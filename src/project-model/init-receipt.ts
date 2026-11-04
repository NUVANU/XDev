import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { buildProjectModel, type ProjectModelBundle } from "./build-project-model.ts";
import { validateProjectModel } from "./validate.ts";
import type { DesignSeed } from "./types.ts";
import { parseUniqueJson } from "../planning/retry-history.ts";

export const D1_RECEIPT = "d1-init-receipt.json";
type FileHash = { path: string; sha256: string };
export type D1InitReceipt = {
  format: "xdev-d1-init-source-1";
  project_id: string;
  root_identity: string;
  seed_ref: string;
  seed_sha256: string;
  source_files: FileHash[];
  artifact_files: FileHash[];
  created_at: string;
  worker_started: false;
  budget_reserved: false;
};

export const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const sameKeys = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
  && Object.keys(value).sort().join("|") === [...keys].sort().join("|");

function fail(code: string): never { throw new Error(code); }
function requireFact(ok: unknown, code: string): asserts ok { if (!ok) fail(code); }

/** Only simple relative files in the project root are accepted as source facts. */
export function checkedRelativeFile(value: string): string {
  requireFact(typeof value === "string" && value.length > 0 && !isAbsolute(value) && !value.includes("\\")
    && !/[\x00-\x1f<>:"|?*]/.test(value) && !/^[A-Za-z]:/.test(value), "D1_SOURCE_PATH_INVALID");
  requireFact(value.split("/").every(segment => segment && segment !== "." && segment !== ".."
    && !/[. ]$/.test(segment) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment)), "D1_SOURCE_PATH_INVALID");
  return value;
}

function noLinks(path: string): void {
  for (let current = path;; current = dirname(current)) {
    requireFact(!lstatSync(current).isSymbolicLink(), "D1_LINKED_INPUT");
    if (dirname(current) === current) break;
  }
}

export function projectRootIdentity(projectRoot: string): { root: string; identity: string } {
  requireFact(isAbsolute(projectRoot) && resolve(projectRoot) === projectRoot, "D1_ROOT_INVALID");
  noLinks(projectRoot);
  const stat = lstatSync(projectRoot, { bigint: true });
  requireFact(stat.isDirectory(), "D1_ROOT_INVALID");
  const root = realpathSync.native(projectRoot);
  requireFact(root === projectRoot, "D1_ROOT_ALIAS");
  return { root, identity: sha256(`${root}\0${stat.dev}:${stat.ino}:${stat.birthtimeNs}`) };
}

export function readProjectFile(root: string, ref: string): Buffer {
  checkedRelativeFile(ref);
  const path = join(root, ref);
  noLinks(path);
  const stat = lstatSync(path);
  requireFact(stat.isFile() && stat.nlink === 1 && stat.size <= 16 * 1024 * 1024, "D1_SOURCE_UNSUPPORTED");
  const actual = realpathSync.native(path);
  const rel = relative(root, actual);
  requireFact(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && actual === path, "D1_SOURCE_CROSS_ROOT");
  return readFileSync(path);
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === new Set(left).size && right.length === new Set(right).size
    && isDeepStrictEqual([...left].sort(), [...right].sort());
}

/** The 0.1 schema accepts independent arrays; D1 registration requires their
 * current project graph to agree in both directions. */
export function validateD1SeedLinks(seed: DesignSeed): void {
  const requirements = new Map(seed.requirements.map(item => [item.requirement_id, item]));
  const criteria = new Map(seed.acceptance_criteria.map(item => [item.id, item]));
  const gates = new Map(seed.owner_gates.map(item => [item.owner_gate_id, item]));
  requireFact(requirements.size === seed.requirements.length && criteria.size === seed.acceptance_criteria.length
    && gates.size === seed.owner_gates.length, "D1_SOURCE_ID_DUPLICATE");
  for (const task of seed.tasks) {
    const expectedRequirements = seed.requirements.filter(item => item.task_ids.includes(task.task_id)).map(item => item.requirement_id);
    requireFact(expectedRequirements.length > 0 && sameSet(task.source_requirement_ids, expectedRequirements), "D1_TASK_REQUIREMENT_LINK_INVALID");
    const expectedCriteria = [...new Set(expectedRequirements.flatMap(id => requirements.get(id)!.acceptance_criteria_ids))];
    requireFact(expectedCriteria.length > 0 && expectedCriteria.every(id => criteria.has(id))
      && sameSet(task.acceptance_criteria, expectedCriteria), "D1_TASK_CRITERION_LINK_INVALID");
    const expectedGates = seed.owner_gates.filter(item => item.affected_task_ids.includes(task.task_id)).map(item => item.owner_gate_id);
    requireFact(sameSet(task.owner_gate_conditions, expectedGates), "D1_TASK_GATE_LINK_INVALID");
  }
  for (const gate of seed.owner_gates) {
    requireFact(gate.affected_requirement_ids.every(id => requirements.has(id))
      && gate.affected_task_ids.every(id => seed.tasks.some(task => task.task_id === id))
      && gate.affected_task_ids.every(id => seed.tasks.find(task => task.task_id === id)!.owner_gate_conditions.includes(gate.owner_gate_id)), "D1_GATE_LINK_INVALID");
  }
}

function sourceRefs(root: string, seed: DesignSeed, seedRef: string): string[] {
  const approved = seed.approved_design_refs.map(ref => checkedRelativeFile(ref.split("#", 1)[0]!));
  requireFact(approved.length > 0 && new Set(approved).size === approved.length, "D1_APPROVED_DESIGN_REQUIRED");
  for (const requirement of seed.requirements) {
    requireFact(requirement.status === "approved" && requirement.delivery_status === "not_started", "D1_REQUIREMENT_NOT_APPROVED");
    requireFact(requirement.source_refs.length > 0 && requirement.source_refs.every(ref => approved.includes(checkedRelativeFile(ref.split("#", 1)[0]!))), "D1_REQUIREMENT_SOURCE_UNAPPROVED");
  }
  requireFact(seed.acceptance_criteria.every(criterion => criterion.status === "approved"), "D1_CRITERION_NOT_APPROVED");
  const decisions: string[] = [];
  for (const gate of seed.owner_gates) {
    if (gate.status === "approved" || gate.status === "resolved") requireFact(!!gate.decision_ref && !!gate.resolved_at, "D1_GATE_DECISION_REQUIRED");
    if (!gate.decision_ref) continue;
    const path = checkedRelativeFile(gate.decision_ref);
    const decision: unknown = parseUniqueJson(new TextDecoder("utf-8", { fatal: true }).decode(readProjectFile(root, path)));
    requireFact(typeof decision === "object" && decision !== null && !Array.isArray(decision)
      && (decision as Record<string, unknown>).owner_gate_id === gate.owner_gate_id
      && typeof (decision as Record<string, unknown>).option_id === "string"
      && gate.options.some(option => option.option_id === (decision as Record<string, unknown>).option_id), "D1_GATE_DECISION_INVALID");
    decisions.push(path);
  }
  return [...new Set([seedRef, ...approved, ...decisions])].sort();
}

function artifactFiles(bundle: ProjectModelBundle): Array<{ path: string; value: unknown }> {
  return [
    { path: "project-state.json", value: bundle.project_state },
    { path: "requirements/registry.json", value: bundle.requirement_registry },
    ...bundle.milestones.map(value => ({ path: `milestones/${value.milestone_id}.json`, value })),
    ...bundle.tasks.map(value => ({ path: `tasks/${value.task_id}.json`, value })),
    ...bundle.owner_gates.map(value => ({ path: `owner-gates/${value.owner_gate_id}.json`, value })),
  ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function makeD1InitReceipt(rootPath: string, seedRef: string, seedBytes: string, seed: DesignSeed, bundle: ProjectModelBundle): D1InitReceipt {
  const { root, identity } = projectRootIdentity(rootPath);
  checkedRelativeFile(seedRef);
  requireFact(readProjectFile(root, seedRef).equals(Buffer.from(seedBytes, "utf8")), "D1_SEED_SOURCE_DRIFT");
  requireFact(isDeepStrictEqual(parseUniqueJson(seedBytes), seed), "D1_SEED_VALUE_DRIFT");
  validateD1SeedLinks(seed);
  const source_files = sourceRefs(root, seed, seedRef).map(path => ({ path, sha256: sha256(readProjectFile(root, path)) }));
  const artifact_files = artifactFiles(bundle).map(file => ({ path: file.path, sha256: sha256(`${JSON.stringify(file.value, null, 2)}\n`) }));
  return { format: "xdev-d1-init-source-1", project_id: seed.project_id, root_identity: identity, seed_ref: seedRef,
    seed_sha256: sha256(seedBytes), source_files, artifact_files, created_at: new Date().toISOString(), worker_started: false, budget_reserved: false };
}

function fileEntries(root: string, base = root): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name), rel = relative(base, path).replaceAll("\\", "/");
    requireFact(!entry.isSymbolicLink(), "D1_LINKED_INPUT");
    if (entry.isDirectory()) paths.push(...fileEntries(path, base));
    else { requireFact(entry.isFile(), "D1_SOURCE_UNSUPPORTED"); paths.push(rel); }
  }
  return paths.sort();
}

