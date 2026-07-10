#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBacklot } from './backlot.js';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const backlot = createBacklot(config);
  const server = buildServer(backlot);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP protocol channel — all logging goes to stderr.
  console.error(`backlot-mcp ready — workspace: ${config.workspaceDir}`);
}

main().catch((error) => {
  console.error('backlot-mcp failed to start:', error);
  process.exit(1);
});
