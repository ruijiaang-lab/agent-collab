// pipeline.mjs — task execution engine: decompose → dispatch → synthesize
// Also supports continue-discussion and single-agent queries.

import { agentConfigs, spawnAgent, parseEnvelope, getInflight } from "./runner.mjs";
import * as tasks from "./tasks.mjs";
import { getConfig } from "./config.mjs";

// ---------------------------------------------------------------------------
// Decompose: Hermes breaks a task into subtasks
// ---------------------------------------------------------------------------

export async function decompose(taskId) {
  const task = tasks.getTask(taskId);
  if (!task) return { ok: false, error: "task not found" };

  tasks.updateTask(taskId, { status: "decomposing" });
  tasks.appendLog(taskId, "decompose", "started");

  const prompt = buildDecomposePrompt(task);
  const result = await callAgent("hermes", prompt);

  if (!result.ok) {
    tasks.updateTask(taskId, { status: "failed" });
    tasks.appendLog(taskId, "decompose", `failed: ${result.error}`);
    return result;
  }

  tasks.updateTask(taskId, {
    decomposeResult: result.content,
    status: "discussing"
  });
  tasks.appendLog(taskId, "decompose", "ok");
  return { ok: true, content: result.content };
}

// ---------------------------------------------------------------------------
// Dispatch: send subtasks to assigned agents, collect results
// ---------------------------------------------------------------------------

export async function dispatch(taskId) {
  const task = tasks.getTask(taskId);
  if (!task) return { ok: false, error: "task not found" };
  if (!task.decomposeResult) return { ok: false, error: "task not decomposed yet" };

  tasks.updateTask(taskId, { status: "executing" });
  tasks.appendLog(taskId, "dispatch", "started");

  // Determine which agents to call
  const cfg = getConfig();
  const agents = task.assignedAgents.length > 0
    ? task.assignedAgents
    : getAvailableAgents(cfg);

  if (agents.length === 0) {
    tasks.updateTask(taskId, { status: "failed" });
    tasks.appendLog(taskId, "dispatch", "failed: no available agents");
    return { ok: false, error: "no available agents" };
  }

  // Execute in parallel
  const results = await Promise.allSettled(
    agents.map(async (agentId) => {
      const prompt = buildDispatchPrompt(task, agentId);
      const result = await callAgent(agentId, prompt);
      tasks.setOutput(taskId, agentId, result.content, result.error);
      tasks.appendLog(taskId, "dispatch", `${agentId}: ${result.ok ? "ok" : "failed"}`);
      return { agentId, ...result };
    })
  );

  const succeeded = results.filter((r) => r.status === "fulfilled" && r.value.ok);
  const failed = results.filter((r) => r.status === "rejected" || !r.value.ok);

  tasks.appendLog(taskId, "dispatch", `done: ${succeeded.length} ok, ${failed.length} failed`);

  // Auto-synthesize if configured
  if (cfg.defaults.auto_synthesize && succeeded.length > 0) {
    return synthesize(taskId);
  }

  tasks.updateTask(taskId, { status: succeeded.length > 0 ? "completed" : "failed" });
  return { ok: succeeded.length > 0, succeeded: succeeded.length, failed: failed.length };
}

// ---------------------------------------------------------------------------
// Synthesize: Hermes combines all outputs into final deliverable
// ---------------------------------------------------------------------------

export async function synthesize(taskId) {
  const task = tasks.getTask(taskId);
  if (!task) return { ok: false, error: "task not found" };

  tasks.updateTask(taskId, { status: "synthesizing" });
  tasks.appendLog(taskId, "synthesize", "started");

  const prompt = buildSynthesisPrompt(task);
  const result = await callAgent("hermes", prompt);

  if (!result.ok) {
    tasks.updateTask(taskId, { status: "failed" });
    tasks.appendLog(taskId, "synthesize", `failed: ${result.error}`);
    return result;
  }

  const cfg = getConfig();
  const finalStatus = cfg.defaults.review_required ? "review" : "completed";

  tasks.updateTask(taskId, {
    synthesis: result.content,
    status: finalStatus
  });
  tasks.appendLog(taskId, "synthesize", `ok, status=${finalStatus}`);
  return { ok: true, content: result.content };
}

// ---------------------------------------------------------------------------
// Roundtable mode: agents discuss in sequence, then conclude
// ---------------------------------------------------------------------------

