import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Circle, LayoutGrid, Maximize2, Minimize2, Users } from 'lucide-react';
import StreamPlayer from './StreamPlayer';
import { getApiBaseUrl, getWSUrl } from '../apiConfig';

const SOURCE_FILTER_OPTIONS = [
    { value: 'all', label: 'All Sources' },
    { value: 'live', label: 'Live Streams' },
    { value: 'uploaded', label: 'Uploaded Videos' },
];

const DISPLAY_MODE_OPTIONS = [
    { value: 'auto', label: 'Auto Layout' },
    { value: 'custom', label: 'Custom Boxes' },
];

const DASHBOARD_PREFERENCES_KEY = 'dashboard_preferences_v2';
const SUPPORTED_LAYOUTS = [1, 4, 9];

const createEmptyPage = (layoutSize) => Array(layoutSize).fill(null);

const createEmptySlotAssignments = () => (
    SUPPORTED_LAYOUTS.reduce((accumulator, layoutSize) => {
        accumulator[layoutSize] = { pages: [createEmptyPage(layoutSize)] };
        return accumulator;
    }, {})
);

const normalizeLayoutSize = (value) => (
    SUPPORTED_LAYOUTS.includes(Number(value)) ? Number(value) : 9
);

const normalizeDisplayMode = (value) => (
    value === 'custom' ? 'custom' : 'auto'
);

const normalizeSourceFilter = (value) => (
    SOURCE_FILTER_OPTIONS.some((option) => option.value === value) ? value : 'all'
);

const normalizePageArray = (rawPage, layoutSize) => (
    Array.from({ length: layoutSize }, (_, index) => {
        const value = Array.isArray(rawPage) ? rawPage[index] : null;
        return typeof value === 'string' && value.trim() ? value : null;
    })
);

const normalizeLayoutPages = (rawLayoutValue, layoutSize, minPageCount = 1) => {
    const rawPages = Array.isArray(rawLayoutValue)
        ? [rawLayoutValue]
        : Array.isArray(rawLayoutValue?.pages)
            ? rawLayoutValue.pages
            : [];

    const normalizedPages = rawPages.map((page) => normalizePageArray(page, layoutSize));
    const targetPageCount = Math.max(1, minPageCount);

    while (normalizedPages.length < targetPageCount) {
        normalizedPages.push(createEmptyPage(layoutSize));
    }

    return normalizedPages.length ? normalizedPages : [createEmptyPage(layoutSize)];
};

const normalizeSlotAssignments = (rawAssignments, minPageCounts = {}) => (
    SUPPORTED_LAYOUTS.reduce((accumulator, layoutSize) => {
        const layoutValue = rawAssignments?.[layoutSize] ?? rawAssignments?.[String(layoutSize)];
        accumulator[layoutSize] = {
            pages: normalizeLayoutPages(layoutValue, layoutSize, minPageCounts[layoutSize] ?? 1),
        };
        return accumulator;
    }, createEmptySlotAssignments())
);

const readStoredDashboardPreferences = () => {
    const defaults = {
        layout: 9,
        displayMode: 'auto',
        sourceFilter: 'all',
        cameraFilter: 'all',
        slotAssignments: createEmptySlotAssignments(),
    };

    if (typeof window === 'undefined') {
        return defaults;
    }

    try {
        const rawValue = window.localStorage.getItem(DASHBOARD_PREFERENCES_KEY);
        if (!rawValue) {
            return defaults;
        }

        const parsed = JSON.parse(rawValue);
        return {
            layout: normalizeLayoutSize(parsed?.layout),
            displayMode: normalizeDisplayMode(parsed?.displayMode),
            sourceFilter: normalizeSourceFilter(parsed?.sourceFilter),
            cameraFilter: typeof parsed?.cameraFilter === 'string' && parsed.cameraFilter.trim()
                ? parsed.cameraFilter
                : 'all',
            slotAssignments: normalizeSlotAssignments(parsed?.slotAssignments),
        };
    } catch (error) {
        console.error('Failed to read stored dashboard preferences:', error);
        return defaults;
    }
};

