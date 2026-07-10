#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBroll } from './broll.js';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const broll = createBroll(config);
  const server = buildServer(broll);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP protocol channel — all logging goes to stderr.
  console.error(`broll-mcp ready — workspace: ${config.workspaceDir}`);
}

main().catch((error) => {
  console.error('broll-mcp failed to start:', error);
  process.exit(1);
});
