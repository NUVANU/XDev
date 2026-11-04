import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { canonical } from './storage-identity.ts';
import { qualityRequirements } from './d1-quality.ts';

/** These codecs describe synthetic protocol facts, never authenticated Host receipts. */
export type B2Record = Record<string, any>;
export type B2Family = 2 | 3;
export type B2Event = { format: string; revision: number; previous_sha256: string | null;
  operation_id: string; occurred_at: string; command: B2Record; sha256: string };
export const B2_GUARANTEES = ['controller_intent', 'native_call_linkage', 'message_plaintext_equivalence',
  'execution_subject', 'known_writer_closure', 'quality_evidence', 'identity_authentication', 'scope_review_v1'] as const;
export function b2Need(ok: unknown, code: string): asserts ok { if (!ok) throw Error(`B2_${code}`); }
export function b2Exact(v: unknown, keys: string[]): asserts v is B2Record {
  b2Need(v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype, 'SCHEMA');
  const own = Reflect.ownKeys(v);
  b2Need(own.every(k => typeof k === 'string') && own.length === keys.length && keys.every(k => own.includes(k)), 'SCHEMA');
  b2Need(Object.values(Object.getOwnPropertyDescriptors(v)).every(d => 'value' in d && d.enumerable), 'SCHEMA');
}
type Check = (v: any) => void;
const text: Check = v => b2Need(typeof v === 'string' && v.trim().length > 0 && v.length <= 8192, 'TEXT');
const hash: Check = v => b2Need(typeof v === 'string' && /^[0-9a-f]{64}$/.test(v), 'HASH');
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uuid: Check = v => b2Need(typeof v === 'string' && new RegExp(`^${uuidPattern}$`).test(v), 'UUID');
const jid: Check = v => b2Need(typeof v === 'string' && new RegExp(`^job:${uuidPattern}$`).test(v), 'JOB_ID');
const tid: Check = v => b2Need(typeof v === 'string' && new RegExp(`^task:${uuidPattern}:${uuidPattern}$`).test(v), 'TASK_ID');
const choice = (...values: unknown[]): Check => v => b2Need(values.includes(v), 'ENUM');
const integer = (min: number, max: number): Check => v => b2Need(Number.isSafeInteger(v) && v >= min && v <= max, 'INTEGER');
const nullable = (f: Check): Check => v => { if (v !== null) f(v); };
const shape = (fields: Record<string, Check>): Check => v => {
  b2Exact(v, Object.keys(fields)); for (const [k, f] of Object.entries(fields)) f(v[k]);
};
export function b2List(v: unknown, min: number, max: number, f: Check): asserts v is any[] {
  b2Need(Array.isArray(v) && Object.getPrototypeOf(v) === Array.prototype && v.length >= min && v.length <= max, 'LIST');
  b2Need(Reflect.ownKeys(v).length === v.length + 1, 'LIST');
  for (let i = 0; i < v.length; i++) { const d = Object.getOwnPropertyDescriptor(v, String(i));
    b2Need(d && 'value' in d && d.enumerable, 'LIST'); f(d.value); }
}
const list = (f: Check, min = 0, max = 64): Check => v => b2List(v, min, max, f);
const unique = (f: Check, min = 0, max = 64): Check => v => {
  b2List(v, min, max, f); b2Need(new Set(v.map(x => canonical(x))).size === v.length, 'DUPLICATE');
};
export function b2Time(v: unknown): number {
  b2Need(typeof v === 'string' && v.length === 24 && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v, 'TIME');
  return Date.parse(v);
}
const time: Check = v => { b2Time(v); };
const path: Check = v => { text(v); b2Need(isAbsolute(v) && resolve(v) === v, 'ROOT'); };
const ref: Check = shape({ id: text, sha256: hash });
const refs: Check = v => { unique(ref)(v); b2Need(new Set(v.map((x: B2Record) => x.id)).size === v.length, 'REFERENCE_REBOUND'); };
const refRequired: Check = v => { refs(v); b2Need(v.length > 0, 'SOURCE_REQUIRED'); };
const purposes: Check = unique(choice('worker', 'review', 'qa', 'integration'), 1, 4);
export function b2Ownership(job: string, task: string) {
  jid(job); tid(task); b2Need(task.startsWith(`task:${job.slice(4)}:`), 'JOB_TASK_MISMATCH');
}

