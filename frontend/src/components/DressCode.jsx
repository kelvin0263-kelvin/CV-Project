import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    AlertTriangle,
    Camera,
    Check,
    Eye,
    RefreshCw,
    Save,
    ShieldCheck,
    SlidersHorizontal,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import StreamPlayer from './StreamPlayer';
import { getApiBaseUrl, getAuthHeaders, getWSUrl } from '../apiConfig';
import { cn } from '../lib/utils';

const LABEL_OPTIONS = [
    {
        id: 'shorts',
        name: 'Shorts',
        description: 'Flags shorts, bermudas, and similar lower-body clothing.',
        classifier: 'pants',
    },
    {
        id: 'long_pants',
        name: 'Long Pants',
        description: 'Flags trousers, jeans, and other full-length pants.',
        classifier: 'pants',
    },
    {
        id: 'slipper',
        name: 'Slipper',
        description: 'Flags open footwear predicted as slippers.',
        classifier: 'slipper',
    },
    {
        id: 'non_slipper',
        name: 'Non-Slipper',
        description: 'Flags footwear predicted as non-slipper.',
        classifier: 'slipper',
    },
];

const labelOptionMap = Object.fromEntries(LABEL_OPTIONS.map((item) => [item.id, item]));
const CATEGORY_GROUPS = [
    {
        id: 'pants',
        title: 'Lower Body',
        description: '',
        items: ['shorts', 'long_pants'],
        accent: 'red',
        badge: 'Pants',
    },
    {
        id: 'slipper',
        title: 'Footwear',
        description: '',
        items: ['slipper', 'non_slipper'],
        accent: 'amber',
        badge: 'Footwear',
    },
];

const isRealtimeStreamSource = (camera) =>
    camera?.source_kind === 'rtsp'
    || camera?.source_kind === 'network'
    || (camera?.is_uploaded && camera?.producer_running);

const getCameraSourceLabel = (camera) => {
    if (!camera) {
        return 'Unknown source';
    }
    if (camera.is_uploaded && camera.producer_running) {
        return 'Uploaded video (playing)';
    }
    if (camera.is_uploaded) {
        return 'Uploaded video';
    }
    if (camera.source_kind === 'network') {
        return 'Network camera';
    }
    if (camera.source_kind === 'rtsp') {
        return 'RTSP stream';
    }
    if (camera.source_kind) {
        return String(camera.source_kind).replace(/_/g, ' ');
    }
    return camera.type || 'Camera feed';
};

const getDisplayLabel = (label) => labelOptionMap[label]?.name || String(label || 'Unknown').replace(/_/g, ' ');

const normalizeConfidencePercent = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return null;
    }
    return Math.round(numeric * 100);
};

const getPolicyThresholdPercent = (policy, key, fallback = 0.8) => {
    const directValue = normalizeConfidencePercent(policy?.[key]);
    if (directValue != null) {
        return directValue;
    }

    const sharedValue = normalizeConfidencePercent(policy?.confidence_threshold);
    if (sharedValue != null) {
        return sharedValue;
    }

    return Math.round(fallback * 100);
};

const buildDetectionItems = (detections) => {
    const items = [];

    (Array.isArray(detections) ? detections : []).forEach((det) => {
        const classifications = Array.isArray(det?.classifications) && det.classifications.length
            ? det.classifications
            : (
                det?.label != null && det?.confidence != null
                    ? [{ label: det.label, confidence: det.confidence, region: 'lower_body' }]
                    : []
            );

        classifications.forEach((classification, index) => {
            items.push({
                key: `${det?.track_id ?? 'track'}-${classification?.region ?? 'region'}-${classification?.label ?? 'label'}-${index}`,
                trackId: det?.track_id,
                label: classification?.label,
                region: classification?.region || 'person',
                confidence: classification?.confidence,
                violation: Boolean(det?.violation) && classification?.label === det?.label,
            });
        });
    });

    return items.sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0));
};

const ToggleRow = ({ title, description, enabled, onToggle, accent = 'blue', disabled = false, badge = null }) => {
    const accentClasses = {
        blue: enabled ? 'border-blue-400/60 bg-blue-50' : 'border-slate-200 bg-white',
        emerald: enabled ? 'border-emerald-400/60 bg-emerald-50' : 'border-slate-200 bg-white',
        slate: enabled ? 'border-slate-400/60 bg-slate-100' : 'border-slate-200 bg-white',
    };
    const trackClasses = {
        blue: enabled ? 'bg-blue-600' : 'bg-slate-200',
        emerald: enabled ? 'bg-emerald-600' : 'bg-slate-200',
        slate: enabled ? 'bg-slate-700' : 'bg-slate-200',
    };

    return (
        <button
            type="button"
            onClick={onToggle}
            disabled={disabled}
            className={cn(
                'flex w-full items-center justify-between rounded-2xl border p-4 text-left transition-all hover:border-blue-300 hover:shadow-sm',
                accentClasses[accent] || accentClasses.blue,
                disabled && 'cursor-not-allowed opacity-50 hover:border-slate-200 hover:shadow-none',
            )}
        >
            <div className="space-y-1 pr-4">
                {badge && (
                    <div className="inline-flex rounded-full bg-white/80 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        {badge}
                    </div>
                )}
                <p className="text-sm font-semibold text-slate-900">{title}</p>
                <p className="text-xs leading-relaxed text-slate-500">{description}</p>
            </div>
            <div className={cn('relative h-7 w-14 rounded-full transition-colors', trackClasses[accent] || trackClasses.blue)}>
                <div
                    className={cn(
                        'absolute top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-all',
                        enabled ? 'left-8' : 'left-1',
                    )}
                />
            </div>
        </button>
    );
};

