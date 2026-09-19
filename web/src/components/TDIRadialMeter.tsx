/**
 * web/components/TDIRadialMeter.tsx
 *
 * Motion-driven SVG semi-circular arc gauge for the Thrash Danger Index (TDI).
 * Animates strokeDashoffset via framer-motion with duration: 0.7s to settle before the next 1Hz tick.
 * Features a glowing background layer shifting from Emerald to Amber to Crimson.
 */

import React from "react";
import { motion } from "framer-motion";
import { AnimatedMetric } from "./AnimatedMetric";

interface TDIRadialMeterProps {
  tdi: number;
}

export function TDIRadialMeter({ tdi }: TDIRadialMeterProps) {
  const clamped = Math.max(0, Math.min(1, tdi));

  // Color dynamic interpolation
  const color = clamped >= 0.90 ? "#f43f5e" : clamped >= 0.75 ? "#f59e0b" : "#10b981";
  const glowColor = clamped >= 0.90 ? "rgba(244, 63, 94, 0.45)" : clamped >= 0.75 ? "rgba(245, 158, 11, 0.35)" : "rgba(16, 185, 129, 0.25)";
  const statusLabel = clamped >= 0.90 ? "CRITICAL THRASH IMMINENT" : clamped >= 0.75 ? "ELEVATED PRESSURE WARNING" : "NOMINAL TELEMETRY";

  // Semi-circle Arc parameters: Radius 85, Center (120, 115)
  // Arc spans from 180° (x: 35, y: 115) to 0° (x: 205, y: 115)
  const radius = 85;
  const strokeWidth = 14;
  const arcLength = Math.PI * radius; // ~267.035
  const strokeDashoffset = arcLength * (1 - clamped);

  return (
    <div className="relative flex flex-col items-center justify-center p-4 select-none">
      <svg
        viewBox="0 0 240 140"
        className="w-full max-w-[280px] overflow-visible"
        aria-label={`Thrash Danger Index: ${(clamped * 100).toFixed(1)}%`}
      >
        <defs>
          <filter id="tdi-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="8" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>

        {/* Inactive Background Track Arc */}
        <path
          d="M 35 115 A 85 85 0 0 1 205 115"
          fill="none"
          stroke="#27272a"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />

        {/* Graduations / Threshold tick marks */}
        <path
          d="M 35 115 A 85 85 0 0 1 205 115"
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={strokeWidth}
          strokeDasharray="2 12"
        />

        {/* Glowing layer behind active stroke */}
        <motion.path
          d="M 35 115 A 85 85 0 0 1 205 115"
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth + 6}
          strokeLinecap="round"
          strokeDasharray={arcLength}
          animate={{
            strokeDashoffset,
            stroke: color,
            opacity: clamped >= 0.75 ? 0.65 : 0.25,
          }}
          transition={{ duration: 0.7, ease: "easeOut" }}
          filter="url(#tdi-glow)"
        />

        {/* Active Primary Meter Arc */}
        <motion.path
          d="M 35 115 A 85 85 0 0 1 205 115"
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={arcLength}
          animate={{
            strokeDashoffset,
            stroke: color,
          }}
          transition={{ duration: 0.7, ease: "easeOut" }}
        />

        {/* Scale labels */}
        <text x="35" y="134" textAnchor="middle" className="text-[10px] font-mono fill-zinc-500">0.0</text>
        <text x="120" y="24" textAnchor="middle" className="text-[10px] font-mono fill-zinc-500">0.5</text>
        <text x="176" y="48" textAnchor="middle" className="text-[10px] font-mono fill-amber-500/90 font-semibold">0.75</text>
        <text x="205" y="134" textAnchor="middle" className="text-[10px] font-mono fill-zinc-500">1.0</text>
      </svg>

      {/* Central Readout */}
      <div className="absolute top-[46px] flex flex-col items-center text-center pointer-events-none">
        <span className="text-[11px] font-mono uppercase tracking-widest text-zinc-400 font-medium">
          Thrash Index
        </span>
        <div
          className="text-4xl sm:text-5xl font-mono font-bold tracking-tight mt-0.5"
          style={{ color, textShadow: `0 0 24px ${glowColor}` }}
        >
          <AnimatedMetric value={clamped} precision={2} />
        </div>
        <motion.div
          animate={{ scale: clamped >= 0.90 ? [1, 1.05, 1] : 1 }}
          transition={{ repeat: clamped >= 0.90 ? Infinity : 0, duration: 1.2 }}
          className="mt-1 px-2.5 py-0.5 rounded-full text-[10px] font-mono font-semibold uppercase tracking-wider border"
          style={{
            color,
            borderColor: `${color}40`,
            backgroundColor: `${color}15`,
          }}
        >
          {statusLabel}
        </motion.div>
      </div>
    </div>
  );
}

export default TDIRadialMeter;
