import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { platform } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  CheckpointPolicy,
  CheckpointResult,
  ClosureManifest,
  CriticalBoundaryEvaluation,
  EvidenceHashEntry,
  EvidenceSnapshot,
  FailureFingerprint,
  FilesystemIdentity,
  PathHashEntry,
  RetryBudget,
  SpecHashEntry,
  WriteLease,
} from "./legacy-types.ts";
import type { CriticalBoundary } from "../project-model/types.ts";

export const CRITICAL_BOUNDARIES: readonly CriticalBoundary[] = Object.freeze([
  "security", "state_migration", "evidence", "permission", "privacy", "payment", "authentication",
  "write_scope", "public_schema", "plan_validation", "readiness",
]);

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function asJsonValue(value: unknown, label = "value"): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label}: non-finite numbers cannot be canonicalized.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => asJsonValue(entry, `${label}[${index}]`));
  if (typeof value !== "object") throw new Error(`${label}: unsupported JSON value.`);
  const record = value as Record<string, unknown>;
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] === undefined) throw new Error(`${label}.${key}: undefined cannot be canonicalized.`);
    result[key] = asJsonValue(record[key], `${label}.${key}`);
  }
  return result;
}

/** RFC 8785-compatible canonical JSON for the JSON-only M2 contract values. */
export function canonicalJson(value: unknown): string {
  const normalized = asJsonValue(value);
  if (normalized === null || typeof normalized !== "object") return JSON.stringify(normalized);
  if (Array.isArray(normalized)) return `[${normalized.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(normalized).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(normalized[key])}`).join(",")}}`;
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

const byteCompare = (left: string, right: string): number => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

function canonicalStringSet(values: readonly string[], label: string): string[] {
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || !/\S/u.test(value)) throw new Error(`${label}: entries must be non-empty strings.`);
  }
  return [...new Set(values)].sort(byteCompare);
}

function canonicalObjectSet<T extends object>(values: readonly T[], keyOf: (entry: T) => string, label: string): T[] {
  const byKey = new Map<string, T>();
  for (const entry of values) {
    const key = keyOf(entry);
    const prior = byKey.get(key);
    if (prior && !isDeepStrictEqual(prior, entry)) throw new Error(`${label}: conflicting entries share key ${JSON.stringify(key)}.`);
    if (!prior) byKey.set(key, structuredClone(entry));
  }
  return [...byKey].sort(([left], [right]) => byteCompare(left, right)).map(([, entry]) => entry);
}

export function canonicalizeRepoRelativePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\") || isAbsolute(value) || /^[A-Za-z]:/u.test(value)) {
    throw new Error(`path: ${JSON.stringify(value)} is not a canonical repository-relative POSIX path.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || /[. ]$/u.test(segment) || /[\u0000-\u001f]/u.test(segment))) {
    throw new Error(`path: ${JSON.stringify(value)} contains an empty, aliasing, or invalid segment.`);
  }
  return value;
}

function canonicalReferenceIdentity(value: string): { canonical: string; identity: string } {
  const canonical = canonicalizeRepoRelativePath(value);
  return { canonical, identity: canonical.toLocaleLowerCase("en-US") };
}

function assertCanonicalReferenceEntries<T>(values: readonly T[], refOf: (entry: T) => string, label: string): void {
  const byIdentity = new Map<string, { ref: string; entry: T }>();
  for (const entry of values) {
    const { canonical, identity } = canonicalReferenceIdentity(refOf(entry));
    const prior = byIdentity.get(identity);
    if (prior && prior.ref !== canonical) throw new Error(`${label}: case-folding alias collision between ${JSON.stringify(prior.ref)} and ${JSON.stringify(canonical)}.`);
    if (prior && !isDeepStrictEqual(prior.entry, entry)) throw new Error(`${label}: conflicting entries identify canonical ref ${JSON.stringify(canonical)}.`);
    if (!prior) byIdentity.set(identity, { ref: canonical, entry });
  }
}

