# XDev 0.1.6 — native milestone Goal

Public source update · 2026-11-25 · MPL-2.0

## What changed / 本次变化

The main coordinator can offer Codex's native Goal for a current, confirmed and authorized milestone. It reads the existing Goal before offering and again before creation; preserves unfinished Goals; accepts only a genuine, applicable reply; and creates once under the current project's scope, XSpec, acceptance criteria, authorization and stop conditions. A missing tool, Later selection or unanswered option leaves ordinary authorized work available. Token budgets are passed only when explicitly specified by the user.

主统筹可为当前已确认、已授权的里程碑提供一次原生 Goal 选择。已有未完成 Goal 不覆盖；默认高亮不算提交；创建结果未知时先在原会话只读对账，不以改名、跨会话输入或盲目重试绕过。子代理、Review 与 QA 保留原分工。

See [the full workflow](CODEX-MILESTONE-GOAL.zh.md), [bounded continuation](R4-BOUNDED-CONTINUATION.zh.md), and [operation routing](R4-OPERATION-ROUTING.zh.md).

## Integration and compatibility

This public tree keeps the 0.1.5 runtime and its project-local layout and adds the qualified milestone Goal Skill/document changes. The local Goal source used an earlier runtime baseline; replacing the whole public tree would have removed existing layout support. Package, plugin and MCP release declarations use public version 0.1.6. These metadata changes do not rename persisted contracts, evidence fingerprints, adapter protocol versions or historical releases.

保留项目内与外置布局的原有边界。Goal 属于宿主生命周期能力，不增加 XDev 后台调度、自动续费、跨卡共享预算，也不放宽 Job、独立 Review、实际 QA、截止或授权。安装后重新连接并核对实际加载，已有会话热加载需另验。

## Validation scope

The Goal Skill/document increment passed separate source Review and bounded read-only regression checks in its local acceptance. Public packaging additionally checks the combined source with typecheck, continuation/hook regressions, project setup/UNBOUND regressions and an isolated SDK/stdio declaration check. See the repository README for the completed packaging results.

These checks do not establish a real product Goal's creation, cross-turn execution, clean-machine installation, current-chat reload, or end-to-end acceptance with the new XMi/XMem combination. Existing failures and UNKNOWN are not converted to PASS by publication. No measured bug-reduction or cost-saving percentage is claimed.
