import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    PenTool,
    Save,
    Trash2,
    RotateCcw,
    ArrowRightLeft,
    Users,
    ArrowDownToLine,
    ArrowUpFromLine,
    AlertTriangle,
    Building2,
} from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { getApiBaseUrl, getWSUrl } from '../apiConfig';
import StreamPlayer from './StreamPlayer';
import CountingCanvas from './CountingCanvas';

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

const CONFIG_TABS = [
    { id: 'setup', label: 'Setup', hint: 'Lines, zones, entrance, and verification' },
    { id: 'building', label: 'Building', hint: 'Capacity and grouped totals' },
];

const filterValidFrameExcludeAreas = (areas) => Array.isArray(areas)
    ? areas.filter((area) => area?.points?.length >= 3)
    : [];

const getLineType = (line) => line?.line_type === 'foot_traffic' ? 'foot_traffic' : 'occupancy';
const getFootTrafficLabelsForLine = (line) => {
    const points = Array.isArray(line?.points) ? line.points : [];
    if (points.length >= 2) {
        const [start, end] = points;
        const dx = Number(end?.[0] ?? 0) - Number(start?.[0] ?? 0);
        const dy = Number(end?.[1] ?? 0) - Number(start?.[1] ?? 0);
        if (Math.abs(dy) >= Math.abs(dx)) {
            return { negative: 'Left', positive: 'Right', shortNegative: 'L', shortPositive: 'R', mode: 'left_right' };
        }
    }
    return { negative: 'Up', positive: 'Down', shortNegative: 'U', shortPositive: 'D', mode: 'up_down' };
};

const getFootTrafficSummaryLabels = (lines) => {
    const ftLines = Array.isArray(lines) ? lines.filter((line) => getLineType(line) === 'foot_traffic') : [];
    if (!ftLines.length) {
        return { negative: 'Left', positive: 'Right', shortNegative: 'L', shortPositive: 'R', mixed: false };
    }
    const labels = ftLines.map(getFootTrafficLabelsForLine);
    const firstMode = labels[0].mode;
    const mixed = labels.some((label) => label.mode !== firstMode);
    if (mixed) {
        return { negative: 'Direction A', positive: 'Direction B', shortNegative: 'A', shortPositive: 'B', mixed: true };
    }
    return { ...labels[0], mixed: false };
};

const Toggle = ({ checked, onClick, disabled = false }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
            'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
            checked ? 'bg-primary' : 'bg-muted',
            disabled && 'cursor-not-allowed opacity-60',
        )}
    >
        <span
            className={cn(
                'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                checked ? 'translate-x-6' : 'translate-x-1',
            )}
        />
    </button>
);

const StatTile = ({ label, value, icon: Icon, tone = 'default', subtitle = null }) => {
    const toneClasses = {
        green: 'border-green-500/20 bg-green-500/10 text-green-500',
        red: 'border-red-500/20 bg-red-500/10 text-red-500',
        cyan: 'border-cyan-500/20 bg-cyan-500/10 text-cyan-500',
        amber: 'border-amber-500/20 bg-amber-500/10 text-amber-500',
        default: 'border-primary/20 bg-primary/10 text-primary',
    };

    return (
        <div className={cn('rounded-2xl border p-3', toneClasses[tone] || toneClasses.default)}>
            <div className="flex items-center gap-2">
                <Icon className="h-4 w-4" />
                <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                    {label}
                </span>
            </div>
            <div className="mt-3 text-2xl font-semibold leading-none">{value}</div>
            {subtitle && <div className="mt-2 text-xs text-muted-foreground">{subtitle}</div>}
        </div>
    );
};

