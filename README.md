# Sentinel-AI 🛡️

Native Apple Silicon unified memory telemetry and AI quota guard for local AI engineers.

## Architecture Overview

Sentinel-AI operates as a lightweight, zero-dependency background daemon (`sentinel-service`), a macOS menu bar monitor (`sentinel-bar`), and an embedded Apple HIG dashboard.

- **FastAPI Telemetry Daemon**: Exposes continuous 1-second WebSocket telemetry (`/ws/telemetry`) and REST endpoints (`/api/*`).
- **Embedded Web Frontend**: A Next.js dashboard statically exported into `sentinel/web_dist/` and served directly by FastAPI via Starlette's `StaticFiles`. This completely eliminates Node.js runtime requirements in production.
- **macOS Menu Bar**: Native Cocoa status bar item providing instantaneous unified memory pressure and GPU wired limits.

---

## Frontend Build & Static Embedding

The Next.js frontend in `web/` is configured for static export (`output: 'export'`) directly into the Python package:

```bash
# 1. Install frontend dependencies
npm --prefix web install

# 2. Compile static assets into sentinel/web_dist/
npm --prefix web run build
```

### How Static Serving Works

1. `web/next.config.ts` sets `distDir: '../sentinel/web_dist'` and `output: 'export'`.
2. When `npm --prefix web run build` runs, the pre-rendered static HTML, CSS, JavaScript, and assets are generated in `sentinel/web_dist/`.
3. In `sentinel/server.py`, all FastAPI API (`/api/*`) and WebSocket (`/ws/*`) routes are registered with priority.
4. If `sentinel/web_dist/index.html` exists, FastAPI mounts `sentinel/web_dist` at `/` using Starlette `StaticFiles`:
   ```python
   dist_dir = Path(__file__).parent / "web_dist"
   if dist_dir.exists() and (dist_dir / "index.html").exists():
       app.mount("/", StaticFiles(directory=str(dist_dir), html=True), name="frontend")
   ```
5. Navigating to `http://localhost:8000/` immediately loads the Next.js frontend without requiring Node.js to be running.

---

## Installation & Packaging

```bash
# Install Python dependencies and sentinel in editable mode
.venv/bin/pip install -e ".[dev]"
```

`pyproject.toml` is configured to package `sentinel/web_dist/**/*` inside the distribution wheel, allowing standalone distribution without Node.js on end-user machines.

---

## Running the Application

### Production Mode (Embedded Frontend)
```bash
# Start the FastAPI service (serves both API & Frontend on port 8000)
.venv/bin/uvicorn sentinel.server:app --host 127.0.0.1 --port 8000
```
Open [http://127.0.0.1:8000](http://127.0.0.1:8000) in your browser.

### Development Mode (Hot-Reloading)
To develop both backend and frontend with live reloading:
```bash
./dev.sh
```

---

## Running Tests

Run the full pytest suite:
```bash
.venv/bin/pytest tests/
```
