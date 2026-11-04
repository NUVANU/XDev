# XDev Community

XDev 在 Codex 中按用户批准的项目、任务版本和改动范围准备及执行开发，并记录 Review、QA 和交付结果。本源码对应 X Suite 联合验收中的 R10 执行代码，以及保留现有材料准备工具的本地插件外壳。

## 本地使用

使用 Node 24.20.0、pnpm 11.25.0 和 npm 11.19.0。在仓库根目录执行 `pnpm install --frozen-lockfile --ignore-scripts`，再到 `mcp` 目录执行 `npm ci --ignore-scripts`。回到根目录后可运行 `npm run typecheck`。

Codex 以 Node 启动 `--experimental-strip-types <绝对路径>/mcp/server.ts`。默认只返回无项目绑定的 `xdev_context`。实际项目通过 `mcp/local.ts init` 显式设置，随后用 `mcp/configure.ts --config <绝对配置路径> --host codex` 生成接入参数。项目、QA 和记忆权限均须按当前任务和宿主许可配置。

本发行的复现范围为本机 D2 和 X Suite 联合验收使用的接入路径。代码库中保留了较早的 D1 本机依赖验证入口，适用范围限于其已登记环境。

XDev 社区源码及本仓库自有文件采用 MPL-2.0。原有第三方声明继续适用。
