/**
 * web/src/pages/index.tsx
 *
 * Sentinel-AI — Motion-Driven Telemetry & Agent Quota Canvas
 * Linear / Raycast inspired design language with deep zinc palette (#09090b),
 * framer-motion staggered container, TDIRadialMeter, RunawayRadar, and smooth SparklineStream.
 */

import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";
import Head from "next/head";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  Cpu,
  Zap,
  HardDrive,
  Shield,
  Play,
  Pause,
  RotateCw,
  Info,
  Clock,
  Layers,
  AlertTriangle,
  Server,
  Sliders,
} from "lucide-react";

import { TDIRadialMeter } from "@/components/TDIRadialMeter";
import { AnimatedMetric } from "@/components/AnimatedMetric";
import { RunawayRadar } from "@/components/RunawayRadar";
import { SparklineStream } from "@/components/SparklineStream";

/* ── Constants & Endpoints ────────────────────────────────────────────── */
const API_BASE = "http://127.0.0.1:8000";
const WS_URL   = "ws://127.0.0.1:8000/ws/telemetry";
const MAX_LIVE_POINTS = 60;
const BASE_RETRY_MS   = 1000;
const MAX_RETRY_MS    = 16000;

/* ── Animation Variants ───────────────────────────────────────────────── */
const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.08,
      delayChildren: 0.04,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 8 },
  show: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.4,
      ease: [0.16, 1, 0.3, 1] as [number, number, number, number],
    },
  },
};

/* ── Types ────────────────────────────────────────────────────────────── */
type ConnectionStatus = "connected" | "reconnecting" | "disconnected";
type TimeWindow = "1m" | "5m" | "1h";
type DashboardTab = "telemetry" | "quotas" | "engines" | "spikes" | "config";

interface VelocityMetrics {
  tps: number;
  tpm: number;
  rpm: number;
  burn_rate_status: "nominal" | "elevated" | "runaway";
  runaway_detected: boolean;
  reason?: string;
}

interface TelemetryFrame {
  timestamp: number;
  wired_mb: number;
  limit_mb: number;
  swap_total_mb: number;
  swap_used_mb: number;
  pageouts: number;
  thrash_index: number;
  engine_active?: boolean;
  kv_cache_mb?: number;
  kv_pressure_pct?: number;
  velocity?: VelocityMetrics;
  is_apple_silicon?: boolean;
}

interface ChartPoint {
  t: string;
  ts: number;
  wired_mb: number;
  swap_used_mb: number;
  pageouts: number;
  thrash_index: number;
  tps: number;
  rpm: number;
}

interface SpikeRecord {
  timestamp: number;
  thrash_index: number;
  wired_mb: number;
  swap_used_mb: number;
  pageouts: number;
}

interface QuotaRecord {
  id: string;
  provider: string;
  model: string;
  remaining_pct: number;
  tokens_left: string;
  resets_in: string;
  status: "healthy" | "warning" | "exhausted";
}

interface EngineModel {
  name: string;
  size_gb: number;
  kv_cache_mb: number;
  context_length: number;
  status: "loaded" | "unloading" | "idle";
}

interface EngineData {
  engines: Array<{
    name: string;
    port: number;
    active: boolean;
    models: EngineModel[];
  }>;
  total_kv_cache_mb: number;
  kv_pressure_pct: number;
  summary: string;
}

interface ConfigData {
  proxy_url: string;
  poll_interval_seconds: number;
  tdi_warning_threshold: number;
  tdi_critical_threshold: number;
  velocity_alert_tps: number;
  velocity_alert_rpm: number;
  notification_debounce_seconds: number;
  swap_limit_ratio: number;
}

/* ── Formatting Helpers ───────────────────────────────────────────────── */
function fmtMB(mb: number): string {
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  return `${Math.round(mb).toLocaleString()} MB`;
}

function fmtNum(n: number): string {
  return Math.round(n).toLocaleString();
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toTimeString().slice(0, 8);
}

function toChartPoint(f: TelemetryFrame): ChartPoint {
  return {
    t: fmtTime(f.timestamp),
    ts: f.timestamp,
    wired_mb: Math.round(f.wired_mb * 10) / 10,
    swap_used_mb: Math.round(f.swap_used_mb * 10) / 10,
    pageouts: f.pageouts,
    thrash_index: Math.round(f.thrash_index * 1000) / 1000,
    tps: f.velocity?.tps ?? 0,
    rpm: f.velocity?.rpm ?? 0,
  };
}

