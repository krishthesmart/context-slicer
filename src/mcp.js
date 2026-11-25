#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { ContextSlicer } = require('./core');

const DEFAULT_DB_PATH = process.env.CONTEXT_SLICER_DB
  || path.join(process.cwd(), '.context-slicer-slices.json');

const INITIALIZE_INSTRUCTIONS = [
  "Prioritize the user's active task as your very first action.",
  'Call slice_and_retrieve immediately and pass both previous_context (the prior conversation context) and current_message (the active user request).',
  'ContextSlicer will non-destructively archive previous_context, update working_summary, and return only the context needed for current_message so you can execute immediately.'
].join(' ');

class SliceStore {
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;
  }

  _readAll() {
    try {
      if (!fs.existsSync(this.dbPath)) {
        return { slices: {} };
      }
      const raw = fs.readFileSync(this.dbPath, 'utf8');
      const parsed = JSON.parse(raw || '{}');
      return { slices: parsed.slices && typeof parsed.slices === 'object' ? parsed.slices : {} };
    } catch (_) {
      return { slices: {} };
    }
  }

  _writeAll(data) {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.dbPath, JSON.stringify(data, null, 2), 'utf8');
  }

  saveSlice(params) {
    if (!params || typeof params.id !== 'string' || !params.id.trim()) {
      throw new Error('Parameter "id" (non-empty string) is required');
    }
    const id = params.id.trim();
    const db = this._readAll();
    const existing = db.slices[id];

    const slicer = existing && existing.state
      ? ContextSlicer.fromJSON(existing.state)
      : new ContextSlicer();

    if (typeof params.goal === 'string' && params.goal.trim()) {
      slicer.addSpec('goal', params.goal);
    }
    if (Array.isArray(params.decisions)) {
      for (const d of params.decisions) slicer.addSpec('decisions', d);
    }
    if (Array.isArray(params.constraints)) {
      for (const c of params.constraints) slicer.addSpec('constraints', c);
    }
    if (Array.isArray(params.rejected)) {
      for (const r of params.rejected) slicer.addSpec('rejected', r);
    }
    if (typeof params.content === 'string' && params.content.trim()) {
      slicer.addTurn(params.role || 'context', params.content);
    }

    const now = new Date().toISOString();
    const workingMemory = slicer.formatWorkingMemory();
    db.slices[id] = {
      id,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      workingMemory,
      working_summary: workingMemory,
      specCard: slicer.specCard,
      archivedTurns: slicer.archive.length,
      state: slicer.toJSON()
    };

    this._writeAll(db);
    return {
      id,
      updatedAt: now,
      archivedTurns: slicer.archive.length,
      specCard: slicer.specCard,
      workingMemory,
      working_summary: workingMemory
    };
  }

  getSlice(params) {
    if (!params || typeof params.id !== 'string' || !params.id.trim()) {
      throw new Error('Parameter "id" (non-empty string) is required');
    }
    const id = params.id.trim();
    const db = this._readAll();
    const record = db.slices[id];
    if (!record) {
      return null;
    }
    return {
      id: record.id,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      archivedTurns: record.archivedTurns,
      specCard: record.specCard,
      workingMemory: record.workingMemory,
      working_summary: record.working_summary || record.workingMemory
    };
  }

  listSlices(params = {}) {
    const db = this._readAll();
    const limit = Number.isFinite(params.limit) && params.limit > 0 ? params.limit : 50;
    return Object.values(db.slices)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, limit)
      .map((s) => ({
        id: s.id,
        goal: (s.specCard && s.specCard.goal && s.specCard.goal[0]) || '',
        archivedTurns: s.archivedTurns || 0,
        updatedAt: s.updatedAt
      }));
  }

  deleteSlice(params) {
    if (!params || typeof params.id !== 'string' || !params.id.trim()) {
      throw new Error('Parameter "id" (non-empty string) is required');
    }
    const id = params.id.trim();
    const db = this._readAll();
    if (!db.slices[id]) {
      return { deleted: false, id, message: `Slice not found: ${id}` };
    }
    delete db.slices[id];
    this._writeAll(db);
    return { deleted: true, id };
  }

  sliceAndRetrieve(params = {}) {
    const id = (typeof params.id === 'string' && params.id.trim()) ? params.id.trim() : 'default';
    const currentMessage = typeof params.current_message === 'string' ? params.current_message.trim() : '';
    const previousContext = typeof params.previous_context === 'string' ? params.previous_context.trim() : '';

    if (!currentMessage) {
      throw new Error('Parameter "current_message" (non-empty string) is required');
    }

    const db = this._readAll();
    const existing = db.slices[id];
    const hasHistory = Boolean(
      (existing && existing.state && Array.isArray(existing.state.archive) && existing.state.archive.length > 0) ||
      Object.keys(db.slices).length > 0
    );

    if (!previousContext) {
      if (hasHistory) {
        return {
          needsPreviousContext: true,
          message: 'History exists for this session. Please provide "previous_context" (the prior conversation context) alongside "current_message" so ContextSlicer can archive it non-destructively and retrieve only the relevant context.'
        };
      }
      throw new Error('Parameter "previous_context" is required. Please supply the previous conversation context.');
    }

    const slicer = existing && existing.state
      ? ContextSlicer.fromJSON(existing.state)
      : new ContextSlicer();

    // Non-destructively archive previous_context (never deletes existing turns)
    const lines = previousContext
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);

    for (const line of lines) {
      const roleMatch = line.match(/^(user|assistant|system|context)\s*:\s*(.+)$/i);
      if (roleMatch) {
        slicer.addTurn(roleMatch[1].toLowerCase(), roleMatch[2]);
      } else {
        slicer.addTurn('context', line);
      }
    }

    const slicedMessages = slicer.buildMessages(currentMessage, 'auto');
    const savings = slicer.getSavings(slicedMessages, currentMessage);
    const workingSummary = slicer.formatWorkingMemory(currentMessage);

    // Return only the relevant prior turns (exclude duplicated system working_summary and trailing current_message)
    const relevantContext = slicedMessages.filter((msg, idx) => {
      if (idx === 0 && msg.role === 'system') return false;
      if (idx === slicedMessages.length - 1 && msg.role === 'user' && msg.content === currentMessage) {
        return false;
      }
      return true;
    });

    const fullWorkingSummary = slicer.formatWorkingMemory();
    const now = new Date().toISOString();

    db.slices[id] = {
      id,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      workingMemory: fullWorkingSummary,
      working_summary: fullWorkingSummary,
      specCard: slicer.specCard,
      archivedTurns: slicer.archive.length,
      state: slicer.toJSON()
    };
    this._writeAll(db);

    return {
      id,
      mode: slicer.lastMode,
      archivedTurns: slicer.archive.length,
      tokens_saved: {
        before: savings.beforeTokens,
        after: savings.afterTokens,
        saved: savings.savedTokens,
        percent: savings.savedPercent
      },
      working_summary: workingSummary,
      relevant_context: relevantContext,
      instruction: `Execute the user's active task ("${currentMessage}") immediately using only the working_summary and relevant_context.`
    };
  }
}

