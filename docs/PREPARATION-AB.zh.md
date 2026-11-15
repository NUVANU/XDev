# 准备区 A+B：显式来源与默认采用

本版 `0.0.12+local.preparation.20261103` 恢复数据准备包。PowerShell 7.5+；正常源码只依赖系统/.NET。支持的准备工作必须实际调用以下入口并保留输入 pins、原始输出、实际耗时与拒绝/UNKNOWN；不得另写同类校验器。已有真实返回对象/FileRef 直接传递，无需为采用工具而重复派生文件。工具不创建 Job、不执行业务或正式 QA，也不拦截任意 shell。确实不支持的用途报 `UNSUPPORTED`，由 Root 只就最小缺口按当前授权补工具。


独立数据准备和只读字面检查，在当前已批准 FileRefs/根目录/写入范围下必须使用上述公开 PowerShell 入口。XDev MCP UNBOUND 不禁止这些已授权数据工具；它仍不提供 Job/QA 权限，也不得据此自动绑定或扩展项目权限。

## 最小 API

| 用途 | 入口与必填参数 |
| --- | --- |
| 原始 UTF-8 / JSON | `Read-PreparationRaw` / `Read-PreparationJson -Path -Sha256 -AllowedRoots`；JSON Document 由调用者 Dispose |
| 字段原文 | `Get-PreparationString -Read -Pointer [-UtcMilliseconds]` |
| 简单字面计数 | `Test-AuthorLiteral.ps1 -RulesPath -RulesSha256 -SourcePath -SourceSha256 -AllowedRoots` |
| 历史 21 行精确规则 | `Test-AuthorPreparation.ps1`，同上五参数；只接受 `root6-helper-rules-pending-actual-session-1` 精确 16 字段与 21 行原件，不沿历史路径访问旧库或应用替换 |
| 单材料派生与独立检查 | `Invoke-MaterialPreparation.ps1`，下列 A/B 参数全部显式提供 |
| 初始化包 | `Invoke-PreparationPackage.ps1 -Action Init -PlanPath -PlanSha256 -PackageDirectory` |
| 检查/冻结 | `-Action Check` / `Freeze -StatePath -StateSha256` |
| 外部观察 | `-Action Observe -StatePath -StateSha256 -ItemId -Outcome -ObservationPath -ObservationSha256` |
| 更正未消费依赖 | `-Action Correct -StatePath -StateSha256 -PlanPath -PlanSha256` |
| 短上下文/原文 | `-Action Context -StatePath -StateSha256`；`Expand` 再给 `-ItemId` 或 `-DiagnosticAttemptId` |

单材料 A 参数：`ApprovedContractPath/ApprovedContractSha256`、`SourcePath/SourceSha256`、`Purpose`、`ManifestPath`、`OutputDirectory`。B 六参数：`CheckerSourcePath/CheckerSourceSha256`、`CheckerApprovedContractPath/CheckerApprovedContractSha256`、`CheckerManifestPath/CheckerManifestSha256`。协调者在生成前分别批准并冻结独立 B；不从 A、产物、lineage 回填。用途限 `IMPLEMENTATION_RELEASE`、`IMPLEMENTATION_RECORD`、`RECORD_PREFLIGHT`、惰性 `CAPACITY_SUBJECT`；`FORMAL_QA_SUBJECT` 拒绝。精确合同/材料格式及全部原安全边界见 [固定材料](PREPARATION-READONLY.zh.md)。`-Fixture` 只对明确批准的 TEST_ONLY 惰性夹具启用。

## plan-2 与依赖

包输入精确字段如下，FileRef 始终为 `{path,sha256}`：

```text
format: xdev-preparation-package-plan-2
package_id, version: 非空字符串，最多80字符
scope: {project_id,project_root,job_id,task_id,spec_sha256,manifest_sha256}
material_contract: A批准合同FileRef
manifest: A完整清单FileRef
checker_contract: 独立B批准合同FileRef
checker_manifest: 独立B完整清单FileRef
required_constraints: 1..32个非空字符串，每个最多2048字符
sources: 1..64个 {id,ref:FileRef,depends_on:[source_id]}
materials: 1..32个 {id,purpose,source_id,checker_source_id,depends_on:[source_id]}
memory: {mode:EXTERNAL_EXPLICIT_ONLY,adoption:NOT_ESTABLISHED}
```

两个合同均绑定同一完整 scope，其 manifest pin 各自与 scope 一致。A/B 可在各自批准 input_root；每个读取仍核实际根。B source id 与路径必须独立，来源/依赖 ID 唯一且无未知 ID/环。两个来源族及各自传递依赖共同构成材料闭包；Check/Freeze/Observe 使用 B 的合同、清单、来源进行独立 Test-Material 核验。更正 A 或 B 来源/依赖只让关联材料回到 DRAFT；B 合同/清单改变影响全部材料。已 CONSUMED 的受影响项或删除项拒绝，UNKNOWN 不重放。

