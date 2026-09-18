/**
 * web/src/pages/index.tsx
 *
 * Sentinel-AI — Glassmorphic telemetry dashboard
 * Connects to ws://127.0.0.1:8000/ws/telemetry and renders live charts
 * for VRAM (wired), swap usage, pageouts, and thrash index.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import {
  Activity,
  Cpu,
  HardDrive,
  AlertTriangle,
  Wifi,
  WifiOff,
  RefreshCw,
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

/* ── Fonts ────────────────────────────────────────────────────────────── */
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/* ── Types ────────────────────────────────────────────────────────────── */
interface TelemetryFrame {
  timestamp: number;
  wired_mb: number;
  limit_mb: number;
  swap_total_mb: number;
  swap_used_mb: number;
  pageouts: number;
  thrash_index: number;
}

interface ChartPoint {
  t: string;           // HH:MM:SS label
  wired_mb: number;
  swap_used_mb: number;
  pageouts: number;
  thrash_index: number;
}

type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "error";

const WS_URL = "ws://127.0.0.1:8000/ws/telemetry";
const MAX_POINTS = 60; // ~1 min of history at 1 s intervals
const BASE_RETRY_MS = 1_500;
const MAX_RETRY_MS = 30_000;

/* ── Helpers ──────────────────────────────────────────────────────────── */
function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("en-GB");
}

function toChartPoint(f: TelemetryFrame): ChartPoint {
  return {
    t: fmtTime(f.timestamp),
    wired_mb: Math.round(f.wired_mb),
    swap_used_mb: Math.round(f.swap_used_mb * 10) / 10,
    pageouts: f.pageouts,
    thrash_index: Math.round(f.thrash_index * 1000) / 1000,
  };
}

function thrashColor(index: number): string {
  if (index >= 0.75) return "#ef4444"; // red-500
  if (index >= 0.5) return "#f97316";  // orange-500
  if (index >= 0.25) return "#eab308"; // yellow-500
  return "#22c55e";                    // green-500
}

/* ── Status badge ─────────────────────────────────────────────────────── */
function StatusBadge({ status }: { status: ConnectionStatus }) {
  const config: Record<
    ConnectionStatus,
    { icon: React.ReactNode; label: string; cls: string }
  > = {
    connected: {
      icon: <Wifi size={13} />,
      label: "Live",
      cls: "bg-green-500/20 text-green-400 border-green-500/30",
    },
    connecting: {
      icon: <RefreshCw size={13} className="animate-spin" />,
      label: "Connecting…",
      cls: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    },
    reconnecting: {
      icon: <RefreshCw size={13} className="animate-spin" />,
      label: "Reconnecting…",
      cls: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    },
    error: {
      icon: <WifiOff size={13} />,
      label: "Disconnected",
      cls: "bg-red-500/20 text-red-400 border-red-500/30",
    },
  };

  const { icon, label, cls } = config[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${cls}`}
    >
      {icon}
      {label}
    </span>
  );
}

/* ── Stat card ────────────────────────────────────────────────────────── */
interface StatCardProps {
  title: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  accent: string; // tailwind bg class for icon ring
  danger?: boolean;
}

function StatCard({ title, value, sub, icon, accent, danger }: StatCardProps) {
  return (
    <div
      className={`glass-card flex flex-col gap-3 p-5 ${
        danger ? "ring-1 ring-red-500/40" : ""
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-widest text-zinc-400">
          {title}
        </span>
        <span className={`rounded-lg p-1.5 ${accent}`}>{icon}</span>
      </div>
      <p className="font-mono text-2xl font-bold text-white">{value}</p>
      {sub && <p className="text-xs text-zinc-500">{sub}</p>}
    </div>
  );
}

/* ── Chart card ───────────────────────────────────────────────────────── */
interface ChartCardProps {
  title: string;
  icon: React.ReactNode;
  accent: string;
  children: React.ReactNode;
}

function ChartCard({ title, icon, accent, children }: ChartCardProps) {
  return (
    <div className="glass-card flex flex-col gap-4 p-5">
      <div className="flex items-center gap-2">
        <span className={`rounded-lg p-1.5 ${accent}`}>{icon}</span>
        <span className="text-sm font-semibold text-zinc-200">{title}</span>
      </div>
      {children}
    </div>
  );
}

/* ── Custom tooltip ───────────────────────────────────────────────────── */
function ChartTooltip({
  active,
  payload,
  label,
  unit,
}: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
  unit: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-zinc-900/90 px-3 py-2 text-xs text-zinc-200 shadow-xl backdrop-blur">
      <p className="mb-1 text-zinc-400">{label}</p>
      <p className="font-mono font-semibold">
        {payload[0].value} {unit}
      </p>
    </div>
  );
}

