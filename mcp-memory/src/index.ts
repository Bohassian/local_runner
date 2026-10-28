import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { EMBEDDING_DIM, openStore } from './store/docs.js';
import { createEmbedClient } from './embed/ollama.js';
import { DOCS_TOOL_NAMES, docsToolDefinitions, handleDocsTool } from './tools/docs.js';

const PORT = Number.parseInt(process.env.MCP_MEMORY_PORT ?? '3939', 10);
const EMBED_BASE_URL = process.env.EMBED_BASE_URL ?? 'http://ollama:11434';
const EMBED_MODEL = process.env.EMBED_MODEL ?? 'nomic-embed-text';
const DOCS_DB_PATH = process.env.MCP_DOCS_DB_PATH ?? '/app/data/docs.db';

const docsDb = openStore(DOCS_DB_PATH);
const embed = createEmbedClient({ baseUrl: EMBED_BASE_URL, model: EMBED_MODEL });

// Probe the embedding model on startup. Fail loud if its dimension doesn't
// match the vec0 table — silently storing the wrong-dim vectors would corrupt
// the index and produce nonsense matches.
{
  const probe = await embed.embed('probe');
  if (probe.length !== EMBEDDING_DIM) {
    throw new Error(
      `Embedding dim mismatch: vec0 declares ${EMBEDDING_DIM}, ` +
        `${EMBED_MODEL} returned ${probe.length}. ` +
        `Update EMBEDDING_DIM in store/docs.ts and re-create the DB.`,
    );
  }
  console.log(
    `mcp-memory: connected to ${EMBED_BASE_URL} (${EMBED_MODEL}, ${probe.length}-d)`,
  );
}

// See phase-1 notes: per-session Server+Transport. The Server class is 1:1 with
// its transport, so we re-build it for every new MCP session. The DB + embed
// client are shared across sessions (they're stateless w.r.t. session).
function buildServer(): Server {
  const server = new Server(
    { name: 'mcp-memory', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: docsToolDefinitions(docsDb),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (DOCS_TOOL_NAMES.has(name)) {
      return handleDocsTool(
        { db: docsDb, embed },
        name,
        (args ?? {}) as Record<string, unknown>,
      );
    }
    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}

const transports = new Map<string, StreamableHTTPServerTransport>();

const httpServer = http.createServer(async (req, res) => {
  if (req.url !== '/mcp') {
    res.statusCode = 404;
    res.end();
    return;
  }

  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res);
      return;
    }

    if (sessionId && !transports.has(sessionId)) {
      res.statusCode = 404;
      res.end('unknown session');
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    const server = buildServer();
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error('mcp-memory request error:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end();
    }
  }
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`mcp-memory listening on http://0.0.0.0:${PORT}/mcp`);
});

const shutdown = () => {
  console.log('mcp-memory shutting down');
  httpServer.close(() => {
    docsDb.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
