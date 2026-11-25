'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const { ContextSlicer } = require('./core');

const MAX_SESSIONS = 100;

class LRUCache {
  constructor(capacity = MAX_SESSIONS) {
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
    this.map.set(key, value);
  }

  get size() {
    return this.map.size;
  }

  entries() {
    return Array.from(this.map.entries());
  }
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Slicer-Key, X-Session-Id, X-Slicer-Mode'
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'X-Context-Saved, X-Context-Mode, X-Session-Id'
  );
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  setCorsHeaders(res);
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    const MAX_BODY = 10 * 1024 * 1024; // 10 MB

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', reject);
  });
}

function getSessionId(req, body) {
  const headerId = req.headers['x-session-id'];
  if (typeof headerId === 'string' && headerId.trim()) {
    return headerId.trim();
  }
  if (body && typeof body.session_id === 'string' && body.session_id.trim()) {
    return body.session_id.trim();
  }
  const seed = body && Array.isArray(body.messages) && body.messages.length > 0
    ? JSON.stringify(body.messages[0])
    : (req.socket && req.socket.remoteAddress) || 'default';
  return 'sess_' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

function checkAuth(req, slicerKey) {
  if (!slicerKey) return true;
  const headerKey = req.headers['x-slicer-key'];
  if (typeof headerKey === 'string' && headerKey === slicerKey) {
    return true;
  }
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth === `Bearer ${slicerKey}`) {
    return true;
  }
  return false;
}

/**
 * Create a zero-dependency OpenAI-compatible streaming ContextSlicer proxy server.
 * @param {Object} [options]
 * @param {string} [options.upstreamUrl='https://api.openai.com']
 * @param {string} [options.slicerKey]
 * @param {number} [options.windowSize=6]
 * @param {number} [options.maxRecallTurns=4]
 * @param {number} [options.maxSessions=100]
 */
