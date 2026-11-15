> 当前0.0.9首选SDK a4a3e1d98344a3afe75183a3bd075c2c7da6399ed6c10267941146c1ffd9aab2（工程/2、记录/1），实际批准根/38pins与生产依赖按本次配套交付。此前章节的固定机器目录与54e0/旧计数是历史，54e0仅兼容工程/1；当前规则见SOURCE02-REMEDIATION-0.0.9.zh.md、INSTALL-0.0.9.zh.md及HOST-ACCEPTANCE-0.0.9.zh.md。

# QA 已持久化、原 final 尚未登记时的恢复

此入口只处理既有 supervised Job 的原 QA final 安全重放。它不派角色、不重跑 QA、不重置 claim、不延长旧执行授权，也不接受其他人代签原 final。原始 QA final 或公开完成观察找不回时，旧 Job 保持 `ORIGINAL_QA_FINAL_UNAVAILABLE` / `BLOCKED`；不能把成功命令当成 QA 本人的结论。是否可以另开当前验证，按下节先核原执行结束和新许可，不能用新名字解除旧阻断。public-session-v2 继续要求原角色合同、原 FINAL_ANSWER、匹配的公开完成观察和本次 record 的 writer_status；普通 legacy full_governance 保留其原 session_ref 兼容语义。

## R4 宿主分流：先核事实，再选原入口

下列五个标签是协调者在公开交接中的建议分类，不是新增 Core 状态、工具字段或执行许可。实际输出仍取原 `recovery-status` 的 `execution_status`、缺项和原 Job 结果；不能向严格 request/record/recovery schema 加这些标签。Core 继续核当前候选、原 QA run/final、角色和 head；普通 `start` 不读取前驱状态，不构成跨 Job 锁，宿主必须执行以下准入约束。

| 宿主建议 | 已核事实 | 当前合法下一步 |
| --- | --- | --- |
| `NOT_QA` | 未曾 QA，且原 claim、活跃写者或外部动作均无未知。已有 Review 后可能返回 `NOT_CLAIMED` / `SUPERVISED_RECOVERY_QA_NOT_RUN`；缺实现或 Review 则先补其原缺项 | 按原任务当前授权和原阶段完成必要检查。没有结果可回放；标签本身不释放 QA |
| `RECONCILE_ORIGINAL` | claim-only、原写者仍活跃、公开完成观察不足、外部动作或提交结果未知 | 原 Job/操作/key 下只读对账。不能据超时、未找到记录或新授权判定原执行已结束；不能换 Job、Agent 或“新验证”绕行 |
| `ORIGINAL_FINAL_REPLAY` | 同一候选的原 QA 已结束且通过，原 final、完成观察、receipt、绑定和准确 head 可取得 | 只读诊断后取得单独当前 `ORIGINAL_FINAL_REPLAY` 许可，用原 `recover-qa`；不重新运行 QA。已提交丢回复先对账，重复原操作只读返回，不增加逻辑 final |
| `NEW_VERIFICATION_REQUIRED` | 原执行与写者已被明确观察为结束，无未决副作用；原 final 确实不可得，或当前候选已改变 | 旧 Job 保持原缺项/陈旧结论及消费。在支持的普通新任务入口，用当前候选、独立新授权、新 Job 和当次真实检查重新验证；不把新 final/run/candidate 填进旧回放 |
| `FAILURE_SUCCESSOR_REQUIRED` | 原 Review 或 QA 失败已确定，原执行已结束且无未知，有可检验新依据/补丁 | 原失败和消费保持，按当次受限后继许可核下一轮；不在原终态 Job 改绿、不自动续轮。一次后继及未支持共享额度的边界另按本次合同核，不由恢复入口生成额度 |

不完整/失败输出、skip/todo、来源漂移和原件缺失不能靠这些建议升格为通过；无法确定是哪一类时保持受阻，先对账。尤其是 `NOT_KNOWN` 不能直接解释成“没有运行”。active/unknown writer 的完成观察还须在登记/回放时由原门禁重核；换一个 signer 不是写者结束证据。

### 关联新验证的最小来源

