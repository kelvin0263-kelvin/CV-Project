import React, { useState, useEffect, useCallback, useMemo } from 'react';
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
const getTimestampIsoDate = (value) => parseApiTimestamp(value)?.toISOString().split('T')[0] ?? '';
const formatTimestamp = (value) => parseApiTimestamp(value)?.toLocaleString() ?? '-';
const getCameraLabel = (item) => {
    if (item?.details?.scope === 'building') return 'Building';
    return (item?.camera_name || '').trim() || item?.camera_id || 'Unknown Camera';
};
const EMPTY_BUILDING_SUMMARY = {
    enabled: true,
    max_capacity: null,
    capacity_exceeded: false,
    manual_offset: 0,
    raw_in: 0,
    raw_out: 0,
    raw_occupancy: 0,
    occupancy: 0,
    active_camera_count: 0,
    entrance_summaries: {},
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

const downsampleSeries = (rows, maxPoints = OCCUPANCY_CHART_MAX_POINTS) => {
    if (rows.length <= maxPoints) return rows;
    const step = Math.ceil(rows.length / maxPoints);
    return rows.filter((_, idx) => idx % step === 0 || idx === rows.length - 1);
};

const formatDateTimeLocal = (date) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const formatDateOnlyLocal = (date) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

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
        const ts = parseApiTimestamp(row.timestamp);
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
                && ((row.total_in ?? 0) < (previousRow.total_in ?? 0) || (row.total_out ?? 0) < (previousRow.total_out ?? 0));
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
                && (
                    currentLeft < previousLeft
                    || currentRight < previousRight
                    || currentEntries < previousEntries
                );

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
    let totalIn = 0;
    let totalOut = 0;
    let peakOccupancy = 0;
    let latestSnapshot = null;
    let resetCount = 0;
    let previousRow = null;

    sortedRows.forEach((row) => {
        if (!row?.tsMs) return;
        if (startMs != null && row.tsMs < startMs) {
            previousRow = row;
            return;
        }
        if (endMs != null && row.tsMs > endMs) {
            return;
        }

        const currentIn = Number(row.raw_in ?? 0);
        const currentOut = Number(row.raw_out ?? 0);
        const previousIn = Number(previousRow?.raw_in ?? 0);
        const previousOut = Number(previousRow?.raw_out ?? 0);
        const resetDetected = previousRow && (currentIn < previousIn || currentOut < previousOut);
        const deltaIn = previousRow
            ? Math.max(0, resetDetected ? currentIn : (currentIn - previousIn))
            : Math.max(0, currentIn);
        const deltaOut = previousRow
            ? Math.max(0, resetDetected ? currentOut : (currentOut - previousOut))
            : Math.max(0, currentOut);

        if (resetDetected) {
            resetCount += 1;
        }

        totalIn += deltaIn;
        totalOut += deltaOut;
        peakOccupancy = Math.max(peakOccupancy, Number(row.occupancy ?? 0));
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
            rawOccupancy: 0,
            peakOccupancy: 0,
        };

        bucketEntry.in += deltaIn;
        bucketEntry.out += deltaOut;
        bucketEntry.totalTraffic += deltaIn + deltaOut;
        bucketEntry.occupancy = Number(row.occupancy ?? bucketEntry.occupancy ?? 0);
        bucketEntry.rawOccupancy = Number(row.raw_occupancy ?? bucketEntry.rawOccupancy ?? 0);
        bucketEntry.peakOccupancy = Math.max(bucketEntry.peakOccupancy, Number(row.occupancy ?? 0));
        bucketMap.set(bucketStartMs, bucketEntry);
        previousRow = row;
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
        estimatedOccupancy: Number(latestSnapshot?.occupancy ?? 0),
        peakPeriodLabel: peakPeriod?.fullLabel || '-',
        resetCount,
    };
};

