// simple.js — ChatGPT-style chat flow for /simple. The user picks a template
// chip, types a brief, and watches three AIs reply in a single message stream
// → final "📝 总结" message appears at the end with copy/download actions.
// Old card-grid is gone; everything renders as flat <li class="msg"> items.

const $ = (id) => document.getElementById(id);
const SESSION_KEY = "agent-collab/simple/session/v1";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

let templates = [];
let selectedTemplate = null;
let enabledAgents = [];

// Session-local state.
let session = null;
let concludeStarted = false;
let stream = null;
let displayedDecisionId = null;
let currentDecision = null;
let currentInflight = new Set();

// ---------------------------------------------------------------------------
// session persistence
// ---------------------------------------------------------------------------
function persistSession() {
  if (!session) return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      sessionId: session.sessionId,
      brief: session.brief,
      template: session.template,
      sequence: session.sequence,
      conclusionAgent: session.conclusionAgent,
      conclusionFormat: session.conclusionFormat,
      startedRound: session.startedRound,
      startedAt: session.startedAt,
      savedAt: new Date().toISOString()
    }));
  } catch { /* storage full or private mode */ }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  session = null;
  concludeStarted = false;
  currentDecision = null;
  currentInflight = new Set();
  displayedDecisionId = null;
}

async function tryResume() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { clearSession(); return false; }
  if (!saved) return false;
  if (Date.now() - new Date(saved.savedAt) > SESSION_TTL_MS) { clearSession(); return false; }
  try {
    const [stateResp, inflightResp] = await Promise.all([
      fetch("/api/state").then((r) => r.json()),
      fetch("/api/agents/inflight").then((r) => r.json())
    ]);
    if (stateResp.meeting?.session?.id !== saved.sessionId) { clearSession(); return false; }
    session = { ...saved, turnsByAgent: {} };
    enterChat();
    subscribeStream();
    applyState(stateResp, inflightResp);
    return true;
  } catch { clearSession(); return false; }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
async function boot() {
  try {
    const [tplResp, inflightResp] = await Promise.all([
      fetch("/api/sessions/templates").then((r) => r.json()),
      fetch("/api/agents/inflight").then((r) => r.json())
    ]);
    templates = tplResp.templates || [];
    enabledAgents = Object.entries(inflightResp.configs || {})
      .filter(([, cfg]) => cfg.enabled !== false)
      .map(([id]) => id);
    renderChips();
    renderAgentHint();
    if (await tryResume()) return;
  } catch (err) {
    $("agentsHint").textContent = `加载失败：${err.message}（server 可能没启动）`;
    $("agentsHint").classList.add("warn");
  }
}

// ---------------------------------------------------------------------------
// chip rendering
// ---------------------------------------------------------------------------
function renderChips() {
  const root = $("chips");
  root.innerHTML = "";
  templates.forEach((tpl) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.id = tpl.id;
    chip.innerHTML = `<span class="ic">${escapeHtml(tpl.icon || "💬")}</span><span>${escapeHtml(tpl.title)}</span>`;
    chip.title = tpl.description || "";
    chip.addEventListener("click", () => selectTemplate(tpl));
    root.appendChild(chip);
  });
}

function selectTemplate(tpl) {
  selectedTemplate = tpl;
  document.querySelectorAll(".chip").forEach((el) => {
    el.classList.toggle("selected", el.dataset.id === tpl.id);
  });
  $("brief").placeholder = tpl.placeholder || "写一段你想聊的…";
  $("brief").focus();
  updateSendButton();
}

function renderAgentHint() {
  const hint = $("agentsHint");
  if (enabledAgents.length === 0) {
    hint.textContent = "⚠ 没找到已启用的 AI runner。请先在终端登录至少一个 CLI（claude / hermes / codex）。";
    hint.classList.add("warn");
    return;
  }
  const names = enabledAgents.map(displayName).join("、");
  hint.textContent = `本次将由 ${names} 参与讨论`;
  hint.classList.remove("warn");
  updateSendButton();
}

function displayName(id) {
  return { "claude-code": "Claude Code", hermes: "Hermes", codex: "Codex" }[id] || id;
}

