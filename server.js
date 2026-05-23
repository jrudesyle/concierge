#!/usr/bin/env node

/**
 * 🔧 Agent Dashboard Server v2
 * Standalone command center for multi-machine agent orchestration.
 */

const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { spawn, execSync } = require('child_process');
const crypto  = require('crypto');

const PORT         = parseInt(process.env.PORT || process.argv.find(a => a.startsWith('--port='))?.split('=')[1], 10) || 3030;

// ── OpenClaw API Configuration ──
// Set via env vars or use defaults for Jeff's OC instance
// Local OpenClaw gateway (port from systemd: --port 18789)
const OC_API_URL = process.env.OC_API_URL || 'http://localhost:18789';
const OC_API_KEY = process.env.OC_API_KEY || 'c260884c97cdad1caf566f58e6814b63017e0fc55dfd2bf6';
const OC_MODEL   = process.env.OC_MODEL || 'openclaw';
const STATIC_DIR   = __dirname;
const STATE_FILE   = path.join(__dirname, 'state.json');
const LOG_DIR      = path.join(__dirname, 'logs');

// ── MIME types ──
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.js'  : 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png' : 'image/png',
  '.ico' : 'image/x-icon',
};

// ── Ensure dirs ──
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ── SSE clients ──
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch (_) { clients.delete(res); }
  }
}

// ── State ──
let state = { agents: {}, subAgents: {}, jobs: {} };
let stateTimer = null;
let debounceTimer = null;

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      if (!state.agents) state.agents = {};
      if (!state.subAgents) state.subAgents = {};
      if (!state.jobs) state.jobs = {};
    }
  } catch (e) {
    console.error('State load error:', e.message);
    state = { agents: {}, subAgents: {}, jobs: {} };
  }
}

function saveState() {
  // Debounce writes
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    try {
      fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2));
      fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch (e) {
      console.error('State save error:', e.message);
    }
  }, 300);
}

// Watch state.json for external changes
if (fs.existsSync(STATE_FILE)) {
  fs.watchFile(STATE_FILE, { interval: 2000 }, () => {
    loadState();
    broadcast('snapshot', state);
  });
}

loadState();

