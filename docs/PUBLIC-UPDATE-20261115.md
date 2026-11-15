# Public source update — 2026-11-15

Public package/plugin: **0.1.3**, MPL-2.0. This is a source synchronization, not a new claim of overall R4 acceptance or an attached binary GitHub Release.

## Provenance

The owning local source is the installed R4 MECH-02 line, upstream plugin `0.0.22+local.r4.mech02.20261114` over the scoped R4 core. Source files are copied from that fixed runtime source tree; local databases, dependencies, session logs, actor-private evidence, machine-specific acceptance scripts and QA fixtures requiring private evidence, and unrelated project material are excluded.

Public packaging aligns package/plugin declarations and the MCP release declaration to 0.1.3, preserves MPL-2.0, adds a local marketplace descriptor for the existing plugin, updates bilingual documentation, and adjusts matching version assertions in three existing release/MCP tests retained in the local verification copy. Existing legacy protocol and runtime allowlists retain their meanings. The upstream root package version and plugin version were different; neither is used as the public version silently.

## Evidence scope

The upstream R4 core record reports scoped core acceptance and separate real feature/fix delivery checks. MECH-02 independent Review and six host scenarios passed: three executed fixture operations, three decision-only cases. Installation and warm-session policy adoption were checked locally; the MECH-02 record does not claim fresh automatic native loading, overall R4/S4 acceptance, or measured cost improvement.

Public packaging changes hashes. The original upstream manifest identifies the upstream tree, not this documented public tree. Current Git commit/tree and generated runtime fingerprints identify the public distribution.

## Compatibility

New formal Node work defaults to request v5 without a tier selector. Old requests, Jobs, UNKNOWN, consumed attempts, and finite authorizations retain their original semantics. The legacy optional XMem bridge has fixed runtime/storage qualification; use independently configured native XMem for the current XMem 0.1.2 source.

## Public payload boundary

Historical XDev test fixtures and acceptance histories are retained locally outside this public source tree, because some contain internal project references or machine-specific assumptions. The local packaging check ran 224 scoped tests successfully in an ordinary Windows host process; an earlier sandbox run could not obtain the Windows writer domain. These checks are local verification evidence, not a public full-suite or fresh-host acceptance claim. The public tree retains runtime/source dependencies, schemas, Skills, runtime preparation tools, and user-facing documentation. Internal material-test runners and the local comparison/evaluation harness are excluded with the retained QA material.
