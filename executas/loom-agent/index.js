'use strict';

const { io } = require('socket.io-client');
const readline = require('readline');

// ─── JSON-RPC over stdio ───────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const pendingHostCalls = new Map(); // id → { resolve, reject }
let hostCallId = 1;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// Call Anna host (reverse call) — returns a Promise
function callHost(method, params) {
  return new Promise((resolve, reject) => {
    const id = `host-${hostCallId++}`;
    pendingHostCalls.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => {
      if (pendingHostCalls.has(id)) {
        pendingHostCalls.delete(id);
        reject(new Error(`Host call timed out: ${method}`));
      }
    }, 15000);
  });
}

// ─── FlowDev bridge ────────────────────────────────────────────────────────
let fdSocket = null;
let fdToken = null;
const fdPending = new Map();

function connectFlowDev(token) {
  if (fdSocket && fdSocket.connected && fdToken === token) return;
  fdToken = token;
  if (fdSocket) fdSocket.disconnect();

  fdSocket = io('https://flowdev.onrender.com', {
    query: { userId: token },
    reconnection: true,
    reconnectionDelay: 2000,
    timeout: 20000,
  });

  fdSocket.on('connect', () => {
    process.stderr.write('[loom] FlowDev connected\n');
  });

  fdSocket.on('disconnect', () => {
    process.stderr.write('[loom] FlowDev disconnected\n');
  });

  fdSocket.on('tool_result', ({ requestId, success, data, error }) => {
    const pending = fdPending.get(requestId);
    if (!pending) return;
    fdPending.delete(requestId);
    if (success) pending.resolve(data);
    else pending.reject(new Error(error));
  });
}

function callFlowDev(tool, params) {
  return new Promise((resolve, reject) => {
    if (!fdSocket || !fdSocket.connected) {
      reject(new Error('FlowDev extension is not connected. Install the FlowDev extension in VS Code, paste your token, and make sure it shows Connected.'));
      return;
    }
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeout = setTimeout(() => {
      fdPending.delete(requestId);
      reject(new Error('FlowDev timed out. Is VS Code still open?'));
    }, 30000);
    fdPending.set(requestId, {
      resolve: (v) => { clearTimeout(timeout); resolve(v); },
      reject: (e) => { clearTimeout(timeout); reject(e); }
    });
    fdSocket.emit('execute_tool', { requestId, tool, params });
  });
}

// ─── Anna storage helpers ──────────────────────────────────────────────────
async function storageGet(key) {
  try {
    const res = await callHost('storage/get', { key });
    return res && res.value !== undefined ? res.value : null;
  } catch { return null; }
}

async function storageSet(key, value) {
  try {
    await callHost('storage/set', { key, value });
  } catch (e) {
    process.stderr.write(`[loom] storage/set failed: ${e.message}\n`);
  }
}

// ─── Anna credentials helper ───────────────────────────────────────────────
async function getCredential(id) {
  try {
    const res = await callHost('credentials/get', { id });
    return res && res.value ? res.value : null;
  } catch { return null; }
}

// ─── Anna sampling helper ──────────────────────────────────────────────────
async function askLLM(systemPrompt, userMessage) {
  const res = await callHost('sampling/createMessage', {
    messages: [{ role: 'user', content: userMessage }],
    system: systemPrompt,
    maxTokens: 1500,
  });
  if (res && res.content) {
    const block = Array.isArray(res.content)
      ? res.content.find(b => b.type === 'text')
      : null;
    return block ? block.text : (typeof res.content === 'string' ? res.content : JSON.stringify(res.content));
  }
  return '';
}

// ─── Tool implementations ──────────────────────────────────────────────────

// check_connection — verify FlowDev bridge is live
async function checkConnection(params) {
  // If the UI passed a token directly, save it to the credential vault first
  let token = params && params.token ? params.token.trim() : null;

  if (token) {
    // Save to Anna credential vault so future calls don't need the UI input
    try {
      await callHost('credentials/set', { id: 'flowdev_token', value: token });
    } catch (e) {
      process.stderr.write(`[loom] credentials/set failed: ${e.message}\n`);
    }
    // Also save to Anna storage as fallback
    await storageSet('loom:token', token);
  } else {
    // Try credential vault, then storage fallback
    token = await getCredential('flowdev_token');
    if (!token) token = await storageGet('loom:token');
  }

  if (!token) {
    return {
      connected: false,
      message: 'No FlowDev token found. Go to flowdev.onrender.com/request to get your free token, then paste it in the field above.'
    };
  }

  connectFlowDev(token);
  await new Promise(r => setTimeout(r, 2500)); // wait for socket handshake
  const connected = fdSocket && fdSocket.connected;
  return {
    connected,
    message: connected
      ? 'VS Code workspace connected. Ready to start a session.'
      : 'Token saved but FlowDev extension is not connected. Open VS Code, install the FlowDev MCP extension, paste your token there, and click Connect.'
  };
}