// A bounded JSON walk runs before hashing, including caller-facing hashing helpers.
export function b2Hash(value: unknown): string {
  let nodes = 0; const ancestors = new Set<object>();
  const walk = (v: any, depth: number): void => {
    b2Need(++nodes <= 100000 && depth <= 32, 'JSON_LIMIT');
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number') { b2Need(Number.isFinite(v), 'JSON'); return; }
    if (typeof v === 'string') { b2Need(v.length <= 262144, 'JSON_LIMIT'); return; }
    b2Need(v && typeof v === 'object' && !ancestors.has(v), 'JSON'); ancestors.add(v);
    if (Array.isArray(v)) b2List(v, 0, 4096, x => walk(x, depth + 1));
    else { b2Exact(v, Object.keys(v)); for (const x of Object.values(v)) walk(x, depth + 1); }
    ancestors.delete(v);
  }; walk(value, 0); return createHash('sha256').update(canonical(value)).digest('hex');
}
export const b2BytesHash = (v: string) => { b2Need(typeof v === 'string' && Buffer.byteLength(v) <= 65536, 'RAW_LIMIT');
  return createHash('sha256').update(v).digest('hex'); };

const project: Check = shape({ project_id: uuid, physical_root: path, physical_identity: text,
  control_root: path, init_ref: ref });
const subject: Check = shape({ physical_root: path, physical_identity: text, workspace_id: text,
  head: text, candidate_sha256: hash, environment_sha256: hash, contract_sha256: hash,
  criteria_sha256: hash, integration_target_sha256: hash });
const operative: Check = shape({ goal: text, contract_ref: ref, criteria: unique(text, 1),
  allowed_scope: unique(text, 1), forbidden_scope: unique(text), risk: choice('isolated_fake_data', 'ordinary'),
  required_guarantees: unique(choice(...B2_GUARANTEES), 0, 7) });
const profileFor = (family: B2Family): Check => v => {
  b2Exact(v, ['format', 'request_sha256', 'purpose', 'goal', 'impact', 'selected_profile', 'minimum_profile',
    'reason', 'test_depth', 'gates', 'gates_sha256', 'execution_protocol']);
  b2Need(v.format === `xdev-d1-profile-decision-${family}` && v.execution_protocol ===
    (family === 2 ? 'B2_TEST_ONLY_PROTOCOL' : 'B2_SOURCE_RULES_PROTOCOL_3'), 'PROFILE_VERSION');
  // Full existing policy validation follows when operative criteria are available.
  for (const k of ['purpose', 'goal', 'impact', 'selected_profile', 'minimum_profile', 'reason']) text(v[k]);
  hash(v.request_sha256); hash(v.gates_sha256); unique(text, 1)(v.test_depth);
  unique(shape({ requirement: text, status: choice('NOT_RUN') }), 1)(v.gates);
};
const bindingFor = (family: B2Family): Check => v => {
  shape({ protocol_version: choice(family), job_id: jid, task_id: tid, project, operative,
    operative_sha256: hash, profile: profileFor(family), request_id: uuid, request_ref: ref,
    work_item: text, change_request: text, predecessor_job: nullable(jid),
    history_refs: refs, authorization_ref: ref, allocation_id: uuid, prior_project_head: hash,
    project_sequence: integer(1, 256) })(v);
  b2Ownership(v.job_id, v.task_id);
  // The adopted scope opinion belongs to the native v3 family; old synthetic Jobs are not upgraded.
  b2Need(family === 3 || !v.operative.required_guarantees.includes('scope_review_v1'), 'SCOPE_REVIEW_NATIVE_ONLY');
  b2Need(v.operative_sha256 === b2Hash(v.operative) && v.profile.request_sha256 === v.operative_sha256, 'OPERATIVE_BINDING');
  b2Need(v.profile.impact === v.operative.risk && v.profile.goal === v.operative.goal, 'PROFILE_BINDING');
  qualityRequirements({ ...v.profile, format: 'xdev-d1-profile-decision-1',
    execution_protocol: 'PROFILE_ONLY_NOT_EXECUTABLE' }, v.operative.criteria);
};
const requestFields: Check = shape({ task_name: (v: unknown) => b2Need(typeof v === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(v), 'TASK_NAME'),
  agent_type: nullable(text), model: nullable(text), reasoning_effort: nullable(text), fork_turns: nullable(text) });
