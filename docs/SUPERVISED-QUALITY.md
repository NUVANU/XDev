> 当前0.0.9首选SDK a4a3e1d98344a3afe75183a3bd075c2c7da6399ed6c10267941146c1ffd9aab2（工程/2、记录/1），实际批准根/38pins与生产依赖按本次配套交付。此前章节的固定机器目录与54e0/旧计数是历史，54e0仅兼容工程/1；当前规则见SOURCE02-REMEDIATION-0.0.9.zh.md、INSTALL-0.0.9.zh.md及HOST-ACCEPTANCE-0.0.9.zh.md。

# Supervised code quality

## Missing QA final recovery

`task recovery-status` (optional `--source ORIGINAL_RECORD`) reads the original
claim/run/final chain and exact revision/head without writing. Missing original
QA final/completion remains ORIGINAL_QA_FINAL_UNAVAILABLE / BLOCKED; a consumed
claim without a committed run remains UNKNOWN. Never rerun QA or substitute a
signer. `task recover-qa --source RECOVERY_REQUEST` needs a separate, current,
exact ORIGINAL_FINAL_REPLAY permit with execute_qa:false. Historical execution
authorization may expire but must remain byte-identical. Normal record and
recovery share the same locked atomic final commit and read-only idempotent
replay. The optional MCP recovery configuration grants only these dedicated
operations, independently of historical request approvals and execution rights.
See [QA-RECOVERY.zh.md](QA-RECOVERY.zh.md) for exact schemas, refusal states and
the input/Store boundary. Synthetic tests do not establish real host acceptance.

## D1.5 supervised preparation (request v3)

For ordinary new tasks the coordinator first reads the owner's original input,
discusses only unresolved requirements, and records whether the current spec is
confirmed and conflicts resolved. One clear sentence can be sufficient. The owner
does not fill JSON, UUIDs or hashes. The coordinator prepares these artifacts from
the actual public discussion. Nonempty fields alone do not establish clarity.

The read-only normal CLI route is:

```text
node --experimental-strip-types src/owner-ux/xdev.ts task prepare --mode supervised --project-root PROJECT --project-id ID --source PREPARATION
```

An optional `--control-root CONTROL` is accepted but never opened. Prepare creates
no directory, Job, start claim or role. It returns READY, NEEDS_CLARIFICATION,
CONFLICT or UNSUPPORTED with a reason and concrete questions from the recorded
discussion. Invalid versions, unknown decisions, malformed or drifted sources
return UNSUPPORTED with the failing binding and a repair question. The code checks
explicit declarations and current byte bindings; it does not independently detect
all ambiguity or contradictions, authenticate the owner/coordinator, or prove the
semantic truth of the declarations. The coordinator must actually read and assess
the original input. Missing confirmation, unknown assessments and open questions
cannot be promoted to READY simply because documents exist.

Preparation JSON has exactly these fields (FileRefs are `{path,sha256}`):

```text
{format:'xdev-supervised-preparation-1',project_id:ID,project_root:PROJECT,
 original_intent:FileRef,confirmed_spec:FileRef|null,
 confirmation_source:FileRef|null,minimal_design:FileRef|null,
 assessment:{source_claim:'COORDINATOR_RECORDED_PUBLIC_DISCUSSION',
   decision:'READY'|'NEEDS_CLARIFICATION'|'CONFLICT'|'UNSUPPORTED',
   reason:'specific discussion-based reason',questions:['unresolved question'],
   original_intent_read:true|false|null,requirements_confirmed:true|false|null,
   conflicts_resolved:true|false|null}}
```

READY requires all three explicit assessment booleans true, no questions, and
nonempty pinned original intent, current confirmed spec, public confirmation
source and minimum necessary design. Unready records may omit the last three
refs with null and must list specific unresolved questions. The confirmation
source is the original public discussion/owner confirmation, retained as bytes,
not a synthetic fixture or an invented approval. A short design or applicable
existing design is enough; a full PRD or new architecture platform is not required.

`xdev-supervised-request-3` has all v2 fields below plus `preparation:FileRef`.
Its prepared project ID/root and confirmed spec must match the request subject
and exact spec FileRef. Invalid or unready preparation is refused before opening
the JobStore or consuming start authorization. The current assessment and all
source refs are saved inside the existing immutable Job contract's entry. Record,
QA, self-check and both queries revalidate that same chain, including the original
preparation document. Changing intent, confirmation, spec or design bytes blocks
delivery and execution. Queries preserve the historical journal. Only v3 reports
`preparation_verified:true` after this deterministic preparation check succeeds;
that field has the declaration/binding meaning above, not semantic completeness.
V1/v2 remain compatible and report no D1.5 preparation assurance.

