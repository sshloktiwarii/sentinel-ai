# Sentinel-AI Architectural Decision Records (ADR)

This document records the foundational architectural and system design decisions made during the development of Sentinel-AI. Each record outlines the engineering context, the specific problem or bottleneck faced, the technical implementation details, and the trade-offs of alternatives considered.

---

## Index of Records

- [ADR 001: Darwin Mach Kernel C-Bindings (`ctypes`) over Subprocess CLI Parsing](#adr-001-darwin-mach-kernel-c-bindings-ctypes-over-subprocess-cli-parsing)
- [ADR 002: Dynamic RAM-Proportional Swap Scaling for TDI vs. Fixed 2GB Ceiling](#adr-002-dynamic-ram-proportional-swap-scaling-for-tdi-vs-fixed-2gb-ceiling)
- [ADR 003: Sliding-Window Velocity Ring Buffer for Agent Runaway Detection](#adr-003-sliding-window-velocity-ring-buffer-for-agent-runaway-detection)
- [ADR 004: Native `launchd` User Agent Persistence over Third-Party Process Managers](#adr-004-native-launchd-user-agent-persistence-over-third-party-process-managers)
- [ADR 005: Embedded Next.js Static Export within FastAPI over Standalone Node.js Runtime](#adr-005-embedded-nextjs-static-export-within-fastapi-over-standalone-nodejs-runtime)
- [ADR 006: SQLite WAL Mode with Precomputed Aggregations over In-Memory Buffers or Heavy DBs](#adr-006-sqlite-wal-mode-with-precomputed-aggregations-over-in-memory-buffers-or-heavy-dbs)
- [ADR 007: Dual Interface Architecture (Native Menu Bar + Rich Canvas)](#adr-007-dual-interface-architecture-native-menu-bar--rich-canvas)
- [ADR 008: Zero-Dependency JSON User Preferences via `~/.sentinel/config.json`](#adr-008-zero-dependency-json-user-preferences-via-sentinelconfigjson)

---

## ADR 001: Darwin Mach Kernel C-Bindings (`ctypes`) over Subprocess CLI Parsing

### Decision
Implement direct C-level bindings to `/usr/lib/libSystem.B.dylib` using Python’s `ctypes` foreign function interface to query Darwin Mach microkernel APIs (`host_statistics64`) and kernel sysctls (`sysctlbyname`), completely eliminating subprocess invocations during telemetry harvesting.

### Context & Problem
Sentinel-AI samples telemetry at 1-second continuous intervals. Early prototypes executed shell commands—namely `vm_stat` (to parse page states, wired memory, and pageouts) and `sysctl` (to extract swap usage and memory limits).

In production benchmarks, this approach introduced severe operational drawbacks:
1. **Subprocess Overhead**: Each `subprocess.run(["vm_stat"])` call spawned a new fork/exec lifecycle, consuming 9.8 ms to 15.0 ms per iteration.
2. **CPU Waste & Energy Impact**: Periodic string parsing, regex matching, and child process allocation caused measurable background CPU spikes (1.5%–3.0% of a core), which is unacceptable for a background desktop utility designed to sit idle on battery-powered MacBooks.
3. **Telemetry Jitter**: Process scheduling jitter occasionally delayed WebSocket pushes, leading to uneven 1 Hz intervals.

### What It Does
1. Loads Darwin libc dynamically:
   ```python
   _libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
   ```
2. Binds to `mach_host_self()` and `host_statistics64()` using an exact Python `ctypes.Structure` representation of Darwin's `vm_statistics64_data_t`:
   ```python
   ret = _libc.host_statistics64(
       host,
       HOST_VM_INFO64,
       ctypes.byref(vm_stat),
       ctypes.byref(count)
   )
   ```
3. Queries swap states via `sysctlbyname(b"vm.swapusage", ...)` using Darwin's native `struct xsw_usage`.
4. Binds GPU wired memory queries to `iogpu.wired_limit_mb` and `iogpu.wired_mem_limit`.
5. Achieves an instantaneous harvest execution latency of **~10 µs (0.01 ms)**—a **~1000x reduction** in latency with zero child process spawning overhead.

### Alternatives Considered
- **Shell Command Scraping (`subprocess.run`)**: Simple to implement but rejected due to high CPU overhead, 10–15 ms latency, and brittle text parsing across localized macOS environments.
- **IOKit PyObjC Bindings**: Considered for deep Metal driver queries, but rejected because importing heavy PyObjC frameworks inflated process memory footprint by over 65 MB and added unnecessary binary dependencies.

---

## ADR 002: Dynamic RAM-Proportional Swap Scaling for TDI vs. Fixed 2GB Ceiling

### Decision
Formulate the Thrash Danger Index (TDI) with a dynamic swap ceiling calculated as $\max(2048.0, \text{RAM}_{\text{total}} \times 0.25)$ combined with a 70% physical memory / 30% swap memory blended model, while retaining a hard saturation override when physical wired memory meets or exceeds the GPU wired limit ($R_{\text{mem}} \ge 1.0$).

### Context & Problem
Earlier versions of the Thrash Danger Index used a hardcoded 2048 MB swap ceiling. On modern Apple Silicon hardware (e.g., 24 GB, 36 GB, 64 GB, 128 GB M-series Macs), this caused critical false-positive alerts:
1. **macOS Cold Swap Caching**: Darwin's virtual memory compressor aggressively pages inactive, cold background application memory to NVMe swap. A developer's machine with 24 GB of RAM sitting completely idle frequently exhibits 1.2 GB to 2.5 GB of disk swap without experiencing any performance degradation or page thrashing.
2. **False Alarms**: Under a static 2048 MB ceiling, 2048 MB of passive cold swap forced the swap ratio to 1.0, triggering red alarms (`TDI = 1.00`) and emergency desktop notifications even though 18 GB of physical RAM remained free.

### What It Does
1. **Dynamic Swap Ceiling**: Scales the swap denominator proportionally to total physical hardware memory:
   $$S_{\text{limit}} = \max\left(2048.0, \text{round}\left(\text{RAM}_{\text{total}} \times 0.25, 2\right)\right)$$
   For a 24 GB Mac, $S_{\text{limit}} = 6144.0\text{ MB}$; for a 64 GB Mac, $S_{\text{limit}} = 16384.0\text{ MB}$.
2. **70/30 Blended Evaluation**: Evaluates overall pressure as a weighted sum of physical wired pressure ($R_{\text{mem}}$) and normalized swap pressure ($R_{\text{swap}}$):
   $$\text{TDI} = \left(0.70 \times R_{\text{mem}}\right) + \left(0.30 \times R_{\text{swap}}\right)$$
3. **Physical Saturation Override**: If physical memory reaches saturation ($R_{\text{mem}} \ge 1.0$), the index overrides directly to $1.0000$, ensuring immediate alarming when genuine out-of-memory jetsam kills are imminent.
4. **Result**: An idle 24 GB machine with 1.2 GB swap and 4 GB wired memory produces $\text{TDI} \approx 0.22$ (safe green), while a system approaching genuine kernel thrash (17 GB wired + 5 GB swap) scales smoothly to $\text{TDI} \ge 0.85$ (critical red).

### Alternatives Considered
- **Raw Physical RAM Percentage (Ignore Swap)**: Evaluated only `wired_mb / total_ram`. Rejected because it completely misses silent disk thrashing when an autonomous agent or local LLM forces heavy active pageins/pageouts.
- **Binary Swap Alert**: Alerting whenever swap > 0 MB. Rejected because almost every macOS machine under daily use maintains passive swap, creating alert fatigue.
- **Swap Delta Rate Only**: Tracking $\Delta\text{Swap}/\Delta t$. Rejected because while swap delta detects active writes, it fails to warn developers that swap space is already dangerously exhausted.

---

## ADR 003: Sliding-Window Velocity Ring Buffer for Agent Runaway Detection

### Decision
Implement an in-memory 60-second sliding-window ring buffer (`TokenVelocityTracker`) that computes instantaneous Tokens Per Second (TPS), extrapolated Tokens Per Minute (TPM), and rolling Requests Per Minute (RPM), paired with an automated heuristic engine that alerts via native macOS notifications when autonomous agent runaway loops are detected.

### Context & Problem
Autonomous AI coding agents (such as Claude Code, Cursor Composer, KiloCode, and OmniRoute) can enter catastrophic retry loops when encountering unresolvable terminal errors, syntax loops, or LLM hallucinations.
- A runaway agent can burn through 100k–500k tokens in under two minutes, exhausting API quotas or incurring heavy financial cost.
- Standard quota monitors only track total balance or daily consumption. By the time a cumulative threshold or daily cost alert triggers, the quota is already burned.
- Engineers require real-time velocity detection that catches anomalous acceleration within seconds of onset.

### What It Does
1. **Ring Buffer Storage**: Stores rolling timestamped records $(t, \text{tokens}, \text{requests})$ over a 60.0-second retention window.
2. **Multi-Horizon Calculations**:
   - **Instantaneous TPS**: $\Delta\text{Tokens} / \Delta t$ between the two latest probes, capturing immediate spikes.
   - **Projected TPM**: Rolling window token delta extrapolated to 60 seconds:
     $$\text{TPM} = \left(\frac{\Delta\text{Tokens}_{\text{window}}}{\Delta t_{\text{window}}}\right) \times 60.0$$
   - **Rolling RPM**: Request frequency over the active window.
3. **Runaway Heuristic Detection**:
   - **Condition A (High Burn)**: $\text{TPS} > 150.0$ sustained for $\ge 15.0$ consecutive seconds.
   - **Condition B (Request Flood)**: $\text{RPM} > 45.0$ sustained with zero backoff for $\ge 10.0$ seconds.
4. **Native Alerting & Debounce**:
   Dispatches a high-priority native notification via AppleScript (`osascript`) with a **180-second debounce period** to ensure developers are notified immediately without notification spam.

### Alternatives Considered
- **Cumulative Token Thresholds**: Alerting when token usage crosses a fixed count (e.g., 50k tokens). Rejected because it fails during normal high-volume tasks and cannot differentiate between a legitimate single prompt with large context vs. a rapid runaway loop.
- **Post-Request Billing Webhooks**: Relying on OpenAI/Anthropic usage dashboards. Rejected because external usage dashboards lag by 5 to 15 minutes, which is far too late to stop a runaway loop.
- **Fixed-Window Batch Aggregation (Cron)**: Checking token counters every 60 seconds. Rejected because boundary clipping creates blind spots and adds up to a 60-second latency before runaway detection begins.

---

## ADR 004: Native `launchd` User Agent Persistence over Third-Party Process Managers

### Decision
Manage Sentinel-AI's background daemon lifecycle using macOS native `launchd` via a user `LaunchAgent` plist located at `~/Library/LaunchAgents/com.sentinel.daemon.plist`, orchestrated through a dedicated Python CLI interface (`sentinel-service`).

### Context & Problem
A desktop telemetry daemon must:
1. Start automatically on user login.
2. Run quietly in the background without keeping a terminal window open.
3. Automatically restart if terminated or if the system wakes from sleep.
4. Require zero external package dependencies or root (`sudo`) privileges.

### What It Does
1. Generates a standard user-space LaunchAgent dictionary with `RunAtLoad=True`, `KeepAlive=True`, and dedicated log redirection paths (`~/.sentinel/daemon.log`, `~/.sentinel/daemon.err`).
2. Serializes the configuration to standard Apple XML plist format using Python's built-in `plistlib`.
3. Resolves the active virtual environment Python binary (`.venv/bin/python`) dynamically, ensuring environment-specific dependencies (e.g., Uvicorn, FastAPI) are loaded correctly.
4. Integrates management commands:
   - `sentinel-service install`: Writes plist, sets permissions, and triggers `launchctl load`.
   - `sentinel-service uninstall`: Executes `launchctl unload` and removes the plist.
   - `sentinel-service status`: Inspects active PID, launchctl state, and performs an HTTP health check.
   - `sentinel-service logs`: Tails live daemon output streams.

### Alternatives Considered
- **Standard `cron` (`@reboot`)**: Rejected because macOS has deprecated cron; cron does not monitor process health, cannot restart failed processes (`KeepAlive`), and requires full disk access permissions.
- **Third-Party Managers (`pm2`, `supervisord`)**: Rejected because requiring Node.js/npm for `pm2` or a separate Python supervisor installation violates the project's zero-friction, native macOS architecture principle.
- **Custom Python Daemon Fork (`os.fork`)**: Rejected because double-forking Python scripts on modern macOS leads to crashes with CoreFoundation/AppKit APIs and lacks operating system-level boot supervision.

---

## ADR 005: Embedded Next.js Static Export within FastAPI over Standalone Node.js Runtime

### Decision
Compile the Next.js frontend into a fully static client-side bundle using `output: 'export'` and `distDir: '../sentinel/web_dist'`, embed the assets directly into the Python package, and serve them via FastAPI's `StaticFiles` mounted at `/`.

### Context & Problem
Sentinel-AI features a rich, responsive dashboard built with React 19, Next.js 16, Tailwind CSS, and Recharts. However:
- Requiring end users to have Node.js, npm, and a separate Next.js development server running on port 3000 to use a Python desktop utility introduces massive installation friction.
- Non-web developers or engineers working in strict Python environments do not want background Node processes consuming memory and requiring separate maintenance.
- Running dual servers (FastAPI on 8000 and Next.js on 3000) doubled memory usage and required complex process orchestration scripts.

### What It Does
1. **Static Export Configuration**:
   Configured in `web/next.config.ts`:
   ```typescript
   const nextConfig: NextConfig = {
     reactStrictMode: true,
     output: "export",
     images: { unoptimized: true },
     distDir: "../sentinel/web_dist",
   };
   ```
2. **Build-Time Compilation**:
   `npm --prefix web run build` compiles the React components into static HTML, JavaScript, and CSS bundles written directly into `sentinel/web_dist/`.
3. **FastAPI Static Mounting with Priority**:
   In `sentinel/server.py`, all `/api/*` and `/ws/*` routes are registered first to ensure strict routing precedence. At the bottom of the server file, static files are mounted at `/`:
   ```python
   dist_dir = Path(__file__).parent / "web_dist"
   if dist_dir.exists() and (dist_dir / "index.html").exists():
       app.mount("/", StaticFiles(directory=str(dist_dir), html=True), name="frontend")
   ```
4. **Python Wheel Packaging**:
   `pyproject.toml` includes `[tool.setuptools.package-data] sentinel = ["web_dist/**/*"]`, allowing Sentinel-AI to be distributed as a standalone wheel that serves both backend APIs and the frontend UI from a single Python command.

### Alternatives Considered
- **Electron Application Wrapper**: Evaluated for desktop distribution. Rejected because Electron bundles an entire Chromium and Node.js runtime, adding >150 MB to package size and consuming 200 MB+ of RAM.
- **Dual-Process Architecture (FastAPI + Node server)**: Rejected due to high memory footprint and packaging complexity on user systems.
- **Server-Rendered Jinja2 Templates**: Rejected because complex time-series graphs, interactive canvas scrubbing, and sub-second WebSocket updates require a rich client-side virtual DOM and component library (Recharts/React).

---

## ADR 006: SQLite WAL Mode with Precomputed Aggregations over In-Memory Buffers or Heavy DBs

### Decision
Use embedded SQLite configured with Write-Ahead Logging (`PRAGMA journal_mode=WAL`) and `PRAGMA synchronous=NORMAL`, paired with deterministic SQL bucket rollups for 1m, 5m, and 1h query windows.

### Context & Problem
High-frequency 1 Hz telemetry requires a database that supports continuous single-row writes while simultaneously serving concurrent read queries from multiple consumers (FastAPI WebSocket loop, REST API requests, and menu bar polls).
- Standard SQLite rollback journals lock the entire database file during writes, resulting in `sqlite3.OperationalError: database is locked` errors under concurrent API load.
- Pure in-memory storage (e.g., Python lists or dictionaries) loses all historical trend data whenever the service restarts or the machine reboots.
- Heavy time-series databases (TimescaleDB, InfluxDB) require separate background daemons and significant disk/RAM footprints.

### What It Does
1. **Concurrency through WAL**:
   Enabling WAL mode (`PRAGMA journal_mode=WAL;`) allows simultaneous read and write operations. Writers append to the `.wal` file without blocking readers, and readers access consistent snapshot views without acquiring table locks.
2. **I/O Optimization**:
   `PRAGMA synchronous=NORMAL;` guarantees database integrity while relaxing fsync barriers on individual transactions, taking full advantage of Apple Silicon NVMe write speeds.
3. **Database Schema & Server-Side Rollups**:
   Telemetry frames are stored in a simple relational table:
   ```sql
   CREATE TABLE IF NOT EXISTS telemetry (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       timestamp REAL NOT NULL,
       wired_mb REAL NOT NULL,
       swap_used_mb REAL NOT NULL,
       pageouts INTEGER NOT NULL,
       thrash_index REAL NOT NULL
   );
   ```
4. **Windowed Queries**:
   - `1m`: Returns raw 1-second records (up to 60 rows).
   - `5m`: Groups into 5-second integer buckets (`CAST((timestamp - :since) / 5 AS INTEGER)`), averaging metrics across each bucket.
   - `1h`: Groups into 60-second buckets, providing high-resolution 1-hour trend graphs in 60 lightweight data points.
5. **Zero-Empty-State Fallback**:
   If a window query yields 0 rows due to sparse data after a restart, a fallback query immediately returns the most recent 60 raw rows.

### Alternatives Considered
- **In-Memory Arrays (`collections.deque`)**: Rejected because process restarts wipe all historical spike data and long-term trend analysis becomes impossible.
- **External Time-Series Engine (InfluxDB / TimescaleDB)**: Rejected as an unacceptable operational dependency for a local developer desktop utility.

---

## ADR 007: Dual Interface Architecture (Native Menu Bar + Rich Canvas)

### Decision
Implement a decoupled dual-consumer interface consisting of an ambient, native AppKit menu bar companion (`sentinel-bar` via `rumps`) for passive monitoring, alongside a full-featured browser canvas (Next.js dashboard on port 8000) for deep telemetry investigation.

### Context & Problem
Engineers monitoring unified memory and AI quota burn face conflicting UI requirements:
1. **Passive Ambient Awareness**: Developers writing code in full-screen IDEs need a low-friction indicator that shows memory state and runaway alerts at a glance without cluttering screen real estate.
2. **High-Density Diagnostics**: When memory pressure spikes or an agent enters a runaway loop, developers need multi-series historical charts, KV-cache breakdowns, model quota tables, and spike logs that cannot fit inside a status bar item.

### What It Does
1. **Native Menu Bar Tray (`sentinel/menubar.py`)**:
   - Built on `rumps` (Apple AppKit `NSStatusBar`).
   - Displays real-time TDI and color-coded status pills: `🟢` ($< 0.30$), `🟡` ($0.30$–$0.70$), `🔴` ($\ge 0.70$).
   - Provides a concise dropdown menu with wired VRAM, active swap, pageouts, instantaneous TPS, and provider health.
   - Includes an "Open Dashboard" action that opens the browser directly to `http://localhost:8000`.
   - Features built-in hardware fallback: if the FastAPI daemon is temporarily stopped, the menu bar app falls back directly to local kernel C-bindings.
2. **High-Density Canvas (`web/`)**:
   - Serves the embedded Next.js dashboard directly from FastAPI.
   - Streams live 1-second telemetry via WebSocket (`/ws/telemetry`).
   - Visualizes multi-window time-series charts (1m raw, 5m sampled, 1h rollup) using Recharts.
   - Displays granular KV-cache allocation per loaded local engine (Ollama, LM Studio, vLLM) and token velocity gauges.
3. **Synergy**: The menu bar companion alerts the engineer when attention is required; a single click transitions them into the rich canvas for root-cause diagnosis.

### Alternatives Considered
- **Web Dashboard Only**: Rejected because engineers working in terminal/IDE workflows will not maintain an open browser window simply to watch for passive memory spikes.
- **Menu Bar Only**: Rejected because complex multi-series time-series charts, spike distribution tables, and multi-provider quota matrices cannot be rendered effectively within a native macOS menu dropdown.

---

## ADR 008: Zero-Dependency JSON User Preferences via `~/.sentinel/config.json`

### Decision
Provide a zero-dependency user configuration engine powered by the Python standard library, storing user preferences in human-readable JSON format at `~/.sentinel/config.json`, with automated missing-file bootstrapping, fallback defaults, and graceful error recovery.

### Context & Problem
Different development setups have distinct operating characteristics and sensitivity requirements:
1. **Custom Ports & Gateways**: Developers frequently run proxy multiplexers (like OmniRoute) on alternative ports or remote endpoints instead of `http://localhost:20128`.
2. **Workload Variance**: High-throughput automated batch jobs (such as agentic code refactoring or local fine-tuning) generate expected bursts that trigger false runaway alerts under fixed, hardcoded thresholds (e.g., 150 TPS or 45 RPM).
3. **Hardware Thrash Differences**: Different Apple Silicon chips (M1 base vs. M4 Max) and varying physical memory sizes benefit from adjustable TDI warning/critical limits and swap allocation ratios.
4. **Zero Configuration Friction**: Prior to this change, modifying these thresholds required directly editing the application source code.

### What It Does
1. **Configuration Engine (`sentinel/config.py`)**:
   Stores default system values for all operational thresholds:
   - `proxy_url`: `"http://localhost:20128"`
   - `poll_interval_seconds`: `1.0`
   - `tdi_warning_threshold`: `0.75`
   - `tdi_critical_threshold`: `0.90`
   - `velocity_alert_tps`: `150.0`
   - `velocity_alert_rpm`: `45.0`
   - `notification_debounce_seconds`: `60.0`
   - `swap_limit_ratio`: `0.25`
2. **Automated Bootstrapping & Graceful Recovery**:
   - If `~/.sentinel/config.json` does not exist, Sentinel-AI automatically generates it with formatted default JSON.
   - If the user provides partial overrides, user values are deeply merged on top of `DEFAULT_CONFIG`.
   - If `~/.sentinel/config.json` contains malformed or corrupt JSON, Sentinel-AI logs a warning and falls back to in-memory defaults without crashing.
3. **Cached Access & Dynamic Reloading**:
   - Access is optimized through `@functools.lru_cache(maxsize=1)` via `get_config()`.
   - Invalidation is provided via `reload_config()`, supporting instant updates during runtime or testing.

### Alternatives Considered
- **Environment Variables**: Considered, but rejected as the primary configuration mechanism because environment variables are cumbersome to manage and persist across native macOS GUI apps, launchd LaunchAgents, and menu bar companions without shell wrappers.
- **YAML or TOML File Formats**: Rejected because standard Python 3 does not include a built-in YAML parser (requiring PyYAML), and TOML write/dump support is not standard across all Python versions without third-party dependencies. JSON is natively supported by Python's standard library with zero external dependencies.
- **SQLite Configuration Table**: Rejected because storing settings in SQLite makes quick inspection and manual editing with plain text editors tedious for developers.
