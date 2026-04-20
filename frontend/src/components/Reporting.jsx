import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import {
    BarChart, Bar, LineChart, Line, ComposedChart,
    XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer, Brush
} from 'recharts';
import {
    Download, Calendar, Eye, FileText, XCircle, AlertTriangle, RefreshCw, Users, Building2,
    ArrowDownToLine, ArrowUpFromLine, Activity, Clock3, TrendingUp, ArrowLeft, ArrowRight, Target,
    ChevronDown, ChevronRight,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { getApiBaseUrl } from '../apiConfig';

const HAS_TZ_SUFFIX = /(Z|[+-]\d{2}:\d{2})$/i;
const DETECTION_EVENT_PAGE_SIZE = 500;
const MAX_DETECTION_EVENT_ROWS = 20000;
const SNAPSHOT_PAGE_SIZE = 1000;
const MAX_COUNTING_HISTORY_ROWS = 20000;
const BUILDING_HISTORY_PAGE_SIZE = 1000;
const MAX_BUILDING_HISTORY_ROWS = 10000;
const OCCUPANCY_CHART_MAX_POINTS = 300;
const OCCUPANCY_RANGE_LOOKBACK_MS = {
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
};
const FLOW_BUCKET_DURATIONS_MS = {
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
};

const parseApiTimestamp = (value) => {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

    const raw = String(value).trim();
    if (!raw) return null;

    // Treat timezone-less API timestamps as UTC to avoid browser-local ambiguity.
    const normalized = HAS_TZ_SUFFIX.test(raw) ? raw : `${raw}Z`;
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const getTimestampMs = (value) => parseApiTimestamp(value)?.getTime() ?? 0;
// Currently unused.
// const getTimestampIsoDate = (value) => parseApiTimestamp(value)?.toISOString().split('T')[0] ?? '';
const formatTimestamp = (value) => parseApiTimestamp(value)?.toLocaleString() ?? '-';
const getReportTimeValue = (row, preferredField = 'timestamp') => {
    if (!row) return null;
    if (preferredField === 'processed_at') {
        return row?.processed_at || row?.timestamp || null;
    }
    return row?.timestamp || row?.processed_at || null;
};
const getReportTime = (row, preferredField = 'timestamp') => parseApiTimestamp(getReportTimeValue(row, preferredField));
const getReportTimeMs = (row, preferredField = 'timestamp') => getReportTime(row, preferredField)?.getTime() ?? 0;
const formatReportTime = (row, preferredField = 'timestamp') => getReportTime(row, preferredField)?.toLocaleString() ?? '-';
const getSortableTimeValue = (row, field) => {
    const parsed = getReportTime(row, field);
    return parsed ? parsed.getTime() : null;
};
const normalizeSourceFilterKind = (rawValue) => {
    const normalized = String(rawValue || '').trim().toLowerCase();
    if (normalized === 'uploaded_video') return 'uploaded';
    if (normalized === 'rtsp' || normalized === 'network') return 'live';
    return 'other';
};

const getReportSourceFilterKind = (item, cameraSourceKindById) => {
    if (item?.details?.scope === 'building') return 'building';
    const mapped = normalizeSourceFilterKind(cameraSourceKindById?.[item?.camera_id]);
    if (mapped !== 'other') return mapped;
    if (item?.processed_at) return 'uploaded';
    return 'live';
};
const isSourceOnlySnapshotScope = (rows, cameraSourceKindById, expectedKind, fallbackSourceFilter = 'all') => {
    if (fallbackSourceFilter === expectedKind) return true;
    const cameraIds = Array.from(new Set(
        (rows || [])
            .map((row) => row?.camera_id)
            .filter(Boolean),
    ));
    if (!cameraIds.length) return false;
    return cameraIds.every((cameraId) => normalizeSourceFilterKind(cameraSourceKindById?.[cameraId]) === expectedKind);
};

const getCameraLabel = (item) => {
    if (item?.details?.scope === 'building') {
        return item?.details?.building_id ? `Building ${item.details.building_id}` : 'Building';
    }
    return (item?.camera_name || '').trim() || item?.camera_id || 'Unknown Camera';
};
const EMPTY_BUILDING_SUMMARY = {
    enabled: true,
    max_capacity: null,
    capacity_exceeded: false,
    exceeded_building_ids: [],
    default_max_capacity: null,
    capacity_by_building_id: {},
    manual_offset: 0,
    raw_in: 0,
    raw_out: 0,
    raw_occupancy: 0,
    occupancy: 0,
    active_camera_count: 0,
    entrance_summaries: {},
};

const doesCameraMatchReportScope = (
    cameraId,
    {
        selectedSourceFilter = 'all',
        selectedCameraFilter = 'all',
        cameraSourceKindById = {},
    } = {},
) => {
    if (!cameraId) return false;
    if (selectedCameraFilter !== 'all' && cameraId !== selectedCameraFilter) return false;
    if (selectedSourceFilter === 'all') return true;
    return normalizeSourceFilterKind(cameraSourceKindById?.[cameraId]) === selectedSourceFilter;
};

const sumBuildingCameraSummaries = (cameraSummaries = {}) => {
    const entries = Object.values(cameraSummaries || {});
    const totalIn = entries.reduce((sum, camera) => sum + Number(camera?.total_in ?? 0), 0);
    const totalOut = entries.reduce((sum, camera) => sum + Number(camera?.total_out ?? 0), 0);
    const occupancy = entries.reduce(
        (sum, camera) => sum + Number(camera?.occupancy ?? Math.max(0, Number(camera?.total_in ?? 0) - Number(camera?.total_out ?? 0))),
        0,
    );
    return {
        totalIn,
        totalOut,
        occupancy,
    };
};

const filterBuildingAggregateForScope = (
    snapshotLike,
    {
        selectedSourceFilter = 'all',
        selectedCameraFilter = 'all',
        cameraSourceKindById = {},
    } = {},
) => {
    if (!snapshotLike) return snapshotLike;

    const hasScopedCameraFilter = selectedSourceFilter !== 'all' || selectedCameraFilter !== 'all';
    if (!hasScopedCameraFilter) {
        return snapshotLike;
    }

    const originalEntranceSummaries = snapshotLike.entrance_summaries || {};
    const filteredEntranceSummaries = Object.entries(originalEntranceSummaries).reduce((acc, [entranceId, entrance]) => {
        const rawCameraIds = new Set([
            ...(Array.isArray(entrance?.camera_ids) ? entrance.camera_ids : []),
            ...Object.keys(entrance?.camera_summaries || {}),
        ]);
        const filteredCameraIds = Array.from(rawCameraIds).filter((cameraId) => (
            doesCameraMatchReportScope(cameraId, {
                selectedSourceFilter,
                selectedCameraFilter,
                cameraSourceKindById,
            })
        ));

        if (!filteredCameraIds.length) {
            return acc;
        }

        const filteredCameraSummaries = filteredCameraIds.reduce((cameraAcc, cameraId) => {
            cameraAcc[cameraId] = entrance?.camera_summaries?.[cameraId] || {
                total_in: 0,
                total_out: 0,
                occupancy: 0,
            };
            return cameraAcc;
        }, {});

        const derived = sumBuildingCameraSummaries(filteredCameraSummaries);

        acc[entranceId] = {
            ...entrance,
            camera_ids: filteredCameraIds,
            camera_summaries: filteredCameraSummaries,
            total_in: derived.totalIn,
            total_out: derived.totalOut,
            occupancy: derived.occupancy,
            capacity_exceeded: entrance?.max_capacity != null
                ? derived.occupancy >= Number(entrance.max_capacity)
                : false,
        };
        return acc;
    }, {});

    const filteredEntries = Object.entries(filteredEntranceSummaries);
    const rawIn = filteredEntries.reduce((sum, [, entrance]) => sum + Number(entrance?.total_in ?? 0), 0);
    const rawOut = filteredEntries.reduce((sum, [, entrance]) => sum + Number(entrance?.total_out ?? 0), 0);
    const rawOccupancy = filteredEntries.reduce((sum, [, entrance]) => sum + Number(entrance?.occupancy ?? 0), 0);
    const knownCapacities = filteredEntries.filter(([, entrance]) => entrance?.max_capacity != null);
    const aggregateCapacityKnown = filteredEntries.length > 0 && knownCapacities.length === filteredEntries.length;
    const exceededBuildingIds = filteredEntries
        .filter(([, entrance]) => Boolean(entrance?.capacity_exceeded))
        .map(([entranceId]) => entranceId);
    const activeCameraCount = filteredEntries.reduce((sum, [, entrance]) => (
        sum + (Array.isArray(entrance?.camera_ids) ? entrance.camera_ids.length : 0)
    ), 0);

    return {
        ...snapshotLike,
        manual_offset: 0,
        raw_in: rawIn,
        raw_out: rawOut,
        raw_occupancy: rawOccupancy,
        occupancy: rawOccupancy,
        active_camera_count: activeCameraCount,
        max_capacity: aggregateCapacityKnown
            ? knownCapacities.reduce((sum, [, entrance]) => sum + Number(entrance.max_capacity || 0), 0)
            : null,
        capacity_exceeded: exceededBuildingIds.length > 0,
        exceeded_building_ids: exceededBuildingIds,
        entrance_summaries: filteredEntranceSummaries,
    };
};

const CAMERA_BADGE_STYLES = [
    { badge: 'border-blue-200 bg-blue-100 text-blue-800', dot: 'bg-blue-500' },
    { badge: 'border-emerald-200 bg-emerald-100 text-emerald-800', dot: 'bg-emerald-500' },
    { badge: 'border-amber-200 bg-amber-100 text-amber-800', dot: 'bg-amber-500' },
    { badge: 'border-rose-200 bg-rose-100 text-rose-800', dot: 'bg-rose-500' },
    { badge: 'border-cyan-200 bg-cyan-100 text-cyan-800', dot: 'bg-cyan-500' },
    { badge: 'border-indigo-200 bg-indigo-100 text-indigo-800', dot: 'bg-indigo-500' },
    { badge: 'border-lime-200 bg-lime-100 text-lime-800', dot: 'bg-lime-500' },
    { badge: 'border-orange-200 bg-orange-100 text-orange-800', dot: 'bg-orange-500' },
];

const getCameraBadgeStyle = (cameraId) => {
    const raw = String(cameraId || '');
    let hash = 0;
    for (let i = 0; i < raw.length; i += 1) {
        hash = ((hash * 31) + raw.charCodeAt(i)) >>> 0;
    }
    return CAMERA_BADGE_STYLES[hash % CAMERA_BADGE_STYLES.length];
};

const toCsvCell = (value) => {
    const text = value == null ? '' : String(value);
    if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
};

const downsampleSeries = (rows, maxPoints = OCCUPANCY_CHART_MAX_POINTS, valueSelectors = []) => {
    if (rows.length <= maxPoints) return rows;

    const interiorRows = rows.slice(1, -1);
    if (interiorRows.length <= 0 || maxPoints <= 2) {
        return [rows[0], rows[rows.length - 1]].filter(Boolean);
    }

    const selectors = Array.isArray(valueSelectors) ? valueSelectors.filter((selector) => typeof selector === 'function') : [];
    const slotsPerChunk = Math.max(1, selectors.length * 2 || 1);
    const chunkCount = Math.max(1, Math.floor((maxPoints - 2) / slotsPerChunk));
    const chunkSize = Math.max(1, Math.ceil(interiorRows.length / chunkCount));
    const selectedIndexes = new Set([0, rows.length - 1]);

    for (let start = 1; start < rows.length - 1; start += chunkSize) {
        const end = Math.min(rows.length - 1, start + chunkSize);
        selectedIndexes.add(start);

        if (!selectors.length) {
            selectedIndexes.add(Math.min(rows.length - 2, start + Math.floor((end - start) / 2)));
            continue;
        }

        selectors.forEach((selector) => {
            let minIndex = start;
            let maxIndex = start;
            let minValue = Number(selector(rows[start]));
            let maxValue = Number(selector(rows[start]));

            for (let idx = start + 1; idx < end; idx += 1) {
                const currentValue = Number(selector(rows[idx]));
                if (!Number.isFinite(currentValue)) continue;

                if (!Number.isFinite(minValue) || currentValue < minValue) {
                    minValue = currentValue;
                    minIndex = idx;
                }
                if (!Number.isFinite(maxValue) || currentValue > maxValue) {
                    maxValue = currentValue;
                    maxIndex = idx;
                }
            }

            selectedIndexes.add(minIndex);
            selectedIndexes.add(maxIndex);
        });
    }

    return Array.from(selectedIndexes)
        .sort((left, right) => left - right)
        .map((index) => rows[index])
        .filter(Boolean);
};

const collapseRowsByTimestamp = (rows, compareFn = null) => {
    const byTimestamp = new Map();

    rows.forEach((row) => {
        const tsMs = Number(row?.tsMs ?? 0);
        if (!Number.isFinite(tsMs) || tsMs <= 0) return;

        const existing = byTimestamp.get(tsMs);
        if (!existing) {
            byTimestamp.set(tsMs, row);
            return;
        }

        if (!compareFn) {
            byTimestamp.set(tsMs, row);
            return;
        }

        const preferred = compareFn(existing, row);
        byTimestamp.set(tsMs, preferred === existing ? existing : row);
    });

    return Array.from(byTimestamp.values()).sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));
};

const isLikelyCounterReset = ({
    previousIn = 0,
    previousOut = 0,
    currentIn = 0,
    currentOut = 0,
}) => {
    const prevIn = Number(previousIn || 0);
    const prevOut = Number(previousOut || 0);
    const currIn = Number(currentIn || 0);
    const currOut = Number(currentOut || 0);

    if (currIn >= prevIn && currOut >= prevOut) return false;
    if (currIn === 0 && currOut === 0 && (prevIn > 0 || prevOut > 0)) return true;

    const previousTotal = prevIn + prevOut;
    const currentTotal = currIn + currOut;
    const totalDrop = previousTotal - currentTotal;

    return previousTotal >= 20
        && totalDrop >= 20
        && currentTotal <= Math.max(2, previousTotal * 0.25);
};

const isLikelyTrafficReset = ({
    previousLeft = 0,
    previousRight = 0,
    previousEntries = 0,
    currentLeft = 0,
    currentRight = 0,
    currentEntries = 0,
}) => {
    const prevLeft = Number(previousLeft || 0);
    const prevRight = Number(previousRight || 0);
    const prevEntries = Number(previousEntries || 0);
    const currLeft = Number(currentLeft || 0);
    const currRight = Number(currentRight || 0);
    const currEntries = Number(currentEntries || 0);

    if (currLeft >= prevLeft && currRight >= prevRight && currEntries >= prevEntries) return false;
    if (currLeft === 0 && currRight === 0 && currEntries === 0 && (prevLeft > 0 || prevRight > 0 || prevEntries > 0)) {
        return true;
    }

    const previousTotal = prevLeft + prevRight + prevEntries;
    const currentTotal = currLeft + currRight + currEntries;
    const totalDrop = previousTotal - currentTotal;

    return previousTotal >= 20
        && totalDrop >= 20
        && currentTotal <= Math.max(2, previousTotal * 0.25);
};

const formatDateTimeLocal = (date) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

// Currently unused.
// const formatDateOnlyLocal = (date) => {
//     const pad = (n) => String(n).padStart(2, '0');
//     return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
// };

const toApiDateTimeParam = (value) => {
    if (value == null) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const appendQueryParam = (params, key, value) => {
    if (value == null || value === '') return;
    params.set(key, String(value));
};

const formatNumber = (value) => new Intl.NumberFormat('en-US').format(Number(value || 0));
const REPORT_SURFACE_CARD_CLASS = 'border-slate-200/80 bg-white/95 shadow-sm';
const REPORT_INPUT_CLASS = 'border-slate-200 bg-white';
const REPORT_SECTION_HEADER_CLASS = 'rounded-[24px] border border-slate-200/80 bg-white/95 px-6 py-5 shadow-sm';

const createDefaultCustomRange = () => {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));
    return {
        start: formatDateTimeLocal(oneDayAgo),
        end: formatDateTimeLocal(now),
    };
};

const createCustomRangeFromBounds = (startMs, endMs) => {
    const fallback = createDefaultCustomRange();
    if (startMs == null || endMs == null) return fallback;

    const start = new Date(startMs);
    const end = new Date(endMs);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
        return fallback;
    }

    return {
        start: formatDateTimeLocal(start),
        end: formatDateTimeLocal(end),
    };
};

const getQuickRangeDateBounds = (quickRange, customStartDate, customEndDate) => {
    if (quickRange === 'custom') {
        return {
            startDate: customStartDate,
            endDate: customEndDate,
        };
    }

    if (quickRange === 'all') {
        return {
            startDate: '',
            endDate: '',
        };
    }

    const end = new Date();

    const start = new Date(end);
    if (quickRange === 'today') {
        start.setHours(0, 0, 0, 0);
        return {
            startDate: formatDateTimeLocal(start),
            endDate: formatDateTimeLocal(end),
        };
    }
    if (quickRange === '7d') {
        start.setDate(start.getDate() - 6);
    } else if (quickRange === '30d') {
        start.setDate(start.getDate() - 29);
    }
    start.setHours(0, 0, 0, 0);

    return {
        startDate: formatDateTimeLocal(start),
        endDate: formatDateTimeLocal(end),
    };
};

const getDateRangeBounds = (startDate, endDate) => {
    const startMs = startDate ? new Date(startDate).getTime() : null;
    const endMs = endDate ? new Date(endDate).getTime() : null;
    return { startMs, endMs };
};

// Currently unused.
// const getLatestSnapshotInRange = (rows, { startMs = null, endMs = null } = {}) => {
//     let latest = null;
//     normalizeSnapshotRows(rows).forEach((row) => {
//         if (startMs != null && row.tsMs < startMs) return;
//         if (endMs != null && row.tsMs > endMs) return;
//         if (!latest || row.tsMs > latest.tsMs) {
//             latest = row;
//         }
//     });
//     return latest;
// };

const getLatestSnapshotsByCamera = (rows, { startMs = null, endMs = null } = {}) => {
    const latestByCamera = new Map();

    normalizeSnapshotRows(rows).forEach((row) => {
        if (startMs != null && row.tsMs < startMs) return;
        if (endMs != null && row.tsMs > endMs) return;
        if (!row.camera_id) return;

        const existing = latestByCamera.get(row.camera_id);
        if (!existing || row.tsMs > existing.tsMs) {
            latestByCamera.set(row.camera_id, row);
        }
    });

    return latestByCamera;
};

const summarizeLatestSnapshots = (rows, { startMs = null, endMs = null } = {}) => {
    const latestByCamera = getLatestSnapshotsByCamera(rows, { startMs, endMs });
    const snapshots = Array.from(latestByCamera.values());

    const totalIn = snapshots.reduce((sum, row) => sum + Number(row.total_in ?? 0), 0);
    const totalOut = snapshots.reduce((sum, row) => sum + Number(row.total_out ?? 0), 0);
    const footTrafficLeft = snapshots.reduce((sum, row) => sum + Number(row.foot_traffic_left ?? 0), 0);
    const footTrafficRight = snapshots.reduce((sum, row) => sum + Number(row.foot_traffic_right ?? 0), 0);
    const footTrafficTotal = snapshots.reduce(
        (sum, row) => sum + Number(row.foot_traffic_total ?? (Number(row.foot_traffic_left ?? 0) + Number(row.foot_traffic_right ?? 0))),
        0,
    );
    const estimatedOccupancy = snapshots.reduce((sum, row) => sum + Number(row.current_occupancy ?? 0), 0);

    return {
        snapshots,
        byCamera: latestByCamera,
        snapshotCount: snapshots.length,
        totalIn,
        totalOut,
        totalTraffic: totalIn + totalOut,
        estimatedOccupancy,
        footTrafficLeft,
        footTrafficRight,
        footTrafficTotal,
        total_in: totalIn,
        total_out: totalOut,
        current_occupancy: estimatedOccupancy,
        foot_traffic_left: footTrafficLeft,
        foot_traffic_right: footTrafficRight,
        foot_traffic_total: footTrafficTotal,
    };
};

const calculateCombinedPeakOccupancy = (rows, { startMs = null, endMs = null } = {}) => {
    const sortedRows = normalizeSnapshotRows(rows)
        .filter((row) => row.camera_id)
        .sort((a, b) => a.tsMs - b.tsMs);

    const occupancyByCamera = new Map();
    let currentTotal = 0;
    let peakOccupancy = 0;
    let enteredRange = startMs == null;

    for (const row of sortedRows) {
        if (endMs != null && row.tsMs > endMs) break;

        if (!enteredRange && row.tsMs >= startMs) {
            peakOccupancy = Math.max(peakOccupancy, currentTotal);
            enteredRange = true;
        }

        const previousOccupancy = Number(occupancyByCamera.get(row.camera_id) ?? 0);
        const nextOccupancy = Number(row.current_occupancy ?? 0);
        occupancyByCamera.set(row.camera_id, nextOccupancy);
        currentTotal += nextOccupancy - previousOccupancy;

        if (enteredRange && (startMs == null || row.tsMs >= startMs)) {
            peakOccupancy = Math.max(peakOccupancy, currentTotal);
        }
    }

    if (!enteredRange && (startMs != null || endMs != null)) {
        peakOccupancy = Math.max(peakOccupancy, currentTotal);
    }

    return peakOccupancy;
};

const isWholeSingleLocalDayRange = (startValue, endValue) => {
    if (!startValue || !endValue) return false;
    const start = new Date(startValue);
    const end = new Date(endValue);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;

    const sameDay = start.getFullYear() === end.getFullYear()
        && start.getMonth() === end.getMonth()
        && start.getDate() === end.getDate();
    if (!sameDay) return false;

    const startAtDayStart = start.getHours() === 0 && start.getMinutes() === 0;
    const endAtDayEnd = end.getHours() === 23 && end.getMinutes() === 59;
    return startAtDayStart && endAtDayEnd;
};

const buildEntranceContributionFromLatestSnapshots = ({
    latestSnapshotSummary,
    entranceSummaries,
}) => {
    const entries = Object.entries(entranceSummaries || {})
        .map(([entranceId, entrance]) => {
            const cameraIds = Array.from(new Set([
                ...(Array.isArray(entrance?.camera_ids) ? entrance.camera_ids : []),
                ...Object.keys(entrance?.camera_summaries || {}),
            ])).filter(Boolean);

            const cameras = cameraIds
                .map((cameraId) => {
                    const row = latestSnapshotSummary.byCamera.get(cameraId);
                    const totalIn = Number(row?.total_in ?? 0);
                    const totalOut = Number(row?.total_out ?? 0);
                    return {
                        id: cameraId,
                        totalIn,
                        totalOut,
                        totalTraffic: totalIn + totalOut,
                        currentOccupancy: Number(row?.current_occupancy ?? 0),
                    };
                })
                .sort((a, b) => {
                    const trafficDelta = Number(b.totalTraffic || 0) - Number(a.totalTraffic || 0);
                    if (trafficDelta !== 0) return trafficDelta;
                    return String(a.id || '').localeCompare(String(b.id || ''));
                });

            const totalIn = cameras.reduce((sum, camera) => sum + Number(camera.totalIn || 0), 0);
            const totalOut = cameras.reduce((sum, camera) => sum + Number(camera.totalOut || 0), 0);
            const totalTraffic = totalIn + totalOut;
            const currentOccupancy = cameras.reduce((sum, camera) => sum + Number(camera.currentOccupancy || 0), 0);

            return {
                name: entranceId,
                totalIn,
                totalOut,
                totalTraffic,
                currentOccupancy,
                cameraCount: cameraIds.length,
                cameras,
            };
        })
        .filter((entry) => entry.cameraCount > 0 || entry.totalTraffic > 0 || entry.currentOccupancy > 0)
        .sort((a, b) => {
            const trafficDelta = Number(b.totalTraffic || 0) - Number(a.totalTraffic || 0);
            if (trafficDelta !== 0) return trafficDelta;
            return String(a.name || '').localeCompare(String(b.name || ''));
        });

    const totalTraffic = entries.reduce((sum, entry) => sum + Number(entry.totalTraffic || 0), 0);

    return {
        entries: entries.map((entry) => ({
            ...entry,
            share: totalTraffic > 0 ? (Number(entry.totalTraffic || 0) / totalTraffic) * 100 : 0,
            cameras: (entry.cameras || []).map((camera) => ({
                ...camera,
                share: Number(entry.totalTraffic || 0) > 0 ? (Number(camera.totalTraffic || 0) / Number(entry.totalTraffic || 0)) * 100 : 0,
            })),
        })),
        totalTraffic,
        totalIn: entries.reduce((sum, entry) => sum + Number(entry.totalIn || 0), 0),
        totalOut: entries.reduce((sum, entry) => sum + Number(entry.totalOut || 0), 0),
        busiestEntrance: entries[0] || null,
    };
};