const ThresholdSlider = ({ title, description, value, onChange, accent = 'blue', disabled = false }) => {
    const accentStyles = {
        blue: {
            badge: 'bg-blue-100 text-blue-700',
            slider: 'accent-blue-600',
        },
        emerald: {
            badge: 'bg-emerald-100 text-emerald-700',
            slider: 'accent-emerald-600',
        },
    };

    const styles = accentStyles[accent] || accentStyles.blue;

    return (
        <div className={cn('rounded-3xl border border-slate-200 bg-slate-50/70 p-4', disabled && 'opacity-50')}>
            <div className="flex items-center justify-between gap-4">
                <div className="pr-3">
                    <div className="flex items-center gap-2">
                        <div className={cn('rounded-full px-2.5 py-1 text-[11px] font-semibold', styles.badge)}>
                            <SlidersHorizontal className="mr-1 inline h-3.5 w-3.5" />
                            {title}
                        </div>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-slate-500">{description}</p>
                </div>
                <div className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-slate-900 shadow-sm">
                    {value}%
                </div>
            </div>
            <input
                type="range"
                min="50"
                max="100"
                step="1"
                value={value}
                onChange={(event) => onChange(Number(event.target.value))}
                disabled={disabled}
                className={cn(
                    'mt-4 h-2 w-full cursor-pointer appearance-none rounded-full bg-slate-200',
                    styles.slider,
                    disabled && 'cursor-not-allowed',
                )}
            />
        </div>
    );
};