const native: Check = v => {
  shape({ parent_thread: uuid, child_thread: uuid, turn_id: uuid, call_id: text, agent_path: text,
    actor_id: text, request_fields: requestFields, coverage: choice('COMPLETE', 'INCOMPLETE'), message: shape({
      representation: choice('opaque', 'visible_plaintext'), parent_value: text, child_value: text }),
    source_refs: refRequired })(v);
  b2Need(v.parent_thread !== v.child_thread, 'NATIVE_IDENTITY');
};
const plan: Check = v => { list(shape({ role_id: uuid, purposes, actor_policy: choice('AUTHOR', 'INDEPENDENT') }), 1, 4)(v);
  b2Need(new Set(v.map((x: B2Record) => x.role_id)).size === v.length, 'DUPLICATE_ROLE'); };
const observedSubject: Check = v => {
  shape({ subject, contract_read_ref: ref, criteria_read_ref: ref, workspace_read_ref: ref,
    before_sha256: hash, after_sha256: hash, coverage: choice('COMPLETE', 'INCOMPLETE') })(v);
};
const evidence: Check = v => {
  shape({ evidence_id: uuid, kind: choice('review', 'qa', 'integration'), send_id: uuid, native,
    observation: observedSubject, coverage: unique(text, 1), findings: unique(text),
    execution: nullable(shape({ argv: list(text, 1), cwd: path, started_at: time, ended_at: time,
      exit_code: integer(-2147483648, 2147483647), stdout: (x: unknown) => { b2BytesHash(x as string); },
      stderr: (x: unknown) => { b2BytesHash(x as string); }, stdout_sha256: hash, stderr_sha256: hash,
      invocation_ref: ref, untested: unique(text) })), original_output_ref: ref })(v);
  if (v.kind === 'review') b2Need(v.execution === null, 'REVIEW_NOT_EXECUTION');
  else { const e = v.execution; b2Need(e !== null, 'EXECUTION_REQUIRED');
    b2Need(b2Time(e.started_at) <= b2Time(e.ended_at) && b2BytesHash(e.stdout) === e.stdout_sha256 &&
      b2BytesHash(e.stderr) === e.stderr_sha256, 'EXECUTION_BINDING'); }
};
const commonIds = { job_id: jid, task_id: tid, attempt_id: uuid, ordinal: integer(1, 2) };
const roleIds = { ...commonIds, role_id: uuid, send_id: uuid, reservation_id: uuid };
const projectCommands: Record<string, Record<string, Check>> = {
  PROJECT_INIT: { project, protocol_version: choice(2), history: shape({ protocol: choice('FRESH_B2', 'A_OR_LEGACY'),
    coverage: choice('COMPLETE', 'INCOMPLETE'), source_refs: refRequired, unresolved: refs }) },
  ALLOCATION_SET: { allocation_id: uuid, authorization_ref: ref, previous_allocation_id: nullable(uuid),
    previous_project_head: hash, call_cap: integer(0, 4096), attempt_cap: integer(0, 512), deadline: time },
  CREATE_INTENT: { binding: bindingFor(2), binding_sha256: hash },
  CREATE_COMMIT: { job_id: jid, intent_ref: ref, job_create_ref: ref },
  RESERVE: { ...roleIds, purposes, allocation_id: uuid, call_units: choice(1), attempt_units: choice(0, 1), deadline: time },
  ROLE_SEND_INTENT: { ...roleIds, purposes, packet_sha256: hash, expected_job_head: hash },
  ROLE_RECEIPT: { ...roleIds, job_receipt_ref: ref, status: choice('ACK', 'UNKNOWN'), native: nullable(native) },
  HOLD_RESOLVE: { ...roleIds, job_receipt_ref: ref, reconciliation_refs: refRequired, authorization_ref: ref },
  JOB_SETTLED: { job_id: jid, job_terminal_ref: ref, closure_refs: refRequired },
  EXECUTION_VIOLATION: { job_id: jid, attempt_id: uuid, native_call_ids: unique(text, 1), source_refs: refRequired },
};
const jobCommands: Record<string, Record<string, Check>> = {
  D1_B2_CREATE: { binding: bindingFor(2), binding_sha256: hash, project_intent_ref: ref },
  ATTEMPT_PREPARE: { ...commonIds, subject, allocation_id: uuid, deadline: time, roles: plan,
    reservation_refs: refRequired, repair_ref: nullable(ref) },
  ROLE_SEND_INTENT: { ...roleIds, purposes, packet_sha256: hash, project_send_ref: ref,
    expected_project_head: hash, expected_job_head: hash },
  ROLE_RECEIPT: { ...roleIds, status: choice('ACK', 'UNKNOWN'), native: nullable(native), project_send_ref: ref },
  ROLE_TERMINAL: { ...roleIds, native, status: choice('SUCCEEDED', 'FAILED', 'INTERRUPTED'),
    observation: observedSubject, terminal_ref: ref, sessions: list(shape({ id: text, state: choice('CLOSED', 'OPEN', 'UNKNOWN'), source_ref: ref })) },
  WRITERS_CLOSED: { ...commonIds, send_ids: unique(uuid, 1), source_refs: refRequired },
  REVIEW_RESULT: { ...commonIds, evidence }, QA_RESULT: { ...commonIds, evidence },
  INTEGRATION_RESULT: { ...commonIds, evidence },
  ATTEMPT_OUTCOME: { ...commonIds, evidence_sha256: hash },
  REPAIR_AUTHORIZE: { ...commonIds, failed_outcome_ref: ref, candidate_sha256: hash, authorization_ref: ref,
    allocation_id: uuid, deadline: time },
  CANCEL_REQUESTED: { ...commonIds, target_send_id: uuid, authorization_ref: ref },
  CANCEL_OBSERVED: { ...commonIds, target_send_id: uuid, native, interrupt_ref: ref, closure_refs: refRequired },
  LATE_OR_REJECTED_OBSERVATION: { ...commonIds, send_id: uuid, native, source_ref: ref,
    reason: choice('LATE', 'STALE', 'EXPIRED', 'REJECTED'), received_at: time },
};