// ── Default agents (from GDrive topics) ──
function ensureDefaultAgents() {
  const defaults = [
    {
      id: 'dev-work',
      label: '📱 RTMS Mobile',
      emoji: '📱',
      description: 'Mobile app dev, E2E testing, feature work',
      status: 'healthy',
      statusLabel: 'Ready',
      topic: 'Dev-Work',
      topicDocs: ['tasks.md', 'decisions.md', 'notes.md'],
      repo: '~/repos/rtms-mobile-notifications',
      context: 'React Native 0.79.7 | Sauce Labs E2E | Auth0 | FCM',
      subtasks: [
        { id: 'e2e-last', label: 'E2E test suite run', state: 'done', icon: '🧪' },
        { id: 'e2e-lockout', label: 'Account lockout (dbush) — retry pending', state: 'error', icon: '🔒' },
        { id: 'screenshots', label: 'Responsive screenshots captured', state: 'done', icon: '📸' },
      ],
      subAgents: [
        { id: 'review-reqs', label: 'Review Requirements', description: 'Run requirements-auditor on spec docs', cmd: 'skill:requirements-auditor' },
        { id: 'write-tests', label: 'Write Automated Tests', description: 'Generate E2E test specs from requirements', cmd: 'shell:echo "test gen placeholder"' },
        { id: 'run-e2e', label: 'Run E2E Suite', description: 'Execute Appium tests on Sauce Labs', cmd: 'shell:cd ~/repos/rtms-mobile-notifications && npx wdio run tests/wdio.conf.ts 2>&1 || true' },
        { id: 'opencode-task', label: 'OpenCode: Code Task', description: 'Delegate coding to OpenCode', cmd: 'opencode' },
      ],
    },
    {
      id: 'claw-mgmt',
      label: '🤖 OpenClaw Ops',
      emoji: '🤖',
      description: 'OpenClaw gateway, config, node management',
      status: 'healthy',
      statusLabel: 'Healthy',
      topic: 'Claw Mgmt',
      topicDocs: ['CONTEXT.md'],
      context: 'Host: archlinux | Tailscale Funnel | ngrok tunnels | 2 services',
      subtasks: [
        { id: 'gateway', label: 'Gateway health: OK', state: 'done', icon: '❤️' },
        { id: 'heartbeat', label: 'Heartbeat cycle: running', state: 'running', icon: '💓' },
        { id: 'funnel', label: 'Tailscale Funnel: active', state: 'done', icon: '🌐' },
        { id: 'ngrok', label: 'ngrok tunnels: 2 active', state: 'done', icon: '🔌' },
      ],
      subAgents: [
        { id: 'health-check', label: 'Full Health Check', description: 'Verify all services, tunnels, and channels', cmd: 'shell:echo "Gateway: $(systemctl --user is-active openclaw-gateway.service)\\nNode: $(systemctl --user is-active openclaw-node.service)"' },
        { id: 'update-oc', label: 'Update OpenClaw', description: 'npm update & restart services', cmd: 'shell:sudo npm update -g openclaw && systemctl --user restart openclaw-gateway.service openclaw-node.service 2>&1 || true' },
      ],
    },
    {
      id: 'pm-automation',
      label: '📋 PM Automation',
      emoji: '📋',
      description: 'Standups, project updates, release tracking',
      status: 'healthy',
      statusLabel: 'Scheduled',
      topic: 'Project Management',
      topicDocs: ['scheduled/*.md', 'framework.md', 'project_update.md', 'release_tracker.md'],
      context: 'Standup: M-F 11:30 AM | Project Update: Tue/Fri 8:35 AM | Training Nag: q2h',
      subtasks: [
        { id: 'standup', label: 'Daily standup (next: 11:30 AM)', state: 'pending', icon: '📢' },
        { id: 'proj-update', label: 'Project update (next: Tue 8:35 AM)', state: 'pending', icon: '📝' },
        { id: 'training', label: 'Training nag queue: 3 pending', state: 'pending', icon: '🎓' },
        { id: 'release', label: 'Release tracker: 1 pending', state: 'running', icon: '🏷️' },
      ],
      subAgents: [
        { id: 'gen-standup', label: 'Generate Standup Now', description: 'Scrape Teams + Jira → post to Slack', cmd: 'shell:cd ~/.openclaw/workspace/gdrive/ThoughtStack/OpenClaw/Topics/Project\\ Management/Scheduled/daily-standup && cat SKILL.md 2>/dev/null || echo "SKILL.md not found"' },
        { id: 'proj-update-now', label: 'Generate Project Update', description: 'Build email-ready status update', cmd: 'shell:cat ~/.openclaw/workspace/gdrive/ThoughtStack/OpenClaw/Topics/Project\\ Management/project_update.md' },
      ],
    },
    {
      id: 'epub-mgmt',
      label: '📚 KOReader',
      emoji: '📚',
      description: 'EPUB cleaning, book management, Kobo sync',
      status: 'idle',
      statusLabel: 'Idle',
      topic: 'epub Management',
      topicDocs: ['README.md'],
      context: 'Pending: 0 books | Last sync: 2026-05-20',
      subtasks: [
        { id: 'epub-clean', label: 'Last cleaned: The Shining - Stephen King', state: 'done', icon: '🧹' },
        { id: 'epub-sync', label: 'Kobo sync: OK', state: 'done', icon: '📤' },
        { id: 'epub-wait', label: 'Waiting for new files', state: 'pending', icon: '💤' },
      ],
      subAgents: [
        { id: 'scan-books', label: 'Scan for New Books', description: 'Check download folder for new EPUBs', cmd: 'shell:find ~/Downloads -name "*.epub" -newer ~/projects/koreader-management/last-scan 2>/dev/null | head -10; touch ~/projects/koreader-management/last-scan' },
        { id: 'sync-kobo', label: 'Sync to Kobo', description: 'SSH-copy cleaned books to Kobo', cmd: 'shell:echo "Would run: rsync cleaned books to KOBO"' },
      ],
    },
    {
      id: 'career',
      label: '💼 Job Search',
      emoji: '💼',
      description: 'Job board scanning, resume optimization',
      status: 'active',
      statusLabel: 'Scheduled',
      topic: 'Career',
      topicDocs: ['Resume/*.md'],
      context: 'Target: Lead/Principal/Architect | Daily scan',
      subtasks: [
        { id: 'linkedin', label: 'LinkedIn scan: 2 new matches', state: 'done', icon: '🔎' },
        { id: 'indeed', label: 'Indeed scan: 0 new matches', state: 'done', icon: '🔎' },
        { id: 'scoring', label: 'Match scoring: 2 candidates', state: 'running', icon: '📊' },
        { id: 'report', label: 'Report pending delivery', state: 'pending', icon: '📨' },
      ],
      subAgents: [
        { id: 'scan-jobs', label: 'Scan Job Boards', description: 'Run jobs.py scanner for new roles', cmd: 'shell:cd ~/projects/openclaw-ai && .venv/bin/python agents/jobs.py 2>&1 || true' },
        { id: 'scan-more', label: 'More Results', description: 'Show next page of pending results', cmd: 'shell:cd ~/projects/openclaw-ai && .venv/bin/python agents/jobs.py --more 2>&1 || true' },
        { id: 'reset-jobs', label: 'Reset Seen Database', description: 'Clear history and rescan all boards', cmd: 'shell:rm -f ~/projects/openclaw-ai/data/jobs_seen.json ~/projects/openclaw-ai/data/jobs_pending.json && cd ~/projects/openclaw-ai && .venv/bin/python agents/jobs.py 2>&1 || true' },
      ],
    },
    {
      id: 'sysadmin',
      label: '⚙️ System Admin',
      emoji: '⚙️',
      description: 'Arch Linux maintenance, MacBook management',
      status: 'healthy',
      statusLabel: 'Healthy',
      topic: 'SysAdmin',
      topicDocs: ['README.md', 'Laptop/maintenance.md', 'OpenClaw/management.md'],
      context: 'Kernel 7.0.3-arch1-2 | Uptime: 12d',
      subtasks: [
        { id: 'sys-updates', label: 'System updates: 0 pending', state: 'done', icon: '🔄' },
        { id: 'sys-disk', label: 'Disk: / 65% | /home 42%', state: 'done', icon: '💾' },
        { id: 'sys-services', label: 'All services: running', state: 'done', icon: '✅' },
      ],
      subAgents: [
        { id: 'check-updates', label: 'Check System Updates', description: 'Check Arch Linux package updates', cmd: 'shell:checkupdates 2>/dev/null | head -20 || echo "No pending updates"' },
      ],
    },
    {
      id: 'spec-dd',
      label: '📐 Spec Architecture',
      emoji: '📐',
      description: 'RTMS spec standards, requirements review',
      status: 'idle',
      statusLabel: 'Idle',
      topic: 'Spec_DD',
      topicDocs: ['ARCHITECTURE.md', 'README.md'],
      context: 'Standard: rtms-specs canonical requirements repo',
      subtasks: [
        { id: 'spec-arch', label: 'Spec architecture defined', state: 'done', icon: '✅' },
        { id: 'spec-adr', label: 'ADR workflow documented', state: 'done', icon: '✅' },
      ],
      subAgents: [
        { id: 'review-reqs', label: 'Review Requirements', description: 'Audit requirements.md against source', cmd: 'skill:requirements-auditor' },
      ],
    },
    {
      id: 'network',
      label: '🌐 Network',
      emoji: '🌐',
      description: 'Router, devices, VPN, Tailscale',
      status: 'healthy',
      statusLabel: 'Healthy',
      topic: 'Network Management',
      topicDocs: ['README.md', 'Router/orbi-router.md', 'Devices/devices.md'],
      context: 'Orbi RBR10 | WireGuard VPN | Tailscale tailnet',
      subtasks: [
        { id: 'net-router', label: 'Router: online', state: 'done', icon: '📡' },
        { id: 'net-vpn', label: 'WireGuard: active', state: 'done', icon: '🔒' },
        { id: 'net-tailscale', label: 'Tailscale: 3 devices', state: 'done', icon: '🌐' },
      ],
      subAgents: [
        { id: 'ping-router', label: 'Ping Router', description: 'Check Orbi router reachability', cmd: 'shell:ping -c 2 -W 3 192.168.1.1 2>&1 || echo "ROUTER UNREACHABLE"' },
      ],
    },
    {
      id: 'personal',
      label: '🏥 Personal',
      emoji: '🏥',
      description: 'Health tracking, reminders',
      status: 'idle',
      statusLabel: 'Idle',
      topic: 'Personal',
      topicDocs: ['Health/Coaching/*.md'],
      context: 'Health coaching prompt available',
      subtasks: [],
      subAgents: [],
    },
    {
      id: 'travel',
      label: '✈️ Travel',
      emoji: '✈️',
      description: 'Ireland trip planning',
      status: 'idle',
      statusLabel: 'Idle',
      topic: 'Travel',
      topicDocs: ['Ireland/*.md'],
      context: 'Ireland 12-day trip | Fodor\'s guide integrated',
      subtasks: [],
      subAgents: [],
    },
    {
      id: 'consulting',
      label: '🏢 Apex AI',
      emoji: '🏢',
      description: 'AI consulting business',
      status: 'idle',
      statusLabel: 'Idle',
      topic: 'Apex_AI_Consulting',
      topicDocs: ['README.md'],
      context: 'Business plan, client pipeline',
      subtasks: [],
      subAgents: [],
    },
  ];

  // Only add agents that don't exist (preserves user-created ones)
  for (const def of defaults) {
    if (!state.agents[def.id]) {
      state.agents[def.id] = { ...def, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    }
  }
  saveState();
}

ensureDefaultAgents();

// ── Job runner ──
const runningJobs = new Map();

// ── Agent Chat state ──
const agentChatHistory = new Map(); // agentId -> [{role, content}]
const MAX_CHAT_HISTORY = 20;

// ── Shell command runner ──
const shellHistory = [];
const MAX_SHELL_HISTORY = 50;
const runningCommands = new Map();

function runJob(agentId, subAgentId) {
  const agent = state.agents[agentId];
  if (!agent) return { error: 'Agent not found' };

  const subAgent = agent.subAgents.find(s => s.id === subAgentId);
  if (!subAgent) return { error: 'Sub-agent not found' };

  const jobId = `${agentId}-${subAgentId}-${Date.now()}`;
  const job = {
    id: jobId,
    agentId,
    subAgentId,
    label: subAgent.label,
    status: 'running',
    startedAt: new Date().toISOString(),
    output: [],
  };

  state.jobs[jobId] = job;
  runningJobs.set(jobId, job);
  saveState();
  broadcast('job:start', job);

  const cmd = subAgent.cmd;

  // Handle skill: prefix (special skills)
  if (cmd.startsWith('skill:')) {
    const skillId = cmd.slice(6);
    job.output.push(`[dashboard] Spawning skill: ${skillId}`);
    pushUpdate(job);

    // Run the skill via shell (agent-ping style)
    const child = spawn('bash', ['-c', `echo "Skill ${skillId} started" && sleep 2 && echo "Skill ${skillId} completed"`]);
    captureOutput(child, job);
    return { jobId };
  }

  // Handle opencode: prefix
  if (cmd === 'opencode') {
    job.output.push('[dashboard] OpenCode interaction requested — pending manual input');
    pushUpdate(job);
    // For now, mark as info
    finishJob(jobId, 'info', 'OpenCode requires terminal interaction. Triggered via OpenCode command.');
    return { jobId };
  }

  // Handle shell: prefix or direct commands
  const shellCmd = cmd.startsWith('shell:') ? cmd.slice(6) : cmd;
  const child = spawn('bash', ['-c', shellCmd], {
    cwd: path.resolve(process.env.HOME || '/home/rudesyle'),
    env: { ...process.env, HOME: process.env.HOME || '/home/rudesyle' },
    shell: '/bin/bash',
  });

  captureOutput(child, job);
  return { jobId };
}

function captureOutput(child, job) {
  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      job.output.push(line);
      pushUpdate(job);
    }
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      job.output.push(`[stderr] ${line}`);
      pushUpdate(job);
    }
  });

  child.on('close', (code) => {
    finishJob(job.id, code === 0 ? 'done' : 'error', `Exit code: ${code}`);
  });

  child.on('error', (err) => {
    finishJob(job.id, 'error', `Spawn error: ${err.message}`);
  });
}