const aggregateBuildingEntranceContribution = (rows, { startMs = null, endMs = null } = {}) => {
    const sortedRows = [...rows].sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));
    const entranceMap = new Map();
    let previousRow = null;

    sortedRows.forEach((row) => {
        if (!row?.tsMs) return;
        if (startMs != null && row.tsMs < startMs) {
            previousRow = row;
            return;
        }
        if (endMs != null && row.tsMs > endMs) {
            return;
        }

        const currentSummaries = row.entrance_summaries || {};
        const previousSummaries = previousRow?.entrance_summaries || {};
        const entranceIds = new Set([
            ...Object.keys(previousSummaries),
            ...Object.keys(currentSummaries),
        ]);

        entranceIds.forEach((entranceId) => {
            const current = currentSummaries[entranceId] || {};
            const previous = previousSummaries[entranceId] || {};
            const currentIn = Number(current.total_in ?? 0);
            const currentOut = Number(current.total_out ?? 0);
            const previousIn = Number(previous.total_in ?? 0);
            const previousOut = Number(previous.total_out ?? 0);
            const resetDetected = previousRow && (currentIn < previousIn || currentOut < previousOut);
            const deltaIn = previousRow
                ? Math.max(0, resetDetected ? currentIn : (currentIn - previousIn))
                : Math.max(0, currentIn);
            const deltaOut = previousRow
                ? Math.max(0, resetDetected ? currentOut : (currentOut - previousOut))
                : Math.max(0, currentOut);

            const existing = entranceMap.get(entranceId) || {
                name: entranceId,
                totalIn: 0,
                totalOut: 0,
                totalTraffic: 0,
                currentOccupancy: 0,
                cameraCount: 0,
                cameras: new Map(),
            };

            existing.totalIn += deltaIn;
            existing.totalOut += deltaOut;
            existing.totalTraffic += deltaIn + deltaOut;
            existing.currentOccupancy = Number(current.occupancy ?? existing.currentOccupancy ?? 0);
            const currentCameraSummaries = current.camera_summaries || {};
            const previousCameraSummaries = previous.camera_summaries || {};
            const cameraIds = new Set([
                ...(Array.isArray(current.camera_ids) ? current.camera_ids : []),
                ...(Array.isArray(previous.camera_ids) ? previous.camera_ids : []),
                ...Object.keys(currentCameraSummaries),
                ...Object.keys(previousCameraSummaries),
            ]);

            cameraIds.forEach((cameraId) => {
                const currentCamera = currentCameraSummaries[cameraId] || {};
                const previousCamera = previousCameraSummaries[cameraId] || {};
                const currentCameraIn = Number(currentCamera.total_in ?? 0);
                const currentCameraOut = Number(currentCamera.total_out ?? 0);
                const previousCameraIn = Number(previousCamera.total_in ?? 0);
                const previousCameraOut = Number(previousCamera.total_out ?? 0);
                const cameraResetDetected = previousRow && (
                    currentCameraIn < previousCameraIn
                    || currentCameraOut < previousCameraOut
                );
                const deltaCameraIn = previousRow
                    ? Math.max(0, cameraResetDetected ? currentCameraIn : (currentCameraIn - previousCameraIn))
                    : Math.max(0, currentCameraIn);
                const deltaCameraOut = previousRow
                    ? Math.max(0, cameraResetDetected ? currentCameraOut : (currentCameraOut - previousCameraOut))
                    : Math.max(0, currentCameraOut);

                const existingCamera = existing.cameras.get(cameraId) || {
                    id: cameraId,
                    totalIn: 0,
                    totalOut: 0,
                    totalTraffic: 0,
                    currentOccupancy: 0,
                };

                existingCamera.totalIn += deltaCameraIn;
                existingCamera.totalOut += deltaCameraOut;
                existingCamera.totalTraffic += deltaCameraIn + deltaCameraOut;
                existingCamera.currentOccupancy = Number(currentCamera.occupancy ?? existingCamera.currentOccupancy ?? 0);
                existing.cameras.set(cameraId, existingCamera);
            });

            existing.cameraCount = Math.max(existing.cameraCount, existing.cameras.size, Array.isArray(current.camera_ids) ? current.camera_ids.length : 0);
            entranceMap.set(entranceId, existing);
        });

        previousRow = row;
    });

    const rawEntries = Array.from(entranceMap.values()).map((entry) => {
        const cameras = Array.from(entry.cameras.values())
            .map((camera) => ({
                ...camera,
                share: entry.totalTraffic > 0 ? (Number(camera.totalTraffic || 0) / Number(entry.totalTraffic || 0)) * 100 : 0,
            }))
            .sort((a, b) => {
                const trafficDelta = Number(b.totalTraffic || 0) - Number(a.totalTraffic || 0);
                if (trafficDelta !== 0) return trafficDelta;
                return String(a.id || '').localeCompare(String(b.id || ''));
            });

        return {
            ...entry,
            cameraCount: Math.max(entry.cameraCount, cameras.length),
            cameras,
        };
    });
    const totalTraffic = rawEntries.reduce((sum, entry) => sum + Number(entry.totalTraffic || 0), 0);
    const entries = rawEntries
        .map((entry) => ({
            ...entry,
            share: totalTraffic > 0 ? (Number(entry.totalTraffic || 0) / totalTraffic) * 100 : 0,
        }))
        .sort((a, b) => {
            const trafficDelta = Number(b.totalTraffic || 0) - Number(a.totalTraffic || 0);
            if (trafficDelta !== 0) return trafficDelta;
            return String(a.name || '').localeCompare(String(b.name || ''));
        });

    return {
        entries,
        totalTraffic,
        totalIn: entries.reduce((sum, entry) => sum + Number(entry.totalIn || 0), 0),
        totalOut: entries.reduce((sum, entry) => sum + Number(entry.totalOut || 0), 0),
        busiestEntrance: entries[0] || null,
    };
};

const formatPercent = (value) => `${Number(value || 0).toFixed(1)}%`;

