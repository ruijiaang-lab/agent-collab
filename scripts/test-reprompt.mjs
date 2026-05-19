// Smoke test for auto re-prompt on motion rejection (issue #1).
// Usage: node scripts/test-reprompt.mjs
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

const before = await api("/api/state");
const baselineDirectives = before.directives.length;
const baselineRound = Number(before.meeting.round) || 1;

const motion = await api("/api/motions", {
  method: "POST",
  body: {
    title: "[smoke] 测试 re-prompt",
    rationale: "由 test-reprompt.mjs 创建，用于验证否决触发自动 re-prompt。",
    proposedBy: "codex"
  }
});

const ruling = "理由不充分，请补充风险评估。";
const rejected = await api(`/api/motions/${motion.id}`, {
  method: "PATCH",
  body: { status: "rejected", ruling }
});

assert(rejected.status === "rejected", "motion status flipped to rejected");
assert(typeof rejected.repromptedAt === "string", "repromptedAt timestamp recorded");

const after = await api("/api/state");

assert(
  after.directives.length === baselineDirectives + 1,
  "exactly one new directive appended"
);

const newDirective = after.directives[0];
assert(
  newDirective.title.startsWith("Re-prompt："),
  "new directive titled with Re-prompt prefix"
);
assert(
  newDirective.priority === "high",
  "new directive has priority=high"
);
assert(
  newDirective.sourceMotionId === motion.id,
  "new directive traces back to the rejected motion"
);
assert(
  newDirective.content.includes(ruling),
  "ruling text propagated into directive body"
);

assert(
  after.meeting.floor === "codex",
  "floor handed back to the rejected proposer"
);
assert(
  Number(after.meeting.round) === baselineRound + 1,
  "round incremented by 1"
);

const rerejected = await api(`/api/motions/${motion.id}`, {
  method: "PATCH",
  body: { status: "rejected", ruling: "再次否决（应该不会触发第二次 re-prompt）" }
});
assert(rerejected.repromptedAt === rejected.repromptedAt, "re-prompt is idempotent: second rejection is a no-op");
const after2 = await api("/api/state");
assert(
  after2.directives.length === after.directives.length,
  "no extra directive created on duplicate rejection"
);

console.log("\nAll re-prompt smoke checks passed.");
