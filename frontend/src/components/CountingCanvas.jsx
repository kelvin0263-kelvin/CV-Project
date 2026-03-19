import React, { useRef, useEffect, useState, useCallback } from 'react';

/**
 * CountingCanvas - Interactive SVG overlay for drawing counting lines,
 * active counting zones, and displaying live counting data.
 *
 * All coordinates are normalised to the ACTUAL VIDEO AREA (0-1),
 * compensating for object-contain letterboxing/pillarboxing.
 *
 * Props:
 *   lines            - array of line configs [{id, name, points, direction, line_type}]
 *   frameExcludeAreas - array of active zones [{id, name, points}]
 *   countingData     - live counting data from WebSocket
 *   drawingMode      - 'line' | 'frame_exclude' | null
 *   onLineDrawn      - callback({points, direction})
 *   onFrameExcludeAreaDrawn - callback({points})
 *   containerRef     - ref to the video container for sizing
 */

const FRAME_EXCLUDE_COLORS = {
    fill: 'rgba(14, 165, 233, 0.14)',
    stroke: '#0ea5e9',
    label: '#0ea5e9',
};

const DRAWING_COLORS = {
    frame_exclude: FRAME_EXCLUDE_COLORS,
    default: { fill: 'rgba(59, 130, 246, 0.15)', stroke: '#3b82f6', label: '#3b82f6' },  // blue
};

const getLineType = (line) => line?.line_type === 'foot_traffic' ? 'foot_traffic' : 'occupancy';
const getFootTrafficLabelsForLine = (line) => {
    const points = Array.isArray(line?.points) ? line.points : [];
    if (points.length >= 2) {
        const [start, end] = points;
        const dx = Number(end?.[0] ?? 0) - Number(start?.[0] ?? 0);
        const dy = Number(end?.[1] ?? 0) - Number(start?.[1] ?? 0);
        if (Math.abs(dy) >= Math.abs(dx)) {
            return { negative: 'Left', positive: 'Right', shortNegative: 'L', shortPositive: 'R', mode: 'left_right' };
        }
    }
    return { negative: 'Up', positive: 'Down', shortNegative: 'U', shortPositive: 'D', mode: 'up_down' };
};

const getFootTrafficSummaryLabels = (lines) => {
    const ftLines = Array.isArray(lines) ? lines.filter((line) => getLineType(line) === 'foot_traffic') : [];
    if (!ftLines.length) {
        return { negative: 'Left', positive: 'Right', shortNegative: 'L', shortPositive: 'R', mixed: false };
    }
    const labels = ftLines.map(getFootTrafficLabelsForLine);
    const firstMode = labels[0].mode;
    const mixed = labels.some((label) => label.mode !== firstMode);
    if (mixed) {
        return { negative: 'Direction A', positive: 'Direction B', shortNegative: 'A', shortPositive: 'B', mixed: true };
    }
    return { ...labels[0], mixed: false };
};

