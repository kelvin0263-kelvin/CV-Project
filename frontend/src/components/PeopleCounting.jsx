import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import {
    PenTool, Save, Trash2, RotateCcw,
    ArrowRightLeft, Users, ArrowDownToLine, ArrowUpFromLine,
    AlertTriangle, Plus, DoorOpen, ChevronDown, ChevronRight,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { getApiBaseUrl, getWSUrl } from '../apiConfig';
import StreamPlayer from './StreamPlayer';
import CountingCanvas from './CountingCanvas';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ZONE_TYPE_META = {
    outside: { color: 'bg-orange-500', label: 'Outside', icon: '🅰' },
    door:    { color: 'bg-yellow-400', label: 'Door',    icon: '🅱' },
    inside:  { color: 'bg-green-500',  label: 'Inside',  icon: '🅲' },
};

/** Derive entrance groups from the flat zones array. */
function deriveGroups(zones) {
    const groups = {};
    for (const z of zones) {
        if (z.group_id && z.zone_type) {
            if (!groups[z.group_id]) groups[z.group_id] = { id: z.group_id, name: z.group_id, zones: {} };
            groups[z.group_id].zones[z.zone_type] = z;
        }
    }
    return groups;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
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
    const [drawingZoneType, setDrawingZoneType] = useState(null); // 'outside'|'door'|'inside'|null
    const [pendingGroupId, setPendingGroupId] = useState(null); // which group the drawing belongs to

    // Live counting data from WebSocket
    const [countingData, setCountingData] = useState({});
    const [stats, setStats] = useState({ fps: 0, people_count: 0 });

    // UI state
    const [saving, setSaving] = useState(false);
    const [saveMessage, setSaveMessage] = useState('');
    const [expandedGroups, setExpandedGroups] = useState({}); // group_id -> bool
    const [showLineCrossing, setShowLineCrossing] = useState(true);

    // Derived entrance groups
    const entranceGroups = useMemo(() => deriveGroups(zones), [zones]);

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
                    // Auto-expand loaded groups
                    const groups = deriveGroups(data.zones || []);
                    const expanded = {};
                    for (const gid of Object.keys(groups)) expanded[gid] = true;
                    setExpandedGroups(expanded);
                } else {
                    setLines([]); setZones([]); setMaxCapacity(''); setEnabled(true);
                }
            } catch (err) {
                console.error('Failed to fetch counting config:', err);
                setLines([]); setZones([]); setMaxCapacity(''); setEnabled(true);
            }
            setConfigLoaded(true);
        };
        fetchConfig();
    }, [selectedCamera, apiUrl]);

    // --- Save config ---
    const handleSave = async () => {
        if (!selectedCamera) return;
        setSaving(true); setSaveMessage('');
        try {
            // Filter out placeholder zones (no drawn points) before saving
            const zonesToSave = zones.filter(z => z.points && z.points.length >= 3);
            const body = { enabled, max_capacity: maxCapacity ? parseInt(maxCapacity, 10) : null, lines, zones: zonesToSave };
            const res = await fetch(`${apiUrl}/api/people-counting-config/${selectedCamera}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            });
            if (res.ok) setSaveMessage('Configuration saved successfully');
            else {
                const err = await res.json();
                setSaveMessage(`Error: ${err.detail || 'Failed to save'}`);
            }
        } catch (err) { setSaveMessage(`Error: ${err.message}`); }
        setSaving(false);
        setTimeout(() => setSaveMessage(''), 3000);
    };

    // --- Drawing callbacks ---
    const handleLineDrawn = useCallback(({ points, direction }) => {
        const newLine = {
            id: `line_${Date.now()}`, name: `Line ${lines.length + 1}`,
            points, direction: direction || 'left_to_right',
        };
        setLines(prev => [...prev, newLine]);
        setDrawingMode(null);
    }, [lines.length]);

    const handleZoneDrawn = useCallback(({ points }) => {
        const newZone = {
            id: `zone_${Date.now()}`,
            name: drawingZoneType
                ? `${ZONE_TYPE_META[drawingZoneType]?.label || drawingZoneType}`
                : `Zone ${zones.length + 1}`,
            points,
            ...(pendingGroupId && drawingZoneType ? { group_id: pendingGroupId, zone_type: drawingZoneType } : {}),
        };
        setZones(prev => [...prev, newZone]);
        setDrawingMode(null);
        setDrawingZoneType(null);
        setPendingGroupId(null);
    }, [zones.length, drawingZoneType, pendingGroupId]);

    // --- Delete / toggle ---
    const deleteLine = (id) => setLines(prev => prev.filter(l => l.id !== id));
    const deleteZone = (id) => setZones(prev => prev.filter(z => z.id !== id));
    const toggleDirection = (id) => {
        setLines(prev => prev.map(l =>
            l.id === id ? { ...l, direction: l.direction === 'left_to_right' ? 'right_to_left' : 'left_to_right' } : l
        ));
    };

    // --- Entrance group management ---
    const addEntranceGroup = () => {
        const existing = Object.keys(entranceGroups).length;
        const gid = `entrance_${Date.now()}`;
        // Just expand - zones will be added as user draws
        setExpandedGroups(prev => ({ ...prev, [gid]: true }));
        // Add placeholder zones so the group appears in the UI immediately.
        // Inside zone is optional (2-zone mode). Placeholders with empty points
        // are filtered out on save.
        setZones(prev => [
            ...prev,
            { id: `${gid}_outside_placeholder`, name: 'Outside', points: [], zone_type: 'outside', group_id: gid },
            { id: `${gid}_door_placeholder`, name: 'Door', points: [], zone_type: 'door', group_id: gid },
            { id: `${gid}_inside_placeholder`, name: 'Inside', points: [], zone_type: 'inside', group_id: gid },
        ]);
    };

    const deleteEntranceGroup = (gid) => {
        setZones(prev => prev.filter(z => z.group_id !== gid));
        setExpandedGroups(prev => { const n = { ...prev }; delete n[gid]; return n; });
    };

    const startDrawZone = (groupId, zoneType) => {
        // Remove existing zone of this type in this group (will be replaced)
        setZones(prev => prev.filter(z => !(z.group_id === groupId && z.zone_type === zoneType)));
        setPendingGroupId(groupId);
        setDrawingZoneType(zoneType);
        setDrawingMode('roi');
    };

    const toggleGroup = (gid) => {
        setExpandedGroups(prev => ({ ...prev, [gid]: !prev[gid] }));
    };

    // --- Reset all ---
    const handleReset = () => {
        setLines([]); setZones([]); setMaxCapacity(''); setDrawingMode(null);
        setDrawingZoneType(null); setPendingGroupId(null); setExpandedGroups({});
    };

    // --- WebSocket callbacks ---
    const handleStats = useCallback((s) => setStats(s), []);
    const handleCountingData = useCallback((data) => {
        if (data && typeof data === 'object') setCountingData(data);
    }, []);

    const wsUrl = selectedCamera ? getWSUrl(`/ws/${selectedCamera}`) : null;
    const selectedCam = cameras.find(c => c.id === selectedCamera);
    const occupancy = countingData.occupancy ?? 0;
    const capacityExceeded = countingData.capacity_exceeded ?? false;
    const zoneGroupCounts = countingData.zone_group_counts ?? {};

    // Filter out placeholder zones (no points) for display on canvas
    const displayZones = zones.filter(z => z.points && z.points.length >= 3);

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
                    <CardContent className="space-y-5">
                        {/* Camera Selection */}
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Select Camera</label>
                            <select
                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                            <button onClick={() => setEnabled(!enabled)}
                                className={cn("relative inline-flex h-6 w-11 items-center rounded-full transition-colors", enabled ? "bg-primary" : "bg-muted")}>
                                <span className={cn("inline-block h-4 w-4 transform rounded-full bg-white transition-transform", enabled ? "translate-x-6" : "translate-x-1")} />
                            </button>
                        </div>

                        {/* ============== ENTRANCE GROUPS ============== */}
                        <div className="space-y-3">
                            <div className="flex items-center justify-between">
                                <div className="text-sm font-medium flex items-center gap-1.5">
                                    <DoorOpen className="w-4 h-4" />
                                    Entrance Groups
                                </div>
                                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={addEntranceGroup}>
                                    <Plus className="w-3 h-3 mr-1" /> Add
                                </Button>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Draw Outside + Door zones (Inside is optional). 2-zone mode uses disappear-inference for entrances near frame edges.
                            </p>

                            {Object.entries(entranceGroups).map(([gid, group]) => {
                                const isExpanded = expandedGroups[gid] ?? false;
                                const gCounts = zoneGroupCounts[gid];
                                const groupName = `Entrance ${Object.keys(entranceGroups).indexOf(gid) + 1}`;

                                // Determine mode: has Inside zone drawn?
                                const hasOutside = group.zones.outside?.points?.length >= 3;
                                const hasDoor = group.zones.door?.points?.length >= 3;
                                const hasInside = group.zones.inside?.points?.length >= 3;
                                const groupMode = hasOutside && hasDoor && hasInside ? '3-zone'
                                    : hasOutside && hasDoor ? '2-zone' : 'incomplete';

                                return (
                                    <div key={gid} className="border rounded-lg overflow-hidden">
                                        {/* Group header */}
                                        <div className="flex items-center gap-2 p-2 bg-muted/30 cursor-pointer"
                                            onClick={() => toggleGroup(gid)}>
                                            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                                            <DoorOpen className="w-4 h-4 text-primary" />
                                            <span className="text-sm font-medium flex-1">{groupName}</span>
                                            {hasOutside && hasDoor && (
                                                <span className={cn("text-[9px] px-1.5 py-0.5 rounded-full font-medium",
                                                    groupMode === '2-zone' ? "bg-yellow-500/15 text-yellow-600" : "bg-green-500/15 text-green-600"
                                                )}>
                                                    {groupMode}
                                                </span>
                                            )}
                                            {gCounts && (
                                                <span className="text-[10px] text-muted-foreground">
                                                    IN:{gCounts.total_in} OUT:{gCounts.total_out}
                                                </span>
                                            )}
                                            <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive shrink-0"
                                                onClick={(e) => { e.stopPropagation(); deleteEntranceGroup(gid); }}>
                                                <Trash2 className="w-3 h-3" />
                                            </Button>
                                        </div>

                                        {/* Group zones */}
                                        {isExpanded && (
                                            <div className="p-2 space-y-1.5">
                                                {['outside', 'door', 'inside'].map((ztype) => {
                                                    const meta = ZONE_TYPE_META[ztype];
                                                    const zoneExists = group.zones[ztype] && group.zones[ztype].points?.length >= 3;
                                                    const isDrawing = drawingMode === 'roi' && pendingGroupId === gid && drawingZoneType === ztype;
                                                    const isOptional = ztype === 'inside';

                                                    return (
                                                        <div key={ztype} className={cn(
                                                            "flex items-center gap-2 p-1.5 rounded-md border text-xs",
                                                            isDrawing ? "border-primary bg-primary/5" : "bg-muted/20"
                                                        )}>
                                                            <div className={cn("w-2.5 h-2.5 rounded-full shrink-0", meta.color)} />
                                                            <span className="font-medium flex-1">
                                                                {meta.label} Zone
                                                                {isOptional && <span className="text-muted-foreground font-normal ml-1">(optional)</span>}
                                                            </span>
                                                            {zoneExists ? (
                                                                <>
                                                                    <span className="text-muted-foreground">✓</span>
                                                                    <Button variant="ghost" size="icon" className="h-5 w-5"
                                                                        onClick={() => startDrawZone(gid, ztype)} title="Redraw">
                                                                        <PenTool className="w-2.5 h-2.5" />
                                                                    </Button>
                                                                </>
                                                            ) : (
                                                                <Button variant="outline" size="sm"
                                                                    className={cn("h-6 text-[10px] px-2", isDrawing && "bg-primary text-primary-foreground")}
                                                                    onClick={() => startDrawZone(gid, ztype)}>
                                                                    {isDrawing ? 'Drawing...' : 'Draw'}
                                                                </Button>
                                                            )}
                                                        </div>
                                                    );
                                                })}

                                                {/* Per-group live stats */}
                                                {gCounts && (
                                                    <div className="grid grid-cols-3 gap-1 pt-1">
                                                        <div className="text-center p-1 rounded bg-green-500/10 text-[10px]">
                                                            <div className="font-bold text-green-500">{gCounts.total_in}</div>
                                                            <div className="text-muted-foreground">IN</div>
                                                        </div>
                                                        <div className="text-center p-1 rounded bg-red-500/10 text-[10px]">
                                                            <div className="font-bold text-red-500">{gCounts.total_out}</div>
                                                            <div className="text-muted-foreground">OUT</div>
                                                        </div>
                                                        <div className="text-center p-1 rounded bg-primary/10 text-[10px]">
                                                            <div className="font-bold text-primary">{gCounts.occupancy}</div>
                                                            <div className="text-muted-foreground">NOW</div>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>

                        {/* ============== LINE CROSSING (collapsible) ============== */}
                        <div className="space-y-3">
                            <div className="flex items-center justify-between cursor-pointer"
                                onClick={() => setShowLineCrossing(!showLineCrossing)}>
                                <div className="text-sm font-medium flex items-center gap-1.5">
                                    {showLineCrossing ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                                    <PenTool className="w-4 h-4" />
                                    Line Crossing
                                </div>
                            </div>

                            {showLineCrossing && (
                                <div className="space-y-3 pl-1">
                                    <div className="flex gap-2">
                                        <Button
                                            variant={drawingMode === 'line' ? 'default' : 'outline'}
                                            size="sm" className="flex-1 h-8 text-xs"
                                            onClick={() => {
                                                setDrawingMode(drawingMode === 'line' ? null : 'line');
                                                setDrawingZoneType(null);
                                                setPendingGroupId(null);
                                            }}
                                        >
                                            <PenTool className="w-3 h-3 mr-1" /> Draw Line
                                        </Button>
                                    </div>

                                    {lines.map((line, i) => (
                                        <div key={line.id} className="flex items-center gap-2 p-1.5 rounded-md border bg-muted/30 text-xs">
                                            <div className="w-2.5 h-2.5 rounded-full bg-yellow-400 shrink-0" />
                                            <span className="flex-1 truncate">{line.name}</span>
                                            <Button variant="ghost" size="icon" className="h-6 w-6"
                                                onClick={() => toggleDirection(line.id)}
                                                title={`Direction: ${line.direction === 'left_to_right' ? 'L→R = IN' : 'R→L = IN'}`}>
                                                <ArrowRightLeft className="w-3 h-3" />
                                            </Button>
                                            <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive"
                                                onClick={() => deleteLine(line.id)}>
                                                <Trash2 className="w-3 h-3" />
                                            </Button>
                                        </div>
                                    ))}

                                    {drawingMode === 'line' && (
                                        <p className="text-xs text-muted-foreground">
                                            Click and drag on the video to draw a counting line.
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Max Capacity */}
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Max Occupancy Capacity</label>
                            <input type="number" min="1" placeholder="e.g. 50"
                                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                value={maxCapacity} onChange={(e) => setMaxCapacity(e.target.value)} />
                            <p className="text-xs text-muted-foreground">Alert triggers when occupancy reaches this value.</p>
                        </div>

                        {/* Live Counting Stats (total) */}
                        <div className="space-y-3">
                            <div className="text-sm font-medium">Live Counting (Total)</div>
                            <div className="grid grid-cols-3 gap-2">
                                <div className="flex flex-col items-center p-2.5 rounded-lg bg-green-500/10 border border-green-500/20">
                                    <ArrowDownToLine className="w-4 h-4 text-green-500 mb-1" />
                                    <span className="text-lg font-bold text-green-500">{countingData.total_in ?? 0}</span>
                                    <span className="text-[10px] text-muted-foreground">IN</span>
                                </div>
                                <div className="flex flex-col items-center p-2.5 rounded-lg bg-red-500/10 border border-red-500/20">
                                    <ArrowUpFromLine className="w-4 h-4 text-red-500 mb-1" />
                                    <span className="text-lg font-bold text-red-500">{countingData.total_out ?? 0}</span>
                                    <span className="text-[10px] text-muted-foreground">OUT</span>
                                </div>
                                <div className={cn("flex flex-col items-center p-2.5 rounded-lg border",
                                    capacityExceeded ? "bg-red-500/10 border-red-500/30" : "bg-primary/10 border-primary/20")}>
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
                                <p className={cn("text-xs text-center",
                                    saveMessage.startsWith('Error') ? 'text-destructive' : 'text-green-500')}>
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
                                    zones={displayZones}
                                    countingData={countingData}
                                    drawingMode={drawingMode}
                                    drawingZoneType={drawingZoneType}
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
