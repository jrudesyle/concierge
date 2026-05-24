/* ── Concierge v2 — Sidebar Layout + Themes ── */

// ── State ──
let state = { agents: {}, jobs: {} };
let currentTab = null;
let shellCommands = [];
let shellInputHistory = [];
let shellHistoryIndex = -1;
let runningShellCmdId = null;
let agentChats = {}; // agentId -> [{role, content}]
let notifEnabled = false;
let sse = null;

// ── DOM ──
const $ = id => document.getElementById(id);
const sidebarEl = $('sidebar');
const sidebarList = $('sidebarList');
const agentCount = $('agentCount');
const main = $('dashboardMain');
const toastContainer = $('toastContainer');
const connectionDot = document.querySelector('#settingsConnection .dot');
const connectionText = document.querySelector('#settingsConnection span:last-child');
const clockEl = $('clock');
const notifBtn = $('settingsNotifBtn');
const sidebarToggle = $('sidebarToggle');
const projectStrip = $('projectStrip');
const bottomTabs = document.querySelectorAll('.bottom-tab');
const settingsPane = $('settingsPane');
const settingsContent = $('settingsContent');
let activeTab = 'chat';
const addAgentBtn = $('addAgentBtn');

// ── Clock ──
function updateClock() {
  clockEl.textContent = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
updateClock();
setInterval(updateClock, 1000);

// ── Theme Persistence ──
function loadTheme() {
  const saved = localStorage.getItem('concierge-theme');
  const theme = saved || 'clean';
  document.body.dataset.theme = theme;
  document.querySelectorAll('.theme-card').forEach(function(c) {
    c.classList.toggle('active', c.dataset.theme === theme);
  });
}
function saveTheme(name) {
  document.body.dataset.theme = name;
  localStorage.setItem('concierge-theme', name);
  document.querySelectorAll('.theme-card').forEach(function(c) {
    c.classList.toggle('active', c.dataset.theme === name);
  });
}


// ── Shell Pane ──
function createShellPane() {
  if (document.getElementById('pane-_shell')) return;
  const pane = document.createElement('div');
  pane.className = 'tab-pane shell-pane';
  pane.id = 'pane-_shell';
  pane.innerHTML = `
    <div class="shell-output" id="shellOutput">
      <div class="shell-empty">
        <div class="big-icon">⌨️</div>
        <p>Type a command to run it on the server.<br>Output streams live.</p>
      </div>
    </div>
    <div class="shell-input-bar">
      <span class="shell-prompt">$</span>
      <input type="text" class="shell-input" id="shellInput" placeholder="Type a command..." spellcheck="false" autocomplete="off" />
      <button class="shell-run-btn" id="shellRunBtn">▸</button>
      <button class="shell-clear-btn" id="shellClearBtn">×</button>
    </div>
  `;
  main.appendChild(pane);

  // Bind shell input
  const shellInput = document.getElementById('shellInput');
  const shellRunBtn = document.getElementById('shellRunBtn');
  const shellClearBtn = document.getElementById('shellClearBtn');

  function submitShellCommand() {
    const cmd = shellInput.value.trim();
    if (!cmd) return;
    shellInputHistory.unshift(cmd);
    if (shellInputHistory.length > 50) shellInputHistory.pop();
    shellHistoryIndex = -1;
    shellInput.value = '';
    apiFetch('/api/command', { method: 'POST', body: JSON.stringify({ command: cmd }) });
  }

  shellInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      submitShellCommand();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (shellInputHistory.length === 0) return;
      shellHistoryIndex = Math.min(shellHistoryIndex + 1, shellInputHistory.length - 1);
      shellInput.value = shellInputHistory[shellHistoryIndex];
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (shellHistoryIndex <= 0) {
        shellHistoryIndex = -1;
        shellInput.value = '';
      } else {
        shellHistoryIndex--;
        shellInput.value = shellInputHistory[shellHistoryIndex];
      }
    }
  });

  shellRunBtn.addEventListener('click', submitShellCommand);
  shellClearBtn.addEventListener('click', () => {
    document.getElementById('shellOutput').innerHTML = '';
    shellCommands = [];
  });
}

function addShellCommandBlock(cmd) {
  const output = document.getElementById('shellOutput');
  // Clear empty state
  output.querySelector('.shell-empty')?.remove();

  const block = document.createElement('div');
  block.className = 'shell-cmd';
  block.dataset.cmdId = cmd.id;
  block.innerHTML = `
    <div class="shell-cmd-header ${cmd.status === 'running' ? 'running' : ''}">
      <span class="shell-cmd-status shell-status-${cmd.status}"></span>
      <code>$ ${escapeHtml(cmd.command)}</code>
      <span class="shell-cmd-duration" id="dur-${cmd.id}"></span>
      <button class="shell-cmd-cancel" data-cmd-id="${cmd.id}" title="Cancel">✕</button>
    </div>
    <div class="shell-cmd-body" id="body-${cmd.id}"></div>
    <div class="shell-cmd-footer" id="footer-${cmd.id}"></div>
  `;

  // Insert at top (most recent first)
  output.insertBefore(block, output.firstChild);

  // Bind cancel
  block.querySelector('.shell-cmd-cancel')?.addEventListener('click', () => {
    apiFetch('/api/commands/' + cmd.id + '/cancel', { method: 'POST' });
  });

  // Update sidebar dot
  updateShellStatusDot(cmd.status);
}

