import { mkdirSync, lstatSync, readdirSync, readFileSync, realpathSync, openSync, writeFileSync, fsyncSync,
  closeSync, renameSync, rmdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { b2Exact as exact, b2Need as need, b2Hash, b2Time, validateB2Inspection, validateB2Journal, validateB2NativeJournal,
  type B2Record, type B2Event } from './d1-b2-contracts.ts';
import { replayProject, replayNativeProject } from './d1-b2-state.ts';
import { inspectB2Structure, inspectB2Pair, inspectB2NativeStructure, inspectB2NativeRules } from './d1-b2-pair.ts';
import { parseD1UniqueJson } from './contracts.ts';
import { projectRootIdentity, readProjectFile, sha256, checkedRelativeFile } from '../project-model/init-receipt.ts';
import { jsonBytes, uuid, hash, domainSource, verifySource, freshRoot, bootstrapSources, allocationFromSource,
  jobSources, appendEvent, eventRef, eventId, type Source, type Domain, type NativeDomain } from '../host-surface/d1-b2-source.ts';
import { buildB2RoleSourcePlan, validateB2StoredSources, roleSourceResponse, roleSourceQuery } from '../host-surface/d1-b2-role-source.ts';
import { openB2NativeBundle, revalidateB2NativeBundle, type B2NativeBundle, type TestNativeContext } from '../host-surface/d1-b2-native-port.ts';
import { NativeSourceError } from '../host-surface/d1-native-records.ts';

type Mode = Domain['mode'] | NativeDomain['mode'];
type AnyDomain = Domain | NativeDomain;
type Journals = Record<string, B2Event[]>;
type Facts = { current_subject: B2Record | null; native_records: B2Record[]; controller_packets: B2Record[] };
type SourceMeta = Omit<Source, 'bytes'>;
type Step = { target: string; before_head: string | null; append: B2Event[]; after_head: string; prepared: string };
type Begin = { format: string; operation_id: string; sequence: number; previous_done_sha256: string | null;
  domain_sha256: string; kind: 'INIT' | 'ALLOCATE' | 'CREATE' | 'TEST' | 'ROLE_SOURCE'; input_path: string; input_sha256: string;
  before_heads: Record<string, string>; after_heads: Record<string, string>; sources: SourceMeta[]; facts: Facts; steps: Step[]; source_proof?: B2Record };
export type B2Loaded = { binding: B2Record; domain: AnyDomain; sources: Source[]; journals: Journals; facts: Facts;
  operations: Array<{ begin: Begin; done_sha256: string }>; structure: ReturnType<typeof inspectB2Structure> | ReturnType<typeof inspectB2NativeStructure> };
type Loaded = B2Loaded;
export type B2Fault = 'AFTER_BEGIN' | 'AFTER_SOURCE' | 'AFTER_PROJECT_INTENT' | 'AFTER_JOB_CREATE' |
  'BEFORE_PROJECT_COMMIT' | 'AFTER_PROJECT_COMMIT_BEFORE_DONE' | 'AFTER_DONE_BEFORE_RESPONSE' | 'PAUSE_AFTER_BEGIN' |
  'WAIT_AFTER_LOCK_RECHECK' | 'WAIT_BEFORE_JOURNAL_PUBLISH' | 'WAIT_BEFORE_DONE_PUBLISH' |
  `WRITE:${string}` | `FSYNC:${string}` | `RENAME:${string}`;
const NONE: Facts = { current_subject: null, native_records: [], controller_packets: [] };
const owned = new Map<string, string>();
const control = (root: string) => join(root, '.xdev-d1-control');
const digest = (x: unknown) => sha256(jsonBytes(x));
const equal = (a: unknown, b: unknown) => jsonBytes(a) === jsonBytes(b);
const kindOf = (target: string): 'project' | 'job' => target === 'project.json' ? 'project' : 'job';
const heads = (j: Journals) => Object.fromEntries(Object.entries(j).sort().map(([k, v]) => [k, v.at(-1)!.sha256]));
function exactEntry(path: string, directory: boolean) {
  const s = lstatSync(path); need(!s.isSymbolicLink() && realpathSync.native(path) === path &&
    (directory ? s.isDirectory() : s.isFile() && s.nlink === 1), 'STORAGE_ALIAS_OR_LINK');
  return s;
}
function idOf(path: string) { const s = exactEntry(path, true); return `${s.dev}:${s.ino}:${s.birthtimeMs}`; }
function readJson(path: string, limit = 64 * 1024 * 1024): B2Record {
  need(exactEntry(path, false).size <= limit, 'STORAGE_SIZE'); const bytes = readFileSync(path, 'utf8');
  const x = parseD1UniqueJson(bytes); exact(x, Object.keys(x as object)); need(jsonBytes(x) === bytes, 'STORAGE_NONCANONICAL'); return x;
}
function names(path: string, expected: string[]) {
  exactEntry(path, true); const actual = readdirSync(path).sort();
  need(equal(actual, [...expected].sort()), 'PARTIAL_COMMIT_STOP:STORAGE_MEMBERSHIP');
}
function treeBytes(path: string): number {
  let count = 0, total = 0;
  const visit = (p: string) => { const s = lstatSync(p); need(++count <= 20000 && !s.isSymbolicLink() && realpathSync.native(p) === p, 'STORAGE_TREE');
    if (s.isDirectory()) for (const n of readdirSync(p)) visit(join(p, n)); else { need(s.isFile() && s.nlink === 1, 'STORAGE_TREE'); total += s.size; }
    need(total <= 256 * 1024 * 1024, 'STORAGE_CAPACITY'); };
  visit(path); return total;
}
function lockNames(path: string) {
  return [...owned.keys()].filter(p => p.startsWith(path + '\\') || p.startsWith(path + '/'));
}
function factsFor(domain: AnyDomain, journals: Journals, sources: Source[], facts: Facts) {
  return { format: domain.protocol_version === 2 ? 'xdev-b2-inspection-test-2' : 'xdev-b2-inspection-native-3', project_events: journals['project.json'],
    job_journals: Object.entries(journals).filter(([k]) => k !== 'project.json').map(([, v]) => v),
    facts: { format: domain.protocol_version === 2 ? 'B2_SYNTHETIC_FACTS_ONLY' : 'B2_SOURCE_DERIVED_RULES_ONLY', coverage: 'COMPLETE', project: journals['project.json']![0]!.command.project,
      source_refs: sources.map(({ id, sha256 }) => ({ id, sha256 })), ...facts }, now: new Date().toISOString() };
}
function sourcesValid(root: string, domain: AnyDomain, sources: Source[]) {
  need(sources.length > 0 && sources.length <= 64 && new Set(sources.map(s => s.id)).size === sources.length, 'SOURCE_CAPACITY_OR_REBOUND');
  const ds = domainSource(domain); need(sources.some(s => equal(s, ds)), 'DOMAIN_SOURCE');
  for (const s of sources) {
    verifySource(root, s); need(domain.protocol_version === 3 || domain.mode === 'TEST_ONLY' || s.path !== null || equal(s, ds), 'SYNTHETIC_SOURCE_IN_LOCAL_ROOT');
  }
}
function checkedState(root: string, domain: AnyDomain, journals: Journals, sources: Source[], facts: Facts) {
  sourcesValid(root, domain, sources);
  for (const [target, events] of Object.entries(journals)) if (target !== 'project.json')
    need(target === `jobs/${events[0]?.command.binding?.job_id?.slice(4)}.json`, 'JOB_FILENAME_BINDING');
  const ds = domainSource(domain), p = journals['project.json']; need(p, 'PROJECT_JOURNAL_MISSING');
  const project = p[0]!.command.project;
  need(equal(project, { project_id: domain.project_id, physical_root: root, physical_identity: domain.physical_identity,
    control_root: control(root), init_ref: { id: ds.id, sha256: ds.sha256 } }), 'DOMAIN_PROJECT');
  const structure = (domain.protocol_version === 2 ? inspectB2Structure : inspectB2NativeStructure)(factsFor(domain, journals, sources, facts));
  need(structure.structurally_complete, `PAIR_STOP:${structure.integrity_reasons.join(',')}`);
  return structure;
}
function assertDomain(root: string, x: unknown, mode: Mode): asserts x is AnyDomain {
  exact(x, ['format', 'mode', 'protocol_version', 'project_id', 'physical_root', 'physical_identity', 'bootstrap_sha256']);
  const actual = projectRootIdentity(root); uuid(x.project_id); hash(x.bootstrap_sha256);
  const family = ['NATIVE_PARTIAL', 'TEST_ONLY_NATIVE'].includes(mode) ? 3 : 2;
  need(x.format === `xdev-b2-domain-${family}` && x.mode === mode && x.protocol_version === family && x.physical_root === root &&
    x.physical_identity === actual.identity, 'DOMAIN_MISMATCH');
}
function mergeSources(old: Source[], additions: Source[]) {
  const all = [...old]; for (const s of additions) { const prior = all.find(x => x.id === s.id); need(!prior || equal(prior, s), 'SOURCE_REBOUND'); if (!prior) all.push(s); }
  need(all.length <= 64, 'SOURCE_CAPACITY'); return all;
}
export function loadB2(root: string, mode: Mode = 'LOCAL_PREHOST'): Loaded {
  need(['LOCAL_PREHOST', 'TEST_ONLY'].includes(mode), 'DOMAIN_MISMATCH'); return loadFamily(root, mode);
}
function loadFamily(root: string, mode: Mode, test?: TestNativeContext): Loaded {
  projectRootIdentity(root); const c = control(root); treeBytes(c);
  const transient = lockNames(c); for (const path of transient) need(owned.get(path) === idOf(path), 'LOCK_OWNERSHIP_LOST');
  names(c, ['binding.json', 'project.json', 'jobs', 'sources', 'operations', ...(owned.has(join(c, 'project.lock')) ? ['project.lock'] : [])]);
  const binding = readJson(join(c, 'binding.json'), 1048576);
  exact(binding, ['format', 'domain', 'domain_sha256', 'initial_project_sha256', 'creation_operation']);
  const family = ['NATIVE_PARTIAL', 'TEST_ONLY_NATIVE'].includes(mode) ? 3 : 2;
  need(binding.format === `xdev-d1-local-control-${family}`, 'CONTROL_VERSION'); assertDomain(root, binding.domain, mode);
  const domain = binding.domain, ds = domainSource(domain); need(binding.domain_sha256 === ds.sha256, 'DOMAIN_BINDING'); uuid(binding.creation_operation); hash(binding.initial_project_sha256);
  const opNames = readdirSync(join(c, 'operations')); need(opNames.length > 0 && opNames.length <= 4096, 'OPERATION_CAPACITY');
  const records: Array<{ begin: Begin; done: B2Record }> = [];
  for (const n of opNames) {
    uuid(n); const op = join(c, 'operations', n); names(op, ['begin.json', 'done.json']);
    const begin = readJson(join(op, 'begin.json')) as Begin, done = readJson(join(op, 'done.json'), 1048576);
    exact(begin, ['format', 'operation_id', 'sequence', 'previous_done_sha256', 'domain_sha256', 'kind', 'input_path', 'input_sha256', 'before_heads', 'after_heads', 'sources', 'facts', 'steps', ...(family === 3 ? ['source_proof'] : [])]);
    exact(done, ['format', 'operation_id', 'domain_sha256', 'begin_sha256', 'after_heads']);
    need(begin.format === `xdev-b2-operation-${family}` && begin.operation_id === n && begin.domain_sha256 === ds.sha256 &&
      Number.isSafeInteger(begin.sequence) && (family === 2 ? ['INIT', 'ALLOCATE', 'CREATE', 'TEST'] : ['INIT', 'CREATE', 'ROLE_SOURCE']).includes(begin.kind) &&
      (mode === 'TEST_ONLY' || begin.kind !== 'TEST'), 'OPERATION_DOMAIN');
    checkedRelativeFile(begin.input_path); hash(begin.input_sha256);
    need(sha256(readProjectFile(root, begin.input_path)) === begin.input_sha256, 'OPERATION_SOURCE_DRIFT');
    need(done.format === `xdev-b2-operation-done-${family}` && done.operation_id === n && done.domain_sha256 === ds.sha256 &&
      done.begin_sha256 === digest(begin) && equal(done.after_heads, begin.after_heads), 'OPERATION_DONE_MISMATCH'); records.push({ begin, done });
  }
  records.sort((a, b) => a.begin.sequence - b.begin.sequence);
  const journals: Journals = {}, sources: Source[] = [], operations: Loaded['operations'] = []; let facts = NONE;
  for (const [i, { begin, done }] of records.entries()) {
    need(begin.sequence === i && begin.previous_done_sha256 === (operations.at(-1)?.done_sha256 ?? null) && equal(begin.before_heads, heads(journals)), 'OPERATION_CHAIN');
    need(i > 0 ? begin.kind !== 'INIT' : begin.kind === 'INIT' && begin.operation_id === binding.creation_operation, 'OPERATION_INIT');
    need(Array.isArray(begin.sources) && begin.sources.length <= 64, 'SOURCE_CAPACITY');
    for (const s of begin.sources) {
      exact(s, ['id', 'sha256', 'path']); hash(s.sha256); need(!sources.some(x => x.id === s.id), 'SOURCE_REBOUND');
      const blob = join(c, 'sources', s.sha256 + '.bin'); need(exactEntry(blob, false).size <= 1048576, 'SOURCE_SIZE');
      const bytes = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(blob)); const src = { ...s, bytes };
      verifySource(root, src); sources.push(src);
    }
    need(Array.isArray(begin.steps) && begin.steps.length > 0 && begin.steps.length <= 4096, 'OPERATION_STEPS');
    for (const [index, step] of begin.steps.entries()) {
      exact(step, ['target', 'before_head', 'append', 'after_head', 'prepared']);
      need(step.target === 'project.json' || /^jobs\/[0-9a-f-]{36}\.json$/.test(step.target), 'OPERATION_TARGET');
      need(step.prepared === `prepared-${index}.json` && step.before_head === (journals[step.target]?.at(-1)?.sha256 ?? null) &&
        Array.isArray(step.append) && step.append.length > 0, 'OPERATION_STEP');
      journals[step.target] = [...(journals[step.target] ?? []), ...step.append];
      (family === 2 ? validateB2Journal : validateB2NativeJournal)(journals[step.target], kindOf(step.target));
      need(journals[step.target]!.at(-1)!.sha256 === step.after_head, 'OPERATION_HEAD');
    }
    need(equal(begin.after_heads, heads(journals)), 'OPERATION_AFTER_HEADS');
    exact(begin.facts, ['current_subject', 'native_records', 'controller_packets']);
    if (mode === 'LOCAL_PREHOST') need(equal(begin.facts, NONE) && Object.values(journals).flat().every(e =>
      ['PROJECT_INIT', 'ALLOCATION_SET', 'CREATE_INTENT', 'D1_B2_CREATE', 'CREATE_COMMIT'].includes(e.command.kind)), 'LOCAL_EXECUTION_UNAVAILABLE');
    for (const k of ['native_records', 'controller_packets'] as const) need(Array.isArray(begin.facts[k]) && facts[k].every(old => begin.facts[k].some(v => equal(old, v))), 'FACT_HISTORY_DROPPED');
    facts = begin.facts; checkedState(root, domain, journals, sources, facts);
    operations.push({ begin, done_sha256: digest(done) });
  }
  need(journals['project.json']![0]!.sha256 === binding.initial_project_sha256, 'INITIAL_PROJECT_DRIFT');
  const jobs = Object.keys(journals).filter(k => k !== 'project.json');
  names(join(c, 'jobs'), [...jobs.map(k => k.slice(5)), ...transient.filter(p => p.startsWith(join(c, 'jobs') + '\\') || p.startsWith(join(c, 'jobs') + '/')).map(p => p.split(/[\\/]/).at(-1)!)]);
  names(join(c, 'sources'), [...new Set(sources.map(s => s.sha256 + '.bin'))]);
  for (const [path, events] of Object.entries(journals)) {
    const raw = readJson(join(c, path)); exact(raw, ['format', 'events']);
    need(raw.format === `xdev-b2-${kindOf(path)}-journal-${family}` && equal(raw.events, events), 'JOURNAL_PLAN_DRIFT');
  }
  const loaded = { binding, domain, sources, journals, facts, operations, structure: checkedState(root, domain, journals, sources, facts) };
  if (family === 3) validateB2StoredSources(root, loaded, test); return loaded;
}
function takeLock(path: string) { need(!owned.has(path), 'LOCK_REENTRY'); mkdirSync(path, { mode: 0o700 }); owned.set(path, idOf(path)); }
function releaseLock(path: string) { const id = owned.get(path); need(id && idOf(path) === id, 'LOCK_OWNERSHIP_LOST'); owned.delete(path); rmdirSync(path); }
function fail(fault: B2Fault | undefined, at: string) {
  if (fault === 'PAUSE_AFTER_BEGIN' && at === 'AFTER_BEGIN') {
    process.stdout.write(`B2_TEST_PAUSED_PID:${process.pid}\n`); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
    throw Error('B2_TEST_PAUSE_EXPIRED');
  }
  need(fault !== at, `FAULT:${at}`);
}
function writeOwned(path: string, bytes: string, label: string, fault?: B2Fault) {
  fail(fault, `WRITE:${label}`); const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes, 'utf8'); fail(fault, `FSYNC:${label}`); fsyncSync(fd); } finally { closeSync(fd); }
  need(exactEntry(path, false).size === Buffer.byteLength(bytes) && readFileSync(path, 'utf8') === bytes, 'WRITE_UNCERTAIN');
}
export type B2DiskPlan = { domain: AnyDomain; operation: string; kind: Begin['kind']; input_path: string; input_sha256: string;
  journals: Journals; sources: Source[]; facts: Facts; writes: Array<{ target: string; events: B2Event[] }>;
  source_proof?: B2Record; bundle?: B2NativeBundle; host_action?: B2Record | null; test?: TestNativeContext };