/* ── Main dashboard ───────────────────────────────────────────────────── */
export default function Home() {
  const [history, setHistory] = useState<ChartPoint[]>([]);
  const [latest, setLatest] = useState<TelemetryFrame | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(BASE_RETRY_MS);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    setStatus((s) => (s === "connected" ? "reconnecting" : s));

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      retryDelayRef.current = BASE_RETRY_MS;
      setStatus("connected");
    };

    ws.onmessage = (evt: MessageEvent<string>) => {
      if (!mountedRef.current) return;
      try {
        const frame: TelemetryFrame = JSON.parse(evt.data);
        setLatest(frame);
        setHistory((prev) => {
          const next = [...prev, toChartPoint(frame)];
          return next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next;
        });
      } catch {
        // malformed frame — skip
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setStatus("reconnecting");
      const delay = Math.min(retryDelayRef.current, MAX_RETRY_MS);
      retryDelayRef.current = Math.min(delay * 2, MAX_RETRY_MS);
      retryRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      setStatus("error");
      ws.close();
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      wsRef.current?.close();
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, [connect]);

  /* derived display values */
  const vramPct =
    latest && latest.limit_mb > 0
      ? ((latest.wired_mb / latest.limit_mb) * 100).toFixed(1)
      : "—";
  const swapPct =
    latest && latest.swap_total_mb > 0
      ? ((latest.swap_used_mb / latest.swap_total_mb) * 100).toFixed(1)
      : "—";
  const tColor = latest ? thrashColor(latest.thrash_index) : "#6b7280";
  const isDanger = latest ? latest.thrash_index >= 0.75 : false;

  const axisStyle = { fill: "#71717a", fontSize: 11 };
  const gridStroke = "rgba(255,255,255,0.06)";

  return (
    <div
      className={`${geistSans.variable} ${geistMono.variable} min-h-screen bg-[#0a0a0f] font-sans`}
    >
      {/* Background glow blobs */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 overflow-hidden"
      >
        <div className="absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-violet-700/20 blur-[120px]" />
        <div className="absolute -right-40 bottom-0 h-[400px] w-[400px] rounded-full bg-cyan-700/15 blur-[100px]" />
        <div className="absolute left-1/2 top-1/2 h-[300px] w-[300px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-700/10 blur-[80px]" />
      </div>

      <div className="relative mx-auto max-w-6xl px-6 py-10">
        {/* Header */}
        <header className="mb-10 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-600/30 ring-1 ring-violet-500/40">
              <Activity size={18} className="text-violet-300" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">
                Sentinel-AI
              </h1>
              <p className="text-xs text-zinc-500">
                Apple Silicon Memory Monitor
              </p>
            </div>
          </div>
          <StatusBadge status={status} />
        </header>

        {/* Stat cards row */}
        <section
          aria-label="Current metrics"
          className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4"
        >
          <StatCard
            title="VRAM Used"
            value={latest ? `${latest.wired_mb} MB` : "—"}
            sub={`${vramPct}% of ${latest ? latest.limit_mb : "—"} MB limit`}
            icon={<Cpu size={15} className="text-violet-300" />}
            accent="bg-violet-500/20"
          />
          <StatCard
            title="Swap Used"
            value={latest ? `${latest.swap_used_mb.toFixed(0)} MB` : "—"}
            sub={`${swapPct}% of ${latest ? latest.swap_total_mb.toFixed(0) : "—"} MB`}
            icon={<HardDrive size={15} className="text-cyan-300" />}
            accent="bg-cyan-500/20"
          />
          <StatCard
            title="Pageouts"
            value={latest ? `${latest.pageouts.toLocaleString()}` : "—"}
            sub="cumulative since boot"
            icon={<RefreshCw size={15} className="text-amber-300" />}
            accent="bg-amber-500/20"
          />
          <StatCard
            title="Thrash Index"
            value={latest ? latest.thrash_index.toFixed(3) : "—"}
            sub={isDanger ? "⚠ High pressure" : "Pressure nominal"}
            icon={<AlertTriangle size={15} style={{ color: tColor }} />}
            accent="bg-rose-500/20"
            danger={isDanger}
          />
        </section>

        {/* Charts grid */}
        <section
          aria-label="Telemetry charts"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
        >
          {/* VRAM */}
          <ChartCard
            title="VRAM Wired (MB)"
            icon={<Cpu size={14} className="text-violet-300" />}
            accent="bg-violet-500/20"
          >
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={history} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="gradVram" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#7c3aed" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#7c3aed" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={gridStroke} vertical={false} />
                <XAxis dataKey="t" tick={axisStyle} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={48} />
                <Tooltip content={<ChartTooltip unit="MB" />} />
                <Area
                  type="monotone"
                  dataKey="wired_mb"
                  stroke="#7c3aed"
                  strokeWidth={2}
                  fill="url(#gradVram)"
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Swap */}
          <ChartCard
            title="Swap Used (MB)"
            icon={<HardDrive size={14} className="text-cyan-300" />}
            accent="bg-cyan-500/20"
          >
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={history} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="gradSwap" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={gridStroke} vertical={false} />
                <XAxis dataKey="t" tick={axisStyle} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={48} />
                <Tooltip content={<ChartTooltip unit="MB" />} />
                <Area
                  type="monotone"
                  dataKey="swap_used_mb"
                  stroke="#06b6d4"
                  strokeWidth={2}
                  fill="url(#gradSwap)"
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Pageouts */}
          <ChartCard
            title="Pageouts (cumulative)"
            icon={<RefreshCw size={14} className="text-amber-300" />}
            accent="bg-amber-500/20"
          >
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={history} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="gradPage" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={gridStroke} vertical={false} />
                <XAxis dataKey="t" tick={axisStyle} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={48} />
                <Tooltip content={<ChartTooltip unit="" />} />
                <Area
                  type="monotone"
                  dataKey="pageouts"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  fill="url(#gradPage)"
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Thrash Index */}
          <ChartCard
            title="Thrash Danger Index"
            icon={<AlertTriangle size={14} className="text-rose-300" />}
            accent="bg-rose-500/20"
          >
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={history} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="gradThrash" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#f43f5e" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={gridStroke} vertical={false} />
                <XAxis dataKey="t" tick={axisStyle} tickLine={false} interval="preserveStartEnd" />
                <YAxis
                  tick={axisStyle}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                  domain={[0, 1]}
                />
                <Tooltip content={<ChartTooltip unit="" />} />
                <Area
                  type="monotone"
                  dataKey="thrash_index"
                  stroke="#f43f5e"
                  strokeWidth={2}
                  fill="url(#gradThrash)"
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
        </section>

        {/* Footer */}
        <footer className="mt-10 text-center text-xs text-zinc-600">
          Sentinel-AI · data sourced from macOS sysctl &amp; vm_stat ·{" "}
          {MAX_POINTS}s rolling window
        </footer>
      </div>
    </div>
  );
}