function avatarClass(id) {
  if (id === "claude-code") return "claude";
  if (id === "hermes") return "hermes";
  if (id === "codex") return "codex";
  if (id === "chair" || id === "user") return id;
  return "chair";
}

function avatarLabel(id) {
  return { "claude-code": "C", hermes: "H", codex: "X", chair: "📝", user: "你" }[id] || id.slice(0, 1).toUpperCase();
}

// ---------------------------------------------------------------------------
// composer
// ---------------------------------------------------------------------------
function updateSendButton() {
  const ready =
    selectedTemplate &&
    $("brief").value.trim().length >= 5 &&
    enabledAgents.length > 0 &&
    !session;
  $("sendBtn").disabled = !ready;
}

$("brief").addEventListener("input", () => {
  // auto-resize textarea
  const ta = $("brief");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  updateSendButton();
});

$("brief").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!$("sendBtn").disabled) $("composer").requestSubmit();
  }
});

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  startSession();
});

async function startSession() {
  const brief = $("brief").value.trim();
  if (!selectedTemplate || brief.length < 5) return;
  $("sendBtn").disabled = true;
  $("hint").classList.remove("error");
  try {
    const resp = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: selectedTemplate.id, brief })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    session = {
      ...data,
      brief,
      template: selectedTemplate,
      startedAt: new Date().toISOString(),
      turnsByAgent: {}
    };
    persistSession();
    enterChat();
    subscribeStream();
    pollOnce();
  } catch (err) {
    $("hint").textContent = `开始失败：${err.message}`;
    $("hint").classList.add("error");
    $("sendBtn").disabled = false;
  }
}

// ---------------------------------------------------------------------------
// enter/exit chat mode
// ---------------------------------------------------------------------------
function enterChat() {
  $("empty").classList.add("hidden");
  $("chips").innerHTML = "";
  $("brief").value = "";
  $("brief").disabled = true;
  $("brief").placeholder = "AI 讨论中…完成后可以「＋ 新讨论」开下一轮";
  $("sendBtn").disabled = true;
  $("stopBtn").hidden = false;
  $("newBtn").hidden = true;
  $("hint").textContent = "⏳ 等 AI 开口…";
  render();
}

function exitChat() {
  clearSession();
  selectedTemplate = null;
  $("empty").classList.remove("hidden");
  $("messages").innerHTML = "";
  renderChips();
  renderAgentHint();
  $("brief").disabled = false;
  $("brief").value = "";
  $("brief").placeholder = "点上面任意一张卡片选择讨论方式，再把你想聊的写下来…";
  $("brief").style.height = "auto";
  $("stopBtn").hidden = true;
  $("newBtn").hidden = true;
  $("hint").classList.remove("error");
  $("hint").textContent = "三个 AI 会按顺序发言，全程约 30-90 秒。";
  updateSendButton();
  $("chat").scrollTop = 0;
}

// ---------------------------------------------------------------------------
// stream + state
// ---------------------------------------------------------------------------
function subscribeStream() {
  if (stream) stream.close();
  stream = new EventSource("/api/stream");
  stream.addEventListener("state", () => pollOnce());
  stream.addEventListener("inflight", () => pollOnce());
  stream.addEventListener("error", () => {
    $("hint").textContent = "（连接闪烁，正在重连…）";
  });
}

async function pollOnce() {
  if (!session) return;
  try {
    const [stateResp, inflightResp] = await Promise.all([
      fetch("/api/state").then((r) => r.json()),
      fetch("/api/agents/inflight").then((r) => r.json())
    ]);
    applyState(stateResp, inflightResp);
  } catch (err) {
    console.warn("poll failed", err);
  }
}

