import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { Graph, alg } from "@dagrejs/graphlib";
import type { ValidationResult } from "../project-model/validate.ts";
import { readVersionedProjectModel } from "../project-model/versioned-reader.ts";
import { validateExecutionDeliveryArtifact as validateDeliveryArtifact, validatePlanningArtifact } from "./validate.ts";
import { validateDeliveryArtifact as validateLegacyDeliveryArtifact } from "./legacy-validate.ts";
import type {
  CheckpointPolicy,
  CheckpointPolicyFacts,
  CheckpointResult,
  ClosureManifest,
  CriticalBoundary,
  EvidenceHashEntry,
  EvidenceSnapshot,
  FailureFingerprint,
  PathHashEntry,
  RetryBudget,
  SpecHashEntry,
  WriteLease,
} from "./types.ts";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type Result<T> = ValidationResult<T>;
const sha256Pattern = /^[0-9a-f]{64}$/;

function valid<T>(value: T): Result<T> { return { valid: true, value, errors: [] }; }
function invalid<T>(...errors: string[]): Result<T> { return { valid: false, errors }; }
function compareUtf8(left: string, right: string): number { return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")); }
function sorted(values: Iterable<string>): string[] { return [...new Set(values)].sort(compareUtf8); }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

/** RFC 8785-compatible for the JSON values used by the V0 contract records. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON rejects non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, JsonValue>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(",")}}`;
}

function canonicalRepoPath(value: string): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes("\\") || value.includes("\0")) return null;
  if (/^[A-Za-z]:/.test(value) || value.startsWith("/") || value.startsWith("./") || value.endsWith("/") || value.includes("//")) return null;
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
  // Canonical repository paths must not hide Windows aliases or alternate streams.
  if (segments.some((segment) => /[. ]$/.test(segment) || /[<>:"|?*\u0000-\u001f]/.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) return null;
  return value;
}

function canonicalArtifactRef(value: string): string | null {
  if (typeof value !== "string") return null;
  const firstHash = value.indexOf("#");
  if (firstHash === -1) return canonicalRepoPath(value);
  if (value.indexOf("#", firstHash + 1) !== -1) return null;
  const path = canonicalRepoPath(value.slice(0, firstHash));
  const fragment = value.slice(firstHash + 1);
  return path && fragment.length > 0 ? `${path}#${fragment}` : null;
}

function artifactPath(ref: string): string { return ref.split("#", 1)[0]!; }
function foldedPath(path: string): string { return path.toLocaleLowerCase("en-US"); }

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalStringSet(values: readonly string[], normalize: (value: string) => string | null): string[] | null {
  const output: string[] = [];
  for (const value of values) {
    const canonical = normalize(value);
    if (!canonical) return null;
    output.push(canonical);
  }
  return sorted(output);
}

function hasCaseFoldCollision(values: readonly string[]): boolean {
  const seen = new Map<string, string>();
  for (const value of values) {
    const folded = value.toLocaleLowerCase("en-US");
    const previous = seen.get(folded);
    if (previous && previous !== value) return true;
    seen.set(folded, value);
  }
  return false;
}

function normaliseSpecManifest(entries: readonly SpecHashEntry[]): Result<SpecHashEntry[]> {
  const byRef = new Map<string, SpecHashEntry>();
  for (const entry of entries) {
    const canonical_ref = canonicalArtifactRef(entry.canonical_ref);
    if (!canonical_ref || !sha256Pattern.test(entry.sha256)) return invalid("spec_manifest: contains an invalid canonical ref or SHA-256.");
    const candidate = { canonical_ref, sha256: entry.sha256 };
    const previous = byRef.get(canonical_ref);
    if (previous && previous.sha256 !== candidate.sha256) return invalid("spec_manifest: conflicting entries share one canonical ref.");
    byRef.set(canonical_ref, candidate);
  }
  if (hasCaseFoldCollision([...byRef.keys()])) return invalid("spec_manifest: case-folded path aliases fail closed.");
  return valid([...byRef.values()].sort((left, right) => compareUtf8(left.canonical_ref, right.canonical_ref)));
}

function normalisePathManifest(entries: readonly PathHashEntry[]): Result<PathHashEntry[]> {
  const byPath = new Map<string, PathHashEntry>();
  for (const entry of entries) {
    const canonical_repo_relative_path = canonicalRepoPath(entry.canonical_repo_relative_path);
    if (!canonical_repo_relative_path || !sha256Pattern.test(entry.sha256) || !/^[0-7]{6}$/.test(entry.git_mode)) return invalid("path_hash_manifest: contains an invalid path, mode, or SHA-256.");
    const modes = { regular_file: ["100644", "100755"], symlink: ["120000"], gitlink: ["160000"] };
    if (!Object.hasOwn(modes, entry.kind) || !modes[entry.kind].includes(entry.git_mode)) return invalid("path_hash_manifest: kind and Git mode must describe the same supported input classification.");
    const candidate = { ...entry, canonical_repo_relative_path };
    const previous = byPath.get(canonical_repo_relative_path);
    if (previous && (previous.kind !== candidate.kind || previous.git_mode !== candidate.git_mode || previous.sha256 !== candidate.sha256)) return invalid("path_hash_manifest: conflicting entries share one canonical path.");
    byPath.set(canonical_repo_relative_path, candidate);
  }
  if (hasCaseFoldCollision([...byPath.keys()])) return invalid("path_hash_manifest: case-folded path aliases fail closed.");
  return valid([...byPath.values()].sort((left, right) => compareUtf8(left.canonical_repo_relative_path, right.canonical_repo_relative_path)));
}

function normaliseEvidenceManifest(entries: readonly EvidenceHashEntry[]): Result<EvidenceHashEntry[]> {
  const byKey = new Map<string, EvidenceHashEntry>();
  const byId = new Map<string, EvidenceHashEntry>();
  const byPath = new Map<string, EvidenceHashEntry>();
  const refs: string[] = [];
  for (const entry of entries) {
    const canonical_ref = canonicalArtifactRef(entry.canonical_ref);
    if (!canonical_ref || !sha256Pattern.test(entry.sha256) || !/^EVID-[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(entry.evidence_id)) return invalid("evidence_manifest: contains an invalid entry.");
    const candidate = { ...entry, canonical_ref };
    const previousId = byId.get(candidate.evidence_id);
    const previousPath = byPath.get(foldedPath(artifactPath(canonical_ref)));
    for (const previous of [previousId, previousPath]) {
      if (previous && (previous.evidence_id !== candidate.evidence_id || previous.canonical_ref !== candidate.canonical_ref || previous.sha256 !== candidate.sha256)) return invalid("evidence_manifest: evidence id and canonical file reference must identify one consistent entry.");
    }
    const key = `${candidate.evidence_id}\u0000${candidate.canonical_ref}`;
    const previous = byKey.get(key);
    if (previous && previous.sha256 !== candidate.sha256) return invalid("evidence_manifest: conflicting entries share one canonical key.");
    byKey.set(key, candidate);
    byId.set(candidate.evidence_id, candidate);
    byPath.set(foldedPath(artifactPath(canonical_ref)), candidate);
    refs.push(canonical_ref);
  }
  if (hasCaseFoldCollision(refs)) return invalid("evidence_manifest: case-folded path aliases fail closed.");
  return valid([...byKey.values()].sort((left, right) => compareUtf8(`${left.evidence_id}\u0000${left.canonical_ref}`, `${right.evidence_id}\u0000${right.canonical_ref}`)));
}

type SnapshotCore = Omit<EvidenceSnapshot, "snapshot_id" | "snapshot_digest">;

function normaliseSnapshotCore(value: SnapshotCore): Result<SnapshotCore> {
  const { snapshot_id: _snapshotId, snapshot_digest: _snapshotDigest, ...core } = value as SnapshotCore & Partial<EvidenceSnapshot>;
  if (!sha256Pattern.test(core.index_digest) || (core.repo_head !== null && !/^[0-9a-f]{40,64}$/.test(core.repo_head))) return invalid("EvidenceSnapshot: invalid Git or index digest.");
  const run_ids = canonicalStringSet(core.run_ids, (item) => /^RUN-[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(item) ? item : null);
  const acceptance_criteria_ids = canonicalStringSet(core.acceptance_criteria_ids, (item) => /^AC-[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(item) ? item : null);
  if (!run_ids || !acceptance_criteria_ids || run_ids.length === 0 || !core.repo_root_identity.trim()) return invalid("EvidenceSnapshot: invalid set member or repository-root identity.");
  const spec_manifest = normaliseSpecManifest(core.spec_manifest);
  const path_hash_manifest = normalisePathManifest(core.path_hash_manifest);
  const evidence_manifest = normaliseEvidenceManifest(core.evidence_manifest);
  if (!spec_manifest.valid || !path_hash_manifest.valid || !evidence_manifest.valid) return invalid(...(!spec_manifest.valid ? spec_manifest.errors : []), ...(!path_hash_manifest.valid ? path_hash_manifest.errors : []), ...(!evidence_manifest.valid ? evidence_manifest.errors : []));
  const files = new Map<string, { path: string; sha256: string }>();
  for (const entry of [
    ...spec_manifest.value.map((item) => ({ path: artifactPath(item.canonical_ref), sha256: item.sha256 })),
    ...path_hash_manifest.value.map((item) => ({ path: item.canonical_repo_relative_path, sha256: item.sha256 })),
    ...evidence_manifest.value.map((item) => ({ path: artifactPath(item.canonical_ref), sha256: item.sha256 })),
  ]) {
    const key = foldedPath(entry.path);
    const previous = files.get(key);
    if (previous && (previous.path !== entry.path || previous.sha256 !== entry.sha256)) return invalid("EvidenceSnapshot: manifests contain ambiguous path identity or conflicting complete-file hashes.");
    files.set(key, entry);
  }
  return valid({ ...core, run_ids, acceptance_criteria_ids, spec_manifest: spec_manifest.value, path_hash_manifest: path_hash_manifest.value, evidence_manifest: evidence_manifest.value });
}

export function materializeEvidenceSnapshot(input: Omit<EvidenceSnapshot, "snapshot_id" | "snapshot_digest">): EvidenceSnapshot {
  if (!["GIT_BACKED_EVIDENCE","HOST_ARTIFACT_EVIDENCE"].includes(input.evidence_class)) throw new Error("EXPLICIT_EVIDENCE_CLASS_REQUIRED");
  const normalized = normaliseSnapshotCore(input);
  if (!normalized.valid) throw new Error(normalized.errors.join(" "));
  const snapshot_digest = hash(canonicalJson(normalized.value as JsonValue));
  return { ...normalized.value, snapshot_digest, snapshot_id: `es-v0.1:${snapshot_digest}`, frozen_at: input.frozen_at };
}

export function validateEvidenceSnapshot(value: unknown): Result<EvidenceSnapshot> {
  const structural = validateDeliveryArtifact("evidenceSnapshot", value);
  if (!structural.valid) return structural;
  const snapshot = structural.value;
  const normalized = normaliseSnapshotCore(snapshot);
  if (!normalized.valid) return normalized;
  const digest = hash(canonicalJson(normalized.value as JsonValue));
  if (snapshot.snapshot_digest !== digest || snapshot.snapshot_id !== `es-v0.1:${digest}`) return invalid("EvidenceSnapshot: content, path alias, or identity mismatch is stale/tampered.");
  return valid({ ...normalized.value, snapshot_digest: digest, snapshot_id: `es-v0.1:${digest}`, frozen_at: snapshot.frozen_at });
}

export type SnapshotSupportInput = { path: string; kind: "file" | "directory" };

/**
 * Direct, read-only coverage check against the caller's Git-confirmed root and
 * independently selected command inputs. Directories expand on disk, never from
 * the submitted manifest. Linked inputs need a separate target manifest and are
 * rejected here; this helper does not claim an atomic freeze or execute a Gate.
 */
export function validateEvidenceSnapshotSupportInputs(value: unknown, repoRoot: string, requiredInputs: readonly SnapshotSupportInput[]): Result<EvidenceSnapshot> {
  const snapshot = validateEvidenceSnapshot(value);
  if (!snapshot.valid) return snapshot;
  const root = resolveWorktreeIdentity(repoRoot);
  if (!root.valid || root.value.filesystem_identity !== snapshot.value.repo_root_identity) return invalid("EvidenceSnapshot support inputs: repository physical identity does not match.");
  if (!Array.isArray(requiredInputs) || requiredInputs.length === 0) return invalid("EvidenceSnapshot support inputs: a nonempty independent input selection is required.");
  const entries = new Map(snapshot.value.path_hash_manifest.map((entry) => [entry.canonical_repo_relative_path, entry]));
  const errors: string[] = [];
  const visit = (path: string, expectedKind?: "file" | "directory"): void => {
    if (!canonicalRepoPath(path)) throw new Error("invalid canonical support path");
    // Check ancestors too: lstat of the final file alone can hide a junction.
    const segments = path.split("/");
    for (let length = 1; length <= segments.length; length++) {
      if (lstatSync(join(repoRoot, ...segments.slice(0, length))).isSymbolicLink()) throw new Error("linked support input cannot establish complete target coverage");
    }
    const absolute = join(repoRoot, path);
    const stats = lstatSync(absolute);
    if (expectedKind === "file" && !stats.isFile() || expectedKind === "directory" && !stats.isDirectory()) throw new Error("support input classification does not match the filesystem");
    if (stats.isDirectory()) {
      for (const child of readdirSync(absolute).sort(compareUtf8)) visit(`${path}/${child}`);
    } else if (stats.isFile()) {
      const entry = entries.get(path);
      const digest = createHash("sha256").update(readFileSync(absolute)).digest("hex");
      if (!entry || entry.kind !== "regular_file" || entry.sha256 !== digest) errors.push(`EvidenceSnapshot support inputs: missing, misclassified, or stale input ${path}.`);
    } else throw new Error("unsupported filesystem input classification");
  };
  for (const input of requiredInputs) {
    if (!input || !["file", "directory"].includes(input.kind) || Object.keys(input).some((key) => !["path", "kind"].includes(key))) return invalid("EvidenceSnapshot support inputs: invalid input classification.");
    try { visit(input.path, input.kind); }
    catch { errors.push("EvidenceSnapshot support inputs: missing, invalid, linked, or unreadable required input."); }
  }
  return errors.length ? invalid(...errors) : snapshot;
}

function canonicalPolicy(policy: CheckpointPolicy): Result<Omit<CheckpointPolicy, "policy_digest">> {
  const { policy_digest: _policyDigest, ...core } = policy;
  const consumers = canonicalStringSet(core.derived_consumer_task_ids, (item) => /^M(?:0|[1-9][0-9]*)-T[0-9]{3,}$/.test(item) ? item : null);
  const triggers = canonicalStringSet(core.trigger_reasons, (item) => item.trim() ? item : null);
  if (!consumers || !triggers) return invalid("CheckpointPolicy: invalid consumer or trigger value.");
  const evaluations = new Map<CriticalBoundary, { boundary: CriticalBoundary; derived_consumer_task_ids: string[] }>();
  for (const evaluation of core.critical_boundary_evaluations) {
    const derived_consumer_task_ids = canonicalStringSet(evaluation.derived_consumer_task_ids, (item) => /^M(?:0|[1-9][0-9]*)-T[0-9]{3,}$/.test(item) ? item : null);
    if (!derived_consumer_task_ids || evaluations.has(evaluation.boundary)) return invalid("CheckpointPolicy: invalid or duplicate critical-boundary evaluation.");
    evaluations.set(evaluation.boundary, { boundary: evaluation.boundary, derived_consumer_task_ids });
  }
  return valid({ ...core, derived_consumer_task_ids: consumers, trigger_reasons: triggers, critical_boundary_evaluations: [...evaluations.values()].sort((left, right) => compareUtf8(left.boundary, right.boundary)) });
}

export function materializeCheckpointPolicy(input: Omit<CheckpointPolicy, "policy_digest">): CheckpointPolicy {
  const normalized = canonicalPolicy({ ...input, policy_digest: "" });
  if (!normalized.valid) throw new Error(normalized.errors.join(" "));
  const policy_digest = hash(canonicalJson(normalized.value as JsonValue));
  return { ...normalized.value, policy_digest };
}

function directImplementationConsumers(subjectTaskId: string, facts: CheckpointPolicyFacts): Result<string[]> {
  const tasks = new Map(facts.tasks.map((fact) => [fact.task.task_id, fact]));
  if (!tasks.has(subjectTaskId) || tasks.size !== facts.tasks.length) return invalid("CheckpointPolicy facts: task ids must be unique and include the subject.");
  const nodes = new Map(facts.dag.nodes.map((node) => [node.task_id, node]));
  if (nodes.size !== facts.dag.nodes.length || !sameStringSet(sorted(nodes.keys()), sorted(tasks.keys()))) return invalid("CheckpointPolicy facts: Task and DAG identities must be unique, complete and equal.");
  const graph = new Graph({ directed: true });
  for (const taskId of tasks.keys()) graph.setNode(taskId);
  for (const { task } of tasks.values()) {
    const dependencies = nodes.get(task.task_id)!.depends_on;
    if (!sameStringSet(sorted(task.dependencies), sorted(dependencies))) return invalid("CheckpointPolicy facts: Task and DAG dependencies must agree exactly.");
    for (const dependency of dependencies) {
      if (dependency === task.task_id || !tasks.has(dependency)) return invalid("CheckpointPolicy facts: dependencies must resolve to a different known Task.");
      graph.setEdge(dependency, task.task_id);
    }
  }
  if (!alg.isAcyclic(graph)) return invalid("CheckpointPolicy facts: dependency cycles fail closed.");

  const interfaces = new Map<string, { producers: string[]; consumers: string[] }>();
  for (const { task } of tasks.values()) {
    if (new Set(task.interface_contracts).size !== task.interface_contracts.length) return invalid("CheckpointPolicy facts: duplicate interface backlinks fail closed.");
    for (const ref of task.interface_contracts) {
      const match = ref.match(/^(IF-[A-Z0-9]+(?:-[A-Z0-9]+)+@[0-9]+\.[0-9]+):(producer|consumer)$/);
      if (!match) return invalid("CheckpointPolicy facts: interface backlinks require a typed interface id, version and producer/consumer role.");
      const key = match[1]!;
      const uses = interfaces.get(key) ?? { producers: [], consumers: [] };
      (match[2] === "producer" ? uses.producers : uses.consumers).push(task.task_id);
      interfaces.set(key, uses);
    }
  }
  const consumers = new Set<string>();
  for (const node of nodes.values()) if (node.depends_on.includes(subjectTaskId) && tasks.get(node.task_id)!.task.task_kind === "implementation") consumers.add(node.task_id);
  for (const uses of interfaces.values()) {
    if (uses.producers.length !== 1) return invalid("CheckpointPolicy facts: each interface must resolve to exactly one producer Task.");
    const producer = uses.producers[0]!;
    const downstream = new Set(alg.preorder(graph, [producer]));
    for (const consumer of uses.consumers) {
      if (consumer === producer || !downstream.has(consumer)) return invalid("CheckpointPolicy facts: interface consumers must transitively depend on their producer in the DAG.");
      if (producer === subjectTaskId && tasks.get(consumer)!.task.task_kind === "implementation") consumers.add(consumer);
    }
  }
  return valid(sorted(consumers));
}

function controlTaskIsExemptable(fact: CheckpointPolicyFacts["tasks"][number]): boolean {
  return fact.task.task_kind !== "implementation"
    && fact.task.repository_access === "read_only"
    && fact.task.critical_boundaries.length === 0
    && fact.writable_output_refs.length === 0
    && !fact.task.interface_contracts.some((item) => item.endsWith(":producer"))
    && fact.independent_role;
}

export function validateCheckpointPolicy(value: unknown, facts?: CheckpointPolicyFacts): Result<CheckpointPolicy> {
  const structural = validatePlanningArtifact("checkpointPolicy", value);
  if (!structural.valid) return structural;
  const policy = structural.value;
  const canonical = canonicalPolicy(policy);
  if (!canonical.valid) return canonical;
  const digest = hash(canonicalJson(canonical.value as JsonValue));
  const errors: string[] = [];
  if (policy.policy_digest !== digest) errors.push("CheckpointPolicy.policy_digest: must bind the canonical policy content.");
  if (!facts || !Array.isArray(facts.tasks) || !validatePlanningArtifact("planDag", facts.dag).valid) return invalid(...errors, "CheckpointPolicy: authoritative typed Task/DAG/interface facts are required; a self-reported policy is insufficient.");
  for (const fact of facts.tasks) {
    const task = readVersionedProjectModel("taskContract", fact?.task);
    if (!task.valid || task.schemaVersion !== "0.2" || typeof fact.independent_role !== "boolean" || !Array.isArray(fact.writable_output_refs) || fact.writable_output_refs.some((ref) => !canonicalArtifactRef(ref))) return invalid(...errors, "CheckpointPolicy: authoritative task facts are missing or invalid.");
  }

  const subject = facts.tasks.find((fact) => fact.task.task_id === policy.subject_task_id);
  const consumers = directImplementationConsumers(policy.subject_task_id, facts);
  if (!subject || !consumers.valid) return invalid(...errors, ...(consumers.valid ? ["CheckpointPolicy facts: subject task is missing."] : consumers.errors));
  if (policy.subject_task_kind !== subject.task.task_kind || policy.subject_repository_access !== subject.task.repository_access) errors.push("CheckpointPolicy: subject kind/access must be derived from the Task Contract.");
  if (!sameStringSet(canonical.value.derived_consumer_task_ids, consumers.value)) errors.push("CheckpointPolicy: derived consumers must match DAG/interface facts.");
  const boundarySet = [...new Set(subject.task.critical_boundaries)].sort(compareUtf8) as CriticalBoundary[];
  const evaluationByBoundary = new Map(canonical.value.critical_boundary_evaluations.map((item) => [item.boundary, item.derived_consumer_task_ids]));
  if (!sameStringSet([...evaluationByBoundary.keys()].sort(compareUtf8), boundarySet)) errors.push("CheckpointPolicy: critical-boundary evaluations must match the Task Contract.");
  for (const boundary of boundarySet) if (!sameStringSet(evaluationByBoundary.get(boundary) ?? [], consumers.value)) errors.push(`CheckpointPolicy: ${boundary} consumers must be derived from facts.`);

  const highRiskBoundary = subject.task.risk_level === "high" && boundarySet.length > 0;
  const sharedOutput = consumers.value.length >= 2;
  const requiresCheckpoint = subject.task.task_kind === "implementation" && consumers.value.length > 0 && (highRiskBoundary || sharedOutput);
  const expectedDisposition = requiresCheckpoint ? "required" : controlTaskIsExemptable(subject) ? "exempt_control" : "not_required";
  if (policy.disposition !== expectedDisposition) errors.push(`CheckpointPolicy.disposition: expected ${expectedDisposition} from typed facts.`);
  if (expectedDisposition === "required") {
    const checkpoint = facts.tasks.find((fact) => fact.task.task_id === policy.checkpoint_task_id);
    if (!checkpoint || checkpoint.task.task_id === subject.task.task_id || checkpoint.task.task_kind !== "checkpoint_control" || !controlTaskIsExemptable(checkpoint)) errors.push("CheckpointPolicy.checkpoint_task_id: must identify an independent read-only checkpoint control.");
  }
  return errors.length ? invalid(...errors) : valid({ ...canonical.value, policy_digest: digest });
}

/** Host/state facts supplied independently of the submitted checkpoint result. */
export type CheckpointRunFact = {
  run_id: string;
  task_id: string;
  agent_id: string;
  role_id: string;
};

export type CheckpointResultBindings = {
  policy: CheckpointPolicy;
  policy_facts: CheckpointPolicyFacts;
  snapshot: EvidenceSnapshot;
  current_task_contract_digest: string;
  current_source_decision_id: string;
  current_source_decision_digest: string;
  current_policy_effective_at: string;
  subject_runs: readonly CheckpointRunFact[];
  reviewer_run: CheckpointRunFact & { role_type: "reviewer" | "verifier"; repository_access: "read_only" };
};

export type FreshnessResult = { fresh: boolean; reasons: string[] };

export function checkpointResultFreshness(value: unknown, bindings: CheckpointResultBindings): FreshnessResult {
  const structural = validateDeliveryArtifact("checkpointResult", value);
  if (!structural.valid) return { fresh: false, reasons: structural.errors };
  if (!bindings) return { fresh: false, reasons: ["CheckpointResult: authoritative bindings are required."] };
  const policy = validateCheckpointPolicy(bindings.policy, bindings.policy_facts);
  const snapshot = validateEvidenceSnapshot(bindings.snapshot);
  const result = structural.value;
  const reasons: string[] = [];
  if (!policy.valid) reasons.push(...policy.errors.map((item) => `policy: ${item}`));
  if (!snapshot.valid) reasons.push(...snapshot.errors.map((item) => `snapshot: ${item}`));
  if (!sha256Pattern.test(bindings.current_task_contract_digest)) reasons.push("task contract digest: cannot be normalized.");
  if (typeof bindings.current_source_decision_id !== "string" || !/^OWNER-DECISION-[0-9]{3,}$/.test(bindings.current_source_decision_id) || !sha256Pattern.test(bindings.current_source_decision_digest) || typeof bindings.current_policy_effective_at !== "string" || !Number.isFinite(Date.parse(bindings.current_policy_effective_at))) reasons.push("OwnerDecision: authoritative adoption id, complete-file digest and effective-at facts are required.");
  if (policy.valid) {
    if (result.policy_id !== policy.value.policy_id || result.policy_digest !== policy.value.policy_digest) reasons.push("policy binding changed.");
    if (result.source_decision_id !== policy.value.source_decision_id || policy.value.source_decision_id !== bindings.current_source_decision_id || result.source_decision_digest !== policy.value.source_decision_digest || policy.value.source_decision_digest !== bindings.current_source_decision_digest) reasons.push("OwnerDecision adoption binding changed.");
    if (result.policy_effective_at !== policy.value.effective_at || policy.value.effective_at !== bindings.current_policy_effective_at) reasons.push("policy effective-at binding changed.");
    if (result.subject_task_id !== policy.value.subject_task_id) reasons.push("subject task binding changed.");
    if (Date.parse(result.created_at) < Date.parse(policy.value.effective_at)) reasons.push("result predates policy adoption.");
  }
  if (snapshot.valid) {
    if (result.artifact_snapshot_id !== snapshot.value.snapshot_id || result.artifact_snapshot_digest !== snapshot.value.snapshot_digest) reasons.push("EvidenceSnapshot binding changed.");
    if (result.subject_task_id !== snapshot.value.task_id) reasons.push("snapshot subject task does not match checkpoint subject.");
    if (!sameStringSet(sorted(result.subject_run_ids), snapshot.value.run_ids)) reasons.push("snapshot subject run binding changed.");
    if (policy.valid && Date.parse(snapshot.value.frozen_at) < Date.parse(policy.value.effective_at)) reasons.push("snapshot predates policy adoption.");
    if (Date.parse(result.created_at) < Date.parse(snapshot.value.frozen_at)) reasons.push("result predates frozen snapshot.");
  }
  const hasRunIdentity = (run: CheckpointRunFact): boolean => !!run && /^RUN-[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(run.run_id) && /^M(?:0|[1-9][0-9]*)-T[0-9]{3,}$/.test(run.task_id) && typeof run.agent_id === "string" && !!run.agent_id.trim() && typeof run.role_id === "string" && !!run.role_id.trim();
  const subjectRuns = bindings.subject_runs;
  if (!Array.isArray(subjectRuns) || subjectRuns.length === 0 || subjectRuns.some((run) => !hasRunIdentity(run) || run.task_id !== result.subject_task_id) || new Set(subjectRuns.map((run) => run.run_id)).size !== subjectRuns.length) reasons.push("subject runs: unique authoritative run/task/agent/role identities are required.");
  else if (!sameStringSet(sorted(result.subject_run_ids), sorted(subjectRuns.map((run) => run.run_id)))) reasons.push("authoritative subject run binding changed.");
  const reviewer = bindings.reviewer_run;
  if (!hasRunIdentity(reviewer) || !["reviewer", "verifier"].includes(reviewer.role_type) || reviewer.repository_access !== "read_only") reasons.push("reviewer: an authoritative read-only Reviewer/Verifier run identity is required.");
  else {
    if (result.reviewer_run_id !== reviewer.run_id || result.reviewer_agent_id !== reviewer.agent_id) reasons.push("reviewer run or Agent binding changed.");
    if (result.reviewer_role_id !== reviewer.role_id) reasons.push("reviewer role binding changed.");
    if (Array.isArray(subjectRuns) && subjectRuns.some((run) => run && (run.run_id === reviewer.run_id || run.agent_id === reviewer.agent_id || run.role_id === reviewer.role_id))) reasons.push("reviewer: must be independent of every subject Worker run, Agent and role.");
    if (policy.valid) {
      const reviewerTask = bindings.policy_facts.tasks.find((fact) => fact.task.task_id === reviewer.task_id);
      if (!reviewerTask || reviewerTask.task.task_kind !== "checkpoint_control" || !controlTaskIsExemptable(reviewerTask) || (policy.value.checkpoint_task_id && reviewer.task_id !== policy.value.checkpoint_task_id)) reasons.push("reviewer: run must belong to the independent checkpoint task.");
    }
  }
  if (result.task_contract_digest !== bindings.current_task_contract_digest) reasons.push("task contract digest binding changed.");
  if (result.outcome !== "PASS") reasons.push("checkpoint outcome is not PASS.");
  return { fresh: reasons.length === 0, reasons };
}

export function validateCheckpointResult(value: unknown, bindings: CheckpointResultBindings): Result<CheckpointResult> {
  const structural = validateDeliveryArtifact("checkpointResult", value);
  if (!structural.valid) return structural;
  const freshness = checkpointResultFreshness(structural.value, bindings);
  return freshness.fresh ? structural : invalid(...freshness.reasons);
}

export function validateClosureManifest(value: unknown, snapshotValue: EvidenceSnapshot): Result<ClosureManifest> {
  const structural = validateDeliveryArtifact("closureManifest", value);
  if (!structural.valid) return structural;
  const snapshot = validateEvidenceSnapshot(snapshotValue);
  if (!snapshot.valid) return invalid(...snapshot.errors.map((item) => `snapshot: ${item}`));
  const closure = structural.value;
  const errors: string[] = [];
  if (snapshot.value.evidence_class === "GIT_BACKED_EVIDENCE") {
    const legacy = validateLegacyDeliveryArtifact("closureManifest", value);
    if (!legacy.valid) errors.push(...legacy.errors.map((error) => `legacy Git evidence guarantee: ${error}`));
  }
  // Host refs may have fragments, but retain the old ordering and one-output-
  // per-artifact guarantees. Fragments do not create distinct physical outputs.
  for (const field of ["report_refs", "evidence_refs"] as const) {
    if (!sameStringSet(closure[field], sorted(closure[field]))) errors.push(`ClosureManifest: ${field} must use unique UTF-8 order.`);
  }
  const outputIdentities = new Set<string>();
  if (closure.snapshot_id !== snapshot.value.snapshot_id || closure.snapshot_digest !== snapshot.value.snapshot_digest) errors.push("ClosureManifest: must bind the frozen snapshot id and digest.");
  const frozenInputPaths = new Set([
    ...snapshot.value.spec_manifest.map((item) => artifactPath(item.canonical_ref)),
    ...snapshot.value.path_hash_manifest.map((item) => item.canonical_repo_relative_path),
    ...snapshot.value.evidence_manifest.map((item) => artifactPath(item.canonical_ref)),
  ].map(foldedPath));
  for (const ref of [...closure.report_refs, ...closure.evidence_refs]) {
    const canonical = canonicalArtifactRef(ref);
    if (!canonical) errors.push("ClosureManifest: output refs must be canonical repository-relative refs.");
    else {
      const identity = foldedPath(artifactPath(canonical));
      if (outputIdentities.has(identity)) errors.push("ClosureManifest: output refs must identify distinct artifacts across reports and evidence.");
      outputIdentities.add(identity);
      if (frozenInputPaths.has(identity)) errors.push("ClosureManifest: cannot recursively replace a frozen snapshot input.");
    }
  }
  return errors.length ? invalid(...errors) : structural;
}

export type WorktreeIdentity = {
  worktree_identity_version: "0.1";
  canonical_real_path: string;
  filesystem_identity: string;
};

export function canonicalizeNativeWorktreePath(value: string): string {
  if (process.platform !== "win32") return resolve(value);
  const normalized = win32.normalize(value.replaceAll("/", "\\"));
  const withoutTrailing = normalized.length > 3 ? normalized.replace(/[. ]+\\?$/, "") : normalized;
  return withoutTrailing.toLocaleLowerCase("en-US");
}

/**
 * Reads host-native identity only. It neither acquires a lease nor writes state;
 * M5 later supplies the atomic state operation required for enforcement.
 */
export function resolveWorktreeIdentity(worktreePath: string): Result<WorktreeIdentity> {
  try {
    const resolved = realpathSync.native(worktreePath);
    const stats = statSync(resolved, { bigint: true });
    if (!stats.isDirectory() || stats.dev === 0n || stats.ino === 0n) return invalid("WriteLease: worktree filesystem identity is unavailable.");
    return valid({
      worktree_identity_version: "0.1",
      canonical_real_path: canonicalizeNativeWorktreePath(resolved),
      filesystem_identity: `${process.platform}:${stats.dev.toString()}:${stats.ino.toString()}`,
    });
  } catch {
    return invalid("WriteLease: worktree path cannot be resolved to a physical directory.");
  }
}

export type WriteLeaseValidationContext = {
  observed_identity?: WorktreeIdentity;
  existing_leases?: readonly WriteLease[];
  prior_leases?: readonly WriteLease[];
  expected_holder_run_id?: string;
  expected_fencing_token?: number;
  now?: string;
};

export function validateWriteLease(value: unknown, context: WriteLeaseValidationContext = {}): Result<WriteLease> {
  const structural = validatePlanningArtifact("writeLease", value);
  if (!structural.valid) return structural;
  const lease = structural.value;
  const errors: string[] = [];
  const acquired = Date.parse(lease.acquired_at);
  const expires = Date.parse(lease.expires_at);
  if (!Number.isFinite(acquired) || !Number.isFinite(expires) || expires <= acquired) errors.push("WriteLease: expiry must follow acquisition.");
  if (lease.status === "active") {
    if (!context.observed_identity) errors.push("WriteLease: active leases require authoritative observed physical identity.");
    else {
      const observed = resolveWorktreeIdentity(lease.canonical_real_path);
      if (!observed.valid) errors.push(...observed.errors);
      else if (observed.value.worktree_identity_version !== context.observed_identity.worktree_identity_version || observed.value.canonical_real_path !== context.observed_identity.canonical_real_path || observed.value.filesystem_identity !== context.observed_identity.filesystem_identity) errors.push("WriteLease: supplied observation does not match current host-native physical identity.");
    }
  }
  if (context.observed_identity && (lease.worktree_identity_version !== context.observed_identity.worktree_identity_version || lease.canonical_real_path !== context.observed_identity.canonical_real_path || lease.filesystem_identity !== context.observed_identity.filesystem_identity)) errors.push("WriteLease: path alias or filesystem identity does not match the observed physical worktree.");
  if (context.expected_holder_run_id && lease.holder_run_id !== context.expected_holder_run_id) errors.push("WriteLease: holder run does not match the fenced writer.");
  if (context.expected_fencing_token !== undefined && lease.fencing_token !== context.expected_fencing_token) errors.push("WriteLease: stale fencing token.");
  const allExisting: WriteLease[] = [];
  for (const field of ["existing_leases", "prior_leases"] as const) {
    const history = context[field];
    if (history !== undefined && !Array.isArray(history)) return invalid(...errors, "WriteLease: lease history must be an array of known lease records.");
    for (const item of history ?? []) {
      const record = validatePlanningArtifact("writeLease", item);
      if (!record.valid || Date.parse(item.expires_at) <= Date.parse(item.acquired_at)) return invalid(...errors, "WriteLease: invalid ownership or fencing history fails closed.");
      // Resolve before filtering on a claimed id: a conflicting id must not hide
      // a same-path writer or a higher token. Unavailable historical paths cannot
      // establish that a record belongs to a different physical worktree.
      if (lease.status === "active") {
        const physical = resolveWorktreeIdentity(item.canonical_real_path);
        if (!physical.valid || physical.value.worktree_identity_version !== item.worktree_identity_version || physical.value.filesystem_identity !== item.filesystem_identity || physical.value.canonical_real_path !== item.canonical_real_path) return invalid(...errors, "WriteLease: conflicting or unverifiable historical physical identity fails closed.");
      }
      // Only an exact current record is a self-check. A prior record is always history.
      if (field === "existing_leases" && canonicalJson(item as JsonValue) === canonicalJson(lease as JsonValue)) continue;
      if (lease.status === "active" && item.lease_id === lease.lease_id) errors.push("WriteLease: a conflicting or historical lease id cannot be reused.");
      if (item.filesystem_identity === lease.filesystem_identity) allExisting.push(item);
    }
  }
  if (lease.status === "active" && allExisting.some((item) => item.status === "active" && item.holder_run_id !== lease.holder_run_id)) errors.push("WriteLease: another active writer owns the same physical worktree.");
  if (lease.status === "active" && allExisting.some((item) => item.fencing_token >= lease.fencing_token)) errors.push("WriteLease: fencing token is stale or reusable.");
  const now = Object.hasOwn(context, "now") ? (typeof context.now === "string" ? Date.parse(context.now) : Number.NaN) : Date.now();
  if (!Number.isFinite(now)) errors.push("WriteLease: an explicitly supplied clock must be parseable.");
  else if (lease.status === "active") {
    if (now < acquired) errors.push("WriteLease: an active lease cannot predate acquisition.");
    if (expires <= now) errors.push("WriteLease: an expired lease cannot remain active.");
  }
  return errors.length ? invalid(...errors) : structural;
}

type FailureTuple = Omit<FailureFingerprint, "fingerprint_id">;

export type FailureFingerprintContext = { repo_root: string };

function physicalFailurePath(path: string, root: WorktreeIdentity): string | null {
  if (!canonicalRepoPath(path)) return null;
  try {
    let physical = root.canonical_real_path;
    const segments = path.split("/");
    for (let index = 0; index < segments.length; index++) {
      const candidate = join(physical, segments[index]!);
      let exists = true;
      try { lstatSync(candidate); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
        exists = false;
      }
      if (!exists) {
        // Deleted/not-yet-created paths retain their spelling below the last
        // verified physical ancestor. A dangling link reaches realpath and fails.
        physical = join(physical, ...segments.slice(index));
        break;
      }
      physical = realpathSync.native(candidate);
      const stats = statSync(physical, { bigint: true });
      if (stats.dev === 0n || stats.ino === 0n || (!stats.isFile() && !stats.isDirectory()) || (stats.isFile() && (stats.nlink > 1n || index !== segments.length - 1))) return null;
      const contained = relative(root.canonical_real_path, physical);
      if (isAbsolute(contained) || contained === ".." || contained.startsWith(`..${sep}`)) return null;
    }
    const result = relative(root.canonical_real_path, physical).split(sep).join("/");
    return canonicalRepoPath(result) ? process.platform === "win32" ? foldedPath(result) : result : null;
  } catch { return null; }
}

function canonicalFailureTuple(value: FailureTuple, context: FailureFingerprintContext): Result<FailureTuple> {
  const root = resolveWorktreeIdentity(context.repo_root);
  if (!root.valid) return invalid("FailureFingerprint: repository physical identity is unavailable.");
  const contract_refs = canonicalStringSet(value.contract_refs, (ref) => {
    const canonical = canonicalArtifactRef(ref);
    if (!canonical) return null;
    const path = artifactPath(canonical);
    const physical = physicalFailurePath(path, root.value);
    return physical ? physical + canonical.slice(path.length) : null;
  });
  const affected_paths = canonicalStringSet(value.affected_paths, (path) => {
    return physicalFailurePath(path, root.value);
  });
  if (!contract_refs || !affected_paths || contract_refs.length === 0 || affected_paths.length === 0 || hasCaseFoldCollision(affected_paths)) return invalid("FailureFingerprint: unknown or aliased normalization fails closed.");
  return valid({ ...value, contract_refs, affected_paths });
}

export function materializeFailureFingerprint(input: FailureTuple, context: FailureFingerprintContext = { repo_root: process.cwd() }): FailureFingerprint {
  const canonical = canonicalFailureTuple(input, context);
  if (!canonical.valid) throw new Error(canonical.errors.join(" "));
  const fingerprint_id = `ff-v0.1:${hash(canonicalJson(canonical.value as JsonValue))}`;
  return { ...canonical.value, fingerprint_id };
}

export function validateFailureFingerprint(value: unknown, known: readonly FailureFingerprint[] = [], context: FailureFingerprintContext = { repo_root: process.cwd() }): Result<FailureFingerprint> {
  const structural = validatePlanningArtifact("failureFingerprint", value);
  if (!structural.valid) return structural;
  const fingerprint = structural.value;
  const { fingerprint_id: _fingerprintId, ...tuple } = fingerprint;
  const canonical = canonicalFailureTuple(tuple, context);
  if (!canonical.valid) return canonical;
  const expectedId = `ff-v0.1:${hash(canonicalJson(canonical.value as JsonValue))}`;
  const errors: string[] = [];
  if (fingerprint.fingerprint_id !== expectedId) errors.push("FailureFingerprint: id does not bind the canonical tuple.");
  for (const candidate of known) {
    if (candidate.fingerprint_id !== fingerprint.fingerprint_id) continue;
    const { fingerprint_id: _candidateId, ...candidateInput } = candidate;
    const candidateTuple = canonicalFailureTuple(candidateInput, context);
    if (!candidateTuple.valid || canonicalJson(candidateTuple.value as JsonValue) !== canonicalJson(canonical.value as JsonValue)) errors.push("FailureFingerprint: digest collision or unknown normalization fails closed.");
  }
  return errors.length ? invalid(...errors) : valid({ ...canonical.value, fingerprint_id: expectedId });
}

export function validateRetryBudget(value: unknown, knownFingerprints: readonly FailureFingerprint[], context: FailureFingerprintContext = { repo_root: process.cwd() }): Result<RetryBudget> {
  const structural = validatePlanningArtifact("retryBudget", value);
  if (!structural.valid) return structural;
  const budget = structural.value;
  const matching = knownFingerprints.filter((fingerprint) => fingerprint.fingerprint_id === budget.failure_fingerprint);
  if (matching.length !== 1) return invalid("RetryBudget: unknown or colliding canonical failure fingerprint.");
  const fingerprint = validateFailureFingerprint(matching[0], knownFingerprints, context);
  if (!fingerprint.valid) return invalid(...fingerprint.errors);
  if (budget.attempts >= budget.max_attempts && budget.next_action === "retry") return invalid("RetryBudget: a third automatic rework is forbidden.");
  return structural;
}
