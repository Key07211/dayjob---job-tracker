import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// The name Claude Code knows the in-app tools by (mcp__dayjob_app__…). Not "dayjob": that is the connection Dayjob
// adds to the user's own Claude Code, and the two must not be mistaken for each other.
export const MCP_SERVER_NAME = 'dayjob_app';

// One MCP exchange with the Claude Code process that runs a conversation. Nothing is kept between requests: each
// POST gets a fresh server, and callTool runs the tool for the conversation the request's token names.
export async function handleMcp({ request, response, body, tools, callTool }) {
  const server = new McpServer({ name: 'dayjob-assistant', version: '1.0.0' });
  for (const tool of tools.list) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.shape,
      annotations: { readOnlyHint: tool.tier === 'read', destructiveHint: false, idempotentHint: tool.tier === 'read', openWorldHint: tool.name === 'run_search' },
    }, async input => {
      const outcome = await callTool(tool.name, input);
      return { content: [{ type: 'text', text: outcome.content }], ...(outcome.ok ? {} : { isError: true }) };
    });
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(request, response, body);
}
