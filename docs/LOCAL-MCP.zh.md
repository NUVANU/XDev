> 当前0.0.9首选SDK a4a3e1d98344a3afe75183a3bd075c2c7da6399ed6c10267941146c1ffd9aab2（工程/2、记录/1），实际批准根/38pins与生产依赖按本次配套交付。此前章节的固定机器目录与54e0/旧计数是历史，54e0仅兼容工程/1；当前规则见SOURCE02-REMEDIATION-0.0.9.zh.md、INSTALL-0.0.9.zh.md及HOST-ACCEPTANCE-0.0.9.zh.md。

# XDev Local：D2 本地 MCP

本包声明XDev/plugin 0.0.8、独立MCP子包与server 0.1.0-d2.6，release_id为xdev-d2-input-scope-sdk-20261021-r1。共用既有supervised preparation/quality、Profile、JobStore、start claim和QA claim，不改变Core或依赖。发布声明、安装缓存字节、实际宿主加载和业务验收分别核对，不能由版本数字互相替代。范围、继承及未验边界见[本次发布说明](RELEASE-20261021-008.zh.md)。

默认技能xdev是D2入口router，绑定后的准备/preflight/独立Review与实际QA细节由xdev-supervised承接；不再把旧D1未准入Job当当前唯一入口。旧Job和失败历史按原版本保留，不迁移或重释。

portable根plugin.json/mcp.json为canonical，root extensions.com.openai包含完整OpenAI展示/默认提示；其对象存在时不会合并.codex-plugin overlay。兼容.codex-plugin/plugin.json显式声明skills和根.mcp.json，两个模板语义都是唯一xdev stdio、node命令、PLUGIN_ROOT内server和无--config默认启动，不预绑真实工程，也不注册第二个MCP。当前模板使用${PLUGIN_ROOT}宿主变量；作者SDK模板替换机制测试不代替官方Host的实际发现与变量解析。

绑定与UNBOUND的xdev_context都返回release：plugin_version、adapter_version、release_id、node_version及identity_observation=RELEASE_DECLARATION_NOT_NATIVE_IDENTITY_ATTESTATION；node_version来自本进程。MCP initialize声明同一adapter版本。它不读取工程来推断版本，不提供原生身份认证，也不证明当前缓存匹配交付清单；实际安装与新鲜Host仍须独立证据。

