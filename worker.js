/**
 * ContextSlicer — Single-File Cloudflare Worker Proxy
 * Free-tier compatible (0 dependencies, no KV or Durable Objects required).
 * Non-destructive context filtering for AI chats: never deletes chat messages,
 * only sends the AI what it needs for the current task.
 *
 * Optional Environment Variables (wrangler.toml / Dashboard):
 *   UPSTREAM_URL  - Default: "https://api.openai.com"
 *   SLICER_KEY    - Optional auth key checked against X-Slicer-Key or Bearer token
 *   WINDOW_SIZE   - Recent turns window in chat mode (default: 6)
 *   RECALL_TURNS  - Max keyword-recalled turns in chat mode (default: 4)
 */

const DEFAULT_BUILD_TRIGGERS = [
  'build it',
  'build the app',
  'write the code',
  'start coding'
];

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'had',
  'are', 'was', 'were', 'will', 'would', 'could', 'should', 'can', 'not',
  'but', 'you', 'your', 'they', 'their', 'what', 'when', 'where', 'which',
  'who', 'how', 'why', 'all', 'any', 'use', 'using', 'make', 'like', 'just',
  'into', 'than', 'then', 'them', 'some', 'such', 'only', 'also', 'more',
  'about', 'want', 'need', 'please', 'let', 'lets', 'our', 'out', 'now'
]);

const SPEC_CATEGORIES = {
  goal: 'goal',
  goals: 'goal',
  decision: 'decisions',
  decisions: 'decisions',
  constraint: 'constraints',
  constraints: 'constraints',
  reject: 'rejected',
  rejected: 'rejected'
};

const MAX_SESSIONS = 100;

function estimateTokens(input) {
  if (typeof input === 'string') return input.length === 0 ? 0 : Math.ceil(input.length / 4);
  if (!Array.isArray(input)) return 0;
  let total = 0;
  for (const msg of input) {
    if (!msg) continue;
    const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
    total += Math.ceil(text.length / 4) + 4;
  }
  return total;
}

function extractSpecTags(text) {
  if (typeof text !== 'string' || !text.includes('<spec')) return [];
  const results = [];
  const regex = /<spec\s+cat=["']?([a-zA-Z0-9_-]+)["']?\s*>([\s\S]*?)<\/spec>/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const rawCat = match[1].toLowerCase().trim();
    const category = SPEC_CATEGORIES[rawCat] || rawCat;
    const value = match[2].replace(/\s+/g, ' ').trim();
    if (category && value) results.push({ category, value });
  }
  return results;
}

function extractKeywords(text) {
  if (typeof text !== 'string') return new Set();
  const tokens = text.toLowerCase().match(/[a-z0-9_-]{3,}/g) || [];
  const out = new Set();
  for (const t of tokens) {
    if (!STOP_WORDS.has(t)) out.add(t);
  }
  return out;
}

function filterItemsByQuery(items, queryKeywords) {
  if (!Array.isArray(items) || items.length === 0 || queryKeywords.size === 0) return items || [];
  const matched = items.filter((item) => {
    const ik = extractKeywords(item);
    for (const kw of queryKeywords) if (ik.has(kw)) return true;
    return false;
  });
  return matched.length > 0 ? matched : items;
}

class ContextSlicer {
  constructor(options = {}) {
    this.windowSize = Number.isFinite(options.windowSize) ? options.windowSize : 6;
    this.maxRecallTurns = Number.isFinite(options.maxRecallTurns) ? options.maxRecallTurns : 4;
    this.systemPrompt = typeof options.systemPrompt === 'string' ? options.systemPrompt : '';
    this.archive = [];
    this.specCard = { goal: [], decisions: [], constraints: [], rejected: [] };
    this.lastMode = 'chat';
  }

  addTurn(role, content) {
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
    this.archive.push({ id: this.archive.length + 1, role: role || 'user', content: text, timestamp: Date.now() });
    for (const { category, value } of extractSpecTags(text)) {
      if (!Array.isArray(this.specCard[category])) this.specCard[category] = [];
      if (!this.specCard[category].includes(value)) this.specCard[category].push(value);
    }
  }

