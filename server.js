import http from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import {
  init as initRunner,
  runAgent,
  getInflight,
  setAutoMode,
  getAutoState,
  scheduleAuto,
  agentConfigs,
  concludeMeeting,
  getConclusionFormats
} from "./scripts/runner.mjs";
import { init as initConfig, getConfig, updateConfig as saveConfig, serializeYaml } from "./scripts/config.mjs";
import * as taskStore from "./scripts/tasks.mjs";
import {
  decompose,
  dispatch,
  synthesize,
  runRoundtable,
  continueDiscussion,
  askAgent
} from "./scripts/pipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5057);
const DATA_DIR = process.env.AGENT_COLLAB_DATA_DIR || path.join(__dirname, "data");
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
    autoMode: false,
    autoMaxRounds: 10,
    autoRoundsRemaining: 0,
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

// Simple-mode templates. Each is a small recipe that turns a one-shot brief
// from a non-technical user into a chair directive + auto-mode meeting. The
// front-end never surfaces "floor / motion / directive" — it only shows the
// brief box, the agent cards mid-discussion, and the conclusion at the end.
const SIMPLE_TEMPLATES = [
  {
    id: "compare",
    title: "三 AI 对比方案",
    icon: "📊",
    description: "在几个选项里选哪个？让 AI 分别从不同角度帮你权衡。",
    placeholder: "例：我在考虑用 React 还是 Vue 重构这个项目，团队 3 个人都没写过 Vue……",
    conclusion: "summary",
    buildDirective: (brief, agents) =>
      `用户面临一个需要权衡的选择。原始描述：\n\n"""\n${brief}\n"""\n\n` +
      `请参与讨论的 AI（${agents.join("、")}）各自完成以下任务：\n` +
      `1. 简短复述你理解到的核心选择是什么（一句话）。\n` +
      `2. 给出你倾向的那一个选项，并列 2-3 条具体理由（避免空话）。\n` +
      `3. 指出对方选项的最大风险或代价。\n\n` +
      `禁止：互相客套、和稀泥、输出"看情况"这种没有立场的结论。每人最多 200 字。`
  },
  {
    id: "critique",
    title: "三 AI 改稿",
    icon: "✍️",
    description: "贴一段文字（文案 / 邮件 / 简历 / PRD），让 AI 帮你诊断和改。",
    placeholder: "例：贴上你的初稿，告诉我们这是给谁看的、目的是什么……",
    conclusion: "actions",
    buildDirective: (brief, agents) =>
      `用户提交了一段需要改进的文字。原文 + 背景：\n\n"""\n${brief}\n"""\n\n` +
      `请参与讨论的 AI（${agents.join("、")}）各自完成以下任务：\n` +
      `1. 指出原文最致命的 1-2 个问题（结构 / 受众 / 语气 / 信息密度）。\n` +
      `2. 给出 1 段重写的开头（不超过 80 字），示范你建议的方向。\n` +
      `3. 列出 2-3 条具体可执行的修改清单。\n\n` +
      `禁止：泛泛说"可以更生动"。每条建议必须能直接动手改。`
  },
  {
    id: "plan",
    title: "三 AI 评计划",
    icon: "📅",
    description: "贴出你的计划或方案，让 AI 帮你挑漏洞、补盲点、排优先级。",
    placeholder: "例：我打算下个月发布新版本，目前的计划是……",
    conclusion: "actions",
    buildDirective: (brief, agents) =>
      `用户提出了一份待评估的计划。计划描述：\n\n"""\n${brief}\n"""\n\n` +
      `请参与讨论的 AI（${agents.join("、")}）各自完成以下任务：\n` +
      `1. 用 1 句话总结你看到的最大盲点或风险。\n` +
      `2. 指出计划里被低估的工作量或前置条件。\n` +
      `3. 给出 2-3 条你建议立刻添加的行动项（带负责人建议）。\n\n` +
      `禁止：复述用户已经写过的内容。重点是补、挑、排。`
  },
  {
    id: "free",
    title: "自由讨论",
    icon: "💬",
    description: "想到什么写什么。AI 会按自己的视角接力，最后给你一份纪要。",
    placeholder: "例：今天我在思考……",
    conclusion: "summary",
    buildDirective: (brief, agents) =>
      `用户开启了一次开放式讨论。话题：\n\n"""\n${brief}\n"""\n\n` +
      `请参与讨论的 AI（${agents.join("、")}）按以下方式接力：\n` +
      `1. 不要重复前一位说过的论点。\n` +
      `2. 每人给出一个新的视角或问题，控制在 150 字以内。\n` +
      `3. 在结尾留下一个值得下一位接的问题。\n\n` +
      `禁止：罗列大纲式回答、写超过 200 字。`
  }
];

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
  // Backfill auto-mode fields added in v0.4 — older state.json predates them.
  if (typeof next.meeting.autoMode !== "boolean") next.meeting.autoMode = false;
  if (typeof next.meeting.autoMaxRounds !== "number") next.meeting.autoMaxRounds = 10;
  if (typeof next.meeting.autoRoundsRemaining !== "number") next.meeting.autoRoundsRemaining = 0;
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

