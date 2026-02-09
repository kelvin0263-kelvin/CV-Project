import React, { useRef, useEffect, useState, useCallback } from 'react';

/**
 * CountingCanvas - Interactive SVG overlay for drawing counting lines/zones
 * and displaying live counting data.
 *
 * Props:
 *   lines         - array of line configs [{id, name, points, direction}]
 *   zones         - array of zone configs [{id, name, points}]
 *   countingData  - live counting data from WebSocket {total_in, total_out, occupancy, zone_counts}
 *   drawingMode   - 'line' | 'roi' | null
 *   onLineDrawn   - callback({points, direction}) when a line is drawn
 *   onZoneDrawn   - callback({points}) when a zone polygon is closed
 *   containerRef  - ref to the video container for sizing
 */
const CountingCanvas = ({
    lines = [],
    zones = [],
    countingData = {},
    drawingMode = null,
    onLineDrawn,
    onZoneDrawn,
    containerRef,
}) => {
    const svgRef = useRef(null);
    const [svgSize, setSvgSize] = useState({ width: 640, height: 360 });

    // Drawing state
    const [lineStart, setLineStart] = useState(null); // normalised {x, y}
    const [lineEnd, setLineEnd] = useState(null);
    const [polygonPoints, setPolygonPoints] = useState([]); // array of normalised {x, y}
    const [mousePos, setMousePos] = useState(null); // normalised

    // Sync SVG size with container
    useEffect(() => {
        const updateSize = () => {
            if (containerRef?.current) {
                const rect = containerRef.current.getBoundingClientRect();
                setSvgSize({ width: rect.width, height: rect.height });
            }
        };
        updateSize();
        window.addEventListener('resize', updateSize);
        const interval = setInterval(updateSize, 500); // catch dynamic resizes
        return () => {
            window.removeEventListener('resize', updateSize);
            clearInterval(interval);
        };
    }, [containerRef]);

    // Convert pixel coords to normalised (0-1)
    const toNorm = useCallback((px, py) => {
        return {
            x: px / svgSize.width,
            y: py / svgSize.height,
        };
    }, [svgSize]);

    // Convert normalised to pixel
    const toPx = useCallback((nx, ny) => {
        return {
            x: nx * svgSize.width,
            y: ny * svgSize.height,
        };
    }, [svgSize]);

    // Get mouse position relative to SVG
    const getMousePos = useCallback((e) => {
        const svg = svgRef.current;
        if (!svg) return null;
        const rect = svg.getBoundingClientRect();
        return {
            px: e.clientX - rect.left,
            py: e.clientY - rect.top,
        };
    }, []);

    // Handle mouse move
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

    // Handle mouse down
    const handleMouseDown = useCallback((e) => {
        if (!drawingMode) return;
        const pos = getMousePos(e);
        if (!pos) return;
        const norm = toNorm(pos.px, pos.py);

        if (drawingMode === 'line') {
            setLineStart(norm);
            setLineEnd(norm);
        }
    }, [drawingMode, getMousePos, toNorm]);

    // Handle mouse up
    const handleMouseUp = useCallback((e) => {
        if (!drawingMode) return;

        if (drawingMode === 'line' && lineStart && lineEnd) {
            // Minimum distance check
            const dist = Math.hypot(lineEnd.x - lineStart.x, lineEnd.y - lineStart.y);
            if (dist > 0.02) {
                onLineDrawn?.({
                    points: [[lineStart.x, lineStart.y], [lineEnd.x, lineEnd.y]],
                    direction: 'left_to_right',
                });
            }
            setLineStart(null);
            setLineEnd(null);
        }
    }, [drawingMode, lineStart, lineEnd, onLineDrawn]);

    // Handle click for polygon drawing
    const handleClick = useCallback((e) => {
        if (drawingMode !== 'roi') return;
        const pos = getMousePos(e);
        if (!pos) return;
        const norm = toNorm(pos.px, pos.py);

        setPolygonPoints(prev => [...prev, norm]);
    }, [drawingMode, getMousePos, toNorm]);

    // Handle double-click to close polygon
    const handleDoubleClick = useCallback((e) => {
        if (drawingMode !== 'roi') return;
        e.preventDefault();

        if (polygonPoints.length >= 3) {
            onZoneDrawn?.({
                points: polygonPoints.map(p => [p.x, p.y]),
            });
        }
        setPolygonPoints([]);
    }, [drawingMode, polygonPoints, onZoneDrawn]);

    // Reset drawing state when mode changes
    useEffect(() => {
        setLineStart(null);
        setLineEnd(null);
        setPolygonPoints([]);
        setMousePos(null);
    }, [drawingMode]);

    // Render a saved counting line
    const renderLine = (line, index) => {
        const pts = line.points || [];
        if (pts.length < 2) return null;

        const p1 = toPx(pts[0][0], pts[0][1]);
        const p2 = toPx(pts[1][0], pts[1][1]);

        // Direction arrow
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy);
        // Perpendicular direction for arrow (indicates "in" direction)
        const perpX = -dy / len * 12;
        const perpY = dx / len * 12;
        const isLeftToRight = line.direction === 'left_to_right';
        const arrowX = midX + (isLeftToRight ? perpX : -perpX);
        const arrowY = midY + (isLeftToRight ? perpY : -perpY);

        return (
            <g key={`line-${line.id || index}`}>
                <line
                    x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
                    stroke="#facc15" strokeWidth="3" strokeDasharray="8,4"
                    strokeLinecap="round"
                />
                {/* Direction arrow */}
                <circle cx={arrowX} cy={arrowY} r="6" fill="#facc15" opacity="0.8" />
                <text x={arrowX} y={arrowY + 1} textAnchor="middle" dominantBaseline="middle"
                    fill="#000" fontSize="8" fontWeight="bold">IN</text>
                {/* Line label */}
                <text x={midX} y={midY - 10} textAnchor="middle" fill="#facc15"
                    fontSize="11" fontWeight="bold" style={{ textShadow: '1px 1px 2px rgba(0,0,0,0.8)' }}>
                    {line.name || `Line ${index + 1}`}
                </text>
                {/* Endpoint dots */}
                <circle cx={p1.x} cy={p1.y} r="5" fill="#facc15" stroke="#000" strokeWidth="1" />
                <circle cx={p2.x} cy={p2.y} r="5" fill="#facc15" stroke="#000" strokeWidth="1" />
            </g>
        );
    };

    // Render a saved zone
    const renderZone = (zone, index) => {
        const pts = zone.points || [];
        if (pts.length < 3) return null;

        const pixelPts = pts.map(p => toPx(p[0], p[1]));
        const pointsStr = pixelPts.map(p => `${p.x},${p.y}`).join(' ');

        // Center of zone for label
        const cx = pixelPts.reduce((s, p) => s + p.x, 0) / pixelPts.length;
        const cy = pixelPts.reduce((s, p) => s + p.y, 0) / pixelPts.length;

        const zoneCount = countingData?.zone_counts?.[zone.id] ?? '-';

        return (
            <g key={`zone-${zone.id || index}`}>
                <polygon
                    points={pointsStr}
                    fill="rgba(59, 130, 246, 0.15)"
                    stroke="#3b82f6" strokeWidth="2" strokeDasharray="6,3"
                />
                {/* Zone label */}
                <rect x={cx - 40} y={cy - 18} width="80" height="36" rx="6"
                    fill="rgba(0,0,0,0.6)" />
                <text x={cx} y={cy - 4} textAnchor="middle" fill="#3b82f6"
                    fontSize="10" fontWeight="bold">
                    {zone.name || `Zone ${index + 1}`}
                </text>
                <text x={cx} y={cy + 12} textAnchor="middle" fill="#fff"
                    fontSize="12" fontWeight="bold">
                    {zoneCount} people
                </text>
                {/* Vertex dots */}
                {pixelPts.map((p, i) => (
                    <circle key={i} cx={p.x} cy={p.y} r="4" fill="#3b82f6" stroke="#fff" strokeWidth="1" />
                ))}
            </g>
        );
    };

    // Render active drawing
    const renderDrawing = () => {
        const elements = [];

        // Drawing a line
        if (drawingMode === 'line' && lineStart && lineEnd) {
            const p1 = toPx(lineStart.x, lineStart.y);
            const p2 = toPx(lineEnd.x, lineEnd.y);
            elements.push(
                <line key="draw-line"
                    x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
                    stroke="#facc15" strokeWidth="3" strokeDasharray="4,4" opacity="0.7"
                />
            );
        }

        // Drawing a polygon
        if (drawingMode === 'roi' && polygonPoints.length > 0) {
            const pixelPts = polygonPoints.map(p => toPx(p.x, p.y));

            // Draw completed edges
            for (let i = 0; i < pixelPts.length - 1; i++) {
                elements.push(
                    <line key={`poly-edge-${i}`}
                        x1={pixelPts[i].x} y1={pixelPts[i].y}
                        x2={pixelPts[i + 1].x} y2={pixelPts[i + 1].y}
                        stroke="#3b82f6" strokeWidth="2" strokeDasharray="4,4"
                    />
                );
            }

            // Draw line from last point to mouse
            if (mousePos) {
                const last = pixelPts[pixelPts.length - 1];
                const mouse = toPx(mousePos.x, mousePos.y);
                elements.push(
                    <line key="poly-preview"
                        x1={last.x} y1={last.y} x2={mouse.x} y2={mouse.y}
                        stroke="#3b82f6" strokeWidth="2" strokeDasharray="2,2" opacity="0.5"
                    />
                );
            }

            // Draw vertices
            pixelPts.forEach((p, i) => {
                elements.push(
                    <circle key={`poly-vert-${i}`}
                        cx={p.x} cy={p.y} r="5"
                        fill="#3b82f6" stroke="#fff" strokeWidth="1.5"
                    />
                );
            });

            // Hint text
            if (polygonPoints.length >= 3) {
                elements.push(
                    <text key="poly-hint" x={svgSize.width / 2} y={20}
                        textAnchor="middle" fill="#3b82f6" fontSize="12" fontWeight="bold"
                        style={{ textShadow: '1px 1px 2px rgba(0,0,0,0.8)' }}>
                        Double-click to close polygon ({polygonPoints.length} points)
                    </text>
                );
            }
        }

        return elements;
    };

    return (
        <svg
            ref={svgRef}
            className="absolute inset-0 w-full h-full"
            style={{
                pointerEvents: drawingMode ? 'auto' : 'none',
                cursor: drawingMode === 'line' ? 'crosshair' : drawingMode === 'roi' ? 'crosshair' : 'default',
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
            {/* Saved zones */}
            {zones.map((zone, i) => renderZone(zone, i))}

            {/* Saved lines */}
            {lines.map((line, i) => renderLine(line, i))}

            {/* Active drawing */}
            {renderDrawing()}

            {/* Live counting summary badge */}
            {countingData && (countingData.total_in > 0 || countingData.total_out > 0) && (
                <g>
                    <rect x={svgSize.width - 140} y={svgSize.height - 50} width="130" height="42" rx="8"
                        fill="rgba(0,0,0,0.7)" />
                    <text x={svgSize.width - 125} y={svgSize.height - 30} fill="#22c55e" fontSize="12" fontWeight="bold">
                        IN: {countingData.total_in}
                    </text>
                    <text x={svgSize.width - 60} y={svgSize.height - 30} fill="#ef4444" fontSize="12" fontWeight="bold">
                        OUT: {countingData.total_out}
                    </text>
                    <text x={svgSize.width - 125} y={svgSize.height - 14} fill="#fff" fontSize="11">
                        Occupancy: {countingData.occupancy ?? 0}
                    </text>
                </g>
            )}
        </svg>
    );
};

export default CountingCanvas;
