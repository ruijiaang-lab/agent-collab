#!/usr/bin/env node
const baseUrl = process.env.AGENT_COLLAB_URL || "http://127.0.0.1:5057";
const debugFile = process.env.AGENT_COLLAB_MCP_DEBUG_FILE || "";
let buffer = Buffer.alloc(0);

const tools = [
  {
    name: "get_state",
    description: "Read current collaboration state: agents, messages, tasks, decisions, and handoff.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "post_message",
    description: "Post a message to the shared discussion stream.",
    inputSchema: {
      type: "object",
      required: ["agent", "content"],
      properties: {
        agent: { type: "string", enum: ["codex", "claude-code", "hermes", "system"] },
        content: { type: "string" }
      }
    }
  },
  {
    name: "create_task",
    description: "Create a shared task for one of the agents.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        owner: { type: "string", enum: ["unassigned", "codex", "claude-code", "hermes"] },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        createdBy: { type: "string" }
      }
    }
  },
  {
    name: "update_task",
    description: "Update a task owner, status, priority, title, description, or add a note.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: { type: "string" },
        owner: { type: "string" },
        status: { type: "string", enum: ["todo", "doing", "review", "done", "blocked"] },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        title: { type: "string" },
        description: { type: "string" },
        agent: { type: "string" },
        note: { type: "string" }
      }
    }
  },
  {
    name: "record_decision",
    description: "Record a decision and its rationale.",
    inputSchema: {
      type: "object",
      required: ["title", "rationale"],
      properties: {
        title: { type: "string" },
        rationale: { type: "string" },
        agent: { type: "string" }
      }
    }
  },
  {
    name: "update_handoff",
    description: "Update current lead, next action, and blockers.",
    inputSchema: {
      type: "object",
      required: ["currentLead", "nextAction"],
      properties: {
        currentLead: { type: "string", enum: ["codex", "claude-code", "hermes"] },
        nextAction: { type: "string" },
        blockers: { type: "string" },
        agent: { type: "string" }
      }
    }
  },
  {
    name: "export_handoff",
    description: "Export the current collaboration handoff as Markdown.",
    inputSchema: { type: "object", properties: {} }
  }
];

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const body = isJson && text ? JSON.parse(text) : text;
  if (!response.ok) throw new Error(typeof body === "string" ? body : body.error);
  return body;
}

async function callTool(name, args = {}) {
  if (name === "get_state") return api("/api/state");
  if (name === "post_message") return api("/api/messages", { method: "POST", body: args });
  if (name === "create_task") return api("/api/tasks", { method: "POST", body: args });
  if (name === "update_task") {
    const { taskId, ...body } = args;
    return api(`/api/tasks/${taskId}`, { method: "PATCH", body });
  }
  if (name === "record_decision") return api("/api/decisions", { method: "POST", body: args });
  if (name === "update_handoff") return api("/api/handoff", { method: "PATCH", body: args });
  if (name === "export_handoff") return api("/api/export");
  throw new Error(`Unknown tool: ${name}`);
}

function send(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function result(id, payload) {
  send({ jsonrpc: "2.0", id, result: payload });
}

function error(id, message, code = -32603) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message) {
  if (debugFile) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(debugFile, `${new Date().toISOString()} ${JSON.stringify(message)}\n`);
  }
  if (message.method === "initialize") {
    return result(message.id, {
      protocolVersion: message.params?.protocolVersion || "2024-11-05",
      capabilities: {
        tools: { listChanged: false },
        resources: {},
        prompts: {}
      },
      serverInfo: { name: "agent-collab", version: "0.1.0" }
    });
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "ping") return result(message.id, {});
  if (message.method === "tools/list") return result(message.id, { tools });
  if (message.method === "resources/list") return result(message.id, { resources: [] });
  if (message.method === "prompts/list") return result(message.id, { prompts: [] });
  if (message.method === "tools/call") {
    try {
      const output = await callTool(message.params.name, message.params.arguments || {});
      return result(message.id, {
        content: [
          {
            type: "text",
            text: typeof output === "string" ? output : JSON.stringify(output, null, 2)
          }
        ]
      });
    } catch (err) {
      return error(message.id, err.message);
    }
  }
  if (message.id !== undefined) error(message.id, `Unsupported method: ${message.method}`, -32601);
}

function parseMessages() {
  while (true) {
    let headerEnd = buffer.indexOf("\r\n\r\n");
    let separatorLength = 4;
    if (headerEnd === -1) {
      headerEnd = buffer.indexOf("\n\n");
      separatorLength = 2;
    }
    if (headerEnd === -1) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) return;
      const line = buffer.slice(0, lineEnd).toString("utf8").trim();
      if (!line.startsWith("{")) return;
      buffer = buffer.slice(lineEnd + 1);
      handle(JSON.parse(line)).catch((err) => error(null, err.message));
      continue;
    }
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = Buffer.alloc(0);
      return;
    }
    const length = Number(match[1]);
    const start = headerEnd + separatorLength;
    const end = start + length;
    if (buffer.length < end) return;
    const raw = buffer.slice(start, end).toString("utf8");
    buffer = buffer.slice(end);
    handle(JSON.parse(raw)).catch((err) => error(null, err.message));
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  parseMessages();
});