For v3 Review the independent reviewer's record and own natural final must both
include explicit booleans `preparation_conformance` and
`review_burden_justified`, matching exactly. The first declares that the reviewer
personally compared the original intent, confirmed spec, minimum design and
actual diff. The second declares that significant review requirements are based
on a requirement or concrete risk. Document that reasoning in the actual review
opinion. Missing, unknown, mismatched or false conclusions cannot release QA or
delivery, even with green tests. A reviewer must not silently add ACs, execution
commands, permissions or time windows. A real scope change returns to the owner
or the applicable existing delegated authority and a newly bound contract.
V3 keeps the original v2 risk floor and quick/full/prototype actor, claim, deadline
and runner semantics, including two real quick checker turns and distinct finals.

XMi is optional guidance at https://github.com/NUVANU/XMi (observed public version
0.1.0-alpha.1, commit d775e77573844a4328decb0e372804a511914f0c, XSpec 0.3.0).
Clear requirements can proceed directly. This entry does not install or call XMi,
save anything into XMi, connect its MCP, or import arbitrary XMi/XSpec files.
Keep original exports, versions, exclusions and risk constraints for a manual
handoff; automatic consumer compatibility is unsupported and must not be claimed.

Module responsibilities stay small: `supervised-preparation.ts` parses the
versioned preparation record using the existing safe FileRef reader and unique
JSON parser; `supervised-quality.ts` binds it to the existing Job contract;
`owner-ux/xdev.ts` routes the CLI. Profile policy, runner, claims and JobStore stay
the existing authorities. The FileRef/version boundary is the future integration
point for an explicitly tested importer; no adapter, monitor, generic semantic
engine, second Store or future runtime is prebuilt. Current Node checks do not
prove engine/UI support or acceptance on the owner's pending real Agent project.

## Compatible v1/v2 execution contracts

V2 consumes a CreateNew receipt keyed by the exact authorization source path and
hash in the approved external control domain before Job creation. Repeating the
same source (including changing profile UUID) is refused; failed/unknown creation
does not release it. This receipt is an action slot, not a second Job Store.
Queries report execution_allowed=false for consumed claims or terminal Jobs.
Prototype execution rechecks its saved implementation source, public proof,
release and code manifest before it can claim or run anything.

Current workspace entry is `skills/xdev-supervised/SKILL.md`. Its coordinator
generates frozen JSON, hashes and UUIDs from confirmed owner inputs; no user
hand-filling or installation is required. This remains supervised source use.

V2 adds `profile` (the existing D1ProfileRequest) and `authorization` with pinned
`source`, ISO `not_before`/`expires_at`, `implementation_limit:1`,
`execution_limit:1`, `stop:false`. The XSpec adds `entry_profile` containing the
same purpose/requested_profile/impact and authorization terms without source.
`profile.receipt_sha256` is the XSpec hash. The purpose/risk JSON source contains
purpose, goal, requested_profile, impact, four facts booleans (no evidence_refs),
risk_categories, risk_reason, complexity and legacy_flow_difference_reason.
The authorization JSON source is `{authorization:TERMS}`. All original sources
are hash-checked and the original decideD1Profile decision is recomputed on all
reads/writes. V1 retains its existing formal three-session meaning.

Full governance uses the existing three-actor independent Review/QA chain. V2
`quick_verified` is available only when the unchanged profile policy selects it:
an ordinary, bounded formal change with explicit source-backed risk facts. It
does not lower the risk floor or silently change the owner's purpose. A separate
checker may perform both Review and actual QA, with two natural work turns and
two separate decisions; the implementer can never be that checker. A verifier's
real `agent_type` stays `verifier` while reviewing. A reviewer may still Review
with a different verifier doing QA. V1 and full governance retain three actors.
Prototype records
implementation then invokes the same claim/runner using `task self-check`,
`format:xdev-supervised-self-check-request-1` and its implementation session.
It always remains PROTOTYPE_UNVERIFIED. Each command needs its entire declared
timeout to fit the remaining authorization window before starting. One recorded
implementation and one durable execution claim consume the finite allowance;
failure/interruption cannot be retried in that Job. Query expiration never
automatically dispatches, extends authority or rewrites historical conclusions.

