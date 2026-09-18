/**
 * web/src/pages/index.tsx
 *
 * Sentinel-AI — macOS HIG-styled telemetry dashboard
 * Connects to ws://127.0.0.1:8000/ws/telemetry and renders live charts
 * for VRAM (wired), swap usage, pageouts, and thrash index.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { Geist_Mono } from "next/font/google";
import { clsx } from "clsx";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

/* ── Font ─────────────────────────────────────────────────────────────── */
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/* ── Apple system accent colors ───────────────────────────────────────── */
const APPLE = {
  blue:   "#0a84ff",
  mint:   "#30d158",
  orange: "#ff9f0a",
  red:    "#ff453a",
  cyan:   "#32ade6",
  gray:   "rgba(235,235,245,0.3)",
} as const;

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
  t: string;
  wired_mb: number;
  swap_used_mb: number;
  pageouts: number;
  thrash_index: number;
}

type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "error";
type ActiveView = "overview" | "memory" | "swap" | "pressure";

const WS_URL        = "ws://127.0.0.1:8000/ws/telemetry";
const MAX_POINTS    = 60;
const BASE_RETRY_MS = 1_500;
const MAX_RETRY_MS  = 30_000;

/* ── Helpers ──────────────────────────────────────────────────────────── */
function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("en-GB");
}

function fmtMB(n: number): string {
  return n.toLocaleString("en-US");
}

function toChartPoint(f: TelemetryFrame): ChartPoint {
  return {
    t:            fmtTime(f.timestamp),
    wired_mb:     Math.round(f.wired_mb),
    swap_used_mb: Math.round(f.swap_used_mb * 10) / 10,
    pageouts:     f.pageouts,
    thrash_index: Math.round(f.thrash_index * 1000) / 1000,
  };
}

function thrashAccent(index: number): string {
  if (index >= 0.75) return APPLE.red;
  if (index >= 0.25) return APPLE.orange;
  return APPLE.mint;
}

function thrashLabel(index: number): string {
  if (index >= 0.75) return "Critical";
  if (index >= 0.5)  return "Elevated";
  if (index >= 0.25) return "Moderate";
  return "Nominal";
}

/* ── Traffic lights ───────────────────────────────────────────────────── */
function TrafficLights() {
  return (
    <div className="traffic-lights" aria-hidden>
      <span className="traffic-light traffic-light-close"  title="Close" />
      <span className="traffic-light traffic-light-min"    title="Minimise" />
      <span className="traffic-light traffic-light-expand" title="Zoom" />
    </div>
  );
}

/* ── Status pill ──────────────────────────────────────────────────────── */
function StatusPill({ status }: { status: ConnectionStatus }) {
  const map: Record<ConnectionStatus, { color: string; label: string; pulse: boolean }> = {
    connected:    { color: APPLE.mint,   label: "Live",           pulse: true  },
    connecting:   { color: APPLE.blue,   label: "Connecting…",   pulse: false },
    reconnecting: { color: APPLE.orange, label: "Reconnecting…", pulse: false },
    error:        { color: APPLE.red,    label: "Disconnected",  pulse: false },
  };
  const { color, label, pulse } = map[status];

  return (
    <span
      className="status-pill"
      style={{
        backgroundColor: `${color}1a`,
        borderColor:     `${color}40`,
        color,
      }}
    >
      <span
        className={clsx(
          "inline-block h-[6px] w-[6px] rounded-full flex-shrink-0",
          pulse && "animate-pulse"
        )}
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}

/* ── Segmented control ────────────────────────────────────────────────── */
const VIEWS: { id: ActiveView; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "memory",   label: "Memory"   },
  { id: "swap",     label: "Swap"     },
  { id: "pressure", label: "Pressure" },
];

