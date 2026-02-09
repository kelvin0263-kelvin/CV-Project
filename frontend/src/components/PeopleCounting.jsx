import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import {
    PenTool, MousePointer2, Save, Trash2, RotateCcw,
    ArrowRightLeft, Users, ArrowDownToLine, ArrowUpFromLine,
    AlertTriangle
} from 'lucide-react';
import { cn } from '../lib/utils';
import { getApiBaseUrl, getWSUrl } from '../apiConfig';
import StreamPlayer from './StreamPlayer';
import CountingCanvas from './CountingCanvas';

const PeopleCounting = () => {
    const apiUrl = getApiBaseUrl();
    const videoContainerRef = useRef(null);

    // Camera state
    const [cameras, setCameras] = useState([]);
    const [selectedCamera, setSelectedCamera] = useState('');

    // Config state
    const [lines, setLines] = useState([]);
    const [zones, setZones] = useState([]);
    const [maxCapacity, setMaxCapacity] = useState('');
    const [enabled, setEnabled] = useState(true);
    const [configLoaded, setConfigLoaded] = useState(false);

    // Drawing mode
    const [drawingMode, setDrawingMode] = useState(null); // 'line' | 'roi' | null

    // Live counting data from WebSocket
    const [countingData, setCountingData] = useState({});
    const [stats, setStats] = useState({ fps: 0, people_count: 0 });

    // UI state
    const [saving, setSaving] = useState(false);
    const [saveMessage, setSaveMessage] = useState('');

    // --- Fetch cameras ---
    useEffect(() => {
        const fetchCameras = async () => {
            try {
                const res = await fetch(`${apiUrl}/api/cameras`);
                const data = await res.json();
                const enabledCameras = data.filter(c => c.enabled);
                setCameras(enabledCameras);
                if (enabledCameras.length > 0 && !selectedCamera) {
                    setSelectedCamera(enabledCameras[0].id);
                }
            } catch (err) {
                console.error('Failed to fetch cameras:', err);
            }
        };
        fetchCameras();
    }, [apiUrl]); // eslint-disable-line react-hooks/exhaustive-deps

    // --- Fetch counting config for selected camera ---
    useEffect(() => {
        if (!selectedCamera) return;

        const fetchConfig = async () => {
            setConfigLoaded(false);
            try {
                const res = await fetch(`${apiUrl}/api/people-counting-config/${selectedCamera}`);
                if (res.ok) {
                    const data = await res.json();
                    setLines(data.lines || []);
                    setZones(data.zones || []);
                    setMaxCapacity(data.max_capacity ?? '');
                    setEnabled(data.enabled ?? true);
                } else {
                    // No config yet -- defaults
                    setLines([]);
                    setZones([]);
                    setMaxCapacity('');
                    setEnabled(true);
                }
            } catch (err) {
                console.error('Failed to fetch counting config:', err);
                setLines([]);
                setZones([]);
                setMaxCapacity('');
                setEnabled(true);
            }
            setConfigLoaded(true);
        };
        fetchConfig();
    }, [selectedCamera, apiUrl]);

    // --- Save config ---
    const handleSave = async () => {
        if (!selectedCamera) return;
        setSaving(true);
        setSaveMessage('');

        try {
            const body = {
                enabled,
                max_capacity: maxCapacity ? parseInt(maxCapacity, 10) : null,
                lines,
                zones,
            };
            const res = await fetch(`${apiUrl}/api/people-counting-config/${selectedCamera}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.ok) {
                setSaveMessage('Configuration saved successfully');
            } else {
                const err = await res.json();
                setSaveMessage(`Error: ${err.detail || 'Failed to save'}`);
            }
        } catch (err) {
            setSaveMessage(`Error: ${err.message}`);
        }
        setSaving(false);
        setTimeout(() => setSaveMessage(''), 3000);
    };

    // --- Drawing callbacks ---
    const handleLineDrawn = useCallback(({ points, direction }) => {
        const newLine = {
            id: `line_${Date.now()}`,
            name: `Line ${lines.length + 1}`,
            points,
            direction: direction || 'left_to_right',
        };
        setLines(prev => [...prev, newLine]);
        setDrawingMode(null);
    }, [lines.length]);

    const handleZoneDrawn = useCallback(({ points }) => {
        const newZone = {
            id: `zone_${Date.now()}`,
            name: `Zone ${zones.length + 1}`,
            points,
        };
        setZones(prev => [...prev, newZone]);
        setDrawingMode(null);
    }, [zones.length]);

    // --- Delete line/zone ---
    const deleteLine = (id) => setLines(prev => prev.filter(l => l.id !== id));
    const deleteZone = (id) => setZones(prev => prev.filter(z => z.id !== id));

    // --- Toggle line direction ---
    const toggleDirection = (id) => {
        setLines(prev => prev.map(l =>
            l.id === id
                ? { ...l, direction: l.direction === 'left_to_right' ? 'right_to_left' : 'left_to_right' }
                : l
        ));
    };

    // --- Reset all ---
    const handleReset = () => {
        setLines([]);
        setZones([]);
        setMaxCapacity('');
        setDrawingMode(null);
    };

    // --- WebSocket stats callback ---
    const handleStats = useCallback((s) => {
        setStats(s);
    }, []);

    // --- WebSocket counting data callback ---
    const handleCountingData = useCallback((data) => {
        if (data && typeof data === 'object') {
            setCountingData(data);
        }
    }, []);

    const wsUrl = selectedCamera ? getWSUrl(`/ws/${selectedCamera}`) : null;
    const selectedCam = cameras.find(c => c.id === selectedCamera);

    const occupancy = countingData.occupancy ?? 0;
    const capacityExceeded = countingData.capacity_exceeded ?? false;

    return (
        <div className="flex flex-col h-full space-y-6">
            <div className="flex items-center justify-between">
                <h1 className="text-3xl font-bold tracking-tight">People Counting</h1>
                {capacityExceeded && (
                    <div className="flex items-center gap-2 px-4 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-500">
                        <AlertTriangle className="w-4 h-4" />
                        <span className="text-sm font-medium">Capacity Exceeded!</span>
                    </div>
                )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-0">
                {/* --- Configuration Sidebar --- */}
                <Card className="lg:col-span-1 overflow-y-auto">
                    <CardHeader>
                        <CardTitle>Settings</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        {/* Camera Selection */}
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Select Camera</label>
                            <select
                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                value={selectedCamera}
                                onChange={(e) => setSelectedCamera(e.target.value)}
                            >
                                {cameras.length === 0 && <option value="">No cameras available</option>}
                                {cameras.map(cam => (
                                    <option key={cam.id} value={cam.id}>{cam.name}</option>
                                ))}
                            </select>
                        </div>

                        {/* Enable/Disable */}
                        <div className="flex items-center justify-between">
                            <label className="text-sm font-medium">Counting Enabled</label>
                            <button
                                onClick={() => setEnabled(!enabled)}
                                className={cn(
                                    "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                                    enabled ? "bg-primary" : "bg-muted"
                                )}
                            >
                                <span className={cn(
                                    "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                                    enabled ? "translate-x-6" : "translate-x-1"
                                )} />
                            </button>
                        </div>

                        {/* Drawing Tools */}
                        <div className="space-y-3">
                            <div className="text-sm font-medium">Drawing Tools</div>
                            <div className="flex gap-2">
                                <Button
                                    variant={drawingMode === 'line' ? 'default' : 'outline'}
                                    className="flex-1"
                                    onClick={() => setDrawingMode(drawingMode === 'line' ? null : 'line')}
                                >
                                    <PenTool className="w-4 h-4 mr-2" />
                                    Draw Line
                                </Button>
                                <Button
                                    variant={drawingMode === 'roi' ? 'default' : 'outline'}
                                    className="flex-1"
                                    onClick={() => setDrawingMode(drawingMode === 'roi' ? null : 'roi')}
                                >
                                    <MousePointer2 className="w-4 h-4 mr-2" />
                                    Draw ROI
                                </Button>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {drawingMode === 'line'
                                    ? 'Click and drag on the video to draw a counting line.'
                                    : drawingMode === 'roi'
                                        ? 'Click points on the video to define a zone. Double-click to close.'
                                        : 'Select a tool to draw counting zones on the video.'}
                            </p>
                        </div>

                        {/* Counting Lines List */}
                        {lines.length > 0 && (
                            <div className="space-y-2">
                                <div className="text-sm font-medium">Counting Lines ({lines.length})</div>
                                {lines.map((line, i) => (
                                    <div key={line.id} className="flex items-center gap-2 p-2 rounded-md border bg-muted/30">
                                        <div className="w-3 h-3 rounded-full bg-yellow-400 shrink-0" />
                                        <span className="text-sm flex-1 truncate">{line.name}</span>
                                        <Button
                                            variant="ghost" size="icon" className="h-7 w-7"
                                            onClick={() => toggleDirection(line.id)}
                                            title={`Direction: ${line.direction === 'left_to_right' ? 'L→R = IN' : 'R→L = IN'}`}
                                        >
                                            <ArrowRightLeft className="w-3.5 h-3.5" />
                                        </Button>
                                        <Button
                                            variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                                            onClick={() => deleteLine(line.id)}
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Zones List */}
                        {zones.length > 0 && (
                            <div className="space-y-2">
                                <div className="text-sm font-medium">ROI Zones ({zones.length})</div>
                                {zones.map((zone, i) => (
                                    <div key={zone.id} className="flex items-center gap-2 p-2 rounded-md border bg-muted/30">
                                        <div className="w-3 h-3 rounded-full bg-blue-500 shrink-0" />
                                        <span className="text-sm flex-1 truncate">{zone.name}</span>
                                        <Button
                                            variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                                            onClick={() => deleteZone(zone.id)}
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Max Capacity */}
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Max Occupancy Capacity</label>
                            <input
                                type="number"
                                min="1"
                                placeholder="e.g. 50"
                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                value={maxCapacity}
                                onChange={(e) => setMaxCapacity(e.target.value)}
                            />
                            <p className="text-xs text-muted-foreground">
                                An alert will trigger when occupancy reaches this value.
                            </p>
                        </div>

                        {/* Live Counting Stats */}
                        <div className="space-y-3">
                            <div className="text-sm font-medium">Live Counting</div>
                            <div className="grid grid-cols-3 gap-2">
                                <div className="flex flex-col items-center p-3 rounded-lg bg-green-500/10 border border-green-500/20">
                                    <ArrowDownToLine className="w-4 h-4 text-green-500 mb-1" />
                                    <span className="text-lg font-bold text-green-500">{countingData.total_in ?? 0}</span>
                                    <span className="text-[10px] text-muted-foreground">IN</span>
                                </div>
                                <div className="flex flex-col items-center p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                                    <ArrowUpFromLine className="w-4 h-4 text-red-500 mb-1" />
                                    <span className="text-lg font-bold text-red-500">{countingData.total_out ?? 0}</span>
                                    <span className="text-[10px] text-muted-foreground">OUT</span>
                                </div>
                                <div className={cn(
                                    "flex flex-col items-center p-3 rounded-lg border",
                                    capacityExceeded
                                        ? "bg-red-500/10 border-red-500/30"
                                        : "bg-primary/10 border-primary/20"
                                )}>
                                    <Users className={cn("w-4 h-4 mb-1", capacityExceeded ? "text-red-500" : "text-primary")} />
                                    <span className={cn("text-lg font-bold", capacityExceeded ? "text-red-500" : "text-primary")}>{occupancy}</span>
                                    <span className="text-[10px] text-muted-foreground">
                                        {maxCapacity ? `/ ${maxCapacity}` : 'NOW'}
                                    </span>
                                </div>
                            </div>
                        </div>

                        {/* Actions */}
                        <div className="space-y-2 pt-2">
                            <Button onClick={handleSave} className="w-full" disabled={saving || !selectedCamera}>
                                <Save className="w-4 h-4 mr-2" />
                                {saving ? 'Saving...' : 'Save Configuration'}
                            </Button>
                            <Button variant="outline" onClick={handleReset} className="w-full">
                                <RotateCcw className="w-4 h-4 mr-2" />
                                Reset All
                            </Button>
                            {saveMessage && (
                                <p className={cn(
                                    "text-xs text-center",
                                    saveMessage.startsWith('Error') ? 'text-destructive' : 'text-green-500'
                                )}>
                                    {saveMessage}
                                </p>
                            )}
                        </div>
                    </CardContent>
                </Card>

                {/* --- Video Area --- */}
                <Card className="lg:col-span-2 overflow-hidden flex flex-col bg-black">
                    <div ref={videoContainerRef} className="relative flex-1 min-h-[400px]">
                        {wsUrl ? (
                            <>
                                <StreamPlayer
                                    wsUrl={wsUrl}
                                    className="w-full h-full"
                                    alt={selectedCam?.name || 'Camera Feed'}
                                    onStats={handleStats}
                                    onCountingData={handleCountingData}
                                />
                                <CountingCanvas
                                    lines={lines}
                                    zones={zones}
                                    countingData={countingData}
                                    drawingMode={drawingMode}
                                    onLineDrawn={handleLineDrawn}
                                    onZoneDrawn={handleZoneDrawn}
                                    containerRef={videoContainerRef}
                                />
                            </>
                        ) : (
                            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                                <p>Select a camera to view the feed</p>
                            </div>
                        )}
                    </div>
                    <div className="p-2 bg-card border-t flex justify-between items-center text-xs text-muted-foreground">
                        <span>{selectedCam?.name || 'No camera selected'}</span>
                        <div className="flex gap-4">
                            <span>People: {stats.people_count}</span>
                            <span>FPS: {stats.fps}</span>
                        </div>
                    </div>
                </Card>
            </div>
        </div>
    );
};

export default PeopleCounting;