// get_memory — retrieve stored project memory
async function getMemory(params) {
  const raw = await storageGet('loom:memory');
  if (!raw) {
    return {
      exists: false,
      memory: null,
      message: 'No project memory yet. Start a session to build it.'
    };
  }
  let memory;
  try { memory = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { memory = { raw }; }
  return { exists: true, memory };
}

// start_session — scan workspace + load memory + return context summary
async function startSession(params) {
  // 1. Get FlowDev token (vault first, storage fallback)
  let token = await getCredential('flowdev_token');
  if (!token) token = await storageGet('loom:token');
  if (!token) {
    return {
      success: false,
      error: 'No FlowDev token. Click Check Connection on the setup screen and paste your token.'
    };
  }

  // 2. Connect to FlowDev
  connectFlowDev(token);
  await new Promise(r => setTimeout(r, 2500));
  if (!fdSocket || !fdSocket.connected) {
    return {
      success: false,
      error: 'FlowDev extension not connected. Open VS Code, install FlowDev extension, paste your token and make sure it shows Connected ✅.'
    };
  }

  // 3. Scan workspace
  let structure = '';
  let gitStatus = '';
  try {
    const structResult = await callFlowDev('get_project_structure', {});
    structure = structResult.output || '';
  } catch (e) {
    structure = `Could not read project structure: ${e.message}`;
  }
  try {
    const gitResult = await callFlowDev('git_status', {});
    gitStatus = gitResult.stdout || '';
  } catch {
    gitStatus = 'No git repository or git not available.';
  }

  // 4. Load existing memory
  const raw = await storageGet('loom:memory');
  let existingMemory = null;
  if (raw) {
    try { existingMemory = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { existingMemory = null; }
  }

  // 5. Use LLM to generate context summary
  const systemPrompt = `You are Loom's memory engine. Your job is to analyze a developer's workspace and produce a concise, useful project context summary.

If existing memory is provided, incorporate it and update it with any new observations from the current workspace scan.

Output a JSON object with these fields:
{
  "project_name": "name of the project",
  "stack": ["list", "of", "technologies", "detected"],
  "purpose": "one sentence describing what this project does",
  "current_focus": "what the developer appears to be working on right now based on git status",
  "key_decisions": ["important architectural or technical decisions you can infer"],
  "tried_and_abandoned": ["things that appear to have been tried and removed"],
  "where_left_off": "a sentence about the current state and what likely needs to happen next",
  "last_updated": "${new Date().toISOString()}"
}

Only output the JSON object. No explanation, no markdown fences.`;

  const userMessage = `Project structure:\n${structure}\n\nGit status:\n${gitStatus}\n\nExisting memory:\n${existingMemory ? JSON.stringify(existingMemory, null, 2) : 'None — this is the first session.'}`;

  let summary = null;
  try {
    const rawResp = await askLLM(systemPrompt, userMessage);
    const cleaned = rawResp.replace(/```json|```/g, '').trim();
    summary = JSON.parse(cleaned);
  } catch (e) {
    process.stderr.write(`[loom] LLM summary parse failed: ${e.message}\n`);
    summary = {
      project_name: 'Unknown',
      stack: [],
      purpose: 'Could not analyze project automatically.',
      current_focus: gitStatus.slice(0, 200),
      key_decisions: [],
      tried_and_abandoned: [],
      where_left_off: 'Review your project structure manually.',
      last_updated: new Date().toISOString()
    };
  }

  // 6. Save updated memory
  await storageSet('loom:memory', JSON.stringify(summary));

  return {
    success: true,
    summary,
    isFirstSession: !existingMemory,
    message: existingMemory
      ? 'Welcome back. Loom remembers your project.'
      : 'First session recorded. Loom will remember this project from now on.'
  };
}

// chat — context-aware AI chat with workspace access
async function chat(params) {
  const { message, conversationHistory = [] } = params;

  let token = await getCredential('flowdev_token');
  if (!token) token = await storageGet('loom:token');
  if (token) {
    connectFlowDev(token);
    await new Promise(r => setTimeout(r, 1000));
  }

  // Load memory
  const raw = await storageGet('loom:memory');
  let memory = null;
  if (raw) {
    try { memory = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { memory = null; }
  }

  // Build system prompt with full project context
  const memoryContext = memory
    ? `PROJECT MEMORY (what Loom knows about this project):
Project: ${memory.project_name}
Stack: ${(memory.stack || []).join(', ')}
Purpose: ${memory.purpose}
Current focus: ${memory.current_focus}
Key decisions: ${(memory.key_decisions || []).join('; ')}
Where left off: ${memory.where_left_off}
Last updated: ${memory.last_updated}`
    : 'No project memory yet. Ask the user to start a session first.';

  const workspaceConnected = fdSocket && fdSocket.connected;

  const systemPrompt = `You are Loom, an AI coding assistant that remembers developer projects across sessions.

${memoryContext}

Workspace connection: ${workspaceConnected ? 'Connected — you can read files, run commands, check git status if needed.' : 'Not connected — answer from memory only.'}

You have access to these workspace tools (only use when clearly needed):
- read_file(path) — read a specific file
- get_project_structure() — see all files
- git_status() — check what changed
- run_command(command) — run terminal commands
- write_file(path, content) — write or create files

When you need to use a workspace tool, include a special line in your response:
TOOL_CALL: tool_name {"param": "value"}

Only one tool call per response. After the tool result, continue your answer.

Always be helpful, specific, and context-aware. You know this project — act like it.`;

  // Build message history for LLM
  const historyText = conversationHistory
    .slice(-6) // last 3 exchanges
    .map(m => `${m.role === 'user' ? 'Developer' : 'Loom'}: ${m.content}`)
    .join('\n');

  const fullMessage = historyText ? `${historyText}\nDeveloper: ${message}` : message;

  try {
    let response = await askLLM(systemPrompt, fullMessage);

    // Check for tool call
    const toolMatch = response.match(/TOOL_CALL:\s*(\w+)\s*(\{[^}]*\})?/);
    let toolResult = null;

    if (toolMatch && workspaceConnected) {
      const toolName = toolMatch[1];
      let toolParams = {};
      try { toolParams = toolMatch[2] ? JSON.parse(toolMatch[2]) : {}; } catch {}

      try {
        toolResult = await callFlowDev(toolName, toolParams);
        // Remove the TOOL_CALL line from response
        response = response.replace(/TOOL_CALL:.*$/m, '').trim();
        // Append tool result context
        const toolContext = typeof toolResult === 'object'
          ? (toolResult.content || toolResult.output || toolResult.stdout || JSON.stringify(toolResult))
          : String(toolResult);
        // Get final response with tool result
        response = await askLLM(systemPrompt,
          `${fullMessage}\n\n[Tool ${toolName} result]: ${toolContext.slice(0, 2000)}\n\nNow give your final answer using this information.`
        );
      } catch (e) {
        response = response.replace(/TOOL_CALL:.*$/m, '').trim();
        response += `\n\n*(Could not execute ${toolName}: ${e.message})*`;
      }
    }

    // Update memory after meaningful exchanges
    if (conversationHistory.length > 0 && conversationHistory.length % 4 === 0 && memory) {
      const updatePrompt = `Based on this recent conversation, update the project memory JSON. Keep all existing fields but refine them if the conversation reveals new information. Only output the updated JSON object, no explanation.`;
      const recentChat = conversationHistory.slice(-4).map(m => `${m.role}: ${m.content}`).join('\n');
      try {
        const updated = await askLLM(updatePrompt, `Current memory: ${JSON.stringify(memory)}\n\nRecent conversation:\n${recentChat}`);
        const cleaned = updated.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        parsed.last_updated = new Date().toISOString();
        await storageSet('loom:memory', JSON.stringify(parsed));
      } catch { /* memory update is best-effort */ }
    }

    return { success: true, response, toolResult };
  } catch (e) {
    return { success: false, error: e.message, response: `I encountered an error: ${e.message}` };
  }
}

// update_memory — manually update or reset memory
async function updateMemory(params) {
  const { updates } = params;
  const raw = await storageGet('loom:memory');
  let memory = {};
  if (raw) {
    try { memory = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch {}
  }
  const updated = { ...memory, ...updates, last_updated: new Date().toISOString() };
  await storageSet('loom:memory', JSON.stringify(updated));
  return { success: true, memory: updated };
}

// end_session — save a session note to memory
async function endSession(params) {
  const { sessionNote } = params;
  const raw = await storageGet('loom:memory');
  let memory = {};
  if (raw) {
    try { memory = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch {}
  }
  if (sessionNote) {
    memory.where_left_off = sessionNote;
    memory.last_updated = new Date().toISOString();
    await storageSet('loom:memory', JSON.stringify(memory));
  }
  if (fdSocket) fdSocket.disconnect();
  return { success: true, message: 'Session ended. Memory saved.' };
}

// ─── RPC dispatch ──────────────────────────────────────────────────────────
async function dispatch(method, params, id) {
  switch (method) {
    case 'describe':
      respond(id, {
        name: 'loom-agent',
        display_name: 'Loom Agent',
        version: '1.0.2',
        description: 'AI-powered project memory engine. Uses Anna LLM to analyze VS Code workspaces and power context-aware coding conversations.',
        tools: [
          {
            name: 'check_connection',
            description: 'Check if the FlowDev VS Code extension is connected and the token is valid',
            parameters: [],
            timeout: 30
          },
          {
            name: 'get_memory',
            description: 'Get the stored project memory for the current workspace',
            parameters: [],
            timeout: 30
          },
          {
            name: 'start_session',
            description: 'Start a Loom session — scans the workspace and loads project memory using Anna AI analysis',
            parameters: [],
            timeout: 90
          },
          {
            name: 'chat',
            description: 'Send a message to Loom with full project context',
            parameters: [
              { name: 'message', type: 'string', description: 'The message to send', required: true },
              { name: 'conversationHistory', type: 'array', items_type: 'object', description: 'Previous messages for context', required: false, default: [] }
            ],
            timeout: 60
          },
          {
            name: 'update_memory',
            description: 'Manually update fields in project memory',
            parameters: [
              { name: 'updates', type: 'object', description: 'Key-value pairs to update in memory', required: true }
            ],
            timeout: 30
          },
          {
            name: 'end_session',
            description: 'End the session and save a note about where you left off',
            parameters: [
              { name: 'sessionNote', type: 'string', description: 'Note about what was done', required: false }
            ],
            timeout: 30
          }
        ],
        credentials: [
          {
            id: 'flowdev_token',
            name: 'FlowDev Token',
            description: 'Your FlowDev token from flowdev.onrender.com/request',
            required: true,
            sensitive: true
          }
        ],
        host_capabilities: ['llm.sample', 'aps.kv'],
        runtime: { type: 'binary' }
      });
      return;

    case 'invoke': {
      const toolName = params.name;
      const toolArgs = params.arguments || params.args || params.params || {};
      try {
        const handler = {
          check_connection: checkConnection,
          get_memory: getMemory,
          start_session: startSession,
          chat,
          update_memory: updateMemory,
          end_session: endSession
        }[toolName];
        if (!handler) {
          respond(id, { success: false, error: `Unknown method: ${toolName}` });
          return;
        }
        const result = await handler(toolArgs);
        respond(id, { success: true, data: result });
      } catch (e) {
        process.stderr.write(`[loom] Tool error (${toolName}): ${e.message}\n`);
        respond(id, { success: false, error: e.message });
      }
      return;
    }

    default:
      respondError(id, -32601, `Method not found: ${method}`);
  }
}

// ─── Main stdin loop ───────────────────────────────────────────────────────
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch (e) { process.stderr.write(`[loom] Invalid JSON: ${line}\n`); return; }

  // Check if this is a response to a host call we made
  if (msg.id && pendingHostCalls.has(msg.id)) {
    const pending = pendingHostCalls.get(msg.id);
    pendingHostCalls.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else pending.resolve(msg.result);
    return;
  }

  // Otherwise it is a call from Anna host to us
  if (msg.method) {
    await dispatch(msg.method, msg.params || {}, msg.id);
  }
});

process.stderr.write('[loom] Loom agent started\n');
