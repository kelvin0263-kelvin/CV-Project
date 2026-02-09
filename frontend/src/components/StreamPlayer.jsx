import React, { useEffect, useRef, useState, useCallback } from 'react';

const StreamPlayer = ({ wsUrl, className, alt, onStats, onDetections, onCountingData }) => {
    const imgRef = useRef(null);
    const canvasRef = useRef(null);
    const wsRef = useRef(null);
    const detectionsRef = useRef([]);
    const [status, setStatus] = useState('connecting');

    // --- Draw detections on canvas overlay ---
    const drawDetections = useCallback((detections) => {
        const canvas = canvasRef.current;
        const img = imgRef.current;
        if (!canvas || !img) return;

        const ctx = canvas.getContext('2d');

        // Match canvas size to displayed image size
        const rect = img.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (!detections || detections.length === 0) return;

        // The detections have coords scaled to 640x360 by the backend.
        // Scale to the actual display size.
        const scaleX = rect.width / 640;
        const scaleY = rect.height / 360;

        detections.forEach((det) => {
            if (!det.person_bbox) return;

            const [x1, y1, x2, y2] = det.person_bbox;
            const sx1 = x1 * scaleX;
            const sy1 = y1 * scaleY;
            const sw = (x2 - x1) * scaleX;
            const sh = (y2 - y1) * scaleY;

            const isViolation = det.violation;
            const color = isViolation ? '#ef4444' : '#22c55e'; // red vs green

            // Draw person bounding box
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.strokeRect(sx1, sy1, sw, sh);

            // Draw label background + text
            if (det.label) {
                const label = `${det.label.replace(/_/g, ' ')} ${Math.round((det.confidence || 0) * 100)}%`;
                ctx.font = `bold ${Math.max(10, 12 * scaleX)}px sans-serif`;
                const textMetrics = ctx.measureText(label);
                const textHeight = 14 * scaleY;
                const padding = 4 * scaleX;

                // Background
                ctx.fillStyle = color;
                ctx.fillRect(
                    sx1,
                    sy1 - textHeight - padding * 2,
                    textMetrics.width + padding * 2,
                    textHeight + padding * 2
                );

                // Text
                ctx.fillStyle = '#ffffff';
                ctx.fillText(label, sx1 + padding, sy1 - padding);
            }

            // Draw track ID if available
            if (det.track_id !== null && det.track_id !== undefined) {
                const idLabel = `ID: ${det.track_id}`;
                ctx.font = `${Math.max(9, 10 * scaleX)}px sans-serif`;
                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                const idMetrics = ctx.measureText(idLabel);
                ctx.fillRect(sx1, sy1, idMetrics.width + 6, 14 * scaleY);
                ctx.fillStyle = '#ffffff';
                ctx.fillText(idLabel, sx1 + 3, sy1 + 11 * scaleY);
            }
        });
    }, []);

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
                    {status === 'error' && "Connection Error"}
                    {status === 'disconnected' && "Offline"}
                </div>
            )}
        </div>
    );
};

export default StreamPlayer;
