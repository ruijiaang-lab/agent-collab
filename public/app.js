const stateUrl = "/api/state";
let state = null;

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
      return `
        <article class="motion-card">
          <div class="task-title">
            <strong>${escapeHtml(motion.title)}</strong>
            <span class="status ${escapeHtml(motion.status)}">${escapeHtml(motion.status)}</span>
          </div>
          <p>${escapeHtml(motion.rationale)}</p>
          <p>提案人：${escapeHtml(agentName(motion.proposedBy))}</p>
          ${motion.ruling ? `<p class="ruling-text">主席裁决：${escapeHtml(motion.ruling)}</p>` : ""}
          <div class="task-actions">
            ${motionButton(motion, "accepted", "通过")}
            ${motionButton(motion, "rejected", "否决")}
            ${motionButton(motion, "deferred", "暂缓")}
            ${motionButton(motion, "needs-work", "重议")}
          </div>
        </article>
      `;
    })
    .join("");
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
  const button = event.target.closest("button[data-motion]");
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

const events = new EventSource("/api/stream");
events.addEventListener("state", load);

load().catch((error) => {
  document.body.innerHTML = `<pre>${escapeHtml(error.stack || error.message)}</pre>`;
});