function pushUpdate(job) {
  broadcast('job:update', { id: job.id, output: job.output, status: job.status });
  saveState();
  // Also broadcast a subtask update for the agent feed
  if (job.output.length > 0) {
    const lastLine = job.output[job.output.length - 1];
    broadcast('update', {
      agent: job.agentId,
      subtask: {
        id: `job-${job.subAgentId}`,
        label: lastLine,
        state: job.status === 'running' ? 'running' : job.status,
        icon: job.status === 'running' ? '🔄' : job.status === 'done' ? '✅' : '❌',
      }
    });
  }
}

function finishJob(jobId, status, message) {
  const job = state.jobs[jobId];
  if (!job) return;
  job.status = status;
  job.finishedAt = new Date().toISOString();
  if (message) job.output.push(message);
  runningJobs.delete(jobId);
  saveState();
  broadcast('job:done', { id: jobId, status, message });

  // Also update the agent subtask feed
  const agentName = job.agentId;
  const subtaskId = `job-${job.subAgentId}-${Date.now()}`;
  broadcast('update', {
    agent: agentName,
    subtask: {
      id: subtaskId,
      label: `[${job.label}] ${message || (status === 'done' ? 'Completed ✅' : 'Failed ❌')}`,
      state: status,
      icon: status === 'done' ? '✅' : '❌',
    }
  });
}

