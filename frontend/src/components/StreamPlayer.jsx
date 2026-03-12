import React, { useEffect, useRef, useState, useCallback } from 'react';

const StreamPlayer = ({
    wsUrl,
    className,
    alt,
    onStats,
    onDetections,
    onCountingData,
    showCountingAnchors = false,
    overlayMode = 'auto',
}) => {
    const imgRef = useRef(null);
    const canvasRef = useRef(null);
    const wsRef = useRef(null);
    const detectionsRef = useRef([]);
    const [status, setStatus] = useState('connecting');

    // --- Compute actual image display area within object-contain ---
    const getImageDisplayArea = useCallback(() => {
        const img = imgRef.current;
        if (!img) return null;
        const rect = img.getBoundingClientRect();
        const containerW = rect.width;
        const containerH = rect.height;
        // Backend always sends 640x360 (16:9)
        const imgAspect = 640 / 360;
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
        return { displayW, displayH, offsetX, offsetY };
    }, []);

    const getOverlayVisual = useCallback((det) => {
        const normalizedMode = String(overlayMode || 'auto').toLowerCase();
        const isViolation = Boolean(det.violation);
        const isFallDetected = Boolean(det.fall_detected);
        const isFallPose = Boolean(det.fall_pose);
        const confidence = Math.round((det.confidence || 0) * 100);
        const clothingLabel = det.label
            ? `${det.label.replace(/_/g, ' ')} ${confidence}%`
            : 'Person';

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

        if (normalizedMode === 'fall') {
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

        if (normalizedMode === 'dress-code' || normalizedMode === 'dresscode') {
            return {
                color: isViolation ? '#ef4444' : '#2563eb',
                lineWidth: isViolation ? 3 : 2,
                dash: [],
                label: clothingLabel,
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
    }, [overlayMode]);

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

        if (!detections || detections.length === 0) return;

        // Compute actual visible image area (accounting for object-contain letterboxing)
        const area = getImageDisplayArea();
        if (!area) return;
        const { displayW, displayH, offsetX, offsetY } = area;

        // The detections have coords scaled to 640x360 by the backend.
        // Scale to the actual displayed image size, with offset for letterboxing.
        const scaleX = displayW / 640;
        const scaleY = displayH / 360;

        detections.forEach((det) => {
            if (!det.person_bbox) return;

            const [x1, y1, x2, y2] = det.person_bbox;
            const sx1 = x1 * scaleX + offsetX;
            const sy1 = y1 * scaleY + offsetY;
            const sw = (x2 - x1) * scaleX;
            const sh = (y2 - y1) * scaleY;
            const visual = getOverlayVisual(det);

            // Draw person bounding box
            ctx.setLineDash(Array.isArray(visual.dash) ? visual.dash : []);
            ctx.strokeStyle = visual.color;
            ctx.lineWidth = visual.lineWidth || 2;
            ctx.strokeRect(sx1, sy1, sw, sh);

            // Draw label background + text
            const label = visual.label;
            if (label) {
                ctx.font = `bold ${Math.max(10, 12 * scaleX)}px sans-serif`;
                const textMetrics = ctx.measureText(label);
                const textHeight = 14 * scaleY;
                const padding = 4 * scaleX;

                // Background
                ctx.fillStyle = visual.labelBgColor || visual.color;
                ctx.fillRect(
                    sx1,
                    sy1 - textHeight - padding * 2,
                    textMetrics.width + padding * 2,
                    textHeight + padding * 2
                );

                // Text
                ctx.fillStyle = visual.labelTextColor || '#ffffff';
                ctx.fillText(label, sx1 + padding, sy1 - padding);
            }

            // Draw track ID if available
            ctx.setLineDash([]);
            if (visual.showTrackId && det.track_id !== null && det.track_id !== undefined) {
                const idLabel = `ID: ${det.track_id}`;
                ctx.font = `${Math.max(9, 10 * scaleX)}px sans-serif`;
                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                const idMetrics = ctx.measureText(idLabel);
                ctx.fillRect(sx1, sy1, idMetrics.width + 6, 14 * scaleY);
                ctx.fillStyle = '#ffffff';
                ctx.fillText(idLabel, sx1 + 3, sy1 + 11 * scaleY);
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
    }, [getImageDisplayArea, getOverlayVisual, showCountingAnchors]);

    useEffect(() => {
        if (!wsUrl) return;

        // Close existing connection if any
        if (wsRef.current) {
            wsRef.current.close();
        }

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
            console.log(`Connected to ${wsUrl}`);
            setStatus('connected');
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.image && imgRef.current) {
                    imgRef.current.src = `data:image/jpeg;base64,${data.image}`;
                    setStatus('connected');
                } else if (imgRef.current) {
                    imgRef.current.removeAttribute('src');
                    drawDetections([]);
                    setStatus(data.stream_status === 'offline' ? 'disconnected' : 'recovering');
                }
                if (onStats) {
                    onStats({
                        fps: data.fps || 0,
                        people_count: data.people_count || 0,
                    });
                }

                // Store detections and draw on canvas
                const detections = data.detections || [];
                detectionsRef.current = detections;
                drawDetections(detections);

                // Forward detections to parent if callback provided
                if (onDetections && detections.length > 0) {
                    onDetections(detections);
                }

                // Forward counting data to parent if callback provided
                if (onCountingData && data.counting_data) {
                    onCountingData(data.counting_data);
                }
            } catch (e) {
                console.error("Error parsing WS message", e);
            }
        };

        ws.onerror = (error) => {
            console.error("WebSocket error:", error);
            setStatus('error');
        };

        ws.onclose = () => {
            console.log("WebSocket closed");
            setStatus('disconnected');
        };

        return () => {
            if (wsRef.current) {
                wsRef.current.close();
            }
        };
    }, [wsUrl]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <div className={`relative bg-black flex items-center justify-center overflow-hidden ${className}`}>
            <img
                ref={imgRef}
                className="w-full h-full object-contain"
                alt={alt}
            />
            <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full pointer-events-none"
                style={{ objectFit: 'contain' }}
            />
            {status !== 'connected' && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white text-xs">
                    {status === 'connecting' && "Connecting..."}
                    {status === 'recovering' && "Recovering stream..."}
                    {status === 'error' && "Connection Error"}
                    {status === 'disconnected' && "Offline"}
                </div>
            )}
        </div>
    );
};

export default StreamPlayer;
