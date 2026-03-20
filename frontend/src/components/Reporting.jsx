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

const formatNumber = (value) => new Intl.NumberFormat('en-US').format(Number(value || 0));

const createDefaultCustomRange = () => {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));
    return {
        start: formatDateTimeLocal(oneDayAgo),
        end: formatDateTimeLocal(now),
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
    end.setHours(0, 0, 0, 0);

    const start = new Date(end);
    if (quickRange === 'today') {
        return {
            startDate: formatDateOnlyLocal(start),
            endDate: formatDateOnlyLocal(end),
        };
    }
    if (quickRange === '7d') {
        start.setDate(start.getDate() - 6);
    } else if (quickRange === '30d') {
        start.setDate(start.getDate() - 29);
    }

    return {
        startDate: formatDateOnlyLocal(start),
        endDate: formatDateOnlyLocal(end),
    };
};

const getDateRangeBounds = (startDate, endDate) => {
    const startMs = startDate ? new Date(`${startDate}T00:00:00`).getTime() : null;
    const endMs = endDate ? new Date(`${endDate}T23:59:59.999`).getTime() : null;
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
        <Card className="flex flex-col min-h-[420px]">
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
                        {flowSummary.resetCount} counter reset{flowSummary.resetCount !== 1 ? 's were' : ' was'} detected in this trend range. Flow totals are derived from deltas, while occupancy should be treated as an estimate.
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
            <div className="space-y-1">
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
                    Traffic counter resets were detected in the selected report range. Foot-traffic and capture-rate trends are reconstructed from snapshot deltas.
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
                <Card className="flex flex-col min-h-[360px]">
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

                <Card className="flex flex-col min-h-[360px]">
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
                <Card className="flex flex-col min-h-[360px]">
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

                <Card className="flex flex-col min-h-[360px]">
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

            <Card className="flex flex-col min-h-[360px]">
                <CardHeader>
                    <CardTitle>Capture Rate by Day</CardTitle>
                </CardHeader>
                <CardContent className="flex-1 min-h-[260px]">
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
                </CardContent>
            </Card>
        </div>
    );
};

