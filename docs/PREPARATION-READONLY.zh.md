> Public source note (2026-11-15): machine-bound historical Test-MaterialFixtures.ps1 and private QA inputs are excluded. The counts below describe original upstream evidence, not a rerunnable public test package. Use the current public tools and synthetic tests under explicit approved inputs.

# 准备材料：只读检查与固定数据派生

本版默认采用现有准备工具。覆盖的 JSON/字面/固定材料/包级操作必须实际调用相应入口，不得另写等价校验脚本；调用和 pins/输出/UNKNOWN 留证。完整版显式 A+B 操作、诊断及 legacy 只读边界见 [PREPARATION-AB](PREPARATION-AB.zh.md)。旧版本暂缓记录继续保留。安装、当前宿主加载及实际采用按各自证据报告。

需要 PowerShell 7.5 或更新版本。调用者明确提供规范的 Windows 绝对路径、允许的根目录和小写 SHA256；根目录应由当前项目批准范围给出。材料最多 2 MiB，JSON 深度最多 32。本节读取器只读材料；固定派生与包入口按批准目录创建数据状态，不写 Job、Core、代码或记忆。

```powershell
Import-Module 'ABS_PACKAGE\material-tools\PreparationJson.psm1'
$material = Read-PreparationJson -Path $path -Sha256 $sha -AllowedRoots @($approvedRoot)
try {
    $material.Text # 原始 UTF-8 文本
    Get-PreparationString -Read $material -Pointer '/task/name'
} finally { $material.Document.Dispose() }
```

`Read-PreparationRaw` 返回原文、字节数和来源。`Read-PreparationJson` 另外拒绝重复键并保留原始 JSON 类型；`Get-PreparationString` 检查明确指定的字段是否为字符串，可用 `-UtcMilliseconds` 检查 `yyyy-MM-ddTHH:mm:ss.fffZ`。这些检查不证明业务语义、完整任务结构或文件从此不再变化。调用者负责释放 JSON Document。

字面检查的公开入口是 `material-tools/Test-AuthorLiteral.ps1`，参数为 `RulesPath/RulesSha256/SourcePath/SourceSha256/AllowedRoots`。规则文件必须精确采用：

```json
{"format":"xdev-author-literal-rules-1","rules":[{"old":"待核对的原文字面量","occurrences":1}]}
```

规则 1 至 64 条，计数是大小写敏感、非重叠的字面匹配。输出 `CHECKED_LITERAL_ONLY` 或 `REJECTED`，逐条列出 expected、actual、passed，始终 `execution_allowed=false`。路径、哈希、UTF-8、JSON 或规则无效时抛出原始错误；协调者将该材料记为拒绝或 UNKNOWN，不据此继续执行。工具不会应用任何替换。

每次业务使用仅记录入口、实际材料引用、保留／拒绝结果、实际额外耗时和未帮助的情况。独立 QA 与安装回执产生前，此目录只供审阅。

## 固定材料组件（F01）

六个文件为 PreparationJson.psm1、Test-AuthorLiteral.ps1、Derive-Material.ps1、Test-Material.ps1、Invoke-MaterialPreparation.ps1 和 Test-MaterialFixtures.ps1。前两文件原样保留，后四文件复用 ER03 合格原字节。65/65 局部 QA 仅覆盖其原组件范围；本版本安装、加载及实际普通任务采用分别留证，不能由旧 QA 代替。

公开入口：material-tools/Invoke-MaterialPreparation.ps1。需要 PowerShell 7.5 或更新版本。协调者必须分别固定以下实际参数，不能用示例占位值运行：

- A：ApprovedContractPath/ApprovedContractSha256、SourcePath/SourceSha256、ManifestPath。
- B：CheckerApprovedContractPath/CheckerApprovedContractSha256、CheckerSourcePath/CheckerSourceSha256、CheckerManifestPath/CheckerManifestSha256。
- 当前窄目的 Purpose 和已批准、真实存在的 OutputDirectory；A 的 manifest SHA256 来自其固定 approved contract。

固定 approved contract 使用 xdev-material-approved-contract-1，source envelope 使用 xdev-acceptance-material-source-1 的 /material。支持 IMPLEMENTATION_RECORD（implementation/public-session-2 的精确字段）、RECORD_PREFLIGHT（expected+record）和 IMPLEMENTATION_RELEASE（job_id/task_name/message）。CAPACITY_SUBJECT 只生成惰性材料；FORMAL_QA_SUBJECT 仍明确拒绝。它不是任意 JSON/角色/协议生成器；没有适用原件不得造 Job、Task、角色 final 或批准来源。

先有分别冻结的独立 A/B 原件，再生成并对照 B 核验；B 为空必须拒绝，B 不从 A、输出或 lineage 推导。路径、根、哈希、唯一 JSON 键、原生类型、引用图和当前合同绑定仍按原规则检查。Fixture 开关只用于协调者明确批准的惰性 TEST_ONLY 数据，不能把夹具当真实角色、Job 或业务验收。

派生器以 CreateNew 创建 material.json 和 lineage.json；发生部分写入或结果不明保留原文件并对账，不覆盖、清理或自动再跑。wrapper 的 CHECKED_NOT_EXECUTED/REJECTED 与 execution_allowed=false 仅说明材料步骤，不创建或修改 Job，不调用 SDK/Core/Node，也不批准或执行正式 QA。Test-MaterialFixtures.ps1 是需要单独释放给独立 QA 的原65例夹具，本卡不重复运行它。

普通新卡优先直接使用工具返回的对象/FileRef。确需上述固定协议且具体授权覆盖数据写入时必须使用派生入口；staging 仍需独立 stage_inputs 权限。材料转录、最终双查询、离线成本和有限纠错统一按 [监督说明](SUPERVISED-QUALITY.md#f01f04f05f06材料复用查询与有限接续) 执行。本包外部当前交付清单给出本版本资格；packaging/BUILD-CONFIG.json、FROZEN-SOURCE-MANIFEST.json 等原构建资产保持历史字节，不充当新批次清单。