const TOOLS = [
  {
    name: 'slice_and_retrieve',
    description: 'Non-destructively archive previous_context, update working_summary, and retrieve only the context needed for current_message so the AI can execute immediately with minimal tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        previous_context: {
          type: 'string',
          description: 'Required. Supply the previous conversation context (prior turns, decisions, and constraints) so ContextSlicer can archive it without deleting anything.'
        },
        current_message: {
          type: 'string',
          description: "The user's current message or active task to execute."
        },
        id: {
          type: 'string',
          description: 'Optional slice/session identifier (defaults to "default").'
        }
      },
      required: ['previous_context', 'current_message']
    }
  },
  {
    name: 'save_slice',
    description: 'Save or update a non-destructive ContextSlicer working-memory slice (goal, decisions, constraints, rejected, or tagged turn content) in local JSON storage.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique slice/session identifier' },
        goal: { type: 'string', description: 'Primary goal to record' },
        decisions: { type: 'array', items: { type: 'string' }, description: 'Key decisions made' },
        constraints: { type: 'array', items: { type: 'string' }, description: 'Hard constraints or requirements' },
        rejected: { type: 'array', items: { type: 'string' }, description: 'Rejected ideas or approaches' },
        role: { type: 'string', description: 'Optional turn role (context/user/assistant)' },
        content: { type: 'string', description: 'Optional raw turn content (supports <spec cat="..."> tags)' }
      },
      required: ['id']
    }
  },
  {
    name: 'get_slice',
    description: 'Retrieve a saved ContextSlicer working-memory slice by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique slice/session identifier' }
      },
      required: ['id']
    }
  },
  {
    name: 'list_slices',
    description: 'List all saved ContextSlicer slices from local JSON storage.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of slices to return (default 50)' }
      }
    }
  },
  {
    name: 'delete_slice',
    description: 'Delete a saved ContextSlicer slice by ID from local JSON storage.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique slice/session identifier to delete' }
      },
      required: ['id']
    }
  }
];

function handleJsonRpc(request, store) {
  const { jsonrpc, id, method, params } = request;

  if (jsonrpc !== '2.0' || typeof method !== 'string') {
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code: -32600, message: 'Invalid Request' }
    };
  }

  // Notifications have no id and must not receive a response
  if (id === undefined || id === null) {
    return null;
  }

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'context-slicer-mcp',
          version: '1.0.0'
        },
        instructions: INITIALIZE_INSTRUCTIONS
      }
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS }
    };
  }

  if (method === 'tools/call') {
    const toolName = params && params.name;
    const args = (params && params.arguments) || {};

    try {
      if (toolName === 'slice_and_retrieve') {
        const result = store.sliceAndRetrieve(args);
        if (result.needsPreviousContext) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: result.message }]
            }
          };
        }
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          }
        };
      }

      if (toolName === 'save_slice') {
        const saved = store.saveSlice(args);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(saved, null, 2) }]
          }
        };
      }

      if (toolName === 'get_slice') {
        const slice = store.getSlice(args);
        if (!slice) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: `Slice not found: ${args.id}` }]
            }
          };
        }
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(slice, null, 2) }]
          }
        };
      }

      if (toolName === 'list_slices') {
        const list = store.listSlices(args);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(list, null, 2) }]
          }
        };
      }

      if (toolName === 'delete_slice') {
        const deleted = store.deleteSlice(args);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: !deleted.deleted,
            content: [{ type: 'text', text: JSON.stringify(deleted, null, 2) }]
          }
        };
      }

      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` }
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: err.message }]
        }
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` }
  };
}

function startMcpServer(dbPath = DEFAULT_DB_PATH) {
  const store = new SliceStore(dbPath);
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req;
    try {
      req = JSON.parse(trimmed);
    } catch (_) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' }
        }) + '\n'
      );
      return;
    }

    const res = handleJsonRpc(req, store);
    if (res !== null) {
      process.stdout.write(JSON.stringify(res) + '\n');
    }
  });
}

if (require.main === module) {
  startMcpServer();
}

module.exports = {
  SliceStore,
  TOOLS,
  INITIALIZE_INSTRUCTIONS,
  handleJsonRpc,
  startMcpServer
};
