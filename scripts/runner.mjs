// agent-collab v0.4 · subprocess runner for real agents.
//
// What this does
// --------------
// Given an agent id (e.g. "claude-code", "hermes"), this module:
//   1. Builds a structured prompt from the current state.json
//   2. Spawns the agent's local CLI (`claude -p`, `hermes -z`, …) — uses
//      whatever the user has *already logged into*. NEVER reads API keys.
//   3. Captures stdout, peels the CLI-specific wrapper, parses the
//      ONE-JSON-ENVELOPE the agent is told to emit
//   4. Dispatches the envelope's action through helpers injected by server.js
//      (post_message / cast_vote / propose_motion / advance floor)
//   5. Releases the per-agent lock, broadcasts SSE
//
// Safety
// ------
//   - Per-agent in-flight lock (one subprocess per agent at a time)
//   - 90s timeout, SIGKILL on overrun
//   - --max-budget-usd 0.50 hard cap on Claude
//   - Output parse failures fall back to post_message with raw stdout
//   - Chair lane is not runnable from here
//
// Auto mode
// ---------
//   When state.meeting.autoMode is on and autoRoundsRemaining > 0, server.js
//   calls scheduleAuto(newFloor) after any floor change. We honour the
//   countdown and refuse to spawn when it hits 0.

import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Dependency injection — server.js passes its state + helpers in via init().
// ---------------------------------------------------------------------------

let deps = null;

export function init(injected) {
  deps = injected;
}

function requireDeps() {
  if (!deps) throw new Error("runner.init() not called");
  return deps;
}

// ---------------------------------------------------------------------------
// Agent configuration. Each entry describes how to spawn the local CLI.
// To add a new agent, register it here; no other change needed.
// ---------------------------------------------------------------------------

export const agentConfigs = {
  "claude-code": {
    bin: process.env.AGENT_COLLAB_CLAUDE_BIN || "claude",
    // --model haiku → ~10x cheaper and ~3x faster than the default Opus route,
    // which matters because we're spawning per-turn. --max-budget-usd caps a
    // single call from blowing up if the model wanders. 180s is the empirical
    // ceiling we've seen for a full prompt; below that we get spurious timeouts.
    args: ["-p", "--output-format", "json", "--model", "haiku", "--max-budget-usd", "0.50"],
    inputVia: "arg",
    parseWrapper: "claude-json",
    timeoutMs: 180_000,
    enabled: true
  },
  hermes: {
    bin: process.env.AGENT_COLLAB_HERMES_BIN || "hermes",
    args: ["-z"],
    inputVia: "arg",
    parseWrapper: "raw",
    timeoutMs: 180_000,
    enabled: true
  },
  codex: {
    bin: process.env.AGENT_COLLAB_CODEX_BIN || "codex",
    args: ["exec"],
    inputVia: "stdin",
    parseWrapper: "raw",
    timeoutMs: 180_000,
    // Disabled until the user installs Codex CLI. UI will surface this.
    enabled: false
  }
};

// ---------------------------------------------------------------------------
// In-flight tracking + auto-mode state. Module-level singletons; the server
// is a single process so this is fine.
// ---------------------------------------------------------------------------

const inflight = new Set();

export function getInflight() {
  return new Set(inflight);
}

export function isInflight(agentId) {
  return inflight.has(agentId);
}

// ---------------------------------------------------------------------------
// Prompt construction. Builds a structured Chinese system prompt that tells
// the agent who they are, what the meeting looks like, and what JSON envelope
// they must output.
// ---------------------------------------------------------------------------

function summarizeDirectives(directives) {
  const active = directives
    .filter((d) => d.status === "active")
    .sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority))
    .slice(0, 5);
  if (active.length === 0) return "（暂无）";
  return active.map((d) => `• [${d.priority}] ${d.title}\n  ${d.content}`).join("\n");
}

function priorityWeight(p) {
  return { highest: 3, high: 2, normal: 1, low: 0 }[p] ?? 1;
}

function summarizeMotions(motions) {
  const open = motions.filter((m) => m.status === "proposed");
  if (open.length === 0) return "（暂无待决议提案）";
  return open.map((m) => {
    const tally = tallyVotes(m.votes || []);
    const myVote = ""; // could mark per agent later
    return `• [${m.id}] ${m.title}\n  提案人：${m.proposedBy} · 票型：支持${tally.support}/反对${tally.oppose}/弃权${tally.abstain}\n  理由：${m.rationale}`;
  }).join("\n");
}