function applyState(state, inflightResp) {
  if (!session) return;

  const existingDecision = findExistingDecision(state);
  if (existingDecision) {
    currentDecision = existingDecision;
    if (existingDecision.id !== displayedDecisionId) {
      displayedDecisionId = existingDecision.id || "anon";
    }
  }

  currentInflight = new Set(inflightResp.inflight || []);
  const round = session.startedRound;
  const turns = (state.messages || [])
    .filter((m) => (m.round || 0) >= round && m.type === "turn" && session.sequence.includes(m.agent))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  session.turnsByAgent = {};
  turns.forEach((m) => { session.turnsByAgent[m.agent] = m; });

  render();

  // status hint
  const speakingAgent = session.sequence.find((id) => currentInflight.has(id));
  const spokenCount = Object.keys(session.turnsByAgent).length;
  if (currentDecision) {
    $("hint").textContent = `✓ 完成 · 共 ${spokenCount}/${session.sequence.length} 位 AI 发言 + 1 份总结`;
  } else if (speakingAgent) {
    $("hint").textContent = `🗣 ${displayName(speakingAgent)} 正在发言…（${spokenCount}/${session.sequence.length}）`;
  } else if (spokenCount > 0) {
    $("hint").textContent = `已完成 ${spokenCount}/${session.sequence.length} 位 AI 的发言`;
  }

  // when discussion is done, swap stop → new
  if (currentDecision) {
    $("stopBtn").hidden = true;
    $("newBtn").hidden = false;
  }

  // trigger conclude
  const autoDone =
    !state.meeting.autoMode ||
    (state.meeting.autoRoundsRemaining || 0) === 0;
  if (
    !concludeStarted &&
    !currentDecision &&
    spokenCount >= 1 &&
    currentInflight.size === 0 &&
    autoDone
  ) {
    concludeStarted = true;
    triggerConclude();
  }
}

// ---------------------------------------------------------------------------
// conclude
// ---------------------------------------------------------------------------
async function triggerConclude() {
  $("hint").textContent = "📝 正在汇总结论…（20-60 秒）";
  // show a thinking message for the chair-conclusion
  render();
  try {
    const resp = await fetch("/api/meeting/conclude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: session.conclusionAgent || session.sequence[0],
        format: session.conclusionFormat || "summary"
      })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    currentDecision = data.decision;
    displayedDecisionId = data.decision?.id || "anon";
    render();
  } catch (err) {
    $("hint").textContent = `生成结论失败：${err.message}`;
    $("hint").classList.add("error");
    concludeStarted = false;
  }
}

function findExistingDecision(state) {
  const sessionState = state?.meeting?.session;
  const decisions = Array.isArray(state?.decisions) ? state.decisions : [];
  if (!sessionState || sessionState.status !== "completed") return null;
  if (sessionState.decisionId) {
    const exact = decisions.find((d) => d && d.id === sessionState.decisionId);
    if (exact) return exact;
  }
  return decisions.find((d) =>
    d && d.kind === "conclusion" && (d.round || 0) >= session.startedRound
  ) || null;
}

// ---------------------------------------------------------------------------
// render — build the flat message stream
// ---------------------------------------------------------------------------
function render() {
  const root = $("messages");
  if (!session) { root.innerHTML = ""; return; }

  const msgs = [];
  msgs.push({ type: "user", content: session.brief });

  session.sequence.forEach((agentId) => {
    const turn = session.turnsByAgent[agentId];
    if (turn) {
      msgs.push({ type: "agent", agentId, stance: turn.stance, content: turn.content });
    } else if (currentInflight.has(agentId)) {
      msgs.push({ type: "thinking", agentId });
    }
    // agents that haven't been triggered yet are simply not shown — keeps it clean
  });

  if (currentDecision) {
    msgs.push({
      type: "conclusion",
      author: currentDecision.author || currentDecision.agent || session.conclusionAgent,
      format: currentDecision.format,
      body: currentDecision.rationale || currentDecision.body || ""
    });
  } else if (concludeStarted) {
    msgs.push({ type: "thinking", agentId: "chair", label: "正在汇总结论" });
  }

  // remember scroll position
  const wasNearBottom = isNearBottom();
  root.innerHTML = msgs.map(renderMsg).join("");
  attachConclusionHandlers();
  if (wasNearBottom) scrollToBottom();
}

