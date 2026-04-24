import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    Clapperboard,
    Edit2,
    FolderUp,
    Loader2,
    Play,
    RefreshCw,
    Save,
    Square,
    Trash2,
} from 'lucide-react';
import { getApiBaseUrl, getWSUrl } from '../apiConfig';
import StreamPlayer from './StreamPlayer';
import RoiEditorCanvas from './RoiEditorCanvas';
import ConfirmationDialog from './ConfirmationDialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { cn } from '../lib/utils';

const DEFAULT_FISHEYE_VIEW = 0;
const SUCCESS_REFRESH_DELAY_MS = 1200;
const FISHEYE_VIEW_SUFFIX_PATTERN = /\s-\sView\s\d+\s*\([^)]*\)$/;
const FISHEYE_VIEW_OPTIONS = Array.from({ length: 8 }, (_, index) => ({
    index,
    angle: index * 45,
    label: `View ${index + 1} (${index * 45}\u00B0)`,
}));

const getFisheyeViewLabel = (viewIndex) => (
    FISHEYE_VIEW_OPTIONS.find((option) => option.index === viewIndex)?.label || `View ${viewIndex + 1}`
);

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

const parseFilenameStartTimeForInput = (filename) => {
    const normalized = String(filename || '').trim();
    if (!normalized) {
        return '';
    }

    const match = normalized.match(/^(\d{14})(?:_|$)/);
    if (!match) {
        return '';
    }

    const raw = match[1];
    const year = Number(raw.slice(0, 4));
    const month = Number(raw.slice(4, 6));
    const day = Number(raw.slice(6, 8));
    const hour = Number(raw.slice(8, 10));
    const minute = Number(raw.slice(10, 12));
    const second = Number(raw.slice(12, 14));
    const parsed = new Date(year, month - 1, day, hour, minute, second);

    if (
        Number.isNaN(parsed.getTime())
        || parsed.getFullYear() !== year
        || parsed.getMonth() !== month - 1
        || parsed.getDate() !== day
        || parsed.getHours() !== hour
        || parsed.getMinutes() !== minute
        || parsed.getSeconds() !== second
    ) {
        return '';
    }

    return formatDateTimeLocalInput(parsed);
};

const buildUploadEditForm = (item) => {
    const primaryCamera = item?.cameras?.[0] || {};
    const selectedView = Number.isInteger(item?.selected_views?.[0])
        ? item.selected_views[0]
        : (Number.isInteger(primaryCamera?.view_index) && primaryCamera.view_index >= 0
            ? primaryCamera.view_index
            : DEFAULT_FISHEYE_VIEW);
    return {
        name: getUploadDisplayName(item),
        location: String(primaryCamera.location || ''),
        sourcePath: String(item?.source_path || ''),
        detectionRoi: primaryCamera?.detection_roi || null,
        isFisheye: Boolean(item?.is_fisheye),
        selectedView,
        uploadedVideoStartTime: formatDateTimeLocalInput(
            item?.uploaded_video_start_time || item?.uploaded_video_start_time_override,
        ),
    };
};

function formatDateTimeLocalInput(value) {
    if (!value) {
        return '';
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '';
    }

    const pad = (segment) => String(segment).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const formatVideoDateTime = (value) => {
    if (!value) {
        return '-';
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '-';
    }

    return date.toLocaleString();
};

const formatVideoDuration = (durationSeconds) => {
    const totalSeconds = Number(durationSeconds);
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
        return 'Unknown';
    }

    const roundedSeconds = Math.round(totalSeconds);
    const hours = Math.floor(roundedSeconds / 3600);
    const minutes = Math.floor((roundedSeconds % 3600) / 60);
    const seconds = roundedSeconds % 60;

    if (hours > 0) {
        return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
    }
    if (minutes > 0) {
        return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
    }
    return `${seconds}s`;
};

const formatVideoFps = (fps) => {
    const numericFps = Number(fps);
    if (!Number.isFinite(numericFps) || numericFps <= 0) {
        return 'Unknown';
    }
    return Number.isInteger(numericFps) ? `${numericFps}` : numericFps.toFixed(2).replace(/\.?0+$/, '');
};

