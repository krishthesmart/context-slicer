'use strict';

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

/**
 * Rough, zero-dependency token estimator (~4 chars per token + small per-message overhead).
 * @param {Array<{role: string, content: string}>|string} input
 * @returns {number}
 */
function estimateTokens(input) {
  if (typeof input === 'string') {
    return input.length === 0 ? 0 : Math.ceil(input.length / 4);
  }
  if (!Array.isArray(input)) return 0;
  let total = 0;
  for (const msg of input) {
    if (!msg) continue;
    const text = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content || '');
    total += Math.ceil(text.length / 4) + 4;
  }
  return total;
}

/**
 * Extract <spec cat="...">...</spec> tags from text.
 * Supports canonical categories (goal, decisions, constraints, rejected) plus any custom category (e.g. note).
 * @param {string} text
 * @returns {Array<{category: string, value: string}>}
 */
function extractSpecTags(text) {
  if (typeof text !== 'string' || !text.includes('<spec')) return [];
  const results = [];
  const regex = /<spec\s+cat=["']?([a-zA-Z0-9_-]+)["']?\s*>([\s\S]*?)<\/spec>/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const rawCat = match[1].toLowerCase().trim();
    const category = SPEC_CATEGORIES[rawCat] || rawCat;
    const value = match[2].replace(/\s+/g, ' ').trim();
    if (category && value) {
      results.push({ category, value });
    }
  }
  return results;
}

/**
 * Extract normalized keywords from a string for lightweight recall.
 * @param {string} text
 * @returns {Set<string>}
 */
function extractKeywords(text) {
  if (typeof text !== 'string') return new Set();
  const tokens = text.toLowerCase().match(/[a-z0-9_-]{3,}/g) || [];
  const keywords = new Set();
  for (const token of tokens) {
    if (!STOP_WORDS.has(token)) {
      keywords.add(token);
    }
  }
  return keywords;
}

function filterItemsByQuery(items, queryKeywords) {
  if (!Array.isArray(items) || items.length === 0 || queryKeywords.size === 0) {
    return items || [];
  }
  const matched = items.filter((item) => {
    const itemKeywords = extractKeywords(item);
    for (const kw of queryKeywords) {
      if (itemKeywords.has(kw)) return true;
    }
    return false;
  });
  return matched.length > 0 ? matched : items;
}

class ContextSlicer {
  /**
   * @param {Object} [options]
   * @param {number} [options.windowSize=6] Max recent turns window in chat mode
   * @param {number} [options.maxRecallTurns=4] Max keyword-recalled turns in chat mode
   * @param {string[]} [options.buildTriggers] Phrases that trigger execute mode
   * @param {string} [options.systemPrompt] Optional base system prompt
   */
  constructor(options = {}) {
    this.windowSize = Number.isFinite(options.windowSize) && options.windowSize >= 0
      ? options.windowSize
      : 6;
    this.maxRecallTurns = Number.isFinite(options.maxRecallTurns) && options.maxRecallTurns >= 0
      ? options.maxRecallTurns
      : 4;
    this.buildTriggers = Array.isArray(options.buildTriggers) && options.buildTriggers.length > 0
      ? options.buildTriggers.map((t) => String(t).toLowerCase())
      : DEFAULT_BUILD_TRIGGERS;
    this.systemPrompt = typeof options.systemPrompt === 'string' ? options.systemPrompt : '';

    // Non-destructive raw history: never deleted or mutated
    this.archive = [];

    // Compact working memory maintained via <spec cat="...">...</spec>
    this.specCard = {
      goal: [],
      decisions: [],
      constraints: [],
      rejected: []
    };

    this.lastMode = 'chat';
  }

  /**
   * Add a single turn to the non-destructive archive and update specCard.
   * @param {'user'|'assistant'|'system'|'context'|'tool'} role
   * @param {string} content
   * @returns {Object} The archived turn
   */
  addTurn(role, content) {
    const normalizedContent = typeof content === 'string'
      ? content
      : JSON.stringify(content ?? '');

    const turn = {
      id: this.archive.length + 1,
      role: role || 'user',
      content: normalizedContent,
      timestamp: Date.now()
    };

    this.archive.push(turn);
    this._ingestSpecTags(normalizedContent);
    return turn;
  }

  /**
   * Sync an array of OpenAI-style messages into the archive without duplicating existing prefix turns.
   * @param {Array<{role: string, content: string}>} messages
   */
  syncMessages(messages) {
    if (!Array.isArray(messages)) return;
    const filtered = messages.filter((m) => m && m.role !== 'system');

    let startIdx = 0;
    if (this.archive.length > 0 && filtered.length >= this.archive.length) {
      let allMatch = true;
      for (let i = 0; i < this.archive.length; i++) {
        const a = this.archive[i];
        const b = filtered[i];
        const bContent = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
        if (a.role !== b.role || a.content !== bContent) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        startIdx = this.archive.length;
      }
    } else if (this.archive.length === 0) {
      startIdx = 0;
    }

    for (let i = startIdx; i < filtered.length; i++) {
      this.addTurn(filtered[i].role, filtered[i].content);
    }
  }