const inferOverlayMode = (analysisTags = []) => {
    const normalizedTags = new Set(
        (Array.isArray(analysisTags) ? analysisTags : []).map((tag) => String(tag).toLowerCase())
    );

    const hasCounting = normalizedTags.has('people counting');
    const hasFall = normalizedTags.has('fall detection');
    const hasDressCode = normalizedTags.has('dress code');
    const activeModes = [hasCounting, hasFall, hasDressCode].filter(Boolean).length;

    if (activeModes !== 1) {
        return 'auto';
    }
    if (hasCounting) return 'counting';
    if (hasFall) return 'fall';
    if (hasDressCode) return 'dress-code';
    return 'auto';
};

const isRealtimeStreamSource = (camera) =>
    camera.source_kind === 'rtsp'
    || camera.source_kind === 'network'
    || (camera.is_uploaded && camera.producer_running);

const matchesSourceFilter = (camera, sourceFilter) => {
    if (sourceFilter === 'all') return true;
    if (sourceFilter === 'live') {
        return camera.source_kind === 'rtsp' || camera.source_kind === 'network';
    }
    if (sourceFilter === 'uploaded') {
        return camera.is_uploaded || camera.source_kind === 'uploaded_video';
    }
    return camera.source_kind === sourceFilter;
};

const getSourceAccentClasses = (camera) => (
    Boolean(camera?.is_uploaded) || camera?.source_kind === 'uploaded_video'
        ? { dot: 'fill-blue-500 text-blue-500', label: 'text-blue-300' }
        : { dot: 'fill-green-500 text-green-500', label: 'text-green-300' }
);

const getLineType = (line) => line?.line_type === 'foot_traffic' ? 'foot_traffic' : 'occupancy';

const getFootTrafficLabelsForLine = (line) => {
    const points = Array.isArray(line?.points) ? line.points : [];
    if (points.length >= 2) {
        const [start, end] = points;
        const dx = Number(end?.[0] ?? 0) - Number(start?.[0] ?? 0);
        const dy = Number(end?.[1] ?? 0) - Number(start?.[1] ?? 0);
        if (Math.abs(dy) >= Math.abs(dx)) {
            return { shortNegative: 'L', shortPositive: 'R', mode: 'left_right' };
        }
    }
    return { shortNegative: 'D', shortPositive: 'U', mode: 'up_down' };
};

const getFootTrafficSummaryLabels = (lines) => {
    const ftLines = Array.isArray(lines) ? lines.filter((line) => getLineType(line) === 'foot_traffic') : [];
    if (!ftLines.length) {
        return { shortNegative: 'L', shortPositive: 'R', mixed: false };
    }
    const labels = ftLines.map(getFootTrafficLabelsForLine);
    const firstMode = labels[0].mode;
    const mixed = labels.some((label) => label.mode !== firstMode);
    return mixed ? { shortNegative: 'L', shortPositive: 'R', mixed: false } : { ...labels[0], mixed: false };
};

const SlotCameraSelector = ({
    slotIndex,
    currentPage,
    selectedCameraId,
    cameraOptions,
    assignedCameraLocations,
    onAssignCamera,
}) => (
    <div className="absolute bottom-2 left-2 z-20 rounded-lg bg-black/65 px-2 py-2 backdrop-blur-sm opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100">
        <select
            value={selectedCameraId || ''}
            onChange={(event) => onAssignCamera(slotIndex, event.target.value || null)}
            className="h-8 min-w-56 rounded-md border border-white/20 bg-black/40 px-2 text-xs text-white outline-none"
            aria-label={`Select camera for page ${currentPage + 1} box ${slotIndex + 1}`}
        >
            <option value="" className="text-black">No Camera</option>
            {cameraOptions.map((camera) => {
                const assignedLocation = assignedCameraLocations.get(camera.id);
                const isCurrentSelection = camera.id === selectedCameraId;
                const isAssignedElsewhere = Boolean(
                    assignedLocation
                    && (assignedLocation.pageIndex !== currentPage || assignedLocation.slotIndex !== slotIndex)
                );

                let optionLabel = camera.name;
                if (isCurrentSelection) {
                    optionLabel = `${camera.name} [Current]`;
                } else if (isAssignedElsewhere) {
                    optionLabel = `${camera.name} [Page ${assignedLocation.pageIndex + 1} Box ${assignedLocation.slotIndex + 1}]`;
                }

                return (
                    <option key={camera.id} value={camera.id} className="text-black">
                        {optionLabel}
                    </option>
                );
            })}
        </select>
    </div>
);

