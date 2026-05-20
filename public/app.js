const stateUrl = "/api/state";
let state = null;
let expandedMotionId = null;

const $ = (id) => document.getElementById(id);

const agentName = (id) => {
  if (id === "chair") return state?.chair?.name || "主席";
  return state?.agents.find((agent) => agent.id === id)?.name || id;
};
const agentColor = (id) => {
  if (id === "chair") return state?.chair?.color || "#f97316";
  return state?.agents.find((agent) => agent.id === id)?.color || "#8b949e";
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || response.statusText);
  }
  return response.json();
}

function timeLabel(iso) {
  return new Date(iso).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

async function load() {
  state = await api(stateUrl);
  render();
}

function render() {
  $("updatedAt").textContent = `更新于 ${timeLabel(state.meta.updatedAt)}`;
  renderChair();
  renderAgents();
  renderMeeting();
  renderSwimlanes();
  renderMessages();
  renderDirectives();
  renderMotions();
  renderTasks();
  renderHandoff();
}

function renderChair() {
  $("chairCard").innerHTML = `
    <article class="chair-seat">
      <div class="agent-top">
        <span class="dot" style="background:${state.chair.color}"></span>
        <strong>${escapeHtml(state.chair.name)}</strong>
        <span class="badge authority">最高权限</span>
      </div>
      <p>${escapeHtml(state.chair.authority)}</p>
      <p>${escapeHtml(state.chair.rule)}</p>
    </article>
  `;
}

function renderAgents() {
  $("agentsList").innerHTML = state.agents
    .map((agent) => {
      return `
        <article class="agent-card">
          <div class="agent-top">
            <span class="dot" style="background:${agent.color}"></span>
            <strong>${escapeHtml(agent.name)}</strong>
            <span class="badge">${escapeHtml(agent.status)}</span>
          </div>
          <p>${escapeHtml(agent.role)}</p>
        </article>
      `;
    })
    .join("");
}

function renderMeeting() {
  const meeting = state.meeting;
  $("meetingTitle").value = meeting.title || "";
  $("meetingObjective").value = meeting.objective || "";
  $("meetingPhase").value = meeting.phase || "open";
  $("meetingFloor").value = meeting.floor || "chair";
  $("meetingRound").value = meeting.round || 1;
  $("meetingSummary").innerHTML = `
    <div class="meeting-grid">
      <div>
        <span class="label">议题</span>
        <strong>${escapeHtml(meeting.title)}</strong>
      </div>
      <div>
        <span class="label">阶段</span>
        <strong>${escapeHtml(meeting.phase)}</strong>
      </div>
      <div>
        <span class="label">当前发言权</span>
        <strong>${escapeHtml(agentName(meeting.floor))}</strong>
      </div>
      <div>
        <span class="label">轮次</span>
        <strong>${escapeHtml(meeting.round)}</strong>
      </div>
    </div>
    <p>${escapeHtml(meeting.objective)}</p>
    <ol class="agenda">
      ${(meeting.agenda || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
    </ol>
  `;
}

function renderMessages() {
  $("messages").innerHTML = state.messages
    .slice()
    .reverse()
    .map((message) => {
      return `
        <article class="message ${message.agent === "chair" ? "chair-message" : ""}">
          <div class="message-meta">
            <span class="dot" style="background:${agentColor(message.agent)}"></span>
            <strong>${escapeHtml(agentName(message.agent))}</strong>
            <span>${escapeHtml(message.type)}</span>
            <span>${timeLabel(message.createdAt)}</span>
          </div>
          <div class="message-content">${escapeHtml(message.content)}</div>
        </article>
      `;
    })
    .join("");
}

// Swimlane view: each participating Agent gets a vertical track of their
// speeches/votes; the chair gets a track that mixes directives + rulings.
// Designed to make "who said what in which round" legible at a glance.
const SWIMLANE_AGENTS = ["codex", "claude-code", "hermes"];

function stanceLabel(message) {
  const type = message.type || "";
  if (type === "motion") return "提案";
  if (type === "motion-vote") return "投票";
  if (type === "chair-ruling") return "裁决";
  if (type === "chair-directive") return "指令";
  if (type === "reprompt") return "Re-prompt";
  if (type === "handoff") return "交接";
  if (type === "decision") return "决策";
  if (type === "turn") {
    const stance = (message.content.match(/^\[(.+?)\]/) || [])[1];
    return stance || "发言";
  }
  return type || "发言";
}

function renderSwimlanes() {
  const container = $("swimlanes");
  if (!container) return;
  const meeting = state.meeting || {};
  const buckets = {
    codex: [],
    "claude-code": [],
    hermes: [],
    chair: []
  };
  for (const message of state.messages) {
    const agent = buckets[message.agent] ? message.agent : "chair";
    buckets[agent].push(message);
  }
  const chairLane = renderChairLane(buckets.chair);
  const agentLanes = SWIMLANE_AGENTS.map((agentId) =>
    renderAgentLane(agentId, buckets[agentId] || [], meeting)
  ).join("");
  container.innerHTML = `
    <div class="swimlane-header">
      <span class="meeting-chip">Round ${escapeHtml(meeting.round || 1)}</span>
      <span class="meeting-chip">phase · ${escapeHtml(meeting.phase || "open")}</span>
      <span class="meeting-chip floor">floor · ${escapeHtml(agentName(meeting.floor || "chair"))}</span>
    </div>
    <div class="lanes-grid">
      ${agentLanes}
      ${chairLane}
    </div>
  `;
}

function renderAgentLane(agentId, messages, meeting) {
  const agent = state.agents.find((item) => item.id === agentId);
  const color = agentColor(agentId);
  const name = agent?.name || agentId;
  const role = agent?.role || "";
  const isFloor = meeting.floor === agentId;
  return `
    <section class="lane ${isFloor ? "lane-active" : ""}" data-agent="${escapeHtml(agentId)}" style="--lane-color:${color}">
      <header class="lane-head">
        <span class="lane-dot" style="background:${color}"></span>
        <strong>${escapeHtml(name)}</strong>
        ${isFloor ? '<span class="lane-badge">on floor</span>' : ""}
        <span class="lane-count">${messages.length}</span>
      </header>
      <p class="lane-role">${escapeHtml(role)}</p>
      <div class="lane-body">
        ${messages.length === 0 ? '<div class="lane-empty">尚未发言</div>' : messages.map((m) => renderLaneCard(m)).join("")}
      </div>
    </section>
  `;
}

function renderChairLane(messages) {
  return `
    <section class="lane lane-chair" data-agent="chair" style="--lane-color:${state.chair.color}">
      <header class="lane-head">
        <span class="lane-dot" style="background:${state.chair.color}"></span>
        <strong>${escapeHtml(state.chair.name)}</strong>
        <span class="lane-badge authority">主席</span>
        <span class="lane-count">${messages.length}</span>
      </header>
      <p class="lane-role">指令 · 裁决 · re-prompt 自动追加在这里</p>
      <div class="lane-body">
        ${messages.length === 0 ? '<div class="lane-empty">尚未发言</div>' : messages.map((m) => renderLaneCard(m)).join("")}
      </div>
    </section>
  `;
}

function renderLaneCard(message) {
  const round = message.round || state.meeting?.round || 1;
  const stance = stanceLabel(message);
  return `
    <article class="lane-card lane-card-${escapeHtml(message.type)}">
      <div class="lane-card-head">
        <span class="round-chip">R${escapeHtml(round)}</span>
        <span class="stance-chip">${escapeHtml(stance)}</span>
        <span class="lane-time">${timeLabel(message.createdAt)}</span>
      </div>
      <div class="lane-card-body">${escapeHtml(message.content)}</div>
    </article>
  `;
}

function renderDirectives() {
  $("directives").innerHTML = state.directives
    .map((directive) => {
      return `
        <article class="directive-card">
          <div class="task-title">
            <strong>${escapeHtml(directive.title)}</strong>
            <span class="status ruling">${escapeHtml(directive.priority)}</span>
          </div>
          <p>${escapeHtml(directive.content)}</p>
          <span class="muted">${escapeHtml(directive.status)} · ${timeLabel(directive.createdAt)}</span>
        </article>
      `;
    })
    .join("");
}

function renderMotions() {
  $("motions").innerHTML = state.motions
    .map((motion) => {
      const tally = motionTally(motion);
      const expanded = expandedMotionId === motion.id;
      return `
        <article class="motion-card ${expanded ? "motion-expanded" : ""}">
          <div class="task-title">
            <strong>${escapeHtml(motion.title)}</strong>
            <span class="status ${escapeHtml(motion.status)}">${escapeHtml(motion.status)}</span>
          </div>
          <p>${escapeHtml(motion.rationale)}</p>
          <p class="motion-meta">
            <span>提案人：${escapeHtml(agentName(motion.proposedBy))}</span>
            <span class="motion-tally" title="赞成 / 反对 / 弃权">
              <span class="tally-support">●${tally.support}</span>
              <span class="tally-oppose">●${tally.oppose}</span>
              <span class="tally-abstain">●${tally.abstain}</span>
            </span>
            ${motion.repromptedAt ? '<span class="motion-flag">re-prompted</span>' : ""}
          </p>
          ${motion.ruling ? `<p class="ruling-text">主席裁决：${escapeHtml(motion.ruling)}</p>` : ""}
          <div class="motion-vote-row" data-motion="${motion.id}">
            <button class="vote-btn vote-support" data-vote="support" data-motion="${motion.id}" type="button">赞成</button>
            <button class="vote-btn vote-oppose" data-vote="oppose" data-motion="${motion.id}" type="button">反对</button>
            <button class="vote-btn vote-abstain" data-vote="abstain" data-motion="${motion.id}" type="button">弃权</button>
            <select class="vote-agent" data-motion="${motion.id}">
              <option value="codex">Codex 投</option>
              <option value="claude-code">Claude Code 投</option>
              <option value="hermes">Hermes 投</option>
            </select>
          </div>
          <div class="task-actions">
            ${motionButton(motion, "accepted", "通过")}
            ${motionButton(motion, "rejected", "否决")}
            ${motionButton(motion, "deferred", "暂缓")}
            ${motionButton(motion, "needs-work", "重议")}
            <button class="chain-toggle" data-chain="${motion.id}" type="button">${expanded ? "收起决策链" : "展开决策链"}</button>
          </div>
          ${expanded ? renderChainPlaceholder(motion.id) : ""}
        </article>
      `;
    })
    .join("");
  if (expandedMotionId) {
    hydrateChain(expandedMotionId);
  }
}

function motionTally(motion) {
  const votes = Array.isArray(motion.votes) ? motion.votes : [];
  return {
    support: votes.filter((v) => v.position === "support").length,
    oppose: votes.filter((v) => v.position === "oppose").length,
    abstain: votes.filter((v) => v.position === "abstain").length
  };
}

function renderChainPlaceholder(motionId) {
  return `<div class="decision-chain" data-chain-body="${motionId}"><div class="chain-loading">加载决策链…</div></div>`;
}

async function hydrateChain(motionId) {
  const host = document.querySelector(`[data-chain-body="${motionId}"]`);
  if (!host) return;
  try {
    const data = await api(`/api/motions/${motionId}/chain`);
    host.innerHTML = renderChainBody(data.chain || []);
  } catch (error) {
    host.innerHTML = `<div class="chain-error">加载失败：${escapeHtml(error.message)}</div>`;
  }
}

function renderChainBody(chain) {
  if (chain.length === 0) return '<div class="chain-empty">尚无事件</div>';
  return `
    <ol class="chain-steps">
      ${chain.map((event) => renderChainStep(event)).join("")}
    </ol>
  `;
}

function renderChainStep(event) {
  const meta = chainStepMeta(event);
  const actor = event.actor ? agentName(event.actor) : "system";
  return `
    <li class="chain-step chain-step-${escapeHtml(event.type)}">
      <span class="chain-step-dot" style="background:${meta.color}"></span>
      <div class="chain-step-body">
        <div class="chain-step-head">
          <strong>${escapeHtml(meta.label)}</strong>
          <span class="chain-step-actor">${escapeHtml(actor)}</span>
          <span class="chain-step-time">${timeLabel(event.createdAt)}</span>
        </div>
        ${renderChainPayload(event)}
      </div>
    </li>
  `;
}

function chainStepMeta(event) {
  switch (event.type) {
    case "motion.proposed": return { label: "提案", color: "#2f81f7" };
    case "motion.voted": return { label: "投票", color: "#2ea043" };
    case "motion.ruled": return { label: "主席裁决", color: "#d29922" };
    case "motion.reprompted": return { label: "Re-prompt（自动）", color: "#f85149" };
    default: return { label: event.type, color: "#8b949e" };
  }
}

function renderChainPayload(event) {
  const payload = event.payload || {};
  if (event.type === "motion.proposed") {
    return `<p class="chain-payload">${escapeHtml(payload.rationale || "")}</p>`;
  }
  if (event.type === "motion.voted") {
    const position = payload.position === "support" ? "赞成" : payload.position === "oppose" ? "反对" : "弃权";
    return `<p class="chain-payload"><span class="stance-chip">${escapeHtml(position)}</span> ${escapeHtml(payload.reason || "")}</p>`;
  }
  if (event.type === "motion.ruled") {
    return `<p class="chain-payload">${escapeHtml(payload.from || "?")} → <strong>${escapeHtml(payload.to || "?")}</strong>${payload.ruling ? `<br />${escapeHtml(payload.ruling)}` : ""}</p>`;
  }
  if (event.type === "motion.reprompted") {
    return `<p class="chain-payload">轮次推进至 R${escapeHtml(payload.newRound)}；已自动追加高优 directive。</p>`;
  }
  return "";
}

function motionButton(motion, status, label) {
  return `<button data-motion="${motion.id}" data-status="${status}" type="button">${label}</button>`;
}

function renderTasks() {
  $("tasks").innerHTML = state.tasks
    .map((task) => {
      return `
        <article class="task-card">
          <div class="task-title">
            <strong>${escapeHtml(task.title)}</strong>
            <span class="status ${escapeHtml(task.status)}">${escapeHtml(task.status)}</span>
          </div>
          <p>${escapeHtml(task.description || "无描述")}</p>
          <p>负责人：${escapeHtml(agentName(task.owner))} · 优先级：${escapeHtml(task.priority)}</p>
          <div class="task-actions">
            ${taskButton(task, "doing", "开始")}
            ${taskButton(task, "review", "待审")}
            ${taskButton(task, "done", "完成")}
            ${taskButton(task, "blocked", "阻塞")}
          </div>
        </article>
      `;
    })
    .join("");
}

function taskButton(task, status, label) {
  return `<button data-task="${task.id}" data-status="${status}" type="button">${label}</button>`;
}

function renderHandoff() {
  $("handoffLead").value = state.handoff.currentLead;
  $("handoffNext").value = state.handoff.nextAction || "";
  $("handoffBlockers").value = state.handoff.blockers || "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

$("meetingForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await api("/api/meeting", {
    method: "PATCH",
    body: {
      title: $("meetingTitle").value,
      objective: $("meetingObjective").value,
      phase: $("meetingPhase").value,
      floor: $("meetingFloor").value,
      round: $("meetingRound").value,
      agent: "chair"
    }
  });
  await load();
});