只有原操作已经明确结束，协调者才可依据当前授权形成新的普通任务合同。沿用现有规格/公开交接引用前驱 Job、原 head、原候选和 run/claim/失败或缺项、原执行及写者结束观察、新验证原因、当前候选和新授权来源；这些是本次任务依据，不新建后继账本或向严格 schema 加未知字段。旧资料可作为明确标注的背景，不能承担新 Job 的本人 final。

新任务使用当前已支持协议（新正式 Node 任务为 request-5）及不同的 start 授权源，重新绑定原意图、规格、范围、候选和检查要求。即使采用现成代码，也要有真实实施者对当前新 Job/候选的采用或实现结论，不伪造原实现记录；按当次合同完成非作者 Review、实际 QA 原回执及 QA 本人自然 final，再由原核心登记交付。新许可不退款旧 start/claim，新的成功不追认旧任务当时完成，也不让旧 QA 多运行一次。

当前能力只是已明确授权的协调者沿普通 start/record/qa 的受监督路径，没有自动“新验证”命令、前驱语义认证、跨 Job 共享预算、跨 Host 回执导入或后台调度。无合法新入口、当前独立检查者或原执行结束证据时，停止该依赖并说明缺口。TEST_ONLY 夹具只证明所测 API 绑定和消费性质，不能替代真实 Host/角色演练。

先只读诊断：

```text
ACTUAL_NODE --experimental-strip-types src/owner-ux/xdev.ts task recovery-status --mode supervised --project-root PROJECT --control-root CONTROL --project-id ID --job JOB
```

已有完整的原 QA record 时可另传 `--source ORIGINAL_RECORD`。结果同时列出 execution_status、closure_status、recovery_status、expected_revision、expected_head_sha256、refs、missing_items 和 next_steps；无论是否命令成功，`execution_allowed`、`claim_reset`、`qa_rerun_allowed` 均为 false。主要分类如下：

| 现状 | 结果与下一步 |
| --- | --- |
| 原 claim 存在但没有已提交 run | UNKNOWN_CLAIM_ONLY / BLOCKED，不能重跑或从孤立 evidence 自动采纳 run |
| run 失败、timeout、skip/todo 或字节不完整 | FAILED_OR_INCOMPLETE / BLOCKED，不能恢复为质量通过 |
| run 成功但原 final 缺失 | ORIGINAL_QA_FINAL_UNAVAILABLE / BLOCKED，寻找原会话公开 final 和完成观察 |
| 原 final、完成观察及全部绑定一致 | READY_FOR_ORIGINAL_FINAL_REPLAY，仍需单独、当前有效恢复许可 |
| 同一原 final 已原子终结 | ALREADY_FINALIZED，可只读对账，不追加事件 |
| 旧版 final 存在但终态仅部分提交 | SUPERVISED_FINAL_PARTIAL_COMMIT_BLOCKED，不迁移或改写旧账 |

恢复请求与许可由已授权协调员根据真实公开材料生成。`FileRef` 为 `{path,sha256}`，`EvidenceRef` 为 `{id,sha256}`，均为精确原件；不是让用户手填 UUID。以下 `BOUND_FIELDS` 是 schema 展示简写，实际 JSON 必须把每个键展开：

```text
BOUND_FIELDS = {
 job_id, task_id, spec_sha256, manifest_sha256,
 operation_key: original_claim_ref.sha256,
 claim_ref: EvidenceRef, qa_receipt: EvidenceRef,
 qa_request: FileRef, original_request: FileRef, record: FileRef,
 expected_revision: number, expected_head_sha256: sha256
}

REQUEST = {
 format:'xdev-supervised-recovery-request-1',
 operation:'ORIGINAL_FINAL_REPLAY', ...BOUND_FIELDS, permit:FileRef
}

PERMIT = {
 format:'xdev-supervised-recovery-permit-1',
 operation:'ORIGINAL_FINAL_REPLAY',
 source_claim:'COORDINATOR_RECORDED_CURRENT_RECOVERY_AUTHORIZATION',
 project_id, project_root, control_root, ...BOUND_FIELDS,
 not_before:'ISO UTC', expires_at:'ISO UTC', stop:false, revoked:false,
 logical_completion_limit:1, execute_qa:false
}
```

