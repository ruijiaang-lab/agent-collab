# Agent Collab · 圆桌会议控制台

> **人类主席制（Chair-Authority）多 Agent 协作框架** —— Codex、Claude Code、Hermes 在同一个会议层里发言、质询、提案，**人是主席，不是被工具拖着走的操作员**。

[![status](https://img.shields.io/badge/status-alpha-orange)]() [![license](https://img.shields.io/badge/license-MIT-blue)]() [![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)]() [![WAIC 2026](https://img.shields.io/badge/WAIC%202026-Future%20Tech%20OPC-purple)]()

---

## Why I built this

> 这一段是给评委 / 路人在 30 秒内 "认识作者" 的窗口。请在比赛前用第一人称、口语化、带具体细节地补完。

我同时使用 Codex、Claude Code、Hermes 三个 Agent 工具，并把它们当成一个"事实上的工程团队"在协作。在真实使用中我连续遇到三件事，让我意识到现在所有的多 Agent 框架都**没在解决我的真问题**：

1. **{{场景一：三个 Agent 同时改同一个仓库 / 文件，互相覆写——具体哪个项目、改了什么、最后怎么发现的}}**
2. **{{场景二：两个 Agent 对同一个决策给出矛盾建议（"必须重构" vs "别动"），你最后是怎么判断的、为什么这个判断很难做}}**
3. **{{场景三：上一个 Agent 留下了一堆未完成工作，下一个 Agent 接手时完全看不懂上下文——具体是什么任务、缺了什么交接、你花了多久补}}**

这三件事的共同根因：业界主流多 Agent 框架（swarm / crewai / autogen / langgraph）都假设 **"Agent 之间自治协商"**。听起来很美，实际上：

- **决策无仲裁**：Agent 互相妥协，输出平均值而不是最优解
- **责任不可追溯**：出错后没人能复盘"谁在第几轮拍的板"
- **人被边缘化**：操作员只能在最后看一个总结，过程中插不上嘴

`agent-collab` 反其道而行：**人始终是会议主席**，Agent 只是参会方。主席发指令、Agent 出方案、主席裁决——整个流程被一个 state machine 记录下来，随时可回放、可导出 handoff。

这个项目是我为 **WAIC 2026 Future Tech OPC 独立先锋挑战赛 · 创新赛道** 公开的早期原型。

---

## 核心概念

| 概念 | 说明 |
|---|---|
| **主席指令（Chair Directive）** | 最高优先级约束，所有 Agent 必须遵守 |
| **圆桌发言（Roundtable Turn）** | Agent 按"观点 / 质询 / 风险 / 执行计划"分类发言 |
| **提案裁决（Motion）** | Agent 提交提案，主席「通过 / 否决 / 暂缓 / 重议」 |
| **行动项（Task）** | 创建任务、分配负责人、跟踪状态 |
| **交接（Handoff）** | 任意时刻可导出 Markdown，粘贴给下一个 Agent 即可接续 |

---

## 架构

```
        ┌─────────────────┐
        │   WebUI (主席台)  │  http://127.0.0.1:5057
        └────────┬────────┘
                 │ REST API + SSE
        ┌────────▼────────┐
        │  Node Server     │  state machine + 持久化
        └────────┬────────┘
                 │
       ┌─────────┼─────────┐
       │         │         │
   ┌───▼──┐ ┌────▼───┐ ┌──▼────┐
   │ MCP  │ │  MCP   │ │  CLI  │
   │ (py) │ │ (node) │ │helper │
   └───┬──┘ └────┬───┘ └──┬────┘
       │        │         │
   ┌───▼──┐ ┌───▼────┐ ┌──▼────┐
   │Hermes│ │ Claude │ │ Codex │
   │      │ │  Code  │ │       │
   └──────┘ └────────┘ └───────┘
```

- **单一事实源**：`data/state.json`，所有 Agent 读写同一份
- **三协议接入**：Python MCP（给 Hermes/Claude Code 用）+ Node MCP（给其他 SDK）+ HTTP CLI（兜底）
- **零数据库依赖**：Node ≥ 20 即可

---

## 杀手锏：主席否决 → 自动 re-prompt（v0.2）

业界多 Agent 框架的"投票/裁决"基本是一次性事件——投完就完了，被否的方案石沉大海。`agent-collab` 把否决变成**循环驱动力**：

```
   Agent A          Chair (你)          State Machine
   ───────          ──────────          ─────────────
      │                  │                    │
      │── 提案 ────────► │                    │
      │                  │── 否决 ──────────► │
      │                  │   + 理由           │
      │                  │                    │ ① 自动追加高优 directive
      │                  │                    │   (sourceMotionId=…)
      │                  │                    │ ② floor → Agent A
      │                  │                    │ ③ round + 1
      │                  │                    │ ④ 写 reprompt 系统消息
      │ ◄── 自动唤起 ────┼────────────────────┤
      │                  │                    │
      │── 修订后再提 ──► │                    │
```

代码：[`server.js`](server.js)（PATCH `/api/motions/:id`） · 测试：[`scripts/test-reprompt.mjs`](scripts/test-reprompt.mjs)

幂等保护：同一提案被反复否决，只会触发一次 re-prompt（避免主席手抖刷屏）。

---

## 快速开始

```bash
git clone https://github.com/ruijiaang-lab/agent-collab.git
cd agent-collab
npm start
# 浏览器打开 http://127.0.0.1:5057
```

跑测试：

```bash
npm test
```

或者用 Docker（零 Node 依赖）：

```bash
docker build -t agent-collab .
docker run --rm -p 5057:5057 -v "$(pwd)/data:/app/data" agent-collab
```

> 更多启动方式（Compose、自定义端口、健康检查）见 [docs/run.md](docs/run.md)。

---

## 接入真 Agent（可选）

公开仓库不包含任何 API key。要让 Claude / Hermes / Codex 真正"开口"，你需要本地配 `.env`：

```bash
cp .env.example .env
# 编辑 .env，填入你自己的 Key 和模型
```

`.env.example` 支持任意 OpenAI/Anthropic 兼容端点：官方 Anthropic、OpenRouter、自建代理、Hermes Portal 等。

> 该模块在 v0.3 实装。在此之前，所有"Agent 发言"通过 CLI / MCP / WebUI 由人或外部 Agent 手动驱动。

---

## CLI 接入

```bash
npm run agent -- post claude-code "我建议先让 Hermes 整理长期上下文"
npm run agent -- task "实现 Hermes MCP wrapper" --owner claude-code --priority high
npm run agent -- claim TASK_ID hermes
npm run agent -- done TASK_ID codex "已补测试并验证"
npm run agent -- export
```

---

## MCP 接入

把下面配置加进 Claude Code / Hermes 的 MCP 配置：

```json
{
  "mcpServers": {
    "agent-collab": {
      "command": "python3",
      "args": ["/path/to/agent-collab/scripts/mcp_server.py"],
      "env": { "AGENT_COLLAB_URL": "http://127.0.0.1:5057" }
    }
  }
}
```

可用 tools：

`get_state` · `post_message` · `chair_directive` · `update_meeting` · `roundtable_turn` · `propose_motion` · `create_task` · `update_task` · `record_decision` · `update_handoff` · `export_handoff`

---

## 推荐三方分工

- **Codex** — 实现、测试、代码审查、自动化
- **Claude Code** — Claude 生态、插件 / Skill、代码实现与方案补充
- **Hermes** — 长期记忆、上下文整理、任务规划、外部消息网关

---

## 与现有方案的区别

| 维度 | swarm / crewai / autogen / langgraph | **agent-collab** |
|---|---|---|
| **决策机制** | Agent 自治协商，多数票或角色权重 | **人作为主席裁决**，否决理由强制写入 directive |
| **否决回路** | 一次性事件，被否方案石沉大海 | **自动 re-prompt + round 推进**，把否决变成循环 |
| **异构 Agent** | 通常锁定单一 SDK 或 Python | **任意 Agent**，只要会读 state.json（HTTP / MCP / CLI 三选一） |
| **可追溯** | 日志 / trace | **状态机 + 提案 ID + 决策链 + 可导出 handoff** |
| **上手成本** | 需写 Agent 类、定义 role、配 prompt | **打开 WebUI 即用**，无需写代码 |
| **人在哪** | 在系统外 | **在系统中心** |

---

## Roadmap

- [x] **v0.1** 主席台 WebUI + state machine + MCP/CLI 三通道
- [x] **v0.2** 主席否决后自动 re-prompt 失败方（[issue #1](https://github.com/ruijiaang-lab/agent-collab/issues/1)）
- [x] **v0.2** Docker 一键启动 + 启动文档（[docs/run.md](docs/run.md)）
- [ ] **v0.3** 真 Agent runner（Claude / OpenAI 兼容端点，本地填 key 即可加入圆桌）
- [ ] **v0.4** 决策回放 / 时间旅行
- [ ] **v1.0** 多会议并行 + 会议模板 + Cursor / Devin 接入

---

## License

MIT
