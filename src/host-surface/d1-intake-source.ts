import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { canonical } from "../job-runtime/storage-identity.ts";
import { parseD1UniqueJson } from "../job-runtime/contracts.ts";
import type { CreateJobInput, EvidenceRef, WorkspaceRef } from "../job-runtime/contracts.ts";
import { readVerifiedD1Init, sha256 } from "../project-model/init-receipt.ts";
import { decideD1Profile, type D1ProfileRequest } from "./d1-profile-entry.ts";

export type D1IntakeRequest = {
  requestId: string;
  controlRoot: string;
  projectId: string;
  workspaceRoot: string;
  profileFile?: string;
};

function check(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
const ref = (id: string, bytes: string): EvidenceRef => ({ id, sha256: sha256(bytes) });
const FIRST_SOURCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export function checkFirstSourceAge(createdAt: string) {
  const created = Date.parse(createdAt), now = Date.now();
  check(Number.isFinite(created) && new Date(created).toISOString() === createdAt, "D1_INTAKE_SOURCE_TIME_INVALID");
  check(created <= now, "D1_INTAKE_SOURCE_FUTURE");
  check(now - created <= FIRST_SOURCE_MAX_AGE_MS, "D1_INTAKE_SOURCE_EXPIRED");
}

function checkedScope(value: string): string {
  check(typeof value === "string" && value.length > 0 && !value.includes("\\") && !/^[A-Za-z]:/.test(value)
    && !/[\x00-\x1f<>:"|?*]/.test(value), "D1_SCOPE_INVALID");
  const path = value.endsWith("/") ? value.slice(0, -1) : value;
  check(path.length > 0 && path.split("/").every(segment => segment && segment !== "." && segment !== ".."
    && !/[. ]$/.test(segment) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment)), "D1_SCOPE_INVALID");
  return path.toLowerCase();
}

function acyclic(tasks: Array<{ task_id: string; dependencies: string[] }>): void {
  const byId = new Map(tasks.map(task => [task.task_id, task]));
  check(byId.size === tasks.length, "D1_TASK_DUPLICATE");
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string): void => {
    check(!visiting.has(id), "D1_DEPENDENCY_CYCLE");
    if (visited.has(id)) return;
    const task = byId.get(id); check(task, "D1_DEPENDENCY_MISSING");
    visiting.add(id);
    check(new Set(task.dependencies).size === task.dependencies.length && !task.dependencies.includes(id), "D1_DEPENDENCY_INVALID");
    for (const dependency of task.dependencies) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const task of tasks) visit(task.task_id);
}

/** Read the fixed or candidate profile and all its evidence. This function performs I/O. */
export function readProfile(request: D1IntakeRequest, receiptSha: string,
  bundle: ReturnType<typeof readVerifiedD1Init>["bundle"]) {
  const path = request.profileFile;
  check(!!path && isAbsolute(path) && resolve(path) === path, "D1_PROFILE_REQUEST_PATH_INVALID");
  const stat = lstatSync(path);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 1024 * 1024 &&
    realpathSync.native(path) === path, "D1_PROFILE_REQUEST_INVALID");
  const bytes = readFileSync(path, "utf8"), raw = parseD1UniqueJson(bytes);
  check(canonical(raw) + "\n" === bytes, "D1_PROFILE_REQUEST_NONCANONICAL");
  const profile = raw as D1ProfileRequest;
  const decision = decideD1Profile(raw, sha256(bytes), receiptSha, request.projectId,
    bundle.project_state.flow.type, bundle.tasks.flatMap(task => task.acceptance_criteria));
  check(profile.request_id === request.requestId, "D1_PROFILE_REQUEST_ID_MISMATCH");
  const evidence = [profile.purpose_source, ...profile.facts.evidence_refs.map(ref => ({ source_ref: ref.path, source_sha256: ref.sha256 }))];
  const expectedEvidence = [...new Set(evidence.map(ref => ref.source_ref.split("/")[1]))].sort();
  check(canonical(readdirSync(join(request.controlRoot, "profile-evidence")).sort()) === canonical(expectedEvidence),
    "D1_PROFILE_EVIDENCE_MANIFEST_DRIFT");
  for (const ref of evidence) {
    check(/^profile-evidence\/[0-9a-f]{64}\.json$/.test(ref.source_ref), "D1_PROFILE_EVIDENCE_PATH_INVALID");
    check(ref.source_ref === `profile-evidence/${ref.source_sha256}.json`, "D1_PROFILE_EVIDENCE_NAME_DRIFT");
    const source = join(request.controlRoot, ...ref.source_ref.split("/")), entry = lstatSync(source);
    check(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1 && entry.size <= 1024 * 1024 &&
      realpathSync.native(source) === source, "D1_PROFILE_EVIDENCE_INVALID");
    const content = readFileSync(source, "utf8"), value = parseD1UniqueJson(content);
    check(canonical(value) + "\n" === content && sha256(content) === ref.source_sha256, "D1_PROFILE_EVIDENCE_DRIFT");
    if (ref.source_ref === profile.purpose_source.source_ref) {
      check(value && typeof value === "object" && !Array.isArray(value) &&
        (value as Record<string, unknown>).format === "xdev-d1-profile-evidence-1" &&
        (value as Record<string, unknown>).kind === "COORDINATOR_RECORDED" &&
        (value as Record<string, unknown>).goal === profile.goal &&
        (value as Record<string, unknown>).purpose === profile.purpose &&
        (value as Record<string, unknown>).impact === profile.impact,
        "D1_PROFILE_PURPOSE_SOURCE_MISMATCH");
    }
  }
  return { decision, bytes };
}