export async function runRoundtable(taskId) {
  const task = tasks.getTask(taskId);
  if (!task) return { ok: false, error: "task not found" };

  const cfg = getConfig();
  const agents = task.assignedAgents.length > 0
    ? task.assignedAgents
    : getAvailableAgents(cfg);

  if (agents.length === 0) {
    tasks.updateTask(taskId, { status: "failed" });
    return { ok: false, error: "no available agents" };
  }

  tasks.updateTask(taskId, { status: "discussing" });
  tasks.appendLog(taskId, "roundtable", `agents: ${agents.join(", ")}`);

  // Agents take turns
  const allTurns = [];
  for (const agentId of agents) {
    const prompt = buildRoundtablePrompt(task, agentId, allTurns);
    const result = await callAgent(agentId, prompt);
    const turn = { agentId, content: result.content, stance: result.stance || "观点", error: result.error };
    allTurns.push(turn);
    tasks.setTurn(taskId, agentId, result.content, result.stance || "观点");
    tasks.appendLog(taskId, "roundtable", `${agentId}: ${result.ok ? "ok" : "failed"}`);
  }

  // Synthesize conclusion
  tasks.updateTask(taskId, { status: "synthesizing" });
  const conclusionPrompt = buildConclusionPrompt(task, allTurns);
  const conclusion = await callAgent(agents[0], conclusionPrompt);

  if (conclusion.ok) {
    tasks.setConclusion(taskId, conclusion.content);
    tasks.setSynthesis(taskId, conclusion.content);
    const cfg2 = getConfig();
    const finalStatus = cfg2.defaults.review_required ? "review" : "completed";
    tasks.updateTask(taskId, { status: finalStatus });
    tasks.appendLog(taskId, "roundtable", `concluded by ${agents[0]}`);
  } else {
    tasks.updateTask(taskId, { status: "failed" });
    tasks.appendLog(taskId, "roundtable", `conclude failed: ${conclusion.error}`);
  }

  return { ok: conclusion.ok, turns: allTurns, conclusion: conclusion.content };
}

// ---------------------------------------------------------------------------
// Continue discussion: re-run with additional context
// ---------------------------------------------------------------------------

export async function continueDiscussion(taskId, newBrief) {
  const task = tasks.getTask(taskId);
  if (!task) return { ok: false, error: "task not found" };

  // Append new context to the task
  const updatedBrief = task.brief + "\n\n---\n\n## 追问\n" + newBrief;
  tasks.updateTask(taskId, { brief: updatedBrief });
  tasks.appendLog(taskId, "continue", newBrief.slice(0, 100));

  // Re-run roundtable with new context
  return runRoundtable(taskId);
}

// ---------------------------------------------------------------------------
// Ask single agent
// ---------------------------------------------------------------------------

export async function askAgent(taskId, agentId, question) {
  const task = tasks.getTask(taskId);
  if (!task) return { ok: false, error: "task not found" };

  tasks.appendLog(taskId, "ask", `${agentId}: ${question.slice(0, 80)}`);

  const prompt = buildAskPrompt(task, agentId, question);
  const result = await callAgent(agentId, prompt);

  if (result.ok) {
    // Store as a follow-up turn
    const existing = task.turnsByAgent[agentId];
    const content = existing
      ? existing.content + "\n\n---\n\n**追问回答：**\n" + result.content
      : result.content;
    tasks.setTurn(taskId, agentId, content, result.stance || "追问");
    tasks.appendLog(taskId, "ask", `${agentId}: ok`);
  } else {
    tasks.appendLog(taskId, "ask", `${agentId}: failed: ${result.error}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Agent calling abstraction (CLI or API based on config)
// ---------------------------------------------------------------------------

async function callAgent(agentId, prompt) {
  const cfg = getConfig();
  const provider = cfg.providers[agentId];

  if (!provider || provider.enabled === false) {
    // Check if CLI is available as fallback
    const cliConfig = agentConfigs[agentId];
    if (!cliConfig || cliConfig.enabled === false) {
      return { ok: false, error: `agent ${agentId} is not available`, content: "" };
    }
    return callAgentCLI(agentId, prompt);
  }

  if (provider.mode === "api") {
    return callAgentAPI(agentId, provider, prompt);
  }

  // CLI mode (default)
  return callAgentCLI(agentId, prompt);
}

async function callAgentCLI(agentId, prompt) {
  const config = agentConfigs[agentId];
  if (!config || config.enabled === false) {
    return { ok: false, error: `CLI for ${agentId} not available`, content: "" };
  }

  try {
    const rawStdout = await spawnAgent(config, prompt);
    const envelope = parseEnvelope(rawStdout, config.parseWrapper);
    return {
      ok: true,
      content: envelope.content || "",
      stance: envelope.stance || ""
    };
  } catch (err) {
    return { ok: false, error: err.message, content: "" };
  }
}

async function callAgentAPI(agentId, provider, prompt) {
  const { base_url, api_key, model, api_format, timeout } = provider;

  if (!base_url || !api_key) {
    return { ok: false, error: `${agentId}: API mode requires base_url and api_key`, content: "" };
  }

  try {
    if (api_format === "openai") {
      return await callOpenAICompatible(base_url, api_key, model, prompt, timeout);
    } else {
      return await callAnthropicCompatible(base_url, api_key, model, prompt, timeout);
    }
  } catch (err) {
    return { ok: false, error: err.message, content: "" };
  }
}

async function callAnthropicCompatible(baseUrl, apiKey, model, prompt, timeout = 180) {
  const url = baseUrl.replace(/\/$/, "") + "/v1/messages";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (timeout || 180) * 1000);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: model || "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }]
      }),
      signal: controller.signal
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 200)}`, content: "" };
    }

    const data = await resp.json();
    const content = data.content?.[0]?.text || "";
    return { ok: true, content, stance: "" };
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAICompatible(baseUrl, apiKey, model, prompt, timeout = 180) {
  const url = baseUrl.replace(/\/$/, "") + "/v1/chat/completions";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (timeout || 180) * 1000);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || "gpt-4",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4096
      }),
      signal: controller.signal
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 200)}`, content: "" };
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || "";
    return { ok: true, content, stance: "" };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildDecomposePrompt(task) {
  return `你是一个任务拆解专家。请将以下任务拆解成具体的子任务，分配给合适的 AI 执行。

