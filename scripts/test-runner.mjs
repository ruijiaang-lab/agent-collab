// v0.4 runner smoke test — no real CLI required.
//
// What this verifies
// ------------------
//   1. parseEnvelope() peels claude-json wrapper and falls back safely
//   2. extractLastJsonObject() finds the last balanced {...} block
//   3. dispatchAction() routes envelopes through injected helpers
//   4. Per-agent in-flight lock prevents concurrent runs of the same agent
//   5. spawn timeout produces an agent.failed event
//   6. Auto-mode countdown decrements and stops at 0
//
// We mock spawn by pointing the runner at `node -e '<script>'` which lets us
// produce arbitrary stdout deterministically without ever touching claude /
// hermes / codex. Real-CLI test is the user-facing v0.4 end-to-end run.

import { strict as assert } from "node:assert";
import {
  init,
  agentConfigs,
  buildPrompt,
  parseEnvelope,
  dispatchAction,
  runAgent,
  getInflight,
  setAutoMode,
  getAutoState
} from "./runner.mjs";

// ---- Mock state + helpers ------------------------------------------------

let mockState;
const events = [];
const messages = [];
const motions = [];

function resetState() {
  mockState = {
    meeting: {
      id: "test-meeting",
      title: "测试会议",
      objective: "验证 v0.4 runner",
      phase: "open",
      floor: "chair",
      round: 1,
      autoMode: false,
      autoMaxRounds: 10,
      autoRoundsRemaining: 0
    },
    agents: [
      { id: "codex", name: "Codex", role: "工程" },
      { id: "claude-code", name: "Claude Code", role: "Claude" },
      { id: "hermes", name: "Hermes", role: "记忆" }
    ],
    messages: [],
    directives: [],
    motions: []
  };
  events.length = 0;
  messages.length = 0;
  motions.length = 0;
}

resetState();

init({
  getState: () => mockState,
  agentDisplayName: (id) => mockState.agents.find((a) => a.id === id)?.name || id,
  addMessage: (msg) => { messages.push(msg); return msg; },
  castVote: ({ motionId, agent, position, reason }) => {
    const m = motions.find((x) => x.id === motionId);
    if (!m) throw new Error("motion not found");
    m.votes.push({ agent, position, reason });
    return { motion: m, vote: { agent, position, reason } };
  },
  proposeMotion: ({ title, rationale, proposedBy }) => {
    const m = { id: `m-${motions.length + 1}`, title, rationale, proposedBy, votes: [] };
    motions.push(m);
    return m;
  },
  setFloor: (id) => { mockState.meeting.floor = id; return id; },
  recordEvent: (e) => { events.push(e); return e; },
  persist: async () => {},
  broadcast: () => {}
});

// ---- Mock the agent CLI by swapping configs to `node -e` -----------------
// We mutate the exported config map in place so runAgent() uses our shim.

function mockClaudeAs(jsResultExpr) {
  // jsResultExpr is a JS expression evaluated server-side that becomes the
  // wrapper's `result` field. Mimics `claude -p --output-format json` output.
  agentConfigs["claude-code"] = {
    bin: process.execPath, // node
    args: ["-e", `process.stdout.write(JSON.stringify({type:"result",result:${jsResultExpr}}))`],
    inputVia: "arg",
    parseWrapper: "claude-json",
    timeoutMs: 2000,
    enabled: true
  };
}

function mockHermesAs(stdoutExpr) {
  agentConfigs.hermes = {
    bin: process.execPath,
    args: ["-e", `process.stdout.write(${stdoutExpr})`],
    inputVia: "arg",
    parseWrapper: "raw",
    timeoutMs: 2000,
    enabled: true
  };
}

function mockClaudeHang() {
  agentConfigs["claude-code"] = {
    bin: process.execPath,
    args: ["-e", "setTimeout(() => {}, 60000)"], // hangs forever
    inputVia: "arg",
    parseWrapper: "claude-json",
    timeoutMs: 300, // override short
    enabled: true
  };
}

