import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RotateCcw, Save, Timer } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import StreamPlayer from './StreamPlayer';
import { clearAuthSession, getApiBaseUrl, getAuthHeaders, getWSUrl } from '../apiConfig';
import { cn } from '../lib/utils';

const DEFAULT_DETECTION_SENSITIVITY = 75;
const DEFAULT_INACTIVITY_TIMER = 1;
const MIN_INACTIVITY_TIMER = 0.1;
const CAMERA_ANALYSIS_TAGS_UPDATED_EVENT = 'camera-analysis-tags-updated';

const FallDetection = () => {
    const apiUrl = getApiBaseUrl();
    const navigate = useNavigate();
    const videoContainerRef = useRef(null);

    const [cameras, setCameras] = useState([]);
    const [selectedCamera, setSelectedCamera] = useState('');
    const [fallDetectionEnabled, setFallDetectionEnabled] = useState(false);
    const [detectionSensitivity, setDetectionSensitivity] = useState(DEFAULT_DETECTION_SENSITIVITY);
    const [inactivityTimer, setInactivityTimer] = useState(DEFAULT_INACTIVITY_TIMER);
    const [saving, setSaving] = useState(false);
    const [saveMessage, setSaveMessage] = useState('');
    const [stats, setStats] = useState({ fps: 0, people_count: 0 });

    const handle401 = useCallback(() => {
        clearAuthSession();
        navigate('/login');
    }, [navigate]);

    useEffect(() => {
        let cancelled = false;

        const fetchCameras = async () => {
            try {
                const response = await fetch(`${apiUrl}/api/cameras`);
                const data = await response.json().catch(() => []);
                if (cancelled || !Array.isArray(data)) {
                    return;
                }

                const enabledCameras = data.filter((camera) => camera.enabled);
                setCameras(enabledCameras);
                setSelectedCamera((current) => current || enabledCameras[0]?.id || '');
            } catch (error) {
                console.error('Failed to fetch cameras:', error);
            }
        };

        fetchCameras();
        return () => {
            cancelled = true;
        };
    }, [apiUrl]);

    useEffect(() => {
        if (!selectedCamera) {
            return;
        }

        const fetchConfig = async () => {
            try {
                const response = await fetch(`${apiUrl}/api/fall-detection-config/${selectedCamera}`, {
                    headers: getAuthHeaders(),
                });
                if (response.status === 401) {
                    handle401();
                    return;
                }
                if (response.status === 404) {
                    setFallDetectionEnabled(false);
                    setDetectionSensitivity(DEFAULT_DETECTION_SENSITIVITY);
                    setInactivityTimer(DEFAULT_INACTIVITY_TIMER);
                    return;
                }
                if (!response.ok) {
                    return;
                }

                const data = await response.json();
                setFallDetectionEnabled(Boolean(data.enabled));
                setDetectionSensitivity(data.detection_sensitivity ?? DEFAULT_DETECTION_SENSITIVITY);
                setInactivityTimer(data.inactivity_timer_seconds ?? DEFAULT_INACTIVITY_TIMER);
            } catch {
                setFallDetectionEnabled(false);
                setDetectionSensitivity(DEFAULT_DETECTION_SENSITIVITY);
                setInactivityTimer(DEFAULT_INACTIVITY_TIMER);
            }
        };

        fetchConfig();
    }, [apiUrl, handle401, selectedCamera]);

    const handleStats = useCallback((nextStats) => {
        setStats(nextStats);
    }, []);

    const dispatchCameraTagsUpdated = useCallback(() => {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new Event(CAMERA_ANALYSIS_TAGS_UPDATED_EVENT));
        }
    }, []);

    const saveConfig = useCallback(async (enabledOverride = fallDetectionEnabled) => {
        const response = await fetch(`${apiUrl}/api/fall-detection-config/${selectedCamera}`, {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                enabled: Boolean(enabledOverride),
                detection_sensitivity: Math.min(100, Math.max(0, Number(detectionSensitivity) || DEFAULT_DETECTION_SENSITIVITY)),
                inactivity_timer_seconds: Math.max(MIN_INACTIVITY_TIMER, Number.parseFloat(String(inactivityTimer)) || DEFAULT_INACTIVITY_TIMER),
            }),
        });

        if (response.status === 401) {
            handle401();
            return { ok: false, unauthorized: true };
        }

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            return {
                ok: false,
                detail: data.detail || 'Failed to save configuration.',
            };
        }

        setFallDetectionEnabled(Boolean(data.enabled));
        setDetectionSensitivity(data.detection_sensitivity ?? DEFAULT_DETECTION_SENSITIVITY);
        setInactivityTimer(data.inactivity_timer_seconds ?? DEFAULT_INACTIVITY_TIMER);
        dispatchCameraTagsUpdated();
        return { ok: true, data };
    }, [
        apiUrl,
        detectionSensitivity,
        dispatchCameraTagsUpdated,
        fallDetectionEnabled,
        handle401,
        inactivityTimer,
        selectedCamera,
    ]);

    const handleSave = async () => {
        if (!selectedCamera) {
            setSaveMessage('Please select a camera.');
            return;
        }

        setSaving(true);
        setSaveMessage('');

        try {
            const result = await saveConfig();
            if (result.unauthorized) {
                return;
            }
            if (!result.ok) {
                setSaveMessage(`Error: ${result.detail}`);
                return;
            }
            setSaveMessage(
                fallDetectionEnabled
                    ? 'Configuration saved. Fall detection is active for this camera.'
                    : 'Configuration saved. Fall detection is disabled for this camera.'
            );
        } catch (error) {
            setSaveMessage(`Error: ${error.message}`);
        } finally {
            setSaving(false);
        }
    };

    const handleToggleEnabled = async () => {
        if (!selectedCamera) {
            setSaveMessage('Please select a camera.');
            return;
        }

        const nextEnabled = !fallDetectionEnabled;
        setSaving(true);
        setSaveMessage('');

        try {
            const result = await saveConfig(nextEnabled);
            if (result.unauthorized) {
                return;
            }
            if (!result.ok) {
                setSaveMessage(`Error: ${result.detail}`);
                return;
            }

            setSaveMessage(
                nextEnabled
                    ? 'Fall detection enabled for this camera.'
                    : 'Fall detection disabled for this camera.'
            );
        } catch (error) {
            setSaveMessage(`Error: ${error.message}`);
        } finally {
            setSaving(false);
        }
    };

    const handleReset = () => {
        setDetectionSensitivity(DEFAULT_DETECTION_SENSITIVITY);
        setInactivityTimer(DEFAULT_INACTIVITY_TIMER);
        setSaveMessage('');
    };

    const selectedCam = cameras.find((camera) => camera.id === selectedCamera);
    const wsUrl = selectedCamera ? getWSUrl(`/ws/${selectedCamera}`) : null;

    return (
        <div className="flex flex-col h-full space-y-6">
            <div className="flex items-center justify-between">
                <h1 className="text-3xl font-bold tracking-tight">Fall Detection Configuration</h1>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-0">
                <Card className="lg:col-span-1 overflow-y-auto">
                    <CardHeader>
                        <CardTitle>Detection Parameters</CardTitle>
                        <CardDescription>Configure fall-detection triggers for each camera.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Select Camera</label>
                            <select
                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                value={selectedCamera}
                                onChange={(event) => setSelectedCamera(event.target.value)}
                            >
                                {cameras.length === 0 && <option value="">No cameras available</option>}
                                {cameras.map((camera) => (
                                    <option key={camera.id} value={camera.id}>
                                        {camera.name}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div
                            className={cn(
                                'rounded-lg border p-4 transition-colors',
                                fallDetectionEnabled ? 'border-green-500/40 bg-green-500/5' : 'border-border bg-muted/20',
                            )}
                        >
                            <div className="flex items-center justify-between gap-3">
                                <div className="space-y-1">
                                    <p className="text-sm font-medium">Detection Status</p>
                                    <p className="text-xs text-muted-foreground">
                                        {fallDetectionEnabled
                                            ? 'Fall detection is currently active for this camera.'
                                            : 'Fall detection is currently turned off for this camera.'}
                                    </p>
                                </div>
                                <Button
                                    type="button"
                                    variant={fallDetectionEnabled ? 'destructive' : 'default'}
                                    onClick={handleToggleEnabled}
                                    disabled={saving || !selectedCamera}
                                >
                                    {fallDetectionEnabled ? 'Disable' : 'Enable'}
                                </Button>
                            </div>
                        </div>

                        <div className="space-y-2">
                            <label className="text-sm font-medium flex justify-between items-center">
                                <span>Detection Sensitivity</span>
                                <span className="text-muted-foreground">{detectionSensitivity}%</span>
                            </label>
                            <input
                                type="range"
                                min="0"
                                max="100"
                                value={detectionSensitivity}
                                onChange={(event) => setDetectionSensitivity(Number(event.target.value))}
                                className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary"
                            />
                            <p className="text-xs text-muted-foreground">
                                Higher sensitivity makes the detector react to less extreme body angles.
                            </p>
                        </div>

                        <div className="space-y-2">
                            <label className="text-sm font-medium">Inactivity Timer (Seconds)</label>
                            <div className="relative">
                                <Timer className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                                <input
                                    type="number"
                                    min={MIN_INACTIVITY_TIMER}
                                    step="0.1"
                                    value={inactivityTimer}
                                    onChange={(event) => setInactivityTimer(event.target.value)}
                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pl-9 text-sm"
                                />
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Alert only after the person remains in a fall pose for this long.
                            </p>
                        </div>

                        <div className="pt-4 flex flex-col gap-2">
                            <Button onClick={handleSave} className="w-full" disabled={saving || !selectedCamera}>
                                <Save className="w-4 h-4 mr-2" />
                                {saving ? 'Saving...' : 'Save Configuration'}
                            </Button>
                            <Button variant="outline" onClick={handleReset} className="w-full">
                                <RotateCcw className="w-4 h-4 mr-2" />
                                Reset All
                            </Button>
                            {saveMessage && (
                                <p
                                    className={cn(
                                        'text-xs text-center',
                                        saveMessage.startsWith('Error') ? 'text-destructive' : 'text-green-600',
                                    )}
                                >
                                    {saveMessage}
                                </p>
                            )}
                        </div>
                    </CardContent>
                </Card>

                <Card className="lg:col-span-2 overflow-hidden flex flex-col bg-black">
                    <div ref={videoContainerRef} className="relative flex-1 min-h-[400px]">
                        {wsUrl ? (
                            <StreamPlayer
                                wsUrl={wsUrl}
                                className="w-full h-full"
                                alt={selectedCam?.name || 'Camera Feed'}
                                onStats={handleStats}
                                overlayMode="fall"
                            />
                        ) : (
                            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                                <p>Select a camera to view the feed</p>
                            </div>
                        )}
                    </div>
                    <div className="p-2 bg-card border-t flex justify-between items-center text-xs text-muted-foreground">
                        <span>{selectedCam?.name || 'No camera selected'}</span>
                        <span>FPS: {stats.fps}</span>
                    </div>
                </Card>
            </div>
        </div>
    );
};

export default FallDetection;