// Shared helpers — used both by HTTP routes and by the v0.4 subprocess runner
// (scripts/runner.mjs) via dependency injection. Kept here so the route bodies
// and the runner dispatch path go through identical state-mutation logic.

function castVote({ motionId, agent, position, reason }) {
  const motion = state.motions.find((item) => item.id === motionId);
  if (!motion) throw new Error("motion not found");
  const voter = sanitizeText(agent);
  if (!voter || !["support", "oppose", "abstain"].includes(position)) {
    throw new Error("agent and position (support|oppose|abstain) are required");
  }
  if (!Array.isArray(motion.votes)) motion.votes = [];
  motion.votes = motion.votes.filter((vote) => vote.agent !== voter);
  const vote = {
    agent: voter,
    position,
    reason: sanitizeText(reason),
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
  return { motion, vote };
}

function proposeMotion({ title, rationale, proposedBy }) {
  const motion = {
    id: id(),
    title: sanitizeText(title),
    rationale: sanitizeText(rationale),
    proposedBy: sanitizeText(proposedBy, "codex"),
    status: "proposed",
    ruling: "",
    votes: [],
    meetingId: state.meeting?.id || null,
    round: state.meeting?.round || 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (!motion.title || !motion.rationale) throw new Error("title and rationale are required");
  state.motions.unshift(motion);
  addMessage({ agent: motion.proposedBy, type: "motion", content: `提出提案：${motion.title}\n${motion.rationale}` });
  recordEvent({
    type: "motion.proposed",
    actor: motion.proposedBy,
    payload: { title: motion.title, rationale: motion.rationale },
    refs: { motionId: motion.id }
  });
  return motion;
}

function setFloor(agentId) {
  const newFloor = sanitizeText(agentId, state.meeting.floor);
  state.meeting.floor = newFloor;
  state.meeting.updatedAt = new Date().toISOString();
  return newFloor;
}

// Inject everything the runner needs. The runner holds no state of its own —
// just the per-agent in-flight lock — and asks for a fresh state snapshot via
// getState() each call so we never serve stale data.
initRunner({
  getState: () => state,
  agentDisplayName,
  addMessage,
  castVote,
  proposeMotion,
  setFloor,
  recordEvent,
  persist,
  broadcast,
  id
});

// Pipeline: config + task storage
initConfig();
taskStore.init();

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
    const previousFloor = state.meeting.floor;
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
    if (state.meeting.floor !== previousFloor) scheduleAuto(state.meeting.floor);
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
    const previousFloor = state.meeting.floor;
    const message = addMessage({ agent, type: "turn", content: `【${stance}】${content}` });
    if (body.nextFloor) state.meeting.floor = sanitizeText(body.nextFloor, state.meeting.floor);
    await persist();
    broadcast();
    if (state.meeting.floor !== previousFloor) scheduleAuto(state.meeting.floor);
    return json(res, 201, message);
  }

  if (req.method === "POST" && url.pathname === "/api/motions") {
    const body = await readJson(req);
    try {
      const motion = proposeMotion({ title: body.title, rationale: body.rationale, proposedBy: body.proposedBy });
      await persist();
      broadcast();
      return json(res, 201, motion);
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  // Agent voting on a motion. Agents express position (support/oppose/abstain)
  // + short reason, before the chair rules. Multiple votes from the same agent
  // overwrite the previous one (last-write-wins on agent identity).
  const motionVoteMatch = url.pathname.match(/^\/api\/motions\/([^/]+)\/votes$/);
  if (req.method === "POST" && motionVoteMatch) {
    const body = await readJson(req);
    try {
      const { vote } = castVote({
        motionId: motionVoteMatch[1],
        agent: body.agent,
        position: body.position,
        reason: body.reason
      });
      await persist();
      broadcast();
      return json(res, 201, vote);
    } catch (error) {
      const status = error.message === "motion not found" ? 404 : 400;
      return json(res, status, { error: error.message });
    }
  }

  const motionMatch = url.pathname.match(/^\/api\/motions\/([^/]+)$/);
  if (req.method === "PATCH" && motionMatch) {
    const body = await readJson(req);
    const motion = state.motions.find((item) => item.id === motionMatch[1]);
    if (!motion) return json(res, 404, { error: "motion not found" });
    const previousStatus = motion.status;
    const previousFloor = state.meeting.floor;
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
    if (state.meeting.floor !== previousFloor) scheduleAuto(state.meeting.floor);
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

  // v0.4 — manual wake button. Spawns the agent's local CLI (claude / hermes /
  // codex) using whatever the user is already logged into. Never reads API keys.
  // Returns immediately once the subprocess is launched; the actual reply lands
  // via persist() + broadcast() once the runner finishes.
  const wakeMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/wake$/);
  if (req.method === "POST" && wakeMatch) {
    const agentId = wakeMatch[1];
    if (agentId === "chair") return json(res, 403, { error: "chair cannot be woken — chair is the human user" });
    const config = agentConfigs[agentId];
    if (!config) return json(res, 404, { error: `unknown agent: ${agentId}` });
    if (config.enabled === false) return json(res, 503, { error: `agent ${agentId} runner is disabled (CLI not installed?)` });
    if (getInflight().has(agentId)) return json(res, 409, { error: `agent ${agentId} is already in-flight` });
    // Fire-and-forget; the runner records its own events and broadcasts state
    // changes when done. Caller gets a 202 with the agentId so the WebUI can
    // flip the "thinking" indicator immediately.
    setImmediate(() => runAgent(agentId, { triggeredBy: "manual" }));
    return json(res, 202, { ok: true, agentId, triggeredBy: "manual" });
  }

  if (req.method === "PATCH" && url.pathname === "/api/meeting/auto") {
    const body = await readJson(req);
    const result = await setAutoMode({ enabled: body.enabled, maxRounds: body.maxRounds });
    addMessage({
      agent: "chair",
      type: "meeting",
      content: result.autoMode
        ? `开启自动模式：剩余 ${result.autoRoundsRemaining} 轮（每轮上限 ${result.autoMaxRounds}）`
        : `关闭自动模式`
    });
    await persist();
    broadcast();
    // If we just enabled auto mode and someone is already holding the floor,
    // kick them so the human doesn't have to click anything.
    if (result.autoMode && state.meeting.floor !== "chair") scheduleAuto(state.meeting.floor);
    return json(res, 200, result);
  }

  if (req.method === "GET" && url.pathname === "/api/agents/inflight") {
    return json(res, 200, {
      inflight: Array.from(getInflight()),
      auto: getAutoState(),
      configs: Object.fromEntries(
        Object.entries(agentConfigs).map(([id, cfg]) => [id, { bin: cfg.bin, enabled: cfg.enabled !== false }])
      )
    });
  }

  // Conclusion mode. Picks an agent to synthesize the round's discussion into
  // a structured deliverable (summary / actions / weekly). Different from a
  // normal turn: no envelope, no floor change, output lands in decisions[].
  if (req.method === "GET" && url.pathname === "/api/meeting/conclude/formats") {
    return json(res, 200, { formats: getConclusionFormats() });
  }

  if (req.method === "POST" && url.pathname === "/api/meeting/conclude") {
    const body = await readJson(req);
    const agentId = sanitizeText(body.agent);
    const format = sanitizeText(body.format, "summary");
    if (!agentId) return json(res, 400, { error: "agent is required" });
    if (agentId === "chair") return json(res, 403, { error: "chair cannot synthesize — pick claude-code / hermes / codex" });
    const config = agentConfigs[agentId];
    if (!config) return json(res, 404, { error: `unknown agent: ${agentId}` });
    if (config.enabled === false) return json(res, 503, { error: `agent ${agentId} runner is disabled (CLI not installed?)` });
    if (getInflight().has(agentId)) return json(res, 409, { error: `agent ${agentId} is already in-flight` });
    // Synchronous wait so the WebUI can show the resulting decision card.
    // Real cost: 20-60s on haiku; UI surfaces a spinner.
    const result = await concludeMeeting({ agentId, format, triggeredBy: "manual" });
    if (!result.ok) return json(res, 502, { error: result.error });
    return json(res, 201, { ok: true, decision: result.decision });
  }

  // ---------------------------------------------------------------------------
  // Simple-mode sessions. The "newbie" path: user picks a template + types a
  // brief; the server sets up the whole meeting in one call, kicks the auto
  // chain, and the front-end watches via SSE until the chain returns to chair,
  // then triggers conclude. No floor / motion / directive concepts surfaced.
  // ---------------------------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/api/sessions/templates") {
    return json(res, 200, { templates: SIMPLE_TEMPLATES.map(({ id, title, icon, description, placeholder }) => ({
      id, title, icon, description, placeholder
    })) });
  }

  if (req.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJson(req);
    const templateId = sanitizeText(body.template, "free");
    const brief = sanitizeText(body.brief);
    if (!brief) return json(res, 400, { error: "brief is required" });
    const template = SIMPLE_TEMPLATES.find((t) => t.id === templateId) || SIMPLE_TEMPLATES[SIMPLE_TEMPLATES.length - 1];

    const enabledAgents = ["claude-code", "hermes", "codex"]
      .filter((id) => agentConfigs[id] && agentConfigs[id].enabled !== false);
    if (enabledAgents.length === 0) return json(res, 503, { error: "no agent runners enabled" });

    // Bump round so the new discussion is cleanly separable from past rounds.
    state.meeting.round = (state.meeting.round || 1) + 1;
    state.meeting.title = `${template.title} · ${brief.slice(0, 40)}${brief.length > 40 ? "…" : ""}`;
    state.meeting.objective = brief;
    state.meeting.phase = "debate";
    state.meeting.updatedAt = new Date().toISOString();

    const sessionId = id();
    state.meeting.session = {
      id: sessionId,
      templateId: template.id,
      sequence: enabledAgents,
      conclusionAgent: enabledAgents.includes("claude-code") ? "claude-code" : enabledAgents[0],
      conclusionFormat: template.conclusion,
      startedAt: new Date().toISOString(),
      status: "running"
    };

    const directive = {
      id: id(),
      title: `[${template.title}] ${brief.slice(0, 30)}${brief.length > 30 ? "…" : ""}`,
      content: template.buildDirective(brief, enabledAgents),
      priority: "highest",
      status: "active",
      createdAt: new Date().toISOString()
    };
    state.directives.unshift(directive);
    addMessage({ agent: "chair", type: "chair-directive", content: `${directive.title}\n${directive.content}` });

    // Enable auto with N rounds = number of agents (one turn each).
    await setAutoMode({ enabled: true, maxRounds: enabledAgents.length });
    state.meeting.floor = enabledAgents[0];

    recordEvent({
      type: "session.started",
      actor: "chair",
      payload: { sessionId, templateId: template.id, sequence: enabledAgents }
    });

    await persist();
    broadcast();
    scheduleAuto(state.meeting.floor);

    return json(res, 201, {
      sessionId,
      template: { id: template.id, title: template.title, icon: template.icon },
      sequence: enabledAgents,
      conclusionAgent: state.meeting.session.conclusionAgent,
      conclusionFormat: template.conclusion,
      startedRound: state.meeting.round
    });
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

  // =========================================================================
  // Pipeline: task management + settings + providers
  // =========================================================================

  // --- Settings (config.yaml) ---
  if (req.method === "GET" && url.pathname === "/api/settings") {
    return json(res, 200, { config: getConfig() });
  }
  if (req.method === "PUT" && url.pathname === "/api/settings") {
    const body = await readJson(req);
    const updated = saveConfig(body);
    return json(res, 200, { config: updated });
  }

  // --- Providers ---
  if (req.method === "GET" && url.pathname === "/api/providers") {
    const cfg = getConfig();
    const providers = {};
    for (const [id, p] of Object.entries(cfg.providers || {})) {
      const cliConfig = agentConfigs[id];
      providers[id] = {
        mode: p.mode,
        hasApiKey: !!(p.api_key),
        hasBaseUrl: !!(p.base_url),
        model: p.model || "(auto)",
        cliAvailable: !!(cliConfig && cliConfig.enabled !== false),
        enabled: p.enabled !== false
      };
    }
    return json(res, 200, { providers });
  }

  // --- Pipeline Tasks CRUD ---
  if (req.method === "POST" && url.pathname === "/api/v2/tasks") {
    const body = await readJson(req);
    if (!body.brief && !body.title) return json(res, 400, { error: "brief or title is required" });
    const task = taskStore.createTask({
      title: body.title,
      brief: body.brief,
      mode: body.mode || "roundtable",
      priority: body.priority || "normal",
      assignedAgents: body.agents || []
    });
    return json(res, 201, task);
  }

  if (req.method === "GET" && url.pathname === "/api/v2/tasks") {
    const status = url.searchParams.get("status") || undefined;
    const limit = Number(url.searchParams.get("limit") || 50);
    const tasks = taskStore.listTasks({ status, limit });
    return json(res, 200, { tasks });
  }

  const v2TaskMatch = url.pathname.match(/^\/api\/v2\/tasks\/([^/]+)$/);
  if (v2TaskMatch) {
    const taskId = v2TaskMatch[1];
    if (req.method === "GET") {
      const task = taskStore.getTask(taskId);
      if (!task) return json(res, 404, { error: "task not found" });
      return json(res, 200, task);
    }
    if (req.method === "DELETE") {
      const ok = taskStore.deleteTask(taskId);
      return json(res, ok ? 200 : 404, { ok });
    }
  }

  // --- Pipeline actions ---
  const v2DecomposeMatch = url.pathname.match(/^\/api\/v2\/tasks\/([^/]+)\/decompose$/);
  if (req.method === "POST" && v2DecomposeMatch) {
    const result = await decompose(v2DecomposeMatch[1]);
    return json(res, result.ok ? 200 : 500, result);
  }

  const v2DispatchMatch = url.pathname.match(/^\/api\/v2\/tasks\/([^/]+)\/dispatch$/);
  if (req.method === "POST" && v2DispatchMatch) {
    const result = await dispatch(v2DispatchMatch[1]);
    return json(res, result.ok ? 200 : 500, result);
  }

  const v2SynthesizeMatch = url.pathname.match(/^\/api\/v2\/tasks\/([^/]+)\/synthesize$/);
  if (req.method === "POST" && v2SynthesizeMatch) {
    const result = await synthesize(v2SynthesizeMatch[1]);
    return json(res, result.ok ? 200 : 500, result);
  }

  const v2RunMatch = url.pathname.match(/^\/api\/v2\/tasks\/([^/]+)\/run$/);
  if (req.method === "POST" && v2RunMatch) {
    const task = taskStore.getTask(v2RunMatch[1]);
    if (!task) return json(res, 404, { error: "task not found" });
    let result;
    if (task.mode === "decompose") {
      result = await decompose(v2RunMatch[1]);
      if (result.ok) result = await dispatch(v2RunMatch[1]);
    } else {
      result = await runRoundtable(v2RunMatch[1]);
    }
    return json(res, result.ok ? 200 : 500, result);
  }

  const v2ContinueMatch = url.pathname.match(/^\/api\/v2\/tasks\/([^/]+)\/continue$/);
  if (req.method === "POST" && v2ContinueMatch) {
    const body = await readJson(req);
    if (!body.brief) return json(res, 400, { error: "brief is required" });
    const result = await continueDiscussion(v2ContinueMatch[1], body.brief);
    return json(res, result.ok ? 200 : 500, result);
  }

  const v2AskMatch = url.pathname.match(/^\/api\/v2\/tasks\/([^/]+)\/ask\/([^/]+)$/);
  if (req.method === "POST" && v2AskMatch) {
    const body = await readJson(req);
    if (!body.question) return json(res, 400, { error: "question is required" });
    const result = await askAgent(v2AskMatch[1], v2AskMatch[2], body.question);
    return json(res, result.ok ? 200 : 500, result);
  }

  const v2ReviewMatch = url.pathname.match(/^\/api\/v2\/tasks\/([^/]+)\/review$/);
  if (req.method === "POST" && v2ReviewMatch) {
    const body = await readJson(req);
    const status = body.status === "approved" ? "completed" : "pending";
    taskStore.updateTask(v2ReviewMatch[1], { reviewStatus: body.status, status });
    taskStore.appendLog(v2ReviewMatch[1], "review", body.status);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: "not found" });
}

async function serveStatic(req, res, url) {
  // Friendly aliases: "/" → simple-mode entry for non-tech users;
  // "/chair" → old chair-authority WebUI for people who want to drive manually.
  const aliases = {
    "/": "/simple.html",
    "/simple": "/simple.html",
    "/chair": "/index.html",
    "/tasks": "/tasks.html",
    "/settings": "/settings.html"
  };
  const requested = aliases[url.pathname] || decodeURIComponent(url.pathname);
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
    res.writeHead(200, {
      "content-type": types[ext] || "application/octet-stream",
      "cache-control": "no-cache, must-revalidate"
    });
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