== 任务 ==
标题：${task.title}
描述：${task.brief}

== 要求 ==
输出 JSON 格式：
{
  "strategy": "整体策略说明",
  "subtasks": [
    {
      "title": "子任务标题",
      "description": "具体要做什么",
      "assignedTo": "claude-code 或 hermes 或 codex",
      "acceptanceCriteria": "怎么算完成"
    }
  ]
}

注意：
- 子任务要具体可执行，不要模糊
- 根据各 AI 擅长的领域分配（Claude Code: 方案/创意/分析，Codex: 工程/实现/测试，Hermes: 整理/综合/记忆）
- 可以只分配给一个 AI，也可以分给多个
- 子任务数量建议 1-5 个`;
}

function buildDispatchPrompt(task, agentId) {
  return `你正在执行一个协作任务中的子部分。

== 原始任务 ==
${task.title}：${task.brief}

== Hermes 的拆解结果 ==
${task.decomposeResult}

== 你的角色 ==
你是 ${agentId}。请根据拆解结果，完成分配给你的子任务。
直接输出结果，不需要重复任务描述。用中文回答。`;
}

function buildSynthesisPrompt(task) {
  const outputs = Object.entries(task.outputs || {})
    .filter(([, v]) => v && v.content)
    .map(([agent, v]) => `### ${agent}\n${v.content}`)
    .join("\n\n");

  return `你是任务合成专家。请将各 AI 的产出整合成一份最终交付物。

== 原始任务 ==
${task.title}：${task.brief}

== 各 AI 产出 ==
${outputs || "（无）"}

== 要求 ==
1. 整合所有有效产出，去重、补缺、统一格式
2. 标注哪些部分来自哪个 AI
3. 如果有分歧，列出不同观点
4. 给出最终结论和建议
5. 用结构化 Markdown 输出`;
}

function buildRoundtablePrompt(task, agentId, previousTurns) {
  const history = previousTurns.length > 0
    ? "\n\n== 之前的发言 ==\n" + previousTurns.map((t) => `**${t.agentId}**（${t.stance}）：${t.content}`).join("\n\n")
    : "";

  return `你正在参加一场圆桌讨论。

== 议题 ==
${task.title}：${task.brief}
${history}

== 你的角色 ==
你是 ${agentId}。请发表你的观点。
- 用中文回答
- 开头用 [观点] / [质疑] / [补充] / [风险] 标注你的立场
- 300-800 字
- 直接输出内容，不要加前缀或后缀`;
}

function buildConclusionPrompt(task, turns) {
  const transcript = turns.map((t) => `**${t.agentId}**（${t.stance}）：${t.content}`).join("\n\n");

  return `请综合以下讨论，生成一份结构化结论。

== 议题 ==
${task.title}：${task.brief}

== 讨论记录 ==
${transcript}

== 输出格式 ==
用 Markdown，包含以下部分：
## 共识
（各方一致同意的点）

## 分歧
（各方不同意见）

## 行动项
（可执行的下一步，带负责人）

## 风险
（需要注意的点）`;
}

function buildAskPrompt(task, agentId, question) {
  const context = task.synthesis || task.conclusion || "";
  const turns = Object.entries(task.turnsByAgent || {})
    .map(([a, t]) => `**${a}**：${(t.content || "").slice(0, 500)}`)
    .join("\n\n");

  return `你之前参与了一场讨论，以下是讨论结果和你的发言。

== 议题 ==
${task.title}：${task.brief}

== 讨论结论 ==
${context}

== 之前的发言 ==
${turns}

== 追问 ==
${question}

请用中文回答，300-600 字。`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAvailableAgents(cfg) {
  const agents = [];
  for (const [id, provider] of Object.entries(cfg.providers)) {
    if (provider.enabled === false) continue;
    agents.push(id);
  }
  // Also check CLI configs
  for (const [id, cliCfg] of Object.entries(agentConfigs)) {
    if (cliCfg.enabled === false) continue;
    if (!agents.includes(id)) agents.push(id);
  }
  return agents;
}
