// tasks.mjs — task CRUD with file-based storage (one JSON file per task)

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { getConfig } from "./config.mjs";

let _tasksDir = null;

export function init() {
  const cfg = getConfig();
  const base = cfg.storage.base_path;
  _tasksDir = path.isAbsolute(base)
    ? path.join(base, cfg.storage.tasks_dir || "tasks")
    : path.join(import.meta.dirname, "..", base, cfg.storage.tasks_dir || "tasks");
  if (!existsSync(_tasksDir)) mkdirSync(_tasksDir, { recursive: true });
}

function getTasksDir() {
  if (!_tasksDir) init();
  return _tasksDir;
}

function taskPath(id) {
  return path.join(getTasksDir(), `${id}.json`);
}

export function generateId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}${rand}`;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function createTask({ title, brief, mode = "roundtable", priority = "normal", assignedAgents = [] }) {
  const id = generateId();
  const now = new Date().toISOString();
  const task = {
    id,
    title: title || brief?.slice(0, 60) || "未命名任务",
    brief: brief || "",
    mode,             // roundtable | decompose
    status: "pending", // pending → discussing/decomposing → executing → synthesizing → completed / failed
    priority,
    assignedAgents,   // [] means auto-assign
    createdAt: now,
    updatedAt: now,
    // roundtable mode fields
    sessionId: null,
    startedRound: null,
    turnsByAgent: {},
    // decompose mode fields
    decomposeResult: null,   // hermes 拆解结果
    outputs: {},              // { agentId: { content, finishedAt, error } }
    synthesis: null,          // hermes 合成结果
    conclusion: null,         // final conclusion (roundtable mode)
    // metadata
    log: [{ ts: now, event: "created", detail: `mode=${mode}` }],
    reviewStatus: null        // null | "approved" | "rejected"
  };
  writeFileSync(taskPath(id), JSON.stringify(task, null, 2), "utf8");
  return task;
}

export function getTask(id) {
  const p = taskPath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function listTasks({ status, limit = 50, offset = 0 } = {}) {
  const dir = getTasksDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const tasks = [];
  for (const f of files) {
    try {
      const task = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
      if (status && task.status !== status) continue;
      tasks.push(task);
    } catch { /* skip corrupted files */ }
  }
  tasks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return tasks.slice(offset, offset + limit);
}

export function updateTask(id, updates) {
  const task = getTask(id);
  if (!task) return null;
  Object.assign(task, updates, { updatedAt: new Date().toISOString() });
  writeFileSync(taskPath(id), JSON.stringify(task, null, 2), "utf8");
  return task;
}

export function appendLog(id, event, detail = "") {
  const task = getTask(id);
  if (!task) return;
  task.log.push({ ts: new Date().toISOString(), event, detail });
  task.updatedAt = new Date().toISOString();
  writeFileSync(taskPath(id), JSON.stringify(task, null, 2), "utf8");
}

export function setTurn(id, agentId, content, stance = "") {
  const task = getTask(id);
  if (!task) return;
  task.turnsByAgent[agentId] = { content, stance, finishedAt: new Date().toISOString() };
  task.updatedAt = new Date().toISOString();
  writeFileSync(taskPath(id), JSON.stringify(task, null, 2), "utf8");
}

export function setOutput(id, agentId, content, error = null) {
  const task = getTask(id);
  if (!task) return;
  task.outputs[agentId] = {
    content: content || "",
    error: error || null,
    finishedAt: new Date().toISOString()
  };
  task.updatedAt = new Date().toISOString();
  writeFileSync(taskPath(id), JSON.stringify(task, null, 2), "utf8");
}

export function setSynthesis(id, content) {
  const task = getTask(id);
  if (!task) return;
  task.synthesis = content;
  task.updatedAt = new Date().toISOString();
  writeFileSync(taskPath(id), JSON.stringify(task, null, 2), "utf8");
}

export function setConclusion(id, conclusion) {
  const task = getTask(id);
  if (!task) return;
  task.conclusion = conclusion;
  task.updatedAt = new Date().toISOString();
  writeFileSync(taskPath(id), JSON.stringify(task, null, 2), "utf8");
}

export function deleteTask(id) {
  const p = taskPath(id);
  if (existsSync(p)) {
    unlinkSync(p);
    return true;
  }
  return false;
}