function canonicalReferenceSet(values: readonly string[], label: string): string[] {
  const canonical = values.map((value) => canonicalReferenceIdentity(value).canonical);
  const byIdentity = new Map<string, string>();
  for (const ref of canonical) {
    const identity = ref.toLocaleLowerCase("en-US");
    const prior = byIdentity.get(identity);
    if (prior && prior !== ref) throw new Error(`${label}: case-folding alias collision between ${JSON.stringify(prior)} and ${JSON.stringify(ref)}.`);
    if (!prior) byIdentity.set(identity, ref);
  }
  return canonicalStringSet(canonical, label);
}

export function resolveCanonicalRepoPath(repoRoot: string, candidate: string): string {
  if (typeof candidate !== "string" || candidate.length === 0 || isAbsolute(candidate) || /^[A-Za-z]:/u.test(candidate)) {
    throw new Error(`path: ${JSON.stringify(candidate)} must be repository-relative.`);
  }
  const root = realpathSync.native(repoRoot);
  const target = realpathSync.native(resolve(root, candidate));
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`path: ${JSON.stringify(candidate)} does not identify a file inside the repository root.`);
  return canonicalizeRepoRelativePath(rel.split(sep).join("/"));
}

export type EvidenceSnapshotInput = Omit<EvidenceSnapshot, "snapshot_id" | "snapshot_digest">;

function canonicalSnapshotInput(input: EvidenceSnapshotInput): EvidenceSnapshotInput {
  assertCanonicalReferenceEntries(input.spec_manifest, (entry) => entry.canonical_ref, "spec_manifest");
  assertCanonicalReferenceEntries(input.evidence_manifest, (entry) => entry.canonical_ref, "evidence_manifest");
  const specManifest = canonicalObjectSet(input.spec_manifest, (entry) => entry.canonical_ref, "spec_manifest");
  const pathManifest = canonicalObjectSet(input.path_hash_manifest, (entry) => entry.canonical_repo_relative_path, "path_hash_manifest");
  const evidenceManifest = canonicalObjectSet(input.evidence_manifest, (entry) => `${entry.evidence_id}\u0000${entry.canonical_ref}`, "evidence_manifest");

  for (const entry of pathManifest) canonicalizeRepoRelativePath(entry.canonical_repo_relative_path);
  const pathAliases = new Map<string, string>();
  for (const entry of pathManifest) {
    const folded = entry.canonical_repo_relative_path.toLocaleLowerCase("en-US");
    const prior = pathAliases.get(folded);
    if (prior && prior !== entry.canonical_repo_relative_path) throw new Error(`path_hash_manifest: case-folding alias collision between ${JSON.stringify(prior)} and ${JSON.stringify(entry.canonical_repo_relative_path)}.`);
    pathAliases.set(folded, entry.canonical_repo_relative_path);
  }

  return {
    ...structuredClone(input),
    run_ids: canonicalStringSet(input.run_ids, "run_ids"),
    acceptance_criteria_ids: canonicalStringSet(input.acceptance_criteria_ids, "acceptance_criteria_ids"),
    spec_manifest: specManifest.sort((left, right) => byteCompare(left.canonical_ref, right.canonical_ref)),
    path_hash_manifest: pathManifest.sort((left, right) => byteCompare(left.canonical_repo_relative_path, right.canonical_repo_relative_path)),
    evidence_manifest: evidenceManifest.sort((left, right) => byteCompare(`${left.evidence_id}\u0000${left.canonical_ref}`, `${right.evidence_id}\u0000${right.canonical_ref}`)),
  };
}

function snapshotDigestPayload(input: EvidenceSnapshotInput): Omit<EvidenceSnapshotInput, "frozen_at"> {
  const { frozen_at: _frozenAt, ...payload } = canonicalSnapshotInput(input);
  return payload;
}