function tallyVotes(votes) {
  return {
    support: votes.filter((v) => v.position === "support").length,
    oppose: votes.filter((v) => v.position === "oppose").length,
    abstain: votes.filter((v) => v.position === "abstain").length
  };
}

function summarizeRecentMessages(messages, agentDisplayName, limit = 15) {
  const recent = messages.slice(-limit);
  return recent.map((m) => {
    const who = agentDisplayName(m.agent);
    const stance = stanceFromMessage(m);
    return `R${m.round || 1} · ${who} · ${stance}: ${m.content}`.trim();
  }).join("\n");
}

function stanceFromMessage(message) {
  const stanceMatch = message.content.match(/^\[(.+?)\]/);
  if (stanceMatch) return stanceMatch[1];
  const labels = {
    motion: "提案",
    "motion-vote": "投票",
    "chair-ruling": "主席裁决",
    "chair-directive": "主席指令",
    reprompt: "Re-prompt",
    handoff: "交接",
    turn: "发言"
  };
  return labels[message.type] || message.type;
}

export function buildPrompt(agentId) {
  const { getState, agentDisplayName } = requireDeps();
  const state = getState();
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) throw new Error(`unknown agent: ${agentId}`);

  const otherAgents = state.agents
    .filter((a) => a.id !== agentId)
    .map((a) => `${a.name}（${a.role}）`)
    .join("、");

  return `你是 **${agent.name}**（角色：${agent.role}），正在参加一场圆桌会议。
主席是人类用户，最终裁决权在主席手里。你只能 **建议 / 质询 / 表态 / 投票 / 提案**，不能替主席下结论。
其他参会方：${otherAgents}。

== 当前会议 ==
议题：${state.meeting.title}
目标：${state.meeting.objective}
阶段：${state.meeting.phase} · 轮次：R${state.meeting.round}
当前发言权：你（${agent.name}）

== 主席指令（高优先级在前）==
${summarizeDirectives(state.directives)}

== 待决议提案 ==
${summarizeMotions(state.motions)}

== 最近发言（旧→新，最多 15 条）==
${summarizeRecentMessages(state.messages, agentDisplayName)}

== 你的任务 ==
基于以上上下文，**选择一个最合适的动作**并输出。要求：
1. **只输出一个 JSON 对象**，不要 markdown、不要解释、不要 \`\`\` 包裹。
2. 用中文。
3. content 控制在 200 字以内（propose_motion 的 rationale 可放到 400 字）。
4. 一次只做一个动作。

JSON 字段规范：
{
  "action": "post_message" | "cast_vote" | "propose_motion" | "do_nothing",
  "stance":   "观点" | "质询" | "风险" | "执行计划" | "复盘",     // post_message 时填
  "content":  "发言文字 / 投票理由 / 提案补充说明",
  "position": "support" | "oppose" | "abstain",                  // cast_vote 时填
  "motionId": "提案 ID（见上方待决议提案的方括号）",                 // cast_vote 时填
  "title":    "提案标题",                                          // propose_motion 时填
  "rationale":"提案理由",                                          // propose_motion 时填
  "nextFloor":"chair" | "codex" | "claude-code" | "hermes"        // 你认为下一棒交给谁
}

判断 nextFloor 的常识：
- 你刚摘要/拆分了 brief → 交给具体执行方（codex / claude-code）
- 你刚投票 / 提出观点，等其他方表态 → 交给另一个 agent
- 你认为可以收口、需要主席裁决 → 交给 chair
- 你没什么要补充的 → action 用 "do_nothing"，nextFloor 用 "chair"`;
}

// ---------------------------------------------------------------------------
// Output parsing. CLI-specific wrapper peeling + envelope JSON.parse, with a
// safe fallback so a misbehaving model can never wedge the meeting.
// ---------------------------------------------------------------------------

