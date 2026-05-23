# Handoff: Concierge Agent Dashboard

**Handed off by:** Jeff (via Telegram, 2026-05-23)
**App directory:** `~/projects/agent-dashboard/`
**Running at:** `http://localhost:3030` | systemd: `agent-dashboard.service`

## What Concierge Is

Concierge is a standalone command center that monitors and orchestrates multi-machine agent processes. It was built from a mockup → interactive demo → fully functional v2 over the course of one session.

Jeff runs it on his Arch Linux desktop. It's accessible from his phone via Tailscale Funnel (`https://archlinux.tail0faf76.ts.net`). His work MacBook will push updates to it via `curl`.

## Current State (as of handoff)

**Working:**
- 11 agent tabs populated from his GDrive ThoughtStack topics
- Live SSE updates to all open browser tabs
- Sub-agent spawning (click a button, server runs command, output streams to task feed)
- Create/delete agents from UI or API
- Add tasks on the fly
- Cross-machine API (`agent-ping.sh` for any machine with curl)
- Tailscale Funnel exposing public HTTPS
- systemd service for auto-start on boot

**Known rough edges (see TASKS.md):**
- No dedicated sub-agent output panel (output goes to task feed as flat entries)
- No progress bar on sub-agent buttons during execution
- "Add Agent" modal renders via JS overlay — needs browser testing
- Mobile layout works but sub-agent grid gets tight on phone screens

## Architecture

```
server.js (Node.js, zero deps)
  ├── Serves static files (index.html, app.js, style.css)
  ├── REST API at /api/*
  ├── SSE endpoint at /api/stream
  ├── Job runner — spawns shell commands via child_process
  └── State persistence to state.json (debounced 300ms writes)

app.js (Vanilla JS, no frameworks)
  ├── Fetches /api/state on load
  ├── Connects to SSE for live updates
  ├── Renders tabs, task feeds, sub-agent grid from state
  └── Desktop Notification API integration
```

## Key Decisions

1. **Standalone, not an OpenClaw plugin** — Jeff wants this for agents that aren't on OpenClaw (cross-machine)
2. **Zero npm dependencies** — Pure Node.js `http` module + vanilla JS frontend. Easy to deploy anywhere
3. **SSE, not WebSockets** — Simpler, one-direction is fine, browsers handle reconnection natively
4. **state.json persistence** — Simple JSON file, debounced writes, watched for external changes
5. **Default agents from GDrive topics** — Hard-coded in `ensureDefaultAgents()` in server.js. Only populate on first run

## How to Jump In

1. Read `AGENTS.md` for full data model and API reference
2. Read `TASKS.md` for what needs doing next
3. The codebase is intentionally small — two server-side files (`server.js`, `agent-ping.sh`) and three frontend files (`index.html`, `style.css`, `app.js`)
4. No build step. Edit → restart service → reload browser

## Contact / Context

- Jeff's on Eastern time, active during business hours
- He communicates through Telegram (this session's context)
- He prefers action over discussion — if you see something broken, fix it. If it's ambiguous, ask one question at a time
- His GDrive at `~/projects/agent-dashboard/../gdrive/ThoughtStack/OpenClaw/Topics/` is the source of truth for agent topics
- The dashboard runs on `archlinux` — a headless Arch Linux box, Jeff's primary workstation

## Useful Commands

```bash
# Restart
systemctl --user restart agent-dashboard

# Watch logs
journalctl --user -u agent-dashboard -f

# Test API
curl -s http://localhost:3030/api/health

# Push a test update
./agent-ping.sh test debug "Handoff verification" done

# Edit defaults
vim server.js  # look for ensureDefaultAgents()

# Direct state access
cat state.json | jq '.agents | keys'
```