const SectionShell = ({ title, description = null, action = null, children }) => (
    <Card className="border-border/70">
        <CardHeader className="space-y-2 pb-3">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <CardTitle className="text-base">{title}</CardTitle>
                    {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
                </div>
                {action}
            </div>
        </CardHeader>
        <CardContent className="space-y-3">{children}</CardContent>
    </Card>
);

const PeopleCounting = () => {
    const apiUrl = getApiBaseUrl();
    const videoContainerRef = useRef(null);

    const [cameras, setCameras] = useState([]);
    const [selectedCamera, setSelectedCamera] = useState('');
    const [lines, setLines] = useState([]);
    const [frameExcludeAreas, setFrameExcludeAreas] = useState([]);
    const [enabled, setEnabled] = useState(true);
    const [participateInBuildingCount, setParticipateInBuildingCount] = useState(false);
    const [entranceId, setEntranceId] = useState('');
    const [crossCameraEnabled, setCrossCameraEnabled] = useState(false);
    const [crossCameraPairId, setCrossCameraPairId] = useState('');
    const [crossCameraRole, setCrossCameraRole] = useState('none');
    const [verificationCameraId, setVerificationCameraId] = useState('');
    const [verificationInwardThreshold, setVerificationInwardThreshold] = useState('0.02');
    const [drawingMode, setDrawingMode] = useState(null);
    const [countingData, setCountingData] = useState({});
    const [stats, setStats] = useState({ fps: 0, people_count: 0 });
    const [saving, setSaving] = useState(false);
    const [saveMessage, setSaveMessage] = useState('');
    const [runtimePreviewImage, setRuntimePreviewImage] = useState('');
    const [runtimePreviewFrameSize, setRuntimePreviewFrameSize] = useState(null);
    const [loadingRuntimePreview, setLoadingRuntimePreview] = useState(false);
    const [buildingEnabled, setBuildingEnabled] = useState(true);
    const [buildingMaxCapacity, setBuildingMaxCapacity] = useState('');
    const [buildingManualOffset, setBuildingManualOffset] = useState('0');
    const [buildingSummary, setBuildingSummary] = useState(EMPTY_BUILDING_SUMMARY);
    const [resettingBuilding, setResettingBuilding] = useState(false);
    const [resettingCamera, setResettingCamera] = useState(false);
    const [activeTab, setActiveTab] = useState('setup');

    const resetCountingConfig = useCallback(() => {
        setLines([]);
        setFrameExcludeAreas([]);
        setEnabled(true);
        setParticipateInBuildingCount(false);
        setEntranceId('');
        setCrossCameraEnabled(false);
        setCrossCameraPairId('');
        setCrossCameraRole('none');
        setVerificationCameraId('');
        setVerificationInwardThreshold('0.02');
        setDrawingMode(null);
    }, []);

    useEffect(() => {
        const fetchCameras = async () => {
            try {
                const res = await fetch(`${apiUrl}/api/cameras`);
                const data = await res.json();
                const enabledCameras = (Array.isArray(data) ? data : []).filter((camera) => camera.enabled);
                setCameras(enabledCameras);
                setSelectedCamera((currentCamera) => currentCamera || enabledCameras[0]?.id || '');
            } catch (err) {
                console.error('Failed to fetch cameras:', err);
            }
        };

        fetchCameras();
    }, [apiUrl]);

    useEffect(() => {
        if (!selectedCamera) {
            resetCountingConfig();
            setCountingData({});
            setStats({ fps: 0, people_count: 0 });
            return;
        }

        let cancelled = false;
        setCountingData({});
        setStats({ fps: 0, people_count: 0 });

        const fetchConfig = async () => {
            try {
                const res = await fetch(`${apiUrl}/api/people-counting-config/${selectedCamera}`);
                if (!res.ok) {
                    if (!cancelled) {
                        resetCountingConfig();
                    }
                    return;
                }

                const data = await res.json();
                if (cancelled) {
                    return;
                }

                setLines(Array.isArray(data.lines) ? data.lines : []);
                setFrameExcludeAreas(filterValidFrameExcludeAreas(data.frame_exclude_areas));
                setEnabled(data.enabled ?? true);
                setParticipateInBuildingCount(data.participate_in_building_count ?? false);
                setEntranceId(data.entrance_id || '');
                setCrossCameraEnabled(data.cross_camera_enabled ?? false);
                setCrossCameraPairId(data.cross_camera_pair_id || '');
                setCrossCameraRole(data.cross_camera_role || 'none');
                setVerificationCameraId(data.verification_camera_id || '');
                setVerificationInwardThreshold(String(data.verification_inward_threshold ?? 0.02));
            } catch (err) {
                console.error('Failed to fetch counting config:', err);
                if (!cancelled) {
                    resetCountingConfig();
                }
            }
        };

        fetchConfig();
        return () => {
            cancelled = true;
        };
    }, [selectedCamera, apiUrl, resetCountingConfig]);

    useEffect(() => {
        const fetchBuildingConfig = async () => {
            try {
                const res = await fetch(`${apiUrl}/api/building-counting-config`);
                if (!res.ok) {
                    return;
                }
                const data = await res.json();
                setBuildingEnabled(data.enabled ?? true);
                setBuildingMaxCapacity(data.max_capacity ? String(data.max_capacity) : '');
                setBuildingManualOffset(String(data.manual_offset ?? 0));
            } catch (err) {
                console.error('Failed to fetch building counting config:', err);
            }
        };

        fetchBuildingConfig();
    }, [apiUrl]);

    useEffect(() => {
        let isMounted = true;

        const fetchBuildingSummary = async () => {
            try {
                const res = await fetch(`${apiUrl}/api/building-occupancy-summary`);
                if (!res.ok) {
                    return;
                }
                const data = await res.json();
                if (isMounted) {
                    setBuildingSummary(data);
                }
            } catch (err) {
                console.error('Failed to fetch building occupancy summary:', err);
            }
        };

        fetchBuildingSummary();
        const intervalId = setInterval(fetchBuildingSummary, 2000);
        return () => {
            isMounted = false;
            clearInterval(intervalId);
        };
    }, [apiUrl]);

    const validFrameExcludeAreas = filterValidFrameExcludeAreas(frameExcludeAreas);

    const handleSave = async () => {
        if (!selectedCamera) {
            return;
        }

        const effectiveCrossCameraRole = crossCameraEnabled
            ? (crossCameraRole === 'none' ? 'primary' : crossCameraRole)
            : 'none';

        if (participateInBuildingCount && !entranceId.trim()) {
            setSaveMessage('Error: entrance ID is required for building counting.');
            setTimeout(() => setSaveMessage(''), 3000);
            return;
        }

        if (crossCameraEnabled && effectiveCrossCameraRole === 'primary' && !verificationCameraId) {
            setSaveMessage('Error: verification camera is required for a primary cross-camera setup.');
            setTimeout(() => setSaveMessage(''), 3000);
            return;
        }

        if (crossCameraEnabled && !crossCameraPairId.trim()) {
            setSaveMessage('Error: pair ID is required for cross-camera verification.');
            setTimeout(() => setSaveMessage(''), 3000);
            return;
        }

        setSaving(true);
        setSaveMessage('');

        try {
            const body = {
                enabled,
                participate_in_building_count: participateInBuildingCount,
                entrance_id: participateInBuildingCount ? entranceId.trim() : null,
                cross_camera_enabled: crossCameraEnabled,
                cross_camera_pair_id: crossCameraEnabled ? crossCameraPairId.trim() : null,
                cross_camera_role: effectiveCrossCameraRole,
                verification_camera_id: crossCameraEnabled && effectiveCrossCameraRole === 'primary' ? verificationCameraId : null,
                verification_inward_threshold: parseFloat(verificationInwardThreshold || '0.02') || 0.02,
                lines,
                frame_exclude_areas: validFrameExcludeAreas,
            };

            const countingRes = await fetch(`${apiUrl}/api/people-counting-config/${selectedCamera}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (!countingRes.ok) {
                const err = await countingRes.json().catch(() => ({}));
                throw new Error(err.detail || 'Failed to save counting config');
            }

            const savedConfig = await countingRes.json();
            setLines(Array.isArray(savedConfig.lines) ? savedConfig.lines : []);
            setFrameExcludeAreas(filterValidFrameExcludeAreas(savedConfig.frame_exclude_areas));
            setEnabled(savedConfig.enabled ?? true);
            setParticipateInBuildingCount(savedConfig.participate_in_building_count ?? false);
            setEntranceId(savedConfig.entrance_id || '');
            setCrossCameraEnabled(savedConfig.cross_camera_enabled ?? false);
            setCrossCameraPairId(savedConfig.cross_camera_pair_id || '');
            setCrossCameraRole(savedConfig.cross_camera_role || 'none');
            setVerificationCameraId(savedConfig.verification_camera_id || '');
            setVerificationInwardThreshold(String(savedConfig.verification_inward_threshold ?? 0.02));

            const buildingRes = await fetch(`${apiUrl}/api/building-counting-config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    enabled: buildingEnabled,
                    max_capacity: buildingMaxCapacity ? parseInt(buildingMaxCapacity, 10) || 0 : 0,
                    manual_offset: parseInt(buildingManualOffset || '0', 10) || 0,
                }),
            });

            if (!buildingRes.ok) {
                const err = await buildingRes.json().catch(() => ({}));
                throw new Error(err.detail || 'Failed to save building counting config');
            }

            const savedBuildingConfig = await buildingRes.json();
            setBuildingEnabled(savedBuildingConfig.enabled ?? true);
            setBuildingMaxCapacity(savedBuildingConfig.max_capacity ? String(savedBuildingConfig.max_capacity) : '');
            setBuildingManualOffset(String(savedBuildingConfig.manual_offset ?? 0));

            const summaryRes = await fetch(`${apiUrl}/api/building-occupancy-summary`);
            if (summaryRes.ok) {
                setBuildingSummary(await summaryRes.json());
            }

            setSaveMessage('Configuration saved successfully');
        } catch (err) {
            setSaveMessage(`Error: ${err.message}`);
        }

        setSaving(false);
        setTimeout(() => setSaveMessage(''), 3000);
    };

    const handleResetBuildingTotals = async () => {
        setResettingBuilding(true);
        setSaveMessage('');
        try {
            const res = await fetch(`${apiUrl}/api/building-occupancy-summary/reset`, {
                method: 'POST',
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || 'Failed to reset building totals');
            }
            setBuildingSummary(await res.json());
            setSaveMessage('Building totals reset successfully');
        } catch (err) {
            setSaveMessage(`Error: ${err.message}`);
        }
        setResettingBuilding(false);
        setTimeout(() => setSaveMessage(''), 3000);
    };

    const handleResetSelectedCamera = async () => {
        if (!selectedCamera) {
            return;
        }

        setResettingCamera(true);
        setSaveMessage('');
        try {
            const res = await fetch(`${apiUrl}/api/people-counting-config/${selectedCamera}/reset`, {
                method: 'POST',
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || 'Failed to reset selected camera');
            }
            const data = await res.json();
            setCountingData(data.counting_data || {});
            if (data.building_summary) {
                setBuildingSummary(data.building_summary);
            }
            setSaveMessage('Selected camera totals reset successfully');
        } catch (err) {
            setSaveMessage(`Error: ${err.message}`);
        }
        setResettingCamera(false);
        setTimeout(() => setSaveMessage(''), 3000);
    };

    const handleLineDrawn = useCallback(({ points, direction }) => {
        setLines((prevLines) => [
            ...prevLines,
            {
                id: `line_${Date.now()}`,
                name: `Line ${prevLines.length + 1}`,
                points,
                direction: direction || 'left_to_right',
                count_event: 'in',
                line_type: 'occupancy',
            },
        ]);
        setDrawingMode(null);
    }, []);

    const handleFrameExcludeAreaDrawn = useCallback(({ points }) => {
        setFrameExcludeAreas((prevAreas) => [
            ...prevAreas,
            {
                id: `frame_exclude_${Date.now()}`,
                name: `Active Zone ${prevAreas.length + 1}`,
                points,
            },
        ]);
        setDrawingMode(null);
    }, []);

    const deleteLine = (lineId) => setLines((prevLines) => prevLines.filter((line) => line.id !== lineId));
    const deleteFrameExcludeArea = (areaId) => setFrameExcludeAreas((prevAreas) => prevAreas.filter((area) => area.id !== areaId));
    const toggleDirection = (lineId) => setLines((prevLines) => prevLines.map((line) => (
        line.id === lineId
            ? { ...line, direction: line.direction === 'left_to_right' ? 'right_to_left' : 'left_to_right' }
            : line
    )));
    const toggleLineEvent = (lineId) => setLines((prevLines) => prevLines.map((line) => (
        line.id === lineId
            ? { ...line, count_event: line.count_event === 'out' ? 'in' : 'out' }
            : line
    )));
    const toggleLineType = (lineId) => setLines((prevLines) => prevLines.map((line) => (
        line.id === lineId
            ? { ...line, line_type: getLineType(line) === 'foot_traffic' ? 'occupancy' : 'foot_traffic' }
            : line
    )));
    const handleReset = () => {
        resetCountingConfig();
        setSaveMessage('');
    };
    const handleStats = useCallback((nextStats) => setStats(nextStats), []);
    const handleCountingData = useCallback((nextData) => {
        if (nextData && typeof nextData === 'object') {
            setCountingData(nextData);
        }
    }, []);

    const wsUrl = selectedCamera ? getWSUrl(`/ws/${selectedCamera}`) : null;
    const selectedCam = cameras.find((camera) => camera.id === selectedCamera);
    const verificationCameraOptions = cameras.filter((camera) => camera.id !== selectedCamera);
    const occupancy = countingData.occupancy ?? 0;
    const footTrafficLeft = countingData.foot_traffic_left ?? 0;
    const footTrafficRight = countingData.foot_traffic_right ?? 0;
    const footTrafficTotal = countingData.foot_traffic_total ?? 0;
    const footTrafficLabels = getFootTrafficSummaryLabels((Array.isArray(countingData.lines) && countingData.lines.length) ? countingData.lines : lines);
    const isVerifierMode = crossCameraEnabled && crossCameraRole === 'verifier';
    const verifierObservedTracks = countingData.verifier_observed_tracks ?? 0;
    const verifierActiveInEvent = countingData.verifier_active_in_event ?? null;
    const verifierActiveOutEvent = countingData.verifier_active_out_event ?? null;
    const verifierLastInEvent = countingData.verifier_last_in_event ?? null;
    const verifierLastOutEvent = countingData.verifier_last_out_event ?? null;
    const verifierPrimaryCameraIds = Array.isArray(countingData.verifier_primary_camera_ids) ? countingData.verifier_primary_camera_ids : [];
    const linkedPrimaryNames = verifierPrimaryCameraIds
        .map((cameraId) => cameras.find((camera) => camera.id === cameraId)?.name || cameraId)
        .join(', ');
    const occupancyLineCount = lines.filter((line) => getLineType(line) !== 'foot_traffic').length;
    const footTrafficLineCount = lines.filter((line) => getLineType(line) === 'foot_traffic').length;
    const buildingCapacityExceeded = buildingSummary.capacity_exceeded ?? false;
    const buildingEntranceSummaries = buildingSummary.entrance_summaries ?? {};
    const showStoppedUploadPreview = Boolean(selectedCam?.is_uploaded && !selectedCam?.producer_running);

    useEffect(() => {
        let cancelled = false;

        const loadRuntimePreview = async () => {
            if (!selectedCam?.runtime_key || !showStoppedUploadPreview) {
                setRuntimePreviewImage('');
                setRuntimePreviewFrameSize(null);
                setLoadingRuntimePreview(false);
                return;
            }

            setLoadingRuntimePreview(true);
            try {
                const res = await fetch(`${apiUrl}/api/upload-videos/preview`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        runtime_key: selectedCam.runtime_key,
                        camera_id: selectedCam.id,
                    }),
                });
                const data = await res.json().catch(() => ({}));
                if (cancelled) {
                    return;
                }
                if (!res.ok || !data.preview_image) {
                    throw new Error(data.detail || 'Preview unavailable.');
                }
                setRuntimePreviewImage(`data:image/jpeg;base64,${data.preview_image}`);
                setRuntimePreviewFrameSize(
                    Number(data.frame_width) > 0 && Number(data.frame_height) > 0
                        ? { width: Number(data.frame_width), height: Number(data.frame_height) }
                        : null
                );
            } catch (err) {
                if (!cancelled) {
                    console.error('Failed to load people counting preview:', err);
                    setRuntimePreviewImage('');
                    setRuntimePreviewFrameSize(null);
                }
            } finally {
                if (!cancelled) {
                    setLoadingRuntimePreview(false);
                }
            }
        };

        loadRuntimePreview();
        return () => {
            cancelled = true;
        };
    }, [apiUrl, selectedCam, showStoppedUploadPreview]);

    const topSummary = isVerifierMode ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <StatTile label="Verifier Tracks" value={verifierObservedTracks} icon={Users} tone="cyan" subtitle="Tracks currently observed by verifier" />
            <StatTile
                label="Active IN"
                value={verifierActiveInEvent?.verifier_count ?? 0}
                icon={ArrowDownToLine}
                tone="green"
                subtitle={verifierActiveInEvent ? `Primary ${verifierActiveInEvent.primary_count ?? 0}` : 'No active IN event'}
            />
            <StatTile
                label="Active OUT"
                value={verifierActiveOutEvent?.verifier_count ?? 0}
                icon={ArrowUpFromLine}
                tone="red"
                subtitle={verifierActiveOutEvent ? `Primary ${verifierActiveOutEvent.primary_count ?? 0}` : 'No active OUT event'}
            />
            <StatTile
                label="Last IN"
                value={verifierLastInEvent?.verifier_count ?? 0}
                icon={ArrowDownToLine}
                tone="green"
                subtitle={verifierLastInEvent ? `Primary ${verifierLastInEvent.primary_count ?? 0}` : 'No completed IN event'}
            />
            <StatTile
                label="Last OUT"
                value={verifierLastOutEvent?.verifier_count ?? 0}
                icon={ArrowUpFromLine}
                tone="red"
                subtitle={verifierLastOutEvent ? `Primary ${verifierLastOutEvent.primary_count ?? 0}` : 'No completed OUT event'}
            />
            <StatTile label="Pair" value={countingData.cross_camera_pair_id || '-'} icon={Building2} tone="amber" subtitle={linkedPrimaryNames ? `Primary ${linkedPrimaryNames}` : 'No linked primary camera'} />
        </div>
    ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Door In" value={countingData.total_in ?? 0} icon={ArrowDownToLine} tone="green" subtitle="Disappear-confirmed inward counts" />
            <StatTile label="Door Out" value={countingData.total_out ?? 0} icon={ArrowUpFromLine} tone="red" subtitle="Cross or zone-exit outward counts" />
            <StatTile label="Inside Now" value={occupancy} icon={Users} tone="default" subtitle="Camera-level occupancy" />
            <StatTile
                label="Foot Traffic"
                value={footTrafficTotal}
                icon={ArrowRightLeft}
                tone="cyan"
                subtitle={footTrafficLabels.mixed
                    ? 'Mixed FT line orientations'
                    : `${footTrafficLabels.negative} ${footTrafficLeft} / ${footTrafficLabels.positive} ${footTrafficRight}`}
            />
        </div>
    );

    const setupContent = (
        <div className="space-y-4">
            <SectionShell
                title="Counting Geometry"
                description="Draw lines here, tag them as occupancy or FT, and keep the active zone nearby."
                action={(
                    <Button variant={drawingMode === 'line' ? 'default' : 'outline'} size="sm" className="h-9" onClick={() => setDrawingMode(drawingMode === 'line' ? null : 'line')}>
                        <PenTool className="mr-2 h-3.5 w-3.5" />
                        {drawingMode === 'line' ? 'Cancel Line' : 'Draw Line'}
                    </Button>
                )}
            >
                <div className="grid gap-3">
                    {lines.length === 0 && (
                        <div className="rounded-2xl border border-dashed px-4 py-5 text-sm text-muted-foreground">
                            No lines yet. Draw one on the preview, then use `FT` for outside foot traffic or the arrow button for IN/OUT door logic.
                        </div>
                    )}
                    {lines.map((line, index) => {
                        const isFootTraffic = getLineType(line) === 'foot_traffic';
                        const lineFootTrafficLabels = getFootTrafficLabelsForLine(line);
                        return (
                            <div key={line.id} className="rounded-2xl border border-border/70 bg-background px-3 py-3">
                                <div className="flex items-center gap-3">
                                    <div className={cn('h-2.5 w-2.5 shrink-0 rounded-full', isFootTraffic ? 'bg-cyan-400' : line.count_event === 'out' ? 'bg-red-500' : 'bg-yellow-400')} />
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate text-sm font-medium">{line.name || `Line ${index + 1}`}</div>
                                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                                        <span className="rounded-full border px-2 py-0.5">{isFootTraffic ? 'Foot Traffic' : `Door ${line.count_event === 'out' ? 'OUT' : 'IN'}`}</span>
                                        <span className="rounded-full border px-2 py-0.5">
                                            {isFootTraffic
                                                ? `Auto ${lineFootTrafficLabels.negative} / ${lineFootTrafficLabels.positive}`
                                                : line.direction === 'left_to_right' ? 'Left to Right' : 'Right to Left'}
                                        </span>
                                    </div>
                                </div>
                                <div className="flex items-center gap-1">
                                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => toggleLineType(line.id)} title={`Line type: ${isFootTraffic ? 'Foot Traffic' : 'Occupancy'}`}>
                                            <span className={cn('text-[10px] font-bold', isFootTraffic ? 'text-cyan-400' : 'text-muted-foreground')}>FT</span>
                                        </Button>
                                        {!isFootTraffic && (
                                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => toggleLineEvent(line.id)} title={`Count event: ${line.count_event === 'out' ? 'OUT' : 'IN'}`}>
                                                {line.count_event === 'out'
                                                    ? <ArrowUpFromLine className="h-3.5 w-3.5 text-red-500" />
                                                    : <ArrowDownToLine className="h-3.5 w-3.5 text-yellow-500" />}
                                            </Button>
                                        )}
                                        {!isFootTraffic && (
                                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => toggleDirection(line.id)} title={`Direction: ${line.direction === 'left_to_right' ? 'L->R' : 'R->L'}`}>
                                                <ArrowRightLeft className="h-3.5 w-3.5" />
                                            </Button>
                                        )}
                                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => deleteLine(line.id)}>
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
                {drawingMode === 'line' && <p className="text-xs text-muted-foreground">Draw directly on the preview. New lines start as occupancy lines, and you can switch them to foot traffic with `FT`.</p>}
            </SectionShell>

            <SectionShell
                title="Active Counting Zone"
                description="Use this only when you need to gate door counts and foot-traffic crossings to a smaller area."
                action={(
                    <Button variant={drawingMode === 'frame_exclude' ? 'default' : 'outline'} size="sm" className="h-9" onClick={() => setDrawingMode(drawingMode === 'frame_exclude' ? null : 'frame_exclude')}>
                        <PenTool className="mr-2 h-3.5 w-3.5" />
                        {drawingMode === 'frame_exclude' ? 'Cancel Area' : 'Draw Area'}
                    </Button>
                )}
            >
                <p className="text-sm text-muted-foreground">Door and occupancy counts only trigger when the counting probe point is inside this polygon. Foot-traffic lines can be placed outside the entrance path.</p>
                <div className="grid gap-3">
                    {validFrameExcludeAreas.length === 0 && (
                        <div className="rounded-2xl border border-dashed px-4 py-5 text-sm text-muted-foreground">
                            No active zone configured. The whole frame is currently eligible for counting.
                        </div>
                    )}
                    {validFrameExcludeAreas.map((area, index) => (
                        <div key={area.id} className="flex items-center gap-3 rounded-2xl border border-border/70 bg-background px-3 py-3">
                            <div className="h-2.5 w-2.5 rounded-full bg-sky-500" />
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium">{area.name || `Active Zone ${index + 1}`}</div>
                                <div className="text-xs text-muted-foreground">{area.points?.length ?? 0} polygon points</div>
                            </div>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => deleteFrameExcludeArea(area.id)}>
                                <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                        </div>
                    ))}
                </div>
                {drawingMode === 'frame_exclude' && <p className="text-xs text-muted-foreground">Click around the preview to place points, then double-click to close the area.</p>}
            </SectionShell>

            <SectionShell title="Building Entrance Group" description="Only cameras with the same entrance ID are merged into one building entrance total.">
                <div className="flex items-center justify-between rounded-2xl border border-border/70 bg-background px-4 py-3">
                    <div>
                        <div className="text-sm font-medium">Participates in Building Count</div>
                        <div className="text-xs text-muted-foreground">Turn this on only for actual entrance cameras.</div>
                    </div>
                    <Toggle checked={participateInBuildingCount} onClick={() => setParticipateInBuildingCount(!participateInBuildingCount)} />
                </div>
                {participateInBuildingCount && (
                    <div className="space-y-2">
                        <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Entrance ID</label>
                        <input type="text" className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm" value={entranceId} onChange={(e) => setEntranceId(e.target.value)} placeholder="entrance_1" />
                    </div>
                )}
            </SectionShell>

            <SectionShell title="Cross-Camera Verification" description="Use this when one camera should correct missed IN counts from another camera covering the same entrance.">
                <div className="flex items-center justify-between rounded-2xl border border-border/70 bg-background px-4 py-3">
                    <div>
                        <div className="text-sm font-medium">Verification Enabled</div>
                        <div className="text-xs text-muted-foreground">Primary cameras only receive upward corrections.</div>
                    </div>
                    <Toggle
                        checked={crossCameraEnabled}
                        onClick={() => {
                            const nextEnabled = !crossCameraEnabled;
                            setCrossCameraEnabled(nextEnabled);
                            if (nextEnabled && crossCameraRole === 'none') {
                                setCrossCameraRole('primary');
                            }
                            if (!nextEnabled) {
                                setCrossCameraPairId('');
                                setCrossCameraRole('none');
                                setVerificationCameraId('');
                            }
                        }}
                    />
                </div>
                {crossCameraEnabled && (
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-2">
                            <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Pair ID</label>
                            <input type="text" className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm" value={crossCameraPairId} onChange={(e) => setCrossCameraPairId(e.target.value)} placeholder="entrance_pair_1" />
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Role</label>
                            <select className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm" value={crossCameraRole} onChange={(e) => setCrossCameraRole(e.target.value)}>
                                <option value="primary">Primary Camera</option>
                                <option value="verifier">Verifier Camera</option>
                            </select>
                        </div>
                        {crossCameraRole === 'primary' && (
                            <div className="space-y-2 sm:col-span-2">
                                <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Verification Camera</label>
                                <select className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm" value={verificationCameraId} onChange={(e) => setVerificationCameraId(e.target.value)}>
                                    <option value="">Select verifier camera</option>
                                    {verificationCameraOptions.map((camera) => (
                                        <option key={camera.id} value={camera.id}>{camera.name}</option>
                                    ))}
                                </select>
                            </div>
                        )}
                        <div className="space-y-2 sm:col-span-2">
                            <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Inward Motion Threshold</label>
                            <input type="number" step="0.005" min="0" className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm" value={verificationInwardThreshold} onChange={(e) => setVerificationInwardThreshold(e.target.value)} />
                        </div>
                    </div>
                )}
            </SectionShell>
        </div>
    );

    const buildingContent = (
        <div className="space-y-4">
            <SectionShell title="Building Occupancy" description="Building settings stay separated from camera geometry so they do not push the preview down.">
                <div className="flex items-center justify-between rounded-2xl border border-border/70 bg-background px-4 py-3">
                    <div>
                        <div className="text-sm font-medium">Building Counting Enabled</div>
                        <div className="text-xs text-muted-foreground">Use grouped entrance totals to drive occupancy alerts.</div>
                    </div>
                    <Toggle checked={buildingEnabled} onClick={() => setBuildingEnabled(!buildingEnabled)} />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                        <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Max Capacity</label>
                        <input type="number" min="1" placeholder="e.g. 200" className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm" value={buildingMaxCapacity} onChange={(e) => setBuildingMaxCapacity(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                        <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Manual Offset</label>
                        <input type="number" className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm" value={buildingManualOffset} onChange={(e) => setBuildingManualOffset(e.target.value)} />
                    </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                    <StatTile label="Building In" value={buildingSummary.raw_in ?? 0} icon={ArrowDownToLine} tone="green" />
                    <StatTile label="Building Out" value={buildingSummary.raw_out ?? 0} icon={ArrowUpFromLine} tone="red" />
                    <StatTile label="Building Now" value={buildingSummary.occupancy ?? 0} icon={Building2} tone={buildingCapacityExceeded ? 'amber' : 'default'} subtitle={buildingSummary.max_capacity ? `Capacity ${buildingSummary.max_capacity}` : 'Live grouped occupancy'} />
                </div>
                <div className="rounded-2xl border border-border/70 bg-background px-4 py-3 text-sm text-muted-foreground">
                    Active cameras: {buildingSummary.active_camera_count ?? 0} | Raw occupancy: {buildingSummary.raw_occupancy ?? 0} | Manual offset: {buildingSummary.manual_offset ?? 0}
                </div>
                {buildingCapacityExceeded && (
                    <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500">
                        Building capacity exceeded.
                    </div>
                )}
                <Button variant="outline" size="sm" className="w-full" onClick={handleResetBuildingTotals} disabled={resettingBuilding}>
                    <RotateCcw className="mr-2 h-3.5 w-3.5" />
                    {resettingBuilding ? 'Resetting Building Totals...' : 'Reset Building Totals'}
                </Button>
            </SectionShell>

            {Object.keys(buildingEntranceSummaries).length > 0 && (
                <SectionShell title="Entrance Rollups" description="These grouped entrance totals feed the building occupancy summary.">
                    <div className="grid gap-3">
                        {Object.entries(buildingEntranceSummaries).map(([entranceIdValue, entrance]) => (
                            <div key={entranceIdValue} className="rounded-2xl border border-border/70 bg-background px-4 py-3">
                                <div className="text-sm font-medium">{entranceIdValue}</div>
                                <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                                    <div>Cameras: {(entrance.camera_ids || []).length}</div>
                                    <div>IN / OUT: {entrance.total_in ?? 0} / {entrance.total_out ?? 0}</div>
                                    <div>Occupancy: {entrance.occupancy ?? 0}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </SectionShell>
            )}
        </div>
    );

    const settingsPanel = (
        <div className="order-2 space-y-4 xl:order-1">
            <Card className="border-border/70 bg-gradient-to-br from-background via-background to-muted/40">
                <CardHeader className="pb-2">
                    <div className="space-y-1">
                        <CardTitle className="text-xl">Configuration</CardTitle>
                        <p className="text-sm text-muted-foreground">A cleaner control rail with the most important inputs aligned first.</p>
                    </div>
                </CardHeader>
                <CardContent className="space-y-5">
                    <div className="rounded-3xl border border-border/70 bg-background/80 p-4">
                        <div className="space-y-4">
                            <div className="space-y-2">
                                <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Selected Camera</label>
                                <select className="flex h-11 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm" value={selectedCamera} onChange={(e) => setSelectedCamera(e.target.value)}>
                                    {cameras.length === 0 && <option value="">No cameras available</option>}
                                    {cameras.map((camera) => (
                                        <option key={camera.id} value={camera.id}>{camera.name}</option>
                                    ))}
                                </select>
                            </div>

                            <div className="flex items-center justify-between rounded-2xl border border-border/70 bg-background px-4 py-3">
                                <div>
                                    <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Counting</div>
                                    <div className="mt-1 text-sm font-medium">{enabled ? 'Enabled' : 'Disabled'}</div>
                                    <div className="text-xs text-muted-foreground">Camera-level counting runtime</div>
                                </div>
                                <Toggle checked={enabled} onClick={() => setEnabled(!enabled)} />
                            </div>

                            <div className="grid grid-cols-3 gap-2">
                                <div className="rounded-2xl border border-border/70 bg-background px-3 py-2">
                                    <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Door Lines</div>
                                    <div className="mt-1 text-lg font-semibold">{occupancyLineCount}</div>
                                </div>
                                <div className="rounded-2xl border border-border/70 bg-background px-3 py-2">
                                    <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">FT Lines</div>
                                    <div className="mt-1 text-lg font-semibold">{footTrafficLineCount}</div>
                                </div>
                                <div className="rounded-2xl border border-border/70 bg-background px-3 py-2">
                                    <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Zones</div>
                                    <div className="mt-1 text-lg font-semibold">{validFrameExcludeAreas.length}</div>
                                </div>
                            </div>

                            <div className="grid gap-2">
                                <Button variant="outline" onClick={handleReset} className="h-11">
                                    <RotateCcw className="mr-2 h-4 w-4" />
                                    Reset Form
                                </Button>
                            </div>

                        </div>
                    </div>

                    <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-1">
                        {CONFIG_TABS.map((tab) => (
                            <button
                                key={tab.id}
                                type="button"
                                onClick={() => setActiveTab(tab.id)}
                                className={cn(
                                    'rounded-2xl border px-4 py-3 text-left text-sm transition-colors',
                                    activeTab === tab.id ? 'border-primary bg-primary/10 text-foreground' : 'border-border/70 bg-background text-muted-foreground hover:text-foreground',
                                )}
                            >
                                <div className="font-medium">{tab.label}</div>
                                <div className="mt-1 text-xs leading-5">{tab.hint}</div>
                            </button>
                        ))}
                    </div>
                </CardContent>
            </Card>
            <div className="space-y-4">
                {activeTab === 'setup' && setupContent}
                {activeTab === 'building' && buildingContent}
            </div>
        </div>
    );

    const videoPanel = (
        <div className="order-1 space-y-4 xl:order-2 xl:sticky xl:top-6">
            {topSummary}
            <Card className="overflow-hidden border-border/70 bg-black">
                <CardHeader className="border-b border-white/10 bg-black/80 pb-3 text-white">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                            <CardTitle className="text-lg text-white">{selectedCam?.name || 'Preview'}</CardTitle>
                            <p className="mt-1 text-sm text-white/60">
                                {drawingMode === 'line' && 'Drawing line on preview'}
                                {drawingMode === 'frame_exclude' && 'Drawing active zone on preview'}
                                {!drawingMode && 'Live preview stays visible while you configure the page'}
                            </p>
                        </div>
                        <div className="flex flex-wrap gap-2 text-xs text-white/70">
                            <span className="rounded-full border border-white/15 px-3 py-1">People {stats.people_count}</span>
                            <span className="rounded-full border border-white/15 px-3 py-1">FPS {stats.fps}</span>
                            <span className="rounded-full border border-white/15 px-3 py-1">
                                FT {footTrafficLabels.shortNegative}:{footTrafficLeft} {footTrafficLabels.shortPositive}:{footTrafficRight} T:{footTrafficTotal}
                            </span>
                        </div>
                    </div>
                </CardHeader>
                <div ref={videoContainerRef} className="relative min-h-[360px] bg-black md:min-h-[480px] xl:min-h-[620px]">
                    {wsUrl ? (
                        <>
                            {showStoppedUploadPreview ? (
                                runtimePreviewImage ? (
                                    <img src={runtimePreviewImage} alt={selectedCam?.name || 'Camera Preview'} className="h-full w-full object-contain" />
                                ) : (
                                    <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                                        <p>{loadingRuntimePreview ? 'Loading preview...' : 'Preview unavailable for this uploaded video.'}</p>
                                    </div>
                                )
                            ) : (
                                <StreamPlayer
                                    wsUrl={wsUrl}
                                    className="h-full w-full"
                                    alt={selectedCam?.name || 'Camera Feed'}
                                    onStats={handleStats}
                                    onCountingData={handleCountingData}
                                    showCountingAnchors
                                    overlayMode="counting"
                                />
                            )}
                            <CountingCanvas
                                lines={lines}
                                frameExcludeAreas={validFrameExcludeAreas}
                                countingData={countingData}
                                drawingMode={drawingMode}
                                onLineDrawn={handleLineDrawn}
                                onFrameExcludeAreaDrawn={handleFrameExcludeAreaDrawn}
                                containerRef={videoContainerRef}
                                mediaSize={showStoppedUploadPreview ? runtimePreviewFrameSize : null}
                            />
                        </>
                    ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                            <p>Select a camera to view the feed</p>
                        </div>
                    )}
                </div>
                <div className="border-t border-white/10 bg-black/85 px-4 py-3">
                    <div className="text-sm text-white/75">
                        Draw directly on the preview. The primary save and reset actions are pinned above the workspace so they stay visible while you configure the page.
                    </div>
                </div>
            </Card>
        </div>
    );

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">People Counting</h1>
                    <p className="mt-1 text-sm text-muted-foreground">Redesigned so the live preview stays primary and the configuration stays focused.</p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
                    {buildingCapacityExceeded && (
                        <div className="flex items-center gap-2 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-red-500">
                            <AlertTriangle className="h-4 w-4" />
                            <span className="text-sm font-medium">Building Capacity Exceeded</span>
                        </div>
                    )}
                    <Button variant="outline" size="sm" onClick={handleResetSelectedCamera} disabled={resettingCamera || !selectedCamera}>
                        <RotateCcw className="mr-2 h-3.5 w-3.5" />
                        {resettingCamera ? 'Resetting...' : 'Reset Totals'}
                    </Button>
                    <Button size="sm" onClick={handleSave} disabled={saving || !selectedCamera}>
                        <Save className="mr-2 h-3.5 w-3.5" />
                        {saving ? 'Saving...' : 'Save Changes'}
                    </Button>
                </div>
            </div>
            {saveMessage && (
                <div className={cn('rounded-2xl border px-4 py-3 text-sm', saveMessage.startsWith('Error') ? 'border-red-500/30 bg-red-500/10 text-red-500' : 'border-green-500/30 bg-green-500/10 text-green-600')}>
                    {saveMessage}
                </div>
            )}
            <div className="grid gap-6 xl:grid-cols-[minmax(420px,500px)_minmax(0,1fr)] xl:items-start">
                {videoPanel}
                {settingsPanel}
            </div>
        </div>
    );
};

export default PeopleCounting;
