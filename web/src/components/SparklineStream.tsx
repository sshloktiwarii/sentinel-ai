/**
 * web/components/SparklineStream.tsx
 *
 * 60-second sliding-window sparkline with smooth SVG cubic bezier curve interpolation,
 * subtle gradient underfill, threshold reference tripwires, and interactive hover crosshairs.
 */

import React, { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { AnimatedMetric } from "./AnimatedMetric";

export interface DataPoint {
  t: string;
  val: number;
}

interface SparklineStreamProps {
  data: DataPoint[];
  color: string;
  unit: string;
  title: string;
  minVal?: number;
  maxVal?: number;
  warningLine?: number;
  criticalLine?: number;
  currentVal?: number | string;
  gradientId?: string;
}

/**
 * Generate smooth cubic bezier SVG path commands for an array of (x, y) points.
 */
function getCubicBezierPath(points: Array<{ x: number; y: number }>, tension = 0.2): string {
  if (points.length <= 1) return "";
  if (points.length === 2) {
    return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)} L ${points[1].x.toFixed(1)} ${points[1].y.toFixed(1)}`;
  }

  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i > 0 ? i - 1 : i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1];

    const cp1x = p1.x + (p2.x - p0.x) * tension;
    const cp1y = p1.y + (p2.y - p0.y) * tension;
    const cp2x = p2.x - (p3.x - p1.x) * tension;
    const cp2y = p2.y - (p3.y - p1.y) * tension;

    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }

  return d;
}

export function SparklineStream({
  data,
  color,
  unit,
  title,
  minVal = 0,
  maxVal,
  warningLine,
  criticalLine,
  currentVal,
  gradientId = "sparkline-grad",
}: SparklineStreamProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const points = useMemo(() => {
    if (!data || data.length === 0) return [];
    return data.map((d) => d.val);
  }, [data]);

  const height = 130;
  const width = 600;
  const padTop = 16;
  const padBottom = 22;
  const padLeft = 12;
  const padRight = 12;
  const chartH = height - padTop - padBottom;
  const chartW = width - padLeft - padRight;

  const yMax = useMemo(() => {
    if (maxVal !== undefined) return maxVal;
    const computedMax = Math.max(...points, 0.001);
    return computedMax * 1.15;
  }, [points, maxVal]);

  const yMin = minVal;

  const getX = (idx: number, total: number) => {
    if (total <= 1) return padLeft;
    return padLeft + (idx / (total - 1)) * chartW;
  };

  const getY = (val: number) => {
    const norm = Math.max(0, Math.min(1, (val - yMin) / (yMax - yMin)));
    return padTop + (1 - norm) * chartH;
  };

  const { pathD, areaD, coords } = useMemo(() => {
    if (points.length === 0) return { pathD: "", areaD: "", coords: [] };
    const pts = points.map((val, i) => ({
      x: getX(i, points.length),
      y: getY(val),
      val,
      time: data[i]?.t || "",
    }));

    const pathString = getCubicBezierPath(pts);
    const lastX = pts[pts.length - 1].x;
    const firstX = pts[0].x;
    const bottomY = padTop + chartH;
    const areaString = `${pathString} L ${lastX.toFixed(1)} ${bottomY.toFixed(1)} L ${firstX.toFixed(1)} ${bottomY.toFixed(1)} Z`;

    return { pathD: pathString, areaD: areaString, coords: pts };
  }, [points, yMax, yMin, data]);

  const hoveredPoint = hoverIndex !== null && coords[hoverIndex] ? coords[hoverIndex] : null;

  return (
    <div className="telemetry-card p-4 flex flex-col justify-between select-none">
      {/* Sparkline Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full shadow-sm" style={{ backgroundColor: color }} />
          <span className="text-xs font-mono uppercase tracking-wider text-zinc-400 font-medium">
            {title}
          </span>
        </div>
        <div className="flex items-baseline gap-1.5 font-mono">
          <span className="text-lg font-bold text-zinc-100 tabular-nums">
            {hoveredPoint ? (
              hoveredPoint.val.toFixed(2)
            ) : typeof currentVal === "number" ? (
              <AnimatedMetric value={currentVal} precision={2} />
            ) : (
              currentVal ?? "—"
            )}
          </span>
          <span className="text-xs text-zinc-500 font-normal">{unit}</span>
          {hoveredPoint && (
            <span className="text-[10px] text-zinc-300 ml-2 px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700">
              {hoveredPoint.time}
            </span>
          )}
        </div>
      </div>

      {/* SVG Path Canvas */}
      <div className="relative w-full h-[130px]">
        {points.length > 1 ? (
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="w-full h-full cursor-crosshair overflow-visible"
            onMouseLeave={() => setHoverIndex(null)}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const relX = (e.clientX - rect.left) / rect.width;
              const idx = Math.round(relX * (points.length - 1));
              setHoverIndex(Math.max(0, Math.min(points.length - 1, idx)));
            }}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.25" />
                <stop offset="100%" stopColor={color} stopOpacity="0.0" />
              </linearGradient>
            </defs>

            {/* Subtle Gridlines */}
            <line x1={padLeft} y1={padTop} x2={width - padRight} y2={padTop} stroke="#27272a" strokeDasharray="3 3" />
            <line x1={padLeft} y1={padTop + chartH / 2} x2={width - padRight} y2={padTop + chartH / 2} stroke="#27272a" strokeDasharray="3 3" />
            <line x1={padLeft} y1={padTop + chartH} x2={width - padRight} y2={padTop + chartH} stroke="#27272a" />

            {/* Threshold reference lines */}
            {warningLine !== undefined && warningLine <= yMax && (
              <g>
                <line
                  x1={padLeft}
                  y1={getY(warningLine)}
                  x2={width - padRight}
                  y2={getY(warningLine)}
                  stroke="#f59e0b"
                  strokeDasharray="4 4"
                  strokeWidth="1.2"
                  opacity="0.8"
                />
                <text
                  x={width - padRight - 4}
                  y={getY(warningLine) - 4}
                  textAnchor="end"
                  className="text-[9px] font-mono fill-amber-500/80"
                >
                  WARN {warningLine}
                </text>
              </g>
            )}
            {criticalLine !== undefined && criticalLine <= yMax && (
              <g>
                <line
                  x1={padLeft}
                  y1={getY(criticalLine)}
                  x2={width - padRight}
                  y2={getY(criticalLine)}
                  stroke="#f43f5e"
                  strokeDasharray="4 4"
                  strokeWidth="1.2"
                  opacity="0.8"
                />
                <text
                  x={width - padRight - 4}
                  y={getY(criticalLine) - 4}
                  textAnchor="end"
                  className="text-[9px] font-mono fill-rose-500/80"
                >
                  CRIT {criticalLine}
                </text>
              </g>
            )}

            {/* Underfill Area */}
            <path d={areaD} fill={`url(#${gradientId})`} />

            {/* Smooth Cubic Bezier Stroke */}
            <path
              d={pathD}
              fill="none"
              stroke={color}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {/* Interactive Crosshair & Cursor Point */}
            {hoveredPoint && (
              <>
                <line
                  x1={hoveredPoint.x}
                  y1={padTop}
                  x2={hoveredPoint.x}
                  y2={padTop + chartH}
                  stroke="#71717a"
                  strokeWidth="1"
                  strokeDasharray="2 2"
                />
                <circle
                  cx={hoveredPoint.x}
                  cy={hoveredPoint.y}
                  r="4.5"
                  fill={color}
                  stroke="#09090b"
                  strokeWidth="2.5"
                />
              </>
            )}
          </svg>
        ) : (
          <div className="h-full flex items-center justify-center text-xs font-mono text-zinc-600">
            Awaiting sliding-window telemetry…
          </div>
        )}
      </div>

      {/* Axis Bounds */}
      <div className="flex justify-between items-center text-[10px] font-mono text-zinc-500 mt-1">
        <span>{data[0]?.t || "—"}</span>
        <span>{data[data.length - 1]?.t || "Live (1s)"}</span>
      </div>
    </div>
  );
}

export default SparklineStream;
