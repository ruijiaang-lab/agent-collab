# Agent Collab · 圆桌会议控制台

> **人类主席制（Chair-Authority）多 Agent 协作框架** —— Codex、Claude Code、Hermes 在同一个会议层里发言、质询、提案，**人是主席，不是被工具拖着走的操作员**。

[![status](https://img.shields.io/badge/status-alpha-orange)]() [![license](https://img.shields.io/badge/license-MIT-blue)]() [![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)]() [![WAIC 2026](https://img.shields.io/badge/WAIC%202026-Future%20Tech%20OPC-purple)]()

---

## Why I built this

我同时使用 Codex、Claude Code、Hermes 三个 Agent 工具，并把它们当成一个"事实上的工程团队"在协作。在真实使用中我发现：我遇到的并不是"AI 不够聪明"，而是多 Agent 协作里很典型的三个系统性问题——

1. **改动冲突与上下文污染**：多个 Agent 同时修改相近文件时，容易出现互相覆写，最后往往要靠 `git reflog` 和 `diff` 一点点找回正确版本。
2. **决策机制缺失**：在面对"要不要重构某个模块"这类关键判断时，不同 Agent 常常给出都合理但方向不同的建议，却缺少一套统一机制去判断**该听谁、怎么记录、怎么复盘**。
3. **交接过程丢上下文**：一个 Agent 先做调研、留下大量笔记和中间判断，再交给另一个 Agent 接力实现时，交接环节很容易丢失原本的决策路径，导致后续执行不得不由我自己重新整理思路。

这些问题看起来是细节，但在真实协作里会不断放大，最后变成效率损耗、重复劳动和决策不可追溯。

所以我开始把它们收进一套本地圆桌式协作机制里：**让不同 Agent 在明确边界下讨论、决策、执行和沉淀，而不是各自聪明、彼此打架**。

这也对应业界主流多 Agent 框架（swarm / crewai / autogen / langgraph）共同的盲区——它们都假设 **"Agent 之间自治协商"**，听起来很美，实际上：

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

## v0.3：会议机制扩展 + 决策可回放

| 能力 | 说明 | 入口 |
|---|---|---|
| **Agent 投票** | 提案被主席裁决前，Agent 可表态 support / oppose / abstain，主席能看见票型再下判断 | `POST /api/motions/:id/votes` · WebUI 提案卡片内 |
| **事件溯源** | 所有 motion.proposed / voted / ruled / reprompted 落到 append-only `events[]`，可按 type/motionId/actor/since 过滤 | `GET /api/events` |
| **决策链回放** | 单个提案的 proposal → votes → ruling → re-prompt 全链路，按时间升序 | `GET /api/motions/:id/chain` · WebUI 决策链卡片 |
| **三轨泳道 UI** | Codex / Claude Code / Hermes 各一条轨 + 主席轨；每张发言卡带 round chip + stance chip；当前发言权高亮 | WebUI 顶部「泳道视图」 |

测试覆盖：27 条 assertion（[`scripts/test-reprompt.mjs`](scripts/test-reprompt.mjs) × 11 + [`scripts/test-events.mjs`](scripts/test-events.mjs) × 16），`npm test` 一并跑。

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

`get_state` · `post_message` · `chair_directive` · `update_meeting` · `roundtable_turn` · `propose_motion` · `cast_vote` · `get_motion_chain` · `list_events` · `create_task` · `update_task` · `record_decision` · `update_handoff` · `export_handoff`

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
- [x] **v0.3** Agent 投票 + 事件溯源 + 决策链回放 + 三轨泳道 UI
- [ ] **v0.4** 真 Agent runner（Claude / OpenAI 兼容端点，本地填 key 即可加入圆桌）
- [ ] **v0.5** 时间旅行 / 决策快照回放
- [ ] **v1.0** 多会议并行 + 会议模板 + Cursor / Devin 接入

---

## License

MIT
