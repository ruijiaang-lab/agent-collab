#!/usr/bin/env node
const baseUrl = process.env.AGENT_COLLAB_URL || "http://127.0.0.1:5057";
const [command, ...args] = process.argv.slice(2);

function usage() {
  console.log(`Usage:
  npm run agent -- state
  npm run agent -- post <agent> <message>
  npm run agent -- task <title> [--owner codex|claude-code|hermes] [--priority high|medium|low] [--desc text]
  npm run agent -- claim <taskId> <agent>
  npm run agent -- status <taskId> <todo|doing|review|done|blocked> <agent> [note]
  npm run agent -- done <taskId> <agent> [note]
  npm run agent -- decision <title> <rationale>
  npm run agent -- handoff <leadAgent> <nextAction> [blockers]
  npm run agent -- export
`);
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const body = text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
  if (!response.ok) throw new Error(typeof body === "string" ? body : body.error);
  return body;
}

function getFlag(name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

function withoutFlags(values) {
  const result = [];
  for (let index = 0; index < values.length; index += 1) {
    if (values[index].startsWith("--")) {
      index += 1;
    } else {
      result.push(values[index]);
    }
  }
  return result;
}

try {
  if (!command || command === "help") {
    usage();
  } else if (command === "state") {
    console.log(JSON.stringify(await request("/api/state"), null, 2));
  } else if (command === "post") {
    const [agent, ...message] = args;
    console.log(JSON.stringify(await request("/api/messages", {
      method: "POST",
      body: { agent, content: message.join(" ") }
    }), null, 2));
  } else if (command === "task") {
    const title = withoutFlags(args).join(" ");
    console.log(JSON.stringify(await request("/api/tasks", {
      method: "POST",
      body: {
        title,
        owner: getFlag("--owner", "unassigned"),
        priority: getFlag("--priority", "medium"),
        description: getFlag("--desc", ""),
        createdBy: getFlag("--by", "system")
      }
    }), null, 2));
  } else if (command === "claim") {
    const [taskId, agent] = args;
    console.log(JSON.stringify(await request(`/api/tasks/${taskId}`, {
      method: "PATCH",
      body: { owner: agent, status: "doing", agent, note: `${agent} 已认领任务` }
    }), null, 2));
  } else if (command === "status") {
    const [taskId, status, agent, ...note] = args;
    console.log(JSON.stringify(await request(`/api/tasks/${taskId}`, {
      method: "PATCH",
      body: { status, agent, note: note.join(" ") || `${agent} 将任务状态更新为 ${status}` }
    }), null, 2));
  } else if (command === "done") {
    const [taskId, agent, ...note] = args;
    console.log(JSON.stringify(await request(`/api/tasks/${taskId}`, {
      method: "PATCH",
      body: { status: "done", agent, note: note.join(" ") || `${agent} 已完成任务` }
    }), null, 2));
  } else if (command === "decision") {
    const [title, ...rationale] = args;
    console.log(JSON.stringify(await request("/api/decisions", {
      method: "POST",
      body: { title, rationale: rationale.join(" "), agent: "system" }
    }), null, 2));
  } else if (command === "handoff") {
    const [currentLead, nextAction, blockers = ""] = args;
    console.log(JSON.stringify(await request("/api/handoff", {
      method: "PATCH",
      body: { currentLead, nextAction, blockers, agent: currentLead }
    }), null, 2));
  } else if (command === "export") {
    console.log(await request("/api/export"));
  } else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
