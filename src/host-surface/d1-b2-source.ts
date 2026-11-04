import { join, dirname, resolve, relative, isAbsolute, posix, sep } from 'node:path';
import { readdirSync, existsSync, lstatSync, realpathSync, readFileSync, readlinkSync,
  openSync, fstatSync, readSync, closeSync, constants, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonical } from '../job-runtime/storage-identity.ts';
import { B2_GUARANTEES, b2Exact as exact, b2Need as need, b2Hash, b2Time, b2List, validateB2Event, validateB2NativeEvent,
  type B2Record, type B2Event, type B2Family } from '../job-runtime/d1-b2-contracts.ts';
import { parseD1UniqueJson } from '../job-runtime/contracts.ts';
import { projectRootIdentity, checkedRelativeFile, readProjectFile, sha256 } from '../project-model/init-receipt.ts';
import { decideD1Profile } from './d1-profile-entry.ts';
import type { B2ProjectView } from '../job-runtime/d1-b2-state.ts';

export type Source = { id: string; sha256: string; path: string | null; bytes: string };
export type Domain = { format: 'xdev-b2-domain-2'; mode: 'LOCAL_PREHOST' | 'TEST_ONLY'; protocol_version: 2;
  project_id: string; physical_root: string; physical_identity: string; bootstrap_sha256: string };
export type NativeDomain = Omit<Domain, 'format' | 'mode' | 'protocol_version'> & {
  format: 'xdev-b2-domain-3'; mode: 'NATIVE_PARTIAL' | 'TEST_ONLY_NATIVE'; protocol_version: 3 };