`record` 必须仍是原 `xdev-supervised-record-1` QA 完成记录，采用同一原 QA session、receipt 和本人的实际独立决定；许可不产生新的角色身份。完整源、规格、scope、manifest、impl/review、claim/run、输出原始 base64/hash 和当前 record 的 writer 状态都重新检查。旧执行授权可以过期，但原授权、request 及公开证据字节仍须完整；正常 record 继续受旧执行窗口约束。

冻结并批准当前恢复许可后，CLI 使用：

```text
ACTUAL_NODE --experimental-strip-types src/owner-ux/xdev.ts task recover-qa --mode supervised --project-root PROJECT --control-root CONTROL --project-id ID --job JOB --source RECOVERY_REQUEST
```

MCP 复用同一既有适配器。只在显式本机配置中添加以下可选项后发现 `xdev_recovery_status({job_id,record?})` 与 `xdev_recover_qa_final({job_id,source})`：

```text
recovery:{enabled:true,format:'xdev-local-recovery-1',approved_permits:[FileRef]}
```

`approved_permits:[]` 只允许只读恢复诊断，不能提交。精确许可必须位于既有 input_root，所有可达原件仍受 input/Store 安全引用边界约束。历史 `approved_requests` 可以为空，`stage_inputs`、`write_jobs`、`execute_qa` 可以全部 false；这不会给普通 start/record/qa 增加权限。更改配置需重载进程，运行中改动会明确拒绝。UNBOUND 仍仅 context，不发现恢复或绑定工具。恢复不会隐式修改本机配置、旧 grant 或 claim。

正常 QA record 和恢复共用 JobStore 的专用锁内 final 事务：核对原 expected revision/head，先 reduce 全部 final/终态事件，再一次替换原 journal；替换前再次核当前许可、证据和 head。stop、过期、撤销、字节漂移或 CAS 冲突使提交拒绝。失败可留下内容寻址 evidence，但未进入 journal 的孤立文件不构成 stage。旧 grant、执行次数和失败历史保持。

已提交却丢回复时，先查 recovery-status。同 operation_key 和原 record digest 重放只读返回当前一致结果，不增加逻辑完成；同 key 异 payload 拒绝。并发 normal record/recovery 至多产生一个逻辑 final。对已完成操作的只读对账不再次消费执行或逻辑完成许可。写入前失败与已提交后响应丢失须根据原 journal 区分，不能凭工具 timeout 推定远程停止。

真实进程被强制终止不会执行 `finally`。新 final 写路径（正常 record 和 recover-qa 共用）先持有本机独占 IPC 句柄，再创建带完整归属元数据的 `.lock` 目录。句柄随进程死亡由操作系统释放，不单凭年龄、超时或 PID 缺失推定可回收，也不使用会在活跃事务中到期的租约。短生命周期 worker 仅桥接同步调用与 Node 24.19/24.20 的本机 IPC 监听，拒绝连接、不处理业务消息；回调结束后须收到关闭确认。未确认取得句柄时不进入写回调。

新协议只有在独占句柄已取得、同主机/同次启动/同 IPC 域/同存储根/同 Job 的元数据与目录 dev/inode 全部一致时，才把遗留锁重命名为唯一 `.lock.abandoned-UUID`，完整保留其 `owner.json`。重试仍重核当前恢复许可、原证据、manifest、head 和 CAS，然后只提交一次原 final，不再次执行 QA。Linux 绑定 boot_id、network namespace 并仅准入明确本地文件系统；Windows 使用固定、有界、只读的原生查询取得 MachineGuid、启动时间及本地固定盘类型，失败即拒绝。UNC、网络盘、未知平台/文件系统不支持本轮自动写恢复；不声明跨主机共享盘、断电或管理员篡改后的安全性。

