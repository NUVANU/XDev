# XDev 社区版操作

从 [X Suite 安装指南](https://github.com/NUVANU/X-Suite/blob/main/INSTALL.md) 选择配套的 XDev 和 XMem。保留 XDev 源码目录，生成的 Codex 插件从该目录启动 MCP 服务，材料准备工具也位于该源码目录。

## 项目绑定

在新对话先调用 `xdev_context`，核对项目根、控制目录、输入目录、权限和已批准请求。未绑定的服务只提供 context。已绑定的配置记录了项目和各目录。修改本地配置后重开连接，重新核对实际绑定。

只使用当前用户批准的路径、文件和任务版本。任务写入、实际 QA、接收 XSpec 和记忆操作分别按本地配置判断权限。

## XSpec 接收

将 XMi 导出的 16 个原件放在 XDev 输入目录的一个独立子目录，保留文件名和原始字节。计算 `manifest.json` 的 SHA-256 并生成 FileRef。映射使用 `xdev-xspec-mapping-1`，将 manifest 中的 `project_id`、`spec_id`、`spec_version`、`product_model_version` 放入 `source`，将 XDev 已确认的 `project_id` 和绝对 `project_root` 放入 `target`。

经用户批准后，在本地配置中启用 `permissions.receive_specs` 和 `spec_intake.enabled`，将 manifest 与映射各自的 FileRef 登记在 `approved_sources` 和 `approved_mappings`。在同一输入目录保存 `xdev-xspec-intake-request-1`，它包含 `manifest` 和 `mapping` 两个 FileRef。重新连接后将请求 FileRef 传给 `xdev_spec_receive`。用 `xdev_spec_read` 核对同一原件与回执。回执中的 `execution_allowed` 由任务流程单独决定。

## 监督任务与 QA

按 [xdev-supervised](../skills/xdev-supervised/SKILL.md) 准备并核对用户确认的范围、验收条件、固定命令和有限授权。用 `xdev_prepare`、`xdev_preflight` 检查来源和绑定。只有批准的请求和权限都就绪时，才能用 `xdev_start` 建立 Job。

实施、Review、实际 QA 和交付都要在同一 Job 和批准版本下登记。独立 Review 通过后，用 `xdev_qa` 运行固定的 Node 检查，保留真实命令回执，再登记 QA 最终结论。用 `xdev_status` 或 `xdev_result` 核对当前结果。原型项目按其批准范围使用 `xdev_self_check`。

## QA 恢复

断连或结果未知时，先读原 Job、版本和执行回执。已有声明、执行记录和资格按原件核对。只有配置了专门恢复许可时，才能使用对应恢复入口登记已产生的原 QA 结果。

## 项目记忆

用 `xdev_context` 核对记忆绑定、任务版本、角色和动作权限。用 `xdev_memory` 显式 `recall`。写入时使用用户批准的公开源文件，并核对读取到的修订和内容。需要跨会话接续时登记明确的检查点，然后重开会话回读并核对项目和任务版本。

部署清单由配套安装流程生成。保留 XMem 运行目录、Node 版本和现有授权边界。可用动作以实际绑定和工具清单为准。

## 材料准备

在 XDev 源码目录的 `material-tools` 里运行对应 PowerShell 入口。普通 JSON 和原字节读取用 `PreparationJson.psm1`，字面约束用 `Test-AuthorLiteral.ps1`，固定材料准备使用 `Invoke-MaterialPreparation.ps1` 或 `Invoke-PreparationPackage.ps1`。先读取入口的参数，再使用用户批准的输入、输出目录和原 FileRef。保留返回对象和原始回执供复查。
