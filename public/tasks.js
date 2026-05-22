// tasks.js — Task panel: list, create, detail, follow-up, settings link

const $ = (id) => document.getElementById(id);

let currentPage = "list";
let currentFilter = "";
let currentTaskId = null;
let selectedMode = "roundtable";
let selectedFollowup = "continue";
let pollTimer = null;

// ---------------------------------------------------------------------------
// page navigation
// ---------------------------------------------------------------------------
function showPage(name) {
  document.querySelectorAll(".page").forEach((el) => el.classList.remove("active"));
  $("page" + name.charAt(0).toUpperCase() + name.slice(1)).classList.add("active");
  currentPage = name;
  if (name === "list") {
    loadTasks();
    startPoll();
  } else {
    stopPoll();
  }
}

// ---------------------------------------------------------------------------
// task list
// ---------------------------------------------------------------------------
async function loadTasks() {
  try {
    const url = currentFilter ? `/api/v2/tasks?status=${currentFilter}` : "/api/v2/tasks";
    const resp = await fetch(url);
    const data = await resp.json();
    renderTaskList(data.tasks || []);
  } catch (err) {
    $("taskList").innerHTML = `<div class="empty">加载失败：${err.message}</div>`;
  }
}

function renderTaskList(tasks) {
  const root = $("taskList");
  if (tasks.length === 0) {
    root.innerHTML = `<div class="empty">${currentFilter ? "没有符合筛选的任务" : "还没有任务，点击右上角新建"}</div>`;
    return;
  }
  root.innerHTML = tasks.map(renderTaskCard).join("");
  root.querySelectorAll(".task-card").forEach((card) => {
    card.addEventListener("click", () => showDetail(card.dataset.id));
  });
}

function renderTaskCard(task) {
  const time = new Date(task.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const statusLabel = {
    pending: "待处理", decomposing: "拆解中", discussing: "讨论中",
    executing: "执行中", synthesizing: "合成中", completed: "已完成",
    review: "需审核", failed: "失败"
  };
  const modeLabel = { roundtable: "圆桌", decompose: "拆解" };
  const agentCount = Object.keys(task.turnsByAgent || task.outputs || {}).length;
  return `
    <div class="task-card" data-id="${esc(task.id)}">
      <div class="task-card-status ${esc(task.status)}"></div>
      <div class="task-card-body">
        <div class="task-card-title">${esc(task.title)}</div>
        <div class="task-card-meta">${time} · ${statusLabel[task.status] || task.status}${agentCount ? " · " + agentCount + " 个 AI 产出" : ""}</div>
      </div>
      <span class="task-card-mode">${modeLabel[task.mode] || task.mode}</span>
    </div>`;
}

// ---------------------------------------------------------------------------
// filters
// ---------------------------------------------------------------------------
document.querySelectorAll(".filter").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.dataset.status;
    loadTasks();
  });
});

// ---------------------------------------------------------------------------
// new task
// ---------------------------------------------------------------------------
$("newTaskBtn").addEventListener("click", () => showPage("new"));
$("backFromNew").addEventListener("click", () => showPage("list"));

document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    selectedMode = btn.dataset.mode;
  });
});

$("newTaskForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const brief = $("newBrief").value.trim();
  if (brief.length < 5) {
    $("newTaskError").textContent = "请写至少 5 个字";
    $("newTaskError").hidden = false;
    return;
  }
  $("submitNewTask").disabled = true;
  $("newTaskError").hidden = true;
  try {
    const resp = await fetch("/api/v2/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: $("newTitle").value.trim() || undefined,
        brief,
        mode: selectedMode
      })
    });
    const task = await resp.json();
    if (!resp.ok) throw new Error(task.error || `HTTP ${resp.status}`);

    // Auto-run
    $("submitNewTask").textContent = "正在执行…";
    const runResp = await fetch(`/api/v2/tasks/${task.id}/run`, { method: "POST" });
    if (!runResp.ok) {
      const err = await runResp.json().catch(() => ({}));
      console.warn("run failed:", err);
    }

    $("newBrief").value = "";
    $("newTitle").value = "";
    $("submitNewTask").disabled = false;
    $("submitNewTask").textContent = "开始执行";
    showDetail(task.id);
  } catch (err) {
    $("newTaskError").textContent = `创建失败：${err.message}`;
    $("newTaskError").hidden = false;
    $("submitNewTask").disabled = false;
    $("submitNewTask").textContent = "开始执行";
  }
});

