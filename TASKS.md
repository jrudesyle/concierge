# Concierge — Tasks

## Active

- [ ] **Sub-agent output panel** — Add a scrollable log/output view for running sub-agents instead of just pushing updates to the task feed
- [ ] **Job progress indicator** — Show spinner/progress bar on sub-agent buttons while running
- [ ] **Sub-agent cancel** — Wire the cancel API into the UI (currently API-only)

## Planned

- [ ] **Scheduling** — Add cron-like schedule display per agent ("Next run: 11:30 AM")
- [ ] **Agent grouping** — Allow organizing agents into groups/categories
- [ ] **Notification preferences** — Per-agent toggle for desktop notifications
- [ ] **State export/import** — Download/upload agent configurations
- [ ] **Historical log viewer** — Browse completed job logs with search

## Polish

- [ ] **Add Agent modal** — Verify modal popup renders correctly (works via API, need browser interaction test)
- [ ] **Sub-agent output truncation** — Cap job output array to prevent unbounded memory growth
- [ ] **Mobile layout** — Sub-agent grid gets tight on phone screens, consider single-column on narrow viewport
- [ ] **Tab reorder** — Allow dragging tabs to reorder
- [ ] **Auto-refresh state** — SSE handles live updates but state.json should also be watched for external edits (watching works, but recovery from corrupt state.json could be better)

## Future

- [ ] **OpenClaw integration** — Spawn real OpenClaw sub-agent sessions from the dashboard
- [ ] **OpenCode integration** — Trigger OpenCode tasks from sub-agent buttons
- [ ] **Auth/access control** — Simple token-based auth for the API so external agents need keys
- [ ] **Docker deployment** — Containerize Concierge for easy deployment anywhere
- [ ] **Plugin system** — Let sub-agents be registered as external plugins instead of hard-coded shell commands
