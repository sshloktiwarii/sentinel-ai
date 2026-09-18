/**
 * web/src/pages/index.tsx
 *
 * Sentinel-AI — production-grade macOS HIG telemetry dashboard
 * Authentic Liquid Glass materials, SF Pro typography, semantic state colours.
 */

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  Fragment,
} from "react";
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
  ReferenceLine,
} from "recharts";

/* ── Font ─────────────────────────────────────────────────────────────── */
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/* ── Apple semantic palette ───────────────────────────────────────────── */
const APPLE = {
  blue:         "#0a84ff",
  mint:         "#30d158",
  orange:       "#ff9f0a",
  red:          "#ff453a",
  cyan:         "#32ade6",
  indigo:       "#5e5ce6",
  label:        "#f2f2f7",
  label2:       "rgba(235,235,245,0.6)",
  label3:       "rgba(235,235,245,0.3)",
  label4:       "rgba(235,235,245,0.16)",
  separator:    "rgba(255,255,255,0.08)",
  fillTertiary: "rgba(118,118,128,0.18)",
} as const;

/* ── Types ────────────────────────────────────────────────────────────── */
interface TelemetryFrame {
  timestamp:     number;
  wired_mb:      number;
  limit_mb:      number;
  swap_total_mb: number;
  swap_used_mb:  number;
  pageouts:      number;
  thrash_index:  number;
}

interface ChartPoint {
  t:            string;
  ts:           number; // raw unix timestamp for spike matching
  wired_mb:     number;
  swap_used_mb: number;
  pageouts:     number;
  thrash_index: number;
}

interface SpikeRecord {
  timestamp:    number;
  thrash_index: number;
  wired_mb:     number;
  swap_used_mb: number;
  pageouts:     number;
}

type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "error";
type ActiveView       = "overview"  | "memory"    | "swap"         | "pressure";
type TimeWindow       = "1m"        | "5m"        | "1h";

const API_BASE      = "http://127.0.0.1:8000";
const WS_URL        = "ws://127.0.0.1:8000/ws/telemetry";
const MAX_POINTS    = 60;
const BASE_RETRY_MS = 1_500;
const MAX_RETRY_MS  = 30_000;
const VRAM_BUDGET   = 18_432; // MB — M-series 18 GB unified memory

// Minimum points before we consider data "ready" to plot
const MIN_PLOT_POINTS = 5;

// How often to re-fetch historical data when in 5m/1h mode (ms)
const HISTORY_POLL_MS: Record<TimeWindow, number> = {
  "1m": 0,       // not used — live stream
  "5m": 15_000,  // refresh every 15 s
  "1h": 60_000,  // refresh every 60 s
};

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
    ts:           f.timestamp,
    wired_mb:     Math.round(f.wired_mb),
    swap_used_mb: Math.round(f.swap_used_mb * 10) / 10,
    pageouts:     f.pageouts,
    thrash_index: Math.round(f.thrash_index * 1000) / 1000,
  };
}

