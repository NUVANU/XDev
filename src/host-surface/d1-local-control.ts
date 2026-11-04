import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { canonical, productionJobRoot } from "../job-runtime/storage-identity.ts";
import { projectRootIdentity, readVerifiedD1Init, sha256 } from "../project-model/init-receipt.ts";
import { parseD1UniqueJson } from "../job-runtime/contracts.ts";
import { initializeProject, type InitializeProjectOptions } from "../project-model/initialize-project.ts";

function need(ok: unknown, code: string): asserts ok { if (!ok) throw Error(code); }
const keys = (v: unknown, names: string[]): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join("|") === [...names].sort().join("|");
const file = (path: string) => {
  const stat = lstatSync(path);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 1024 * 1024, "D1_CONTROL_FILE_INVALID");
  need(realpathSync.native(path) === path, "D1_CONTROL_FILE_ALIAS");
  return readFileSync(path, "utf8");
};
const json = (path: string): Record<string, unknown> => {
  const bytes = file(path);
  const value = parseD1UniqueJson(bytes);
  need(canonical(value) + "\n" === bytes && !!value && typeof value === "object" && !Array.isArray(value), "D1_CONTROL_FILE_NONCANONICAL");
  return value as Record<string, unknown>;
};
export const d1ControlRoot = (workspaceRoot: string) => join(projectRootIdentity(workspaceRoot).root, ".xdev-d1-control");
const heldLocalLocks = new Set<string>();
export const hasD1LocalControlLock = (controlRoot: string) => heldLocalLocks.has(controlRoot);

/** This directory is project-local and physically bound. No claim of protection
 * against a process with the same filesystem privileges is made. */
export function assertD1LocalControl(workspaceRoot: string, controlRoot: string, projectId: string,
  options: { allowLock?: boolean; allowNoProfile?: boolean } = {}) {
  const identity = projectRootIdentity(workspaceRoot);
  const expected = join(identity.root, ".xdev-d1-control");
  need(isAbsolute(controlRoot) && resolve(controlRoot) === controlRoot && controlRoot === expected,
    "D1_CONTROL_ROOT_MISMATCH");
  need(existsSync(expected), "D1_CONTROL_BINDING_MISSING_STOP");
  need(lstatSync(expected).isDirectory() && !lstatSync(expected).isSymbolicLink() &&
    realpathSync.native(expected) === expected, "D1_CONTROL_ROOT_INVALID");
  const pending = json(join(expected, "pending-init.json"));
  need(keys(pending, ["format", "root_identity", "seed_sha256", "request_marker", "created_at"])
    && pending.format === "xdev-d1-pending-init-1" && pending.root_identity === identity.identity
    && typeof pending.seed_sha256 === "string" && /^[0-9a-f]{64}$/.test(pending.seed_sha256)
    && typeof pending.request_marker === "string" && /^[0-9a-f-]{36}$/.test(pending.request_marker),
    "D1_CONTROL_PENDING_INVALID");
  need(existsSync(join(expected, "binding.json")), "D1_CONTROL_BINDING_MISSING_STOP");
  const binding = json(join(expected, "binding.json"));
  const init = readVerifiedD1Init(identity.root);
  need(keys(binding, ["format", "root_identity", "project_id", "receipt_sha256", "control_root", "pending_sha256"])
    && binding.format === "xdev-d1-local-control-1" && binding.root_identity === identity.identity
    && binding.project_id === projectId && binding.project_id === init.receipt.project_id
    && binding.receipt_sha256 === init.receipt_sha256 && binding.control_root === expected
    && binding.pending_sha256 === sha256(file(join(expected, "pending-init.json")))
    && pending.seed_sha256 === init.receipt.seed_sha256, "D1_CONTROL_BINDING_DRIFT");
  const entries = readdirSync(expected).sort();
  const allowed = new Set(["pending-init.json", "binding.json", "profile-request.json", "profile-snapshot.json", "profile-evidence",
    "d1-intake-requests", `recoverable-jobs-${sha256(projectId)}`]);
  if(options.allowLock)allowed.add("project.lock");
  need(entries.every(name => allowed.has(name)), "D1_CONTROL_UNEXPECTED_ENTRY");
  if(entries.includes("project.lock")){
    const lock=join(expected,"project.lock"),stat=lstatSync(lock);
    need(options.allowLock&&stat.isDirectory()&&!stat.isSymbolicLink()&&readdirSync(lock).length===0,
      "D1_CONTROL_WRITER_UNKNOWN");
  }
  if (!options.allowNoProfile) need(entries.includes("profile-request.json"), "D1_PROFILE_REQUEST_MISSING");
  if (entries.includes("profile-request.json")) json(join(expected, "profile-request.json"));
  let snapshotRequest: string | null = null;
  let snapshotBinding: { request_id: string; profile_sha256: string; root_identity: string;
    project_id: string; receipt_sha256: string } | null = null;
  if (entries.includes("profile-snapshot.json")) {
    const snapshot = json(join(expected, "profile-snapshot.json"));
    need(keys(snapshot, ["format", "request_id", "profile_sha256", "root_identity", "project_id", "receipt_sha256"])
      && snapshot.format === "xdev-d1-profile-snapshot-1"
      && typeof snapshot.request_id === "string" && /^[0-9a-f-]{36}$/.test(snapshot.request_id)
      && typeof snapshot.profile_sha256 === "string" && /^[0-9a-f]{64}$/.test(snapshot.profile_sha256)
      && snapshot.root_identity === identity.identity && snapshot.project_id === projectId
      && snapshot.receipt_sha256 === init.receipt_sha256,
      "D1_PROFILE_SNAPSHOT_INVALID");
    snapshotRequest = snapshot.request_id as string;
    snapshotBinding = snapshot as { request_id: string; profile_sha256: string;
      root_identity: string; project_id: string; receipt_sha256: string };
    need(entries.includes("profile-request.json")
      && sha256(file(join(expected, "profile-request.json"))) === snapshot.profile_sha256,
      "D1_PROFILE_SNAPSHOT_PARTIAL_OR_DRIFT_STOP");
  }
  for (const name of entries.filter(n => n === "profile-evidence" || n === "d1-intake-requests" || n.startsWith("recoverable-jobs-"))) {
    const dir = join(expected, name), stat = lstatSync(dir);
    need(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync.native(dir) === dir,
      "D1_CONTROL_DIRECTORY_INVALID");
    const children = readdirSync(dir);
    if (name === "profile-evidence") need(children.length <= 9, "D1_PROFILE_EVIDENCE_LIMIT");
    else {
      need(children.filter(child => child.endsWith(".json")).length <= 1,
        "D1_CONTROL_MULTIPLE_JOBS_STOP");
      need(children.filter(child => child.endsWith(".lock")).length <= (options.allowLock ? 1 : 0)
        && children.length <= (options.allowLock ? 2 : 1), "D1_CONTROL_WRITER_UNKNOWN");
    }
    for (const child of children) {
      if (child.endsWith(".lock") && options.allowLock) continue;
      need(name === "profile-evidence" ? /^[0-9a-f]{64}\.json$/.test(child) :
        /^[0-9a-f-]{36}\.json$/.test(child), "D1_CONTROL_UNEXPECTED_ENTRY");
      json(join(dir, child));
    }
  }
  if (snapshotRequest) {
    const journal = join(productionJobRoot(expected, projectId), `${snapshotRequest}.json`);
    const index = join(expected, "d1-intake-requests", `${snapshotRequest}.json`);
    need((existsSync(journal) && existsSync(index)) ||
      (options.allowLock && entries.includes("project.lock")),
      "D1_PROFILE_SNAPSHOT_PARTIAL_OR_DRIFT_STOP");
  }
  // Any lock left after a process dies is an unknown writer, not a stale lease.
  return { root: expected, binding, init, jobRoot: productionJobRoot(expected, projectId),
    snapshot: snapshotBinding };
}