function appendShellLine(cmdId, line, type) {
  const body = document.getElementById('body-' + cmdId);
  if (!body) return;

  const el = document.createElement('div');
  el.className = 'shell-line' + (type === 'stderr' ? ' shell-stderr' : '');
  el.textContent = line;
  body.appendChild(el);

  // Auto-scroll the output area
  const output = document.getElementById('shellOutput');
  output.scrollTop = output.scrollHeight;
}

function finishShellCommand(id, status, exitCode, duration) {
  const block = document.querySelector('.shell-cmd[data-cmd-id="' + id + '"]');
  if (!block) return;

  const header = block.querySelector('.shell-cmd-header');
  const statusDot = block.querySelector('.shell-cmd-status');
  const durationEl = block.querySelector('.shell-cmd-duration');
  const footer = block.querySelector('.shell-cmd-footer');
  const cancelBtn = block.querySelector('.shell-cmd-cancel');

  // Update status dot
  statusDot.className = 'shell-cmd-status shell-status-' + status;
  header.classList.remove('running');

  // Show duration
  if (duration != null) {
    const secs = (duration / 1000).toFixed(1);
    durationEl.textContent = '\u2500 ' + secs + 's';
  }

  // Remove cancel button
  cancelBtn?.remove();

  // Show exit code in footer
  const isOk = status === 'done';
  footer.className = 'shell-cmd-footer visible';
  footer.innerHTML = '<span class="shell-exit-' + (isOk ? 'ok' : 'error') + '">\u2192 ' + (exitCode != null ? 'exit ' + exitCode : status) + '</span>';

  // Clear running state
  if (runningShellCmdId === id) runningShellCmdId = null;

  // Update sidebar dot
  updateShellStatusDot(null);
}

