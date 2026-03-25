import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Camera, Plus, Edit2, Trash2, Save, X, Loader2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import StreamPlayer from './StreamPlayer';
import RoiEditorCanvas from './RoiEditorCanvas';
import VideoUpload from './VideoUpload';
import { getApiBaseUrl, getWSUrl } from '../apiConfig';

const CAMERA_ANALYSIS_TAGS_UPDATED_EVENT = 'camera-analysis-tags-updated';
const DEFAULT_FISHEYE_VIEW = 0;

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

const inferSourceType = (sourcePath = '', enableFisheye = false) => {
    const normalized = String(sourcePath || '').trim().toLowerCase();
    if (normalized.startsWith('rtsp://') || normalized.startsWith('rtsps://')) {
        return enableFisheye ? 'RTSP Fisheye' : 'RTSP';
    }
    return enableFisheye ? 'Network Stream Fisheye' : 'Network Stream';
};

const parseResolutionString = (resolution) => {
    const text = String(resolution || '').trim().toLowerCase();
    const match = text.match(/^(\d+)\s*x\s*(\d+)$/);
    if (match) {
        return {
            width: parseInt(match[1], 10),
            height: parseInt(match[2], 10),
        };
    }
    return { width: 640, height: 360 };
};

const SYSTEM_SURFACE_CARD_CLASS = 'border-slate-200/80 bg-white/95 shadow-sm';

