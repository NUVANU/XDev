# R4 新任务合同

新正式 Node 代码任务使用 `xdev-supervised-request-5`，不选择或自动补 profile。v1—v4 和已有 Job 保持原格式解释。旧版程序拒绝 v5，不负责迁移。

协调者从当前项目规范与 Owner 确认整理目标、范围、关键行为、应保留行为及命令，使用既有 preparation 的原始意图、确认规格、确认来源和最小设计。不要求用户手填机器字段。确认来源是转交公开材料，不是原生身份认证；MCP 仍须本地配置显式批准准确 request FileRef。

v5 保留 spec、allowed_scope、forbidden_scope、acceptance_criteria、commands、excluded_scope、authorization、preparation，增加 check_requirements，并显式传 task_context 和 memory_boundary（无材料传 null）。首版 task_context 与 memory_boundary 只接受 null，旧 task basis 的档位派生入口尚不适配 v5；可直接按项目授权使用独立 XMem，v4 的既有物理边界桥接保持原支持范围。纯文档或其他非代码交付对象暂不走本正式 Node 协议，报告 UNSUPPORTED，按该对象的实际合同检查，不能伪称正式代码 QA 已通过。

check_requirements 的精确字段为：

```json
{
  "format": "xdev-check-requirements-1",
  "artifact_kind": "formal_code",
  "required_checks": ["review", "qa-execution", "qa-session"],
  "checker_independence": "non_author",
  "review_qa_separation": "same_checker_allowed",
  "behavior_criteria": ["AC-new-behavior"],
  "regression_criteria": ["AC-preserved-behavior"]
}
```

要求同时存在于 request、spec.check_requirements 和 preparation.confirmation_source 的 check_requirements，逐字节来源核对后作规范对象比较。确认 JSON 另含 source_claim=COORDINATOR_RECORDED_OWNER_CONFIRMATION、project_id、project_root、confirmed_spec（准确 spec FileRef）。缺来源、空检查、未知检查、作者豁免、空行为/回归、遗漏 AC 不得启动。三个 supported 检查分别承载非作者 Review、现有 runner 的实际运行、QA 本人自然结束及登记；额外项目承诺必须进入命名 AC 和完整命令覆盖，不能静默忽略。新检查种类须另行实现和验收。

review_qa_separation 可为 distinct_checkers，保留当前项目要求的三方分离；或 same_checker_allowed，沿用已验证的 public-session-1 verifier 路径：Review 自然结束并登记，真实 followup_task 的 XDEV_QA_RELEASE 绑定同 Job/候选/review_final，再本人下一轮 QA。两个职责和不同自然 final 都保留。public-session-2 仍只支持不同检查者。无论设置如何，作者不能 Review/QA 自己的正式交付。

现有 Store 的 verification_required 直接取当前确认的 required_checks，不转换为旧档位。record 的 Review 仍须 preparation_conformance/review_burden_justified，QA 的本人 final 必须准确引用原 runner receipt，所有 v5 都重核 active/completed session 一致性。查询显示本次要求与缺口，失败/claim-only/UNKNOWN/到期保持保守，原 final 恢复仍走原 permit、head CAS 和原身份，不重跑 QA。

授权的一次 start、一次执行、期限和停止规则不变。MCP 的一条冻结命令、90 秒及精确 Node24.19.0/24.20.0 限制不变。没有外部 Host/CI 回执替换或自动角色派发，不据此声称能拦截任意宿主编辑或发布。