This explicit mode reuses the recoverable JobStore journal and content-addressed
evidence. It does not alter native D1 intake/admission, profile gates, provenance,
historical results, resource accounts, XMem or Host configuration.

Use the current Node CLI with **absolute, canonical paths**. The external control
parent must already exist and must not overlap the project. No default thread or
session discovery occurs. Every project file participates in the snapshot; this
bounded path rejects links, special files and excluded files. Commands use the
current Node executable directly, without a shell/eval/preload.

```
node --experimental-strip-types src/owner-ux/xdev.ts task start --mode supervised --project-root PROJECT --control-root CONTROL --project-id ID --source REQUEST
node --experimental-strip-types src/owner-ux/xdev.ts task record --mode supervised --project-root PROJECT --control-root CONTROL --project-id ID --job JOB --source RECORD
node --experimental-strip-types src/owner-ux/xdev.ts task qa --mode supervised --project-root PROJECT --control-root CONTROL --project-id ID --job JOB --source QA_REQUEST
node --experimental-strip-types src/owner-ux/xdev.ts task run-status --mode supervised --project-root PROJECT --control-root CONTROL --project-id ID --job JOB
node --experimental-strip-types src/owner-ux/xdev.ts task run-result --mode supervised --project-root PROJECT --control-root CONTROL --project-id ID --job JOB
```

`REQUEST` is immutable JSON:

```
{format:'xdev-supervised-request-1',spec:{path,sha256},allowed_scope:[exact_paths],
 forbidden_scope:[paths_or_prefixes],acceptance_criteria:[{id,text}],
 commands:[{id,argv,criteria:[ac_ids],timeout_ms,required_output:[literal_strings]}],
 excluded_scope:[]}
```

The pinned XSpec JSON must have a nonempty `goal` and exactly the same
`acceptance_criteria`, `allowed_scope`, `forbidden_scope` and `quality_commands`
(mapped to request `commands`). A request cannot quietly rewrite the XSpec.
The only accepted Node flags are `--test` and `--test-reporter=tap`.

Start records the baseline and returns the next supervised Host action; it does
not dispatch. The coordinator consumes that action with the public Host tool.
After the implementer naturally finishes, record its immutable source manifest.
The implementer record must additionally pin `job_release:{path,sha256}` whose
JSON contains `{job_id,task_name,message}`. This binds an explicitly released Job
even if its Worker was initially dispatched before Job registration; that order
must be disclosed. Public session and source references are coordinator transferred
observations, **not native authenticated identities or full native traces**.

Each session object has `format:'xdev-supervised-public-session-1'`, `role`
(`implementation`, `review`, `qa`), `session_ref` (full public task path),
`source_claim:'COORDINATOR_TRANSFERRED_PUBLIC_TOOLS'`,
`native_authenticated:false`, `dispatch_request:{path,sha256}`,
`dispatch_return:{path,sha256}`, `natural_final:{path,sha256}`,
`natural_end:true`, `stop_requested:false`. Dispatch request JSON must expose
the exact `agent_type` (`worker`, `reviewer`, `verifier`) and short `task_name`;
only V2 quick Review additionally accepts an actual `verifier` checker without
relabeling its public dispatch. QA always requires an actual `verifier`.
return JSON must expose the full `task_name`. Natural final JSON must contain
`{task_name:full_path,status:'completed',stop_requested:false,final:full_text}`.
Keep original public tool data alongside any explicitly labelled projection.

`RECORD` contains `{format:'xdev-supervised-record-1',job_id,role,session,
manifest_sha256}`. The manifest hash is SHA256 of the existing JobStore canonical
JSON encoding of the complete sorted `[{path,sha256}]` project snapshot, without
a trailing newline. Review also supplies `scope_pass:boolean` and one explicit
`checks:[{id,passed,reason}]` entry per AC. An independent checker must PASS Review
before QA. Missing/unknown scope or AC cannot advance.

Review and QA records also carry the independent person's explicit
`decision:'PASS'|'FAIL'|'BLOCKED'`; QA additionally supplies `qa_pass:boolean`.
Their structured natural-final public projections must contain precisely the
same decision, checks and scope/QA flag. The final person's FAIL/BLOCKED, missing
AC, or record/projection mismatch cannot be replaced by command exit zero. In
quick mode the QA natural-final projection must also contain the exact
`qa_receipt:{id,sha256}` from its own executed command run.