const SystemConfiguration = () => {
    const apiUrl = getApiBaseUrl();
    const previewContainerRef = useRef(null);
    const [searchParams, setSearchParams] = useSearchParams();
    const [cameras, setCameras] = useState([]);
    const [activeManagementTab, setActiveManagementTab] = useState(
        searchParams.get('tab') === 'uploads' ? 'uploads' : 'streams'
    );
    const [activeStreamTab, setActiveStreamTab] = useState('added');
    const [activeUploadTab, setActiveUploadTab] = useState('create');
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
    const [selectedViews, setSelectedViews] = useState(new Set([DEFAULT_FISHEYE_VIEW]));
    const [sourceRoi, setSourceRoi] = useState(null);
    const [isDrawingSourceRoi, setIsDrawingSourceRoi] = useState(false);
    const [uploadPreviewUrl, setUploadPreviewUrl] = useState('');
    const [uploadPreviewImage, setUploadPreviewImage] = useState('');
    const [uploadPreviewSize, setUploadPreviewSize] = useState({ width: 640, height: 360 });
    const [streamPreview, setStreamPreview] = useState(null);

    // Form State
    const [formData, setFormData] = useState({
        name: '',
        location: '',
        streamUrl: '',
        frameRate: '30',
        resolution: '1080p',
        enabled: true,
    });

    useEffect(() => {
        fetchCameras();
        fetchSyncGroups();
    }, []);

    useEffect(() => {
        const requestedTab = searchParams.get('tab') === 'uploads' ? 'uploads' : 'streams';
        setActiveManagementTab(requestedTab);
    }, [searchParams]);

    useEffect(() => {
        const handleCameraTagsUpdated = () => {
            fetchCameras();
        };

        window.addEventListener(CAMERA_ANALYSIS_TAGS_UPDATED_EVENT, handleCameraTagsUpdated);
        return () => {
            window.removeEventListener(CAMERA_ANALYSIS_TAGS_UPDATED_EVENT, handleCameraTagsUpdated);
        };
    }, []);

    const fetchCameras = async () => {
        try {
            console.log("SystemConfig fetching from:", apiUrl);
            const res = await fetch(`${apiUrl}/api/cameras`);
            const data = await res.json();
            setCameras((Array.isArray(data) ? data : []).filter((camera) => !camera.is_uploaded));
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
            streamUrl: '',
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
        setSelectedViews(new Set([DEFAULT_FISHEYE_VIEW]));
        setTestResult(null);
        setSourceRoi(null);
        setIsDrawingSourceRoi(false);
        setStreamPreview(null);
        setUploadPreviewImage('');
    };

    const handleAddClick = () => {
        resetForm();
        setActiveManagementTab('streams');
        setActiveStreamTab('form');
        setSearchParams({}, { replace: true });
        setIsAddMode(true);
    };

    const handleEditClick = (cam) => {
        setFormData({
            name: cam.name,
            location: cam.location,
            streamUrl: cam.source_path || '',
            frameRate: String(cam.fps ?? 30),
            resolution: cam.resolution,
            enabled: cam.enabled,
        });
        setEnableFisheye(Boolean(cam.is_fisheye));
        setSelectedViews(
            cam.is_fisheye && Number.isInteger(cam.view_index) && cam.view_index >= 0
                ? new Set([cam.view_index])
                : new Set([DEFAULT_FISHEYE_VIEW])
        );
        setSourceRoi(cam.detection_roi || null);
        setIsDrawingSourceRoi(false);
        setStreamPreview(null);
        setSelectedCamera(cam);
        setActiveManagementTab('streams');
        setActiveStreamTab('form');
        setSearchParams({}, { replace: true });
        setIsEditMode(true);
    };

    const handleShowStreams = () => {
        resetForm();
        setActiveManagementTab('streams');
        setActiveStreamTab('added');
        setSearchParams({}, { replace: true });
    };

    const handleShowUploads = () => {
        resetForm();
        setActiveManagementTab('uploads');
        setSearchParams({ tab: 'uploads' }, { replace: true });
    };

    const handleShowAddedStreams = () => {
        resetForm();
        setActiveManagementTab('streams');
        setActiveStreamTab('added');
        setSearchParams({}, { replace: true });
    };

    const handleInputChange = (e) => {
        const { name, value, type, checked } = e.target;
        setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
        if (name === 'streamUrl' && testResult) {
            setTestResult(null);
            setStreamPreview(null);
        }
    };

    const handleFileChange = (e) => {
        if (e.target.files && e.target.files[0]) {
            setSelectedFile(e.target.files[0]);
            setSourceRoi(null);
            setIsDrawingSourceRoi(false);
        }
    };

    useEffect(() => {
        if (!selectedFile) {
            setUploadPreviewUrl('');
            setUploadPreviewImage('');
            setUploadPreviewSize({ width: 640, height: 360 });
            return undefined;
        }
        const objectUrl = URL.createObjectURL(selectedFile);
        setUploadPreviewUrl(objectUrl);
        setUploadPreviewImage('');
        setUploadPreviewSize({ width: 640, height: 360 });

        let cancelled = false;

        const loadBackendPreview = async () => {
            try {
                const formData = new FormData();
                formData.append('file', selectedFile);
                const res = await fetch(`${apiUrl}/api/cameras/upload-preview`, {
                    method: 'POST',
                    body: formData,
                });
                if (!res.ok) {
                    return;
                }
                const data = await res.json();
                if (cancelled || !data?.preview_image) {
                    return;
                }
                setUploadPreviewImage(`data:image/jpeg;base64,${data.preview_image}`);
                setUploadPreviewSize({
                    width: parseInt(data.frame_width, 10) || 640,
                    height: parseInt(data.frame_height, 10) || 360,
                });
            } catch (error) {
                if (!cancelled) {
                    console.error('Failed to load backend upload preview:', error);
                }
            }
        };
        loadBackendPreview();

        return () => {
            cancelled = true;
            URL.revokeObjectURL(objectUrl);
        };
    }, [selectedFile]);

    const handleClearSourceRoi = () => {
        setSourceRoi(null);
        setIsDrawingSourceRoi(false);
    };

    const handleSelectSingleView = (idx) => {
        setSelectedViews(new Set([idx]));
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
            if (sourceRoi?.points?.length >= 3) {
                uploadData.append('detection_roi', JSON.stringify(sourceRoi));
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
            type: inferSourceType(formData.streamUrl, false),
            status: formData.enabled ? 'Online' : 'Disabled',
            mode: selectedCamera?.mode || 'Unassigned',
            source_path: formData.streamUrl.trim(),
            resolution: formData.resolution,
            fps: parseInt(formData.frameRate, 10) || 30,
            enabled: formData.enabled,
            image: '',
            view_index: -1,
            is_fisheye: false,
            detection_roi: sourceRoi?.points?.length >= 3 ? sourceRoi : null,
        };

        try {
            if (!payload.source_path) {
                alert("Please enter a stream URL.");
                return;
            }

            if (enableFisheye) {
                if (isEditMode) {
                    alert("Editing fisheye stream sources is not supported yet. Delete and recreate the source.");
                    return;
                }

                const res = await fetch(`${apiUrl}/api/cameras/stream-source`, {
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
                        detection_roi: payload.detection_roi,
                    }),
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || 'Failed to create fisheye stream source');
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
        if (!formData.streamUrl) {
            setTestResult({ type: 'error', message: 'Please enter a stream URL.' });
            return;
        }

        setIsTestingConnection(true);
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);
            const res = await fetch(`${apiUrl}/api/cameras/test-stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    source_path: formData.streamUrl.trim(),
                    enable_fisheye: enableFisheye,
                    selected_view: Array.from(selectedViews)[0] ?? DEFAULT_FISHEYE_VIEW,
                }),
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
                throw new Error(data.detail || 'Unable to reach stream.');
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
            setStreamPreview(
                data.preview_image
                    ? {
                        image: `data:image/jpeg;base64,${data.preview_image}`,
                        width: parseInt(data.frame_width, 10) || parseResolutionString(data.resolution).width,
                        height: parseInt(data.frame_height, 10) || parseResolutionString(data.resolution).height,
                    }
                    : null
            );
        } catch (error) {
            const message = error?.name === 'AbortError'
                ? 'Connection test timed out.'
                : (error?.message || 'Connection test failed.');
            setTestResult({ type: 'error', message });
            setStreamPreview(null);
        } finally {
            setIsTestingConnection(false);
        }
    };

    const isStreamSource = (cam) =>
        cam.source_kind === 'rtsp' || cam.source_kind === 'network';


    return (
        <div className="flex h-full flex-col gap-6 overflow-auto bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.08),_transparent_32%),linear-gradient(180deg,_rgba(248,250,252,0.95),_rgba(255,255,255,1))] p-6 text-foreground">
            <section className="relative overflow-hidden rounded-[28px] border border-slate-200/80 bg-white/90 p-6 shadow-sm backdrop-blur">
                <div className="pointer-events-none absolute right-[-100px] top-[-120px] h-64 w-64 rounded-full bg-blue-100/60 blur-3xl" />
                <div className="relative flex items-center justify-between">
                    <h1 className="text-2xl font-bold">System Configuration</h1>
                </div>
            </section>

            <div className="flex flex-1 flex-col overflow-hidden">
                {/* Toolbar */}
                <section className={cn(SYSTEM_SURFACE_CARD_CLASS, "mb-4 rounded-[28px] p-5 md:p-6")}>
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div className="flex gap-2">
                            <Button
                                type="button"
                                onClick={handleShowStreams}
                                variant={activeManagementTab === 'streams' ? 'default' : 'outline'}
                                className={cn(activeManagementTab !== 'streams' && "border-slate-200 bg-white")}
                            >
                                Live Stream Camera
                            </Button>
                            <Button
                                type="button"
                                onClick={handleShowUploads}
                                variant={activeManagementTab === 'uploads' ? 'default' : 'outline'}
                                className={cn(activeManagementTab !== 'uploads' && "border-slate-200 bg-white")}
                            >
                                Upload Video
                            </Button>
                        </div>
                        <div className="text-sm text-muted-foreground">
                            {activeManagementTab === 'streams'
                                ? `${cameras.length} Live Sources Configured`
                                : 'Manage uploaded video sources'}
                        </div>
                    </div>

                    {activeManagementTab === 'streams' && (
                        <div className="mt-4 flex gap-2">
                            <Button
                                type="button"
                                onClick={handleShowAddedStreams}
                                variant={activeStreamTab === 'added' && !isAddMode && !isEditMode ? 'default' : 'outline'}
                                className={cn(activeStreamTab !== 'added' || isAddMode || isEditMode ? "border-slate-200 bg-white" : undefined)}
                            >
                                Added Stream Camera
                            </Button>
                            <Button
                                type="button"
                                onClick={handleAddClick}
                                className="flex items-center gap-2"
                                variant={activeStreamTab === 'form' ? 'default' : 'outline'}
                            >
                                <Plus className="w-4 h-4" />
                                {isEditMode ? 'Modify Stream Camera' : 'Add Stream Camera'}
                            </Button>
                        </div>
                    )}

                    {activeManagementTab === 'uploads' && (
                        <div className="mt-4 flex gap-2">
                            <Button
                                type="button"
                                onClick={() => setActiveUploadTab('create')}
                                variant={activeUploadTab === 'create' ? 'default' : 'outline'}
                                className={cn(activeUploadTab !== 'create' && "border-slate-200 bg-white")}
                            >
                                Create Upload Source
                            </Button>
                            <Button
                                type="button"
                                onClick={() => setActiveUploadTab('sources')}
                                variant={activeUploadTab === 'sources' ? 'default' : 'outline'}
                                className={cn(activeUploadTab !== 'sources' && "border-slate-200 bg-white")}
                            >
                                Uploaded Sources
                            </Button>
                        </div>
                    )}
                </section>

                {/* Content */}
                <div className="flex-1 overflow-auto pr-2">
                    {activeManagementTab === 'uploads' ? (
                        <VideoUpload
                            embedded
                            activeSection={activeUploadTab}
                            onActiveSectionChange={setActiveUploadTab}
                        />
                    ) : (
                        activeStreamTab === 'added' && !isAddMode && !isEditMode && !showUpload ? (
                            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                                {cameras.map((cam) => {
                                    const overlayMode = inferOverlayMode(cam.analysis_tags);
                                    return (
                                    <Card key={cam.id} className={cn(SYSTEM_SURFACE_CARD_CLASS, "relative group overflow-hidden transition-all cursor-pointer hover:border-primary/50", !cam.enabled && "opacity-60")}>
                                        <div className="aspect-video bg-muted relative flex items-center justify-center bg-black">
                                            {isStreamSource(cam) ? (
                                                <StreamPlayer
                                                    wsUrl={getWSUrl(`/ws/${cam.id}`)}
                                                    className="w-full h-full"
                                                    alt="Live Stream"
                                                    overlayMode={overlayMode}
                                                    showCountingAnchors={overlayMode === 'counting'}
                                                />
                                            ) : (
                                                <div className="flex flex-col items-center">
                                                    <Camera className="w-8 h-8 text-muted-foreground mb-2" />
                                                    <span className="text-xs text-muted-foreground">Live Stream</span>
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
                                    );
                                })}
                            </div>
                        ) : null
                    )}

                    {/* Edit/Add/Upload Form Overlay */}
                    {activeManagementTab === 'streams' && activeStreamTab === 'form' && (isAddMode || isEditMode || showUpload) && (
                        <Card className={cn(SYSTEM_SURFACE_CARD_CLASS, "mx-auto max-w-2xl")}>
                            <CardHeader className="flex flex-row items-center justify-between">
                                <CardTitle>
                                    {showUpload ? "Upload Video Source" : (isEditMode ? "Modify Camera Source" : "Add Stream Camera")}
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
                                                <Label htmlFor="fisheye">Enable Fisheye Processing (Choose 1 of 8 Views)</Label>
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
                                                    <Label>Select One View</Label>
                                                    <div className="grid grid-cols-4 gap-2">
                                                        {[0, 1, 2, 3, 4, 5, 6, 7].map((idx) => {
                                                            const angle = idx * 45;
                                                            return (
                                                                <div key={idx} className="flex items-center space-x-2 border p-2 rounded hover:bg-muted/50">
                                                                    <Checkbox
                                                                        id={`view-${idx}`}
                                                                        checked={selectedViews.has(idx)}
                                                                        onCheckedChange={() => handleSelectSingleView(idx)}
                                                                    />
                                                                    <Label htmlFor={`view-${idx}`} className="cursor-pointer text-xs">
                                                                        View {idx + 1} ({angle}°)
                                                                    </Label>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                    <p className="text-xs text-muted-foreground">
                                                        Only one fisheye view can be processed and displayed at a time.
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

                                            {uploadPreviewUrl && (
                                                <div className="space-y-3 rounded-lg border p-3 bg-background/60">
                                                    <div className="flex items-center justify-between">
                                                        <Label>Detection ROI</Label>
                                                        <div className="flex gap-2">
                                                            <Button type="button" variant={isDrawingSourceRoi ? 'default' : 'outline'} size="sm" onClick={() => setIsDrawingSourceRoi((prev) => !prev)}>
                                                                {isDrawingSourceRoi ? 'Stop Drawing' : 'Draw ROI'}
                                                            </Button>
                                                            <Button type="button" variant="outline" size="sm" onClick={handleClearSourceRoi} disabled={!sourceRoi}>
                                                                Clear ROI
                                                            </Button>
                                                        </div>
                                                    </div>
                                                    <div ref={previewContainerRef} className="relative aspect-video overflow-hidden rounded-md bg-black">
                                                        {uploadPreviewImage ? (
                                                            <img
                                                                src={uploadPreviewImage}
                                                                alt="Upload preview"
                                                                className="h-full w-full object-contain"
                                                            />
                                                        ) : (
                                                            <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
                                                                Extracting preview frame...
                                                            </div>
                                                        )}
                                                        <RoiEditorCanvas
                                                            roi={sourceRoi}
                                                            drawingEnabled={isDrawingSourceRoi}
                                                            onChange={(nextRoi) => {
                                                                setSourceRoi(nextRoi);
                                                                setIsDrawingSourceRoi(false);
                                                            }}
                                                            containerRef={previewContainerRef}
                                                            mediaWidth={uploadPreviewSize.width}
                                                            mediaHeight={uploadPreviewSize.height}
                                                            label="Detection ROI"
                                                        />
                                                    </div>
                                                    <p className="text-xs text-muted-foreground">
                                                        If ROI is not set, the full original frame is sent to YOLO. When ROI is set, only that cropped region is used for detection.
                                                    </p>
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        // Live stream specific UI
                                        <>
                                            <div className="space-y-2">
                                                <Label>Stream URL</Label>
                                            <div className="flex gap-2">
                                                <input
                                                    type="text"
                                                    name="streamUrl"
                                                        value={formData.streamUrl}
                                                        onChange={handleInputChange}
                                                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                                        placeholder="rtsp://camera/stream"
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
                                                    id="stream-fisheye"
                                                    checked={enableFisheye}
                                                    disabled={isEditMode}
                                                    onCheckedChange={setEnableFisheye}
                                                />
                                                <Label htmlFor="stream-fisheye">Enable Fisheye Processing (Choose 1 Stream View)</Label>
                                            </div>
                                            {enableFisheye && (
                                                <div className="space-y-4 border rounded-lg p-4 bg-muted/30">
                                                    <Label>Select One View</Label>
                                                    <div className="grid grid-cols-4 gap-2">
                                                        {[0, 1, 2, 3, 4, 5, 6, 7].map((idx) => {
                                                            const angle = idx * 45;
                                                            return (
                                                                <div key={idx} className="flex items-center space-x-2 border p-2 rounded hover:bg-muted/50">
                                                                    <Checkbox
                                                                        id={`stream-view-${idx}`}
                                                                        checked={selectedViews.has(idx)}
                                                                        onCheckedChange={() => handleSelectSingleView(idx)}
                                                                    />
                                                                    <Label htmlFor={`stream-view-${idx}`} className="cursor-pointer text-xs">
                                                                        View {idx + 1} ({angle}°)
                                                                    </Label>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                    <p className="text-xs text-muted-foreground">
                                                        This creates one camera card for the selected fisheye view.
                                                    </p>
                                                </div>
                                            )}
                                            <div className="space-y-3 rounded-lg border p-3 bg-muted/20">
                                                <div className="flex items-center justify-between">
                                                    <Label>Detection ROI</Label>
                                                    <div className="flex gap-2">
                                                        <Button type="button" variant={isDrawingSourceRoi ? 'default' : 'outline'} size="sm" onClick={() => setIsDrawingSourceRoi((prev) => !prev)} disabled={!streamPreview}>
                                                            {isDrawingSourceRoi ? 'Stop Drawing' : 'Draw ROI'}
                                                        </Button>
                                                        <Button type="button" variant="outline" size="sm" onClick={handleClearSourceRoi} disabled={!sourceRoi}>
                                                            Clear ROI
                                                        </Button>
                                                    </div>
                                                </div>
                                                {!streamPreview && (
                                                    <p className="text-xs text-muted-foreground">
                                                        Test the stream first to load a preview frame, then draw the detector ROI. If ROI is not set, YOLO uses the full frame.
                                                    </p>
                                                )}
                                                {streamPreview && (
                                                    <div ref={previewContainerRef} className="relative aspect-video overflow-hidden rounded-md bg-black">
                                                        <img
                                                            src={streamPreview.image}
                                                            alt="Stream preview"
                                                            className="h-full w-full object-contain"
                                                        />
                                                        <RoiEditorCanvas
                                                            roi={sourceRoi}
                                                            drawingEnabled={isDrawingSourceRoi}
                                                            onChange={(nextRoi) => {
                                                                setSourceRoi(nextRoi);
                                                                setIsDrawingSourceRoi(false);
                                                            }}
                                                            containerRef={previewContainerRef}
                                                            mediaWidth={streamPreview.width}
                                                            mediaHeight={streamPreview.height}
                                                            label="Detection ROI"
                                                        />
                                                    </div>
                                                )}
                                            </div>
                                        </>
                                    )}

                                    <p className="text-xs text-muted-foreground">
                                        Analysis tags are assigned from the People Counting, Dress Code, and Fall Detection pages.
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