export function withD1LocalControlLock<T>(workspaceRoot: string, controlRoot: string,
  projectId: string, action: () => T): T {
  const control = assertD1LocalControl(workspaceRoot, controlRoot, projectId, { allowNoProfile: true });
  const lock = join(control.root, "project.lock");
  // A concurrent caller fails closed. An unknown lock is never removed by another caller.
  mkdirSync(lock, { mode: 0o700 });
  const stat = lstatSync(lock), identity = `${stat.dev}:${stat.ino}`;
  need(!heldLocalLocks.has(control.root), "D1_CONTROL_LOCK_REENTRY");
  heldLocalLocks.add(control.root);
  try { return action(); }
  finally {
    heldLocalLocks.delete(control.root);
    const end = lstatSync(lock);
    need(end.isDirectory() && `${end.dev}:${end.ino}` === identity, "D1_CONTROL_LOCK_OWNERSHIP_LOST");
    rmdirSync(lock);
  }
}

export function initializeD1LocalProject(options: InitializeProjectOptions) {
  need(!options.fileSystem && !!options.d1IntakeSource, "D1_NATIVE_INIT_REQUIRED");
  const root = projectRootIdentity(options.targetRoot).root, control = join(root, ".xdev-d1-control");
  need(!existsSync(join(root, ".xdev")) && !existsSync(control), "D1_INIT_EXISTING_HISTORY_STOP");
  mkdirSync(control, { mode: 0o700 });
  const pending = { format: "xdev-d1-pending-init-1", root_identity: projectRootIdentity(root).identity,
    seed_sha256: sha256(options.d1IntakeSource.seedBytes), request_marker: randomUUID(),
    created_at: new Date().toISOString() };
  writeFileSync(join(control, "pending-init.json"), canonical(pending) + "\n", { flag: "wx", mode: 0o600 });
  const result = initializeProject(options);
  const init = readVerifiedD1Init(root);
  need(init.receipt.project_id === result.projectId, "D1_CONTROL_INIT_DRIFT");
  const binding = { format: "xdev-d1-local-control-1", root_identity: pending.root_identity,
    project_id: result.projectId, receipt_sha256: init.receipt_sha256, control_root: control,
    pending_sha256: sha256(file(join(control, "pending-init.json"))) };
  writeFileSync(join(control, "binding.json"), canonical(binding) + "\n", { flag: "wx", mode: 0o600 });
  assertD1LocalControl(root, control, result.projectId, { allowNoProfile: true });
  return result;
}