export function createEvidenceSnapshot(input: EvidenceSnapshotInput): EvidenceSnapshot {
  const canonical = canonicalSnapshotInput(input);
  const snapshotDigest = canonicalSha256(snapshotDigestPayload(canonical));
  return { ...canonical, snapshot_id: `es-v0.1:${snapshotDigest}`, snapshot_digest: snapshotDigest };
}

export function evidenceSnapshotInvariantErrors(snapshot: EvidenceSnapshot, current?: EvidenceSnapshotInput): string[] {
  try {
    const { snapshot_id: _id, snapshot_digest: _digest, ...input } = snapshot;
    const expected = createEvidenceSnapshot(input);
    const errors: string[] = [];
    if (snapshot.snapshot_digest !== expected.snapshot_digest) errors.push("snapshot_digest: does not match the canonical frozen inputs.");
    if (snapshot.snapshot_id !== expected.snapshot_id) errors.push("snapshot_id: does not match snapshot_digest.");
    if (!isDeepStrictEqual(snapshot, expected)) errors.push("snapshot: stored arrays and manifests must use the canonical deduplicated order.");
    if (current && expected.snapshot_digest !== createEvidenceSnapshot(current).snapshot_digest) errors.push("snapshot: stale or tampered relative to current bound inputs.");
    return errors;
  } catch (error) {
    return [error instanceof Error ? error.message : "snapshot: canonicalization failed closed."];
  }
}

export function closureManifestInvariantErrors(closure: ClosureManifest, snapshot?: EvidenceSnapshot): string[] {
  try {
    const errors: string[] = [];
    const reportRefs = canonicalReferenceSet(closure.report_refs, "report_refs");
    const evidenceRefs = canonicalReferenceSet(closure.evidence_refs, "evidence_refs");
    if (!isDeepStrictEqual(closure.report_refs, reportRefs)) errors.push("report_refs: must use canonical, unique UTF-8 order.");
    if (!isDeepStrictEqual(closure.evidence_refs, evidenceRefs)) errors.push("evidence_refs: must use canonical, unique UTF-8 order.");
    const outputByIdentity = new Map<string, string>();
    for (const ref of [...reportRefs, ...evidenceRefs]) {
      const identity = ref.toLocaleLowerCase("en-US");
      const prior = outputByIdentity.get(identity);
      if (prior) errors.push(`closure: output refs ${JSON.stringify(prior)} and ${JSON.stringify(ref)} identify the same canonical artifact.`);
      else outputByIdentity.set(identity, ref);
    }
    if (closure.snapshot_id !== `es-v0.1:${closure.snapshot_digest}`) errors.push("snapshot_id: must identify snapshot_digest.");
    if (snapshot) {
      if (closure.snapshot_id !== snapshot.snapshot_id || closure.snapshot_digest !== snapshot.snapshot_digest) errors.push("closure: must bind the exact judged EvidenceSnapshot identity and digest.");
      const frozenRefs = new Set([
        ...snapshot.spec_manifest.map((entry) => canonicalReferenceIdentity(entry.canonical_ref).identity),
        ...snapshot.evidence_manifest.map((entry) => canonicalReferenceIdentity(entry.canonical_ref).identity),
        ...snapshot.path_hash_manifest.map((entry) => canonicalReferenceIdentity(entry.canonical_repo_relative_path).identity),
      ]);
      for (const ref of [...reportRefs, ...evidenceRefs]) {
        if (frozenRefs.has(canonicalReferenceIdentity(ref).identity)) errors.push(`closure: output ref ${JSON.stringify(ref)} must not recursively replace a frozen snapshot input.`);
      }
    }
    return errors;
  } catch (error) {
    return [error instanceof Error ? error.message : "closure manifest: reference canonicalization failed closed."];
  }
}

