export const REQUIRED_MCP_SERVERS = ["slack", "atlassian"];

export function parseMcpConfig(raw, source = "MCP config") {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${source} is not valid JSON: ${e.message}`);
  }
  return validateMcpConfig(parsed, source);
}

export function validateMcpConfig(config, source = "MCP config") {
  if (!isPlainObject(config)) {
    throw new Error(`${source} must be a JSON object`);
  }
  if (!isPlainObject(config.mcpServers)) {
    throw new Error(`${source} must contain an object at mcpServers`);
  }

  for (const name of REQUIRED_MCP_SERVERS) {
    const server = config.mcpServers[name];
    if (!isPlainObject(server)) {
      throw new Error(`${source} must define mcpServers.${name}`);
    }
    if (!hasTransport(server)) {
      throw new Error(
        `${source} mcpServers.${name} must define a stdio command or remote url`
      );
    }
  }

  return config;
}

export function mergeClaudeMcpConfig(current, incoming) {
  const base = isPlainObject(current) ? { ...current } : {};
  const validated = validateMcpConfig(incoming);
  const existingServers = isPlainObject(base.mcpServers) ? base.mcpServers : {};

  return {
    ...base,
    mcpServers: {
      ...existingServers,
      ...validated.mcpServers,
    },
  };
}

function hasTransport(server) {
  return (
    typeof server.command === "string" ||
    typeof server.url === "string" ||
    typeof server.transport === "string"
  );
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
