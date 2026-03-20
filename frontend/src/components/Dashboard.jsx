import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import { Circle, LayoutGrid, Users, Maximize2, Minimize2 } from 'lucide-react';
import StreamPlayer from './StreamPlayer';
import { getApiBaseUrl, getWSUrl } from '../apiConfig';

const RECENT_DETECTIONS = [
    { id: 1, type: 'Dress Code', time: '10:42 AM', camera: 'Factory Floor A', image: '/factory.png', person: 'Unknown' },
    { id: 2, type: 'Person', time: '10:41 AM', camera: 'Main Lobby', image: '/lobby.png', person: 'Staff' },
    { id: 3, type: 'Person', time: '10:39 AM', camera: 'Corridor B', image: '/hallway.png', person: 'Visitor' },
];

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
    if (hasCounting) {
        return 'counting';
    }
    if (hasFall) {
        return 'fall';
    }
    if (hasDressCode) {
        return 'dress-code';
    }
    return 'auto';
};

const SOURCE_FILTER_OPTIONS = [
    { value: 'all', label: 'All Sources' },
    { value: 'live', label: 'Live Streams' },
    { value: 'uploaded', label: 'Uploaded Videos' },
];

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
    if (mixed) {
        return { shortNegative: 'L', shortPositive: 'R', mixed: false };
    }
    return { ...labels[0], mixed: false };
};

