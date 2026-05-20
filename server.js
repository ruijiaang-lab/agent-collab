import http from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5057);
const DATA_DIR = path.join(__dirname, "data");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const DEFAULT_STATE = {
  meta: {
    name: "圆桌会议控制台",
    workspace: "/Users/ssd",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  chair: {
    id: "chair",
    name: "主席",
    authority: "最高指令源和最终裁决者",
    rule: "Codex、Claude Code、Hermes 只能建议、质询、执行；会议结论以主席裁决为准。",
    color: "#f97316"
  },
  meeting: {
    id: id(),
    title: "三方圆桌会议",
    objective: "围绕用户议题进行讨论、分工和裁决。",
    phase: "open",
    floor: "chair",
    round: 1,
    agenda: [
      "主席提出议题和约束",
      "三方 agent 依次给出观点、风险、分工建议",
      "主席裁决最终方案和行动项"
    ],
    updatedAt: new Date().toISOString()
  },
  agents: [
    {
      id: "codex",
      name: "Codex",
      role: "工程实现、代码审查、测试、自动化落地",
      status: "online",
      color: "#3b82f6",
      endpoint: "local"
    },
    {
      id: "claude-code",
      name: "Claude Code",
      role: "Claude 生态、插件/Skill、代码实现与方案补充",
      status: "ready",
      color: "#8b5cf6",
      endpoint: "cli-helper"
    },
    {
      id: "hermes",
      name: "Hermes",
      role: "长期记忆、任务规划、上下文整理、跨渠道触达",
      status: "ready",
      color: "#10b981",
      endpoint: "cli-helper"
    }
  ],
  messages: [
    {
      id: id(),
      agent: "system",
      type: "system",
      content: "圆桌会议已初始化。主席拥有最高指令和最终裁决权，Codex / Claude Code / Hermes 作为参会 agent 提供建议、质询和执行。",
      createdAt: new Date().toISOString()
    }
  ],
  directives: [
    {
      id: id(),
      title: "会议主规则",
      content: "主席指令优先于 agent 建议；agent 需要说明假设、风险和可执行下一步；最终行动以主席裁决为准。",
      priority: "highest",
      status: "active",
      createdAt: new Date().toISOString()
    }
  ],
  motions: [],
  tasks: [
    {
      id: id(),
      title: "定义三方协作协议",
      description: "确定消息、任务、交接、决策四类协作对象的最小字段和使用规则。",
      owner: "codex",
      status: "done",
      priority: "high",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  ],
  decisions: [
    {
      id: id(),
      title: "使用本地 WebUI 作为共享协调层",
      rationale: "三方工具的直接互调能力不同，统一落到本地 API 和持久化文件最稳定，也便于后续加 MCP。",
      createdAt: new Date().toISOString()
    }
  ],
  events: [],
  handoff: {
    currentLead: "codex",
    nextAction: "在 WebUI 中创建真实任务，并把任务链接或 handoff 内容交给 Claude Code / Hermes。",
    blockers: "",
    updatedAt: new Date().toISOString()
  }
};

let state = ensureStateShape(await loadState());
const clients = new Set();
let writeQueue = Promise.resolve();

function id() {
  return crypto.randomUUID();
}

async function loadState() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch {
    await writeFile(STATE_PATH, JSON.stringify(DEFAULT_STATE, null, 2));
    return structuredClone(DEFAULT_STATE);
  }
}

function ensureStateShape(rawState) {
  const next = { ...rawState };
  next.meta = {
    ...DEFAULT_STATE.meta,
    ...(next.meta || {}),
    name: next.meta?.name || DEFAULT_STATE.meta.name
  };
  next.chair = next.chair || DEFAULT_STATE.chair;
  next.meeting = next.meeting || DEFAULT_STATE.meeting;
  next.directives = Array.isArray(next.directives) ? next.directives : DEFAULT_STATE.directives;
  next.motions = Array.isArray(next.motions) ? next.motions : [];
  next.agents = Array.isArray(next.agents) ? next.agents : DEFAULT_STATE.agents;
  next.messages = Array.isArray(next.messages) ? next.messages : DEFAULT_STATE.messages;
  next.tasks = Array.isArray(next.tasks) ? next.tasks : DEFAULT_STATE.tasks;
  next.decisions = Array.isArray(next.decisions) ? next.decisions : DEFAULT_STATE.decisions;
  next.events = Array.isArray(next.events) ? next.events : [];
  next.handoff = next.handoff || DEFAULT_STATE.handoff;

  // Backfill: ensure each motion has a votes array and decisionChain root.
  next.motions.forEach((motion) => {
    if (!Array.isArray(motion.votes)) motion.votes = [];
    if (!motion.meetingId) motion.meetingId = next.meeting.id;
    if (motion.round == null) motion.round = next.meeting.round || 1;
  });
  next.messages.forEach((message) => {
    if (!message.meetingId) message.meetingId = next.meeting.id;
    if (message.round == null) message.round = next.meeting.round || 1;
  });
  next.directives.forEach((directive) => {
    if (directive.meetingId == null) directive.meetingId = next.meeting.id;
  });
  next.tasks.forEach((task) => {
    if (task.meetingId == null) task.meetingId = next.meeting.id;
  });

  return next;
}

// Append-only event log. Every mutation that the chair / agents would want to
// audit later (proposals, votes, rulings, re-prompts, task transitions) goes
// through this so the timeline view and decisionChain can be reconstructed
// from history rather than from current-state inference.
function recordEvent({ type, actor, payload = {}, refs = {} }) {
  const event = {
    id: id(),
    type,
    actor: sanitizeText(actor, "system"),
    meetingId: state.meeting?.id || null,
    round: state.meeting?.round || 1,
    payload,
    refs,
    createdAt: new Date().toISOString()
  };
  state.events.push(event);
  return event;
}

function persist() {
  state.meta.updatedAt = new Date().toISOString();
  writeQueue = writeQueue.then(() => writeFile(STATE_PATH, JSON.stringify(state, null, 2)));
  return writeQueue;
}

function broadcast(event = "state") {
  const payload = `event: ${event}\ndata: ${JSON.stringify({ updatedAt: state.meta.updatedAt })}\n\n`;
  for (const res of clients) res.write(payload);
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sanitizeText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function agentDisplayName(agentId) {
  if (agentId === "chair") return state?.chair?.name || "主席";
  const agent = state?.agents?.find((item) => item.id === agentId);
  return agent?.name || agentId;
}

function addMessage({ agent, content, type = "message", taskId = null, meetingId = null, round = null }) {
  const message = {
    id: id(),
    agent: sanitizeText(agent, "system"),
    type: sanitizeText(type, "message"),
    taskId: taskId || null,
    meetingId: meetingId || state.meeting?.id || null,
    round: round ?? (state.meeting?.round || 1),
    content: sanitizeText(content),
    createdAt: new Date().toISOString()
  };
  if (!message.content) throw new Error("content is required");
  state.messages.push(message);
  return message;
}

function exportMarkdown() {
  const agentName = (agentId) => {
    if (agentId === "chair") return state.chair.name;
    return state.agents.find((agent) => agent.id === agentId)?.name || agentId;
  };
  const directiveLines = state.directives.map((directive) => {
    return `- [${directive.status}] ${directive.title} | priority: ${directive.priority}\n  ${directive.content}`;
  });
  const motionLines = state.motions.map((motion) => {
    return `- [${motion.status}] ${motion.title} | proposed by: ${agentName(motion.proposedBy)}\n  ${motion.rationale}\n  Chair ruling: ${motion.ruling || "N/A"}`;
  });
  const taskLines = state.tasks.map((task) => {
    return `- [${task.status}] ${task.title} | owner: ${agentName(task.owner || "unassigned")} | priority: ${task.priority}\n  ${task.description || ""}`;
  });
  const decisionLines = state.decisions.map((decision) => {
    return `- ${decision.title}: ${decision.rationale}`;
  });
  const messageLines = state.messages.slice(-30).map((message) => {
    return `- ${message.createdAt} ${agentName(message.agent)}: ${message.content}`;
  });

  return `# Agent Collaboration Handoff

Updated: ${state.meta.updatedAt}
Workspace: ${state.meta.workspace}

## Chair

Authority: ${state.chair.authority}
Rule: ${state.chair.rule}

## Meeting

Title: ${state.meeting.title}
Objective: ${state.meeting.objective}
Phase: ${state.meeting.phase}
Floor: ${agentName(state.meeting.floor)}
Round: ${state.meeting.round}

## Chair Directives

${directiveLines.join("\n")}

## Motions

${motionLines.join("\n")}

## Handoff

Lead: ${agentName(state.handoff.currentLead)}
Next action: ${state.handoff.nextAction || "N/A"}
Blockers: ${state.handoff.blockers || "N/A"}

## Tasks

${taskLines.join("\n")}

## Decisions

${decisionLines.join("\n")}

## Recent Discussion

${messageLines.join("\n")}
`;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, state);
  if (req.method === "GET" && url.pathname === "/api/export") {
    res.writeHead(200, {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "no-store"
    });
    return res.end(exportMarkdown());
  }

  if (req.method === "POST" && url.pathname === "/api/messages") {
    try {
      const message = addMessage(await readJson(req));
      await persist();
      broadcast();
      return json(res, 201, message);
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  if (req.method === "PATCH" && url.pathname === "/api/meeting") {
    const body = await readJson(req);
    for (const key of ["title", "objective", "phase", "floor"]) {
      if (body[key] !== undefined) state.meeting[key] = sanitizeText(body[key], state.meeting[key]);
    }
    if (body.round !== undefined) {
      const round = Number(body.round);
      if (Number.isFinite(round) && round > 0) state.meeting.round = round;
    }
    if (Array.isArray(body.agenda)) {
      state.meeting.agenda = body.agenda.map((item) => sanitizeText(item)).filter(Boolean);
    }
    state.meeting.updatedAt = new Date().toISOString();
    addMessage({ agent: body.agent || "chair", type: "meeting", content: `更新会议：${state.meeting.title} / ${state.meeting.phase}` });
    await persist();
    broadcast();
    return json(res, 200, state.meeting);
  }

  if (req.method === "POST" && url.pathname === "/api/chair/directives") {
    const body = await readJson(req);
    const directive = {
      id: id(),
      title: sanitizeText(body.title),
      content: sanitizeText(body.content),
      priority: sanitizeText(body.priority, "highest"),
      status: sanitizeText(body.status, "active"),
      createdAt: new Date().toISOString()
    };
    if (!directive.title || !directive.content) return json(res, 400, { error: "title and content are required" });
    state.directives.unshift(directive);
    addMessage({ agent: "chair", type: "chair-directive", content: `${directive.title}\n${directive.content}` });
    await persist();
    broadcast();
    return json(res, 201, directive);
  }

  if (req.method === "POST" && url.pathname === "/api/meeting/turns") {
    const body = await readJson(req);
    const agent = sanitizeText(body.agent, "codex");
    const stance = sanitizeText(body.stance, "发言");
    const content = sanitizeText(body.content);
    if (!content) return json(res, 400, { error: "content is required" });
    const message = addMessage({ agent, type: "roundtable-turn", content: `【${stance}】${content}` });
    if (body.nextFloor) state.meeting.floor = sanitizeText(body.nextFloor, state.meeting.floor);
    await persist();
    broadcast();
    return json(res, 201, message);
  }

  if (req.method === "POST" && url.pathname === "/api/motions") {
    const body = await readJson(req);
    const motion = {
      id: id(),
      title: sanitizeText(body.title),
      rationale: sanitizeText(body.rationale),
      proposedBy: sanitizeText(body.proposedBy, "codex"),
      status: "proposed",
      ruling: "",
      votes: [],
      meetingId: state.meeting?.id || null,
      round: state.meeting?.round || 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (!motion.title || !motion.rationale) return json(res, 400, { error: "title and rationale are required" });
    state.motions.unshift(motion);
    addMessage({ agent: motion.proposedBy, type: "motion", content: `提出提案：${motion.title}\n${motion.rationale}` });
    recordEvent({
      type: "motion.proposed",
      actor: motion.proposedBy,
      payload: { title: motion.title, rationale: motion.rationale },
      refs: { motionId: motion.id }
    });
    await persist();
    broadcast();
    return json(res, 201, motion);
  }

  // Agent voting on a motion. Agents express position (support/oppose/abstain)
  // + short reason, before the chair rules. Multiple votes from the same agent
  // overwrite the previous one (last-write-wins on agent identity).
  const motionVoteMatch = url.pathname.match(/^\/api\/motions\/([^/]+)\/votes$/);
  if (req.method === "POST" && motionVoteMatch) {
    const body = await readJson(req);
    const motion = state.motions.find((item) => item.id === motionVoteMatch[1]);
    if (!motion) return json(res, 404, { error: "motion not found" });
    const voter = sanitizeText(body.agent);
    const position = sanitizeText(body.position);
    if (!voter || !["support", "oppose", "abstain"].includes(position)) {
      return json(res, 400, { error: "agent and position (support|oppose|abstain) are required" });
    }
    if (!Array.isArray(motion.votes)) motion.votes = [];
    motion.votes = motion.votes.filter((vote) => vote.agent !== voter);
    const vote = {
      agent: voter,
      position,
      reason: sanitizeText(body.reason),
      round: state.meeting?.round || 1,
      createdAt: new Date().toISOString()
    };
    motion.votes.push(vote);
    motion.updatedAt = vote.createdAt;
    addMessage({
      agent: voter,
      type: "motion-vote",
      content: `对提案【${motion.title}】投${position === "support" ? "赞成" : position === "oppose" ? "反对" : "弃权"}票${vote.reason ? `：${vote.reason}` : ""}`
    });
    recordEvent({
      type: "motion.voted",
      actor: voter,
      payload: { position, reason: vote.reason },
      refs: { motionId: motion.id }
    });
    await persist();
    broadcast();
    return json(res, 201, vote);
  }

  const motionMatch = url.pathname.match(/^\/api\/motions\/([^/]+)$/);
  if (req.method === "PATCH" && motionMatch) {
    const body = await readJson(req);
    const motion = state.motions.find((item) => item.id === motionMatch[1]);
    if (!motion) return json(res, 404, { error: "motion not found" });
    const previousStatus = motion.status;
    if (body.status !== undefined) motion.status = sanitizeText(body.status, motion.status);
    if (body.ruling !== undefined) motion.ruling = sanitizeText(body.ruling, motion.ruling);
    motion.updatedAt = new Date().toISOString();
    addMessage({ agent: "chair", type: "chair-ruling", content: `裁决提案：${motion.title}\n状态：${motion.status}\n${motion.ruling}` });
    if (motion.status !== previousStatus) {
      recordEvent({
        type: "motion.ruled",
        actor: "chair",
        payload: { from: previousStatus, to: motion.status, ruling: motion.ruling },
        refs: { motionId: motion.id }
      });
    }

    // Auto re-prompt on rejection: closes issue #1.
    // When chair rejects a motion, push a high-priority directive carrying
    // the ruling, hand the floor back to the proposer, and bump the round
    // so the proposer's next turn lands in round + 1.
    if (
      motion.status === "rejected" &&
      previousStatus !== "rejected" &&
      !motion.repromptedAt
    ) {
      const directive = {
        id: id(),
        title: `Re-prompt：${motion.title}`,
        content: motion.ruling
          ? `主席否决理由：${motion.ruling}\n请 ${agentDisplayName(motion.proposedBy)} 据此修订方案后重新提案。`
          : `主席否决该提案。请 ${agentDisplayName(motion.proposedBy)} 修订后重新提案。`,
        priority: "high",
        status: "active",
        meetingId: state.meeting?.id || null,
        createdAt: new Date().toISOString(),
        sourceMotionId: motion.id
      };
      state.directives.unshift(directive);

      state.meeting.floor = motion.proposedBy;
      state.meeting.round = (Number(state.meeting.round) || 1) + 1;
      state.meeting.updatedAt = new Date().toISOString();

      motion.repromptedAt = new Date().toISOString();

      addMessage({
        agent: "system",
        type: "reprompt",
        content: `已自动 re-prompt ${agentDisplayName(motion.proposedBy)}（round ${state.meeting.round}）。否决理由已写入高优 directive。`
      });
      recordEvent({
        type: "motion.reprompted",
        actor: "system",
        payload: { proposer: motion.proposedBy, newRound: state.meeting.round },
        refs: { motionId: motion.id, directiveId: directive.id }
      });
    }

    await persist();
    broadcast();
    return json(res, 200, motion);
  }

  if (req.method === "POST" && url.pathname === "/api/tasks") {
    const body = await readJson(req);
    const task = {
      id: id(),
      title: sanitizeText(body.title),
      description: sanitizeText(body.description),
      owner: sanitizeText(body.owner, "unassigned"),
      status: sanitizeText(body.status, "todo"),
      priority: sanitizeText(body.priority, "medium"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (!task.title) return json(res, 400, { error: "title is required" });
    state.tasks.unshift(task);
    addMessage({ agent: body.createdBy || "system", type: "task", taskId: task.id, content: `创建任务：${task.title}` });
    await persist();
    broadcast();
    return json(res, 201, task);
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === "PATCH" && taskMatch) {
    const body = await readJson(req);
    const task = state.tasks.find((item) => item.id === taskMatch[1]);
    if (!task) return json(res, 404, { error: "task not found" });
    for (const key of ["title", "description", "owner", "status", "priority"]) {
      if (body[key] !== undefined) task[key] = sanitizeText(body[key]);
    }
    task.updatedAt = new Date().toISOString();
    if (body.note) addMessage({ agent: body.agent || task.owner || "system", type: "task", taskId: task.id, content: body.note });
    await persist();
    broadcast();
    return json(res, 200, task);
  }

  if (req.method === "POST" && url.pathname === "/api/decisions") {
    const body = await readJson(req);
    const decision = {
      id: id(),
      title: sanitizeText(body.title),
      rationale: sanitizeText(body.rationale),
      createdAt: new Date().toISOString()
    };
    if (!decision.title || !decision.rationale) return json(res, 400, { error: "title and rationale are required" });
    state.decisions.unshift(decision);
    addMessage({ agent: body.agent || "system", type: "decision", content: `记录决策：${decision.title}` });
    await persist();
    broadcast();
    return json(res, 201, decision);
  }

  if (req.method === "PATCH" && url.pathname === "/api/handoff") {
    const body = await readJson(req);
    state.handoff = {
      currentLead: sanitizeText(body.currentLead, state.handoff.currentLead),
      nextAction: sanitizeText(body.nextAction, state.handoff.nextAction),
      blockers: sanitizeText(body.blockers, state.handoff.blockers),
      updatedAt: new Date().toISOString()
    };
    addMessage({ agent: body.agent || "system", type: "handoff", content: `更新交接：${state.handoff.nextAction}` });
    await persist();
    broadcast();
    return json(res, 200, state.handoff);
  }

  // Server-sent events for WebUI live updates. Renamed from /api/events
  // (which is now the append-only event log) to /api/stream in v0.3.
  if (req.method === "GET" && (url.pathname === "/api/stream" || url.pathname === "/api/events/stream")) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    clients.add(res);
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    req.on("close", () => clients.delete(res));
    return;
  }

  // Append-only event log. Supports ?since=<isoTimestamp>, ?type=<eventType>,
  // ?motionId=, ?actor=, ?limit=<n>. Designed for decision-chain replay and
  // future time-travel debugging in the WebUI.
  if (req.method === "GET" && url.pathname === "/api/events") {
    const events = Array.isArray(state.events) ? state.events : [];
    const since = url.searchParams.get("since");
    const typeFilter = url.searchParams.get("type");
    const motionIdFilter = url.searchParams.get("motionId");
    const actorFilter = url.searchParams.get("actor");
    const limit = Math.min(Number(url.searchParams.get("limit")) || 500, 2000);
    let filtered = events;
    if (since) filtered = filtered.filter((event) => event.createdAt > since);
    if (typeFilter) filtered = filtered.filter((event) => event.type === typeFilter);
    if (motionIdFilter) filtered = filtered.filter((event) => event.refs?.motionId === motionIdFilter);
    if (actorFilter) filtered = filtered.filter((event) => event.actor === actorFilter);
    const sliced = filtered.slice(-limit);
    return json(res, 200, {
      total: events.length,
      filtered: filtered.length,
      returned: sliced.length,
      events: sliced
    });
  }

  // Decision chain for a single motion — the canonical "how did we arrive
  // here" view: proposal → votes → ruling → (optional) re-prompt → revisions.
  const motionChainMatch = url.pathname.match(/^\/api\/motions\/([^/]+)\/chain$/);
  if (req.method === "GET" && motionChainMatch) {
    const motionId = motionChainMatch[1];
    const motion = state.motions.find((item) => item.id === motionId);
    if (!motion) return json(res, 404, { error: "motion not found" });
    const events = Array.isArray(state.events) ? state.events : [];
    const chain = events
      .filter((event) => event.refs?.motionId === motionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return json(res, 200, { motion, chain });
  }

  return json(res, 404, { error: "not found" });
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "forbidden" });

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("not file");
    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml"
    };
    res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
    res.end(await readFile(filePath));
  } catch {
    json(res, 404, { error: "not found" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Agent Collab WebUI: http://127.0.0.1:${PORT}`);
  console.log(`State file: ${STATE_PATH}`);
});