const controlCommands: Record<string, Record<string, Check>> = {
  CONTROL_SEND_INTENT: { control_id: uuid, job_id: jid, attempt_id: uuid, send_id: uuid,
    child_thread: uuid, action: choice('CANCEL'), operation_id: uuid, grant_ref: ref, deadline: time },
  CONTROL_RECEIPT: { control_id: uuid, status: choice('ACK', 'UNKNOWN'), call_id: nullable(text), native: nullable(native) },
};
function fieldsFor(kind: 'project' | 'job', command: string, family: B2Family) {
  const table = kind === 'project' ? projectCommands : jobCommands;
  if (family === 3 && kind === 'project' && Object.hasOwn(controlCommands, command)) return controlCommands[command];
  if (!Object.hasOwn(table, command)) return undefined;
  if (family === 3 && command === 'PROJECT_INIT') return { ...table[command], protocol_version: choice(3) };
  if (family === 3 && ['CREATE_INTENT', 'D1_B2_CREATE'].includes(command)) return { ...table[command], binding: bindingFor(3) };
  return table[command];
}
function validateEvent(value: unknown, kind: 'project' | 'job', family: B2Family): B2Event {
  b2Need(kind === 'project' || kind === 'job', 'KIND');
  b2Exact(value, ['format', 'revision', 'previous_sha256', 'operation_id', 'occurred_at', 'command', 'sha256']);
  b2Need(value.format === `xdev-b2-${kind}-event-${family}`, 'VERSION'); integer(0, kind === 'project' ? 4095 : 511)(value.revision);
  nullable(hash)(value.previous_sha256); uuid(value.operation_id); time(value.occurred_at); hash(value.sha256);
  b2Need(value.command && typeof value.command === 'object', 'COMMAND');
  b2Exact(value.command, Object.keys(value.command));
  const fields = fieldsFor(kind, value.command.kind, family);
  b2Need(fields, 'COMMAND');
  shape({ kind: choice(value.command.kind), ...fields })(value.command);
  const c = value.command;
  if (c.job_id && c.task_id) b2Ownership(c.job_id, c.task_id);
  if (c.binding) b2Need(c.binding_sha256 === b2Hash(c.binding), 'CREATE_BINDING');
  if (c.status === 'ACK') b2Need(c.native !== null && c.native.coverage === 'COMPLETE', 'ACK_SOURCE');
  if (c.kind.endsWith('_RESULT')) b2Need(c.evidence.kind === ({ REVIEW_RESULT: 'review', QA_RESULT: 'qa', INTEGRATION_RESULT: 'integration' } as B2Record)[c.kind], 'EVIDENCE_KIND');
  const { sha256, ...body } = value; b2Need(b2Hash(body) === sha256, 'EVENT_HASH');
  return structuredClone(value) as B2Event;
}
export function validateB2Event(value: unknown, kind: 'project' | 'job') { return validateEvent(value, kind, 2); }
export function validateB2NativeEvent(value: unknown, kind: 'project' | 'job') { return validateEvent(value, kind, 3); }