// ── Parse body ──
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve(null); }
    });
    req.on('error', reject);
  });
}

// ── Global + Project context ──
const WORKSPACE_DIR = path.resolve(process.env.HOME || '/home/rudesyle', '.openclaw/workspace');
const GLOBAL_CTX_DIR = path.join(WORKSPACE_DIR, 'global-context');
const PROJECTS_DIR = path.join(WORKSPACE_DIR, 'projects');

function readDirMdFiles(dirPath, maxFiles) {
  try {
    if (!fs.existsSync(dirPath)) return '';
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'));
    let content = '';
    for (const file of files.slice(0, maxFiles || 8)) {
      const filePath = path.join(dirPath, file);
      try {
        const text = fs.readFileSync(filePath, 'utf8').trim();
        content += '\n--- ' + file + ' ---\n' + text.slice(0, 4000) + '\n';
      } catch (_) {}
    }
    return content;
  } catch (_) { return ''; }
}

function readGlobalContext() {
  return readDirMdFiles(GLOBAL_CTX_DIR, 10);
}

function readProjectContext(agentId) {
  return readDirMdFiles(path.join(PROJECTS_DIR, agentId, 'context'), 8);
}

// ── Call OpenClaw API ──
const https = require('https');

function callOpenClaw(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: OC_MODEL,
      stream: false,
      messages: messages,
    });

    const url = new URL(OC_API_URL);
    const apiPath = url.pathname === '/' ? '/v1/chat/completions' : url.pathname;
    const isHttps = url.protocol === 'https:';

    const reqOpts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: apiPath,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OC_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const transport = isHttps ? https : http;
    const req = transport.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.choices?.[0]?.message?.content;
          if (text) {
            resolve(text);
          } else {
            reject(new Error('Empty response from API: ' + data.slice(0, 200)));
          }
        } catch (e) {
          reject(new Error('Parse error: ' + e.message + ' — body: ' + data.slice(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Router ──
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;
  const pathParts = url.pathname.split('/').filter(Boolean);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── API Routes ──

  // POST /api/agents/:id/chat — ask agent a question
  if (method === 'POST' && pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'agents' && pathParts[3] === 'chat') {
    const agentId = pathParts[2];
    const agent = state.agents[agentId];
    if (!agent) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

    const body = await parseBody(req);
    if (!body || !body.message) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing message' }));
      return;
    }

    // Build system prompt from agent state + project context files
    const tasks = agent.subtasks.map(t => '  [' + t.state + '] ' + t.label).join('\n');
    const actions = agent.subAgents.map(sa => '  ' + sa.label + ' — ' + sa.description).join('\n');
    const globalCtx = readGlobalContext();
    const projectCtx = readProjectContext(agentId);
    const systemPrompt = [
      'You are ' + (agent.label || agent.id) + ', an AI assistant focused on ' + (agent.description || 'managing ' + agent.id) + '.',
      globalCtx ? ('\n=== Global Context ===' + globalCtx) : '',
      '',
      'Status: ' + (agent.statusLabel || agent.status),
      'Context: ' + (agent.context || 'No additional context'),
      agent.topic ? 'Topic: ' + agent.topic : '',
      '',
      'Current tasks:',
      tasks || '  (none)',
      '',
      'Available actions you can suggest:',
      actions || '  (none)',
      projectCtx ? ('\n=== Project Documents ===' + projectCtx) : '',
      '',
      'Answer questions concisely. Help the user understand the current state and suggest what to do next. Use the project documents and global context above to answer questions.',
    ].filter(Boolean).join('\n');

    // Get or create chat history for this agent
    if (!agentChatHistory.has(agentId)) {
      agentChatHistory.set(agentId, []);
    }
    const history = agentChatHistory.get(agentId);

    // Add user message to history
    history.push({ role: 'user', content: body.message });
    if (history.length > MAX_CHAT_HISTORY) history.shift();

    // Build messages array for API call
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
    ];

    // Respond immediately so the client knows we got the message
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

    // Call OpenClaw API (non-blocking after response)
    callOpenClaw(messages).then(response => {
      history.push({ role: 'assistant', content: response });
      if (history.length > MAX_CHAT_HISTORY) history.shift();
      broadcast('chat:response', { agentId, message: body.message, response });
    }).catch(err => {
      const errMsg = 'Error: ' + (err.message || 'Failed to reach AI backend');
      history.push({ role: 'assistant', content: errMsg });
      broadcast('chat:response', { agentId, message: body.message, response: errMsg });
    });

    return;
  }

  // GET /api/global-context — list global context files
  if (method === 'GET' && pathParts.length === 2 && pathParts[0] === 'api' && pathParts[1] === 'global-context') {
    try {
      if (!fs.existsSync(GLOBAL_CTX_DIR)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files: [] }));
        return;
      }
      const files = fs.readdirSync(GLOBAL_CTX_DIR).filter(f => f.endsWith('.md')).map(f => ({
        name: f,
        path: f,
        size: fs.statSync(path.join(GLOBAL_CTX_DIR, f)).size,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/global-context/:file — read a global context file
  if (method === 'GET' && pathParts.length === 3 && pathParts[0] === 'api' && pathParts[1] === 'global-context') {
    const fileName = pathParts[2];
    const filePath = path.resolve(path.join(GLOBAL_CTX_DIR, fileName));
    if (!filePath.startsWith(GLOBAL_CTX_DIR) || !fileName.endsWith('.md')) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: fileName, content }));
    } catch (e) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'File not found' }));
    }
    return;
  }

  // PUT /api/global-context/:file — write a global context file
  if (method === 'PUT' && pathParts.length === 3 && pathParts[0] === 'api' && pathParts[1] === 'global-context') {
    const fileName = pathParts[2];
    const filePath = path.resolve(path.join(GLOBAL_CTX_DIR, fileName));
    if (!filePath.startsWith(GLOBAL_CTX_DIR) || !fileName.endsWith('.md')) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    const body = await parseBody(req);
    if (!body || body.content === undefined) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing content' }));
      return;
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, body.content, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── File-backed Real Tasks ──
  function parseTasksFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return { sections: [], raw: '' };
      var raw = fs.readFileSync(filePath, 'utf8');
      var lines = raw.split('\n');
      var sections = [];
      var currentSection = { name: 'Tasks', tasks: [] };
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var sectionMatch = line.match(/^##\s+(.+)/);
        if (sectionMatch) {
          if (currentSection.tasks.length > 0) sections.push(currentSection);
          currentSection = { name: sectionMatch[1].trim(), tasks: [] };
        }
        var taskMatch = line.match(/^[-*] \[([ xX])\] (.+)/);
        if (taskMatch) {
          currentSection.tasks.push({
            checked: taskMatch[1] === 'x' || taskMatch[1] === 'X',
            text: taskMatch[2].trim(),
            lineNum: i,
          });
        }
      }
      if (currentSection.tasks.length > 0) sections.push(currentSection);
      return { sections, raw };
    } catch (_) { return { sections: [], raw: '' }; }
  }

  function rebuildTasksFile(sections) {
    var result = '# Tasks\n\n';
    for (var i = 0; i < sections.length; i++) {
      result += '## ' + sections[i].name + '\n';
      if (sections[i].tasks.length === 0) {
        result += '- (none)\n';
      } else {
        for (var j = 0; j < sections[i].tasks.length; j++) {
          var t = sections[i].tasks[j];
          result += '- [' + (t.checked ? 'x' : ' ') + '] ' + t.text + '\n';
        }
      }
      result += '\n';
    }
    return result;
  }

  // GET /api/projects/:id/tasks — list real tasks
  if (method === 'GET' && pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'projects' && pathParts[3] === 'tasks') {
    var projectId = pathParts[2];
    var tasksFile = path.join(PROJECTS_DIR, projectId, 'context', 'tasks.md');
    var data = parseTasksFile(tasksFile);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  // POST /api/projects/:id/tasks/toggle — toggle a task
  if (method === 'POST' && pathParts.length === 5 && pathParts[0] === 'api' && pathParts[1] === 'projects' && pathParts[3] === 'tasks' && pathParts[4] === 'toggle') {
    var projectId = pathParts[2];
    var body = await parseBody(req);
    if (!body || body.text === undefined) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing text' }));
      return;
    }
    var tasksFile = path.join(PROJECTS_DIR, projectId, 'context', 'tasks.md');
    var data = parseTasksFile(tasksFile);
    var found = false;
    for (var si = 0; si < data.sections.length; si++) {
      for (var ti = 0; ti < data.sections[si].tasks.length; ti++) {
        if (data.sections[si].tasks[ti].text === body.text) {
          data.sections[si].tasks[ti].checked = body.checked !== undefined ? !!body.checked : !data.sections[si].tasks[ti].checked;
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (found) {
      try {
        var newContent = rebuildTasksFile(data.sections);
        fs.writeFileSync(tasksFile, newContent, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Task not found' }));
    }
    return;
  }

  // POST /api/projects/:id/tasks/add — add a task
  if (method === 'POST' && pathParts.length === 5 && pathParts[0] === 'api' && pathParts[1] === 'projects' && pathParts[3] === 'tasks' && pathParts[4] === 'add') {
    var projectId = pathParts[2];
    var body = await parseBody(req);
    if (!body || !body.text) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing text' }));
      return;
    }
    var tasksFile = path.join(PROJECTS_DIR, projectId, 'context', 'tasks.md');
    var data = parseTasksFile(tasksFile);
    // Add to first pending/in-progress section, or create one
    var section = data.sections.find(function(s) { return /pending|in.progress/i.test(s.name); });
    if (!section) {
      section = { name: 'Pending', tasks: [] };
      data.sections.unshift(section);
    }
    section.tasks.push({ checked: false, text: body.text });
    try {
      var newContent = rebuildTasksFile(data.sections);
      fs.writeFileSync(tasksFile, newContent, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/projects/:id/context — list context files
  if (method === 'GET' && pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'projects' && pathParts[3] === 'context') {
    const projectId = pathParts[2];
    const ctxDir = path.join(PROJECTS_DIR, projectId, 'context');
    try {
      if (!fs.existsSync(ctxDir)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files: [] }));
        return;
      }
      const files = fs.readdirSync(ctxDir).filter(f => f.endsWith('.md')).map(f => ({
        name: f,
        path: 'context/' + f,
        size: fs.statSync(path.join(ctxDir, f)).size,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/projects/:id/context/* — read a file
  if (method === 'GET' && pathParts.length === 5 && pathParts[0] === 'api' && pathParts[1] === 'projects' && pathParts[3] === 'context') {
    const projectId = pathParts[2];
    const fileName = pathParts[4];
    const filePath = path.resolve(path.join(PROJECTS_DIR, projectId, 'context', fileName));
    // Security: ensure resolved path is within the context directory
    if (!filePath.startsWith(path.join(PROJECTS_DIR, projectId, 'context'))) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: fileName, content }));
    } catch (e) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'File not found' }));
    }
    return;
  }

  // PUT /api/projects/:id/context/* — write a file
  if (method === 'PUT' && pathParts.length === 5 && pathParts[0] === 'api' && pathParts[1] === 'projects' && pathParts[3] === 'context') {
    const projectId = pathParts[2];
    const fileName = pathParts[4];
    const filePath = path.resolve(path.join(PROJECTS_DIR, projectId, 'context', fileName));
    if (!filePath.startsWith(path.join(PROJECTS_DIR, projectId, 'context')) || !fileName.endsWith('.md')) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    const body = await parseBody(req);
    if (!body || body.content === undefined) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing content' }));
      return;
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, body.content, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/projects — create a new project
  if (method === 'POST' && pathParts.length === 2 && pathParts[0] === 'api' && pathParts[1] === 'projects') {
    const body = await parseBody(req);
    if (!body || !body.id || !body.label) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing id or label' }));
      return;
    }
    const projId = body.id.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const projDir = path.join(PROJECTS_DIR, projId);
    try {
      if (state.agents[projId]) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'Project already exists' }));
        return;
      }
      // Create project directories and default files
      fs.mkdirSync(path.join(projDir, 'context'), { recursive: true });
      fs.writeFileSync(path.join(projDir, 'README.md'), '# ' + body.label + '\n\n' + (body.description || ''), 'utf8');
      fs.writeFileSync(path.join(projDir, 'notes.md'), '# Notes\n\n', 'utf8');
      fs.writeFileSync(path.join(projDir, 'decisions.md'), '# Decisions\n- ' + new Date().toISOString().slice(0, 10) + ': Project created\n', 'utf8');
      fs.writeFileSync(path.join(projDir, 'tasks.md'), '# Tasks\n\n', 'utf8');

      // Register as an agent in the dashboard
      const hasEmoji = /^\p{Emoji}/u.test(body.label);
      const newAgent = {
        id: projId,
        label: hasEmoji ? body.label : (body.emoji || '📁') + ' ' + body.label,
        emoji: body.emoji || (hasEmoji ? body.label.match(/^(\p{Emoji}+)/u)?.[1] || '📁' : '📁'),
        description: body.description || '',
        status: 'idle',
        statusLabel: 'New',
        topic: body.topic || body.label,
        context: body.context || 'Project created',
        subtasks: [],
        subAgents: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.agents[projId] = newAgent;
      saveState();
      broadcast('agent:created', newAgent);

      // Also sync context from GDrive if a topic folder exists
      const topicName = body.topic || body.label;
      const gdrivePath = 'gdrive:ThoughtStack/OpenClaw/Topics/' + topicName.replace(/ /g, ' ');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, project: newAgent }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/state — full agent state
  if (method === 'GET' && url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
    return;
  }

  // GET /api/stream — SSE
  if (method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':ok\n\n');
    // Send current snapshot
    res.write(`event: snapshot\ndata: ${JSON.stringify(state)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // GET /api/health
  if (method === 'GET' && url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', clients: clients.size, uptime: process.uptime(), agents: Object.keys(state.agents).length }));
    return;
  }

  // POST /api/update — agent pushes status update
  if (method === 'POST' && url.pathname === '/api/update') {
    const body = await parseBody(req);
    if (!body || !body.agent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "agent" in body' }));
      return;
    }

    const agentId = body.agent;
    if (!state.agents[agentId]) {
      // Auto-create agent if it doesn't exist (for external agents)
      state.agents[agentId] = {
        id: agentId,
        label: body.agentLabel || agentId,
        emoji: body.emoji || '🔄',
        description: body.description || 'External agent',
        status: 'active',
        statusLabel: 'Active',
        subtasks: [],
        subAgents: [],
        context: body.context || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    if (body.subtask) {
      state.agents[agentId].updatedAt = new Date().toISOString();
      const existing = state.agents[agentId].subtasks.find(s => s.id === body.subtask.id);
      if (existing) {
        Object.assign(existing, body.subtask, { timestamp: new Date().toISOString() });
      } else {
        state.agents[agentId].subtasks.push({ ...body.subtask, timestamp: new Date().toISOString() });
      }

      // Auto-update agent status based on subtask states
      const tasks = state.agents[agentId].subtasks;
      const errors = tasks.filter(t => t.state === 'error').length;
      const running = tasks.filter(t => t.state === 'running').length;
      if (errors > 0) { state.agents[agentId].status = 'error'; state.agents[agentId].statusLabel = 'Error'; }
      else if (running > 0) { state.agents[agentId].status = 'active'; state.agents[agentId].statusLabel = 'Active'; }
      else { state.agents[agentId].status = 'healthy'; state.agents[agentId].statusLabel = 'Ready'; }
    }

    saveState();
    broadcast('update', { agent: agentId, subtask: body.subtask || body, full: state.agents[agentId] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/agents — create new agent
  if (method === 'POST' && url.pathname === '/api/agents') {
    const body = await parseBody(req);
    if (!body || !body.id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "id" in body' }));
      return;
    }
    if (state.agents[body.id]) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent already exists' }));
      return;
    }

    state.agents[body.id] = {
      id: body.id,
      label: body.label || body.id,
      emoji: body.emoji || '🔄',
      description: body.description || '',
      status: body.status || 'idle',
      statusLabel: body.statusLabel || 'Idle',
      topic: body.topic || '',
      topicDocs: body.topicDocs || [],
      context: body.context || '',
      subtasks: body.subtasks || [],
      subAgents: body.subAgents || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    saveState();
    broadcast('agent:created', state.agents[body.id]);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, agent: state.agents[body.id] }));
    return;
  }

  // DELETE /api/agents/:id — delete agent
  if (method === 'DELETE' && pathParts.length === 3 && pathParts[0] === 'api' && pathParts[1] === 'agents') {
    const agentId = pathParts[2];
    if (state.agents[agentId]) {
      delete state.agents[agentId];
      saveState();
      broadcast('agent:deleted', { id: agentId });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
    }
    return;
  }

  // POST /api/agents/:id/spawn — spawn sub-agent
  if (method === 'POST' && pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'agents' && pathParts[3] === 'spawn') {
    const agentId = pathParts[2];
    const body = await parseBody(req);
    const subAgentId = body?.subAgentId;
    if (!subAgentId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "subAgentId" in body' }));
      return;
    }

    const result = runJob(agentId, subAgentId);
    if (result.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, jobId: result.jobId }));
    return;
  }

  // POST /api/agents/:id/subtasks — add subtask
  if (method === 'POST' && pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'agents' && pathParts[3] === 'subtasks') {
    const agentId = pathParts[2];
    const body = await parseBody(req);
    if (!body || !body.id || !body.label) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "id" or "label"' }));
      return;
    }
    if (!state.agents[agentId]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

    state.agents[agentId].subtasks.push({
      id: body.id,
      label: body.label,
      state: body.state || 'pending',
      icon: body.icon || '📋',
      timestamp: new Date().toISOString(),
    });
    state.agents[agentId].updatedAt = new Date().toISOString();
    saveState();
    broadcast('update', { agent: agentId, subtask: { id: body.id, label: body.label, state: body.state || 'pending', icon: body.icon || '📋' } });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/agents/:id/subagents — create custom sub-agent
  if (method === 'POST' && pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'agents' && pathParts[3] === 'subagents') {
    const agentId = pathParts[2];
    const body = await parseBody(req);
    if (!body || !body.label) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "label"' }));
      return;
    }
    if (!state.agents[agentId]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

    const saId = agentId + '-sa-' + Date.now();
    const sa = {
      id: saId,
      label: body.label,
      description: body.description || body.label,
      state: 'idle',
      custom: true,
      createdAt: new Date().toISOString(),
    };
    if (!state.agents[agentId].subAgents) state.agents[agentId].subAgents = [];
    state.agents[agentId].subAgents.push(sa);
    state.agents[agentId].updatedAt = new Date().toISOString();
    saveState();
    broadcast('agent:update', { agent: agentId });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, subAgent: sa }));
    return;
  }

  // POST /api/jobs/:id/cancel — cancel running job
  if (method === 'POST' && pathParts.length === 4 && pathParts[0] === 'api' && pathParts[1] === 'jobs' && pathParts[3] === 'cancel') {
    const jobId = pathParts[2];
    const job = runningJobs.get(jobId);
    if (job) {
      finishJob(jobId, 'cancelled', 'Cancelled by user');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No running job with that id' }));
    }
    return;
  }

  // POST /api/clear-logs — clear old job logs
  if (method === 'POST' && url.pathname === '/api/clear-logs') {
    const cutoff = Date.now() - 86400000; // 24h
    for (const [id, job] of Object.entries(state.jobs)) {
      const started = new Date(job.startedAt).getTime();
      if (started < cutoff) delete state.jobs[id];
    }
    saveState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, removed: true }));
    return;
  }

  // GET /api/commands — shell command history
  if (method === 'GET' && url.pathname === '/api/commands') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(shellHistory));
    return;
  }

  // POST /api/command — execute a shell command
  if (method === 'POST' && url.pathname === '/api/command') {
    const body = await parseBody(req);
    if (!body || !body.command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "command" in body' }));
      return;
    }

    const id = 'cmd-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
    const entry = {
      id,
      command: body.command,
      status: 'running',
      startedAt: new Date().toISOString(),
      output: [],
      exitCode: null,
      duration: null,
    };

    shellHistory.unshift(entry);
    if (shellHistory.length > MAX_SHELL_HISTORY) shellHistory.pop();

    broadcast('cmd:start', entry);

    const startTime = Date.now();
    const child = spawn('bash', ['-c', body.command], {
      cwd: path.resolve(process.env.HOME || '/home/rudesyle'),
      env: { ...process.env },
      shell: '/bin/bash',
    });

    runningCommands.set(id, child);

    child.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        entry.output.push({ type: 'stdout', text: line });
        broadcast('cmd:output', { id, line, type: 'stdout' });
      }
    });

    child.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        entry.output.push({ type: 'stderr', text: line });
        broadcast('cmd:output', { id, line, type: 'stderr' });
      }
    });

    child.on('close', (code) => {
      entry.status = code === 0 ? 'done' : 'error';
      entry.exitCode = code;
      entry.duration = Date.now() - startTime;
      runningCommands.delete(id);
      broadcast('cmd:done', { id, status: entry.status, exitCode: code, duration: entry.duration });
    });

    child.on('error', (err) => {
      entry.status = 'error';
      entry.exitCode = -1;
      entry.duration = Date.now() - startTime;
      entry.output.push({ type: 'stderr', text: 'Spawn error: ' + err.message });
      runningCommands.delete(id);
      broadcast('cmd:done', { id, status: 'error', exitCode: -1, duration: entry.duration });
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id }));
    return;
  }

  // POST /api/commands/:id/cancel — cancel a running command
  if (method === 'POST' && pathParts.length === 4 &&
      pathParts[0] === 'api' && pathParts[1] === 'commands' && pathParts[3] === 'cancel') {
    const cmdId = pathParts[2];
    const child = runningCommands.get(cmdId);
    if (child) {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (runningCommands.has(cmdId)) runningCommands.get(cmdId).kill('SIGKILL');
      }, 3000);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found or already finished' }));
    }
    return;
  }

  // ── Static file serve ──
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  if (filePath.includes('..')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  filePath = path.join(STATIC_DIR, filePath);

  try {
    const content = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

// ── Start ──
const server = http.createServer(handle);
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║       🔧 Agent Dashboard Server v2        ║
║────────────────────────────────────────────║
║  Dashboard  → http://localhost:${PORT}        ║
║  Funnel     → https://archlinux.tail0faf76.ts.net ║
║  SSE stream → /api/stream                  ║
║  API        → POST /api/update             ║
║  Spawn      → POST /api/agents/:id/spawn   ║
║  Create     → POST /api/agents             ║
║                                            ║
║  Command API → POST /api/command          ║
╚════════════════════════════════════════════╝
  `);
});

// ── Graceful shutdown ──
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  // Kill running jobs
  for (const [id, job] of runningJobs) {
    finishJob(id, 'cancelled', 'Server shutdown');
  }
  // Kill running shell commands
  for (const [id, child] of runningCommands) {
    child.kill('SIGKILL');
  }
  saveState();
  process.exit(0);
});
process.on('SIGTERM', () => {
  for (const [id, job] of runningJobs) {
    finishJob(id, 'cancelled', 'Server shutdown');
  }
  for (const [id, child] of runningCommands) {
    child.kill('SIGKILL');
  }
  saveState();
  process.exit(0);
});