For a quick verifier continuing after its own completed Review, keep its original
dispatch request/return references unchanged and add `qa_continuation:{path,sha256}`
to both the active QA session and completed QA session. That referenced JSON is:

```
{format:'xdev-supervised-qa-continuation-1',tool:'collaboration.followup_task',
 target:full_checker_path,job_id:JOB,review_final:{path,sha256},
 request:{path,sha256},response:{path,sha256}}
```

`request` pins the actual public followup input `{target:full_checker_path,message}`;
that actual message must contain exactly one unindented line starting with
`XDEV_QA_RELEASE=` followed by the JSON object
`{stage:'qa',job_id:JOB,manifest_sha256:CURRENT,review_final:{path,sha256}}`.
These four exact keys are required; duplicate JSON keys, unknown fields, missing
or repeated markers, wrong stage/Job/version/Review final are refused before the
execution claim. The current checked project manifest and recorded Review final
must match the values inside the original operation, not only its outer wrapper.
`response` pins its actual raw return (including an explicitly recorded null/empty
return). The coordinator first saves and records the Review natural final, then
performs and records that followup, before the checker's next turn runs QA. The
Review final hash, target and Job must match. The final QA proof must use the same
original dispatch and continuation as its execution claim, with a distinct final
path and distinct final bytes. These are coordinator-observed public continuation
records, not a native turn identifier, native authentication or adversarial proof
against that coordinator. A changed filename/hash alone never establishes a new
actual turn. Keep both actual public natural ends and both own decisions.

The independent QA personally invokes `task qa` with
`{format:'xdev-supervised-qa-request-1',job_id,session,manifest_sha256}`. Its session
must have `natural_final:null,natural_end:false` at execution time. The command
runs each frozen Node command once and saves full byte-recoverable stdout/stderr,
Before any command, an existing JobStore verification receipt atomically claims
QA at the original expected revision; an existing/unknown claim is consumed and
cannot be retried after a crash. The result pins the same claim, session and version.
hashes, argv/cwd, UTC times, exit/signal/error, timeout/output limits and before/after
source hashes. Failed/skipped/missing/timeout/overflow outputs cannot pass. It
returns `qa_receipt`, while delivery remains false. After QA's actual natural
final, record the completed QA session with `qa_receipt` referencing that exact
run. Implementer, Reviewer and QA public sessions must be distinct for full/v1;
quick permits the same independent verifier for the two sequential checks under
the continuation contract above. All modes keep the existing single execution
claim, CAS/replay guards, deadline, finite source authorization and refusal rules.

Both result queries use one current assessment and re-read the pinned XSpec,
request, public evidence and complete project manifest even after terminal state.
Drift prevents delivery while preserving the historical journal's stored state.
Only the explicitly scoped result is `SUPERVISED_CODE_QUALITY_VERIFIED`;
`strict_d1_pass:false` always remains. Global descendant closure, native identity
authentication, adversarial coordinator tamper resistance and historical D1
acceptance are not claimed. A failed stage is preserved; corrections use a new
bounded Job and fresh checks, never overwrite an old receipt.

## 0.0.9 当前补充

本文件此前版本、固定机器路径与SDK身份说明按原时点保留；当前事务/重放、writer能力预检、SDK精确build及/2双hash、显式同key前驱更正、正常授权边界转交和构建要求，以[SOURCE02-REMEDIATION-0.0.9.zh.md](SOURCE02-REMEDIATION-0.0.9.zh.md)为准。实际资格与未验范围看包外交付报告，每个目标填[HOST-ACCEPTANCE-0.0.9.zh.md](HOST-ACCEPTANCE-0.0.9.zh.md)，不从文字自行填PASS。

## MECH-01 host coordination policy

MECH-02适用边界：本节实施卡、单卡串行、独立Review/实际QA和滚动发布约束产品开发。日常操作及高风险叠加规则先按[操作类型与风险](R4-OPERATION-ROUTING.zh.md)选择相称流程，不默认生成开发卡或要求MCP绑定。既有Job、承诺过的检查、权限和UNKNOWN仍按原合同，不因分类变化被降级。

