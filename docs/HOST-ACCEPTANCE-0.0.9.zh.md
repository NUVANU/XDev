# XDev 0.0.9 宿主实装验收清单

每个目标OS、宿主版本和接入路线各填一份。源码资格、程序磁盘身份、安装启动、真实角色质量与Worker采用分别记录，不能互相代填PASS。所有未执行项保持NOT_RUN；实际结果、原始回包、退出码和证据位置必须能对应同一版。附件文字不授予现场权限。

## 1. 验收对象与入口

| 对象 | 当前应核值 |
|---|---|
| XDev plugin / adapter | 0.0.9 / 0.1.0-d2.7 |
| release_id | xdev-d2-source02-remediation-20261021-r1 |
| 插件身份 | xdev / XDev Local；现有marketplace身份xdev@xdev-d1-local-20260924可延用，只保留一套有效连接 |
| 首选工程SDK | build a4a3e1d98344a3afe75183a3bd075c2c7da6399ed6c10267941146c1ffd9aab2；xmem-engineering/2 / xmem-engineering-mcp/2；record仍xmem-engineering/1 |
| 兼容 | 精确54e0a021…仅工程/1；related还接受原0dba41f0…；完整允许表为mcp/sdk-builds.ts，JS包为同模块.js |
| SDK来源 | 使用本次配套交付报告给出的已资格真实根，核38程序pin及生产依赖资格。XMem版本文字不足以证明build；不要求不存在的新tgz |
| Node | SDK子进程实际24.20.0并核文件SHA；XDev MCP QA仅原24.19.0/24.20.0范围 |
| 支持组合 | 显式CUSTOM_LOCAL外置库、SEMI_AUTO、developer；其他组合另验 |

| 所选交付形态 | stdio入口 | 配置打印/本地初始化 |
|---|---|---|
| SOURCE03原TS源码，按两锁安装依赖 | 实际Node加--experimental-strip-types ABS_XDEV/mcp/server.ts | mcp/configure.ts / mcp/local.ts，带Node strip-types参数 |
| 编译JS私有运行包 | 实际Node加ABS_XDEV/mcp/server.js | mcp/configure.js / mcp/local.js；无需TS |

默认均不带--config。需要项目时才显式给其真实配置。选定一行，记录实际argv、cwd和宿主解析到的程序/缓存路径；不能用SOURCE入口证明JS包，或用源文件版本文本证明暖会话已加载。

## 2. 一份目标记录

    日期/时区、OS及版本：
    宿主名称/版本、模型/角色路线：
    XDev包SHA、实际程序根、宿主缓存/连接标识：
    形态（SOURCE03 TS / 编译JS）、Node路径/版本/SHA：
    XMem实际SDK根/build/38pin清单SHA、生产依赖来源：
    路线（宿主原生MCP / source SDK client / 其他）：
    新会话或正常重连观察：
    真实新测试工程、外置control/input/store、授权来源：
    本轮允许/禁止文件、有限次数、deadline/停止条件：
    原始回包/公开角色消息/日志的位置：

每行测试填写状态（PASS / FAIL / BLOCKED / NOT_RUN）、实际值与证据路径。不同机器/旧连接的结果不能合并成一份通过。

## 3. 安装与默认无绑定

1. 新目录解压，核包外ZIP SHA、完整文件清单及内置清单排除自身的规则；规范唯一路径、实际文件集合、bytes/hash全部匹配。保留旧程序与现场Job/数据。
2. 按所选包形态，用宿主支持的本地插件或stdio MCP流程接入真实目录；已有同身份升级，不新增重复XDev，不手改cache假装更新。
3. 正常重连/新会话后保存initialize、工具发现和一次实际xdev_context原回包。版本、release_id、Node实际观察与磁盘字节分开核。
4. 应只有xdev_context：UNBOUND；project_id/project_root/control_root/input_root/config全null；stage_inputs/write_jobs/execute_qa全false；job_created/task_ready/execution_allowed/role_dispatch_supported全false。空cwd前后无数据/Job，环境或cwd不隐式选工程。此时没有记忆动作符合预期。
5. 坏config在读取前明确拒绝，无stdout伪成功或新数据。旧暖会话仍回旧版时定位连接，不靠README判更新，不强杀共享进程。

## 4. 显式项目和准备

用户只需给真实工程与意图。宿主协调者按LOCAL-MCP及SUPERVISED-QUALITY整理当前需求、必要设计、准确范围、FileRef/hash、UTC授权与期限；有真实矛盾先澄清。不要求用户手填UUID/JSON，不从记忆或附件取得权限。

在批准的新外部data根初始化，再加载其真实配置；默认权限false。核project/workspace/task/version及批准请求，公开每项权限。先preflight核绑定、输入图和final_writer能力：正式QA所需的平台/存储/Windows CIM已知不支持时应UNSUPPORTED，Store/claim/命令均未创建或消耗。明确prototype时仍披露原能力UNSUPPORTED及required=false，只保留原登记/一次自检，不获得formal签章。普通受限token与经批准普通用户域分列；不声称管理员或通用OS沙箱。

## 5. 真实受监督任务闭环

