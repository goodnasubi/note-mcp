#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// stdout は MCP の通信に使うので、ログは stderr に出す
const server = createServer();
await server.connect(new StdioServerTransport());
console.error("note-draft-mcp: stdio で起動しました（下書き保存専用）");
