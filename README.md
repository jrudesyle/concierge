# 🛎️ Concierge

**Multi-machine agent command center.** Tracks, triggers, and coordinates agents across any number of machines. Runs as a single Node.js server with a browser-based dashboard, REST API, and SSE live updates.

## Quick Start

```bash
cd ~/projects/agent-dashboard
node server.js
```

Open **http://localhost:3030** in your browser.

Or via systemd (already installed):
```bash
systemctl --user restart agent-dashboard
```

## Access from Anywhere

| Where | URL |
|-------|-----|
| Local | `http://localhost:3030` |
| LAN | `http://192.168.1.14:3030` |
| Internet | `https://archlinux.tail0faf76.ts.net` |
| Tailnet | `http://archlinux:3030` or `http://100.122.3.123:3030` |

The Tailscale Funnel URL works from any browser — no Tailscale install needed on mobile.

## Architecture

```
┌──────────────────────┐      POST /api/update      ┌──────────────┐
│  Any machine w/ curl │  ──────────────────────────→ │              │
│  (MacBook, server,   │                              │  Concierge   │
│   Raspberry Pi, CI)  │                              │  Server      │
│                      │  ←── SSE /api/stream ─────── │  :3030       │
│                      │                              │              │
│  Agent scripts use   │                              │  state.json  │
│  agent-ping.sh or    │  POST /api/agents/:id/spawn  │  (persistent)│
│  raw curl            │  ─── trigger sub-agent ────→ │              │
└──────────────────────┘                              └──────────────┘
```

## Features

- **Tabbed agent view** — Each GDrive topic becomes an agent tab
- **Live task feed** — Subtasks stream in real-time via SSE
- **Sub-agent spawning** — Click a button to run shell commands, stream output back to the dashboard
- **Desktop notifications** — Alert when tasks error or complete
- **Agent creation** — Add new agents from the UI or API
- **External agent support** — Any machine with `curl` can push updates
- **Persistent state** — Survives restarts via `state.json`
- **Mobile-friendly** — Accessible via Tailscale Funnel HTTPS

## The 10-Second Agent Integration

On any machine, copy `agent-ping.sh` and run:

```bash
# Set the dashboard URL once
export DASHBOARD_URL="http://192.168.1.14:3030"

# Push status updates
./agent-ping.sh my-process build-1 "Building v2.3.1" running
./agent-ping.sh my-process build-1 "Build complete" done
./agent-ping.sh my-process deploy "Deploy failed — port conflict" error
```

## API Overview

| Method | Path | What it does |
|--------|------|-------------|
| `GET` | `/api/state` | Full current state |
| `GET` | `/api/stream` | SSE live updates |
| `GET` | `/api/health` | Server health |
| `POST` | `/api/update` | Push agent update |
| `POST` | `/api/agents` | Create new agent |
| `DELETE` | `/api/agents/:id` | Delete agent |
| `POST` | `/api/agents/:id/spawn` | Trigger sub-agent |
| `POST` | `/api/agents/:id/subtasks` | Add task |
| `POST` | `/api/clear-logs` | Prune old logs |

Full details in [AGENTS.md](AGENTS.md).

## Project Files

| File | Purpose |
|------|---------|
| `server.js` | Node.js HTTP server — API, SSE, job runner, static files |
| `app.js` | Browser dashboard — tabs, task feed, sub-agent buttons, SSE client |
| `index.html` | Dashboard HTML shell |
| `style.css` | Dark theme, responsive layout |
| `agent-ping.sh` | Shell script for external agents |
| `state.json` | Persistent state (auto-created) |
| `AGENTS.md` | Agent/developer documentation |
| `TASKS.md` | Known tasks and roadmap |
| `logs/` | Output logs directory |

## Deployment

Run as a systemd user service:

```bash
systemctl --user enable --now agent-dashboard
systemctl --user status agent-dashboard
```

Service file: `~/.config/systemd/user/agent-dashboard.service`
