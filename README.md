# ContextSlicer

**Cut AI token usage without deleting a single message.**

Normally, AI chats re-send and re-read the entire conversation history on every turn—wasting thousands of tokens on unrelated turns and dead-end brainstorming. **ContextSlicer** is a non-destructive context filter that keeps your full chat history archived while sending the AI **only the specific context it needs to complete the active task**.

Zero npm dependencies. Built with pure Node.js CommonJS, stdio JSON-RPC 2.0, and a single-file Cloudflare Worker.

## Why ContextSlicer?

- **Sends only what the task needs**: Instead of replaying the entire chat on every request, ContextSlicer filters the history down to only the relevant context and key decisions required for the current task.
- **Non-destructive by design**: All raw turns remain safely archived in `this.archive` (or local JSON storage)—nothing is ever deleted from your chat.
- **Auto-switches on build triggers**: During brainstorming (`chat` mode), it includes compact working memory, keyword-recalled turns, and the recent window. When you trigger execution (`"build it"`, `"build the app"`, `"write the code"`, `"start coding"`), it drops the brainstorm window and sends only the distilled task essentials (`[WORKING_MEMORY] + current_message`).

## Architecture

1. **SDK (`src/core.js`)**: `ContextSlicer` keeps all raw turns in `this.archive` and maintains a compact `specCard` (`goal`, `decisions`, `constraints`, `rejected`, plus custom categories like `note`) via `<spec cat="...">...</spec>` tags.
   - **Chat mode**: `[WORKING_MEMORY] + keyword-recalled turns + last N turns + userMsg`
   - **Execute mode**: Triggered automatically on build phrases — drops brainstorm clutter and sends only the essential spec + `userMsg`.
2. **Proxy (`src/proxy.js` & `bin/cli.js`)**: OpenAI-compatible streaming proxy with `GET /health`, `GET /stats`, `GET /v1/models`, `OPTIONS` CORS, `POST /v1/chat/completions` (`stream: true` SSE passthrough), `X-Context-Saved` header, 100-session LRU RAM cap, and optional `SLICER_KEY` auth.
3. **MCP (`src/mcp.js`)**: Zero-dependency stdio JSON-RPC 2.0 server exposing `slice_and_retrieve`, `save_slice`, `get_slice`, `list_slices`, and `delete_slice` backed by a local JSON file.
4. **Cloudflare Worker (`worker.js`) & Product Site (`index.html`)**: Free-tier single-file Cloudflare Worker proxy + dark-mode 1-page site.

## Quick Start

### Proxy
```bash
npm start
# or
npx context-slicer serve --port 8787 --upstream https://api.openai.com
```

### MCP Server
```bash
npm run mcp
# or
node src/mcp.js
```

### SDK
```js
const { ContextSlicer } = require('./src/core');

const slicer = new ContextSlicer({ windowSize: 6 });
slicer.addTurn('user', 'Build a CLI <spec cat="goal">Zero-dep CLI</spec>');
const messages = slicer.buildMessages('build it'); // switches to execute mode
```

### Cloudflare Worker
Deploy `worker.js` directly with Wrangler or paste into the Cloudflare Workers dashboard (no KV or credit card required).

## License
MIT