/** Convert a raw history row (no limit_mb / swap_total_mb) to a ChartPoint. */
function historyRowToChartPoint(row: Record<string, number>): ChartPoint {
  return {
    t:            fmtTime(row.timestamp),
    ts:           row.timestamp,
    wired_mb:     Math.round(row.wired_mb),
    swap_used_mb: Math.round(row.swap_used_mb * 10) / 10,
    pageouts:     Math.round(row.pageouts),
    thrash_index: Math.round(row.thrash_index * 1000) / 1000,
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

/* ── Alert-triangle icon (inline SVG, no extra dep) ──────────────────── */
function IconAlertTriangle({ color = APPLE.orange, size = 14 }: { color?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   TRAFFIC LIGHTS
══════════════════════════════════════════════════════════════════════ */
function TrafficLights() {
  return (
    <div className="traffic-lights" aria-hidden="true">
      <span className="tl tl-close" title="Close" />
      <span className="tl tl-min"   title="Minimise" />
      <span className="tl tl-zoom"  title="Zoom" />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   STATUS BADGE
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
        background:  `${color}18`,
        borderColor: `${color}38`,
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
   SEGMENTED CONTROL  (view picker)
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
   TIME WINDOW PICKER  –  sliding capsule indicator, Apple HIG style
══════════════════════════════════════════════════════════════════════ */
const TIME_WINDOWS: TimeWindow[] = ["1m", "5m", "1h"];

function TimeWindowPicker({
  active,
  onChange,
}: {
  active:   TimeWindow;
  onChange: (w: TimeWindow) => void;
}) {
  const idx = TIME_WINDOWS.indexOf(active);

  return (
    <div
      className="tw-track"
      role="group"
      aria-label="Time window"
      style={{
        position:     "relative",
        display:      "inline-flex",
        background:   APPLE.fillTertiary,
        borderRadius: 8,
        padding:      2,
        gap:          0,
        border:       `1px solid ${APPLE.separator}`,
      }}
    >
      {/* Sliding capsule */}
      <span
        aria-hidden="true"
        style={{
          position:     "absolute",
          top:          2,
          bottom:       2,
          left:         `calc(${idx} * (100% - 4px) / ${TIME_WINDOWS.length} + 2px)`,
          width:        `calc((100% - 4px) / ${TIME_WINDOWS.length})`,
          background:   "rgba(255,255,255,0.12)",
          borderRadius: 6,
          border:       `1px solid rgba(255,255,255,0.18)`,
          transition:   "left 0.18s cubic-bezier(0.4, 0, 0.2, 1)",
          pointerEvents:"none",
          boxShadow:    "0 1px 3px rgba(0,0,0,0.4)",
        }}
      />
      {TIME_WINDOWS.map((w) => (
        <button
          key={w}
          aria-pressed={active === w}
          onClick={() => onChange(w)}
          style={{
            position:       "relative",
            zIndex:         1,
            minWidth:       40,
            padding:        "3px 10px",
            fontSize:       11,
            fontWeight:     active === w ? 600 : 400,
            color:          active === w ? APPLE.label : APPLE.label3,
            background:     "transparent",
            border:         "none",
            borderRadius:   6,
            cursor:         "pointer",
            letterSpacing:  "0.02em",
            transition:     "color 0.15s",
            fontFamily:     "-apple-system, BlinkMacSystemFont, sans-serif",
            userSelect:     "none",
          }}
        >
          {w}
        </button>
      ))}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   VRAM GAUGE
══════════════════════════════════════════════════════════════════════ */
function VramGauge({ wired_mb, limit_mb }: { wired_mb: number; limit_mb: number }) {
  const budget   = limit_mb > 0 ? limit_mb : VRAM_BUDGET;
  const pct      = Math.min((wired_mb / budget) * 100, 100);
  const barColor = pct >= 80 ? APPLE.red : pct >= 55 ? APPLE.orange : APPLE.blue;

  return (
    <div className="vram-gauge">
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
   THRASH METER
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
   STAT CARD
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
   CHART TOOLTIP
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
      <span
        className="chart-tooltip-value"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {payload[0].value.toLocaleString("en-US")}
        {unit ? <span className="chart-tooltip-unit"> {unit}</span> : null}
      </span>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   EMPTY STATE — shown when fewer than MIN_PLOT_POINTS data points exist
══════════════════════════════════════════════════════════════════════ */
function ChartEmptyState({ loading }: { loading: boolean }) {
  return (
    <div
      aria-live="polite"
      style={{
        height:         168,
        display:        "flex",
        flexDirection:  "column",
        alignItems:     "center",
        justifyContent: "center",
        gap:            8,
        color:          APPLE.label3,
        fontFamily:     "-apple-system, BlinkMacSystemFont, sans-serif",
        fontSize:       12,
        letterSpacing:  "0.01em",
        userSelect:     "none",
      }}
    >
      {/* Subtle animated dot trio when loading */}
      {loading ? (
        <span
          style={{
            display:    "inline-flex",
            gap:        5,
          }}
          aria-label="Loading historical metrics"
        >
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={{
                width:            5,
                height:           5,
                borderRadius:     "50%",
                background:       APPLE.label4,
                display:          "inline-block",
                animation:        `sentinel-pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
              }}
            />
          ))}
        </span>
      ) : (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke={APPLE.label4}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {/* Simple waveform / chart icon */}
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
      )}
      <span>
        {loading ? "Fetching historical metrics…" : "Collecting historical metrics…"}
      </span>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   AREA CHART WRAPPER
══════════════════════════════════════════════════════════════════════ */
interface MiniChartProps {
  data:          ChartPoint[];
  dataKey:       keyof ChartPoint;
  color:         string;
  unit:          string;
  domain?:       [number | string, number | string];
  spikeMarkers?: SpikeRecord[]; // vertical reference lines for spike timestamps
  loading?:      boolean;
}

function MiniChart({ data, dataKey, color, unit, domain, spikeMarkers, loading }: MiniChartProps) {
  const gradId    = `grad-${String(dataKey)}`;
  const axisColor = APPLE.label4;
  const gridColor = "rgba(255,255,255,0.04)";

  // Show empty state when data is too sparse
  if (data.length < MIN_PLOT_POINTS) {
    return <ChartEmptyState loading={loading ?? false} />;
  }

  const firstTs = data[0]?.ts  ?? 0;
  const lastTs  = data[data.length - 1]?.ts ?? 0;

  const visibleSpikes =
    spikeMarkers?.filter(
      (s) => s.timestamp >= firstTs && s.timestamp <= lastTs
    ) ?? [];

  // Find the chart point with the closest timestamp to each spike
  function closestLabel(spikeTs: number): string {
    if (!data.length) return "";
    let best = data[0];
    let bestDiff = Math.abs(data[0].ts - spikeTs);
    for (const pt of data) {
      const diff = Math.abs(pt.ts - spikeTs);
      if (diff < bestDiff) {
        bestDiff = diff;
        best     = pt;
      }
    }
    return best.t;
  }

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
          domain={domain ?? ["auto", "auto"]}
          tickFormatter={(v: number) =>
            v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)
          }
          style={{ userSelect: "none" }}
        />

        <Tooltip
          content={<ChartTooltip unit={unit} />}
          cursor={{ stroke: axisColor, strokeWidth: 1 }}
        />

        {/* Spike reference lines */}
        {visibleSpikes.map((s) => (
          <ReferenceLine
            key={s.timestamp}
            x={closestLabel(s.timestamp)}
            stroke={APPLE.orange}
            strokeWidth={1.5}
            strokeDasharray="3 3"
            label={{
              value:    "⚠",
              position: "top",
              fill:     APPLE.orange,
              fontSize: 10,
            }}
          />
        ))}

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
  toolbar,
}: {
  title:    string;
  children: React.ReactNode;
  toolbar?: React.ReactNode;
}) {
  return (
    <div className="chart-card">
      <div
        style={{
          display:        "flex",
          alignItems:     "center",
          justifyContent: "space-between",
          marginBottom:   4,
        }}
      >
        <p className="chart-card-title" style={{ margin: 0 }}>
          {title}
        </p>
        {toolbar}
      </div>
      {children}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   SPIKES INSPECTOR  –  compact dropdown sheet
══════════════════════════════════════════════════════════════════════ */
function SpikesInspector({
  spikes,
  onSelect,
}: {
  spikes:   SpikeRecord[];
  onSelect: (s: SpikeRecord) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref             = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display:      "inline-flex",
          alignItems:   "center",
          gap:          6,
          padding:      "4px 10px",
          fontSize:     12,
          fontWeight:   500,
          color:        APPLE.orange,
          background:   `${APPLE.orange}14`,
          border:       `1px solid ${APPLE.orange}30`,
          borderRadius: 8,
          cursor:       "pointer",
          fontFamily:   "-apple-system, BlinkMacSystemFont, sans-serif",
          userSelect:   "none",
          transition:   "background 0.12s",
          whiteSpace:   "nowrap",
        }}
      >
        <IconAlertTriangle color={APPLE.orange} size={13} />
        Previous Spikes
        {spikes.length > 0 && (
          <span
            style={{
              background:   APPLE.orange,
              color:        "#000",
              borderRadius: 10,
              fontSize:     10,
              fontWeight:   700,
              padding:      "0 5px",
              lineHeight:   "16px",
              minWidth:     16,
              textAlign:    "center",
            }}
          >
            {spikes.length}
          </span>
        )}
      </button>

      {/* Dropdown sheet */}
      {open && (
        <div
          role="listbox"
          aria-label="Previous spike events"
          style={{
            position:     "absolute",
            top:          "calc(100% + 6px)",
            right:        0,
            zIndex:       100,
            minWidth:     280,
            background:   "rgba(28,28,30,0.92)",
            backdropFilter: "blur(20px) saturate(180%)",
            WebkitBackdropFilter: "blur(20px) saturate(180%)",
            border:       `1px solid ${APPLE.separator}`,
            borderRadius: 12,
            boxShadow:    "0 8px 32px rgba(0,0,0,0.6)",
            overflow:     "hidden",
          }}
        >
          {/* Sheet header */}
          <div
            style={{
              padding:      "10px 14px 8px",
              borderBottom: `1px solid ${APPLE.separator}`,
              display:      "flex",
              alignItems:   "center",
              gap:          6,
            }}
          >
            <IconAlertTriangle color={APPLE.orange} size={12} />
            <span
              style={{
                fontSize:      12,
                fontWeight:    600,
                color:         APPLE.label2,
                fontFamily:    "-apple-system, BlinkMacSystemFont, sans-serif",
                letterSpacing: "0.02em",
              }}
            >
              Spike Events — last 24 h
            </span>
          </div>

          {spikes.length === 0 ? (
            <div
              style={{
                padding:   "16px 14px",
                fontSize:  12,
                color:     APPLE.label3,
                fontFamily:"-apple-system, BlinkMacSystemFont, sans-serif",
                textAlign: "center",
              }}
            >
              No spikes detected
            </div>
          ) : (
            <ul
              style={{
                listStyle: "none",
                margin:    0,
                padding:   "4px 0",
              }}
            >
              {spikes.map((s, i) => {
                const tc = thrashColor(s.thrash_index);
                return (
                  <li key={s.timestamp}>
                    <button
                      role="option"
                      aria-selected={false}
                      onClick={() => {
                        onSelect(s);
                        setOpen(false);
                      }}
                      style={{
                        display:    "block",
                        width:      "100%",
                        textAlign:  "left",
                        padding:    "8px 14px",
                        background: "transparent",
                        border:     "none",
                        cursor:     "pointer",
                        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) =>
                        ((e.currentTarget as HTMLButtonElement).style.background =
                          "rgba(255,255,255,0.06)")
                      }
                      onMouseLeave={(e) =>
                        ((e.currentTarget as HTMLButtonElement).style.background =
                          "transparent")
                      }
                    >
                      <div
                        style={{
                          display:        "flex",
                          justifyContent: "space-between",
                          alignItems:     "baseline",
                          marginBottom:   2,
                        }}
                      >
                        <span style={{ fontSize: 11, color: APPLE.label3 }}>
                          #{i + 1} — {fmtTime(s.timestamp)}
                        </span>
                        <span
                          style={{
                            fontSize:          11,
                            fontWeight:        600,
                            color:             tc,
                            fontVariantNumeric:"tabular-nums",
                          }}
                        >
                          {thrashLabel(s.thrash_index)}
                        </span>
                      </div>
                      <div
                        style={{
                          display:    "flex",
                          gap:        12,
                          fontSize:   11,
                          color:      APPLE.label2,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        <span>
                          Thrash:{" "}
                          <span style={{ color: tc }}>
                            {s.thrash_index.toFixed(3)}
                          </span>
                        </span>
                        <span>
                          Wired:{" "}
                          <span style={{ color: APPLE.blue }}>
                            {fmtMB(Math.round(s.wired_mb))} MB
                          </span>
                        </span>
                        <span>
                          Swap:{" "}
                          <span style={{ color: APPLE.cyan }}>
                            {fmtMB(Math.round(s.swap_used_mb))} MB
                          </span>
                        </span>
                      </div>
                    </button>
                    {i < spikes.length - 1 && (
                      <div
                        style={{
                          height:     1,
                          background: APPLE.separator,
                          margin:     "0 14px",
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   OVERVIEW GRID
══════════════════════════════════════════════════════════════════════ */
function OverviewGrid({
  latest,
  history,
  histLoading,
  spikes,
  timeWindow,
  onTimeWindowChange,
}: {
  latest:              TelemetryFrame | null;
  history:             ChartPoint[];
  histLoading:         boolean;
  spikes:              SpikeRecord[];
  timeWindow:          TimeWindow;
  onTimeWindowChange:  (w: TimeWindow) => void;
}) {
  const tIdx   = latest?.thrash_index ?? 0;
  const tColor = latest ? thrashColor(tIdx) : APPLE.label4;

  const swapPct =
    latest && latest.swap_total_mb > 0
      ? ((latest.swap_used_mb / latest.swap_total_mb) * 100).toFixed(1)
      : "—";

  const windowToolbar = (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <TimeWindowPicker active={timeWindow} onChange={onTimeWindowChange} />
    </div>
  );

  return (
    <div className="overview-layout">

      {/* ── Stat cards row ── */}
      <div className="stat-row">

        <StatCard label="VRAM Wired" accent={APPLE.blue}>
          {latest ? (
            <VramGauge wired_mb={latest.wired_mb} limit_mb={latest.limit_mb} />
          ) : (
            <span className="stat-placeholder">Loading…</span>
          )}
        </StatCard>

        <StatCard label="Thrash Danger Index" accent={tColor}>
          {latest ? (
            <ThrashMeter index={tIdx} />
          ) : (
            <span className="stat-placeholder">Loading…</span>
          )}
        </StatCard>

        <StatCard label="Swap Committed" accent={APPLE.cyan}>
          <div
            className="stat-value"
            style={{ color: APPLE.cyan, fontVariantNumeric: "tabular-nums" }}
          >
            {latest ? `${fmtMB(Math.round(latest.swap_used_mb))} MB` : "—"}
          </div>
          <div className="stat-sub">
            {latest
              ? `${swapPct}% of ${fmtMB(Math.round(latest.swap_total_mb))} MB`
              : "Loading…"}
          </div>
        </StatCard>

        <StatCard label="Cumulative Pageouts" accent={APPLE.orange}>
          <div
            className="stat-value"
            style={{ color: APPLE.orange, fontVariantNumeric: "tabular-nums" }}
          >
            {latest ? fmtMB(latest.pageouts) : "—"}
          </div>
          <div className="stat-sub">since boot</div>
        </StatCard>

      </div>

      {/* ── 2×2 chart grid ── */}
      <div className="chart-grid">
        <ChartCard title="VRAM Wired — MB" toolbar={windowToolbar}>
          <MiniChart
            data={history}
            dataKey="wired_mb"
            color={APPLE.blue}
            unit="MB"
            spikeMarkers={spikes}
            loading={histLoading}
          />
        </ChartCard>
        <ChartCard title="Swap Used — MB">
          <MiniChart
            data={history}
            dataKey="swap_used_mb"
            color={APPLE.cyan}
            unit="MB"
            spikeMarkers={spikes}
            loading={histLoading}
          />
        </ChartCard>
        <ChartCard title="Pageouts — cumulative">
          <MiniChart
            data={history}
            dataKey="pageouts"
            color={APPLE.orange}
            unit=""
            spikeMarkers={spikes}
            loading={histLoading}
          />
        </ChartCard>
        <ChartCard title="Thrash Danger Index — 0–1">
          <MiniChart
            data={history}
            dataKey="thrash_index"
            color={tColor}
            unit=""
            domain={[0, 1]}
            spikeMarkers={spikes}
            loading={histLoading}
          />
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
  histLoading,
  dataKey,
  color,
  unit,
  valueFn,
  subFn,
  domain,
  gauge,
  spikes,
  timeWindow,
  onTimeWindowChange,
}: {
  title:               string;
  latest:              TelemetryFrame | null;
  history:             ChartPoint[];
  histLoading?:        boolean;
  dataKey:             keyof ChartPoint;
  color:               string;
  unit:                string;
  valueFn:             (f: TelemetryFrame) => string;
  subFn:               (f: TelemetryFrame) => string;
  domain?:             [number | string, number | string];
  gauge?:              React.ReactNode;
  spikes?:             SpikeRecord[];
  timeWindow?:         TimeWindow;
  onTimeWindowChange?: (w: TimeWindow) => void;
}) {
  return (
    <div className="focus-layout">
      <div className="stat-card focus-hero">
        <span className="stat-label" style={{ color }}>
          {title}
        </span>
        <div className="stat-body">
          <div
            className="stat-value"
            style={{ color, fontVariantNumeric: "tabular-nums" }}
          >
            {latest ? valueFn(latest) : "—"}
          </div>
          <div className="stat-sub">
            {latest ? subFn(latest) : "Loading…"}
          </div>
          {gauge && <div style={{ marginTop: 16 }}>{gauge}</div>}
        </div>
      </div>
      <ChartCard
        title={`${title} — ${timeWindow ?? "1m"} window`}
        toolbar={
          timeWindow && onTimeWindowChange ? (
            <TimeWindowPicker
              active={timeWindow}
              onChange={onTimeWindowChange}
            />
          ) : undefined
        }
      >
        <MiniChart
          data={history}
          dataKey={dataKey}
          color={color}
          unit={unit}
          domain={domain}
          spikeMarkers={spikes}
          loading={histLoading}
        />
      </ChartCard>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   CUSTOM HOOK — historical data fetcher
   Clears stale data immediately on window change so the chart never
   shows data from the previous window while fetching.
══════════════════════════════════════════════════════════════════════ */
function useHistoryData(window: TimeWindow) {
  const [data, setData]       = useState<ChartPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const timerRef              = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch_ = useCallback(async () => {
    if (window === "1m") return; // live stream handles this
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/history?window=${window}`);
      if (res.ok) {
        const rows: Record<string, number>[] = await res.json();
        setData(rows.map(historyRowToChartPoint));
      }
    } catch {
      // network error — keep stale data
    } finally {
      setLoading(false);
    }
  }, [window]);

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (window === "1m") {
      // Clear any stale hist data so switching back to live is clean
      setData([]);
      setLoading(false);
      return;
    }

    // Clear immediately so we don't flash stale data from the previous window
    setData([]);
    fetch_();

    const interval = HISTORY_POLL_MS[window];
    if (interval > 0) {
      timerRef.current = setInterval(fetch_, interval);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [window, fetch_]);

  return { data, loading, refresh: fetch_ };
}

/* ══════════════════════════════════════════════════════════════════════
   CUSTOM HOOK — spikes fetcher
══════════════════════════════════════════════════════════════════════ */
function useSpikes() {
  const [spikes, setSpikes] = useState<SpikeRecord[]>([]);
  const timerRef            = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/spikes`);
      if (res.ok) {
        const data: SpikeRecord[] = await res.json();
        setSpikes(data);
      }
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    fetch_();
    timerRef.current = setInterval(fetch_, 60_000); // refresh every minute
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetch_]);

  return spikes;
}

/* ══════════════════════════════════════════════════════════════════════
   MAIN DASHBOARD
══════════════════════════════════════════════════════════════════════ */
export default function Home() {
  const [liveHistory, setLiveHistory] = useState<ChartPoint[]>([]);
  const [latest,      setLatest]      = useState<TelemetryFrame | null>(null);
  const [status,      setStatus]      = useState<ConnectionStatus>("connecting");
  const [view,        setView]        = useState<ActiveView>("overview");
  const [timeWindow,  setTimeWindow]  = useState<TimeWindow>("1m");

  // Highlighted spike — used to scroll/focus a specific moment
  const [highlightedSpike, setHighlightedSpike] = useState<SpikeRecord | null>(null);

  const wsRef         = useRef<WebSocket | null>(null);
  const retryRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(BASE_RETRY_MS);
  const mountedRef    = useRef(true);

  const { data: histData, loading: histLoading } = useHistoryData(timeWindow);
  const spikes = useSpikes();

  /* ── Decide which data set to show ── */
  // In 1m mode, use the live buffer.
  // In 5m / 1h mode, use the fetched historical data.
  const displayHistory = timeWindow === "1m" ? liveHistory : histData;

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
        // Always update the live buffer regardless of which window is shown,
        // so switching back to 1m is instant.
        setLiveHistory((prev) => {
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

  /* ── When a spike is selected, switch to an appropriate window ── */
  function handleSpikeSelect(s: SpikeRecord) {
    setHighlightedSpike(s);
    const age = Date.now() / 1000 - s.timestamp;
    if (age <= 60) {
      setTimeWindow("1m");
    } else if (age <= 300) {
      setTimeWindow("5m");
    } else {
      setTimeWindow("1h");
    }
  }

  const tIdx   = latest?.thrash_index ?? 0;
  const tColor = latest ? thrashColor(tIdx) : APPLE.label4;

  // Merge spike highlight into the spikes list as an overlay marker
  const spikeMarkers: SpikeRecord[] =
    highlightedSpike && !spikes.find((s) => s.timestamp === highlightedSpike.timestamp)
      ? [highlightedSpike, ...spikes]
      : spikes;

  /* ── Toolbar accessories shared across views ── */
  const spikesBtn = (
    <SpikesInspector spikes={spikes} onSelect={handleSpikeSelect} />
  );

  /* ── Keyframe for the loading pulse dots ── */
  const pulseKeyframes = `
    @keyframes sentinel-pulse {
      0%, 80%, 100% { opacity: 0.2; transform: scale(0.85); }
      40%           { opacity: 1;   transform: scale(1);    }
    }
  `;

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
      {/* Inject pulse keyframes once */}
      <style>{pulseKeyframes}</style>

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

            <div className="window-title-right">
              <StatusBadge status={status} />
            </div>
          </header>

          {/* Unified toolbar — view picker + spikes button */}
          <div
            className="unified-toolbar"
            style={{
              display:        "flex",
              alignItems:     "center",
              justifyContent: "space-between",
            }}
          >
            <SegmentedControl active={view} onChange={setView} />
            {spikesBtn}
          </div>

          {/* Content */}
          <main className="window-content">
            {view === "overview" && (
              <OverviewGrid
                latest={latest}
                history={displayHistory}
                histLoading={histLoading}
                spikes={spikeMarkers}
                timeWindow={timeWindow}
                onTimeWindowChange={setTimeWindow}
              />
            )}

            {view === "memory" && (
              <FocusView
                title="VRAM Wired"
                latest={latest}
                history={displayHistory}
                histLoading={histLoading}
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
                spikes={spikeMarkers}
                timeWindow={timeWindow}
                onTimeWindowChange={setTimeWindow}
              />
            )}

            {view === "swap" && (
              <FocusView
                title="Swap Committed"
                latest={latest}
                history={displayHistory}
                histLoading={histLoading}
                dataKey="swap_used_mb"
                color={APPLE.cyan}
                unit="MB"
                valueFn={(f) => `${fmtMB(Math.round(f.swap_used_mb))} MB`}
                subFn={(f) =>
                  f.swap_total_mb > 0
                    ? `${((f.swap_used_mb / f.swap_total_mb) * 100).toFixed(1)}% of ${fmtMB(Math.round(f.swap_total_mb))} MB`
                    : "—"
                }
                spikes={spikeMarkers}
                timeWindow={timeWindow}
                onTimeWindowChange={setTimeWindow}
              />
            )}

            {view === "pressure" && (
              <div className="focus-layout">
                <FocusView
                  title="Thrash Danger Index"
                  latest={latest}
                  history={displayHistory}
                  histLoading={histLoading}
                  dataKey="thrash_index"
                  color={tColor}
                  unit=""
                  valueFn={(f) => f.thrash_index.toFixed(3)}
                  subFn={(f) => thrashLabel(f.thrash_index)}
                  domain={[0, 1]}
                  gauge={latest ? <ThrashMeter index={tIdx} /> : undefined}
                  spikes={spikeMarkers}
                  timeWindow={timeWindow}
                  onTimeWindowChange={setTimeWindow}
                />
                <FocusView
                  title="Pageouts"
                  latest={latest}
                  history={displayHistory}
                  histLoading={histLoading}
                  dataKey="pageouts"
                  color={APPLE.orange}
                  unit=""
                  valueFn={(f) => fmtMB(f.pageouts)}
                  subFn={() => "cumulative since boot"}
                  spikes={spikeMarkers}
                />
              </div>
            )}
          </main>
        </div>

        {/* Footer */}
        <footer className="page-footer">
          Sentinel-AI · macOS sysctl &amp; vm_stat ·{" "}
          {timeWindow === "1m"
            ? `${MAX_POINTS}s rolling window`
            : timeWindow === "5m"
            ? "5 min history"
            : "1 hour history"}
        </footer>
      </div>
    </div>
  );
}
