import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { PenTool, Save, Trash2, RotateCcw, ArrowRightLeft, Users, ArrowDownToLine, ArrowUpFromLine, AlertTriangle, ChevronDown, ChevronRight, Building2, Link2 } from 'lucide-react';
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

const filterValidFrameExcludeAreas = (areas) => Array.isArray(areas)
    ? areas.filter((area) => area?.points?.length >= 3)
    : [];

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
    const [showLineCrossing, setShowLineCrossing] = useState(true);
    const [buildingEnabled, setBuildingEnabled] = useState(true);
    const [buildingMaxCapacity, setBuildingMaxCapacity] = useState('');
    const [buildingManualOffset, setBuildingManualOffset] = useState('0');
    const [buildingSummary, setBuildingSummary] = useState(EMPTY_BUILDING_SUMMARY);
    const [resettingBuilding, setResettingBuilding] = useState(false);
    const [resettingCamera, setResettingCamera] = useState(false);

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
                const enabledCameras = data.filter((camera) => camera.enabled);
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
                    if (!cancelled) resetCountingConfig();
                    return;
                }
                const data = await res.json();
                if (cancelled) return;
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
                if (!cancelled) resetCountingConfig();
            }
        };
        fetchConfig();
        return () => { cancelled = true; };
    }, [selectedCamera, apiUrl, resetCountingConfig]);

    useEffect(() => {
        const fetchBuildingConfig = async () => {
            try {
                const res = await fetch(`${apiUrl}/api/building-counting-config`);
                if (!res.ok) return;
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
                if (!res.ok) return;
                const data = await res.json();
                if (isMounted) setBuildingSummary(data);
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

    const handleSave = async () => {
        if (!selectedCamera) return;
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
        if (!selectedCamera) return;
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
        setLines((prevLines) => [...prevLines, { id: `line_${Date.now()}`, name: `Line ${prevLines.length + 1}`, points, direction: direction || 'left_to_right', count_event: 'in' }]);
        setDrawingMode(null);
    }, []);
    const handleFrameExcludeAreaDrawn = useCallback(({ points }) => {
        setFrameExcludeAreas((prevAreas) => [...prevAreas, { id: `frame_exclude_${Date.now()}`, name: `Active Zone ${prevAreas.length + 1}`, points }]);
        setDrawingMode(null);
    }, []);
    const deleteLine = (lineId) => setLines((prevLines) => prevLines.filter((line) => line.id !== lineId));
    const deleteFrameExcludeArea = (areaId) => setFrameExcludeAreas((prevAreas) => prevAreas.filter((area) => area.id !== areaId));
    const toggleDirection = (lineId) => setLines((prevLines) => prevLines.map((line) => (line.id === lineId ? { ...line, direction: line.direction === 'left_to_right' ? 'right_to_left' : 'left_to_right' } : line)));
    const toggleLineEvent = (lineId) => setLines((prevLines) => prevLines.map((line) => (line.id === lineId ? { ...line, count_event: line.count_event === 'out' ? 'in' : 'out' } : line)));
    const handleReset = () => { resetCountingConfig(); setSaveMessage(''); };
    const handleStats = useCallback((nextStats) => setStats(nextStats), []);
    const handleCountingData = useCallback((nextData) => { if (nextData && typeof nextData === 'object') setCountingData(nextData); }, []);

    const wsUrl = selectedCamera ? getWSUrl(`/ws/${selectedCamera}`) : null;
    const selectedCam = cameras.find((camera) => camera.id === selectedCamera);
    const verificationCameraOptions = cameras.filter((camera) => camera.id !== selectedCamera);
    const occupancy = countingData.occupancy ?? 0;
    const buildingCapacityExceeded = buildingSummary.capacity_exceeded ?? false;
    const buildingEntranceSummaries = buildingSummary.entrance_summaries ?? {};
    const validFrameExcludeAreas = filterValidFrameExcludeAreas(frameExcludeAreas);

    const settingsPanel = (
        <Card className="lg:col-span-1 overflow-y-auto">
            <CardHeader><CardTitle>Settings</CardTitle></CardHeader>
            <CardContent className="space-y-5">
                <div className="space-y-2">
                    <label className="text-sm font-medium">Select Camera</label>
                    <select
                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        value={selectedCamera}
                        onChange={(e) => setSelectedCamera(e.target.value)}
                    >
                        {cameras.length === 0 && <option value="">No cameras available</option>}
                        {cameras.map((camera) => <option key={camera.id} value={camera.id}>{camera.name}</option>)}
                    </select>
                </div>

                <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">Counting Enabled</label>
                    <button onClick={() => setEnabled(!enabled)} className={cn('relative inline-flex h-6 w-11 items-center rounded-full transition-colors', enabled ? 'bg-primary' : 'bg-muted')}>
                        <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white transition-transform', enabled ? 'translate-x-6' : 'translate-x-1')} />
                    </button>
                </div>

                <div className="space-y-3">
                    <div className="flex items-center justify-between cursor-pointer" onClick={() => setShowLineCrossing(!showLineCrossing)}>
                        <div className="text-sm font-medium flex items-center gap-1.5">
                            {showLineCrossing ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                            <PenTool className="w-4 h-4" />
                            Line Crossing
                        </div>
                    </div>
                    {showLineCrossing && (
                        <div className="space-y-3 pl-1">
                            <Button variant={drawingMode === 'line' ? 'default' : 'outline'} size="sm" className="w-full h-8 text-xs" onClick={() => setDrawingMode(drawingMode === 'line' ? null : 'line')}>
                                <PenTool className="w-3 h-3 mr-1" /> Draw Line
                            </Button>
                            {lines.map((line, index) => (
                                <div key={line.id} className="flex items-center gap-2 p-1.5 rounded-md border bg-muted/30 text-xs">
                                    <div className={cn('w-2.5 h-2.5 rounded-full shrink-0', line.count_event === 'out' ? 'bg-red-500' : 'bg-yellow-400')} />
                                    <span className="flex-1 truncate">{line.name || `Line ${index + 1}`}</span>
                                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => toggleLineEvent(line.id)} title={`Count event: ${line.count_event === 'out' ? 'OUT' : 'IN'}`}>
                                        {line.count_event === 'out' ? <ArrowUpFromLine className="w-3 h-3 text-red-500" /> : <ArrowDownToLine className="w-3 h-3 text-yellow-500" />}
                                    </Button>
                                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => toggleDirection(line.id)} title={`Direction: ${line.direction === 'left_to_right' ? 'L->R' : 'R->L'}`}>
                                        <ArrowRightLeft className="w-3 h-3" />
                                    </Button>
                                    <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => deleteLine(line.id)}>
                                        <Trash2 className="w-3 h-3" />
                                    </Button>
                                </div>
                            ))}
                            {drawingMode === 'line' && <p className="text-xs text-muted-foreground">Click and drag on the video to draw a counting line.</p>}
                        </div>
                    )}
                </div>

                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                        <div className="text-sm font-medium flex items-center gap-1.5">
                            <PenTool className="w-4 h-4" />
                            Active Counting Zone
                        </div>
                        <Button variant={drawingMode === 'frame_exclude' ? 'default' : 'outline'} size="sm" className="h-7 text-xs" onClick={() => setDrawingMode(drawingMode === 'frame_exclude' ? null : 'frame_exclude')}>
                            <PenTool className="w-3 h-3 mr-1" />
                            {drawingMode === 'frame_exclude' ? 'Cancel' : 'Draw Area'}
                        </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">A line-cross or disappear count only triggers when the counting probe point is inside this polygon.</p>
                    {validFrameExcludeAreas.map((area, index) => (
                        <div key={area.id} className="flex items-center gap-2 p-1.5 rounded-md border bg-muted/30 text-xs">
                            <div className="w-2.5 h-2.5 rounded-full shrink-0 bg-sky-500" />
                            <span className="flex-1 truncate">{area.name || `Active Zone ${index + 1}`}</span>
                            <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => deleteFrameExcludeArea(area.id)}>
                                <Trash2 className="w-3 h-3" />
                            </Button>
                        </div>
                    ))}
                    {drawingMode === 'frame_exclude' && <p className="text-xs text-muted-foreground">Click around the video to draw the active zone, then double-click to close it.</p>}
                </div>

                <div className="space-y-3 border rounded-lg p-3 bg-muted/20">
                    <div className="text-sm font-medium flex items-center gap-1.5"><Link2 className="w-4 h-4" />Building Entrance Group</div>
                    <div className="flex items-center justify-between">
                        <label className="text-sm">Participates in Building Count</label>
                        <button onClick={() => setParticipateInBuildingCount(!participateInBuildingCount)} className={cn('relative inline-flex h-6 w-11 items-center rounded-full transition-colors', participateInBuildingCount ? 'bg-primary' : 'bg-muted')}>
                            <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white transition-transform', participateInBuildingCount ? 'translate-x-6' : 'translate-x-1')} />
                        </button>
                    </div>
                    {participateInBuildingCount && (
                        <div className="space-y-2">
                            <label className="text-xs font-medium">Entrance ID</label>
                            <input type="text" className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={entranceId} onChange={(e) => setEntranceId(e.target.value)} placeholder="entrance_1" />
                        </div>
                    )}
                    <p className="text-xs text-muted-foreground">Cameras with the same entrance ID are combined into one entrance-level total for the building count.</p>
                </div>

                <div className="space-y-3 border rounded-lg p-3 bg-muted/20">
                    <div className="text-sm font-medium flex items-center gap-1.5"><Link2 className="w-4 h-4" />Cross-Camera Verification</div>
                    <div className="flex items-center justify-between">
                        <label className="text-sm">Enabled</label>
                        <button onClick={() => {
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
                        }} className={cn('relative inline-flex h-6 w-11 items-center rounded-full transition-colors', crossCameraEnabled ? 'bg-primary' : 'bg-muted')}>
                            <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white transition-transform', crossCameraEnabled ? 'translate-x-6' : 'translate-x-1')} />
                        </button>
                    </div>
                    {crossCameraEnabled && (
                        <div className="space-y-3">
                            <div className="space-y-2">
                                <label className="text-xs font-medium">Pair ID</label>
                                <input
                                    type="text"
                                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    value={crossCameraPairId}
                                    onChange={(e) => setCrossCameraPairId(e.target.value)}
                                    placeholder="entrance_pair_1"
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-medium">Role</label>
                                <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={crossCameraRole} onChange={(e) => setCrossCameraRole(e.target.value)}>
                                    <option value="primary">Primary Camera</option>
                                    <option value="verifier">Verifier Camera</option>
                                </select>
                            </div>
                            {crossCameraRole === 'primary' && (
                                <div className="space-y-2">
                                    <label className="text-xs font-medium">Verification Camera</label>
                                    <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={verificationCameraId} onChange={(e) => setVerificationCameraId(e.target.value)}>
                                        <option value="">Select verifier camera</option>
                                        {verificationCameraOptions.map((camera) => <option key={camera.id} value={camera.id}>{camera.name}</option>)}
                                    </select>
                                </div>
                            )}
                            <div className="space-y-2">
                                <label className="text-xs font-medium">Inward Motion Threshold</label>
                                <input type="number" step="0.005" min="0" className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={verificationInwardThreshold} onChange={(e) => setVerificationInwardThreshold(e.target.value)} />
                            </div>
                            <p className="text-xs text-muted-foreground">Primary cameras only get corrected upward. Verifier tracks must be newborn inside the active zone and move inward before they can add a missed IN count.</p>
                        </div>
                    )}
                </div>

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
                        <div className="flex flex-col items-center p-2.5 rounded-lg border bg-primary/10 border-primary/20">
                            <Users className="w-4 h-4 mb-1 text-primary" />
                            <span className="text-lg font-bold text-primary">{occupancy}</span>
                            <span className="text-[10px] text-muted-foreground">NOW</span>
                        </div>
                    </div>
                    <Button variant="outline" size="sm" className="w-full" onClick={handleResetSelectedCamera} disabled={resettingCamera || !selectedCamera}>
                        <RotateCcw className="w-3 h-3 mr-1" />
                        {resettingCamera ? 'Resetting Selected Camera...' : 'Reset Selected Camera'}
                    </Button>
                </div>

                <div className="space-y-3 border rounded-lg p-3 bg-muted/20">
                    <div className="text-sm font-medium flex items-center gap-1.5"><Building2 className="w-4 h-4" />Building Occupancy</div>
                    <div className="flex items-center justify-between">
                        <label className="text-sm">Building Counting Enabled</label>
                        <button onClick={() => setBuildingEnabled(!buildingEnabled)} className={cn('relative inline-flex h-6 w-11 items-center rounded-full transition-colors', buildingEnabled ? 'bg-primary' : 'bg-muted')}>
                            <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white transition-transform', buildingEnabled ? 'translate-x-6' : 'translate-x-1')} />
                        </button>
                    </div>
                    <div className="space-y-2">
                        <label className="text-xs font-medium">Building Max Occupancy Capacity</label>
                        <input type="number" min="1" placeholder="e.g. 200" className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={buildingMaxCapacity} onChange={(e) => setBuildingMaxCapacity(e.target.value)} />
                        <p className="text-xs text-muted-foreground">Building alert triggers when building occupancy reaches this value.</p>
                    </div>
                    <div className="space-y-2">
                        <label className="text-xs font-medium">Manual Occupancy Offset</label>
                        <input type="number" className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={buildingManualOffset} onChange={(e) => setBuildingManualOffset(e.target.value)} />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                        <div className="flex flex-col items-center p-2.5 rounded-lg bg-green-500/10 border border-green-500/20">
                            <ArrowDownToLine className="w-4 h-4 text-green-500 mb-1" />
                            <span className="text-lg font-bold text-green-500">{buildingSummary.raw_in ?? 0}</span>
                            <span className="text-[10px] text-muted-foreground">BUILDING IN</span>
                        </div>
                        <div className="flex flex-col items-center p-2.5 rounded-lg bg-red-500/10 border border-red-500/20">
                            <ArrowUpFromLine className="w-4 h-4 text-red-500 mb-1" />
                            <span className="text-lg font-bold text-red-500">{buildingSummary.raw_out ?? 0}</span>
                            <span className="text-[10px] text-muted-foreground">BUILDING OUT</span>
                        </div>
                        <div className={cn('flex flex-col items-center p-2.5 rounded-lg border', buildingCapacityExceeded ? 'bg-red-500/10 border-red-500/30' : 'bg-primary/10 border-primary/20')}>
                            <Users className={cn('w-4 h-4 mb-1', buildingCapacityExceeded ? 'text-red-500' : 'text-primary')} />
                            <span className={cn('text-lg font-bold', buildingCapacityExceeded ? 'text-red-500' : 'text-primary')}>{buildingSummary.occupancy ?? 0}</span>
                            <span className="text-[10px] text-muted-foreground">{buildingSummary.max_capacity ? `/ ${buildingSummary.max_capacity}` : 'BUILDING NOW'}</span>
                        </div>
                    </div>
                    <div className="text-xs text-muted-foreground">Active cameras: {buildingSummary.active_camera_count ?? 0} | Raw occupancy: {buildingSummary.raw_occupancy ?? 0} | Manual offset: {buildingSummary.manual_offset ?? 0}</div>
                    <div className="text-xs text-muted-foreground">Displayed building occupancy is the raw grouped total plus the manual offset.</div>
                    {buildingCapacityExceeded && (
                        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
                            Building capacity exceeded.
                        </div>
                    )}
                    <Button variant="outline" size="sm" className="w-full" onClick={handleResetBuildingTotals} disabled={resettingBuilding}>
                        <RotateCcw className="w-3 h-3 mr-1" />
                        {resettingBuilding ? 'Resetting Building Totals...' : 'Reset Building Totals'}
                    </Button>
                    {Object.keys(buildingEntranceSummaries).length > 0 && (
                        <div className="space-y-2">
                            {Object.entries(buildingEntranceSummaries).map(([entranceIdValue, entrance]) => (
                                <div key={entranceIdValue} className="rounded-md border bg-background/50 p-2 text-xs">
                                    <div className="font-medium">{entranceIdValue}</div>
                                    <div className="text-muted-foreground">Cameras: {(entrance.camera_ids || []).length}</div>
                                    <div className="text-muted-foreground">IN/OUT: {entrance.total_in ?? 0} / {entrance.total_out ?? 0}</div>
                                    <div className="text-muted-foreground">Occupancy: {entrance.occupancy ?? 0}</div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="space-y-2 pt-2">
                    <Button onClick={handleSave} className="w-full" disabled={saving || !selectedCamera}><Save className="w-4 h-4 mr-2" />{saving ? 'Saving...' : 'Save Configuration'}</Button>
                    <Button variant="outline" onClick={handleReset} className="w-full"><RotateCcw className="w-4 h-4 mr-2" />Reset All</Button>
                    {saveMessage && <p className={cn('text-xs text-center', saveMessage.startsWith('Error') ? 'text-destructive' : 'text-green-500')}>{saveMessage}</p>}
                </div>
            </CardContent>
        </Card>
    );

    const videoPanel = (
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
                            showCountingAnchors
                            overlayMode="counting"
                        />
                        <CountingCanvas
                            lines={lines}
                            frameExcludeAreas={validFrameExcludeAreas}
                            countingData={countingData}
                            drawingMode={drawingMode}
                            onLineDrawn={handleLineDrawn}
                            onFrameExcludeAreaDrawn={handleFrameExcludeAreaDrawn}
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
    );

    return (
        <div className="flex flex-col h-full space-y-6">
            <div className="flex items-center justify-between">
                <h1 className="text-3xl font-bold tracking-tight">People Counting</h1>
                {buildingCapacityExceeded && (
                    <div className="flex items-center gap-2 px-4 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-500">
                        <AlertTriangle className="w-4 h-4" />
                        <span className="text-sm font-medium">Building Capacity Exceeded!</span>
                    </div>
                )}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-0">
                {settingsPanel}
                {videoPanel}
            </div>
        </div>
    );
};

export default PeopleCounting;
