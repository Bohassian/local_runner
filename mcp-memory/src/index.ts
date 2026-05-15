import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number.parseInt(process.env.MCP_MEMORY_PORT ?? '3939', 10);

// Each session needs its own Server+Transport pair: the SDK's Server has a 1:1
// binding to its transport (server.connect throws "Already connected" on a
// second connect), and Streamable HTTP sessions are also 1:1 with a transport.
// So per-session factories all the way down. Handler logic is identical across
// servers — `buildServer` re-registers it for each new session.
function buildServer(): Server {
  const server = new Server(
    { name: 'mcp-memory', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'ping',
        description: 'Round-trip health check. Returns "pong" with an optional echoed message.',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'Optional message to echo back in the response.',
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name === 'ping') {
      const message = (args as { message?: string } | undefined)?.message;
      return {
        content: [{ type: 'text' as const, text: message ? `pong: ${message}` : 'pong' }],
      };
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
      // Subsequent request on an established session.
      await transports.get(sessionId)!.handleRequest(req, res);
      return;
    }

    if (sessionId && !transports.has(sessionId)) {
      // Session ID supplied but unknown — stale client.
      res.statusCode = 404;
      res.end('unknown session');
      return;
    }

    // No session ID: only valid for the initial `initialize` request, which
    // spins up a new Server+Transport pair.
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
  httpServer.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
