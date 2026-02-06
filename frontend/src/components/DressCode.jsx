import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { ShieldCheck, Save, RefreshCw, Check } from 'lucide-react';
import { cn } from '../lib/utils';
import { getApiBaseUrl } from '../apiConfig';

const DressCode = () => {
    const [cameras, setCameras] = useState([]);
    const [policy, setPolicy] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    // Local editable state
    const [enabledCameraIds, setEnabledCameraIds] = useState([]);
    const [confidence, setConfidence] = useState(80);
    const [restrictedLabels, setRestrictedLabels] = useState([]);
    const [policyEnabled, setPolicyEnabled] = useState(true);

    // Available clothing labels (from the model)
    const clothingItems = [
        { id: 'shorts', name: 'Shorts', description: 'Shorts, bermudas, etc.' },
        { id: 'long_pants', name: 'Long Pants', description: 'Jeans, trousers, slacks, etc.' },
    ];

    const apiUrl = getApiBaseUrl();

    // Fetch cameras and policy on mount
    useEffect(() => {
        Promise.all([
            fetch(`${apiUrl}/api/cameras`).then(r => r.json()),
            fetch(`${apiUrl}/api/dresscode-policy`).then(r => r.json()),
        ])
            .then(([camerasData, policyData]) => {
                setCameras(camerasData.filter(c => c.enabled));
                setPolicy(policyData);
                setEnabledCameraIds(policyData.enabled_camera_ids || []);
                setConfidence(Math.round((policyData.confidence_threshold || 0.8) * 100));
                setRestrictedLabels(policyData.restricted_labels || ['shorts']);
                setPolicyEnabled(policyData.enabled !== false);
            })
            .catch(err => console.error("Failed to load config:", err))
            .finally(() => setLoading(false));
    }, [apiUrl]);

    const toggleCamera = (cameraId) => {
        setEnabledCameraIds(prev =>
            prev.includes(cameraId)
                ? prev.filter(id => id !== cameraId)
                : [...prev, cameraId]
        );
        setSaved(false);
    };

    const toggleLabel = (labelId) => {
        setRestrictedLabels(prev =>
            prev.includes(labelId)
                ? prev.filter(l => l !== labelId)
                : [...prev, labelId]
        );
        setSaved(false);
    };

    const handleSave = async () => {
        setSaving(true);
        setSaved(false);
        try {
            const res = await fetch(`${apiUrl}/api/dresscode-policy`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    enabled_camera_ids: enabledCameraIds,
                    restricted_labels: restrictedLabels,
                    confidence_threshold: confidence / 100,
                    enabled: policyEnabled,
                }),
            });
            const updated = await res.json();
            setPolicy(updated);
            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
        } catch (err) {
            console.error("Failed to save policy:", err);
            alert("Failed to save policy");
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full">
                <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full space-y-6 p-6 overflow-auto">
            <div className="flex items-center justify-between">
                <h1 className="text-3xl font-bold tracking-tight">Dress Code Policy</h1>
                <div className="flex items-center gap-3">
                    {saved && (
                        <span className="text-sm text-green-500 flex items-center gap-1">
                            <Check className="w-4 h-4" /> Saved
                        </span>
                    )}
                    <Button onClick={handleSave} disabled={saving}>
                        <Save className="w-4 h-4 mr-2" />
                        {saving ? "Saving..." : "Save Policy"}
                    </Button>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Settings Panel */}
                <Card className="lg:col-span-1">
                    <CardHeader>
                        <CardTitle>Detection Settings</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        {/* Global Enable */}
                        <div
                            className={cn(
                                "flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-all",
                                policyEnabled ? "bg-primary/5 border-primary" : "bg-card"
                            )}
                            onClick={() => { setPolicyEnabled(!policyEnabled); setSaved(false); }}
                        >
                            <span className="font-medium text-sm">Enable Detection</span>
                            <div className={cn("w-12 h-6 rounded-full relative transition-colors", policyEnabled ? "bg-primary" : "bg-muted")}>
                                <div className={cn("absolute top-1 w-4 h-4 rounded-full bg-white transition-all shadow-sm", policyEnabled ? "left-7" : "left-1")} />
                            </div>
                        </div>

                        {/* Confidence Threshold */}
                        <div className="space-y-2">
                            <label className="text-sm font-medium flex justify-between">
                                <span>Confidence Threshold</span>
                                <span className="text-muted-foreground">{confidence}%</span>
                            </label>
                            <input
                                type="range"
                                min="50"
                                max="99"
                                value={confidence}
                                onChange={(e) => { setConfidence(Number(e.target.value)); setSaved(false); }}
                                className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary"
                            />
                            <p className="text-xs text-muted-foreground">
                                Minimum confidence to flag a detection as a violation.
                            </p>
                        </div>
                    </CardContent>
                </Card>

                {/* Restricted Clothing */}
                <Card className="lg:col-span-2">
                    <CardHeader>
                        <CardTitle>Restricted Clothing Categories</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-sm text-muted-foreground mb-4">
                            Select which clothing types are <strong>not allowed</strong>. Detections matching these labels will trigger a violation.
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {clothingItems.map((item) => {
                                const isRestricted = restrictedLabels.includes(item.id);
                                return (
                                    <div
                                        key={item.id}
                                        onClick={() => toggleLabel(item.id)}
                                        className={cn(
                                            "flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-all hover:border-destructive/50",
                                            isRestricted ? "bg-destructive/5 border-destructive" : "bg-card"
                                        )}
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className={cn("w-10 h-10 rounded-full flex items-center justify-center", isRestricted ? "bg-destructive text-destructive-foreground" : "bg-muted text-muted-foreground")}>
                                                <ShieldCheck className="w-5 h-5" />
                                            </div>
                                            <div>
                                                <h3 className="font-medium">{item.name}</h3>
                                                <p className="text-xs text-muted-foreground">
                                                    {isRestricted ? "Restricted (Not Allowed)" : "Allowed"}
                                                </p>
                                            </div>
                                        </div>
                                        <div className={cn("w-12 h-6 rounded-full relative transition-colors", isRestricted ? "bg-destructive" : "bg-muted")}>
                                            <div className={cn("absolute top-1 w-4 h-4 rounded-full bg-white transition-all shadow-sm", isRestricted ? "left-7" : "left-1")} />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Camera Selection */}
            <Card>
                <CardHeader>
                    <CardTitle>Monitored Cameras</CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-muted-foreground mb-4">
                        Select which camera feeds should have dress code detection enabled.
                    </p>
                    {cameras.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No cameras available. Upload a video first.</p>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                            {cameras.map((cam) => {
                                const isEnabled = enabledCameraIds.includes(cam.id);
                                return (
                                    <div
                                        key={cam.id}
                                        onClick={() => toggleCamera(cam.id)}
                                        className={cn(
                                            "flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-all",
                                            isEnabled ? "bg-primary/5 border-primary" : "bg-card hover:border-primary/30"
                                        )}
                                    >
                                        <div className="min-w-0">
                                            <h4 className="font-medium text-sm truncate">{cam.name}</h4>
                                            <p className="text-xs text-muted-foreground">{cam.type} &middot; {cam.location}</p>
                                        </div>
                                        <div className={cn("w-10 h-5 rounded-full relative transition-colors shrink-0 ml-2", isEnabled ? "bg-primary" : "bg-muted")}>
                                            <div className={cn("absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all shadow-sm", isEnabled ? "left-5" : "left-0.5")} />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
};

export default DressCode;