适用层级：host/coordinator skill policy，作用于同一协调工作流及其委托角色。原 Core 的单 Job/授权 claim/版本与独立质量门禁仍由既有代码执行；本节的跨卡次序由宿主协调者遵守，当前没有新增跨卡代码锁或代码拒绝证据。不得将历史 PLANNED 项改称已代码实现。

一张最小可验收卡在现有卡/交接中写清目标、包含/排除范围、验收条件、依赖前置、完成/阻塞状态、交付状态与原证据即可。不得增加第二状态库、通用框架、多层审批或未知 Core schema 字段。实现、独立 Review、实际 QA 和必要纠正是同一卡阶段；单条命令不是一张产品卡。

宿主卡不取代 Core Job；既有规则要求新有界 Job/重绑时，仍按本卡适用授权和原门禁处理、保留旧证据。任务执行角色的禁止安装约束保持；验收后覆盖授权内的发布/安装由宿主协调者按现有流程推进。

前卡未验收且没有明确阻塞处置时，不派下一张独立实施卡。阻塞处置须保留事实/FAIL/STOP/UNKNOWN、原消费、依赖和未完成项，并记录现有授权内的停止或暂挂及来源；不得改成完成、续旧期限、复活 claim，或绕过未知提交。授权范围内的协调者直接处置，不重复索取同一权限。必须共同核验的依赖同批，不将依赖失败核心的外围拆成绿色交付。

以下是独立角色应实际演练的规则场景，不是本说明已执行/通过的测试记录：

| 场景 | 规则要求的实际行为与证据 |
| --- | --- |
| 卡 A 实现已完成、Review/QA 尚未结束，同时收到独立卡 B | 继续 A 的既有阶段，B 仅排队；不能把 Review、QA 或下一条命令另建为产品卡来绕过单卡。 |
| 卡 A 拒绝或 UNKNOWN，协调者已有暂挂授权 | 保留 A 原结果/消费与受影响依赖，记录明确暂挂处置及来源后，才可选择独立 B；依赖 A 的 B 仍阻塞，A 不记完成。 |
| 核心与外围必须联合核验，核心 FAIL | 同卡保留联合失败/未完成状态；不单独发布仍依赖失败核心的外围“绿色批次”。 |
| 同版本批次通过相称独立 Review 和实际 QA，安装授权覆盖 | 核可独立安装/回退并按原流程安装；记录实际版本/入口和回退材料，再由下一张真实卡使用新规则并给出采用证据。 |

规则改动的静态差异、JSON/frontmatter 检查支撑源候选对照；实际独立 QA 应根据批准入口和版本执行正常/阻塞场景并记录真实决定，不能用文案存在代替行为正确。复用当前范围有效证据，只补变更缺口；不为说明改动重复整套产品测试。

验收、安装、加载和采用分开记实：源候选可处于“已验收、未安装”；安装后可处于“已安装、未采用”。条件与授权覆盖时按批滚动安装，不停留在只交候选。暖会话显式重读、Host 重载证实、fresh 加载分别记录实际路径/version/pins 与 NOT_RUN/UNKNOWN；不把缓存声明、ACK 或安装成功当成规则已生效。下一张真实修复卡实际读入并依据该版本作出协调决策、留下结果引用后，才标采用；已验收上批的采用留证不构成第二张并行实施卡。

发布继续使用既有插件 identity 和版本 metadata、实际安装/回退流程。本文不授予安装或执行权限。旧 reduced 版本的 Migration、Observe/Correct、FullAB 暂缓记录按原版本保留；本版显式 plan-2 准备状态操作以 PREPARATION-AB 为准，自动业务重放仍不支持。


## F01/F04/F05/F06：材料复用、查询与有限接续

本节落实宿主使用规则，沿用当前 Job、版本、权限、范围、独立质量和有限次数。它不增加 Core schema 字段、自动调度、遥测、缓存或恢复引擎。F03 类内新增问题聚合仍暂缓；现有绑定聚合、request/record 独立检查及安全短路保持，不能据本节声称六项全部完成。

### F01 默认实际采用准备工具

以实际工具返回的对象或 FileRef 为转录来源，沿批准流程直接传递。需要文件时用结构化序列化和已审固定载体，保留原始类型、完整 schema 与字节来源；人读卡只集中说明本次差异，不能用差量说明代替机器要求的完整输入。不要手抄 UUID、布尔值、路径或哈希，也不要从材料正文推断批准。stage_inputs 仍是独立写权限；未启用时不得为省事暂存或改变连接配置。

