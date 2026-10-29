// ═══════════════════════════════════════════
//  LOOM — App logic (external module, loaded as type="module")
//  Kept external so Anna's CSP (script-src 'self') allows it.
// ═══════════════════════════════════════════

// ═══════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════
let anna = null;
let currentMemory = null;
let conversationHistory = [];
let isWaiting = false;

// ═══════════════════════════════════════════
//  ANNA SDK — lazy load + connect
// ═══════════════════════════════════════════
async function ensureAnna() {
  if (!anna) {
    let AnnaAppRuntime;
    try {
      const mod = await import('/static/anna-apps/_sdk/latest/index.js');
      AnnaAppRuntime = mod.AnnaAppRuntime;
    } catch (e) {
      throw new Error('Could not load Anna SDK: ' + e.message + '. Make sure Loom is open inside Anna AI.');
    }
    if (!AnnaAppRuntime) throw new Error('Anna SDK loaded but AnnaAppRuntime not found.');
    anna = await AnnaAppRuntime.connect();
  }
  return anna;
}

async function invokeTool(name, params = {}) {
  const sdk = await ensureAnna();
  const toolId = (window.__ANNA_TOOL_IDS__ || {})['loom-agent'];
  if (!toolId) throw new Error('anna-tool-ids.js did not load — tool ID missing. Try refreshing the app.');
  const result = await sdk.tools.invoke({ tool_id: toolId, method: name, args: params });
  if (result && result.success === false) throw new Error(result.error || 'Executa returned failure');
  return result && result.data !== undefined ? result.data : result;
}

// ═══════════════════════════════════════════
//  VIEW MANAGEMENT
// ═══════════════════════════════════════════
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`${name}-view`).classList.add('active');
}

function setStatus(state, text) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-text');
  dot.className = 'dot' + (state === 'connected' ? ' green' : state === 'loading' ? ' yellow' : '');
  label.textContent = text;
}

// ═══════════════════════════════════════════
//  CHECK CONNECTION
// ═══════════════════════════════════════════
async function checkConnection() {
  const btn = document.getElementById('check-btn');
  const btnText = document.getElementById('check-btn-text');
  const errEl = document.getElementById('connect-error');
  const tokenInput = document.getElementById('token-input');
  const token = tokenInput ? tokenInput.value.trim() : '';

  if (tokenInput && !token) {
    errEl.textContent = 'Please paste your FlowDev token above before checking the connection.';
    errEl.style.display = 'block';
    tokenInput.style.borderColor = 'var(--red)';
    return;
  }
  if (tokenInput) tokenInput.style.borderColor = 'var(--border)';

  btn.disabled = true;
  btnText.innerHTML = '<span class="spinner"></span> Checking…';
  errEl.style.display = 'none';
  setStatus('loading', 'Connecting…');

  try {
    const result = await invokeTool('check_connection', token ? { token } : {});
    if (result.connected) {
      setStatus('connected', 'VS Code Connected');
      await loadMemoryView();
    } else {
      setStatus('', 'Not connected');
      errEl.textContent = result.message;
      errEl.style.display = 'block';
    }
  } catch (e) {
    setStatus('', 'Error');
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btnText.textContent = 'Check Connection';
  }
}

// ═══════════════════════════════════════════
//  MEMORY VIEW
// ═══════════════════════════════════════════
async function loadMemoryView() {
  showView('memory');
  const container = document.getElementById('memory-content');
  container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">Loading memory…</div>';

  try {
    const result = await invokeTool('get_memory');
    if (!result.exists || !result.memory) {
      container.innerHTML = `
        <div class="empty-memory">
          <div class="empty-icon">🌱</div>
          <div class="empty-title">No project memory yet</div>
          <p class="empty-sub">Hit <strong>Start Session</strong> and Loom will scan your workspace and build a permanent memory of your project.</p>
        </div>`;
    } else {
      currentMemory = result.memory;
      container.innerHTML = renderMemoryCards(currentMemory);
    }
  } catch (e) {
    container.innerHTML = `<div class="alert alert-error">Failed to load memory: ${escHtml(e.message)}</div>`;
  }
}