// ---------------------------------------------------------------------------
// task detail
// ---------------------------------------------------------------------------
async function showDetail(taskId) {
  currentTaskId = taskId;
  showPage("detail");
  await refreshDetail();
}

async function refreshDetail() {
  if (!currentTaskId) return;
  try {
    const resp = await fetch(`/api/v2/tasks/${currentTaskId}`);
    if (!resp.ok) throw new Error("task not found");
    const task = await resp.json();
    renderDetail(task);
  } catch (err) {
    $("detailTitle").textContent = "加载失败";
    $("briefContent").textContent = err.message;
  }
}

function renderDetail(task) {
  $("detailTitle").textContent = task.title;

  // Status badge
  const badge = $("detailStatus");
  badge.textContent = {
    pending: "待处理", decomposing: "拆解中", discussing: "讨论中",
    executing: "执行中", synthesizing: "合成中", completed: "已完成",
    review: "需审核", failed: "失败"
  }[task.status] || task.status;
  badge.className = "status-badge " + task.status;

  // Brief
  $("briefContent").textContent = task.brief || "(无描述)";

  // Outputs / turns
  const outputsSection = $("detailOutputs");
  const container = $("outputsContainer");
  const hasOutputs = Object.keys(task.outputs || {}).length > 0;
  const hasTurns = Object.keys(task.turnsByAgent || {}).length > 0;

  if (hasOutputs || hasTurns) {
    outputsSection.hidden = false;
    const items = [];
    const source = hasOutputs ? task.outputs : task.turnsByAgent;
    for (const [agent, data] of Object.entries(source)) {
      const time = data.finishedAt ? new Date(data.finishedAt).toLocaleTimeString("zh-CN") : "";
      const isError = data.error;
      items.push(`
        <div class="output-card ${isError ? "error" : ""}">
          <div class="output-card-header">
            <span class="output-card-agent">${esc(displayName(agent))}</span>
            <span class="output-card-time">${esc(data.stance || "")} ${time}</span>
          </div>
          <div class="output-card-content">${esc(isError ? "错误：" + data.error : data.content || "(空)")}</div>
        </div>`);
    }
    container.innerHTML = items.join("");
  } else {
    outputsSection.hidden = true;
  }

  // Synthesis / conclusion
  const synthesisSection = $("detailSynthesis");
  const synthesis = task.synthesis || task.conclusion;
  if (synthesis) {
    synthesisSection.hidden = false;
    $("synthesisTitle").textContent = task.mode === "roundtable" ? "结论" : "合成交付物";
    $("synthesisContent").innerHTML = renderMarkdown(synthesis);
  } else {
    synthesisSection.hidden = true;
  }

  // Review
  $("detailReview").hidden = task.status !== "review";

  // Follow-up: hide if task is still processing
  $("detailFollowup").hidden = ["decomposing", "executing", "synthesizing"].includes(task.status);

  // Log
  $("detailLog").textContent = (task.log || []).map((l) =>
    `[${new Date(l.ts).toLocaleTimeString("zh-CN")}] ${l.event} ${l.detail || ""}`
  ).join("\n");

  // Auto-poll if task is still processing
  if (["discussing", "decomposing", "executing", "synthesizing"].includes(task.status)) {
    if (!pollTimer) {
      pollTimer = setInterval(refreshDetail, 5000);
    }
  } else {
    stopPoll();
  }
}

// ---------------------------------------------------------------------------
// follow-up
// ---------------------------------------------------------------------------
$("backFromDetail").addEventListener("click", () => {
  stopPoll();
  showPage("list");
});

