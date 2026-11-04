import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { JobStore, canonical, productionJobRoot } from "../job-runtime/store.ts";
import { parseD1UniqueJson, type JobId } from "../job-runtime/contracts.ts";
import { readVerifiedD1Init, sha256 } from "../project-model/init-receipt.ts";
import { assertD1LocalControl, d1ControlRoot, withD1LocalControlLock } from "../host-surface/d1-local-control.ts";
import { checkFirstSourceAge, deriveD1IntakeInput, readProfile, type D1IntakeRequest } from "../host-surface/d1-intake-source.ts";
import { decideD1Profile, type D1Profile, type D1ProfileRequest } from "../host-surface/d1-profile-entry.ts";
import type { JobQueryArgs } from "./xdev.ts";

type Init = ReturnType<typeof readVerifiedD1Init>;
type Local = ReturnType<typeof assertD1LocalControl>;
type Intent = {
  goal: string; purpose: D1ProfileRequest["purpose"]; impact: D1ProfileRequest["impact"];
  facts: Omit<D1ProfileRequest["facts"], "evidence_refs">;
  risk_categories: string[]; risk_reason: string; complexity: D1ProfileRequest["complexity"];
  requested_profile?: D1Profile; legacy_flow_difference_reason: string | null;
};
const BOOLEAN_FLAGS = ["fake-data-only", "production-permissions", "external-effects", "reversible",
  "cross-module", "interface-change", "untested-path"];
const INTAKE_FLAGS = ["goal", "purpose", "impact", "risk-reason", "complexity-reason", "risk-category",
  "profile", "legacy-flow-difference-reason", "workspace-root", ...BOOLEAN_FLAGS];
function need(ok: unknown, code: string): asserts ok { if (!ok) throw Error(code); }

