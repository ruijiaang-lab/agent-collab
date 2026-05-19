# Agent Collab · 圆桌会议控制台

> **人类主席制（Chair-Authority）多 Agent 协作框架** —— Codex、Claude Code、Hermes 在同一个会议层里发言、质询、提案，**人是主席，不是被工具拖着走的操作员**。

[![status](https://img.shields.io/badge/status-alpha-orange)]() [![license](https://img.shields.io/badge/license-MIT-blue)]() [![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)]()

---

## 为什么做这个？

业界主流的多 Agent 框架（swarm / crewai / autogen / langgraph）几乎都假设**Agent 之间自治协商**——结果是：

- **决策无仲裁**：Agent 互相妥协，输出平均值而不是最优解。
- **责任不可追溯**：出错后没人能复盘"谁在第几轮拍的板"。
- **人被边缘化**：操作员只能在最后看一个总结，过程中插不上嘴。

`agent-collab` 反其道而行：**人始终是会议主席**，Agent 只是参会方。主席发指令、Agent 出方案、主席裁决——整个流程被一个 state machine 记录下来，随时可回放、可导出 handoff。

## 核心概念

| 概念 | 说明 |
|---|---|
| **主席指令（Chair Directive）** | 最高优先级约束，所有 Agent 必须遵守 |
| **圆桌发言（Roundtable Turn）** | Agent 按"观点 / 质询 / 风险 / 执行计划"分类发言 |
| **提案裁决（Motion）** | Agent 提交提案，主席「通过 / 否决 / 暂缓 / 重议」 |
| **行动项（Task）** | 创建任务、分配负责人、跟踪状态 |
| **交接（Handoff）** | 任意时刻可导出 Markdown，粘贴给下一个 Agent 即可接续 |

## 架构

```
        ┌─────────────────┐
        │   WebUI (主席台)  │  http://127.0.0.1:5057
        └────────┬────────┘
                 │ REST API
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

- **单一事实源**：`data/state.json`，所有 Agent 读写同一份。
- **双协议接入**：Python MCP（给 Hermes/Claude Code 用）+ Node MCP（给其他 SDK）+ HTTP CLI（兜底）。
- **零依赖**：Node ≥ 20 即可，无需数据库。

## 快速开始

```bash
git clone https://github.com/<your-user>/agent-collab.git
cd agent-collab
npm start
# 浏览器打开 http://127.0.0.1:5057
```

## CLI 接入

```bash
npm run agent -- post claude-code "我建议先让 Hermes 整理长期上下文"
npm run agent -- task "实现 Hermes MCP wrapper" --owner claude-code --priority high
npm run agent -- claim TASK_ID hermes
npm run agent -- done TASK_ID codex "已补测试并验证"
npm run agent -- export
```

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

## 推荐三方分工

- **Codex** — 实现、测试、代码审查、自动化
- **Claude Code** — Claude 生态、插件 / Skill、代码实现与方案补充
- **Hermes** — 长期记忆、上下文整理、任务规划、外部消息网关

## 与 swarm / crewai / autogen 的区别

|  | swarm / crewai / autogen | **agent-collab** |
|---|---|---|
| 决策机制 | Agent 自治协商 | **人作为主席裁决** |
| 异构 Agent | 通常锁定单 SDK | 任意 Agent，只要会读 state.json |
| 可追溯 | 日志 | **状态机 + 提案 + 决策 + handoff** |
| 上手成本 | 需写 Agent 代码 | **MCP / CLI / WebUI 三选一** |

## Roadmap

- [ ] 主席否决后自动 re-prompt 失败方
- [ ] 决策回放 / 时间旅行
- [ ] 接入 Cursor / Devin / Manus
- [ ] 多会议并行 + 会议模板

## License

MIT
