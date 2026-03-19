import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    CheckCircle2,
    Clapperboard,
    FolderUp,
    Loader2,
    Play,
    RefreshCw,
    Square,
    Trash2,
} from 'lucide-react';
import { getApiBaseUrl, getWSUrl } from '../apiConfig';
import StreamPlayer from './StreamPlayer';
import RoiEditorCanvas from './RoiEditorCanvas';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { cn } from '../lib/utils';

const DEFAULT_FISHEYE_VIEW = 0;
const FISHEYE_VIEW_SUFFIX_PATTERN = /\s-\sView\s\d+\s*\([^)]*\)$/;

const getUploadDisplayName = (item) => {
    const explicitName = String(item?.display_name || '').trim();
    if (explicitName) {
        return explicitName;
    }

    const firstCameraName = String(item?.cameras?.[0]?.name || '').trim();
    if (firstCameraName) {
        return firstCameraName.replace(FISHEYE_VIEW_SUFFIX_PATTERN, '').trim() || firstCameraName;
    }

    return item?.file_name || '';
};

const VideoUpload = ({ embedded = false }) => {
    const apiUrl = getApiBaseUrl();
    const previewContainerRef = useRef(null);
    const [activeSection, setActiveSection] = useState('create');

    const [items, setItems] = useState([]);
    const [loadingItems, setLoadingItems] = useState(true);
    const [refreshTick, setRefreshTick] = useState(0);
    const [selectedRuntimeKeys, setSelectedRuntimeKeys] = useState(new Set());
    const [activeRuntimeKey, setActiveRuntimeKey] = useState('');

    const [selectedFile, setSelectedFile] = useState(null);
    const [cameraNamePrefix, setCameraNamePrefix] = useState('');
    const [enableFisheye, setEnableFisheye] = useState(false);
    const [selectedViews, setSelectedViews] = useState(new Set([DEFAULT_FISHEYE_VIEW]));
    const [sourceRoi, setSourceRoi] = useState(null);
    const [isDrawingSourceRoi, setIsDrawingSourceRoi] = useState(false);
    const [uploadPreviewUrl, setUploadPreviewUrl] = useState('');
    const [uploadPreviewImage, setUploadPreviewImage] = useState('');
    const [uploadPreviewSize, setUploadPreviewSize] = useState({ width: 640, height: 360 });
    const [runtimePreviewImage, setRuntimePreviewImage] = useState('');
    const [loadingRuntimePreview, setLoadingRuntimePreview] = useState(false);

    const [isUploading, setIsUploading] = useState(false);
    const [busyAction, setBusyAction] = useState('');
    const [message, setMessage] = useState(null);

    useEffect(() => {
        let cancelled = false;

        const fetchUploads = async () => {
            setLoadingItems(true);
            try {
                const res = await fetch(`${apiUrl}/api/upload-videos`);
                const data = await res.json().catch(() => ({ items: [] }));
                if (cancelled) {
                    return;
                }
                const nextItems = Array.isArray(data.items) ? data.items : [];
                setItems(nextItems);
                setSelectedRuntimeKeys((current) => {
                    const validKeys = new Set(nextItems.map((item) => item.runtime_key));
                    const filtered = new Set([...current].filter((key) => validKeys.has(key)));
                    if (!filtered.size && nextItems.length > 0) {
                        filtered.add(nextItems[0].runtime_key);
                    }
                    return filtered;
                });
                setActiveRuntimeKey((current) => {
                    if (current && nextItems.some((item) => item.runtime_key === current)) {
                        return current;
                    }
                    return nextItems[0]?.runtime_key || '';
                });
            } catch (error) {
                if (!cancelled) {
                    console.error('Failed to fetch uploaded videos:', error);
                }
            } finally {
                if (!cancelled) {
                    setLoadingItems(false);
                }
            }
        };

        fetchUploads();

        return () => {
            cancelled = true;
        };
    }, [apiUrl, refreshTick]);

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

        const video = document.createElement('video');
        video.preload = 'auto';
        video.muted = true;
        video.playsInline = true;

        let captured = false;
        let cancelled = false;
        let backendPreviewResolved = false;

        const captureFrame = () => {
            if (cancelled || captured || backendPreviewResolved) {
                return;
            }
            const width = video.videoWidth || 640;
            const height = video.videoHeight || 360;
            setUploadPreviewSize({ width, height });

            try {
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    return;
                }
                ctx.drawImage(video, 0, 0, width, height);
                setUploadPreviewImage(canvas.toDataURL('image/jpeg', 0.85));
                captured = true;
            } catch (error) {
                console.error('Failed to capture upload preview frame:', error);
            }
        };

        video.onloadedmetadata = () => {
            if (cancelled) {
                return;
            }
            const width = video.videoWidth || 640;
            const height = video.videoHeight || 360;
            setUploadPreviewSize({ width, height });

            if (!Number.isFinite(video.duration) || video.duration <= 0) {
                captureFrame();
                return;
            }

            const targetTime = Math.min(0.1, Math.max(video.duration / 20, 0.02));
            try {
                video.currentTime = targetTime;
            } catch (_) {
                captureFrame();
            }
        };

        video.onloadeddata = captureFrame;
        video.oncanplay = captureFrame;
        video.onseeked = captureFrame;
        video.onerror = () => {
            if (!cancelled) {
                console.error('Failed to load upload preview video.');
            }
        };
        video.src = objectUrl;
        video.load();

        const loadBackendPreview = async () => {
            try {
                const formData = new FormData();
                formData.append('file', selectedFile);
                formData.append('enable_fisheye', String(enableFisheye));
                formData.append('selected_view', String(Array.from(selectedViews)[0] ?? DEFAULT_FISHEYE_VIEW));
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
                backendPreviewResolved = true;
                captured = true;
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

        const fallbackTimer = window.setTimeout(() => {
            captureFrame();
        }, 2000);

        return () => {
            cancelled = true;
            window.clearTimeout(fallbackTimer);
            video.onloadedmetadata = null;
            video.onloadeddata = null;
            video.oncanplay = null;
            video.onseeked = null;
            video.onerror = null;
            video.src = '';
            URL.revokeObjectURL(objectUrl);
        };
    }, [apiUrl, enableFisheye, selectedFile, selectedViews]);

    const activeItem = useMemo(
        () => items.find((item) => item.runtime_key === activeRuntimeKey) || items[0] || null,
        [activeRuntimeKey, items],
    );
    const activeDisplayName = useMemo(() => getUploadDisplayName(activeItem), [activeItem]);

    useEffect(() => {
        let cancelled = false;

        const loadRuntimePreview = async () => {
            if (!activeItem || activeItem.producer_running) {
                setRuntimePreviewImage('');
                setLoadingRuntimePreview(false);
                return;
            }

            setLoadingRuntimePreview(true);
            try {
                const res = await fetch(`${apiUrl}/api/upload-videos/preview`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ runtime_key: activeItem.runtime_key }),
                });
                const data = await res.json().catch(() => ({}));
                if (cancelled) {
                    return;
                }
                if (!res.ok || !data.preview_image) {
                    throw new Error(data.detail || 'Preview unavailable.');
                }
                setRuntimePreviewImage(`data:image/jpeg;base64,${data.preview_image}`);
            } catch (error) {
                if (!cancelled) {
                    console.error('Failed to load uploaded runtime preview:', error);
                    setRuntimePreviewImage('');
                }
            } finally {
                if (!cancelled) {
                    setLoadingRuntimePreview(false);
                }
            }
        };

        loadRuntimePreview();
        return () => {
            cancelled = true;
        };
    }, [activeItem, apiUrl]);

    const selectedCount = selectedRuntimeKeys.size;

    const handleFileChange = (event) => {
        const file = event.target.files?.[0] || null;
        setSelectedFile(file);
        setSourceRoi(null);
        setIsDrawingSourceRoi(false);
        setMessage(null);
    };

    const handleToggleView = (index) => {
        setSelectedViews(new Set([index]));
    };

    const handleClearSourceRoi = () => {
        setSourceRoi(null);
        setIsDrawingSourceRoi(false);
    };

    const handleToggleSelection = (runtimeKey) => {
        setSelectedRuntimeKeys((current) => {
            const next = new Set(current);
            if (next.has(runtimeKey)) {
                next.delete(runtimeKey);
            } else {
                next.add(runtimeKey);
            }
            return next;
        });
    };

    const handleSelectAll = () => {
        setSelectedRuntimeKeys(new Set(items.map((item) => item.runtime_key)));
    };

    const handleClearSelection = () => {
        setSelectedRuntimeKeys(new Set());
    };

    const refreshUploads = () => {
        setRefreshTick((value) => value + 1);
    };

    const handleUpload = async () => {
        if (!selectedFile) {
            setMessage({ type: 'error', text: 'Please choose a video file first.' });
            return;
        }

        setIsUploading(true);
        setMessage(null);

        const formData = new FormData();
        formData.append('file', selectedFile);
        formData.append('camera_name_prefix', cameraNamePrefix.trim() || 'Uploaded Camera');
        formData.append('enable_fisheye', String(enableFisheye));
        if (enableFisheye) {
            formData.append('selected_views', Array.from(selectedViews).join(','));
        }
        if (sourceRoi?.points?.length >= 3) {
            formData.append('detection_roi', JSON.stringify(sourceRoi));
        }

        try {
            const controller = new AbortController();
            const timeoutId = window.setTimeout(() => controller.abort(), 10 * 60 * 1000);
            const res = await fetch(`${apiUrl}/api/upload_and_process`, {
                method: 'POST',
                body: formData,
                signal: controller.signal,
            });
            window.clearTimeout(timeoutId);

            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.detail || 'Upload failed.');
            }

            const createdRuntimeKey = Array.isArray(data.created_cameras) ? data.created_cameras[0]?.runtime_key : '';
            setMessage({
                type: 'success',
                text: 'Upload created successfully. Configure the analysis rules, then press Start Selected when ready.',
            });
            setSelectedFile(null);
            setSourceRoi(null);
            setIsDrawingSourceRoi(false);
            setUploadPreviewImage('');
            setUploadPreviewUrl('');
            setSelectedViews(new Set([DEFAULT_FISHEYE_VIEW]));
            setEnableFisheye(false);
            setCameraNamePrefix('');
            refreshUploads();
            if (createdRuntimeKey) {
                setActiveRuntimeKey(createdRuntimeKey);
                setSelectedRuntimeKeys(new Set([createdRuntimeKey]));
            }
            setActiveSection('sources');
        } catch (error) {
            setMessage({
                type: 'error',
                text: error?.name === 'AbortError'
                    ? 'Upload timed out.'
                    : (error?.message || 'Failed to upload video.'),
            });
        } finally {
            setIsUploading(false);
        }
    };

    const runAction = async (action, runtimeKeysOverride = null) => {
        const runtimeKeys = Array.isArray(runtimeKeysOverride)
            ? runtimeKeysOverride
            : Array.from(selectedRuntimeKeys);
        if (!runtimeKeys.length) {
            setMessage({ type: 'error', text: 'Select at least one uploaded video first.' });
            return;
        }

        if (action === 'delete' && !window.confirm(`Remove ${runtimeKeys.length} uploaded source(s)? This also deletes the uploaded video file.`)) {
            return;
        }

        setBusyAction(action);
        setMessage(null);
        try {
            const res = await fetch(`${apiUrl}/api/upload-videos/${action}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ runtime_keys: runtimeKeys }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.detail || `Failed to ${action} selected videos.`);
            }

            setMessage({
                type: 'success',
                text: action === 'start'
                    ? `Started ${data.started_sources || 0} uploaded source(s).`
                    : action === 'stop'
                        ? `Stopped ${data.stopped_sources || 0} uploaded source(s).`
                        : `Removed ${data.deleted_sources || 0} uploaded source(s).`,
            });
            if (action === 'delete') {
                setSelectedRuntimeKeys(new Set());
                setActiveRuntimeKey('');
                setRuntimePreviewImage('');
            }
            refreshUploads();
        } catch (error) {
            setMessage({
                type: 'error',
                text: error?.message || `Failed to ${action} selected videos.`,
            });
        } finally {
            setBusyAction('');
        }
    };

    return (
        <div className="flex flex-col gap-6">
            {!embedded && (
                <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight">Uploaded Video Manager</h1>
                        <p className="text-sm text-muted-foreground">
                            Upload video files here, configure counting or detection rules, then start the selected uploads when you are ready.
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Link className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground" to="/settings">
                            Manage RTSP Sources
                        </Link>
                        <Link className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground" to="/people-counting">
                            People Counting Rules
                        </Link>
                        <Link className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground" to="/dress-code">
                            Dress Code
                        </Link>
                        <Link className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground" to="/fall-detection">
                            Fall Detection
                        </Link>
                    </div>
                </div>
            )}

            <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                    <Button
                        type="button"
                        variant={activeSection === 'create' ? 'default' : 'outline'}
                        onClick={() => setActiveSection('create')}
                    >
                        Create Upload Source
                    </Button>
                    <Button
                        type="button"
                        variant={activeSection === 'sources' ? 'default' : 'outline'}
                        onClick={() => setActiveSection('sources')}
                    >
                        Uploaded Sources
                    </Button>
                </div>

                {activeSection === 'create' && (
                <Card className="w-full border-border/60">
                    <CardHeader>
                        <CardTitle>Create Upload Source</CardTitle>
                        <CardDescription>
                            Upload does not start analysis automatically. It only creates the source so you can configure it first.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="upload-name">Camera Name / Prefix</Label>
                            <input
                                id="upload-name"
                                type="text"
                                value={cameraNamePrefix}
                                onChange={(event) => setCameraNamePrefix(event.target.value)}
                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                placeholder="e.g. Warehouse Test Video"
                            />
                        </div>

                        <div className="relative rounded-xl border border-dashed border-border bg-muted/20 p-6 text-center">
                            <input
                                type="file"
                                className="absolute inset-0 cursor-pointer opacity-0"
                                accept="video/*"
                                onChange={handleFileChange}
                            />
                            <FolderUp className="mx-auto mb-3 h-9 w-9 text-muted-foreground" />
                            <div className="text-sm font-medium">
                                {selectedFile ? selectedFile.name : 'Choose a video file'}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                                MP4, AVI, MKV and other supported video formats
                            </div>
                        </div>

                        <div className="flex items-center space-x-2 rounded-lg border p-3">
                            <Checkbox
                                id="upload-fisheye"
                                checked={enableFisheye}
                                onCheckedChange={setEnableFisheye}
                            />
                            <Label htmlFor="upload-fisheye">Enable fisheye processing</Label>
                        </div>

                        {enableFisheye && (
                            <div className="space-y-3 rounded-lg border p-3">
                                <Label>Select One View</Label>
                                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                    {[0, 1, 2, 3, 4, 5, 6, 7].map((index) => (
                                        <label
                                            key={index}
                                            className={cn(
                                                'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs',
                                                selectedViews.has(index) && 'border-primary bg-primary/5',
                                            )}
                                        >
                                            <Checkbox
                                                checked={selectedViews.has(index)}
                                                onCheckedChange={() => handleToggleView(index)}
                                            />
                                            <span>View {index + 1}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>
                        )}

                        {uploadPreviewUrl && (
                            <div className="space-y-3 rounded-lg border p-3 bg-background/60">
                                <div className="flex items-center justify-between">
                                    <Label>Detection ROI</Label>
                                    <div className="flex gap-2">
                                        <Button
                                            type="button"
                                            variant={isDrawingSourceRoi ? 'default' : 'outline'}
                                            size="sm"
                                            onClick={() => setIsDrawingSourceRoi((prev) => !prev)}
                                        >
                                            {isDrawingSourceRoi ? 'Stop Drawing' : 'Draw ROI'}
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            onClick={handleClearSourceRoi}
                                            disabled={!sourceRoi}
                                        >
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
                            </div>
                        )}

                        {message && (
                            <div
                                className={cn(
                                    'rounded-md border px-3 py-2 text-sm',
                                    message.type === 'success'
                                        ? 'border-green-500/30 bg-green-500/10 text-green-600'
                                        : 'border-red-500/30 bg-red-500/10 text-red-600',
                                )}
                            >
                                {message.text}
                            </div>
                        )}

                        <Button className="w-full" onClick={handleUpload} disabled={!selectedFile || isUploading}>
                            {isUploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Clapperboard className="mr-2 h-4 w-4" />}
                            {isUploading ? 'Creating Source...' : 'Upload Without Starting'}
                        </Button>
                    </CardContent>
                </Card>
                )}

                {activeSection === 'sources' && (
                <div className="space-y-6">
                    <Card className="border-border/60">
                        <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                            <div>
                                <CardTitle>Uploaded Sources</CardTitle>
                                <CardDescription>
                                    Select one or more uploaded videos, then start them together or stop them manually.
                                </CardDescription>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                <Button variant="outline" onClick={handleSelectAll} disabled={!items.length}>Select All</Button>
                                <Button variant="outline" onClick={handleClearSelection} disabled={!selectedCount}>Clear</Button>
                                <Button variant="outline" onClick={refreshUploads}>
                                    <RefreshCw className="mr-2 h-4 w-4" />
                                    Refresh
                                </Button>
                                <Button onClick={() => runAction('start')} disabled={!selectedCount || busyAction === 'stop' || busyAction === 'delete'}>
                                    {busyAction === 'start' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                                    Start Selected
                                </Button>
                                <Button variant="secondary" onClick={() => runAction('stop')} disabled={!selectedCount || busyAction === 'start' || busyAction === 'delete'}>
                                    {busyAction === 'stop' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Square className="mr-2 h-4 w-4" />}
                                    Stop Selected
                                </Button>
                                <Button variant="destructive" onClick={() => runAction('delete')} disabled={!selectedCount || busyAction === 'start' || busyAction === 'stop'}>
                                    {busyAction === 'delete' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                                    Remove Selected
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            {message && (
                                <div
                                    className={cn(
                                        'rounded-md border px-3 py-2 text-sm',
                                        message.type === 'success'
                                            ? 'border-green-500/30 bg-green-500/10 text-green-600'
                                            : 'border-red-500/30 bg-red-500/10 text-red-600',
                                    )}
                                >
                                    {message.text}
                                </div>
                            )}

                            {loadingItems ? (
                                <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    Loading uploaded videos...
                                </div>
                            ) : !items.length ? (
                                <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                                    No uploaded videos yet.
                                </div>
                            ) : (
                                <div className="grid gap-4 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
                                    <div className="space-y-3">
                                        {items.map((item) => {
                                            const isSelected = selectedRuntimeKeys.has(item.runtime_key);
                                            const isActive = activeItem?.runtime_key === item.runtime_key;
                                            const isRunning = Boolean(item.producer_running);
                                            const displayName = getUploadDisplayName(item);
                                            return (
                                                <button
                                                    key={item.runtime_key}
                                                    type="button"
                                                    onClick={() => setActiveRuntimeKey(item.runtime_key)}
                                                    className={cn(
                                                        'w-full rounded-xl border p-4 text-left transition',
                                                        isActive ? 'border-primary bg-primary/5' : 'border-border bg-card',
                                                    )}
                                                >
                                                    <div className="flex items-start gap-3">
                                                        <Checkbox
                                                            checked={isSelected}
                                                            onCheckedChange={() => handleToggleSelection(item.runtime_key)}
                                                            onClick={(event) => event.stopPropagation()}
                                                        />
                                                        <div className="min-w-0 flex-1">
                                                            <div className="flex items-center justify-between gap-3">
                                                                <div className="truncate font-medium">{displayName}</div>
                                                                <span
                                                                    className={cn(
                                                                        'rounded-full px-2 py-1 text-[11px] font-medium',
                                                                        isRunning
                                                                            ? 'bg-green-500/10 text-green-600'
                                                                            : 'bg-amber-500/10 text-amber-600',
                                                                    )}
                                                                >
                                                                    {item.status}
                                                                </span>
                                                            </div>
                                                            <div className="mt-1 text-xs text-muted-foreground">
                                                                {item.is_fisheye ? 'Fisheye upload' : 'Standard upload'} • {item.camera_count} camera source{item.camera_count > 1 ? 's' : ''}
                                                            </div>
                                                            <div className="mt-2 flex flex-wrap gap-2">
                                                                {(item.analysis_tags || ['Unassigned']).map((tag) => (
                                                                    <span key={`${item.runtime_key}-${tag}`} className="rounded-full bg-secondary px-2 py-1 text-[11px]">
                                                                        {tag}
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>

                                    <div className="space-y-4">
                                        {activeItem ? (
                                            <>
                                                <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                                                    <div>
                                                        <div className="text-lg font-semibold">{activeDisplayName}</div>
                                                        <div className="text-sm text-muted-foreground">
                                                            Uploaded source preview and runtime status
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <span
                                                            className={cn(
                                                                'rounded-full px-3 py-1 text-xs font-medium',
                                                                activeItem.producer_running
                                                                    ? 'bg-green-500/10 text-green-600'
                                                                    : 'bg-amber-500/10 text-amber-600',
                                                            )}
                                                        >
                                                            {activeItem.status}
                                                        </span>
                                                    </div>
                                                </div>

                                                    <div className="grid gap-3 md:grid-cols-3">
                                                        <div className="rounded-lg border p-3">
                                                            <div className="text-xs uppercase tracking-wide text-muted-foreground">Source Path</div>
                                                            <div className="mt-1 break-all text-sm">{activeItem.source_path}</div>
                                                        </div>
                                                        <div className="rounded-lg border p-3">
                                                        <div className="text-xs uppercase tracking-wide text-muted-foreground">Views</div>
                                                        <div className="mt-1 text-sm">
                                                            {activeItem.selected_views?.length
                                                                ? activeItem.selected_views.map((viewIndex) => `View ${viewIndex + 1}`).join(', ')
                                                                : 'Original'}
                                                            </div>
                                                        </div>
                                                        <div className="rounded-lg border p-3">
                                                            <div className="text-xs uppercase tracking-wide text-muted-foreground">Linked Cameras</div>
                                                            <div className="mt-2 grid gap-2">
                                                                {(activeItem.cameras || []).map((camera) => (
                                                                    <div key={camera.id} className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-2">
                                                                        <div>
                                                                            <div className="text-sm font-medium">{camera.name}</div>
                                                                            <div className="text-xs text-muted-foreground">
                                                                                {camera.analysis_tags?.join(', ') || 'Unassigned'}
                                                                            </div>
                                                                        </div>
                                                                        {camera.producer_running && (
                                                                            <span className="flex items-center gap-1 text-xs text-green-600">
                                                                                <CheckCircle2 className="h-3.5 w-3.5" />
                                                                                Running
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    </div>

                                                <div className="overflow-hidden rounded-xl border bg-black">
                                                    <div className="aspect-video">
                                                        {activeItem.producer_running ? (
                                                            <StreamPlayer
                                                                wsUrl={getWSUrl(`/ws/${activeItem.primary_camera_id}`)}
                                                                className="h-full w-full"
                                                                    alt={activeDisplayName}
                                                            />
                                                        ) : runtimePreviewImage ? (
                                                            <img
                                                                src={runtimePreviewImage}
                                                                    alt={`${activeDisplayName} preview`}
                                                                className="h-full w-full object-contain"
                                                            />
                                                        ) : (
                                                            <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
                                                                {loadingRuntimePreview ? 'Loading preview...' : 'Preview unavailable. Start the upload to inspect the live frame.'}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </>
                                        ) : (
                                            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                                                Select an uploaded source to inspect it here.
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
                )}
            </div>
        </div>
    );
};

export default VideoUpload;