const getHistoryRangeBounds = (timeRange, customStart, customEnd, fallbackEndMs = Date.now()) => {
    let startMs = null;
    let endMs = fallbackEndMs;

    if (timeRange === 'custom') {
        const customStartMs = new Date(customStart).getTime();
        const customEndMs = new Date(customEnd).getTime();
        if (Number.isNaN(customStartMs) || Number.isNaN(customEndMs) || customStartMs > customEndMs) {
            return { valid: false, startMs: null, endMs: null };
        }
        startMs = customStartMs;
        endMs = customEndMs;
    } else if (timeRange !== 'all') {
        startMs = fallbackEndMs - OCCUPANCY_RANGE_LOOKBACK_MS[timeRange];
    }

    return { valid: true, startMs, endMs };
};

const getAdaptiveFlowBucket = (timeRange, startMs, endMs) => {
    if (timeRange === '1h' || timeRange === '6h') return '15m';
    if (timeRange === '24h') return '1h';
    if (timeRange === '7d') return '1h';
    if (timeRange === '30d' || timeRange === 'all') return '1d';

    if (startMs == null || endMs == null) return '1h';
    const durationMs = Math.max(0, endMs - startMs);
    if (durationMs <= 12 * 60 * 60 * 1000) return '15m';
    if (durationMs <= 10 * 24 * 60 * 60 * 1000) return '1h';
    return '1d';
};

const getBucketStartMs = (tsMs, bucket) => {
    const date = new Date(tsMs);
    if (bucket === '15m') {
        date.setMinutes(Math.floor(date.getMinutes() / 15) * 15, 0, 0);
        return date.getTime();
    }
    if (bucket === '1h') {
        date.setMinutes(0, 0, 0);
        return date.getTime();
    }
    date.setHours(0, 0, 0, 0);
    return date.getTime();
};

const formatFlowBucketTick = (tsMs, bucket) => {
    const date = new Date(tsMs);
    if (bucket === '15m' || bucket === '1h') {
        return date.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: bucket === '15m' ? '2-digit' : undefined,
        });
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const formatFlowBucketRange = (tsMs, bucket) => {
    const start = new Date(tsMs);
    const end = new Date(tsMs + (FLOW_BUCKET_DURATIONS_MS[bucket] || FLOW_BUCKET_DURATIONS_MS['1d']));

    if (bucket === '15m' || bucket === '1h') {
        return `${start.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: bucket === '15m' ? '2-digit' : undefined,
        })} - ${end.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: bucket === '15m' ? '2-digit' : undefined,
        })}`;
    }

    return start.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: start.getFullYear() !== end.getFullYear() ? 'numeric' : undefined,
    });
};

const normalizeSnapshotRows = (rows) => rows
    .map((row) => {
        const ts = getReportTime(row);
        if (!ts) return null;
        return {
            ...row,
            ts,
            tsMs: ts.getTime(),
        };
    })
    .filter(Boolean);

const aggregateCountingFlow = (rows, { startMs = null, endMs = null, bucket = '1d' } = {}) => {
    const groupedRows = new Map();
    const bucketMap = new Map();
    let totalIn = 0;
    let totalOut = 0;
    let peakOccupancy = 0;
    let latestSnapshot = null;
    let resetCount = 0;

    normalizeSnapshotRows(rows).forEach((row) => {
        const existing = groupedRows.get(row.camera_id) || [];
        existing.push(row);
        groupedRows.set(row.camera_id, existing);
    });

    groupedRows.forEach((cameraRows) => {
        cameraRows.sort((a, b) => a.tsMs - b.tsMs);
        let previousRow = null;

        cameraRows.forEach((row) => {
            if (startMs != null && row.tsMs < startMs) {
                previousRow = row;
                return;
            }
            if (endMs != null && row.tsMs > endMs) {
                return;
            }

            const resetDetected = previousRow
                && isLikelyCounterReset({
                    previousIn: previousRow.total_in,
                    previousOut: previousRow.total_out,
                    currentIn: row.total_in,
                    currentOut: row.total_out,
                });
            const deltaIn = previousRow
                ? Math.max(0, resetDetected ? (row.total_in ?? 0) : ((row.total_in ?? 0) - (previousRow.total_in ?? 0)))
                : Math.max(0, row.total_in ?? 0);
            const deltaOut = previousRow
                ? Math.max(0, resetDetected ? (row.total_out ?? 0) : ((row.total_out ?? 0) - (previousRow.total_out ?? 0)))
                : Math.max(0, row.total_out ?? 0);

            if (resetDetected) {
                resetCount += 1;
            }

            totalIn += deltaIn;
            totalOut += deltaOut;
            peakOccupancy = Math.max(peakOccupancy, Number(row.current_occupancy ?? 0));
            if (!latestSnapshot || row.tsMs > latestSnapshot.tsMs) {
                latestSnapshot = row;
            }

            const bucketStartMs = getBucketStartMs(row.tsMs, bucket);
            const bucketEntry = bucketMap.get(bucketStartMs) || {
                tsMs: bucketStartMs,
                label: formatFlowBucketTick(bucketStartMs, bucket),
                fullLabel: formatFlowBucketRange(bucketStartMs, bucket),
                in: 0,
                out: 0,
                totalTraffic: 0,
                occupancy: 0,
                peakOccupancy: 0,
            };

            bucketEntry.in += deltaIn;
            bucketEntry.out += deltaOut;
            bucketEntry.totalTraffic += deltaIn + deltaOut;
            bucketEntry.occupancy = Number(row.current_occupancy ?? bucketEntry.occupancy ?? 0);
            bucketEntry.peakOccupancy = Math.max(bucketEntry.peakOccupancy, Number(row.current_occupancy ?? 0));
            bucketMap.set(bucketStartMs, bucketEntry);
            previousRow = row;
        });
    });

    const series = Array.from(bucketMap.values()).sort((a, b) => a.tsMs - b.tsMs);
    const peakPeriod = series.reduce((best, point) => {
        if (!best || point.totalTraffic > best.totalTraffic) return point;
        return best;
    }, null);

    return {
        series,
        totalIn,
        totalOut,
        totalTraffic: totalIn + totalOut,
        peakOccupancy,
        estimatedOccupancy: Number(latestSnapshot?.current_occupancy ?? 0),
        peakPeriodLabel: peakPeriod?.fullLabel || '-',
        resetCount,
    };
};

const aggregateTrafficAnalytics = (rows, { startMs = null, endMs = null, bucket = '1d' } = {}) => {
    const groupedRows = new Map();
    const bucketMap = new Map();
    let totalLeftTraffic = 0;
    let totalRightTraffic = 0;
    let totalEntries = 0;
    let resetCount = 0;
    let latestSnapshot = null;

    normalizeSnapshotRows(rows).forEach((row) => {
        const existing = groupedRows.get(row.camera_id) || [];
        existing.push(row);
        groupedRows.set(row.camera_id, existing);
    });

    groupedRows.forEach((cameraRows) => {
        cameraRows.sort((a, b) => a.tsMs - b.tsMs);
        let previousRow = null;

        cameraRows.forEach((row) => {
            if (startMs != null && row.tsMs < startMs) {
                previousRow = row;
                return;
            }
            if (endMs != null && row.tsMs > endMs) {
                return;
            }

            const currentLeft = Number(row.foot_traffic_left ?? 0);
            const currentRight = Number(row.foot_traffic_right ?? 0);
            const currentEntries = Number(row.total_in ?? 0);
            const previousLeft = Number(previousRow?.foot_traffic_left ?? 0);
            const previousRight = Number(previousRow?.foot_traffic_right ?? 0);
            const previousEntries = Number(previousRow?.total_in ?? 0);

            const resetDetected = previousRow
                && isLikelyTrafficReset({
                    previousLeft,
                    previousRight,
                    previousEntries,
                    currentLeft,
                    currentRight,
                    currentEntries,
                });

            const deltaLeft = previousRow
                ? Math.max(0, resetDetected ? currentLeft : (currentLeft - previousLeft))
                : Math.max(0, currentLeft);
            const deltaRight = previousRow
                ? Math.max(0, resetDetected ? currentRight : (currentRight - previousRight))
                : Math.max(0, currentRight);
            const deltaEntries = previousRow
                ? Math.max(0, resetDetected ? currentEntries : (currentEntries - previousEntries))
                : Math.max(0, currentEntries);

            if (resetDetected) {
                resetCount += 1;
            }

            totalLeftTraffic += deltaLeft;
            totalRightTraffic += deltaRight;
            totalEntries += deltaEntries;
            if (!latestSnapshot || row.tsMs > latestSnapshot.tsMs) {
                latestSnapshot = row;
            }

            const bucketStartMs = getBucketStartMs(row.tsMs, bucket);
            const bucketEntry = bucketMap.get(bucketStartMs) || {
                tsMs: bucketStartMs,
                label: formatFlowBucketTick(bucketStartMs, bucket),
                fullLabel: formatFlowBucketRange(bucketStartMs, bucket),
                leftTraffic: 0,
                rightTraffic: 0,
                totalFootTraffic: 0,
                entries: 0,
                captureRate: 0,
            };

            bucketEntry.leftTraffic += deltaLeft;
            bucketEntry.rightTraffic += deltaRight;
            bucketEntry.totalFootTraffic += deltaLeft + deltaRight;
            bucketEntry.entries += deltaEntries;
            bucketMap.set(bucketStartMs, bucketEntry);
            previousRow = row;
        });
    });

    const series = Array.from(bucketMap.values())
        .sort((a, b) => a.tsMs - b.tsMs)
        .map((point) => ({
            ...point,
            captureRate: point.totalFootTraffic > 0 ? (point.entries / point.totalFootTraffic) * 100 : 0,
        }));

    const peakTrafficPeriod = series.reduce((best, point) => {
        if (!best || point.totalFootTraffic > best.totalFootTraffic) return point;
        return best;
    }, null);
    const peakConversionPeriod = series.reduce((best, point) => {
        if (point.totalFootTraffic <= 0) return best;
        if (!best || point.captureRate > best.captureRate) return point;
        return best;
    }, null);
    const totalFootTraffic = totalLeftTraffic + totalRightTraffic;

    return {
        series,
        totalLeftTraffic,
        totalRightTraffic,
        totalFootTraffic,
        totalEntries,
        captureRate: totalFootTraffic > 0 ? (totalEntries / totalFootTraffic) * 100 : 0,
        peakTrafficPeriodLabel: peakTrafficPeriod?.fullLabel || '-',
        peakConversionPeriodLabel: peakConversionPeriod?.fullLabel || '-',
        resetCount,
    };
};

const aggregateBuildingFlow = (rows, { startMs = null, endMs = null, bucket = '1d' } = {}) => {
    const sortedRows = [...rows].sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));
    const bucketMap = new Map();
    let peakOccupancy = 0;
    let peakOccupancyTsMs = null;
    let latestSnapshot = null;

    sortedRows.forEach((row) => {
        if (!row?.tsMs) return;
        if (startMs != null && row.tsMs < startMs) return;
        if (endMs != null && row.tsMs > endMs) {
            return;
        }

        const rowOccupancy = Number(row.occupancy ?? 0);
        if (rowOccupancy > peakOccupancy || peakOccupancyTsMs == null) {
            peakOccupancy = rowOccupancy;
            peakOccupancyTsMs = row.tsMs;
        }
        if (!latestSnapshot || row.tsMs > latestSnapshot.tsMs) {
            latestSnapshot = row;
        }

        const bucketStartMs = getBucketStartMs(row.tsMs, bucket);
        const existingEntry = bucketMap.get(bucketStartMs);
        if (existingEntry && existingEntry.sourceTsMs >= row.tsMs) {
            return;
        }

        const bucketEntry = {
            tsMs: bucketStartMs,
            label: formatFlowBucketTick(bucketStartMs, bucket),
            fullLabel: formatFlowBucketRange(bucketStartMs, bucket),
            sourceTsMs: row.tsMs,
            in: Number(row.raw_in ?? 0),
            out: Number(row.raw_out ?? 0),
            totalTraffic: Number(row.raw_in ?? 0) + Number(row.raw_out ?? 0),
            occupancy: Number(row.occupancy ?? 0),
            rawOccupancy: Number(row.raw_occupancy ?? 0),
            peakOccupancy: Number(row.occupancy ?? 0),
        };
        bucketMap.set(bucketStartMs, bucketEntry);
    });

    const series = Array.from(bucketMap.values())
        .sort((a, b) => a.tsMs - b.tsMs)
        .map(({ sourceTsMs, ...point }) => point);
    const peakPeriod = series.reduce((best, point) => {
        if (!best || point.totalTraffic > best.totalTraffic) return point;
        return best;
    }, null);
    const displayedTotalIn = Number(latestSnapshot?.raw_in ?? 0);
    const displayedTotalOut = Number(latestSnapshot?.raw_out ?? 0);
    const peakOccupancyPeriodLabel = peakOccupancyTsMs != null
        ? formatFlowBucketRange(getBucketStartMs(peakOccupancyTsMs, bucket), bucket)
        : '-';

    return {
        series,
        totalIn: displayedTotalIn,
        totalOut: displayedTotalOut,
        totalTraffic: displayedTotalIn + displayedTotalOut,
        peakOccupancy,
        peakOccupancyPeriodLabel,
        estimatedOccupancy: Number(latestSnapshot?.occupancy ?? 0),
        peakPeriodLabel: peakPeriod?.fullLabel || '-',
        resetCount: 0,
    };
};

const aggregateBuildingRangeTotals = (rows, { startMs = null, endMs = null } = {}) => {
    const sortedRows = [...rows].sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));
    const latestByDay = new Map();

    sortedRows.forEach((row) => {
        if (!row?.tsMs) return;
        if (startMs != null && row.tsMs < startMs) return;
        if (endMs != null && row.tsMs > endMs) return;

        const dayStartMs = getBucketStartMs(row.tsMs, '1d');
        const existing = latestByDay.get(dayStartMs);
        if (!existing || row.tsMs > existing.tsMs) {
            latestByDay.set(dayStartMs, row);
        }
    });

    const latestRows = Array.from(latestByDay.values());
    const totalIn = latestRows.reduce((sum, row) => sum + Number(row.raw_in ?? 0), 0);
    const totalOut = latestRows.reduce((sum, row) => sum + Number(row.raw_out ?? 0), 0);

    return {
        totalIn,
        totalOut,
        totalTraffic: totalIn + totalOut,
        dayCount: latestRows.length,
    };
};

const aggregateBuildingEntranceContribution = (rows, { startMs = null, endMs = null } = {}) => {
    const sortedRows = [...rows].sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));
    let latestSnapshot = null;

    sortedRows.forEach((row) => {
        if (!row?.tsMs) return;
        if (startMs != null && row.tsMs < startMs) return;
        if (endMs != null && row.tsMs > endMs) {
            return;
        }
        if (!latestSnapshot || row.tsMs > latestSnapshot.tsMs) {
            latestSnapshot = row;
        }
    });

    const snapshotEntries = Object.entries(latestSnapshot?.entrance_summaries || {})
        .map(([entranceId, entrance]) => {
            const cameras = Object.entries(entrance?.camera_summaries || {})
                .map(([cameraId, camera]) => {
                    const totalIn = Number(camera?.total_in ?? 0);
                    const totalOut = Number(camera?.total_out ?? 0);
                    return {
                        id: cameraId,
                        totalIn,
                        totalOut,
                        totalTraffic: totalIn + totalOut,
                        currentOccupancy: Number(camera?.occupancy ?? 0),
                    };
                })
                .sort((a, b) => Number(b.totalTraffic || 0) - Number(a.totalTraffic || 0));
            const totalIn = Number(entrance?.total_in ?? cameras.reduce((sum, camera) => sum + Number(camera.totalIn || 0), 0));
            const totalOut = Number(entrance?.total_out ?? cameras.reduce((sum, camera) => sum + Number(camera.totalOut || 0), 0));
            const totalTrafficForEntrance = totalIn + totalOut;
            return {
                name: entranceId,
                totalIn,
                totalOut,
                totalTraffic: totalTrafficForEntrance,
                currentOccupancy: Number(entrance?.occupancy ?? 0),
                cameraCount: Array.isArray(entrance?.camera_ids) ? entrance.camera_ids.length : cameras.length,
                cameras,
            };
        })
        .sort((a, b) => Number(b.totalTraffic || 0) - Number(a.totalTraffic || 0));
    const totalTraffic = snapshotEntries.reduce((sum, entry) => sum + Number(entry.totalTraffic || 0), 0);
    const entries = snapshotEntries.map((entry) => ({
        ...entry,
        share: totalTraffic > 0 ? (Number(entry.totalTraffic || 0) / totalTraffic) * 100 : 0,
        cameras: (entry.cameras || []).map((camera) => ({
            ...camera,
            share: Number(entry.totalTraffic || 0) > 0 ? (Number(camera.totalTraffic || 0) / Number(entry.totalTraffic || 0)) * 100 : 0,
        })),
    }));

    return {
        entries,
        totalTraffic,
        totalIn: entries.reduce((sum, entry) => sum + Number(entry.totalIn || 0), 0),
        totalOut: entries.reduce((sum, entry) => sum + Number(entry.totalOut || 0), 0),
        busiestEntrance: entries[0] || null,
    };
};

const formatPercent = (value) => `${Number(value || 0).toFixed(1)}%`;
const formatDetailedPercent = (value) => {
    const numeric = Number(value || 0);
    if (!Number.isFinite(numeric) || numeric === 0) return '0.0%';
    if (Math.abs(numeric) >= 10) return `${numeric.toFixed(1)}%`;
    if (Math.abs(numeric) >= 1) return `${numeric.toFixed(2)}%`;
    if (Math.abs(numeric) >= 0.1) return `${numeric.toFixed(3)}%`;
    return `${numeric.toFixed(4)}%`;
};

const isWithinTimeBounds = (tsMs, { startMs = null, endMs = null } = {}) => {
    if (!Number.isFinite(tsMs)) return false;
    if (startMs != null && tsMs < startMs) return false;
    if (endMs != null && tsMs > endMs) return false;
    return true;
};

const getPeakTwoHourLabel = (events) => {
    const byWindow = new Map();

    events.forEach((evt) => {
        const ts = getReportTime(evt);
        if (!ts) return;
        const bucketHour = Math.floor(ts.getHours() / 2) * 2;
        byWindow.set(bucketHour, (byWindow.get(bucketHour) || 0) + 1);
    });

    let bestHour = null;
    let bestCount = -1;
    byWindow.forEach((count, hour) => {
        if (count > bestCount) {
            bestHour = hour;
            bestCount = count;
        }
    });

    if (bestHour == null) return '-';

    const start = new Date();
    start.setHours(bestHour, 0, 0, 0);
    const end = new Date(start);
    end.setHours(bestHour + 2, 0, 0, 0);

    return `${start.toLocaleTimeString('en-US', { hour: 'numeric' })} - ${end.toLocaleTimeString('en-US', { hour: 'numeric' })}`;
};

const normalizeDressCodeSubtype = (label) => {
    const normalized = String(label || '').trim().toLowerCase();
    if (!normalized) return 'Others';
    if (normalized.includes('slipper')) return 'Slippers';
    if (normalized.includes('short')) return 'Shorts';
    return 'Others';
};

const aggregateDressCodeAnalytics = (events, snapshots, { startMs = null, endMs = null, bucket = null } = {}) => {
    const relevantEvents = events.filter((evt) => {
        if (evt.event_type !== 'Dress Code Violation') return false;
        const tsMs = getReportTimeMs(evt);
        return isWithinTimeBounds(tsMs, { startMs, endMs });
    });
    const trafficBucket = bucket || getAdaptiveFlowBucket('custom', startMs, endMs);
    const normalizedSnapshots = normalizeSnapshotRows(snapshots);
    const snapshotsByCamera = new Map();
    const cameraLabelById = new Map();
    const violationCountByCamera = new Map();
    const uniqueViolatorKeysByCamera = new Map();
    const uniqueViolatorBucketKeysByCamera = new Map();
    normalizedSnapshots.forEach((row) => {
        if (!row?.camera_id) return;
        const existing = snapshotsByCamera.get(row.camera_id) || [];
        existing.push(row);
        snapshotsByCamera.set(row.camera_id, existing);
        cameraLabelById.set(row.camera_id, getCameraLabel(row));
    });
    const violationBucketMap = new Map();
    const violationBreakdownMap = new Map([
        ['Slippers', 0],
        ['Shorts', 0],
        ['Others', 0],
    ]);
    const violatorKeys = new Set();
    const violationCameraIds = new Set();

    relevantEvents.forEach((evt) => {
        const ts = getReportTime(evt);
        if (!ts) return;
        const tsMs = ts.getTime();
        const bucketStartMs = getBucketStartMs(tsMs, trafficBucket);
        const subtype = normalizeDressCodeSubtype(evt.details?.label);
        if (evt.camera_id) {
            violationCameraIds.add(evt.camera_id);
            cameraLabelById.set(evt.camera_id, getCameraLabel(evt));
            violationCountByCamera.set(evt.camera_id, (violationCountByCamera.get(evt.camera_id) || 0) + 1);
        }
        const violationKey = evt.details?.track_id != null
            ? `${evt.camera_id || 'unknown'}:${evt.details.track_id}`
            : `${evt.camera_id || 'unknown'}:${evt.id}`;

        violatorKeys.add(violationKey);
        if (evt.camera_id) {
            const perCameraViolators = uniqueViolatorKeysByCamera.get(evt.camera_id) || new Set();
            perCameraViolators.add(violationKey);
            uniqueViolatorKeysByCamera.set(evt.camera_id, perCameraViolators);

            const perCameraBuckets = uniqueViolatorBucketKeysByCamera.get(evt.camera_id) || new Map();
            const bucketViolators = perCameraBuckets.get(bucketStartMs) || new Set();
            bucketViolators.add(violationKey);
            perCameraBuckets.set(bucketStartMs, bucketViolators);
            uniqueViolatorBucketKeysByCamera.set(evt.camera_id, perCameraBuckets);
        }
        violationBreakdownMap.set(subtype, (violationBreakdownMap.get(subtype) || 0) + 1);

        const bucketEntry = violationBucketMap.get(bucketStartMs) || {
            tsMs: bucketStartMs,
            label: formatFlowBucketTick(bucketStartMs, trafficBucket),
            fullLabel: formatFlowBucketRange(bucketStartMs, trafficBucket),
            violations: 0,
        };
        bucketEntry.violations += 1;
        violationBucketMap.set(bucketStartMs, bucketEntry);
    });

    const denominatorSeriesByCamera = new Map();
    const denominatorTotalByCamera = new Map();
    const denominatorSourceByCamera = new Map();

    snapshotsByCamera.forEach((cameraRows, cameraId) => {
        const trafficSummary = aggregateTrafficAnalytics(cameraRows, {
            startMs,
            endMs,
            bucket: trafficBucket,
        });
        const movementSummary = aggregateCountingFlow(cameraRows, {
            startMs,
            endMs,
            bucket: trafficBucket,
        });

        if (Number(trafficSummary.totalFootTraffic || 0) > 0) {
            const adjustedTrafficBase = Number(trafficSummary.totalFootTraffic || 0) + Number(movementSummary.totalOut || 0);
            denominatorSourceByCamera.set(cameraId, 'foot_traffic_plus_out');
            denominatorTotalByCamera.set(cameraId, adjustedTrafficBase);
            denominatorSeriesByCamera.set(
                cameraId,
                new Map(
                    Array.from(new Set([
                        ...trafficSummary.series.map((point) => point.tsMs),
                        ...movementSummary.series.map((point) => point.tsMs),
                    ])).map((tsMs) => {
                        const trafficPoint = trafficSummary.series.find((point) => point.tsMs === tsMs);
                        const movementPoint = movementSummary.series.find((point) => point.tsMs === tsMs);
                        return [
                            tsMs,
                            Number(trafficPoint?.totalFootTraffic || 0) + Number(movementPoint?.out || 0),
                        ];
                    }),
                ),
            );
            return;
        }

        if (Number(movementSummary.totalTraffic || 0) > 0) {
            denominatorSourceByCamera.set(cameraId, 'movement');
            denominatorTotalByCamera.set(cameraId, Number(movementSummary.totalTraffic || 0));
            denominatorSeriesByCamera.set(
                cameraId,
                new Map(movementSummary.series.map((point) => [point.tsMs, Number(point.totalTraffic || 0)])),
            );
        }
    });

    const scopedCameraIds = new Set([
        ...Array.from(denominatorTotalByCamera.keys()),
        ...Array.from(violationCameraIds),
    ]);

    const eligibleUniqueViolatorCountByCamera = new Map(
        Array.from(uniqueViolatorKeysByCamera.entries())
            .filter(([cameraId]) => denominatorTotalByCamera.has(cameraId))
            .map(([cameraId, keys]) => [cameraId, keys.size]),
    );

    const mergedRateSeries = Array.from(new Set([
        ...Array.from(denominatorSeriesByCamera.values()).flatMap((seriesMap) => Array.from(seriesMap.keys())),
        ...violationBucketMap.keys(),
    ]))
        .sort((a, b) => a - b)
        .map((tsMs) => {
            let trafficCount = 0;
            let eligibleUniqueViolators = 0;
            denominatorSeriesByCamera.forEach((seriesMap) => {
                trafficCount += Number(seriesMap.get(tsMs) || 0);
            });
            denominatorSeriesByCamera.forEach((_, cameraId) => {
                const perCameraBuckets = uniqueViolatorBucketKeysByCamera.get(cameraId);
                eligibleUniqueViolators += perCameraBuckets?.get(tsMs)?.size || 0;
            });
            const violations = eligibleUniqueViolators;
            return {
                tsMs,
                label: formatFlowBucketTick(tsMs, trafficBucket),
                fullLabel: formatFlowBucketRange(tsMs, trafficBucket),
                violations,
                totalFootTraffic: trafficCount,
                violationRate: trafficCount > 0 ? Math.min(100, (violations / trafficCount) * 100) : 0,
            };
        });

    const totalViolations = relevantEvents.length;
    const rateEligibleUniqueViolators = Array.from(eligibleUniqueViolatorCountByCamera.values())
        .reduce((sum, value) => sum + Number(value || 0), 0);
    const totalTrafficBase = Array.from(denominatorTotalByCamera.values())
        .reduce((sum, value) => sum + Number(value || 0), 0);
    const violationRate = totalTrafficBase > 0
        ? Math.min(100, (rateEligibleUniqueViolators / totalTrafficBase) * 100)
        : 0;
    const peakViolationPoint = mergedRateSeries.reduce((best, point) => {
        if (point.violations <= 0) return best;
        if (!best || point.violations > best.violations) return point;
        return best;
    }, null);
    const peakRatePoint = mergedRateSeries.reduce((best, point) => {
        if (point.totalFootTraffic <= 0) return best;
        if (!best || point.violationRate > best.violationRate) return point;
        return best;
    }, null);

    const breakdown = ['Slippers', 'Shorts', 'Others'].map((name) => {
        const count = Number(violationBreakdownMap.get(name) || 0);
        return {
            name,
            count,
            percentage: totalViolations > 0 ? (count / totalViolations) * 100 : 0,
        };
    });

    const camerasWithRateBase = Array.from(scopedCameraIds).filter((cameraId) => denominatorTotalByCamera.has(cameraId));
    const violatingCamerasWithoutRateBase = Array.from(violationCameraIds).filter((cameraId) => !denominatorTotalByCamera.has(cameraId));
    const rateBreakdownByCamera = Array.from(scopedCameraIds)
        .map((cameraId) => ({
            cameraId,
            cameraLabel: cameraLabelById.get(cameraId) || cameraId || 'Unknown Camera',
            violationCount: Number(violationCountByCamera.get(cameraId) || 0),
            uniqueViolators: Number(uniqueViolatorKeysByCamera.get(cameraId)?.size || 0),
            eligibleUniqueViolators: Number(eligibleUniqueViolatorCountByCamera.get(cameraId) || 0),
            denominatorSource: denominatorSourceByCamera.get(cameraId) || null,
            denominatorValue: Number(denominatorTotalByCamera.get(cameraId) || 0),
            includedInRate: denominatorTotalByCamera.has(cameraId),
        }))
        .sort((a, b) => {
            if (Number(b.includedInRate) !== Number(a.includedInRate)) {
                return Number(b.includedInRate) - Number(a.includedInRate);
            }
            if (b.violationCount !== a.violationCount) {
                return b.violationCount - a.violationCount;
            }
            return a.cameraLabel.localeCompare(b.cameraLabel);
        });

    return {
        totalViolations,
        rateEligibleUniqueViolators,
        uniqueViolators: violatorKeys.size,
        violationRate,
        peakViolationTimeLabel: peakViolationPoint?.fullLabel || '-',
        peakConversionLabel: peakRatePoint?.fullLabel || '-',
        breakdown,
        rateSeries: mergedRateSeries,
        totalTrafficBase,
        scopedCameraCount: scopedCameraIds.size,
        camerasWithRateBaseCount: camerasWithRateBase.length,
        violatingCameraCount: violationCameraIds.size,
        violatingCamerasWithoutRateBaseCount: violatingCamerasWithoutRateBase.length,
        hasTrafficBase: totalTrafficBase > 0,
        denominatorSourceByCamera,
        rateBreakdownByCamera,
    };
};