function renderMemoryCards(m) {
  const sections = [];

  sections.push(`
    <div class="memory-project-header">
      <div class="memory-project-name">${escHtml(m.project_name || 'Your Project')}</div>
      <div class="memory-project-purpose">${escHtml(m.purpose || '')}</div>
    </div>`);

  if (m.stack && m.stack.length) {
    sections.push(`
      <div class="memory-card">
        <h3>Stack</h3>
        <div class="tag-list">${m.stack.map(t => `<span class="tag">${escHtml(t)}</span>`).join('')}</div>
      </div>`);
  }

  if (m.current_focus) {
    sections.push(`
      <div class="memory-card">
        <h3>Current Focus</h3>
        <div class="memory-value">${escHtml(m.current_focus)}</div>
      </div>`);
  }

  if (m.where_left_off) {
    sections.push(`
      <div class="memory-card">
        <h3>Where You Left Off</h3>
        <div class="memory-value">${escHtml(m.where_left_off)}</div>
      </div>`);
  }

  if (m.key_decisions && m.key_decisions.length) {
    sections.push(`
      <div class="memory-card">
        <h3>Key Decisions</h3>
        <ul class="bullet-list">${m.key_decisions.map(d => `<li>${escHtml(d)}</li>`).join('')}</ul>
      </div>`);
  }

  if (m.tried_and_abandoned && m.tried_and_abandoned.length) {
    sections.push(`
      <div class="memory-card">
        <h3>Tried &amp; Abandoned</h3>
        <ul class="bullet-list">${m.tried_and_abandoned.map(d => `<li>${escHtml(d)}</li>`).join('')}</ul>
      </div>`);
  }

  if (m.last_updated) {
    sections.push(`<div class="last-updated">Last updated: ${new Date(m.last_updated).toLocaleString()}</div>`);
  }

  return sections.join('');
}

// ═══════════════════════════════════════════
//  START SESSION
// ═══════════════════════════════════════════
async function startSession() {
  const btn = document.getElementById('start-btn');
  const btnText = document.getElementById('start-btn-text');
  const errEl = document.getElementById('start-error');

  btn.disabled = true;
  btnText.innerHTML = '<span class="spinner"></span> Scanning workspace…';
  errEl.style.display = 'none';

  try {
    const result = await invokeTool('start_session');
    if (!result.success) {
      errEl.textContent = result.error;
      errEl.style.display = 'inline';
      return;
    }
    currentMemory = result.summary;
    conversationHistory = [];
    showChatView(result);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'inline';
  } finally {
    btn.disabled = false;
    btnText.textContent = '▶ Start Session';
  }
}

// ═══════════════════════════════════════════
//  CHAT VIEW
// ═══════════════════════════════════════════
function showChatView(sessionResult) {
  showView('chat');

  const m = sessionResult.summary;

  // Populate memory sidebar
  const panel = document.getElementById('panel-memory-content');
  let panelHTML = '';

  if (m.project_name) {
    panelHTML += `<div class="mem-field"><div class="mem-label">Project</div><div class="mem-val" style="font-weight:600">${escHtml(m.project_name)}</div></div>`;
  }
  if (m.stack && m.stack.length) {
    panelHTML += `<div class="mem-field"><div class="mem-label">Stack</div><div class="mem-tags">${m.stack.map(t => `<span class="mem-tag">${escHtml(t)}</span>`).join('')}</div></div>`;
  }
  if (m.current_focus) {
    panelHTML += `<div class="mem-field"><div class="mem-label">Current Focus</div><div class="mem-val">${escHtml(m.current_focus)}</div></div>`;
  }
  if (m.where_left_off) {
    panelHTML += `<div class="mem-field"><div class="mem-label">Left Off</div><div class="mem-val">${escHtml(m.where_left_off)}</div></div>`;
  }
  if (m.key_decisions && m.key_decisions.length) {
    panelHTML += `<div class="mem-field"><div class="mem-label">Key Decisions</div><div class="mem-val">${m.key_decisions.map(d => `• ${escHtml(d)}`).join('<br>')}</div></div>`;
  }

  panel.innerHTML = panelHTML;

  // Set welcome message
  const welcomeMsg = document.getElementById('welcome-msg');
  if (welcomeMsg) {
    if (sessionResult.isFirstSession) {
      welcomeMsg.textContent = `First session for ${m.project_name || 'this project'}. I’ve scanned your workspace and built an initial memory. What would you like to work on?`;
    } else {
      welcomeMsg.textContent = `Welcome back to ${m.project_name || 'your project'}. I remember where you left off: ${m.where_left_off || 'your last session'}. What would you like to work on?`;
    }
  }

  document.getElementById('chat-input').focus();
}

