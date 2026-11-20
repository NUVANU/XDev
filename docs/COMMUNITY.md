# XDev 社区版工作流 / Community workflow

0.1.5 adds an explicit project-local layout for supported supervised tasks. Start with the [suite installation guide](https://github.com/NUVANU/X-Suite/blob/main/INSTALL.md). English overview: [README](../README.md).

## 1. 先选择实际操作路径

日常已有能力支持、范围清楚且可回退的操作，按风险备份、执行、核结果，不默认建立产品 Job。产品行为或协议变化才进入当前合同下的开发、非作者 Review 和实际 QA。高风险叠加具体检查；既有 Job、承诺、消费与 UNKNOWN 不因重新分类降级。

See [operation routing](R4-OPERATION-ROUTING.zh.md) and [shallow integration](R4-SHALLOW-INTEGRATION.zh.md). These are host policies, not new core enforcement.

## 2. 明确项目与来源

无配置启动 MCP 时，`xdev_context` 只返回 UNBOUND；不选择 cwd，不创建任务，也不授予写权限。真正开发前按 [LOCAL-MCP](LOCAL-MCP.zh.md) 显式设置实际项目、输入/控制目录及准确权限，重连后核对 context。

For a supported XMi XSpec handoff, preserve its original files and manifest and use explicit source-to-target mapping under the spec-intake permission. A successful readback is not permission to execute the specification. XMi is optional for a clear ordinary task.

普通受监督开发可显式选择项目直属 `.xdev/control`、`.xdev/input` 与 `.xdev/local-config.json`。只排除这三个运行数据路径，其他 `.xdev` 产品文件仍纳入候选。已有目录不覆盖、不自动搬迁；XSpec 接收、旧 XMem bridge 与外部实施产物采用仍使用外置布局。详见 [LOCAL-MCP](LOCAL-MCP.zh.md)。

## 3. 新正式开发使用 v5

普通正式 Node 任务采用 [v5 统一合同](R4-UNIFIED-CONTRACT.zh.md)，不选择三档，不静默填旧 profile。用户给出目标与真实决定，协调者从确认来源准备结构化请求；不能猜测风险、权限或范围。

按当前请求与候选核 `xdev_prepare`、`xdev_preflight`，获准后 `xdev_start`。宿主完成实现与角色协调；非作者 Review、实际 QA 和最终记录在同一 Job、版本与候选下关联。用 `xdev_status` / `xdev_result` 独立读回结果。

Legacy v1–v4 and existing Jobs keep their original contracts. Do not migrate them by renaming a profile. The supported runner has an exact runtime and bounded-command limit; other QA mechanisms require their own supported evidence path.

## 4. 中断先只读诊断

按 [QA recovery](QA-RECOVERY.zh.md) 区分未执行、claim-only/未知写者、同候选原结果可重放、需要新验证、确定失败后继。先保留原身份、原 final/receipt、失败、窗口与消费。UNKNOWN 不通过删锁、换 key 或新建任务处理；存在准确权限时才走对应恢复入口。

## 5. 优先使用原生 XMem

已配置原生 XMem 时，发现和核对实际项目、政策与存储，再绑定真实 task/version/role。按需要检索并完整展开采用内容；关键公开发现保存后完整读回，阶段交接建立 checkpoint。不为每条命令重复记忆，不共享 Reviewer/QA 私有内容。

未配置或未加载时如实披露，继续不依赖记忆的已授权工作，不自动初始化现场库或修改全局 memory 开关。

**Compatibility:** the legacy XDev bridge and `xdev_memory` remain build/storage-qualified interfaces. XMem 0.1.2 is not automatically admitted. Use the host's direct XMem MCP connection; do not change old fingerprints to bypass qualification.

## 6. 复用准备工具

受支持的材料读取与准备使用 `material-tools` 的既有入口，保留批准范围、原 FileRef 与真实输出。入口和限制见 [PREPARATION-AB](PREPARATION-AB.zh.md)。UNSUPPORTED 先查已有公开 CLI/SDK；不能把一次日常操作自动升级为开发新工具的任务。