const CameraFeedCard = ({
    camera,
    apiUrl,
    slotIndex,
    currentPage,
    topLabelOffsetClass = 'top-1.5',
    showSlotSelector,
    cameraOptions,
    assignedCameraLocations,
    onAssignCamera,
}) => {
    const [stats, setStats] = useState({ fps: 0, people_count: 0 });
    const [countingData, setCountingData] = useState({});
    const [runtimePreviewImage, setRuntimePreviewImage] = useState('');
    const [showSourceLabelHint, setShowSourceLabelHint] = useState(true);
    const wsUrl = getWSUrl(`/ws/${camera.id}`);
    const overlayMode = inferOverlayMode(camera.analysis_tags);
    const footTrafficLabels = getFootTrafficSummaryLabels(countingData?.lines);
    const sourceAccent = getSourceAccentClasses(camera);
    const hasCountingData = countingData && (
        countingData.total_in > 0
        || countingData.total_out > 0
        || countingData.foot_traffic_total > 0
    );
    const shouldLoadStoppedUploadPreview = Boolean(camera.is_uploaded && !camera.producer_running && camera.runtime_key);

    useEffect(() => {
        let cancelled = false;

        const loadRuntimePreview = async () => {
            if (!shouldLoadStoppedUploadPreview) {
                setRuntimePreviewImage('');
                return;
            }

            try {
                const res = await fetch(`${apiUrl}/api/upload-videos/preview`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ runtime_key: camera.runtime_key }),
                });
                const data = await res.json().catch(() => ({}));
                if (cancelled) {
                    return;
                }
                if (!res.ok || !data.preview_image) {
                    throw new Error(data.detail || 'Preview unavailable.');
                }
                setRuntimePreviewImage(`data:image/jpeg;base64,${data.preview_image}`);
            } catch (error) {
                if (!cancelled) {
                    console.error('Failed to load dashboard upload preview:', error);
                    setRuntimePreviewImage('');
                }
            }
        };

        loadRuntimePreview();
        return () => {
            cancelled = true;
        };
    }, [apiUrl, camera.runtime_key, shouldLoadStoppedUploadPreview]);

    useEffect(() => {
        setShowSourceLabelHint(true);
        const timeoutId = window.setTimeout(() => {
            setShowSourceLabelHint(false);
        }, 3200);
        return () => window.clearTimeout(timeoutId);
    }, [camera.id]);

    return (
        <div className="relative group flex h-full min-h-0 w-full items-center justify-center overflow-hidden rounded-sm border border-border/50 bg-black">
            {isRealtimeStreamSource(camera) ? (
                <StreamPlayer
                    wsUrl={wsUrl}
                    className="h-full w-full"
                    alt={camera.name}
                    onStats={setStats}
                    onCountingData={setCountingData}
                    overlayMode={overlayMode}
                    showCountingAnchors={overlayMode === 'counting'}
                />
            ) : runtimePreviewImage ? (
                <img src={runtimePreviewImage} className="h-full w-full bg-black object-contain" alt={camera.name} />
            ) : (
                <div className="absolute inset-0 flex items-center justify-center bg-muted/20 text-muted-foreground">
                    <img src={camera.image} className="h-full w-full bg-black object-contain opacity-80" alt={camera.name} onError={(event) => { event.target.style.display = 'none'; }} />
                    <span className="absolute">{camera.is_uploaded ? 'Uploaded Video Preview' : 'Stream Placeholder'}</span>
                </div>
            )}

            {showSlotSelector && (
                <SlotCameraSelector
                    slotIndex={slotIndex}
                    currentPage={currentPage}
                    selectedCameraId={camera.id}
                    cameraOptions={cameraOptions}
                    assignedCameraLocations={assignedCameraLocations}
                    onAssignCamera={onAssignCamera}
                />
            )}

            <div className="pointer-events-none absolute inset-0">
                <div
                    className={`absolute left-1.5 ${topLabelOffsetClass} overflow-hidden rounded-full bg-black/70 backdrop-blur-sm transition-all duration-300 ${showSourceLabelHint
                        ? 'max-w-[70%] px-2.5 py-1'
                        : 'max-w-4 px-1.5 py-1'
                        } group-hover:max-w-[70%] group-hover:px-2.5`}
                >
                    <div className="flex items-center gap-2 text-xs text-white">
                        <Circle className={`h-2 w-2 shrink-0 animate-pulse ${sourceAccent.dot}`} />
                        <div
                            className={`flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap transition-all duration-300 ${showSourceLabelHint ? 'max-w-[260px] opacity-100' : 'max-w-0 opacity-0'
                                } group-hover:max-w-[260px] group-hover:opacity-100`}
                        >
                            <span className={`truncate font-medium ${sourceAccent.label}`}>{camera.name}</span>
                            {camera.location && <span className="truncate text-white/70">- {camera.location}</span>}
                        </div>
                    </div>
                </div>

                <div className="absolute right-1.5 top-1.5 flex flex-wrap justify-end gap-2">
                    {stats.people_count > 0 && (
                        <div className="flex items-center gap-1 rounded bg-black/60 px-2 py-1 text-xs text-white backdrop-blur-sm">
                            <Users className="h-3 w-3" />
                            {stats.people_count}
                        </div>
                    )}
                    {hasCountingData && (
                        <div className="flex items-center gap-1.5 rounded bg-black/60 px-2 py-1 text-xs text-white backdrop-blur-sm">
                            <span className="text-green-400">IN:{countingData.total_in}</span>
                            <span className="text-red-400">OUT:{countingData.total_out}</span>
                            {(countingData.foot_traffic_total ?? 0) > 0 && (
                                <span className="text-cyan-300">
                                    FT:{footTrafficLabels.shortNegative}{countingData.foot_traffic_left ?? 0}/{footTrafficLabels.shortPositive}{countingData.foot_traffic_right ?? 0}/T{countingData.foot_traffic_total ?? 0}
                                </span>
                            )}
                        </div>
                    )}
                    <div className="rounded bg-black/60 px-2 py-1 text-xs text-white backdrop-blur-sm">
                        {stats.fps > 0 ? stats.fps : camera.fps} FPS
                    </div>
                </div>
            </div>
        </div>
    );
};