  syncMessages(messages) {
    if (!Array.isArray(messages)) return;
    const filtered = messages.filter((m) => m && m.role !== 'system');
    let startIdx = 0;
    if (this.archive.length > 0 && filtered.length >= this.archive.length) {
      let match = true;
      for (let i = 0; i < this.archive.length; i++) {
        const bText = typeof filtered[i].content === 'string'
          ? filtered[i].content
          : JSON.stringify(filtered[i].content ?? '');
        if (this.archive[i].role !== filtered[i].role || this.archive[i].content !== bText) {
          match = false;
          break;
        }
      }
      if (match) startIdx = this.archive.length;
    }
    for (let i = startIdx; i < filtered.length; i++) {
      this.addTurn(filtered[i].role, filtered[i].content);
    }
  }

  isBuildTrigger(userMsg) {
    if (typeof userMsg !== 'string') return false;
    const lower = userMsg.toLowerCase();
    return DEFAULT_BUILD_TRIGGERS.some((t) => lower.includes(t));
  }

  formatWorkingMemory(userMsg = '') {
    const baseKeys = new Set(['goal', 'decisions', 'constraints', 'rejected']);
    const isBuild = this.isBuildTrigger(userMsg);
    const qk = (!isBuild && typeof userMsg === 'string' && userMsg.trim()) ? extractKeywords(userMsg) : new Set();

    const decisions = qk.size > 0 ? filterItemsByQuery(this.specCard.decisions, qk) : this.specCard.decisions;
    const rejected = qk.size > 0 ? filterItemsByQuery(this.specCard.rejected, qk) : this.specCard.rejected;

    const sections = [
      `Goal: ${this.specCard.goal.length ? this.specCard.goal.join('; ') : 'None recorded yet'}`,
      `Decisions: ${decisions.length ? decisions.join(' | ') : 'None'}`,
      `Constraints: ${this.specCard.constraints.length ? this.specCard.constraints.join(' | ') : 'None'}`,
      `Rejected: ${rejected.length ? rejected.join(' | ') : 'None'}`
    ];

    for (const [key, items] of Object.entries(this.specCard)) {
      if (!baseKeys.has(key) && Array.isArray(items) && items.length > 0) {
        const filtered = qk.size > 0 ? filterItemsByQuery(items, qk) : items;
        sections.push(`${key.charAt(0).toUpperCase() + key.slice(1)}: ${filtered.join(' | ')}`);
      }
    }

    return `[WORKING_MEMORY]\n${sections.join('\n')}\n[/WORKING_MEMORY]`;
  }

  recallTurns(userMsg, windowStartIdx) {
    if (this.maxRecallTurns <= 0 || windowStartIdx <= 0) return [];
    const qk = extractKeywords(userMsg);
    if (qk.size === 0) return [];
    const scored = [];
    for (let i = 0; i < windowStartIdx; i++) {
      const tk = extractKeywords(this.archive[i].content);
      let hits = 0;
      for (const kw of qk) if (tk.has(kw)) hits++;
      if (hits > 0) scored.push({ index: i, hits, turn: this.archive[i] });
    }
    scored.sort((a, b) => b.hits - a.hits || b.index - a.index);
    return scored
      .slice(0, this.maxRecallTurns)
      .sort((a, b) => a.index - b.index)
      .map((s) => ({ role: s.turn.role, content: s.turn.content }));
  }