Codex实际工具授权：同任务recall/checkpoint会写衍生状态，related会预扣本地预算，因此xdev_memory的readOnlyHint=false正确；read-only shell不等于批准MCP写工具，只有approval=never而没有相应工具许可时会在派发前拒绝。已有明确Owner授权时，可仅在本次隔离Codex命令给名为xdev的MCP添加 `-c 'mcp_servers.xdev.enabled_tools=["xdev_context","xdev_memory"]' -c 'mcp_servers.xdev.tools.xdev_memory.approval_mode="approve"'`，仍受原配置/批准来源/权限/预算约束；不自动改全局配置、trust或工具annotations。无授权时正常请求具体工具/动作范围的批准。[官方配置参考](https://developers.openai.com/codex/config-reference)列出enabled_tools与逐工具approval_mode字段。

## 安装与接入：不要求项目

当前MCP实际QA仅支持精确版本Node24.19.0或24.20.0，无需编译。含依赖安装包已经包含864根依赖和3655个MCP依赖文件，解压后不需要再次npm安装；仅源码包才按交付清单准备根依赖及在mcp目录npm ci。mcp/package-lock.json固定官方SDK1.32.1、zod4.6.7，不修改冻结依赖。

从实际解压/安装目录运行：

```powershell
node --experimental-strip-types mcp/configure.ts --host codex
```

四种host为codex/claude/workbuddy/deepseek；configure只打印真实当前Node/server绝对参数，不注册、不写宿主。协调员采用对应输出接入，日常用户不管理JSON/UUID。无配置的stdio命令就是`node --experimental-strip-types ABS_XDEV/mcp/server.ts`，没有--config或项目变量。

默认只安装功能入口：服务无参数启动时明确UNBOUND，仅提供xdev_context，project_id/project_root/control_root/input_root/config为null，permissions全false、task_ready/execution_allowed=false；没有项目/Job/claim或假数据根。cwd不是工程；环境XDEV_LOCAL_CONFIG以及cwd里的配置文件均不选择、不加载。未绑定的项目工具不注册，调用由SDK明确拒绝。显式坏参数或坏--config会启动失败，不能默默变成UNBOUND。

## 实际任务：确定项目后本地绑定

用户给实际任务和已有工程目录后，协调员沿用下面init步骤。安装不要求先给项目；真正项目工作仍要求确切绑定和原本地批准。init完成后运行`node --experimental-strip-types mcp/configure.ts --config ABS_LOCAL_CONFIG --host codex`（或实际host），用返回的绑定连接参数更新注册，并按宿主重载/重启为新进程。原进程不自动热切项目，远端没有bind/approve工具，不自动派角色。

以下是已有实际项目后的本地绑定入口，由协调员执行，不是安装前置。在源码目录内运行：

```powershell
node --experimental-strip-types mcp/local.ts init --project-root 'C:\Projects\my-project' --data-root 'C:\XDevData\my-project-new' --project-id my-project
```

上述路径是需替换的示例，不代表本机已有这些工程。project-root 必须是已有的规范化绝对目录，data-root 必须全新且父目录已存在，两者不能互相包含，路径及祖先不能经过符号链接/junction。Windows init 当前只支持普通盘符绝对路径；UNC、设备路径、扩展前缀（包括 `\\?\`、`\\.\`）及非普通盘符命名空间明确 UNSUPPORTED，在访问/创建前拒绝。路径有空格可正常引用；非法段、设备名和尾点/尾空格拒绝。

已有工程与 data 父目录在创建前分别核 `realpathSync.native` 的实际位置及 BigInt dev/ino 身份（同一目录前后与解析目标一致、ino 非零），再用真实父目录组合尚未存在的 data 叶名做双向分离检查。不能确定身份或分离就拒绝；若短名/SUBST 等别名解析后的普通物理名称与输入不同（不计Windows大小写），当前 init 明确 `PHYSICAL_PATH_ALIAS_UNSUPPORTED`，不自动接受别名。请使用实际长路径及物理盘符；不宣称跨所有文件系统别名支持。这是创建前检查，不是抵御恶意并发替换目录/盘符的OS沙箱。数据不放在工程内，避免控制证据被当作工程变更。

init 仅在 data-root 建立 control、input、local-config.json，工程字节不改，不创建 Job/claim。配置使用既有 `xdev-local-mcp-1` 模式及 loadConfig 检查，显式设置 `stage_inputs:false, write_jobs:false, execute_qa:false, approved_requests:[]`。仅在需要暂存公开输入时显式增加 `--stage-inputs`，这仍不授予写 Job/执行许可。

成功输出 JSON `status:CONFIGURED`，含 `config:{path,sha256}`、`permissions`、`stdio:{command,args}` 以及 `codex_registration:{argv,executed:false}`。Node、server 和 config 都是实际绝对路径，server 取自当前运行的 local.ts 所在源码位置；安装到稳定目录后从该目录执行 init，输出即绑定该目录，无需变量替换。协调员按 shell 规则引用 argv 的每项并执行注册；init 本身不改宿主。`task_ready/execution_allowed/job_created/host_registered` 均 false，只表示配置完成。

未知/重复参数、非法绑定、重叠、已有数据与链接等可预知错误在创建前拒绝。已有 data-root 不覆盖、不修复、不删除，即使为空也拒绝。若权限、磁盘或并发变化导致创建后的运行时失败，返回 `PARTIAL_OR_UNKNOWN`、实际已观察的 created_paths 与不确定状态，保留原件且不自动清理；不能据此宣称零副作用或重新执行。先核现存工件，再由协调员选择新的数据目录；setup 不授予任务重试额度。

当前 Owner 的真实 Agent 项目仍未提供目录和需求；此入口不伪造业务任务。已有手工配置仍可直接用 server/configure；它与 init 使用同一模式，不产生第二状态源。

默认只读：context、prepare、status、result。prepare 的 source 是 `{ "path": "绝对路径", "sha256": "当前64位小写SHA256" }`。所有输入及嵌套 FileRef（含 purpose_source）只能在 input 内；链接、硬链接、漂移、额外 FileRef 字段和越界均拒绝。JSON 不允许重复键。远端不提供任意读文件、任意 shell、改根或批准工具。

需要追加输入时，init 显式加 `--stage-inputs`；手工配置可设置 `"permissions":{"stage_inputs":true}`。`xdev_stage_input` 只在 input 追加最多256KiB的内容寻址文本/JSON，不写工程/control，不批准任务、不覆盖已存不同内容。允许JSON所引用的原件必须已存在于 input；按依赖到上层的顺序提交。

写Job前，由本机协调员从真实公开讨论整理原有 v3 request、preparation、规格、确认、设计、风险与有限授权原件到 input，并在本机配置增加：

```json
{
  "permissions": {"stage_inputs": true, "write_jobs": true, "execute_qa": true},
  "approved_requests": [{"path": "实际input内request.json绝对路径", "sha256": "实际当前SHA256"}]
}
```

以上片段合并进完整配置，不能直接当完整配置。写Job/QA默认不开放；`execute_qa`要求`write_jobs`。请求必须先经本机明确批准，远端暂存不会自动批准。配置字节改变后进程拒绝后续调用，需本机检查并重启；不从远端自动重载。

运行：

```text
node --experimental-strip-types ABS_XDEV/mcp/server.ts --config ABS_LOCAL_CONFIG.json
node --experimental-strip-types ABS_XDEV/mcp/configure.ts --config ABS_LOCAL_CONFIG.json --host codex
```

第二条只输出连接描述，不安装、不改宿主。`--host` 支持 codex、claude、workbuddy、deepseek；生成结果使用当前 Node 与 server/config 的真实绝对路径。旧Codex兼容manifest原4条defaultPrompt按原值/顺序保留；新portable格式最多3条，因此新root manifest省略该可选字段，不静默删除旧提示。root mcp.json 默认仅使用 `${PLUGIN_ROOT}` 的无项目模板，不要求 `${XDEV_LOCAL_CONFIG}` 或--config；宿主变量展开支持各异，先使用 configure 的具体绝对参数。模板导入不等于宿主工作流已验；实际项目工作仍需本地init后显式绑定。

## 工具和质量语义

- `xdev_context`：本进程根、权限、批准请求和限制。
- `xdev_preflight`：绑定态只读核对当前根/ID、server及Node实际路径/哈希、权限和批准项数量，以及hash绑定的request或record形状。不会消费Job/start/QA；UNBOUND仍只提供context。
- `xdev_stage_input`：有本地授权时追加输入工件。
- `xdev_prepare`：原需求准备检查；不创建Job、不消耗启动。语义来自公开讨论声明与字节绑定，不是通用需求理解证明。
- `xdev_start`：当前 v3、READY、精确预批准请求、有限窗口成立后，复用原唯一启动占用创建Job；不派发角色。
- `xdev_record`：记录公开归属、本人自然final及同版本实现/Review/QA结果；旧证据不能换绑新源码。MCP不能赋予原生身份。当前角色记录仍是受监督人工/协调员中转。
- `xdev_qa` / `xdev_self_check`：只运行该批准任务冻结的 Node 命令。复用原Review前置、独立性、范围、版本、单次QA占用。prototype始终UNVERIFIED。
- `xdev_status` / `xdev_result`：对同一Store读取当前判定，只能查询本地批准请求对应Job。

MCP annotations 是客户端提示，真正权限检查在服务端。远端工具不能扩大根、批准自己的请求、修改额度或任意重试。多个MCP进程共用原核心原子启动/QA占用，不建立第二账本。

同步QA本切片要求冻结命令timeout总和不超过90秒；超出在start/QA前返回UNSUPPORTED类错误，不运行或消费相应QA占用。这个限制为适应官方Tunnel总120秒截止（含排队，progress不续期）；原CLI能力和质量断言不改。QA中的Node代码仍以当前本机用户权限执行；cwd不是OS沙箱，只有本机明确批准且独立检查的可信工程才应启用execute_qa。当前支持的Node24.19.0和24.20.0原QA以65536的maxBuffer作双流累计溢出检查，检查前还可能收到最后一个读块；容量预估按每条命令双流合计131072字节处理，不把65536说成各流的绝对截断长度。仅支持单条冻结命令且timeout总和≤90秒，溢出/超时/无退出码均失败而非截断后PASS。MCP结果总JSON另限256KiB，超过返回 `isError`/INCOMPLETE、实际Job ID、原Store保留与未重置占用；不能称公开返回完整，不增加分页框架。

断开客户端、Tunnel超时或关闭MCP进程，都不证明QA子进程停止。start/QA claim原样保留；已占用或未知不能重连再跑。查询可能看到未结束占用，必须如实处理，不能退款、删占用或补造完成。角色独立性与真实QA要求不因MCP接通而降低。

## 宿主接入与验收状态

1. **Codex/本机Work**：本机CLI已发现0.163.0-alpha.10.2，`codex mcp`公开帮助具有add/get/list/remove/login/logout。configure输出 `codex mcp add xdev -- NODE ...server.ts --config ...` 参数数组；应由Owner在实际宿主安装时采用。本轮SDK子进程协议测试不等于Codex模型调用或Work界面验收。
2. **Claude Code**：官方支持本地stdio MCP；configure输出标准 `mcpServers` 描述。可用官方 `claude mcp add --transport stdio xdev -- NODE ...` 接入。未在Claude实际连接/派发角色/QA，不能标PASS。https://code.claude.com/docs/en/mcp
3. **WorkBuddy**：官方MCP+Skill连接器允许stdio，configure输出 `mcpServers` 描述，不依赖cwd。官方cwd字段要求4.22.15+；本机发现5.3.8安装元数据，真实连接未验。https://open.workbuddy.cn/docs/connector
4. **DeepSeek Harness**：官方 `@deepseek-ai/dsh-mcp-client` 插件可接stdio。configure输出单个overlay插件条目（id/name/config），按实际overlay已有结构加入，不覆盖已有配置。显式 `toolCallTimeoutMs:110000`、`reconnect.enabled:false`；默认60秒不能覆盖本切片QA上限。宿主会先启动临时协商probe再启正式进程，所以服务启动/initialize/list仅元数据、无Job/QA/占用。https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md （核对blob 950b9b8c8566a2db2f82c21d64c3b224bfbb2650）。真实宿主未验。
5. **ChatGPT端**：通过官方 Secure MCP Tunnel 让本机agent连接私有stdio服务，不需要开放公网入站端口。当前机器未发现tunnel-client；账户、workspace授权、tunnel_id、运行连接均未验。官方 https://developers.openai.com/api/docs/guides/secure-mcp-tunnels 。需要Platform实际Tunnel ID、runtime API key的Tunnels Read/Use权限，以及目标ChatGPT workspace关联；key只用官方安全配置/环境，不进源码/包/日志。CLI从Platform Tunnel settings或官方openai/tunnel-client实际release取得；不伪造下载文件或端点。

官方Tunnel执行形状（全部待Owner具体配置，不由MCP远端自安装）：

```text
tunnel-client help quickstart
tunnel-client init --sample sample_mcp_stdio_local --profile local-stdio --tunnel-id ACTUAL_TUNNEL_ID --mcp-command "node --experimental-strip-types ABS_XDEV/mcp/server.ts --config ABS_LOCAL_CONFIG.json"
tunnel-client doctor --profile local-stdio --explain
tunnel-client run --profile local-stdio
```

ACTUAL_TUNNEL_ID必须替换成该账户真实ID。路径有空格时按官方CLI实际平台引用规则配置，不能把这里的字符串作为已执行证据。Tunnel提供连接，不证明公开角色归属或真实独立检查。ChatGPT、Codex/Work及三外部宿主的完整闭环分别验收，任何一个协议PASS不自动覆盖其他宿主。

## 本轮限制

本轮只验证源码与TEST_ONLY SDK协议机制：fixture公开角色final不是产品真实角色证据。本轮不安装到宿主、不运行模型、不改trust/启动许可/角色配置、不公开工程或部署云服务；不恢复EverBound/heartbeat。XMem、收费、无人值守与混合编排不作为本轮门槛。旧D1/V0/D1.5冻结物与历史FAIL不改，不以MCP工具调用成功替代D2各宿主验收。


## R1：副作用前容量支持边界

独立Review1指出，合法的大合同/大entry与多个输出回执可能在消费start/QA或record后才触发原Store1MiB限制或MCP256KiB返回限制。本次只在MCP外层增加保守支持范围；原Core、原Store限额、CLI和质量断言保持。

所有写Job/record/QA在原核心调用前检查：request规范JSON<=16KiB、record/QA请求规范JSON<=16KiB、当前工程清单规范JSON<=32KiB、实际准备/profile entry规范JSON<=32KiB、当前Job元数据<=256KiB。这里统计规范JSON的UTF8字节（含换行），包含转义成本，不是原始文件长度。写操作的project_id及工程/control/input/派生Store/Node路径JSON各<=512字节，顶层source路径JSON<=2KiB。实际拟持久化初始合同也在消费start前检查原1MiB限制；所有stage/start/record/QA的已知返回有保守预留。超出返回 `MCP_CAPACITY_UNSUPPORTED`，不改请求、不删命令，不产生该次Job/Journal/claim副作用。

**本MCP切片的QA执行当前只支持精确版本Node24.19.0、24.20.0和单条冻结命令**，总冻结timeout仍<=90秒；其他Node版本不能冒称输出上界已证，MCP执行前返回 `MCP_QA_RUNTIME_UNSUPPORTED`。context/prepare/受支持记录与只读查询不因Node版本未知自动赋予执行许可。`xdev_context`公开这些限制及当前runtime是否匹配。

依据官方[spawn_sync.h](https://raw.githubusercontent.com/nodejs/node/v24.19.0/src/spawn_sync.h)（kBufferSize）与[spawn_sync.cc](https://raw.githubusercontent.com/nodejs/node/v24.19.0/src/spawn_sync.cc)（OnRead、IncrementBufferSizeAndCheckOverflow、Kill）：计数是双流累计，包含检查前最后一个读块。因此预估每命令总raw上界131072字节，按每raw字节最多6字节JSON转义、两流base64填充，以及实际命令JSON＋64KiB元数据余量检查原1MiB持久化上限。不能把65536当作每流绝对截断长度。多条命令的最坏上界超限时整体拒绝；不静默省略命令。可以在原CLI按其支持范围使用多命令，不自动更改或重批当前请求。

容量预检覆盖可预知的不支持组合，不保证磁盘故障、进程丢失或其他运行时异常永不丢证。若底层在已占用后失败，只能如实失败/UNKNOWN，原claim保留，不声称尚未写出的raw已经保留，不退款或重跑。只读大结果的INCOMPLETE兜底仍保留；它不是写操作可预知容量不足的替代。

### 2026-10-19 Node兼容增量

仅在独立候选副本扩展精确白名单至24.19.0、24.20.0；其他版本仍拒绝，无环境/配置绕过或静默回退。新增版本依据官方[v24.20.0 spawn_sync.h](https://raw.githubusercontent.com/nodejs/node/v24.20.0/src/spawn_sync.h)与[spawn_sync.cc](https://raw.githubusercontent.com/nodejs/node/v24.20.0/src/spawn_sync.cc)复核双流累计、65536读块、溢出后关闭全部stdio；原131072 raw上界及全部容量/授权/claim约束保持不变。该兼容增量不代表EAMI任务认证、宿主身份认证或支持TypeScript/Vite/Vitest全套编排；旧试点结论仍属历史。

## R2：绑定与调用预检（候选）

绑定态先调用 `xdev_preflight`。参数为严格对象，可含 `expected`、`request:FileRef`、`record:FileRef`。FileRef沿用精确 `path`/`sha256`，必须在本机配置input根内；request还须已本地批准为v3，沿用现有准备/profile、容量、冻结命令和运行时限制。record只读取真实Job对应合同及当前工程清单，检查严格字段、boolean类型和版本；不记录结果、不重置claim。缺失/对象/字符串不会转换成boolean，报告字段名；v3 Review的preparation_conformance与review_burden_justified仍必须由本人作出。

`expected`可明确给出project_root、project_id、control_root、input_root、server_path、server_sha256、node_path、node_sha256、node_version、config_sha256中的任意字段，逐字段精确比较，不规范化别名或自动修配置。绑定不匹配时不继续读取所给任务工件。server_sha256只标识server.ts字节，不能代替整份源码清单；Node hash来自本进程实际可执行文件。config hash来自当前加载配置，漂移须显式重启。没有expected只表示已观察当前绑定，不表示符合未提供的期望。

本机独立CLI使用同一adapter读取与校验，不启动stdio连接：

```text
ACTUAL_NODE --experimental-strip-types ABS_XDEV/mcp/preflight.ts --config ABS_CONFIG
ACTUAL_NODE --experimental-strip-types ABS_XDEV/mcp/preflight.ts --config ABS_CONFIG --input ABS_OPTIONS_JSON
```

协调员从真实返回生成options文件；不要要求Owner手填UUID/哈希。options遵循同一参数形状，最大16KiB，非法或重复JSON字段拒绝。CLI将一份JSON写stdout，CHECKED退出0，REFUSED/UNSUPPORTED退出1；MCP的业务预检拒绝以结构化status报告，传输/schema错误仍沿用原isError包络。不能只看工具调用成功或CLI exit0判断任务可执行。

每项checks分别为CHECKED、MISMATCH、INVALID或UNSUPPORTED；总体CHECKED仅指已请求的绑定/形状检查。real_review=NOT_EVALUATED、actual_qa=NOT_RUN、current_job_executability=NOT_EVALUATED、native_identity_authenticated=false、execution_allowed=false、delivery_allowed=false始终分列。record的session证明、独立性、本人final、QA真实回执判定和当前阶段仍由原record/QA/查询决定；预检不替检查者决定PASS。不得把unknown/缺项改写为READY。无request/record时不检查任务材料。

冻结命令required_output若明确采用TAP协议前缀（TAP version N、ok N、not ok N、1..N或# tests/pass/fail N），必须在第一个脚本路径之前同时冻结--test与--test-reporter=tap（脚本之后的同名参数不会启用Node reporter）。缺少任一项在CLI与MCP实际start的原副作用边界前拒绝，错误指向commands.<id>.argv；不静默改请求或重批授权。普通脚本如run.mjs/required_output:["OK"]仍兼容。不根据任意需求prose推断角色、授权或reporter。

预检只是当前读取时点的观察；随后字节、权限或版本变化仍按原入口拒绝。它不授予执行许可，不修改配置，不提供通用shell、原生身份、自动派发或宿主验收，也不改变既有容量/Node精确白名单。
## 显式同任务记忆桥接（R5候选）

本机配置可选memory_bridge；只有明确配置时才增加有副作用的xdev_memory(action,source?)。原无记忆配置和UNBOUND保持；context/prepare/preflight只读，不暗中调用XMem start。配置、独立记忆权限、固定Companion1/Node24.20.0/部署及schema指纹、单developer公开受众与外置存储步骤见[XMEM-BRIDGE.zh.md](XMEM-BRIDGE.zh.md)。记忆许可不增加Job/QA许可，不重置claim；候选不是Owner授权或执行证据。

保存确认、完整readback、上下文状态和协调员接收分开报告；UNKNOWN先按原key/revision只读对账，不自动重写/换ID/改前驱。当前七工具无start逐次budget/mode及capture逐次roles，不能使用未部署contract2字段或自动切Full。私有Review/QA材料不得进入共享source。新源码、真实联合trial、实际接收者和安装均需各自证据，详见本卡交付报告。


## 0.0.9 当前补充

本文件此前版本、固定机器路径与SDK身份说明按原时点保留；当前事务/重放、writer能力预检、SDK精确build及/2双hash、显式同key前驱更正、正常授权边界转交和构建要求，以[SOURCE02-REMEDIATION-0.0.9.zh.md](SOURCE02-REMEDIATION-0.0.9.zh.md)为准。实际资格与未验范围看包外交付报告，每个目标填[HOST-ACCEPTANCE-0.0.9.zh.md](HOST-ACCEPTANCE-0.0.9.zh.md)，不从文字自行填PASS。
