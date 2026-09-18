/**
 * web/src/pages/index.tsx
 *
 * Sentinel-AI — production-grade macOS HIG telemetry dashboard
 * Authentic Liquid Glass materials, SF Pro typography, semantic state colours.
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
  subsets:  ["latin"],
});

/* ── Apple semantic palette ───────────────────────────────────────────── */
const APPLE = {
  blue:        "#0a84ff",
  mint:        "#30d158",
  orange:      "#ff9f0a",
  red:         "#ff453a",
  cyan:        "#32ade6",
  indigo:      "#5e5ce6",
  label:       "#f2f2f7",
  label2:      "rgba(235,235,245,0.6)",
  label3:      "rgba(235,235,245,0.3)",
  label4:      "rgba(235,235,245,0.16)",
  separator:   "rgba(255,255,255,0.08)",
  fillTertiary:"rgba(118,118,128,0.18)",
} as const;

/* ── Types ────────────────────────────────────────────────────────────── */
interface TelemetryFrame {
  timestamp:    number;
  wired_mb:     number;
  limit_mb:     number;
  swap_total_mb:number;
  swap_used_mb: number;
  pageouts:     number;
  thrash_index: number;
}

interface ChartPoint {
  t:            string;
  wired_mb:     number;
  swap_used_mb: number;
  pageouts:     number;
  thrash_index: number;
}

type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "error";
type ActiveView       = "overview"  | "memory"    | "swap"          | "pressure";

const WS_URL        = "ws://127.0.0.1:8000/ws/telemetry";
const MAX_POINTS    = 60;
const BASE_RETRY_MS = 1_500;
const MAX_RETRY_MS  = 30_000;
const VRAM_BUDGET   = 18_432; // MB — M-series 18 GB unified memory

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

/** Semantic thrash colour: Mint → Orange → Red */
function thrashColor(index: number): string {
  if (index >= 0.7) return APPLE.red;
  if (index >= 0.3) return APPLE.orange;
  return APPLE.mint;
}

function thrashLabel(index: number): string {
  if (index >= 0.7) return "Critical";
  if (index >= 0.5) return "Elevated";
  if (index >= 0.3) return "Moderate";
  return "Nominal";
}