function validateJournal(value: unknown, kind: 'project' | 'job', family: B2Family): B2Event[] {
  b2Need(kind === 'project' || kind === 'job', 'KIND');
  b2List(value, 1, kind === 'project' ? 4096 : 512, () => {});
  const events = value.map(x => validateEvent(x, kind, family)); const operations = new Set<string>();
  events.forEach((e, i) => {
    b2Need(e.revision === i && e.previous_sha256 === (i ? events[i - 1]!.sha256 : null), 'CHAIN');
    b2Need(!operations.has(e.operation_id), 'DUPLICATE_OPERATION'); operations.add(e.operation_id);
    if (i) b2Need(b2Time(e.occurred_at) >= b2Time(events[i - 1]!.occurred_at), 'TIME_ORDER');
  }); return events;
}
export function validateB2Journal(value: unknown, kind: 'project' | 'job') { return validateJournal(value, kind, 2); }
export function validateB2NativeJournal(value: unknown, kind: 'project' | 'job') { return validateJournal(value, kind, 3); }

/** Only the pair entry consumes these synthetic source facts. No caller-supplied view is accepted. */
function validateInspection(value: unknown, family: B2Family): B2Record {
  b2Exact(value, ['format', 'project_events', 'job_journals', 'facts', 'now']);
  b2Need(value.format === (family === 2 ? 'xdev-b2-inspection-test-2' : 'xdev-b2-inspection-native-3'), 'VERSION'); time(value.now);
  validateJournal(value.project_events, 'project', family);
  b2List(value.job_journals, 0, 256, x => { validateJournal(x, 'job', family); });
  shape({ format: choice(family === 2 ? 'B2_SYNTHETIC_FACTS_ONLY' : 'B2_SOURCE_DERIVED_RULES_ONLY'), coverage: choice('COMPLETE', 'INCOMPLETE'),
    project, source_refs: refRequired, current_subject: nullable(subject),
    native_records: list(shape({ send_id: uuid, native }), 0, 1024),
    controller_packets: list(shape({ send_id: uuid, sha256: hash, request_fields: requestFields,
      plaintext_sha256: hash }), 0, 1024) })(value.facts);
  for (const k of ['native_records', 'controller_packets']) b2Need(new Set(value.facts[k].map((x: B2Record) => x.send_id)).size === value.facts[k].length, 'DUPLICATE_SOURCE');
  return structuredClone(value);
}
export function validateB2Inspection(value: unknown) { return validateInspection(value, 2); }
/** A codec validates bytes and rules only. It never brands a native source. */
export function validateB2NativeInspection(value: unknown) { return validateInspection(value, 3); }
