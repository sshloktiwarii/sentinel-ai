/**
 * web/src/components/RunawayRadar.tsx
 *
 * Minimalist Linear/Apple micro-pulse radar dot for Token Velocity & Loop Tripwire.
 * Replaces the heavy submarine banner with a subtle, elegant micro-indicator
 * positioned directly adjacent to the TPS metric readout.
 * Only animates when tps > 0 (active) or runaway_detected == true (alert).
 */

import React from "react";
import { motion } from "framer-motion";

interface RunawayRadarProps {
  isRunaway: boolean;
  burnRateStatus?: "nominal" | "elevated" | "runaway";
  reason?: string;
  tps?: number;
  rpm?: number;
  className?: string;
}

export function RunawayRadar({
  isRunaway,
  burnRateStatus = "nominal",
  reason,
  tps = 0,
  rpm = 0,
  className = "",
}: RunawayRadarProps) {
  const isActive = tps > 0 || rpm > 0;

  if (isRunaway) {
    return (
      <div className={`inline-flex items-center gap-1.5 ${className}`} title={reason || "Runaway recursive loop tripwire triggered"}>
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-rose-500 shadow-[0_0_8px_#f43f5e]" />
        </span>
        <span className="text-[10px] font-mono font-semibold text-rose-400 uppercase tracking-wide">
          Runaway Alert
        </span>
      </div>
    );
  }

  if (isActive) {
    return (
      <div className={`inline-flex items-center gap-1.5 ${className}`} title={`Active inference: ${tps.toFixed(1)} TPS`}>
        <span className="relative flex h-2 w-2">
          <motion.span
            animate={{ scale: [1, 1.4, 1], opacity: [0.4, 0.9, 0.4] }}
            transition={{ repeat: Infinity, duration: 1.8, ease: "easeInOut" }}
            className="absolute inline-flex h-full w-full rounded-full bg-indigo-400"
          />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500" />
        </span>
        <span className="text-[10px] font-mono text-zinc-400 uppercase tracking-wide">
          Active
        </span>
      </div>
    );
  }

  // Idle state: completely neutral, static, zero distraction
  return (
    <div className={`inline-flex items-center gap-1.5 ${className}`} title="Agent burn rate idle (0 TPS)">
      <span className="inline-flex rounded-full h-1.5 w-1.5 bg-zinc-600" />
      <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-wide">
        Idle
      </span>
    </div>
  );
}

export default RunawayRadar;