$("turnForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = $("turnContent").value.trim();
  if (!content) return;
  const agent = $("turnAgent").value;
  if (agent === "chair" && $("turnStance").value === "主席指令") {
    await api("/api/chair/directives", {
      method: "POST",
      body: { title: "主席即时指令", content, priority: "highest" }
    });
  } else {
    await api("/api/meeting/turns", {
      method: "POST",
      body: { agent, stance: $("turnStance").value, content }
    });
  }
  $("turnContent").value = "";
  await load();
});

$("directiveForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = $("directiveTitle").value.trim();
  const content = $("directiveContent").value.trim();
  if (!title || !content) return;
  await api("/api/chair/directives", {
    method: "POST",
    body: {
      title,
      content,
      priority: $("directivePriority").value
    }
  });
  $("directiveTitle").value = "";
  $("directiveContent").value = "";
  await load();
});

$("motionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = $("motionTitle").value.trim();
  const rationale = $("motionRationale").value.trim();
  if (!title || !rationale) return;
  await api("/api/motions", {
    method: "POST",
    body: {
      title,
      rationale,
      proposedBy: $("motionProposedBy").value
    }
  });
  $("motionTitle").value = "";
  $("motionRationale").value = "";
  await load();
});

$("motions").addEventListener("click", async (event) => {
  const chainBtn = event.target.closest("button[data-chain]");
  if (chainBtn) {
    const id = chainBtn.dataset.chain;
    expandedMotionId = expandedMotionId === id ? null : id;
    renderMotions();
    return;
  }
  const voteBtn = event.target.closest("button[data-vote]");
  if (voteBtn) {
    const motionId = voteBtn.dataset.motion;
    const row = document.querySelector(`.motion-vote-row[data-motion="${motionId}"]`);
    const voter = row?.querySelector(".vote-agent")?.value || "codex";
    await api(`/api/motions/${motionId}/votes`, {
      method: "POST",
      body: { agent: voter, position: voteBtn.dataset.vote, reason: "" }
    });
    await load();
    return;
  }
  const button = event.target.closest("button[data-motion][data-status]");
  if (!button) return;
  await api(`/api/motions/${button.dataset.motion}`, {
    method: "PATCH",
    body: {
      status: button.dataset.status,
      ruling: `主席裁定为 ${button.dataset.status}`
    }
  });
  await load();
});