const RestrictedCategoryCard = ({
    title,
    description,
    badge,
    accent = 'red',
    disabled = false,
    items,
    restrictedLabels,
    onToggle,
}) => {
    const accentStyles = {
        red: {
            badge: 'bg-red-100 text-red-700',
            activeCard: 'border-red-300 bg-red-50',
            activeIcon: 'bg-red-500 text-white',
            activeState: 'text-red-600',
        },
        amber: {
            badge: 'bg-amber-100 text-amber-700',
            activeCard: 'border-amber-300 bg-amber-50',
            activeIcon: 'bg-amber-500 text-white',
            activeState: 'text-amber-700',
        },
    };
    const styles = accentStyles[accent] || accentStyles.red;

    return (
        <div className={cn('rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm', disabled && 'opacity-50')}>
            <div className="flex items-start justify-between gap-3">
                <div>
                    <div className={cn('inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]', styles.badge)}>
                        {badge}
                    </div>
                    <h3 className="mt-3 text-lg font-semibold text-slate-950">{title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-slate-500">{description}</p>
                </div>
                <div className={cn(
                    'rounded-full px-3 py-1 text-xs font-medium',
                    disabled ? 'bg-slate-100 text-slate-500' : 'bg-emerald-50 text-emerald-700',
                )}>
                    {disabled ? 'Classifier off' : 'Ready'}
                </div>
            </div>

            <div className="mt-4 grid gap-3">
                {items.map((item) => {
                    const option = labelOptionMap[item];
                    const isRestricted = restrictedLabels.includes(item);
                    return (
                        <button
                            key={item}
                            type="button"
                            disabled={disabled}
                            onClick={() => onToggle(item)}
                            className={cn(
                                'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 rounded-2xl border p-4 text-left transition-all',
                                isRestricted ? styles.activeCard : 'border-slate-200 bg-slate-50 hover:border-slate-300',
                                disabled && 'cursor-not-allowed',
                            )}
                        >
                            <div className={cn(
                                'flex h-11 w-11 items-center justify-center rounded-2xl',
                                isRestricted ? styles.activeIcon : 'bg-white text-slate-500',
                            )}>
                                <ShieldCheck className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-base font-semibold text-slate-900">{option?.name}</span>
                                    <span className={cn(
                                        'rounded-full px-2.5 py-1 text-[11px] font-semibold',
                                        isRestricted ? 'bg-white/80 text-slate-700' : 'bg-white text-slate-500',
                                    )}>
                                        {isRestricted ? 'Restricted' : 'Allowed'}
                                    </span>
                                </div>
                                <p className="mt-1 text-sm text-slate-500">{option?.description}</p>
                            </div>
                            <div className={cn('relative h-7 w-14 rounded-full transition-colors', isRestricted ? 'bg-red-500' : 'bg-slate-200')}>
                                <div
                                    className={cn(
                                        'absolute top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-all',
                                        isRestricted ? 'left-8' : 'left-1',
                                    )}
                                />
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
};

const DressCode = () => {
    const apiUrl = getApiBaseUrl();

    const [cameras, setCameras] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [saveMessage, setSaveMessage] = useState('');

    const [enabledCameraIds, setEnabledCameraIds] = useState([]);
    const [pantsConfidence, setPantsConfidence] = useState(80);
    const [slipperConfidence, setSlipperConfidence] = useState(80);
    const [restrictedLabels, setRestrictedLabels] = useState([]);
    const [policyEnabled, setPolicyEnabled] = useState(true);
    const [enablePantsDetection, setEnablePantsDetection] = useState(true);
    const [enableSlipperDetection, setEnableSlipperDetection] = useState(false);
    const [selectedCameraId, setSelectedCameraId] = useState('');

    const [previewStats, setPreviewStats] = useState({ fps: 0, people_count: 0 });
    const [previewDetections, setPreviewDetections] = useState([]);
    const [runtimePreviewImage, setRuntimePreviewImage] = useState('');
    const [loadingRuntimePreview, setLoadingRuntimePreview] = useState(false);

    const loadPage = useCallback(async ({ silent = false } = {}) => {
        if (silent) {
            setRefreshing(true);
        } else {
            setLoading(true);
        }

        try {
            const [camerasResponse, policyResponse] = await Promise.all([
                fetch(`${apiUrl}/api/cameras`),
                fetch(`${apiUrl}/api/dresscode-policy`, { headers: getAuthHeaders() }),
            ]);

            if (!camerasResponse.ok) {
                throw new Error('Failed to load camera list.');
            }
            if (!policyResponse.ok) {
                throw new Error('Failed to load dress code policy.');
            }

            const camerasData = await camerasResponse.json().catch(() => []);
            const policyData = await policyResponse.json().catch(() => ({}));
            const enabledCameras = Array.isArray(camerasData)
                ? camerasData.filter((camera) => camera.enabled)
                : [];

            setCameras(enabledCameras);
            setEnabledCameraIds(Array.isArray(policyData.enabled_camera_ids) ? policyData.enabled_camera_ids : []);
            setPantsConfidence(getPolicyThresholdPercent(policyData, 'pants_confidence_threshold'));
            setSlipperConfidence(getPolicyThresholdPercent(policyData, 'slipper_confidence_threshold'));
            setRestrictedLabels(Array.isArray(policyData.restricted_labels) ? policyData.restricted_labels : []);
            setPolicyEnabled(policyData.enabled !== false);
            setEnablePantsDetection(policyData.enable_pants_detection !== false);
            setEnableSlipperDetection(Boolean(policyData.enable_slipper_detection));
            setSaveMessage('');

            setSelectedCameraId((current) => {
                if (current && enabledCameras.some((camera) => camera.id === current)) {
                    return current;
                }

                const firstMonitored = (policyData.enabled_camera_ids || []).find((id) =>
                    enabledCameras.some((camera) => camera.id === id),
                );

                return firstMonitored || enabledCameras[0]?.id || '';
            });
        } catch (error) {
            console.error('Failed to load dress code page:', error);
            setSaveMessage(error.message || 'Failed to load page data.');
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [apiUrl]);

    useEffect(() => {
        void loadPage();
    }, [loadPage]);

    useEffect(() => {
        setPreviewStats({ fps: 0, people_count: 0 });
        setPreviewDetections([]);
        setRuntimePreviewImage('');
    }, [selectedCameraId]);

    const selectedCamera = useMemo(
        () => cameras.find((camera) => camera.id === selectedCameraId) || null,
        [cameras, selectedCameraId],
    );
    const quickSelectorCameras = useMemo(
        () => [...cameras].sort((left, right) => {
            const leftMonitored = enabledCameraIds.includes(left.id) ? 0 : 1;
            const rightMonitored = enabledCameraIds.includes(right.id) ? 0 : 1;
            if (leftMonitored !== rightMonitored) {
                return leftMonitored - rightMonitored;
            }
            return String(left?.name || '').localeCompare(String(right?.name || ''), undefined, {
                numeric: true,
                sensitivity: 'base',
            });
        }),
        [cameras, enabledCameraIds],
    );

    const previewStreamUrl = selectedCameraId ? getWSUrl(`/ws/${selectedCameraId}`) : null;
    const showStoppedUploadPreview = Boolean(
        selectedCamera?.is_uploaded && !selectedCamera?.producer_running && selectedCamera?.runtime_key,
    );

    useEffect(() => {
        let cancelled = false;

        const loadRuntimePreview = async () => {
            if (!showStoppedUploadPreview || !selectedCamera?.runtime_key) {
                setRuntimePreviewImage('');
                setLoadingRuntimePreview(false);
                return;
            }

            setLoadingRuntimePreview(true);
            try {
                const response = await fetch(`${apiUrl}/api/upload-videos/preview`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ runtime_key: selectedCamera.runtime_key }),
                });
                const data = await response.json().catch(() => ({}));
                if (cancelled) {
                    return;
                }
                if (!response.ok || !data.preview_image) {
                    throw new Error(data.detail || 'Preview unavailable.');
                }

                setRuntimePreviewImage(`data:image/jpeg;base64,${data.preview_image}`);
            } catch (error) {
                if (!cancelled) {
                    console.error('Failed to load dress code preview:', error);
                    setRuntimePreviewImage('');
                }
            } finally {
                if (!cancelled) {
                    setLoadingRuntimePreview(false);
                }
            }
        };

        void loadRuntimePreview();
        return () => {
            cancelled = true;
        };
    }, [apiUrl, selectedCamera, showStoppedUploadPreview]);

    const previewDetectionItems = useMemo(() => buildDetectionItems(previewDetections), [previewDetections]);
    const previewViolations = useMemo(
        () => (Array.isArray(previewDetections) ? previewDetections.filter((item) => item?.violation).length : 0),
        [previewDetections],
    );
    const monitoredCount = enabledCameraIds.length;
    const policyControlsDisabled = !policyEnabled;
    const pantsControlsDisabled = !policyEnabled || !enablePantsDetection;
    const slipperControlsDisabled = !policyEnabled || !enableSlipperDetection;

    const toggleCameraMonitoring = (cameraId) => {
        setEnabledCameraIds((prev) => (
            prev.includes(cameraId)
                ? prev.filter((id) => id !== cameraId)
                : [...prev, cameraId]
        ));
        setSaved(false);
    };

    const toggleRestrictedLabel = (labelId) => {
        setRestrictedLabels((prev) => (
            prev.includes(labelId)
                ? prev.filter((label) => label !== labelId)
                : [...prev, labelId]
        ));
        setSaved(false);
    };

    const handleSave = async () => {
        setSaving(true);
        setSaved(false);
        setSaveMessage('');

        try {
            const response = await fetch(`${apiUrl}/api/dresscode-policy`, {
                method: 'PUT',
                headers: getAuthHeaders(),
                body: JSON.stringify({
                    enabled_camera_ids: enabledCameraIds,
                    restricted_labels: restrictedLabels,
                    confidence_threshold: pantsConfidence / 100,
                    pants_confidence_threshold: pantsConfidence / 100,
                    slipper_confidence_threshold: slipperConfidence / 100,
                    enabled: policyEnabled,
                    enable_pants_detection: enablePantsDetection,
                    enable_slipper_detection: enableSlipperDetection,
                }),
            });

            const updatedPolicy = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(updatedPolicy.detail || 'Failed to save policy.');
            }

            setEnabledCameraIds(Array.isArray(updatedPolicy.enabled_camera_ids) ? updatedPolicy.enabled_camera_ids : enabledCameraIds);
            setRestrictedLabels(Array.isArray(updatedPolicy.restricted_labels) ? updatedPolicy.restricted_labels : restrictedLabels);
            setPantsConfidence(getPolicyThresholdPercent(updatedPolicy, 'pants_confidence_threshold', pantsConfidence / 100));
            setSlipperConfidence(getPolicyThresholdPercent(updatedPolicy, 'slipper_confidence_threshold', slipperConfidence / 100));
            setPolicyEnabled(updatedPolicy.enabled !== false);
            setEnablePantsDetection(updatedPolicy.enable_pants_detection !== false);
            setEnableSlipperDetection(Boolean(updatedPolicy.enable_slipper_detection));
            setSaved(true);
            setSaveMessage('Dress code policy saved successfully.');
            window.setTimeout(() => setSaved(false), 3000);
        } catch (error) {
            console.error('Failed to save dress code policy:', error);
            setSaveMessage(error.message || 'Failed to save dress code policy.');
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center">
                <RefreshCw className="h-6 w-6 animate-spin text-slate-400" />
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col gap-6 overflow-auto bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.08),_transparent_32%),linear-gradient(180deg,_rgba(248,250,252,0.95),_rgba(255,255,255,1))] p-6">
            <section className="relative overflow-hidden rounded-[28px] border border-slate-200/80 bg-white/90 p-6 shadow-sm backdrop-blur">
                <div className="absolute inset-y-0 right-0 hidden w-72 bg-[radial-gradient(circle_at_center,_rgba(59,130,246,0.12),_transparent_60%)] lg:block" />
                <div className="relative flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <h1 className="text-3xl font-bold tracking-tight text-slate-950">Dress Code Policy</h1>
                           
                        </div>
                    </div>

                    <div className="flex flex-col items-start gap-3 xl:items-end">
                        <div className="flex flex-wrap gap-3">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => void loadPage({ silent: true })}
                                disabled={refreshing}
                                className="border-slate-200 bg-white text-slate-700"
                            >
                                <RefreshCw className={cn('mr-2 h-4 w-4', refreshing && 'animate-spin')} />
                                Refresh
                            </Button>
                            <Button type="button" onClick={handleSave} disabled={saving} className="bg-blue-600 text-white hover:bg-blue-700">
                                <Save className="mr-2 h-4 w-4" />
                                {saving ? 'Saving...' : 'Save Policy'}
                            </Button>
                        </div>
                        <div className="min-h-[20px] text-sm">
                            {saved ? (
                                <span className="inline-flex items-center gap-2 font-medium text-emerald-600">
                                    <Check className="h-4 w-4" />
                                    Policy saved
                                </span>
                            ) : saveMessage ? (
                                <span className={cn(saveMessage.toLowerCase().includes('failed') ? 'text-red-600' : 'text-slate-500')}>
                                    {saveMessage}
                                </span>
                            ) : null}
                        </div>
                    </div>
                </div>
            </section>

            <div className="grid gap-6 xl:grid-cols-[minmax(360px,0.85fr)_minmax(0,1.15fr)]">
                <Card className="order-2 overflow-hidden border-slate-200/80 bg-white/95 shadow-sm xl:order-2">
                    <CardHeader className="border-b border-slate-100 bg-[linear-gradient(180deg,_rgba(248,250,252,0.92),_rgba(255,255,255,0.98))]">
                        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                            <div className="space-y-2">
                                <div className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                                    <Eye className="h-3.5 w-3.5" />
                                    Selected Camera Preview
                                </div>
                                <div>
                                    <CardTitle className="text-2xl text-slate-950">
                                        {selectedCamera?.name || 'Select a camera'}
                                    </CardTitle>
                                    <CardDescription className="mt-1 max-w-xl leading-relaxed">
                                        {selectedCamera
                                            ? `${getCameraSourceLabel(selectedCamera)}${selectedCamera?.location ? ` - ${selectedCamera.location}` : ''}`
                                            : 'Choose a monitored camera below to preview its stream and current dress code results.'}
                                    </CardDescription>
                                </div>
                            </div>

                            {selectedCamera && (
                                <div className="flex flex-wrap gap-2">
                                    <span className={cn(
                                        'rounded-full px-3 py-1 text-xs font-medium',
                                        enabledCameraIds.includes(selectedCamera.id)
                                            ? 'bg-emerald-50 text-emerald-700'
                                            : 'bg-slate-100 text-slate-600',
                                    )}>
                                        {enabledCameraIds.includes(selectedCamera.id) ? 'Monitored' : 'Preview only'}
                                    </span>
                                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                                        {isRealtimeStreamSource(selectedCamera) ? 'Live stream' : 'Still preview'}
                                    </span>
                                </div>
                            )}
                        </div>
                    </CardHeader>

                    <CardContent className="space-y-5 p-5">
                        {quickSelectorCameras.length > 0 && (
                            <div className="space-y-3 rounded-3xl border border-slate-200 bg-slate-50/70 p-4">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Quick Preview Selector</p>
                                        <p className="mt-1 text-sm text-slate-500">
                                            Switch preview cameras here without scrolling to the coverage section.
                                        </p>
                                    </div>
                                    <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600 shadow-sm">
                                        {quickSelectorCameras.length} camera{quickSelectorCameras.length === 1 ? '' : 's'}
                                    </span>
                                </div>

                                <div className="flex gap-2 overflow-x-auto pb-1">
                                    {quickSelectorCameras.map((camera) => {
                                        const isActive = camera.id === selectedCameraId;
                                        const isMonitored = enabledCameraIds.includes(camera.id);
                                        return (
                                            <button
                                                key={camera.id}
                                                type="button"
                                                onClick={() => setSelectedCameraId(camera.id)}
                                                className={cn(
                                                    'shrink-0 rounded-2xl border px-4 py-3 text-left transition-all',
                                                    isActive
                                                        ? 'border-blue-400 bg-blue-50 shadow-sm'
                                                        : 'border-slate-200 bg-white hover:border-blue-200 hover:bg-slate-50',
                                                )}
                                            >
                                                <div className="flex items-center gap-2">
                                                    <span className={cn(
                                                        'h-2.5 w-2.5 rounded-full',
                                                        isMonitored ? 'bg-emerald-500' : 'bg-slate-300',
                                                    )}
                                                    />
                                                    <span className="max-w-[160px] truncate text-sm font-semibold text-slate-900">
                                                        {camera.name}
                                                    </span>
                                                </div>
                                                <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                                                    <span>{isMonitored ? 'Monitored' : 'Preview only'}</span>
                                                    <span>•</span>
                                                    <span>{camera.is_uploaded && !camera.producer_running ? 'Still preview' : 'Live preview'}</span>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {selectedCamera ? (
                            <>
                                <div className="relative overflow-hidden rounded-[24px] border border-slate-200 bg-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
                                    <div className="absolute left-4 top-4 z-10 flex items-center gap-2 rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white backdrop-blur">
                                        <span className={cn(
                                            'h-2.5 w-2.5 rounded-full',
                                            isRealtimeStreamSource(selectedCamera) ? 'bg-emerald-400' : 'bg-amber-300',
                                        )}
                                        />
                                        {selectedCamera.name}
                                    </div>

                                    <div className="absolute right-4 top-4 z-10 flex gap-2">
                                        <div className="rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white backdrop-blur">
                                            {previewStats.fps > 0 ? `${previewStats.fps} FPS` : 'Waiting'}
                                        </div>
                                        <div className="rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white backdrop-blur">
                                            {previewStats.people_count || 0} people
                                        </div>
                                    </div>

                                    <div className="aspect-video w-full">
                                        {isRealtimeStreamSource(selectedCamera) ? (
                                            <StreamPlayer
                                                wsUrl={previewStreamUrl}
                                                className="h-full w-full"
                                                alt={selectedCamera.name}
                                                overlayMode="dress-code"
                                                onStats={setPreviewStats}
                                                onDetections={setPreviewDetections}
                                            />
                                        ) : runtimePreviewImage ? (
                                            <img
                                                src={runtimePreviewImage}
                                                alt={selectedCamera.name}
                                                className="h-full w-full object-contain"
                                            />
                                        ) : (
                                            <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_center,_rgba(148,163,184,0.18),_transparent_55%),linear-gradient(180deg,_rgba(15,23,42,0.98),_rgba(2,6,23,1))] p-8 text-center text-slate-300">
                                                <div className="space-y-3">
                                                    <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10">
                                                        {loadingRuntimePreview ? (
                                                            <RefreshCw className="h-6 w-6 animate-spin" />
                                                        ) : (
                                                            <Camera className="h-6 w-6" />
                                                        )}
                                                    </div>
                                                    <div className="space-y-1">
                                                        <p className="text-sm font-semibold text-white">
                                                            {selectedCamera.is_uploaded ? 'Uploaded preview unavailable' : 'Stream preview unavailable'}
                                                        </p>
                                                        <p className="max-w-sm text-sm text-slate-400">
                                                            {selectedCamera.is_uploaded
                                                                ? 'This uploaded video is not currently playing. A preview image will appear here when available.'
                                                                : 'The selected camera feed is offline or still connecting.'}
                                                        </p>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
                                    <div className="rounded-3xl border border-slate-200 bg-slate-50/70 p-4">
                                        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Preview Summary</p>
                                        <div className="mt-4 grid grid-cols-2 gap-3">
                                            <div className="rounded-2xl bg-white p-4 shadow-sm">
                                                <p className="text-xs text-slate-500">Visible people</p>
                                                <p className="mt-2 text-2xl font-semibold text-slate-900">{previewStats.people_count || 0}</p>
                                            </div>
                                            <div className="rounded-2xl bg-white p-4 shadow-sm">
                                                <p className="text-xs text-slate-500">Violations now</p>
                                                <p className="mt-2 text-2xl font-semibold text-red-600">{previewViolations}</p>
                                            </div>
                                            <div className="rounded-2xl bg-white p-4 shadow-sm">
                                                <p className="text-xs text-slate-500">Pants classifier</p>
                                                <p className="mt-2 text-sm font-semibold text-slate-900">
                                                    {enablePantsDetection ? 'Enabled' : 'Disabled'}
                                                </p>
                                            </div>
                                            <div className="rounded-2xl bg-white p-4 shadow-sm">
                                                <p className="text-xs text-slate-500">Slipper classifier</p>
                                                <p className="mt-2 text-sm font-semibold text-slate-900">
                                                    {enableSlipperDetection ? 'Enabled' : 'Disabled'}
                                                </p>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="rounded-3xl border border-slate-200 bg-white p-4">
                                        <div className="flex items-center justify-between gap-3">
                                            <div>
                                                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Current Frame Labels</p>
                                                <p className="mt-1 text-sm text-slate-500">
                                                    Live classifications reported by the selected camera feed.
                                                </p>
                                            </div>
                                            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                                                {previewDetectionItems.length} label{previewDetectionItems.length === 1 ? '' : 's'}
                                            </span>
                                        </div>

                                        <div className="mt-4 flex max-h-40 flex-wrap gap-2 overflow-auto pr-1">
                                            {previewDetectionItems.length > 0 ? previewDetectionItems.map((item) => {
                                                const confidencePercent = normalizeConfidencePercent(item.confidence);
                                                return (
                                                    <div
                                                        key={item.key}
                                                        className={cn(
                                                            'rounded-2xl border px-3 py-2 text-sm shadow-sm',
                                                            item.violation
                                                                ? 'border-red-200 bg-red-50 text-red-700'
                                                                : 'border-slate-200 bg-slate-50 text-slate-700',
                                                        )}
                                                    >
                                                        <div className="flex items-center gap-2 font-semibold">
                                                            <span>{getDisplayLabel(item.label)}</span>
                                                            {item.trackId != null && (
                                                                <span className="rounded-full bg-white/80 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                                                                    ID {item.trackId}
                                                                </span>
                                                            )}
                                                        </div>
                                                        <div className="mt-1 text-xs text-slate-500">
                                                            {item.region === 'footwear' ? 'Footwear' : 'Lower body'}
                                                            {confidencePercent != null ? ` - ${confidencePercent}%` : ''}
                                                        </div>
                                                    </div>
                                                );
                                            }) : (
                                                <div className="flex min-h-24 w-full items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500">
                                                    No live dress code labels yet for this preview.
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </>
                        ) : (
                            <div className="flex min-h-[420px] items-center justify-center rounded-[24px] border border-dashed border-slate-200 bg-slate-50 text-center">
                                <div className="space-y-3 px-6">
                                    <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
                                        <Camera className="h-6 w-6" />
                                    </div>
                                    <div>
                                        <p className="text-lg font-semibold text-slate-900">No camera selected</p>
                                        <p className="mt-1 max-w-md text-sm text-slate-500">
                                            Pick a camera from the coverage panel below to preview its stream and adjust which feeds are monitored.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}
                    </CardContent>
                </Card>

                <div className="order-1 grid gap-6 xl:order-1">
                    <Card className="border-slate-200/80 bg-white/95 shadow-sm">
                        <CardHeader className="space-y-4">
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <CardTitle className="text-2xl">Dress Code Control</CardTitle>
                                    {/* <CardDescription className="mt-1 max-w-xl">
                                        Keep this master switch obvious. When it is off, the detection settings and restricted categories below become read-only and visually muted.
                                    </CardDescription> */}
                                </div>
                                <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                                    {monitoredCount} monitored camera{monitoredCount === 1 ? '' : 's'}
                                </div>
                            </div>

                            <ToggleRow
                                title="Enable Dress Code Detection"
                                description="The main policy switch. Turn this off to pause all dress code classification and rule enforcement."
                                enabled={policyEnabled}
                                onToggle={() => {
                                    setPolicyEnabled((current) => !current);
                                    setSaved(false);
                                }}
                                accent="blue"
                                badge="Master Switch"
                            />

                            {!policyEnabled && (
                                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                                    <div className="flex items-start gap-3">
                                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                                        <div>
                                            <p className="font-semibold">Dress code detection is currently off</p>
                                            <p className="mt-1 text-amber-700">
                                                All classifier settings and restricted-category controls are temporarily disabled until the master switch is turned back on.
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </CardHeader>
                    </Card>

                    <Card className="border-slate-200/80 bg-white/95 shadow-sm">
                        <CardHeader>
                            <CardTitle className="text-2xl">Detection Settings</CardTitle>
                            {/* <CardDescription>
                                Only show threshold controls when their matching classifier is enabled, so each setting feels directly connected to its effect.
                            </CardDescription> */}
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className={cn('space-y-4', policyControlsDisabled && 'pointer-events-none')}>
                                <ToggleRow
                                    title="Enable Pants Detection"
                                    description="Runs the shorts and long-pants classifier. Lower Body rules depend on this switch."
                                    enabled={enablePantsDetection}
                                    onToggle={() => {
                                        setEnablePantsDetection((current) => !current);
                                        setSaved(false);
                                    }}
                                    accent="emerald"
                                    disabled={policyControlsDisabled}
                                    badge="Lower Body"
                                />
                                {enablePantsDetection && (
                                    <ThresholdSlider
                                        title="Pants Threshold"
                                        description="Minimum confidence required before shorts or long pants results are used for restriction checks."
                                        value={pantsConfidence}
                                        onChange={(value) => {
                                            setPantsConfidence(value);
                                            setSaved(false);
                                        }}
                                        accent="blue"
                                        disabled={pantsControlsDisabled}
                                    />
                                )}

                                <ToggleRow
                                    title="Enable Slipper Detection"
                                    description="Runs the slipper classifier. Footwear rules depend on this switch."
                                    enabled={enableSlipperDetection}
                                    onToggle={() => {
                                        setEnableSlipperDetection((current) => !current);
                                        setSaved(false);
                                    }}
                                    accent="emerald"
                                    disabled={policyControlsDisabled}
                                    badge="Footwear"
                                />
                                {enableSlipperDetection && (
                                    <ThresholdSlider
                                        title="Slipper Threshold"
                                        description="Minimum confidence required before slipper or non-slipper results are used for restriction checks."
                                        value={slipperConfidence}
                                        onChange={(value) => {
                                            setSlipperConfidence(value);
                                            setSaved(false);
                                        }}
                                        accent="emerald"
                                        disabled={slipperControlsDisabled}
                                    />
                                )}
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="border-slate-200/80 bg-white/95 shadow-sm">
                        <CardHeader>
                            <CardTitle className="text-2xl">Restricted Categories</CardTitle>
                            {/* <CardDescription>
                                Keep policy rules grouped by classifier so Lower Body and Footwear are easier to scan and reason about.
                            </CardDescription> */}
                        </CardHeader>
                        <CardContent className="grid gap-4">
                            {CATEGORY_GROUPS.map((group) => {
                                const groupDisabled = group.id === 'pants' ? pantsControlsDisabled : slipperControlsDisabled;
                                return (
                                    <RestrictedCategoryCard
                                        key={group.id}
                                        title={group.title}
                                        description={group.description}
                                        badge={group.badge}
                                        accent={group.accent}
                                        disabled={groupDisabled}
                                        items={group.items}
                                        restrictedLabels={restrictedLabels}
                                        onToggle={(labelId) => {
                                            toggleRestrictedLabel(labelId);
                                        }}
                                    />
                                );
                            })}
                        </CardContent>
                    </Card>
                </div>
            </div>

            <Card className="border-slate-200/80 bg-white/95 shadow-sm">
                <CardHeader className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                    <div>
                        <CardTitle className="text-2xl">Camera Coverage</CardTitle>
                        <CardDescription className="mt-1 max-w-2xl">
                            Click a camera card to load it into the preview player. Use the switch on each card to decide whether dress code detection should run on that feed.
                        </CardDescription>
                    </div>
                    <div className="rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
                        {cameras.length} available camera{cameras.length === 1 ? '' : 's'}
                    </div>
                </CardHeader>
                <CardContent>
                    {cameras.length === 0 ? (
                        <div className="flex min-h-40 items-center justify-center rounded-3xl border border-dashed border-slate-200 bg-slate-50 text-center">
                            <div className="space-y-2 px-6">
                                <p className="text-lg font-semibold text-slate-900">No cameras available</p>
                                <p className="text-sm text-slate-500">Enable a camera or upload a video first, then come back here to configure dress code monitoring.</p>
                            </div>
                        </div>
                    ) : (
                        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                            {cameras.map((camera) => {
                                const isSelected = camera.id === selectedCameraId;
                                const isMonitored = enabledCameraIds.includes(camera.id);

                                return (
                                    <div
                                        key={camera.id}
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => setSelectedCameraId(camera.id)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter' || event.key === ' ') {
                                                event.preventDefault();
                                                setSelectedCameraId(camera.id);
                                            }
                                        }}
                                        className={cn(
                                            'group rounded-[26px] border p-4 text-left transition-all',
                                            isSelected
                                                ? 'border-blue-400 bg-blue-50 shadow-[0_18px_40px_-24px_rgba(37,99,235,0.45)]'
                                                : 'border-slate-200 bg-white hover:border-blue-200 hover:shadow-sm',
                                        )}
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <div className={cn(
                                                        'flex h-10 w-10 items-center justify-center rounded-2xl',
                                                        isSelected ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600',
                                                    )}>
                                                        <Camera className="h-4 w-4" />
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="truncate text-sm font-semibold text-slate-900">{camera.name}</p>
                                                        <p className="truncate text-xs text-slate-500">{getCameraSourceLabel(camera)}</p>
                                                    </div>
                                                </div>
                                            </div>

                                            <button
                                                type="button"
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    toggleCameraMonitoring(camera.id);
                                                }}
                                                className={cn(
                                                    'relative h-7 w-14 shrink-0 rounded-full transition-colors',
                                                    isMonitored ? 'bg-blue-600' : 'bg-slate-200',
                                                )}
                                                aria-label={isMonitored ? `Disable ${camera.name}` : `Enable ${camera.name}`}
                                            >
                                                <span
                                                    className={cn(
                                                        'absolute top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-all',
                                                        isMonitored ? 'left-8' : 'left-1',
                                                    )}
                                                />
                                            </button>
                                        </div>

                                        <div className="mt-4 flex flex-wrap gap-2">
                                            <span className={cn(
                                                'rounded-full px-3 py-1 text-xs font-medium',
                                                isSelected ? 'bg-white text-blue-700' : 'bg-slate-100 text-slate-600',
                                            )}>
                                                {isSelected ? 'Previewing' : 'Select to preview'}
                                            </span>
                                            <span className={cn(
                                                'rounded-full px-3 py-1 text-xs font-medium',
                                                isMonitored ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600',
                                            )}>
                                                {isMonitored ? 'Monitoring on' : 'Monitoring off'}
                                            </span>
                                        </div>

                                        {camera.location && (
                                            <p className="mt-3 text-xs text-slate-500">{camera.location}</p>
                                        )}
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
