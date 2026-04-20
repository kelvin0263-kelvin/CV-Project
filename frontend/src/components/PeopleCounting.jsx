import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
    ChevronLeft,
    ChevronDown,
    ChevronRight,
} from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { getApiBaseUrl, getWSUrl } from '../apiConfig';
import StreamPlayer from './StreamPlayer';
import CountingCanvas from './CountingCanvas';
import ConfirmationDialog from './ConfirmationDialog';

const EMPTY_BUILDING_SUMMARY = {
    enabled: true,
    max_capacity: null,
    capacity_exceeded: false,
    exceeded_building_ids: [],
    default_max_capacity: null,
    building_ids: [],
    capacity_by_building_id: {},
    manual_offset: 0,
    raw_in: 0,
    raw_out: 0,
    raw_occupancy: 0,
    occupancy: 0,
    active_camera_count: 0,
    entrance_summaries: {},
};

const SUCCESS_REFRESH_DELAY_MS = 1200;

const CONFIG_TABS = [
    { id: 'setup', label: 'Setup', hint: 'Lines, zones, entrance, and verification' },
    { id: 'building', label: 'Building', hint: 'Capacity and grouped totals' },
];

const filterValidFrameExcludeAreas = (areas) => Array.isArray(areas)
    ? areas.filter((area) => area?.points?.length >= 3)
    : [];

const getNextNamedIndex = (items, prefix) => {
    const pattern = new RegExp(`^${prefix} (\\d+)$`);
    let maxIndex = 0;

    (Array.isArray(items) ? items : []).forEach((item) => {
        const name = String(item?.name || '').trim();
        const match = pattern.exec(name);
        if (!match) return;
        const parsed = Number(match[1]);
        if (Number.isFinite(parsed) && parsed > maxIndex) {
            maxIndex = parsed;
        }
    });

    return maxIndex + 1;
};

const getLineType = (line) => line?.line_type === 'foot_traffic' ? 'foot_traffic' : 'occupancy';
const getFootTrafficLabelsForLine = (line) => {
    const points = Array.isArray(line?.points) ? line.points : [];
    if (points.length >= 2) {
        const [start, end] = points;
        const dx = Number(end?.[0] ?? 0) - Number(start?.[0] ?? 0);
        const dy = Number(end?.[1] ?? 0) - Number(start?.[1] ?? 0);
        if (Math.abs(dy) >= Math.abs(dx)) {
            return dy >= 0
                ? { negative: 'Right', positive: 'Left', shortNegative: 'R', shortPositive: 'L', mode: 'left_right' }
                : { negative: 'Left', positive: 'Right', shortNegative: 'L', shortPositive: 'R', mode: 'left_right' };
        }
    }
    const [start, end] = points;
    const dx = Number(end?.[0] ?? 0) - Number(start?.[0] ?? 0);
    return dx >= 0
        ? { negative: 'Up', positive: 'Down', shortNegative: 'U', shortPositive: 'D', mode: 'up_down' }
        : { negative: 'Down', positive: 'Up', shortNegative: 'D', shortPositive: 'U', mode: 'up_down' };
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
        return { negative: 'Left', positive: 'Right', shortNegative: 'L', shortPositive: 'R', mixed: false };
    }
    return { ...labels[0], mixed: false };
};

const getLineDirectionDisplay = (line) => {
    if (getLineType(line) === 'foot_traffic') {
        const labels = getFootTrafficLabelsForLine(line);
        return line.direction === 'left_to_right'
            ? `${labels.negative} only`
            : `${labels.positive} only`;
    }

    return line.direction === 'left_to_right' ? 'Right to Left' : 'Left to Right';
};

const sortCamerasAlphabetically = (cameraList) => [...cameraList].sort((left, right) => (
    String(left?.name || '').localeCompare(String(right?.name || ''), undefined, {
        numeric: true,
        sensitivity: 'base',
    })
));

