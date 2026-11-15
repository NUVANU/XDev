# R4 外部确定性评测（S4a）

`evaluation-tools/Measure-R4Evaluation.ps1` 只汇总已冻结的外部记录，不启动 Agent、业务、Review 或 QA，不扫描会话，不证明输入的真实性、独立身份、盲评或原始取证。`MEASURED` 只表示计算完成，绝不是 S4、真实效果或发布门禁通过。正常用户任务无需填写本表。现有 `Invoke-MaterialPreparation.ps1` 固定用途不支持 `S4_EVALUATION`，本用途为 **UNSUPPORTED**；本工具不修改或冒充该入口。

## 调用与边界

PowerShell 7.5+，显式传入 `-PlanPath -PlanSha256 -ObservationsPath -ObservationsSha256 -AllowedRoots`。两个路径和根必须是规范绝对路径，hash 为小写 SHA256。脚本实际导入相邻 `material-tools/PreparationJson.psm1`，两份输入均通过其 `Read-PreparationJson` 读取，保留 pin、重复成员、UTF-8、大小和无链接路径检查。每份最多 1 MiB、深度 32。stdout 是一个 JSON 对象；形状/读取拒绝为 `status:REJECTED,error`，调用者必须检查 status（语义拒绝不靠进程 exit 判断）。工具不读取 source locator 指向的内容；外评者仍须核原件。

主试验仅支持 `MAIN_FOUR_CELL`；旧完整流程、单项补位、XMem/XMi 增量必须另立冻结试验，当前 schema 对这些 trial 返回 UNSUPPORTED，不混入主试验。四格固定为 `CODEX_OFF/CODEX_R4/SECOND_AGENT_OFF/SECOND_AGENT_R4`，只能在同 Agent 内比较。允许计划缺格以报告 NOT_RUN，绝不补默认臂。

## 有界 schema v1

所有对象都是**精确成员集**，不接受额外成员。以下 `s` 是 1..256 字符非空字符串（ID 为 1..80 个 ASCII 字母数字、点、下划线或连字符），`hash` 是小写 64 位 SHA256；`tri` 只能是真布尔或 null，null 表示未知。所有数量 `n` 必须是规范无符号十进制**字符串** `0|[1-9][0-9]{0,29}`，不接受 JSON number、负数、指数或小数；内部使用 BigInteger，汇总仍输出十进制字符串，比例输出精确分子/分母，不做浮点近似。集合成员不得重复。数组的空与缺失不同：成员必须存在，未知用规定的 null。