function updateShellStatusDot(status) {
  const dot = document.getElementById('shellStatusDot') || document.querySelector('.sidebar-item[data-agent="_shell"] .si-status');
  if (!dot) return;
  if (status === 'running' || runningShellCmdId) {
    dot.className = 'si-status si-status-warning';
    dot.style.animation = 'shellPulse 1s ease-in-out infinite';
  } else {
    dot.className = 'si-status si-status-idle';
    dot.style.animation = 'none';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Markdown Renderer ──
function renderMarkdown(text) {
  if (!text) return '';
  var escaped = escapeHtml(text);
  // Code blocks: ```lang\ncode\n```
  escaped = escaped.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, function(m, c) {
    return '<pre><code>' + c + '</code></pre>';
  });
  escaped = escaped.replace(/```(\w*)\n?([\s\S]*?)```/g, function(m, lang, code) {
    return '<pre><code class="lang-' + escapeHtml(lang) + '">' + code.trim() + '</code></pre>';
  });
  // Inline code
  escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Links
  escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Horizontal rules
  escaped = escaped.replace(/^---$/gm, '<hr>');
  // Unordered lists (lines starting with - or *)
  escaped = escaped.replace(/^( *)[*-] +(.*)$/gm, '$1• $2');
  // Line breaks
  escaped = escaped.replace(/\n/g, '<br>');
  return escaped;
}

// ── Bottom Tab Switching (mobile) ──
bottomTabs.forEach(function(tab) {
  tab.addEventListener('click', function() { switchTab(this.dataset.tab); });
});

function switchTab(tabName) {
  activeTab = tabName;
  bottomTabs.forEach(function(t) { t.classList.toggle('active', t.dataset.tab === tabName); });
  if (tabName === 'chat') {
    main.style.display = 'flex';
    settingsPane.style.display = 'none';
    renderProjectStrip();
    if (currentTab && currentTab !== '_shell') {
      var input = document.getElementById('chatInput-' + currentTab);
      if (input) input.focus();
    }
  } else {
    main.style.display = 'none';
    settingsPane.style.display = 'flex';
    renderSettings();
  }
}

function checkLayout() {
  var wide = window.innerWidth > 700;
  document.querySelectorAll('.bottom-tabs').forEach(function(el) { el.style.display = wide ? 'none' : 'flex'; });
  if (wide) {
    main.style.display = 'flex';
    settingsPane.style.display = 'none';
    sidebarEl.style.display = 'flex';
  } else {
    sidebarEl.style.display = 'none';
    switchTab(activeTab);
  }
}
window.addEventListener('resize', checkLayout);
setTimeout(checkLayout, 50);

// ── Notifications ──
async function enableNotifications() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

function sendDesktopNotif(title, body, icon = '🔧') {
  if (!notifEnabled) return;
  try {
    const n = new Notification(title, {
      body,
      icon: '/assets/icon-192.png',
      badge: '/assets/favicon.png',
      tag: 'concierge',
      silent: false,
    });
    setTimeout(() => n.close(), 10000);
  } catch (_) {}
}

// ── Toast ──
function showToast(icon, title, text, duration = 5000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      <div class="toast-text">${text}</div>
    </div>
    <button class="toast-close">&times;</button>
  `;
  el.querySelector('.toast-close').onclick = () => el.remove();
  toastContainer.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, duration);
}

// ── API ──
async function apiFetch(path, opts = {}) {
  try {
    const resp = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      ...opts,
    });
    return await resp.json();
  } catch (e) {
    showToast('⚠️', 'API Error', `Failed to ${opts.method || 'GET'} ${path}: ${e.message}`);
    return null;
  }
}

// ── Render Sidebar ──
function renderSidebar() {
  const agents = Object.values(state.agents);
  agentCount.textContent = agents.length;

  if (agents.length === 0) {
    sidebarList.innerHTML = '<div class="empty-state" style="padding:20px"><p>No agents yet.</p></div>';
    currentTab = null;
    renderPanes();
    return;
  }


  if (!currentTab || !state.agents[currentTab]) {
    currentTab = agents[0].id;
  }

  // Shell sidebar item
  const shellActive = currentTab === '_shell' ? 'active' : '';
  const shellDot = runningShellCmdId ? 'si-status-warning' : 'si-status-idle';
  const globalActive = currentTab === '_global' ? 'active' : '';
  sidebarList.innerHTML = `
    <button class="sidebar-item ${shellActive}" data-agent="_shell">
      <span class="si-status ${shellDot}" id="shellStatusDot"></span>
      <span class="si-icon">⌨️</span>
      <span class="si-label">Shell</span>
    </button>
    <button class="sidebar-item ${globalActive}" data-agent="_global">
      <span class="si-status si-status-healthy"></span>
      <span class="si-icon">🌐</span>
      <span class="si-label">Global</span>
    </button>
  ` + agents.map(a => {
    const active = a.id === currentTab ? 'active' : '';
    const running = a.subtasks.filter(s => s.state === 'running').length;
    const errors = a.subtasks.filter(s => s.state === 'error').length;

    let statusClass = 'si-status-healthy';
    if (a.status === 'warning') statusClass = 'si-status-warning';
    else if (a.status === 'error') statusClass = 'si-status-error';
    else if (a.status === 'idle') statusClass = 'si-status-idle';
    else if (a.status === 'active') statusClass = 'si-status-active';

    let badges = '';
    if (running > 0) badges += `<span class="si-badge si-badge-running">${running}</span>`;
    if (errors > 0) badges += `<span class="si-badge si-badge-error">${errors}</span>`;

    return `
      <button class="sidebar-item ${active}" data-agent="${a.id}">
        <span class="si-status ${statusClass}"></span>
        <span class="si-label">${a.label || a.id}</span>
        ${badges ? `<span class="si-badges">${badges}</span>` : ''}
      </button>
    `;
  }).join('');

  // Bind click handlers
  sidebarList.querySelectorAll('.sidebar-item').forEach(el => {
    el.addEventListener('click', () => selectAgent(el.dataset.agent));
  });

  renderPanes();
}

// ── Select Agent ──
function selectAgent(agentId) {
  if (agentId === currentTab) return;
  currentTab = agentId;

  // Update sidebar highlight
  document.querySelectorAll('.sidebar-item').forEach(el => {
    el.classList.toggle('active', el.dataset.agent === agentId);
  });

  // Update pane visibility and close any open info panels
  document.querySelectorAll('.tab-pane').forEach(p => {
    const isThis = p.id === `pane-${agentId}`;
    p.classList.toggle('active', isThis);
    if (!isThis) {
      // Close info panel when switching away
      const inner = p.querySelector('.pane-inner');
      if (inner) inner.classList.remove('info-open');
      const infoPanel = p.querySelector('.info-panel');
      if (infoPanel) infoPanel.style.display = 'none';
    }
    if (isThis && agentId === '_global') {
      loadGlobalFiles();
    }
  });

  // Focus shell input when switching to shell
  if (agentId === '_shell') {
    const shellInput = document.getElementById('shellInput');
    if (shellInput) setTimeout(function() { shellInput.focus(); }, 100);
  } else {
    // Load context files for the selected project
    setTimeout(function() { loadContextFiles(agentId); }, 200);
  }

  // Close sidebar on mobile
  if (window.innerWidth <= 600) {
    sidebarEl.classList.remove('open');
  }
}

// ── Global Pane ──
function createGlobalPane() {
  if (document.getElementById('pane-_global')) return;
  const pane = document.createElement('div');
  pane.className = 'tab-pane';
  pane.id = 'pane-_global';
  pane.innerHTML = `
    <div class="pane-header">
      <h2>🌐 Global Context</h2>
      <div class="pane-header-actions">
        <span class="pane-status-tag status-healthy">Applied to All Projects</span>
      </div>
    </div>
    <div class="context-panel"><strong>Global settings, identity, and tools.</strong> Loaded into every project chat. Edit below.</div>
    <div class="section-header">
      <h3>📄 Global Files</h3>
      <button class="btn-icon btn-reload-global" title="Reload">🔄</button>
    </div>
    <div class="context-files" id="globalFiles">
      <div class="empty-state"><p>Loading...</p></div>
    </div>
  `;
  main.appendChild(pane);

  pane.querySelector('.btn-reload-global').addEventListener('click', loadGlobalFiles);
}

async function loadGlobalFiles() {
  const container = document.getElementById('globalFiles');
  if (!container) return;
  const data = await apiFetch('/api/global-context');
  if (!data || !data.files || data.files.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No global context files yet</p></div>';
    return;
  }
  renderFileList(container, '_global', data.files, '/api/global-context');
}

function renderFileList(container, agentId, files, basePath) {
  container.innerHTML = files.map(function(f) {
    var fname = f.name.replace(/-/g, ' ').replace(/\.md$/, '');
    return '<div class="ctx-file" data-agent="' + agentId + '" data-file="' + f.name + '" data-base="' + basePath + '">' +
      '<div class="ctx-file-header">' +
      '<span class="ctx-file-icon">📄</span>' +
      '<span class="ctx-file-name">' + fname + '</span>' +
      '<span class="ctx-file-size">' + (f.size > 1024 ? Math.round(f.size / 1024) + ' KB' : f.size + ' B') + '</span>' +
      '</div>' +
      '<div class="ctx-file-editor" style="display:none">' +
      '<textarea class="ctx-textarea" data-agent="' + agentId + '" data-file="' + f.name + '" data-base="' + basePath + '"></textarea>' +
      '<div class="ctx-editor-actions">' +
      '<button class="ctx-save-btn" data-agent="' + agentId + '" data-file="' + f.name + '" data-base="' + basePath + '">💾 Save</button>' +
      '<button class="ctx-cancel-btn">Cancel</button>' +
      '</div></div></div>';
  }).join('');

  // Bind click to expand
  container.querySelectorAll('.ctx-file-header').forEach(function(el) {
    el.addEventListener('click', async function() {
      var parent = this.parentElement;
      var editor = parent.querySelector('.ctx-file-editor');
      var file = parent.dataset.file;
      var agent = parent.dataset.agent;
      var base = parent.dataset.base;
      if (editor.style.display === 'block') {
        editor.style.display = 'none';
        return;
      }
      var fileData = await apiFetch(base + '/' + file);
      if (fileData && fileData.content !== undefined) {
        var textarea = editor.querySelector('.ctx-textarea');
        if (textarea) textarea.value = fileData.content;
        editor.style.display = 'block';
      }
    });
  });

  container.querySelectorAll('.ctx-save-btn').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      var agent = this.dataset.agent;
      var file = this.dataset.file;
      var base = this.dataset.base;
      var editor = this.closest('.ctx-file-editor');
      if (!editor) return;
      var textarea = editor.querySelector('.ctx-textarea');
      if (!textarea) return;
      var result = await apiFetch(base + '/' + file, {
        method: 'PUT',
        body: JSON.stringify({ content: textarea.value }),
      });
      if (result && result.ok) {
        showToast('💾', 'Saved', file, 2000);
        editor.style.display = 'none';
      } else {
        showToast('❌', 'Save failed', file, 3000);
      }
    });
  });

  container.querySelectorAll('.ctx-cancel-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var editor = this.closest('.ctx-file-editor');
      if (editor) editor.style.display = 'none';
    });
  });
}

// ── Project Strip (mobile chip selector) ──
function renderProjectStrip() {
  if (!projectStrip) return;
  if (window.innerWidth > 700) { projectStrip.style.display = 'none'; return; }
  projectStrip.style.display = 'flex';
  var a = currentTab && state.agents[currentTab] ? state.agents[currentTab] : null;
  if (!a) { projectStrip.innerHTML = ''; return; }
  var emoji = a.emoji || '💬';
  projectStrip.innerHTML =
    '<span class="strip-current">' + emoji + ' ' + (a.label || a.id) + '</span>' +
    '<button class="strip-switch-btn" id="switchProjBtn">Switch</button>';
  var btn = document.getElementById('switchProjBtn');
  if (btn) btn.addEventListener('click', function() { switchTab('settings'); });
}

// ── Settings Pane ──
function renderSettings() {
  if (!settingsContent) return;
  var detailAgent = settingsContent.dataset.detailAgent;
  if (detailAgent && state.agents[detailAgent]) {
    renderSettingsDetail(detailAgent);
    return;
  }
  settingsContent.innerHTML = '';
  var agents = Object.values(state.agents);
  var list = document.createElement('div');
  list.className = 'settings-projects';
  agents.forEach(function(a) {
    var emoji = a.emoji || '📁';
    var statusDot = a.status === 'active' ? '🟢' : a.status === 'error' ? '🔴' : '⚪';
    var item = document.createElement('button');
    item.className = 'settings-project-item';
    item.innerHTML = '<span class="spi-dot">' + statusDot + '</span><span class="spi-label">' + emoji + ' ' + (a.label || a.id) + '</span><span class="spi-arrow">›</span>';
    item.addEventListener('click', function() { renderSettingsDetail(a.id); });
    list.appendChild(item);
  });
  settingsContent.appendChild(list);
  var newBtn = document.createElement('button');
  newBtn.className = 'settings-new-btn';
  newBtn.textContent = '＋ New Project';
  newBtn.addEventListener('click', showCreateProjectModal);
  settingsContent.appendChild(newBtn);
  var appSection = document.createElement('div');
  appSection.className = 'settings-app-section';
  appSection.innerHTML = '<div class="settings-app-title">App</div>' +
    '<button class="settings-app-btn" id="settingsThemeBtn">🎨 Theme</button>' +
    '<button class="settings-app-btn" id="settingsNotifBtn2">🔔 Notification Test</button>' +
    '<button class="settings-app-btn" id="pwaInstallBtn2" style="display:none">📲 Install</button>';
  settingsContent.appendChild(appSection);
  var themeBtn = document.getElementById('settingsThemeBtn');
  if (themeBtn) themeBtn.addEventListener('click', function() { document.getElementById('settingsBtn').click(); });
  var notifBtn2 = document.getElementById('settingsNotifBtn2');
  if (notifBtn2) notifBtn2.addEventListener('click', function() {
    if (notifEnabled) { sendDesktopNotif('🔔 Test', 'Notifications work!'); showToast('🔔', 'Test', 'Sent!'); }
    else { showToast('⚠️', 'Notifications', 'Enable in browser permissions.'); }
  });
  if (typeof installPromptEvent !== 'undefined' && installPromptEvent) {
    var pwaBtn = document.getElementById('pwaInstallBtn2');
    if (pwaBtn) { pwaBtn.style.display = 'flex'; pwaBtn.addEventListener('click', function() {
      installPromptEvent.prompt();
      installPromptEvent.userChoice.then(function(result) {
        if (result.outcome === 'accepted') { pwaBtn.style.display = 'none'; showToast('✅', 'Installed!', ''); }
        installPromptEvent = null;
      });
    });}
  }
}

function renderSettingsDetail(agentId) {
  var a = state.agents[agentId];
  if (!a) return;
  settingsContent.dataset.detailAgent = agentId;
  var backBtn = '<button class="settings-detail-back">‹ Back to Projects</button>';
  var header = '<div class="settings-detail-header">' + (a.emoji || '📁') + ' ' + (a.label || a.id) + '</div>';
  var tasksSection = '<div class="settings-section-title">📋 Tasks</div>' +
    '<div class="task-list" id="taskList-' + agentId + '"><div class="empty-state" style="padding:10px"><p>Loading...</p></div></div>' +
    '<button class="settings-add-btn" id="addTaskBtn-' + agentId + '">＋ Add Task</button>';
  var saHTML = '<div class="settings-section-title">⚡ Sub-Agents</div><div class="subagent-grid">';
  if (a.subAgents && a.subAgents.length > 0) {
    saHTML += a.subAgents.map(function(sa) {
      return '<div class="settings-sa-item">⚡ ' + sa.label + '<br><small>' + (sa.description || '') + '</small></div>';
    }).join('');
  } else {
    saHTML += '<div class="empty-state" style="padding:10px;font-size:0.82rem"><p>No sub-agents</p></div>';
  }
  saHTML += '</div><button class="settings-add-btn" id="createSubAgentBtn-' + agentId + '">＋ Custom Sub-Agent</button>';
  var ctxSection = '<div class="settings-section-title">📄 Context Files</div><div class="context-files" id="ctxFiles-' + agentId + '"><div class="empty-state"><p>Loading...</p></div></div>';
  settingsContent.innerHTML = backBtn + header + tasksSection + saHTML + ctxSection;
  settingsContent.querySelector('.settings-detail-back').addEventListener('click', function() {
    settingsContent.dataset.detailAgent = '';
    renderSettings();
  });
  renderTasks(agentId);
  loadContextFiles(agentId);
  var addTaskBtn = document.getElementById('addTaskBtn-' + agentId);
  if (addTaskBtn) addTaskBtn.addEventListener('click', function() {
    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;gap:4px;padding:4px 0';
    wrapper.innerHTML = '<input type="text" id="inlineTaskInput" class="task-add-input" placeholder="New task..." />' +
      '<button class="task-add-confirm" id="inlineTaskConfirm">Add</button>';
    this.parentNode.insertBefore(wrapper, this);
    var inp = document.getElementById('inlineTaskInput');
    inp.focus();
    document.getElementById('inlineTaskConfirm').addEventListener('click', function() {
      var text = inp.value.trim();
      if (!text) return;
      apiFetch('/api/projects/' + agentId + '/tasks/add', {
        method: 'POST',
        body: JSON.stringify({ text: text }),
      }).then(function(r) { if (r && r.ok) { wrapper.remove(); renderTasks(agentId); } });
    });
    inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') document.getElementById('inlineTaskConfirm').click(); });
  });
  var createBtn = document.getElementById('createSubAgentBtn-' + agentId);
  if (createBtn) createBtn.addEventListener('click', function() { showCreateSubAgentForm(agentId); });
}

// ── Render Panes ──
// ── Render Panes ──
function renderPanes() {
  document.querySelectorAll('.tab-pane:not(#pane-_shell)').forEach(p => p.remove());

  createShellPane();
  createGlobalPane();

  const agents = Object.values(state.agents);
  agents.forEach(a => {
    const pane = document.createElement('div');
    pane.className = 'tab-pane ' + (a.id === currentTab ? 'active' : '');
    pane.id = 'pane-' + a.id;

    let statusClass = 'status-healthy';
    if (a.status === 'warning') statusClass = 'status-warning';
    else if (a.status === 'error') statusClass = 'status-error';
    else if (a.status === 'idle') statusClass = 'status-idle';
    else if (a.status === 'active') statusClass = 'status-active';

    const labelClean = (a.label || a.id).replace(/['"]/g, '');

    // Build sub-agent buttons
    const saHTML = a.subAgents.length === 0
      ? '<p class="empty-state" style="padding:12px;font-size:0.82rem">No sub-agents configured.</p>'
      : a.subAgents.map(function(sa) {
          return '<button class="subagent-btn" data-agent="' + a.id + '" data-subagent="' + sa.id + '">' +
            '<span class="sa-icon">⚡</span>' +
            '<span class="sa-label">' + sa.label + '</span>' +
            '<span class="sa-desc">' + sa.description + '</span></button>';
        }).join('');

  // ── Create chat pane ──
  pane.innerHTML =
    '<div class="chat-pane">' +
      '<div class="chat-messages" id="chatMsgs-' + a.id + '">' +
        '<div class="chat-empty">' +
          '<div class="big-icon">💬</div>' +
          '<p>Start a conversation — ask questions, review code, or get help.</p>' +
        '</div>' +
      '</div>' +
      '<div class="chat-input-bar">' +
        '<input type="text" class="chat-input" id="chatInput-' + a.id + '" data-agent="' + a.id + '" placeholder="Ask about ' + labelClean + '..." />' +
        '<button class="chat-send-btn" data-agent="' + a.id + '">Send</button>' +
      '</div>' +
    '</div>';

    main.appendChild(pane);
  });

  // Load context files and tasks for visible agent
  if (currentTab && currentTab !== '_shell' && currentTab !== '_global') {
    loadContextFiles(currentTab);
    renderTasks(currentTab);
  }

  // Render chat
  renderChat(currentTab);

  // Bind chat send
  document.querySelectorAll('.chat-send-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      handleChatSend(this.dataset.agent);
    });
  });

  // Bind chat input enter
  document.querySelectorAll('.chat-input').forEach(function(input) {
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') handleChatSend(this.dataset.agent);
    });
  });

  var visibleInput = document.getElementById('chatInput-' + currentTab);
  if (visibleInput) visibleInput.focus();
}

// ── Sidebar Toggle (desktop) ──
sidebarToggle.addEventListener('click', function() {
  sidebarEl.classList.toggle('collapsed');
});

function toggleChatFullscreen() {
  const isFs = document.body.classList.toggle('chat-fullscreen');
  document.querySelectorAll('.chat-fs-btn').forEach(function(btn) {
    btn.textContent = isFs ? '✕' : '⛶';
    btn.title = isFs ? 'Exit full screen' : 'Full screen';
  });
  // Focus the chat input when entering fullscreen
  if (isFs) {
    const visibleInput = document.querySelector('.tab-pane.active .chat-input');
    if (visibleInput) setTimeout(function() { visibleInput.focus(); }, 100);
  }
}

// Escape key exits fullscreen chat
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && document.body.classList.contains('chat-fullscreen')) {
    toggleChatFullscreen();
  }
});

// ── Context Files ──
async function loadContextFiles(agentId) {
  const container = document.getElementById('ctxFiles-' + agentId);
  if (!container) return;
  const data = await apiFetch('/api/projects/' + agentId + '/context');
  if (!data || !data.files || data.files.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No context files yet</p></div>';
    return;
  }
  renderFileList(container, agentId, data.files, '/api/projects/' + agentId + '/context');
}



function renderTasks(agentId) {
  const container = document.getElementById('taskList-' + agentId);
  if (!container) return;
  apiFetch('/api/projects/' + agentId + '/tasks').then(function(data) {
    if (!data || !data.sections || data.sections.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding:10px"><p>No tasks yet.<br><small>Add one below.</small></p></div>';
      return;
    }
    container.innerHTML = data.sections.map(function(section) {
      var tasks = section.tasks.map(function(t) {
        return '<label class="task-item">' +
          '<input type="checkbox" class="task-checkbox" data-agent="' + agentId + '" data-text="' + escapeHtml(t.text) + '"' + (t.checked ? ' checked' : '') + ' />' +
          '<span class="task-text' + (t.checked ? ' done' : '') + '">' + escapeHtml(t.text) + '</span>' +
          '</label>';
      }).join('');
      return '<div class="task-section"><div class="task-section-title">' + escapeHtml(section.name) + '</div>' + tasks + '</div>';
    }).join('');

    // Bind checkbox toggles
    container.querySelectorAll('.task-checkbox').forEach(function(cb) {
      cb.addEventListener('change', function() {
        var text = this.dataset.text;
        var agent = this.dataset.agent;
        apiFetch('/api/projects/' + agent + '/tasks/toggle', {
          method: 'POST',
          body: JSON.stringify({ text: text, checked: this.checked }),
        }).then(function(result) {
          if (result && result.ok) {
            // Re-render
            renderTasks(agent);
          }
        });
      });
    });
  });
}

// ── Agent Chat ──

// Initialize chat state for all agents
function initAgentChats() {
  for (const id of Object.keys(state.agents)) {
    if (!agentChats[id]) agentChats[id] = [];
  }
}

function renderChat(agentId) {
  const container = document.getElementById('chatMsgs-' + agentId);
  if (!container) return;

  const msgs = agentChats[agentId] || [];
  if (msgs.length === 0) {
    container.innerHTML = '<div class="chat-empty"><div class="big-icon">💬</div><p>Start a conversation about <strong>' + (escapeHtml(agentId) || 'this project') + '</strong> — ask questions, review status, or get help.</p></div>';
    return;
  }

  container.innerHTML = msgs.map(function(m) {
    if (m.role === 'typing') {
      return '<div class="chat-msg chat-msg-assistant"><div class="chat-typing">Thinking...</div></div>';
    }
    var time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
    var content = m.role === 'assistant' ? renderMarkdown(m.content) : escapeHtml(m.content);
    return '<div class="chat-msg chat-msg-' + m.role + '">' +
      '<div class="chat-msg-content">' + content + '</div>' +
      (time ? '<div class="chat-msg-time">' + time + '</div>' : '') +
      '</div>';
  }).join('');

  container.scrollTop = container.scrollHeight;
}

async function handleChatSend(agentId) {
  const input = document.getElementById('chatInput-' + agentId);
  if (!input) return;
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';

  // Add user message with timestamp
  if (!agentChats[agentId]) agentChats[agentId] = [];
  agentChats[agentId].push({ role: 'user', content: msg, timestamp: Date.now() });
  // Add typing indicator
  agentChats[agentId].push({ role: 'typing', content: '' });
  renderChat(agentId);

  // Send to server
  await apiFetch('/api/agents/' + agentId + '/chat', {
    method: 'POST',
    body: JSON.stringify({ message: msg }),
  });
}

// ── Load initial state ──
async function loadInitialState() {
  const data = await apiFetch('/api/state');
  if (data) {
    state = data;
    initAgentChats();
    renderSidebar();
  } else {
    showToast('⚠️', 'Failed to Load', 'Could not fetch agent state from server.');
  }
}

// ── Spawn sub-agent ──
async function spawnSubAgent(agentId, subAgentId, btn) {
  btn.classList.add('spawning');
  btn.disabled = true;
  const origText = btn.innerHTML;
  btn.innerHTML = '⏳ Running...';
  btn.dataset.originalHtml = origText;

  const result = await apiFetch(`/api/agents/${agentId}/spawn`, {
    method: 'POST',
    body: JSON.stringify({ subAgentId }),
  });

  if (result?.ok) {
    showToast('⚡', 'Sub-Agent Started', `${agentId} → ${subAgentId}`);
  } else {
    showToast('❌', 'Failed to Start', result?.error || 'Unknown error');
    btn.innerHTML = origText;
    btn.disabled = false;
    btn.classList.remove('spawning');
  }
}

// ── Create agent modal ──
addAgentBtn.addEventListener('click', showCreateProjectModal);

function showCreateProjectModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>📁 New Project</h3>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <label>Project ID (no spaces)</label>
          <input type="text" id="newProjId" placeholder="e.g. ireland-trip" />
        </div>
        <div class="form-row">
          <label>Display Name</label>
          <input type="text" id="newProjLabel" placeholder="e.g. ✈️ Ireland Trip" />
        </div>
        <div class="form-row">
          <label>Description</label>
          <input type="text" id="newProjDesc" placeholder="What this project is about" />
        </div>
        <div class="form-row">
          <label>Context / Notes</label>
          <textarea id="newProjContext" rows="3" placeholder="Environment, notes, goals..."></textarea>
        </div>
        <div class="form-row">
          <label>GDrive Topic Folder (optional)</label>
          <input type="text" id="newProjTopic" placeholder="e.g. Ireland Trip (matches GDrive folder name)" />
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-cancel" id="modalCancel">Cancel</button>
        <button class="btn-primary" id="modalCreate">Create Project</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('.modal-close').onclick = () => overlay.remove();
  overlay.querySelector('#modalCancel').onclick = () => overlay.remove();
  overlay.querySelector('#modalCreate').onclick = async () => {
    const id = $('#newProjId').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const label = $('#newProjLabel').value.trim();
    if (!id || !label) { showToast('⚠️', 'Missing Fields', 'ID and Name are required'); return; }
    const result = await apiFetch('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        id,
        label,
        description: $('#newProjDesc').value.trim() || '',
        context: $('#newProjContext').value.trim() || '',
        topic: $('#newProjTopic').value.trim() || undefined,
        template: $('#newProjTemplate').value || undefined,
      }),
    });
    overlay.remove();
    if (result?.ok) {
      showToast('✅', 'Project Created', label);
    } else {
      showToast('❌', 'Create Failed', 'Check server logs');
    }
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function showAddTaskModal(agentId) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal modal-sm">
      <div class="modal-header">
        <h3>＋ Add Task</h3>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <label>Task description</label>
          <input type="text" id="newTaskLabel" placeholder="e.g. Run E2E tests" />
        </div>
        <div class="form-row">
          <label>State</label>
          <select id="newTaskState">
            <option value="pending">Pending</option>
            <option value="running">Running</option>
            <option value="done">Done</option>
          </select>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-cancel" id="modalCancel">Cancel</button>
        <button class="btn-primary" id="modalAdd">Add</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('.modal-close').onclick = () => overlay.remove();
  overlay.querySelector('#modalCancel').onclick = () => overlay.remove();
  overlay.querySelector('#modalAdd').onclick = async () => {
    const label = $('#newTaskLabel').value.trim();
    if (!label) { showToast('⚠️', 'Missing description', 'Enter a task description'); return; }
    const state = $('#newTaskState').value;
    const id = `task-${Date.now()}`;
    await apiFetch(`/api/agents/${agentId}/subtasks`, {
      method: 'POST',
      body: JSON.stringify({ id, label, state }),
    });
    overlay.remove();
    showToast('✅', 'Task Added', `${label} → ${state}`);
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

async function deleteAgent(agentId) {
  if (!confirm(`Delete agent "${agentId}"? This cannot be undone.`)) return;
  const result = await apiFetch(`/api/agents/${agentId}`, { method: 'DELETE' });
  if (result?.ok) {
    showToast('🗑️', 'Agent Deleted', agentId);
  }
}

// ── SSE ──
function connectSSE() {
  if (sse) sse.close();
  sse = new EventSource('/api/stream');
  sse.onopen = () => {
    connectionDot.className = 'dot dot-green';
    connectionText.textContent = 'Connected';
  };
  sse.onerror = () => {
    connectionDot.className = 'dot dot-red';
    connectionText.textContent = 'Disconnected';
  };
  sse.addEventListener('snapshot', (e) => {
    try {
      state = JSON.parse(e.data);
      initAgentChats();
      renderSidebar();
      // Reset spawning buttons
      document.querySelectorAll('.subagent-btn.spawning').forEach(btn => {
        btn.innerHTML = btn.dataset.originalHtml || btn.innerHTML;
        btn.disabled = false;
        btn.classList.remove('spawning');
      });
    } catch (_) {}
  });
  sse.addEventListener('update', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.agent && data.subtask) {
        const agent = state.agents[data.agent];
        if (agent) {
          const existing = agent.subtasks.find(s => s.id === data.subtask.id);
          if (existing) {
            Object.assign(existing, data.subtask);
          } else {
            agent.subtasks.unshift(data.subtask);
          }
          // Recalc status
          const errors = agent.subtasks.filter(t => t.state === 'error').length;
          const running = agent.subtasks.filter(t => t.state === 'running').length;
          if (errors > 0) { agent.status = 'error'; agent.statusLabel = 'Error'; }
          else if (running > 0) { agent.status = 'active'; agent.statusLabel = 'Active'; }
          else { agent.status = 'healthy'; agent.statusLabel = 'Ready'; }
          renderSidebar();
        }
      }
    } catch (_) {}
  });
  sse.addEventListener('agent:created', (e) => {
    try {
      const agent = JSON.parse(e.data);
      state.agents[agent.id] = agent;
      if (!agentChats[agent.id]) agentChats[agent.id] = [];
      renderSidebar();
    } catch (_) {}
  });
  sse.addEventListener('agent:deleted', (e) => {
    try {
      delete state.agents[JSON.parse(e.data).id];
      renderSidebar();
    } catch (_) {}
  });
  sse.addEventListener('job:done', (e) => {
    try {
      const job = JSON.parse(e.data);
      showToast(
        job.status === 'done' ? '✅' : '❌',
        `Sub-Agent ${job.status === 'done' ? 'Complete' : 'Failed'}`,
        job.message || '',
        8000
      );
      if (notifEnabled) {
        sendDesktopNotif(
          (job.status === 'done' ? '✅ ' : '❌ ') + (job.label || 'Sub-Agent'),
          job.message || 'No output'
        );
      }
    } catch (_) {}
  });

  sse.addEventListener('cmd:start', (e) => {
    try {
      const cmd = JSON.parse(e.data);
      shellCommands.unshift(cmd);
      runningShellCmdId = cmd.id;
      addShellCommandBlock(cmd);
      showToast('⌨️', 'Shell', '$ ' + cmd.command, 2000);
    } catch (_) {}
  });

  sse.addEventListener('cmd:output', (e) => {
    try {
      const { id, line, type } = JSON.parse(e.data);
      appendShellLine(id, line, type);
    } catch (_) {}
  });

  sse.addEventListener('cmd:done', (e) => {
    try {
      const { id, status, exitCode, duration } = JSON.parse(e.data);
      finishShellCommand(id, status, exitCode, duration);
      const entry = shellCommands.find(c => c.id === id);
      if (entry) {
        entry.status = status;
        entry.exitCode = exitCode;
        entry.duration = duration;
      }
      if (notifEnabled && status === 'done') {
        sendDesktopNotif('⌨️ Shell', 'Command finished (exit ' + exitCode + ')' + (duration ? ' in ' + (duration / 1000).toFixed(1) + 's' : ''));
      }
    } catch (_) {}
  });

  sse.addEventListener('chat:response', (e) => {
    try {
      const { agentId, message, response } = JSON.parse(e.data);
      // Remove typing indicator, add assistant response
      const chat = agentChats[agentId];
      if (chat) {
        const typingIdx = chat.findIndex(m => m.role === 'typing');
        if (typingIdx >= 0) chat.splice(typingIdx, 1);
        chat.push({ role: 'assistant', content: response, timestamp: Date.now() });
        // Only re-render if this agent's pane is visible
        if (currentTab === agentId) {
          renderChat(agentId);
        }
      }
      showToast('💬', agentId, response.slice(0, 80) + (response.length > 80 ? '...' : ''), 4000);
      if (notifEnabled && currentTab !== agentId) {
        sendDesktopNotif('💬 ' + agentId, response.slice(0, 120) + (response.length > 120 ? '...' : ''));
      }
    } catch (_) {}
  });
}

// ── PWA Install Prompt ──
var installPromptEvent = null;
window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault();
  installPromptEvent = e;
  var btn = document.getElementById('pwaInstallBtn');
  if (btn) btn.style.display = 'flex';
});

// ── Service Worker (PWA) ──
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js').then(function(reg) {
      console.log('SW registered:', reg.scope);
    }, function(err) {
      console.log('SW failed:', err);
    });
  });
}

(async function init() {
  loadTheme();
  notifEnabled = await enableNotifications();
  await loadInitialState();
  connectSSE();

  // Manual update events

  // Settings modal
  document.getElementById('settingsBtn').addEventListener('click', function() {
    document.getElementById('settingsModal').classList.add('open');
  });
  document.getElementById('settingsClose').addEventListener('click', function() {
    document.getElementById('settingsModal').classList.remove('open');
  });
  document.getElementById('settingsModal').addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('open');
  });

  // Theme picker
  document.querySelectorAll('.theme-card').forEach(function(btn) {
    btn.addEventListener('click', function() {
      saveTheme(this.dataset.theme);
    });
  });

  // PWA Install
  document.getElementById('pwaInstallBtn').addEventListener('click', function() {
    if (!installPromptEvent) {
      showToast('⚠️', 'Install', 'Already installed or not available.');
      return;
    }
    installPromptEvent.prompt();
    installPromptEvent.userChoice.then(function(result) {
      if (result.outcome === 'accepted') {
        document.getElementById('pwaInstallSection').style.display = 'none';
        showToast('✅', 'Installed!', 'Concierge is now on your home screen.');
      }
      installPromptEvent = null;
    });
  });

  // Check if already installed
  if (window.matchMedia('(display-mode: standalone)').matches) {
    var sec = document.getElementById('pwaInstallSection');
    if (sec) sec.style.display = 'none';
  }

  // Notif test
  notifBtn.addEventListener('click', function() {
    if (notifEnabled) {
      sendDesktopNotif('🔔 Test', 'Notifications are working!');
      showToast('🔔', 'Test', 'Desktop notification sent!');
    } else {
      showToast('⚠️', 'Notifications', 'Enable in browser permissions.');
    }
  });

  // Load shell history
  const cmdHistory = await apiFetch('/api/commands');
  if (cmdHistory) {
    shellCommands = cmdHistory;
    for (const cmd of shellCommands) {
      if (cmd.status === 'running') {
        runningShellCmdId = cmd.id;
        addShellCommandBlock(cmd);
        for (const line of cmd.output) {
          appendShellLine(cmd.id, line.text, line.type);
        }
      }
    }
  }

  showToast('🔧', 'Concierge v2 Loaded', Object.keys(state.agents).length + ' agents · Sidebar + Shell');
  if (notifEnabled) sendDesktopNotif('🔧 Concierge', 'v2 with PWA, global context & project workspaces');
})();