const BuildingOccupancyPanel = ({ apiUrl, startDate, endDate, refreshToken, visible }) => {
    const [buildingSummary, setBuildingSummary] = useState(EMPTY_BUILDING_SUMMARY);
    const [buildingHistory, setBuildingHistory] = useState([]);
    const [loading, setLoading] = useState(false);
    const [timeRange, setTimeRange] = useState('24h');
    const [customStart, setCustomStart] = useState(() => createDefaultCustomRange().start);
    const [customEnd, setCustomEnd] = useState(() => createDefaultCustomRange().end);
    const [rangeNowMs, setRangeNowMs] = useState(() => Date.now());
    const [brushWindow, setBrushWindow] = useState({ key: '', startTs: null, endTs: null });

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
        setLoading(true);
        try {
            const rows = [];
            let offset = 0;
            while (offset < MAX_BUILDING_HISTORY_ROWS) {
                const res = await fetch(
                    `${apiUrl}/api/building-counting-history?limit=${BUILDING_HISTORY_PAGE_SIZE}&offset=${offset}`,
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
    }, [apiUrl, visible]);

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
        const interval = setInterval(fetchBuildingHistory, 15000);
        return () => {
            clearTimeout(timeoutId);
            clearInterval(interval);
        };
    }, [fetchBuildingHistory, visible, refreshToken]);

    useEffect(() => {
        if (!visible) return undefined;
        const intervalId = setInterval(() => {
            setRangeNowMs(Date.now());
        }, 60000);
        return () => clearInterval(intervalId);
    }, [visible]);

    const filteredHistory = useMemo(() => {
        let rangeStartMs = null;
        let rangeEndMs = rangeNowMs;

        if (timeRange === 'custom') {
            const customStartMs = new Date(customStart).getTime();
            const customEndMs = new Date(customEnd).getTime();
            if (Number.isNaN(customStartMs) || Number.isNaN(customEndMs) || customStartMs > customEndMs) {
                return [];
            }
            rangeStartMs = customStartMs;
            rangeEndMs = customEndMs;
        } else if (timeRange !== 'all') {
            rangeStartMs = rangeNowMs - OCCUPANCY_RANGE_LOOKBACK_MS[timeRange];
        }

        return buildingHistory.filter((row) => {
            const dayIso = getTimestampIsoDate(row.timestamp);
            if (!dayIso) return false;
            if (startDate && dayIso < startDate) return false;
            if (endDate && dayIso > endDate) return false;
            if (rangeStartMs !== null && row.tsMs < rangeStartMs) return false;
            if (rangeEndMs !== null && row.tsMs > rangeEndMs) return false;
            return true;
        });
    }, [buildingHistory, startDate, endDate, timeRange, customStart, customEnd, rangeNowMs]);

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
    const brushContextKey = `${timeRange}|${customStart}|${customEnd}|${startDate}|${endDate}`;
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

    const entranceEntries = useMemo(
        () => Object.entries(buildingSummary.entrance_summaries ?? {}),
        [buildingSummary.entrance_summaries],
    );

    if (!visible) return null;

    return (
        <Card className="flex flex-col min-h-[420px]">
            <CardHeader className="space-y-3">
                <CardTitle className="flex items-center gap-2">
                    <Building2 className="w-4 h-4" />
                    Building Occupancy
                </CardTitle>
                <div className="text-sm text-muted-foreground">
                    Live building occupancy is shown from the current runtime summary. The chart below uses persisted building snapshots.
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                    <div className={cn("rounded-lg border p-4", buildingSummary.capacity_exceeded ? 'border-red-500/30 bg-red-500/10' : 'border-primary/20 bg-primary/10')}>
                        <div className="text-xs text-muted-foreground">Current Occupancy</div>
                        <div className={cn("mt-1 text-2xl font-bold", buildingSummary.capacity_exceeded ? 'text-red-600' : 'text-primary')}>{buildingSummary.occupancy ?? 0}</div>
                    </div>
                    <div className="rounded-lg border border-green-500/20 bg-green-500/10 p-4">
                        <div className="text-xs text-muted-foreground">Building In</div>
                        <div className="mt-1 text-2xl font-bold text-green-600">{buildingSummary.raw_in ?? 0}</div>
                    </div>
                    <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4">
                        <div className="text-xs text-muted-foreground">Building Out</div>
                        <div className="mt-1 text-2xl font-bold text-red-600">{buildingSummary.raw_out ?? 0}</div>
                    </div>
                    <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-4">
                        <div className="text-xs text-muted-foreground">Manual Offset</div>
                        <div className="mt-1 text-2xl font-bold text-amber-600">{buildingSummary.manual_offset ?? 0}</div>
                    </div>
                    <div className="rounded-lg border border-slate-300 bg-slate-50 p-4">
                        <div className="text-xs text-muted-foreground">Building Max Capacity</div>
                        <div className="mt-1 text-2xl font-bold text-slate-700">{buildingSummary.max_capacity ?? '-'}</div>
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>Building counting: {buildingSummary.enabled ? 'Enabled' : 'Disabled'}</span>
                    <span>Active cameras: {buildingSummary.active_camera_count ?? 0}</span>
                    <span>Raw occupancy: {buildingSummary.raw_occupancy ?? 0}</span>
                </div>
                {buildingSummary.capacity_exceeded && (
                    <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600">
                        Building capacity exceeded.
                    </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                    <select
                        value={timeRange}
                        onChange={(e) => setTimeRange(e.target.value)}
                        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                    >
                        <option value="1h">Last 1 hour</option>
                        <option value="6h">Last 6 hours</option>
                        <option value="24h">Last 24 hours</option>
                        <option value="7d">Last 7 days</option>
                        <option value="30d">Last 30 days</option>
                        <option value="all">All time</option>
                        <option value="custom">Custom range</option>
                    </select>
                    {timeRange === 'custom' && (
                        <>
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
                        </>
                    )}
                </div>

                <div className="h-[260px]">
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
                            {loading ? 'Loading building history...' : 'No building occupancy history available for the selected date range'}
                        </div>
                    )}
                </div>

                {entranceEntries.length > 0 && (
                    <div className="space-y-2">
                        <div className="text-sm font-medium">Entrance Breakdown</div>
                        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                            {entranceEntries.map(([entranceId, entrance]) => (
                                <div key={entranceId} className="rounded-lg border bg-muted/20 p-3">
                                    <div className="font-medium">{entranceId}</div>
                                    <div className="mt-1 text-xs text-muted-foreground">Cameras: {(entrance.camera_ids || []).length}</div>
                                    <div className="mt-2 flex items-center gap-3 text-xs">
                                        <span className="text-green-600">IN: {entrance.total_in ?? 0}</span>
                                        <span className="text-red-600">OUT: {entrance.total_out ?? 0}</span>
                                        <span className="text-primary">NOW: {entrance.occupancy ?? 0}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
};

const BuildingAlertsPanel = ({ rows, onSelectRecord, loading, visible }) => {
    if (!visible) return null;

    return (
        <Card className="flex flex-col min-h-[320px] overflow-hidden">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-red-500" />
                    Recent Building Alerts
                </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 p-0 overflow-auto">
                <table className="w-full text-sm text-left">
                    <thead className="text-muted-foreground bg-muted/50 sticky top-0">
                        <tr>
                            <th className="px-4 py-3 font-medium">Timestamp</th>
                            <th className="px-4 py-3 font-medium">Scope</th>
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
                                        Building
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
    const [selectedQuickRange, setSelectedQuickRange] = useState('7d');
    const [startDate, setStartDate] = useState(() => formatDateOnlyLocal(new Date(Date.now() - (6 * 24 * 60 * 60 * 1000))));
    const [endDate, setEndDate] = useState(() => formatDateOnlyLocal(new Date()));
    const [selectedRecord, setSelectedRecord] = useState(null);
    const [showExportModal, setShowExportModal] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    const [rowsPerPage, setRowsPerPage] = useState(20);
    const [refreshToken, setRefreshToken] = useState(0);

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
            let url = `${apiUrl}/api/detection-events?limit=200`;
            if (selectedCategory === 'Dress Code') {
                url += '&event_type=Dress Code Violation';
            } else if (selectedCategory === 'Fall Detection') {
                url += '&event_type=Fall Detected';
            } else if (selectedCategory === 'People Counting') {
                url += '&event_type=Capacity Exceeded';
            }
            const res = await fetch(url);
            const data = await res.json();
            setEvents(data);
        } catch (err) {
            console.error("Failed to fetch events:", err);
        } finally {
            setLoading(false);
        }
    }, [apiUrl, selectedCategory]);

    // Fetch counting snapshots when People Counting category is selected
    const fetchCountingSnapshots = useCallback(async () => {
        if (selectedCategory !== 'People Counting' && selectedCategory !== 'All') {
            setCountingSnapshots([]);
            return;
        }
        try {
            const allSnapshots = [];
            let offset = 0;

            while (offset < MAX_COUNTING_HISTORY_ROWS) {
                const res = await fetch(
                    `${apiUrl}/api/people-counting-history?limit=${SNAPSHOT_PAGE_SIZE}&offset=${offset}`,
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
    }, [apiUrl, selectedCategory]);

    useEffect(() => {
        fetchEvents();
        const interval = setInterval(fetchEvents, 10000);
        return () => clearInterval(interval);
    }, [fetchEvents]);

    useEffect(() => {
        fetchCountingSnapshots();
        const interval = setInterval(fetchCountingSnapshots, 15000);
        return () => clearInterval(interval);
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
    const effectiveDateRange = useMemo(
        () => getQuickRangeDateBounds(selectedQuickRange, startDate, endDate),
        [selectedQuickRange, startDate, endDate],
    );
    const effectiveStartDate = effectiveDateRange.startDate;
    const effectiveEndDate = effectiveDateRange.endDate;
    const isCustomQuickRange = selectedQuickRange === 'custom';

    // Date filter helper
    const dateFilter = (timestamp) => {
        const dayIso = getTimestampIsoDate(timestamp);
        if (!dayIso) return false;
        if (effectiveStartDate) {
            if (dayIso < effectiveStartDate) return false;
        }
        if (effectiveEndDate) {
            if (dayIso > effectiveEndDate) return false;
        }
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
    const isPeopleCountingCategory = selectedCategory === 'People Counting';
    const isPeopleCountingBuildingView = isPeopleCountingCategory && selectedPeopleCountingView === 'building';
    const isPeopleCountingCameraView = isPeopleCountingCategory && selectedPeopleCountingView === 'camera';
    const isPeopleCountingTrafficView = isPeopleCountingCategory && selectedPeopleCountingView === 'traffic';
    const selectedCountingSnapshots = countingSnapshots
        .map(s => ({ ...s, camera_name: s.camera_name || cameraNameById[s.camera_id] || s.camera_id }))
        .filter(s => cameraFilter(s.camera_id));
    const reportingDateBounds = getDateRangeBounds(effectiveStartDate, effectiveEndDate);
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
            return [...eventRows, ...snapshotRows].sort((a, b) => getTimestampMs(b.timestamp) - getTimestampMs(a.timestamp));
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
    const showStandardReportSections = !isPeopleCountingBuildingView && !isPeopleCountingTrafficView;
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

    // Handlers
    const handleCategoryChange = (cat) => setSelectedCategory(cat);

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
        <div className="flex flex-col h-full bg-background p-6 gap-6 overflow-hidden">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 shrink-0">
                <h1 className="text-3xl font-bold tracking-tight">Reporting Dashboard</h1>
                <div className="flex items-center gap-2">
                    <Button variant="outline" onClick={() => { fetchEvents(); fetchCountingSnapshots(); setRefreshToken((value) => value + 1); }} disabled={loading} className="gap-2">
                        <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} /> Refresh
                    </Button>
                    <Button onClick={() => setShowExportModal(true)} className="gap-2" disabled={isPeopleCountingBuildingView}>
                        <Download className="w-4 h-4" /> Export Report
                    </Button>
                </div>
            </div>

            {/* Filter Bar */}
            <Card className="shrink-0">
                <CardContent className="space-y-4 p-4">
                    <div className={cn(
                        "grid gap-4",
                        isPeopleCountingCategory
                            ? "xl:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)]"
                            : "xl:grid-cols-1",
                    )}>
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Report Category</label>
                            <div className="flex bg-muted rounded-md p-1 h-10 items-center">
                                {['All', 'Dress Code', 'Fall Detection', 'People Counting'].map(cat => (
                                    <button key={cat} onClick={() => handleCategoryChange(cat)}
                                        className={cn("px-3 py-1.5 text-sm font-medium rounded-sm transition-all flex-1 whitespace-nowrap",
                                            selectedCategory === cat ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground")}>
                                        {cat}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {isPeopleCountingCategory && (
                            <div className="space-y-2">
                                <label className="text-sm font-medium">People Counting View</label>
                                <div className="flex bg-muted rounded-md p-1 h-10 items-center">
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
                                                    ? "bg-background shadow-sm text-foreground"
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
                            ? "xl:grid-cols-[minmax(180px,0.8fr)_minmax(180px,1fr)_minmax(180px,1fr)_auto]"
                            : "xl:grid-cols-[minmax(180px,0.8fr)_minmax(180px,1fr)_minmax(180px,1fr)_minmax(220px,1fr)_auto]",
                    )}>
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Quick Range</label>
                            <select
                                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                            <label className="text-sm font-medium">Start Date</label>
                            <div className="relative">
                                <Calendar className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                <input
                                    type="date"
                                    disabled={!isCustomQuickRange}
                                    className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 pl-9 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-muted/30"
                                    value={startDate}
                                    onChange={(e) => setStartDate(e.target.value)}
                                />
                            </div>
                        </div>

                        <div className={cn("space-y-2 transition-opacity", !isCustomQuickRange && "opacity-50")}>
                            <label className="text-sm font-medium">End Date</label>
                            <div className="relative">
                                <Calendar className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                <input
                                    type="date"
                                    disabled={!isCustomQuickRange}
                                    className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 pl-9 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-muted/30"
                                    value={endDate}
                                    onChange={(e) => setEndDate(e.target.value)}
                                />
                            </div>
                        </div>

                        {!isPeopleCountingBuildingView && (
                            <div className="space-y-2">
                                <label className="text-sm font-medium">Camera</label>
                                <select
                                    className="h-10 w-full min-w-[220px] rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

                        <div className="text-sm text-muted-foreground xl:justify-self-end xl:self-end pb-2">
                            {isPeopleCountingBuildingView
                                ? 'Building-level occupancy view'
                                : `${totalDisplayRows} record${totalDisplayRows !== 1 ? 's' : ''} found`}
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Charts & Log */}
            <div className="flex-1 overflow-y-auto grid grid-cols-1 gap-6 min-h-0">
                <BuildingOccupancyPanel
                    apiUrl={apiUrl}
                    startDate={effectiveStartDate}
                    endDate={effectiveEndDate}
                    refreshToken={refreshToken}
                    visible={selectedCategory === 'All' || isPeopleCountingBuildingView}
                />

                <BuildingAlertsPanel
                    rows={filteredBuildingAlerts}
                    onSelectRecord={setSelectedRecord}
                    loading={loading}
                    visible={isPeopleCountingBuildingView}
                />

                {!isPeopleCountingBuildingView && (
                    <>
                        {isPeopleCountingCameraView && (
                            <>
                                <div className="space-y-1">
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
                                            Estimated Occupancy
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
                <Card className="flex flex-col min-h-[350px]">
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

                <div className="space-y-1">
                    <h2 className="text-lg font-semibold tracking-tight">Diagnostics</h2>
                    <p className="text-sm text-muted-foreground">
                        Raw counting records and operational details for validation and troubleshooting.
                    </p>
                </div>

                {isPeopleCountingCameraView && peopleCountingSummary.resetCount > 0 && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700">
                        Counter resets were detected in the selected report range. Flow totals remain usable, but occupancy-related numbers may not be continuous across the full period.
                    </div>
                )}

                {/* Log Table */}
                <Card className="flex flex-col min-h-[350px] overflow-hidden">
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
                                    <th className="px-4 py-3 font-medium">Direction</th>
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
                                    const eventDirection = row.details?.direction
                                        ? String(row.details.direction).replace(/_/g, ' ')
                                        : '-';
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
                                            <td className="px-4 py-3 text-muted-foreground">{eventDirection}</td>
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
                    </>
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