/** Internal coordinator interface: missing facts are never boolean defaults. */
function flags(args: string[], allowed: string[]) {
  need(Array.isArray(args) && args.length <= 512 && args.every(v => typeof v === "string") &&
    args.reduce((n, v) => n + v.length, 0) <= 65536 && args.length % 2 === 0, "D1_TASK_ARGUMENT_INVALID");
  const values = new Map<string, string>(), risks: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    need(key.startsWith("--") && allowed.includes(key.slice(2)) && !!value?.trim() &&
      value.length <= 8192 && !value.startsWith("--"), "D1_TASK_ARGUMENT_INVALID");
    if (key === "--risk-category") risks.push(value);
    else { need(!values.has(key), "D1_TASK_ARGUMENT_DUPLICATE"); values.set(key, value); }
  }
  need(risks.length <= 8 && new Set(risks).size === risks.length, "D1_TASK_RISK_CATEGORY_INVALID");
  return { values, risks };
}
function intent(values: Map<string, string>, risks: string[]): Intent {
  const text = (key: string) => { const v = values.get(`--${key}`); need(v, "D1_TASK_REQUIRED_FACT_MISSING"); return v; };
  const boolean = (key: string) => { const v = text(key); need(v === "true" || v === "false", "D1_TASK_BOOLEAN_INVALID"); return v === "true"; };
  need(risks.length > 0, "D1_TASK_REQUIRED_FACT_MISSING");
  const purpose = text("purpose"), impact = text("impact"), profile = values.get("--profile");
  need(["explore", "formal_change", "formal_release"].includes(purpose) &&
    ["isolated_fake_data", "ordinary", "real_high_impact", "unknown"].includes(impact) &&
    (!profile || ["prototype", "quick_verified", "full_governance"].includes(profile)), "D1_TASK_ARGUMENT_INVALID");
  return { goal: text("goal"), purpose: purpose as Intent["purpose"], impact: impact as Intent["impact"],
    facts: { fake_data_only: boolean("fake-data-only"), production_permissions: boolean("production-permissions"),
      external_effects: boolean("external-effects"), reversible: boolean("reversible") },
    risk_categories: risks, risk_reason: text("risk-reason"),
    complexity: { cross_module: boolean("cross-module"), interface_change: boolean("interface-change"),
      untested_path: boolean("untested-path"), reason: text("complexity-reason") },
    ...(profile ? { requested_profile: profile as D1Profile } : {}),
    legacy_flow_difference_reason: values.get("--legacy-flow-difference-reason") ?? null };
}
function declaration(r: D1ProfileRequest) {
  const { fake_data_only, production_permissions, external_effects, reversible } = r.facts;
  return { format: "xdev-d1-profile-evidence-1", kind: "COORDINATOR_RECORDED", goal: r.goal,
    purpose: r.purpose, impact: r.impact, declaration_status: "CALLER_DECLARED_UNVERIFIED",
    owner_approval: "UNVERIFIED", host_receipt_authenticated: false,
    declaration: { facts: { fake_data_only, production_permissions, external_effects, reversible },
      risk_categories: r.risk_categories, risk_reason: r.risk_reason, complexity: r.complexity,
      requested_profile: r.requested_profile, legacy_flow_difference_reason: r.legacy_flow_difference_reason } };
}
function build(input: Intent, init: Init, requestId: string) {
  const make = (selected: D1Profile) => {
    const profile: D1ProfileRequest = { format: "xdev-d1-profile-request-1", request_id: requestId,
      project_id: init.receipt.project_id, receipt_sha256: init.receipt_sha256,
      goal: input.goal, purpose: input.purpose, impact: input.impact, requested_profile: selected,
      purpose_source: { kind: "COORDINATOR_RECORDED", source_ref: "", source_sha256: "" },
      facts: { ...input.facts, evidence_refs: [] }, risk_categories: input.risk_categories,
      risk_reason: input.risk_reason, complexity: input.complexity,
      legacy_flow_difference_reason: input.legacy_flow_difference_reason };
    const evidenceBytes = canonical(declaration(profile)) + "\n", digest = sha256(evidenceBytes);
    const ref = `profile-evidence/${digest}.json`;
    profile.purpose_source = { kind: "COORDINATOR_RECORDED", source_ref: ref, source_sha256: digest };
    profile.facts.evidence_refs = [{ path: ref, sha256: digest }];
    const bytes = canonical(profile) + "\n";
    const decision = decideD1Profile(profile, sha256(bytes), init.receipt_sha256, init.receipt.project_id,
      init.bundle.project_state.flow.type, init.bundle.tasks.flatMap(t => t.acceptance_criteria));
    return { profile, bytes, evidenceBytes, decision };
  };
  const selected = input.requested_profile ?? make("full_governance").decision.minimum_profile;
  return make(selected);
}
function unchanged(root: string, init: Init) {
  const now = readVerifiedD1Init(root);
  need(now.receipt_sha256 === init.receipt_sha256 && canonical(now.bundle) === canonical(init.bundle), "D1_TASK_SOURCE_CHANGED_STOP");
}
function subject(root: string, local: Local, requestId: string): D1IntakeRequest {
  return { workspaceRoot: root, controlRoot: local.root, projectId: local.init.receipt.project_id,
    requestId, profileFile: join(local.root, "profile-request.json") };
}
function complete(root: string, local: Local) {
  need(local.snapshot, "D1_TASK_PARTIAL_INTAKE_STOP");
  const request = subject(root, local, local.snapshot.request_id);
  const source = readProfile(request, local.init.receipt_sha256, local.init.bundle);
  const profile = parseD1UniqueJson(source.bytes) as D1ProfileRequest;
  const expected = canonical(declaration(profile)) + "\n", digest = sha256(expected);
  need(profile.purpose_source.source_ref === `profile-evidence/${digest}.json` &&
    profile.purpose_source.source_sha256 === digest &&
    canonical(profile.facts.evidence_refs) === canonical([{ path: profile.purpose_source.source_ref, sha256: digest }]) &&
    readFileSync(join(local.root, ...profile.purpose_source.source_ref.split("/")), "utf8") === expected,
    "D1_TASK_DECLARATION_NOT_COLLECTED_STOP");
  const store = new JobStore(local.jobRoot, { project_id: request.projectId, workspace_root: root });
  const journal = store.inspectD1Journal(`job:${request.requestId}` as JobId);
  need(canonical(journal.job.d1_intake?.profile) === canonical(source.decision), "D1_PROFILE_DECISION_DRIFT");
  return { request, source, profile, journal };
}
function view(init: Init, profile: D1ProfileRequest) {
  return { scope: "LOCAL_REGISTRATION_AND_QUERY_ONLY" as const,
    caller_facts: "CALLER_DECLARED_UNVERIFIED" as const, role_execution: "UNAVAILABLE" as const,
    production_quality: "HOST_OBSERVER_UNAVAILABLE" as const, xmem_adapter: "UNAVAILABLE_NOT_CALLED" as const,
    execution_permitted: false as const, declared_goal: profile.goal,
    goal_contract_relation: "UNVERIFIED" as const, new_contract_supported: false as const,
    approved_tasks: init.bundle.tasks.map(t => ({ task_key: t.task_id, objective: t.objective,
      contract_ref: { id: `.xdev/tasks/${t.task_id}.json`,
        sha256: init.receipt.artifact_files.find(f => f.path === `tasks/${t.task_id}.json`)!.sha256 } })),
    init_receipt: { id: ".xdev/d1-init-receipt.json", sha256: init.receipt_sha256 } };
}
export type PreparedD1Task =
  | { operation: "intake"; intake: D1IntakeRequest; task_entry: ReturnType<typeof view> }
  | { operation: "query"; query: JobQueryArgs; task_entry: ReturnType<typeof view> };

