# XDev 0.1.4 / 公开源码更新

2026-11-17 · MPL-2.0

## What changed / 更新内容

This update helps the host coordinator continue toward the confirmed overall goal after a stage or current Job ends. It reuses the existing workflow and permissions.

- After implementation, Review, QA, a repair, or a Job final, check the remaining acceptance criteria, current candidate, dependencies, roles, authorization, budget, and deadline. Continue a specifically authorized and unblocked next step without waiting for another generic “continue”.
- Preserve each role's natural final and original receipts. Independent Review, actual QA, candidate binding, installation authority, and finite limits remain required by their original contracts.
- Add a static `primary_next_step.interpretation` with `coordination_owner: HOST`, `automatic_execution_scope: XDEV_RUNTIME_ONLY`, `completion_scope: CURRENT_JOB`, and `permission_granted: false`. Original status/reason/action and execution/delivery booleans retain their meanings. The interpretation itself grants no permission.
- Record concrete blockers and stop their dependent paths. An explicitly handled blocker does not prevent genuinely independent work already covered by authorization. UNKNOWN is reconciled under its original identity; it is not retried under a new one.
- Keep accumulated attempts and consumption across roles, directories, sessions, and Jobs. No new evidence means no repeat attempt; existing stricter correction/deadline limits take precedence. Two completed, authorized unsuccessful rounds trigger reassessment, not a new allowance.
- Stop reminds the coordinator to check the overall goal. SubagentStop preserves a completed role's natural final. Hooks return reminders only and do not block stopping, dispatch work, or wake an idle/closed session.

本次重点是减少“阶段已经结束，但尚有已授权工作时又等待用户说继续”的停顿。继续与否由当前具体授权、候选版本、独立性、额度、期限、写者状态及证据前置决定；单个 Job 完成不代表总体目标全部验收完成。原失败、消费、UNKNOWN、停止请求和过期窗口保持，不能靠更换身份或解释字段绕过。

See [bounded continuation](R4-BOUNDED-CONTINUATION.zh.md) for the exact policy and field interpretation.

## Source provenance and packaging / 来源与封装

The accepted owning source is the locally installed `0.0.23+local.r4.mech03.20261117` line. Its retained acceptance record covers 13 upstream file differences from the previous local source, with no deletions. The public synchronization copies its seven applicable runtime/skill/document changes. Upstream test changes and local acceptance logs remain outside the public payload.

Public package/plugin and MCP release declarations are aligned to **0.1.4**. Existing public MPL-2.0 metadata, marketplace descriptor, installation instructions, and curated source boundary are preserved. English/Chinese README and this note describe the new behavior without attaching internal batch identifiers to the public version.

The quality executor, writer/Store/claim/recovery logic, preflight permissions, hook configuration, dependencies, and runtime-build allowlists are unchanged. Public metadata and documentation change hashes; the upstream manifest is provenance, not an identity claim for this public package.

## Validation and retained limits / 验证与保留限制

- Upstream independent source/method Review: PASS.
- Upstream actual independent read-only source QA: **35/35** projection/hook tests and a successful typecheck. Four host-policy cases were read-only decisions, not business execution or background-continuation tests.
- Upstream local installation/cache consistency and a fresh CLI loading probe were checked. The loading probe was guided and does not count as independent behavior QA.
- **Full Job/MCP integration was not passed in that environment.** The candidate and unchanged prior source both produced **11/17**, with the same six failures. Five explicitly reported writer-domain unavailability; the sixth underlying response remains UNKNOWN. The original failures and consumption were retained; no guard or oracle was weakened. Independent QA did not run fixture-writing integration.
- There is no claim of cross-idle/background wakeup, automatic new rounds/shared budgets, all-host support, later real-product adoption, or measured long-term reductions in pauses or cost.

独立源码检查、完整任务集成、本机安装、宿主实际加载和真实项目后续采用分别看待。本次同步不将既有未通过或 UNKNOWN 改写成通过，不恢复旧 Job、claim、期限或余额；旧验证记录也不改绑到新公开包。

## Integration / 组合使用

Use the host's configured native XMem tools within the actual project/task authorization. This update does not change XMem or qualify a new runtime for the legacy XDev memory bridge. XMi and XMem public versions are unchanged.
