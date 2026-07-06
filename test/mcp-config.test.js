import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeClaudeMcpConfig,
  parseMcpConfig,
  validateMcpConfig,
} from "../lib/mcp-config.js";

const validConfig = {
  mcpServers: {
    slack: { command: "slack-mcp", args: [] },
    atlassian: { command: "atlassian-mcp", args: [] },
  },
};

test("validates Slack and Atlassian MCP servers", () => {
  assert.equal(validateMcpConfig(validConfig), validConfig);
});

test("rejects configs missing a required server", () => {
  assert.throws(
    () => validateMcpConfig({ mcpServers: { slack: { command: "slack-mcp" } } }),
    /mcpServers\.atlassian/
  );
});

test("rejects required servers without a transport", () => {
  assert.throws(
    () =>
      validateMcpConfig({
        mcpServers: {
          slack: { env: { SLACK_BOT_TOKEN: "from-local-secret-file" } },
          atlassian: { command: "atlassian-mcp" },
        },
      }),
    /mcpServers\.slack/
  );
});

test("parses JSON before validation", () => {
  assert.deepEqual(parseMcpConfig(JSON.stringify(validConfig)), validConfig);
  assert.throws(() => parseMcpConfig("{"), /not valid JSON/);
});

test("merges MCP servers without clobbering existing Claude settings", () => {
  const merged = mergeClaudeMcpConfig(
    {
      hasCompletedOnboarding: true,
      mcpServers: {
        github: { command: "github-mcp" },
      },
    },
    validConfig
  );

  assert.equal(merged.hasCompletedOnboarding, true);
  assert.deepEqual(Object.keys(merged.mcpServers).sort(), [
    "atlassian",
    "github",
    "slack",
  ]);
});