function SegmentedControl({
  active,
  onChange,
}: {
  active: ActiveView;
  onChange: (v: ActiveView) => void;
}) {
  return (
    <div className="seg-control" role="tablist" aria-label="Dashboard view">
      {VIEWS.map(({ id, label }) => (
        <button
          key={id}
          role="tab"
          aria-selected={active === id}
          className={clsx("seg-btn", active === id && "seg-btn-active")}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
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
    <div
      style={{
        background:     "rgba(28,28,30,0.95)",
        border:         "1px solid rgba(255,255,255,0.1)",
        borderRadius:   8,
        padding:        "8px 12px",
        fontSize:       12,
        color:          "#f2f2f7",
        backdropFilter: "blur(20px)",
        boxShadow:      "0 4px 20px rgba(0,0,0,0.5)",
      }}
    >
      <p style={{ color: "rgba(235,235,245,0.45)", marginBottom: 4 }}>{label}</p>
      <p style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
        {payload[0].value.toLocaleString("en-US")}{unit ? ` ${unit}` : ""}
      </p>
    </div>
  );
}

/* ── Metric row ───────────────────────────────────────────────────────── */
interface MetricRowProps {
  label:  string;
  value:  string;
  sub?:   string;
  accent: string;
}

function MetricRow({ label, value, sub, accent }: MetricRowProps) {
  return (
    <div className="flex flex-col gap-1 py-3">
      <span className="metric-label">{label}</span>
      <span className="metric-value" style={{ color: accent }}>{value}</span>
      {sub && <span className="metric-sub">{sub}</span>}
    </div>
  );
}

/* ── Area chart ───────────────────────────────────────────────────────── */
interface MiniChartProps {
  data:    ChartPoint[];
  dataKey: keyof ChartPoint;
  color:   string;
  unit:    string;
  domain?: [number | string, number | string];
}

function MiniChart({ data, dataKey, color, unit, domain }: MiniChartProps) {
  const gradId     = `grad-${dataKey}`;
  const axisStyle  = { fill: "rgba(235,235,245,0.3)", fontSize: 10 };
  const gridStroke = "rgba(255,255,255,0.05)";

  return (
    <ResponsiveContainer width="100%" height={160}>
      <AreaChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: -8 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={color} stopOpacity={0.35} />
            <stop offset="95%" stopColor={color} stopOpacity={0}    />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={gridStroke} vertical={false} />
        <XAxis
          dataKey="t"
          tick={axisStyle}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={axisStyle}
          tickLine={false}
          axisLine={false}
          width={44}
          domain={domain}
        />
        <Tooltip content={<ChartTooltip unit={unit} />} />
        <Area
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={1.5}
          fill={`url(#${gradId})`}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* ── Full-width chart card ────────────────────────────────────────────── */
function FullChartCard({
  title,
  children,
}: {
  title:    string;
  children: React.ReactNode;
}) {
  return (
    <div className="mac-card p-5">
      <p
        style={{
          fontSize:      12,
          fontWeight:    600,
          color:         "rgba(235,235,245,0.5)",
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          marginBottom:  12,
        }}
      >
        {title}
      </p>
      {children}
    </div>
  );
}

/* ── Overview grid ────────────────────────────────────────────────────── */
function OverviewGrid({
  latest,
  history,
}: {
  latest:  TelemetryFrame | null;
  history: ChartPoint[];
}) {
  const tIdx   = latest?.thrash_index ?? 0;
  const tColor = latest ? thrashAccent(tIdx) : APPLE.gray;

  const vramPct = latest && latest.limit_mb > 0
    ? ((latest.wired_mb / latest.limit_mb) * 100).toFixed(1)
    : "—";
  const swapPct = latest && latest.swap_total_mb > 0
    ? ((latest.swap_used_mb / latest.swap_total_mb) * 100).toFixed(1)
    : "—";

  const stats = [
    {
      label:  "VRAM Wired",
      value:  latest ? `${fmtMB(Math.round(latest.wired_mb))} MB` : "—",
      sub:    latest ? `${vramPct}% of ${fmtMB(latest.limit_mb)} MB` : "Loading…",
      accent: APPLE.blue,
    },
    {
      label:  "Swap Used",
      value:  latest ? `${fmtMB(Math.round(latest.swap_used_mb))} MB` : "—",
      sub:    latest ? `${swapPct}% of ${fmtMB(Math.round(latest.swap_total_mb))} MB` : "Loading…",
      accent: APPLE.cyan,
    },
    {
      label:  "Pageouts",
      value:  latest ? fmtMB(latest.pageouts) : "—",
      sub:    "cumulative since boot",
      accent: APPLE.orange,
    },
    {
      label:  "Thrash Index",
      value:  latest ? tIdx.toFixed(3) : "—",
      sub:    latest ? thrashLabel(tIdx) : "—",
      accent: tColor,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Stat strip */}
      <div className="mac-card grid grid-cols-2 sm:grid-cols-4">
        {stats.map(({ label, value, sub, accent }, i) => (
          <div
            key={label}
            className="px-5"
            style={{
              borderRight: i < stats.length - 1
                ? "1px solid rgba(255,255,255,0.06)"
                : undefined,
            }}
          >
            <MetricRow label={label} value={value} sub={sub} accent={accent} />
          </div>
        ))}
      </div>

      {/* 2 × 2 chart grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FullChartCard title="VRAM Wired (MB)">
          <MiniChart data={history} dataKey="wired_mb"     color={APPLE.blue}   unit="MB" />
        </FullChartCard>
        <FullChartCard title="Swap Used (MB)">
          <MiniChart data={history} dataKey="swap_used_mb" color={APPLE.cyan}   unit="MB" />
        </FullChartCard>
        <FullChartCard title="Pageouts">
          <MiniChart data={history} dataKey="pageouts"     color={APPLE.orange} unit=""   />
        </FullChartCard>
        <FullChartCard title="Thrash Danger Index">
          <MiniChart data={history} dataKey="thrash_index" color={tColor} unit="" domain={[0, 1]} />
        </FullChartCard>
      </div>
    </div>
  );
}

/* ── Focused single-metric view ───────────────────────────────────────── */
function FocusView({
  title,
  latest,
  history,
  dataKey,
  color,
  unit,
  valueFn,
  subFn,
  domain,
}: {
  title:   string;
  latest:  TelemetryFrame | null;
  history: ChartPoint[];
  dataKey: keyof ChartPoint;
  color:   string;
  unit:    string;
  valueFn: (f: TelemetryFrame) => string;
  subFn:   (f: TelemetryFrame) => string;
  domain?: [number | string, number | string];
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="mac-card px-6 py-2">
        <MetricRow
          label={title}
          value={latest ? valueFn(latest) : "—"}
          sub={latest ? subFn(latest) : "Loading…"}
          accent={color}
        />
      </div>
      <FullChartCard title={`${title} — 60s window`}>
        <MiniChart
          data={history}
          dataKey={dataKey}
          color={color}
          unit={unit}
          domain={domain}
        />
      </FullChartCard>
    </div>
  );
}

/* ── Main dashboard ───────────────────────────────────────────────────── */
export default function Home() {
  const [history, setHistory] = useState<ChartPoint[]>([]);
  const [latest,  setLatest]  = useState<TelemetryFrame | null>(null);
  const [status,  setStatus]  = useState<ConnectionStatus>("connecting");
  const [view,    setView]    = useState<ActiveView>("overview");

  const wsRef         = useRef<WebSocket | null>(null);
  const retryRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(BASE_RETRY_MS);
  const mountedRef    = useRef(true);

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
        /* malformed frame — skip */
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

  const tIdx   = latest?.thrash_index ?? 0;
  const tColor = latest ? thrashAccent(tIdx) : APPLE.gray;

  return (
    <div
      className={geistMono.variable}
      style={{
        minHeight:  "100vh",
        background: "#121214",
        fontFamily: "-apple-system, 'SF Pro Display', 'Helvetica Neue', sans-serif",
      }}
    >
      {/* Ambient background glows */}
      <div
        aria-hidden
        style={{
          position:      "fixed",
          inset:         0,
          overflow:      "hidden",
          pointerEvents: "none",
          zIndex:        0,
        }}
      >
        <div
          style={{
            position:     "absolute",
            top:          -160,
            left:         -160,
            width:        480,
            height:       480,
            borderRadius: "50%",
            background:   "radial-gradient(circle, rgba(10,132,255,0.12) 0%, transparent 70%)",
            filter:       "blur(40px)",
          }}
        />
        <div
          style={{
            position:     "absolute",
            bottom:       -120,
            right:        -120,
            width:        400,
            height:       400,
            borderRadius: "50%",
            background:   "radial-gradient(circle, rgba(48,209,88,0.08) 0%, transparent 70%)",
            filter:       "blur(40px)",
          }}
        />
      </div>

      {/* Page layout */}
      <div
        style={{
          position: "relative",
          zIndex:   1,
          maxWidth: 1080,
          margin:   "0 auto",
          padding:  "32px 24px 48px",
        }}
      >
        {/* macOS window */}
        <div className="mac-window">

          {/* Title bar */}
          <div className="mac-titlebar">
            <TrafficLights />

            {/* Centred title */}
            <div
              style={{
                position:   "absolute",
                left:       "50%",
                transform:  "translateX(-50%)",
                display:    "flex",
                alignItems: "center",
                gap:        8,
              }}
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
                <circle cx="7.5" cy="7.5" r="7"   stroke={APPLE.blue} strokeWidth="1.2" />
                <circle cx="7.5" cy="7.5" r="3.5" fill={APPLE.blue}   fillOpacity={0.6} />
              </svg>
              <span
                style={{
                  fontSize:      13,
                  fontWeight:    600,
                  color:         "rgba(235,235,245,0.85)",
                  letterSpacing: "-0.01em",
                  userSelect:    "none",
                }}
              >
                Sentinel-AI
              </span>
            </div>

            {/* Right: status pill */}
            <div style={{ marginLeft: "auto" }}>
              <StatusPill status={status} />
            </div>
          </div>

          {/* Sub-toolbar: segmented control */}
          <div
            style={{
              display:        "flex",
              alignItems:     "center",
              justifyContent: "center",
              padding:        "10px 16px",
              borderBottom:   "1px solid rgba(255,255,255,0.06)",
              background:     "rgba(28,28,30,0.6)",
            }}
          >
            <SegmentedControl active={view} onChange={setView} />
          </div>

          {/* Content area */}
          <div style={{ padding: "20px 20px 24px" }}>
            {view === "overview" && (
              <OverviewGrid latest={latest} history={history} />
            )}

            {view === "memory" && (
              <FocusView
                title="VRAM Wired"
                latest={latest}
                history={history}
                dataKey="wired_mb"
                color={APPLE.blue}
                unit="MB"
                valueFn={(f) => `${fmtMB(Math.round(f.wired_mb))} MB`}
                subFn={(f) =>
                  f.limit_mb > 0
                    ? `${((f.wired_mb / f.limit_mb) * 100).toFixed(1)}% of ${fmtMB(f.limit_mb)} MB limit`
                    : "—"
                }
              />
            )}

            {view === "swap" && (
              <FocusView
                title="Swap Used"
                latest={latest}
                history={history}
                dataKey="swap_used_mb"
                color={APPLE.cyan}
                unit="MB"
                valueFn={(f) => `${fmtMB(Math.round(f.swap_used_mb))} MB`}
                subFn={(f) =>
                  f.swap_total_mb > 0
                    ? `${((f.swap_used_mb / f.swap_total_mb) * 100).toFixed(1)}% of ${fmtMB(Math.round(f.swap_total_mb))} MB`
                    : "—"
                }
              />
            )}

            {view === "pressure" && (
              <div className="flex flex-col gap-4">
                <FocusView
                  title="Thrash Index"
                  latest={latest}
                  history={history}
                  dataKey="thrash_index"
                  color={tColor}
                  unit=""
                  valueFn={(f) => f.thrash_index.toFixed(3)}
                  subFn={(f) => thrashLabel(f.thrash_index)}
                  domain={[0, 1]}
                />
                <FocusView
                  title="Pageouts"
                  latest={latest}
                  history={history}
                  dataKey="pageouts"
                  color={APPLE.orange}
                  unit=""
                  valueFn={(f) => fmtMB(f.pageouts)}
                  subFn={() => "cumulative since boot"}
                />
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <p
          style={{
            marginTop:  20,
            textAlign:  "center",
            fontSize:   11,
            color:      "rgba(235,235,245,0.2)",
            userSelect: "none",
          }}
        >
          Sentinel-AI · macOS sysctl &amp; vm_stat · {MAX_POINTS}s rolling window
        </p>
      </div>
    </div>
  );
}