  buildMessages(userMsg, mode = 'auto') {
    const clean = typeof userMsg === 'string' ? userMsg : String(userMsg ?? '');
    for (const { category, value } of extractSpecTags(clean)) {
      if (!Array.isArray(this.specCard[category])) this.specCard[category] = [];
      if (!this.specCard[category].includes(value)) this.specCard[category].push(value);
    }

    const effectiveMode = mode === 'auto' ? (this.isBuildTrigger(clean) ? 'execute' : 'chat') : mode;
    this.lastMode = effectiveMode;

    const wmBlock = this.formatWorkingMemory(clean);
    const wmText = this.systemPrompt ? `${this.systemPrompt}\n\n${wmBlock}` : wmBlock;
    const wmMsg = { role: 'system', content: wmText };
    const userObj = { role: 'user', content: clean };

    if (effectiveMode === 'execute') {
      return [wmMsg, userObj];
    }

    const total = this.archive.length;
    const windowStart = Math.max(0, total - this.windowSize);
    const qk = extractKeywords(clean);
    const continuityStart = Math.max(windowStart, total - Math.min(2, this.windowSize));
    const neededRecent = [];

    for (let i = windowStart; i < total; i++) {
      const turn = this.archive[i];
      if (i >= continuityStart || qk.size === 0) {
        neededRecent.push({ role: turn.role, content: turn.content });
        continue;
      }
      const tk = extractKeywords(turn.content);
      let match = false;
      for (const kw of qk) if (tk.has(kw)) { match = true; break; }
      if (match) neededRecent.push({ role: turn.role, content: turn.content });
    }

    const recalled = this.recallTurns(clean, windowStart);
    return [wmMsg, ...recalled, ...neededRecent, userObj];
  }

  getSavings(slicedMessages, userMsg) {
    const full = [];
    if (this.systemPrompt) full.push({ role: 'system', content: this.systemPrompt });
    for (const t of this.archive) full.push({ role: t.role, content: t.content });
    full.push({ role: 'user', content: userMsg || '' });

    const beforeTokens = estimateTokens(full);
    const afterTokens = estimateTokens(slicedMessages);
    const savedTokens = Math.max(0, beforeTokens - afterTokens);
    const savedPercent = beforeTokens > 0 ? Math.round((savedTokens / beforeTokens) * 100) : 0;
    return { beforeTokens, afterTokens, savedTokens, savedPercent, mode: this.lastMode };
  }
}

// Per-isolate 100-session LRU cache (zero paid storage required)
const sessions = new Map();
const stats = {
  totalRequests: 0,
  totalBeforeTokens: 0,
  totalAfterTokens: 0,
  totalSavedTokens: 0
};

function getSession(sessionId, windowSize, maxRecallTurns, systemPrompt) {
  let slicer = sessions.get(sessionId);
  if (slicer) {
    sessions.delete(sessionId);
    sessions.set(sessionId, slicer);
    if (systemPrompt && !slicer.systemPrompt) slicer.systemPrompt = systemPrompt;
    return slicer;
  }
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    sessions.delete(oldest);
  }
  slicer = new ContextSlicer({ windowSize, maxRecallTurns, systemPrompt });
  sessions.set(sessionId, slicer);
  return slicer;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Slicer-Key, X-Session-Id, X-Slicer-Mode',
  'Access-Control-Expose-Headers': 'X-Context-Saved, X-Context-Mode, X-Session-Id'
};

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders
    }
  });
}