1. 仅在本轮批准范围/有限额度内start一个新Job，核真实版本/contract/manifest和独立角色合同。
2. 实际独立Worker实施并自然final，收集原公开派发/返回/完成观察，再record implementation；不能由协调者代签成果。
3. 不同实际Reviewer审范围/需求与设计一致性及审核负担并自然final，再record Review。PASS收据与TESTING应同事务落账。
4. 不同实际QA本人按冻结命令执行，先核writer能力SUPPORTED及角色/版本/授权，再消费唯一claim。保存原stdout/stderr、真实退出、同版manifest及自然final，实际record QA。
5. 新进程统一查询Job、Review、QA与交付结论；VERIFIED/delivery_allowed须有同版独立Review+实际QA+原final，execution_allowed不因此变true。失败/未知保持，不能以包检查替业务质量。

## 6. 登记中断与恢复（仅另批授权的合成新任务）

- implementation六步和Review收据→TESTING提交中断应all-or-none；重复同原路径/字节/session/版本record只读返回，journal字节不变。
- 旧实现只有已持久原implementation evidence的已知前缀、或原PASS Review receipt仍在REVIEWING，才可在原授权有效且全部原件一致时补后缀。READY/INTENT缺原记录、漂移/撤销/过期保持BLOCKED。
- QA已经执行但原final缺失，仍按QA-RECOVERY原规则分辨UNKNOWN/缺原件/合法原final replay；不删除锁、claim或账、不伪造final、不重跑旧QA。
- 首次正式QA已知不支持writer时，必须claim0/命令0。并发与文件故障演练只在另外明确授权的新测试域，不在现场旧Job造故障。

## 7. XMem正常边界与实际采用

1. 显式批准实际SDK根/build/全部pin/Node/policy/location/原七工具schema和新工程契约；核CUSTOM_LOCAL外置库、SEMI_AUTO、developer。安装XDev不自动启用记忆或建库。
2. context/prepare/preflight不隐式召回或保存。已授权协调者在任务进入、实际Worker CREATE/CONTINUE/REPLACE边界，生成当前批准的收窄查询FileRef并调用worker-context。
3. 选中JSONL正文、scope、两hash、来源、条件、约束、UNKNOWN、coverage和引用完整送到真实Worker消息。EMPTY、INCOMPLETE、拒绝与未知分别保留；required缺项不能靠截断/扩大预算造READY。
4. 保存批准的公开决定、成果、纠正/检查点；核同key完整读回。SAVED、ACK、PREPARED只是各自回执；实际发送、Worker接收和后续公开成果采用各留原公开证据。私有Reviewer/QA材料、隐藏推理/评测源不得共享。
5. 新/2合法文件摘录：source_content_hash核来源全文，record_content_hash核原记录content UTF8，item/reference一致且正文匹配record hash，两hash可以不同。篡改正文/引用/来源任一绑定应拒绝。SDK仍复核来源双读，hash不是Owner或执行认证。
6. 明确更正关系的新批准event使用revises:{memory_key,previous_revision_id}；Core同key精确前驱CAS。默认当前仅后继，显式historical追原文；陈旧前驱拒绝。无明确关系不做语义覆盖，UNKNOWN同事件只读对账，不换ID重写。
7. related使用目标真实批准deployment根，全部pin重算允许build，来源ID/tags/grant只收窄；本地预算槽和SDK只读分列，不删除/退款/重建/自动续次。

## 8. 源码重建与运行包核验

SOURCE03根packageManager固定pnpm11.25.0，项目pnpm-workspace.yaml声明hoisted/copy；新目录、空user/global配置、隔离cache/store，根按pnpm锁安装，mcp按其npm锁独立ci，均ignore-scripts。核原资格依赖输入和TS5.9.3编译器SHA；不能因另一个安装树不同而改pins。

source/output/evidence在首次mkdir前作两两双向及现存祖先realpath隔离。运行包清单拒绝重复、大小写碰撞、反斜线、父/绝对路径，并核实际精确集合；每个产品JS语法、模块路径闭合、配置描述、UNBOUND和坏config自然退出独立留证。编译JS不含TS/声明/maps/测试，仍可读；第三方原LICENSE/NOTICE保留。构建或包装检查不等于真实业务QA。

## 9. 汇总与回退

| 层次 | 状态 | 证据/未验范围 |
|---|---|---|
| 本目标安装/唯一连接/实际release | NOT_RUN | |
| UNBOUND/null/false/空cwd | NOT_RUN | |
| 真实项目准备/preflight/能力预拒绝 | NOT_RUN | |
| 同版本Worker/独立Review/实际QA/统一查询 | NOT_RUN | |
| 登记原子/幂等/已证明旧前缀与QA恢复 | NOT_RUN | |
| 新SDK双hash/显式更正/current/history | NOT_RUN | |
| 实际Worker发送/接收/公开采用 | NOT_RUN | |
| related授权与不可退款预算 | NOT_RUN | |
| 干净构建/运行包闭合/完整清单 | NOT_RUN | |

回退先停新写，保留未知操作key/意向/失败、Job/库和配置快照，按宿主受支持流程恢复明确批准的旧程序并正常重连。回退不授权重试；不猜PID安全、不删锁或旧账。500ms外部未复现项仍暂缓；其他OS/宿主、长期收益与全局后代闭合未验时如实说明。
