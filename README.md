# XDev

**Make “done” an inspectable claim.**

A lightweight engineering governance layer for AI-assisted development: keep the host's coding workflow, add scope checks, delivery evidence, and bounded recovery.

**English** · [简体中文](https://github.com/NUVANU/XDev/blob/main/README.zh-CN.md)

[Get started](https://github.com/NUVANU/X-Suite/blob/main/INSTALL.md) · [Community workflow](docs/COMMUNITY.md) · [X Suite](https://github.com/NUVANU/X-Suite)

Your agent says the feature is finished. But did it implement the agreed behavior? Was the actual candidate reviewed? Did QA run against those files? If a session disconnected, is there already a result worth recovering?

**XDev connects delivery claims to the project, candidate, and evidence behind them.** The host still searches, designs, writes code, runs tools, and coordinates agents. XDev adds checks at task entry, material changes or interruptions, and delivery.

## Why use it?

| What goes wrong during AI development | What XDev adds |
| --- | --- |
| A plausible file comes from another project or an older specification | Explicit project, source, version, and content bindings |
| “Helpful” additions quietly expand the scope | Approved boundaries and conformance checks during Review |
| Author self-tests become “independent QA” in the final message | Separate implementation, non-author Review, and actual QA evidence |
| The reviewed files differ from the delivered files | Candidate-bound stage records and delivery judgment |
| An interruption triggers duplicate execution | Read-only diagnosis, original-result reconciliation, and bounded recovery |
| Every small file operation becomes a development ceremony | Operation routing: ordinary reversible work uses proportionate checks |

Useful for maintained products, multi-session development, and agent handoffs where a convincing final message is insufficient evidence.

## What's new in 0.1.4

This update adds bounded continuation within the existing host workflow and authorization.

- **Continue after a stage finishes.** Check the overall goal and remaining acceptance criteria, then take an authorized, unblocked next step without asking for another generic “continue”. Each role still submits its own natural final and original receipts.
- **Keep Job status in scope.** A completed Job is not completion of the whole goal. Runtime automation flags describe XDev itself; they neither revoke existing authority nor grant new authority to the host.
- **Handle blockers with limits.** Preserve the original evidence, dependencies, attempts, and consumption. Reconcile UNKNOWN under the original identity; stop affected paths while handling genuinely independent, authorized work. Existing deadlines and stricter correction limits still apply.

See [bounded continuation](docs/R4-BOUNDED-CONTINUATION.zh.md). The Stop hook is a reminder, not a scheduler or background wakeup service.

### Retained governance capabilities

- **One default contract for new formal Node tasks.** Request v5 has no three-tier profile selector. Legacy v1–v4 contracts and existing Jobs retain their original meaning.
- **Shallow integration.** Let the host develop normally; inspect entry, changes/interruption, and delivery rather than approve every file edit.
- **Operation routing.** Ordinary supported, reversible operations do not automatically need a product Job, MCP binding, or product Review/QA. Product behavior/protocol changes retain independent checks. Concrete high risks add proportionate checks.
- **Recovery with limits.** Distinguish missing QA, unresolved claims, reusable original results, and cases needing new verification. UNKNOWN remains UNKNOWN; history and consumed attempts stay visible.
- **Use configured native XMem.** Discover and bind the actual task, retrieve applicable history, and save/read back key public findings. Memory is optional when unavailable; it never grants authority.

These routing rules are **host/skill policy**. They do not add an OS sandbox, a cross-card code lock, or an automatic agent scheduler. See [operation routing](docs/R4-OPERATION-ROUTING.zh.md) and [shallow integration](docs/R4-SHALLOW-INTEGRATION.zh.md).

## The development workflow

```text
Confirmed goal and current project
              ↓
Necessary preparation / preflight
              ↓
Host implementation → Non-author Review → Actual QA
              ↓
Candidate-bound result and delivery decision
```

New formal tasks use the [unified contract](docs/R4-UNIFIED-CONTRACT.zh.md). The coordinator prepares supported structured inputs from confirmed facts; users do not need to write UUIDs or JSON. A parsed request, a receipt, or READY status alone does not grant permission to develop.

If execution is interrupted, inspect the original Job and records first. Recover a same-candidate original result only through its applicable authorization and supported path. Do not erase a lock, refund a consumed attempt, or create a renamed Job to escape an unknown outcome. See [QA recovery](docs/QA-RECOVERY.zh.md).

## Quick start

**Public source: 0.1.4 · MPL-2.0 · Windows/Codex is the validated local path.** Source provenance and packaging differences are listed in [this update note](docs/PUBLIC-UPDATE-20261117.md).

Use Node.js **24.20.0**, pnpm **11.25.0**, and npm **11.19.0** for the documented local path:

```powershell
# In a clean XDev checkout
pnpm.cmd install --frozen-lockfile --ignore-scripts
npm.cmd --prefix mcp ci --ignore-scripts
npm.cmd run typecheck

# Install the included Skills and UNBOUND MCP entry in Codex
codex plugin marketplace add . --json
codex plugin add xdev@xdev-community-local --json

# Print concrete connection parameters for this checkout
node --experimental-strip-types mcp/configure.ts --host codex
```

Keep the source checkout in place. The local marketplace installs Skills and the default MCP entry; `configure.ts` prints parameters for manual or other-host setup without registering them. Avoid registering a second XDev server alongside the plugin. A server started without project configuration exposes **UNBOUND context only**; it does not choose the current directory as your project or create a Job.

For project setup and native XMem, follow the [X Suite installation guide](https://github.com/NUVANU/X-Suite/blob/main/INSTALL.md) and [local MCP guide](docs/LOCAL-MCP.zh.md). Setup, task permission, and actual host loading are separate checks.

Example request after setup:

```text
Use the host's normal coding workflow for this confirmed task.
Apply XDev at entry, relevant changes or interruptions, and delivery.
Keep the scope, candidate, non-author Review, and actual QA traceable.
Use already configured XMem for applicable history; preserve unknowns.
Report what was delivered and which evidence is still missing.
```

## Technical foundations

| Mechanism | Purpose |
| --- | --- |
| MCP, Skills, and source CLI over the existing core | Structured checks without replacing the host runtime |
| Versioned contracts, FileRefs, hashes, and candidate manifests | Bind scope and evidence to the actual project and bytes |
| Persisted Jobs, claims, and quality records | Keep implementation, Review, execution, and delivery distinguishable |
| Supported Node QA runner | Retain actual frozen-command execution receipts |
| Read-only diagnosis and idempotent result handling | Reconcile interruption before further execution |
| PowerShell preparation tools | Reuse bounded material checks instead of inventing duplicate validators |
| Native XMem use and optional legacy adapter | Retrieve engineering evidence under explicit project/task policy |

The optional legacy XMem bridge accepts specific qualified runtime builds and storage modes. **XMem 0.1.2 is not automatically qualified for that bridge.** Prefer the host's native XMem connection for this update. Do not edit an allowlist merely to force a new build through.

## Who owns what?

- **Host/model:** search, design, coding, debugging, scheduling, sessions, permissions, and lifecycle.
- **XDev:** task/scope bindings, delivery judgment, evidence checks, and bounded recovery.
- **XMem:** persistent history, revisions, source references, and retrieval.
- **XMi:** optional clarification and owner-confirmed specification.

Hashes establish content consistency, not the truth of a conclusion or authenticated human approval. XDev does not intercept every shell operation or prove that a model followed every instruction.

## Validation and limits

The new continuation changes passed independent source/method Review and **35/35 scoped projection/hook checks**, with a successful typecheck. Host-policy decisions, local installation, fresh loading, and real business continuation are separate evidence. Full Job/MCP integration retains unpassed cases: the candidate and prior source both produced **11/17** in the recorded environment. See the [validation scope and retained failures](docs/PUBLIC-UPDATE-20261117.md).

The supported MCP QA runner retains its exact Node **24.19.0 / 24.20.0**, single frozen command, and **90-second maximum** boundary. Browser/UI, game engines, other hosts, unattended operation, clean-machine installation, and long-term savings require their own evidence. The source update does not establish a measured bug-reduction or token-saving percentage.

## Contribute

Start with the [community workflow](docs/COMMUNITY.md). For [issues](https://github.com/NUVANU/XDev/issues), include version/commit, host/runtime, a small reproduction, and redacted error/receipt details. Keep private code, databases, credentials, and personal conversations out of public issues.

## License

[Mozilla Public License 2.0](LICENSE). Third-party dependencies retain their own licenses.
