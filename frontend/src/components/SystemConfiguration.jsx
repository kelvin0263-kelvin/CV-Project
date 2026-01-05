import React, { useState } from 'react';
import { Camera, FolderUp, Plus, Edit2, Trash2, Save, X } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { Button } from './ui/button';
import { cn } from '../lib/utils';

const SystemConfiguration = () => {
    const [cameras, setCameras] = useState([
        { id: 1, name: 'Camera Source 1', location: 'Main Lobby', type: 'RTSP', status: 'Online', mode: 'People Counting', ip: '192.168.1.101', resolution: '1080p', fps: 30, enabled: true, image: '/1.png' },
        { id: 2, name: 'Camera Source 2', location: 'Factory Floor A', type: 'RTSP', status: 'Online', mode: 'Dress Code', ip: '192.168.1.102', resolution: '1080p', fps: 24, enabled: true, image: '/2.png' },
        { id: 3, name: 'Camera Source 3', location: 'Corridor B', type: 'RTSP', status: 'Online', mode: 'Intrusion', ip: '192.168.1.103', resolution: '720p', fps: 15, enabled: true, image: '/3.png' },
        { id: 4, name: 'Camera Source 4', location: 'Parking Lot', type: 'RTSP', status: 'Online', mode: 'People Counting', ip: '192.168.1.104', resolution: '1080p', fps: 30, enabled: true, image: '/4.png' },
    ]);
    const [isAddMode, setIsAddMode] = useState(false);
    const [isEditMode, setIsEditMode] = useState(false);
    const [selectedCamera, setSelectedCamera] = useState(null);
    const [showUpload, setShowUpload] = useState(false);

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

    const handleSave = (e) => {
        e.preventDefault();
        if (!formData.name || !formData.location) {
            alert("Please fill in required fields.");
            return;
        }

        if (isEditMode && selectedCamera) {
            setCameras(prev => prev.map(c => c.id === selectedCamera.id ? { ...c, ...formData, ip: formData.rtspUrl, mode: formData.analysisMode, fps: formData.frameRate } : c));
        } else {
            const newCam = {
                id: cameras.length + 1,
                name: formData.name,
                location: formData.location,
                type: showUpload ? 'File' : 'RTSP',
                status: formData.enabled ? 'Online' : 'Disabled',
                mode: formData.analysisMode,
                ip: formData.rtspUrl || 'Uploaded File',
                resolution: formData.resolution,
                fps: formData.frameRate,
                enabled: formData.enabled,
            };
            setCameras(prev => [...prev, newCam]);
        }
        resetForm();
    };

    const handleDelete = (id) => {
        if (window.confirm("Are you sure you want to remove this camera?")) {
            setCameras(prev => prev.filter(c => c.id !== id));
        }
    };

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
                            <Plus className="w-4 h-4" /> Add Camera
                        </Button>
                        <Button variant="outline" onClick={handleUploadClick} className="flex items-center gap-2">
                            <FolderUp className="w-4 h-4" /> Upload Video
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
                                    <div className="aspect-video bg-muted relative flex items-center justify-center">
                                        {/* Placeholder for camera preview */}
                                        <img src={cam.image} alt={cam.name} className="w-full h-full object-cover opacity-80" />
                                        <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <Button size="icon" variant="secondary" className="h-8 w-8" onClick={() => handleEditClick(cam)}>
                                                <Edit2 className="w-4 h-4" />
                                            </Button>
                                            <Button size="icon" variant="destructive" className="h-8 w-8" onClick={() => handleDelete(cam.id)}>
                                                <Trash2 className="w-4 h-4" />
                                            </Button>
                                        </div>
                                        <div className={cn("absolute top-2 left-2 px-2 py-0.5 rounded text-xs font-medium", cam.enabled ? (cam.status === 'Online' ? "bg-green-500/20 text-green-500" : "bg-red-500/20 text-red-500") : "bg-gray-500/20 text-gray-500")}>
                                            {cam.enabled ? cam.status : 'Disabled'}
                                        </div>
                                    </div>
                                    <CardContent className="p-4">
                                        <h3 className="font-semibold text-lg truncate">{cam.name}</h3>
                                        <p className="text-sm text-muted-foreground truncate">{cam.location}</p>
                                        <div className="mt-3 flex flex-wrap gap-2">
                                            <span className="text-xs px-2 py-1 bg-secondary rounded-full">{cam.mode}</span>
                                            <span className="text-xs px-2 py-1 bg-secondary rounded-full">{cam.resolution}</span>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    )}

                    {/* Edit/Add Form Overlay */}
                    {(isAddMode || isEditMode || showUpload) && (
                        <Card className="max-w-2xl mx-auto">
                            <CardHeader className="flex flex-row items-center justify-between">
                                <CardTitle>
                                    {showUpload ? "Upload Video Source" : (isEditMode ? "Modify Camera Source" : "Add Camera Source")}
                                </CardTitle>
                                <Button variant="ghost" size="icon" onClick={resetForm}>
                                    <X className="w-4 h-4" />
                                </Button>
                            </CardHeader>
                            <CardContent>
                                <form onSubmit={handleSave} className="space-y-4">
                                    {showUpload && (
                                        <div className="p-8 border-2 border-dashed rounded-lg flex flex-col items-center justify-center bg-muted/20 hover:bg-muted/40 transition-colors cursor-pointer">
                                            <FolderUp className="w-12 h-12 text-muted-foreground mb-2" />
                                            <p className="text-sm text-muted-foreground">Click or Drag to Upload Video File</p>
                                            <input type="file" className="hidden" />
                                        </div>
                                    )}

                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium">Camera Name</label>
                                            <input
                                                type="text"
                                                name="name"
                                                value={formData.name}
                                                onChange={handleInputChange}
                                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                                                placeholder="e.g. Front Entrance"
                                                required
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium">Location</label>
                                            <input
                                                type="text"
                                                name="location"
                                                value={formData.location}
                                                onChange={handleInputChange}
                                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                                                placeholder="e.g. Building A"
                                                required
                                            />
                                        </div>
                                    </div>

                                    {!showUpload && (
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium">RTSP URL</label>
                                            <div className="flex gap-2">
                                                <input
                                                    type="text"
                                                    name="rtspUrl"
                                                    value={formData.rtspUrl}
                                                    onChange={handleInputChange}
                                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                                                    placeholder="rtsp://admin:password@192.168.1.1:554/stream"
                                                />
                                                <Button type="button" variant="secondary" onClick={handleTestConnection}>Test</Button>
                                            </div>
                                        </div>
                                    )}

                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium">Analysis Mode</label>
                                            <select
                                                name="analysisMode"
                                                value={formData.analysisMode}
                                                onChange={handleInputChange}
                                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                <option>People Counting</option>
                                                <option>Dress Code</option>
                                                <option>Fall Detection</option>
                                            </select>
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium">Frame Rate</label>
                                            <select
                                                name="frameRate"
                                                value={formData.frameRate}
                                                onChange={handleInputChange}
                                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                <option>15</option>
                                                <option>24</option>
                                                <option>30</option>
                                                <option>60</option>
                                            </select>
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium">Resolution</label>
                                            <select
                                                name="resolution"
                                                value={formData.resolution}
                                                onChange={handleInputChange}
                                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                <option>720p</option>
                                                <option>1080p</option>
                                                <option>1440p</option>
                                                <option>4K</option>
                                            </select>
                                        </div>
                                    </div>

                                    <div className="flex items-center space-x-2">
                                        <input
                                            type="checkbox"
                                            id="enabled"
                                            name="enabled"
                                            checked={formData.enabled}
                                            onChange={handleInputChange}
                                            className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                                        />
                                        <label
                                            htmlFor="enabled"
                                            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                                        >
                                            Camera Enabled
                                        </label>
                                    </div>

                                    <div className="flex justify-end gap-2 pt-4">
                                        <Button type="button" variant="ghost" onClick={resetForm}>Cancel</Button>
                                        <Button type="submit">
                                            <Save className="w-4 h-4 mr-2" /> Save Configuration
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