document.querySelectorAll(".followup-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".followup-btn").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    selectedFollowup = btn.dataset.action;
    $("followupAskAgent").hidden = selectedFollowup !== "ask";
    $("followupInput").placeholder = selectedFollowup === "ask"
      ? "想问这个 AI 什么？"
      : "追问或补充说明…";
  });
});

$("followupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("followupInput").value.trim();
  if (!text || !currentTaskId) return;

  $("followupSubmit").disabled = true;
  $("followupStatus").textContent = "执行中…";

  try {
    let url, body;
    if (selectedFollowup === "ask") {
      const agent = $("askAgentSelect").value;
      url = `/api/v2/tasks/${currentTaskId}/ask/${agent}`;
      body = { question: text };
    } else {
      url = `/api/v2/tasks/${currentTaskId}/continue`;
      body = { brief: text };
    }
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    $("followupInput").value = "";
    $("followupStatus").textContent = "完成";
    await refreshDetail();
  } catch (err) {
    $("followupStatus").textContent = `失败：${err.message}`;
  } finally {
    $("followupSubmit").disabled = false;
    setTimeout(() => { $("followupStatus").textContent = ""; }, 3000);
  }
});

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------
$("approveBtn").addEventListener("click", () => review("approved"));
$("rejectBtn").addEventListener("click", () => review("rejected"));

async function review(status) {
  if (!currentTaskId) return;
  try {
    await fetch(`/api/v2/tasks/${currentTaskId}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
    await refreshDetail();
  } catch (err) {
    alert("审核操作失败：" + err.message);
  }
}

// ---------------------------------------------------------------------------
// synthesis actions
// ---------------------------------------------------------------------------
$("copySynthesis").addEventListener("click", async () => {
  try {
    const resp = await fetch(`/api/v2/tasks/${currentTaskId}`);
    const task = await resp.json();
    const text = task.synthesis || task.conclusion || "";
    await navigator.clipboard.writeText(text);
    const btn = $("copySynthesis");
    btn.textContent = "✓ 已复制";
    setTimeout(() => { btn.textContent = "复制"; }, 1500);
  } catch {
    alert("复制失败");
  }
});

$("downloadSynthesis").addEventListener("click", async () => {
  try {
    const resp = await fetch(`/api/v2/tasks/${currentTaskId}`);
    const task = await resp.json();
    const text = task.synthesis || task.conclusion || "";
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.href = url;
    a.download = `${task.title || "task"}-${stamp}.md`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  } catch {
    alert("下载失败");
  }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function startPoll() { stopPoll(); }
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function displayName(id) {
  return { "claude-code": "Claude Code", hermes: "Hermes", codex: "Codex" }[id] || id;
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(md) {
  if (!md) return "<p class='muted'>(空)</p>";
  const lines = String(md).split("\n");
  const out = [];
  let inList = false;
  let inPara = [];

  const flushPara = () => {
    if (inPara.length) {
      out.push(`<p>${formatInline(inPara.join(" "))}</p>`);
      inPara = [];
    }
  };
  const flushList = () => {
    if (inList) { out.push("</ul>"); inList = false; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) { flushPara(); flushList(); continue; }
    if (line.startsWith("### ")) {
      flushPara(); flushList();
      out.push(`<h4>${formatInline(line.slice(4))}</h4>`);
    } else if (line.startsWith("## ")) {
      flushPara(); flushList();
      out.push(`<h3>${formatInline(line.slice(3))}</h3>`);
    } else if (line.startsWith("# ")) {
      flushPara(); flushList();
      out.push(`<h3>${formatInline(line.slice(2))}</h3>`);
    } else if (/^[-*]\s+/.test(line)) {
      flushPara();
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${formatInline(line.replace(/^[-*]\s+/, ""))}</li>`);
    } else {
      flushList();
      inPara.push(line);
    }
  }
  flushPara(); flushList();
  return out.join("\n");
}

function formatInline(text) {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

// boot
showPage("list");