function canonicalBoundaryEvaluations(values: readonly CriticalBoundaryEvaluation[]): CriticalBoundaryEvaluation[] {
  const canonical = canonicalObjectSet(values, (entry) => entry.boundary, "critical_boundary_evaluations").map((entry) => ({
    ...entry,
    producer_interface_refs: canonicalStringSet(entry.producer_interface_refs, `${entry.boundary}.producer_interface_refs`),
    consumer_task_ids: canonicalStringSet(entry.consumer_task_ids, `${entry.boundary}.consumer_task_ids`),
  }));
  const present = new Set(canonical.map((entry) => entry.boundary));
  const missing = CRITICAL_BOUNDARIES.filter((boundary) => !present.has(boundary));
  if (missing.length > 0 || canonical.length !== CRITICAL_BOUNDARIES.length) throw new Error(`critical_boundary_evaluations: must contain each known boundary exactly once; missing ${missing.join(", ") || "none"}.`);
  return canonical.sort((left, right) => byteCompare(left.boundary, right.boundary));
}

export function checkpointPolicyDigest(policy: Omit<CheckpointPolicy, "policy_digest"> | CheckpointPolicy): string {
  const { policy_digest: _digest, ...payload } = policy as CheckpointPolicy;
  return canonicalSha256({
    ...payload,
    critical_boundary_evaluations: canonicalBoundaryEvaluations(payload.critical_boundary_evaluations),
    derived_consumer_task_ids: canonicalStringSet(payload.derived_consumer_task_ids, "derived_consumer_task_ids"),
    trigger_reasons: canonicalStringSet(payload.trigger_reasons, "trigger_reasons"),
  });
}

export function checkpointPolicyInvariantErrors(policy: CheckpointPolicy): string[] {
  try {
    const evaluations = canonicalBoundaryEvaluations(policy.critical_boundary_evaluations);
    const consumers = canonicalStringSet(policy.derived_consumer_task_ids, "derived_consumer_task_ids");
    const evaluationConsumers = canonicalStringSet(evaluations.flatMap((entry) => entry.consumer_task_ids), "critical boundary consumer task ids");
    const changed = evaluations.some((entry) => entry.changed);
    const sharedInterface = evaluations.some((entry) => entry.producer_interface_refs.length > 0 && entry.consumer_task_ids.length >= 2);
    const controlKind = policy.subject_task_kind !== "implementation";
    const invalidWritableControl = controlKind && (policy.subject_repository_access !== "read_only" || policy.has_writable_outputs || policy.has_writable_interfaces);
    const exempt = controlKind && policy.subject_repository_access === "read_only" && !policy.has_writable_outputs && !policy.has_writable_interfaces && policy.reviewer_independence_required;
    const required = !controlKind && policy.subject_repository_access === "write_scoped" && consumers.length > 0
      && (((policy.subject_risk_level === "high" || policy.subject_risk_level === "medium-high") && changed) || consumers.length >= 2 || sharedInterface);
    const expectedDisposition = exempt ? "exempt_control" : required ? "required" : "not_required";
    const reasons = exempt ? ["control_exemption"]
      : required
        ? [
          ...((policy.subject_risk_level === "high" || policy.subject_risk_level === "medium-high") && changed ? ["critical_boundary_change"] : []),
          ...(consumers.length >= 2 ? ["multiple_downstream_consumers"] : []),
          ...(sharedInterface ? ["shared_interface_contract"] : []),
        ]
        : ["no_checkpoint_trigger"];
    const expectedReasons = canonicalStringSet(reasons, "expected trigger reasons");
    const actualReasons = canonicalStringSet(policy.trigger_reasons, "trigger_reasons");
    const errors: string[] = [];
    if (policy.policy_digest !== checkpointPolicyDigest(policy)) errors.push("policy_digest: does not match the complete canonical policy including source-decision adoption fields.");
    if (evaluationConsumers.some((taskId) => !consumers.includes(taskId))) errors.push("critical boundary evaluations: every consumer backlink must occur in derived_consumer_task_ids.");
    if (invalidWritableControl) errors.push("control classification: checkpoint/review/verification controls must be read-only with no writable outputs or interfaces.");
    if (policy.disposition !== expectedDisposition) errors.push(`disposition: expected ${expectedDisposition} from typed task/DAG/interface facts.`);
    if (!isDeepStrictEqual(actualReasons, expectedReasons)) errors.push("trigger_reasons: must be the deterministic derived enumeration, not self-reported prose.");
    if (policy.disposition === "required" && (!policy.checkpoint_task_id || policy.checkpoint_task_id === policy.subject_task_id)) errors.push("checkpoint_task_id: required checkpoint must identify a different control task.");
    return errors;
  } catch (error) {
    return [error instanceof Error ? error.message : "checkpoint policy: canonicalization failed closed."];
  }
}