/* ══════════════════════════════════════════════════════════════════════
   MAIN APPLICATION COMPONENT
══════════════════════════════════════════════════════════════════════ */
export default function Home() {
  const [liveHistory, setLiveHistory] = useState<ChartPoint[]>([]);
  const [latest, setLatest] = useState<TelemetryFrame | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<DashboardTab>("telemetry");
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("1m");
  const [historyData, setHistoryData] = useState<ChartPoint[]>([]);
  const [quotas, setQuotas] = useState<QuotaRecord[]>([]);
  const [engines, setEngines] = useState<EngineData | null>(null);
  const [spikes, setSpikes] = useState<SpikeRecord[]>([]);
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(BASE_RETRY_MS);
  const isPausedRef = useRef(isPaused);
  isPausedRef.current = isPaused;

  /* ── REST Data Fetching ── */
  const fetchREST = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const [qRes, eRes, sRes, cRes] = await Promise.all([
        fetch(`${API_BASE}/api/quotas`).then((r) => r.json()).catch(() => []),
        fetch(`${API_BASE}/api/engines`).then((r) => r.json()).catch(() => null),
        fetch(`${API_BASE}/api/spikes`).then((r) => r.json()).catch(() => []),
        fetch(`${API_BASE}/api/config`).then((r) => r.json()).catch(() => null),
      ]);

      if (Array.isArray(qRes)) setQuotas(qRes);
      if (eRes) setEngines(eRes);
      if (Array.isArray(sRes)) setSpikes(sRes);
      if (cRes) setConfig(cRes);
    } catch {
      // ignore transient fetch errors
    } finally {
      setTimeout(() => setIsRefreshing(false), 400);
    }
  }, []);

  const fetchHistory = useCallback(async (win: TimeWindow) => {
    if (win === "1m") return;
    try {
      const res = await fetch(`${API_BASE}/api/history?window=${win}`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setHistoryData(
          data.map((item: any) => ({
            t: fmtTime(item.timestamp || item.bucket_ts || 0),
            ts: item.timestamp || item.bucket_ts || 0,
            wired_mb: item.avg_wired_mb ?? item.wired_mb ?? 0,
            swap_used_mb: item.avg_swap_used_mb ?? item.swap_used_mb ?? 0,
            pageouts: item.max_pageouts ?? item.pageouts ?? 0,
            thrash_index: item.max_thrash_index ?? item.thrash_index ?? 0,
            tps: 0,
            rpm: 0,
          }))
        );
      }
    } catch {
      // skip
    }
  }, []);

  useEffect(() => {
    fetchREST();
    const timer = setInterval(fetchREST, 15000);
    return () => clearInterval(timer);
  }, [fetchREST]);

  useEffect(() => {
    fetchHistory(timeWindow);
  }, [timeWindow, fetchHistory]);

  /* ── WebSocket Telemetry Stream ── */
  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    setStatus((s) => (s === "connected" ? "reconnecting" : s));
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      retryDelayRef.current = BASE_RETRY_MS;
      setStatus("connected");
    };

    ws.onmessage = (evt: MessageEvent<string>) => {
      if (isPausedRef.current) return;
      try {
        const frame: TelemetryFrame = JSON.parse(evt.data);
        setLatest(frame);
        setLiveHistory((prev) => {
          const pt = toChartPoint(frame);
          const next = [...prev, pt];
          return next.length > MAX_LIVE_POINTS ? next.slice(-MAX_LIVE_POINTS) : next;
        });
      } catch {
        // skip malformed
      }
    };

    ws.onclose = () => {
      setStatus("reconnecting");
      const delay = Math.min(retryDelayRef.current, MAX_RETRY_MS);
      retryDelayRef.current = Math.min(delay * 2, MAX_RETRY_MS);
      retryRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      setStatus("disconnected");
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, [connect]);

  /* ── Derived Metrics ── */
  const tdi = latest?.thrash_index ?? 0;
  const wiredMB = latest?.wired_mb ?? 0;
  const limitMB = latest?.limit_mb ?? 18432;
  const swapUsedMB = latest?.swap_used_mb ?? 0;
  const pageouts = latest?.pageouts ?? 0;
  const velocity = latest?.velocity;
  const isRunaway = velocity?.runaway_detected ?? false;

  // Dynamic swap limit: max(2048 MB, RAM * 0.25)
  const swapRatio = config?.swap_limit_ratio ?? 0.25;
  const approxRAM = limitMB / 0.75; // Apple dynamic limit is 75% RAM
  const dynamicSwapCeilingMB = Math.max(2048, Math.round(approxRAM * swapRatio));

  // TDI Breakdown weights: 70% physical, 30% swap
  const physicalRatio = limitMB > 0 ? wiredMB / limitMB : 0;
  const physicalTDIContribution = 0.70 * physicalRatio;
  const swapSubsystemRatio = dynamicSwapCeilingMB > 0 ? swapUsedMB / dynamicSwapCeilingMB : 0;
  const swapTDIContribution = 0.30 * swapSubsystemRatio;

  const currentChartData = timeWindow === "1m" ? liveHistory : historyData;

  const tpsChartData = useMemo(() => {
    return currentChartData.map((d) => ({
      t: d.t,
      val: d.tps,
    }));
  }, [currentChartData]);

  const tdiChartData = useMemo(() => {
    return currentChartData.map((d) => ({
      t: d.t,
      val: d.thrash_index,
    }));
  }, [currentChartData]);

  // Color discipline: neutral zinc below 0.50, amber at 0.75, crimson at 0.90
  const tdiSparklineColor = tdi >= 0.90 ? "#f43f5e" : tdi >= 0.75 ? "#f59e0b" : "#71717a";
  const tpsSparklineColor = isRunaway ? "#f43f5e" : (velocity?.tps ?? 0) > 0 ? "#818cf8" : "#71717a";

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 flex flex-col font-sans selection:bg-zinc-800 selection:text-zinc-100">
      <Head>
        <title>Sentinel-AI — Unified Memory & Velocity Telemetry</title>
        <meta name="description" content="Zero-overhead unified memory telemetry and runaway agent loop tripwire for Apple Silicon." />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      {/* Ambient Raycast Lighting */}
      <div className="ambient-glow" aria-hidden="true" />

      {/* Main Container */}
      <div className="relative z-10 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">

        {/* ══════════════════════════════════════════════════════════════════
           HEADER BAR
        ══════════════════════════════════════════════════════════════════ */}
        <header className="telemetry-card px-5 py-3.5 flex flex-wrap items-center justify-between gap-4">
          {/* Brand & Version */}
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-zinc-800/80 border border-zinc-700/60 shadow-inner">
              <Shield className="w-4 h-4 text-cyan-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm tracking-tight text-zinc-100">
                  Sentinel-AI
                </span>
                <span className="font-mono text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-800/90 text-zinc-400 border border-zinc-700/60">
                  v1.0.1
                </span>
              </div>
              <p className="text-[11px] text-zinc-500">
                Unified Memory &amp; Agent Loop Tripwire
              </p>
            </div>
          </div>

          {/* Center Badges: Connection & Hardware */}
          <div className="flex items-center flex-wrap gap-2 text-xs">
            {/* Live Connection Pill */}
            <div className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-full font-mono text-[11px] border transition-colors ${
              status === "connected"
                ? "bg-zinc-900/60 border-zinc-800/80 text-zinc-300"
                : status === "reconnecting"
                ? "bg-amber-500/10 border-amber-500/30 text-amber-400"
                : "bg-rose-500/10 border-rose-500/30 text-rose-400"
            }`}>
              <span className="relative flex h-1.5 w-1.5">
                {status === "reconnecting" && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                )}
                <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${
                  status === "connected" ? (isPaused ? "bg-zinc-500" : "bg-emerald-400") : status === "reconnecting" ? "bg-amber-400" : "bg-rose-400"
                }`} />
              </span>
              <span>
                {status === "connected" ? (isPaused ? "STREAM PAUSED" : "LIVE 1Hz") : status.toUpperCase()}
              </span>
            </div>

            {/* Apple Silicon Hardware Banner */}
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full font-mono text-[11px] bg-zinc-900/40 border border-zinc-800/60 text-zinc-400">
              <Cpu className="w-3.5 h-3.5 text-zinc-400" />
              <span>Apple Silicon</span>
              <span className="text-zinc-600">|</span>
              <span className="text-zinc-500">Ceiling:</span>
              <span className="text-zinc-300 tabular-nums">{fmtMB(dynamicSwapCeilingMB)}</span>
            </div>
          </div>

          {/* Quick Action Controls */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setIsPaused((p) => !p)}
              className={`p-2 rounded-lg border text-xs font-mono transition-all flex items-center gap-1.5 ${
                isPaused
                  ? "bg-amber-500/10 border-amber-500/40 text-amber-300"
                  : "bg-zinc-800/60 border-zinc-700/60 text-zinc-300 hover:text-zinc-100 hover:border-zinc-600"
              }`}
              title={isPaused ? "Resume telemetry stream" : "Pause live stream"}
            >
              {isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{isPaused ? "Resume" : "Pause"}</span>
            </button>

            <button
              onClick={fetchREST}
              className="p-2 rounded-lg bg-zinc-800/60 border border-zinc-700/60 text-zinc-300 hover:text-zinc-100 hover:border-zinc-600 transition-all"
              title="Refresh quota & engine snapshots"
            >
              <RotateCw className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin text-cyan-400" : ""}`} />
            </button>
          </div>
        </header>

        {/* ══════════════════════════════════════════════════════════════════
           NAVIGATION TABS (with layoutId sliding indicator pill)
        ══════════════════════════════════════════════════════════════════ */}
        <div className="flex items-center gap-1.5 border-b border-zinc-800/80 pb-2 text-xs font-mono relative">
          {[
            { id: "telemetry", label: "Telemetry & Tripwires", icon: Activity },
            { id: "quotas", label: "AI Quota Radar", icon: Zap, count: quotas.length },
            { id: "engines", label: "Local LLM Engines", icon: Server },
            { id: "spikes", label: "Spike Incidents", icon: AlertTriangle, count: spikes.length },
            { id: "config", label: "Config & Rules", icon: Sliders },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as DashboardTab)}
                className={`relative flex items-center gap-2 px-3.5 py-1.5 rounded-lg transition-colors z-10 ${
                  isActive
                    ? "text-zinc-100 font-semibold"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {isActive && (
                  <motion.div
                    layoutId="activeTabIndicator"
                    className="absolute inset-0 bg-zinc-800 rounded-lg border border-zinc-700/70 shadow-sm z-[-1]"
                    transition={{ type: "spring", stiffness: 450, damping: 35 }}
                  />
                )}
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
                {tab.count !== undefined && tab.count > 0 && (
                  <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-zinc-700/60 text-zinc-300">
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* ══════════════════════════════════════════════════════════════════
           TAB 1: TELEMETRY & TRIPWIRES (MOTION-DRIVEN STAGGERED GRID)
        ══════════════════════════════════════════════════════════════════ */}
        {activeTab === "telemetry" && (
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="show"
            className="space-y-6"
          >
            {/* HERO SECTION: Thrash Danger Index (TDI) Radial Gauge & Decomposition */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

              {/* Left Column: Radial Meter with Motion Glow */}
              <motion.div variants={itemVariants} className="telemetry-card lg:col-span-5 flex flex-col justify-between p-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-zinc-400" />
                    <span className="text-xs font-mono uppercase tracking-wider text-zinc-300 font-semibold">
                      Thrash Danger Index (TDI)
                    </span>
                  </div>
                  <div className="group relative">
                    <Info className="w-3.5 h-3.5 text-zinc-500 hover:text-zinc-300 cursor-help" />
                    <div className="hidden group-hover:block absolute right-0 top-6 z-50 w-72 p-3 text-[11px] font-mono rounded-lg bg-zinc-900 border border-zinc-700 shadow-2xl text-zinc-300">
                      <div className="font-bold text-zinc-100 mb-1">TDI Mathematical Formulation:</div>
                      <div>TDI = 0.70 × (Wired / Limit) + 0.30 × (Swap / SwapCeiling)</div>
                      <div className="text-zinc-400 mt-1.5">
                        Swap Ceiling dynamically scales as max(2048 MB, hw.memsize × 0.25).
                      </div>
                    </div>
                  </div>
                </div>

                {/* Precision Ultra-Thin 4px SVG Radial Gauge */}
                <TDIRadialMeter tdi={tdi} />

                {/* Gauge Footnote */}
                <div className="text-[11px] font-mono text-zinc-500 text-center border-t border-zinc-800/80 pt-3 flex items-center justify-center gap-4">
                  <span>Warning: &ge; 0.75</span>
                  <span>•</span>
                  <span>Critical: &ge; 0.90</span>
                </div>
              </motion.div>

              {/* Right Column: Mathematical Decomposition Breakdown */}
              <motion.div variants={itemVariants} className="telemetry-card lg:col-span-7 flex flex-col justify-between p-5 space-y-4">
                <div>
                  <h3 className="text-xs font-mono uppercase tracking-wider text-zinc-300 font-semibold mb-1">
                    Telemetry Decomposition &amp; Weight Attribution
                  </h3>
                  <p className="text-xs text-zinc-500 font-mono">
                    Linear blend of Darwin Mach kernel wired VRAM allocations and swap subsystem thrash pressure.
                  </p>
                </div>

                <div className="space-y-4">
                  {/* Physical Pressure (70% Weight) */}
                  <div className="p-3 rounded-lg bg-zinc-900/40 border border-zinc-800/80 space-y-2">
                    <div className="flex items-center justify-between text-xs font-mono">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${physicalRatio >= 0.90 ? "bg-rose-500" : physicalRatio >= 0.75 ? "bg-amber-400" : "bg-zinc-400"}`} />
                        <span className="text-zinc-300 font-medium">Physical Wired VRAM Pressure</span>
                        <span className="text-zinc-500 text-[10px]">(70% Weight)</span>
                      </div>
                      <span className="text-zinc-300 font-medium tabular-nums">
                        +<AnimatedMetric value={physicalTDIContribution} precision={3} /> TDI
                      </span>
                    </div>

                    <div className="w-full h-1.5 rounded-full bg-zinc-800/80 overflow-hidden">
                      <motion.div
                        className={`h-full rounded-full transition-colors ${
                          physicalRatio >= 0.90 ? "bg-rose-500" : physicalRatio >= 0.75 ? "bg-amber-500" : "bg-zinc-400"
                        }`}
                        animate={{ width: `${Math.min(100, physicalRatio * 100)}%` }}
                        transition={{ duration: 0.5, ease: "easeOut" }}
                      />
                    </div>

                    <div className="flex justify-between text-[11px] font-mono text-zinc-400 tabular-nums">
                      <span>Wired: <AnimatedMetric value={wiredMB} formatFn={fmtMB} /></span>
                      <span>GPU Wired Limit: {fmtMB(limitMB)} ({(physicalRatio * 100).toFixed(1)}%)</span>
                    </div>
                  </div>

                  {/* Swap Pressure (30% Weight) */}
                  <div className="p-3 rounded-lg bg-zinc-900/40 border border-zinc-800/80 space-y-2">
                    <div className="flex items-center justify-between text-xs font-mono">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${swapSubsystemRatio >= 0.90 ? "bg-rose-500" : swapSubsystemRatio >= 0.75 ? "bg-amber-400" : "bg-zinc-600"}`} />
                        <span className="text-zinc-300 font-medium">Swap Subsystem Pressure</span>
                        <span className="text-zinc-500 text-[10px]">(30% Weight)</span>
                      </div>
                      <span className="text-zinc-400 font-medium tabular-nums">
                        +<AnimatedMetric value={swapTDIContribution} precision={3} /> TDI
                      </span>
                    </div>

                    <div className="w-full h-1.5 rounded-full bg-zinc-800/80 overflow-hidden">
                      <motion.div
                        className={`h-full rounded-full transition-colors ${
                          swapSubsystemRatio >= 0.90 ? "bg-rose-500" : swapSubsystemRatio >= 0.75 ? "bg-amber-500" : "bg-zinc-600"
                        }`}
                        animate={{ width: `${Math.min(100, swapSubsystemRatio * 100)}%` }}
                        transition={{ duration: 0.5, ease: "easeOut" }}
                      />
                    </div>

                    <div className="flex justify-between text-[11px] font-mono text-zinc-400 tabular-nums">
                      <span>Swap In Use: <AnimatedMetric value={swapUsedMB} formatFn={fmtMB} /></span>
                      <span>Dynamic Ceiling: {fmtMB(dynamicSwapCeilingMB)} ({(swapSubsystemRatio * 100).toFixed(1)}%)</span>
                    </div>
                  </div>
                </div>

                {/* Subsystem Summary Footer */}
                <div className="flex items-center justify-between text-[11px] font-mono text-zinc-500 border-t border-zinc-800/80 pt-3">
                  <div className="flex items-center gap-2">
                    <Clock className="w-3.5 h-3.5 text-zinc-500" />
                    <span>Sampling Frequency: 1.0s (Mach kernel C-bindings)</span>
                  </div>
                  <span className="text-zinc-400">Total Derived TDI: <AnimatedMetric value={tdi} precision={3} /></span>
                </div>
              </motion.div>
            </div>

            {/* ══════════════════════════════════════════════════════════════
               SECONDARY MATRIX GRID (3-COLUMN RESPONSIVE)
            ══════════════════════════════════════════════ */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

              {/* CARD 1: Unified Memory Allocation */}
              <motion.div variants={itemVariants} className="telemetry-card p-5 flex flex-col justify-between space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Layers className="w-4 h-4 text-zinc-400" />
                    <span className="text-xs font-mono uppercase tracking-wider text-zinc-300 font-medium">
                      Unified Memory Allocation
                    </span>
                  </div>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800/60 text-zinc-400 border border-zinc-800">
                    Apple Silicon
                  </span>
                </div>

                <div>
                  <div className="flex items-baseline gap-2 font-mono">
                    <span className="text-3xl font-semibold text-zinc-100 tabular-nums">
                      <AnimatedMetric value={wiredMB} formatFn={fmtMB} />
                    </span>
                    <span className="text-xs text-zinc-500">
                      / {fmtMB(limitMB)}
                    </span>
                  </div>
                  <p className="text-[11px] font-mono text-zinc-400 mt-1">
                    Active GPU Wired VRAM Allocation
                  </p>
                </div>

                {/* Segmented Memory Bar */}
                <div className="space-y-1.5">
                  <div className="w-full h-1.5 rounded-full bg-zinc-800/80 overflow-hidden flex">
                    <motion.div
                      className={`h-full rounded-full transition-colors ${
                        (wiredMB / limitMB) >= 0.90 ? "bg-rose-500" : (wiredMB / limitMB) >= 0.75 ? "bg-amber-500" : "bg-zinc-400"
                      }`}
                      animate={{ width: `${Math.min(100, (wiredMB / limitMB) * 100)}%` }}
                      transition={{ duration: 0.5, ease: "easeOut" }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] font-mono text-zinc-500">
                    <span>Wired: {((wiredMB / limitMB) * 100).toFixed(1)}%</span>
                    <span>Free Headroom: {fmtMB(Math.max(0, limitMB - wiredMB))}</span>
                  </div>
                </div>

                <div className="border-t border-zinc-800/80 pt-3 flex items-center justify-between text-[11px] font-mono text-zinc-400">
                  <span className="text-zinc-500">Engine KV Cache:</span>
                  <span className="text-zinc-300 tabular-nums">
                    {latest?.kv_cache_mb ? fmtMB(latest.kv_cache_mb) : "0 MB (Idle)"}
                  </span>
                </div>
              </motion.div>

              {/* CARD 2: Swap Subsystem */}
              <motion.div variants={itemVariants} className="telemetry-card p-5 flex flex-col justify-between space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <HardDrive className="w-4 h-4 text-zinc-400" />
                    <span className="text-xs font-mono uppercase tracking-wider text-zinc-300 font-medium">
                      Swap Subsystem &amp; Disk
                    </span>
                  </div>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800/60 text-zinc-400 border border-zinc-800">
                    SSD Guard
                  </span>
                </div>

                <div>
                  <div className="flex items-baseline gap-2 font-mono">
                    <span className="text-3xl font-semibold text-zinc-100 tabular-nums">
                      <AnimatedMetric value={swapUsedMB} formatFn={fmtMB} />
                    </span>
                    <span className="text-xs text-zinc-500">
                      / {fmtMB(dynamicSwapCeilingMB)} ceiling
                    </span>
                  </div>
                  <p className="text-[11px] font-mono text-zinc-400 mt-1">
                    Cumulative Pageouts: <AnimatedMetric value={pageouts} precision={0} /> pages
                  </p>
                </div>

                {/* Swap Subsystem Status */}
                <div className="space-y-1.5">
                  <div className="w-full h-1.5 rounded-full bg-zinc-800/80 overflow-hidden flex">
                    <motion.div
                      className={`h-full rounded-full transition-colors ${
                        (swapUsedMB / dynamicSwapCeilingMB) >= 0.90 ? "bg-rose-500" : (swapUsedMB / dynamicSwapCeilingMB) >= 0.75 ? "bg-amber-500" : "bg-zinc-600"
                      }`}
                      animate={{ width: `${Math.min(100, (swapUsedMB / dynamicSwapCeilingMB) * 100)}%` }}
                      transition={{ duration: 0.5, ease: "easeOut" }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] font-mono text-zinc-500">
                    <span>Ceiling Used: {((swapUsedMB / dynamicSwapCeilingMB) * 100).toFixed(1)}%</span>
                    <span>Total Alloc: {fmtMB(latest?.swap_total_mb ?? 0)}</span>
                  </div>
                </div>

                <div className="border-t border-zinc-800/80 pt-3 flex items-center justify-between text-[11px] font-mono text-zinc-400">
                  <span className="text-zinc-500">SSD Thrash State:</span>
                  <span className={`tabular-nums font-medium ${swapUsedMB > 0 ? "text-amber-400" : "text-zinc-500"}`}>
                    {swapUsedMB > 0 ? "Swapping Active" : "Zero Thrash"}
                  </span>
                </div>
              </motion.div>

              {/* CARD 3: Token Velocity & Loop Tripwire */}
              <motion.div variants={itemVariants} className="telemetry-card p-5 flex flex-col justify-between space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-zinc-400" />
                    <span className="text-xs font-mono uppercase tracking-wider text-zinc-300 font-medium">
                      Token Velocity &amp; Tripwire
                    </span>
                  </div>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800/60 text-zinc-400 border border-zinc-800">
                    OmniRoute (:20128)
                  </span>
                </div>

                <div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-baseline gap-2 font-mono">
                      <span className="text-3xl font-semibold text-zinc-100 tabular-nums">
                        <AnimatedMetric value={velocity?.tps ?? 0} precision={1} />
                      </span>
                      <span className="text-xs text-zinc-500">
                        TPS
                      </span>
                    </div>

                    {/* Subtle micro-pulse dot radar */}
                    <RunawayRadar
                      isRunaway={isRunaway}
                      burnRateStatus={velocity?.burn_rate_status ?? "nominal"}
                      reason={velocity?.reason}
                      tps={velocity?.tps ?? 0}
                      rpm={velocity?.rpm ?? 0}
                    />
                  </div>

                  <div className="flex items-center gap-3 text-[11px] font-mono text-zinc-500 mt-1 tabular-nums">
                    <span>TPM: <AnimatedMetric value={velocity?.tpm ?? 0} precision={0} /></span>
                    <span>•</span>
                    <span>RPM: <AnimatedMetric value={velocity?.rpm ?? 0} precision={1} /> req/min</span>
                  </div>
                </div>

                {/* Tripwire Status Pill */}
                <div className="pt-1">
                  <div className={`p-2.5 rounded-lg border text-xs font-mono flex items-center justify-between transition-colors ${
                    isRunaway
                      ? "bg-rose-500/15 border-rose-500/40 text-rose-300 font-bold animate-pulse"
                      : "bg-zinc-900/40 border-zinc-800/80 text-zinc-400"
                  }`}>
                    <span>Loop Tripwire:</span>
                    <span className={isRunaway ? "uppercase text-rose-400 font-bold" : "uppercase text-zinc-500 font-medium"}>
                      {isRunaway ? "RUNAWAY DETECTED" : "NOMINAL"}
                    </span>
                  </div>
                </div>

                <div className="border-t border-zinc-800/80 pt-3 flex items-center justify-between text-[11px] font-mono text-zinc-400">
                  <span className="text-zinc-500">Threshold Limit:</span>
                  <span className="text-zinc-300 tabular-nums">
                    {config?.velocity_alert_tps ?? 150} TPS / {config?.velocity_alert_rpm ?? 45} RPM
                  </span>
                </div>
              </motion.div>

            </div>

            {/* ══════════════════════════════════════════════════════════════
               HISTORICAL VELOCITY & TELEMETRY SPARKLINES
            ══════════════════════════════════════════════ */}
            <motion.div variants={itemVariants} className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h3 className="text-sm font-mono font-semibold tracking-tight text-zinc-100">
                    Historical Velocity &amp; Memory Trajectory
                  </h3>
                  <p className="text-xs font-mono text-zinc-500">
                    Smooth cubic bezier SVG sparklines capturing sliding-window token burn and memory pressure.
                  </p>
                </div>

                {/* Segmented Window Picker with layoutId sliding pill */}
                <div className="flex items-center p-1 rounded-lg bg-zinc-900 border border-zinc-800 font-mono text-xs relative">
                  {(["1m", "5m", "1h"] as TimeWindow[]).map((win) => {
                    const isSelected = timeWindow === win;
                    return (
                      <motion.button
                        key={win}
                        onClick={() => setTimeWindow(win)}
                        whileHover={{ scale: 1.04 }}
                        whileTap={{ scale: 0.96 }}
                        className={`relative z-10 px-3 py-1.5 rounded-md transition-colors ${
                          isSelected ? "text-zinc-100 font-semibold" : "text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        {isSelected && (
                          <motion.div
                            layoutId="activeTimeWindowPill"
                            className="absolute inset-0 bg-zinc-800 rounded-md shadow-sm border border-zinc-700/60 z-[-1]"
                            transition={{ type: "spring", stiffness: 450, damping: 35 }}
                          />
                        )}
                        {win === "1m" ? "Real-time (1s)" : win === "5m" ? "5m Rollup" : "1h History"}
                      </motion.button>
                    );
                  })}
                </div>
              </div>

              {/* Motion Sparklines Stream Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Chart 1: TDI & Wired VRAM */}
                <SparklineStream
                  data={tdiChartData}
                  color={tdiSparklineColor}
                  unit="TDI"
                  minVal={0}
                  maxVal={1.0}
                  warningLine={0.75}
                  criticalLine={0.90}
                  title="Thrash Danger Index (TDI)"
                  currentVal={tdi}
                  gradientId="grad-tdi-stream"
                />

                {/* Chart 2: Token Velocity (TPS) */}
                <SparklineStream
                  data={tpsChartData}
                  color={tpsSparklineColor}
                  unit="TPS"
                  minVal={0}
                  warningLine={config?.velocity_alert_tps ?? 150}
                  title="Token Velocity Burn Rate"
                  currentVal={velocity?.tps ?? 0}
                  gradientId="grad-tps-stream"
                />
              </div>
            </motion.div>

          </motion.div>
        )}

        {/* ══════════════════════════════════════════════════════════════════
           TAB 2: AI QUOTA RADAR
        ══════════════════════════════════════════════════════════════════ */}
        {activeTab === "quotas" && (
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="show"
            className="space-y-4"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-mono font-semibold text-zinc-100">
                  AI Provider Quota &amp; Rate-Limit Radar
                </h3>
                <p className="text-xs font-mono text-zinc-500">
                  Live quota balances, remaining tokens, and reset windows harvested via OmniRoute proxy.
                </p>
              </div>
              <button
                onClick={fetchREST}
                className="text-xs font-mono px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300 hover:text-zinc-100"
              >
                Sync Quotas
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {quotas.length > 0 ? (
                quotas.map((q) => (
                  <motion.div variants={itemVariants} key={q.id} className="telemetry-card p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono font-semibold text-zinc-200">{q.provider}</span>
                      <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full uppercase border ${
                        q.status === "healthy"
                          ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                          : q.status === "warning"
                          ? "bg-amber-500/10 border-amber-500/30 text-amber-400"
                          : "bg-rose-500/10 border-rose-500/30 text-rose-400"
                      }`}>
                        {q.status}
                      </span>
                    </div>

                    <div>
                      <div className="text-sm font-mono font-bold text-zinc-100 tabular-nums">
                        {q.tokens_left}
                      </div>
                      <div className="text-[11px] font-mono text-zinc-500 mt-0.5">
                        Model: {q.model}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className="w-full h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            q.remaining_pct > 30 ? "bg-emerald-500" : q.remaining_pct > 10 ? "bg-amber-500" : "bg-rose-500"
                          }`}
                          style={{ width: `${Math.max(2, Math.min(100, q.remaining_pct))}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-[10px] font-mono text-zinc-500">
                        <span>Remaining: {q.remaining_pct.toFixed(0)}%</span>
                        <span>Resets: {q.resets_in}</span>
                      </div>
                    </div>
                  </motion.div>
                ))
              ) : (
                <div className="col-span-3 text-center py-12 text-zinc-500 font-mono text-xs">
                  No quota targets registered. Launch OmniRoute proxy at http://localhost:20128.
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* ══════════════════════════════════════════════════════════════════
           TAB 3: LOCAL LLM ENGINES
        ══════════════════════════════════════════════════════════════════ */}
        {activeTab === "engines" && (
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="show"
            className="space-y-4"
          >
            <div>
              <h3 className="text-sm font-mono font-semibold text-zinc-100">
                Local LLM Inference Engine Probes
              </h3>
              <p className="text-xs font-mono text-zinc-500">
                Near-zero latency memory probes for Ollama (:11434), LM Studio (:1234), vLLM (:8000), and MLX.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {engines?.engines?.map((eng) => (
                <motion.div variants={itemVariants} key={eng.name} className="telemetry-card p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Server className="w-4 h-4 text-cyan-400" />
                      <span className="text-sm font-mono font-semibold text-zinc-200">{eng.name}</span>
                    </div>
                    <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                      eng.active
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                        : "bg-zinc-800 border-zinc-700 text-zinc-500"
                    }`}>
                      {eng.active ? `ACTIVE :${eng.port}` : `OFFLINE :${eng.port}`}
                    </span>
                  </div>

                  {eng.models.length > 0 ? (
                    <div className="space-y-2 pt-2 border-t border-zinc-800">
                      {eng.models.map((m) => (
                        <div key={m.name} className="flex justify-between items-center text-xs font-mono">
                          <span className="text-zinc-300">{m.name}</span>
                          <span className="text-zinc-400 tabular-nums">
                            {m.size_gb.toFixed(1)} GB | KV: {fmtMB(m.kv_cache_mb)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs font-mono text-zinc-500 pt-2 border-t border-zinc-800">
                      No models loaded in unified memory.
                    </p>
                  )}
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}

        {/* ══════════════════════════════════════════════════════════════════
           TAB 4: SPIKE INCIDENTS (24-HOUR AUDIT)
        ══════════════════════════════════════════════════════════════════ */}
        {activeTab === "spikes" && (
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="show"
            className="space-y-4"
          >
            <div>
              <h3 className="text-sm font-mono font-semibold text-zinc-100">
                Top 24-Hour Memory Spike Incidents
              </h3>
              <p className="text-xs font-mono text-zinc-500">
                Logged thrash danger spikes recorded by SQLite WAL telemetry store.
              </p>
            </div>

            <motion.div variants={itemVariants} className="telemetry-card overflow-hidden">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-zinc-800/60 border-b border-zinc-800 text-zinc-400">
                  <tr>
                    <th className="p-3">Incident Timestamp</th>
                    <th className="p-3">Peak TDI</th>
                    <th className="p-3">Wired VRAM</th>
                    <th className="p-3">Swap Consumed</th>
                    <th className="p-3">Cumulative Pageouts</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
                  {spikes.length > 0 ? (
                    spikes.map((s, i) => (
                      <tr key={i} className="hover:bg-zinc-800/30 transition-colors">
                        <td className="p-3 text-zinc-400 tabular-nums">{new Date(s.timestamp * 1000).toLocaleString()}</td>
                        <td className="p-3 font-bold text-rose-400 tabular-nums">{s.thrash_index.toFixed(3)}</td>
                        <td className="p-3 tabular-nums">{fmtMB(s.wired_mb)}</td>
                        <td className="p-3 tabular-nums">{fmtMB(s.swap_used_mb)}</td>
                        <td className="p-3 tabular-nums">{fmtNum(s.pageouts)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} className="p-8 text-center text-zinc-500">
                        No critical memory spikes recorded in the last 24 hours.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </motion.div>
          </motion.div>
        )}

        {/* ══════════════════════════════════════════════════════════════════
           TAB 5: CONFIG & PREFERENCES (macOS PREFERENCES / RAYCAST MODAL)
        ══════════════════════════════════════════════════════════════════ */}
        {activeTab === "config" && (
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="show"
            className="max-w-4xl mx-auto space-y-6"
          >
            {/* Header */}
            <div className="flex items-center justify-between pb-2 border-b border-zinc-800/80">
              <div>
                <h3 className="text-sm font-semibold tracking-tight text-zinc-100">
                  Sentinel Preferences
                </h3>
                <p className="text-xs text-zinc-500 font-mono mt-0.5">
                  Daemon telemetry rules, tripwire thresholds, and gateway preferences loaded from ~/.sentinel/config.json
                </p>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800/80 text-zinc-400 border border-zinc-700/60">
                Zero-Dependency LRU Cache
              </span>
            </div>

            {/* Group 1: Gateway & Polling */}
            <motion.div variants={itemVariants} className="telemetry-card overflow-hidden">
              <div className="px-4 py-2.5 bg-zinc-900/60 border-b border-zinc-800/80 flex items-center justify-between">
                <span className="text-xs font-mono font-semibold uppercase tracking-wider text-zinc-300">
                  Gateway &amp; Polling
                </span>
                <span className="text-[10px] font-mono text-zinc-500">I/O Cadence</span>
              </div>
              <div className="divide-y divide-zinc-800/50 text-xs">
                <div className="px-4 py-3 flex items-center justify-between gap-4">
                  <div>
                    <div className="font-medium text-zinc-200">OmniRoute Proxy URL</div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">Reverse proxy gateway intercepting local AI agent tokens</div>
                  </div>
                  <span className="font-mono text-xs px-2.5 py-1 rounded bg-zinc-800/80 border border-zinc-700/60 text-zinc-300 tabular-nums">
                    {config?.proxy_url ?? "http://localhost:20128"}
                  </span>
                </div>

                <div className="px-4 py-3 flex items-center justify-between gap-4">
                  <div>
                    <div className="font-medium text-zinc-200">Mach Telemetry Polling Interval</div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">Kernel C-bindings sampling frequency for physical &amp; swap statistics</div>
                  </div>
                  <span className="font-mono text-xs px-2.5 py-1 rounded bg-zinc-800/80 border border-zinc-700/60 text-zinc-300 tabular-nums">
                    {config?.poll_interval_seconds ?? 1.0}s
                  </span>
                </div>

                <div className="px-4 py-3 flex items-center justify-between gap-4">
                  <div>
                    <div className="font-medium text-zinc-200">Notification Debounce Window</div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">Minimum quiet period between consecutive macOS native banner notifications</div>
                  </div>
                  <span className="font-mono text-xs px-2.5 py-1 rounded bg-zinc-800/80 border border-zinc-700/60 text-zinc-300 tabular-nums">
                    {config?.notification_debounce_seconds ?? 60.0}s
                  </span>
                </div>
              </div>
            </motion.div>

            {/* Group 2: Tripwires & Thresholds */}
            <motion.div variants={itemVariants} className="telemetry-card overflow-hidden">
              <div className="px-4 py-2.5 bg-zinc-900/60 border-b border-zinc-800/80 flex items-center justify-between">
                <span className="text-xs font-mono font-semibold uppercase tracking-wider text-zinc-300">
                  Tripwires &amp; Thresholds
                </span>
                <span className="text-[10px] font-mono text-zinc-500">Heuristic Limits</span>
              </div>
              <div className="divide-y divide-zinc-800/50 text-xs">
                <div className="px-4 py-3 flex items-center justify-between gap-4">
                  <div>
                    <div className="font-medium text-zinc-200">TDI Elevated Warning Level</div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">Thrash Danger Index boundary triggering amber visual alert state</div>
                  </div>
                  <span className="font-mono text-xs px-2.5 py-1 rounded bg-amber-500/10 border border-amber-500/30 text-amber-400 tabular-nums font-semibold">
                    {config?.tdi_warning_threshold ?? 0.75}
                  </span>
                </div>

                <div className="px-4 py-3 flex items-center justify-between gap-4">
                  <div>
                    <div className="font-medium text-zinc-200">TDI Critical Starvation Level</div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">Severe thrash danger threshold triggering kill/throttle intervention</div>
                  </div>
                  <span className="font-mono text-xs px-2.5 py-1 rounded bg-rose-500/10 border border-rose-500/30 text-rose-400 tabular-nums font-semibold">
                    {config?.tdi_critical_threshold ?? 0.90}
                  </span>
                </div>

                <div className="px-4 py-3 flex items-center justify-between gap-4">
                  <div>
                    <div className="font-medium text-zinc-200">Token Velocity Limit (TPS)</div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">Sliding 60-second window token burn rate triggering runaway tripwire</div>
                  </div>
                  <span className="font-mono text-xs px-2.5 py-1 rounded bg-zinc-800/80 border border-zinc-700/60 text-zinc-300 tabular-nums">
                    {config?.velocity_alert_tps ?? 150.0} TPS
                  </span>
                </div>

                <div className="px-4 py-3 flex items-center justify-between gap-4">
                  <div>
                    <div className="font-medium text-zinc-200">Request Velocity Limit (RPM)</div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">Sliding 60-second window request frequency triggering runaway tripwire</div>
                  </div>
                  <span className="font-mono text-xs px-2.5 py-1 rounded bg-zinc-800/80 border border-zinc-700/60 text-zinc-300 tabular-nums">
                    {config?.velocity_alert_rpm ?? 45.0} RPM
                  </span>
                </div>
              </div>
            </motion.div>

            {/* Group 3: Hardware Memory Limits */}
            <motion.div variants={itemVariants} className="telemetry-card overflow-hidden">
              <div className="px-4 py-2.5 bg-zinc-900/60 border-b border-zinc-800/80 flex items-center justify-between">
                <span className="text-xs font-mono font-semibold uppercase tracking-wider text-zinc-300">
                  Hardware Memory Limits
                </span>
                <span className="text-[10px] font-mono text-zinc-500">Apple Silicon Allocation</span>
              </div>
              <div className="divide-y divide-zinc-800/50 text-xs">
                <div className="px-4 py-3 flex items-center justify-between gap-4">
                  <div>
                    <div className="font-medium text-zinc-200">Dynamic Swap Ceiling Ratio</div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">Allocated swap bound calibrated as fraction of hw.memsize (min 2,048 MB)</div>
                  </div>
                  <span className="font-mono text-xs px-2.5 py-1 rounded bg-zinc-800/80 border border-zinc-700/60 text-zinc-300 tabular-nums">
                    {((config?.swap_limit_ratio ?? 0.25) * 100).toFixed(0)}% RAM ({fmtMB(dynamicSwapCeilingMB)})
                  </span>
                </div>
              </div>
            </motion.div>

            {/* macOS Preferences Footer Tip */}
            <motion.div variants={itemVariants} className="p-3.5 rounded-lg bg-zinc-900/40 border border-zinc-800/80 text-[11px] font-mono text-zinc-500 flex items-center gap-2.5">
              <Info className="w-4 h-4 text-zinc-400 shrink-0" />
              <span>
                To configure overrides, edit <code className="text-zinc-300 px-1 py-0.5 rounded bg-zinc-800 border border-zinc-700">~/.sentinel/config.json</code>. Changes reload automatically via zero-overhead LRU cache.
              </span>
            </motion.div>
          </motion.div>
        )}

        {/* ══════════════════════════════════════════════════════════════════
           FOOTER
        ══════════════════════════════════════════════════════════════════ */}
        <footer className="text-center py-4 text-[11px] font-mono text-zinc-600 space-y-1">
          <div>Sentinel-AI v1.0.1 • Darwin Mach Microkernel Bindings • Native launchd daemon</div>
          <div className="text-zinc-700">Embedded Static Web Canvas (Zero Node.js Runtime Required)</div>
        </footer>

      </div>
    </div>
  );
}
