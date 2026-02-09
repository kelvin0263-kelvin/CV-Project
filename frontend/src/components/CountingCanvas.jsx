import React, { useRef, useEffect, useState, useCallback } from 'react';

/**
 * CountingCanvas - Interactive SVG overlay for drawing counting lines/zones
 * and displaying live counting data.
 *
 * All coordinates are normalised to the ACTUAL VIDEO AREA (0-1),
 * compensating for object-contain letterboxing/pillarboxing.
 *
 * Props:
 *   lines            - array of line configs [{id, name, points, direction}]
 *   zones            - array of zone configs [{id, name, points, zone_type?, group_id?}]
 *   countingData     - live counting data from WebSocket
 *   drawingMode      - 'line' | 'roi' | null
 *   drawingZoneType  - 'outside' | 'door' | 'inside' | null (color hint for ROI drawing)
 *   onLineDrawn      - callback({points, direction})
 *   onZoneDrawn      - callback({points})
 *   containerRef     - ref to the video container for sizing
 */

// Zone-type colour palette
const ZONE_COLORS = {
    outside: { fill: 'rgba(249, 115, 22, 0.15)', stroke: '#f97316', label: '#f97316' },  // orange
    door:    { fill: 'rgba(250, 204, 21, 0.15)', stroke: '#facc15', label: '#facc15' },  // yellow
    inside:  { fill: 'rgba(34, 197, 94, 0.15)',  stroke: '#22c55e', label: '#22c55e' },  // green
    default: { fill: 'rgba(59, 130, 246, 0.15)', stroke: '#3b82f6', label: '#3b82f6' },  // blue
};

const ZONE_TYPE_LABELS = {
    outside: 'Outside',
    door: 'Door',
    inside: 'Inside',
};