const VideoUpload = ({ embedded = false, activeSection: controlledActiveSection = null, onActiveSectionChange = null }) => {
    const apiUrl = getApiBaseUrl();
    const previewContainerRef = useRef(null);
    const refreshTimeoutRef = useRef(null);
    const [internalActiveSection, setInternalActiveSection] = useState('sources');
    const activeSection = controlledActiveSection ?? internalActiveSection;
    const setActiveSection = onActiveSectionChange ?? setInternalActiveSection;

    const [items, setItems] = useState([]);
    const [loadingItems, setLoadingItems] = useState(true);
    const [refreshTick, setRefreshTick] = useState(0);
    const [selectedRuntimeKeys, setSelectedRuntimeKeys] = useState(new Set());
    const [activeRuntimeKey, setActiveRuntimeKey] = useState('');

    const [selectedFile, setSelectedFile] = useState(null);
    const [cameraNamePrefix, setCameraNamePrefix] = useState('');
    const [uploadLocation, setUploadLocation] = useState('');
    const [uploadVideoStartTime, setUploadVideoStartTime] = useState('');
    const [uploadFilenameHasTimestamp, setUploadFilenameHasTimestamp] = useState(false);
    const [enableFisheye, setEnableFisheye] = useState(false);
    const [selectedViews, setSelectedViews] = useState(new Set([DEFAULT_FISHEYE_VIEW]));
    const [sourceRoi, setSourceRoi] = useState(null);
    const [isDrawingSourceRoi, setIsDrawingSourceRoi] = useState(false);
    const [uploadPreviewUrl, setUploadPreviewUrl] = useState('');
    const [uploadPreviewImage, setUploadPreviewImage] = useState('');
    const [uploadPreviewSize, setUploadPreviewSize] = useState({ width: 640, height: 360 });
    const [uploadPreviewMeta, setUploadPreviewMeta] = useState({
        durationSeconds: null,
        resolution: null,
        fps: null,
    });
    const [runtimePreviewImage, setRuntimePreviewImage] = useState('');
    const [loadingRuntimePreview, setLoadingRuntimePreview] = useState(false);

    const [isUploading, setIsUploading] = useState(false);
    const [busyAction, setBusyAction] = useState('');
    const [isEditingSource, setIsEditingSource] = useState(false);
    const [isSavingEdit, setIsSavingEdit] = useState(false);
    const [editForm, setEditForm] = useState(() => buildUploadEditForm(null));
    const [isDrawingEditRoi, setIsDrawingEditRoi] = useState(false);
    const [editPreviewImage, setEditPreviewImage] = useState('');
    const [editPreviewSize, setEditPreviewSize] = useState({ width: 640, height: 360 });
    const [loadingEditPreview, setLoadingEditPreview] = useState(false);
    const [confirmAction, setConfirmAction] = useState(null);
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

    useEffect(() => () => {
        if (refreshTimeoutRef.current) {
            window.clearTimeout(refreshTimeoutRef.current);
        }
    }, []);

    useEffect(() => {
        if (!selectedFile) {
            setUploadPreviewUrl('');
            setUploadPreviewImage('');
            setUploadPreviewSize({ width: 640, height: 360 });
            setUploadPreviewMeta({ durationSeconds: null, resolution: null, fps: null });
            return undefined;
        }

        const objectUrl = URL.createObjectURL(selectedFile);
        setUploadPreviewUrl(objectUrl);
        setUploadPreviewImage('');
        setUploadPreviewSize({ width: 640, height: 360 });
        setUploadPreviewMeta({ durationSeconds: null, resolution: null, fps: null });

        let cancelled = false;

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
                setUploadPreviewImage(`data:image/jpeg;base64,${data.preview_image}`);
                setUploadPreviewSize({
                    width: parseInt(data.frame_width, 10) || 640,
                    height: parseInt(data.frame_height, 10) || 360,
                });
                setUploadPreviewMeta({
                    durationSeconds: data.video_duration_seconds ?? null,
                    resolution: data.video_resolution || null,
                    fps: data.video_fps ?? null,
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
    }, [apiUrl, enableFisheye, selectedFile, selectedViews]);

    const activeItem = useMemo(
        () => items.find((item) => item.runtime_key === activeRuntimeKey) || items[0] || null,
        [activeRuntimeKey, items],
    );
    const activeDisplayName = useMemo(() => getUploadDisplayName(activeItem), [activeItem]);
    const sortedItems = useMemo(
        () => [...items].sort((left, right) => (
            getUploadDisplayName(left).localeCompare(getUploadDisplayName(right), undefined, {
                numeric: true,
                sensitivity: 'base',
            })
        )),
        [items],
    );

    useEffect(() => {
        setIsEditingSource(false);
        setIsSavingEdit(false);
        setIsDrawingEditRoi(false);
        setEditPreviewImage('');
        setEditPreviewSize({ width: 640, height: 360 });
        setEditForm(buildUploadEditForm(activeItem));
    }, [activeItem?.runtime_key]);

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
        const parsedStartTime = parseFilenameStartTimeForInput(file?.name);
        setSelectedFile(file);
        setUploadVideoStartTime(parsedStartTime);
        setUploadFilenameHasTimestamp(Boolean(parsedStartTime));
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
        setSelectedRuntimeKeys(new Set(sortedItems.map((item) => item.runtime_key)));
    };

    const handleClearSelection = () => {
        setSelectedRuntimeKeys(new Set());
    };

    const refreshUploads = () => {
        setRefreshTick((value) => value + 1);
    };

    const schedulePageRefresh = () => {
        if (refreshTimeoutRef.current) {
            window.clearTimeout(refreshTimeoutRef.current);
        }
        refreshTimeoutRef.current = window.setTimeout(() => {
            window.location.reload();
        }, SUCCESS_REFRESH_DELAY_MS);
    };

    const requestActionConfirmation = (action, runtimeKeysOverride = null) => {
        const runtimeKeys = Array.isArray(runtimeKeysOverride)
            ? runtimeKeysOverride
            : Array.from(selectedRuntimeKeys);
        if (!runtimeKeys.length) {
            setMessage({ type: 'error', text: 'Select at least one uploaded video first.' });
            return;
        }

        setConfirmAction({
            action,
            runtimeKeys,
        });
    };

    const closeConfirmation = () => {
        setConfirmAction(null);
    };

    const handleBeginEdit = () => {
        if (!activeItem) {
            return;
        }
        setEditForm(buildUploadEditForm(activeItem));
        setIsEditingSource(true);
        setIsDrawingEditRoi(false);
        setMessage(null);
    };

    const handleCancelEdit = () => {
        setEditForm(buildUploadEditForm(activeItem));
        setIsEditingSource(false);
        setIsDrawingEditRoi(false);
    };

    const handleEditFieldChange = (field) => (event) => {
        setEditForm((current) => ({
            ...current,
            [field]: event.target.value,
        }));
    };

    const handleClearEditRoi = () => {
        setEditForm((current) => ({
            ...current,
            detectionRoi: null,
        }));
        setIsDrawingEditRoi(false);
    };

    const handleEditViewSelection = (viewIndex) => {
        setEditForm((current) => ({
            ...current,
            selectedView: viewIndex,
        }));
    };

    useEffect(() => {
        let cancelled = false;

        const loadEditPreview = async () => {
            if (!isEditingSource || !activeItem?.runtime_key) {
                setLoadingEditPreview(false);
                return;
            }

            setLoadingEditPreview(true);
            try {
                const res = await fetch(`${apiUrl}/api/upload-videos/preview`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        runtime_key: activeItem.runtime_key,
                        selected_view: editForm.isFisheye ? editForm.selectedView : null,
                    }),
                });
                const data = await res.json().catch(() => ({}));
                if (cancelled) {
                    return;
                }
                if (!res.ok || !data.preview_image) {
                    throw new Error(data.detail || 'Preview unavailable.');
                }
                setEditPreviewImage(`data:image/jpeg;base64,${data.preview_image}`);
                setEditPreviewSize({
                    width: parseInt(data.frame_width, 10) || 640,
                    height: parseInt(data.frame_height, 10) || 360,
                });
            } catch (error) {
                if (!cancelled) {
                    console.error('Failed to load uploaded edit preview:', error);
                    setEditPreviewImage('');
                    setEditPreviewSize({ width: 640, height: 360 });
                }
            } finally {
                if (!cancelled) {
                    setLoadingEditPreview(false);
                }
            }
        };

        loadEditPreview();
        return () => {
            cancelled = true;
        };
    }, [activeItem?.runtime_key, apiUrl, editForm.isFisheye, editForm.selectedView, isEditingSource]);

    const handleSaveEdit = async () => {
        if (!activeItem) {
            return;
        }

        const name = editForm.name.trim();
        if (!name) {
            setMessage({ type: 'error', text: 'Please enter a source name.' });
            return;
        }
        const location = editForm.location.trim();
        if (!location) {
            setMessage({ type: 'error', text: 'Please enter a location.' });
            return;
        }

        setIsSavingEdit(true);
        setMessage(null);
        try {
            const res = await fetch(`${apiUrl}/api/upload-videos`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    runtime_key: activeItem.runtime_key,
                    name,
                    location,
                    detection_roi: editForm.detectionRoi?.points?.length >= 3 ? editForm.detectionRoi : null,
                    is_fisheye: editForm.isFisheye,
                    view_index: editForm.isFisheye ? editForm.selectedView : -1,
                    uploaded_video_start_time_override: editForm.uploadedVideoStartTime || null,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.detail || 'Failed to update video source.');
            }

            if (data.item?.runtime_key) {
                setItems((current) => current.map((item) => (
                    item.runtime_key === data.item.runtime_key ? data.item : item
                )));
            } else {
                refreshUploads();
            }

            setMessage({ type: 'success', text: 'Video source updated successfully.' });
            setIsEditingSource(false);
        } catch (error) {
            setMessage({
                type: 'error',
                text: error?.message || 'Failed to update video source.',
            });
        } finally {
            setIsSavingEdit(false);
        }
    };

    const handleUpload = async () => {
        if (!selectedFile) {
            setMessage({ type: 'error', text: 'Please choose a video file first.' });
            return;
        }

        const normalizedCameraNamePrefix = cameraNamePrefix.trim();
        if (!normalizedCameraNamePrefix) {
            setMessage({ type: 'error', text: 'Please enter a camera name.' });
            return;
        }

        const normalizedUploadLocation = uploadLocation.trim();
        if (!normalizedUploadLocation) {
            setMessage({ type: 'error', text: 'Please enter a location.' });
            return;
        }

        setIsUploading(true);
        setMessage(null);

        const formData = new FormData();
        formData.append('file', selectedFile);
        formData.append('camera_name_prefix', normalizedCameraNamePrefix);
        formData.append('location', normalizedUploadLocation);
        formData.append('uploaded_video_start_time', uploadVideoStartTime.trim());
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
                text: 'Video source added successfully.',
            });
            setSelectedFile(null);
            setSourceRoi(null);
            setIsDrawingSourceRoi(false);
            setUploadPreviewImage('');
            setUploadPreviewUrl('');
            setUploadVideoStartTime('');
            setUploadFilenameHasTimestamp(false);
            setSelectedViews(new Set([DEFAULT_FISHEYE_VIEW]));
            setEnableFisheye(false);
            setCameraNamePrefix('');
            setUploadLocation('');
            refreshUploads();
            if (createdRuntimeKey) {
                setActiveRuntimeKey(createdRuntimeKey);
                setSelectedRuntimeKeys(new Set([createdRuntimeKey]));
            }
            setActiveSection('sources');
            schedulePageRefresh();
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
                    ? `Started ${data.started_sources || 0} video source(s).`
                    : action === 'stop'
                        ? `Stopped ${data.stopped_sources || 0} video source(s).`
                        : `Removed ${data.deleted_sources || 0} video source(s).`,
            });
            if (action === 'delete') {
                setSelectedRuntimeKeys(new Set());
                setActiveRuntimeKey('');
                setRuntimePreviewImage('');
                schedulePageRefresh();
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
            <ConfirmationDialog
                open={Boolean(confirmAction)}
                title={confirmAction?.action === 'stop' ? 'Stop Selected Uploads?' : 'Remove Selected Video Source?'}
                description={confirmAction?.action === 'stop'
                    ? `Stop ${confirmAction?.runtimeKeys?.length || 0} video source(s)? You can start them again later.`
                    : `Remove ${confirmAction?.runtimeKeys?.length || 0} video source(s)? This also deletes the uploaded video file.`}
                confirmLabel={confirmAction?.action === 'stop' ? 'Confirm Stop' : 'Confirm Remove'}
                confirmVariant={confirmAction?.action === 'delete' ? 'destructive' : 'secondary'}
                loading={busyAction === confirmAction?.action}
                loadingIcon={<Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                onCancel={closeConfirmation}
                onConfirm={async () => {
                    if (!confirmAction) {
                        return;
                    }
                    const pendingAction = confirmAction;
                    closeConfirmation();
                    await runAction(pendingAction.action, pendingAction.runtimeKeys);
                }}
            />

            {!embedded && (
                <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight">Video Sources</h1>
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
                {!embedded && (
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            variant={activeSection === 'sources' ? 'default' : 'outline'}
                            onClick={() => setActiveSection('sources')}
                        >
                            Added Video Sources
                        </Button>
                        <Button
                            type="button"
                            variant={activeSection === 'create' ? 'default' : 'outline'}
                            onClick={() => setActiveSection('create')}
                        >
                            Add Video Source
                        </Button>
                    </div>
                )}

                {activeSection === 'create' && (
                <Card className="mx-auto w-full max-w-2xl border-border/60">
                    <CardHeader>
                        <CardTitle>Add Video Source</CardTitle>
                        <CardDescription>
                            Adding a video source does not start analysis automatically. It only creates the source so you can configure it first.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-2">
                                <Label htmlFor="upload-name">Camera Name / Prefix</Label>
                                <input
                                    id="upload-name"
                                    type="text"
                                    value={cameraNamePrefix}
                                    onChange={(event) => setCameraNamePrefix(event.target.value)}
                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    placeholder="e.g. Warehouse Test Video"
                                    required
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="upload-location">Location</Label>
                                <input
                                    id="upload-location"
                                    type="text"
                                    value={uploadLocation}
                                    onChange={(event) => setUploadLocation(event.target.value)}
                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    placeholder="e.g. Building A"
                                    required
                                />
                            </div>
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

                        {selectedFile && (
                            <div className="space-y-3 rounded-lg border p-3">
                                <div className="grid gap-3 sm:grid-cols-3">
                                    <div className="rounded-md bg-muted/30 px-3 py-3">
                                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Duration</div>
                                        <div className="mt-1 text-sm font-medium">{formatVideoDuration(uploadPreviewMeta.durationSeconds)}</div>
                                    </div>
                                    <div className="rounded-md bg-muted/30 px-3 py-3">
                                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Resolution</div>
                                        <div className="mt-1 text-sm font-medium">{uploadPreviewMeta.resolution || 'Loading...'}</div>
                                    </div>
                                    <div className="rounded-md bg-muted/30 px-3 py-3">
                                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">FPS</div>
                                        <div className="mt-1 text-sm font-medium">
                                            {uploadPreviewMeta.fps != null ? `${formatVideoFps(uploadPreviewMeta.fps)} FPS` : 'Loading...'}
                                        </div>
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="upload-video-start-time">Start Time</Label>
                                    <input
                                        id="upload-video-start-time"
                                        type="datetime-local"
                                        step="1"
                                        value={uploadVideoStartTime}
                                        onChange={(event) => setUploadVideoStartTime(event.target.value)}
                                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                        placeholder="YYYY-MM-DDTHH:mm:ss"
                                    />
                                    <p className={cn(
                                        'text-xs',
                                        uploadFilenameHasTimestamp ? 'text-muted-foreground' : 'text-amber-600',
                                    )}>
                                        {uploadFilenameHasTimestamp
                                            ? 'Auto-filled from the filename. You can adjust it before upload.'
                                            : 'No valid 14-digit timestamp was found at the start of the filename. You can enter the start time manually or leave it empty.'}
                                    </p>
                                </div>
                            </div>
                        )}

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
                                    {FISHEYE_VIEW_OPTIONS.map(({ index, label }) => (
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
                                            <span>{label}</span>
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
                                <p className="text-xs text-muted-foreground">
                                    If ROI is never set, the whole image is used for detection.
                                </p>
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
                                <CardTitle>Added Video Sources</CardTitle>
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
                                    Start Selected ({selectedCount})
                                </Button>
                                <Button variant="secondary" onClick={() => requestActionConfirmation('stop')} disabled={!selectedCount || busyAction === 'start' || busyAction === 'delete'}>
                                    {busyAction === 'stop' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Square className="mr-2 h-4 w-4" />}
                                    Stop Selected ({selectedCount})
                                </Button>
                                <Button variant="destructive" onClick={() => requestActionConfirmation('delete')} disabled={!selectedCount || busyAction === 'start' || busyAction === 'stop'}>
                                    {busyAction === 'delete' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                                    Remove Selected ({selectedCount})
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
                                <div className="rounded-[28px] border border-dashed border-border/80 bg-muted/20 px-8 py-14 text-center">
                                    <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-blue-50 text-blue-600 shadow-sm">
                                        <FolderUp className="h-8 w-8" />
                                    </div>
                                    <h3 className="mt-6 text-2xl font-semibold text-slate-950">No video sources yet</h3>
                                    <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                                        This section is empty right now. Upload a video source first, then you can preview it here, edit its name and ROI, or start and stop it later.
                                    </p>
                                    <Button type="button" className="mt-6" onClick={() => setActiveSection('create')}>
                                        <Clapperboard className="mr-2 h-4 w-4" />
                                        Add Video Source
                                    </Button>
                                </div>
                            ) : (
                                <div className="grid gap-4 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
                                    <div className="max-h-[100vh] space-y-3 overflow-y-auto pr-2">
                                        {sortedItems.map((item) => {
                                            const isSelected = selectedRuntimeKeys.has(item.runtime_key);
                                            const isActive = activeItem?.runtime_key === item.runtime_key;
                                            const isRunning = Boolean(item.producer_running);
                                            const displayName = getUploadDisplayName(item);
                                            const metadataSummary = [
                                                formatVideoDuration(item.video_duration_seconds),
                                                item.video_resolution || 'Unknown resolution',
                                                `${formatVideoFps(item.video_fps)} FPS`,
                                            ].join(' • ');
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
                                                            <div className="mt-1 text-xs text-muted-foreground">
                                                                {metadataSummary}
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
                                                        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                                                            <div className="text-lg font-semibold">{activeDisplayName}</div>
                                                            {activeItem.cameras?.[0]?.location && (
                                                                <div className="text-sm text-muted-foreground">
                                                                    {activeItem.cameras[0].location}
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div className="text-sm text-muted-foreground">
                                                            Video source preview and runtime status
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <Button
                                                            type="button"
                                                            variant="outline"
                                                            size="sm"
                                                            onClick={handleBeginEdit}
                                                            disabled={isSavingEdit}
                                                        >
                                                            <Edit2 className="mr-2 h-4 w-4" />
                                                            Edit
                                                        </Button>
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

                                                {isEditingSource && (
                                                    <div className="rounded-xl border p-4">
                                                        <div className="grid gap-4 md:grid-cols-2">
                                                            <div className="space-y-2">
                                                                <Label htmlFor="edit-upload-name">Source Name</Label>
                                                                <input
                                                                    id="edit-upload-name"
                                                                    type="text"
                                                                    value={editForm.name}
                                                                    onChange={handleEditFieldChange('name')}
                                                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                                                    placeholder="e.g. Warehouse Test Video"
                                                                    required
                                                                />
                                                            </div>
                                                            <div className="space-y-2">
                                                                <Label htmlFor="edit-upload-location">Location</Label>
                                                                <input
                                                                    id="edit-upload-location"
                                                                    type="text"
                                                                    value={editForm.location}
                                                                    onChange={handleEditFieldChange('location')}
                                                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                                                    placeholder="e.g. Building A"
                                                                    required
                                                                />
                                                            </div>
                                                        </div>
                                                        <div className="mt-4 space-y-2">
                                                            <Label htmlFor="edit-video-start-time">Start Time</Label>
                                                            <input
                                                                id="edit-video-start-time"
                                                                type="datetime-local"
                                                                step="1"
                                                                value={editForm.uploadedVideoStartTime}
                                                                onChange={handleEditFieldChange('uploadedVideoStartTime')}
                                                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                                            />
                                                            <p className="text-xs text-muted-foreground">
                                                                Auto-filled from the filename during upload when available. You can correct it here.
                                                            </p>
                                                        </div>
                                                        <div className="mt-4 space-y-2">
                                                            <Label htmlFor="edit-upload-path">Source Path</Label>
                                                            <input
                                                                id="edit-upload-path"
                                                                type="text"
                                                                value={editForm.sourcePath}
                                                                readOnly
                                                                className="flex h-10 w-full rounded-md border border-input bg-muted px-3 py-2 text-sm text-muted-foreground"
                                                            />
                                                            <p className="text-xs text-muted-foreground">
                                                                This path is visible for reference, but uploaded video files cannot be changed after creation.
                                                            </p>
                                                        </div>
                                                        {editForm.isFisheye && (
                                                            <div className="mt-4 space-y-3">
                                                                <div className="flex items-center justify-between">
                                                                    <Label>Select View</Label>
                                                                    <span className="text-xs text-muted-foreground">
                                                                        Preview updates immediately for the chosen fisheye view.
                                                                    </span>
                                                                </div>
                                                                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                                                    {FISHEYE_VIEW_OPTIONS.map(({ index, label }) => (
                                                                        <label
                                                                            key={`edit-view-${index}`}
                                                                            className={cn(
                                                                                'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs',
                                                                                editForm.selectedView === index && 'border-primary bg-primary/5',
                                                                            )}
                                                                        >
                                                                            <Checkbox
                                                                                checked={editForm.selectedView === index}
                                                                                onCheckedChange={() => handleEditViewSelection(index)}
                                                                            />
                                                                            <span>{label}</span>
                                                                        </label>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        )}
                                                        <div className="mt-4 space-y-3">
                                                            <div className="flex items-center justify-between">
                                                                <Label>Detection ROI</Label>
                                                                <div className="flex gap-2">
                                                                    <Button
                                                                        type="button"
                                                                        variant={isDrawingEditRoi ? 'default' : 'outline'}
                                                                        size="sm"
                                                                        onClick={() => setIsDrawingEditRoi((prev) => !prev)}
                                                                        disabled={loadingEditPreview || !editPreviewImage}
                                                                    >
                                                                        {isDrawingEditRoi ? 'Stop Drawing' : 'Draw ROI'}
                                                                    </Button>
                                                                    <Button
                                                                        type="button"
                                                                        variant="outline"
                                                                        size="sm"
                                                                        onClick={handleClearEditRoi}
                                                                        disabled={!editForm.detectionRoi}
                                                                    >
                                                                        Clear ROI
                                                                    </Button>
                                                                </div>
                                                            </div>
                                                            <div ref={previewContainerRef} className="relative aspect-video overflow-hidden rounded-md bg-black">
                                                                {editPreviewImage ? (
                                                                    <img
                                                                        src={editPreviewImage}
                                                                        alt={`${activeDisplayName} edit preview`}
                                                                        className="h-full w-full object-contain"
                                                                    />
                                                                ) : (
                                                                    <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
                                                                        {loadingEditPreview ? 'Loading preview...' : 'Preview unavailable for ROI editing.'}
                                                                    </div>
                                                                )}
                                                                {editPreviewImage && (
                                                                    <RoiEditorCanvas
                                                                        roi={editForm.detectionRoi}
                                                                        drawingEnabled={isDrawingEditRoi}
                                                                        onChange={(nextRoi) => {
                                                                            setEditForm((current) => ({
                                                                                ...current,
                                                                                detectionRoi: nextRoi,
                                                                            }));
                                                                            setIsDrawingEditRoi(false);
                                                                        }}
                                                                        containerRef={previewContainerRef}
                                                                        mediaWidth={editPreviewSize.width}
                                                                        mediaHeight={editPreviewSize.height}
                                                                        label="Detection ROI"
                                                                    />
                                                                )}
                                                            </div>
                                                            <p className="text-xs text-muted-foreground">
                                                                ROI changes are allowed here and will apply to this video source. If ROI is never set, the whole image is used for detection. Clear ROI to use the full frame again.
                                                            </p>
                                                        </div>
                                                        <div className="mt-4 flex justify-end gap-2">
                                                            <Button
                                                                type="button"
                                                                variant="ghost"
                                                                onClick={handleCancelEdit}
                                                                disabled={isSavingEdit}
                                                            >
                                                                Cancel
                                                            </Button>
                                                            <Button
                                                                type="button"
                                                                onClick={handleSaveEdit}
                                                                disabled={isSavingEdit}
                                                            >
                                                                {isSavingEdit ? (
                                                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                                                ) : (
                                                                    <Save className="mr-2 h-4 w-4" />
                                                                )}
                                                                Save Changes
                                                            </Button>
                                                        </div>
                                                    </div>
                                                )}

                                                {!isEditingSource && (
                                                    <>
                                                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                                                        <div className="rounded-lg border p-3">
                                                            <div className="text-xs uppercase tracking-wide text-muted-foreground">Source Path</div>
                                                            <div className="mt-1 break-all text-sm">{activeItem.source_path}</div>
                                                        </div>
                                                        <div className="rounded-lg border p-3">
                                                            <div className="text-xs uppercase tracking-wide text-muted-foreground">Video Details</div>
                                                            <div className="mt-2 grid gap-2 text-sm">
                                                                <div className="flex items-center justify-between gap-3">
                                                                    <span className="text-muted-foreground">Duration</span>
                                                                    <span className="font-medium">{formatVideoDuration(activeItem.video_duration_seconds)}</span>
                                                                </div>
                                                                <div className="flex items-center justify-between gap-3">
                                                                    <span className="text-muted-foreground">Resolution</span>
                                                                    <span className="font-medium">{activeItem.video_resolution || 'Unknown'}</span>
                                                                </div>
                                                                <div className="flex items-center justify-between gap-3">
                                                                    <span className="text-muted-foreground">FPS</span>
                                                                    <span className="font-medium">{formatVideoFps(activeItem.video_fps)}</span>
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <div className="rounded-lg border p-3">
                                                        <div className="text-xs uppercase tracking-wide text-muted-foreground">Views</div>
                                                        <div className="mt-1 text-sm">
                                                            {activeItem.selected_views?.length
                                                                ? activeItem.selected_views.map((viewIndex) => getFisheyeViewLabel(viewIndex)).join(', ')
                                                                : 'Original'}
                                                            </div>
                                                        </div>
                                                        <div className="rounded-lg border p-3">
                                                            <div className="text-xs uppercase tracking-wide text-muted-foreground">Start Time</div>
                                                            <div className="mt-1 text-sm font-medium">
                                                                {formatVideoDateTime(activeItem.uploaded_video_start_time || activeItem.uploaded_video_start_time_override)}
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
                                                )}
                                            </>
                                        ) : (
                                            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                                                Select an video source to inspect it here.
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
