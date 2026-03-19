import React, { useRef, useEffect, useState, useCallback } from 'react';

const ROI_COLORS = {
    fill: 'rgba(34, 197, 94, 0.16)',
    stroke: '#22c55e',
    label: '#22c55e',
};

const RoiEditorCanvas = ({
    roi = null,
    drawingEnabled = false,
    onChange,
    containerRef,
    mediaWidth = 640,
    mediaHeight = 360,
    label = 'Detection ROI',
}) => {
    const svgRef = useRef(null);
    const [svgSize, setSvgSize] = useState({ width: 640, height: 360 });
    const [mediaArea, setMediaArea] = useState({ displayW: 640, displayH: 360, offsetX: 0, offsetY: 0 });
    const [dragStart, setDragStart] = useState(null);
    const [dragEnd, setDragEnd] = useState(null);

    useEffect(() => {
        const updateSize = () => {
            if (!containerRef?.current) {
                return;
            }
            const rect = containerRef.current.getBoundingClientRect();
            const containerW = rect.width || 640;
            const containerH = rect.height || 360;
            setSvgSize({ width: containerW, height: containerH });

            const mediaAspect = mediaWidth > 0 && mediaHeight > 0 ? mediaWidth / mediaHeight : 640 / 360;
            const containerAspect = containerH > 0 ? containerW / containerH : mediaAspect;

            let displayW;
            let displayH;
            let offsetX;
            let offsetY;
            if (containerAspect > mediaAspect) {
                displayH = containerH;
                displayW = displayH * mediaAspect;
                offsetX = (containerW - displayW) / 2;
                offsetY = 0;
            } else {
                displayW = containerW;
                displayH = displayW / mediaAspect;
                offsetX = 0;
                offsetY = (containerH - displayH) / 2;
            }
            setMediaArea({ displayW, displayH, offsetX, offsetY });
        };

        updateSize();
        window.addEventListener('resize', updateSize);
        const intervalId = setInterval(updateSize, 500);
        return () => {
            window.removeEventListener('resize', updateSize);
            clearInterval(intervalId);
        };
    }, [containerRef, mediaWidth, mediaHeight]);

    const toNorm = useCallback((px, py) => {
        const { displayW, displayH, offsetX, offsetY } = mediaArea;
        return {
            x: Math.max(0, Math.min(1, (px - offsetX) / displayW)),
            y: Math.max(0, Math.min(1, (py - offsetY) / displayH)),
        };
    }, [mediaArea]);

    const toPx = useCallback((nx, ny) => {
        const { displayW, displayH, offsetX, offsetY } = mediaArea;
        return {
            x: nx * displayW + offsetX,
            y: ny * displayH + offsetY,
        };
    }, [mediaArea]);

    const getMousePos = useCallback((event) => {
        const svg = svgRef.current;
        if (!svg) {
            return null;
        }
        const rect = svg.getBoundingClientRect();
        return { px: event.clientX - rect.left, py: event.clientY - rect.top };
    }, []);

    const isInMediaArea = useCallback((px, py) => {
        const { displayW, displayH, offsetX, offsetY } = mediaArea;
        return px >= offsetX && px <= offsetX + displayW && py >= offsetY && py <= offsetY + displayH;
    }, [mediaArea]);

    const handleMouseMove = useCallback((event) => {
        if (!drawingEnabled || !dragStart) {
            return;
        }
        const pos = getMousePos(event);
        if (!pos) {
            return;
        }
        const next = toNorm(pos.px, pos.py);
        setDragEnd(next);
    }, [drawingEnabled, dragStart, getMousePos, toNorm]);

    const handleMouseDown = useCallback((event) => {
        if (!drawingEnabled) {
            return;
        }
        const pos = getMousePos(event);
        if (!pos || !isInMediaArea(pos.px, pos.py)) {
            return;
        }
        const start = toNorm(pos.px, pos.py);
        setDragStart(start);
        setDragEnd(start);
    }, [drawingEnabled, getMousePos, isInMediaArea, toNorm]);

    const handleMouseUp = useCallback(() => {
        if (!drawingEnabled || !dragStart || !dragEnd) {
            return;
        }

        const minX = Math.min(dragStart.x, dragEnd.x);
        const maxX = Math.max(dragStart.x, dragEnd.x);
        const minY = Math.min(dragStart.y, dragEnd.y);
        const maxY = Math.max(dragStart.y, dragEnd.y);

        if ((maxX - minX) >= 0.01 && (maxY - minY) >= 0.01) {
            onChange?.({
                id: roi?.id || 'detection_roi',
                name: roi?.name || label,
                points: [
                    [minX, minY],
                    [maxX, minY],
                    [maxX, maxY],
                    [minX, maxY],
                ],
            });
        }

        setDragStart(null);
        setDragEnd(null);
    }, [dragEnd, dragStart, drawingEnabled, label, onChange, roi]);

    useEffect(() => {
        setDragStart(null);
        setDragEnd(null);
    }, [drawingEnabled, mediaWidth, mediaHeight]);

    const renderSavedRoi = () => {
        const points = roi?.points || [];
        if (points.length < 3) {
            return null;
        }
        const pixelPoints = points.map((point) => toPx(point[0], point[1]));
        const pointString = pixelPoints.map((point) => `${point.x},${point.y}`).join(' ');
        const centerX = pixelPoints.reduce((sum, point) => sum + point.x, 0) / pixelPoints.length;
        const centerY = pixelPoints.reduce((sum, point) => sum + point.y, 0) / pixelPoints.length;

        return (
            <g key="saved-roi">
                <polygon points={pointString} fill={ROI_COLORS.fill} stroke={ROI_COLORS.stroke} strokeWidth="2" strokeDasharray="6,3" />
                <rect x={centerX - 55} y={centerY - 12} width="110" height="24" rx="6" fill="rgba(0,0,0,0.65)" />
                <text x={centerX} y={centerY + 1} textAnchor="middle" fill={ROI_COLORS.label} fontSize="10" fontWeight="bold">
                    {roi?.name || label}
                </text>
                {pixelPoints.map((point, index) => (
                    <circle key={`saved-roi-point-${index}`} cx={point.x} cy={point.y} r="4" fill={ROI_COLORS.stroke} stroke="#fff" strokeWidth="1" />
                ))}
            </g>
        );
    };

    const renderDrawing = () => {
        if (!dragStart || !dragEnd) {
            return null;
        }
        const p1 = toPx(dragStart.x, dragStart.y);
        const p2 = toPx(dragEnd.x, dragEnd.y);
        const x = Math.min(p1.x, p2.x);
        const y = Math.min(p1.y, p2.y);
        const width = Math.abs(p2.x - p1.x);
        const height = Math.abs(p2.y - p1.y);

        return (
            <>
                <rect
                    x={x}
                    y={y}
                    width={width}
                    height={height}
                    fill={ROI_COLORS.fill}
                    stroke={ROI_COLORS.stroke}
                    strokeWidth="2"
                    strokeDasharray="4,4"
                    opacity="0.9"
                />
                <circle cx={x} cy={y} r="4" fill={ROI_COLORS.stroke} stroke="#fff" strokeWidth="1" />
                <circle cx={x + width} cy={y} r="4" fill={ROI_COLORS.stroke} stroke="#fff" strokeWidth="1" />
                <circle cx={x + width} cy={y + height} r="4" fill={ROI_COLORS.stroke} stroke="#fff" strokeWidth="1" />
                <circle cx={x} cy={y + height} r="4" fill={ROI_COLORS.stroke} stroke="#fff" strokeWidth="1" />
                <text
                    x={svgSize.width / 2}
                    y={mediaArea.offsetY + 20}
                    textAnchor="middle"
                    fill={ROI_COLORS.stroke}
                    fontSize="12"
                    fontWeight="bold"
                    style={{ textShadow: '1px 1px 2px rgba(0,0,0,0.8)' }}
                >
                    Drag to draw rectangular ROI
                </text>
            </>
        );
    };

    return (
        <svg
            ref={svgRef}
            className="absolute inset-0 w-full h-full"
            style={{
                pointerEvents: drawingEnabled ? 'auto' : 'none',
                cursor: drawingEnabled ? 'crosshair' : 'default',
                zIndex: 20,
            }}
            viewBox={`0 0 ${svgSize.width} ${svgSize.height}`}
            preserveAspectRatio="none"
            onMouseMove={handleMouseMove}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
        >
            <rect
                x={mediaArea.offsetX}
                y={mediaArea.offsetY}
                width={mediaArea.displayW}
                height={mediaArea.displayH}
                fill="none"
                stroke="rgba(255,255,255,0.15)"
                strokeWidth="1"
                strokeDasharray="4,4"
            />
            {renderSavedRoi()}
            {renderDrawing()}
        </svg>
    );
};

export default RoiEditorCanvas;