export function parseEnvelope(rawStdout, parseWrapper) {
  const cleaned = (rawStdout || "").trim();
  if (!cleaned) return fallbackEnvelope("（无输出）");

  let innerText = cleaned;
  if (parseWrapper === "claude-json") {
    try {
      const wrapper = JSON.parse(cleaned);
      innerText = wrapper.result || wrapper.message || wrapper.content || cleaned;
    } catch {
      // wrapper parse failed — treat the whole thing as the inner text
      innerText = cleaned;
    }
  }

  const jsonBlock = extractLastJsonObject(innerText);
  if (!jsonBlock) return fallbackEnvelope(innerText);

  try {
    const env = JSON.parse(jsonBlock);
    return normalizeEnvelope(env, innerText);
  } catch {
    return fallbackEnvelope(innerText);
  }
}

// Find the last balanced {...} block in a string. Handles models that wrap
// JSON in markdown fences or chatter around it.
function extractLastJsonObject(text) {
  let depth = 0;
  let start = -1;
  let lastBlock = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        lastBlock = text.slice(start, i + 1);
        start = -1;
      }
    }
  }
  return lastBlock;
}

function normalizeEnvelope(raw, fallbackContent) {
  const action = ["post_message", "cast_vote", "propose_motion", "do_nothing"].includes(raw.action)
    ? raw.action
    : "post_message";
  return {
    action,
    stance: typeof raw.stance === "string" ? raw.stance : "观点",
    content: typeof raw.content === "string" && raw.content.trim() ? raw.content : fallbackContent,
    position: ["support", "oppose", "abstain"].includes(raw.position) ? raw.position : null,
    motionId: typeof raw.motionId === "string" ? raw.motionId : null,
    title: typeof raw.title === "string" ? raw.title : null,
    rationale: typeof raw.rationale === "string" ? raw.rationale : null,
    nextFloor: ["chair", "codex", "claude-code", "hermes"].includes(raw.nextFloor) ? raw.nextFloor : "chair"
  };
}

function fallbackEnvelope(rawText) {
  return {
    action: "post_message",
    stance: "观点",
    content: rawText.slice(0, 800),
    position: null,
    motionId: null,
    title: null,
    rationale: null,
    nextFloor: "chair",
    _fallback: true
  };
}

// ---------------------------------------------------------------------------
// Dispatch — turn a parsed envelope into actual state mutations via the
// helpers server.js injected. Returns a summary of what changed.
// ---------------------------------------------------------------------------