覆盖材料必须实际调用已有入口，不另写同类校验脚本。公共读取/字面规则、固定材料派生及包级诊断/状态分别使用 [准备区 A+B](PREPARATION-AB.zh.md) 中列出的最小 API。保留实际入口/输入 pins/完整输出、拒绝及 UNKNOWN。未覆盖项先披露UNSUPPORTED并检查已有公开CLI/SDK或正常操作；确需新增产品能力且开发授权覆盖才有界补现有工具，不自动立项。这不要求日常操作制造A/B材料，也不拦截任意shell。原生XMem已加载且项目enabled/存储已确认时，按真实task/version开始/绑定、相关编辑前query、关键公开发现保存完整读回及阶段checkpoint；按任务/关键变化复用，不为每条命令复制材料或捕获记忆。不以memory赋权、不自动新建/迁移库、不共享Reviewer/QA私有资料。原生调用与另配XDev bridge分开核验，UNBOUND不假装bridge可用。

固定材料组件入口为 [Invoke-MaterialPreparation.ps1](../material-tools/Invoke-MaterialPreparation.ps1)，详细参数和边界见 [准备材料说明](PREPARATION-READONLY.zh.md)。只支持其中列明的协议与目的。A 和 B 的 source、approved contract、manifest 及 SHA256 必须由当前协调卡分别冻结；checker 的 B 不得回退到 A、生成文件或 lineage。成功仅证明本次材料生成/核验；生成器会创建数据文件，不生成执行许可或真实角色证据，不启动 Job、SDK、Core 或正式 QA。没有适用的固定协议就继续使用原有对象/FileRef，不另造通用生成器或伪造 Job。

### F04 只省去无依据的中途重复查询

当前输入、版本和状态未变，且原合同没有要求额外查询时，使用已有公开回执或带 cursor 的等待工具，省去多余的中途 status/result 轮询。发生实际状态、输入或版本变化，或原合同明确要求复验时，按原要求查询。最终仍同时执行 task run-status 和 task run-result，并保留被明确要求的新进程检查及当前清单/质量证据复验。旧 PASS、缓存或同函数实现不能替代最终成对查询。

### F05 在现有公开记录中离线分类成本

在本卡原有交接/证据索引或收尾记录中区分：材料准备与预检、实现/Review/QA、模型/角色/Owner 等待、重复转录或纯协调、安装与采用。只使用实际已记录的起止、elapsed、父子关系和时钟域，附原回执引用；缺失项写 UNKNOWN，不按总历时倒推工作量，也不把未知当 0。

同 run 且同一已证明时钟域内，父子区间不重复相加，重叠根区间取并集。只有 elapsed 而没有真实起止/父子关系时，只报告该来源的 elapsed，不能补造 span 或算跨进程/时钟域总和。没有对照不声称一般提速、节省 token 或瓶颈根因；不得按 mtime、路径或 TTL 跳过哈希和提交前复验。不增加采集器、持久缓存、第二账本或严格 Core request/record 字段。

### F06 有限准备纠错与同一卡阶段接续

原工具明确返回 NOT_STARTED_BY_THIS_CALL 时，它只说明本次调用没有进入动作，不能证明历史上从未执行。协调者已给当前具体材料、来源、窗口和纠错次数时，可在该有限许可内纠正确切准备字段，再做原预检；保留原拒绝和实际消费，不扩大 AC、命令、范围或权限。没有该具体剩余额度不自动重试，也不因本节自增次数。

出现 UNKNOWN、断连、超时或 claim-only，先按原 key/Job/版本读取既有状态、结果或专用恢复诊断；不重写未知意向，不换 ID、删锁、重置 claim 或重跑旧正式 QA/SDK。只有同一原 QA 的原 final/完成证据和另行当前 ORIGINAL_FINAL_REPLAY 许可都齐全时，才走原恢复入口；缺失保持 BLOCKED。

实现、独立 Review、实际 QA、验收与覆盖授权内的安装是同一卡阶段。前阶段自然完成、当前版本与门禁成立且已有具体授权覆盖时直接接续，不重复索取同一笼统授权。冻结实现有变化时，旧 Review/QA 不能换绑新版本；真实范围、权限或窗口变化仍回到适用授权和重绑。新的卡名不复活旧 Job、消费或期限。