$("taskForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = $("taskTitle").value.trim();
  if (!title) return;
  await api("/api/tasks", {
    method: "POST",
    body: {
      title,
      description: $("taskDescription").value,
      owner: $("taskOwner").value,
      priority: $("taskPriority").value,
      createdBy: "chair"
    }
  });
  $("taskTitle").value = "";
  $("taskDescription").value = "";
  await load();
});

$("tasks").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-task]");
  if (!button) return;
  await api(`/api/tasks/${button.dataset.task}`, {
    method: "PATCH",
    body: {
      status: button.dataset.status,
      agent: "chair",
      note: `主席将行动项状态更新为 ${button.dataset.status}`
    }
  });
  await load();
});

$("handoffForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await api("/api/handoff", {
    method: "PATCH",
    body: {
      currentLead: $("handoffLead").value,
      nextAction: $("handoffNext").value,
      blockers: $("handoffBlockers").value,
      agent: "chair"
    }
  });
  await load();
});

$("refreshBtn").addEventListener("click", load);

document.querySelectorAll(".view-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const view = btn.dataset.view;
    document.querySelectorAll(".view-btn").forEach((b) => b.classList.toggle("active", b === btn));
    $("swimlanes").classList.toggle("hidden", view !== "swimlane");
    $("messages").classList.toggle("hidden", view !== "timeline");
  });
});

const events = new EventSource("/api/stream");
events.addEventListener("state", load);

load().catch((error) => {
  document.body.innerHTML = `<pre>${escapeHtml(error.stack || error.message)}</pre>`;
});
