# Concierge — Agent Dashboard

**Concierge** is a standalone command center for orchestrating and monitoring multiple agent processes across any number of machines. It runs as a single Node.js server and communicates via a lightweight REST + SSE API.

## What Concierge Does

- Displays a real-time dashboard of **agents** (processes, services, monitors, anything with a state)
- Each agent has a **task feed** showing current and recent subtask statuses
- Each agent has **sub-agents** — triggerable commands that run on the server and stream output back
- Any machine with `curl` can push status updates to the dashboard
- Desktop notifications when agents error out or tasks complete
- Mobile-accessible via Tailscale Funnel (public HTTPS)

## Project Structure

```
~/projects/agent-dashboard/
├── server.js          # Node.js HTTP server — REST API + SSE + job runner + static files
├── app.js             # Client-side JS — dashboard UI, tab pane rendering, SSE client
├── index.html         # Dashboard shell (header, tab bar, input bar)
├── style.css          # All styling — dark theme, modals, sub-agent grid, animations
├── agent-ping.sh      # Shell script for any machine to push updates via curl
├── state.json         # Persistent state — agents, subtasks, job history (auto-created)
├── README.md          # Full user & deployment documentation
├── TASKS.md           # Known development tasks and roadmap
└── logs/              # Future: job output logs
```

## Agent Data Model

Each agent in `state.json` looks like:

```json
{
  "id": "dev-work",
  "label": "📱 RTMS Mobile",
  "emoji": "📱",
  "description": "Mobile app dev, E2E testing, feature work",
  "status": "healthy",           // healthy | active | warning | error | idle
  "statusLabel": "Ready",
  "topic": "Dev-Work",           // Maps to GDrive ThoughtStack topic
  "context": "React Native 0.79.7 | Sauce Labs E2E | Auth0 | FCM",
  "subtasks": [                  // Feed of current/recent tasks
    { "id": "e2e-last", "label": "E2E test suite run", "state": "done", "icon": "🧪" }
  ],
  "subAgents": [                 // Triggerable actions
    { "id": "run-e2e", "label": "Run E2E Suite", "description": "...", "cmd": "shell:..." }
  ]
}
```

`cmd` supports three modes:
- `shell:<command>` — runs a bash command, streams stdout/stderr as job output
- `skill:<name>` — placeholder for OpenClaw skill invocations
- `opencode` — placeholder for OpenCode task delegation

## API Reference

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/state` | Full current state (agents, jobs) |
| `GET` | `/api/stream` | SSE endpoint — pushes live updates |
| `GET` | `/api/health` | Server health + agent count |
| `POST` | `/api/update` | Agent pushes status update |
| `POST` | `/api/agents` | Create new agent |
| `DELETE` | `/api/agents/:id` | Delete agent |
| `POST` | `/api/agents/:id/spawn` | Trigger sub-agent (runs shell cmd) |
| `POST` | `/api/agents/:id/subtasks` | Add task to agent |
| `POST` | `/api/jobs/:id/cancel` | Cancel running job |
| `POST` | `/api/clear-logs` | Prune old job logs |

### POST /api/update

```json
{
  "agent": "my-custom-agent",
  "agentLabel": "🚀 My Agent",   // optional, auto-creates agent if new
  "subtask": {
    "id": "build-step-3",
    "label": "Compiling assets...",
    "state": "running",
    "icon": "🔄"
  }
}
```

States: `done`, `running`, `error`, `pending`

## Default Agents

Defined in `server.js` function `ensureDefaultAgents()`. They map directly to Jeff's Google Drive ThoughtStack topics:

| Dashboard ID | Topic | Purpose |
|-------------|-------|---------|
| `dev-work` | Dev-Work/MobileApp | RTMS mobile app dev & E2E testing |
| `claw-mgmt` | Claw Mgmt | OpenClaw gateway, config, services |
| `pm-automation` | Project Management | Standups, project updates, training nag |
| `epub-mgmt` | epub Management | KOReader book cleaning & syncing |
| `career` | Career | Job board scanning & resume |
| `sysadmin` | SysAdmin | Arch Linux maintenance |
| `spec-dd` | Spec_DD | RTMS spec architecture standard |
| `network` | Network Management | Router, VPN, Tailscale |
| `personal` | Personal | Health tracking |
| `travel` | Travel | Ireland trip planning |
| `consulting` | Apex_AI_Consulting | AI consulting business |

**Important:** These defaults only populate on first run. Once `state.json` exists, new defaults are NOT added. To re-add, delete `state.json` and restart.

## How to Integrate an External Agent

Any machine with `curl` can report to Concierge:

```bash
# Minimal
curl -X POST https://archlinux.tail0faf76.ts.net/api/update \
  -H "Content-Type: application/json" \
  -d '{"agent":"my-worker","subtask":{"id":"job-1","label":"Processing...","state":"running"}}'

# Or use agent-ping.sh (no JSON syntax needed)
./agent-ping.sh my-worker job-1 "Processing batch #4" running
```

The agent auto-creates if it doesn't exist.

## Known Issues / Gotchas

- **Sub-agent shell commands** run synchronously in the Node.js event loop via `child_process.spawn`. Long-running commands tie up server resources. No timeout or cgroup limits yet.
- **state.json** is debounced (300ms). Heavy write bursts are safe but rapid reads from external editors might cause a brief inconsistency.
- **Default agents** are defined in code, not state.json. To edit default tasks/sub-agents, modify `ensureDefaultAgents()` in `server.js`.
- **Funnel URL** is Jeff's Tailscale Funnel. If you're not on that tailnet, use Tailscale IP or localhost.

## Deployment

Managed as a systemd user service:

```bash
systemctl --user enable --now agent-dashboard
```

The service file is at `~/.config/systemd/user/agent-dashboard.service` and points to `~/projects/agent-dashboard/server.js`.
