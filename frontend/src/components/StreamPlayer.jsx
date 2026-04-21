import React, { useEffect, useRef, useState, useCallback } from 'react';

const STREAM_RENDER_INTERVAL_MS = 100;
const OVERLAY_FONT_FAMILY = '"Segoe UI", Inter, sans-serif';
const DEFAULT_STREAM_AUTO_RECONNECT_INTERVAL_MS = (() => {
    const rawMinutes = (
        typeof import.meta !== 'undefined'
        && import.meta.env
        && import.meta.env.VITE_STREAM_AUTO_RECONNECT_MINUTES
    )
        ? import.meta.env.VITE_STREAM_AUTO_RECONNECT_MINUTES
        : '60';
    const minutes = Number.parseFloat(rawMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
        return 60 * 60 * 1000;
    }
    return Math.round(minutes * 60 * 1000);
})();

const StreamPlayer = ({
    wsUrl,
    className,
    alt,
    onStats,
    onDetections,
    onCountingData,
    onMediaLayout,
    onStreamState,
    showCountingAnchors = false,
    hideOverlays = false,
    showDressCodeDetails = false,
    showFallAlerts = false,
    overlayMode = 'auto',
    autoReconnectIntervalMs = DEFAULT_STREAM_AUTO_RECONNECT_INTERVAL_MS,
}) => {
    const wrapperRef = useRef(null);
    const imgRef = useRef(null);
    const canvasRef = useRef(null);
    const wsRef = useRef(null);
    const reconnectTimerRef = useRef(null);
    const refreshInProgressRef = useRef(false);
    const onStatsRef = useRef(onStats);
    const onDetectionsRef = useRef(onDetections);
    const onCountingDataRef = useRef(onCountingData);
    const onMediaLayoutRef = useRef(onMediaLayout);
    const onStreamStateRef = useRef(onStreamState);
    const detectionsRef = useRef([]);
    const latestFrameBlobRef = useRef(null);
    const latestPayloadRef = useRef(null);
    const renderRafRef = useRef(null);
    const lastRenderedAtRef = useRef(0);
    const activeImageUrlRef = useRef(null);
    const statusRef = useRef('connecting');
    const [status, setStatus] = useState('connecting');
    const [connectionVersion, setConnectionVersion] = useState(0);

    const setStatusSafe = useCallback((nextStatus) => {
        if (statusRef.current === nextStatus) return;
        statusRef.current = nextStatus;
        setStatus(nextStatus);
    }, []);

    const clearAutoReconnectTimer = useCallback(() => {
        if (reconnectTimerRef.current === null) return;
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
    }, []);

    const requestStreamReconnect = useCallback(() => {
        clearAutoReconnectTimer();
        refreshInProgressRef.current = true;
        setStatusSafe('refreshing');
        setConnectionVersion((current) => current + 1);
    }, [clearAutoReconnectTimer, setStatusSafe]);

    const armAutoReconnectTimer = useCallback(() => {
        clearAutoReconnectTimer();
        const intervalMs = Number(autoReconnectIntervalMs);
        if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
            return;
        }
        reconnectTimerRef.current = window.setTimeout(() => {
            reconnectTimerRef.current = null;
            requestStreamReconnect();
        }, intervalMs);
    }, [autoReconnectIntervalMs, clearAutoReconnectTimer, requestStreamReconnect]);

    useEffect(() => {
        onStatsRef.current = onStats;
    }, [onStats]);

    useEffect(() => {
        onDetectionsRef.current = onDetections;
    }, [onDetections]);

    useEffect(() => {
        onCountingDataRef.current = onCountingData;
    }, [onCountingData]);

    useEffect(() => {
        onMediaLayoutRef.current = onMediaLayout;
    }, [onMediaLayout]);

    useEffect(() => {
        onStreamStateRef.current = onStreamState;
    }, [onStreamState]);


    // --- Compute actual image display area within object-contain ---
    const getImageDisplayArea = useCallback(() => {
        const img = imgRef.current;
        const wrapper = wrapperRef.current;
        if (!img || !wrapper) return null;
        const rect = wrapper.getBoundingClientRect();
        const containerW = rect.width;
        const containerH = rect.height;
        if (!containerW || !containerH) return null;
        const naturalWidth = Number(img.naturalWidth) > 0 ? Number(img.naturalWidth) : 640;
        const naturalHeight = Number(img.naturalHeight) > 0 ? Number(img.naturalHeight) : 360;
        const imgAspect = naturalWidth / naturalHeight;
        const containerAspect = containerW / containerH;

        let displayW, displayH, offsetX, offsetY;
        if (containerAspect > imgAspect) {
            // Container is wider - pillarboxing (black bars on sides)
            displayH = containerH;
            displayW = containerH * imgAspect;
            offsetX = (containerW - displayW) / 2;
            offsetY = 0;
        } else {
            // Container is taller - letterboxing (black bars top/bottom)
            displayW = containerW;
            displayH = containerW / imgAspect;
            offsetX = 0;
            offsetY = (containerH - displayH) / 2;
        }
        return {
            displayW,
            displayH,
            offsetX,
            offsetY,
            mediaWidth: naturalWidth,
            mediaHeight: naturalHeight,
            containerWidth: containerW,
            containerHeight: containerH,
        };
    }, []);

    const publishMediaLayout = useCallback(() => {
        if (!onMediaLayoutRef.current) return;
        const area = getImageDisplayArea();
        if (!area) return;
        onMediaLayoutRef.current(area);
    }, [getImageDisplayArea]);

    const revokeActiveImageUrl = useCallback(() => {
        if (!activeImageUrlRef.current) return;
        URL.revokeObjectURL(activeImageUrlRef.current);
        activeImageUrlRef.current = null;
    }, []);

    const clearImage = useCallback(() => {
        revokeActiveImageUrl();
        if (imgRef.current) {
            imgRef.current.removeAttribute('src');
        }
    }, [revokeActiveImageUrl]);

    const getOverlayVisual = useCallback((det) => {
        const normalizedMode = String(overlayMode || 'auto').toLowerCase();
        const isViolation = Boolean(det.violation);
        const isFallDetected = Boolean(det.fall_detected);
        const isFallPose = Boolean(det.fall_pose);
        const confidence = Math.round((det.confidence || 0) * 100);
        const shouldRenderFallAlerts = normalizedMode === 'fall' || showFallAlerts;
        const shouldRenderDressCodeDetails = (
            normalizedMode === 'dress-code'
            || normalizedMode === 'dresscode'
            || showDressCodeDetails
        );
        const clothingLabel = det.label
            ? `${det.label.replace(/_/g, ' ')} ${confidence}%`
            : 'Person';
        const classifications = Array.isArray(det.classifications) ? det.classifications : [];
        const lowerBodyClassification = classifications.find((item) => item?.region === 'lower_body');
        const footwearClassification = classifications.find((item) => item?.region === 'footwear');
        const hasDressCodeDetails = Boolean(
            lowerBodyClassification
            || footwearClassification
            || (det.label != null && det.confidence != null)
        );

        const formatClassificationLabel = (classification, fallbackLabel = null, fallbackConfidence = null) => {
            const rawLabel = classification?.label ?? fallbackLabel;
            if (!rawLabel) {
                return null;
            }

            const rawConfidence = classification?.confidence ?? fallbackConfidence;
            const formattedLabel = String(rawLabel).replace(/_/g, ' ');
            const formattedConfidence = Number.isFinite(Number(rawConfidence))
                ? ` ${Math.round(Number(rawConfidence) * 100)}%`
                : '';
            return `${formattedLabel}${formattedConfidence}`;
        };

        if (normalizedMode === 'counting') {
            return {
                color: '#06b6d4',
                lineWidth: 2.5,
                dash: [8, 4],
                label: det.track_id !== null && det.track_id !== undefined ? `Track ${det.track_id}` : 'Counting target',
                labelTextColor: '#ffffff',
                labelBgColor: '#0891b2',
                showTrackId: false,
            };
        }

        if (shouldRenderFallAlerts) {
            if (isFallDetected) {
                return {
                    color: '#ef4444',
                    lineWidth: 3,
                    dash: [],
                    label: 'Fall detected',
                    labelTextColor: '#ffffff',
                    labelBgColor: '#b91c1c',
                    showTrackId: true,
                };
            }

            if (isFallPose) {
                return {
                    color: '#f59e0b',
                    lineWidth: 2.5,
                    dash: [],
                    label: 'Fall risk',
                    labelTextColor: '#111827',
                    labelBgColor: '#fbbf24',
                    showTrackId: true,
                };
            }

            return {
                color: '#94a3b8',
                lineWidth: 2,
                dash: [4, 4],
                label: null,
                labelTextColor: '#ffffff',
                labelBgColor: '#475569',
                showTrackId: true,
            };
        }

        if (shouldRenderDressCodeDetails) {
            return {
                color: isViolation ? '#ef4444' : '#2563eb',
                lineWidth: isViolation ? 3 : 2,
                dash: [],
                labelLines: [
                    formatClassificationLabel(lowerBodyClassification, det.label, det.confidence) || clothingLabel,
                    formatClassificationLabel(footwearClassification),
                ].filter(Boolean),
                labelTextColor: '#ffffff',
                labelBgColor: isViolation ? '#b91c1c' : '#1d4ed8',
                showTrackId: true,
            };
        }

        if (hasDressCodeDetails && !shouldRenderFallAlerts && !isFallDetected && !isFallPose) {
            return {
                color: isViolation ? '#ef4444' : '#2563eb',
                lineWidth: isViolation ? 3 : 2,
                dash: [],
                labelLines: [
                    formatClassificationLabel(lowerBodyClassification, det.label, det.confidence) || clothingLabel,
                    formatClassificationLabel(footwearClassification),
                ].filter(Boolean),
                labelTextColor: '#ffffff',
                labelBgColor: isViolation ? '#b91c1c' : '#1d4ed8',
                showTrackId: true,
            };
        }

        const eventLabel = isFallDetected ? 'Fall detected' : isFallPose ? 'Fall risk' : null;
        return {
            color: isViolation || isFallDetected ? '#ef4444' : isFallPose ? '#f59e0b' : '#22c55e',
            lineWidth: 2,
            dash: [],
            label: det.label
                ? `${det.label.replace(/_/g, ' ')} ${confidence}%`
                : eventLabel,
            labelTextColor: '#ffffff',
            labelBgColor: isViolation || isFallDetected ? '#dc2626' : isFallPose ? '#f59e0b' : '#16a34a',
            showTrackId: true,
        };
    }, [overlayMode, showDressCodeDetails, showFallAlerts]);

    // --- Draw detections on canvas overlay ---
    const drawDetections = useCallback((detections) => {
        const canvas = canvasRef.current;
        const img = imgRef.current;
        if (!canvas || !img) return;

        const ctx = canvas.getContext('2d');

        // Match canvas size to displayed image element size
        const rect = img.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (hideOverlays || !detections || detections.length === 0) return;

        // Compute actual visible image area (accounting for object-contain letterboxing)
        const area = getImageDisplayArea();
        if (!area) return;
        const { displayW, displayH, offsetX, offsetY, mediaWidth, mediaHeight } = area;
        const normalizedMode = String(overlayMode || 'auto').toLowerCase();

        // Keep the overlay locked to the exact visible media area inside object-contain.
        const scaleX = displayW / mediaWidth;
        const scaleY = displayH / mediaHeight;

        const drawScaledBoundingBox = (bbox, style) => {
            if (!Array.isArray(bbox) || bbox.length < 4) {
                return null;
            }

            const [x1, y1, x2, y2] = bbox;
            const sx1 = x1 * scaleX + offsetX;
            const sy1 = y1 * scaleY + offsetY;
            const sw = (x2 - x1) * scaleX;
            const sh = (y2 - y1) * scaleY;

            ctx.setLineDash(Array.isArray(style?.dash) ? style.dash : []);
            ctx.strokeStyle = style?.color || '#22c55e';
            ctx.lineWidth = style?.lineWidth || 2;
            ctx.strokeRect(sx1, sy1, sw, sh);

            const labelLines = Array.isArray(style?.labelLines) && style.labelLines.length
                ? style.labelLines
                : (style?.label ? [style.label] : []);
            if (labelLines.length) {
                const primaryFontSize = Math.max(8, 8.5 * scaleX);
                const secondaryFontSize = Math.max(8, 8.5 * scaleX);
                const paddingX = Math.max(2, 3 * scaleX);
                const paddingY = Math.max(1.5, 2 * scaleY);
                const lineGap = Math.max(1, 1.5 * scaleY);
                const lineHeights = labelLines.map((_, index) => (
                    index === 0 ? Math.max(9, 10 * scaleY) : Math.max(9, 10 * scaleY)
                ));
                const lineWidths = labelLines.map((line, index) => {
                    ctx.font = `600 ${index === 0 ? primaryFontSize : secondaryFontSize}px ${OVERLAY_FONT_FAMILY}`;
                    return ctx.measureText(line).width;
                });
                const textBlockHeight = lineHeights.reduce((sum, value) => sum + value, 0) + lineGap * Math.max(0, labelLines.length - 1);
                const labelY = Math.max(0, sy1 - textBlockHeight - paddingY * 2);

                ctx.fillStyle = style?.labelBgColor || style?.color || '#22c55e';
                ctx.fillRect(
                    sx1,
                    labelY,
                    Math.max(...lineWidths) + paddingX * 2,
                    textBlockHeight + paddingY * 2,
                );
                ctx.fillStyle = style?.labelTextColor || '#ffffff';
                let currentTextY = labelY + paddingY;
                labelLines.forEach((line, index) => {
                    const fontSize = index === 0 ? primaryFontSize : secondaryFontSize;
                    const lineHeight = lineHeights[index];
                    ctx.font = `600 ${fontSize}px ${OVERLAY_FONT_FAMILY}`;
                    currentTextY += lineHeight;
                    ctx.fillText(line, sx1 + paddingX, currentTextY);
                    currentTextY += lineGap;
                });
            }

            return { sx1, sy1, sw, sh };
        };

        const orderedDetections = showFallAlerts || normalizedMode === 'fall'
            ? [
                ...detections.filter((det) => !det?.fall_detected),
                ...detections.filter((det) => det?.fall_detected),
            ]
            : detections;

        orderedDetections.forEach((det) => {
            if (!det.person_bbox) return;

            const visual = getOverlayVisual(det);
            const personBox = drawScaledBoundingBox(det.person_bbox, visual);
            if (!personBox) {
                return;
            }

            // Draw track ID if available
            ctx.setLineDash([]);
            if (visual.showTrackId && det.track_id !== null && det.track_id !== undefined) {
                const idLabel = `ID: ${det.track_id}`;
                ctx.font = `600 ${Math.max(9, 10 * scaleX)}px ${OVERLAY_FONT_FAMILY}`;
                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                const idMetrics = ctx.measureText(idLabel);
                ctx.fillRect(personBox.sx1, personBox.sy1, idMetrics.width + 6, 14 * scaleY);
                ctx.fillStyle = '#ffffff';
                ctx.fillText(idLabel, personBox.sx1 + 3, personBox.sy1 + 11 * scaleY);
            }

            const anchorPoint = Array.isArray(det.display_anchor) && det.display_anchor.length >= 2
                ? det.display_anchor
                : det.count_anchor;
            if (showCountingAnchors && Array.isArray(anchorPoint) && anchorPoint.length >= 2) {
                const [ax, ay] = anchorPoint;
                const anchorX = ax * scaleX + offsetX;
                const anchorY = ay * scaleY + offsetY;

                ctx.beginPath();
                ctx.arc(anchorX, anchorY, Math.max(3, 4 * scaleX), 0, Math.PI * 2);
                ctx.fillStyle = '#facc15';
                ctx.fill();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = '#111827';
                ctx.stroke();
            }
        });
    }, [getImageDisplayArea, getOverlayVisual, hideOverlays, overlayMode, showCountingAnchors, showFallAlerts]);

    const applyPayload = useCallback((data) => {
        const hasImage = Boolean(data.imageBlob);

        if (hasImage && imgRef.current) {
            const nextImageUrl = URL.createObjectURL(data.imageBlob);
            revokeActiveImageUrl();
            activeImageUrlRef.current = nextImageUrl;
            imgRef.current.src = nextImageUrl;
            setStatusSafe('connected');
        } else if (imgRef.current) {
            clearImage();
            drawDetections([]);
            setStatusSafe(data.stream_status === 'offline' ? 'disconnected' : 'recovering');
        }

        if (onStatsRef.current) {
            onStatsRef.current({
                fps: data.fps || 0,
                people_count: data.people_count || 0,
            });
        }

        if (onStreamStateRef.current) {
            onStreamStateRef.current({
                status: data.stream_status || (hasImage ? 'live' : 'recovering'),
                reason: data.stream_reason || null,
                hasImage,
            });
        }

        const detections = Array.isArray(data.detections) ? data.detections : [];
        detectionsRef.current = detections;
        drawDetections(detections);

        if (onDetectionsRef.current) {
            onDetectionsRef.current(detections);
        }

        if (onCountingDataRef.current && data.counting_data) {
            onCountingDataRef.current(data.counting_data);
        }
    }, [clearImage, drawDetections, revokeActiveImageUrl, setStatusSafe]);

    const scheduleLatestRender = useCallback(() => {
        if (renderRafRef.current !== null) return;

        const pump = () => {
            renderRafRef.current = window.requestAnimationFrame((now) => {
                if ((now - lastRenderedAtRef.current) < STREAM_RENDER_INTERVAL_MS) {
                    pump();
                    return;
                }

                renderRafRef.current = null;
                const payload = latestPayloadRef.current;
                latestPayloadRef.current = null;
                if (!payload) return;

                lastRenderedAtRef.current = now;
                applyPayload(payload);

                if (latestPayloadRef.current) {
                    pump();
                }
            });
        };

        pump();
    }, [applyPayload]);

    useEffect(() => {
        clearAutoReconnectTimer();
        if (!wsUrl) {
            refreshInProgressRef.current = false;
            return undefined;
        }

        let intentionalClose = false;

        // Close existing connection if any
        if (wsRef.current) {
            wsRef.current.close();
        }

        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'blob';
        wsRef.current = ws;
        latestFrameBlobRef.current = null;
        latestPayloadRef.current = null;
        lastRenderedAtRef.current = 0;
        setStatusSafe(refreshInProgressRef.current ? 'refreshing' : 'connecting');

        ws.onopen = () => {
            console.log(`Connected to ${wsUrl}`);
            refreshInProgressRef.current = false;
            setStatusSafe('connected');
            armAutoReconnectTimer();
        };

        ws.onmessage = (event) => {
            try {
                if (typeof event.data === 'string') {
                    const data = JSON.parse(event.data);
                    latestPayloadRef.current = {
                        ...data,
                        imageBlob: data.has_image ? latestFrameBlobRef.current : null,
                    };
                    if (!data.has_image) {
                        latestFrameBlobRef.current = null;
                    }
                    scheduleLatestRender();
                    return;
                }

                latestFrameBlobRef.current = event.data instanceof Blob
                    ? event.data
                    : new Blob([event.data], { type: 'image/jpeg' });
            } catch (e) {
                console.error("Error parsing WS message", e);
            }
        };

        ws.onerror = (error) => {
            console.error("WebSocket error:", error);
            refreshInProgressRef.current = false;
            setStatusSafe('error');
        };

        ws.onclose = () => {
            console.log("WebSocket closed");
            clearAutoReconnectTimer();
            if (wsRef.current === ws) {
                wsRef.current = null;
            }
            if (intentionalClose) {
                return;
            }
            refreshInProgressRef.current = false;
            setStatusSafe('disconnected');
        };

        return () => {
            intentionalClose = true;
            clearAutoReconnectTimer();
            if (wsRef.current) {
                wsRef.current.close();
            }
            if (renderRafRef.current !== null) {
                window.cancelAnimationFrame(renderRafRef.current);
                renderRafRef.current = null;
            }
            latestFrameBlobRef.current = null;
            latestPayloadRef.current = null;
            detectionsRef.current = [];
            clearImage();
            drawDetections([]);
        };
    }, [
        armAutoReconnectTimer,
        clearAutoReconnectTimer,
        clearImage,
        connectionVersion,
        drawDetections,
        scheduleLatestRender,
        setStatusSafe,
        wsUrl,
    ]);

    useEffect(() => {
        if (!onMediaLayoutRef.current) return undefined;
        const wrapper = wrapperRef.current;
        const img = imgRef.current;
        if (!wrapper || typeof ResizeObserver === 'undefined') {
            publishMediaLayout();
            return undefined;
        }

        const observer = new ResizeObserver(() => {
            publishMediaLayout();
        });
        observer.observe(wrapper);
        if (img) {
            observer.observe(img);
        }
        publishMediaLayout();

        return () => {
            observer.disconnect();
        };
    }, [publishMediaLayout]);

    return (
        <div ref={wrapperRef} className={`relative bg-black flex items-center justify-center overflow-hidden ${className}`}>
            <img
                ref={imgRef}
                className="w-full h-full object-contain"
                alt={alt}
                onLoad={publishMediaLayout}
            />
            <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full pointer-events-none"
                style={{ objectFit: 'contain' }}
            />
            {status !== 'connected' && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white text-xs">
                    {status === 'connecting' && "Connecting..."}
                    {status === 'refreshing' && "Refreshing stream..."}
                    {status === 'recovering' && "Recovering stream..."}
                    {status === 'error' && "Connection Error"}
                    {status === 'disconnected' && "Offline"}
                </div>
            )}
        </div>
    );
};

export default StreamPlayer;