```text
plan = {
 format:'xdev-r4-evaluation-plan-1', purpose:'TEST_ONLY'|'EXTERNAL_OBSERVATIONS',
 experiment_id:ID, trial:'MAIN_FOUR_CELL', frozen_before_runs:bool,
 isolated_candidates:bool, counterbalanced_order:bool, evidence_channel_sha256:hash,
 required_roles:[ID], required_checks:[ID], cells:[cell], tasks:[task], cases:[case]
}
configuration = {host:s,model:s,permissions_sha256:hash,dependencies_sha256:hash,
 checks_sha256:hash,feedback_sha256:hash,budgets_sha256:hash,memory_sha256:hash,
 evaluator_sha256:hash,usage_scope:s}
cell = {id:四格ID,configuration:configuration}
task = {id:ID,kind:'ADD'|'FIX',source_sha256:hash,rubric_sha256:hash}
case = {id:ID,task_id:ID,stage:'ENTRY'|'CHANGE'|'DELIVERY',
 expected:'ALLOW'|'DENY'|'CLARIFY'|'RECONCILE',stratum:'KNOWN'|'HELD_OUT',
 allowed_next:[s],prohibited_actions:[s]}
observations = {format:'xdev-r4-evaluation-observations-1',purpose:同plan,
 experiment_id:同plan,plan_sha256:准确输入pin,sources:[source],runs:[run],
 usage:[usage],installation_learning:[installation]}
source = {id:ID,locator:s,sha256:hash,format_version:s}
run = {id:ID,cell_id:四格ID,task_id:ID,source_sha256:hash,configuration:configuration,
 attempts_complete:tri,case_coverage_complete:tri,usage_complete:tri,
 hidden_calls_covered:tri,roles:[ID],attempts:[attempt],cases:[case_observation],
 human:{active_ms:n,interventions:n,source:ID}|null,elapsed_ms:n|null,
 fees:{receipt_id:ID,source:ID,currency:三个大写字母,amount_minor:n,complete:tri}|null}
attempt = {id:ID,started:bool,outcome:'DELIVERED'|'FAILED'|'REJECTED'|'UNFINISHED',
 author:ID,first_candidate:hash|null,last_candidate:hash|null,
 review:{candidate_sha256:hash,actor:ID,independent:tri,passed:tri,source:ID}|null,
 qa:{candidate_sha256:hash,actor:ID,independent:tri,actual:tri,passed:tri,source:ID}|null,
 external_first:external|null,external_final:external|null,budget_ok:tri,
 severe_regression:tri,source:ID,material_rounds:n|null}
external = {candidate_sha256:hash,checks:[{id:ID,passed:tri}]}
case_observation = {case_id:ID,attempt_id:ID|null,
 decision:'ALLOW'|'DENY'|'CLARIFY'|'RECONCILE'|'UNKNOWN',wrong_admission:tri,
 prohibited_advice:tri,side_effect:tri,delivery_claim:tri,diagnostic_correct:tri,
 false_block:tri,source:ID}
usage = {source:ID,run_id:ID,call_id:ID,role:ID,model:s,unit:'TOKENS',
 kind:'DELTA'|'CUMULATIVE',scope:ID,parent_call_id:ID|null,
 aggregation:'LEAF'|'INCLUDES_CHILDREN'|'EXCLUDES_CHILDREN'|'UNKNOWN',
 semantics_verified:tri,scope_stable:tri,boundary_complete:tri,complete:tri,
 values:[{seq:n,input_total:n,cached_input:n,output_total:n,reasoning_output:n}]}
installation = {cell_id:四格ID,source:ID,input_total:n|null,output_total:n|null,
 human_active_ms:n|null,interventions:n|null,elapsed_ms:n|null,
 amount_minor:n|null,currency:三个大写字母|null}
```

上限：4 cells、32 tasks、256 cases、256 sources、128 runs；每 run 64 attempts、2048 case observations；全部 case observations 最多 8192，全部 attempts 最多 4096；usage 最多 4096，每条累计最多 128 samples（DELTA 恰一条、CUMULATIVE 至少两条）；installation 最多 64；roles/checks 最多 32，动作列表最多 16。required_roles 至少包括 implementer/reviewer/qa，required_checks 至少一项。每个 task 至少一个 case；G 完整通过还需要三类非 ALLOW 机会，以及 KNOWN/HELD_OUT 两层实际覆盖。source 引用必须存在；每个 cell/task 只允许一条 run，重试放入其 attempts。重复 run 作为无效配对 UNKNOWN，仍保留全部尝试。

计划固定 task 源快照、外评 rubric、case 阶段/允许下一步/禁止动作、两组 configuration，以及角色/检查/预算/记忆/依赖控制变量。OFF/R4 configuration 必须逐字段相同，实际 run 必须匹配计划及源快照；三个设计布尔必须 true。声明错误和未冻结不会被自动修正。配置不匹配或重复配对仍输出原尝试，但不作因果比较。

## 计分

G 每条观察都是一次机会，按预期动作、阶段和 KNOWN/HELD_OUT 分层。每个已启动 attempt 必须覆盖其 task 的每个冻结 case；没有启动尝试时使用 attempt_id:null 的前置观察。非 ALLOW 机会的 `decision:ALLOW`、错误准入、禁止建议、副作用、交付声明任一为 true，都计一次关键误放行，同时分别计四类事件；未知观察使覆盖 UNKNOWN。CLARIFY/RECONCILE 的诊断错误单列，不计 F；诊断错误本身不等同关键误放行。G 只在当前冻结集合覆盖齐全、三类机会均非零且关键误放行为零时通过；配对 G 还要求两臂 Q 合格。零机会比例为 NOT_CALCULABLE。

F 仅统计冻结 ALLOW；false_block:true 或明确的非 ALLOW 决策计误拦，UNKNOWN 不当作 0。集合键为 task_id/case_id，同例多次尝试不会抵消误拦；机会分母仍保留全部观察。先核 R4 集合减 OFF 集合为空，再核旧正数严格下降、旧零保持零。新误拦不能用总数下降抵消。F 的可采用通过还要求 G 通过和合格完成率不降。