export async function dispatchAction(agentId, envelope) {
  const { addMessage, castVote, proposeMotion, setFloor, recordEvent } = requireDeps();
  const summary = { action: envelope.action, ok: true };

  switch (envelope.action) {
    case "post_message":
      addMessage({
        agent: agentId,
        type: "turn",
        content: `[${envelope.stance}] ${envelope.content}`
      });
      break;

    case "cast_vote":
      if (!envelope.motionId || !envelope.position) {
        summary.ok = false;
        summary.error = "missing motionId or position";
        addMessage({
          agent: agentId,
          type: "turn",
          content: `[观点] ${envelope.content}（注：原意似乎是投票，但 motionId/position 缺失）`
        });
        break;
      }
      try {
        castVote({
          motionId: envelope.motionId,
          agent: agentId,
          position: envelope.position,
          reason: envelope.content || ""
        });
      } catch (error) {
        summary.ok = false;
        summary.error = error.message;
      }
      break;

    case "propose_motion":
      if (!envelope.title || !envelope.rationale) {
        summary.ok = false;
        summary.error = "missing title or rationale";
        addMessage({
          agent: agentId,
          type: "turn",
          content: `[观点] ${envelope.content || "（无内容）"}`
        });
        break;
      }
      proposeMotion({
        title: envelope.title,
        rationale: envelope.rationale,
        proposedBy: agentId
      });
      break;

    case "do_nothing":
      recordEvent({
        type: "agent.silent",
        actor: agentId,
        payload: { reason: envelope.content || "（无补充）" }
      });
      break;
  }

  if (envelope.nextFloor && envelope.nextFloor !== "chair") {
    setFloor(envelope.nextFloor);
    summary.newFloor = envelope.nextFloor;
  } else {
    setFloor("chair");
    summary.newFloor = "chair";
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Subprocess runner. The headline export. Acquires the per-agent lock, spawns
// the CLI, parses, dispatches, releases the lock. Always returns a result
// object — never throws past the caller.
// ---------------------------------------------------------------------------

export async function runAgent(agentId, options = {}) {
  const { recordEvent, persist, broadcast } = requireDeps();
  const config = agentConfigs[agentId];

  if (!config) return { ok: false, error: `unknown agent: ${agentId}` };
  if (config.enabled === false) return { ok: false, error: `agent ${agentId} runner is disabled (CLI not installed?)` };
  if (inflight.has(agentId)) return { ok: false, error: `agent ${agentId} is already in-flight` };

  inflight.add(agentId);
  recordEvent({
    type: "agent.thinking",
    actor: agentId,
    payload: { triggeredBy: options.triggeredBy || "manual", bin: config.bin }
  });
  broadcast("inflight");
  await persist();

  let result;
  try {
    const prompt = buildPrompt(agentId);
    const rawStdout = await spawnAgent(config, prompt);
    const envelope = parseEnvelope(rawStdout, config.parseWrapper);
    const summary = await dispatchAction(agentId, envelope);

    recordEvent({
      type: "agent.responded",
      actor: agentId,
      payload: {
        action: envelope.action,
        fallback: envelope._fallback === true,
        newFloor: summary.newFloor,
        ok: summary.ok,
        error: summary.error
      }
    });

    result = { ok: true, envelope, summary };
  } catch (error) {
    recordEvent({
      type: "agent.failed",
      actor: agentId,
      payload: { error: error.message }
    });
    result = { ok: false, error: error.message };
  } finally {
    inflight.delete(agentId);
    await persist();
    broadcast("state");
    broadcast("inflight");
  }

  // Auto-mode countdown: if we just responded and auto is on, kick the new
  // floor agent. Decrement happens here so the per-cycle accounting is honest.
  await maybeContinueAuto(result, options);

  return result;
}

async function spawnAgent(config, prompt) {
  return new Promise((resolve, reject) => {
    const args = [...config.args];
    if (config.inputVia === "arg") args.push(prompt);

    const child = spawn(config.bin, args, {
      stdio: [config.inputVia === "stdin" ? "pipe" : "ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    if (config.inputVia === "stdin") {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`spawn timeout after ${config.timeoutMs}ms`));
    }, config.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`spawn ${config.bin}: ${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout) {
        return reject(new Error(`${config.bin} exited ${code}: ${stderr.slice(0, 500)}`));
      }
      resolve(stdout);
    });
  });
}

// ---------------------------------------------------------------------------
// Auto-mode bookkeeping. The server's floor-change hooks call
// scheduleAuto(newFloor); we honour the countdown and per-agent lock.
// ---------------------------------------------------------------------------

export function setAutoMode({ enabled, maxRounds }) {
  const { getState, persist, broadcast } = requireDeps();
  const state = getState();
  state.meeting.autoMode = !!enabled;
  if (typeof maxRounds === "number" && maxRounds > 0) {
    state.meeting.autoMaxRounds = Math.min(maxRounds, 50);
  }
  state.meeting.autoRoundsRemaining = state.meeting.autoMode
    ? (state.meeting.autoMaxRounds || 10)
    : 0;
  state.meeting.updatedAt = new Date().toISOString();
  broadcast("state");
  return persist().then(() => ({
    autoMode: state.meeting.autoMode,
    autoMaxRounds: state.meeting.autoMaxRounds,
    autoRoundsRemaining: state.meeting.autoRoundsRemaining
  }));
}

export function getAutoState() {
  const { getState } = requireDeps();
  const state = getState();
  return {
    autoMode: !!state.meeting.autoMode,
    autoMaxRounds: state.meeting.autoMaxRounds || 10,
    autoRoundsRemaining: state.meeting.autoRoundsRemaining || 0
  };
}

// Called externally by server.js after any floor change. We're the gatekeeper
// for whether to actually fire the next runner.
export function scheduleAuto(newFloor) {
  const { getState } = requireDeps();
  const state = getState();
  if (!state.meeting.autoMode) return;
  if (!newFloor || newFloor === "chair") return;
  if (!agentConfigs[newFloor] || agentConfigs[newFloor].enabled === false) return;
  if (inflight.has(newFloor)) return;
  if ((state.meeting.autoRoundsRemaining || 0) <= 0) return;

  state.meeting.autoRoundsRemaining = Math.max(0, (state.meeting.autoRoundsRemaining || 0) - 1);
  setImmediate(() => runAgent(newFloor, { triggeredBy: "auto" }));
}

async function maybeContinueAuto(result, _options) {
  if (!result?.ok) return;
  const newFloor = result.summary?.newFloor;
  if (!newFloor) return;
  scheduleAuto(newFloor);
}
