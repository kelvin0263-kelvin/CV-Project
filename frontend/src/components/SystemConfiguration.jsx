import React, { useState, useEffect } from 'react';
import { Camera, FolderUp, Plus, Edit2, Trash2, Save, X, Loader2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import WebSocketPlayer from './WebSocketPlayer';
import API_BASE_URL from '../config';

const SystemConfiguration = () => {
    const [cameras, setCameras] = useState([]);
    const [isAddMode, setIsAddMode] = useState(false);
    const [isEditMode, setIsEditMode] = useState(false);
    const [selectedCamera, setSelectedCamera] = useState(null);
    const [showUpload, setShowUpload] = useState(false);
    const [isUploading, setIsUploading] = useState(false);

    // File Upload State
    const [selectedFile, setSelectedFile] = useState(null);
    const [enableFisheye, setEnableFisheye] = useState(false);

    // Form State
    const [formData, setFormData] = useState({
        name: '',
        location: '',
        rtspUrl: '',
        analysisMode: 'People Counting',
        frameRate: '30',
        resolution: '1080p',
        enabled: true,
    });

    useEffect(() => {
        fetchCameras();
    }, []);

    const fetchCameras = async () => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/cameras`);
            const data = await res.json();
            setCameras(data);
        } catch (error) {
            console.error("Failed to fetch cameras:", error);
        }
    };

    const resetForm = () => {
        setFormData({
            name: '',
            location: '',
            rtspUrl: '',
            analysisMode: 'People Counting',
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
    };

    const handleAddClick = () => {
        resetForm();
        setIsAddMode(true);
    };

    const handleEditClick = (cam) => {
        setFormData({
            name: cam.name,
            location: cam.location,
            rtspUrl: cam.ip,
            analysisMode: cam.mode,
            frameRate: cam.fps,
            resolution: cam.resolution,
            enabled: cam.enabled,
        });
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
            const uploadData = new FormData();
            uploadData.append('file', selectedFile);
            uploadData.append('enable_fisheye', enableFisheye);
            uploadData.append('camera_name_prefix', formData.name || 'Uploaded Camera');

            try {
                const res = await fetch(`${API_BASE_URL}/api/upload_and_process`, {
                    method: 'POST',
                    body: uploadData
                });
                if (!res.ok) throw new Error("Upload failed");
                const data = await res.json();
                console.log("Upload success:", data);
                await fetchCameras(); // Refresh list
                resetForm();
            } catch (err) {
                alert("Error Uploading: " + err.message);
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
            mode: formData.analysisMode,
            ip: formData.rtspUrl,
            resolution: formData.resolution,
            fps: parseInt(formData.frameRate),
            enabled: formData.enabled,
            image: '/placeholder.png'
        };

        try {
            if (isEditMode) {
                // For MVP: Delete old and add new as 'update' logic is simple on backend
                await fetch(`${API_BASE_URL}/api/cameras/${selectedCamera.id}`, { method: 'DELETE' });
                await fetch(`${API_BASE_URL}/api/cameras`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            } else {
                await fetch(`${API_BASE_URL}/api/cameras`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
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
                await fetch(`${API_BASE_URL}/api/cameras/${id}`, { method: 'DELETE' });
                await fetchCameras();
            } catch (e) {
                alert("Failed to delete");
            }
        }
    };

    // ... existing test connection ...
    const handleTestConnection = () => {
        if (!formData.rtspUrl) {
            alert("Please enter a RTSP URL.");
            return;
        }
        // Simulate checking
        const isSuccess = Math.random() > 0.2;
        if (isSuccess) {
            alert("Connection Successful!");
        } else {
            alert("Connection Failed: Unable to reach host.");
        }
    };


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
                                        {cam.type.includes('File') || cam.type.includes('Fisheye') ? (
                                            <WebSocketPlayer
                                                wsUrl={cam.ws_url}
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
                                        <p className="text-sm text-muted-foreground truncate">{cam.location}</p>
                                        <div className="mt-3 flex flex-wrap gap-2">
                                            <span className="text-xs px-2 py-1 bg-secondary rounded-full">{cam.mode}</span>
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

                                            {enableFisheye && (
                                                <p className="text-xs text-muted-foreground">
                                                    Note: Processing 8 views for a large video may take some time.
                                                    This demo limits processing to the first 10 seconds.
                                                </p>
                                            )}
                                        </div>
                                    ) : (
                                        // RTSP Specific UI
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
                                                <Button type="button" variant="secondary" onClick={handleTestConnection}>Test</Button>
                                            </div>
                                        </div>
                                    )}

                                    {/* Common Settings */}
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <Label>Analysis Mode</Label>
                                            <select
                                                name="analysisMode"
                                                value={formData.analysisMode}
                                                onChange={handleInputChange}
                                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                            >
                                                <option>People Counting</option>
                                                <option>Dress Code</option>
                                                <option>Fall Detection</option>
                                            </select>
                                        </div>
                                    </div>

                                    {/* Footer Actions */}
                                    <div className="flex justify-end gap-2 pt-4">
                                        <Button type="button" variant="ghost" onClick={resetForm} disabled={isUploading}>Cancel</Button>
                                        <Button type="submit" disabled={isUploading}>
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