export function readVerifiedD1Init(rootPath: string): { receipt: D1InitReceipt; receipt_sha256: string; bundle: ProjectModelBundle; seed: DesignSeed } {
  const { root, identity } = projectRootIdentity(rootPath);
  const receiptBytes = readProjectFile(root, `.xdev/${D1_RECEIPT}`);
  const raw: unknown = parseUniqueJson(new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes));
  requireFact(sameKeys(raw, ["format", "project_id", "root_identity", "seed_ref", "seed_sha256", "source_files", "artifact_files", "created_at", "worker_started", "budget_reserved"]), "D1_RECEIPT_INVALID");
  const receipt = raw as D1InitReceipt;
  requireFact(receipt.format === "xdev-d1-init-source-1" && receipt.root_identity === identity && receipt.worker_started === false
    && receipt.budget_reserved === false && /^[0-9a-f]{64}$/.test(receipt.seed_sha256), "D1_RECEIPT_INVALID");
  const createdAt = Date.parse(receipt.created_at);
  requireFact(Number.isFinite(createdAt) && new Date(createdAt).toISOString() === receipt.created_at && createdAt <= Date.now(), "D1_RECEIPT_TIME_INVALID");
  requireFact(Array.isArray(receipt.source_files) && Array.isArray(receipt.artifact_files) && receipt.artifact_files.length > 0, "D1_RECEIPT_INVALID");
  const manifest = (entries: FileHash[], prefix: string) => {
    requireFact(entries.every(entry => sameKeys(entry, ["path", "sha256"]) && typeof entry.path === "string"
      && typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/.test(entry.sha256)), "D1_RECEIPT_INVALID");
    requireFact(new Set(entries.map(entry => entry.path)).size === entries.length, "D1_RECEIPT_INVALID");
    for (const entry of entries) requireFact(sha256(readProjectFile(root, `${prefix}${entry.path}`)) === entry.sha256, "D1_SOURCE_DRIFT");
  };
  manifest(receipt.source_files, ""); manifest(receipt.artifact_files, ".xdev/");
  requireFact(isDeepStrictEqual(fileEntries(join(root, ".xdev")), [...receipt.artifact_files.map(entry => entry.path), D1_RECEIPT].sort()), "D1_UNEXPECTED_HISTORY_OR_FILE");
  const seedBytes = readProjectFile(root, receipt.seed_ref);
  requireFact(sha256(seedBytes) === receipt.seed_sha256, "D1_SEED_SOURCE_DRIFT");
  const seed: unknown = parseUniqueJson(new TextDecoder("utf-8", { fatal: true }).decode(seedBytes));
  requireFact(validateProjectModel("designSeed", seed).valid, "D1_SEED_INVALID");
  const typedSeed = seed as DesignSeed;
  requireFact(receipt.project_id === typedSeed.project_id, "D1_PROJECT_DRIFT");
  validateD1SeedLinks(typedSeed);
  requireFact(isDeepStrictEqual(receipt.source_files.map(entry => entry.path), sourceRefs(root, typedSeed, receipt.seed_ref)), "D1_SOURCE_MANIFEST_DRIFT");
  const stateBytes = readProjectFile(root, ".xdev/project-state.json");
  const state = parseUniqueJson(stateBytes.toString("utf8")) as ProjectModelBundle["project_state"];
  requireFact(validateProjectModel("projectState", state).valid && state.readiness.status === "NOT_RUN"
    && state.project_id === typedSeed.project_id, "D1_STATE_INVALID");
  const stateTime = Date.parse(state.updated_at);
  requireFact(Number.isFinite(stateTime) && stateTime <= createdAt && state.readiness.checked_at === state.updated_at, "D1_STATE_TIME_INVALID");
  const bundle = buildProjectModel(typedSeed, () => state.updated_at);
  requireFact(isDeepStrictEqual(receipt.artifact_files, artifactFiles(bundle).map(file => ({ path: file.path, sha256: sha256(`${JSON.stringify(file.value, null, 2)}\n`) }))), "D1_ARTIFACT_MANIFEST_DRIFT");
  for (const file of artifactFiles(bundle)) requireFact(readProjectFile(root, `.xdev/${file.path}`).equals(Buffer.from(`${JSON.stringify(file.value, null, 2)}\n`)), "D1_ARTIFACT_DRIFT");
  return { receipt, receipt_sha256: sha256(receiptBytes), bundle, seed: typedSeed };
}