export const jsonBytes = (x: unknown) => canonical(x) + '\n';
export function uuid(x: unknown): asserts x is string { need(typeof x === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(x), 'SOURCE_UUID'); }
export function hash(x: unknown): asserts x is string { need(typeof x === 'string' && /^[0-9a-f]{64}$/.test(x), 'SOURCE_HASH'); }
function word(x: unknown): asserts x is string { need(typeof x === 'string' && x.trim().length > 0 && x.length <= 8192, 'SOURCE_TEXT'); }
const same = (x: unknown, y: unknown) => canonical(x) === canonical(y);
const age = (at: unknown) => { const n = b2Time(at), now = Date.now(); need(n <= now && now - n <= 7 * 86400000, 'SOURCE_AGE'); };
const future = (at: unknown) => need(b2Time(at) > Date.now(), 'SOURCE_EXPIRED');
export function eventId(operation: string, label: string) {
  const h = createHash('sha256').update(`${operation}:${label}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Actual byte/physical identities shared by the port and fixed recorder. No approval is inferred here. */
export function nativeFileIdentity(path: string, allowDependencyLink = false) {
  need(resolve(path) === path, 'SOURCE_ALIAS');
  const s = lstatSync(path, { bigint: true });
  need(allowDependencyLink || !s.isSymbolicLink() && realpathSync.native(path) === path, 'SOURCE_ALIAS');
  if (s.isFile()) need(s.nlink === 1n, 'SOURCE_HARDLINK');
  return sha256(`${path}\0${s.dev}:${s.ino}:${s.birthtimeNs}`);
}
export function nativeMember(root: string, path: string) {
  checkedRelativeFile(path); const bytes = readProjectFile(root, path), physical = join(root, path);
  need(bytes.length <= 16 * 1024 * 1024, 'MEMBER_SIZE');
  return { path, bytes: bytes.length, sha256: sha256(bytes), identity: nativeFileIdentity(physical) };
}
export function nativeManifestHash(value: unknown) {
  // Dependency manifests have their own explicit 20000-member bound; the v2 JSON/hash bound stays unchanged.
  return sha256(canonical(value));
}
function actualMembers(root: string, excluded: Set<string>) {
  const files: ReturnType<typeof nativeMember>[] = []; let total = 0, entries = 0;
  projectRootIdentity(root);
  const walk = (rel: string) => {
    const dir = join(root, rel); nativeFileIdentity(dir);
    for (const name of readdirSync(dir).sort()) {
      const path = rel ? `${rel}/${name}` : name; checkedRelativeFile(path);
      need(++entries <= 20000, 'MEMBERSHIP_LIMIT');
      if (excluded.has(path)) continue;
      const s = lstatSync(join(root, path)); need(!s.isSymbolicLink(), 'SOURCE_ALIAS');
      if (s.isDirectory()) walk(path);
      else { need(s.isFile(), 'SOURCE_KIND'); const m = nativeMember(root, path); total += m.bytes;
        need(total <= 256 * 1024 * 1024, 'MEMBERSHIP_SIZE'); files.push(m); }
    }
  }; walk(''); return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function nativeDependencyManifest(runtime: B2Record) {
  exact(runtime.dependencies, ['root', 'identity', 'manifest_sha256']); const d = runtime.dependencies;
  // DEP-PNPM-01 applies only to this enrolled dependency tree. Source/record/runtime files
  // still use nativeMember/nativeFileIdentity and their original nlink=1/no-link rules.
  const root = resolve('O:/Codex Project/XDev/implementation/d1-codex-plugin/node_modules');
  need(d.root === root && realpathSync.native(root) === root, 'DEPENDENCY_FIXED_ROOT');
  need(nativeFileIdentity(root) === d.identity, 'DEPENDENCY_IDENTITY');
  for (let path = root; ; path = dirname(path)) {
    const s = lstatSync(path, { bigint: true });
    need(s.isDirectory() && !s.isSymbolicLink() && realpathSync.native(path) === path, 'DEPENDENCY_ROOT_ALIAS');
    if (dirname(path) === path) break;
  }
  const began = Date.now(), checkTime = () => need(Date.now() - began <= 120000, 'DEPENDENCY_METADATA_TIMEOUT');
  const fileId = (path: string, s: BigIntStats) => sha256(`${path}\0${s.dev}:${s.ino}:${s.birthtimeNs}`);
  const times = (s: BigIntStats) => ({ mtime_ns: String(s.mtimeNs), ctime_ns: String(s.ctimeNs) });
  const stamp = (s: BigIntStats) => [s.dev, s.ino, s.birthtimeNs, s.mtimeNs, s.ctimeNs, s.size, s.nlink, s.mode].map(String).join(':');
  const inside = (path: string) => { const r = relative(root, path); return r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r); };
  const once = () => {
    checkTime(); const rs = lstatSync(root, { bigint: true });
    const directories: B2Record[] = [], files: B2Record[] = [], links: B2Record[] = [], seen = new Set<string>();
    let entries = 0, total = 0;
    const entry = (path: string) => {
      checkTime(); need(++entries <= 20000, 'DEPENDENCY_ENTRY_BOUNDS');
      need(!seen.has(path.toLowerCase()), 'DEPENDENCY_PATH_CASE_COLLISION'); seen.add(path.toLowerCase());
    };
    const walk = (path: string, rel: string, depth: number) => {
      need(depth <= 64, 'DEPENDENCY_DEPTH_BOUNDS'); entry(rel);
      const ds = lstatSync(path, { bigint: true });
      need(ds.isDirectory() && !ds.isSymbolicLink() && realpathSync.native(path) === path, 'DEPENDENCY_DIRECTORY_ALIAS');
      directories.push({ path: rel, identity: fileId(path, ds), ...times(ds) });
      for (const name of readdirSync(path).sort()) {
        need(name !== '.' && name !== '..' && !/[\\/:\x00]/.test(name), 'DEPENDENCY_PATH_COMPONENT');
        const child = join(path, name), cr = rel ? rel + '/' + name : name, before = lstatSync(child, { bigint: true }); checkTime();
        if (before.isSymbolicLink()) {
          entry(cr); need(links.length < 32, 'DEPENDENCY_LINK_BOUNDS');
          const raw = readlinkSync(child), target = realpathSync.native(child), ts = lstatSync(target, { bigint: true });
          need(inside(target) && ts.isDirectory() && !ts.isSymbolicLink(), 'DEPENDENCY_LINK_TARGET');
          need(resolve(dirname(child), raw) === target, 'DEPENDENCY_LINK_TARGET_ALIAS');
          links.push({ path: cr, kind: 'DIRECTORY_LINK', identity: fileId(child, before), raw_target: raw,
            target_path: relative(root, target).replaceAll('\\', '/'), target_identity: fileId(target, ts), ...times(before) });
          need(stamp(lstatSync(child, { bigint: true })) === stamp(before) && readlinkSync(child) === raw &&
            realpathSync.native(child) === target && stamp(lstatSync(target, { bigint: true })) === stamp(ts), 'DEPENDENCY_LINK_READ_DRIFT');
        } else if (before.isDirectory()) walk(child, cr, depth + 1);
        else {
          entry(cr);
          need(before.isFile() && before.nlink >= 1n && before.size <= 16n * 1024n * 1024n && realpathSync.native(child) === child, 'DEPENDENCY_FILE_TYPE_SIZE_ALIAS');
          total += Number(before.size); need(total <= 256 * 1024 * 1024, 'DEPENDENCY_BYTE_BOUNDS');
          const fd = openSync(child, constants.O_RDONLY); let bytes: Buffer;
          try {
            need(stamp(fstatSync(fd, { bigint: true })) === stamp(before), 'DEPENDENCY_FILE_OPEN_DRIFT');
            bytes = Buffer.alloc(Number(before.size)); let offset = 0;
            while (offset < bytes.length) { checkTime(); const n = readSync(fd, bytes, offset, bytes.length - offset, null);
              need(n > 0, 'DEPENDENCY_FILE_SHORT_READ'); offset += n; }
            need(readSync(fd, Buffer.alloc(1), 0, 1, null) === 0 && stamp(fstatSync(fd, { bigint: true })) === stamp(before), 'DEPENDENCY_FILE_CONTENT_DRIFT');
          } finally { closeSync(fd); }
          need(stamp(lstatSync(child, { bigint: true })) === stamp(before) && realpathSync.native(child) === child, 'DEPENDENCY_FILE_PATH_DRIFT');
          files.push({ path: cr, bytes: bytes.length, sha256: sha256(bytes), identity: fileId(child, before), nlink: String(before.nlink), ...times(before) });
        }
      }
      need(stamp(lstatSync(path, { bigint: true })) === stamp(ds) && realpathSync.native(path) === path, 'DEPENDENCY_DIRECTORY_READ_DRIFT');
    };
    walk(root, '', 0);
    const dirs = new Map(directories.map(d => [d.path as string, d]));
    need(dirs.get('')?.identity === fileId(root, rs), 'DEPENDENCY_ROOT_READ_DRIFT');
    for (const link of links) {
      need(dirs.get(link.target_path)?.identity === link.target_identity, 'DEPENDENCY_LINK_TARGET_IDENTITY');
      for (let p = link.target_path as string; ; p = posix.dirname(p)) {
        need(dirs.has(p === '.' ? '' : p), 'DEPENDENCY_LINK_TARGET_ANCESTOR'); if (p === '' || p === '.') break;
      }
    }
    const order = (a: B2Record, b: B2Record) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    checkTime(); return { format: 'xdev-b2-dependencies-3-pnpm-topology-1', root, root_identity: fileId(root, rs),
      directories: directories.sort(order), files: files.sort(order), links: links.sort(order) };
  };
  const manifest = once(), second = once();
  need(same(manifest, second), 'DEPENDENCY_DOUBLE_READ_DRIFT'); checkTime();
  need(nativeManifestHash(manifest) === d.manifest_sha256, 'DEPENDENCY_DRIFT'); return manifest;
}
// These three readers share only a synchronous caller's fresh source check. Nothing
// is stored on a bundle/store, and retained readers are revoked when work returns.
export type B2NativeSourceCheck = {
  productManifest(packageRoot: string, runtime: B2Record): ReturnType<typeof readNativeProductManifest>;
  environment(root: string, runtime: B2Record): ReturnType<typeof readNativeEnvironment>;
  currentSubject(root: string, policy: B2Record, contractRef: B2Record): ReturnType<typeof readNativeCurrentSubject>;
};
export function withB2NativeSourceCheck<T>(work: (read: B2NativeSourceCheck) => T): T {
  let active = true;
  const dependencies = new Map<string, ReturnType<typeof nativeDependencyManifest>>();
  const environments = new Map<string, ReturnType<typeof readNativeEnvironment>>();
  const dependency = (runtime: B2Record) => {
    need(active, 'SOURCE_CHECK_CLOSED');
    // Full runtime pins, not just a path/name, select a freshly verified result.
    const key = canonical(runtime); let result = dependencies.get(key);
    if (!result) { result = nativeDependencyManifest(runtime); dependencies.set(key, result); }
    need(nativeManifestHash(result) === runtime.dependencies.manifest_sha256, 'DEPENDENCY_DRIFT');
    return result;
  };
  const environment = (root: string, runtime: B2Record) => {
    need(active, 'SOURCE_CHECK_CLOSED');
    const key = canonical({ root, runtime }); let result = environments.get(key);
    if (!result) {
      result = readNativeEnvironment(root, structuredClone(runtime), () => dependency(runtime));
      environments.set(key, result);
    }
    need(same(result.runtime, runtime), 'ENVIRONMENT_DRIFT');
    return structuredClone(result);
  };
  const read: B2NativeSourceCheck = {
    productManifest(packageRoot, runtime) {
      need(active, 'SOURCE_CHECK_CLOSED');
      return readNativeProductManifest(packageRoot, runtime, dependency(runtime));
    },
    environment,
    currentSubject(root, policy, contractRef) {
      need(active, 'SOURCE_CHECK_CLOSED');
      return readNativeCurrentSubject(root, policy, contractRef, environment(root, policy.runtime));
    },
  };
  try { return work(read); } finally { active = false; dependencies.clear(); environments.clear(); }
}
export function nativeProductManifest(packageRoot: string, runtime: B2Record): ReturnType<typeof readNativeProductManifest> {
  return withB2NativeSourceCheck(read => read.productManifest(packageRoot, runtime));
}
function readNativeProductManifest(packageRoot: string, runtime: B2Record, dependencies: ReturnType<typeof nativeDependencyManifest>) {
  const excluded: B2Record[] = [];
  const dep = join(packageRoot, 'node_modules'), deployment = join(packageRoot, '.xdev-accepted-deployment');
  if (existsSync(dep)) {
    need(realpathSync.native(dep) === runtime.dependencies.root, 'DEPENDENCY_LINK_DRIFT');
    excluded.push({ path: 'node_modules', reason: 'PINNED_DEPENDENCIES', identity: nativeFileIdentity(dep, true), sha256: nativeManifestHash(dependencies) });
  }
  excluded.push({ path: '.xdev-accepted-deployment', reason: 'DEPLOYMENT_AUTHORITY',
    identity: existsSync(deployment) ? nativeFileIdentity(deployment) : 'ABSENT', sha256: null });
  return { format: 'xdev-b2-product-manifest-3', files: actualMembers(packageRoot, new Set(['node_modules', '.xdev-accepted-deployment'])), excluded };
}
export function nativeCandidate(root: string, policy: B2Record) {
  const managed = policy.scope.candidate_exclusions as string[]; const skip = new Set<string>(managed);
  const excluded: B2Record[] = [];
  for (const path of managed) { checkedRelativeFile(path);
    need(policy.scope.managed_inputs.includes(path) && !scopeContains(policy.scope.allowed_paths, path), 'CANDIDATE_EXCLUSION');
    if (existsSync(join(root, path))) { need(lstatSync(join(root, path)).isFile(), 'CANDIDATE_EXCLUSION');
      excluded.push({ path, reason: 'MANAGED_INPUT', identity: nativeFileIdentity(join(root, path)) }); }
  }
  const ctrl = join(root, '.xdev-d1-control');
  skip.add('.xdev-d1-control');
  if (existsSync(ctrl)) excluded.push({ path: '.xdev-d1-control', reason: 'CONTROL', identity: nativeFileIdentity(ctrl) });
  const dep = join(root, 'node_modules');
  if (existsSync(dep)) { need(realpathSync.native(dep) === policy.runtime.dependencies.root, 'DEPENDENCY_LINK_DRIFT');
    skip.add('node_modules'); excluded.push({ path: 'node_modules', reason: 'PINNED_DEPENDENCIES', identity: nativeFileIdentity(dep, true) }); }
  return { format: 'xdev-b2-candidate-3', files: actualMembers(root, skip),
    excluded: excluded.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}
export function scopeContains(scopes: string[], path: string) {
  checkedRelativeFile(path);
  return scopes.some(s => s.endsWith('/**') ? path.startsWith(s.slice(0, -2)) : s === path);
}
export function nativeEnvironment(root: string, runtime: B2Record): ReturnType<typeof readNativeEnvironment> {
  return withB2NativeSourceCheck(read => read.environment(root, runtime));
}
function readNativeEnvironment(root: string, runtime: B2Record, dependency: () => unknown) {
  exact(runtime, ['node', 'powershell', 'recorder', 'dependencies', 'environment_files']);
  for (const key of ['node', 'powershell', 'recorder']) {
    const f = runtime[key]; exact(f, ['path', 'identity', 'sha256']); hash(f.sha256);
    need(nativeFileIdentity(f.path) === f.identity && sha256(readFileSync(f.path)) === f.sha256, 'ENVIRONMENT_DRIFT');
  }
  need(runtime.node.path === process.execPath, 'NODE_RUNTIME_MISMATCH'); dependency();
  const files = runtime.environment_files.map((ref: B2Record) => {
    exact(ref, ['path', 'sha256']); const m = nativeMember(root, ref.path);
    need(m.sha256 === ref.sha256, 'ENVIRONMENT_DRIFT'); return m;
  });
  return { format: 'xdev-b2-environment-3', platform: process.platform, architecture: process.arch,
    node_version: process.version, runtime, environment_files: files };
}
export function nativeCurrentSubject(root: string, policy: B2Record, contractRef: B2Record): ReturnType<typeof readNativeCurrentSubject> {
  return withB2NativeSourceCheck(read => read.currentSubject(root, policy, contractRef));
}
/** Checks already source-pinned Task/operative/policy values; this pure check is not source authentication. */
export function assertB2ScopeReviewBinding(operative: B2Record, task: B2Record, policy: B2Record) {
  for (const value of [operative, task, policy]) b2List(value.required_guarantees, 0, 7,
    g => need(B2_GUARANTEES.includes(g), 'UNSUPPORTED_REQUIRED_GUARANTEE'));
  need(same(operative.required_guarantees, task.required_guarantees), 'TASK_OPERATIVE_GUARANTEES');
  need(operative.required_guarantees.includes('scope_review_v1') === policy.required_guarantees.includes('scope_review_v1'), 'TASK_POLICY_SCOPE_REVIEW');
}
/** Two predeclared, immutable-per-attempt material slots; ordinal is the existing Job attempt, not role ordinal. */
export function b2ScopeReviewPaths(ordinal: number) {
  need(ordinal === 1 || ordinal === 2, 'SCOPE_ATTEMPT');
  const prefix = `scope-review-inputs/attempt-${ordinal}/`;
  return { diff: prefix + 'change.diff', request: prefix + 'reviewer-read.json' };
}
/** Preserve every original role READ row, coverage item and user path. Only the opposite attempt's
 * two fixed derived-material paths may be omitted, only for a marked independent Review.
 * Empty rows and missing current material are rejected, never silently discarded.
 */
export function b2RoleReadPlan(policy: B2Record, binding: B2Record, role: B2Record, attemptOrdinal: number): B2Record[] {
  const original = policy.read_plan.filter((p: B2Record) => p.role_ordinal === role.ordinal);
  if (!binding.operative.required_guarantees.includes('scope_review_v1') || !role.purposes.includes('review')) return structuredClone(original);
  need(role.actor_policy === 'INDEPENDENT' && !role.purposes.includes('worker'), 'SCOPE_REVIEW_INDEPENDENCE');
  const current = b2ScopeReviewPaths(attemptOrdinal), other = b2ScopeReviewPaths(attemptOrdinal === 1 ? 2 : 1);
  const fixed = [...Object.values(current), ...Object.values(other)];
  need(fixed.every(path => policy.scope.managed_inputs.includes(path) && policy.scope.candidate_exclusions.includes(path) &&
    !scopeContains(policy.scope.allowed_paths, path)), 'SCOPE_ATTEMPT_MATERIAL_DECLARATION');
  const selected = original.map((p: B2Record) => ({ ...structuredClone(p), paths: p.paths.filter((path: string) =>
    path !== other.diff && path !== other.request) }));
  need(selected.every((p: B2Record) => p.paths.length > 0) && Object.values(current).every(path =>
    selected.some((p: B2Record) => p.paths.includes(path))), 'SCOPE_ATTEMPT_READ_PLAN');
  return selected;
}
function readNativeCurrentSubject(root: string, policy: B2Record, contractRef: B2Record, environment: ReturnType<typeof readNativeEnvironment>) {
  exact(contractRef, ['id', 'sha256']); need(contractRef.id.startsWith('file:'), 'SOURCE_CONTRACT');
  const path = contractRef.id.slice(5), body = readProjectFile(root, path);
  need(sha256(body) === contractRef.sha256, 'SOURCE_DRIFT');
  const task = parseD1UniqueJson(body.toString('utf8')) as B2Record;
  need(task.format === 'xdev-b2-task-source-3', 'SOURCE_CONTRACT');
  for (const ac of task.criteria) { const bytes = readProjectFile(root, ac.source_ref.path);
    need(sha256(bytes) === ac.source_ref.sha256, 'SOURCE_DRIFT');
    const value = parseD1UniqueJson(bytes.toString('utf8')) as B2Record;
    need(value.format === 'xdev-b2-criterion-source-3' && value.id === ac.id && value.text === ac.text, 'SOURCE_CRITERION'); }
  const candidate = nativeCandidate(root, policy);
  let head = 'NO_GIT'; const git = join(root, '.git');
  if (existsSync(git)) {
    need(lstatSync(git).isDirectory(), 'GIT_INDIRECTION_UNSUPPORTED');
    const text = readProjectFile(root, '.git/HEAD').toString('utf8').trim();
    if (/^[0-9a-f]{40}$/.test(text)) head = text;
    else { need(/^ref: refs\/[a-zA-Z0-9_./-]+$/.test(text), 'GIT_HEAD_UNSUPPORTED');
      head = readProjectFile(root, `.git/${text.slice(5)}`).toString('utf8').trim(); need(/^[0-9a-f]{40}$/.test(head), 'GIT_HEAD_UNSUPPORTED'); }
  }
  const candidateSha = nativeManifestHash(candidate);
  const subject = { physical_root: root, physical_identity: projectRootIdentity(root).identity,
    workspace_id: `workspace:${policy.project.project_id}:${policy.epoch_id}`, head,
    candidate_sha256: candidateSha, environment_sha256: nativeManifestHash(environment),
    contract_sha256: contractRef.sha256, criteria_sha256: b2Hash(task.criteria), integration_target_sha256: candidateSha };
  return { subject, candidate, environment, task, taskBody: body.toString('utf8') };
}
export function appendEvent(events: B2Event[], kind: 'project' | 'job', command: B2Record, operation: string, label: string, at: string) {
  return appendFamilyEvent(events, kind, command, operation, label, at, 2);
}
export function appendNativeEvent(events: B2Event[], kind: 'project' | 'job', command: B2Record, operation: string, label: string, at: string) {
  return appendFamilyEvent(events, kind, command, operation, label, at, 3);
}
function appendFamilyEvent(events: B2Event[], kind: 'project' | 'job', command: B2Record, operation: string, label: string, at: string, family: B2Family) {
  const body = { format: `xdev-b2-${kind}-event-${family}`, revision: events.length, previous_sha256: events.at(-1)?.sha256 ?? null,
    operation_id: eventId(operation, label), occurred_at: at, command };
  const e = (family === 2 ? validateB2Event : validateB2NativeEvent)({ ...body, sha256: b2Hash(body) }, kind); events.push(e); return e;
}
export const eventRef = (e: B2Event) => ({ id: e.operation_id, sha256: e.sha256 });
export function domainSource(d: Domain | NativeDomain): Source { const bytes = jsonBytes(d); return { id: 'B2_DOMAIN', sha256: sha256(bytes), path: null, bytes }; }
export function verifySource(root: string, s: Source) {
  exact(s, ['id', 'sha256', 'path', 'bytes']); word(s.id); hash(s.sha256);
  need(typeof s.bytes === 'string' && Buffer.byteLength(s.bytes) <= 1048576 && sha256(s.bytes) === s.sha256, 'SOURCE_BYTES');
  if (s.path !== null) { checkedRelativeFile(s.path); need(s.id === `file:${s.path}` && readProjectFile(root, s.path).equals(Buffer.from(s.bytes)), 'SOURCE_DRIFT'); }
}
class Reader {
  root: string; sources: Source[] = []; family: B2Family;
  constructor(root: string, family: B2Family = 2) { this.root = projectRootIdentity(root).root; this.family = family; }
  read(path: string, expected?: string): B2Record {
    checkedRelativeFile(path); need(!path.split('/')[0]!.startsWith('.xdev'), 'SOURCE_CONTROL_PATH');
    const bytes = new TextDecoder('utf-8', { fatal: true }).decode(readProjectFile(this.root, path));
    need(Buffer.byteLength(bytes) <= 1048576, 'SOURCE_SIZE'); const digest = sha256(bytes);
    need(expected === undefined || digest === expected, 'SOURCE_DRIFT');
    const value = parseD1UniqueJson(bytes); exact(value, Object.keys(value as object));
    need(jsonBytes(value) === bytes, 'SOURCE_NONCANONICAL');
    const old = this.sources.find(s => s.path === path); need(!old || old.sha256 === digest, 'SOURCE_REBOUND');
    if (!old) this.sources.push({ id: `file:${path}`, sha256: digest, path, bytes });
    need(this.sources.length <= 64, 'SOURCE_CAPACITY'); return value;
  }
  ref(ref: unknown) { exact(ref, ['path', 'sha256']); hash(ref.sha256); return this.read(ref.path, ref.sha256); }
  eventRef(ref: B2Record) { return { id: `file:${ref.path}`, sha256: ref.sha256 }; }
}
function scopeIdentity(x: B2Record, project: B2Record) {
  uuid(x.project_id); need(x.project_id === project.project_id && x.root_identity === project.physical_identity, 'SOURCE_PROJECT');
}
function decision(reader: Reader, ref: unknown, action: unknown, project: B2Record, deadline: string, historical = false) {
  const d = reader.ref(ref); exact(d, ['format', 'kind', 'project_id', 'root_identity', 'action_sha256', 'deadline', 'owner_text', 'created_at']);
  need(d.format === `xdev-b2-decision-source-${reader.family}` && d.kind === 'COORDINATOR_RECORDED', 'SOURCE_DECISION');
  scopeIdentity(d, project); word(d.owner_text); hash(d.action_sha256);
  if (historical && reader.family === 3) need(b2Time(d.created_at) <= Date.now() && b2Time(d.created_at) < b2Time(d.deadline), 'SOURCE_TIME');
  else { age(d.created_at); future(d.deadline); }
  need(d.action_sha256 === b2Hash(action) && d.deadline === deadline, 'SOURCE_AUTHORITY');
}
export function allocationFromSource(readerRoot: string, sourcePath: string, project: B2Record,
  previous: B2ProjectView | null, suppliedReader?: Reader) {
  const r = suppliedReader ?? new Reader(readerRoot), a = r.read(sourcePath);
  exact(a, ['format', 'operation_id', 'allocation_id', 'project_id', 'root_identity', 'previous_project_head',
    'previous_allocation_id', 'previous_spent_calls', 'previous_spent_attempts', 'previous_reserved_calls',
    'call_cap', 'attempt_cap', 'deadline', 'decision_source']);
  need(a.format === `xdev-b2-allocation-source-${r.family}`, 'SOURCE_ALLOCATION'); uuid(a.operation_id); uuid(a.allocation_id); scopeIdentity(a, project); future(a.deadline);
  need(Number.isSafeInteger(a.call_cap) && a.call_cap >= 0 && a.call_cap <= 4096 && Number.isSafeInteger(a.attempt_cap) && a.attempt_cap >= 0 && a.attempt_cap <= 512, 'SOURCE_CAP');
  need(a.previous_project_head === (previous?.head ?? null) && a.previous_allocation_id === (previous?.allocation?.allocation_id ?? null) &&
    a.previous_spent_calls === (previous?.spent_calls ?? 0) && a.previous_spent_attempts === (previous?.spent_attempts ?? 0) &&
    a.previous_reserved_calls === (previous?.reservations.filter(z => !z.sent).length ?? 0), 'SOURCE_LEDGER');
  const { decision_source, ...action } = a; decision(r, decision_source, action, project, a.deadline);
  return { a, sources: r.sources, reader: r };
}
export function freshRoot(root: string) {
  projectRootIdentity(root); need(!existsSync(join(root, '.xdev')) && !existsSync(join(root, '.xdev-d1-control')) &&
    !readdirSync(root).some(n => n.startsWith('.xdev.staging-') || n.startsWith('.xdev-d1-')), 'EXISTING_HISTORY_STOP');
}
export function bootstrapSources(root: string, path: string) {
  const result = bootstrapFamilySources(root, path, 2, 'LOCAL_PREHOST'); return { ...result, domain: result.domain as Domain };
}
export function bootstrapNativeSources(root: string, path: string, mode: NativeDomain['mode']) {
  need(['NATIVE_PARTIAL', 'TEST_ONLY_NATIVE'].includes(mode), 'DOMAIN_MISMATCH');
  const result = bootstrapFamilySources(root, path, 3, mode); return { ...result, domain: result.domain as NativeDomain };
}
function bootstrapFamilySources(root: string, path: string, family: B2Family, mode: Domain['mode'] | NativeDomain['mode']) {
  freshRoot(root); const identity = projectRootIdentity(root), r = new Reader(root, family), b = r.read(path);
  exact(b, ['format', 'project_id', 'physical_root', 'physical_identity', 'created_at', 'history', 'allocation_source']);
  need(b.format === `xdev-b2-bootstrap-source-${family}` && b.physical_root === root && b.physical_identity === identity.identity, 'BOOTSTRAP_IDENTITY');
  uuid(b.project_id); age(b.created_at); exact(b.history, ['coverage', 'known_registrations', 'disposition_source', 'unresolved']);
  need(b.history.coverage === 'COMPLETE', 'HISTORY_COVERAGE'); b2List(b.history.unresolved, 0, 0, () => {});
  b2List(b.history.known_registrations, 0, 64, x => { const v = r.ref(x); exact(v, ['format', 'project_id', 'root_identity', 'protocol', 'unresolved']);
    need(v.format === `xdev-b2-history-source-${family}` && v.protocol === 'FRESH_B2' && v.project_id === b.project_id && v.root_identity === identity.identity, 'HISTORY_BLOCKED');
    b2List(v.unresolved, 0, 0, () => {}); });
  const disposition = r.ref(b.history.disposition_source);
  exact(disposition, ['format', 'kind', 'project_id', 'root_identity', 'known_registrations', 'conclusion', 'owner_text', 'created_at']);
  need(disposition.format === `xdev-b2-history-disposition-${family}` && disposition.kind === 'COORDINATOR_RECORDED' && disposition.conclusion === 'FRESH_B2' &&
    disposition.project_id === b.project_id && disposition.root_identity === identity.identity && same(disposition.known_registrations, b.history.known_registrations), 'HISTORY_BLOCKED');
  word(disposition.owner_text); age(disposition.created_at);
  const bootstrap = r.sources.find(s => s.path === path)!;
  const domain = { format: `xdev-b2-domain-${family}`, mode, protocol_version: family, project_id: b.project_id,
    physical_root: root, physical_identity: identity.identity, bootstrap_sha256: bootstrap.sha256 } as Domain | NativeDomain;
  const ds = domainSource(domain), project = { project_id: b.project_id, physical_root: root, physical_identity: identity.identity,
    control_root: join(root, '.xdev-d1-control'), init_ref: { id: ds.id, sha256: ds.sha256 } };
  exact(b.allocation_source, ['path', 'sha256']); r.ref(b.allocation_source);
  const allocation = allocationFromSource(root, b.allocation_source.path, project, null, r);
  return { domain, project, operation: allocation.a.operation_id as string, allocation: allocation.a,
    sources: [...r.sources, ds], request_sha256: bootstrap.sha256,
    history_refs: [r.eventRef(b.history.disposition_source), ...b.history.known_registrations.map((x: B2Record) => r.eventRef(x))] };
}
function checkedScope(x: unknown): string {
  word(x); const path = x.endsWith('/**') ? x.slice(0, -3) : x.endsWith('/') ? x.slice(0, -1) : x;
  checkedRelativeFile(path); return path.toLowerCase();
}
export function jobSources(root: string, path: string, p: B2ProjectView, priorSources: Source[], first = true) {
  return jobFamilySources(root, path, p, priorSources, first, 2);
}
export function jobNativeSources(root: string, path: string, p: B2ProjectView, priorSources: Source[], first = true) {
  return jobFamilySources(root, path, p, priorSources, first, 3);
}
function jobFamilySources(root: string, path: string, p: B2ProjectView, priorSources: Source[], first: boolean, family: B2Family) {
  const r = new Reader(root, family), x = r.read(path);
  exact(x, ['format', 'operation_id', 'request_id', 'project_id', 'root_identity', 'created_at', 'work_item', 'change_request',
    'predecessor_job', 'operative', 'profile_request', 'authorization_source', 'history_sources']);
  need(x.format === `xdev-b2-job-source-${family}`, 'SOURCE_JOB'); uuid(x.operation_id); uuid(x.request_id); scopeIdentity(x, p.project);
  if (first) age(x.created_at); else need(b2Time(x.created_at) <= Date.now(), 'SOURCE_TIME');
  word(x.work_item); word(x.change_request); need(p.allocation, 'SOURCE_ALLOCATION');
  if (family === 3 && !first) need(b2Time(x.created_at) < b2Time(p.allocation.deadline), 'SOURCE_EXPIRED');
  else future(p.allocation.deadline);
  exact(x.operative, ['goal', 'contract_ref', 'criteria', 'allowed_scope', 'forbidden_scope', 'risk', 'required_guarantees']);
  const o = x.operative; exact(o.contract_ref, ['id', 'sha256']); need(typeof o.contract_ref.id === 'string' && o.contract_ref.id.startsWith('file:'), 'SOURCE_CONTRACT');
  hash(o.contract_ref.sha256); const contract = r.read(o.contract_ref.id.slice(5), o.contract_ref.sha256);
  exact(contract, ['format', 'goal', 'criteria', 'allowed_scope', 'forbidden_scope', 'risk', 'required_guarantees']);
  need(contract.format === `xdev-b2-task-source-${family}`, 'SOURCE_CONTRACT');
  b2List(contract.criteria, 1, 64, row => { exact(row, ['id', 'text', 'source_ref']); word(row.id); word(row.text);
    const ac = r.ref(row.source_ref); exact(ac, ['format', 'id', 'text']); need(ac.format === `xdev-b2-criterion-source-${family}` && ac.id === row.id && ac.text === row.text, 'SOURCE_CRITERION'); });
  const derived = { goal: contract.goal, contract_ref: o.contract_ref, criteria: contract.criteria.map((c: B2Record) => c.id),
    allowed_scope: contract.allowed_scope, forbidden_scope: contract.forbidden_scope, risk: contract.risk, required_guarantees: contract.required_guarantees };
  need(same(derived, o), 'SOURCE_OPERATIVE');
  b2List(o.allowed_scope, 1, 64, checkedScope); b2List(o.forbidden_scope, 0, 64, checkedScope);
  const allowed = o.allowed_scope.map(checkedScope), forbidden = o.forbidden_scope.map(checkedScope);
  const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
  need(!allowed.some((a: string) => a.startsWith('.xdev') || a === '.git' || forbidden.some((f: string) => overlaps(a, f))), 'SOURCE_SCOPE');
  b2List(o.required_guarantees, 0, 7, g => need(B2_GUARANTEES.includes(g), 'UNSUPPORTED_REQUIRED_GUARANTEE'));
  need(family === 3 || !o.required_guarantees.includes('scope_review_v1'), 'SCOPE_REVIEW_NATIVE_ONLY');
  need(!o.required_guarantees.some((g: string) => ['identity_authentication', 'message_plaintext_equivalence'].includes(g)), 'UNSUPPORTED_REQUIRED_GUARANTEE');
  need(['ordinary', 'isolated_fake_data'].includes(o.risk), 'SOURCE_RISK');
  const profile = x.profile_request;
  need(profile && profile.request_id === x.request_id && profile.goal === o.goal && profile.impact === o.risk, 'SOURCE_PROFILE');
  // The policy's receipt slot binds the new domain's bootstrap digest, not a v1 receipt.
  const ds = priorSources.find(s => s.id === 'B2_DOMAIN')!; const domain = parseD1UniqueJson(ds.bytes) as Domain;
  const pure = decideD1Profile(profile, b2Hash(o), domain.bootstrap_sha256, p.project.project_id, 'quick_verified', o.criteria);
  const purpose = r.read(profile.purpose_source.source_ref, profile.purpose_source.source_sha256);
  exact(purpose, ['format', 'kind', 'goal', 'purpose', 'impact']);
  need(purpose.format === 'xdev-d1-profile-evidence-1' && purpose.kind === 'COORDINATOR_RECORDED' && purpose.goal === profile.goal && purpose.purpose === profile.purpose && purpose.impact === profile.impact, 'SOURCE_PURPOSE');
  for (const ref of profile.facts.evidence_refs) {
    const facts = r.read(ref.path, ref.sha256); exact(facts, ['format', 'fake_data_only', 'production_permissions', 'external_effects', 'reversible']);
    need(facts.format === `xdev-b2-risk-source-${family}` && ['fake_data_only', 'production_permissions', 'external_effects', 'reversible'].every(k => facts[k] === profile.facts[k]), 'SOURCE_RISK_FACTS');
  }
  const { authorization_source, ...action } = x;
  decision(r, authorization_source, { request: action, allocation_id: p.allocation.allocation_id, deadline: p.allocation.deadline }, p.project, p.allocation.deadline, family === 3 && !first);
  b2List(x.history_sources, 0, 64, ref => { r.ref(ref); });
  need(x.predecessor_job === (p.catalog.at(-1)?.binding.job_id ?? null), 'SOURCE_PREDECESSOR');
  const allSources = [...priorSources, ...r.sources];
  need(!allowed.some((a: string) => allSources.some(s => s.path && overlaps(a, s.path.toLowerCase()))), 'SOURCE_SCOPE');
  need(p.catalog.every(c => c.settlement), 'SOURCE_PRIOR_UNSETTLED');
  const binding = { protocol_version: family, job_id: `job:${x.request_id}`, task_id: `task:${x.request_id}:${eventId(x.request_id, 'task')}`,
    project: p.project, operative: o, operative_sha256: b2Hash(o), profile: { ...pure, format: `xdev-d1-profile-decision-${family}`, execution_protocol: family === 2 ? 'B2_TEST_ONLY_PROTOCOL' : 'B2_SOURCE_RULES_PROTOCOL_3' },
    request_id: x.request_id, request_ref: { id: `file:${path}`, sha256: r.sources.find(s => s.path === path)!.sha256 },
    work_item: x.work_item, change_request: x.change_request, predecessor_job: x.predecessor_job,
    history_refs: [...p.events[0]!.command.history.source_refs, ...p.catalog.map(c => eventRef(c.settlement))],
    authorization_ref: r.eventRef(authorization_source), allocation_id: p.allocation.allocation_id, prior_project_head: p.head, project_sequence: p.catalog.length + 1 };
  return { binding, sources: r.sources, operation: x.operation_id as string, request_sha256: binding.request_ref.sha256 };
}