type Plan = B2DiskPlan;
function plannedBegin(plan: Plan, prior: Loaded | null): Begin {
  const working = structuredClone(prior?.journals ?? {}) as Journals;
  const steps = plan.writes.map(({ target, events }, i) => {
    const before = working[target] ?? []; need(events.length > before.length && equal(events.slice(0, before.length), before), 'JOURNAL_PREFIX');
    const step: Step = { target, before_head: before.at(-1)?.sha256 ?? null, append: events.slice(before.length), after_head: events.at(-1)!.sha256, prepared: `prepared-${i}.json` };
    working[target] = events; return step;
  });
  need(equal(working, plan.journals), 'PLAN_JOURNALS');
  return { format: `xdev-b2-operation-${plan.domain.protocol_version}`, operation_id: plan.operation, sequence: prior?.operations.length ?? 0,
    previous_done_sha256: prior?.operations.at(-1)?.done_sha256 ?? null, domain_sha256: domainSource(plan.domain).sha256,
    kind: plan.kind, input_path: plan.input_path, input_sha256: plan.input_sha256, before_heads: heads(prior?.journals ?? {}), after_heads: heads(plan.journals),
    sources: plan.sources.filter(s => !prior?.sources.some(old => old.id === s.id)).map(({ bytes, ...meta }) => meta), facts: plan.facts, steps,
    ...(plan.domain.protocol_version === 3 ? { source_proof: plan.source_proof } : {}) };
}
function validatePlan(root: string, plan: Plan, prior: Loaded | null) {
  uuid(plan.operation); assertDomain(root, plan.domain, plan.domain.mode); checkedState(root, plan.domain, plan.journals, plan.sources, plan.facts);
  need(!prior || equal(prior.domain, plan.domain), 'DOMAIN_MISMATCH');
  need(sha256(readProjectFile(root, plan.input_path)) === plan.input_sha256, 'SOURCE_DRIFT');
  const begin = plannedBegin(plan, prior); need(begin.sequence < 4096, 'OPERATION_CAPACITY');
  let extra = Buffer.byteLength(jsonBytes(begin)) + 1048576;
  for (const w of plan.writes) { const n = Buffer.byteLength(jsonBytes({ format: `xdev-b2-${kindOf(w.target)}-journal-${plan.domain.protocol_version}`, events: w.events })); need(n <= 64 * 1024 * 1024, 'JOURNAL_CAPACITY'); extra += n; }
  extra += plan.sources.reduce((sum, s) => sum + Buffer.byteLength(s.bytes), 0);
  need((prior ? treeBytes(control(root)) : 0) + extra <= 256 * 1024 * 1024, 'STORAGE_CAPACITY'); return begin;
}
/** Bind time checks once to the already validated original events, not a caller timestamp or final allocation alone. */
function operationDeadline(plan: Plan, begin: Begin): number | null {
  const project = (plan.domain.protocol_version === 2 ? replayProject : replayNativeProject)(plan.journals['project.json']);
  const allocations = new Map(project.events.filter(e => e.command.kind === 'ALLOCATION_SET')
    .map(e => [e.command.allocation_id, e.command.deadline]));
  const deadlines: number[] = [];
  const add = (deadline: unknown) => { need(typeof deadline === 'string', 'DEADLINE_BINDING'); deadlines.push(b2Time(deadline)); };
  const allocation = (id: string) => add(allocations.get(id));
  const binding = (id: string) => { const row = project.catalog.find(x => x.binding.job_id === id); need(row, 'DEADLINE_BINDING'); return row.binding; };
  const attempt = (c: B2Record) => {
    const events = plan.journals[`jobs/${c.job_id.slice(4)}.json`];
    const e = events?.find(e => e.command.kind === 'ATTEMPT_PREPARE' && e.command.attempt_id === c.attempt_id && e.command.ordinal === c.ordinal);
    need(e, 'DEADLINE_BINDING'); return e.command;
  };
  for (const step of begin.steps) for (const e of step.append) {
    const c = e.command;
    switch (c.kind) {
      case 'ALLOCATION_SET': add(c.deadline); break;
      case 'CREATE_INTENT': case 'D1_B2_CREATE': allocation(c.binding.allocation_id); break;
      case 'CREATE_COMMIT': allocation(binding(c.job_id).allocation_id); break;
      case 'RESERVE': case 'ATTEMPT_PREPARE': allocation(c.allocation_id); add(c.deadline); break;
      case 'ROLE_SEND_INTENT': {
        const r = project.reservations.find(r => r.command.reservation_id === c.reservation_id);
        need(r, 'DEADLINE_BINDING'); allocation(r.command.allocation_id); add(r.command.deadline); add(attempt(c).deadline); break;
      }
      case 'REPAIR_AUTHORIZE': add(c.deadline); break;
      case 'CONTROL_SEND_INTENT': add(c.deadline); break;
      case 'REVIEW_RESULT': case 'QA_RESULT': case 'INTEGRATION_RESULT': case 'ATTEMPT_OUTCOME': add(attempt(c).deadline); break;
      // These append observations/reconciliation, not new execution authority. Their original reducer checks still apply.
      case 'PROJECT_INIT': case 'ROLE_RECEIPT': case 'ROLE_TERMINAL': case 'WRITERS_CLOSED':
      case 'CANCEL_REQUESTED': case 'CANCEL_OBSERVED': case 'LATE_OR_REJECTED_OBSERVATION':
      case 'HOLD_RESOLVE': case 'JOB_SETTLED': case 'EXECUTION_VIOLATION': case 'CONTROL_RECEIPT': break;
      default: throw Error('B2_DEADLINE_OPERATION_UNSUPPORTED');
    }
  }
  return deadlines.length ? Math.min(...deadlines) : null;
}
function commit(root: string, plan: Plan, prior: Loaded | null, fault?: B2Fault) {
  need(['TEST_ONLY', 'TEST_ONLY_NATIVE'].includes(plan.domain.mode) || fault === undefined, 'TEST_FAULT_IN_LOCAL_ROOT');
  const begin = validatePlan(root, plan, prior), c = control(root), projectLock = join(c, 'project.lock');
  const newRoot = prior === null; const jobTargets = [...new Set(plan.writes.map(w => w.target).filter(p => p.startsWith('jobs/')))];
  need(jobTargets.length <= 1 || newRoot && plan.domain.mode === 'TEST_ONLY', 'ONE_JOB_TRANSACTION');
  const deadline = operationDeadline(plan, begin); let persistentChange = false, waited = false;
  const checkTime = (stage: string) => {
    const now = Date.now();
    need(deadline === null || now < deadline,
      `${persistentChange ? 'PARTIAL_COMMIT_STOP' : 'ZERO_WRITE_REJECT'}:NATIVE_DEADLINE_EXPIRED:${stage}:${deadline}:${now}`);
  };
  const waitOnce = (stage: B2Fault) => {
    if (fault === stage && !waited) {
      need(['TEST_ONLY', 'TEST_ONLY_NATIVE'].includes(plan.domain.mode), 'TEST_FAULT_IN_LOCAL_ROOT'); waited = true;
      if (plan.domain.mode === 'TEST_ONLY_NATIVE' && stage === 'WAIT_AFTER_LOCK_RECHECK') process.stdout.write(`B2_TEST_NATIVE_RECHECK_DONE:${process.pid}\n`);
      const start = Date.now(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      process.stdout.write(`B2_TEST_NATIVE_WAIT:${JSON.stringify({ stage, start, end: Date.now(), deadline, requested_ms: 1000 })}\n`);
    }
  };
  if (newRoot) freshRoot(root);
  checkTime('PREFLIGHT');
  if (newRoot) { mkdirSync(c, { mode: 0o700 }); persistentChange = true; }
  takeLock(projectLock); const jobLocks: string[] = [];
  try {
    if (!newRoot) {
      const locked = loadFamily(root, plan.domain.mode, plan.test); need(equal(heads(locked.journals), begin.before_heads) && locked.operations.length === begin.sequence, 'REVISION_CONFLICT');
    } else { for (const n of ['jobs', 'sources', 'operations']) mkdirSync(join(c, n), { mode: 0o700 }); }
    for (const target of jobTargets) { const lock = join(c, target.replace(/\.json$/, '.lock')); takeLock(lock); jobLocks.push(lock); }
    for (const source of plan.sources) verifySource(root, source);
    need(projectRootIdentity(root).identity === plan.domain.physical_identity && sha256(readProjectFile(root, plan.input_path)) === plan.input_sha256, 'SOURCE_DRIFT');
    if (plan.bundle) revalidateB2NativeBundle(plan.bundle);
    waitOnce('WAIT_AFTER_LOCK_RECHECK'); if (plan.bundle) revalidateB2NativeBundle(plan.bundle); checkTime('LOCK_RECHECK');
    const opDir = join(c, 'operations', plan.operation); mkdirSync(opDir, { mode: 0o700 }); persistentChange = true;
    writeOwned(join(opDir, 'begin.json'), jsonBytes(begin), 'begin', fault); fail(fault, 'AFTER_BEGIN');
    if (newRoot) writeOwned(join(c, 'binding.json'), jsonBytes({ format: `xdev-d1-local-control-${plan.domain.protocol_version}`, domain: plan.domain,
      domain_sha256: domainSource(plan.domain).sha256, initial_project_sha256: plan.journals['project.json']![0]!.sha256, creation_operation: plan.operation }), 'binding', fault);
    for (const source of plan.sources) { const path = join(c, 'sources', source.sha256 + '.bin');
      if (!existsSync(path)) writeOwned(path, source.bytes, `source-${source.sha256}`, fault);
      else need(readFileSync(path, 'utf8') === source.bytes && exactEntry(path, false).nlink === 1, 'SOURCE_REBOUND'); }
    fail(fault, 'AFTER_SOURCE');
    for (const [i, w] of plan.writes.entries()) {
      const last = w.events.at(-1)!.command.kind;
      if (last === 'CREATE_COMMIT') fail(fault, 'BEFORE_PROJECT_COMMIT');
      // Dynamic originals are re-read before every publish; post-begin drift is a retained partial operation.
      for (const source of plan.sources) verifySource(root, source);
      if (plan.bundle) revalidateB2NativeBundle(plan.bundle);
      need(owned.get(projectLock) === idOf(projectLock) && projectRootIdentity(root).identity === plan.domain.physical_identity, 'LOCK_OWNERSHIP_LOST');
      const tmp = join(opDir, begin.steps[i]!.prepared), target = join(c, w.target);
      const bytes = jsonBytes({ format: `xdev-b2-${kindOf(w.target)}-journal-${plan.domain.protocol_version}`, events: w.events });
      writeOwned(tmp, bytes, `journal-${i}`, fault); fail(fault, `RENAME:journal-${i}`);
      if (existsSync(target)) exactEntry(target, false);
      waitOnce('WAIT_BEFORE_JOURNAL_PUBLISH'); checkTime(`JOURNAL_${i}`); renameSync(tmp, target);
      need(readFileSync(target, 'utf8') === bytes && exactEntry(target, false).nlink === 1, 'PUBLISH_UNCERTAIN');
      if (last === 'CREATE_INTENT') fail(fault, 'AFTER_PROJECT_INTENT');
      if (plan.domain.protocol_version === 3 && w.target === 'project.json' && last === 'ROLE_SEND_INTENT') fail(fault, 'AFTER_PROJECT_INTENT');
      if (last === 'D1_B2_CREATE') fail(fault, 'AFTER_JOB_CREATE');
      if (last === 'CREATE_COMMIT') fail(fault, 'AFTER_PROJECT_COMMIT_BEFORE_DONE');
    }
    const done = { format: `xdev-b2-operation-done-${plan.domain.protocol_version}`, operation_id: plan.operation, domain_sha256: begin.domain_sha256,
      begin_sha256: digest(begin), after_heads: begin.after_heads };
    // A visible done record means its bytes completed fsync before publication.
    // Failure before this rename leaves the pending name as explicit STOP evidence.
    writeOwned(join(opDir, 'pending-done.json'), jsonBytes(done), 'done', fault);
    fail(fault, 'RENAME:done'); waitOnce('WAIT_BEFORE_DONE_PUBLISH'); checkTime('DONE');
    if (plan.bundle) revalidateB2NativeBundle(plan.bundle);
    // A prepublication sample cannot make the native rename atomic with the system clock.
    renameSync(join(opDir, 'pending-done.json'), join(opDir, 'done.json'));
    need(readFileSync(join(opDir, 'done.json'), 'utf8') === jsonBytes(done), 'DONE_PUBLISH_UNCERTAIN');
    fail(fault, 'AFTER_DONE_BEFORE_RESPONSE');
  } finally { for (const l of jobLocks.reverse()) releaseLock(l); releaseLock(projectLock); }
  const loaded = loadFamily(root, plan.domain.mode, plan.test);
  return plan.domain.protocol_version === 3 ? roleSourceResponse(loaded, false, plan.operation, plan.host_action ?? null) : response(loaded, false, plan.operation);
}
function response(l: Loaded, replayed: boolean, operation: string) {
  return { status: replayed ? 'ALREADY_APPLIED' : 'APPLIED', operation_id: operation, mode: l.domain.mode,
    project_id: l.domain.project_id, project_head: l.structure.project_state.head, job_ids: l.structure.jobs.map(j => j.binding.job_id),
    spent_calls: l.structure.project_state.spent_calls, spent_attempts: l.structure.project_state.spent_attempts,
    reserved_calls: l.structure.project_state.reservations.filter(r => !r.sent).length,
    execution_permitted: false, host_observer: 'UNAVAILABLE', delivery_claim_allowed: false };
}
function existingOperation(l: Loaded, inputPath: string, inputSha: string, operation: string) {
  const old = l.operations.find(o => o.begin.operation_id === operation || o.begin.input_path === inputPath);
  if (old) { need(old.begin.operation_id === operation && old.begin.input_path === inputPath && old.begin.input_sha256 === inputSha, 'IDENTITY_CONFLICT'); return response(l, true, operation); }
  return null;
}
/** Native registration is resolved again here, below the public Store. No trusted plan argument exists. */
export function performB2Local(root: string, action: 'init' | 'allocate' | 'create', sourcePath: string, expectedHead?: string): ReturnType<typeof response> {
  need(arguments.length >= 3 && arguments.length <= 4, 'STORE_OPTIONS_UNSUPPORTED');
  need(['init', 'allocate', 'create'].includes(action), 'LOCAL_ACTION'); projectRootIdentity(root); checkedRelativeFile(sourcePath);
  const bytes = readProjectFile(root, sourcePath); need(bytes.length <= 1048576, 'SOURCE_SIZE'); const raw = parseD1UniqueJson(bytes.toString('utf8')) as B2Record;
  exact(raw, Object.keys(raw)); need(jsonBytes(raw) === bytes.toString('utf8'), 'SOURCE_NONCANONICAL');
  let prior: Loaded | null = existsSync(control(root)) ? loadB2(root) : null;
  let operation: string;
  if (action === 'init') { const ref = raw.allocation_source; exact(ref, ['path', 'sha256']);
    const allocationBytes = readProjectFile(root, ref.path); need(sha256(allocationBytes) === ref.sha256, 'SOURCE_DRIFT');
    operation = (parseD1UniqueJson(allocationBytes.toString('utf8')) as B2Record).operation_id;
  } else operation = raw.operation_id;
  uuid(operation); const inputSha = sha256(bytes);
  if (prior) { const replay = existingOperation(prior, sourcePath, inputSha, operation); if (replay) return replay; }
  const at = new Date().toISOString();
  if (action === 'init') {
    need(!prior, 'EXISTING_HISTORY_STOP'); const src = bootstrapSources(root, sourcePath), p: B2Event[] = [];
    appendEvent(p, 'project', { kind: 'PROJECT_INIT', project: src.project, protocol_version: 2,
      history: { protocol: 'FRESH_B2', coverage: 'COMPLETE', source_refs: src.history_refs, unresolved: [] } }, operation, 'init', at);
    appendEvent(p, 'project', allocationCommand(src.allocation, p.at(-1)!.sha256), operation, 'allocation', at);
    return commit(root, { domain: src.domain, operation, kind: 'INIT', input_path: sourcePath, input_sha256: inputSha,
      journals: { 'project.json': p }, sources: src.sources, facts: NONE, writes: [{ target: 'project.json', events: p }] }, null) as ReturnType<typeof response>;
  }
  need(prior && expectedHead === prior.structure.project_state.head, 'REVISION_CONFLICT');
  const p = structuredClone(prior.journals['project.json']!), journals = structuredClone(prior.journals), writes: Plan['writes'] = [];
  let additions: Source[];
  if (action === 'allocate') {
    const src = allocationFromSource(root, sourcePath, prior.structure.project_state.project, prior.structure.project_state); additions = src.sources;
    appendEvent(p, 'project', allocationCommand(src.a, p.at(-1)!.sha256), operation, 'allocation', at); writes.push({ target: 'project.json', events: structuredClone(p) });
  } else {
    const src = jobSources(root, sourcePath, prior.structure.project_state, prior.sources); additions = src.sources;
    const b = src.binding, intent = appendEvent(p, 'project', { kind: 'CREATE_INTENT', binding: b, binding_sha256: b2Hash(b) }, operation, 'create-intent', at);
    writes.push({ target: 'project.json', events: structuredClone(p) }); const j: B2Event[] = [];
    const create = appendEvent(j, 'job', { kind: 'D1_B2_CREATE', binding: b, binding_sha256: b2Hash(b), project_intent_ref: eventRef(intent) }, operation, 'job-create', at);
    const target = `jobs/${b.job_id.slice(4)}.json`; journals[target] = j; writes.push({ target, events: j });
    appendEvent(p, 'project', { kind: 'CREATE_COMMIT', job_id: b.job_id, intent_ref: eventRef(intent), job_create_ref: eventRef(create) }, operation, 'create-commit', at);
    writes.push({ target: 'project.json', events: structuredClone(p) });
  }
  journals['project.json'] = p;
  return commit(root, { domain: prior.domain, operation, kind: action === 'allocate' ? 'ALLOCATE' : 'CREATE', input_path: sourcePath,
    input_sha256: inputSha, journals, sources: mergeSources(prior.sources, additions), facts: NONE, writes }, prior) as ReturnType<typeof response>;
}
function allocationCommand(a: B2Record, head: string) { return { kind: 'ALLOCATION_SET', allocation_id: a.allocation_id,
  authorization_ref: { id: `file:${a.decision_source.path}`, sha256: a.decision_source.sha256 }, previous_allocation_id: a.previous_allocation_id,
  previous_project_head: head, call_cap: a.call_cap, attempt_cap: a.attempt_cap, deadline: a.deadline }; }

/** Explicit test protocol, never a native observer. Lowest entry rechecks immutable on-disk domain. */
export function performB2Test(root: string, inputPath: string, fault?: B2Fault): ReturnType<typeof response> {
  projectRootIdentity(root); checkedRelativeFile(inputPath); const rawBytes = readProjectFile(root, inputPath);
  need(rawBytes.length <= 16 * 1024 * 1024, 'TEST_INPUT_SIZE'); const raw = parseD1UniqueJson(rawBytes.toString('utf8'));
  exact(raw, ['format', 'operation_id', 'domain', 'inspection', 'sources']); need(raw.format === 'xdev-b2-test-operation-2', 'TEST_SOURCE_REQUIRED');
  need(jsonBytes(raw) === rawBytes.toString('utf8'), 'SOURCE_NONCANONICAL'); uuid(raw.operation_id); assertDomain(root, raw.domain, 'TEST_ONLY');
  if (fault) need(['AFTER_BEGIN', 'AFTER_SOURCE', 'AFTER_PROJECT_INTENT', 'AFTER_JOB_CREATE', 'BEFORE_PROJECT_COMMIT',
    'AFTER_PROJECT_COMMIT_BEFORE_DONE', 'AFTER_DONE_BEFORE_RESPONSE', 'PAUSE_AFTER_BEGIN',
    'WAIT_AFTER_LOCK_RECHECK', 'WAIT_BEFORE_JOURNAL_PUBLISH', 'WAIT_BEFORE_DONE_PUBLISH'].includes(fault) || /^(WRITE|FSYNC):(begin|binding|done|source-[0-9a-f]{64}|journal-\d+)$/.test(fault) || /^RENAME:(journal-\d+|done)$/.test(fault), 'FAULT_STAGE');
  const prior = existsSync(control(root)) ? loadB2(root, 'TEST_ONLY') : null;
  if (prior) { const replay = existingOperation(prior, inputPath, sha256(rawBytes), raw.operation_id); if (replay) return replay; }
  const x = validateB2Inspection(raw.inspection), domain = raw.domain;
  need(Array.isArray(raw.sources) && raw.sources.length <= 64, 'SOURCE_CAPACITY');
  const sources: Source[] = raw.sources.map((s: B2Record) => { exact(s, ['id', 'bytes']); need(typeof s.id === 'string' && typeof s.bytes === 'string', 'TEST_SOURCE');
    return { id: s.id, bytes: s.bytes, path: null, sha256: sha256(s.bytes) }; });
  need(equal(x.facts.source_refs, sources.map(({ id, sha256 }) => ({ id, sha256 }))), 'TEST_SOURCE_REFS');
  const journals: Journals = { 'project.json': x.project_events };
  for (const j of x.job_journals as B2Event[][]) journals[`jobs/${j[0]!.command.binding.job_id.slice(4)}.json`] = j;
  if (prior) { mergeSources(prior.sources, sources); need(prior.sources.every(s => sources.some(n => equal(n, s))), 'SOURCE_HISTORY_DROPPED'); }
  const facts: Facts = { current_subject: x.facts.current_subject, native_records: x.facts.native_records, controller_packets: x.facts.controller_packets };
  if (prior) for (const k of ['native_records', 'controller_packets'] as const) need(prior.facts[k].every(v => facts[k].some(n => equal(n, v))), 'FACT_HISTORY_DROPPED');
  const additions: Array<{ target: string; e: B2Event }> = [];
  for (const [target, events] of Object.entries(journals)) { const old = prior?.journals[target] ?? [];
    need(events.length >= old.length && equal(events.slice(0, old.length), old), 'JOURNAL_PREFIX');
    for (const e of events.slice(old.length)) additions.push({ target, e }); }
  need(!prior || Object.keys(prior.journals).every(k => journals[k]), 'JOB_HISTORY_DROPPED');
  additions.sort((a, b) => b2Time(a.e.occurred_at) - b2Time(b.e.occurred_at));
  const working = structuredClone(prior?.journals ?? {}) as Journals;
  const writes = additions.map(({ target, e }) => { (working[target] ??= []).push(e); return { target, events: structuredClone(working[target]!) }; });
  need(writes.length > 0, 'EMPTY_OPERATION');
  if (!prior) need(Object.keys(journals).length === 1 && journals['project.json']!.length === 2, 'TEST_INIT_ONLY');
  return commit(root, { domain, operation: raw.operation_id, kind: prior ? 'TEST' : 'INIT', input_path: inputPath,
    input_sha256: sha256(rawBytes), journals, sources, facts, writes }, prior, fault) as ReturnType<typeof response>;
}
export function queryB2(root: string, jobId?: string, mode: Mode = 'LOCAL_PREHOST') {
  const l = loadB2(root, mode), current = jobId ? l.structure.jobs.find(j => j.binding.job_id === jobId) : l.structure.jobs.at(-1);
  need(!jobId || current, 'JOB_NOT_FOUND');
  const result = { ...response(l, false, l.operations.at(-1)!.begin.operation_id), status: 'LOCAL_PREHOST_NOT_EXECUTABLE',
    integrity: 'COMPLETE', holds: l.structure.holds, current_job: current?.binding.job_id ?? null,
    job_state: current?.state ?? null, attempts: current?.attempts.map(a => ({ ordinal: a.command.ordinal, observations: a.observation_count })) ?? [],
    job_count: l.structure.jobs.length, planned_profile: current?.binding.profile.selected_profile ?? null,
    quality: 'NOT_ASSESSED', resume_action: 'READ_ONLY_NO_RETRY', test_quality: mode === 'TEST_ONLY' ? inspectB2Pair(factsFor(l.domain, l.journals, l.sources, l.facts)) : null };
  const after = loadB2(root, mode); need(equal(heads(l.journals), heads(after.journals)) && equal(l.sources, after.sources), 'QUERY_DRIFT'); return result;
}

function beforeOperation(loaded: Loaded, sequence: number): Loaded {
  const journals: Journals = {}, operations = loaded.operations.slice(0, sequence); let facts = NONE;
  const ids = new Set<string>();
  for (const operation of operations) {
    for (const s of operation.begin.sources) ids.add(s.id);
    for (const step of operation.begin.steps) journals[step.target] = [...(journals[step.target] ?? []), ...step.append];
    facts = operation.begin.facts;
  }
  const sources = loaded.sources.filter(s => ids.has(s.id));
  return { ...loaded, journals, sources, operations, facts, structure: checkedState(loaded.domain.physical_root, loaded.domain, journals, sources, facts) };
}
/** Resolve only a completed operation's own target, never the latest Job. This
 * is a structural check over already loaded journals, not native admission. */
export function resolveB2OperationJob(loaded: B2Loaded, operation: string): string | null {
  const matches = loaded.operations.filter(o => o.begin.operation_id === operation);
  need(matches.length === 1, 'OPERATION_TARGET_AMBIGUOUS');
  const begin = matches[0]!.begin, action = begin.source_proof?.action;
  const rows = begin.steps.flatMap(s => s.append.map(event => ({ target: s.target, event })));
  need(rows.length > 0 && rows.every(({ target, event }) =>
    loaded.journals[target]?.filter(e => equal(e, event)).length === 1), 'OPERATION_TARGET_EVENT_MISSING');
  if (action === 'INIT') {
    need(begin.kind === 'INIT' && rows.length === 2 && rows.every(r => r.target === 'project.json') &&
      rows[0]!.event.command.kind === 'PROJECT_INIT' && rows[1]!.event.command.kind === 'ALLOCATION_SET' &&
      rows[0]!.event.operation_id === eventId(operation, 'init') &&
      rows[1]!.event.operation_id === eventId(operation, 'allocation'), 'OPERATION_INIT_TARGET');
    return null;
  }
  const ids = new Set(rows.flatMap(({ event }) => {
    const c = event.command; return c.binding?.job_id ? [c.binding.job_id] : c.job_id ? [c.job_id] : [];
  }));
  need(ids.size === 1, 'OPERATION_TARGET_AMBIGUOUS');
  const jobId = [...ids][0];
  need(typeof jobId === 'string' && /^job:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(jobId), 'OPERATION_TARGET_JOB');
  const jobs = loaded.structure.jobs.filter(j => j.binding.job_id === jobId);
  need(jobs.length === 1 && rows.every(r => r.target === 'project.json' || r.target === `jobs/${jobId.slice(4)}.json`), 'OPERATION_TARGET_JOB');
  if (action === 'CREATE') {
    need(begin.kind === 'CREATE' && rows.length === 3 && rows[0]!.target === 'project.json' &&
      rows[1]!.target === `jobs/${jobId.slice(4)}.json` && rows[2]!.target === 'project.json' &&
      equal(rows.map(r => r.event.command.kind), ['CREATE_INTENT', 'D1_B2_CREATE', 'CREATE_COMMIT']) &&
      equal(rows.map(r => r.event.operation_id), ['create-intent', 'job-create', 'create-commit'].map(label => eventId(operation, label))), 'CREATE_TARGET_EVENTS');
    const [intent, create, committed] = rows.map(r => r.event), binding = jobs[0]!.binding;
    need(equal(intent!.command.binding, binding) && equal(create!.command.binding, binding) &&
      intent!.command.binding_sha256 === b2Hash(binding) && create!.command.binding_sha256 === b2Hash(binding) &&
      equal(create!.command.project_intent_ref, eventRef(intent!)) && committed!.command.job_id === jobId &&
      equal(committed!.command.intent_ref, eventRef(intent!)) && equal(committed!.command.job_create_ref, eventRef(create!)) &&
      equal(jobs[0]!.create, create!), 'CREATE_TARGET_BINDING');
    const sources = loaded.sources.filter(s => s.path === begin.input_path && s.id === `file:${begin.input_path}`);
    need(sources.length === 1 && sources[0]!.sha256 === begin.input_sha256 && sha256(sources[0]!.bytes) === begin.input_sha256, 'CREATE_TARGET_SOURCE');
    const source = parseD1UniqueJson(sources[0]!.bytes) as B2Record; uuid(source.request_id);
    need(source.format === 'xdev-b2-job-source-3' && source.operation_id === operation &&
      source.project_id === loaded.domain.project_id && source.root_identity === loaded.domain.physical_identity &&
      binding.job_id === `job:${source.request_id}` && binding.request_id === source.request_id &&
      binding.task_id === `task:${source.request_id}:${eventId(source.request_id, 'task')}` &&
      equal(binding.operative, source.operative) && binding.operative_sha256 === b2Hash(source.operative) &&
      equal(binding.request_ref, { id: `file:${begin.input_path}`, sha256: begin.input_sha256 }), 'CREATE_TARGET_SOURCE_BINDING');
  } else {
    need(begin.kind === 'ROLE_SOURCE' && ['PREPARE_ROLE', 'OBSERVE', 'OUTCOME', 'CANCEL', 'RECONCILE'].includes(action), 'OPERATION_TARGET_ACTION');
    need(!begin.source_proof?.plan || begin.source_proof.plan.job_id === jobId, 'OPERATION_TARGET_JOB');
  }
  return jobId;
}

/** Called only with source-validated binding/policy, before the ordinary commit.
 * The Task itself is resolved by the existing job/native source validator. */
export function assertB2TaskStartScope(binding: B2Record, policy: B2Record): void {
  need(Array.isArray(binding.operative?.required_guarantees) && binding.operative.required_guarantees.includes('scope_review_v1') &&
    Array.isArray(policy.required_guarantees) && policy.required_guarantees.includes('scope_review_v1'), 'TASK_SCOPE_REVIEW_REQUIRED');
}

function performRoleSource(root: string, action: string, args: any[], test?: TestNativeContext, fault?: B2Fault, taskStart = false): unknown {
  const mode = test ? 'TEST_ONLY_NATIVE' : 'NATIVE_PARTIAL'; projectRootIdentity(root);
  const count: Record<string, number> = { init: 1, create: 2, prepare: 5, observe: 4, outcome: 4, cancel: 5, reconcile: 5, result: 1 };
  need(Object.hasOwn(count, action) && args.length === count[action], 'STORE_OPTIONS_UNSUPPORTED');
  if (!['init', 'create'].includes(action)) need(typeof args[0] === 'string' && /^job:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(args[0]), 'JOB_ID');
  // Admission is checked before load or any real native read, including the absent-deployment branch.
  const admission = buildAdmission(root, test);
  if (['init', 'create', 'prepare', 'cancel', 'outcome'].includes(action))
    need(Date.parse(admission.policy.valid_from) <= Date.now() && Date.now() < Date.parse(admission.policy.deadline), 'POLICY_EXPIRED');
  const loaded = existsSync(control(root)) ? loadFamily(root, mode, test) : null;
  if (taskStart) need(action === 'create' && loaded, 'TASK_B2_INITIALIZATION_REQUIRED');
  if (action === 'result') {
    need(loaded, 'CONTROL_REQUIRED'); const result = roleSourceQuery(root, loaded, args[0], test), after = loadFamily(root, mode, test);
    need(equal(heads(loaded.journals), heads(after.journals)) && equal(loaded.sources, after.sources), 'QUERY_DRIFT'); return result;
  }
  let operation: string;
  if (['init', 'create'].includes(action)) {
    const input = parseD1UniqueJson(readProjectFile(root, args[0]).toString('utf8')) as B2Record;
    operation = action === 'init' ? (parseD1UniqueJson(readProjectFile(root, input.allocation_source.path).toString('utf8')) as B2Record).operation_id : input.operation_id;
  } else operation = args[1]; uuid(operation);
  const old = loaded?.operations.find(o => o.begin.operation_id === operation);
  if (old) {
    need(old.begin.source_proof?.action === ({ init: 'INIT', create: 'CREATE', prepare: 'PREPARE_ROLE', observe: 'OBSERVE',
      outcome: 'OUTCOME', cancel: 'CANCEL', reconcile: 'RECONCILE' } as B2Record)[action], 'IDENTITY_CONFLICT');
    if (['init', 'create'].includes(action)) {
      need(old.begin.input_path === args[0] && sha256(readProjectFile(root, args[0])) === old.begin.input_sha256, 'IDENTITY_CONFLICT');
      if (action === 'create') need(args[1] === old.begin.before_heads['project.json'], 'IDENTITY_CONFLICT');
    }
    else {
      const grantAction = ['prepare', 'cancel', 'reconcile'].includes(action), target = `jobs/${args[0].slice(4)}.json`;
      need(args[grantAction ? 3 : 2] === old.begin.before_heads['project.json'] && args[grantAction ? 4 : 3] === old.begin.before_heads[target], 'IDENTITY_CONFLICT');
      if (grantAction) {
        need(equal(args[2], old.begin.source_proof!.locator), 'IDENTITY_CONFLICT');
        const prior = beforeOperation(loaded!, old.begin.sequence);
        const checked = buildB2RoleSourcePlan(root, action, args, prior, test);
        need(equal(checked.journals, Object.fromEntries(Object.keys(old.begin.after_heads).map(k => {
          const all = loaded!.journals[k]!; const i = all.findIndex(e => e.sha256 === old.begin.after_heads[k]); return [k, all.slice(0, i + 1)];
        }))), 'REPLAY_PLAN_DRIFT');
      }
    }
    const target = resolveB2OperationJob(loaded!, operation);
    if (!['init', 'create'].includes(action)) need(target === args[0], 'OPERATION_TARGET_JOB');
    if (taskStart) assertB2TaskStartScope(loaded!.structure.jobs.find(j => j.binding.job_id === target)!.binding, admission.policy);
    revalidateB2NativeBundle(admission); return roleSourceResponse(loaded!, true, operation, null);
  }
  const plan = buildB2RoleSourcePlan(root, action, args, loaded, test);
  need(plan.domain.mode === mode && plan.operation === operation, 'DOMAIN_MISMATCH');
  if (taskStart) {
    const created = Object.values(plan.journals).flat().filter(e => e.command.kind === 'D1_B2_CREATE' &&
      e.command.binding.request_ref.id === `file:${args[0]}`);
    need(created.length === 1 && plan.bundle, 'CREATE_TARGET_AMBIGUOUS');
    assertB2TaskStartScope(created[0]!.command.binding, plan.bundle.policy);
  }
  return commit(root, plan, loaded, fault);
}
function buildAdmission(root: string, test?: TestNativeContext) {
  return openB2NativeBundle(root, undefined, test);
}
function nativeFailure<T>(f: () => T): T {
  try { return f(); } catch (error) {
    if (error instanceof NativeSourceError) throw Error(`B2_NATIVE_SOURCE:${error.code}`);
    throw error;
  }
}
/** The public real entry has no policy, clock, native path, facts, or source-brand options. */
export function performB2RoleSource(root: string, action: string, args: any[]) {
  need(arguments.length === 3, 'STORE_OPTIONS_UNSUPPORTED'); return nativeFailure(() => performRoleSource(root, action, args));
}
/** The new task route has no injected policy/clock/native facts and never initializes
 * a domain or upgrades an A Job. Queries use the same persisted quality path. */
export function performB2TaskSource(root: string, action: 'start' | 'result', args: any[]) {
  need(arguments.length === 3 && ['start', 'result'].includes(action) && Array.isArray(args) &&
    args.length === (action === 'start' ? 2 : 1), 'STORE_OPTIONS_UNSUPPORTED');
  projectRootIdentity(root); need(existsSync(control(root)), 'TASK_B2_INITIALIZATION_REQUIRED');
  return nativeFailure(() => performRoleSource(root, action === 'start' ? 'create' : 'result', args, undefined, undefined, action === 'start'));
}
/** Named test boundary: its mode and reader can never publish to NATIVE_PARTIAL. */
export function performB2TestRoleSource(root: string, action: string, args: any[], test: TestNativeContext, fault?: B2Fault) {
  need(arguments.length >= 4 && arguments.length <= 5, 'STORE_OPTIONS_UNSUPPORTED');
  return nativeFailure(() => performRoleSource(root, action, args, test, fault));
}
export function performB2NativeTest(root: string, inputPath: string, fault?: B2Fault) {
  need(arguments.length >= 2 && arguments.length <= 3, 'STORE_OPTIONS_UNSUPPORTED'); checkedRelativeFile(inputPath);
  const bytes = readProjectFile(root, inputPath), value = parseD1UniqueJson(bytes.toString('utf8')) as B2Record;
  exact(value, ['format', 'native_fixture_root', 'native_context', 'policy_fixture_path', 'action', 'arguments']);
  need(value.format === 'xdev-b2-native-test-operation-3' && jsonBytes(value) === bytes.toString('utf8'), 'TEST_SOURCE_REQUIRED');
  const actions: B2Record = { roleQualityInitialize: 'init', roleQualityCreate: 'create', roleQualityPrepare: 'prepare',
    roleQualityObserve: 'observe', roleQualityOutcome: 'outcome', roleQualityCancel: 'cancel', roleQualityReconcile: 'reconcile', roleQualityResult: 'result' };
  need(Object.hasOwn(actions, value.action) && Array.isArray(value.arguments), 'TEST_ACTION');
  if (fault) need(['AFTER_BEGIN', 'AFTER_SOURCE', 'AFTER_PROJECT_INTENT', 'AFTER_JOB_CREATE', 'BEFORE_PROJECT_COMMIT',
    'AFTER_PROJECT_COMMIT_BEFORE_DONE', 'AFTER_DONE_BEFORE_RESPONSE', 'PAUSE_AFTER_BEGIN', 'WAIT_AFTER_LOCK_RECHECK',
    'WAIT_BEFORE_JOURNAL_PUBLISH', 'WAIT_BEFORE_DONE_PUBLISH'].includes(fault) || /^(WRITE|FSYNC):(begin|binding|done|source-[0-9a-f]{64}|journal-\d+)$/.test(fault) ||
    /^RENAME:(journal-\d+|done)$/.test(fault), 'FAULT_STAGE');
  return performB2TestRoleSource(root, actions[value.action], value.arguments,
    { fixtureRoot: value.native_fixture_root, context: value.native_context, policyPath: value.policy_fixture_path }, fault);
}