const getPeakTwoHourLabel = (events) => {
    const byWindow = new Map();

    events.forEach((evt) => {
        const ts = parseApiTimestamp(evt.timestamp);
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
    const relevantEvents = events.filter((evt) => evt.event_type === 'Dress Code Violation');
    const trafficBucket = bucket || getAdaptiveFlowBucket('custom', startMs, endMs);
    const trafficSummary = aggregateTrafficAnalytics(snapshots, {
        startMs,
        endMs,
        bucket: trafficBucket,
    });
    const violationBucketMap = new Map();
    const violationBreakdownMap = new Map([
        ['Slippers', 0],
        ['Shorts', 0],
        ['Others', 0],
    ]);
    const violatorKeys = new Set();

    relevantEvents.forEach((evt) => {
        const ts = parseApiTimestamp(evt.timestamp);
        if (!ts) return;
        const tsMs = ts.getTime();
        const bucketStartMs = getBucketStartMs(tsMs, trafficBucket);
        const subtype = normalizeDressCodeSubtype(evt.details?.label);
        const violationKey = evt.details?.track_id != null
            ? `${evt.camera_id || 'unknown'}:${evt.details.track_id}`
            : `${evt.camera_id || 'unknown'}:${evt.id}`;

        violatorKeys.add(violationKey);
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

    const trafficByBucket = new Map(trafficSummary.series.map((point) => [point.tsMs, point]));
    const mergedRateSeries = Array.from(new Set([
        ...trafficSummary.series.map((point) => point.tsMs),
        ...violationBucketMap.keys(),
    ]))
        .sort((a, b) => a - b)
        .map((tsMs) => {
            const trafficPoint = trafficByBucket.get(tsMs);
            const violationPoint = violationBucketMap.get(tsMs);
            const trafficCount = Number(trafficPoint?.totalFootTraffic ?? 0);
            const violations = Number(violationPoint?.violations ?? 0);
            return {
                tsMs,
                label: formatFlowBucketTick(tsMs, trafficBucket),
                fullLabel: formatFlowBucketRange(tsMs, trafficBucket),
                violations,
                totalFootTraffic: trafficCount,
                violationRate: trafficCount > 0 ? (violations / trafficCount) * 100 : 0,
            };
        });

    const totalViolations = relevantEvents.length;
    const totalTrafficBase = Number(trafficSummary.totalFootTraffic || 0);
    const violationRate = totalTrafficBase > 0 ? (totalViolations / totalTrafficBase) * 100 : 0;
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

    return {
        totalViolations,
        uniqueViolators: violatorKeys.size,
        violationRate,
        peakViolationTimeLabel: peakViolationPoint?.fullLabel || '-',
        peakConversionLabel: peakRatePoint?.fullLabel || '-',
        breakdown,
        rateSeries: mergedRateSeries,
        trafficSummary,
    };
};

const aggregateFallDetectionAnalytics = (events) => {
    const fallEvents = events
        .filter((evt) => evt.event_type === 'Fall Detected')
        .sort((a, b) => getTimestampMs(b.timestamp) - getTimestampMs(a.timestamp));

    const affectedCameraIds = new Set(
        fallEvents
            .map((evt) => evt.camera_id)
            .filter(Boolean),
    );

    const latestEvent = fallEvents[0] || null;

    return {
        totalFalls: fallEvents.length,
        affectedCameraCount: affectedCameraIds.size,
        latestEventLabel: latestEvent ? formatTimestamp(latestEvent.timestamp) : '-',
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
                            <p>{formatTimestamp(record.timestamp)}</p>
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

const TrafficAnalyticsPanel = ({ snapshots, cameraLabel, startMs, endMs, isAllCameras }) => {
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

            {trafficSummary.resetCount > 0 && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700">
                    Traffic counter resets were detected in the selected report range. Foot-traffic and capture-rate trends are rebuilt from changes between saved snapshots.
                </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border border-sky-500/20 bg-sky-500/10 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <ArrowLeft className="h-4 w-4 text-sky-600" />
                        Left Traffic
                    </div>
                    <div className="mt-2 text-3xl font-bold text-sky-700">{formatNumber(trafficSummary.totalLeftTraffic)}</div>
                </div>
                <div className="rounded-xl border border-violet-500/20 bg-violet-500/10 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <ArrowRight className="h-4 w-4 text-violet-600" />
                        Right Traffic
                    </div>
                    <div className="mt-2 text-3xl font-bold text-violet-700">{formatNumber(trafficSummary.totalRightTraffic)}</div>
                </div>
                <div className="rounded-xl border border-slate-300 bg-slate-50 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Activity className="h-4 w-4 text-slate-700" />
                        Total Traffic Flow
                    </div>
                    <div className="mt-2 text-3xl font-bold text-slate-800">{formatNumber(trafficSummary.totalFootTraffic)}</div>
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
                    <div className="mt-2 text-3xl font-bold text-slate-800">{formatNumber(trafficSummary.totalFootTraffic)}</div>
                </div>
                <div className="rounded-xl border border-green-500/20 bg-green-500/10 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <ArrowDownToLine className="h-4 w-4 text-green-600" />
                        Total Entries
                    </div>
                    <div className="mt-2 text-3xl font-bold text-green-600">{formatNumber(trafficSummary.totalEntries)}</div>
                </div>
                <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/10 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Target className="h-4 w-4 text-indigo-600" />
                        Capture Rate
                    </div>
                    <div className="mt-2 text-3xl font-bold text-indigo-700">{trafficSummary.captureRate.toFixed(1)}%</div>
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
                    <div className="mt-2 text-3xl font-bold text-amber-700">{formatPercent(analytics.violationRate)}</div>
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
                                <LineChart data={chartAnalytics.rateSeries} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                                    <XAxis dataKey="label" className="text-xs text-muted-foreground" tickLine={false} axisLine={false} />
                                    <YAxis className="text-xs text-muted-foreground" tickLine={false} axisLine={false} tickFormatter={(value) => `${value}%`} domain={[0, 'auto']} />
                                    <RechartsTooltip
                                        cursor={{ strokeDasharray: '3 3' }}
                                        labelFormatter={(_, payload) => payload?.[0]?.payload?.fullLabel || ''}
                                        formatter={(value, name) => [name === 'Violation Rate' ? formatPercent(value) : formatNumber(value), name]}
                                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                                    />
                                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                                    <Bar dataKey="violations" name="Violations" fill="#fca5a5" radius={[4, 4, 0, 0]} maxBarSize={26} />
                                    <Line type="monotone" dataKey="violationRate" name="Violation Rate" stroke="#dc2626" strokeWidth={2.5} dot={false} />
                                </LineChart>
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
}) => {
    const [buildingSummary, setBuildingSummary] = useState(EMPTY_BUILDING_SUMMARY);
    const [buildingHistory, setBuildingHistory] = useState([]);
    const [loading, setLoading] = useState(false);
    const [rangeNowMs, setRangeNowMs] = useState(() => Date.now());
    const [brushWindow, setBrushWindow] = useState({ key: '', startTs: null, endTs: null });
    const [expandedEntranceIds, setExpandedEntranceIds] = useState(() => new Set());
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
                    const ts = parseApiTimestamp(row.timestamp);
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

    const filteredHistory = useMemo(() => {
        if (!panelRangeBounds.valid) return [];
        return buildingHistory.filter((row) => {
            if (panelRangeBounds.startMs !== null && row.tsMs < panelRangeBounds.startMs) return false;
            if (panelRangeBounds.endMs !== null && row.tsMs > panelRangeBounds.endMs) return false;
            return true;
        });
    }, [buildingHistory, panelRangeBounds]);

    const historyRangeKey = useMemo(() => {
        if (filteredHistory.length < 2) return '24h';
        const durationMs = filteredHistory[filteredHistory.length - 1].tsMs - filteredHistory[0].tsMs;
        return durationMs <= OCCUPANCY_RANGE_LOOKBACK_MS['24h'] ? '24h' : '7d';
    }, [filteredHistory]);

    const chartData = useMemo(() => {
        const sampledRows = downsampleSeries(filteredHistory, 2000);
        return sampledRows.map((row) => ({
            time: getOccupancyTickLabel(row.ts, historyRangeKey),
            fullTime: row.ts.toLocaleString(),
            tsMs: row.tsMs,
            occupancy: row.occupancy,
            rawOccupancy: row.raw_occupancy,
        }));
    }, [filteredHistory, historyRangeKey]);

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
    const handleBrushChange = useCallback((range) => {
        if (!range || !chartData.length) return;

        const maxIndex = chartData.length - 1;
        const startIndex = clamp(Number(range.startIndex ?? 0), 0, maxIndex);
        const endIndex = clamp(Number(range.endIndex ?? maxIndex), 0, maxIndex);
        const startTs = chartData[startIndex]?.tsMs ?? null;
        const endTs = chartData[endIndex]?.tsMs ?? null;

        setBrushWindow((prev) => {
            if (prev.key === brushContextKey && prev.startTs === startTs && prev.endTs === endTs) return prev;
            return { key: brushContextKey, startTs, endTs };
        });
    }, [brushContextKey, chartData]);

    const flowSummary = useMemo(() => {
        if (!panelRangeBounds.valid) {
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

        return aggregateBuildingFlow(buildingHistory, {
            startMs: panelRangeBounds.startMs,
            endMs: panelRangeBounds.endMs,
            bucket: effectiveBucket,
        });
    }, [buildingHistory, effectiveBucket, panelRangeBounds]);

    const rangeSummary = useMemo(() => aggregateBuildingFlow(buildingHistory, {
        startMs: panelRangeBounds.valid ? panelRangeBounds.startMs : null,
        endMs: panelRangeBounds.valid ? panelRangeBounds.endMs : null,
        bucket: effectiveBucket,
    }), [buildingHistory, effectiveBucket, panelRangeBounds]);

    const entranceContribution = useMemo(() => {
        const aggregated = aggregateBuildingEntranceContribution(buildingHistory, {
            startMs: panelRangeBounds.valid ? panelRangeBounds.startMs : null,
            endMs: panelRangeBounds.valid ? panelRangeBounds.endMs : null,
        });
        if (aggregated.entries.length > 0) {
            return aggregated;
        }

        const liveEntries = Object.entries(buildingSummary.entrance_summaries ?? {})
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
    }, [buildingHistory, buildingSummary.entrance_summaries, panelRangeBounds]);
    const entranceContributionWithCameraBreakdown = useMemo(() => {
        const entries = entranceContribution.entries.map((entry) => {
            const configuredCameraIds = Array.isArray(buildingSummary.entrance_summaries?.[entry.name]?.camera_ids)
                ? buildingSummary.entrance_summaries[entry.name].camera_ids
                : [];

            if (!configuredCameraIds.length) {
                return entry;
            }

            const cameras = configuredCameraIds
                .map((cameraId) => {
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
                })
                .sort((a, b) => {
                    const trafficDelta = Number(b.totalTraffic || 0) - Number(a.totalTraffic || 0);
                    if (trafficDelta !== 0) return trafficDelta;
                    return String(a.id || '').localeCompare(String(b.id || ''));
                });

            return {
                ...entry,
                cameraCount: Math.max(entry.cameraCount, cameras.length),
                cameras: cameras.map((camera) => ({
                    ...camera,
                    share: Number(entry.totalTraffic || 0) > 0 ? (Number(camera.totalTraffic || 0) / Number(entry.totalTraffic || 0)) * 100 : 0,
                })),
            };
        });

        return {
            ...entranceContribution,
            entries,
            busiestEntrance: entries[0] || null,
        };
    }, [buildingSummary.entrance_summaries, countingSnapshots, entranceContribution, panelRangeBounds]);

    const capacityUtilization = buildingSummary.max_capacity
        ? (Number(buildingSummary.occupancy ?? 0) / Number(buildingSummary.max_capacity)) * 100
        : null;
    const capacityUtilizationLabel = capacityUtilization == null
        ? 'Capacity not configured'
        : `${Math.round(capacityUtilization)}% Capacity Utilization`;
    const peakOccupancyValue = Math.max(
        Number(buildingSummary.occupancy ?? 0),
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
        const totalTraffic = Number(entranceContributionWithCameraBreakdown.totalTraffic || 0);
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
                                Building View
                            </CardTitle>
                            <p className="mt-1 text-sm text-muted-foreground">
                                Building-wide occupancy, throughput, and entrance contribution from persisted counting snapshots.
                            </p>
                        </div>
                        <div className="text-xs text-muted-foreground">
                            Uses the global report range and building-only grouping control above.
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span>Building counting: {buildingSummary.enabled ? 'Enabled' : 'Disabled'}</span>
                        <span>Active cameras: {buildingSummary.active_camera_count ?? 0}</span>
                        <span>Raw occupancy: {buildingSummary.raw_occupancy ?? 0}</span>
                        <span>Manual offset: {buildingSummary.manual_offset ?? 0}</span>
                    </div>

                    {buildingSummary.capacity_exceeded && (
                        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600">
                            Building capacity exceeded.
                        </div>
                    )}
                </CardHeader>
                <CardContent>
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                        <div className={cn(
                            'rounded-xl border p-4',
                            buildingSummary.capacity_exceeded ? 'border-red-500/30 bg-red-500/10' : 'border-primary/20 bg-primary/10',
                        )}>
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Users className={cn('h-4 w-4', buildingSummary.capacity_exceeded ? 'text-red-600' : 'text-primary')} />
                                Current Occupancy
                            </div>
                            <div className={cn('mt-2 text-3xl font-bold', buildingSummary.capacity_exceeded ? 'text-red-600' : 'text-primary')}>
                                {formatNumber(buildingSummary.occupancy)}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">{capacityUtilizationLabel}</div>
                        </div>

                        <div className="rounded-xl border border-green-500/20 bg-green-500/10 p-4">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <ArrowDownToLine className="h-4 w-4 text-green-600" />
                                Range IN
                            </div>
                            <div className="mt-2 text-3xl font-bold text-green-600">{formatNumber(rangeSummary.totalIn)}</div>
                            <div className="mt-1 text-xs text-muted-foreground">Within selected report range</div>
                        </div>

                        <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <ArrowUpFromLine className="h-4 w-4 text-red-600" />
                                Range OUT
                            </div>
                            <div className="mt-2 text-3xl font-bold text-red-600">{formatNumber(rangeSummary.totalOut)}</div>
                            <div className="mt-1 text-xs text-muted-foreground">Within selected report range</div>
                        </div>

                        <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-4">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <TrendingUp className="h-4 w-4 text-blue-600" />
                                Peak Occupancy
                            </div>
                            <div className="mt-2 text-3xl font-bold text-blue-700">{formatNumber(peakOccupancyValue)}</div>
                            <div className="mt-1 text-xs text-muted-foreground">{flowSummary.peakPeriodLabel}</div>
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
                            Building-level flow trend with adaptive {effectiveBucket === '15m' ? '15-minute' : effectiveBucket === '1h' ? 'hourly' : 'daily'} buckets.
                        </p>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        This matches the people-counting camera report pattern, but uses the merged building snapshot history.
                    </p>
                    {flowSummary.resetCount > 0 && (
                        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700">
                            {flowSummary.resetCount} building counter reset{flowSummary.resetCount !== 1 ? 's were' : ' was'} detected in this trend range. Flow totals are derived from deltas, while occupancy should be treated as an estimate.
                        </div>
                    )}
                </CardHeader>
                <CardContent className="flex-1">
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                        <div className="rounded-xl border border-green-500/20 bg-green-500/10 p-4">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <ArrowDownToLine className="h-4 w-4 text-green-600" />
                                Range IN
                            </div>
                            <div className="mt-2 text-3xl font-bold text-green-600">{formatNumber(flowSummary.totalIn)}</div>
                        </div>
                        <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <ArrowUpFromLine className="h-4 w-4 text-red-600" />
                                Range OUT
                            </div>
                            <div className="mt-2 text-3xl font-bold text-red-600">{formatNumber(flowSummary.totalOut)}</div>
                        </div>
                        <div className="rounded-xl border border-slate-300 bg-slate-50 p-4">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Activity className="h-4 w-4 text-slate-700" />
                                Total Traffic
                            </div>
                            <div className="mt-2 text-3xl font-bold text-slate-800">{formatNumber(flowSummary.totalTraffic)}</div>
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
                        Entrance-level contribution share of total building traffic for the selected range.
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
                                <td className="px-4 py-3">{formatTimestamp(row.timestamp)}</td>
                                <td className="px-4 py-3">
                                    <span className="inline-flex items-center gap-2 rounded-full border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-700">
                                        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                                        Capacity Exceeded
                                    </span>
                                </td>
                                <td className="px-4 py-3 text-muted-foreground">
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

const AllOverviewPanel = ({ events, snapshots, startMs, endMs, cameraOptions, cameraFilter }) => {
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

    const dressCodeSummary = useMemo(() => aggregateDressCodeAnalytics(events, snapshots, {
        startMs,
        endMs,
        bucket: summaryBucket,
    }), [endMs, events, snapshots, startMs, summaryBucket]);

    const fallSummary = useMemo(() => aggregateFallDetectionAnalytics(
        events.filter((evt) => {
            const tsMs = getTimestampMs(evt.timestamp);
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
                    <div className="mt-2 text-3xl font-bold text-primary">{formatNumber(peopleSummary.estimatedOccupancy)}</div>
                </div>
                <div className="rounded-xl border border-green-500/20 bg-green-500/10 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <TrendingUp className="h-4 w-4 text-green-600" />
                        Total Traffic
                    </div>
                    <div className="mt-2 text-3xl font-bold text-green-600">{formatNumber(peopleSummary.totalTraffic)}</div>
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
                        <div className="mt-2 text-3xl font-bold text-primary">{formatPercent(trafficSummary.captureRate)}</div>
                    </div>
                    <div className="rounded-xl border border-green-500/20 bg-green-500/10 p-4">
                        <div className="text-sm text-muted-foreground">Total In</div>
                        <div className="mt-2 text-3xl font-bold text-green-600">{formatNumber(peopleSummary.totalIn)}</div>
                    </div>
                    <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4">
                        <div className="text-sm text-muted-foreground">Total Out</div>
                        <div className="mt-2 text-3xl font-bold text-red-600">{formatNumber(peopleSummary.totalOut)}</div>
                    </div>
                    <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-4">
                        <div className="text-sm text-muted-foreground">Peak Occupancy</div>
                        <div className="mt-2 text-3xl font-bold text-blue-700">{formatNumber(peopleSummary.peakOccupancy)}</div>
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
                        <div className="mt-2 text-3xl font-bold text-amber-700">{formatPercent(dressCodeSummary.violationRate)}</div>
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
    const [refreshToken, setRefreshToken] = useState(0);
    const effectiveDateRange = useMemo(
        () => getQuickRangeDateBounds(selectedQuickRange, startDate, endDate),
        [selectedQuickRange, startDate, endDate],
    );
    const effectiveStartDate = effectiveDateRange.startDate;
    const effectiveEndDate = effectiveDateRange.endDate;
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
            const params = new URLSearchParams();
            appendQueryParam(params, 'limit', 200);
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
            const data = await res.json();
            setEvents(data);
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
            allSnapshots.sort((a, b) => getTimestampMs(b.timestamp) - getTimestampMs(a.timestamp));
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
    const cameraOptions = useMemo(() => {
        const options = new Map();

        cameras.forEach((cam) => {
            options.set(cam.id, cam.name || cam.id);
        });

        events.forEach((evt) => {
            if (!evt?.camera_id) return;
            if (!options.has(evt.camera_id)) {
                options.set(evt.camera_id, evt.camera_name || evt.camera_id);
            }
        });

        countingSnapshots.forEach((snapshot) => {
            if (!snapshot?.camera_id) return;
            if (!options.has(snapshot.camera_id)) {
                options.set(snapshot.camera_id, snapshot.camera_name || snapshot.camera_id);
            }
        });

        return Array.from(options.entries())
            .map(([id, name]) => ({ id, name }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [cameras, events, countingSnapshots]);
    // Date filter helper
    const dateFilter = (timestamp) => {
        const tsMs = getTimestampMs(timestamp);
        if (!tsMs) return false;
        if (reportingDateBounds.startMs !== null && tsMs < reportingDateBounds.startMs) return false;
        if (reportingDateBounds.endMs !== null && tsMs > reportingDateBounds.endMs) return false;
        return true;
    };
    const cameraFilter = (cameraId) => selectedCameraFilter === 'all' || cameraId === selectedCameraFilter;

    // Filtered events
    const filteredEvents = events
        .map(evt => ({ ...evt, camera_name: cameraNameById[evt.camera_id] || evt.camera_name }))
        .filter(evt => dateFilter(evt.timestamp) && cameraFilter(evt.camera_id));
    const filteredBuildingAlerts = filteredEvents
        .filter((evt) => evt.event_type === 'Capacity Exceeded' && evt.details?.scope === 'building')
        .sort((a, b) => getTimestampMs(b.timestamp) - getTimestampMs(a.timestamp));

    // Filtered counting snapshots
    const filteredSnapshots = countingSnapshots
        .map(s => ({ ...s, camera_name: s.camera_name || cameraNameById[s.camera_id] || s.camera_id }))
        .filter(s => dateFilter(s.timestamp) && cameraFilter(s.camera_id));
    const isOverviewCategory = selectedCategory === 'All';
    const isPeopleCountingCategory = selectedCategory === 'People Counting';
    const isDressCodeCategory = selectedCategory === 'Dress Code';
    const isPeopleCountingBuildingView = isPeopleCountingCategory && selectedPeopleCountingView === 'building';
    const isPeopleCountingCameraView = isPeopleCountingCategory && selectedPeopleCountingView === 'camera';
    const isPeopleCountingTrafficView = isPeopleCountingCategory && selectedPeopleCountingView === 'traffic';
    const selectedCountingSnapshots = countingSnapshots
        .map(s => ({ ...s, camera_name: s.camera_name || cameraNameById[s.camera_id] || s.camera_id }))
        .filter(s => cameraFilter(s.camera_id));
    const selectedCameraMeta = selectedCameraFilter === 'all'
        ? null
        : cameraOptions.find((cam) => cam.id === selectedCameraFilter);
    const selectedCameraLabel = selectedCameraMeta?.name
        || (selectedCameraFilter === 'all'
            ? `Selected cameras${cameraOptions.length ? ` (${cameraOptions.length})` : ''}`
            : selectedCameraFilter);
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
    const dailyFlowSeries = useMemo(() => (
        aggregateCountingFlow(selectedCountingSnapshots, {
            startMs: reportingDateBounds.startMs,
            endMs: reportingDateBounds.endMs,
            bucket: '1d',
        }).series.slice(-14)
    ), [reportingDateBounds.endMs, reportingDateBounds.startMs, selectedCountingSnapshots]);

    // Build combined display rows for log table
    const displayRows = (() => {
        if (isPeopleCountingCategory) {
            // Show counting snapshots as log entries (plus any capacity alerts)
            const snapshotRows = filteredSnapshots.map(s => ({
                id: s.id,
                timestamp: s.timestamp,
                event_type: 'Counting Snapshot',
                camera_id: s.camera_id,
                camera_name: s.camera_name,
                total_in: s.total_in,
                total_out: s.total_out,
                current_occupancy: s.current_occupancy,
                _isSnapshot: true,
            }));
            const eventRows = filteredEvents.map(e => ({ ...e, _isSnapshot: false }));
            // Merge and sort by timestamp desc
            return [...eventRows, ...snapshotRows].sort((a, b) => getTimestampMs(b.timestamp) - getTimestampMs(a.timestamp));
        }
        if (selectedCategory === 'All') {
            return filteredEvents.map(e => ({ ...e, _isSnapshot: false }));
        }
        // Detection-only categories
        return filteredEvents.map(e => ({ ...e, _isSnapshot: false }));
    })();

    // Build chart data
    const chartData = (() => {
        if (selectedCategory === 'People Counting') {
            return dailyFlowSeries.map((point) => ({
                name: point.label,
                totalIn: point.in,
                totalOut: point.out,
            }));
        }
        // Detection events aggregated by day
        const byDay = {};
        filteredEvents.forEach(evt => {
            const parsed = parseApiTimestamp(evt.timestamp);
            if (!parsed) return;
            const day = parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            if (!byDay[day]) byDay[day] = { name: day, violations: 0 };
            byDay[day].violations++;
        });
        return Object.values(byDay).slice(-7);
    })();

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
    }, [selectedCategory, selectedPeopleCountingView, selectedCameraFilter, selectedQuickRange, startDate, endDate]);

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
                csv = 'Timestamp,Camera Name,Camera ID,Total In,Total Out,Occupancy\n';
                csv += filteredSnapshots.map(s => [
                    toCsvCell(s.timestamp),
                    toCsvCell(getCameraLabel(s)),
                    toCsvCell(s.camera_id),
                    toCsvCell(s.total_in),
                    toCsvCell(s.total_out),
                    toCsvCell(s.current_occupancy),
                ].join(',')).join('\n');
            } else {
                csv = 'ID,Timestamp,Event Type,Camera Name,Camera ID,Label,Confidence\n';
                csv += filteredEvents.map(e => [
                    toCsvCell(e.id),
                    toCsvCell(e.timestamp),
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
            alert('PDF export not implemented yet.');
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
                                ? "xl:grid-cols-[minmax(180px,0.8fr)_minmax(180px,1fr)_minmax(180px,1fr)_minmax(140px,0.6fr)_auto_auto]"
                                : "xl:grid-cols-[minmax(180px,0.8fr)_minmax(180px,1fr)_minmax(180px,1fr)_minmax(140px,0.6fr)_auto]")
                            : (isCustomQuickRange
                                ? "xl:grid-cols-[minmax(180px,0.8fr)_minmax(180px,1fr)_minmax(180px,1fr)_minmax(220px,1fr)_auto_auto]"
                                : "xl:grid-cols-[minmax(180px,0.8fr)_minmax(180px,1fr)_minmax(180px,1fr)_minmax(220px,1fr)_auto]"),
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
                        ) : (
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
                    countingSnapshots={filteredSnapshots}
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
                                        <div className="mt-2 text-3xl font-bold text-green-600">{formatNumber(peopleCountingSummary.totalIn)}</div>
                                    </div>
                                    <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4">
                                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                            <ArrowUpFromLine className="h-4 w-4 text-red-600" />
                                            Total Out
                                        </div>
                                        <div className="mt-2 text-3xl font-bold text-red-600">{formatNumber(peopleCountingSummary.totalOut)}</div>
                                    </div>
                                    <div className="rounded-xl border border-slate-300 bg-slate-50 p-4">
                                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                            <Activity className="h-4 w-4 text-slate-700" />
                                            Total Traffic
                                        </div>
                                        <div className="mt-2 text-3xl font-bold text-slate-800">{formatNumber(peopleCountingSummary.totalTraffic)}</div>
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
                                        <div className="mt-2 text-3xl font-bold text-blue-700">{formatNumber(peopleCountingSummary.peakOccupancy)}</div>
                                    </div>
                                    <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/10 p-4">
                                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                            <TrendingUp className="h-4 w-4 text-indigo-600" />
                                            Current Occupancy
                                        </div>
                                        <div className="mt-2 text-3xl font-bold text-indigo-700">{formatNumber(peopleCountingSummary.estimatedOccupancy)}</div>
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
                        <table className="w-full min-w-[980px] text-sm text-left">
                            <thead className="text-muted-foreground bg-muted/50 sticky top-0">
                                <tr>
                                    <th className="px-4 py-3 font-medium">Timestamp</th>
                                    <th className="px-4 py-3 font-medium">Camera</th>
                                    <th className="px-4 py-3 font-medium">Event Type</th>
                                    <th className="px-4 py-3 font-medium">Subtype</th>
                                    <th className="px-4 py-3 font-medium text-right">In</th>
                                    <th className="px-4 py-3 font-medium text-right">Out</th>
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
                                                <td className="px-4 py-3">{formatTimestamp(row.timestamp)}</td>
                                                <td className="px-4 py-3">
                                                    <span className={cn(
                                                        "inline-flex items-center gap-2 rounded-full border px-2 py-1 text-xs font-medium",
                                                        getCameraBadgeStyle(row.camera_id).badge,
                                                    )}>
                                                        <span className={cn("h-1.5 w-1.5 rounded-full", getCameraBadgeStyle(row.camera_id).dot)} />
                                                        {getCameraLabel(row)}
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
                                        : (isCapacity ? 'Capacity alert' : '-');
                                    return (
                                        <tr key={row.id} className="hover:bg-muted/30 transition-colors group cursor-pointer"
                                            onClick={() => setSelectedRecord(row)}>
                                            <td className="px-4 py-3">{formatTimestamp(row.timestamp)}</td>
                                            <td className="px-4 py-3">
                                                <span className={cn(
                                                    "inline-flex items-center gap-2 rounded-full border px-2 py-1 text-xs font-medium",
                                                    getCameraBadgeStyle(row.camera_id).badge,
                                                )}>
                                                    <span className={cn("h-1.5 w-1.5 rounded-full", getCameraBadgeStyle(row.camera_id).dot)} />
                                                    {getCameraLabel(row)}
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
                                        <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
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