const EmptySlotCard = ({
    slotIndex,
    currentPage,
    cameraOptions,
    assignedCameraLocations,
    onAssignCamera,
}) => (
    <div className="relative group flex min-h-0 items-center justify-center overflow-hidden border border-border/50 bg-black/90 text-muted-foreground">
        <div className="flex flex-col items-center gap-2 px-4 text-center">
            <span className="text-sm text-white/80">No Camera Assigned</span>
            <span className="text-xs text-white/45">Choose a feed for this slot.</span>
        </div>
        <SlotCameraSelector
            slotIndex={slotIndex}
            currentPage={currentPage}
            selectedCameraId={null}
            cameraOptions={cameraOptions}
            assignedCameraLocations={assignedCameraLocations}
            onAssignCamera={onAssignCamera}
        />
    </div>
);

const Dashboard = () => {
    const initialPreferences = useMemo(() => readStoredDashboardPreferences(), []);
    const apiUrl = getApiBaseUrl();
    const [cameras, setCameras] = useState([]);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [layout, setLayout] = useState(initialPreferences.layout);
    const [page, setPage] = useState(0);
    const [sourceFilter, setSourceFilter] = useState(initialPreferences.sourceFilter);
    const [cameraFilter, setCameraFilter] = useState(initialPreferences.cameraFilter);
    const [displayMode, setDisplayMode] = useState(initialPreferences.displayMode);
    const [slotAssignments, setSlotAssignments] = useState(initialPreferences.slotAssignments);
    const [assignmentNotice, setAssignmentNotice] = useState('');
    const containerRef = useRef(null);

    const fetchCameras = useCallback(async () => {
        try {
            const res = await fetch(`${apiUrl}/api/cameras`);
            const data = await res.json();
            setCameras((Array.isArray(data) ? data : []).filter((camera) => camera.enabled));
        } catch (error) {
            console.error('Failed to fetch cameras:', error);
        }
    }, [apiUrl]);

    useEffect(() => {
        let cancelled = false;
        const loadCameras = async () => {
            if (!cancelled) {
                await fetchCameras();
            }
        };

        const timeoutId = window.setTimeout(() => {
            void loadCameras();
        }, 0);
        const intervalId = window.setInterval(() => {
            void loadCameras();
        }, 5000);

        return () => {
            cancelled = true;
            window.clearTimeout(timeoutId);
            window.clearInterval(intervalId);
        };
    }, [fetchCameras]);

    useEffect(() => {
        if (!assignmentNotice) {
            return undefined;
        }

        const timeoutId = window.setTimeout(() => {
            setAssignmentNotice('');
        }, 2600);

        return () => window.clearTimeout(timeoutId);
    }, [assignmentNotice]);

    useEffect(() => {
        const handleFullscreenChange = () => {
            setIsFullscreen(Boolean(document.fullscreenElement));
        };

        document.addEventListener('fullscreenchange', handleFullscreenChange);
        return () => {
            document.removeEventListener('fullscreenchange', handleFullscreenChange);
        };
    }, []);

    const cameraMap = useMemo(
        () => new Map(cameras.map((camera) => [camera.id, camera])),
        [cameras],
    );

    const minCustomPageCounts = useMemo(
        () => SUPPORTED_LAYOUTS.reduce((accumulator, layoutSize) => {
            accumulator[layoutSize] = Math.max(1, Math.ceil(cameras.length / layoutSize));
            return accumulator;
        }, {}),
        [cameras.length],
    );

    const sanitizedSlotAssignments = useMemo(() => {
        const availableCameraIds = new Set(cameras.map((camera) => camera.id));
        const nextAssignments = normalizeSlotAssignments(slotAssignments, minCustomPageCounts);

        SUPPORTED_LAYOUTS.forEach((layoutSize) => {
            const seenCameraIds = new Set();
            nextAssignments[layoutSize].pages = nextAssignments[layoutSize].pages.map((slotPage) => (
                slotPage.map((cameraId) => {
                    if (!cameraId || !availableCameraIds.has(cameraId) || seenCameraIds.has(cameraId)) {
                        return null;
                    }
                    seenCameraIds.add(cameraId);
                    return cameraId;
                })
            ));
        });

        return nextAssignments;
    }, [cameras, minCustomPageCounts, slotAssignments]);

    useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        window.localStorage.setItem(DASHBOARD_PREFERENCES_KEY, JSON.stringify({
            layout,
            displayMode,
            sourceFilter,
            cameraFilter,
            slotAssignments: sanitizedSlotAssignments,
        }));
    }, [cameraFilter, displayMode, layout, sanitizedSlotAssignments, sourceFilter]);

    const filteredBySource = useMemo(
        () => cameras.filter((camera) => matchesSourceFilter(camera, sourceFilter)),
        [cameras, sourceFilter],
    );

    const autoModeCameraOptions = useMemo(
        () => filteredBySource.map((camera) => ({ id: camera.id, name: camera.name })),
        [filteredBySource],
    );

    const customModeCameraOptions = useMemo(
        () => cameras.map((camera) => ({ id: camera.id, name: camera.name })),
        [cameras],
    );

    const effectiveCameraFilter = useMemo(() => {
        if (displayMode !== 'auto' || cameraFilter === 'all') {
            return 'all';
        }
        return autoModeCameraOptions.some((camera) => camera.id === cameraFilter) ? cameraFilter : 'all';
    }, [autoModeCameraOptions, cameraFilter, displayMode]);

    const filteredCameras = useMemo(
        () => filteredBySource.filter((camera) => effectiveCameraFilter === 'all' || camera.id === effectiveCameraFilter),
        [effectiveCameraFilter, filteredBySource],
    );

    const autoTotalPages = Math.ceil(filteredCameras.length / layout) || 1;
    const customTotalPages = sanitizedSlotAssignments[layout].pages.length;
    const totalPages = displayMode === 'custom' ? customTotalPages : autoTotalPages;
    const currentPage = page % totalPages;

    const displayedSlots = useMemo(() => {
        if (displayMode === 'auto') {
            const startIndex = currentPage * layout;
            const nextCameras = filteredCameras.slice(startIndex, startIndex + layout);
            return Array.from({ length: layout }, (_, index) => nextCameras[index] || null);
        }

        return sanitizedSlotAssignments[layout].pages[currentPage] || createEmptyPage(layout);
    }, [currentPage, displayMode, filteredCameras, layout, sanitizedSlotAssignments]);

    const displayedCameras = useMemo(
        () => displayedSlots.map((slotValue) => (
            typeof slotValue === 'string' ? cameraMap.get(slotValue) || null : slotValue
        )),
        [cameraMap, displayedSlots],
    );

    const assignedCameraLocations = useMemo(() => {
        if (displayMode !== 'custom') {
            return new Map();
        }

        return sanitizedSlotAssignments[layout].pages.reduce((accumulator, slotPage, pageIndex) => {
            slotPage.forEach((cameraId, slotIndex) => {
                if (cameraId) {
                    accumulator.set(cameraId, { pageIndex, slotIndex });
                }
            });
            return accumulator;
        }, new Map());
    }, [displayMode, layout, sanitizedSlotAssignments]);

    const handleAssignCameraToSlot = (slotIndex, nextCameraId) => {
        const nextAssignments = normalizeSlotAssignments(sanitizedSlotAssignments, minCustomPageCounts);
        const currentLayoutPages = nextAssignments[layout].pages.map((slotPage) => [...slotPage]);
        let nextNotice = '';

        currentLayoutPages.forEach((slotPage, pageIndex) => {
            slotPage.forEach((cameraId, innerSlotIndex) => {
                const isCurrentTarget = pageIndex === currentPage && innerSlotIndex === slotIndex;
                if (!isCurrentTarget && cameraId === nextCameraId) {
                    currentLayoutPages[pageIndex][innerSlotIndex] = null;
                    const movedCameraName = cameraMap.get(nextCameraId)?.name || 'Camera';
                    nextNotice = `${movedCameraName} moved from Page ${pageIndex + 1} to Page ${currentPage + 1}.`;
                }
            });
        });

        currentLayoutPages[currentPage][slotIndex] = nextCameraId || null;

        setSlotAssignments({
            ...nextAssignments,
            [layout]: { pages: currentLayoutPages },
        });
        setAssignmentNotice(nextNotice);
    };

    const toggleFullscreen = () => {
        if (!document.fullscreenElement) {
            containerRef.current?.requestFullscreen().catch((error) => {
                console.error(`Error attempting to enable fullscreen: ${error.message}`);
            });
            return;
        }

        document.exitFullscreen().catch((error) => {
            console.error(`Error attempting to exit fullscreen: ${error.message}`);
        });
    };

    const handleLayoutChange = (newLayout) => {
        setLayout(newLayout);
        setPage(0);
    };

    const handleDisplayModeChange = (nextMode) => {
        setDisplayMode(nextMode);
        setPage(0);
    };

    const handleSourceFilterChange = (nextFilter) => {
        setSourceFilter(nextFilter);
        setPage(0);
    };

    const handleCameraFilterChange = (nextFilter) => {
        setCameraFilter(nextFilter);
        setPage(0);
    };

    const handleNextPage = () => {
        setPage((currentValue) => (currentValue + 1) % totalPages);
    };

    const handlePrevPage = () => {
        setPage((currentValue) => (currentValue - 1 + totalPages) % totalPages);
    };

    const currentCameraOptions = displayMode === 'custom' ? customModeCameraOptions : autoModeCameraOptions;

    return (
        <div
            ref={containerRef}
            className="relative group flex h-[calc(100vh-5.5rem)] min-h-0 w-full flex-col overflow-hidden bg-background lg:h-[calc(100vh-6.75rem)]"
        >
            <div className="absolute left-4 top-4 z-50 flex flex-wrap gap-2 rounded-lg bg-black/50 p-2 opacity-0 transition-opacity backdrop-blur-md group-hover:opacity-100 hover:opacity-100">
                <div className="mr-2 flex gap-1 border-r border-white/20 pr-2">
                    <Button size="icon" variant={layout === 1 ? 'secondary' : 'ghost'} className="h-8 w-8 text-white" onClick={() => handleLayoutChange(1)}>
                        <div className="h-4 w-4 rounded-sm border-2 border-current" />
                    </Button>
                    <Button size="icon" variant={layout === 4 ? 'secondary' : 'ghost'} className="h-8 w-8 text-white" onClick={() => handleLayoutChange(4)}>
                        <LayoutGrid className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant={layout === 9 ? 'secondary' : 'ghost'} className="h-8 w-8 text-white" onClick={() => handleLayoutChange(9)}>
                        <div className="grid h-4 w-4 grid-cols-3 gap-0.5">
                            {Array.from({ length: 9 }).map((_, index) => <div key={index} className="rounded-[1px] bg-current" />)}
                        </div>
                    </Button>
                </div>

                <div className="mr-2 flex items-center gap-2 border-r border-white/20 pr-2">
                    <select
                        value={displayMode}
                        onChange={(event) => handleDisplayModeChange(event.target.value)}
                        className="h-8 rounded-md border border-white/20 bg-black/30 px-2 text-xs text-white"
                    >
                        {DISPLAY_MODE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value} className="text-black">{option.label}</option>
                        ))}
                    </select>

                    <select
                        value={sourceFilter}
                        onChange={(event) => handleSourceFilterChange(event.target.value)}
                        className="h-8 rounded-md border border-white/20 bg-black/30 px-2 text-xs text-white"
                        disabled={displayMode !== 'auto'}
                    >
                        {SOURCE_FILTER_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value} className="text-black">{option.label}</option>
                        ))}
                    </select>

                    <select
                        value={effectiveCameraFilter}
                        onChange={(event) => handleCameraFilterChange(event.target.value)}
                        className="h-8 max-w-44 rounded-md border border-white/20 bg-black/30 px-2 text-xs text-white disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={displayMode !== 'auto'}
                    >
                        <option value="all" className="text-black">All Cameras</option>
                        {autoModeCameraOptions.map((camera) => (
                            <option key={camera.id} value={camera.id} className="text-black">{camera.name}</option>
                        ))}
                    </select>
                </div>

                {totalPages > 1 && (
                    <div className="flex items-center gap-2 text-xs text-white">
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-white" onClick={handlePrevPage}>&lt;</Button>
                        <span>{currentPage + 1}/{totalPages}</span>
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-white" onClick={handleNextPage}>&gt;</Button>
                    </div>
                )}
            </div>

            <div className="absolute right-4 top-4 z-50 opacity-0 transition-opacity group-hover:opacity-100 hover:opacity-100">
                <Button size="icon" variant="secondary" className="bg-black/50 text-white hover:bg-black/70 backdrop-blur-md" onClick={toggleFullscreen}>
                    {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                </Button>
            </div>

            {assignmentNotice && (
                <div className="absolute bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full bg-black/70 px-4 py-2 text-xs text-white backdrop-blur-md">
                    {assignmentNotice}
                </div>
            )}

            <div className={`grid min-h-0 flex-1 auto-rows-fr gap-1 bg-background ${layout === 1 ? 'grid-cols-1' : layout === 4 ? 'grid-cols-2' : 'grid-cols-3'}`}>
                {displayedCameras.map((camera, index) => (
                    camera ? (
                        <CameraFeedCard
                            key={`${layout}-${currentPage}-${index}-${camera.id}`}
                            camera={camera}
                            apiUrl={apiUrl}
                            slotIndex={index}
                            currentPage={currentPage}
                            topLabelOffsetClass={index === 0 ? 'top-16' : 'top-1.5'}
                            showSlotSelector={displayMode === 'custom'}
                            cameraOptions={currentCameraOptions}
                            assignedCameraLocations={assignedCameraLocations}
                            onAssignCamera={handleAssignCameraToSlot}
                        />
                    ) : (
                        <EmptySlotCard
                            key={`${layout}-${currentPage}-${index}-empty`}
                            slotIndex={index}
                            currentPage={currentPage}
                            cameraOptions={currentCameraOptions}
                            assignedCameraLocations={assignedCameraLocations}
                            onAssignCamera={handleAssignCameraToSlot}
                        />
                    )
                ))}
            </div>
        </div>
    );
};

export default Dashboard;
