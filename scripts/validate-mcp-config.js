#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseMcpConfig, REQUIRED_MCP_SERVERS } from "../lib/mcp-config.js";

const file = process.argv[2];

if (!file) {
  console.error("usage: node scripts/validate-mcp-config.js <mcp-config.json>");
  process.exit(64);
}

try {
  parseMcpConfig(await readFile(file, "utf8"), file);
  console.log(`ok: ${file} defines ${REQUIRED_MCP_SERVERS.join(" + ")} MCP servers`);
} catch (e) {
  console.error(`invalid MCP config: ${e.message}`);
  process.exit(1);
}