/** No dispatch/quality/XMem port is reachable. This adapter stages existing A
 * inputs; the caller invokes the unchanged register/query entry after the lock. */
export function prepareD1TaskEntry(args: string[], cwd: string): PreparedD1Task {
  const [operation, ...rest] = args;
  need(["intake", "status", "result", "inspect-resume"].includes(operation), "D1_TASK_OPERATION_UNSUPPORTED");
  const parsed = flags(rest, operation === "intake" ? INTAKE_FLAGS : ["workspace-root"]);
  const root = parsed.values.get("--workspace-root") ?? cwd;
  need(isAbsolute(root) && resolve(root) === root, "D1_TASK_WORKSPACE_INVALID");
  const initial = readVerifiedD1Init(root), control = d1ControlRoot(root);
  const local = assertD1LocalControl(root, control, initial.receipt.project_id, { allowNoProfile: true });
  if (operation !== "intake") {
    const fixed = complete(root, local); unchanged(root, local.init);
    return { operation: "query", query: { operation: operation as JobQueryArgs["operation"],
      jobId: `job:${fixed.request.requestId}` as JobId, controlRoot: control, projectId: initial.receipt.project_id,
      workspaceRoot: root, ...(operation === "inspect-resume" ? { expectedRevision: fixed.journal.revision } : {}) },
      task_entry: view(local.init, fixed.profile) };
  }
  const input = intent(parsed.values, parsed.risks);
  return withD1LocalControlLock<PreparedD1Task>(root, control, initial.receipt.project_id, () => {
    const current = assertD1LocalControl(root, control, initial.receipt.project_id, { allowLock: true, allowNoProfile: true });
    unchanged(root, initial);
    if (current.snapshot) {
      const fixed = complete(root, current), proposed = build(input, current.init, fixed.request.requestId);
      need(proposed.bytes === fixed.source.bytes, "D1_TASK_INPUT_CONFLICT_STOP");
      unchanged(root, current.init);
      return { operation: "intake", intake: fixed.request, task_entry: view(current.init, fixed.profile) };
    }
    need(canonical(readdirSync(control).sort()) === canonical(["binding.json", "pending-init.json", "project.lock"].sort()),
      "D1_TASK_PARTIAL_INTAKE_STOP");
    const prepared = build(input, current.init, randomUUID()), request = subject(root, current, prepared.profile.request_id);
    checkFirstSourceAge(current.init.receipt.created_at);
    const create = deriveD1IntakeInput(request, current.init, prepared.decision);
    new JobStore(productionJobRoot(control, request.projectId), { project_id: request.projectId, workspace_root: root })
      .prepareIntakeJob(request.requestId, `job:${request.requestId}` as JobId, create);
    unchanged(root, current.init);
    const writeOnce = (path: string, bytes: string) => {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    };
    need(!existsSync(join(control, "profile-evidence")) && !existsSync(request.profileFile!), "D1_TASK_PARTIAL_INTAKE_STOP");
    mkdirSync(join(control, "profile-evidence"), { mode: 0o700 });
    assertD1LocalControl(root, control, request.projectId, { allowLock: true, allowNoProfile: true });
    unchanged(root, current.init);
    writeOnce(join(control, ...prepared.profile.purpose_source.source_ref.split("/")), prepared.evidenceBytes);
    assertD1LocalControl(root, control, request.projectId, { allowLock: true, allowNoProfile: true });
    unchanged(root, current.init);
    writeOnce(request.profileFile!, prepared.bytes);
    readProfile(request, current.init.receipt_sha256, current.init.bundle);
    return { operation: "intake", intake: request, task_entry: view(current.init, prepared.profile) };
  });
}
