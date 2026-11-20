# XDev 0.1.5 / 公开源码更新

2026-11-20 · MPL-2.0

## Project-local layout / 项目内布局

Ordinary supervised work can now explicitly place XDev data in the project's direct `.xdev` directory:

```text
project/
  .xdev/
    control/
    input/
    local-config.json
```

Use the existing local initialization command with the actual project and a new, non-existing data directory:

```powershell
node --experimental-strip-types mcp/local.ts init --project-root C:\Projects\my-project --data-root C:\Projects\my-project\.xdev --project-id my-project
```

This is explicit opt-in. Installation still starts UNBOUND, initialization does not create a Job or grant QA authority, and existing data is not overwritten or migrated.

受监督源码清单只排除本布局保留的 `.xdev/control`、`.xdev/input` 和 `.xdev/local-config.json`，不排除整个 `.xdev`。其中其他产品文件仍纳入候选检查。控制和输入保持隔离，原许可、claim、Job Store、版本、独立 Review 与实际 QA 要求继续生效。

## Supported boundary / 支持边界

- The project-local data root must be the direct `.xdev` child with the exact reserved paths. Other overlapping roots, aliases, links, unexpected input references, and unsupported namespaces remain rejected.
- External layout and default UNBOUND behavior remain supported.
- **XSpec intake, the legacy XMem bridge, and external implementation-artifact adoption continue to require external layout.** Do not use the new directory option to bypass their original boundaries.
- The host's independently configured native XMem connection is separate from the legacy bridge and is not changed by this update.
- Git/file backups, installation, project binding, actual process loading, task execution, and business QA remain separate operations.

When using the complete suite's XMi specification intake, retain the external layout described in the [suite installation guide](https://github.com/NUVANU/X-Suite/blob/main/INSTALL.md). For ordinary supervised work, the project-local layout is an additional option.

## Source and packaging / 来源与公开封装

The accepted source line is `0.0.24+local.project-layout.20261120`, delivered as a stable project-specific runtime. All **4,954** files of that runtime were checked against its retained accepted manifest for this public synchronization. The delta from the previous local source contains 12 changed files; eight applicable runtime/document files are synchronized. Test fixtures, private project configuration, installation receipts, and local acceptance logs are not included in the public payload.

Public package/plugin and MCP release declarations use **0.1.5**, with MPL-2.0 preserved. Bilingual README, public workflow documentation, and installation examples are updated. Public metadata/documentation changes produce different hashes from the local source; original records are not relabeled or rebound.

The source changes are confined to project/config initialization, validation and input boundaries, storage identity, candidate membership, Store binding, and related documentation. Existing dependencies, hook configuration, memory build allowlists, permissions and quality gates are preserved.

## Validation and limitations / 验证与限制

The upstream independent source Review passed after two retained failed reviews and their bounded corrections. The findings concerned candidate-member case handling and the distinction between literal source membership and physical input-directory containment. Original failed pins and corrected bytes were retained.

The author's related regression package completed **65/65**, including one synthetic approved Job start and subsequent query. That is author regression evidence, not independent business QA. The independent verifier separately completed typecheck and actual read-only stdio probes for both project-local and external bindings, confirming configuration, permissions and candidate membership without changing its fixtures.

The current test volume could not create two genuinely distinct directories whose names compare equal under case folding; that dynamic branch remains unrun. A complete business implementation/Review/QA cycle, other hosts, and global installation were outside this change's acceptance scope.

本机项目级注册已作实际读回；普通沙箱中的写入能力检查返回过 `SUPERVISED_WRITER_DOMAIN_UNAVAILABLE`，普通本机权限下旧外置与新项目内路径均返回 `SUPPORTED`。预检 `CHECKED` 不是新的执行授权。既有完整集成未通过记录与 UNKNOWN 继续保留，不因本次限定布局验证而变成通过。

See [LOCAL-MCP](LOCAL-MCP.zh.md) for exact setup, path validation, permissions, and workflow restrictions. Existing installed/global instances and old conversations do not automatically switch to this public package.