const getDressCodeRateCoverageNote = (analytics) => {
    if (!analytics) return null;

    if (!analytics.hasTrafficBase) {
        if (analytics.scopedCameraCount > 0) {
            return `No valid traffic base for ${formatNumber(analytics.scopedCameraCount)} camera(s)`;
        }
        return 'No valid traffic base in selected scope';
    }

    if (
        Number(analytics.camerasWithRateBaseCount || 0) > 0
        && Number(analytics.scopedCameraCount || 0) > Number(analytics.camerasWithRateBaseCount || 0)
    ) {
        return `Rate based on ${formatNumber(analytics.camerasWithRateBaseCount)} of ${formatNumber(analytics.scopedCameraCount)} cameras`;
    }

    return null;
};

const formatDressCodeDenominatorSource = (source) => {
    if (source === 'foot_traffic_plus_out') return 'Foot traffic + total out';
    if (source === 'movement') return 'Total traffic fallback';
    return 'No traffic base';
};

const DressCodeRateBreakdown = ({ analytics, compact = false }) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const rows = analytics?.rateBreakdownByCamera || [];

    if (!rows.length) return null;

    return (
        <div className={cn('mt-2', compact ? 'space-y-1' : 'space-y-2')}>
            <button
                type="button"
                onClick={() => setIsExpanded((prev) => !prev)}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 transition hover:text-blue-800"
            >
                {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                {isExpanded ? 'Hide rate basis' : 'Show rate basis'}
            </button>
            {isExpanded && (
                <div className={cn(
                    'rounded-lg border border-slate-200 bg-white/70',
                    compact ? 'p-2' : 'p-3',
                )}>
                    <div className="grid grid-cols-[minmax(0,1.4fr)_auto_auto_auto] gap-2 border-b border-slate-200 pb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        <span>Camera</span>
                        <span className="text-right">Unique</span>
                        <span className="text-right">Traffic Base</span>
                        <span className="text-right">Used</span>
                    </div>
                    <div className="mt-2 space-y-2">
                        {rows.map((row) => (
                            <div key={row.cameraId} className="grid grid-cols-[minmax(0,1.4fr)_auto_auto_auto] gap-2 text-xs text-slate-700">
                                <div className="min-w-0">
                                    <div className="truncate font-medium text-slate-900">{row.cameraLabel}</div>
                                    <div className="truncate text-[11px] text-muted-foreground">
                                        {formatDressCodeDenominatorSource(row.denominatorSource)}
                                        {row.violationCount > 0 ? ` | ${formatNumber(row.violationCount)} violation${row.violationCount !== 1 ? 's' : ''}` : ''}
                                    </div>
                                </div>
                                <div className="text-right font-medium">{formatNumber(row.uniqueViolators)}</div>
                                <div className="text-right font-medium">
                                    {row.includedInRate ? formatNumber(row.denominatorValue) : '-'}
                                </div>
                                <div className={cn(
                                    'text-right font-medium',
                                    row.includedInRate ? 'text-green-700' : 'text-slate-500',
                                )}>
                                    {row.includedInRate ? 'Yes' : 'No'}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

const aggregateFallDetectionAnalytics = (events) => {
    const fallEvents = events
        .filter((evt) => evt.event_type === 'Fall Detected')
        .sort((a, b) => getReportTimeMs(b) - getReportTimeMs(a));

    const affectedCameraIds = new Set(
        fallEvents
            .map((evt) => evt.camera_id)
            .filter(Boolean),
    );

    const latestEvent = fallEvents[0] || null;

    return {
        totalFalls: fallEvents.length,
        affectedCameraCount: affectedCameraIds.size,
        latestEventLabel: latestEvent ? formatReportTime(latestEvent) : '-',
        peakFallTimeLabel: getPeakTwoHourLabel(fallEvents),
    };
};

const getOccupancyTickLabel = (date, rangeKey) => {
    if (rangeKey === '1h' || rangeKey === '6h' || rangeKey === '24h') {
        return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const findNearestIndexByTimestamp = (rows, targetTs) => {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    if (typeof targetTs !== 'number' || Number.isNaN(targetTs)) return 0;

    let nearestIndex = 0;
    let nearestDelta = Math.abs((rows[0]?.tsMs ?? 0) - targetTs);

    for (let idx = 1; idx < rows.length; idx += 1) {
        const delta = Math.abs((rows[idx]?.tsMs ?? 0) - targetTs);
        if (delta < nearestDelta) {
            nearestDelta = delta;
            nearestIndex = idx;
        }
    }
    return nearestIndex;
};

// --- Detail Modal ---
const DetailModal = ({ record, onClose, apiUrl }) => {
    if (!record) return null;

    const snapshotId = record.details?.snapshot_path ? record.id : null;
    const snapshotUrl = snapshotId ? `${apiUrl}/api/snapshots/${snapshotId}` : null;
    const isSnapshot = record._isSnapshot;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <Card className="w-full max-w-lg bg-background shadow-lg">
                <CardHeader className="flex flex-row items-center justify-between border-b pb-4">
                    <CardTitle>{isSnapshot ? 'Counting Snapshot' : 'Event Details'}</CardTitle>
                    <Button variant="ghost" size="icon" onClick={onClose}><XCircle className="w-5 h-5" /></Button>
                </CardHeader>
                <CardContent className="space-y-4 pt-4">
                    {!isSnapshot && (
                        <div className="aspect-video w-full bg-black/5 rounded-lg flex items-center justify-center border relative overflow-hidden">
                            {snapshotUrl ? (
                                <img src={snapshotUrl} alt="Evidence" className="object-contain w-full h-full"
                                    onError={(e) => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }} />
                            ) : null}
                            <span className="text-muted-foreground absolute" style={{ display: snapshotUrl ? 'none' : 'flex' }}>
                                No Snapshot Available
                            </span>
                        </div>
                    )}

                    <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                            <p className="text-muted-foreground font-medium">ID</p>
                            <p className="font-mono text-xs">{record.id}</p>
                        </div>
                        <div>
                            <p className="text-muted-foreground font-medium">Timestamp</p>
                            <p>{formatReportTime(record)}</p>
                        </div>
                        <div>
                            <p className="text-muted-foreground font-medium">Processed At</p>
                            <p>{formatTimestamp(record.processed_at)}</p>
                        </div>
                        <div>
                            <p className="text-muted-foreground font-medium">Camera Name</p>
                            <p className="truncate">{getCameraLabel(record)}</p>
                        </div>
                        <div>
                            <p className="text-muted-foreground font-medium">Camera ID</p>
                            <p className="truncate font-mono text-xs">{record.camera_id || '-'}</p>
                        </div>

                        {isSnapshot ? (
                            <>
                                <div>
                                    <p className="text-muted-foreground font-medium">Total In</p>
                                    <p className="text-green-500 font-bold">{record.total_in}</p>
                                </div>
                                <div>
                                    <p className="text-muted-foreground font-medium">Total Out</p>
                                    <p className="text-red-500 font-bold">{record.total_out}</p>
                                </div>
                                <div>
                                    <p className="text-muted-foreground font-medium">Occupancy</p>
                                    <p className="text-primary font-bold">{record.current_occupancy}</p>
                                </div>
                                <div>
                                    <p className="text-muted-foreground font-medium">Foot Traffic</p>
                                    <p className="text-slate-700 font-bold">{formatNumber(record.foot_traffic_total)}</p>
                                </div>
                            </>
                        ) : (
                            <>
                                <div>
                                    <p className="text-muted-foreground font-medium">Event Type</p>
                                    <div className="flex items-center gap-2">
                                        <AlertTriangle className="w-3 h-3 text-red-500" />
                                        {record.event_type}
                                    </div>
                                </div>
                                {record.details?.label && (
                                    <div>
                                        <p className="text-muted-foreground font-medium">Classification</p>
                                        <p>{record.details.label.replace(/_/g, ' ')}</p>
                                    </div>
                                )}
                                {record.details?.confidence && (
                                    <div>
                                        <p className="text-muted-foreground font-medium">Confidence</p>
                                        <p>{Math.round(record.details.confidence * 100)}%</p>
                                    </div>
                                )}
                                {record.details?.track_id && (
                                    <div>
                                        <p className="text-muted-foreground font-medium">Track ID</p>
                                        <p className="font-mono">{record.details.track_id}</p>
                                    </div>
                                )}
                                {record.details?.occupancy !== undefined && (
                                    <div>
                                        <p className="text-muted-foreground font-medium">Occupancy</p>
                                        <p>{record.details.occupancy}</p>
                                    </div>
                                )}
                                {record.details?.building_id && (
                                    <div>
                                        <p className="text-muted-foreground font-medium">Building ID</p>
                                        <p>{record.details.building_id}</p>
                                    </div>
                                )}
                                {record.details?.max_capacity !== undefined && (
                                    <div>
                                        <p className="text-muted-foreground font-medium">Max Capacity</p>
                                        <p>{record.details.max_capacity}</p>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </CardContent>
            </Card>
        </div>
    );
};

// --- Export Dialog ---
const ExportDialog = ({ isOpen, onClose, onExport }) => {
    if (!isOpen) return null;
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <Card className="w-full max-w-sm">
                <CardHeader><CardTitle>Export Report</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                    <p className="text-sm text-muted-foreground">Select the format you wish to download.</p>
                    <div className="grid grid-cols-2 gap-3">
                        <Button variant="outline" className="flex flex-col h-20 items-center justify-center gap-2 hover:bg-primary/5 hover:border-primary" onClick={() => onExport('CSV')}>
                            <FileText className="w-6 h-6" /> CSV
                        </Button>
                        <Button variant="outline" className="flex flex-col h-20 items-center justify-center gap-2 hover:bg-primary/5 hover:border-primary" onClick={() => onExport('PDF')}>
                            <FileText className="w-6 h-6" /> PDF
                        </Button>
                    </div>
                    <Button variant="ghost" className="w-full" onClick={onClose}>Cancel</Button>
                </CardContent>
            </Card>
        </div>
    );
};

const escapeExportHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const FlowTrendPanel = ({ snapshots, cameraLabel }) => {
    const [timeRange, setTimeRange] = useState('24h');
    const [customStart, setCustomStart] = useState(() => createDefaultCustomRange().start);
    const [customEnd, setCustomEnd] = useState(() => createDefaultCustomRange().end);
    const [selectedBucket, setSelectedBucket] = useState('auto');
    const [showOccupancy, setShowOccupancy] = useState(false);

    const rangeBounds = useMemo(
        () => getHistoryRangeBounds(timeRange, customStart, customEnd),
        [timeRange, customStart, customEnd],
    );
    const effectiveBucket = useMemo(() => (
        selectedBucket === 'auto'
            ? getAdaptiveFlowBucket(timeRange, rangeBounds.startMs, rangeBounds.endMs)
            : selectedBucket
    ), [selectedBucket, timeRange, rangeBounds.startMs, rangeBounds.endMs]);

    const flowSummary = useMemo(() => {
        if (!rangeBounds.valid) {
            return {
                series: [],
                totalIn: 0,
                totalOut: 0,
                totalTraffic: 0,
                peakOccupancy: 0,
                estimatedOccupancy: 0,
                peakPeriodLabel: '-',
                resetCount: 0,
            };
        }
        return aggregateCountingFlow(snapshots, {
            startMs: rangeBounds.startMs,
            endMs: rangeBounds.endMs,
            bucket: effectiveBucket,
        });
    }, [effectiveBucket, rangeBounds.endMs, rangeBounds.startMs, rangeBounds.valid, snapshots]);

    const isDailyView = effectiveBucket === '1d';
    const ChartComponent = isDailyView ? ComposedChart : ComposedChart;

    return (
        <Card className={cn(REPORT_SURFACE_CARD_CLASS, "flex flex-col min-h-[420px]")}>
            <CardHeader className="space-y-3">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                        <CardTitle className="flex items-center gap-2">
                            <TrendingUp className="w-4 h-4" />
                            In/Out Over Time
                        </CardTitle>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {cameraLabel} flow trend with adaptive {effectiveBucket === '15m' ? '15-minute' : effectiveBucket === '1h' ? 'hourly' : 'daily'} buckets.
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-muted-foreground">Range</span>
                        <select
                            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                            value={timeRange}
                            onChange={(e) => setTimeRange(e.target.value)}
                        >
                            <option value="1h">Last 1 hour</option>
                            <option value="6h">Last 6 hours</option>
                            <option value="24h">Last 24 hours</option>
                            <option value="7d">Last 7 days</option>
                            <option value="30d">Last 30 days</option>
                            <option value="all">All data</option>
                            <option value="custom">Custom range</option>
                        </select>
                        <span className="text-xs font-medium text-muted-foreground">Grouping</span>
                        <select
                            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                            value={selectedBucket}
                            onChange={(e) => setSelectedBucket(e.target.value)}
                        >
                            <option value="auto">Auto</option>
                            <option value="15m">15 min</option>
                            <option value="1h">Hourly</option>
                            <option value="1d">Daily</option>
                        </select>
                        <label className="inline-flex items-center gap-2 rounded-md border border-input px-2 py-1.5 text-xs text-muted-foreground">
                            <Checkbox checked={showOccupancy} onCheckedChange={setShowOccupancy} />
                            Show occupancy
                        </label>
                    </div>
                </div>
                <p className="text-xs text-muted-foreground">
                    Range controls how much history is shown. Grouping controls whether the trend is combined into 15-minute, hourly, or daily points.
                </p>

                {timeRange === 'custom' && (
                    <div className="flex flex-wrap items-center gap-2">
                        <input
                            type="datetime-local"
                            value={customStart}
                            onChange={(e) => setCustomStart(e.target.value)}
                            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                        />
                        <span className="text-xs text-muted-foreground">to</span>
                        <input
                            type="datetime-local"
                            value={customEnd}
                            onChange={(e) => setCustomEnd(e.target.value)}
                            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                        />
                    </div>
                )}

                {flowSummary.resetCount > 0 && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700">
                        {flowSummary.resetCount} counter reset{flowSummary.resetCount !== 1 ? 's were' : ' was'} detected in this trend range. Flow totals are rebuilt from changes between saved snapshots, so occupancy should be treated as an estimate.
                    </div>
                )}
            </CardHeader>
            <CardContent className="flex-1 min-h-[300px]">
                {flowSummary.series.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                        <ChartComponent data={flowSummary.series} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                            <XAxis dataKey="label" className="text-xs text-muted-foreground" tickLine={false} axisLine={false} />
                            <YAxis
                                yAxisId="flow"
                                className="text-xs text-muted-foreground"
                                tickLine={false}
                                axisLine={false}
                                allowDecimals={false}
                            />
                            {showOccupancy && (
                                <YAxis
                                    yAxisId="occupancy"
                                    orientation="right"
                                    className="text-xs text-muted-foreground"
                                    tickLine={false}
                                    axisLine={false}
                                    allowDecimals={false}
                                />
                            )}
                            <RechartsTooltip
                                cursor={{ strokeDasharray: '3 3' }}
                                labelFormatter={(_, payload) => payload?.[0]?.payload?.fullLabel || ''}
                                formatter={(value, name) => [formatNumber(value), name]}
                                contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                            />
                            <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                            {isDailyView ? (
                                <>
                                    <Bar yAxisId="flow" dataKey="in" name="In" fill="#22c55e" radius={[4, 4, 0, 0]} maxBarSize={36} />
                                    <Bar yAxisId="flow" dataKey="out" name="Out" fill="#ef4444" radius={[4, 4, 0, 0]} maxBarSize={36} />
                                </>
                            ) : (
                                <>
                                    <Line yAxisId="flow" type="monotone" dataKey="in" name="In" stroke="#22c55e" strokeWidth={2.5} dot={false} />
                                    <Line yAxisId="flow" type="monotone" dataKey="out" name="Out" stroke="#ef4444" strokeWidth={2.5} dot={false} />
                                </>
                            )}
                            {showOccupancy && (
                                <Line
                                    yAxisId="occupancy"
                                    type="monotone"
                                    dataKey="occupancy"
                                    name="Occupancy"
                                    stroke="#2563eb"
                                    strokeWidth={2}
                                    dot={false}
                                    strokeDasharray="6 4"
                                />
                            )}
                        </ChartComponent>
                    </ResponsiveContainer>
                ) : (
                    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                        {rangeBounds.valid ? 'No people-counting flow data available for the selected trend range' : 'Choose a valid custom date/time range to view flow'}
                    </div>
                )}
            </CardContent>
        </Card>
    );
};

const TrafficAnalyticsPanel = ({ snapshots, cameraLabel, startMs, endMs, isAllCameras, latestSnapshotTotals = null }) => {
    const summaryBucket = useMemo(() => {
        const nowMs = Date.now();
        const effectiveEndMs = endMs ?? nowMs;
        const effectiveStartMs = startMs ?? Math.max(0, effectiveEndMs - OCCUPANCY_RANGE_LOOKBACK_MS['7d']);
        return getAdaptiveFlowBucket('custom', effectiveStartMs, effectiveEndMs);
    }, [endMs, startMs]);

    const trafficSummary = useMemo(() => aggregateTrafficAnalytics(snapshots, {
        startMs,
        endMs,
        bucket: summaryBucket,
    }), [endMs, snapshots, startMs, summaryBucket]);

      const dailyTrafficSeries = useMemo(() => (
          aggregateTrafficAnalytics(snapshots, {
              startMs,
              endMs,
              bucket: '1d',
          }).series.slice(-14)
      ), [endMs, snapshots, startMs]);

      const displayedLeftTraffic = latestSnapshotTotals
          ? Number(latestSnapshotTotals.foot_traffic_left ?? 0)
          : Number(trafficSummary.totalLeftTraffic ?? 0);
      const displayedRightTraffic = latestSnapshotTotals
          ? Number(latestSnapshotTotals.foot_traffic_right ?? 0)
          : Number(trafficSummary.totalRightTraffic ?? 0);
      const displayedFootTraffic = latestSnapshotTotals
          ? Number(latestSnapshotTotals.foot_traffic_total ?? (displayedLeftTraffic + displayedRightTraffic))
          : Number(trafficSummary.totalFootTraffic ?? 0);
      const displayedEntries = latestSnapshotTotals
          ? Number(latestSnapshotTotals.total_in ?? 0)
          : Number(trafficSummary.totalEntries ?? 0);
      const displayedCaptureRate = displayedFootTraffic > 0
          ? (displayedEntries / displayedFootTraffic) * 100
          : 0;

      const isAdaptiveDaily = summaryBucket === '1d';
      const TrendChartComponent = isAdaptiveDaily ? ComposedChart : ComposedChart;

    return (
        <div className="space-y-6">
            <div className={cn(REPORT_SECTION_HEADER_CLASS, "space-y-1")}>
                <h2 className="text-lg font-semibold tracking-tight">Traffic Analytics</h2>
                <p className="text-sm text-muted-foreground">
                    Foot-traffic and conversion reporting for {cameraLabel}.
                </p>
            </div>

            {isAllCameras && (
                <div className="rounded-md border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-sm text-blue-700">
                    Combined traffic analytics are being shown across all selected cameras. Choose a single camera for the clearest camera-level conversion view.
                </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-xl border border-sky-500/20 bg-sky-500/10 p-4">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <ArrowLeft className="h-4 w-4 text-sky-600" />
                          Left Traffic
                      </div>
                    <div className="mt-2 text-3xl font-bold text-sky-700">{formatNumber(displayedLeftTraffic)}</div>
                  </div>
                  <div className="rounded-xl border border-violet-500/20 bg-violet-500/10 p-4">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <ArrowRight className="h-4 w-4 text-violet-600" />
                          Right Traffic
                      </div>
                      <div className="mt-2 text-3xl font-bold text-violet-700">{formatNumber(displayedRightTraffic)}</div>
                  </div>
                  <div className="rounded-xl border border-slate-300 bg-slate-50 p-4">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Activity className="h-4 w-4 text-slate-700" />
                          Total Traffic Flow
                      </div>
                      <div className="mt-2 text-3xl font-bold text-slate-800">{formatNumber(displayedFootTraffic)}</div>
                  </div>
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Clock3 className="h-4 w-4 text-amber-600" />
                        Peak Traffic Period
                    </div>
                    <div className="mt-2 text-lg font-semibold text-amber-700">{trafficSummary.peakTrafficPeriodLabel}</div>
                </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-2">
                <Card className={cn(REPORT_SURFACE_CARD_CLASS, "flex flex-col min-h-[360px]")}>
                    <CardHeader>
                        <CardTitle>Left/Right Traffic Over Time</CardTitle>
                    </CardHeader>
                    <CardContent className="flex-1 min-h-[260px]">
                        {trafficSummary.series.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%">
                                <TrendChartComponent data={trafficSummary.series} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                                    <XAxis dataKey="label" className="text-xs text-muted-foreground" tickLine={false} axisLine={false} />
                                    <YAxis className="text-xs text-muted-foreground" tickLine={false} axisLine={false} allowDecimals={false} />
                                    <RechartsTooltip
                                        cursor={{ strokeDasharray: '3 3' }}
                                        labelFormatter={(_, payload) => payload?.[0]?.payload?.fullLabel || ''}
                                        formatter={(value, name) => [formatNumber(value), name]}
                                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                                    />
                                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                                    {isAdaptiveDaily ? (
                                        <>
                                            <Bar dataKey="leftTraffic" name="Left Traffic" fill="#0ea5e9" radius={[4, 4, 0, 0]} maxBarSize={36} />
                                            <Bar dataKey="rightTraffic" name="Right Traffic" fill="#8b5cf6" radius={[4, 4, 0, 0]} maxBarSize={36} />
                                        </>
                                    ) : (
                                        <>
                                            <Line type="monotone" dataKey="leftTraffic" name="Left Traffic" stroke="#0ea5e9" strokeWidth={2.5} dot={false} />
                                            <Line type="monotone" dataKey="rightTraffic" name="Right Traffic" stroke="#8b5cf6" strokeWidth={2.5} dot={false} />
                                        </>
                                    )}
                                </TrendChartComponent>
                            </ResponsiveContainer>
                        ) : (
                            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                                No traffic data available for the selected report range
                            </div>
                        )}
                    </CardContent>
                </Card>

                <Card className={cn(REPORT_SURFACE_CARD_CLASS, "flex flex-col min-h-[360px]")}>
                    <CardHeader>
                        <CardTitle>Left/Right Traffic by Day</CardTitle>
                    </CardHeader>
                    <CardContent className="flex-1 min-h-[260px]">
                        {dailyTrafficSeries.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={dailyTrafficSeries} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                                    <XAxis dataKey="label" className="text-xs text-muted-foreground" tickLine={false} axisLine={false} />
                                    <YAxis className="text-xs text-muted-foreground" tickLine={false} axisLine={false} allowDecimals={false} />
                                    <RechartsTooltip
                                        cursor={{ fill: 'transparent' }}
                                        formatter={(value, name) => [formatNumber(value), name]}
                                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                                    />
                                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                                    <Bar dataKey="leftTraffic" name="Left Traffic" fill="#0ea5e9" radius={[4, 4, 0, 0]} maxBarSize={36} />
                                    <Bar dataKey="rightTraffic" name="Right Traffic" fill="#8b5cf6" radius={[4, 4, 0, 0]} maxBarSize={36} />
                                </BarChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                                No daily traffic data available
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-xl border border-slate-300 bg-slate-50 p-4">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Activity className="h-4 w-4 text-slate-700" />
                          Total Foot Traffic
                      </div>
                      <div className="mt-2 text-3xl font-bold text-slate-800">{formatNumber(displayedFootTraffic)}</div>
                  </div>
                  <div className="rounded-xl border border-green-500/20 bg-green-500/10 p-4">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <ArrowDownToLine className="h-4 w-4 text-green-600" />
                          Total Entries
                      </div>
                      <div className="mt-2 text-3xl font-bold text-green-600">{formatNumber(displayedEntries)}</div>
                  </div>
                  <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/10 p-4">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Target className="h-4 w-4 text-indigo-600" />
                          Capture Rate
                      </div>
                      <div className="mt-2 text-3xl font-bold text-indigo-700">{displayedCaptureRate.toFixed(1)}%</div>
                  </div>
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Clock3 className="h-4 w-4 text-amber-600" />
                        Peak Conversion Period
                    </div>
                    <div className="mt-2 text-lg font-semibold text-amber-700">{trafficSummary.peakConversionPeriodLabel}</div>
                </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-2">
                <Card className={cn(REPORT_SURFACE_CARD_CLASS, "flex flex-col min-h-[360px]")}>
                    <CardHeader>
                        <CardTitle>Capture Rate Over Time</CardTitle>
                    </CardHeader>
                    <CardContent className="flex-1 min-h-[260px]">
                        {trafficSummary.series.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={trafficSummary.series} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                                    <XAxis dataKey="label" className="text-xs text-muted-foreground" tickLine={false} axisLine={false} />
                                    <YAxis className="text-xs text-muted-foreground" tickLine={false} axisLine={false} domain={[0, 100]} tickFormatter={(value) => `${value}%`} />
                                    <RechartsTooltip
                                        cursor={{ strokeDasharray: '3 3' }}
                                        labelFormatter={(_, payload) => payload?.[0]?.payload?.fullLabel || ''}
                                        formatter={(value, name) => [`${Number(value).toFixed(1)}%`, name]}
                                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                                    />
                                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                                    <Line type="monotone" dataKey="captureRate" name="Capture Rate" stroke="#4f46e5" strokeWidth={2.5} dot={false} />
                                </LineChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                                No capture-rate data available for the selected report range
                            </div>
                        )}
                    </CardContent>
                </Card>

                <Card className={cn(REPORT_SURFACE_CARD_CLASS, "flex flex-col min-h-[360px]")}>
                    <CardHeader>
                        <CardTitle>Foot Traffic vs Entries Over Time</CardTitle>
                    </CardHeader>
                    <CardContent className="flex-1 min-h-[260px]">
                        {trafficSummary.series.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%">
                                <ComposedChart data={trafficSummary.series} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                                    <XAxis dataKey="label" className="text-xs text-muted-foreground" tickLine={false} axisLine={false} />
                                    <YAxis className="text-xs text-muted-foreground" tickLine={false} axisLine={false} allowDecimals={false} />
                                    <RechartsTooltip
                                        cursor={{ strokeDasharray: '3 3' }}
                                        labelFormatter={(_, payload) => payload?.[0]?.payload?.fullLabel || ''}
                                        formatter={(value, name) => [formatNumber(value), name]}
                                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                                    />
                                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                                    <Bar dataKey="totalFootTraffic" name="Foot Traffic" fill="#94a3b8" radius={[4, 4, 0, 0]} maxBarSize={36} />
                                    <Line type="monotone" dataKey="entries" name="Entries" stroke="#16a34a" strokeWidth={2.5} dot={false} />
                                </ComposedChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                                No comparison data available for the selected report range
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            <Card className={cn(REPORT_SURFACE_CARD_CLASS, "flex flex-col min-h-[360px]")}>
                <CardHeader>
                    <CardTitle>Capture Rate by Day</CardTitle>
                </CardHeader>
                <CardContent className="flex-1 min-h-[260px]">
                    <div className="h-[260px]">
                        {dailyTrafficSeries.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={dailyTrafficSeries} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                                    <XAxis dataKey="label" className="text-xs text-muted-foreground" tickLine={false} axisLine={false} />
                                    <YAxis className="text-xs text-muted-foreground" tickLine={false} axisLine={false} domain={[0, 100]} tickFormatter={(value) => `${value}%`} />
                                    <RechartsTooltip
                                        cursor={{ fill: 'transparent' }}
                                        formatter={(value, name) => [`${Number(value).toFixed(1)}%`, name]}
                                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                                    />
                                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                                    <Bar dataKey="captureRate" name="Capture Rate" fill="#4f46e5" radius={[4, 4, 0, 0]} maxBarSize={36} />
                                </BarChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                                No daily capture-rate data available
                            </div>
                        )}
                    </div>
                </CardContent>
            </Card>
        </div>
    );
};

const DressCodeAnalyticsPanel = ({ events, snapshots, cameraLabel, startMs, endMs, isAllCameras }) => {
    const initialCustomRange = useMemo(
        () => createCustomRangeFromBounds(startMs, endMs),
        [startMs, endMs],
    );
    const [timeRange, setTimeRange] = useState('24h');
    const [customStart, setCustomStart] = useState(initialCustomRange.start);
    const [customEnd, setCustomEnd] = useState(initialCustomRange.end);
    const [selectedBucket, setSelectedBucket] = useState('auto');

    useEffect(() => {
        setCustomStart(initialCustomRange.start);
        setCustomEnd(initialCustomRange.end);
    }, [initialCustomRange.end, initialCustomRange.start]);

    const chartRangeBounds = useMemo(
        () => getHistoryRangeBounds(timeRange, customStart, customEnd, endMs ?? Date.now()),
        [timeRange, customStart, customEnd, endMs],
    );
    const effectiveBucket = useMemo(() => (
        selectedBucket === 'auto'
            ? getAdaptiveFlowBucket(timeRange, chartRangeBounds.startMs, chartRangeBounds.endMs)
            : selectedBucket
    ), [selectedBucket, timeRange, chartRangeBounds.startMs, chartRangeBounds.endMs]);
    const analytics = useMemo(() => aggregateDressCodeAnalytics(events, snapshots, {
        startMs,
        endMs,
    }), [endMs, events, snapshots, startMs]);
    const chartAnalytics = useMemo(() => {
        if (!chartRangeBounds.valid) {
            return {
                ...analytics,
                rateSeries: [],
            };
        }

        return aggregateDressCodeAnalytics(events, snapshots, {
            startMs: chartRangeBounds.startMs,
            endMs: chartRangeBounds.endMs,
            bucket: effectiveBucket,
        });
    }, [analytics, chartRangeBounds.endMs, chartRangeBounds.startMs, chartRangeBounds.valid, effectiveBucket, events, snapshots]);
    const violationRateCoverageNote = useMemo(
        () => getDressCodeRateCoverageNote(analytics),
        [analytics],
    );

    return (
        <div className="space-y-6">
            <div className={cn(REPORT_SECTION_HEADER_CLASS, "space-y-1")}>
                <h2 className="text-lg font-semibold tracking-tight">Dress Code Reporting</h2>
                <p className="text-sm text-muted-foreground">
                    Violation summary and rate trends for {cameraLabel}.
                </p>
            </div>

            {isAllCameras && (
                <div className="rounded-md border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-sm text-blue-700">
                    Combined dress code analytics are being shown across all selected cameras. Choose a single camera for the clearest camera-level view.
                </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <AlertTriangle className="h-4 w-4 text-red-600" />
                        Total Violations
                    </div>
                    <div className="mt-2 text-3xl font-bold text-red-600">{formatNumber(analytics.totalViolations)}</div>
                </div>
                <div className="rounded-xl border border-slate-300 bg-slate-50 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Users className="h-4 w-4 text-slate-700" />
                        Unique Violators
                    </div>
                    <div className="mt-2 text-3xl font-bold text-slate-800">{formatNumber(analytics.uniqueViolators)}</div>
                </div>
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <TrendingUp className="h-4 w-4 text-amber-600" />
                        Violation Rate
                    </div>
                    <div className="mt-2 text-3xl font-bold text-amber-700">
                        {analytics.hasTrafficBase ? formatPercent(analytics.violationRate) : '-'}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                        {violationRateCoverageNote || 'Based on available traffic denominator'}
                    </div>
                    <DressCodeRateBreakdown analytics={analytics} />
                </div>
                <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/10 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Clock3 className="h-4 w-4 text-indigo-600" />
                        Peak Violation Time
                    </div>
                    <div className="mt-2 text-lg font-semibold text-indigo-700">{chartAnalytics.peakViolationTimeLabel}</div>
                </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-2">
                <Card className={cn(REPORT_SURFACE_CARD_CLASS, "flex flex-col min-h-[360px]")}>
                    <CardHeader>
                        <CardTitle>Violation Breakdown</CardTitle>
                    </CardHeader>
                    <CardContent className="flex-1 min-h-[260px]">
                        {analytics.breakdown.some((item) => item.count > 0) ? (
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart
                                    data={analytics.breakdown}
                                    layout="vertical"
                                    margin={{ top: 10, right: 20, left: 20, bottom: 0 }}
                                >
                                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
                                    <XAxis type="number" className="text-xs text-muted-foreground" tickLine={false} axisLine={false} tickFormatter={(value) => `${value}%`} domain={[0, 100]} />
                                    <YAxis type="category" dataKey="name" className="text-xs text-muted-foreground" tickLine={false} axisLine={false} width={80} />
                                    <RechartsTooltip
                                        cursor={{ fill: 'transparent' }}
                                        formatter={(value, name, item) => [`${Number(value).toFixed(1)}% (${formatNumber(item?.payload?.count)})`, name]}
                                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                                    />
                                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                                    <Bar dataKey="percentage" name="Share of Violations" fill="#ef4444" radius={[0, 4, 4, 0]} />
                                </BarChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                                No dress code violations found for the selected report range
                            </div>
                        )}
                    </CardContent>
                </Card>

                <Card className={cn(REPORT_SURFACE_CARD_CLASS, "flex flex-col min-h-[360px]")}>
                    <CardHeader className="space-y-3">
                        <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                            <div>
                                <CardTitle>Violation Rate Over Time</CardTitle>
                                {/* <p className="mt-1 text-sm text-muted-foreground">
                                    Explore violation spikes across shorter or longer time windows with {effectiveBucket === '15m' ? '15-minute' : effectiveBucket === '1h' ? 'hourly' : 'daily'} grouping.
                                </p> */}
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-xs font-medium text-muted-foreground">Range</span>
                                <select
                                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                                    value={timeRange}
                                    onChange={(e) => setTimeRange(e.target.value)}
                                >
                                    <option value="1h">Last 1 hour</option>
                                    <option value="6h">Last 6 hours</option>
                                    <option value="24h">Last 24 hours</option>
                                    <option value="7d">Last 7 days</option>
                                    <option value="30d">Last 30 days</option>
                                    <option value="all">All data</option>
                                    <option value="custom">Custom range</option>
                                </select>
                                <span className="text-xs font-medium text-muted-foreground">Grouping</span>
                                <select
                                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                                    value={selectedBucket}
                                    onChange={(e) => setSelectedBucket(e.target.value)}
                                >
                                    <option value="auto">Auto</option>
                                    <option value="15m">15 min</option>
                                    <option value="1h">Hourly</option>
                                    <option value="1d">Daily</option>
                                </select>
                            </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Range controls how much history is shown. Grouping controls whether the trend is combined into 15-minute, hourly, or daily points.
                        </p>
                        {timeRange === 'custom' && (
                            <div className="flex flex-wrap items-center gap-2">
                                <input
                                    type="datetime-local"
                                    value={customStart}
                                    onChange={(e) => setCustomStart(e.target.value)}
                                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                                />
                                <span className="text-xs text-muted-foreground">to</span>
                                <input
                                    type="datetime-local"
                                    value={customEnd}
                                    onChange={(e) => setCustomEnd(e.target.value)}
                                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                                />
                            </div>
                        )}
                    </CardHeader>
                    <CardContent className="flex-1 min-h-[260px]">
                        {chartAnalytics.rateSeries.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%">
                                <ComposedChart data={chartAnalytics.rateSeries} margin={{ top: 10, right: 10, left: 8, bottom: 0 }}>
                                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                                    <XAxis dataKey="label" className="text-xs text-muted-foreground" tickLine={false} axisLine={false} />
                                    <YAxis
                                        yAxisId="rate"
                                        width={42}
                                        className="text-xs text-muted-foreground"
                                        tickLine={false}
                                        axisLine={false}
                                        tickFormatter={(value) => `${Math.round(Number(value || 0))}%`}
                                        domain={[0, 100]}
                                    />
                                    <YAxis
                                        yAxisId="count"
                                        orientation="right"
                                        width={42}
                                        className="text-xs text-muted-foreground"
                                        tickLine={false}
                                        axisLine={false}
                                        allowDecimals={false}
                                        tickFormatter={(value) => formatNumber(value)}
                                    />
                                    <RechartsTooltip
                                        cursor={{ strokeDasharray: '3 3' }}
                                        labelFormatter={(_, payload) => payload?.[0]?.payload?.fullLabel || ''}
                                        formatter={(value, name) => [name === 'Violation Rate' ? formatDetailedPercent(value) : formatNumber(value), name]}
                                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                                    />
                                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                                    <Bar yAxisId="count" dataKey="violations" name="Violations" fill="#fca5a5" radius={[4, 4, 0, 0]} maxBarSize={26} />
                                    <Line yAxisId="rate" type="monotone" dataKey="violationRate" name="Violation Rate" stroke="#dc2626" strokeWidth={2.5} dot={false} />
                                </ComposedChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                                {chartRangeBounds.valid
                                    ? 'No violation-rate trend data available for the selected range'
                                    : 'Choose a valid custom date/time range to view violation rate'}
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>
        </div>
    );
};

const BuildingOccupancyPanel = ({
    apiUrl,
    reportStartMs,
    reportEndMs,
    selectedBucket,
    refreshToken,
    visible,
    cameraNameById,
    countingSnapshots,
    selectedSourceFilter = 'all',
    selectedCameraFilter = 'all',
    cameraSourceKindById = {},
    preferLatestSnapshotTotals = false,
}) => {
    const [buildingSummary, setBuildingSummary] = useState(EMPTY_BUILDING_SUMMARY);
    const [buildingHistory, setBuildingHistory] = useState([]);
    const [selectedBuildingId, setSelectedBuildingId] = useState('all');
    const [loading, setLoading] = useState(false);
    const [rangeNowMs, setRangeNowMs] = useState(() => Date.now());
    const [brushWindow, setBrushWindow] = useState({ key: '', startTs: null, endTs: null });
    const [expandedEntranceIds, setExpandedEntranceIds] = useState(() => new Set());
    const brushFrameRef = useRef(null);
    const pendingBrushRangeRef = useRef(null);
    const buildingHistoryFetchBounds = useMemo(() => ({
        valid: reportStartMs == null || reportEndMs == null || reportStartMs <= reportEndMs,
        startMs: reportStartMs,
        endMs: reportEndMs ?? rangeNowMs,
    }), [rangeNowMs, reportEndMs, reportStartMs]);

    const fetchBuildingSummary = useCallback(async () => {
        if (!visible) return;
        try {
            const res = await fetch(`${apiUrl}/api/building-occupancy-summary`);
            if (!res.ok) return;
            const data = await res.json();
            setBuildingSummary(data);
        } catch (err) {
            console.error('Failed to fetch building occupancy summary:', err);
        }
    }, [apiUrl, visible]);

    const fetchBuildingHistory = useCallback(async () => {
        if (!visible) {
            setBuildingHistory([]);
            return;
        }
        if (!buildingHistoryFetchBounds.valid) {
            setBuildingHistory([]);
            return;
        }
        setLoading(true);
        try {
            const rows = [];
            let offset = 0;
            while (offset < MAX_BUILDING_HISTORY_ROWS) {
                const params = new URLSearchParams();
                appendQueryParam(params, 'limit', BUILDING_HISTORY_PAGE_SIZE);
                appendQueryParam(params, 'offset', offset);
                appendQueryParam(params, 'start', toApiDateTimeParam(buildingHistoryFetchBounds.startMs));
                appendQueryParam(params, 'end', toApiDateTimeParam(buildingHistoryFetchBounds.endMs));
                const res = await fetch(
                    `${apiUrl}/api/building-counting-history?${params.toString()}`,
                );
                if (!res.ok) break;

                const data = await res.json();
                if (!Array.isArray(data) || data.length === 0) break;

                rows.push(...data);
                offset += data.length;
                if (data.length < BUILDING_HISTORY_PAGE_SIZE) break;
            }

            const normalizedRows = rows
                .map((row) => {
                    const ts = parseApiTimestamp(row.timestamp) || parseApiTimestamp(row.processed_at);
                    if (!ts) return null;
                    return {
                        ...row,
                        ts,
                        tsMs: ts.getTime(),
                    };
                })
                .filter(Boolean)
                .sort((a, b) => a.tsMs - b.tsMs);

            setBuildingHistory(normalizedRows);
        } catch (err) {
            console.error('Failed to fetch building counting history:', err);
            setBuildingHistory([]);
        }
        setLoading(false);
    }, [apiUrl, buildingHistoryFetchBounds.endMs, buildingHistoryFetchBounds.startMs, buildingHistoryFetchBounds.valid, visible]);

    useEffect(() => {
        if (!visible) return undefined;
        const timeoutId = setTimeout(() => {
            void fetchBuildingSummary();
        }, 0);
        const interval = setInterval(fetchBuildingSummary, 10000);
        return () => {
            clearTimeout(timeoutId);
            clearInterval(interval);
        };
    }, [fetchBuildingSummary, visible, refreshToken]);

    useEffect(() => {
        if (!visible) return undefined;
        const timeoutId = setTimeout(() => {
            void fetchBuildingHistory();
        }, 0);
        return () => {
            clearTimeout(timeoutId);
        };
    }, [fetchBuildingHistory, visible, refreshToken]);

    useEffect(() => {
        if (!visible) return undefined;
        const intervalId = setInterval(() => {
            setRangeNowMs(Date.now());
        }, 60000);
        return () => clearInterval(intervalId);
    }, [visible]);

    const panelRangeBounds = useMemo(() => ({
        valid: reportStartMs == null || reportEndMs == null || reportStartMs <= reportEndMs,
        startMs: reportStartMs,
        endMs: reportEndMs ?? rangeNowMs,
    }), [rangeNowMs, reportEndMs, reportStartMs]);

    const scopedBuildingSummaryByCameraScope = useMemo(() => (
        filterBuildingAggregateForScope(buildingSummary, {
            selectedSourceFilter,
            selectedCameraFilter,
            cameraSourceKindById,
        })
    ), [buildingSummary, cameraSourceKindById, selectedCameraFilter, selectedSourceFilter]);

    const scopedBuildingHistoryByCameraScope = useMemo(() => (
        buildingHistory
            .map((row) => filterBuildingAggregateForScope(row, {
                selectedSourceFilter,
                selectedCameraFilter,
                cameraSourceKindById,
            }))
            .filter((row) => {
                if (selectedSourceFilter === 'all' && selectedCameraFilter === 'all') return true;
                return Object.keys(row?.entrance_summaries || {}).length > 0;
            })
    ), [buildingHistory, cameraSourceKindById, selectedCameraFilter, selectedSourceFilter]);

    const filteredHistory = useMemo(() => {
        if (!panelRangeBounds.valid) return [];
        return scopedBuildingHistoryByCameraScope.filter((row) => {
            if (panelRangeBounds.startMs !== null && row.tsMs < panelRangeBounds.startMs) return false;
            if (panelRangeBounds.endMs !== null && row.tsMs > panelRangeBounds.endMs) return false;
            return true;
        });
    }, [panelRangeBounds, scopedBuildingHistoryByCameraScope]);

    const buildingIdOptions = useMemo(() => {
        const ids = new Set();
        Object.keys(scopedBuildingSummaryByCameraScope.entrance_summaries ?? {}).forEach((buildingId) => {
            if (buildingId) ids.add(buildingId);
        });
        filteredHistory.forEach((row) => {
            Object.keys(row.entrance_summaries ?? {}).forEach((buildingId) => {
                if (buildingId) ids.add(buildingId);
            });
        });
        return ['all', ...Array.from(ids).sort((left, right) => String(left).localeCompare(String(right), undefined, {
            numeric: true,
            sensitivity: 'base',
        }))];
    }, [filteredHistory, scopedBuildingSummaryByCameraScope.entrance_summaries]);

    useEffect(() => {
        if (buildingIdOptions.includes(selectedBuildingId)) return;
        setSelectedBuildingId('all');
    }, [buildingIdOptions, selectedBuildingId]);

    const scopedBuildingSummary = useMemo(() => {
        if (selectedBuildingId === 'all') {
            return scopedBuildingSummaryByCameraScope;
        }

        const entrance = scopedBuildingSummaryByCameraScope.entrance_summaries?.[selectedBuildingId] || {};
        const cameraIds = Array.isArray(entrance.camera_ids) ? entrance.camera_ids : [];
        const maxCapacity = entrance.max_capacity ?? null;
        const occupancy = Number(entrance.occupancy ?? 0);

        return {
            ...scopedBuildingSummaryByCameraScope,
            max_capacity: maxCapacity,
            capacity_exceeded: Boolean(entrance.capacity_exceeded),
            exceeded_building_ids: entrance.capacity_exceeded ? [selectedBuildingId] : [],
            manual_offset: 0,
            raw_in: Number(entrance.total_in ?? 0),
            raw_out: Number(entrance.total_out ?? 0),
            raw_occupancy: occupancy,
            occupancy,
            active_camera_count: cameraIds.length,
            entrance_summaries: {
                [selectedBuildingId]: {
                    ...entrance,
                    camera_ids: cameraIds,
                },
            },
        };
    }, [scopedBuildingSummaryByCameraScope, selectedBuildingId]);

    const scopedHistory = useMemo(() => {
        if (selectedBuildingId === 'all') {
            return filteredHistory;
        }

        return filteredHistory.map((row) => {
            const entrance = row.entrance_summaries?.[selectedBuildingId] || {};
            const occupancy = Number(entrance.occupancy ?? 0);
            return {
                ...row,
                raw_in: Number(entrance.total_in ?? 0),
                raw_out: Number(entrance.total_out ?? 0),
                raw_occupancy: occupancy,
                max_capacity: entrance.max_capacity ?? null,
                capacity_exceeded: Boolean(entrance.capacity_exceeded),
                manual_offset: 0,
                occupancy,
                active_camera_count: Array.isArray(entrance.camera_ids) ? entrance.camera_ids.length : 0,
                entrance_summaries: {
                    [selectedBuildingId]: {
                        ...entrance,
                        camera_ids: Array.isArray(entrance.camera_ids) ? entrance.camera_ids : [],
                    },
                },
            };
        });
    }, [filteredHistory, selectedBuildingId]);

    const historyRangeKey = useMemo(() => {
        if (scopedHistory.length < 2) return '24h';
        const durationMs = scopedHistory[scopedHistory.length - 1].tsMs - scopedHistory[0].tsMs;
        return durationMs <= OCCUPANCY_RANGE_LOOKBACK_MS['24h'] ? '24h' : '7d';
    }, [scopedHistory]);

    const chartRows = useMemo(() => {
        const collapsedRows = collapseRowsByTimestamp(scopedHistory, (currentBest, candidate) => {
            const currentOccupancy = Number(currentBest?.occupancy ?? 0);
            const candidateOccupancy = Number(candidate?.occupancy ?? 0);
            if (candidateOccupancy > currentOccupancy) return candidate;
            if (candidateOccupancy < currentOccupancy) return currentBest;

            const currentRawOccupancy = Number(currentBest?.raw_occupancy ?? 0);
            const candidateRawOccupancy = Number(candidate?.raw_occupancy ?? 0);
            if (candidateRawOccupancy > currentRawOccupancy) return candidate;
            if (candidateRawOccupancy < currentRawOccupancy) return currentBest;

            return (Number(candidate?.raw_in ?? 0) + Number(candidate?.raw_out ?? 0))
                >= (Number(currentBest?.raw_in ?? 0) + Number(currentBest?.raw_out ?? 0))
                ? candidate
                : currentBest;
        });

        return downsampleSeries(collapsedRows, 2000, [
            (row) => Number(row?.occupancy ?? 0),
            (row) => Number(row?.raw_occupancy ?? 0),
        ]);
    }, [scopedHistory]);

    const chartData = useMemo(() => {
        const sampledRows = chartRows;
        return sampledRows.map((row) => ({
            time: getOccupancyTickLabel(row.ts, historyRangeKey),
            fullTime: row.ts.toLocaleString(),
            tsMs: row.tsMs,
            occupancy: row.occupancy,
            rawOccupancy: row.raw_occupancy,
        }));
    }, [chartRows, historyRangeKey]);

    const effectiveBucket = useMemo(() => {
        if (selectedBucket !== 'auto') return selectedBucket;
        return getAdaptiveFlowBucket(
            'custom',
            panelRangeBounds.startMs,
            panelRangeBounds.endMs ?? rangeNowMs,
        );
    }, [panelRangeBounds.endMs, panelRangeBounds.startMs, rangeNowMs, selectedBucket]);
    const brushContextKey = `${reportStartMs}|${reportEndMs}|${selectedBucket}`;
    const activeBrushWindow = useMemo(() => (
        brushWindow.key === brushContextKey
            ? brushWindow
            : { key: brushContextKey, startTs: null, endTs: null }
    ), [brushContextKey, brushWindow]);
    const brushIndices = useMemo(() => {
        const maxIndex = Math.max(chartData.length - 1, 0);
        if (!chartData.length) {
            return { startIndex: 0, endIndex: 0 };
        }
        if (activeBrushWindow.startTs == null || activeBrushWindow.endTs == null) {
            return { startIndex: 0, endIndex: maxIndex };
        }

        let startIndex = findNearestIndexByTimestamp(chartData, activeBrushWindow.startTs);
        let endIndex = findNearestIndexByTimestamp(chartData, activeBrushWindow.endTs);
        startIndex = clamp(startIndex, 0, maxIndex);
        endIndex = clamp(endIndex, 0, maxIndex);

        if (startIndex > endIndex) {
            return { startIndex: endIndex, endIndex: startIndex };
        }
        return { startIndex, endIndex };
    }, [activeBrushWindow, chartData]);

    useEffect(() => () => {
        if (brushFrameRef.current != null) {
            cancelAnimationFrame(brushFrameRef.current);
        }
    }, []);

    const commitBrushRange = useCallback((range) => {
        if (!range || !chartData.length) return;

        const maxIndex = chartData.length - 1;
        const rawStartIndex = Number(range.startIndex);
        const rawEndIndex = Number(range.endIndex);
        if (!Number.isFinite(rawStartIndex) || !Number.isFinite(rawEndIndex)) return;

        const startIndex = clamp(Math.round(rawStartIndex), 0, maxIndex);
        const endIndex = clamp(Math.round(rawEndIndex), 0, maxIndex);
        const startTs = chartData[startIndex]?.tsMs ?? null;
        const endTs = chartData[endIndex]?.tsMs ?? null;
        if (startTs == null || endTs == null) return;

        setBrushWindow((prev) => {
            if (prev.key === brushContextKey && prev.startTs === startTs && prev.endTs === endTs) return prev;
            return { key: brushContextKey, startTs, endTs };
        });
    }, [brushContextKey, chartData]);

    const handleBrushChange = useCallback((range) => {
        if (!range || !chartData.length) return;

        pendingBrushRangeRef.current = range;
        if (brushFrameRef.current != null) return;

        brushFrameRef.current = requestAnimationFrame(() => {
            brushFrameRef.current = null;
            const nextRange = pendingBrushRangeRef.current;
            pendingBrushRangeRef.current = null;
            commitBrushRange(nextRange);
        });
    }, [chartData.length, commitBrushRange]);

    const flowSummary = useMemo(() => {
        if (!panelRangeBounds.valid) {
            return {
                series: [],
                totalIn: 0,
                totalOut: 0,
                totalTraffic: 0,
                peakOccupancy: 0,
                peakOccupancyPeriodLabel: '-',
                estimatedOccupancy: 0,
                peakPeriodLabel: '-',
                resetCount: 0,
            };
        }

        return aggregateBuildingFlow(scopedHistory, {
            startMs: panelRangeBounds.startMs,
            endMs: panelRangeBounds.endMs,
            bucket: effectiveBucket,
        });
    }, [effectiveBucket, panelRangeBounds, scopedHistory]);

    const rangeSummary = useMemo(() => aggregateBuildingFlow(scopedHistory, {
        startMs: panelRangeBounds.valid ? panelRangeBounds.startMs : null,
        endMs: panelRangeBounds.valid ? panelRangeBounds.endMs : null,
        bucket: effectiveBucket,
    }), [effectiveBucket, panelRangeBounds, scopedHistory]);
    const rangeTotalsSummary = useMemo(() => aggregateBuildingRangeTotals(scopedHistory, {
        startMs: panelRangeBounds.valid ? panelRangeBounds.startMs : null,
        endMs: panelRangeBounds.valid ? panelRangeBounds.endMs : null,
    }), [panelRangeBounds, scopedHistory]);

    const latestBuildingSnapshotSummary = useMemo(() => summarizeLatestSnapshots(countingSnapshots, {
        startMs: panelRangeBounds.valid ? panelRangeBounds.startMs : null,
        endMs: panelRangeBounds.valid ? panelRangeBounds.endMs : null,
    }), [countingSnapshots, panelRangeBounds]);

    const latestBuildingEntranceContribution = useMemo(() => (
        buildEntranceContributionFromLatestSnapshots({
            latestSnapshotSummary: latestBuildingSnapshotSummary,
            entranceSummaries: scopedBuildingSummary.entrance_summaries,
        })
    ), [latestBuildingSnapshotSummary, scopedBuildingSummary.entrance_summaries]);

    const entranceContribution = useMemo(() => {
        const aggregated = aggregateBuildingEntranceContribution(scopedHistory, {
            startMs: panelRangeBounds.valid ? panelRangeBounds.startMs : null,
            endMs: panelRangeBounds.valid ? panelRangeBounds.endMs : null,
        });
        if (aggregated.entries.length > 0) {
            return aggregated;
        }

        const liveEntries = Object.entries(scopedBuildingSummary.entrance_summaries ?? {})
            .map(([entranceId, entrance]) => ({
                name: entranceId,
                totalIn: Number(entrance?.total_in ?? 0),
                totalOut: Number(entrance?.total_out ?? 0),
                totalTraffic: Number(entrance?.total_in ?? 0) + Number(entrance?.total_out ?? 0),
                currentOccupancy: Number(entrance?.occupancy ?? 0),
                cameraCount: Array.isArray(entrance?.camera_ids) ? entrance.camera_ids.length : 0,
                cameras: Object.entries(entrance?.camera_summaries ?? {})
                    .map(([cameraId, camera]) => ({
                        id: cameraId,
                        totalIn: Number(camera?.total_in ?? 0),
                        totalOut: Number(camera?.total_out ?? 0),
                        totalTraffic: Number(camera?.total_in ?? 0) + Number(camera?.total_out ?? 0),
                        currentOccupancy: Number(camera?.occupancy ?? 0),
                    }))
                    .sort((a, b) => Number(b.totalTraffic || 0) - Number(a.totalTraffic || 0)),
            }))
            .sort((a, b) => Number(b.totalTraffic || 0) - Number(a.totalTraffic || 0));
        const totalTraffic = liveEntries.reduce((sum, entry) => sum + Number(entry.totalTraffic || 0), 0);
        const entries = liveEntries.map((entry) => ({
            ...entry,
            share: totalTraffic > 0 ? (Number(entry.totalTraffic || 0) / totalTraffic) * 100 : 0,
            cameras: (entry.cameras || []).map((camera) => ({
                ...camera,
                share: Number(entry.totalTraffic || 0) > 0 ? (Number(camera.totalTraffic || 0) / Number(entry.totalTraffic || 0)) * 100 : 0,
            })),
        }));

        return {
            entries,
            totalTraffic,
            totalIn: entries.reduce((sum, entry) => sum + Number(entry.totalIn || 0), 0),
            totalOut: entries.reduce((sum, entry) => sum + Number(entry.totalOut || 0), 0),
            busiestEntrance: entries[0] || null,
        };
    }, [panelRangeBounds, scopedBuildingSummary.entrance_summaries, scopedHistory]);
    const deltaEntranceContributionWithCameraBreakdown = useMemo(() => {
        const entries = entranceContribution.entries.map((entry) => {
            const configuredCameraIds = Array.isArray(scopedBuildingSummary.entrance_summaries?.[entry.name]?.camera_ids)
                ? scopedBuildingSummary.entrance_summaries[entry.name].camera_ids
                : [];

            if (!configuredCameraIds.length) {
                return entry;
            }

            const existingCameras = Array.isArray(entry.cameras) ? entry.cameras : [];
            const existingCameraTraffic = existingCameras.reduce((sum, camera) => sum + Number(camera.totalTraffic || 0), 0);

            const cameras = (existingCameraTraffic > 0
                ? existingCameras
                : configuredCameraIds.map((cameraId) => {
                    const summary = aggregateCountingFlow(
                        countingSnapshots.filter((snapshot) => snapshot.camera_id === cameraId),
                        {
                            startMs: panelRangeBounds.valid ? panelRangeBounds.startMs : null,
                            endMs: panelRangeBounds.valid ? panelRangeBounds.endMs : null,
                            bucket: '1h',
                        },
                    );

                    return {
                        id: cameraId,
                        totalIn: summary.totalIn,
                        totalOut: summary.totalOut,
                        totalTraffic: summary.totalTraffic,
                        currentOccupancy: summary.estimatedOccupancy,
                    };
                }))
                .sort((a, b) => {
                    const trafficDelta = Number(b.totalTraffic || 0) - Number(a.totalTraffic || 0);
                    if (trafficDelta !== 0) return trafficDelta;
                    return String(a.id || '').localeCompare(String(b.id || ''));
                });

            const cameraTrafficBase = cameras.reduce((sum, camera) => sum + Number(camera.totalTraffic || 0), 0);

            return {
                ...entry,
                cameraCount: Math.max(entry.cameraCount, cameras.length),
                cameras: cameras.map((camera) => ({
                    ...camera,
                    share: cameraTrafficBase > 0 ? (Number(camera.totalTraffic || 0) / cameraTrafficBase) * 100 : 0,
                })),
            };
        });

        return {
            ...entranceContribution,
            entries,
            busiestEntrance: entries[0] || null,
        };
    }, [countingSnapshots, entranceContribution, panelRangeBounds, scopedBuildingSummary.entrance_summaries]);
    const latestScopedHistoryRow = scopedHistory.length > 0 ? scopedHistory[scopedHistory.length - 1] : null;
    const useLatestBuildingSnapshotTotals = selectedBuildingId === 'all' && preferLatestSnapshotTotals && latestBuildingSnapshotSummary.snapshotCount > 0;
    const useLatestBuildingRangeTotals = preferLatestSnapshotTotals && (
        selectedBuildingId === 'all'
            ? latestBuildingSnapshotSummary.snapshotCount > 0
            : Boolean(latestScopedHistoryRow)
    );
    const entranceContributionWithCameraBreakdown = selectedBuildingId === 'all' && useLatestBuildingSnapshotTotals
        ? latestBuildingEntranceContribution
        : deltaEntranceContributionWithCameraBreakdown;
    const latestScopedRangeIn = selectedBuildingId === 'all'
        ? Number(latestBuildingSnapshotSummary.totalIn ?? 0)
        : Number(latestScopedHistoryRow?.raw_in ?? 0);
    const latestScopedRangeOut = selectedBuildingId === 'all'
        ? Number(latestBuildingSnapshotSummary.totalOut ?? 0)
        : Number(latestScopedHistoryRow?.raw_out ?? 0);
    const displayedRangeIn = useLatestBuildingRangeTotals
        ? latestScopedRangeIn
        : Number(rangeTotalsSummary.totalIn ?? 0);
    const displayedRangeOut = useLatestBuildingRangeTotals
        ? latestScopedRangeOut
        : Number(rangeTotalsSummary.totalOut ?? 0);
    const displayedFlowIn = useLatestBuildingRangeTotals
        ? latestScopedRangeIn
        : Number(rangeTotalsSummary.totalIn ?? 0);
    const displayedFlowOut = useLatestBuildingRangeTotals
        ? latestScopedRangeOut
        : Number(rangeTotalsSummary.totalOut ?? 0);
    const displayedFlowTraffic = useLatestBuildingRangeTotals
        ? latestScopedRangeIn + latestScopedRangeOut
        : Number(rangeTotalsSummary.totalTraffic ?? 0);
    const displayedBuildingOccupancy = selectedBuildingId === 'all'
        ? (useLatestBuildingSnapshotTotals
            ? Number(latestBuildingSnapshotSummary.estimatedOccupancy ?? 0)
            : Number(scopedBuildingSummary.occupancy ?? 0))
        : Number(latestScopedHistoryRow?.occupancy ?? scopedBuildingSummary.occupancy ?? 0);

    const capacityUtilization = scopedBuildingSummary.max_capacity
        ? (displayedBuildingOccupancy / Number(scopedBuildingSummary.max_capacity)) * 100
        : null;
    const capacityUtilizationLabel = capacityUtilization == null
        ? 'Capacity not configured'
        : `${Math.round(capacityUtilization)}% Capacity Utilization`;
    const peakOccupancyValue = Math.max(
        Number(scopedBuildingSummary.occupancy ?? 0),
        Number(flowSummary.peakOccupancy ?? 0),
    );
    const busiestCamera = useMemo(() => {
        const cameras = entranceContributionWithCameraBreakdown.entries
            .flatMap((entry) => (entry.cameras || []).map((camera) => ({
                ...camera,
                entranceName: entry.name,
            })))
            .sort((a, b) => {
                const trafficDelta = Number(b.totalTraffic || 0) - Number(a.totalTraffic || 0);
                if (trafficDelta !== 0) return trafficDelta;
                return String(a.id || '').localeCompare(String(b.id || ''));
            });
        return cameras[0] || null;
    }, [entranceContributionWithCameraBreakdown.entries]);
    const entranceContributionChartData = useMemo(() => {
        const totalTraffic = entranceContributionWithCameraBreakdown.entries.reduce(
            (sum, entry) => sum + (entry.cameras || []).reduce((cameraSum, camera) => cameraSum + Number(camera.totalTraffic || 0), 0),
            0,
        );
        const flattenedCameras = entranceContributionWithCameraBreakdown.entries
            .flatMap((entry) => (entry.cameras || []).map((camera) => ({
                id: camera.id,
                name: cameraNameById?.[camera.id] || camera.id,
                buildingId: entry.name,
                totalIn: Number(camera.totalIn || 0),
                totalOut: Number(camera.totalOut || 0),
                totalTraffic: Number(camera.totalTraffic || 0),
                currentOccupancy: Number(camera.currentOccupancy || 0),
                shareOfBuilding: totalTraffic > 0 ? (Number(camera.totalTraffic || 0) / totalTraffic) * 100 : 0,
            })))
            .sort((a, b) => {
                const shareDelta = Number(b.shareOfBuilding || 0) - Number(a.shareOfBuilding || 0);
                if (shareDelta !== 0) return shareDelta;
                return String(a.name || '').localeCompare(String(b.name || ''));
            });

        if (flattenedCameras.length > 0) {
            return flattenedCameras;
        }

        return entranceContributionWithCameraBreakdown.entries.map((entry) => ({
            id: entry.name,
            name: `Building ${entry.name}`,
            buildingId: entry.name,
            totalIn: Number(entry.totalIn || 0),
            totalOut: Number(entry.totalOut || 0),
            totalTraffic: Number(entry.totalTraffic || 0),
            currentOccupancy: Number(entry.currentOccupancy || 0),
            shareOfBuilding: Number(entry.share || 0),
        }));
    }, [cameraNameById, entranceContributionWithCameraBreakdown]);
    const isDailyFlowView = effectiveBucket === '1d';
    const toggleEntranceExpanded = useCallback((entranceId) => {
        setExpandedEntranceIds((prev) => {
            const next = new Set(prev);
            if (next.has(entranceId)) next.delete(entranceId);
            else next.add(entranceId);
            return next;
        });
    }, []);

    if (!visible) return null;

    return (
        <div className="space-y-6">
            <Card className={cn(REPORT_SURFACE_CARD_CLASS, "flex flex-col")}>
                <CardHeader className="space-y-4">
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                        <div>
                            <CardTitle className="flex items-center gap-2">
                                <Building2 className="w-4 h-4" />
                                {selectedBuildingId === 'all' ? 'Building View' : `Building View: ${selectedBuildingId}`}
                            </CardTitle>
                            <p className="mt-1 text-sm text-muted-foreground">
                                {selectedBuildingId === 'all'
                                    ? 'Building-wide occupancy, throughput, and entrance contribution from persisted counting snapshots.'
                                    : 'Occupancy, throughput, and camera contribution for the selected building ID from persisted counting snapshots.'}
                            </p>
                        </div>
                        <div className="flex flex-col items-start gap-2 xl:items-end">
                            <div className="text-xs text-muted-foreground">
                                Uses the global report range plus the selected grouping, source, and camera filters above.
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="text-xs font-medium text-muted-foreground">Building ID</span>
                                <select
                                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                                    value={selectedBuildingId}
                                    onChange={(e) => setSelectedBuildingId(e.target.value)}
                                >
                                    {buildingIdOptions.map((option) => (
                                        <option key={option} value={option}>
                                            {option === 'all' ? 'All Building IDs' : option}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span>Building counting: {scopedBuildingSummary.enabled ? 'Enabled' : 'Disabled'}</span>
                        <span>Active cameras: {scopedBuildingSummary.active_camera_count ?? 0}</span>
                        <span>Raw occupancy: {scopedBuildingSummary.raw_occupancy ?? 0}</span>
                        <span>Manual offset: {selectedBuildingId === 'all' ? (scopedBuildingSummary.manual_offset ?? 0) : 'N/A'}</span>
                    </div>

                    {scopedBuildingSummary.capacity_exceeded && (
                        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600">
                            {selectedBuildingId === 'all'
                                ? `Building capacity exceeded${Array.isArray(scopedBuildingSummary.exceeded_building_ids) && scopedBuildingSummary.exceeded_building_ids.length > 0 ? `: ${scopedBuildingSummary.exceeded_building_ids.join(', ')}` : '.'}`
                                : `${selectedBuildingId} capacity exceeded.`}
                        </div>
                    )}
                </CardHeader>
                <CardContent>
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                        <div className={cn(
                            'rounded-xl border p-4',
                            scopedBuildingSummary.capacity_exceeded ? 'border-red-500/30 bg-red-500/10' : 'border-primary/20 bg-primary/10',
                        )}>
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Users className={cn('h-4 w-4', scopedBuildingSummary.capacity_exceeded ? 'text-red-600' : 'text-primary')} />
                                Current Occupancy
                            </div>
                            <div className={cn('mt-2 text-3xl font-bold', scopedBuildingSummary.capacity_exceeded ? 'text-red-600' : 'text-primary')}>
                                {formatNumber(displayedBuildingOccupancy)}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">{capacityUtilizationLabel}</div>
                        </div>

                        <div className="rounded-xl border border-green-500/20 bg-green-500/10 p-4">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <ArrowDownToLine className="h-4 w-4 text-green-600" />
                                Range IN
                            </div>
                            <div className="mt-2 text-3xl font-bold text-green-600">{formatNumber(displayedRangeIn)}</div>
                            <div className="mt-1 text-xs text-muted-foreground">Within selected report range</div>
                        </div>

                        <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <ArrowUpFromLine className="h-4 w-4 text-red-600" />
                                Range OUT
                            </div>
                            <div className="mt-2 text-3xl font-bold text-red-600">{formatNumber(displayedRangeOut)}</div>
                            <div className="mt-1 text-xs text-muted-foreground">Within selected report range</div>
                        </div>

                        <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-4">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <TrendingUp className="h-4 w-4 text-blue-600" />
                                Peak Occupancy
                            </div>
                            <div className="mt-2 text-3xl font-bold text-blue-700">{formatNumber(peakOccupancyValue)}</div>
                            <div className="mt-1 text-xs text-muted-foreground">{flowSummary.peakOccupancyPeriodLabel}</div>
                        </div>

                        <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Target className="h-4 w-4 text-amber-600" />
                                Busiest Camera
                            </div>
                                    <div className="mt-2 text-xl font-bold text-amber-700">
                                        {busiestCamera ? (cameraNameById?.[busiestCamera.id] || busiestCamera.id) : '-'}
                                    </div>
                                    <div className="mt-1 text-xs text-muted-foreground">
                                        {busiestCamera
                                            ? `${formatNumber(busiestCamera.totalTraffic)} traffic | Building ID ${busiestCamera.entranceName}`
                                            : 'No entrance flow in range'}
                                    </div>
                                </div>
                            </div>
                </CardContent>
            </Card>

            <Card className={cn(REPORT_SURFACE_CARD_CLASS, "flex flex-col min-h-[420px]")}>
                <CardHeader className="space-y-2">
                    <CardTitle>Building Occupancy</CardTitle>
                    <p className="text-sm text-muted-foreground">
                        Current occupancy trend across the selected report range.
                    </p>
                </CardHeader>
                <CardContent className="flex-1">
                    <div className="h-[320px]">
                        {chartData.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 20 }}>
                                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                                    <XAxis
                                        type="number"
                                        dataKey="tsMs"
                                        domain={['dataMin', 'dataMax']}
                                        tickFormatter={(value) => getOccupancyTickLabel(new Date(value), historyRangeKey)}
                                        className="text-xs text-muted-foreground"
                                        tickLine={false}
                                        axisLine={false}
                                    />
                                    <YAxis className="text-xs text-muted-foreground" tickLine={false} axisLine={false} allowDecimals={false} />
                                    <RechartsTooltip
                                        cursor={{ strokeDasharray: '3 3' }}
                                        labelFormatter={(value, payload) => payload?.[0]?.payload?.fullTime || formatTimestamp(value)}
                                        formatter={(value, name) => [formatNumber(value), name]}
                                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                                    />
                                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                                    <Line type="linear" dataKey="occupancy" name="Occupancy" stroke="#2563eb" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                                    <Line type="linear" dataKey="rawOccupancy" name="Raw Occupancy" stroke="#94a3b8" strokeWidth={2} dot={false} activeDot={{ r: 4 }} strokeDasharray="6 4" />
                                    <Brush
                                        dataKey="time"
                                        height={22}
                                        stroke="#2563eb"
                                        travellerWidth={8}
                                        startIndex={brushIndices.startIndex}
                                        endIndex={brushIndices.endIndex}
                                        onChange={handleBrushChange}
                                    />
                                </LineChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                                {loading
                                    ? 'Loading building history...'
                                    : panelRangeBounds.valid
                                        ? 'No building occupancy history available for the selected date range'
                                        : 'Choose a valid custom date/time range to view occupancy'}
                            </div>
                        )}
                    </div>
                </CardContent>
            </Card>

            <Card className={cn(REPORT_SURFACE_CARD_CLASS, "flex flex-col min-h-[420px]")}>
                <CardHeader className="space-y-3">
                    <div>
                        <CardTitle className="flex items-center gap-2">
                            <TrendingUp className="w-4 h-4" />
                            In/Out Over Time
                        </CardTitle>
                        <p className="mt-1 text-sm text-muted-foreground">
                            Building-level flow trend with adaptive {effectiveBucket === '15m' ? '15-minute' : effectiveBucket === '1h' ? 'hourly' : 'daily'} buckets using latest saved building snapshots.
                        </p>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Each bucket shows the latest settled building snapshot in that period instead of rebuilding flow from deltas.
                    </p>
                </CardHeader>
                <CardContent className="flex-1">
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                        <div className="rounded-xl border border-green-500/20 bg-green-500/10 p-4">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <ArrowDownToLine className="h-4 w-4 text-green-600" />
                                Range IN
                            </div>
                            <div className="mt-2 text-3xl font-bold text-green-600">{formatNumber(displayedFlowIn)}</div>
                        </div>
                        <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <ArrowUpFromLine className="h-4 w-4 text-red-600" />
                                Range OUT
                            </div>
                            <div className="mt-2 text-3xl font-bold text-red-600">{formatNumber(displayedFlowOut)}</div>
                        </div>
                        <div className="rounded-xl border border-slate-300 bg-slate-50 p-4">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Activity className="h-4 w-4 text-slate-700" />
                                Total Traffic
                            </div>
                            <div className="mt-2 text-3xl font-bold text-slate-800">{formatNumber(displayedFlowTraffic)}</div>
                        </div>
                        <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/10 p-4">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Clock3 className="h-4 w-4 text-indigo-600" />
                                Peak Period
                            </div>
                            <div className="mt-2 text-lg font-semibold text-indigo-700">{flowSummary.peakPeriodLabel}</div>
                        </div>
                    </div>

                    <div className="mt-6 h-[300px]">
                        {flowSummary.series.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%">
                                <ComposedChart data={flowSummary.series} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                                    <XAxis dataKey="label" className="text-xs text-muted-foreground" tickLine={false} axisLine={false} />
                                    <YAxis
                                        yAxisId="flow"
                                        className="text-xs text-muted-foreground"
                                        tickLine={false}
                                        axisLine={false}
                                        allowDecimals={false}
                                    />
                                    <YAxis
                                        yAxisId="occupancy"
                                        orientation="right"
                                        className="text-xs text-muted-foreground"
                                        tickLine={false}
                                        axisLine={false}
                                        allowDecimals={false}
                                    />
                                    <RechartsTooltip
                                        cursor={{ strokeDasharray: '3 3' }}
                                        labelFormatter={(_, payload) => payload?.[0]?.payload?.fullLabel || ''}
                                        formatter={(value, name) => [formatNumber(value), name]}
                                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                                    />
                                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                                    {isDailyFlowView ? (
                                        <>
                                            <Bar yAxisId="flow" dataKey="in" name="In" fill="#22c55e" radius={[4, 4, 0, 0]} maxBarSize={36} />
                                            <Bar yAxisId="flow" dataKey="out" name="Out" fill="#ef4444" radius={[4, 4, 0, 0]} maxBarSize={36} />
                                        </>
                                    ) : (
                                        <>
                                            <Line yAxisId="flow" type="monotone" dataKey="in" name="In" stroke="#22c55e" strokeWidth={2.5} dot={false} />
                                            <Line yAxisId="flow" type="monotone" dataKey="out" name="Out" stroke="#ef4444" strokeWidth={2.5} dot={false} />
                                        </>
                                    )}
                                    <Line
                                        yAxisId="occupancy"
                                        type="monotone"
                                        dataKey="occupancy"
                                        name="Occupancy"
                                        stroke="#2563eb"
                                        strokeWidth={2}
                                        dot={false}
                                        strokeDasharray="6 4"
                                    />
                                </ComposedChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                                {panelRangeBounds.valid
                                    ? 'No building flow data available for the selected trend range'
                                    : 'Choose a valid custom date/time range to view flow'}
                            </div>
                        )}
                    </div>
                </CardContent>
            </Card>

            <Card className={cn(REPORT_SURFACE_CARD_CLASS, "flex flex-col min-h-[400px]")}>
                <CardHeader className="space-y-2">
                        <CardTitle>Entrance Contribution</CardTitle>
                        <p className="text-sm text-muted-foreground">
                            {selectedBuildingId === 'all'
                                ? 'Entrance-level contribution share of total building traffic for the selected range.'
                                : 'Camera contribution share within the selected building ID for the selected range.'}
                        </p>
                    </CardHeader>
                <CardContent className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_320px]">
                    <div className="h-[320px]">
                        {entranceContributionChartData.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart
                                    data={entranceContributionChartData}
                                    layout="vertical"
                                    margin={{ top: 10, right: 20, left: 0, bottom: 0 }}
                                    barCategoryGap="28%"
                                >
                                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
                                    <XAxis
                                        type="number"
                                        domain={[0, 100]}
                                        className="text-xs text-muted-foreground"
                                        tickLine={false}
                                        axisLine={false}
                                        tickFormatter={(value) => `${value}%`}
                                    />
                                    <YAxis
                                        type="category"
                                        dataKey="name"
                                        width={120}
                                        className="text-xs text-muted-foreground"
                                        tickLine={false}
                                        axisLine={false}
                                    />
                                    <RechartsTooltip
                                        cursor={{ fill: 'transparent' }}
                                        formatter={(value, name, item) => {
                                            if (name === 'Contribution') {
                                                return [`${Number(value || 0).toFixed(1)}%`, name];
                                            }
                                            return [formatNumber(value), name];
                                        }}
                                        labelFormatter={(_, payload) => {
                                            const row = payload?.[0]?.payload;
                                            if (!row) return '';
                                            return `${row.name}${row.buildingId ? ` | Building ID ${row.buildingId}` : ''}`;
                                        }}
                                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                                    />
                                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                                    <Bar dataKey="shareOfBuilding" name="Contribution" fill="#2563eb" radius={[0, 4, 4, 0]} maxBarSize={18} />
                                </BarChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                                No entrance contribution data available for the selected range
                            </div>
                        )}
                    </div>

                    <div className="space-y-3">
                        <div className="rounded-xl border border-muted bg-muted/20 p-4">
                            <div className="text-xs uppercase tracking-wide text-muted-foreground">Busiest Camera</div>
                            <div className="mt-2 text-2xl font-bold">
                                {busiestCamera ? (cameraNameById?.[busiestCamera.id] || busiestCamera.id) : '-'}
                            </div>
                            <div className="mt-1 text-sm text-muted-foreground">
                                {busiestCamera
                                    ? `${formatNumber(busiestCamera.totalTraffic)} traffic | Building ID ${busiestCamera.entranceName}`
                                    : 'No building camera activity yet'}
                            </div>
                        </div>

                        <div className="space-y-2">
                            {entranceContributionWithCameraBreakdown.entries.slice(0, 5).map((entry) => (
                                <div key={entry.name} className="rounded-xl border p-3">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0 flex-1">
                                            <div className="font-medium">{entry.name}</div>
                                            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                                                <span className="text-green-600">IN: {formatNumber(entry.totalIn)}</span>
                                                <span className="text-red-600">OUT: {formatNumber(entry.totalOut)}</span>
                                                <span className="text-muted-foreground">Cameras: {entry.cameraCount}</span>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <div className="text-sm text-muted-foreground">{formatPercent(entry.share)}</div>
                                            {entry.cameras?.length > 0 && (
                                                <button
                                                    type="button"
                                                    onClick={() => toggleEntranceExpanded(entry.name)}
                                                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 text-muted-foreground transition-colors hover:bg-slate-50 hover:text-foreground"
                                                    aria-label={expandedEntranceIds.has(entry.name) ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
                                                >
                                                    {expandedEntranceIds.has(entry.name) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    {expandedEntranceIds.has(entry.name) && entry.cameras?.length > 0 && (
                                        <div className="mt-3 space-y-2 border-t border-slate-200 pt-3">
                                            {entry.cameras.map((camera) => (
                                                <div key={camera.id} className="rounded-lg bg-slate-50/90 px-3 py-2 text-xs">
                                                    <div className="flex items-center justify-between gap-3">
                                                        <div className="font-medium text-foreground">{cameraNameById?.[camera.id] || camera.id}</div>
                                                        <div className="text-muted-foreground">{formatPercent(camera.share)}</div>
                                                    </div>
                                                    <div className="mt-1 flex flex-wrap items-center gap-3">
                                                        <span className="text-green-600">IN: {formatNumber(camera.totalIn)}</span>
                                                        <span className="text-red-600">OUT: {formatNumber(camera.totalOut)}</span>
                                                        <span className="text-slate-700">TRAFFIC: {formatNumber(camera.totalTraffic)}</span>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
};

const BuildingAlertsPanel = ({ rows, onSelectRecord, loading, visible }) => {
    if (!visible) return null;

    return (
        <Card className={cn(REPORT_SURFACE_CARD_CLASS, "flex flex-col min-h-[320px] overflow-hidden")}>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-red-500" />
                    Recent Alert Log
                </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 p-0 overflow-auto">
                <table className="w-full text-sm text-left">
                    <thead className="text-muted-foreground bg-muted/50 sticky top-0">
                        <tr>
                            <th className="px-4 py-3 font-medium">Timestamp</th>
                            <th className="px-4 py-3 font-medium">Alert</th>
                            <th className="px-4 py-3 font-medium">Details</th>
                            <th className="px-4 py-3 font-medium text-right">Action</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y">
                        {rows.length > 0 ? rows.map((row) => (
                            <tr
                                key={row.id}
                                className="hover:bg-muted/30 transition-colors group cursor-pointer"
                                onClick={() => onSelectRecord(row)}
                            >
                                <td className="px-4 py-3">{formatReportTime(row)}</td>
                                <td className="px-4 py-3">
                                    <span className="inline-flex items-center gap-2 rounded-full border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-700">
                                        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                                        Capacity Exceeded
                                    </span>
                                </td>
                                <td className="px-4 py-3 text-muted-foreground">
                                    {row.details?.building_id ? `${row.details.building_id} | ` : ''}
                                    Occupancy: {row.details?.occupancy ?? '-'} / {row.details?.max_capacity ?? '-'}
                                </td>
                                <td className="px-4 py-3 text-right">
                                    <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <Eye className="w-4 h-4" />
                                    </Button>
                                </td>
                            </tr>
                        )) : (
                            <tr>
                                <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                                    {loading ? 'Loading...' : 'No building alerts found.'}
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </CardContent>
        </Card>
    );
};

const AllOverviewPanel = ({
    events,
    snapshots,
    startMs,
    endMs,
    cameraOptions,
    cameraFilter,
    preferLatestSnapshotTotals = false,
    useSnapshotCountingTotals = false,
}) => {
    const summaryBucket = useMemo(() => {
        const nowMs = Date.now();
        const effectiveEndMs = endMs ?? nowMs;
        const effectiveStartMs = startMs ?? Math.max(0, effectiveEndMs - OCCUPANCY_RANGE_LOOKBACK_MS['7d']);
        return getAdaptiveFlowBucket('custom', effectiveStartMs, effectiveEndMs);
    }, [endMs, startMs]);

    const peopleSummary = useMemo(() => aggregateCountingFlow(snapshots, {
        startMs,
        endMs,
        bucket: summaryBucket,
    }), [endMs, snapshots, startMs, summaryBucket]);

    const trafficSummary = useMemo(() => aggregateTrafficAnalytics(snapshots, {
        startMs,
        endMs,
        bucket: summaryBucket,
    }), [endMs, snapshots, startMs, summaryBucket]);
    const latestSnapshotSummary = useMemo(() => summarizeLatestSnapshots(snapshots, {
        startMs,
        endMs,
    }), [endMs, snapshots, startMs]);
    const useLatestSnapshotTotals = (
        (preferLatestSnapshotTotals || useSnapshotCountingTotals)
        && latestSnapshotSummary.snapshotCount > 0
    );
    const displayedOverviewOccupancy = useLatestSnapshotTotals
        ? Number(latestSnapshotSummary.estimatedOccupancy ?? 0)
        : Number(peopleSummary.estimatedOccupancy ?? 0);
    const displayedOverviewTraffic = useLatestSnapshotTotals
        ? Number(latestSnapshotSummary.totalTraffic ?? 0)
        : Number(peopleSummary.totalTraffic ?? 0);
    const displayedOverviewIn = useLatestSnapshotTotals
        ? Number(latestSnapshotSummary.totalIn ?? 0)
        : Number(peopleSummary.totalIn ?? 0);
    const displayedOverviewOut = useLatestSnapshotTotals
        ? Number(latestSnapshotSummary.totalOut ?? 0)
        : Number(peopleSummary.totalOut ?? 0);
    const displayedOverviewCaptureRate = useLatestSnapshotTotals
        ? (
            Number(latestSnapshotSummary.footTrafficTotal ?? 0) > 0
                ? (Number(latestSnapshotSummary.totalIn ?? 0) / Number(latestSnapshotSummary.footTrafficTotal ?? 0)) * 100
                : 0
        )
        : Number(trafficSummary.captureRate ?? 0);
    const displayedOverviewPeakOccupancy = useMemo(() => (
        cameraFilter === 'all'
            ? calculateCombinedPeakOccupancy(snapshots, { startMs, endMs })
            : Number(peopleSummary.peakOccupancy ?? 0)
    ), [cameraFilter, endMs, peopleSummary.peakOccupancy, snapshots, startMs]);

    const dressCodeSummary = useMemo(() => aggregateDressCodeAnalytics(events, snapshots, {
        startMs,
        endMs,
        bucket: summaryBucket,
    }), [endMs, events, snapshots, startMs, summaryBucket]);

    const fallSummary = useMemo(() => aggregateFallDetectionAnalytics(
        events.filter((evt) => {
            const tsMs = getReportTimeMs(evt);
            if (!tsMs) return false;
            if (startMs != null && tsMs < startMs) return false;
            if (endMs != null && tsMs > endMs) return false;
            return true;
        }),
    ), [endMs, events, startMs]);

    const eventCounts = useMemo(() => {
        const dressCodeViolations = events.filter((evt) => evt.event_type === 'Dress Code Violation').length;
        const fallDetections = events.filter((evt) => evt.event_type === 'Fall Detected').length;
        const capacityAlerts = events.filter((evt) => evt.event_type === 'Capacity Exceeded').length;
        return {
            dressCodeViolations,
            fallDetections,
            capacityAlerts,
            totalDetections: events.length,
            criticalAlerts: fallDetections + capacityAlerts,
        };
    }, [events]);

    const topDressCodeSubtype = dressCodeSummary.breakdown.reduce((best, item) => {
        if (!best || Number(item.count || 0) > Number(best.count || 0)) return item;
        return best;
    }, null);
    const dressCodeRateCoverageNote = getDressCodeRateCoverageNote(dressCodeSummary);

    const camerasInScope = cameraFilter === 'all'
        ? cameraOptions.length
        : (cameraFilter ? 1 : 0);

    return (
        <div className="space-y-6">
            <div className={cn(REPORT_SECTION_HEADER_CLASS, "space-y-1")}>
                <h2 className="text-lg font-semibold tracking-tight">Overview Dashboard</h2>
                <p className="text-sm text-muted-foreground">
                    Cross-module summary for people counting, dress code, and fall detection in the selected report range.
                </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                <div className="rounded-xl border border-slate-300 bg-slate-50 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Activity className="h-4 w-4 text-slate-700" />
                        Total Detection Events
                    </div>
                    <div className="mt-2 text-3xl font-bold text-slate-800">{formatNumber(eventCounts.totalDetections)}</div>
                </div>
                <div className="rounded-xl border border-primary/20 bg-primary/10 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Users className="h-4 w-4 text-primary" />
                        Current Occupancy
                    </div>
                    <div className="mt-2 text-3xl font-bold text-primary">{formatNumber(displayedOverviewOccupancy)}</div>
                </div>
                <div className="rounded-xl border border-green-500/20 bg-green-500/10 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <TrendingUp className="h-4 w-4 text-green-600" />
                        Total Traffic
                    </div>
                    <div className="mt-2 text-3xl font-bold text-green-600">{formatNumber(displayedOverviewTraffic)}</div>
                </div>
                <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Building2 className="h-4 w-4 text-blue-600" />
                        Cameras In Scope
                    </div>
                    <div className="mt-2 text-3xl font-bold text-blue-700">{formatNumber(camerasInScope)}</div>
                </div>
                <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <AlertTriangle className="h-4 w-4 text-red-600" />
                        Critical Alerts
                    </div>
                    <div className="mt-2 text-3xl font-bold text-red-600">{formatNumber(eventCounts.criticalAlerts)}</div>
                </div>
            </div>

            <Card className={cn(REPORT_SURFACE_CARD_CLASS, "flex flex-col")}>
                <CardHeader className="space-y-2">
                    <CardTitle>People Counting Summary</CardTitle>
                    <p className="text-sm text-muted-foreground">
                        Aggregated occupancy and movement metrics across the selected people-counting scope.
                    </p>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-xl border border-primary/20 bg-primary/10 p-4">
                        <div className="text-sm text-muted-foreground">Capture Rate</div>
                        <div className="mt-2 text-3xl font-bold text-primary">{formatPercent(displayedOverviewCaptureRate)}</div>
                    </div>
                    <div className="rounded-xl border border-green-500/20 bg-green-500/10 p-4">
                        <div className="text-sm text-muted-foreground">Total In</div>
                        <div className="mt-2 text-3xl font-bold text-green-600">{formatNumber(displayedOverviewIn)}</div>
                    </div>
                    <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4">
                        <div className="text-sm text-muted-foreground">Total Out</div>
                        <div className="mt-2 text-3xl font-bold text-red-600">{formatNumber(displayedOverviewOut)}</div>
                    </div>
                    <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-4">
                        <div className="text-sm text-muted-foreground">Peak Occupancy</div>
                        <div className="mt-2 text-3xl font-bold text-blue-700">{formatNumber(displayedOverviewPeakOccupancy)}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{peopleSummary.peakPeriodLabel}</div>
                    </div>
                </CardContent>
            </Card>

            <Card className={cn(REPORT_SURFACE_CARD_CLASS, "flex flex-col")}>
                <CardHeader className="space-y-2">
                    <CardTitle>Dress Code Summary</CardTitle>
                    <p className="text-sm text-muted-foreground">
                        Violation totals and rate summary for the selected camera scope.
                    </p>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4">
                        <div className="text-sm text-muted-foreground">Total Violations</div>
                        <div className="mt-2 text-3xl font-bold text-red-600">{formatNumber(dressCodeSummary.totalViolations)}</div>
                    </div>
                    <div className="rounded-xl border border-slate-300 bg-slate-50 p-4">
                        <div className="text-sm text-muted-foreground">Unique Violators</div>
                        <div className="mt-2 text-3xl font-bold text-slate-800">{formatNumber(dressCodeSummary.uniqueViolators)}</div>
                    </div>
                    <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4">
                        <div className="text-sm text-muted-foreground">Violation Rate</div>
                        <div className="mt-2 text-3xl font-bold text-amber-700">
                            {dressCodeSummary.hasTrafficBase ? formatPercent(dressCodeSummary.violationRate) : '-'}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                            {dressCodeRateCoverageNote || 'Based on available traffic denominator'}
                        </div>
                        <DressCodeRateBreakdown analytics={dressCodeSummary} compact />
                    </div>
                    <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/10 p-4">
                        <div className="text-sm text-muted-foreground">Top Violation</div>
                        <div className="mt-2 text-2xl font-bold text-indigo-700">{topDressCodeSubtype?.name || '-'}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                            {topDressCodeSubtype ? `${formatNumber(topDressCodeSubtype.count)} event(s)` : 'No violations in range'}
                        </div>
                    </div>
                </CardContent>
            </Card>

            <Card className={cn(REPORT_SURFACE_CARD_CLASS, "flex flex-col")}>
                <CardHeader className="space-y-2">
                    <CardTitle>Fall Detection Summary</CardTitle>
                    <p className="text-sm text-muted-foreground">
                        Fall alerts detected in the selected report range.
                    </p>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4">
                        <div className="text-sm text-muted-foreground">Total Falls</div>
                        <div className="mt-2 text-3xl font-bold text-red-600">{formatNumber(fallSummary.totalFalls)}</div>
                    </div>
                    <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-4">
                        <div className="text-sm text-muted-foreground">Cameras Triggered</div>
                        <div className="mt-2 text-3xl font-bold text-blue-700">{formatNumber(fallSummary.affectedCameraCount)}</div>
                    </div>
                    <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4">
                        <div className="text-sm text-muted-foreground">Peak Detection Time</div>
                        <div className="mt-2 text-lg font-semibold text-amber-700">{fallSummary.peakFallTimeLabel}</div>
                    </div>
                    <div className="rounded-xl border border-slate-300 bg-slate-50 p-4">
                        <div className="text-sm text-muted-foreground">Latest Detection</div>
                        <div className="mt-2 text-sm font-semibold text-slate-800">{fallSummary.latestEventLabel}</div>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
};

// --- Main Reporting Component ---
const Reporting = () => {
    const apiUrl = getApiBaseUrl();

    const [events, setEvents] = useState([]);
    const [countingSnapshots, setCountingSnapshots] = useState([]);
    const [cameras, setCameras] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedCategory, setSelectedCategory] = useState('All');
    const [selectedPeopleCountingView, setSelectedPeopleCountingView] = useState('building');
    const [selectedCameraFilter, setSelectedCameraFilter] = useState('all');
    const [selectedSourceFilter, setSelectedSourceFilter] = useState('live');
    const [selectedQuickRange, setSelectedQuickRange] = useState('today');
    const [buildingGrouping, setBuildingGrouping] = useState('auto');
    const [startDate, setStartDate] = useState(() => {
        const bounds = getQuickRangeDateBounds('today', '', '');
        return bounds.startDate;
    });
    const [endDate, setEndDate] = useState(() => {
        const bounds = getQuickRangeDateBounds('today', '', '');
        return bounds.endDate;
    });
    const [draftStartDate, setDraftStartDate] = useState(() => {
        const bounds = getQuickRangeDateBounds('today', '', '');
        return bounds.startDate;
    });
    const [draftEndDate, setDraftEndDate] = useState(() => {
        const bounds = getQuickRangeDateBounds('today', '', '');
        return bounds.endDate;
    });
    const [selectedRecord, setSelectedRecord] = useState(null);
    const [showExportModal, setShowExportModal] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    const [rowsPerPage, setRowsPerPage] = useState(20);
    const [detectionLogSort, setDetectionLogSort] = useState({ field: 'timestamp', direction: 'desc' });
    const [refreshToken, setRefreshToken] = useState(0);
    const effectiveDateRange = useMemo(
        () => getQuickRangeDateBounds(selectedQuickRange, startDate, endDate),
        [selectedQuickRange, startDate, endDate],
    );
    const effectiveStartDate = effectiveDateRange.startDate;
    const effectiveEndDate = effectiveDateRange.endDate;
    const shouldPreferSnapshotTotalsForAppliedRange = useMemo(() => (
        selectedQuickRange === 'today'
        || isWholeSingleLocalDayRange(effectiveStartDate, effectiveEndDate)
    ), [effectiveEndDate, effectiveStartDate, selectedQuickRange]);
    const isCustomQuickRange = selectedQuickRange === 'custom';
    const draftDateBounds = useMemo(
        () => getDateRangeBounds(draftStartDate, draftEndDate),
        [draftEndDate, draftStartDate],
    );
    const isCustomRangeValid = (
        draftDateBounds.startMs != null
        && draftDateBounds.endMs != null
        && draftDateBounds.startMs <= draftDateBounds.endMs
    );
    const isCustomRangeDirty = draftStartDate !== startDate || draftEndDate !== endDate;
    const reportingDateBounds = getDateRangeBounds(effectiveStartDate, effectiveEndDate);
    const reportingStartParam = useMemo(
        () => toApiDateTimeParam(reportingDateBounds.startMs),
        [reportingDateBounds.startMs],
    );
    const reportingEndParam = useMemo(
        () => toApiDateTimeParam(reportingDateBounds.endMs),
        [reportingDateBounds.endMs],
    );

    // Fetch cameras
    useEffect(() => {
        const fetchCameras = async () => {
            try {
                const res = await fetch(`${apiUrl}/api/cameras`);
                const data = await res.json();
                // Reporting should include historical data for all cameras, even if disabled.
                setCameras(data);
            } catch (err) {
                console.error('Failed to fetch cameras:', err);
            }
        };
        fetchCameras();
    }, [apiUrl]);

    // Fetch detection events
    const fetchEvents = useCallback(async () => {
        setLoading(true);
        try {
            const allEvents = [];
            let offset = 0;

            while (offset < MAX_DETECTION_EVENT_ROWS) {
                const params = new URLSearchParams();
                appendQueryParam(params, 'limit', DETECTION_EVENT_PAGE_SIZE);
                appendQueryParam(params, 'offset', offset);
                if (selectedCategory === 'Dress Code') {
                    appendQueryParam(params, 'event_type', 'Dress Code Violation');
                } else if (selectedCategory === 'Fall Detection') {
                    appendQueryParam(params, 'event_type', 'Fall Detected');
                } else if (selectedCategory === 'People Counting') {
                    appendQueryParam(params, 'event_type', 'Capacity Exceeded');
                }
                if (selectedCameraFilter !== 'all') {
                    appendQueryParam(params, 'camera_id', selectedCameraFilter);
                }
                appendQueryParam(params, 'start', reportingStartParam);
                appendQueryParam(params, 'end', reportingEndParam);

                const res = await fetch(`${apiUrl}/api/detection-events?${params.toString()}`);
                if (!res.ok) break;

                const data = await res.json();
                if (!Array.isArray(data) || data.length === 0) break;

                allEvents.push(...data);
                offset += data.length;

                if (data.length < DETECTION_EVENT_PAGE_SIZE) break;
            }

            if (allEvents.length >= MAX_DETECTION_EVENT_ROWS) {
                console.warn(
                    `[Reporting] Detection event history reached cap (${MAX_DETECTION_EVENT_ROWS} rows).`,
                );
            }

            setEvents(allEvents);
        } catch (err) {
            console.error("Failed to fetch events:", err);
        } finally {
            setLoading(false);
        }
    }, [apiUrl, reportingEndParam, reportingStartParam, selectedCameraFilter, selectedCategory]);

    // Fetch counting snapshots when People Counting category is selected
    const fetchCountingSnapshots = useCallback(async () => {
        const needsCountingSnapshots = (
            selectedCategory === 'Dress Code'
            || selectedCategory === 'All'
            || selectedCategory === 'People Counting'
        );
        if (!needsCountingSnapshots) {
            setCountingSnapshots([]);
            return;
        }
        try {
            const allSnapshots = [];
            let offset = 0;

            while (offset < MAX_COUNTING_HISTORY_ROWS) {
                const params = new URLSearchParams();
                appendQueryParam(params, 'limit', SNAPSHOT_PAGE_SIZE);
                appendQueryParam(params, 'offset', offset);
                if (selectedCameraFilter !== 'all') {
                    appendQueryParam(params, 'camera_id', selectedCameraFilter);
                }
                appendQueryParam(params, 'start', reportingStartParam);
                appendQueryParam(params, 'end', reportingEndParam);
                const res = await fetch(
                    `${apiUrl}/api/people-counting-history?${params.toString()}`,
                );
                if (!res.ok) break;

                const data = await res.json();
                if (!Array.isArray(data) || data.length === 0) break;

                allSnapshots.push(...data.map((snapshot) => ({ ...snapshot, _isSnapshot: true })));
                offset += data.length;

                if (data.length < SNAPSHOT_PAGE_SIZE) break;
            }

            if (allSnapshots.length >= MAX_COUNTING_HISTORY_ROWS) {
                console.warn(
                    `[Reporting] Snapshot history reached cap (${MAX_COUNTING_HISTORY_ROWS} rows).`,
                );
            }

            // Sort by timestamp descending (newest first)
            allSnapshots.sort((a, b) => getReportTimeMs(b) - getReportTimeMs(a));
            setCountingSnapshots(allSnapshots);
        } catch (err) {
            console.error("Failed to fetch counting snapshots:", err);
        }
    }, [
        apiUrl,
        reportingEndParam,
        reportingStartParam,
        selectedCameraFilter,
        selectedCategory,
        selectedPeopleCountingView,
    ]);

    useEffect(() => {
        fetchEvents();
        const interval = setInterval(fetchEvents, 10000);
        return () => clearInterval(interval);
    }, [fetchEvents]);

    useEffect(() => {
        fetchCountingSnapshots();
        return undefined;
    }, [fetchCountingSnapshots]);

    const cameraNameById = cameras.reduce((acc, cam) => {
        acc[cam.id] = cam.name || cam.id;
        return acc;
    }, {});
    const currentCameraIdSet = useMemo(() => new Set(cameras.map((cam) => cam.id)), [cameras]);
    const cameraSourceKindById = useMemo(() => (
        cameras.reduce((acc, cam) => {
            acc[cam.id] = cam.source_kind || '';
            return acc;
        }, {})
    ), [cameras]);
    const baseCameraOptions = useMemo(() => {
        const options = new Map();
        const upsertOption = (id, name, kind = 'other') => {
            if (!id) return;
            const normalizedKind = kind || 'other';
            const isHistorical = !currentCameraIdSet.has(id);
            const existing = options.get(id);
            if (!existing) {
                options.set(id, {
                    id,
                    name: name || id,
                    kind: normalizedKind,
                    isHistorical,
                });
                return;
            }
            options.set(id, {
                id,
                name: existing.name || name || id,
                kind: existing.kind !== 'other' ? existing.kind : normalizedKind,
                isHistorical: existing.isHistorical && isHistorical,
            });
        };

        cameras.forEach((cam) => {
            upsertOption(
                cam.id,
                cam.name || cam.id,
                normalizeSourceFilterKind(cam.source_kind),
            );
        });

        events.forEach((evt) => {
            if (!evt?.camera_id) return;
            upsertOption(
                evt.camera_id,
                evt.camera_name || evt.camera_id,
                getReportSourceFilterKind(evt, cameraSourceKindById),
            );
        });

        countingSnapshots.forEach((snapshot) => {
            if (!snapshot?.camera_id) return;
            upsertOption(
                snapshot.camera_id,
                snapshot.camera_name || snapshot.camera_id,
                getReportSourceFilterKind(snapshot, cameraSourceKindById),
            );
        });

        return Array.from(options.values())
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [cameraSourceKindById, cameras, countingSnapshots, currentCameraIdSet, events]);
    const isOverviewCategory = selectedCategory === 'All';
    const isPeopleCountingCategory = selectedCategory === 'People Counting';
    const isDressCodeCategory = selectedCategory === 'Dress Code';
    const isPeopleCountingBuildingView = isPeopleCountingCategory && selectedPeopleCountingView === 'building';
    const isPeopleCountingCameraView = isPeopleCountingCategory && selectedPeopleCountingView === 'camera';
    const isPeopleCountingTrafficView = isPeopleCountingCategory && selectedPeopleCountingView === 'traffic';
    const effectiveSourceFilter = selectedSourceFilter;
    const cameraOptions = useMemo(() => (
        baseCameraOptions
            .filter((option) => effectiveSourceFilter === 'all' || option.kind === effectiveSourceFilter)
            .map(({ id, name, isHistorical }) => ({
                id,
                name: isHistorical ? `${name} (Historical)` : name,
            }))
    ), [baseCameraOptions, effectiveSourceFilter]);

    // Date filter helper
    const dateFilter = (row, field = 'timestamp') => {
        const tsMs = getReportTimeMs(row, field);
        if (!tsMs) return false;
        if (reportingDateBounds.startMs !== null && tsMs < reportingDateBounds.startMs) return false;
        if (reportingDateBounds.endMs !== null && tsMs > reportingDateBounds.endMs) return false;
        return true;
    };
    const cameraFilter = (cameraId) => selectedCameraFilter === 'all' || cameraId === selectedCameraFilter;
    const sourceFilter = useCallback((item) => {
        if (effectiveSourceFilter === 'all') return true;
        return getReportSourceFilterKind(item, cameraSourceKindById) === effectiveSourceFilter;
    }, [cameraSourceKindById, effectiveSourceFilter]);

    // Filtered events
    const filteredEvents = events
        .map(evt => ({ ...evt, camera_name: cameraNameById[evt.camera_id] || evt.camera_name }))
        .filter(evt => dateFilter(evt) && cameraFilter(evt.camera_id) && sourceFilter(evt));
    const filteredBuildingAlerts = filteredEvents
        .filter((evt) => evt.event_type === 'Capacity Exceeded' && evt.details?.scope === 'building')
        .sort((a, b) => getReportTimeMs(b) - getReportTimeMs(a));

    // Filtered counting snapshots
    const filteredSnapshots = countingSnapshots
        .map(s => ({ ...s, camera_name: s.camera_name || cameraNameById[s.camera_id] || s.camera_id }))
        .filter(s => dateFilter(s) && cameraFilter(s.camera_id) && sourceFilter(s));
    const selectedCountingSnapshots = countingSnapshots
        .map(s => ({ ...s, camera_name: s.camera_name || cameraNameById[s.camera_id] || s.camera_id }))
        .filter(s => cameraFilter(s.camera_id) && sourceFilter(s));
    const selectedCameraMeta = selectedCameraFilter === 'all'
        ? null
        : cameraOptions.find((cam) => cam.id === selectedCameraFilter);
    const selectedCameraLabel = selectedCameraMeta?.name
        || (selectedCameraFilter === 'all'
            ? `Selected cameras${cameraOptions.length ? ` (${cameraOptions.length})` : ''}`
            : selectedCameraFilter);
    const getCameraBadgeLabel = useCallback((item) => {
        const baseLabel = getCameraLabel(item);
        const sourceKind = getReportSourceFilterKind(item, cameraSourceKindById);
        if (sourceKind === 'building') return baseLabel;
        if (sourceKind === 'uploaded') return `Video | ${baseLabel}`;
        if (sourceKind === 'live') return `RTSP | ${baseLabel}`;
        return `Other | ${baseLabel}`;
    }, [cameraSourceKindById]);
    const selectedSourceFilterLabel = (
        effectiveSourceFilter === 'uploaded'
            ? 'Uploaded Video'
            : effectiveSourceFilter === 'live'
                ? 'RTSP / Network'
                : 'All Sources'
    );
    const peopleCountingSummaryBucket = useMemo(() => {
        const nowMs = Date.now();
        const effectiveEndMs = reportingDateBounds.endMs ?? nowMs;
        const effectiveStartMs = reportingDateBounds.startMs ?? Math.max(0, effectiveEndMs - OCCUPANCY_RANGE_LOOKBACK_MS['7d']);
        return getAdaptiveFlowBucket('custom', effectiveStartMs, effectiveEndMs);
    }, [reportingDateBounds.endMs, reportingDateBounds.startMs]);
    const peopleCountingSummary = useMemo(() => aggregateCountingFlow(selectedCountingSnapshots, {
        startMs: reportingDateBounds.startMs,
        endMs: reportingDateBounds.endMs,
        bucket: peopleCountingSummaryBucket,
    }), [peopleCountingSummaryBucket, reportingDateBounds.endMs, reportingDateBounds.startMs, selectedCountingSnapshots]);
    const latestSelectedSnapshotSummary = useMemo(() => summarizeLatestSnapshots(selectedCountingSnapshots, {
        startMs: reportingDateBounds.startMs,
        endMs: reportingDateBounds.endMs,
    }), [reportingDateBounds.endMs, reportingDateBounds.startMs, selectedCountingSnapshots]);
    const dailyFlowSeries = useMemo(() => (
        aggregateCountingFlow(selectedCountingSnapshots, {
            startMs: reportingDateBounds.startMs,
            endMs: reportingDateBounds.endMs,
            bucket: '1d',
        }).series
    ), [reportingDateBounds.endMs, reportingDateBounds.startMs, selectedCountingSnapshots]);
    const dailyDetectionSeries = useMemo(() => {
        const byDay = new Map();

        filteredEvents.forEach((evt) => {
            const tsMs = getReportTimeMs(evt);
            if (!tsMs) return;

            const dayStartMs = getBucketStartMs(tsMs, '1d');
            const existing = byDay.get(dayStartMs);
            if (existing) {
                existing.violations += 1;
                return;
            }

            byDay.set(dayStartMs, {
                tsMs: dayStartMs,
                name: formatFlowBucketTick(dayStartMs, '1d'),
                violations: 1,
            });
        });

        return Array.from(byDay.values())
            .sort((a, b) => a.tsMs - b.tsMs)
            .map(({ tsMs, ...point }) => point);
    }, [filteredEvents]);
    const shouldUseRtspSnapshotTotals = useMemo(() => (
        isSourceOnlySnapshotScope(selectedCountingSnapshots, cameraSourceKindById, 'live', effectiveSourceFilter)
    ), [cameraSourceKindById, effectiveSourceFilter, selectedCountingSnapshots]);
    const shouldUseUploadedSnapshotTotals = useMemo(() => (
        isSourceOnlySnapshotScope(selectedCountingSnapshots, cameraSourceKindById, 'uploaded', effectiveSourceFilter)
    ), [cameraSourceKindById, effectiveSourceFilter, selectedCountingSnapshots]);
    const shouldUseSnapshotCountingTotals = shouldUseRtspSnapshotTotals || shouldUseUploadedSnapshotTotals;
    const shouldUseRangeScopedSnapshotCountingTotals = (
        shouldPreferSnapshotTotalsForAppliedRange
        && shouldUseSnapshotCountingTotals
    );
    const shouldUseLatestSnapshotTotals = shouldPreferSnapshotTotalsForAppliedRange
        && latestSelectedSnapshotSummary.snapshotCount > 0;
    const displayedPeopleCountingTotalIn = shouldUseRangeScopedSnapshotCountingTotals
        ? Number(latestSelectedSnapshotSummary.totalIn ?? 0)
        : Number(peopleCountingSummary.totalIn ?? 0);
    const displayedPeopleCountingTotalOut = shouldUseRangeScopedSnapshotCountingTotals
        ? Number(latestSelectedSnapshotSummary.totalOut ?? 0)
        : Number(peopleCountingSummary.totalOut ?? 0);
    const displayedPeopleCountingTotalTraffic = shouldUseRangeScopedSnapshotCountingTotals
        ? Number(latestSelectedSnapshotSummary.totalTraffic ?? 0)
        : Number(peopleCountingSummary.totalTraffic ?? 0);
    const displayedPeopleCountingOccupancy = (shouldUseLatestSnapshotTotals || shouldUseRangeScopedSnapshotCountingTotals)
        ? Number(latestSelectedSnapshotSummary.estimatedOccupancy ?? 0)
        : Number(peopleCountingSummary.estimatedOccupancy ?? 0);
    const displayedPeopleCountingPeakOccupancy = useMemo(() => (
        selectedCameraFilter === 'all'
            ? calculateCombinedPeakOccupancy(selectedCountingSnapshots, {
                startMs: reportingDateBounds.startMs,
                endMs: reportingDateBounds.endMs,
            })
            : Number(peopleCountingSummary.peakOccupancy ?? 0)
    ), [
        peopleCountingSummary.peakOccupancy,
        reportingDateBounds.endMs,
        reportingDateBounds.startMs,
        selectedCameraFilter,
        selectedCountingSnapshots,
    ]);

    // Build combined display rows for log table
    const displayRows = (() => {
        if (isPeopleCountingCategory) {
            // Show counting snapshots as log entries (plus any capacity alerts)
            const snapshotRows = filteredSnapshots.map(s => ({
                id: s.id,
                timestamp: s.timestamp,
                processed_at: s.processed_at,
                event_type: 'Counting Snapshot',
                camera_id: s.camera_id,
                camera_name: s.camera_name,
                total_in: s.total_in,
                total_out: s.total_out,
                current_occupancy: s.current_occupancy,
                foot_traffic_total: s.foot_traffic_total,
                _isSnapshot: true,
            }));
            const eventRows = filteredEvents.map(e => ({ ...e, _isSnapshot: false }));
            return [...eventRows, ...snapshotRows].sort((a, b) => {
                const aValue = getSortableTimeValue(a, detectionLogSort.field);
                const bValue = getSortableTimeValue(b, detectionLogSort.field);
                if (aValue == null && bValue == null) return 0;
                if (aValue == null) return 1;
                if (bValue == null) return -1;
                return detectionLogSort.direction === 'asc' ? aValue - bValue : bValue - aValue;
            });
        }
        const detectionRows = filteredEvents.map(e => ({ ...e, _isSnapshot: false }));
        detectionRows.sort((a, b) => {
            const aValue = getSortableTimeValue(a, detectionLogSort.field);
            const bValue = getSortableTimeValue(b, detectionLogSort.field);
            if (aValue == null && bValue == null) return 0;
            if (aValue == null) return 1;
            if (bValue == null) return -1;
            return detectionLogSort.direction === 'asc' ? aValue - bValue : bValue - aValue;
        });
        if (selectedCategory === 'All') {
            return detectionRows;
        }
        // Detection-only categories
        return detectionRows;
    })();

    const chartData = useMemo(() => {
        if (selectedCategory === 'People Counting') {
            return dailyFlowSeries.map((point) => ({
                name: point.label,
                totalIn: point.in,
                totalOut: point.out,
            }));
        }

        return dailyDetectionSeries;
    }, [dailyDetectionSeries, dailyFlowSeries, selectedCategory]);

    const isPeopleCountingChart = isPeopleCountingCategory;
    const showStandardReportSections = !isOverviewCategory && !isPeopleCountingBuildingView && !isPeopleCountingTrafficView;
    const showLogTable = showStandardReportSections || isOverviewCategory;
    const totalDisplayRows = displayRows.length;
    const totalPages = Math.max(1, Math.ceil(totalDisplayRows / rowsPerPage));
    const pageStartIndex = (currentPage - 1) * rowsPerPage;
    const paginatedRows = displayRows.slice(pageStartIndex, pageStartIndex + rowsPerPage);
    const pageStartLabel = totalDisplayRows === 0 ? 0 : pageStartIndex + 1;
    const pageEndLabel = Math.min(pageStartIndex + rowsPerPage, totalDisplayRows);

    useEffect(() => {
        setCurrentPage(1);
    }, [selectedCategory, selectedPeopleCountingView, selectedCameraFilter, selectedSourceFilter, selectedQuickRange, startDate, endDate, detectionLogSort]);

    useEffect(() => {
        if (selectedCameraFilter === 'all') return;
        if (cameraOptions.some((cam) => cam.id === selectedCameraFilter)) return;
        setSelectedCameraFilter('all');
    }, [cameraOptions, selectedCameraFilter]);

    useEffect(() => {
        if (currentPage > totalPages) {
            setCurrentPage(totalPages);
        }
    }, [currentPage, totalPages]);

    useEffect(() => {
        if (!isCustomQuickRange) {
            setDraftStartDate(effectiveStartDate);
            setDraftEndDate(effectiveEndDate);
        }
    }, [effectiveEndDate, effectiveStartDate, isCustomQuickRange]);

    // Handlers
    const toggleDetectionLogSort = (field) => {
        setDetectionLogSort((current) => {
            if (current.field === field) {
                return {
                    field,
                    direction: current.direction === 'desc' ? 'asc' : 'desc',
                };
            }
            return {
                field,
                direction: 'desc',
            };
        });
    };
    const renderDetectionSortIndicator = (field) => {
        if (detectionLogSort.field !== field) {
            return <span className="text-[11px] text-muted-foreground/70">↕</span>;
        }
        return (
            <span className="text-[11px] text-foreground">
                {detectionLogSort.direction === 'desc' ? '↓' : '↑'}
            </span>
        );
    };
    const handleCategoryChange = (cat) => setSelectedCategory(cat);
    const applyCustomRange = useCallback(() => {
        if (!isCustomRangeValid) return;
        setStartDate(draftStartDate);
        setEndDate(draftEndDate);
    }, [draftEndDate, draftStartDate, isCustomRangeValid]);
    const handleCustomRangeKeyDown = useCallback((event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            applyCustomRange();
        }
    }, [applyCustomRange]);

    const handleDownload = (format) => {
        setShowExportModal(false);
        if (format === 'CSV') {
            let csv;
            if (isPeopleCountingBuildingView) {
                alert('Building view export is not implemented yet.');
                return;
            }
            if (isPeopleCountingCategory) {
                csv = 'Timestamp,Processed At,Camera Name,Camera ID,Total In,Total Out,Occupancy,Foot Traffic\n';
                csv += filteredSnapshots.map(s => [
                    toCsvCell(s.timestamp),
                    toCsvCell(s.processed_at),
                    toCsvCell(getCameraLabel(s)),
                    toCsvCell(s.camera_id),
                    toCsvCell(s.total_in),
                    toCsvCell(s.total_out),
                    toCsvCell(s.current_occupancy),
                    toCsvCell(s.foot_traffic_total),
                ].join(',')).join('\n');
            } else {
                csv = 'ID,Timestamp,Processed At,Event Type,Camera Name,Camera ID,Label,Confidence\n';
                csv += filteredEvents.map(e => [
                    toCsvCell(e.id),
                    toCsvCell(e.timestamp),
                    toCsvCell(e.processed_at),
                    toCsvCell(e.event_type),
                    toCsvCell(getCameraLabel(e)),
                    toCsvCell(e.camera_id),
                    toCsvCell(e.details?.label || ''),
                    toCsvCell(e.details?.confidence || ''),
                ].join(',')).join('\n');
            }
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `report_${selectedCategory.replace(/\s/g, '_')}_${new Date().toISOString().split('T')[0]}.csv`;
            link.click();
            URL.revokeObjectURL(url);
        } else {
            if (isPeopleCountingBuildingView) {
                alert('Building view export is not implemented yet.');
                return;
            }

            const isCounting = isPeopleCountingCategory;
            const title = `${selectedCategory} Report`;
            const filters = [
                `Generated: ${new Date().toLocaleString()}`,
                `Category: ${selectedCategory}`,
                `Quick Range: ${selectedQuickRange}`,
                selectedSourceFilter !== 'all' ? `Source Type: ${selectedSourceFilterLabel}` : null,
                selectedCameraFilter !== 'all' ? `Camera Filter: ${selectedCameraFilter}` : null,
                isCounting ? `Mode: ${selectedPeopleCountingView}` : null,
                `Rows: ${isCounting ? filteredSnapshots.length : filteredEvents.length}`,
            ].filter(Boolean);
            const headers = isCounting
                ? ['Timestamp', 'Processed At', 'Camera Name', 'Camera ID', 'Total In', 'Total Out', 'Occupancy', 'Foot Traffic']
                : ['ID', 'Timestamp', 'Processed At', 'Event Type', 'Camera Name', 'Camera ID', 'Label', 'Confidence'];
            const rows = isCounting
                ? filteredSnapshots.map((s) => [
                    s.timestamp,
                    s.processed_at,
                    getCameraLabel(s),
                    s.camera_id,
                    s.total_in,
                    s.total_out,
                    s.current_occupancy,
                    s.foot_traffic_total,
                ])
                : filteredEvents.map((e) => [
                    e.id,
                    e.timestamp,
                    e.processed_at,
                    e.event_type,
                    getCameraLabel(e),
                    e.camera_id,
                    e.details?.label || '',
                    e.details?.confidence || '',
                ]);

            const printWindow = window.open('', '_blank', 'width=1100,height=800');
            if (!printWindow) {
                alert('Unable to open print window for PDF export.');
                return;
            }

            const tableHead = headers.map((header) => `<th>${escapeExportHtml(header)}</th>`).join('');
            const tableRows = rows.length
                ? rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeExportHtml(cell)}</td>`).join('')}</tr>`).join('')
                : `<tr><td colspan="${headers.length}">No data available for the current filters.</td></tr>`;

            printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
  <title>${escapeExportHtml(title)}</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; color: #0f172a; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    .meta { margin: 0 0 18px; color: #475569; font-size: 12px; line-height: 1.6; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border: 1px solid #cbd5e1; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f8fafc; }
    tr:nth-child(even) td { background: #f8fafc; }
  </style>
</head>
<body>
  <h1>${escapeExportHtml(title)}</h1>
  <div class="meta">${filters.map((item) => `<div>${escapeExportHtml(item)}</div>`).join('')}</div>
  <table>
    <thead><tr>${tableHead}</tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
</body>
</html>`);
            printWindow.document.close();
            printWindow.focus();
            window.setTimeout(() => {
                printWindow.print();
            }, 150);
        }
    };

    return (
        <div className="flex h-full flex-col gap-6 overflow-auto bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.08),_transparent_32%),linear-gradient(180deg,_rgba(248,250,252,0.95),_rgba(255,255,255,1))] p-6">
            {/* Header */}
            <section className="relative shrink-0 overflow-hidden rounded-[28px] border border-slate-200/80 bg-white/90 p-6 shadow-sm backdrop-blur">
                <div className="pointer-events-none absolute right-[-100px] top-[-120px] h-64 w-64 rounded-full bg-blue-100/60 blur-3xl" />
                <div className="relative flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <h1 className="text-3xl font-bold tracking-tight">Reporting Dashboard</h1>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            onClick={() => { fetchEvents(); fetchCountingSnapshots(); setRefreshToken((value) => value + 1); }}
                            disabled={loading}
                            className="gap-2 border-slate-200 bg-white"
                        >
                            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} /> Refresh
                        </Button>
                        <Button onClick={() => setShowExportModal(true)} className="gap-2" disabled={isPeopleCountingBuildingView}>
                            <Download className="w-4 h-4" /> Export Report
                        </Button>
                    </div>
                </div>
            </section>

            {/* Filter Bar */}
            <Card className={cn(REPORT_SURFACE_CARD_CLASS, "shrink-0 rounded-[28px]")}>
                <CardContent className="space-y-4 p-5 md:p-6">
                    <div className={cn(
                        "grid gap-4",
                        isPeopleCountingCategory
                            ? "xl:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)]"
                            : "xl:grid-cols-1",
                    )}>
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Report Category</label>
                            <div className="flex h-10 items-center rounded-xl border border-slate-200 bg-slate-100/80 p-1">
                                {['All', 'Dress Code', 'Fall Detection', 'People Counting'].map(cat => (
                                    <button key={cat} onClick={() => handleCategoryChange(cat)}
                                        className={cn("px-3 py-1.5 text-sm font-medium rounded-sm transition-all flex-1 whitespace-nowrap",
                                            selectedCategory === cat ? "rounded-lg bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground")}>
                                        {cat}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {isPeopleCountingCategory && (
                            <div className="space-y-2">
                                <label className="text-sm font-medium">People Counting View</label>
                                <div className="flex h-10 items-center rounded-xl border border-slate-200 bg-slate-100/80 p-1">
                                    {[
                                        { id: 'building', label: 'Building' },
                                        { id: 'camera', label: 'Camera' },
                                        { id: 'traffic', label: 'Traffic Analytics' },
                                    ].map(view => (
                                        <button
                                            key={view.id}
                                            onClick={() => setSelectedPeopleCountingView(view.id)}
                                            className={cn(
                                                "px-3 py-1.5 text-sm font-medium rounded-sm transition-all flex-1 whitespace-nowrap",
                                                selectedPeopleCountingView === view.id
                                                    ? "rounded-lg bg-white shadow-sm text-foreground"
                                                    : "text-muted-foreground hover:text-foreground",
                                            )}
                                        >
                                            {view.label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>

                    <div className={cn(
                        "grid gap-4 xl:items-end",
                        isPeopleCountingBuildingView
                            ? (isCustomQuickRange
                                ? "xl:grid-cols-[minmax(180px,0.8fr)_minmax(180px,1fr)_minmax(180px,1fr)_minmax(140px,0.6fr)_minmax(180px,0.9fr)_minmax(220px,1fr)_auto_auto]"
                                : "xl:grid-cols-[minmax(180px,0.8fr)_minmax(180px,1fr)_minmax(180px,1fr)_minmax(140px,0.6fr)_minmax(180px,0.9fr)_minmax(220px,1fr)_auto]")
                            : (isCustomQuickRange
                                ? "xl:grid-cols-[minmax(180px,0.8fr)_minmax(180px,1fr)_minmax(180px,1fr)_minmax(180px,0.9fr)_minmax(220px,1fr)_auto_auto]"
                                : "xl:grid-cols-[minmax(180px,0.8fr)_minmax(180px,1fr)_minmax(180px,1fr)_minmax(180px,0.9fr)_minmax(220px,1fr)_auto]"),
                    )}>
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Quick Range</label>
                            <select
                                className={cn("h-10 w-full rounded-md border px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", REPORT_INPUT_CLASS)}
                                value={selectedQuickRange}
                                onChange={(e) => setSelectedQuickRange(e.target.value)}
                            >
                                <option value="today">Today</option>
                                <option value="7d">Last 7 Days</option>
                                <option value="30d">Last 30 Days</option>
                                <option value="all">All Time</option>
                                <option value="custom">Custom</option>
                            </select>
                        </div>

                        <div className={cn("space-y-2 transition-opacity", !isCustomQuickRange && "opacity-50")}>
                            <label className="text-sm font-medium">Start Date & Time</label>
                            <div className="relative">
                                <Calendar className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                <input
                                    type="datetime-local"
                                    disabled={!isCustomQuickRange}
                                    className={cn("h-10 w-full rounded-md border px-3 py-2 pl-9 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-muted/30", REPORT_INPUT_CLASS)}
                                    value={isCustomQuickRange ? draftStartDate : effectiveStartDate}
                                    onChange={(e) => setDraftStartDate(e.target.value)}
                                    onKeyDown={handleCustomRangeKeyDown}
                                />
                            </div>
                        </div>

                        <div className={cn("space-y-2 transition-opacity", !isCustomQuickRange && "opacity-50")}>
                            <label className="text-sm font-medium">End Date & Time</label>
                            <div className="relative">
                                <Calendar className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                <input
                                    type="datetime-local"
                                    disabled={!isCustomQuickRange}
                                    className={cn("h-10 w-full rounded-md border px-3 py-2 pl-9 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-muted/30", REPORT_INPUT_CLASS)}
                                    value={isCustomQuickRange ? draftEndDate : effectiveEndDate}
                                    onChange={(e) => setDraftEndDate(e.target.value)}
                                    onKeyDown={handleCustomRangeKeyDown}
                                />
                            </div>
                        </div>

                        {isPeopleCountingBuildingView ? (
                            <>
                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Grouping</label>
                                    <select
                                        className={cn("h-10 w-full rounded-md border px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", REPORT_INPUT_CLASS)}
                                        value={buildingGrouping}
                                        onChange={(e) => setBuildingGrouping(e.target.value)}
                                    >
                                        <option value="auto">Auto</option>
                                        <option value="15m">15 min</option>
                                        <option value="1h">Hourly</option>
                                        <option value="1d">Daily</option>
                                    </select>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Source Type</label>
                                    <select
                                        className={cn("h-10 w-full rounded-md border px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", REPORT_INPUT_CLASS)}
                                        value={selectedSourceFilter}
                                        onChange={(e) => setSelectedSourceFilter(e.target.value)}
                                    >
                                        <option value="all">All Sources</option>
                                        <option value="live">RTSP / Network</option>
                                        <option value="uploaded">Uploaded Video</option>
                                    </select>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Camera</label>
                                    <select
                                        className={cn("h-10 w-full min-w-[220px] rounded-md border px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", REPORT_INPUT_CLASS)}
                                        value={selectedCameraFilter}
                                        onChange={(e) => setSelectedCameraFilter(e.target.value)}
                                    >
                                        <option value="all">All Cameras</option>
                                        {cameraOptions.map(cam => (
                                            <option key={cam.id} value={cam.id}>{cam.name || cam.id}</option>
                                        ))}
                                    </select>
                                </div>
                            </>
                        ) : (
                            <>
                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Source Type</label>
                                    <select
                                        className={cn("h-10 w-full rounded-md border px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", REPORT_INPUT_CLASS)}
                                        value={selectedSourceFilter}
                                        onChange={(e) => setSelectedSourceFilter(e.target.value)}
                                    >
                                        <option value="all">All Sources</option>
                                        <option value="live">RTSP / Network</option>
                                        <option value="uploaded">Uploaded Video</option>
                                    </select>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Camera</label>
                                    <select
                                        className={cn("h-10 w-full min-w-[220px] rounded-md border px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", REPORT_INPUT_CLASS)}
                                        value={selectedCameraFilter}
                                        onChange={(e) => setSelectedCameraFilter(e.target.value)}
                                    >
                                        <option value="all">All Cameras</option>
                                        {cameraOptions.map(cam => (
                                            <option key={cam.id} value={cam.id}>{cam.name || cam.id}</option>
                                        ))}
                                    </select>
                                </div>
                            </>
                        )}

                        {isCustomQuickRange && (
                            <div className="space-y-2 xl:self-end">
                                <label className="text-sm font-medium opacity-0">Apply</label>
                                <Button
                                    variant="outline"
                                    className="h-10 border-slate-200 bg-white"
                                    onClick={applyCustomRange}
                                    disabled={!isCustomRangeDirty || !isCustomRangeValid}
                                >
                                    Apply
                                </Button>
                            </div>
                        )}

                        <div className="text-sm text-muted-foreground xl:justify-self-end xl:self-end pb-2">
                            {isOverviewCategory
                                ? 'Overview dashboard'
                                : isPeopleCountingBuildingView
                                ? 'Building-level occupancy view'
                                : `${totalDisplayRows} record${totalDisplayRows !== 1 ? 's' : ''} found`}
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Charts & Log */}
            <div className="flex-1 overflow-y-auto grid grid-cols-1 gap-6 min-h-0">
                {isOverviewCategory && (
                    <AllOverviewPanel
                        events={filteredEvents}
                        snapshots={filteredSnapshots}
                        startMs={reportingDateBounds.startMs}
                        endMs={reportingDateBounds.endMs}
                        cameraOptions={cameraOptions}
                        cameraFilter={selectedCameraFilter}
                        preferLatestSnapshotTotals={shouldPreferSnapshotTotalsForAppliedRange}
                        useSnapshotCountingTotals={shouldUseRangeScopedSnapshotCountingTotals}
                    />
                )}

                <BuildingOccupancyPanel
                    apiUrl={apiUrl}
                    reportStartMs={reportingDateBounds.startMs}
                    reportEndMs={reportingDateBounds.endMs}
                    selectedBucket={buildingGrouping}
                    refreshToken={refreshToken}
                    visible={isPeopleCountingBuildingView}
                    cameraNameById={cameraNameById}
                    countingSnapshots={selectedCountingSnapshots}
                    selectedSourceFilter={selectedSourceFilter}
                    selectedCameraFilter={selectedCameraFilter}
                    cameraSourceKindById={cameraSourceKindById}
                    preferLatestSnapshotTotals={shouldPreferSnapshotTotalsForAppliedRange}
                />

                <BuildingAlertsPanel
                    rows={filteredBuildingAlerts}
                    onSelectRecord={setSelectedRecord}
                    loading={loading}
                    visible={isPeopleCountingBuildingView}
                />

                {isDressCodeCategory && (
                    <DressCodeAnalyticsPanel
                        events={filteredEvents}
                        snapshots={filteredSnapshots}
                        cameraLabel={selectedCameraLabel}
                        startMs={reportingDateBounds.startMs}
                        endMs={reportingDateBounds.endMs}
                        isAllCameras={selectedCameraFilter === 'all'}
                    />
                )}

                {!isPeopleCountingBuildingView && (
                    <>
                        {isPeopleCountingCameraView && (
                            <>
                                <div className={cn(REPORT_SECTION_HEADER_CLASS, "space-y-1")}>
                                    <h2 className="text-lg font-semibold tracking-tight">Reporting</h2>
                                    <p className="text-sm text-muted-foreground">
                                        Camera-focused flow reporting for {selectedCameraLabel}.
                                    </p>
                                </div>

                                {selectedCameraFilter === 'all' && (
                                    <div className="rounded-md border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-sm text-blue-700">
                                        Combined flow is being shown across all selected cameras. Choose a single camera for the clearest entrance-level report.
                                    </div>
                                )}

                                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
                                    <div className="rounded-xl border border-green-500/20 bg-green-500/10 p-4">
                                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                            <ArrowDownToLine className="h-4 w-4 text-green-600" />
                                            Total In
                                        </div>
                                        <div className="mt-2 text-3xl font-bold text-green-600">{formatNumber(displayedPeopleCountingTotalIn)}</div>
                                    </div>
                                    <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4">
                                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                            <ArrowUpFromLine className="h-4 w-4 text-red-600" />
                                            Total Out
                                        </div>
                                        <div className="mt-2 text-3xl font-bold text-red-600">{formatNumber(displayedPeopleCountingTotalOut)}</div>
                                    </div>
                                    <div className="rounded-xl border border-slate-300 bg-slate-50 p-4">
                                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                            <Activity className="h-4 w-4 text-slate-700" />
                                            Total Traffic
                                        </div>
                                        <div className="mt-2 text-3xl font-bold text-slate-800">{formatNumber(displayedPeopleCountingTotalTraffic)}</div>
                                    </div>
                                    <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4">
                                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                            <Clock3 className="h-4 w-4 text-amber-600" />
                                            Peak Period
                                        </div>
                                        <div className="mt-2 text-lg font-semibold text-amber-700">{peopleCountingSummary.peakPeriodLabel}</div>
                                    </div>
                                    <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-4">
                                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                            <Users className="h-4 w-4 text-blue-600" />
                                            Peak Occupancy
                                        </div>
                                        <div className="mt-2 text-3xl font-bold text-blue-700">{formatNumber(displayedPeopleCountingPeakOccupancy)}</div>
                                    </div>
                                    <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/10 p-4">
                                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                            <TrendingUp className="h-4 w-4 text-indigo-600" />
                                            Current Occupancy
                                        </div>
                                        <div className="mt-2 text-3xl font-bold text-indigo-700">{formatNumber(displayedPeopleCountingOccupancy)}</div>
                                    </div>
                                </div>

                                <FlowTrendPanel snapshots={selectedCountingSnapshots} cameraLabel={selectedCameraLabel} />
                            </>
                        )}

                        {isPeopleCountingTrafficView && (
                              <TrafficAnalyticsPanel
                                  snapshots={selectedCountingSnapshots}
                                  cameraLabel={selectedCameraLabel}
                                  startMs={reportingDateBounds.startMs}
                                  endMs={reportingDateBounds.endMs}
                                  isAllCameras={selectedCameraFilter === 'all'}
                                  latestSnapshotTotals={(shouldUseLatestSnapshotTotals || shouldUseRangeScopedSnapshotCountingTotals) ? latestSelectedSnapshotSummary : null}
                              />
                        )}

                {showStandardReportSections && (
                    <>
                        {/* Events / Counting by Day Chart */}
                        <Card className={cn(REPORT_SURFACE_CARD_CLASS, "flex flex-col min-h-[350px]")}>
                            <CardHeader>
                                <CardTitle>{isPeopleCountingChart ? 'In/Out by Day' : 'Events by Day'}</CardTitle>
                            </CardHeader>
                            <CardContent className="flex-1 min-h-[250px]">
                                {chartData.length > 0 ? (
                                    <ResponsiveContainer width="100%" height="100%">
                                        {isPeopleCountingChart ? (
                                            <BarChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                                                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                                                <XAxis dataKey="name" className="text-xs text-muted-foreground" tickLine={false} axisLine={false} />
                                                <YAxis className="text-xs text-muted-foreground" tickLine={false} axisLine={false} allowDecimals={false} />
                                                <RechartsTooltip cursor={{ fill: 'transparent' }}
                                                    formatter={(value, name) => [formatNumber(value), name]}
                                                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }} />
                                                <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                                                <Bar dataKey="totalIn" name="In" fill="#22c55e" radius={[4, 4, 0, 0]} maxBarSize={40} />
                                                <Bar dataKey="totalOut" name="Out" fill="#ef4444" radius={[4, 4, 0, 0]} maxBarSize={40} />
                                            </BarChart>
                                        ) : (
                                            <BarChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                                                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                                                <XAxis dataKey="name" className="text-xs text-muted-foreground" tickLine={false} axisLine={false} />
                                                <YAxis className="text-xs text-muted-foreground" tickLine={false} axisLine={false} allowDecimals={false} />
                                                <RechartsTooltip cursor={{ fill: 'transparent' }}
                                                    formatter={(value, name) => [formatNumber(value), name]}
                                                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }} />
                                                <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                                                <Bar dataKey="violations" name="Events" fill="hsl(var(--destructive))" radius={[4, 4, 0, 0]} maxBarSize={40} />
                                            </BarChart>
                                        )}
                                    </ResponsiveContainer>
                                ) : (
                                    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                                        No data to display
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </>
                )}

                {showLogTable && (
                <Card className={cn(REPORT_SURFACE_CARD_CLASS, "flex flex-col min-h-[350px] overflow-hidden")}>
                    <CardHeader className="flex flex-row items-center justify-between gap-4">
                        <CardTitle>
                            {selectedCategory === 'People Counting' ? 'Counting Log' : 'Detection Event Logs'}
                        </CardTitle>
                        <div className="flex items-center gap-3">
                            <label className="text-xs text-muted-foreground">Rows</label>
                            <select
                                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                                value={rowsPerPage}
                                onChange={(e) => {
                                    setRowsPerPage(Number(e.target.value));
                                    setCurrentPage(1);
                                }}
                            >
                                {[10, 20, 50, 100].map(size => (
                                    <option key={size} value={size}>{size}</option>
                                ))}
                            </select>
                        </div>
                    </CardHeader>
                    <CardContent className="flex-1 p-0 overflow-auto">
                        <table className="w-full min-w-[1220px] text-sm text-left">
                            <thead className="text-muted-foreground bg-muted/50 sticky top-0">
                                <tr>
                                    <th className="px-4 py-3 font-medium">
                                        <button
                                            type="button"
                                            className="inline-flex items-center gap-2 text-left"
                                            onClick={() => toggleDetectionLogSort('timestamp')}
                                        >
                                            <span>Timestamp</span>
                                            {renderDetectionSortIndicator('timestamp')}
                                        </button>
                                    </th>
                                    <th className="px-4 py-3 font-medium">
                                        <button
                                            type="button"
                                            className="inline-flex items-center gap-2 text-left"
                                            onClick={() => toggleDetectionLogSort('processed_at')}
                                        >
                                            <span>Processed At</span>
                                            {renderDetectionSortIndicator('processed_at')}
                                        </button>
                                    </th>
                                    <th className="px-4 py-3 font-medium">Camera</th>
                                    <th className="px-4 py-3 font-medium">Event Type</th>
                                    <th className="px-4 py-3 font-medium">Subtype</th>
                                    <th className="px-4 py-3 font-medium text-right">In</th>
                                    <th className="px-4 py-3 font-medium text-right">Out</th>
                                    <th className="px-4 py-3 font-medium text-right">Foot Traffic</th>
                                    <th className="px-4 py-3 font-medium text-right">Occupancy</th>
                                    <th className="px-4 py-3 font-medium text-right">Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {paginatedRows.length > 0 ? paginatedRows.map(row => {
                                    if (row._isSnapshot) {
                                        return (
                                            <tr key={row.id} className="group hover:bg-muted/30 transition-colors cursor-pointer"
                                                onClick={() => setSelectedRecord(row)}>
                                                <td className="px-4 py-3">{formatReportTime(row)}</td>
                                                <td className="px-4 py-3">{formatTimestamp(row.processed_at)}</td>
                                                <td className="px-4 py-3">
                                                    <span className={cn(
                                                        "inline-flex items-center gap-2 rounded-full border px-2 py-1 text-xs font-medium",
                                                        getCameraBadgeStyle(row.camera_id).badge,
                                                    )}>
                                                        <span className={cn("h-1.5 w-1.5 rounded-full", getCameraBadgeStyle(row.camera_id).dot)} />
                                                        {getCameraBadgeLabel(row)}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3">
                                                    <div className="flex items-center gap-2">
                                                        <div className="w-2 h-2 rounded-full bg-blue-500" />
                                                        Counting Snapshot
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3 text-muted-foreground">Snapshot</td>
                                                <td className="px-4 py-3 text-right font-medium text-green-600">{formatNumber(row.total_in)}</td>
                                                <td className="px-4 py-3 text-right font-medium text-red-600">{formatNumber(row.total_out)}</td>
                                                <td className="px-4 py-3 text-right font-medium text-slate-700">{formatNumber(row.foot_traffic_total)}</td>
                                                <td className="px-4 py-3 text-right font-medium text-blue-700">{formatNumber(row.current_occupancy)}</td>
                                                <td className="px-4 py-3 text-right">
                                                    <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity">
                                                        <Eye className="w-4 h-4" />
                                                    </Button>
                                                </td>
                                            </tr>
                                        );
                                    }

                                    const isCapacity = row.event_type === 'Capacity Exceeded';
                                    const dotColor = isCapacity ? 'bg-orange-500' : 'bg-red-500';
                                    const eventSubtype = row.details?.label
                                        ? String(row.details.label).replace(/_/g, ' ')
                                        : (isCapacity
                                            ? `Capacity alert${row.details?.building_id ? ` (${row.details.building_id})` : ''}`
                                            : '-');
                                    return (
                                        <tr key={row.id} className="hover:bg-muted/30 transition-colors group cursor-pointer"
                                            onClick={() => setSelectedRecord(row)}>
                                            <td className="px-4 py-3">{formatReportTime(row)}</td>
                                            <td className="px-4 py-3">{formatTimestamp(row.processed_at)}</td>
                                            <td className="px-4 py-3">
                                                <span className={cn(
                                                    "inline-flex items-center gap-2 rounded-full border px-2 py-1 text-xs font-medium",
                                                    getCameraBadgeStyle(row.camera_id).badge,
                                                )}>
                                                    <span className={cn("h-1.5 w-1.5 rounded-full", getCameraBadgeStyle(row.camera_id).dot)} />
                                                    {getCameraBadgeLabel(row)}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3">
                                                <div className="flex items-center gap-2">
                                                    <div className={cn("w-2 h-2 rounded-full", dotColor)} />
                                                    {row.event_type}
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 text-muted-foreground">{eventSubtype}</td>
                                            <td className="px-4 py-3 text-right text-muted-foreground">-</td>
                                            <td className="px-4 py-3 text-right text-muted-foreground">-</td>
                                            <td className="px-4 py-3 text-right text-muted-foreground">-</td>
                                            <td className="px-4 py-3 text-right font-medium text-blue-700">
                                                {row.details?.occupancy != null ? formatNumber(row.details.occupancy) : '-'}
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <Eye className="w-4 h-4" />
                                                </Button>
                                            </td>
                                        </tr>
                                    );
                                }) : (
                                    <tr>
                                        <td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">
                                            {loading ? "Loading..." : "No records found."}
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                        <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
                            <span className="text-muted-foreground">
                                Showing {pageStartLabel}-{pageEndLabel} of {totalDisplayRows}
                            </span>
                            <div className="flex items-center gap-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={currentPage <= 1}
                                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                                >
                                    Previous
                                </Button>
                                <span className="text-muted-foreground">
                                    Page {currentPage} / {totalPages}
                                </span>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={currentPage >= totalPages}
                                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                                >
                                    Next
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                )}
                    </>
                )}
            </div>

            {/* Modals */}
            <DetailModal record={selectedRecord} onClose={() => setSelectedRecord(null)} apiUrl={apiUrl} />
            <ExportDialog isOpen={showExportModal} onClose={() => setShowExportModal(false)} onExport={handleDownload} />
        </div>
    );
};

export default Reporting;
