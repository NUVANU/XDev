# XDev

**Make “done” an inspectable claim.**

Engineering governance and delivery evidence for AI-assisted development in Codex.

**English** · [简体中文](README.zh-CN.md)

[Quick start](#quick-start) · [Community workflow](docs/COMMUNITY.md) · [X Suite](https://github.com/NUVANU/X-Suite)

An AI can write code and confidently announce success. The harder questions are: Did it stay within the agreed scope? Did someone review the actual change? Did QA run against the candidate you are about to receive?

**XDev connects those questions to project-bound records.** It prepares approved work, checks input and scope bindings, and records implementation, Review, actual QA, and delivery outcomes. Your host and model still perform the coding and agent execution.

## Why use XDev?

| A common failure mode | The check XDev adds |
| --- | --- |
| A task starts with ambiguous or changed inputs | Preparation and preflight checks against approved, versioned inputs |
| A file with the right name belongs to the wrong project or version | Explicit project mapping, file references, and content hashes |
| An agent adds features outside the request | Approved/forbidden scope and Review conformance checks |
| “Reviewed” and “tested” refer to different candidates | A Job and candidate binding shared by stage evidence |
| An implementation self-check is presented as independent QA | Distinct evidence requirements for implementation, Review, and actual QA |
| A disconnect makes the last QA result uncertain | Read-only diagnosis and bounded reconciliation using original records |

Use it when a small demo is becoming a maintained project, when multiple agents hand work to one another, or when you want to inspect the basis of a delivery rather than rely on its final message.

## What the workflow looks like

```text
Confirmed request and permitted scope
             ↓
Prepare → Preflight → Start Job
             ↓
Implementation → Review → Actual QA
             ↓
Status / result with the relevant evidence
```

The flow is carried out through supported host tools and XDev’s structured interfaces. Stage success does not grant new authority, and a specification receipt does not itself permit development.

### 1. Bind the right project and inputs

`xdev_context` exposes the actual project/configuration and available permissions. `xdev_prepare` and `xdev_preflight` check supported source and binding conditions before a Job starts. An unbound MCP service exposes context only; it does not silently select the working directory as a project.

For an XMi handoff, the intake maps the XSpec identity to the explicitly selected XDev project, checks the manifest and original files, and provides a readback receipt. Ordinary tasks can also start from a clear, confirmed request; XMi is not mandatory for every change.

### 2. Keep development and validation evidence together

Use the same Job and approved version when recording implementation, Review, QA, and delivery. The published workflow supports different assurance profiles; formal full governance requires distinct implementation, Review, and QA sessions. Prototype self-checks retain their limited status.

For example, a cancellation-rule change should be judged against the agreed behavior, its actual diff, and the QA receipt for that candidate—not a passing result from an earlier file set.

### 3. Reconcile interruptions before continuing

Status/result queries inspect the original Job without dispatching more work. If QA execution persisted but final registration is missing, the documented recovery path requires the original result and the applicable recovery permission. An unknown result is not a reason to erase evidence or rerun QA blindly.

## Quick start

Current public source: **V0.1 community line · package `0.1.2` · MPL-2.0**. The documented joint setup pairs it with **XMem `0.1.1`**.

**For installation and project setup, follow [the X Suite Windows guide](https://github.com/NUVANU/X-Suite/blob/main/INSTALL.md).** It configures the matching XMem runtime, deployment manifest, XDev local plugin, and explicit project binding.

To prepare the source checkout, use the documented Node.js **24.20.0**, pnpm **11.25.0**, and npm **11.19.0**:

```powershell
# Run from the XDev repository root.
pnpm.cmd install --frozen-lockfile --ignore-scripts
npm.cmd --prefix mcp ci --ignore-scripts
npm.cmd run typecheck
```

The source MCP entry is:

```text
node --experimental-strip-types <absolute-XDev-path>/mcp/server.ts
```

Starting the server alone does not configure a project. Use the [installation guide](https://github.com/NUVANU/X-Suite/blob/main/INSTALL.md), then reopen the connection and check `xdev_context`. Project writes, QA execution, specification intake, and memory operations have separate permissions.

An example request **after setup and the required task approval**:

```text
Use XDev for this project. First verify the project binding.
Work toward the confirmed acceptance criteria within the approved scope.
Keep implementation, independent Review, and actual QA evidence separate.
Report the final candidate and any missing evidence truthfully.
```

## Technical foundations

| Mechanism | Purpose |
| --- | --- |
| MCP + Skills + source CLI | Expose structured operations and guide supported host workflows |
| Versioned preparation/request records | Keep the approved inputs and task contract explicit |
| FileRef + SHA-256 + candidate manifests | Detect content drift and bind evidence to the relevant bytes |
| Job and stage records | Keep implementation, Review, QA, and delivery claims distinguishable |
| Bounded Node QA runner | Run the frozen supported command and retain its actual receipt |
| Recovery/status entry points | Inspect and reconcile interrupted work without treating a query as execution |
| XMem integration | Explicitly retrieve and preserve applicable project knowledge |

The repository also retains PowerShell material-preparation tools under `material-tools`. See [community operations](docs/COMMUNITY.md) for the supported entry points.

Hashes establish content consistency, not the truth of a review or native authentication of a reviewer. Public role provenance is coordinator-transferred in the documented supervised path. Independent sessions and actual runner receipts still matter.

## XDev, the host, and XMem

- **Host/model:** coding, tools, agent scheduling, execution permissions, and lifecycle.
- **XDev:** task/scope bindings, evidence requirements, stage records, delivery judgments, and bounded recovery.
- **XMem:** persistent engineering history, sources, revisions, and retrieval.
- **XMi, when useful:** clarify the product and export the specification.

XMem history is context, not permission to execute a new task. XDev is not an operating-system sandbox and does not intercept every arbitrary shell operation.

## Current scope and limitations

This README describes the source published in this repository, not newer local development builds. Its documented acceptance scope is the local D2/joint workflow; legacy D1 paths have additional environment-specific requirements.

The MCP QA path supports exact Node.js **24.19.0 / 24.20.0**, **one frozen command**, and a **maximum 90-second synchronous QA budget**. It does not establish browser/UI, game-engine, load, or production acceptance. A disconnect/timeout is not proof that an operation stopped.

Tool visibility, installation, project binding, Job completion, actual QA, and release acceptance are separate claims. Other hosts and clean-machine setups need their own validation. This repository makes no measured claim of a specific bug-reduction rate.

## Contribute and report issues

Start with [community operations](docs/COMMUNITY.md), covering project binding, XSpec intake, supervised work, QA recovery, memory, and material preparation. For integration, see [X Suite](https://github.com/NUVANU/X-Suite).

When [reporting a problem](https://github.com/NUVANU/XDev/issues), include the version/commit, host/runtime, minimal steps, expected behavior, and redacted error/receipt details. Do not upload private source, memory databases, credentials, or personal conversation logs.

## License

[Mozilla Public License 2.0](LICENSE). Third-party components retain their own licenses.