function renderMsg(m) {
  if (m.type === "user") {
    return `
      <li class="msg user-msg">
        <div class="avatar user">${avatarLabel("user")}</div>
        <div class="msg-body">
          <div class="msg-head"><span class="msg-name">你</span></div>
          <div class="msg-content">${escapeHtml(m.content)}</div>
        </div>
      </li>`;
  }
  if (m.type === "thinking") {
    const isChair = m.agentId === "chair";
    return `
      <li class="msg thinking-msg">
        <div class="avatar ${avatarClass(m.agentId)}">${avatarLabel(m.agentId)}</div>
        <div class="msg-body">
          <div class="msg-head"><span class="msg-name">${isChair ? "总结" : escapeHtml(displayName(m.agentId))}</span></div>
          <div class="msg-content">
            <span>${m.label || "正在思考"}</span>
            <span class="dots"><span></span><span></span><span></span></span>
          </div>
        </div>
      </li>`;
  }
  if (m.type === "agent") {
    return `
      <li class="msg agent-msg">
        <div class="avatar ${avatarClass(m.agentId)}">${avatarLabel(m.agentId)}</div>
        <div class="msg-body">
          <div class="msg-head">
            <span class="msg-name">${escapeHtml(displayName(m.agentId))}</span>
            ${m.stance ? `<span class="msg-stance">${escapeHtml(m.stance)}</span>` : ""}
          </div>
          <div class="msg-content">${escapeHtml(m.content || "(空)")}</div>
        </div>
      </li>`;
  }
  if (m.type === "conclusion") {
    return `
      <li class="msg conclusion-msg">
        <div class="avatar chair">${avatarLabel("chair")}</div>
        <div class="msg-body">
          <div class="msg-head">
            <span class="msg-name">总结 · ${escapeHtml(displayName(m.author))}</span>
            <span class="msg-stance">${escapeHtml(formatLabel(m.format))}</span>
          </div>
          <div class="msg-content">${renderMarkdown(m.body)}</div>
          <div class="conclusion-actions">
            <button data-action="copy">复制</button>
            <button data-action="download">下载 Markdown</button>
            <button data-action="restart">＋ 新讨论</button>
          </div>
        </div>
      </li>`;
  }
  return "";
}

function attachConclusionHandlers() {
  if (!currentDecision) return;
  const body = currentDecision.rationale || currentDecision.body || "";
  document.querySelectorAll(".conclusion-actions [data-action]").forEach((btn) => {
    btn.onclick = () => {
      const a = btn.dataset.action;
      if (a === "copy") copyToClipboard(body, btn);
      else if (a === "download") downloadMarkdown(body);
      else if (a === "restart") exitChat();
    };
  });
}

function isNearBottom() {
  const c = $("chat");
  return c.scrollHeight - c.scrollTop - c.clientHeight < 120;
}

function scrollToBottom() {
  const c = $("chat");
  requestAnimationFrame(() => { c.scrollTop = c.scrollHeight; });
}

// ---------------------------------------------------------------------------
// top buttons
// ---------------------------------------------------------------------------
$("stopBtn").addEventListener("click", async () => {
  if (!confirm("中止本轮？已发言的内容会留在屏幕上，但 AI 不会再继续。")) return;
  try {
    await fetch("/api/meeting/auto", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false })
    });
    $("hint").textContent = "已请求中止…";
    $("stopBtn").hidden = true;
    $("newBtn").hidden = false;
  } catch (err) {
    alert(`中止失败：${err.message}`);
  }
});

$("newBtn").addEventListener("click", exitChat);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function formatLabel(f) {
  return { summary: "结论纪要", actions: "行动项清单", weekly: "对外周报" }[f] || f || "summary";
}

function escapeHtml(str) {
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
    } else if (/^[-*]\s+\[\s?[xX ]\s?\]\s+/.test(line)) {
      flushPara();
      if (!inList) { out.push("<ul>"); inList = true; }
      const checked = /\[\s?[xX]\s?\]/.test(line);
      const text = line.replace(/^[-*]\s+\[\s?[xX ]\s?\]\s+/, "");
      out.push(`<li>${checked ? "✅ " : "▢ "}${formatInline(text)}</li>`);
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
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = "✓ 已复制";
      setTimeout(() => { btn.textContent = orig; }, 1500);
    }
  } catch {
    alert("复制失败，请手动选中文字复制");
  }
}

function downloadMarkdown(text) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.href = url;
  a.download = `agent-collab-${stamp}.md`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

boot();