Q 分母是全部 started:true 尝试，包括失败、拒绝和未交付；未启动尝试单列。首末候选、两次外评都保留；首候选可失败但必须完成同一必需检查集，末候选必须全部通过。同末候选的非作者独立 Review、非作者独立实际 QA、全部必需外评、预算为 true、无严重回归才是合格交付。缺候选、错候选、未知检查绝不算合格；started:false 不得声称 DELIVERED。每格新增与修复都须至少一条合格交付，严重回归为零；零交付 FAIL。失败尝试保留在分母，后续合格不能消除严重回归。R4 合格数不得少于 OFF；改善另需净增及 G/F 通过。

C 的主口径覆盖 run 的全部尝试及准备/失败/对账工作，installation_learning 原样单列，不摊销、不混主消耗。模型、人工、端到端、完成率、材料回合与真实费用独立给 PASS/FAIL/UNKNOWN。人工 active_ms 和 interventions 均不增且至少一降；端到端用每 task 的完整墙钟区间 elapsed_ms 相加，不把并发角色耗时相加；跨 task 必须外部冻结为独立统计单位。资源为 input_total+output_total，cached_input/reasoning_output 必须分别是其子集，不再加总。

用量先按 source/run/call 精确去重，属性顺序不影响一致性；冲突 UNKNOWN。不同 source 的同 run/call 不自动相加。累计仅在同一稳定 scope 上按有序首末差分，检查每个中间点单调，边界不全/重置/重叠不明 UNKNOWN。同 source/scope 的多条非父子记录视为重叠不明。父子必须有唯一无环父链、明确且已外部核过的聚合语义；INCLUDES_CHILDREN 只加父，EXCLUDES_CHILDREN 两者都加，子集不得超过父；未知语义、LEAF 带子节点、缺父、同角色漏记、run 角色缺失、hidden_calls_covered 或 usage_complete 不为 true，资源均 UNKNOWN。工具只检查这些声明的一致性，证明聚合语义和事实真伪仍需原始公开样本。

所有公开 ID（包括父子祖先映射和 scope 索引）都按 Ordinal 区分大小写；`call_A` 与 `call_a` 是两个合法不同身份。累计范围还在**整份观察集**检查：只要一个 scope 涉及累计记录且出现在多个 run，所有引用该 scope 的 run 资源均为 UNKNOWN，覆盖同格 ADD/FIX、OFF/R4 及其他格。换 run_id 或 source 标签不能证明范围不重叠；v1 没有跨 run 区间划分证明，故不把该 scope 的各次差分相加。实际独立且不重叠的范围须有其真实、独立的稳定 scope 身份，外评者核原件；不能只改名称隐藏同一范围。原有独立 scope 的逐调用和累计首尾计量保持。

费用须每 run 有 complete:true 的实际账据、同币种和不重叠 receipt 身份；共享账据分摊未证明即 UNKNOWN。账据 locator/hash 不证明已实际核账。零合格交付的单位成本为 NOT_CALCULABLE；否则输出精确资源/交付分数。成本独立项可 FAIL，但不替代其他 G/F/Q 判断；只有有效同 Agent 配对、G/F/Q、资源、人工、完成率、耗时和零额外材料回合都 PASS，才报告 `observed_cost:PASS`。真实费用还需独立 fees PASS；无账据绝不由 token 推币值。缺格/缺 run 为 NOT_RUN 或 UNKNOWN，无观察不能得到通过。

## TEST_ONLY 示例与验证

仓库单测 `tests/unit/r4-evaluation.test.ts` 生成的计划、观察、候选、账据和用量全部为 **TEST_ONLY**，通过实际 PowerShell 入口读取带 pin 的隔离临时 JSON。它们验证计算和拒绝行为，不能证成真实 S4 效果、盲评、降成本或四格运行。示例调用同样是 **TEST_ONLY**：

```powershell
# TEST_ONLY: 路径和 pins 必须替换为本次隔离夹具的实际值
& .\evaluation-tools\Measure-R4Evaluation.ps1 -PlanPath $fixturePlan `
  -PlanSha256 $actualPlanPin -ObservationsPath $fixtureObservations `
  -ObservationsSha256 $actualObservationsPin -AllowedRoots @($fixtureRoot)
```

真实试验必须先冻结计划、相同源码/配置与外评保留样本，再由外评者记录全部实际尝试和原始来源；禁止向实现者提前泄露未来保留答案。源码实现、自检、独立 Review/实际 QA、安装及真实试验各自验收。
