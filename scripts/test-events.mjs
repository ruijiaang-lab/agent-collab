// Smoke test for the event sourcing API (issue #2).
// Usage: node scripts/test-events.mjs
// Assumes the server is running on PORT (default 5057).

const BASE = process.env.AGENT_COLLAB_URL || "http://127.0.0.1:5057";

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${options.method || "GET"} ${path} → ${res.status} ${text}`);
  }
  return res.json();
}

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`PASS: ${message}`);
}

const baselineEvents = await api("/api/events?limit=1");
const baselineTotal = baselineEvents.total;
const since = new Date().toISOString();

const motion = await api("/api/motions", {
  method: "POST",
  body: {
    title: "[smoke] events 链路验证",
    rationale: "由 test-events.mjs 创建，验证 motion.proposed → voted → ruled 事件链。",
    proposedBy: "hermes"
  }
});

const supportVote = await api(`/api/motions/${motion.id}/votes`, {
  method: "POST",
  body: { agent: "codex", position: "support", reason: "实现合理" }
});
assert(supportVote.position === "support", "codex support vote recorded");

const opposeVote = await api(`/api/motions/${motion.id}/votes`, {
  method: "POST",
  body: { agent: "claude-code", position: "oppose", reason: "需评估风险" }
});
assert(opposeVote.position === "oppose", "claude-code oppose vote recorded");

const revote = await api(`/api/motions/${motion.id}/votes`, {
  method: "POST",
  body: { agent: "codex", position: "abstain", reason: "重新考虑后弃权" }
});
assert(revote.position === "abstain", "last-write-wins on revote");

await api(`/api/motions/${motion.id}`, {
  method: "PATCH",
  body: { status: "rejected", ruling: "[smoke] 测试否决以触发完整事件链" }
});

const filtered = await api(`/api/events?motionId=${motion.id}`);
assert(filtered.events.length >= 4, `at least 4 events for the motion (got ${filtered.events.length})`);

const types = filtered.events.map((event) => event.type);
assert(types.includes("motion.proposed"), "chain contains motion.proposed");
assert(types.includes("motion.voted"), "chain contains motion.voted");
assert(types.includes("motion.ruled"), "chain contains motion.ruled");
assert(types.includes("motion.reprompted"), "chain contains motion.reprompted");

const voted = filtered.events.filter((event) => event.type === "motion.voted");
assert(voted.length === 3, `three vote events appended (got ${voted.length})`);

const byType = await api("/api/events?type=motion.proposed&limit=5");
assert(byType.events.every((event) => event.type === "motion.proposed"), "type filter returns only matching events");

const sinceFilter = await api(`/api/events?since=${encodeURIComponent(since)}`);
assert(sinceFilter.events.every((event) => event.createdAt > since), "since filter respects timestamp boundary");
assert(sinceFilter.total >= baselineTotal + filtered.events.length, "total events grew by at least the chain length");

const chain = await api(`/api/motions/${motion.id}/chain`);
assert(chain.motion.id === motion.id, "decision-chain endpoint returns the motion");
assert(chain.chain.length === filtered.events.length, "decision-chain matches motionId filter result");

const sortedAscending = chain.chain.every((event, idx) => idx === 0 || chain.chain[idx - 1].createdAt <= event.createdAt);
assert(sortedAscending, "decision-chain is sorted ascending by createdAt");
assert(chain.chain[0].type === "motion.proposed", "decision-chain starts with motion.proposed");

console.log("\nAll event-sourcing smoke checks passed.");