export type CheckpointCurrentBindings = {
  task_contract_digest: string;
  subject_run_ids: string[];
  artifact_snapshot_id: string;
  artifact_snapshot_digest: string;
  worker_role_ids?: string[];
};

export function checkpointResultInvariantErrors(result: CheckpointResult, policy?: CheckpointPolicy, current?: CheckpointCurrentBindings): string[] {
  const errors: string[] = [];
  if (Date.parse(result.created_at) < Date.parse(result.policy_effective_at)) errors.push("created_at: checkpoint result predates policy adoption.");
  if (result.artifact_snapshot_id !== `es-v0.1:${result.artifact_snapshot_digest}`) errors.push("artifact_snapshot_id: must identify artifact_snapshot_digest.");
  if (policy) {
    if (result.policy_id !== policy.policy_id || result.policy_digest !== policy.policy_digest) errors.push("checkpoint result: stale policy binding.");
    if (result.source_decision_id !== policy.source_decision_id || result.source_decision_digest !== policy.source_decision_digest || result.policy_effective_at !== policy.effective_at) errors.push("checkpoint result: stale source-decision adoption binding.");
    if (result.subject_task_id !== policy.subject_task_id) errors.push("checkpoint result: subject task does not match policy.");
  }
  if (current) {
    if (result.task_contract_digest !== current.task_contract_digest) errors.push("checkpoint result: stale Task Contract digest.");
    if (!isDeepStrictEqual(canonicalStringSet(result.subject_run_ids, "subject_run_ids"), canonicalStringSet(current.subject_run_ids, "current subject_run_ids"))) errors.push("checkpoint result: stale subject run binding.");
    if (result.artifact_snapshot_id !== current.artifact_snapshot_id || result.artifact_snapshot_digest !== current.artifact_snapshot_digest) errors.push("checkpoint result: stale artifact snapshot binding.");
    if (current.worker_role_ids?.includes(result.reviewer_role_id)) errors.push("reviewer_role_id: reviewer must be independent from every subject Worker role.");
  }
  return errors;
}

function supportedPlatform(): FilesystemIdentity["platform"] {
  const value = platform();
  if (value === "win32" || value === "linux" || value === "darwin") return value;
  throw new Error(`filesystem identity: unsupported host platform ${JSON.stringify(value)}.`);
}

function canonicalHostRealPath(value: string, host: FilesystemIdentity["platform"]): string {
  if (host !== "win32") return value;
  let normalized = value.replace(/^\\\\\?\\UNC\\/iu, "\\\\").replace(/^\\\\\?\\/u, "").replaceAll("/", "\\");
  if (!/^[A-Za-z]:\\$/u.test(normalized) && !/^\\\\[^\\]+\\[^\\]+\\?$/u.test(normalized)) normalized = normalized.replace(/[. \\]+$/u, "");
  return normalized.toLocaleLowerCase("en-US");
}

