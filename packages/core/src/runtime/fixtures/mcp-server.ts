import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// A small MCP server over stdio for McpHost's tests. `FIXTURE_GREETING` checks that configured
// environment variables, secrets included, reach the server.

const server = new McpServer({ name: 'fixture', version: '1.0.0' });
server.registerTool(
    'echo',
    {
        description: 'Repeat a text.',
        inputSchema: { text: z.string() },
        annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({
        content: [{ type: 'text', text: `${process.env.FIXTURE_GREETING ?? ''}${text}` }],
    })
);
server.registerTool('pixel', { description: 'Return a one-byte image.' }, async () => ({
    content: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
}));
server.registerTool('fail', { description: 'Always fail.' }, async () => ({
    content: [{ type: 'text', text: 'it broke' }],
    isError: true,
}));
await server.connect(new StdioServerTransport());