const CountingCanvas = ({
    lines = [],
    zones = [],
    countingData = {},
    drawingMode = null,
    drawingZoneType = null,
    onLineDrawn,
    onZoneDrawn,
    containerRef,
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

                const imgAspect = 640 / 360;
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
    }, [containerRef]);

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

    const handleMouseUp = useCallback((e) => {
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
        if (drawingMode !== 'roi') return;
        const pos = getMousePos(e);
        if (!pos || !isInVideoArea(pos.px, pos.py)) return;
        const norm = toNorm(pos.px, pos.py);
        setPolygonPoints(prev => [...prev, norm]);
    }, [drawingMode, getMousePos, toNorm, isInVideoArea]);

    const handleDoubleClick = useCallback((e) => {
        if (drawingMode !== 'roi') return;
        e.preventDefault();
        if (polygonPoints.length >= 3) {
            onZoneDrawn?.({ points: polygonPoints.map(p => [p.x, p.y]) });
        }
        setPolygonPoints([]);
    }, [drawingMode, polygonPoints, onZoneDrawn]);

    useEffect(() => {
        setLineStart(null);
        setLineEnd(null);
        setPolygonPoints([]);
        setMousePos(null);
    }, [drawingMode]);

    // --- Helpers ---
    const getZoneColor = (zone) => {
        const ztype = zone?.zone_type;
        return ZONE_COLORS[ztype] || ZONE_COLORS.default;
    };

    const getDrawingColor = () => {
        return ZONE_COLORS[drawingZoneType] || ZONE_COLORS.default;
    };

    // --- Render saved counting line ---
    const renderLine = (line, index) => {
        const pts = line.points || [];
        if (pts.length < 2) return null;
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
                    stroke="#facc15" strokeWidth="3" strokeDasharray="8,4" strokeLinecap="round" />
                <circle cx={arrowX} cy={arrowY} r="6" fill="#facc15" opacity="0.8" />
                <text x={arrowX} y={arrowY + 1} textAnchor="middle" dominantBaseline="middle"
                    fill="#000" fontSize="8" fontWeight="bold">IN</text>
                <text x={midX} y={midY - 10} textAnchor="middle" fill="#facc15"
                    fontSize="11" fontWeight="bold" style={{ textShadow: '1px 1px 2px rgba(0,0,0,0.8)' }}>
                    {line.name || `Line ${index + 1}`}
                </text>
                <circle cx={p1.x} cy={p1.y} r="5" fill="#facc15" stroke="#000" strokeWidth="1" />
                <circle cx={p2.x} cy={p2.y} r="5" fill="#facc15" stroke="#000" strokeWidth="1" />
            </g>
        );
    };

    // --- Render saved zone (colour-coded by type) ---
    const renderZone = (zone, index) => {
        const pts = zone.points || [];
        if (pts.length < 3) return null;

        const colors = getZoneColor(zone);
        const pixelPts = pts.map(p => toPx(p[0], p[1]));
        const pointsStr = pixelPts.map(p => `${p.x},${p.y}`).join(' ');
        const cx = pixelPts.reduce((s, p) => s + p.x, 0) / pixelPts.length;
        const cy = pixelPts.reduce((s, p) => s + p.y, 0) / pixelPts.length;

        const typeLabel = ZONE_TYPE_LABELS[zone.zone_type] || '';
        const zoneName = zone.name || `Zone ${index + 1}`;
        const displayLabel = typeLabel ? `${typeLabel}` : zoneName;

        // For standalone zones show people count
        const zoneCount = !zone.group_id ? (countingData?.zone_counts?.[zone.id] ?? '-') : null;

        return (
            <g key={`zone-${zone.id || index}`}>
                <polygon points={pointsStr}
                    fill={colors.fill} stroke={colors.stroke} strokeWidth="2" strokeDasharray="6,3" />
                {/* Zone label */}
                <rect x={cx - 45} y={cy - (zoneCount !== null ? 18 : 10)} width="90"
                    height={zoneCount !== null ? 36 : 22} rx="6" fill="rgba(0,0,0,0.65)" />
                <text x={cx} y={cy - (zoneCount !== null ? 4 : 0)} textAnchor="middle" fill={colors.label}
                    fontSize="10" fontWeight="bold">
                    {displayLabel}
                </text>
                {zoneCount !== null && (
                    <text x={cx} y={cy + 12} textAnchor="middle" fill="#fff" fontSize="12" fontWeight="bold">
                        {zoneCount} people
                    </text>
                )}
                {/* Vertex dots */}
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

        if (drawingMode === 'roi' && polygonPoints.length > 0) {
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
                const typeHint = drawingZoneType ? ` (${ZONE_TYPE_LABELS[drawingZoneType] || drawingZoneType})` : '';
                elements.push(
                    <text key="poly-hint" x={svgSize.width / 2} y={hintY}
                        textAnchor="middle" fill={drawColor.stroke} fontSize="12" fontWeight="bold"
                        style={{ textShadow: '1px 1px 2px rgba(0,0,0,0.8)' }}>
                        Double-click to close{typeHint} ({polygonPoints.length} points)
                    </text>
                );
            }
        }

        return elements;
    };

    const isCountingActive = countingData && countingData.total_in !== undefined;

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

            {zones.map((zone, i) => renderZone(zone, i))}
            {lines.map((line, i) => renderLine(line, i))}
            {renderDrawing()}

            {/* Live counting summary badge */}
            {isCountingActive && (
                <g>
                    <rect x={videoArea.offsetX + videoArea.displayW - 140}
                          y={videoArea.offsetY + videoArea.displayH - 50}
                          width="130" height="42" rx="8" fill="rgba(0,0,0,0.7)" />
                    <text x={videoArea.offsetX + videoArea.displayW - 125}
                          y={videoArea.offsetY + videoArea.displayH - 30}
                          fill="#22c55e" fontSize="12" fontWeight="bold">
                        IN: {countingData.total_in}
                    </text>
                    <text x={videoArea.offsetX + videoArea.displayW - 60}
                          y={videoArea.offsetY + videoArea.displayH - 30}
                          fill="#ef4444" fontSize="12" fontWeight="bold">
                        OUT: {countingData.total_out}
                    </text>
                    <text x={videoArea.offsetX + videoArea.displayW - 125}
                          y={videoArea.offsetY + videoArea.displayH - 14}
                          fill="#fff" fontSize="11">
                        Now: {countingData.occupancy ?? 0}
                    </text>
                </g>
            )}
        </svg>
    );
};

export default CountingCanvas;