function isAuthorized(request, env) {
  const key = env && env.SLICER_KEY;
  if (!key) return true;
  const xKey = request.headers.get('X-Slicer-Key');
  const auth = request.headers.get('Authorization');
  return xKey === key || auth === `Bearer ${key}`;
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const upstreamBase = (env.UPSTREAM_URL || 'https://api.openai.com').replace(/\/+$/, '');
    const windowSize = Number(env.WINDOW_SIZE) || 6;
    const maxRecallTurns = Number(env.RECALL_TURNS) || 4;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (pathname !== '/health' && !isAuthorized(request, env)) {
      return jsonResponse(
        { error: { message: 'Unauthorized: invalid or missing SLICER_KEY', type: 'authentication_error' } },
        401
      );
    }

    if (request.method === 'GET' && pathname === '/health') {
      return jsonResponse({
        status: 'ok',
        service: 'context-slicer-worker',
        activeSessions: sessions.size,
        maxSessions: MAX_SESSIONS
      });
    }

    if (request.method === 'GET' && pathname === '/stats') {
      const avgSavedPercent = stats.totalBeforeTokens > 0
        ? Math.round((stats.totalSavedTokens / stats.totalBeforeTokens) * 100)
        : 0;
      return jsonResponse({
        ...stats,
        avgSavedPercent,
        activeSessions: sessions.size,
        maxSessions: MAX_SESSIONS
      });
    }

    if (request.method === 'GET' && pathname === '/v1/models') {
      const authHeader = request.headers.get('Authorization') || (env.OPENAI_API_KEY ? `Bearer ${env.OPENAI_API_KEY}` : '');
      if (!authHeader && upstreamBase === 'https://api.openai.com') {
        return jsonResponse({
          object: 'list',
          data: [
            { id: 'gpt-4o-mini', object: 'model', owned_by: 'openai' },
            { id: 'gpt-4o', object: 'model', owned_by: 'openai' },
            { id: 'gpt-4.1-mini', object: 'model', owned_by: 'openai' }
          ]
        });
      }
      const upstreamRes = await fetch(`${upstreamBase}/v1/models`, {
        headers: authHeader ? { Authorization: authHeader } : {}
      });
      const headers = new Headers(upstreamRes.headers);
      for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
      return new Response(upstreamRes.body, { status: upstreamRes.status, headers });
    }

    if (request.method === 'POST' && pathname === '/v1/chat/completions') {
      let body;
      try {
        body = await request.json();
      } catch (err) {
        return jsonResponse({ error: { message: `Invalid JSON: ${err.message}`, type: 'invalid_request_error' } }, 400);
      }

      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (messages.length === 0) {
        return jsonResponse({ error: { message: 'messages array is required', type: 'invalid_request_error' } }, 400);
      }

      const systemMsg = messages.find((m) => m && m.role === 'system');
      const systemPrompt = systemMsg && typeof systemMsg.content === 'string' ? systemMsg.content : '';
      const sessionId =
        request.headers.get('X-Session-Id') ||
        body.session_id ||
        request.headers.get('CF-Connecting-IP') ||
        'default';

      const slicer = getSession(sessionId, windowSize, maxRecallTurns, systemPrompt);
      const nonSystem = messages.filter((m) => m && m.role !== 'system');
      const lastMsg = nonSystem[nonSystem.length - 1];
      const priorTurns = nonSystem.slice(0, -1);

      if (priorTurns.length > 0) slicer.syncMessages(priorTurns);

      const userContent = lastMsg
        ? (typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content ?? ''))
        : '';

      const mode = request.headers.get('X-Slicer-Mode') || body.slicer_mode || 'auto';
      const slicedMessages = slicer.buildMessages(userContent, mode);
      const savings = slicer.getSavings(slicedMessages, userContent);

      if (lastMsg) slicer.addTurn(lastMsg.role || 'user', userContent);

      stats.totalRequests += 1;
      stats.totalBeforeTokens += savings.beforeTokens;
      stats.totalAfterTokens += savings.afterTokens;
      stats.totalSavedTokens += savings.savedTokens;

      const xContextSaved = `${savings.savedPercent}% (${savings.savedTokens} tokens; ${savings.beforeTokens}->${savings.afterTokens})`;

      const upstreamBody = { ...body, messages: slicedMessages };
      delete upstreamBody.session_id;
      delete upstreamBody.slicer_mode;

      const outHeaders = { 'Content-Type': 'application/json' };
      const authHeader = request.headers.get('Authorization') || (env.OPENAI_API_KEY ? `Bearer ${env.OPENAI_API_KEY}` : '');
      if (authHeader) outHeaders.Authorization = authHeader;

      const upstreamRes = await fetch(`${upstreamBase}/v1/chat/completions`, {
        method: 'POST',
        headers: outHeaders,
        body: JSON.stringify(upstreamBody)
      });

      const resHeaders = new Headers(upstreamRes.headers);
      for (const [k, v] of Object.entries(CORS_HEADERS)) resHeaders.set(k, v);
      resHeaders.set('X-Context-Saved', xContextSaved);
      resHeaders.set('X-Context-Mode', savings.mode);
      resHeaders.set('X-Session-Id', sessionId);

      // Stream SSE passthrough directly without buffering
      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: resHeaders
      });
    }

    return jsonResponse({ error: { message: `Route not found: ${request.method} ${pathname}`, type: 'not_found' } }, 404);
  }
};