/** Deterministic derivation from already verified immutable 0.1 data. No filesystem I/O. */
export function deriveD1IntakeInput(request: D1IntakeRequest,
  verified: Pick<ReturnType<typeof readVerifiedD1Init>, "receipt" | "receipt_sha256" | "bundle">,
  decision: ReturnType<typeof readProfile>["decision"]): CreateJobInput {
  const { receipt, receipt_sha256, bundle } = verified;
  check(receipt.project_id === request.projectId && bundle.project_state.project_id === request.projectId, "D1_PROJECT_DRIFT");
  check(bundle.project_state.owner_gate_ids.length === bundle.owner_gates.length, "D1_OWNER_GATE_DRIFT");
  check(bundle.owner_gates.every(gate => ["approved", "resolved"].includes(gate.status) && !!gate.decision_ref && !!gate.resolved_at), "D1_OWNER_GATE_PENDING");
  acyclic(bundle.tasks);
  const receiptId = `.xdev/${receipt.format}:${receipt_sha256}`;
  const unavailable = (kind: string) => ref(`D1_EXECUTION_NOT_ADMITTED:${kind}:${receipt_sha256}`, kind);
  const controls = { budget_ref: unavailable("budget"), control_ref: unavailable("control"), allocation_ref: unavailable("allocation") };
  const tasks: CreateJobInput["tasks"] = bundle.tasks.map(task => {
    check(["BACKLOG", "PLANNED", "READINESS_CHECK", "READY"].includes(task.state), "D1_TASK_HAS_PRIOR_PROGRESS");
    const allowed = task.allowed_scope.map(checkedScope), forbidden = task.forbidden_scope.map(checkedScope);
    check(new Set(allowed).size === allowed.length && new Set(forbidden).size === forbidden.length
      && !allowed.some(scope => forbidden.some(other => scope === other || scope.startsWith(other + "/") || other.startsWith(scope + "/"))), "D1_SCOPE_CONFLICT");
    const workspace: WorkspaceRef = {
      workspace_id: receipt.root_identity, repository_id: receipt.root_identity,
      base_revision: "D1_INIT_NO_EXECUTION_HEAD", branch_ref: null, worktree_ref: request.workspaceRoot, observed_head: null,
      allowed_scope_ref: ref(`${receiptId}:task:${task.task_id}:allowed_scope`, canonical(task.allowed_scope)),
      forbidden_scope_ref: ref(`${receiptId}:task:${task.task_id}:forbidden_scope`, canonical(task.forbidden_scope)),
      mutability: task.allowed_scope.length ? "MUTABLE" : "READ_ONLY",
    };
    const verification_required = [...new Set([
      ...task.acceptance_criteria.map(id => `criterion:${id}`),
      ...task.required_tests.map(item => `test:${item}`),
      ...task.required_evidence.map(item => `evidence:${item}`),
      ...decision.gates.map(gate => gate.requirement),
    ])];
    return { key: task.task_id,
      contract_ref: { id: `.xdev/tasks/${task.task_id}.json`, sha256: receipt.artifact_files.find(file => file.path === `tasks/${task.task_id}.json`)!.sha256 },
      dependency_keys: task.dependencies, workspace, verification_required, control_refs: controls };
  });
  const intakeBinding = ref(`D1_INTAKE_REQUEST:${request.requestId}`, canonical({ receipt_sha256, project_id: request.projectId,
    workspace_root: request.workspaceRoot, root_identity: receipt.root_identity, tasks }));
  return { tasks, control_refs: controls, handoff_refs: [intakeBinding], context_pack_refs: [], d1_profile: decision };
}