// ---- Tests --------------------------------------------------------------

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`✓ ${name}`); })
    .catch((err) => { failed++; console.error(`✗ ${name}\n   ${err.message}`); });
}

await test("parseEnvelope peels claude-json wrapper", () => {
  const raw = JSON.stringify({
    type: "result",
    result: JSON.stringify({ action: "post_message", stance: "观点", content: "你好", nextFloor: "chair" })
  });
  const env = parseEnvelope(raw, "claude-json");
  assert.equal(env.action, "post_message");
  assert.equal(env.content, "你好");
  assert.equal(env.stance, "观点");
  assert.equal(env.nextFloor, "chair");
  assert.notEqual(env._fallback, true);
});

await test("parseEnvelope handles raw wrapper", () => {
  const env = parseEnvelope('{"action":"do_nothing","nextFloor":"hermes"}', "raw");
  assert.equal(env.action, "do_nothing");
  assert.equal(env.nextFloor, "hermes");
});

await test("parseEnvelope extracts JSON from markdown fences", () => {
  const text = "```json\n{\"action\":\"post_message\",\"content\":\"嗨\"}\n```";
  const env = parseEnvelope(text, "raw");
  assert.equal(env.action, "post_message");
  assert.equal(env.content, "嗨");
});

await test("parseEnvelope falls back when no JSON present", () => {
  const env = parseEnvelope("just a sentence with no json", "raw");
  assert.equal(env.action, "post_message");
  assert.equal(env._fallback, true);
  assert.ok(env.content.includes("just a sentence"));
});

await test("parseEnvelope falls back on garbage JSON", () => {
  const env = parseEnvelope("{not valid json}", "raw");
  assert.equal(env._fallback, true);
});

await test("parseEnvelope rejects unknown action and defaults to post_message", () => {
  const env = parseEnvelope('{"action":"hack_database","content":"oops"}', "raw");
  assert.equal(env.action, "post_message");
});

await test("buildPrompt includes agent name and meeting context", () => {
  resetState();
  const prompt = buildPrompt("codex");
  assert.ok(prompt.includes("Codex"));
  assert.ok(prompt.includes("测试会议"));
  assert.ok(prompt.includes("post_message"));
  assert.ok(prompt.includes("cast_vote"));
});

await test("dispatchAction post_message adds message and updates floor", async () => {
  resetState();
  await dispatchAction("codex", {
    action: "post_message",
    stance: "观点",
    content: "建议拆成两步",
    nextFloor: "claude-code"
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, "[观点] 建议拆成两步");
  assert.equal(mockState.meeting.floor, "claude-code");
});

await test("dispatchAction cast_vote calls castVote helper", async () => {
  resetState();
  motions.push({ id: "m-1", title: "test", votes: [] });
  await dispatchAction("hermes", {
    action: "cast_vote",
    motionId: "m-1",
    position: "support",
    content: "理由",
    nextFloor: "chair"
  });
  assert.equal(motions[0].votes.length, 1);
  assert.equal(motions[0].votes[0].position, "support");
});

await test("dispatchAction cast_vote without motionId falls back to message", async () => {
  resetState();
  const summary = await dispatchAction("hermes", {
    action: "cast_vote",
    motionId: null,
    position: null,
    content: "想投票但忘了 ID"
  });
  assert.equal(summary.ok, false);
  assert.equal(messages.length, 1);
  assert.ok(messages[0].content.includes("想投票"));
});

await test("dispatchAction propose_motion creates motion via helper", async () => {
  resetState();
  await dispatchAction("claude-code", {
    action: "propose_motion",
    title: "新提案",
    rationale: "理由很长",
    nextFloor: "chair"
  });
  assert.equal(motions.length, 1);
  assert.equal(motions[0].title, "新提案");
  assert.equal(motions[0].proposedBy, "claude-code");
});

await test("runAgent end-to-end: spawn mock claude → post_message → message + events", async () => {
  resetState();
  mockClaudeAs("JSON.stringify({action:'post_message',stance:'观点',content:'mock 答复',nextFloor:'chair'})");
  const result = await runAgent("claude-code", { triggeredBy: "test" });
  assert.equal(result.ok, true);
  assert.equal(result.envelope.action, "post_message");
  assert.equal(messages.at(-1).content, "[观点] mock 答复");
  const types = events.map((e) => e.type);
  assert.ok(types.includes("agent.thinking"));
  assert.ok(types.includes("agent.responded"));
});

await test("runAgent end-to-end: spawn mock hermes (raw wrapper)", async () => {
  resetState();
  mockHermesAs("JSON.stringify({action:'do_nothing',content:'没补充',nextFloor:'chair'})");
  const result = await runAgent("hermes");
  assert.equal(result.ok, true);
  assert.equal(result.envelope.action, "do_nothing");
});

await test("runAgent lock: second concurrent call returns immediately", async () => {
  resetState();
  // Slow mock so first call holds the lock long enough.
  agentConfigs["claude-code"] = {
    bin: process.execPath,
    args: ["-e", "setTimeout(() => process.stdout.write(JSON.stringify({type:'result',result:'{\"action\":\"do_nothing\",\"nextFloor\":\"chair\"}'})), 200)"],
    inputVia: "arg",
    parseWrapper: "claude-json",
    timeoutMs: 2000,
    enabled: true
  };
  const first = runAgent("claude-code");
  // Wait a tick so first acquires lock.
  await new Promise((r) => setImmediate(r));
  const second = await runAgent("claude-code");
  assert.equal(second.ok, false);
  assert.ok(second.error.includes("in-flight"));
  await first;
  assert.equal(getInflight().has("claude-code"), false, "lock released after completion");
});

await test("runAgent timeout: lock released and agent.failed event recorded", async () => {
  resetState();
  mockClaudeHang();
  const result = await runAgent("claude-code");
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("timeout"));
  assert.equal(getInflight().has("claude-code"), false);
  const failed = events.find((e) => e.type === "agent.failed");
  assert.ok(failed, "agent.failed event should be recorded");
});