`Correct` 要求新 version、同 package/scope/A合同/A清单/约束，独立新 B 参数需由当前协调者批准。它不从旧 Job 猜新身份、不迁移 Job 或增加执行额度。未变更已消费项的原 artifact、observation、outcome 及诊断 observed_version 保留。

## 状态、诊断与兼容

状态为 DRAFT → CHECKED → FROZEN → CONSUMED；STALE/REJECTED 保留原证据后按有界当前更正规则处理。外部观察 Outcome 仅 `SUCCESS|COMMAND_FAILURE|ENVIRONMENT_FAILURE|UNKNOWN`。HEAD CAS 防止旧 state pin 写入；已有未完成 attempt/state 后缀表示 UNKNOWN，Context 披露，写操作拒绝。不能删锁/marker、换 ID 或重跑未知提交。

Observe 可选诊断三参数 `DiagnosticPath/DiagnosticSha256/DiagnosticAttemptId` 必须一起提供。诊断使用 `xdev-preparation-runtime-diagnostic-1`，独立绑定 scope/package/version/item/attempt 与当前 manifest；保留 outer/bridge/child 的 elapsed/timeout/exit/signal/EOF/natural_exit/error，STARTUP/VALIDATION/SAVE/READBACK 的实际 begin/end，ACK/commit 与原始 source_refs。缺测仍 null/UNKNOWN；相似失败不合并事件或推断根因。Context 给短结果，Expand 返回指定引用同次已核字节的完整文本。

Observe 先核 observation/诊断绑定和 SUCCESS 矛盾，拒绝路径不读无关 A/B 依赖且不写 attempt。接受路径仍完整重验来源、B checker、最终来源/observation/诊断 pins 后才写。SUCCESS 与非零 exit、signal、明确非自然退出/EOF失败、error.code、commit非COMMITTED或任一 ACK 非true 矛盾时 `DIAG_SUCCESS_CONFLICT`。无诊断不会补造 ACK。Check/Freeze 提交前还重新核来源与已保存观察/诊断；不使用跨动作安全缓存。

state-1 仍可承载当前 plan-2；首次保存诊断仅升级为 state-2，增加 diagnostics 引用数组。旧 state-1/state-2 若引用 plan-1（缺独立 B），只允许 Context/Expand 原文披露并明确 `LEGACY_PLAN_REBIND_REQUIRED`；Init/Check/Freeze/Observe/Correct 全拒绝，不静默升级或迁移旧 Job。建立新批准 plan-2/package 是独立当前动作，不能复活旧消费/失败。

常见拒绝：`CHECKER_SOURCE_UNKNOWN`、`CHECKER_SOURCE_NOT_INDEPENDENT`、`CHECKER_PLAN_SCOPE`、`CHECKER_PLAN_MANIFEST`、`PIN_DRIFT`、`PATH_LINK`、`STATE_CAS_CONFLICT`、`CONSUMED_OR_UNKNOWN_NO_REPLAY`、`UNKNOWN_UNCOMMITTED_ATTEMPT`、`LEGACY_PLAN_REBIND_REQUIRED`。拒绝可能是异常或结构化 REJECTED，必须保留真实形式及原文。状态/测试通过都不是 Owner 授权或执行许可。

## 已配置原生 XMem

工具真实加载时先 discover/status/storage 核明确项目根与既有 enabled/独立确认存储；按真实 task/version/role 显式 start 或 engineering bind/status，相关编辑前 query。获准公共关键发现保存后完整 read/expand 对账，阶段 checkpoint；EMPTY/INCOMPLETE/UNKNOWN 如实披露，不改变全局 memory、不新建/迁移库、不共享 Reviewer/QA 私有材料。原生 XMem 与另行配置的 XDev bridge 分开核验；XDev UNBOUND 不被称为 bridge 可用。无原生能力/未启用则披露缺口并继续不依赖它的已授权工作，记忆永远不提供执行权限。

## 验证与证据边界

冻结集成命令为 `node --test --test-reporter=tap tests/unit/preparation-ab.test.ts`，总上限60秒，八个 child 仍依次受 5/5/5/5/8/8/8/8 秒上限，要求自然退出。原八组行为及所有原断言保留，增加独立B局部失效/消费拒绝、legacy只读及矛盾拒绝前无依赖读取/无写入反例。夹具在源码根外使用 CreateNew，每次独立目录，公开21行原件只读按 pin 复制；不访问历史 UNKNOWN 现场库/key。环境变量 `XDEV_PREPARATION_EVIDENCE_ROOT` 可把本次原始 stdout/stderr/phases/receipt 放在当前角色批准外部证据根，否则写新隔离目录。作者自检、独立 Review、正式 QA、安装、fresh-host加载及真实默认采用分别报告，历史 FAIL/STOP/UNKNOWN 不被替换。
