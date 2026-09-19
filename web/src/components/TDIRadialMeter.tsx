/**
 * web/src/components/TDIRadialMeter.tsx
 *
 * Minimalist Linear/Apple precision radial ring gauge for Thrash Danger Index (TDI).
 * Ultra-thin 4px SVG precision arc with neutral zinc styling during idle state.
 * Color only surfaces under elevated pressure (amber at >=0.75, crimson at >=0.90).
 */

import React from "react";
import { motion } from "framer-motion";
import { AnimatedMetric } from "./AnimatedMetric";

interface TDIRadialMeterProps {
  tdi: number;
}

export function TDIRadialMeter({ tdi }: TDIRadialMeterProps) {
  const clamped = Math.max(0, Math.min(1, tdi));

  // Color discipline: neutral zinc below 0.50, amber at 0.75, crimson at 0.90
  const isCritical = clamped >= 0.90;
  const isWarning = clamped >= 0.75 && clamped < 0.90;
  const isModerate = clamped >= 0.50 && clamped < 0.75;

  const strokeColor = isCritical
    ? "#f43f5e"
    : isWarning
    ? "#f59e0b"
    : isModerate
    ? "#a1a1aa"
    : "#71717a";

  const numColor = isCritical
    ? "text-rose-400"
    : isWarning
    ? "text-amber-400"
    : "text-zinc-100";

  const statusText = isCritical
    ? "Critical Thrash"
    : isWarning
    ? "Pressure Warning"
    : isModerate
    ? "Elevated"
    : "Nominal";

  const statusBadge = isCritical
    ? "text-rose-400 border-rose-500/40 bg-rose-500/10 animate-pulse"
    : isWarning
    ? "text-amber-400 border-amber-500/30 bg-amber-500/10"
    : isModerate
    ? "text-zinc-300 border-zinc-700/60 bg-zinc-800/40"
    : "text-zinc-500 border-zinc-800/80 bg-zinc-900/40";

  // Precision 240° arc parameters: Center (80, 72), Radius 54
  // Arc length = (240 / 360) * 2 * PI * 54 = 226.195
  const arcLength = 226.2;
  const strokeDashoffset = arcLength * (1 - clamped);

  return (
    <div className="relative flex flex-col items-center justify-center select-none py-1">
      <div className="relative w-48 h-40 flex items-center justify-center">
        <svg
          viewBox="0 0 160 144"
          className="w-full h-full overflow-visible"
          aria-label={`Thrash Danger Index: ${(clamped * 100).toFixed(1)}%`}
        >
          <defs>
            {/* Subtle glow filter only activated during critical thrash states */}
            {isCritical && (
              <filter id="tdi-alert-glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            )}
          </defs>

          {/* Precision 4px Inactive Background Track */}
          <path
            d="M 33.2 99 A 54 54 0 1 1 126.8 99"
            fill="none"
            stroke="#27272a"
            strokeWidth={4}
            strokeLinecap="round"
          />

          {/* Minimal Threshold Indicator Dots on Track */}
          {/* 0.75 threshold mark */}
          <circle cx="122.4" cy="45.5" r="1.5" fill="#3f3f46" />
          {/* 0.90 threshold mark */}
          <circle cx="126.5" cy="74.2" r="1.5" fill="#3f3f46" />

          {/* Active Precision Stroke (stroke-width: 4px) */}
          <motion.path
            d="M 33.2 99 A 54 54 0 1 1 126.8 99"
            fill="none"
            stroke={strokeColor}
            strokeWidth={4}
            strokeLinecap="round"
            strokeDasharray={arcLength}
            animate={{
              strokeDashoffset,
              stroke: strokeColor,
            }}
            transition={{ duration: 0.7, ease: "easeOut" }}
            filter={isCritical ? "url(#tdi-alert-glow)" : undefined}
          />
        </svg>

        {/* Central High-Density Readout */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pt-2 pointer-events-none">
          <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 font-medium">
            TDI
          </span>
          <div className={`font-mono text-3xl font-semibold tracking-tight tabular-nums ${numColor}`}>
            <AnimatedMetric value={clamped} precision={2} />
          </div>
          <div className={`mt-1.5 px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider border ${statusBadge}`}>
            {statusText}
          </div>
        </div>
      </div>

      {/* Subtle Scale Reference Footer */}
      <div className="flex items-center justify-between w-44 text-[10px] font-mono text-zinc-500 px-2 -mt-2">
        <span>0.0</span>
        <span className={clamped >= 0.75 ? "text-amber-500/80 font-medium" : "text-zinc-600"}>0.75</span>
        <span className={clamped >= 0.90 ? "text-rose-500/80 font-medium" : "text-zinc-600"}>0.90</span>
        <span>1.0</span>
      </div>
    </div>
  );
}

export default TDIRadialMeter;
