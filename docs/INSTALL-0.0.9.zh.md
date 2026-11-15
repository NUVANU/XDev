# XDev 0.0.9 安装、版本核对与回退

候选资格、实际包SHA和完整清单看本次交付报告；报告未通过不能据此填PASS。采用唯一身份xdev / XDev Local，保留现有marketplace身份，不新增第二套XDev或手改cache。

## 交付形态

SOURCE03是原TS、测试、两锁和构建载体，不含node_modules/现场库。实际Node24.20.0与pnpm11.25.0，项目pnpm-workspace.yaml固定hoisted/copy；在新目录、空user/global配置及隔离cache/store中，根pnpm install --frozen-lockfile --ignore-scripts，mcp独立npm ci --ignore-scripts --no-audit --no-fund。按BUILD-CONFIG原输入和编译器hash核资格；见README-SOURCE03.zh.md。

编译JS私有运行包包含所需第三方运行文件及原LICENSE/NOTICE，不需TS/npm安装；需另有实际Node24.20.0。JS仍可读，XDev自有部分UNLICENSED私有受邀内测，第三方原许可不改。

## 安装与实际响应

两种形态都解压新目录，先核外部ZIP SHA、实际完整集合和每项bytes/hash，保留旧程序与现场数据。SOURCE入口为实际Node加--experimental-strip-types ABS_XDEV/mcp/server.ts；编译JS入口为实际Node加ABS_XDEV/mcp/server.js。默认不带--config。配置打印/初始化分别使用同形态mcp/configure.ts或.js、mcp/local.ts或.js，TS入口带Node strip-types参数。

按目标宿主支持的本地插件/MCP方式接入真实根，正常重连/新会话后保存实际initialize/tools/list/context回包。应见plugin0.0.9、adapter0.1.0-d2.7、release_id=xdev-d2-source02-remediation-20261021-r1。UNBOUND只context、根全null、权限false，无Job/数据。缓存字节、版本文本、实际进程分别核，不靠README判暖会话已升级，不强杀共享进程。

明确真实工程和当前任务后，协调者在批准的新外部data根初始化并从实际文件计算FileRef/hash；默认权限false。按LOCAL-MCP、SUPERVISED-QUALITY与SOURCE02-REMEDIATION-0.0.9准备范围、有限次数与期限。先preflight披露final_writer，正式QA在claim前再次拒绝已知不支持；不改角色/ACL或撤writer守卫。

## XMem配套

当前首选build a4a3e1d98344a3afe75183a3bd075c2c7da6399ed6c10267941146c1ffd9aab2，工程SDK/2、工程MCP/2、记录仍/1。使用本次配套交付报告给出的已资格真实根，核38程序pin与生产依赖资格；不要求尚不存在的新tgz。旧54e0a021…只按精确工程/1兼容；related保留允许表中的原0dba。完整表见mcp/sdk-builds.ts（JS包为.js），不接受任意SDK。

XDev不捆XMem程序/数据库/账号，不自动启用记忆。本组合显式CUSTOM_LOCAL外置库、SEMI_AUTO、developer，须另核Node/部署/工具/政策/位置/批准来源/预算。新/2双hash、显式revises同key前驱及实际Worker转交要求见XMEM-BRIDGE和当前变更说明。

## 验收与回退

附HOST-ACCEPTANCE-0.0.9.zh.md，逐OS/宿主/实际路线填写，未验NOT_RUN。独立源码Review/QA、运行包检查、安装和真实业务采用分开。回退先停止新写，保留原Job/未知意向/失败/库/配置，按宿主受支持流程恢复明确批准的旧程序并正常重连；不删锁/claim、不换ID重试，不复活旧额度。