function canonicalDecimalIdentity(value: string, label: string, allowZero: boolean): string {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${label}: must be a canonical unsigned decimal identifier.`);
  if (!allowZero && value === "0") throw new Error(`${label}: zero is not a usable filesystem file identity.`);
  return value;
}

function canonicalFilesystemIdentity(identity: FilesystemIdentity): FilesystemIdentity {
  if (identity.platform !== "win32" && identity.platform !== "linux" && identity.platform !== "darwin") throw new Error("filesystem identity: unsupported platform.");
  return {
    platform: identity.platform,
    volume_id: canonicalDecimalIdentity(identity.volume_id, "filesystem_identity.volume_id", true),
    file_id: canonicalDecimalIdentity(identity.file_id, "filesystem_identity.file_id", false),
  };
}

export type WorktreeIdentity = {
  worktree_identity_version: "filesystem-v0.1";
  canonical_real_path: string;
  filesystem_identity: FilesystemIdentity;
  worktree_id: string;
};

function worktreeIdentityInvariantErrors(identity: WorktreeIdentity): string[] {
  try {
    const filesystemIdentity = canonicalFilesystemIdentity(identity.filesystem_identity);
    const expectedWorktreeId = `wt-v0.1:${canonicalSha256({ worktree_identity_version: identity.worktree_identity_version, filesystem_identity: filesystemIdentity })}`;
    const errors: string[] = [];
    if (identity.worktree_identity_version !== "filesystem-v0.1") errors.push("worktree_identity_version: unsupported identity version.");
    if (identity.worktree_id !== expectedWorktreeId) errors.push("worktree_id: does not match the versioned canonical filesystem identity.");
    if (identity.canonical_real_path !== canonicalHostRealPath(identity.canonical_real_path, filesystemIdentity.platform)) errors.push("canonical_real_path: must use the host-canonical path representation.");
    return errors;
  } catch (error) {
    return [error instanceof Error ? error.message : "worktree identity: canonicalization failed closed."];
  }
}

export function resolveWorktreeIdentity(worktreePath: string): WorktreeIdentity {
  const host = supportedPlatform();
  const realPath = realpathSync.native(worktreePath);
  const stats = statSync(realPath, { bigint: true });
  if (!stats.isDirectory() || stats.dev < 0n || stats.ino <= 0n) throw new Error("filesystem identity: worktree must be an existing directory with a usable volume/device and file identity.");
  const filesystemIdentity: FilesystemIdentity = { platform: host, volume_id: stats.dev.toString(10), file_id: stats.ino.toString(10) };
  const worktreeId = `wt-v0.1:${canonicalSha256({ worktree_identity_version: "filesystem-v0.1", filesystem_identity: filesystemIdentity })}`;
  return { worktree_identity_version: "filesystem-v0.1", canonical_real_path: canonicalHostRealPath(realPath, host), filesystem_identity: filesystemIdentity, worktree_id: worktreeId };
}

export function deriveFencingToken(seed: { worktree_id: string; holder_run_id: string; acquired_at: string; nonce: string }): string {
  if (!seed.nonce) throw new Error("fencing token: a non-empty, non-reusable acquisition nonce is required.");
  return `ft-v0.1:${canonicalSha256(seed)}`;
}

export function deriveWriteLeaseId(lease: Pick<WriteLease, "worktree_id" | "holder_run_id" | "fencing_token" | "acquired_at">): string {
  return `wl-v0.1:${canonicalSha256({
    worktree_id: lease.worktree_id,
    holder_run_id: lease.holder_run_id,
    fencing_token: lease.fencing_token,
    acquired_at: lease.acquired_at,
  })}`;
}

export function writeLeaseInvariantErrors(lease: WriteLease, observedIdentity?: WorktreeIdentity): string[] {
  const leaseIdentity: WorktreeIdentity = {
    worktree_identity_version: lease.worktree_identity_version,
    canonical_real_path: lease.canonical_real_path,
    filesystem_identity: lease.filesystem_identity,
    worktree_id: lease.worktree_id,
  };
  const errors = worktreeIdentityInvariantErrors(leaseIdentity);
  if (lease.lease_id.startsWith("wl-v0.1:") && lease.lease_id !== deriveWriteLeaseId(lease)) errors.push("lease_id: does not match the bound worktree, holder, fencing token and acquisition time.");
  if (Date.parse(lease.expires_at) <= Date.parse(lease.acquired_at)) errors.push("expires_at: must be later than acquired_at.");
  try {
    const canonicalScope = lease.allowed_scope.map(canonicalizeRepoRelativePath);
    if (!isDeepStrictEqual(canonicalScope, canonicalStringSet(canonicalScope, "allowed_scope"))) errors.push("allowed_scope: must be canonical, unique and UTF-8 sorted.");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "allowed_scope: canonicalization failed closed.");
  }
  if (observedIdentity && (lease.worktree_id !== observedIdentity.worktree_id || lease.canonical_real_path !== observedIdentity.canonical_real_path || !isDeepStrictEqual(lease.filesystem_identity, observedIdentity.filesystem_identity))) errors.push("write lease: stale or aliased worktree identity does not match the observed filesystem object.");
  return errors;
}

export function writeLeaseSetInvariantErrors(leases: readonly WriteLease[], now = new Date()): string[] {
  const errors: string[] = [];
  const activeByIdentity = new Map<string, WriteLease>();
  const realPathByFilesystem = new Map<string, { pathKey: string; leaseId: string }>();
  const filesystemByRealPath = new Map<string, { filesystemKey: string; leaseId: string }>();
  for (const lease of leases) {
    errors.push(...writeLeaseInvariantErrors(lease).map((error) => `${lease.lease_id}: ${error}`));
    let filesystemKey: string;
    try {
      filesystemKey = canonicalJson(canonicalFilesystemIdentity({
        ...lease.filesystem_identity,
        volume_id: BigInt(lease.filesystem_identity.volume_id).toString(10),
        file_id: BigInt(lease.filesystem_identity.file_id).toString(10),
      }));
    } catch {
      filesystemKey = canonicalJson(lease.filesystem_identity);
    }
    const pathKey = `${lease.filesystem_identity.platform}\u0000${canonicalHostRealPath(lease.canonical_real_path, lease.filesystem_identity.platform)}`;
    const priorPath = realPathByFilesystem.get(filesystemKey);
    if (priorPath && priorPath.pathKey !== pathKey) errors.push(`${lease.lease_id}: filesystem identity conflicts with canonical real path claimed by ${priorPath.leaseId}.`);
    else if (!priorPath) realPathByFilesystem.set(filesystemKey, { pathKey, leaseId: lease.lease_id });
    const priorFilesystem = filesystemByRealPath.get(pathKey);
    if (priorFilesystem && priorFilesystem.filesystemKey !== filesystemKey) errors.push(`${lease.lease_id}: canonical real path conflicts with filesystem identity claimed by ${priorFilesystem.leaseId}.`);
    else if (!priorFilesystem) filesystemByRealPath.set(pathKey, { filesystemKey, leaseId: lease.lease_id });
    if (lease.status !== "active") continue;
    if (Date.parse(lease.acquired_at) > now.getTime()) errors.push(`${lease.lease_id}: active lease was acquired in the future and is not current.`);
    if (Date.parse(lease.expires_at) <= now.getTime()) errors.push(`${lease.lease_id}: active lease is expired and must fail closed until reconciled.`);
    const prior = activeByIdentity.get(filesystemKey);
    if (prior) errors.push(`${lease.lease_id}: competing active writer conflicts with ${prior.lease_id}.`);
    else activeByIdentity.set(filesystemKey, lease);
  }
  return errors;
}

export function hasCurrentFencingToken(lease: WriteLease, holderRunId: string, fencingToken: string, now = new Date()): boolean {
  return lease.status === "active" && lease.holder_run_id === holderRunId && lease.fencing_token === fencingToken
    && Date.parse(lease.acquired_at) <= now.getTime() && now.getTime() < Date.parse(lease.expires_at)
    && writeLeaseInvariantErrors(lease).length === 0;
}

export type FailureFingerprintInput = Omit<FailureFingerprint, "schema_version" | "fingerprint_id" | "repo_root_identity">;

export function createFailureFingerprint(input: FailureFingerprintInput, repoRoot: string | WorktreeIdentity): FailureFingerprint {
  if (repoRoot === undefined || repoRoot === null) throw new Error("failure fingerprint: a filesystem-backed repository root or validated canonical identity is required.");
  const rootIdentity = typeof repoRoot === "string" ? resolveWorktreeIdentity(repoRoot) : structuredClone(repoRoot);
  const rootErrors = worktreeIdentityInvariantErrors(rootIdentity);
  if (rootErrors.length > 0) throw new Error(`failure fingerprint: invalid repository root identity: ${rootErrors.join(" ")}`);
  const contractRefs = canonicalStringSet(input.contract_refs, "contract_refs");
  const affectedPaths = canonicalStringSet(input.affected_paths.map((path) => typeof repoRoot === "string" ? resolveCanonicalRepoPath(repoRoot, path) : canonicalizeRepoRelativePath(path)), "affected_paths");
  const tuple = { schema_version: "0.1", repo_root_identity: rootIdentity.worktree_id, stage: input.stage, issue_code: input.issue_code, contract_refs: contractRefs, affected_paths: affectedPaths, root_cause_class: input.root_cause_class } as const;
  return { ...tuple, fingerprint_id: `ff-v0.1:${canonicalSha256(tuple)}` };
}

export function failureFingerprintInvariantErrors(fingerprint: FailureFingerprint): string[] {
  try {
    if (!/^wt-v0\.1:[0-9a-f]{64}$/u.test(fingerprint.repo_root_identity)) throw new Error("repo_root_identity: must be a validated canonical worktree identity.");
    const contractRefs = canonicalStringSet(fingerprint.contract_refs, "contract_refs");
    const affectedPaths = canonicalStringSet(fingerprint.affected_paths.map(canonicalizeRepoRelativePath), "affected_paths");
    const tuple = {
      schema_version: "0.1" as const,
      repo_root_identity: fingerprint.repo_root_identity,
      stage: fingerprint.stage,
      issue_code: fingerprint.issue_code,
      contract_refs: contractRefs,
      affected_paths: affectedPaths,
      root_cause_class: fingerprint.root_cause_class,
    };
    const expected: FailureFingerprint = { ...tuple, fingerprint_id: `ff-v0.1:${canonicalSha256(tuple)}` };
    const errors: string[] = [];
    if (fingerprint.fingerprint_id !== expected.fingerprint_id) errors.push("fingerprint_id: does not match the canonical versioned failure tuple.");
    if (!isDeepStrictEqual(fingerprint, expected)) errors.push("failure fingerprint: arrays and paths must use the canonical deduplicated order.");
    return errors;
  } catch (error) {
    return [error instanceof Error ? error.message : "failure fingerprint: normalization failed closed."];
  }
}

export function failureFingerprintSetInvariantErrors(fingerprints: readonly FailureFingerprint[]): string[] {
  const byId = new Map<string, string>();
  const errors: string[] = [];
  for (const fingerprint of fingerprints) {
    errors.push(...failureFingerprintInvariantErrors(fingerprint).map((error) => `${fingerprint.fingerprint_id}: ${error}`));
    const { fingerprint_id: _fingerprintId, ...fingerprintTuple } = fingerprint;
    const tuple = canonicalJson(fingerprintTuple);
    const prior = byId.get(fingerprint.fingerprint_id);
    if (prior && prior !== tuple) errors.push(`${fingerprint.fingerprint_id}: digest collision maps to different canonical tuples.`);
    else byId.set(fingerprint.fingerprint_id, tuple);
  }
  return errors;
}

export function retryBudgetInvariantErrors(budget: RetryBudget): string[] {
  const errors: string[] = [];
  if (budget.max_attempts !== 2) errors.push("max_attempts: V0 automatic rework ceiling is exactly two.");
  if (budget.attempts > budget.max_attempts) errors.push("attempts: a third automatic rework attempt is prohibited.");
  if (budget.attempts >= budget.max_attempts && budget.next_action === "retry") errors.push("next_action: exhausted failure fingerprint must escalate instead of retrying.");
  return errors;
}