const getCameraOptionLabel = (camera) => {
    const name = String(camera?.name || '').trim() || 'Unnamed camera';
    const location = String(camera?.location || '').trim();
    return location ? `${name} - ${location}` : name;
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

const StatTile = ({ label, value, icon: Icon, tone = 'default', subtitle = null, className = '' }) => {
    const toneClasses = {
        green: 'border-green-500/20 bg-green-500/10 text-green-500',
        red: 'border-red-500/20 bg-red-500/10 text-red-500',
        cyan: 'border-cyan-500/20 bg-cyan-500/10 text-cyan-500',
        amber: 'border-amber-500/20 bg-amber-500/10 text-amber-500',
        blue: 'border-blue-500/20 bg-blue-500/10 text-blue-500',
        default: 'border-blue-500/20 bg-blue-500/10 text-blue-500',
    };

    return (
        <div className={cn('rounded-2xl border p-3 shadow-sm', toneClasses[tone] || toneClasses.default, className)}>
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

const SectionShell = ({
    title,
    description = null,
    action = null,
    children,
    collapsible = false,
    collapsed = false,
    onToggle = null,
}) => (
    <Card className="border-slate-200/80 bg-white/95 shadow-sm">
        <CardHeader className="space-y-2 pb-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        {collapsible && (
                            <button
                                type="button"
                                onClick={onToggle}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-700"
                                aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
                            >
                                <ChevronDown
                                    className={cn(
                                        'h-4 w-4 transition-transform duration-300 ease-out',
                                        collapsed ? '-rotate-90' : 'rotate-0',
                                    )}
                                />
                            </button>
                        )}
                        <CardTitle className="text-base">{title}</CardTitle>
                    </div>
                    {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
                </div>
                {!collapsed && action}
            </div>
        </CardHeader>
        <div
            className={cn(
                'grid transition-[grid-template-rows,opacity,transform] duration-300 ease-out',
                collapsed ? 'grid-rows-[0fr] opacity-0 -translate-y-1' : 'grid-rows-[1fr] opacity-100 translate-y-0',
            )}
        >
            <div className="min-h-0 overflow-hidden">
                <CardContent className="space-y-3 pt-0">{children}</CardContent>
            </div>
        </div>
    </Card>
);

const PeopleCounting = () => {
    const apiUrl = getApiBaseUrl();
    const singleVideoContainerRef = useRef(null);
    const primaryVideoContainerRef = useRef(null);
    const verifierVideoContainerRef = useRef(null);
    const stoppedPreviewStateRef = useRef({});
    const stoppedPreviewRequestRef = useRef({});
    const pairedPrimaryLookupCacheRef = useRef({});
    const cameraConfigCacheRef = useRef({});
    const cameraConfigRequestRef = useRef({});

    const [cameras, setCameras] = useState([]);
    const [selectedCamera, setSelectedCamera] = useState('');
    const [lines, setLines] = useState([]);
    const [frameExcludeAreas, setFrameExcludeAreas] = useState([]);
    const [enabled, setEnabled] = useState(true);
    const [participateInBuildingCount, setParticipateInBuildingCount] = useState(false);
    const [buildingId, setBuildingId] = useState('');
    const [crossCameraEnabled, setCrossCameraEnabled] = useState(false);
    const [crossCameraPairId, setCrossCameraPairId] = useState('');
    const [crossCameraRole, setCrossCameraRole] = useState('none');
    const [verificationCameraId, setVerificationCameraId] = useState('');
    const [primaryInEventIdleTimeoutSec, setPrimaryInEventIdleTimeoutSec] = useState('7');
    const [primaryOutEventIdleTimeoutSec, setPrimaryOutEventIdleTimeoutSec] = useState('7');
    const [drawingMode, setDrawingMode] = useState(null);
    const [countingData, setCountingData] = useState({});
    const [stats, setStats] = useState({ fps: 0, people_count: 0 });
    const [panelStatsByCamera, setPanelStatsByCamera] = useState({});
    const [panelCountingDataByCamera, setPanelCountingDataByCamera] = useState({});
    const [saving, setSaving] = useState(false);
    const [saveMessage, setSaveMessage] = useState('');
    const [stoppedPreviewStateByCamera, setStoppedPreviewStateByCamera] = useState({});
    const [livePreviewLayout, setLivePreviewLayout] = useState(null);
    const [panelLivePreviewLayouts, setPanelLivePreviewLayouts] = useState({});
    const [pairedPrimaryCameraId, setPairedPrimaryCameraId] = useState('');
    const [pairedPrimaryPairId, setPairedPrimaryPairId] = useState('');
    const [resolvingPairedPrimary, setResolvingPairedPrimary] = useState(false);
    const [pairedVerifierReady, setPairedVerifierReady] = useState(false);
    const [resolvingPairedVerifier, setResolvingPairedVerifier] = useState(false);
    const [buildingEnabled, setBuildingEnabled] = useState(true);
    const [registeredBuildingIds, setRegisteredBuildingIds] = useState([]);
    const [newBuildingId, setNewBuildingId] = useState('');
    const [selectedCapacityBuildingId, setSelectedCapacityBuildingId] = useState('');
    const [buildingCapacityById, setBuildingCapacityById] = useState({});
    const [buildingMaxCapacity, setBuildingMaxCapacity] = useState('');
    const [buildingManualOffset, setBuildingManualOffset] = useState('0');
    const [buildingSummary, setBuildingSummary] = useState(EMPTY_BUILDING_SUMMARY);
    const [addingBuildingId, setAddingBuildingId] = useState(false);
    const [resettingBuilding, setResettingBuilding] = useState(false);
    const [deletingBuildingId, setDeletingBuildingId] = useState('');
    const [resettingCamera, setResettingCamera] = useState(false);
    const [confirmDialog, setConfirmDialog] = useState(null);
    const [activeTab, setActiveTab] = useState('setup');
    const [collapsedConfigurationPanel, setCollapsedConfigurationPanel] = useState(false);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [showSidebarRestoreHint, setShowSidebarRestoreHint] = useState(false);
    const [isSidebarRestoreHovered, setIsSidebarRestoreHovered] = useState(false);
    const [comparisonCameraConfig, setComparisonCameraConfig] = useState(null);
    const [collapsedSetupSections, setCollapsedSetupSections] = useState({
        geometry: true,
        activeZone: true,
        buildingGroup: true,
        crossCamera: true,
    });
    const [collapsedBuildingSections, setCollapsedBuildingSections] = useState({
        occupancy: false,
        rollups: true,
    });

    const resetCountingConfig = useCallback(() => {
        setLines([]);
        setFrameExcludeAreas([]);
        setEnabled(true);
        setParticipateInBuildingCount(false);
        setBuildingId('');
        setCrossCameraEnabled(false);
        setCrossCameraPairId('');
        setCrossCameraRole('none');
        setVerificationCameraId('');
        setPrimaryInEventIdleTimeoutSec('7');
        setPrimaryOutEventIdleTimeoutSec('7');
        setDrawingMode(null);
    }, []);

    const toggleSetupSection = useCallback((sectionKey) => {
        setCollapsedSetupSections((current) => ({
            ...current,
            [sectionKey]: !current[sectionKey],
        }));
    }, []);

    const toggleBuildingSection = useCallback((sectionKey) => {
        setCollapsedBuildingSections((current) => ({
            ...current,
            [sectionKey]: !current[sectionKey],
        }));
    }, []);

    const loadStoppedPreviewForCamera = useCallback(async (camera) => {
        const cameraId = camera?.id;
        const runtimeKey = String(camera?.runtime_key || '').trim();
        if (!cameraId || !runtimeKey) {
            return null;
        }

        const cachedState = stoppedPreviewStateRef.current[cameraId];
        if (cachedState?.image) {
            return cachedState;
        }

        if (stoppedPreviewRequestRef.current[cameraId]) {
            return stoppedPreviewRequestRef.current[cameraId];
        }

        setStoppedPreviewStateByCamera((current) => ({
            ...current,
            [cameraId]: {
                image: current[cameraId]?.image || '',
                frameSize: current[cameraId]?.frameSize || null,
                loading: true,
            },
        }));

        const request = fetch(`${apiUrl}/api/upload-videos/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                runtime_key: runtimeKey,
                camera_id: cameraId,
            }),
        })
            .then(async (res) => {
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.preview_image) {
                    throw new Error(data.detail || 'Preview unavailable.');
                }

                const nextState = {
                    image: `data:image/jpeg;base64,${data.preview_image}`,
                    frameSize: Number(data.frame_width) > 0 && Number(data.frame_height) > 0
                        ? { width: Number(data.frame_width), height: Number(data.frame_height) }
                        : null,
                    loading: false,
                };

                setStoppedPreviewStateByCamera((current) => ({
                    ...current,
                    [cameraId]: nextState,
                }));
                return nextState;
            })
            .catch((err) => {
                console.error('Failed to load people counting preview:', err);
                const failedState = {
                    image: '',
                    frameSize: null,
                    loading: false,
                };
                setStoppedPreviewStateByCamera((current) => ({
                    ...current,
                    [cameraId]: failedState,
                }));
                return failedState;
            })
            .finally(() => {
                delete stoppedPreviewRequestRef.current[cameraId];
            });

        stoppedPreviewRequestRef.current[cameraId] = request;
        return request;
    }, [apiUrl]);

    const getCameraCountingConfig = useCallback(async (cameraId) => {
        if (!cameraId) {
            return null;
        }

        if (Object.prototype.hasOwnProperty.call(cameraConfigCacheRef.current, cameraId)) {
            return cameraConfigCacheRef.current[cameraId];
        }

        if (cameraConfigRequestRef.current[cameraId]) {
            return cameraConfigRequestRef.current[cameraId];
        }

        const request = fetch(`${apiUrl}/api/people-counting-config/${cameraId}`)
            .then(async (res) => {
                if (res.status === 404) {
                    cameraConfigCacheRef.current[cameraId] = null;
                    return null;
                }
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || `Failed to fetch counting config for camera ${cameraId}`);
                }
                const data = await res.json().catch(() => null);
                cameraConfigCacheRef.current[cameraId] = data;
                return data;
            })
            .finally(() => {
                delete cameraConfigRequestRef.current[cameraId];
            });

        cameraConfigRequestRef.current[cameraId] = request;
        return request;
    }, [apiUrl]);

    useEffect(() => {
        const fetchCameras = async () => {
            try {
                const res = await fetch(`${apiUrl}/api/cameras`);
                const data = await res.json();
                const enabledCameras = sortCamerasAlphabetically(
                    (Array.isArray(data) ? data : []).filter((camera) => camera.enabled)
                );
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
            setPanelStatsByCamera({});
            setPanelCountingDataByCamera({});
            setLivePreviewLayout(null);
            setPanelLivePreviewLayouts({});
            return;
        }

        let cancelled = false;
        setCountingData({});
        setStats({ fps: 0, people_count: 0 });
        setPanelStatsByCamera({});
        setPanelCountingDataByCamera({});
        setPanelLivePreviewLayouts({});

        const fetchConfig = async () => {
            try {
                const data = await getCameraCountingConfig(selectedCamera);
                if (!data) {
                    if (!cancelled) {
                        resetCountingConfig();
                    }
                    return;
                }
                if (cancelled) {
                    return;
                }

                setLines(Array.isArray(data.lines) ? data.lines : []);
                setFrameExcludeAreas(filterValidFrameExcludeAreas(data.frame_exclude_areas));
                setEnabled(data.enabled ?? true);
                setParticipateInBuildingCount(data.participate_in_building_count ?? false);
                setBuildingId(data.building_id || data.entrance_id || '');
                setCrossCameraEnabled(data.cross_camera_enabled ?? false);
                setCrossCameraPairId(data.cross_camera_pair_id || '');
                setCrossCameraRole(data.cross_camera_role || 'none');
                setVerificationCameraId(data.verification_camera_id || '');
                setPrimaryInEventIdleTimeoutSec(String(data.primary_in_event_idle_timeout_sec ?? 7));
                setPrimaryOutEventIdleTimeoutSec(String(data.primary_out_event_idle_timeout_sec ?? 7));
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
    }, [selectedCamera, apiUrl, getCameraCountingConfig, resetCountingConfig]);

    useEffect(() => {
        setLivePreviewLayout(null);
        setPanelLivePreviewLayouts({});
    }, [selectedCamera, crossCameraRole, crossCameraEnabled]);

    useEffect(() => {
        const fetchBuildingConfig = async () => {
            try {
                const res = await fetch(`${apiUrl}/api/building-counting-config`);
                if (!res.ok) {
                    return;
                }
                const data = await res.json();
                setBuildingEnabled(data.enabled ?? true);
                setRegisteredBuildingIds(Array.isArray(data.building_ids) ? data.building_ids : []);
                setBuildingCapacityById(data.capacity_by_building_id ?? {});
                setBuildingManualOffset(String(data.manual_offset ?? 0));
            } catch (err) {
                console.error('Failed to fetch building counting config:', err);
            }
        };

        fetchBuildingConfig();
    }, [apiUrl]);

    useEffect(() => {
        stoppedPreviewStateRef.current = stoppedPreviewStateByCamera;
    }, [stoppedPreviewStateByCamera]);

    const buildingIdOptions = useMemo(() => Array.from(new Set([
        ...(Array.isArray(registeredBuildingIds) ? registeredBuildingIds : []),
        ...Object.keys(buildingSummary.entrance_summaries ?? {}),
        ...Object.keys(buildingCapacityById ?? {}),
    ]))
        .filter(Boolean)
        .sort((left, right) => String(left).localeCompare(String(right), undefined, {
            numeric: true,
            sensitivity: 'base',
        })), [buildingCapacityById, buildingSummary.entrance_summaries, registeredBuildingIds]);

    const cameraBuildingIdOptions = useMemo(() => Array.from(new Set([
        ...buildingIdOptions,
        ...(buildingId ? [buildingId] : []),
    ]))
        .filter(Boolean)
        .sort((left, right) => String(left).localeCompare(String(right), undefined, {
            numeric: true,
            sensitivity: 'base',
        })), [buildingId, buildingIdOptions]);

    useEffect(() => {
        if (selectedCapacityBuildingId.trim()) {
            return;
        }

        const normalizedBuildingId = buildingId.trim();
        const preferredBuildingId = normalizedBuildingId || buildingIdOptions[0] || '';

        if (preferredBuildingId !== selectedCapacityBuildingId) {
            setSelectedCapacityBuildingId(preferredBuildingId);
        }
    }, [buildingId, buildingIdOptions, selectedCapacityBuildingId]);

    useEffect(() => {
        const normalizedSelectedCapacityBuildingId = selectedCapacityBuildingId.trim();

        if (!normalizedSelectedCapacityBuildingId) {
            setBuildingMaxCapacity('');
            return;
        }

        const nextCapacity = buildingCapacityById?.[normalizedSelectedCapacityBuildingId];
        setBuildingMaxCapacity(nextCapacity ? String(nextCapacity) : '');
    }, [buildingCapacityById, selectedCapacityBuildingId]);

    const normalizedNewBuildingId = newBuildingId.trim();
    const duplicateNewBuildingId = useMemo(() => {
        if (!normalizedNewBuildingId) {
            return false;
        }

        return buildingIdOptions.some((option) => (
            String(option).trim().toLowerCase() === normalizedNewBuildingId.toLowerCase()
        ));
    }, [buildingIdOptions, normalizedNewBuildingId]);

    const handleAddBuildingId = useCallback(async () => {
        if (!normalizedNewBuildingId) {
            return;
        }

        setAddingBuildingId(true);
        setSaveMessage('');

        try {
            const nextRegisteredBuildingIds = Array.from(new Set([
                ...registeredBuildingIds.map((value) => String(value || '').trim()).filter(Boolean),
                normalizedNewBuildingId,
            ]));

            const res = await fetch(`${apiUrl}/api/building-counting-config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    building_ids: nextRegisteredBuildingIds,
                }),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || 'Failed to add building ID');
            }

            setSelectedCapacityBuildingId(normalizedNewBuildingId);
            if (!buildingId.trim()) {
                setBuildingId(normalizedNewBuildingId);
            }
            setNewBuildingId('');
            setSaveMessage(`Building ID '${normalizedNewBuildingId}' added successfully`);
            setAddingBuildingId(false);
            setTimeout(() => window.location.reload(), SUCCESS_REFRESH_DELAY_MS);
            return;
        } catch (err) {
            setSaveMessage(`Error: ${err.message}`);
            setTimeout(() => setSaveMessage(''), 3000);
        }
        setAddingBuildingId(false);
    }, [apiUrl, buildingId, normalizedNewBuildingId, registeredBuildingIds]);

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

        if (participateInBuildingCount && !buildingId.trim()) {
            setSaveMessage('Error: building ID is required for building counting.');
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
            const parsedPrimaryInEventIdleTimeoutSec = Number.parseFloat(primaryInEventIdleTimeoutSec);
            const parsedPrimaryOutEventIdleTimeoutSec = Number.parseFloat(primaryOutEventIdleTimeoutSec);
            const normalizedSelectedCapacityBuildingId = selectedCapacityBuildingId.trim();
            const normalizedRegisteredBuildingIds = Array.from(new Set(
                registeredBuildingIds
                    .map((value) => String(value || '').trim())
                    .filter(Boolean),
            ));

            if (!Number.isFinite(parsedPrimaryInEventIdleTimeoutSec) || parsedPrimaryInEventIdleTimeoutSec < 0) {
                throw new Error('Primary IN idle timeout must be 0 or greater.');
            }

            if (!Number.isFinite(parsedPrimaryOutEventIdleTimeoutSec) || parsedPrimaryOutEventIdleTimeoutSec < 0) {
                throw new Error('Primary OUT idle timeout must be 0 or greater.');
            }

            const body = {
                enabled,
                participate_in_building_count: participateInBuildingCount,
                building_id: participateInBuildingCount ? buildingId.trim() : null,
                cross_camera_enabled: crossCameraEnabled,
                cross_camera_pair_id: crossCameraEnabled ? crossCameraPairId.trim() : null,
                cross_camera_role: effectiveCrossCameraRole,
                verification_camera_id: crossCameraEnabled && effectiveCrossCameraRole === 'primary' ? verificationCameraId : null,
                primary_in_event_idle_timeout_sec: parsedPrimaryInEventIdleTimeoutSec,
                primary_out_event_idle_timeout_sec: parsedPrimaryOutEventIdleTimeoutSec,
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
            cameraConfigCacheRef.current[selectedCamera] = savedConfig;
            setLines(Array.isArray(savedConfig.lines) ? savedConfig.lines : []);
            setFrameExcludeAreas(filterValidFrameExcludeAreas(savedConfig.frame_exclude_areas));
            setEnabled(savedConfig.enabled ?? true);
            setParticipateInBuildingCount(savedConfig.participate_in_building_count ?? false);
            setBuildingId(savedConfig.building_id || savedConfig.entrance_id || '');
            setCrossCameraEnabled(savedConfig.cross_camera_enabled ?? false);
            setCrossCameraPairId(savedConfig.cross_camera_pair_id || '');
            setCrossCameraRole(savedConfig.cross_camera_role || 'none');
            setVerificationCameraId(savedConfig.verification_camera_id || '');
            setPrimaryInEventIdleTimeoutSec(String(savedConfig.primary_in_event_idle_timeout_sec ?? 7));
            setPrimaryOutEventIdleTimeoutSec(String(savedConfig.primary_out_event_idle_timeout_sec ?? 7));

            const buildingRes = await fetch(`${apiUrl}/api/building-counting-config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    enabled: buildingEnabled,
                    building_ids: normalizedRegisteredBuildingIds,
                    manual_offset: parseInt(buildingManualOffset || '0', 10) || 0,
                    ...(normalizedSelectedCapacityBuildingId
                        ? {
                            building_id: normalizedSelectedCapacityBuildingId,
                            max_capacity: buildingMaxCapacity ? parseInt(buildingMaxCapacity, 10) || 0 : 0,
                        }
                        : {}),
                }),
            });

            if (!buildingRes.ok) {
                const err = await buildingRes.json().catch(() => ({}));
                throw new Error(err.detail || 'Failed to save building counting config');
            }

            const savedBuildingConfig = await buildingRes.json();
            setBuildingEnabled(savedBuildingConfig.enabled ?? true);
            setRegisteredBuildingIds(Array.isArray(savedBuildingConfig.building_ids) ? savedBuildingConfig.building_ids : []);
            setBuildingCapacityById(savedBuildingConfig.capacity_by_building_id ?? {});
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

    const openResetConfirmation = (target) => {
        setConfirmDialog({
            kind: target === 'building' ? 'reset_building' : 'reset_camera',
        });
    };

    const openFormResetConfirmation = () => {
        setConfirmDialog({
            kind: 'reset_form',
        });
    };

    const openLineDeleteConfirmation = (lineId) => {
        const targetLine = lines.find((line) => line.id === lineId);
        setConfirmDialog({
            kind: 'delete_line',
            lineId,
            name: targetLine?.name || 'this line',
        });
    };

    const openAreaDeleteConfirmation = (areaId) => {
        const targetArea = frameExcludeAreas.find((area) => area.id === areaId);
        setConfirmDialog({
            kind: 'delete_area',
            areaId,
            name: targetArea?.name || 'this active zone',
        });
    };

    const openBuildingIdDeleteConfirmation = (targetBuildingId) => {
        const targetBuilding = selectedBuildingRegistryRow && selectedBuildingRegistryRow.buildingId === targetBuildingId
            ? selectedBuildingRegistryRow
            : null;
        setConfirmDialog({
            kind: 'delete_building_id',
            buildingId: targetBuildingId,
            activeCameraCount: targetBuilding?.activeCameraCount ?? 0,
        });
    };

    const closeConfirmationDialog = () => {
        if (resettingBuilding || resettingCamera || Boolean(deletingBuildingId)) {
            return;
        }
        setConfirmDialog(null);
    };

    const handleDeleteBuildingId = async (targetBuildingId) => {
        const normalizedTargetBuildingId = String(targetBuildingId || '').trim();
        if (!normalizedTargetBuildingId) {
            return;
        }

        setDeletingBuildingId(normalizedTargetBuildingId);
        setSaveMessage('');

        try {
            const deleteRes = await fetch(`${apiUrl}/api/building-counting-config/${encodeURIComponent(normalizedTargetBuildingId)}`, {
                method: 'DELETE',
            });

            if (!deleteRes.ok) {
                const err = await deleteRes.json().catch(() => ({}));
                throw new Error(err.detail || 'Failed to delete building ID');
            }

            const savedBuildingConfig = await deleteRes.json();
            setBuildingEnabled(savedBuildingConfig.enabled ?? true);
            setRegisteredBuildingIds(Array.isArray(savedBuildingConfig.building_ids) ? savedBuildingConfig.building_ids : []);
            setBuildingCapacityById(savedBuildingConfig.capacity_by_building_id ?? {});
            setBuildingManualOffset(String(savedBuildingConfig.manual_offset ?? 0));
            setSelectedCapacityBuildingId((current) => (
                current === normalizedTargetBuildingId ? '' : current
            ));

            const summaryRes = await fetch(`${apiUrl}/api/building-occupancy-summary`);
            if (summaryRes.ok) {
                setBuildingSummary(await summaryRes.json());
            }

            setSaveMessage(`Building ID '${normalizedTargetBuildingId}' deleted successfully`);
            setDeletingBuildingId('');
            setTimeout(() => window.location.reload(), SUCCESS_REFRESH_DELAY_MS);
            return;
        } catch (err) {
            setSaveMessage(`Error: ${err.message}`);
        }

        setDeletingBuildingId('');
        setTimeout(() => setSaveMessage(''), 3000);
    };

    const handleConfirmDialogConfirm = async () => {
        if (!confirmDialog) {
            return;
        }

        if (confirmDialog.kind === 'reset_building') {
            await handleResetBuildingTotals();
            setConfirmDialog(null);
            return;
        }

        if (confirmDialog.kind === 'reset_camera') {
            await handleResetSelectedCamera();
            setConfirmDialog(null);
            return;
        }

        if (confirmDialog.kind === 'reset_form') {
            resetCountingConfig();
            setSaveMessage('');
            setConfirmDialog(null);
            return;
        }

        if (confirmDialog.kind === 'delete_line') {
            setLines((prevLines) => prevLines.filter((line) => line.id !== confirmDialog.lineId));
            setConfirmDialog(null);
            return;
        }

        if (confirmDialog.kind === 'delete_area') {
            setFrameExcludeAreas((prevAreas) => prevAreas.filter((area) => area.id !== confirmDialog.areaId));
            setConfirmDialog(null);
            return;
        }

        if (confirmDialog.kind === 'delete_building_id') {
            await handleDeleteBuildingId(confirmDialog.buildingId);
            setConfirmDialog(null);
        }
    };

    const handleLineDrawn = useCallback(({ points, direction }) => {
        setLines((prevLines) => {
            const nextIndex = getNextNamedIndex(prevLines, 'Line');
            return [
                ...prevLines,
                {
                    id: `line_${Date.now()}`,
                    name: `Line ${nextIndex}`,
                    points,
                    direction: direction || 'left_to_right',
                    count_event: 'in',
                    line_type: 'occupancy',
                },
            ];
        });
        setDrawingMode(null);
    }, []);

    const handleFrameExcludeAreaDrawn = useCallback(({ points }) => {
        setFrameExcludeAreas((prevAreas) => {
            const nextIndex = getNextNamedIndex(prevAreas, 'Active Zone');
            return [
                ...prevAreas,
                {
                    id: `frame_exclude_${Date.now()}`,
                    name: `Active Zone ${nextIndex}`,
                    points,
                },
            ];
        });
        setDrawingMode(null);
    }, []);

    const deleteLine = (lineId) => openLineDeleteConfirmation(lineId);
    const deleteFrameExcludeArea = (areaId) => openAreaDeleteConfirmation(areaId);
    const toggleDirection = (lineId) => setLines((prevLines) => prevLines.map((line) => (
        line.id === lineId
            ? { ...line, direction: line.direction === 'left_to_right' ? 'right_to_left' : 'left_to_right' }
            : line
    )));
    const cycleLineMode = (lineId) => setLines((prevLines) => prevLines.map((line) => {
        if (line.id !== lineId) {
            return line;
        }

        const currentType = getLineType(line);
        if (currentType === 'foot_traffic') {
            return {
                ...line,
                line_type: 'occupancy',
                count_event: 'in',
            };
        }

        if (line.count_event === 'in') {
            return {
                ...line,
                count_event: 'out',
            };
        }

        return {
            ...line,
            line_type: 'foot_traffic',
        };
    }));
    const handleReset = () => openFormResetConfirmation();
    const handleStats = useCallback((nextStats) => {
        setStats(nextStats);
        setPanelStatsByCamera((current) => ({
            ...current,
            [selectedCamera]: nextStats,
        }));
    }, [selectedCamera]);
    const handleCountingData = useCallback((nextData) => {
        if (nextData && typeof nextData === 'object') {
            setCountingData(nextData);
            setPanelCountingDataByCamera((current) => ({
                ...current,
                [selectedCamera]: nextData,
            }));
        }
    }, [selectedCamera]);

    const handlePanelStats = useCallback((cameraId, nextStats) => {
        if (!cameraId) {
            return;
        }
        setPanelStatsByCamera((current) => ({
            ...current,
            [cameraId]: nextStats,
        }));
    }, []);

    const handlePanelCountingData = useCallback((cameraId, nextData) => {
        if (!cameraId || !nextData || typeof nextData !== 'object') {
            return;
        }
        setPanelCountingDataByCamera((current) => ({
            ...current,
            [cameraId]: nextData,
        }));
    }, []);

    const handlePanelMediaLayout = useCallback((cameraId, nextLayout) => {
        if (!cameraId || !nextLayout) {
            return;
        }
        setPanelLivePreviewLayouts((current) => ({
            ...current,
            [cameraId]: nextLayout,
        }));
    }, []);

    const selectedCam = cameras.find((camera) => camera.id === selectedCamera);
    const verificationCameraOptions = cameras.filter((camera) => camera.id !== selectedCamera);
    const selectedCameraLocation = String(selectedCam?.location || '').trim();
    const selectedCameraLabel = selectedCam?.name || 'Select a camera';
    const occupancy = countingData.occupancy ?? 0;
    const footTrafficLeft = countingData.foot_traffic_left ?? 0;
    const footTrafficRight = countingData.foot_traffic_right ?? 0;
    const footTrafficTotal = countingData.foot_traffic_total ?? 0;
    const footTrafficLabels = getFootTrafficSummaryLabels((Array.isArray(countingData.lines) && countingData.lines.length) ? countingData.lines : lines);
    const verifierActiveInEvent = countingData.verifier_active_in_event ?? null;
    const verifierActiveOutEvent = countingData.verifier_active_out_event ?? null;
    const verifierLastInEvent = countingData.verifier_last_in_event ?? null;
    const verifierLastOutEvent = countingData.verifier_last_out_event ?? null;
    const verifierPrimaryCameraIds = Array.isArray(countingData.verifier_primary_camera_ids) ? countingData.verifier_primary_camera_ids : [];
    const verifierPrimaryCameraIdsKey = verifierPrimaryCameraIds.filter(Boolean).sort().join('|');
    const occupancyLineCount = lines.filter((line) => getLineType(line) !== 'foot_traffic').length;
    const footTrafficLineCount = lines.filter((line) => getLineType(line) === 'foot_traffic').length;
    const buildingCapacityExceeded = buildingSummary.capacity_exceeded ?? false;
    const exceededBuildingIds = Array.isArray(buildingSummary.exceeded_building_ids)
        ? buildingSummary.exceeded_building_ids
        : [];
    const buildingGroupSummaries = buildingSummary.entrance_summaries ?? {};
    const selectedBuildingCapacitySummary = selectedCapacityBuildingId
        ? (buildingGroupSummaries[selectedCapacityBuildingId] || null)
        : null;
    const selectedBuildingRegistryRow = useMemo(() => {
        if (!selectedCapacityBuildingId) {
            return null;
        }

        const summary = buildingGroupSummaries[selectedCapacityBuildingId] || {};
        const activeCameraCountForBuilding = Array.isArray(summary.camera_ids) ? summary.camera_ids.length : 0;
        return {
            buildingId: selectedCapacityBuildingId,
            capacity: buildingCapacityById?.[selectedCapacityBuildingId] ?? null,
            occupancy: summary.occupancy ?? 0,
            activeCameraCount: activeCameraCountForBuilding,
            canDelete: activeCameraCountForBuilding === 0,
        };
    }, [buildingCapacityById, buildingGroupSummaries, selectedCapacityBuildingId]);
    const buildingUtilizationSubtitle = buildingSummary.max_capacity && Number(buildingSummary.max_capacity) > 0
        ? `Utilization rate ${Math.round(((buildingSummary.occupancy ?? 0) / Number(buildingSummary.max_capacity)) * 100)}%`
        : null;
    const selectedCameraRole = crossCameraRole === 'primary' ? 'primary' : crossCameraRole === 'verifier' ? 'verifier' : 'single';
    const resolvedVerifierPrimaryCameraId = verifierPrimaryCameraIds.find((cameraId) => cameraId && cameraId !== selectedCamera) || pairedPrimaryCameraId || '';
    const primaryPairReady = crossCameraEnabled
        && selectedCameraRole === 'primary'
        && Boolean(crossCameraPairId.trim())
        && Boolean(verificationCameraId)
        && pairedVerifierReady;
    const verifierPairReady = crossCameraEnabled
        && selectedCameraRole === 'verifier'
        && Boolean(crossCameraPairId.trim())
        && Boolean(resolvedVerifierPrimaryCameraId)
        && String(pairedPrimaryPairId || '').trim() === crossCameraPairId.trim();
    const verificationLayoutEnabled = primaryPairReady || verifierPairReady;
    const crossCameraWaitingMessage = !crossCameraEnabled
        ? ''
        : selectedCameraRole === 'primary'
            ? (!crossCameraPairId.trim()
                ? 'Enter a Pair ID to connect this primary camera.'
                : !verificationCameraId
                    ? 'Select the verification camera to complete the pair.'
                    : resolvingPairedVerifier
                        ? 'Waiting for the verification camera to finish pairing...'
                        : 'Waiting for the verification camera to enable cross-camera and use the same Pair ID.')
            : selectedCameraRole === 'verifier'
                ? (!pairedPrimaryCameraId
                    ? 'Waiting for a primary camera to select this verifier camera first.'
                    : !crossCameraPairId.trim()
                        ? `Enter the same Pair ID used by the primary camera${pairedPrimaryPairId ? ` (${pairedPrimaryPairId})` : ''}.`
                        : resolvingPairedPrimary
                            ? 'Waiting for the primary camera to finish pairing...'
                            : 'Waiting for the primary camera and verifier camera to use the same Pair ID.')
                : '';
    const primaryCameraId = selectedCameraRole === 'primary'
        ? selectedCamera
        : resolvedVerifierPrimaryCameraId;
    const verifierCameraId = selectedCameraRole === 'primary' ? verificationCameraId : selectedCamera;
    const primaryCamera = cameras.find((camera) => camera.id === primaryCameraId) || (selectedCameraRole === 'primary' ? selectedCam : null);
    const verifierCamera = cameras.find((camera) => camera.id === verifierCameraId) || (selectedCameraRole === 'verifier' ? selectedCam : null);
    const comparisonCamera = verificationLayoutEnabled
        ? (selectedCameraRole === 'primary' ? verifierCamera : primaryCamera)
        : null;
    const primarySummaryData = verificationLayoutEnabled
        ? (selectedCameraRole === 'primary' ? countingData : (panelCountingDataByCamera[primaryCameraId] || {}))
        : countingData;
    const verifierSummaryData = verificationLayoutEnabled
        ? (selectedCameraRole === 'verifier' ? countingData : (panelCountingDataByCamera[verifierCameraId] || {}))
        : {};
    const primarySummaryFootTrafficLeft = primarySummaryData.foot_traffic_left ?? 0;
    const primarySummaryFootTrafficRight = primarySummaryData.foot_traffic_right ?? 0;
    const primarySummaryFootTrafficTotal = primarySummaryData.foot_traffic_total ?? 0;
    const primarySummaryFootTrafficLabels = getFootTrafficSummaryLabels(
        (Array.isArray(primarySummaryData.lines) && primarySummaryData.lines.length)
            ? primarySummaryData.lines
            : (selectedCameraRole === 'primary' ? lines : []),
    );
    const verifierSummaryActiveInEvent = verifierSummaryData.verifier_active_in_event ?? verifierActiveInEvent ?? null;
    const verifierSummaryActiveOutEvent = verifierSummaryData.verifier_active_out_event ?? verifierActiveOutEvent ?? null;
    const verifierSummaryLastInEvent = verifierSummaryData.verifier_last_in_event ?? verifierLastInEvent ?? null;
    const verifierSummaryLastOutEvent = verifierSummaryData.verifier_last_out_event ?? verifierLastOutEvent ?? null;
    const verificationPairLabel = crossCameraPairId || verifierSummaryData.cross_camera_pair_id || countingData.cross_camera_pair_id || '-';

    const shouldUseStoppedUploadPreview = useCallback(
        (camera) => Boolean(camera?.is_uploaded && !camera?.producer_running),
        [],
    );

    const getStoppedPreviewState = useCallback(
        (cameraId) => stoppedPreviewStateByCamera[cameraId] || { image: '', frameSize: null, loading: false },
        [stoppedPreviewStateByCamera],
    );

    const displayedSplitCameras = useMemo(() => [
        primaryCamera,
        verifierCamera,
    ].filter((camera, index, current) => camera && current.findIndex((item) => item?.id === camera.id) === index), [primaryCamera, verifierCamera]);

    const displayedStoppedPreviewCameras = useMemo(
        () => (verificationLayoutEnabled ? displayedSplitCameras : [selectedCam])
            .filter((camera) => camera?.runtime_key && shouldUseStoppedUploadPreview(camera)),
        [displayedSplitCameras, selectedCam, shouldUseStoppedUploadPreview, verificationLayoutEnabled],
    );

    useEffect(() => {
        let cancelled = false;

        const resolvePairedPrimaryCamera = async () => {
            if (!selectedCamera || !crossCameraEnabled || verificationCameraId) {
                setPairedPrimaryCameraId('');
                setPairedPrimaryPairId('');
                setResolvingPairedPrimary(false);
                return;
            }

            const livePrimaryCameraId = verifierPrimaryCameraIds.find((cameraId) => cameraId && cameraId !== selectedCamera);
            if (livePrimaryCameraId) {
                setPairedPrimaryCameraId(livePrimaryCameraId);
                setPairedPrimaryPairId(String(countingData.cross_camera_pair_id || '').trim());
                setResolvingPairedPrimary(false);
                return;
            }

            const candidateCameras = cameras.filter((camera) => camera.id !== selectedCamera);
            if (!candidateCameras.length) {
                setPairedPrimaryCameraId('');
                setPairedPrimaryPairId('');
                setResolvingPairedPrimary(false);
                return;
            }

            const lookupCacheKey = JSON.stringify({
                selectedCamera,
                candidateCameraIds: candidateCameras.map((camera) => camera.id).sort(),
            });
            if (Object.prototype.hasOwnProperty.call(pairedPrimaryLookupCacheRef.current, lookupCacheKey)) {
                const cached = pairedPrimaryLookupCacheRef.current[lookupCacheKey] || {};
                setPairedPrimaryCameraId(cached.cameraId || '');
                setPairedPrimaryPairId(cached.pairId || '');
                setResolvingPairedPrimary(false);
                return;
            }

            setResolvingPairedPrimary(true);
            try {
                const candidateConfigs = await Promise.all(candidateCameras.map(async (camera) => {
                    try {
                        const data = await getCameraCountingConfig(camera.id);
                        if (!data) {
                            return null;
                        }
                        const isTargetPrimary = Boolean(data.cross_camera_enabled)
                            && data.cross_camera_role === 'primary'
                            && data.verification_camera_id === selectedCamera;
                        return isTargetPrimary
                            ? {
                                cameraId: camera.id,
                                pairId: String(data.cross_camera_pair_id || '').trim(),
                            }
                            : null;
                    } catch {
                        return null;
                    }
                }));

                if (!cancelled) {
                    const matchingCandidate = candidateConfigs.find((candidate) => candidate && candidate.pairId && candidate.pairId === crossCameraPairId.trim());
                    const fallbackCandidate = candidateConfigs.find(Boolean) || null;
                    const resolvedPrimary = matchingCandidate || fallbackCandidate || { cameraId: '', pairId: '' };
                    pairedPrimaryLookupCacheRef.current[lookupCacheKey] = resolvedPrimary;
                    setPairedPrimaryCameraId(resolvedPrimary.cameraId || '');
                    setPairedPrimaryPairId(resolvedPrimary.pairId || '');
                }
            } catch (err) {
                if (!cancelled) {
                    console.error('Failed to resolve paired primary camera:', err);
                    pairedPrimaryLookupCacheRef.current[lookupCacheKey] = { cameraId: '', pairId: '' };
                    setPairedPrimaryCameraId('');
                    setPairedPrimaryPairId('');
                }
            } finally {
                if (!cancelled) {
                    setResolvingPairedPrimary(false);
                }
            }
        };

        resolvePairedPrimaryCamera();
        return () => {
            cancelled = true;
        };
    }, [apiUrl, cameras, countingData.cross_camera_pair_id, crossCameraEnabled, crossCameraPairId, getCameraCountingConfig, selectedCamera, verificationCameraId, verifierPrimaryCameraIdsKey]);

    useEffect(() => {
        let cancelled = false;

        const resolvePairedVerifier = async () => {
            if (!selectedCamera || !crossCameraEnabled || !crossCameraPairId || !verificationCameraId) {
                setPairedVerifierReady(false);
                setResolvingPairedVerifier(false);
                return;
            }

            setResolvingPairedVerifier(true);
            try {
                const data = await getCameraCountingConfig(verificationCameraId);
                if (cancelled) {
                    return;
                }

                const isReady = Boolean(data?.cross_camera_enabled)
                    && String(data?.cross_camera_pair_id || '').trim() === crossCameraPairId.trim()
                    && String(data?.cross_camera_role || 'none') === 'verifier';

                setPairedVerifierReady(isReady);
            } catch (err) {
                if (!cancelled) {
                    console.error('Failed to resolve paired verifier camera:', err);
                    setPairedVerifierReady(false);
                }
            } finally {
                if (!cancelled) {
                    setResolvingPairedVerifier(false);
                }
            }
        };

        resolvePairedVerifier();
        return () => {
            cancelled = true;
        };
    }, [crossCameraEnabled, crossCameraPairId, getCameraCountingConfig, selectedCamera, verificationCameraId]);

    useEffect(() => {
        if (!crossCameraEnabled) {
            if (crossCameraRole !== 'none') {
                setCrossCameraRole('none');
            }
            return;
        }

        const nextRole = verificationCameraId || !pairedPrimaryCameraId ? 'primary' : 'verifier';

        if (crossCameraRole !== nextRole) {
            setCrossCameraRole(nextRole);
        }
    }, [
        crossCameraEnabled,
        crossCameraRole,
        pairedPrimaryCameraId,
        verificationCameraId,
    ]);

    useEffect(() => {
        const loadStoppedPreviews = async () => {
            if (!displayedStoppedPreviewCameras.length) {
                return;
            }

            await Promise.all(displayedStoppedPreviewCameras.map(async (camera) => {
                await loadStoppedPreviewForCamera(camera);
            }));
        };

        loadStoppedPreviews();
    }, [displayedStoppedPreviewCameras, loadStoppedPreviewForCamera]);

    useEffect(() => {
        if (!verificationLayoutEnabled || !comparisonCamera?.id || comparisonCamera.id === selectedCamera) {
            setComparisonCameraConfig(null);
            return;
        }

        let cancelled = false;

        const fetchComparisonConfig = async () => {
            try {
                const data = await getCameraCountingConfig(comparisonCamera.id);
                if (!cancelled) {
                    setComparisonCameraConfig(data);
                }
            } catch (err) {
                console.error('Failed to fetch paired camera counting config:', err);
                if (!cancelled) {
                    setComparisonCameraConfig(null);
                }
            }
        };

        fetchComparisonConfig();
        return () => {
            cancelled = true;
        };
    }, [comparisonCamera?.id, getCameraCountingConfig, selectedCamera, verificationLayoutEnabled]);

    const topSummary = verificationLayoutEnabled ? (
        <div className="grid gap-4 xl:grid-cols-2">
            <div className="rounded-3xl border border-slate-200 bg-white/70 p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-blue-400/40 bg-blue-500/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-700">
                        Primary Camera Stats
                    </span>
                    <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-3 py-1 text-[11px] font-semibold text-amber-700">
                        Pair: {verificationPairLabel}
                    </span>
                    {selectedCameraRole === 'primary' && (
                        <span className="rounded-full border border-emerald-400/35 bg-emerald-500/12 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                            Selected
                        </span>
                    )}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                    <StatTile label="Door In" value={primarySummaryData.total_in ?? 0} icon={ArrowDownToLine} tone="green" subtitle="Cross inward counts" />
                    <StatTile label="Door Out" value={primarySummaryData.total_out ?? 0} icon={ArrowUpFromLine} tone="red" subtitle="Cross outward counts" />
                    <StatTile label="Inside Now" value={primarySummaryData.occupancy ?? 0} icon={Users} tone="default" subtitle="Camera-level occupancy" />
                    <StatTile
                        label="Foot Traffic"
                        value={primarySummaryFootTrafficTotal}
                        icon={ArrowRightLeft}
                        tone="cyan"
                        subtitle={primarySummaryFootTrafficLabels.mixed
                            ? 'Mixed FT line orientations'
                            : `${primarySummaryFootTrafficLabels.negative} ${primarySummaryFootTrafficLeft} / ${primarySummaryFootTrafficLabels.positive} ${primarySummaryFootTrafficRight}`}
                    />
                </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white/70 p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-emerald-400/45 bg-emerald-500/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-700">
                        Verifier Camera Stats
                    </span>
                    {selectedCameraRole === 'verifier' && (
                        <span className="rounded-full border border-emerald-400/35 bg-emerald-500/12 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                            Selected
                        </span>
                    )}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                    <StatTile
                        label="Active In"
                        value={verifierSummaryActiveInEvent?.verifier_count ?? 0}
                        icon={ArrowDownToLine}
                        tone="green"
                        subtitle={verifierSummaryActiveInEvent ? `Primary ${verifierSummaryActiveInEvent.primary_count ?? 0}` : 'No active IN event'}
                    />
                    <StatTile
                        label="Active Out"
                        value={verifierSummaryActiveOutEvent?.verifier_count ?? 0}
                        icon={ArrowUpFromLine}
                        tone="red"
                        subtitle={verifierSummaryActiveOutEvent ? `Primary ${verifierSummaryActiveOutEvent.primary_count ?? 0}` : 'No active OUT event'}
                    />
                    <StatTile
                        label="Last In"
                        value={verifierSummaryLastInEvent?.verifier_count ?? 0}
                        icon={ArrowDownToLine}
                        tone="green"
                        subtitle={verifierSummaryLastInEvent ? `Primary ${verifierSummaryLastInEvent.primary_count ?? 0}` : 'No completed IN event'}
                    />
                    <StatTile
                        label="Last Out"
                        value={verifierSummaryLastOutEvent?.verifier_count ?? 0}
                        icon={ArrowUpFromLine}
                        tone="red"
                        subtitle={verifierSummaryLastOutEvent ? `Primary ${verifierSummaryLastOutEvent.primary_count ?? 0}` : 'No completed OUT event'}
                    />
                </div>
            </div>
        </div>
    ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Door In" value={countingData.total_in ?? 0} icon={ArrowDownToLine} tone="green" subtitle="Cross inward counts" />
            <StatTile label="Door Out" value={countingData.total_out ?? 0} icon={ArrowUpFromLine} tone="red" subtitle="Cross outward counts" />
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

    const renderCameraSurface = ({ camera, role, containerRef, isSelected }) => {
        const roleLabel = role === 'primary' ? 'Primary Camera' : 'Verifier Camera';
        const roleTone = role === 'primary'
            ? 'bg-blue-500/15 text-blue-100 border-blue-400/30'
            : 'bg-amber-500/15 text-amber-100 border-amber-400/30';

        if (!camera) {
            return (
                <div className="flex h-full min-h-[360px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-950 md:min-h-[480px] xl:min-h-[620px]">
                    <div className="border-b border-white/10 bg-white/5 px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', roleTone)}>
                                {roleLabel}
                            </span>
                            {isSelected && (
                                <span className="rounded-full border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-white/80">
                                    Selected for editing
                                </span>
                            )}
                        </div>
                        <div className="mt-2 text-sm font-semibold text-white">{roleLabel} unavailable</div>
                        <div className="mt-1 text-xs text-white/60">
                            {role === 'primary' && resolvingPairedPrimary
                                ? 'Resolving the paired primary camera...'
                                : `No ${role.toLowerCase()} camera is configured for this verification pair.`}
                        </div>
                    </div>
                    <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-white/60">
                        Connect both cameras in Cross-Camera Verification to compare them side by side.
                    </div>
                </div>
            );
        }

        const location = String(camera.location || '').trim();
        const wsUrl = getWSUrl(`/ws/${camera.id}`);
        const useStoppedPreview = shouldUseStoppedUploadPreview(camera);
        const stoppedPreview = getStoppedPreviewState(camera.id);
        const panelTitle = camera.name || roleLabel;
        const panelStats = panelStatsByCamera[camera.id] || { fps: 0, people_count: 0 };
        const panelCountingData = panelCountingDataByCamera[camera.id] || {};
        const panelFootTrafficLeft = panelCountingData.foot_traffic_left ?? 0;
        const panelFootTrafficRight = panelCountingData.foot_traffic_right ?? 0;
        const panelFootTrafficTotal = panelCountingData.foot_traffic_total ?? 0;
        const panelFootTrafficLabels = getFootTrafficSummaryLabels(Array.isArray(panelCountingData.lines) ? panelCountingData.lines : []);
        const comparisonOverlayActive = !isSelected && comparisonCamera?.id === camera.id && comparisonCameraConfig;
        const overlayLines = isSelected
            ? lines
            : (comparisonOverlayActive ? (Array.isArray(comparisonCameraConfig?.lines) ? comparisonCameraConfig.lines : []) : []);
        const overlayFrameExcludeAreas = isSelected
            ? validFrameExcludeAreas
            : (comparisonOverlayActive ? filterValidFrameExcludeAreas(comparisonCameraConfig?.frame_exclude_areas) : []);
        const overlayCountingData = isSelected ? countingData : panelCountingData;
        const overlayDisplayArea = useStoppedPreview
            ? null
            : (isSelected ? livePreviewLayout : panelLivePreviewLayouts[camera.id] || null);

        return (
            <div className="flex h-full min-h-[360px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-950 md:min-h-[480px] xl:min-h-[620px]">
                <div className="border-b border-white/10 bg-white/5 px-4 py-3">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                            <div className="flex flex-wrap items-center gap-2">
                                <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', roleTone)}>
                                    {roleLabel}
                                </span>
                                {isSelected && (
                                    <span className="rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-200">
                                        Selected for editing
                                    </span>
                                )}
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                                <div className="text-sm font-semibold text-white">{panelTitle}</div>
                                <div className="text-xs text-white/60">
                                    {location || 'No location configured'}
                                </div>
                            </div>
                        </div>

                        <div className="flex flex-wrap gap-2 text-xs text-white/70">
                            <span className="rounded-full border border-white/15 px-3 py-1">People {panelStats.people_count ?? 0}</span>
                            <span className="rounded-full border border-white/15 px-3 py-1">FPS {panelStats.fps ?? 0}</span>
                        </div>
                    </div>
                </div>

                <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden bg-black">
                    {useStoppedPreview ? (
                        stoppedPreview.image ? (
                            <img
                                src={stoppedPreview.image}
                                alt={panelTitle}
                                className="absolute inset-0 h-full w-full object-contain"
                            />
                        ) : (
                            <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
                                <p>{stoppedPreview.loading ? 'Loading preview...' : 'Preview unavailable for this uploaded video.'}</p>
                            </div>
                        )
                    ) : (
                        <StreamPlayer
                            wsUrl={wsUrl}
                            className="absolute inset-0 h-full w-full"
                            alt={panelTitle}
                            onStats={isSelected ? handleStats : (nextStats) => handlePanelStats(camera.id, nextStats)}
                            onCountingData={isSelected ? handleCountingData : (nextData) => handlePanelCountingData(camera.id, nextData)}
                            onMediaLayout={isSelected ? setLivePreviewLayout : (nextLayout) => handlePanelMediaLayout(camera.id, nextLayout)}
                            showCountingAnchors={isSelected}
                            overlayMode="counting"
                        />
                    )}

                    {(isSelected || comparisonOverlayActive) && (
                        <CountingCanvas
                            lines={overlayLines}
                            frameExcludeAreas={overlayFrameExcludeAreas}
                            countingData={overlayCountingData}
                            drawingMode={isSelected ? drawingMode : null}
                            onLineDrawn={isSelected ? handleLineDrawn : undefined}
                            onFrameExcludeAreaDrawn={isSelected ? handleFrameExcludeAreaDrawn : undefined}
                            containerRef={containerRef}
                            mediaSize={useStoppedPreview ? stoppedPreview.frameSize : null}
                            displayArea={overlayDisplayArea}
                            showLiveSummary={false}
                        />
                    )}
                </div>
            </div>
        );
    };

    const setupContent = (
        <div className="space-y-4">
            <SectionShell
                title="Counting Geometry"
                description="Draw lines here, tag them as occupancy or foot traffic(FT), and keep the active zone nearby."
                collapsible
                collapsed={collapsedSetupSections.geometry}
                onToggle={() => toggleSetupSection('geometry')}
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
                            No lines yet. Draw one on the preview, then use the mode button to cycle `Door IN`, `Door OUT`, and `Foot Traffic`.
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
                                            {getLineDirectionDisplay(line)}
                                        </span>
                                    </div>
                                </div>
                                <div className="flex items-center gap-1">
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-8 w-8"
                                            onClick={() => cycleLineMode(line.id)}
                                            title="Cycle line mode: Door IN -> Door OUT -> Foot Traffic"
                                        >
                                            {isFootTraffic
                                                ? <span className="text-[10px] font-bold text-cyan-400">FT</span>
                                                : line.count_event === 'out'
                                                    ? <ArrowUpFromLine className="h-3.5 w-3.5 text-red-500" />
                                                    : <ArrowDownToLine className="h-3.5 w-3.5 text-yellow-500" />}
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-8 w-8"
                                            onClick={() => toggleDirection(line.id)}
                                            title={isFootTraffic
                                                ? `Foot traffic direction: ${getLineDirectionDisplay(line)}`
                                                : `Direction: ${line.direction === 'left_to_right' ? 'R->L' : 'L->R'}`}
                                        >
                                            <ArrowRightLeft className="h-3.5 w-3.5" />
                                        </Button>
                                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => deleteLine(line.id)}>
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
                {drawingMode === 'line' && <p className="text-xs text-muted-foreground">Draw directly on the preview. New lines start as `Door IN`, and the mode button cycles `Door IN`, `Door OUT`, and `Foot Traffic`.</p>}
            </SectionShell>

            <SectionShell
                title="Active Counting Zone"
                description="Occupancy counts only trigger when the counting probe point is inside this polygon. Foot-traffic lines can be placed outside the entrance path."
                collapsible
                collapsed={collapsedSetupSections.activeZone}
                onToggle={() => toggleSetupSection('activeZone')}
                action={(
                    <Button variant={drawingMode === 'frame_exclude' ? 'default' : 'outline'} size="sm" className="h-9" onClick={() => setDrawingMode(drawingMode === 'frame_exclude' ? null : 'frame_exclude')}>
                        <PenTool className="mr-2 h-3.5 w-3.5" />
                        {drawingMode === 'frame_exclude' ? 'Cancel Area' : 'Draw Area'}
                    </Button>
                )}
            >
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

            <SectionShell
                title="Building Group"
                description="Only cameras with the same building ID are merged into one building total group."
                collapsible
                collapsed={collapsedSetupSections.buildingGroup}
                onToggle={() => toggleSetupSection('buildingGroup')}
            >
                <div className="flex items-center justify-between rounded-2xl border border-border/70 bg-background px-4 py-3">
                    <div>
                        <div className="text-sm font-medium">Use Building ID</div>
                        <div className="text-xs text-muted-foreground">Turn this on only for cameras that should belong to a building group.</div>
                    </div>
                    <Toggle checked={participateInBuildingCount} onClick={() => setParticipateInBuildingCount(!participateInBuildingCount)} />
                </div>
                {participateInBuildingCount && (
                    <div className="space-y-2">
                        <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Building ID</label>
                        <select
                            className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
                            value={buildingId}
                            onChange={(e) => setBuildingId(e.target.value)}
                            disabled={!cameraBuildingIdOptions.length}
                        >
                            <option value="">
                                {cameraBuildingIdOptions.length > 0
                                    ? 'Select a building ID'
                                    : 'Create a building ID in the Building tab first'}
                            </option>
                            {cameraBuildingIdOptions.map((option) => (
                                <option key={option} value={option}>{option}</option>
                            ))}
                        </select>
                        <p className="text-xs text-muted-foreground">
                            {cameraBuildingIdOptions.length > 0
                                ? 'Camera grouping now uses the building IDs created in the Building tab.'
                                : 'No building IDs exist yet. Create one in the Building tab before assigning this camera.'}
                        </p>
                    </div>
                )}
            </SectionShell>

            <SectionShell
                title="Cross-Camera Verification"
                description="Pair two cameras covering the same entrance so the verification camera can correct missed IN and OUT counts from the primary camera."
                collapsible
                collapsed={collapsedSetupSections.crossCamera}
                onToggle={() => toggleSetupSection('crossCamera')}
            >
                <div className="flex items-center justify-between rounded-2xl border border-border/70 bg-background px-4 py-3">
                    <div>
                        <div className="text-sm font-medium">Verification Enabled</div>
                        <div className="text-xs text-muted-foreground"></div>
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
                        <div className="space-y-2 sm:col-span-2">
                            <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Pair ID</label>
                            <input type="text" className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm" value={crossCameraPairId} onChange={(e) => setCrossCameraPairId(e.target.value)} placeholder="entrance_pair_1" />
                        </div>
                        {crossCameraRole === 'primary' && (
                            <div className="space-y-2 sm:col-span-2">
                                <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Verification Camera</label>
                                <select className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm" value={verificationCameraId} onChange={(e) => setVerificationCameraId(e.target.value)}>
                                    <option value="">Select verifier camera</option>
                                    {verificationCameraOptions.map((camera) => (
                                        <option key={camera.id} value={camera.id}>{getCameraOptionLabel(camera)}</option>
                                    ))}
                                </select>
                            </div>
                        )}
                        {crossCameraRole === 'primary' && primaryPairReady && (
                            <>
                                <div className="space-y-2">
                                    <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">IN Idle Timeout (sec)</label>
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.1"
                                        className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
                                        value={primaryInEventIdleTimeoutSec}
                                        onChange={(e) => setPrimaryInEventIdleTimeoutSec(e.target.value)}
                                        placeholder="7.0"
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        How long to wait after the last primary IN event before closing that verification window.
                                    </p>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">OUT Idle Timeout (sec)</label>
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.1"
                                        className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
                                        value={primaryOutEventIdleTimeoutSec}
                                        onChange={(e) => setPrimaryOutEventIdleTimeoutSec(e.target.value)}
                                        placeholder="7.0"
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        How long to wait after the last primary OUT event before closing that verification window.
                                    </p>
                                </div>
                            </>
                        )}
                        <div className="sm:col-span-2">
                            <div className={cn(
                                'rounded-xl border px-3 py-2 text-sm',
                                verificationLayoutEnabled
                                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                    : 'border-amber-200 bg-amber-50 text-amber-700',
                            )}>
                                {verificationLayoutEnabled
                                    ? 'Pair connected. Cross-camera verification is ready.'
                                    : (crossCameraWaitingMessage || 'Waiting for pairing.')}
                            </div>
                        </div>
                    </div>
                )}
            </SectionShell>

        </div>
    );

    const buildingContent = (
        <div className="space-y-4">
            <SectionShell
                title="Building Occupancy"
                description="Configure grouped occupancy, capacity alerts, and manual offsets for cameras that share the same building ID."
                collapsible
                collapsed={collapsedBuildingSections.occupancy}
                onToggle={() => toggleBuildingSection('occupancy')}
            >
                <div className="flex items-center justify-between rounded-2xl border border-border/70 bg-background px-4 py-3">
                    <div>
                        <div className="text-sm font-medium">Building Counting Enabled</div>
                        <div className="text-xs text-muted-foreground">Use grouped entrance totals to drive occupancy alerts.</div>
                    </div>
                    <Toggle checked={buildingEnabled} onClick={() => setBuildingEnabled(!buildingEnabled)} />
                </div>
                {buildingEnabled && (
                    <>
                        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                            <div className="space-y-2">
                                <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">New Building ID</label>
                                <input
                                    type="text"
                                    className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
                                    value={newBuildingId}
                                    onChange={(e) => setNewBuildingId(e.target.value)}
                                    placeholder="building_1"
                                />
                                {duplicateNewBuildingId && (
                                    <p className="text-xs text-amber-600">
                                        This building ID already exists. Select it below in `Manage Building ID`.
                                    </p>
                                )}
                            </div>
                            <div className="flex items-end">
                                <Button
                                    type="button"
                                    variant="outline"
                                    className="w-full sm:w-auto"
                                    onClick={handleAddBuildingId}
                                    disabled={!normalizedNewBuildingId || duplicateNewBuildingId || addingBuildingId}
                                >
                                    {addingBuildingId ? 'Adding...' : 'Add Building ID'}
                                </Button>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Manage Building ID</label>
                            <select
                                className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
                                value={selectedCapacityBuildingId}
                                onChange={(e) => setSelectedCapacityBuildingId(e.target.value)}
                                disabled={!buildingIdOptions.length}
                            >
                                <option value="">
                                    {buildingIdOptions.length > 0 ? 'Select a building ID' : 'Add a building ID first'}
                                </option>
                                {buildingIdOptions.map((option) => (
                                    <option key={option} value={option}>{option}</option>
                                ))}
                            </select>
                            <p className="text-xs text-muted-foreground">
                                {buildingIdOptions.length > 0
                                    ? 'Choose one building ID to manage its settings and remove it if needed.'
                                    : 'No building IDs exist yet. Add the first one above.'}
                            </p>
                        </div>
                        {selectedCapacityBuildingId.trim() && (
                            <>
                                <div className="grid gap-3 sm:grid-cols-2">
                                    <div className="space-y-2">
                                        <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Building Capacity</label>
                                        <input
                                            type="number"
                                            min="1"
                                            placeholder="e.g. 200"
                                            className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
                                            value={buildingMaxCapacity}
                                            onChange={(e) => setBuildingMaxCapacity(e.target.value)}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Manual Offset</label>
                                        <input
                                            type="number"
                                            className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
                                            value={buildingManualOffset}
                                            onChange={(e) => setBuildingManualOffset(e.target.value)}
                                        />
                                    </div>
                                </div>
                                <div className="grid gap-3 sm:grid-cols-3">
                                    <StatTile label="Building In" value={buildingSummary.raw_in ?? 0} icon={ArrowDownToLine} tone="green" />
                                    <StatTile label="Building Out" value={buildingSummary.raw_out ?? 0} icon={ArrowUpFromLine} tone="red" />
                                    <StatTile label="Building Now" value={buildingSummary.occupancy ?? 0} icon={Building2} tone={buildingCapacityExceeded ? 'amber' : 'default'} subtitle={buildingUtilizationSubtitle} />
                                </div>
                                <div className="rounded-2xl border border-border/70 bg-background px-4 py-3 text-sm text-muted-foreground">
                                    Active cameras: {buildingSummary.active_camera_count ?? 0} | Raw occupancy: {buildingSummary.raw_occupancy ?? 0} | Manual offset: {buildingSummary.manual_offset ?? 0}
                                </div>
                                {buildingCapacityExceeded && (
                                    <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500">
                                        {exceededBuildingIds.length > 0
                                            ? `Capacity exceeded for: ${exceededBuildingIds.join(', ')}.`
                                            : 'Building capacity exceeded.'}
                                    </div>
                                )}
                                {selectedBuildingRegistryRow && (
                                    <div className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-background px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                                        <div className="min-w-0 flex-1">
                                            <div className="text-sm font-medium">{selectedBuildingRegistryRow.buildingId}</div>
                                            <div className="mt-1 text-xs text-muted-foreground">
                                                Capacity: {selectedBuildingRegistryRow.capacity ?? 'Not set'} | Occupancy: {selectedBuildingRegistryRow.occupancy ?? 0} | Active cameras: {selectedBuildingRegistryRow.activeCameraCount}
                                            </div>
                                            {!selectedBuildingRegistryRow.canDelete && (
                                                <div className="mt-2 text-xs text-amber-600">
                                                    Remove this building ID from all active cameras before deleting it.
                                                </div>
                                            )}
                                        </div>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            className="border-red-200 text-red-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700"
                                            onClick={() => openBuildingIdDeleteConfirmation(selectedBuildingRegistryRow.buildingId)}
                                            disabled={!selectedBuildingRegistryRow.canDelete || deletingBuildingId === selectedBuildingRegistryRow.buildingId}
                                        >
                                            <Trash2 className="mr-2 h-3.5 w-3.5" />
                                            {deletingBuildingId === selectedBuildingRegistryRow.buildingId ? 'Deleting...' : 'Delete Building ID'}
                                        </Button>
                                    </div>
                                )}
                                <Button variant="outline" size="sm" className="w-full" onClick={() => openResetConfirmation('building')} disabled={resettingBuilding}>
                                    <RotateCcw className="mr-2 h-3.5 w-3.5" />
                                    {resettingBuilding ? 'Resetting Building Totals...' : 'Reset Building Totals'}
                                </Button>
                            </>
                        )}
                    </>
                )}
            </SectionShell>

            {Object.keys(buildingGroupSummaries).length > 0 && (
                <SectionShell
                    title="Building Rollups"
                    description="These grouped building-ID totals feed the building occupancy summary."
                    collapsible
                    collapsed={collapsedBuildingSections.rollups}
                    onToggle={() => toggleBuildingSection('rollups')}
                >
                    <div className="grid gap-3">
                        {Object.entries(buildingGroupSummaries).map(([buildingGroupId, entrance]) => (
                            <div key={buildingGroupId} className="rounded-2xl border border-border/70 bg-background px-4 py-3">
                                <div className="text-sm font-medium">{buildingGroupId}</div>
                                <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                                    <div>Cameras: {(entrance.camera_ids || []).length}</div>
                                    <div>IN / OUT: {entrance.total_in ?? 0} / {entrance.total_out ?? 0}</div>
                                    <div>Occupancy: {entrance.occupancy ?? 0}</div>
                                </div>
                                <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                                    <div>Capacity: {entrance.max_capacity ?? 'Not set'}</div>
                                    <div>{entrance.capacity_exceeded ? 'Alert active' : 'Within capacity'}</div>
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
            <div className="flex justify-end">
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSidebarCollapsed(true)}
                    className="h-9 rounded-xl border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                >
                    <ChevronLeft className="mr-1.5 h-4 w-4" />
                    Hide Configuration Bar
                </Button>
            </div>
            <Card className="border-slate-200/80 bg-white/95 shadow-sm">
                <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => setCollapsedConfigurationPanel((current) => !current)}
                                    className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-700"
                                    aria-label={`${collapsedConfigurationPanel ? 'Expand' : 'Collapse'} configuration`}
                                >
                                    <ChevronDown
                                        className={cn(
                                            'h-4 w-4 transition-transform duration-300 ease-out',
                                            collapsedConfigurationPanel ? '-rotate-90' : 'rotate-0',
                                        )}
                                    />
                                </button>
                                <CardTitle className="text-xl">Configuration</CardTitle>
                            </div>
                            {collapsedConfigurationPanel && (
                                <p className="text-sm text-muted-foreground">
                                    {selectedCameraLabel}{selectedCameraLocation ? ` - ${selectedCameraLocation}` : ''}
                                </p>
                            )}
                            {/* <p className="text-sm text-muted-foreground">A cleaner control rail with the most important inputs aligned first.</p> */}
                        </div>
                    </div>
                </CardHeader>
                <div
                    className={cn(
                        'grid transition-[grid-template-rows,opacity,transform] duration-300 ease-out',
                        collapsedConfigurationPanel ? 'grid-rows-[0fr] opacity-0 -translate-y-1' : 'grid-rows-[1fr] opacity-100 translate-y-0',
                    )}
                >
                    <div className="min-h-0 overflow-hidden">
                        <CardContent className="space-y-5 pt-0">
                            <div className="rounded-3xl border border-slate-200 bg-slate-50/70 p-4">
                                <div className="space-y-4">
                                    <div className="space-y-2">
                                        <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Selected Camera</label>
                                        <select className="flex h-11 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm" value={selectedCamera} onChange={(e) => setSelectedCamera(e.target.value)}>
                                            {cameras.length === 0 && <option value="">No cameras available</option>}
                                            {cameras.map((camera) => (
                                                <option key={camera.id} value={camera.id}>{getCameraOptionLabel(camera)}</option>
                                            ))}
                                        </select>
                                    </div>

                                    <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                                        <div>
                                            <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Counting</div>
                                            <div className="mt-1 text-sm font-medium">{enabled ? 'Enabled' : 'Disabled'}</div>
                                            <div className="text-xs text-muted-foreground">Camera-level counting runtime</div>
                                        </div>
                                        <Toggle checked={enabled} onClick={() => setEnabled(!enabled)} />
                                    </div>

                                    <div className="grid grid-cols-3 gap-2">
                                        <div className="rounded-2xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
                                            <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Door Lines</div>
                                            <div className="mt-1 text-lg font-semibold">{occupancyLineCount}</div>
                                        </div>
                                        <div className="rounded-2xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
                                            <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">FT Lines</div>
                                            <div className="mt-1 text-lg font-semibold">{footTrafficLineCount}</div>
                                        </div>
                                        <div className="rounded-2xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
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
                                            activeTab === tab.id ? 'border-primary bg-primary/10 text-foreground' : 'border-slate-200 bg-white text-muted-foreground hover:text-foreground',
                                        )}
                                    >
                                        <div className="font-medium">{tab.label}</div>
                                        <div className="mt-1 text-xs leading-5">{tab.hint}</div>
                                    </button>
                                ))}
                            </div>
                        </CardContent>
                    </div>
                </div>
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
            <Card className="overflow-hidden border-slate-200/80 bg-white/95 shadow-sm">
                {!verificationLayoutEnabled && (
                    <CardHeader className="border-b border-white/10 bg-black/80 pb-3 text-white">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                            <div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <CardTitle className="text-lg text-white">
                                        {selectedCameraLabel || 'Preview'}
                                    </CardTitle>
                                    {selectedCameraLocation && (
                                        <span className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-white/80">
                                            <Building2 className="h-3.5 w-3.5" />
                                            {selectedCameraLocation}
                                        </span>
                                    )}
                                </div>
                                <p className="mt-1 text-sm text-white/60">
                                    {drawingMode === 'line' && 'Drawing line on preview'}
                                    {drawingMode === 'frame_exclude' && 'Drawing active zone on preview'}
                                    {!drawingMode && 'Live preview stays visible while you configure the page'}
                                </p>
                            </div>
                            <div className="flex flex-wrap gap-2 text-xs text-white/70">
                                <span className="rounded-full border border-white/15 px-3 py-1">People {stats.people_count}</span>
                                <span className="rounded-full border border-white/15 px-3 py-1">FPS {stats.fps}</span>
                            </div>
                        </div>
                    </CardHeader>
                )}
                {verificationLayoutEnabled ? (
                    <div className="grid min-h-[360px] auto-rows-fr gap-4 bg-black p-4 md:min-h-[480px] xl:min-h-[620px] lg:grid-cols-2">
                        {renderCameraSurface({
                            camera: primaryCamera,
                            role: 'primary',
                            containerRef: primaryVideoContainerRef,
                            isSelected: selectedCameraRole === 'primary',
                        })}
                        {renderCameraSurface({
                            camera: verifierCamera,
                            role: 'verifier',
                            containerRef: verifierVideoContainerRef,
                            isSelected: selectedCameraRole === 'verifier',
                        })}
                    </div>
                ) : (
                    <div ref={singleVideoContainerRef} className="relative min-h-[360px] overflow-hidden bg-black md:min-h-[480px] xl:min-h-[620px]">
                        {selectedCam ? (
                            <>
                                {shouldUseStoppedUploadPreview(selectedCam) ? (
                                    getStoppedPreviewState(selectedCam.id).image ? (
                                        <img
                                            src={getStoppedPreviewState(selectedCam.id).image}
                                            alt={selectedCam?.name || 'Camera Preview'}
                                            className="absolute inset-0 h-full w-full object-contain"
                                        />
                                    ) : (
                                        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                                            <p>{getStoppedPreviewState(selectedCam.id).loading ? 'Loading preview...' : 'Preview unavailable for this uploaded video.'}</p>
                                        </div>
                                    )
                                ) : (
                                    <StreamPlayer
                                        wsUrl={getWSUrl(`/ws/${selectedCamera}`)}
                                        className="absolute inset-0 h-full w-full"
                                        alt={selectedCam?.name || 'Camera Feed'}
                                        onStats={handleStats}
                                        onCountingData={handleCountingData}
                                        onMediaLayout={setLivePreviewLayout}
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
                                    containerRef={singleVideoContainerRef}
                                    mediaSize={shouldUseStoppedUploadPreview(selectedCam) ? getStoppedPreviewState(selectedCam.id).frameSize : null}
                                    displayArea={shouldUseStoppedUploadPreview(selectedCam) ? null : livePreviewLayout}
                                    showLiveSummary={false}
                                />
                            </>
                        ) : (
                            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                                <p>Select a camera to view the feed</p>
                            </div>
                        )}
                    </div>
                )}
                {/* <div className="border-t border-white/10 bg-black/85 px-4 py-3">
                    <div className="text-sm text-white/75">
                        Draw directly on the preview. The primary save and reset actions are pinned above the workspace so they stay visible while you configure the page.
                    </div>
                </div> */}
            </Card>
        </div>
    );

    const confirmDialogTitle = !confirmDialog
        ? ''
        : confirmDialog.kind === 'reset_building'
            ? 'Reset Building Totals?'
            : confirmDialog.kind === 'reset_camera'
                ? 'Reset Camera Totals?'
                : confirmDialog.kind === 'reset_form'
                    ? 'Reset Counting Form?'
                    : confirmDialog.kind === 'delete_line'
                        ? `Delete ${confirmDialog.name}?`
                        : confirmDialog.kind === 'delete_area'
                            ? 'Delete Active Zone?'
                            : `Delete Building ID ${confirmDialog.buildingId}?`;

    const confirmDialogDescription = !confirmDialog
        ? ''
        : confirmDialog.kind === 'reset_building'
            ? 'This will clear the grouped building occupancy totals. Continue?'
            : confirmDialog.kind === 'reset_camera'
                ? 'This will clear the totals for the selected camera. Continue?'
                : confirmDialog.kind === 'reset_form'
                ? 'This will clear all unsaved lines, active zones, and form changes for the selected camera.'
                : confirmDialog.kind === 'delete_line'
                    ? 'This line will be removed from the current setup immediately.'
                    : confirmDialog.kind === 'delete_area'
                        ? 'This active zone will be removed from the current setup immediately.'
                        : confirmDialog.activeCameraCount > 0
                            ? `This building ID still has ${confirmDialog.activeCameraCount} active camera${confirmDialog.activeCameraCount === 1 ? '' : 's'} and cannot be deleted right now.`
                            : 'This will remove the building ID, its saved capacity, and its live building totals.';

    const confirmDialogLabel = !confirmDialog
        ? 'Confirm'
        : confirmDialog.kind === 'delete_line'
            ? 'Delete Line'
            : confirmDialog.kind === 'delete_area'
                ? 'Delete Zone'
                : confirmDialog.kind === 'delete_building_id'
                    ? 'Delete Building ID'
                    : 'Confirm Reset';

    const confirmDialogLoading = confirmDialog?.kind === 'reset_building'
        ? resettingBuilding
        : confirmDialog?.kind === 'reset_camera'
            ? resettingCamera
            : confirmDialog?.kind === 'delete_building_id'
                ? Boolean(deletingBuildingId)
                : false;

    useEffect(() => {
        if (!sidebarCollapsed) {
            setShowSidebarRestoreHint(false);
            setIsSidebarRestoreHovered(false);
            return undefined;
        }

        setShowSidebarRestoreHint(true);
        const timeoutId = window.setTimeout(() => {
            setShowSidebarRestoreHint(false);
        }, 3500);

        return () => {
            window.clearTimeout(timeoutId);
        };
    }, [sidebarCollapsed]);

    const showSidebarRestoreLabel = showSidebarRestoreHint || isSidebarRestoreHovered;

    return (
        <div className="flex h-full flex-col gap-6 overflow-auto bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.08),_transparent_32%),linear-gradient(180deg,_rgba(248,250,252,0.95),_rgba(255,255,255,1))] p-6">
            <ConfirmationDialog
                open={Boolean(confirmDialog)}
                title={confirmDialogTitle}
                description={confirmDialogDescription}
                confirmLabel={confirmDialogLabel}
                confirmVariant="destructive"
                loading={confirmDialogLoading}
                loadingIcon={confirmDialogLoading ? <RotateCcw className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                onCancel={closeConfirmationDialog}
                onConfirm={handleConfirmDialogConfirm}
            />

            <section className="relative overflow-hidden rounded-[28px] border border-slate-200/80 bg-white/90 p-6 shadow-sm backdrop-blur">
                <div className="absolute inset-y-0 right-0 hidden w-72 bg-[radial-gradient(circle_at_center,_rgba(59,130,246,0.12),_transparent_60%)] lg:block" />
                <div className="relative flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-slate-950">People Counting</h1>
                        {/* <p className="mt-1 text-sm text-slate-600">Redesigned so the live preview stays primary and the configuration stays focused.</p> */}
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
                        {buildingCapacityExceeded && (
                            <div className="flex items-center gap-2 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-red-500">
                                <AlertTriangle className="h-4 w-4" />
                                <span className="text-sm font-medium">
                                    {exceededBuildingIds.length > 0
                                        ? `Capacity Exceeded: ${exceededBuildingIds.join(', ')}`
                                        : 'Building Capacity Exceeded'}
                                </span>
                            </div>
                        )}
                        <Button variant="outline" size="sm" onClick={() => openResetConfirmation('camera')} disabled={resettingCamera || !selectedCamera} className="border-slate-200 bg-white text-slate-700">
                            <RotateCcw className="mr-2 h-3.5 w-3.5" />
                            {resettingCamera ? 'Resetting...' : 'Reset Totals'}
                        </Button>
                        <Button size="sm" onClick={handleSave} disabled={saving || !selectedCamera} className="bg-blue-600 text-white hover:bg-blue-700">
                            <Save className="mr-2 h-3.5 w-3.5" />
                            {saving ? 'Saving...' : 'Save Changes'}
                        </Button>
                    </div>
                </div>
            </section>
            {saveMessage && (
                <div className={cn('rounded-2xl border px-4 py-3 text-sm', saveMessage.startsWith('Error') ? 'border-red-500/30 bg-red-500/10 text-red-500' : 'border-green-500/30 bg-green-500/10 text-green-600')}>
                    {saveMessage}
                </div>
            )}
            {sidebarCollapsed && (
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSidebarCollapsed(false)}
                    onMouseEnter={() => setIsSidebarRestoreHovered(true)}
                    onMouseLeave={() => setIsSidebarRestoreHovered(false)}
                    aria-label="Show configuration bar"
                    className={cn(
                        'fixed left-20 top-28 z-50 h-11 overflow-hidden rounded-full border-slate-200 bg-white/95 px-3 text-slate-700 shadow-lg backdrop-blur transition-all duration-300 hover:bg-white sm:left-28',
                        showSidebarRestoreLabel ? 'w-[240px] justify-start' : 'w-11 justify-center',
                    )}
                >
                    <ChevronRight className={cn('h-4 w-4 shrink-0', showSidebarRestoreLabel && 'mr-2')} />
                    <span
                        className={cn(
                            'whitespace-nowrap text-sm transition-all duration-300',
                            showSidebarRestoreLabel ? 'max-w-[190px] opacity-100' : 'max-w-0 opacity-0',
                        )}
                    >
                        Show Configuration Bar
                    </span>
                </Button>
            )}
            <div
                className={cn(
                    'grid gap-6 xl:items-start',
                    sidebarCollapsed
                        ? 'xl:grid-cols-[minmax(0,1fr)]'
                        : 'xl:grid-cols-[minmax(360px,500px)_minmax(0,1fr)]',
                )}
            >
                {!sidebarCollapsed && (
                    <div className="min-w-0 xl:order-1">
                        {settingsPanel}
                    </div>
                )}
                <div className={cn('min-w-0', sidebarCollapsed ? 'xl:order-1' : 'xl:order-2')}>
                    {videoPanel}
                </div>
            </div>
        </div>
    );
};

export default PeopleCounting;