  /**
   * Parse and merge <spec cat="...">...</spec> tags into this.specCard.
   * @param {string} text
   */
  _ingestSpecTags(text) {
    const tags = extractSpecTags(text);
    for (const { category, value } of tags) {
      if (!Array.isArray(this.specCard[category])) {
        this.specCard[category] = [];
      }
      const list = this.specCard[category];
      if (!list.includes(value)) {
        list.push(value);
      }
    }
  }

  /**
   * Manually add or update a spec item (supports canonical and arbitrary categories).
   * @param {string} category
   * @param {string} value
   */
  addSpec(category, value) {
    const rawCat = String(category || '').toLowerCase().trim();
    const normalizedCat = SPEC_CATEGORIES[rawCat] || rawCat;
    if (!normalizedCat) {
      throw new Error(`Invalid spec category: ${category}`);
    }
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    if (!Array.isArray(this.specCard[normalizedCat])) {
      this.specCard[normalizedCat] = [];
    }
    if (clean && !this.specCard[normalizedCat].includes(clean)) {
      this.specCard[normalizedCat].push(clean);
    }
  }

  /**
   * Check whether a user message contains a build trigger phrase.
   * @param {string} userMsg
   * @returns {boolean}
   */
  isBuildTrigger(userMsg) {
    if (typeof userMsg !== 'string') return false;
    const lower = userMsg.toLowerCase();
    return this.buildTriggers.some((trigger) => lower.includes(trigger));
  }

  /**
   * Render a compact [WORKING_MEMORY] block.
   * When userMsg is a targeted task (not a broad build trigger), filters Decisions,
   * Rejected, and custom categories to only items relevant to userMsg.
   * @param {string} [userMsg]
   * @returns {string}
   */
  formatWorkingMemory(userMsg = '') {
    const baseKeys = new Set(['goal', 'decisions', 'constraints', 'rejected']);
    const isBuild = this.isBuildTrigger(userMsg);
    const qk = (!isBuild && typeof userMsg === 'string' && userMsg.trim())
      ? extractKeywords(userMsg)
      : new Set();

    const decisions = qk.size > 0
      ? filterItemsByQuery(this.specCard.decisions, qk)
      : this.specCard.decisions;
    const rejected = qk.size > 0
      ? filterItemsByQuery(this.specCard.rejected, qk)
      : this.specCard.rejected;

    const sections = [
      `Goal: ${this.specCard.goal.length ? this.specCard.goal.join('; ') : 'None recorded yet'}`,
      `Decisions: ${decisions.length ? decisions.join(' | ') : 'None'}`,
      `Constraints: ${this.specCard.constraints.length ? this.specCard.constraints.join(' | ') : 'None'}`,
      `Rejected: ${rejected.length ? rejected.join(' | ') : 'None'}`
    ];

    for (const [key, items] of Object.entries(this.specCard)) {
      if (!baseKeys.has(key) && Array.isArray(items) && items.length > 0) {
        const filtered = qk.size > 0 ? filterItemsByQuery(items, qk) : items;
        const label = key.charAt(0).toUpperCase() + key.slice(1);
        sections.push(`${label}: ${filtered.join(' | ')}`);
      }
    }

    return `[WORKING_MEMORY]\n${sections.join('\n')}\n[/WORKING_MEMORY]`;
  }

  /**
   * Recall earlier archived turns matching keywords in userMsg, excluding recent window indices.
   * @param {string} userMsg
   * @param {number} windowStartIdx
   * @returns {Array<{role: string, content: string}>}
   */
  recallTurns(userMsg, windowStartIdx) {
    if (this.maxRecallTurns <= 0 || windowStartIdx <= 0) return [];
    const queryKeywords = extractKeywords(userMsg);
    if (queryKeywords.size === 0) return [];

    const scored = [];
    for (let i = 0; i < windowStartIdx; i++) {
      const turn = this.archive[i];
      const turnKeywords = extractKeywords(turn.content);
      let hits = 0;
      for (const kw of queryKeywords) {
        if (turnKeywords.has(kw)) hits++;
      }
      if (hits > 0) {
        scored.push({ index: i, hits, turn });
      }
    }

    scored.sort((a, b) => b.hits - a.hits || b.index - a.index);
    const top = scored.slice(0, this.maxRecallTurns);
    top.sort((a, b) => a.index - b.index);

    return top.map((item) => ({
      role: item.turn.role,
      content: item.turn.content
    }));
  }

