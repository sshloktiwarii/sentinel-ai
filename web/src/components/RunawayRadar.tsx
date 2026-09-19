/**
 * web/components/RunawayRadar.tsx
 *
 * Ambient radar sweep & expanding sonar pulse component.
 * Displays real-time loop detection state and triggers visual radar pulses
 * when runaway agent loops are detected.
 */

import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ShieldAlert, Zap, CheckCircle2 } from "lucide-react";

interface RunawayRadarProps {
  isRunaway: boolean;
  burnRateStatus: "nominal" | "elevated" | "runaway";
  reason?: string;
  tps?: number;
  rpm?: number;
}

export function RunawayRadar({
  isRunaway,
  burnRateStatus,
  reason,
  tps = 0,
  rpm = 0,
}: RunawayRadarProps) {
  const isWarning = burnRateStatus === "elevated" || isRunaway;

  return (
    <div className="relative overflow-hidden rounded-xl border p-4 transition-all duration-300 bg-zinc-900/60 backdrop-blur-md"
      style={{
        borderColor: isRunaway ? "rgba(244, 63, 94, 0.7)" : isWarning ? "rgba(245, 158, 11, 0.5)" : "rgba(39, 39, 42, 0.8)",
      }}
    >
      {/* Background Expanding Radar Waves when Runaway is active */}
      <AnimatePresence>
        {isRunaway && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center overflow-hidden">
            {[0, 0.6, 1.2].map((delay, i) => (
              <motion.div
                key={i}
                initial={{ scale: 0.5, opacity: 0.7 }}
                animate={{ scale: 2.8, opacity: 0 }}
                transition={{
                  repeat: Infinity,
                  duration: 2.2,
                  delay,
                  ease: "easeOut",
                }}
                className="absolute w-36 h-36 rounded-full border border-rose-500/60 bg-rose-500/10"
              />
            ))}
          </div>
        )}
      </AnimatePresence>

      <div className="relative z-10 flex items-start justify-between gap-4">
        {/* Left Status & Info */}
        <div className="space-y-1.5 flex-1">
          <div className="flex items-center gap-2">
            <div className="relative flex items-center justify-center">
              {isRunaway ? (
                <ShieldAlert className="w-4 h-4 text-rose-400" />
              ) : isWarning ? (
                <Zap className="w-4 h-4 text-amber-400" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              )}
            </div>
            <span className="text-xs font-mono font-semibold uppercase tracking-wider text-zinc-300">
              Agent Loop Radar
            </span>

            {/* Dynamic Status Badge */}
            <span
              className={`text-[10px] font-mono px-2 py-0.5 rounded-full uppercase font-bold border transition-colors ${
                isRunaway
                  ? "bg-rose-500/20 border-rose-500/50 text-rose-300 animate-pulse"
                  : isWarning
                  ? "bg-amber-500/15 border-amber-500/40 text-amber-300"
                  : "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
              }`}
            >
              {isRunaway ? "RUNAWAY ACTIVE" : burnRateStatus.toUpperCase()}
            </span>
          </div>

          <p className="text-xs font-mono text-zinc-400 leading-relaxed">
            {isRunaway
              ? reason || "Recursive inference loop triggered: Sustained high token burn rate or request flood with zero backoff."
              : isWarning
              ? "Elevated agent activity detected: Approaching runaway tripwire thresholds."
              : "Continuous 60s sliding window monitoring token burn (TPS) and request frequency (RPM)."}
          </p>

          <div className="flex items-center gap-4 text-[11px] font-mono text-zinc-500 pt-1 tabular-nums">
            <span>Burn: <strong className="text-zinc-300">{tps.toFixed(1)} TPS</strong></span>
            <span>•</span>
            <span>Freq: <strong className="text-zinc-300">{rpm.toFixed(1)} RPM</strong></span>
          </div>
        </div>

        {/* Right Radar Reticle */}
        <div className="relative w-16 h-16 shrink-0 rounded-full border border-zinc-800 bg-zinc-950/80 flex items-center justify-center shadow-inner">
          {/* Concentric rings */}
          <div className="absolute w-12 h-12 rounded-full border border-zinc-800/80" />
          <div className="absolute w-6 h-6 rounded-full border border-zinc-800/60" />
          <div className="absolute w-full h-[1px] bg-zinc-800/40" />
          <div className="absolute h-full w-[1px] bg-zinc-800/40" />

          {/* Rotating Radar Sweep Needle */}
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, duration: isRunaway ? 1.0 : 3.0, ease: "linear" }}
            className="absolute inset-0 flex items-center justify-center pointer-events-none"
          >
            <div
              className={`w-[1px] h-8 origin-bottom ${
                isRunaway ? "bg-rose-500 shadow-[0_0_8px_#f43f5e]" : "bg-cyan-400/80 shadow-[0_0_6px_#38bdf8]"
              }`}
              style={{ transform: "translateY(-50%)" }}
            />
          </motion.div>

          {/* Center blip */}
          <div className={`w-2 h-2 rounded-full z-10 ${
            isRunaway ? "bg-rose-500 shadow-[0_0_10px_#f43f5e]" : "bg-emerald-400"
          }`} />
        </div>
      </div>
    </div>
  );
}

export default RunawayRadar;