const CameraFeedCard = ({ camera, apiUrl }) => {
    const [stats, setStats] = useState({ fps: 0, people_count: 0 });
    const [countingData, setCountingData] = useState({});
    const [runtimePreviewImage, setRuntimePreviewImage] = useState('');
    const wsUrl = getWSUrl(`/ws/${camera.id}`);
    const overlayMode = inferOverlayMode(camera.analysis_tags);
    const footTrafficLabels = getFootTrafficSummaryLabels(countingData?.lines);

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

    return (
        <div className="relative group overflow-hidden bg-black rounded-sm border border-border/50 h-full w-full flex items-center justify-center">
            {/* Live Feed or Image */}
            {isRealtimeStreamSource(camera) ? (
                <StreamPlayer
                    wsUrl={wsUrl}
                    className="w-full h-full"
                    alt={camera.name}
                    onStats={setStats}
                    onCountingData={setCountingData}
                    overlayMode={overlayMode}
                    showCountingAnchors={overlayMode === 'counting'}
                />
            ) : runtimePreviewImage ? (
                <img src={runtimePreviewImage} className="w-full h-full object-contain bg-black" alt={camera.name} />
            ) : (
                <div className="absolute inset-0 bg-muted/20 flex items-center justify-center text-muted-foreground">
                    <img src={camera.image} className="w-full h-full object-contain bg-black opacity-80" alt={camera.name} onError={(e) => { e.target.style.display = 'none' }} />
                    <span className="absolute">{camera.is_uploaded ? 'Uploaded Video Preview' : 'Stream Placeholder'}</span>
                </div>
            )}


            {/* Overlays */}
            <div className="absolute inset-0 p-4 pointer-events-none">
                {/* Top Bar: Camera Info */}
                <div className="flex justify-between items-start">
                    <div className="bg-black/60 text-white text-xs px-2 py-1 rounded backdrop-blur-sm flex items-center gap-2">
                        <Circle className="w-2 h-2 fill-green-500 text-green-500 animate-pulse" />
                        {camera.name}
                    </div>
                    <div className="flex gap-2 flex-wrap justify-end">
                        {stats.people_count > 0 && (
                            <div className="bg-black/60 text-white text-xs px-2 py-1 rounded backdrop-blur-sm flex items-center gap-1">
                                <Users className="w-3 h-3" />
                                {stats.people_count}
                            </div>
                        )}
                        {hasCountingData && (
                            <div className="bg-black/60 text-white text-xs px-2 py-1 rounded backdrop-blur-sm flex items-center gap-1.5">
                                <span className="text-green-400">IN:{countingData.total_in}</span>
                                <span className="text-red-400">OUT:{countingData.total_out}</span>
                                {(countingData.foot_traffic_total ?? 0) > 0 && (
                                    <span className="text-cyan-300">
                                        FT:{footTrafficLabels.shortNegative}{countingData.foot_traffic_left ?? 0}/{footTrafficLabels.shortPositive}{countingData.foot_traffic_right ?? 0}/T{countingData.foot_traffic_total ?? 0}
                                    </span>
                                )}
                            </div>
                        )}
                        <div className="bg-black/60 text-white text-xs px-2 py-1 rounded backdrop-blur-sm flex items-center gap-1">
                            {stats.fps > 0 ? stats.fps : camera.fps} FPS
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

const Dashboard = () => {
    const apiUrl = getApiBaseUrl();
    const [cameras, setCameras] = useState([]);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [layout, setLayout] = useState(9); // Default to 9 for multiscreen view
    const [page, setPage] = useState(0);
    const [sourceFilter, setSourceFilter] = useState('all');
    const [cameraFilter, setCameraFilter] = useState('all');
    const containerRef = useRef(null);

    async function fetchCameras() {
        try {
            console.log("Dashboard fetching from:", apiUrl);
            const res = await fetch(`${apiUrl}/api/cameras`);
            const data = await res.json();
            setCameras((Array.isArray(data) ? data : []).filter((camera) => camera.enabled));
        } catch (error) {
            console.error("Failed to fetch cameras:", error);
        }
    }

    useEffect(() => {
        let cancelled = false;
        const loadCameras = async () => {
            if (!cancelled) {
                await fetchCameras();
            }
        };

        const timeoutId = setTimeout(() => {
            void loadCameras();
        }, 0);
        const intervalId = setInterval(() => {
            void loadCameras();
        }, 5000);

        return () => {
            cancelled = true;
            clearTimeout(timeoutId);
            clearInterval(intervalId);
        };
    }, [apiUrl]);

    const filteredBySource = useMemo(
        () => cameras.filter((camera) => matchesSourceFilter(camera, sourceFilter)),
        [cameras, sourceFilter],
    );

    const availableCameraOptions = useMemo(
        () => filteredBySource.map((camera) => ({ id: camera.id, name: camera.name })),
        [filteredBySource],
    );

    const filteredCameras = useMemo(
        () => filteredBySource.filter((camera) => cameraFilter === 'all' || camera.id === cameraFilter),
        [cameraFilter, filteredBySource],
    );

    useEffect(() => {
        if (cameraFilter === 'all') {
            return;
        }
        if (!availableCameraOptions.some((camera) => camera.id === cameraFilter)) {
            setCameraFilter('all');
        }
    }, [availableCameraOptions, cameraFilter]);

    useEffect(() => {
        setPage(0);
    }, [cameraFilter, layout, sourceFilter]);

    const totalCameras = filteredCameras.length;
    const totalPages = Math.ceil(totalCameras / layout) || 1;

    const startIndex = page * layout;
    const displayedCameras = filteredCameras.slice(startIndex, startIndex + layout);

    const toggleFullscreen = () => {
        if (!document.fullscreenElement) {
            containerRef.current.requestFullscreen().catch(err => {
                console.error(`Error attempting to enable fullscreen: ${err.message}`);
            });
            setIsFullscreen(true);
        } else {
            document.exitFullscreen();
            setIsFullscreen(false);
        }
    };

    const handleLayoutChange = (newLayout) => {
        setLayout(newLayout);
        setPage(0); // Reset to first page on layout change
    };

    const handleNextPage = () => {
        setPage(old => (old + 1) % totalPages);
    };

    const handlePrevPage = () => {
        setPage(old => (old - 1 + totalPages) % totalPages);
    };

    return (
        <div ref={containerRef} className="relative flex h-full w-full bg-background overflow-hidden flex-col">
            {/* Controls Bar */}
            <div className="absolute top-4 left-4 z-50 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity hover:opacity-100 p-2 rounded-lg bg-black/50 backdrop-blur-md">
                <div className="flex gap-1 border-r border-white/20 pr-2 mr-2">
                    <Button size="icon" variant={layout === 1 ? "secondary" : "ghost"} className="h-8 w-8 text-white" onClick={() => handleLayoutChange(1)}>
                        <div className="w-4 h-4 border-2 border-current rounded-sm" />
                    </Button>
                    <Button size="icon" variant={layout === 4 ? "secondary" : "ghost"} className="h-8 w-8 text-white" onClick={() => handleLayoutChange(4)}>
                        <LayoutGrid className="w-4 h-4" />
                    </Button>
                    <Button size="icon" variant={layout === 9 ? "secondary" : "ghost"} className="h-8 w-8 text-white" onClick={() => handleLayoutChange(9)}>
                        <div className="grid grid-cols-3 gap-0.5 w-4 h-4">
                            {[...Array(9)].map((_, i) => <div key={i} className="bg-current rounded-[1px]" />)}
                        </div>
                    </Button>
                </div>

                <div className="flex items-center gap-2 border-r border-white/20 pr-2 mr-2">
                    <select
                        value={sourceFilter}
                        onChange={(event) => setSourceFilter(event.target.value)}
                        className="h-8 rounded-md border border-white/20 bg-black/30 px-2 text-xs text-white"
                    >
                        {SOURCE_FILTER_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value} className="text-black">
                                {option.label}
                            </option>
                        ))}
                    </select>
                    <select
                        value={cameraFilter}
                        onChange={(event) => setCameraFilter(event.target.value)}
                        className="h-8 max-w-44 rounded-md border border-white/20 bg-black/30 px-2 text-xs text-white"
                    >
                        <option value="all" className="text-black">All Cameras</option>
                        {availableCameraOptions.map((camera) => (
                            <option key={camera.id} value={camera.id} className="text-black">
                                {camera.name}
                            </option>
                        ))}
                    </select>
                </div>

                {totalPages > 1 && (
                    <div className="flex items-center gap-2 text-white text-xs">
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-white" onClick={handlePrevPage}>&lt;</Button>
                        <span>{page + 1}/{totalPages}</span>
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-white" onClick={handleNextPage}>&gt;</Button>
                    </div>
                )}
            </div>

            {/* Fullscreen Toggle */}
            <div className="absolute top-4 right-4 z-50 opacity-0 group-hover:opacity-100 transition-opacity hover:opacity-100">
                <Button size="icon" variant="secondary" className="bg-black/50 text-white hover:bg-black/70 backdrop-blur-md" onClick={toggleFullscreen}>
                    {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                </Button>
            </div>

            {/* Main Grid */}
            <div className={`flex-1 grid auto-rows-fr gap-1 bg-background h-full ${layout === 1 ? 'grid-cols-1' :
                layout === 4 ? 'grid-cols-2' :
                    'grid-cols-3'
                }`}>
                {displayedCameras.map(cam => (
                    <CameraFeedCard key={cam.id} camera={cam} apiUrl={apiUrl} />
                ))}

                {/* Fill empty slots if last page is not full */}
                {displayedCameras.length < layout && Array.from({ length: layout - displayedCameras.length }).map((_, i) => (
                    <div key={`empty-${i}`} className="bg-black/90 flex items-center justify-center text-muted-foreground border border-border/50">
                        <span className="text-sm">No Signal</span>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default Dashboard;