  /**
   * Build the filtered message array containing only what the AI needs for userMsg,
   * without modifying this.archive.
   *
   * - "execute" mode: [WORKING_MEMORY] + userMsg (drops brainstorm window)
   * - "chat" mode: [filtered WORKING_MEMORY] + keyword-recalled turns + needed recent turns + userMsg
   * - "auto" mode: switches to "execute" if userMsg matches a build trigger, else "chat"
   *
   * @param {string} userMsg
   * @param {'auto'|'chat'|'execute'} [mode='auto']
   * @returns {Array<{role: string, content: string}>}
   */
  buildMessages(userMsg, mode = 'auto') {
    const cleanUserMsg = typeof userMsg === 'string' ? userMsg : String(userMsg ?? '');
    this._ingestSpecTags(cleanUserMsg);

    let effectiveMode = mode;
    if (mode === 'auto') {
      effectiveMode = this.isBuildTrigger(cleanUserMsg) ? 'execute' : 'chat';
    }
    this.lastMode = effectiveMode;

    const wmBlock = this.formatWorkingMemory(cleanUserMsg);
    const workingMemoryContent = this.systemPrompt
      ? `${this.systemPrompt}\n\n${wmBlock}`
      : wmBlock;

    const workingMemoryMsg = {
      role: 'system',
      content: workingMemoryContent
    };

    const finalUserMsg = {
      role: 'user',
      content: cleanUserMsg
    };

    if (effectiveMode === 'execute') {
      return [workingMemoryMsg, finalUserMsg];
    }

    const total = this.archive.length;
    const windowStartIdx = Math.max(0, total - this.windowSize);
    const queryKeywords = extractKeywords(cleanUserMsg);
    const continuityCount = Math.min(2, this.windowSize);
    const continuityStart = Math.max(windowStartIdx, total - continuityCount);

    // Within the window, keep only keyword-relevant turns plus the last <=2 turns for conversational flow
    const neededRecent = [];
    for (let i = windowStartIdx; i < total; i++) {
      const turn = this.archive[i];
      if (i >= continuityStart || queryKeywords.size === 0) {
        neededRecent.push({ role: turn.role, content: turn.content });
        continue;
      }
      const tk = extractKeywords(turn.content);
      let hits = 0;
      for (const kw of queryKeywords) {
        if (tk.has(kw)) {
          hits++;
          break;
        }
      }
      if (hits > 0) {
        neededRecent.push({ role: turn.role, content: turn.content });
      }
    }

    const recalledTurns = this.recallTurns(cleanUserMsg, windowStartIdx);

    return [
      workingMemoryMsg,
      ...recalledTurns,
      ...neededRecent,
      finalUserMsg
    ];
  }

  /**
   * Compute token savings comparing full archive + userMsg against sliced messages.
   * @param {Array<{role: string, content: string}>} slicedMessages
   * @param {string} userMsg
   * @returns {{beforeTokens: number, afterTokens: number, savedTokens: number, savedPercent: number, mode: string}}
   */
  getSavings(slicedMessages, userMsg) {
    const fullHistory = [];
    if (this.systemPrompt) {
      fullHistory.push({ role: 'system', content: this.systemPrompt });
    }
    for (const t of this.archive) {
      fullHistory.push({ role: t.role, content: t.content });
    }
    fullHistory.push({ role: 'user', content: userMsg || '' });

    const beforeTokens = estimateTokens(fullHistory);
    const afterTokens = estimateTokens(slicedMessages);
    const savedTokens = Math.max(0, beforeTokens - afterTokens);
    const savedPercent = beforeTokens > 0
      ? Math.round((savedTokens / beforeTokens) * 100)
      : 0;

    return {
      beforeTokens,
      afterTokens,
      savedTokens,
      savedPercent,
      mode: this.lastMode
    };
  }

  toJSON() {
    return {
      windowSize: this.windowSize,
      maxRecallTurns: this.maxRecallTurns,
      buildTriggers: this.buildTriggers,
      systemPrompt: this.systemPrompt,
      archive: this.archive,
      specCard: this.specCard,
      lastMode: this.lastMode
    };
  }

  static fromJSON(data) {
    const slicer = new ContextSlicer({
      windowSize: data.windowSize,
      maxRecallTurns: data.maxRecallTurns,
      buildTriggers: data.buildTriggers,
      systemPrompt: data.systemPrompt
    });
    if (Array.isArray(data.archive)) slicer.archive = data.archive;
    if (data.specCard) {
      const restored = {
        goal: Array.isArray(data.specCard.goal) ? data.specCard.goal : [],
        decisions: Array.isArray(data.specCard.decisions) ? data.specCard.decisions : [],
        constraints: Array.isArray(data.specCard.constraints) ? data.specCard.constraints : [],
        rejected: Array.isArray(data.specCard.rejected) ? data.specCard.rejected : []
      };
      for (const [key, val] of Object.entries(data.specCard)) {
        if (!(key in restored) && Array.isArray(val)) {
          restored[key] = val;
        }
      }
      slicer.specCard = restored;
    }
    if (data.lastMode) slicer.lastMode = data.lastMode;
    return slicer;
  }
}

module.exports = {
  ContextSlicer,
  DEFAULT_BUILD_TRIGGERS,
  extractSpecTags,
  estimateTokens
};