/* ══════════════════════════════════════════════════════════════════════
   TRAFFIC LIGHTS
══════════════════════════════════════════════════════════════════════ */
function TrafficLights() {
  return (
    <div className="traffic-lights" aria-hidden="true">
      <span className="tl tl-close"  title="Close"    />
      <span className="tl tl-min"    title="Minimise" />
      <span className="tl tl-zoom"   title="Zoom"     />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   STATUS BADGE  –  mint dot with radial glow when live
══════════════════════════════════════════════════════════════════════ */
function StatusBadge({ status }: { status: ConnectionStatus }) {
  const cfg: Record<ConnectionStatus, { color: string; label: string; glow: boolean }> = {
    connected:    { color: APPLE.mint,   label: "Live",           glow: true  },
    connecting:   { color: APPLE.blue,   label: "Connecting…",   glow: false },
    reconnecting: { color: APPLE.orange, label: "Reconnecting…", glow: false },
    error:        { color: APPLE.red,    label: "Disconnected",  glow: false },
  };
  const { color, label, glow } = cfg[status];

  return (
    <span
      className="status-badge"
      style={{
        background:   `${color}18`,
        borderColor:  `${color}38`,
        color,
      }}
    >
      <span
        className={clsx("status-dot", glow && "status-dot-live")}
        style={{
          background: color,
          boxShadow: glow ? `0 0 6px 2px ${color}70` : "none",
        }}
      />
      {label}
    </span>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   SEGMENTED CONTROL
══════════════════════════════════════════════════════════════════════ */
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
  active:   ActiveView;
  onChange: (v: ActiveView) => void;
}) {
  return (
    <nav className="seg-track" role="tablist" aria-label="Dashboard view">
      {VIEWS.map(({ id, label }) => (
        <button
          key={id}
          role="tab"
          aria-selected={active === id}
          className={clsx("seg-item", active === id && "seg-item--active")}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   VRAM GAUGE  –  native progress bar + wired vs budget
══════════════════════════════════════════════════════════════════════ */
function VramGauge({
  wired_mb,
  limit_mb,
}: {
  wired_mb: number;
  limit_mb: number;
}) {
  const budget   = limit_mb > 0 ? limit_mb : VRAM_BUDGET;
  const pct      = Math.min((wired_mb / budget) * 100, 100);
  const barColor =
    pct >= 80 ? APPLE.red : pct >= 55 ? APPLE.orange : APPLE.blue;

  return (
    <div className="vram-gauge">
      {/* Track */}
      <div className="vram-track">
        <div
          className="vram-fill"
          style={{
            width:      `${pct}%`,
            background: barColor,
            boxShadow:  `0 0 8px 0 ${barColor}60`,
          }}
        />
      </div>
      {/* Labels */}
      <div className="vram-labels">
        <span style={{ color: barColor, fontVariantNumeric: "tabular-nums" }}>
          {fmtMB(Math.round(wired_mb))} MB
        </span>
        <span style={{ color: APPLE.label3 }}>
          {pct.toFixed(1)}% of {fmtMB(budget)} MB
        </span>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   THRASH METER  –  segmented indicator bar
══════════════════════════════════════════════════════════════════════ */
function ThrashMeter({ index }: { index: number }) {
  const color = thrashColor(index);
  const pct   = Math.min(index * 100, 100);
  const label = thrashLabel(index);

  return (
    <div className="thrash-meter">
      <div className="vram-track">
        <div
          className="vram-fill"
          style={{
            width:      `${pct}%`,
            background: color,
            boxShadow:  `0 0 8px 0 ${color}60`,
          }}
        />
      </div>
      <div className="vram-labels">
        <span style={{ color, fontVariantNumeric: "tabular-nums" }}>
          {index.toFixed(3)}
        </span>
        <span style={{ color: APPLE.label3 }}>{label}</span>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   STAT CARD  –  glass tile
══════════════════════════════════════════════════════════════════════ */
interface StatCardProps {
  label:    string;
  accent:   string;
  children: React.ReactNode;
}

function StatCard({ label, accent, children }: StatCardProps) {
  return (
    <div className="stat-card">
      <span className="stat-label" style={{ color: accent }}>
        {label}
      </span>
      <div className="stat-body">{children}</div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   CHART TOOLTIP  –  native popover style
══════════════════════════════════════════════════════════════════════ */
function ChartTooltip({
  active,
  payload,
  label,
  unit,
}: {
  active?:  boolean;
  payload?: Array<{ value: number }>;
  label?:   string;
  unit:     string;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="chart-tooltip">
      <span className="chart-tooltip-time">{label}</span>
      <span className="chart-tooltip-value" style={{ fontVariantNumeric: "tabular-nums" }}>
        {payload[0].value.toLocaleString("en-US")}
        {unit ? <span className="chart-tooltip-unit"> {unit}</span> : null}
      </span>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   AREA CHART WRAPPER
══════════════════════════════════════════════════════════════════════ */
interface MiniChartProps {
  data:    ChartPoint[];
  dataKey: keyof ChartPoint;
  color:   string;
  unit:    string;
  domain?: [number | string, number | string];
}

function MiniChart({ data, dataKey, color, unit, domain }: MiniChartProps) {
  const gradId    = `grad-${String(dataKey)}`;
  const axisColor = APPLE.label4;
  const gridColor = "rgba(255,255,255,0.04)";

  return (
    <ResponsiveContainer width="100%" height={168}>
      <AreaChart data={data} margin={{ top: 8, right: 2, bottom: 0, left: -10 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={color} stopOpacity={0.4} />
            <stop offset="100%" stopColor={color} stopOpacity={0}   />
          </linearGradient>
        </defs>

        <CartesianGrid
          stroke={gridColor}
          vertical={false}
          strokeDasharray="0"
        />

        <XAxis
          dataKey="t"
          tick={{ fill: APPLE.label3, fontSize: 10, fontFamily: "-apple-system" }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
          style={{ userSelect: "none" }}
        />
        <YAxis
          tick={{ fill: APPLE.label3, fontSize: 10, fontFamily: "-apple-system", dx: -2 }}
          tickLine={false}
          axisLine={false}
          width={46}
          domain={domain}
          tickFormatter={(v: number) =>
            v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)
          }
          style={{ userSelect: "none" }}
        />

        <Tooltip
          content={<ChartTooltip unit={unit} />}
          cursor={{ stroke: axisColor, strokeWidth: 1 }}
        />

        <Area
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={1.5}
          fill={`url(#${gradId})`}
          dot={false}
          activeDot={{ r: 3, fill: color, strokeWidth: 0 }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   CHART CARD
══════════════════════════════════════════════════════════════════════ */
function ChartCard({
  title,
  children,
}: {
  title:    string;
  children: React.ReactNode;
}) {
  return (
    <div className="chart-card">
      <p className="chart-card-title">{title}</p>
      {children}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   OVERVIEW GRID
══════════════════════════════════════════════════════════════════════ */
function OverviewGrid({
  latest,
  history,
}: {
  latest:  TelemetryFrame | null;
  history: ChartPoint[];
}) {
  const tIdx   = latest?.thrash_index ?? 0;
  const tColor = latest ? thrashColor(tIdx) : APPLE.label4;

  const swapPct =
    latest && latest.swap_total_mb > 0
      ? ((latest.swap_used_mb / latest.swap_total_mb) * 100).toFixed(1)
      : "—";

  return (
    <div className="overview-layout">

      {/* ── Stat cards row ── */}
      <div className="stat-row">

        {/* VRAM */}
        <StatCard label="VRAM Wired" accent={APPLE.blue}>
          {latest ? (
            <VramGauge wired_mb={latest.wired_mb} limit_mb={latest.limit_mb} />
          ) : (
            <span className="stat-placeholder">Loading…</span>
          )}
        </StatCard>

        {/* Thrash Danger Index */}
        <StatCard label="Thrash Danger Index" accent={tColor}>
          {latest ? (
            <ThrashMeter index={tIdx} />
          ) : (
            <span className="stat-placeholder">Loading…</span>
          )}
        </StatCard>

        {/* Swap Committed */}
        <StatCard label="Swap Committed" accent={APPLE.cyan}>
          <div className="stat-value" style={{ color: APPLE.cyan, fontVariantNumeric: "tabular-nums" }}>
            {latest ? `${fmtMB(Math.round(latest.swap_used_mb))} MB` : "—"}
          </div>
          <div className="stat-sub">
            {latest
              ? `${swapPct}% of ${fmtMB(Math.round(latest.swap_total_mb))} MB`
              : "Loading…"}
          </div>
        </StatCard>

        {/* Cumulative Pageouts */}
        <StatCard label="Cumulative Pageouts" accent={APPLE.orange}>
          <div className="stat-value" style={{ color: APPLE.orange, fontVariantNumeric: "tabular-nums" }}>
            {latest ? fmtMB(latest.pageouts) : "—"}
          </div>
          <div className="stat-sub">since boot</div>
        </StatCard>

      </div>

      {/* ── 2×2 chart grid ── */}
      <div className="chart-grid">
        <ChartCard title="VRAM Wired — MB">
          <MiniChart data={history} dataKey="wired_mb"     color={APPLE.blue}   unit="MB" />
        </ChartCard>
        <ChartCard title="Swap Used — MB">
          <MiniChart data={history} dataKey="swap_used_mb" color={APPLE.cyan}   unit="MB" />
        </ChartCard>
        <ChartCard title="Pageouts — cumulative">
          <MiniChart data={history} dataKey="pageouts"     color={APPLE.orange} unit=""   />
        </ChartCard>
        <ChartCard title="Thrash Danger Index — 0–1">
          <MiniChart data={history} dataKey="thrash_index" color={tColor}       unit=""   domain={[0, 1]} />
        </ChartCard>
      </div>

    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   FOCUSED SINGLE-METRIC VIEW
══════════════════════════════════════════════════════════════════════ */
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
  gauge,
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
  gauge?:  React.ReactNode;
}) {
  return (
    <div className="focus-layout">
      <div className="stat-card focus-hero">
        <span className="stat-label" style={{ color }}>{title}</span>
        <div className="stat-body">
          <div className="stat-value" style={{ color, fontVariantNumeric: "tabular-nums" }}>
            {latest ? valueFn(latest) : "—"}
          </div>
          <div className="stat-sub">
            {latest ? subFn(latest) : "Loading…"}
          </div>
          {gauge && <div style={{ marginTop: 16 }}>{gauge}</div>}
        </div>
      </div>
      <ChartCard title={`${title} — 60 s window`}>
        <MiniChart
          data={history}
          dataKey={dataKey}
          color={color}
          unit={unit}
          domain={domain}
        />
      </ChartCard>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   MAIN DASHBOARD
══════════════════════════════════════════════════════════════════════ */
export default function Home() {
  const [history, setHistory] = useState<ChartPoint[]>([]);
  const [latest,  setLatest]  = useState<TelemetryFrame | null>(null);
  const [status,  setStatus]  = useState<ConnectionStatus>("connecting");
  const [view,    setView]    = useState<ActiveView>("overview");

  const wsRef         = useRef<WebSocket | null>(null);
  const retryRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(BASE_RETRY_MS);
  const mountedRef    = useRef(true);

  /* ── WebSocket with exponential back-off reconnect ── */
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
  const tColor = latest ? thrashColor(tIdx) : APPLE.label4;

  /* ── Render ── */
  return (
    <div
      className={geistMono.variable}
      style={{
        minHeight:  "100dvh",
        background: "#0d0d0f",
        fontFamily: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display",
                     "Helvetica Neue", Arial, sans-serif`,
      }}
    >
      {/* ── Ambient background glows ── */}
      <div aria-hidden="true" className="ambient-layer">
        <div className="glow glow-blue"  />
        <div className="glow glow-green" />
      </div>

      {/* ── Page wrapper ── */}
      <div className="page-wrapper">

        {/* ── macOS window frame ── */}
        <div className="mac-window">

          {/* Title bar */}
          <header className="mac-titlebar">
            <TrafficLights />

            {/* Window title — centred absolutely */}
            <div className="window-title-center">
              <svg
                width="14" height="14" viewBox="0 0 14 14"
                fill="none" aria-hidden="true"
              >
                <circle cx="7" cy="7" r="6.25" stroke={APPLE.blue} strokeWidth="1.5" />
                <circle cx="7" cy="7" r="3"    fill={APPLE.blue}   fillOpacity={0.7} />
              </svg>
              <span className="window-title-text">Sentinel-AI</span>
            </div>

            {/* Right: live status badge */}
            <div className="window-title-right">
              <StatusBadge status={status} />
            </div>
          </header>

          {/* Unified toolbar — segmented control */}
          <div className="unified-toolbar">
            <SegmentedControl active={view} onChange={setView} />
          </div>

          {/* Content */}
          <main className="window-content">
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
                    ? `${((f.wired_mb / f.limit_mb) * 100).toFixed(1)}% of ${fmtMB(f.limit_mb)} MB budget`
                    : "—"
                }
                gauge={
                  latest ? (
                    <VramGauge
                      wired_mb={latest.wired_mb}
                      limit_mb={latest.limit_mb}
                    />
                  ) : undefined
                }
              />
            )}

            {view === "swap" && (
              <FocusView
                title="Swap Committed"
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
              <div className="focus-layout">
                <FocusView
                  title="Thrash Danger Index"
                  latest={latest}
                  history={history}
                  dataKey="thrash_index"
                  color={tColor}
                  unit=""
                  valueFn={(f) => f.thrash_index.toFixed(3)}
                  subFn={(f) => thrashLabel(f.thrash_index)}
                  domain={[0, 1]}
                  gauge={latest ? <ThrashMeter index={tIdx} /> : undefined}
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
          </main>
        </div>

        {/* Footer */}
        <footer className="page-footer">
          Sentinel-AI · macOS sysctl &amp; vm_stat · {MAX_POINTS}s rolling window
        </footer>
      </div>
    </div>
  );
}
