#!/usr/bin/env node
'use strict';

const { createProxyServer } = require('../src/proxy');
const { startMcpServer } = require('../src/mcp');

function printHelp() {
  console.log(`ContextSlicer CLI (zero-dependency)

Usage:
  context-slicer serve [options]   Start OpenAI-compatible streaming proxy
  context-slicer mcp               Start stdio JSON-RPC 2.0 MCP server
  context-slicer --help            Show this help message
  context-slicer --version         Show version

Serve Options:
  --port <number>       Port to listen on (default: process.env.PORT || 8787)
  --host <string>       Host to bind (default: 0.0.0.0)
  --upstream <url>      Upstream OpenAI-compatible base URL (default: https://api.openai.com)
  --window <number>     Recent turns window size in chat mode (default: 6)
  --recall <number>     Max keyword-recalled turns in chat mode (default: 4)
  --key <string>        Optional SLICER_KEY for proxy auth
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0] && !args[0].startsWith('-') ? args[0] : 'serve';
  const flags = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--version' || a === '-v') flags.version = true;
    else if (a === '--port' && args[i + 1]) flags.port = Number(args[++i]);
    else if (a === '--host' && args[i + 1]) flags.host = args[++i];
    else if (a === '--upstream' && args[i + 1]) flags.upstream = args[++i];
    else if (a === '--window' && args[i + 1]) flags.window = Number(args[++i]);
    else if (a === '--recall' && args[i + 1]) flags.recall = Number(args[++i]);
    else if (a === '--key' && args[i + 1]) flags.key = args[++i];
  }

  return { command, flags };
}

function main() {
  const { command, flags } = parseArgs(process.argv);

  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  if (flags.version) {
    const pkg = require('../package.json');
    console.log(pkg.version);
    process.exit(0);
  }

  if (command === 'mcp') {
    startMcpServer();
    return;
  }

  if (command === 'serve') {
    const port = Number.isFinite(flags.port) ? flags.port : Number(process.env.PORT || 8787);
    const host = flags.host || process.env.HOST || '0.0.0.0';
    const upstreamUrl = flags.upstream || process.env.UPSTREAM_URL || 'https://api.openai.com';

    const { server } = createProxyServer({
      upstreamUrl,
      slicerKey: flags.key,
      windowSize: flags.window,
      maxRecallTurns: flags.recall
    });

    server.listen(port, host, () => {
      console.log(`ContextSlicer proxy listening on http://${host}:${port}`);
      console.log(`Upstream: ${upstreamUrl}`);
      console.log('Endpoints: GET /health, GET /stats, GET /v1/models, POST /v1/chat/completions');
    });
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

main();
