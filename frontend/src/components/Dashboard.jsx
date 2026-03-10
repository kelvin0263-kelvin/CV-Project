import React, { useState, useRef, useEffect } from 'react';
import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import { HardDrive, Circle, ChevronRight, LayoutGrid, Users, Shirt, ShieldCheck, Maximize2, Minimize2, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
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

const CameraFeedCard = ({ camera }) => {
    const [stats, setStats] = useState({ fps: 0, people_count: 0 });
    const [countingData, setCountingData] = useState({});
    const wsUrl = getWSUrl(`/ws/${camera.id}`);
    const isStreamSource = camera.type.includes("RTSP") || camera.type.includes("File") || camera.type.includes("Fisheye");
    const overlayMode = inferOverlayMode(camera.analysis_tags);

    const hasCountingData = countingData && (countingData.total_in > 0 || countingData.total_out > 0);

    return (
        <div className="relative group overflow-hidden bg-black rounded-sm border border-border/50 h-full w-full flex items-center justify-center">
            {/* Live Feed or Image */}
            {isStreamSource ? (
                <StreamPlayer
                    wsUrl={wsUrl}
                    className="w-full h-full"
                    alt={camera.name}
                    onStats={setStats}
                    onCountingData={setCountingData}
                    overlayMode={overlayMode}
                    showCountingAnchors={overlayMode === 'counting'}
                />
            ) : (
                <div className="absolute inset-0 bg-muted/20 flex items-center justify-center text-muted-foreground">
                    <img src={camera.image} className="w-full h-full object-cover opacity-80" alt={camera.name} onError={(e) => { e.target.style.display = 'none' }} />
                    <span className="absolute">RTSP Feed Placeholder</span>
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
    const [cameras, setCameras] = useState([]);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [layout, setLayout] = useState(9); // Default to 9 for multiscreen view
    const [page, setPage] = useState(0);
    const containerRef = useRef(null);

    async function fetchCameras() {
        try {
            const apiUrl = getApiBaseUrl();
            console.log("Dashboard fetching from:", apiUrl);
            const res = await fetch(`${apiUrl}/api/cameras`);
            const data = await res.json();
            // Filter only enabled cameras
            setCameras(data.filter(c => c.enabled));
        } catch (error) {
            console.error("Failed to fetch cameras:", error);
        }
    }

    useEffect(() => {
        const timeoutId = setTimeout(() => {
            void fetchCameras();
        }, 0);
        return () => clearTimeout(timeoutId);
    }, []);

    const totalCameras = cameras.length;
    const totalPages = Math.ceil(totalCameras / layout) || 1;

    const startIndex = page * layout;
    const displayedCameras = cameras.slice(startIndex, startIndex + layout);

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
                    <CameraFeedCard key={cam.id} camera={cam} />
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