async function goToMemory() {
  try { await invokeTool('end_session', {}); } catch {}
  await loadMemoryView();
}

// ═══════════════════════════════════════════
//  CHAT
// ═══════════════════════════════════════════
function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

async function sendMessage() {
  if (isWaiting) return;
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  input.style.height = 'auto';
  isWaiting = true;

  document.getElementById('send-btn').disabled = true;

  appendMessage('user', message);
  const loadingBubble = appendLoadingMessage();

  try {
    const result = await invokeTool('chat', { message, conversationHistory });
    const reply = result.response || result.error || 'No response received.';
    loadingBubble.className = 'msg-bubble';
    loadingBubble.textContent = reply;

    conversationHistory.push({ role: 'user', content: message });
    conversationHistory.push({ role: 'assistant', content: reply });
    if (conversationHistory.length > 20) {
      conversationHistory = conversationHistory.slice(-20);
    }
  } catch (e) {
    loadingBubble.className = 'msg-bubble';
    loadingBubble.textContent = `Error: ${e.message}`;
  } finally {
    isWaiting = false;
    document.getElementById('send-btn').disabled = false;
    input.focus();
  }
}

function appendMessage(role, text) {
  const messages = document.getElementById('messages');
  const wrapper = document.createElement('div');
  wrapper.className = `message ${role}`;

  const avatar = document.createElement('div');
  avatar.className = `msg-avatar ${role}`;
  avatar.textContent = role === 'user' ? '👤' : '🧵';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;

  wrapper.appendChild(avatar);
  wrapper.appendChild(bubble);
  messages.appendChild(wrapper);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

function appendLoadingMessage() {
  const messages = document.getElementById('messages');
  const wrapper = document.createElement('div');
  wrapper.className = 'message assistant';

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar assistant';
  avatar.textContent = '🧵';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble loading';
  bubble.innerHTML = '<span class="typing-dots"><span>●</span><span>●</span><span>●</span></span>';

  wrapper.appendChild(avatar);
  wrapper.appendChild(bubble);
  messages.appendChild(wrapper);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

// ═══════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Auto-resize textarea
document.getElementById('chat-input').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

// ═══════════════════════════════════════════
//  EXPOSE TO window (required for inline onclick= attributes)
// ═══════════════════════════════════════════
window.checkConnection = checkConnection;
window.startSession   = startSession;
window.sendMessage    = sendMessage;
window.handleKey      = handleKey;
window.goToMemory     = goToMemory;

// ═══════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════
window.addEventListener('load', () => {
  setStatus('loading', 'Initializing…');

  // Give Anna 800ms to inject its SDK, then auto-check connection
  setTimeout(async () => {
    try {
      const result = await invokeTool('check_connection');
      if (result.connected) {
        setStatus('connected', 'VS Code Connected');
        await loadMemoryView();
      } else {
        setStatus('', 'Setup required');
        showView('connect');
      }
    } catch {
      // No Anna SDK (direct browser preview) — show connect view
      setStatus('', 'Outside Anna');
      showView('connect');
      const errEl = document.getElementById('connect-error');
      errEl.textContent = 'Running outside Anna AI. Open this app inside the Anna platform to connect your workspace.';
      errEl.style.display = 'block';
    }
  }, 800);
});