await test("setAutoMode enables and seeds remaining rounds", async () => {
  resetState();
  const result = await setAutoMode({ enabled: true, maxRounds: 3 });
  assert.equal(result.autoMode, true);
  assert.equal(result.autoMaxRounds, 3);
  assert.equal(result.autoRoundsRemaining, 3);
});

await test("setAutoMode disable resets remaining to 0", async () => {
  resetState();
  await setAutoMode({ enabled: true, maxRounds: 5 });
  const result = await setAutoMode({ enabled: false });
  assert.equal(result.autoMode, false);
  assert.equal(result.autoRoundsRemaining, 0);
});

await test("getAutoState reflects mockState", () => {
  resetState();
  mockState.meeting.autoMode = true;
  mockState.meeting.autoMaxRounds = 7;
  mockState.meeting.autoRoundsRemaining = 4;
  const s = getAutoState();
  assert.equal(s.autoMode, true);
  assert.equal(s.autoMaxRounds, 7);
  assert.equal(s.autoRoundsRemaining, 4);
});

await test("auto countdown via runAgent → nextFloor chain stops at 0", async () => {
  resetState();
  // Two agents ping-pong: claude→hermes→claude→hermes ... but counter caps at 2.
  await setAutoMode({ enabled: true, maxRounds: 2 });
  mockState.meeting.floor = "claude-code";
  mockClaudeAs("JSON.stringify({action:'post_message',stance:'观点',content:'A',nextFloor:'hermes'})");
  mockHermesAs("JSON.stringify({action:'post_message',stance:'观点',content:'B',nextFloor:'claude-code'})");
  // Manually fire first runAgent; scheduleAuto chain should drive the rest.
  await runAgent("claude-code", { triggeredBy: "test" });
  // Give the event loop a few ticks for the chain to drain.
  await new Promise((r) => setTimeout(r, 200));
  // After auto chain ends, remaining must be 0.
  assert.equal(mockState.meeting.autoRoundsRemaining, 0);
  // And we should have at least 2 agent responses recorded.
  const responded = events.filter((e) => e.type === "agent.responded");
  assert.ok(responded.length >= 2, `expected >=2 responses, got ${responded.length}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
