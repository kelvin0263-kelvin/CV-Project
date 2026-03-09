import React, { useState, useEffect } from 'react';
import { Camera, FolderUp, Plus, Edit2, Trash2, Save, X, Loader2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import StreamPlayer from './StreamPlayer';
import { getApiBaseUrl, getWSUrl } from '../apiConfig';

const SystemConfiguration = () => {
    const apiUrl = getApiBaseUrl();
    const [cameras, setCameras] = useState([]);
    const [isAddMode, setIsAddMode] = useState(false);
    const [isEditMode, setIsEditMode] = useState(false);
    const [selectedCamera, setSelectedCamera] = useState(null);
    const [showUpload, setShowUpload] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [isTestingConnection, setIsTestingConnection] = useState(false);
    const [testResult, setTestResult] = useState(null);

    // File Upload State
    const [selectedFile, setSelectedFile] = useState(null);
    const [enableFisheye, setEnableFisheye] = useState(false);
    const [syncStart, setSyncStart] = useState(false);
    const [syncGroupId, setSyncGroupId] = useState('test-group');
    const [syncGroups, setSyncGroups] = useState([]);
    const [uploadMessage, setUploadMessage] = useState(null);
    const [startingSyncGroup, setStartingSyncGroup] = useState(false);
    // Default to all 8 views selected
    const [selectedViews, setSelectedViews] = useState(new Set([0, 1, 2, 3, 4, 5, 6, 7]));

    // Form State
    const [formData, setFormData] = useState({
        name: '',
        location: '',
        rtspUrl: '',
        frameRate: '30',
        resolution: '1080p',
        enabled: true,
    });

    useEffect(() => {
        fetchCameras();
        fetchSyncGroups();
    }, []);

    const fetchCameras = async () => {
        try {
            console.log("SystemConfig fetching from:", apiUrl);
            const res = await fetch(`${apiUrl}/api/cameras`);
            const data = await res.json();
            setCameras(data);
        } catch (error) {
            console.error("Failed to fetch cameras:", error);
        }
    };

    const fetchSyncGroups = async () => {
        try {
            const res = await fetch(`${apiUrl}/api/upload-sync-groups`);
            if (!res.ok) return;
            const data = await res.json();
            setSyncGroups(data.groups || []);
        } catch (error) {
            console.error("Failed to fetch sync groups:", error);
        }
    };

    const resetForm = () => {
        setFormData({
            name: '',
            location: '',
            rtspUrl: '',
            frameRate: '30',
            resolution: '1080p',
            enabled: true,
        });
        setIsAddMode(false);
        setIsEditMode(false);
        setSelectedCamera(null);
        setShowUpload(false);
        setSelectedFile(null);
        setEnableFisheye(false);
        setSyncStart(false);
        setSyncGroupId('test-group');
        setUploadMessage(null);
        setSelectedViews(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
        setTestResult(null);
    };

    const handleAddClick = () => {
        resetForm();
        setIsAddMode(true);
    };

    const handleEditClick = (cam) => {
        setFormData({
            name: cam.name,
            location: cam.location,
            rtspUrl: cam.source_path || '',
            frameRate: String(cam.fps ?? 30),
            resolution: cam.resolution,
            enabled: cam.enabled,
        });
        setEnableFisheye(Boolean(cam.is_fisheye));
        setSelectedViews(
            cam.is_fisheye && Number.isInteger(cam.view_index) && cam.view_index >= 0
                ? new Set([cam.view_index])
                : new Set([0, 1, 2, 3, 4, 5, 6, 7])
        );
        setSelectedCamera(cam);
        setIsEditMode(true);
    };

    const handleUploadClick = () => {
        resetForm();
        setShowUpload(true);
    };

    const handleInputChange = (e) => {
        const { name, value, type, checked } = e.target;
        setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
        if (name === 'rtspUrl' && testResult) {
            setTestResult(null);
        }
    };

    const handleFileChange = (e) => {
        if (e.target.files && e.target.files[0]) {
            setSelectedFile(e.target.files[0]);
        }
    };

    const handleSave = async (e) => {
        e.preventDefault();

        if (showUpload) {
            if (!selectedFile) return alert("Please select a file");

            setIsUploading(true);
            setUploadMessage(null);
            const uploadData = new FormData();
            uploadData.append('file', selectedFile);
            uploadData.append('enable_fisheye', enableFisheye);
            if (enableFisheye) {
                // Convert Set to comma separated string "0,3,5"
                const views = Array.from(selectedViews).join(',');
                uploadData.append('selected_views', views);
            }
            uploadData.append('camera_name_prefix', formData.name || 'Uploaded Camera');
            uploadData.append('sync_start', syncStart);
            if (syncStart) {
                uploadData.append('sync_group_id', syncGroupId.trim());
            }

            try {
                if (syncStart && !syncGroupId.trim()) {
                    throw new Error("Please enter a sync group ID.");
                }
                // Large files need a generous timeout (10 minutes)
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10 * 60 * 1000);
                const res = await fetch(`${apiUrl}/api/upload_and_process`, {
                    method: 'POST',
                    body: uploadData,
                    signal: controller.signal,
                });
                clearTimeout(timeoutId);
                if (!res.ok) throw new Error("Upload failed");
                const data = await res.json();
                console.log("Upload success:", data);
                await fetchCameras(); // Refresh list
                await fetchSyncGroups();
                if (syncStart) {
                    setSelectedFile(null);
                    setUploadMessage({
                        type: 'success',
                        text: `Uploaded to sync group "${data.sync_group_id}". Pending sources: ${data.pending_sources}.`,
                    });
                } else {
                    resetForm();
                }
            } catch (err) {
                setUploadMessage({
                    type: 'error',
                    text: `Error Uploading: ${err.message}`,
                });
            } finally {
                setIsUploading(false);
            }
            return;
        }

        // Standard Add/Edit
        const payload = {
            id: selectedCamera ? selectedCamera.id : Date.now().toString(),
            name: formData.name,
            location: formData.location,
            type: 'RTSP',
            status: formData.enabled ? 'Online' : 'Disabled',
            mode: selectedCamera?.mode || 'Unassigned',
            source_path: formData.rtspUrl.trim(),
            resolution: formData.resolution,
            fps: parseInt(formData.frameRate, 10) || 30,
            enabled: formData.enabled,
            image: '',
            view_index: -1,
            is_fisheye: false,
        };

        try {
            if (!payload.source_path) {
                alert("Please enter a RTSP URL.");
                return;
            }

            if (enableFisheye) {
                if (isEditMode) {
                    alert("Editing RTSP fisheye sources is not supported yet. Delete and recreate the source.");
                    return;
                }

                const res = await fetch(`${apiUrl}/api/cameras/rtsp-source`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: formData.name,
                        location: formData.location,
                        source_path: payload.source_path,
                        mode: payload.mode,
                        resolution: formData.resolution,
                        fps: payload.fps,
                        enabled: formData.enabled,
                        enable_fisheye: true,
                        selected_views: Array.from(selectedViews),
                    }),
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || 'Failed to create RTSP fisheye source');
                }

                await fetchCameras();
                resetForm();
                return;
            }

            if (isEditMode) {
                const res = await fetch(`${apiUrl}/api/cameras/${selectedCamera.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || 'Failed to save camera');
                }
            } else {
                const res = await fetch(`${apiUrl}/api/cameras`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || 'Failed to save camera');
                }
            }
            await fetchCameras();
            resetForm();
        } catch (error) {
            console.error("Save error:", error);
            alert("Failed to save camera");
        }
    };

    const handleDelete = async (id) => {
        if (window.confirm("Are you sure you want to remove this camera Source? This will remove it from the dashboard.")) {
            try {
                await fetch(`${apiUrl}/api/cameras/${id}`, { method: 'DELETE' });
                await fetchCameras();
            } catch (e) {
                alert("Failed to delete");
            }
        }
    };

    const handleTestConnection = async () => {
        if (!formData.rtspUrl) {
            setTestResult({ type: 'error', message: 'Please enter a RTSP URL.' });
            return;
        }

        setIsTestingConnection(true);
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);
            const res = await fetch(`${apiUrl}/api/cameras/test-rtsp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source_path: formData.rtspUrl.trim() }),
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
                throw new Error(data.detail || 'Unable to reach RTSP stream.');
            }

            const parts = [];
            if (data.resolution) parts.push(`Resolution: ${data.resolution}`);
            if (data.fps) parts.push(`FPS: ${data.fps}`);
            setTestResult({
                type: 'success',
                message: parts.length > 0
                    ? `Connection successful. ${parts.join(' | ')}`
                    : 'Connection successful.',
            });
        } catch (error) {
            const message = error?.name === 'AbortError'
                ? 'Connection test timed out.'
                : (error?.message || 'Connection test failed.');
            setTestResult({ type: 'error', message });
        } finally {
            setIsTestingConnection(false);
        }
    };

    const isStreamSource = (cam) =>
        cam.type.includes('RTSP') || cam.type.includes('File') || cam.type.includes('Fisheye');

    const handleStartSyncGroup = async () => {
        if (!syncGroupId.trim()) {
            setUploadMessage({ type: 'error', text: 'Please enter a sync group ID.' });
            return;
        }

        setStartingSyncGroup(true);
        setUploadMessage(null);
        try {
            const res = await fetch(`${apiUrl}/api/upload-sync-groups/${encodeURIComponent(syncGroupId.trim())}/start`, {
                method: 'POST',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.detail || 'Failed to start sync group.');
            }

            await fetchCameras();
            await fetchSyncGroups();
            setUploadMessage({
                type: 'success',
                text: `Started ${data.started_sources} source(s) in sync group "${data.group_id}".`,
            });
        } catch (err) {
            setUploadMessage({
                type: 'error',
                text: err.message || 'Failed to start sync group.',
            });
        } finally {
            setStartingSyncGroup(false);
        }
    };

    const currentSyncGroup = syncGroups.find((group) => group.group_id === syncGroupId.trim());


    return (
        <div className="flex flex-col h-full bg-background text-foreground">
            <div className="flex items-center justify-between mb-6">
                <h1 className="text-2xl font-bold">System Configuration</h1>
            </div>

            <div className="flex flex-1 flex-col h-full overflow-hidden">
                {/* Toolbar */}
                <div className="flex items-center justify-between mb-4">
                    <div className="flex gap-2">
                        <Button onClick={handleAddClick} className="flex items-center gap-2">
                            <Plus className="w-4 h-4" /> Add RTSP Camera
                        </Button>
                        <Button variant="outline" onClick={handleUploadClick} className="flex items-center gap-2">
                            <FolderUp className="w-4 h-4" /> Upload Video Source
                        </Button>
                    </div>
                    <div className="text-sm text-muted-foreground">
                        {cameras.length} Sources Configured
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-auto pr-2">
                    {!isAddMode && !isEditMode && !showUpload && (
                        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                            {cameras.map((cam) => (
                                <Card key={cam.id} className={cn("relative group overflow-hidden hover:border-primary/50 transition-all cursor-pointer border-muted", !cam.enabled && "opacity-60")}>
                                    <div className="aspect-video bg-muted relative flex items-center justify-center bg-black">
                                        {isStreamSource(cam) ? (
                                            <StreamPlayer
                                                wsUrl={getWSUrl(`/ws/${cam.id}`)}
                                                className="w-full h-full"
                                                alt="Live Stream"
                                            />
                                        ) : (
                                            <div className="flex flex-col items-center">
                                                <Camera className="w-8 h-8 text-muted-foreground mb-2" />
                                                <span className="text-xs text-muted-foreground">RTSP Stream</span>
                                            </div>
                                        )}

                                        <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                            {!cam.is_fisheye && (
                                                <Button size="icon" variant="secondary" className="h-8 w-8" onClick={() => handleEditClick(cam)}>
                                                    <Edit2 className="w-4 h-4" />
                                                </Button>
                                            )}
                                            <Button size="icon" variant="destructive" className="h-8 w-8" onClick={() => handleDelete(cam.id)}>
                                                <Trash2 className="w-4 h-4" />
                                            </Button>
                                        </div>
                                        <div className={cn("absolute top-2 left-2 px-2 py-0.5 rounded text-xs font-medium", cam.enabled ? "bg-green-500/20 text-green-500" : "bg-red-500/20 text-red-500")}>
                                            {cam.type}
                                        </div>
                                    </div>
                                    <CardContent className="p-4">
                                        <h3 className="font-semibold text-lg truncate" title={cam.name}>{cam.name}</h3>
                                        <p className="text-sm text-muted-foreground truncate">
                                            {cam.location || cam.source_path || 'No location configured'}
                                        </p>
                                        <div className="mt-3 flex flex-wrap gap-2">
                                            {(Array.isArray(cam.analysis_tags) && cam.analysis_tags.length > 0
                                                ? cam.analysis_tags
                                                : ['Unassigned']
                                            ).map((tag) => (
                                                <span
                                                    key={`${cam.id}-${tag}`}
                                                    className="text-xs px-2 py-1 bg-secondary rounded-full"
                                                >
                                                    {tag}
                                                </span>
                                            ))}
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    )}

                    {/* Edit/Add/Upload Form Overlay */}
                    {(isAddMode || isEditMode || showUpload) && (
                        <Card className="max-w-2xl mx-auto">
                            <CardHeader className="flex flex-row items-center justify-between">
                                <CardTitle>
                                    {showUpload ? "Upload Video Source" : (isEditMode ? "Modify Camera Source" : "Add RTSP Camera")}
                                </CardTitle>
                                <Button variant="ghost" size="icon" onClick={resetForm}>
                                    <X className="w-4 h-4" />
                                </Button>
                            </CardHeader>
                            <CardContent>
                                <form onSubmit={handleSave} className="space-y-4">

                                    {/* Basic Info needed for both */}
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <Label>Camera Name / Prefix</Label>
                                            <input
                                                type="text"
                                                name="name"
                                                value={formData.name}
                                                onChange={handleInputChange}
                                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                                placeholder={showUpload ? "e.g. Fisheye Cam 01" : "e.g. Front Entrance"}
                                                required={!showUpload}
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <Label>Location</Label>
                                            <input
                                                type="text"
                                                name="location"
                                                value={formData.location}
                                                onChange={handleInputChange}
                                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                                placeholder="e.g. Building A"
                                            />
                                        </div>
                                    </div>

                                    {showUpload ? (
                                        // Upload Specific UI
                                        <div className="space-y-4 border rounded-lg p-4 bg-muted/30">
                                            <div className="flex flex-col items-center justify-center p-6 border-2 border-dashed rounded-lg cursor-pointer hover:bg-muted/50 transition-colors relative">
                                                <input
                                                    type="file"
                                                    className="absolute inset-0 opacity-0 cursor-pointer"
                                                    onChange={handleFileChange}
                                                    accept="video/*"
                                                />
                                                <FolderUp className="w-10 h-10 text-muted-foreground mb-2" />
                                                <p className="text-sm font-medium">
                                                    {selectedFile ? selectedFile.name : "Click to Select Video File"}
                                                </p>
                                            </div>

                                            <div className="flex items-center space-x-2">
                                                <Checkbox
                                                    id="fisheye"
                                                    checked={enableFisheye}
                                                    onCheckedChange={setEnableFisheye}
                                                />
                                                <Label htmlFor="fisheye">Enable Fisheye Processing (Generates 8 Views)</Label>
                                            </div>

                                            <div className="space-y-3 rounded-lg border p-3 bg-background/60">
                                                <div className="flex items-center space-x-2">
                                                    <Checkbox
                                                        id="sync-start"
                                                        checked={syncStart}
                                                        onCheckedChange={setSyncStart}
                                                    />
                                                    <Label htmlFor="sync-start">Synchronize start for uploaded videos</Label>
                                                </div>
                                                {syncStart && (
                                                    <>
                                                        <div className="space-y-2">
                                                            <Label htmlFor="sync-group-id">Sync Group ID</Label>
                                                            <input
                                                                id="sync-group-id"
                                                                type="text"
                                                                value={syncGroupId}
                                                                onChange={(e) => setSyncGroupId(e.target.value)}
                                                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                                                placeholder="test-group"
                                                            />
                                                        </div>
                                                        <div className="flex items-center justify-between rounded-md border p-2 text-xs text-muted-foreground">
                                                            <span>Pending sources in this group</span>
                                                            <span className="font-medium text-foreground">
                                                                {currentSyncGroup?.pending_sources ?? 0}
                                                            </span>
                                                        </div>
                                                        <Button
                                                            type="button"
                                                            variant="secondary"
                                                            onClick={handleStartSyncGroup}
                                                            disabled={startingSyncGroup || isUploading}
                                                            className="w-full"
                                                        >
                                                            {startingSyncGroup ? 'Starting Sync Group...' : 'Start Sync Group'}
                                                        </Button>
                                                        <p className="text-xs text-muted-foreground">
                                                            Upload multiple files with the same group ID, then start them together.
                                                        </p>
                                                    </>
                                                )}
                                            </div>

                                            {enableFisheye && (
                                                <div className="space-y-4">
                                                    <Label>Select Enabled Views</Label>
                                                    <div className="grid grid-cols-4 gap-2">
                                                        {[0, 1, 2, 3, 4, 5, 6, 7].map((idx) => {
                                                            const angle = idx * 45;
                                                            return (
                                                                <div key={idx} className="flex items-center space-x-2 border p-2 rounded hover:bg-muted/50">
                                                                    <Checkbox
                                                                        id={`view-${idx}`}
                                                                        checked={selectedViews.has(idx)}
                                                                        onCheckedChange={(checked) => {
                                                                            const newSet = new Set(selectedViews);
                                                                            if (checked) newSet.add(idx);
                                                                            else newSet.delete(idx);
                                                                            setSelectedViews(newSet);
                                                                        }}
                                                                    />
                                                                    <Label htmlFor={`view-${idx}`} className="cursor-pointer text-xs">
                                                                        View {idx + 1} ({angle}°)
                                                                    </Label>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                    <p className="text-xs text-muted-foreground">
                                                        Only selected views will be processed and displayed.
                                                    </p>
                                                </div>
                                            )}

                                            {uploadMessage && (
                                                <div className={cn(
                                                    "rounded-md border px-3 py-2 text-sm",
                                                    uploadMessage.type === 'success'
                                                        ? "border-green-500/30 bg-green-500/10 text-green-600"
                                                        : "border-red-500/30 bg-red-500/10 text-red-600"
                                                )}>
                                                    {uploadMessage.text}
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        // RTSP Specific UI
                                        <>
                                            <div className="space-y-2">
                                                <Label>RTSP URL</Label>
                                            <div className="flex gap-2">
                                                <input
                                                    type="text"
                                                    name="rtspUrl"
                                                        value={formData.rtspUrl}
                                                        onChange={handleInputChange}
                                                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                                        placeholder="rtsp://admin:password@192.168.1.1:554/stream"
                                                    />
                                                    <Button type="button" variant="secondary" onClick={handleTestConnection} disabled={isTestingConnection}>
                                                    {isTestingConnection ? 'Testing...' : 'Test'}
                                                </Button>
                                            </div>
                                            {testResult && (
                                                <div className={cn(
                                                    "rounded-md border px-3 py-2 text-sm",
                                                    testResult.type === 'success'
                                                        ? "border-green-500/30 bg-green-500/10 text-green-600"
                                                        : "border-red-500/30 bg-red-500/10 text-red-600"
                                                )}>
                                                    {testResult.message}
                                                </div>
                                            )}
                                            </div>
                                            <div className="flex items-center space-x-2">
                                                <Checkbox
                                                    id="rtsp-fisheye"
                                                    checked={enableFisheye}
                                                    disabled={isEditMode}
                                                    onCheckedChange={setEnableFisheye}
                                                />
                                                <Label htmlFor="rtsp-fisheye">Enable Fisheye Processing (Creates multiple RTSP views)</Label>
                                            </div>
                                            {enableFisheye && (
                                                <div className="space-y-4 border rounded-lg p-4 bg-muted/30">
                                                    <Label>Select Enabled Views</Label>
                                                    <div className="grid grid-cols-4 gap-2">
                                                        {[0, 1, 2, 3, 4, 5, 6, 7].map((idx) => {
                                                            const angle = idx * 45;
                                                            return (
                                                                <div key={idx} className="flex items-center space-x-2 border p-2 rounded hover:bg-muted/50">
                                                                    <Checkbox
                                                                        id={`rtsp-view-${idx}`}
                                                                        checked={selectedViews.has(idx)}
                                                                        onCheckedChange={(checked) => {
                                                                            const newSet = new Set(selectedViews);
                                                                            if (checked) newSet.add(idx);
                                                                            else newSet.delete(idx);
                                                                            setSelectedViews(newSet);
                                                                        }}
                                                                    />
                                                                    <Label htmlFor={`rtsp-view-${idx}`} className="cursor-pointer text-xs">
                                                                        View {idx + 1} ({angle}°)
                                                                    </Label>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                    <p className="text-xs text-muted-foreground">
                                                        This creates one camera card per selected fisheye view.
                                                    </p>
                                                </div>
                                            )}
                                        </>
                                    )}

                                    <p className="text-xs text-muted-foreground">
                                        Analysis tags are assigned from the People Counting and Dress Code pages.
                                    </p>

                                    {/* Footer Actions */}
                                    <div className="flex justify-end gap-2 pt-4">
                                        <Button type="button" variant="ghost" onClick={resetForm} disabled={isUploading || isTestingConnection}>Cancel</Button>
                                        <Button type="submit" disabled={isUploading || isTestingConnection}>
                                            {isUploading ? (
                                                <>
                                                    <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Processing...
                                                </>
                                            ) : (
                                                <>
                                                    <Save className="w-4 h-4 mr-2" />
                                                    {showUpload ? "Upload & Create Sources" : "Save Configuration"}
                                                </>
                                            )}
                                        </Button>
                                    </div>
                                </form>
                            </CardContent>
                        </Card>
                    )}
                </div>
            </div>
        </div>
    );
};

export default SystemConfiguration;