function createProxyServer(options = {}) {
  const upstreamBase = (options.upstreamUrl || process.env.UPSTREAM_URL || 'https://api.openai.com').replace(/\/+$/, '');
  const slicerKey = options.slicerKey !== undefined ? options.slicerKey : (process.env.SLICER_KEY || '');
  const windowSize = Number.isFinite(options.windowSize) ? options.windowSize : 6;
  const maxRecallTurns = Number.isFinite(options.maxRecallTurns) ? options.maxRecallTurns : 4;
  const maxSessions = Number.isFinite(options.maxSessions) ? options.maxSessions : MAX_SESSIONS;

  const sessions = new LRUCache(maxSessions);
  const stats = {
    startedAt: new Date().toISOString(),
    totalRequests: 0,
    totalBeforeTokens: 0,
    totalAfterTokens: 0,
    totalSavedTokens: 0
  };

  function getOrCreateSession(sessionId, systemPrompt) {
    let slicer = sessions.get(sessionId);
    if (!slicer) {
      slicer = new ContextSlicer({
        windowSize,
        maxRecallTurns,
        systemPrompt: systemPrompt || ''
      });
      sessions.set(sessionId, slicer);
    } else if (systemPrompt && !slicer.systemPrompt) {
      slicer.systemPrompt = systemPrompt;
    }
    return slicer;
  }

  function forwardRequest(reqPath, method, headers, bodyString, onResponse) {
    const target = new URL(upstreamBase + reqPath);
    const transport = target.protocol === 'https:' ? https : http;

    const outHeaders = { ...headers };
    delete outHeaders.host;
    delete outHeaders['content-length'];
    delete outHeaders['x-slicer-key'];
    delete outHeaders['x-session-id'];
    delete outHeaders['x-slicer-mode'];

    if (!outHeaders.authorization && process.env.OPENAI_API_KEY) {
      outHeaders.authorization = `Bearer ${process.env.OPENAI_API_KEY}`;
    }

    if (bodyString !== null) {
      outHeaders['content-type'] = 'application/json';
      outHeaders['content-length'] = Buffer.byteLength(bodyString);
    }

    const upstreamReq = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method,
        headers: outHeaders
      },
      onResponse
    );

    if (bodyString !== null) {
      upstreamReq.write(bodyString);
    }
    upstreamReq.end();
    return upstreamReq;
  }

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // CORS preflight
    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    // Optional SLICER_KEY auth check (health is open)
    if (pathname !== '/health' && !checkAuth(req, slicerKey)) {
      sendJson(res, 401, {
        error: {
          message: 'Unauthorized: invalid or missing SLICER_KEY',
          type: 'authentication_error'
        }
      });
      return;
    }

    // GET /health
    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        service: 'context-slicer',
        uptimeSeconds: Math.floor(process.uptime()),
        activeSessions: sessions.size,
        maxSessions
      });
      return;
    }

    // GET /stats
    if (req.method === 'GET' && pathname === '/stats') {
      const avgSavedPercent = stats.totalBeforeTokens > 0
        ? Math.round((stats.totalSavedTokens / stats.totalBeforeTokens) * 100)
        : 0;

      sendJson(res, 200, {
        ...stats,
        avgSavedPercent,
        activeSessions: sessions.size,
        maxSessions,
        sessions: sessions.entries().map(([id, s]) => ({
          id,
          archivedTurns: s.archive.length,
          lastMode: s.lastMode,
          specCounts: {
            goal: s.specCard.goal.length,
            decisions: s.specCard.decisions.length,
            constraints: s.specCard.constraints.length,
            rejected: s.specCard.rejected.length
          }
        }))
      });
      return;
    }

    // GET /v1/models
    if (req.method === 'GET' && pathname === '/v1/models') {
      const hasAuth = Boolean(req.headers.authorization || process.env.OPENAI_API_KEY);
      if (!hasAuth && upstreamBase === 'https://api.openai.com') {
        sendJson(res, 200, {
          object: 'list',
          data: [
            { id: 'gpt-4o-mini', object: 'model', owned_by: 'openai' },
            { id: 'gpt-4o', object: 'model', owned_by: 'openai' },
            { id: 'gpt-4.1-mini', object: 'model', owned_by: 'openai' }
          ]
        });
        return;
      }

      const upstreamReq = forwardRequest('/v1/models', 'GET', req.headers, null, (upstreamRes) => {
        setCorsHeaders(res);
        res.writeHead(upstreamRes.statusCode || 200, {
          'Content-Type': upstreamRes.headers['content-type'] || 'application/json'
        });
        upstreamRes.pipe(res);
      });
      upstreamReq.on('error', (err) => {
        sendJson(res, 502, { error: { message: `Upstream error: ${err.message}`, type: 'proxy_error' } });
      });
      return;
    }

    // POST /v1/chat/completions
    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      let body;
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw || '{}');
      } catch (err) {
        sendJson(res, 400, { error: { message: `Invalid JSON body: ${err.message}`, type: 'invalid_request_error' } });
        return;
      }

      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (messages.length === 0) {
        sendJson(res, 400, { error: { message: 'messages array is required', type: 'invalid_request_error' } });
        return;
      }

      const systemMsg = messages.find((m) => m && m.role === 'system');
      const systemPrompt = systemMsg && typeof systemMsg.content === 'string' ? systemMsg.content : '';
      const sessionId = getSessionId(req, body);
      const slicer = getOrCreateSession(sessionId, systemPrompt);

      // Separate prior turns from the latest user message
      const nonSystem = messages.filter((m) => m && m.role !== 'system');
      const lastMsg = nonSystem[nonSystem.length - 1];
      const priorTurns = nonSystem.slice(0, -1);

      if (priorTurns.length > 0) {
        slicer.syncMessages(priorTurns);
      }

      const userContent = lastMsg
        ? (typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content ?? ''))
        : '';

      const requestedMode = req.headers['x-slicer-mode'] || body.slicer_mode || 'auto';
      const slicedMessages = slicer.buildMessages(userContent, requestedMode);
      const savings = slicer.getSavings(slicedMessages, userContent);

      // Record the current user turn in the non-destructive archive
      if (lastMsg) {
        slicer.addTurn(lastMsg.role || 'user', userContent);
      }

      stats.totalRequests += 1;
      stats.totalBeforeTokens += savings.beforeTokens;
      stats.totalAfterTokens += savings.afterTokens;
      stats.totalSavedTokens += savings.savedTokens;

      const xContextSaved = `${savings.savedPercent}% (${savings.savedTokens} tokens; ${savings.beforeTokens}->${savings.afterTokens})`;

      const upstreamBodyObj = { ...body, messages: slicedMessages };
      delete upstreamBodyObj.session_id;
      delete upstreamBodyObj.slicer_mode;
      const upstreamPayload = JSON.stringify(upstreamBodyObj);

      const isStreaming = Boolean(body.stream);

      const upstreamReq = forwardRequest('/v1/chat/completions', 'POST', req.headers, upstreamPayload, (upstreamRes) => {
        setCorsHeaders(res);
        res.setHeader('X-Context-Saved', xContextSaved);
        res.setHeader('X-Context-Mode', savings.mode);
        res.setHeader('X-Session-Id', sessionId);

        if (isStreaming) {
          res.writeHead(upstreamRes.statusCode || 200, {
            'Content-Type': upstreamRes.headers['content-type'] || 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Context-Saved': xContextSaved,
            'X-Context-Mode': savings.mode,
            'X-Session-Id': sessionId
          });

          let sseBuffer = '';
          let assistantText = '';

          upstreamRes.on('data', (chunk) => {
            res.write(chunk);
            // Non-blocking tap to capture streamed assistant content for specCard & archive
            sseBuffer += chunk.toString('utf8');
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() || '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const dataStr = trimmed.slice(5).trim();
              if (!dataStr || dataStr === '[DONE]') continue;
              try {
                const parsed = JSON.parse(dataStr);
                const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
                if (delta && typeof delta.content === 'string') {
                  assistantText += delta.content;
                }
              } catch (_) {
                // Ignore partial/non-JSON SSE lines
              }
            }
          });

          upstreamRes.on('end', () => {
            if (assistantText) {
              slicer.addTurn('assistant', assistantText);
            }
            res.end();
          });

          upstreamRes.on('error', () => {
            res.end();
          });
          return;
        }

        // Non-streaming JSON response
        const chunks = [];
        upstreamRes.on('data', (c) => chunks.push(c));
        upstreamRes.on('end', () => {
          const buf = Buffer.concat(chunks);
          try {
            const parsed = JSON.parse(buf.toString('utf8'));
            const msg = parsed.choices && parsed.choices[0] && parsed.choices[0].message;
            if (msg && typeof msg.content === 'string') {
              slicer.addTurn('assistant', msg.content);
            }
          } catch (_) {
            // Non-JSON upstream error body
          }

          res.writeHead(upstreamRes.statusCode || 200, {
            'Content-Type': upstreamRes.headers['content-type'] || 'application/json',
            'Content-Length': buf.length,
            'X-Context-Saved': xContextSaved,
            'X-Context-Mode': savings.mode,
            'X-Session-Id': sessionId
          });
          res.end(buf);
        });
      });

      upstreamReq.on('error', (err) => {
        sendJson(res, 502, {
          error: { message: `Upstream connection failed: ${err.message}`, type: 'proxy_error' }
        });
      });
      return;
    }

    sendJson(res, 404, { error: { message: `Route not found: ${req.method} ${pathname}`, type: 'not_found' } });
  });

  return { server, sessions, stats };
}

module.exports = {
  createProxyServer,
  LRUCache,
  MAX_SESSIONS
};