const CountingCanvas = ({
    lines = [],
    frameExcludeAreas = [],
    countingData = {},
    drawingMode = null,
    onLineDrawn,
    onFrameExcludeAreaDrawn,
    containerRef,
    mediaSize = null,
}) => {
    const svgRef = useRef(null);
    const [svgSize, setSvgSize] = useState({ width: 640, height: 360 });
    const [videoArea, setVideoArea] = useState({ displayW: 640, displayH: 360, offsetX: 0, offsetY: 0 });

    // Drawing state
    const [lineStart, setLineStart] = useState(null);
    const [lineEnd, setLineEnd] = useState(null);
    const [polygonPoints, setPolygonPoints] = useState([]);
    const [mousePos, setMousePos] = useState(null);

    // Sync SVG size and video area with container
    useEffect(() => {
        const updateSize = () => {
            if (containerRef?.current) {
                const rect = containerRef.current.getBoundingClientRect();
                const containerW = rect.width;
                const containerH = rect.height;
                setSvgSize({ width: containerW, height: containerH });

                const mediaWidth = Number(mediaSize?.width) > 0 ? Number(mediaSize.width) : 640;
                const mediaHeight = Number(mediaSize?.height) > 0 ? Number(mediaSize.height) : 360;
                const imgAspect = mediaWidth / mediaHeight;
                const containerAspect = containerW / containerH;

                let displayW, displayH, offsetX, offsetY;
                if (containerAspect > imgAspect) {
                    displayH = containerH;
                    displayW = containerH * imgAspect;
                    offsetX = (containerW - displayW) / 2;
                    offsetY = 0;
                } else {
                    displayW = containerW;
                    displayH = containerW / imgAspect;
                    offsetX = 0;
                    offsetY = (containerH - displayH) / 2;
                }
                setVideoArea({ displayW, displayH, offsetX, offsetY });
            }
        };
        updateSize();
        window.addEventListener('resize', updateSize);
        const interval = setInterval(updateSize, 500);
        return () => {
            window.removeEventListener('resize', updateSize);
            clearInterval(interval);
        };
    }, [containerRef, mediaSize]);

    const toNorm = useCallback((px, py) => {
        const { displayW, displayH, offsetX, offsetY } = videoArea;
        return {
            x: Math.max(0, Math.min(1, (px - offsetX) / displayW)),
            y: Math.max(0, Math.min(1, (py - offsetY) / displayH)),
        };
    }, [videoArea]);

    const toPx = useCallback((nx, ny) => {
        const { displayW, displayH, offsetX, offsetY } = videoArea;
        return {
            x: nx * displayW + offsetX,
            y: ny * displayH + offsetY,
        };
    }, [videoArea]);

    const getMousePos = useCallback((e) => {
        const svg = svgRef.current;
        if (!svg) return null;
        const rect = svg.getBoundingClientRect();
        return { px: e.clientX - rect.left, py: e.clientY - rect.top };
    }, []);

    const isInVideoArea = useCallback((px, py) => {
        const { displayW, displayH, offsetX, offsetY } = videoArea;
        return px >= offsetX && px <= offsetX + displayW &&
               py >= offsetY && py <= offsetY + displayH;
    }, [videoArea]);

    const handleMouseMove = useCallback((e) => {
        if (!drawingMode) return;
        const pos = getMousePos(e);
        if (!pos) return;
        const norm = toNorm(pos.px, pos.py);
        setMousePos(norm);
        if (drawingMode === 'line' && lineStart) {
            setLineEnd(norm);
        }
    }, [drawingMode, lineStart, getMousePos, toNorm]);

    const handleMouseDown = useCallback((e) => {
        if (!drawingMode) return;
        const pos = getMousePos(e);
        if (!pos || !isInVideoArea(pos.px, pos.py)) return;
        const norm = toNorm(pos.px, pos.py);
        if (drawingMode === 'line') {
            setLineStart(norm);
            setLineEnd(norm);
        }
    }, [drawingMode, getMousePos, toNorm, isInVideoArea]);

    const handleMouseUp = useCallback(() => {
        if (!drawingMode) return;
        if (drawingMode === 'line' && lineStart && lineEnd) {
            const dist = Math.hypot(lineEnd.x - lineStart.x, lineEnd.y - lineStart.y);
            if (dist > 0.02) {
                onLineDrawn?.({ points: [[lineStart.x, lineStart.y], [lineEnd.x, lineEnd.y]], direction: 'left_to_right' });
            }
            setLineStart(null);
            setLineEnd(null);
        }
    }, [drawingMode, lineStart, lineEnd, onLineDrawn]);

    const handleClick = useCallback((e) => {
        if (drawingMode !== 'frame_exclude') return;
        const pos = getMousePos(e);
        if (!pos || !isInVideoArea(pos.px, pos.py)) return;
        const norm = toNorm(pos.px, pos.py);
        setPolygonPoints(prev => [...prev, norm]);
    }, [drawingMode, getMousePos, toNorm, isInVideoArea]);

    const handleDoubleClick = useCallback((e) => {
        if (drawingMode !== 'frame_exclude') return;
        e.preventDefault();
        if (polygonPoints.length >= 3) {
            onFrameExcludeAreaDrawn?.({ points: polygonPoints.map(p => [p.x, p.y]) });
        }
        setPolygonPoints([]);
    }, [drawingMode, polygonPoints, onFrameExcludeAreaDrawn]);

    useEffect(() => {
        const resetId = window.requestAnimationFrame(() => {
            setLineStart(null);
            setLineEnd(null);
            setPolygonPoints([]);
            setMousePos(null);
        });
        return () => window.cancelAnimationFrame(resetId);
    }, [drawingMode]);

    const getDrawingColor = () => {
        return DRAWING_COLORS[drawingMode] || DRAWING_COLORS.default;
    };

    // --- Render saved counting line ---
    const renderLine = (line, index) => {
        const pts = line.points || [];
        if (pts.length < 2) return null;
        const isFootTraffic = line.line_type === 'foot_traffic';
        const countEvent = isFootTraffic ? 'FT' : (line.count_event === 'out' ? 'OUT' : 'IN');
        const lineColor = isFootTraffic ? '#06b6d4' : (line.count_event === 'out' ? '#ef4444' : '#facc15');
        const p1 = toPx(pts[0][0], pts[0][1]);
        const p2 = toPx(pts[1][0], pts[1][1]);
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy);
        if (len === 0) return null;
        const perpX = -dy / len * 12;
        const perpY = dx / len * 12;
        const isLTR = line.direction === 'left_to_right';
        const arrowX = midX + (isLTR ? perpX : -perpX);
        const arrowY = midY + (isLTR ? perpY : -perpY);

        return (
            <g key={`line-${line.id || index}`}>
                <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
                    stroke={lineColor} strokeWidth="3" strokeDasharray="8,4" strokeLinecap="round" />
                <circle cx={arrowX} cy={arrowY} r="6" fill={lineColor} opacity="0.8" />
                <text x={arrowX} y={arrowY + 1} textAnchor="middle" dominantBaseline="middle"
                    fill="#000" fontSize="8" fontWeight="bold">{countEvent}</text>
                <text x={midX} y={midY - 10} textAnchor="middle" fill={lineColor}
                    fontSize="11" fontWeight="bold" style={{ textShadow: '1px 1px 2px rgba(0,0,0,0.8)' }}>
                    {line.name || `Line ${index + 1}`}
                </text>
                <circle cx={p1.x} cy={p1.y} r="5" fill={lineColor} stroke="#000" strokeWidth="1" />
                <circle cx={p2.x} cy={p2.y} r="5" fill={lineColor} stroke="#000" strokeWidth="1" />
            </g>
        );
    };

    const renderFrameExcludeArea = (area, index) => {
        const pts = area.points || [];
        if (pts.length < 3) return null;

        const colors = FRAME_EXCLUDE_COLORS;
        const pixelPts = pts.map(p => toPx(p[0], p[1]));
        const pointsStr = pixelPts.map(p => `${p.x},${p.y}`).join(' ');
        const cx = pixelPts.reduce((s, p) => s + p.x, 0) / pixelPts.length;
        const cy = pixelPts.reduce((s, p) => s + p.y, 0) / pixelPts.length;

        const displayLabel = area.name || `Active Zone ${index + 1}`;

        return (
            <g key={`frame-exclude-${area.id || index}`}>
                <polygon points={pointsStr}
                    fill={colors.fill} stroke={colors.stroke} strokeWidth="2" strokeDasharray="6,3" />
                <rect x={cx - 45} y={cy - 10} width="90"
                    height="22" rx="6" fill="rgba(0,0,0,0.65)" />
                <text x={cx} y={cy} textAnchor="middle" fill={colors.label}
                    fontSize="10" fontWeight="bold">
                    {displayLabel}
                </text>
                {pixelPts.map((p, i) => (
                    <circle key={i} cx={p.x} cy={p.y} r="4" fill={colors.stroke} stroke="#fff" strokeWidth="1" />
                ))}
            </g>
        );
    };

    // --- Render active drawing ---
    const renderDrawing = () => {
        const elements = [];
        const drawColor = getDrawingColor();

        if (drawingMode === 'line' && lineStart && lineEnd) {
            const p1 = toPx(lineStart.x, lineStart.y);
            const p2 = toPx(lineEnd.x, lineEnd.y);
            elements.push(
                <line key="draw-line" x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
                    stroke="#facc15" strokeWidth="3" strokeDasharray="4,4" opacity="0.7" />
            );
        }

        if (drawingMode === 'frame_exclude' && polygonPoints.length > 0) {
            const pixelPts = polygonPoints.map(p => toPx(p.x, p.y));

            for (let i = 0; i < pixelPts.length - 1; i++) {
                elements.push(
                    <line key={`poly-edge-${i}`}
                        x1={pixelPts[i].x} y1={pixelPts[i].y}
                        x2={pixelPts[i + 1].x} y2={pixelPts[i + 1].y}
                        stroke={drawColor.stroke} strokeWidth="2" strokeDasharray="4,4" />
                );
            }

            if (mousePos) {
                const last = pixelPts[pixelPts.length - 1];
                const mouse = toPx(mousePos.x, mousePos.y);
                elements.push(
                    <line key="poly-preview" x1={last.x} y1={last.y} x2={mouse.x} y2={mouse.y}
                        stroke={drawColor.stroke} strokeWidth="2" strokeDasharray="2,2" opacity="0.5" />
                );
            }

            // Close-preview fill when >=3 points
            if (pixelPts.length >= 3) {
                const previewStr = pixelPts.map(p => `${p.x},${p.y}`).join(' ');
                elements.push(
                    <polygon key="poly-fill-preview" points={previewStr}
                        fill={drawColor.fill} stroke="none" opacity="0.4" />
                );
            }

            pixelPts.forEach((p, i) => {
                elements.push(
                    <circle key={`poly-vert-${i}`} cx={p.x} cy={p.y} r="5"
                        fill={drawColor.stroke} stroke="#fff" strokeWidth="1.5" />
                );
            });

            if (polygonPoints.length >= 3) {
                const hintY = videoArea.offsetY + 20;
                elements.push(
                    <text key="poly-hint" x={svgSize.width / 2} y={hintY}
                        textAnchor="middle" fill={drawColor.stroke} fontSize="12" fontWeight="bold"
                        style={{ textShadow: '1px 1px 2px rgba(0,0,0,0.8)' }}>
                        Double-click to close Active Zone ({polygonPoints.length} points)
                    </text>
                );
            }
        }

        return elements;
    };

    const isCountingActive = countingData && (
        countingData.total_in !== undefined
        || countingData.foot_traffic_total !== undefined
    );
    const showFootTraffic = Number(countingData?.foot_traffic_total ?? 0) > 0
        || (Array.isArray(countingData?.foot_traffic_lines) && countingData.foot_traffic_lines.length > 0);
    const footTrafficLabels = getFootTrafficSummaryLabels(countingData?.lines);

    return (
        <svg
            ref={svgRef}
            className="absolute inset-0 w-full h-full"
            style={{
                pointerEvents: drawingMode ? 'auto' : 'none',
                cursor: drawingMode ? 'crosshair' : 'default',
                zIndex: 20,
            }}
            viewBox={`0 0 ${svgSize.width} ${svgSize.height}`}
            preserveAspectRatio="none"
            onMouseMove={handleMouseMove}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
        >
            {drawingMode && (
                <rect x={videoArea.offsetX} y={videoArea.offsetY}
                    width={videoArea.displayW} height={videoArea.displayH}
                    fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1" strokeDasharray="4,4" />
            )}

            {frameExcludeAreas.map((area, i) => renderFrameExcludeArea(area, i))}
            {lines.map((line, i) => renderLine(line, i))}
            {renderDrawing()}

            {/* Live counting summary badge */}
            {isCountingActive && (
                <g>
                    <rect x={videoArea.offsetX + videoArea.displayW - 140}
                          y={videoArea.offsetY + videoArea.displayH - (showFootTraffic ? 66 : 50)}
                          width="130" height={showFootTraffic ? '58' : '42'} rx="8" fill="rgba(0,0,0,0.7)" />
                    <text x={videoArea.offsetX + videoArea.displayW - 125}
                          y={videoArea.offsetY + videoArea.displayH - (showFootTraffic ? 46 : 30)}
                          fill="#22c55e" fontSize="12" fontWeight="bold">
                        IN: {countingData.total_in ?? 0}
                    </text>
                    <text x={videoArea.offsetX + videoArea.displayW - 60}
                          y={videoArea.offsetY + videoArea.displayH - (showFootTraffic ? 46 : 30)}
                          fill="#ef4444" fontSize="12" fontWeight="bold">
                        OUT: {countingData.total_out ?? 0}
                    </text>
                    <text x={videoArea.offsetX + videoArea.displayW - 125}
                          y={videoArea.offsetY + videoArea.displayH - (showFootTraffic ? 30 : 14)}
                          fill="#fff" fontSize="11">
                        Now: {countingData.occupancy ?? 0}
                    </text>
                    {showFootTraffic && (
                        <text x={videoArea.offsetX + videoArea.displayW - 125}
                              y={videoArea.offsetY + videoArea.displayH - 14}
                              fill="#67e8f9" fontSize="10.5" fontWeight="bold">
                            FT {footTrafficLabels.shortNegative}:{countingData.foot_traffic_left ?? 0} {footTrafficLabels.shortPositive}:{countingData.foot_traffic_right ?? 0} T:{countingData.foot_traffic_total ?? 0}
                        </text>
                    )}
                </g>
            )}
        </svg>
    );
};

export default CountingCanvas;