取得 IPC 独占句柄后，还必须确认元数据指向的原父进程明确不存在：仅对该精确正整数 PID 发送 signal=0 的存在查询，只接受 ESRCH。存活、EPERM、复用 PID 或其他未知结果均保持锁原字节并拒绝；PID 缺失绝不单独授权回收。Linux 还把 PID namespace 加入原有 boot/net 域，不能跨 PID 命名空间解释归属。守护线程异常退出而原父进程仍活跃时，可能持续阻断；需先正常退役原写进程，不能凭超时、内核句柄释放或更换 signer 推定它已退役。此查询不扫描或终止任何原进程。

Windows 运行令牌须有读取本机 `Win32_OperatingSystem.LastBootUpTime` 的 CIM 权限。受限令牌明确返回 PermissionDenied 时，新写恢复返回 `SUPERVISED_WRITER_DOMAIN_UNAVAILABLE`；不能绕过安全策略或退回 PID/时间推断。已提交操作的纯只读重放不调用该原生查询。正常应用与受限测试环境应分别记录实际权限和结果；进程内只缓存成功的同盘设备身份，并持续重核具体存储根 dev/inode。

旧版空目录锁、畸形/未知元数据、异域或目录归属变化保持原字节并明确拒绝。新进程若在 `.lock` 创建后、完整 `owner.json` 发布前死亡，也属于未知归属，不能自动回收；诊断需保留锁、journal 和原证据，由另行授权的现场处置处理，不能直接删锁、清 claim、重跑 QA 或代签 final。普通 Job mutate 和 D1 锁协议保持原行为。

已完整提交的同一 final 先走纯只读重放：前后 journal 快照一致，并重新校验原来源、key/digest、全部公开 proof、manifest 和许可绑定。此路径不创建锁、证据或目录，因此遗留旧/未知锁不阻断已提交操作的对账；部分提交、异 payload、证据漂移仍拒绝。恢复许可过期/撤销会阻止新提交，已完成操作的只读对账不重新消费该许可。

预检查尚未发现 final 时，进入内核互斥下重新读取的写/幂等路径；另一调用在此期间合法完成不能仅因旧负向快照变化而被拒绝。只有确认准备只读返回已完成结果时，才强制前后 journal 完全一致；正向重放期间的漂移仍拒绝。

IPC 已绑定后发生监听错误时，先立即标记 guard 失效，不再重试绑定，并只启动一次关闭流程；实际监听句柄保留到 parent release，避免同步事务在最后一次断言和原子替换之间失去互斥。错误事件本身不是关闭证明；parent release 后仍须等实际 close 回调成功才发布关闭确认。关闭报错或无法确认时保持 UNKNOWN/失败，后续 parent release 不能重复关闭或把失败当确认。固定桥接源码的确定性 VM 测试只用严格假 net 注入错误/延迟关闭；真实内核进程中断测试仍单独保留。

异常抛出注入仍用于提交原子性回归，但不能替代真实进程终止覆盖。实际测试在 BEFORE_REPLACE 和 AFTER_COMMIT 观察到直接子进程到达精确边界后才强制终止；Windows TerminateProcess 语义与 Linux SIGKILL 结果分别留证，未实跑的平台不能标为通过。

本功能仍是 coordinator-transferred public provenance，不认证原生身份、全局后代闭合或 OS 沙箱。测试夹具与 SDK 连接不代表真实 Owner 业务/各宿主验收。独立 Review、独立实际 QA 和安装发布由相应角色另行留证。500ms Dot happy-path timer 本轮保持；Dot Linux 原基线与诊断版各 0/30 未复现，根因 UNKNOWN，旧失败与诊断资料保留。

## 0.0.9 当前补充

本文件此前版本、固定机器路径与SDK身份说明按原时点保留；当前事务/重放、writer能力预检、SDK精确build及/2双hash、显式同key前驱更正、正常授权边界转交和构建要求，以[SOURCE02-REMEDIATION-0.0.9.zh.md](SOURCE02-REMEDIATION-0.0.9.zh.md)为准。实际资格与未验范围看包外交付报告，每个目标填[HOST-ACCEPTANCE-0.0.9.zh.md](HOST-ACCEPTANCE-0.0.9.zh.md)，不从文字自行填PASS。
