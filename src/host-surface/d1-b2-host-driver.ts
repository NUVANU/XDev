import { b2Exact as exact, b2Need as need, b2List, b2Hash, b2BytesHash, b2Time, b2Ownership,
  type B2Record } from '../job-runtime/d1-b2-contracts.ts';
import { parseD1UniqueJson } from '../job-runtime/contracts.ts';
import { canonical } from '../job-runtime/storage-identity.ts';
import { checkedRelativeFile } from '../project-model/init-receipt.ts';

type GrantLocator = { thread_id: string; item_id: string; ordinal: number; raw_sha256: string };
type SpawnArguments = { task_name: string; message: string; agent_type: string; model: string;
  reasoning_effort: string; fork_turns: 'none' };
export type B2HostWorkflowInput = { source: string; expected_head: string; steps: {
  prepare_operation: string; observe_operation: string; grant_locator: GrantLocator; expected_purposes: string[];
}[]; outcome_operation: string };
export type B2HostStorePort = {
  start(source: string, expectedHead: string): unknown | Promise<unknown>;
  prepare(job: string, operation: string, grant: GrantLocator, projectHead: string, jobHead: string): unknown | Promise<unknown>;
  observe(job: string, operation: string, projectHead: string, jobHead: string): unknown | Promise<unknown>;
  outcome(job: string, operation: string, projectHead: string, jobHead: string): unknown | Promise<unknown>;
  result(job: string): unknown | Promise<unknown>;
};
export type B2HostPort = {
  context: { parent_thread_id: string; parent_session_id: string; parent_turn_id: string };
  spawnAgent(args: SpawnArguments): Promise<unknown>;
  waitForFinal(taskName: string): Promise<{ state: 'COMPLETED' | 'UNKNOWN'; complete: boolean; final: string | null }>;
};
type Phase = 'input' | 'start' | 'prepare' | 'spawn' | 'wait' | 'observe' | 'result' | 'outcome';
type SendCertainty = 'NOT_SENT' | 'UNKNOWN' | 'RETURNED';
type StepObservation = { prepare_operation: string; observe_operation: string; role_id: string | null;
  send_id: string | null; task_name: string | null; send_certainty: SendCertainty; observed: boolean };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = (v: unknown) => need(typeof v === 'string' && uuidPattern.test(v), 'HOST_UUID');
const hash = (v: unknown) => need(typeof v === 'string' && /^[0-9a-f]{64}$/.test(v), 'HOST_HASH');
const text = (v: unknown, max = 8192) => need(typeof v === 'string' && v.trim().length > 0 && v.length <= max, 'HOST_TEXT');
const same = (a: unknown, b: unknown) => b2Hash(a) === b2Hash(b);
function purposes(v: unknown) {
  b2List(v, 1, 4, p => need(['worker', 'review', 'qa', 'integration'].includes(p), 'HOST_PURPOSE'));
  need(new Set(v).size === v.length, 'HOST_DUPLICATE_PURPOSE');
}
function context(v: unknown) {
  exact(v, ['parent_thread_id', 'parent_session_id', 'parent_turn_id']); Object.values(v).forEach(uuid);
}
function inputShape(v: unknown): asserts v is B2HostWorkflowInput {
  exact(v, ['source', 'expected_head', 'steps', 'outcome_operation']);
  text(v.source); checkedRelativeFile(v.source); hash(v.expected_head); uuid(v.outcome_operation);
  const operations = [v.outcome_operation];
  b2List(v.steps, 1, 3, step => {
    exact(step, ['prepare_operation', 'observe_operation', 'grant_locator', 'expected_purposes']);
    uuid(step.prepare_operation); uuid(step.observe_operation); operations.push(step.prepare_operation, step.observe_operation);
    const g = step.grant_locator; exact(g, ['thread_id', 'item_id', 'ordinal', 'raw_sha256']);
    uuid(g.thread_id); text(g.item_id, 256); hash(g.raw_sha256);
    need(Number.isSafeInteger(g.ordinal) && g.ordinal >= 0, 'HOST_GRANT_LOCATOR'); purposes(step.expected_purposes);
  });
  need(new Set(operations).size === operations.length, 'HOST_OPERATION_REUSE');
}
function native(value: unknown): asserts value is B2Record {
  need(value && typeof value === 'object', 'HOST_NATIVE_RESULT'); exact(value, Object.keys(value));
  need(!Object.hasOwn(value, 'diagnostic_host_action') && value.mode === 'NATIVE_PARTIAL' &&
    value.source_level === 'COOPERATIVE_NATIVE_PARTIAL', 'HOST_PRODUCTION_ONLY');
  need(typeof value.job_id === 'string' && value.job_id.startsWith('job:'), 'HOST_JOB'); uuid(value.job_id.slice(4));
  hash(value.project_head); hash(value.job_head);
}
function mutation(value: unknown, job?: string, operation?: string): B2Record {
  native(value); uuid(value.operation_id);
  need(['APPLIED', 'ALREADY_APPLIED'].includes(value.status) && typeof value.execution_permitted === 'boolean' &&
    Object.hasOwn(value, 'host_action'), 'HOST_MUTATION_RESULT');
  need((job === undefined || value.job_id === job) && (operation === undefined || value.operation_id === operation), 'HOST_OPERATION_BINDING');
  return structuredClone(value);
}
function noAction(value: B2Record) {
  need(value.execution_permitted === false && value.host_action === null, 'HOST_UNEXPECTED_ACTION');
}
function query(value: unknown, job: string, projectHead: string, jobHead: string): B2Record {
  native(value);
  need(value.format === 'xdev-b2-role-quality-result-3' && value.job_id === job &&
    value.project_head === projectHead && value.job_head === jobHead, 'HOST_QUERY_BINDING');
  const p = value.execution_progress;
  exact(p, ['attempt_id', 'known_writers_closed', 'outcome_recorded', 'roles']);
  if (p.attempt_id !== null) uuid(p.attempt_id);
  need(typeof p.known_writers_closed === 'boolean' && typeof p.outcome_recorded === 'boolean', 'HOST_PROGRESS');
  b2List(p.roles, 0, 4, r => {
    exact(r, ['role_id', 'purposes', 'send_id', 'receipt_status', 'terminal_status', 'sessions_closed']);
    uuid(r.role_id); if (r.send_id !== null) uuid(r.send_id); purposes(r.purposes);
    need(['ACK', 'UNKNOWN', 'NOT_OBSERVED'].includes(r.receipt_status) &&
      ['SUCCEEDED', 'FAILED', 'INTERRUPTED', 'NOT_OBSERVED'].includes(r.terminal_status) &&
      typeof r.sessions_closed === 'boolean', 'HOST_ROLE_PROGRESS');
  });
  need(new Set(p.roles.map((r: B2Record) => r.role_id)).size === p.roles.length, 'HOST_DUPLICATE_ROLE');
  const sent = p.roles.filter((r: B2Record) => r.send_id !== null);
  need(new Set(sent.map((r: B2Record) => r.send_id)).size === sent.length, 'HOST_DUPLICATE_SEND');
  return structuredClone(value);
}
function actionShape(prepared: B2Record, expected: B2HostWorkflowInput['steps'][number], parent: B2HostPort['context']) {
  need(prepared.status === 'APPLIED' && prepared.execution_permitted === true, 'HOST_PREPARE_NOT_FRESH');
  const a = prepared.host_action;
  exact(a, ['format', 'operation_id', 'job_id', 'attempt_id', 'role_id', 'send_id', 'tool', 'arguments',
    'parent_thread_id', 'parent_session_id', 'parent_turn_id', 'packet_sha256', 'subject_sha256',
    'project_head', 'job_head', 'grant_ref', 'deadline']);
  need(a.format === 'xdev-b2-host-action-3' && a.tool === 'collaboration.spawn_agent', 'HOST_UNSUPPORTED_ACTION');
  need(a.operation_id === prepared.operation_id && a.operation_id === expected.prepare_operation &&
    a.job_id === prepared.job_id && a.project_head === prepared.project_head && a.job_head === prepared.job_head, 'HOST_ACTION_BINDING');
  ['attempt_id', 'role_id', 'send_id', 'parent_thread_id', 'parent_session_id', 'parent_turn_id'].forEach(k => uuid(a[k]));
  need(Object.entries(parent).every(([k, v]) => a[k] === v), 'HOST_CONTEXT_BINDING');
  hash(a.packet_sha256); hash(a.subject_sha256); hash(a.project_head); hash(a.job_head);
  exact(a.grant_ref, ['id', 'sha256']); text(a.grant_ref.id); hash(a.grant_ref.sha256);
  need(a.grant_ref.id.startsWith(`native:${expected.grant_locator.thread_id}:`) &&
    a.grant_ref.id.endsWith(':' + expected.grant_locator.ordinal) &&
    a.grant_ref.sha256 === expected.grant_locator.raw_sha256, 'HOST_GRANT_BINDING');
  const args = a.arguments;
  exact(args, ['task_name', 'message', 'agent_type', 'model', 'reasoning_effort', 'fork_turns']);
  need(typeof args.task_name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(args.task_name), 'HOST_TASK_NAME');
  ['agent_type', 'model', 'reasoning_effort'].forEach(k => text(args[k]));
  need(args.fork_turns === 'none', 'HOST_FORK');
  const plaintext = b2BytesHash(args.message), packet = parseD1UniqueJson(args.message) as B2Record;
  need(packet && typeof packet === 'object', 'HOST_PACKET'); exact(packet, Object.keys(packet));
  need(packet.format === 'xdev-b2-task-packet-3' && canonical(packet) === args.message, 'HOST_PACKET');
  uuid(packet.project_id); uuid(packet.epoch_id); b2Ownership(packet.job_id, packet.task_id);
  need(packet.job_id === a.job_id && packet.attempt_id === a.attempt_id && packet.role_id === a.role_id &&
    Number.isSafeInteger(packet.ordinal) && packet.ordinal >= 1 && packet.ordinal <= 2 &&
    Number.isSafeInteger(packet.role_ordinal) && packet.role_ordinal >= 1 && packet.role_ordinal <= 4, 'HOST_PACKET_BINDING');
  purposes(packet.purposes); need(same(packet.purposes, expected.expected_purposes), 'HOST_PURPOSE_BINDING');
  need(packet.actor_policy === (packet.purposes.includes('worker') ? 'AUTHOR' : 'INDEPENDENT'), 'HOST_ACTOR_POLICY');
  const { message: _message, ...requestFields } = args;
  need(same(packet.request_fields, requestFields) && b2Hash(packet.subject) === a.subject_sha256 &&
    b2Hash({ request_fields: requestFields, plaintext_sha256: plaintext }) === a.packet_sha256, 'HOST_PACKET_HASH');
  need(packet.deadline === a.deadline && Date.now() < b2Time(a.deadline), 'HOST_DEADLINE');
  return { action: structuredClone(a), args: structuredClone(args) as SpawnArguments };
}
/** Expiry retains an uncertain send; it never cancels or retries the Host call. */
async function beforeDeadline<T>(call: () => Promise<T>, deadline: string): Promise<T> {
  const remaining = b2Time(deadline) - Date.now();
  need(remaining > 0 && remaining <= 2147483647, 'HOST_DEADLINE');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([call(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Error('B2_HOST_DEADLINE_UNKNOWN')), remaining);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** A one-shot Host consumer. Store originals alone determine identity, closure,
 * scope and QA. This function never imports final text, requested configuration,
 * a public task path, or a callback's completion flag as canonical evidence. */
export async function runB2TaskHostWorkflow(input: B2HostWorkflowInput, store: B2HostStorePort, host: B2HostPort) {
  let phase: Phase = 'input', job: string | null = null, projectHead: string | null = null, jobHead: string | null = null;
  let operation: string | null = null, startOperation: string | null = null, outcomeOperation: string | null = null, attempt: string | null = null;
  let sendCertainty: SendCertainty = 'NOT_SENT', commitCertainty: 'NOT_ATTEMPTED' | 'UNKNOWN' | 'RETURNED' = 'NOT_ATTEMPTED';
  let portPending = false, canonicalResult: B2Record | null = null;
  const steps: StepObservation[] = [];
  const snapshot = () => ({ phase, job_id: job, project_head: projectHead, job_head: jobHead, operation_id: operation,
    send_certainty: sendCertainty, commit_certainty: commitCertainty,
    operations: { start: startOperation, steps: structuredClone(steps), outcome: outcomeOperation },
    canonical_result: canonicalResult });
  try {
    need(store && host && typeof store === 'object' && typeof host === 'object', 'HOST_PORT_REQUIRED');
    for (const key of ['start', 'prepare', 'observe', 'outcome', 'result'] as const)
      need(typeof store[key] === 'function', 'HOST_STORE_METHOD_REQUIRED');
    need(typeof host.spawnAgent === 'function' && typeof host.waitForFinal === 'function', 'HOST_METHOD_REQUIRED');
    inputShape(input); const plan = structuredClone(input); context(host.context); const parent = structuredClone(host.context);
    const currentContext = () => { context(host.context); need(same(host.context, parent), 'HOST_CONTEXT_DRIFT'); };
    const allOps = [plan.outcome_operation, ...plan.steps.flatMap(s => [s.prepare_operation, s.observe_operation])];
    phase = 'start'; portPending = true; commitCertainty = 'UNKNOWN';
    const startRaw = await store.start(plan.source, plan.expected_head); portPending = false;
    const start = mutation(startRaw); noAction(start); commitCertainty = 'RETURNED';
    job = start.job_id; projectHead = start.project_head; jobHead = start.job_head;
    startOperation = start.operation_id; operation = startOperation;
    need(!allOps.includes(startOperation!), 'HOST_OPERATION_REUSE');
    if (start.status === 'ALREADY_APPLIED') {
      phase = 'result'; portPending = true; const raw = await store.result(job!); portPending = false;
      canonicalResult = query(raw, job!, projectHead!, jobHead!);
      return { status: 'REPLAY_QUERY_ONLY' as const, ...snapshot() };
    }
    const approved: Array<{ role_id: string; send_id: string; purposes: string[] }> = [];
    const closedRoles = (result: B2Record, outcomeRecorded: boolean) => {
      const progress = result.execution_progress;
      need(progress.attempt_id === attempt && progress.outcome_recorded === outcomeRecorded, 'HOST_ATTEMPT_PROGRESS');
      for (const expected of approved) {
        const role = progress.roles.find((r: B2Record) => r.role_id === expected.role_id);
        need(role && role.send_id === expected.send_id && same(role.purposes, expected.purposes) && role.receipt_status === 'ACK' &&
          role.terminal_status === 'SUCCEEDED' && role.sessions_closed === true, 'HOST_CANONICAL_ROLE_NOT_CLOSED');
        if (expected.purposes.includes('worker')) need(progress.known_writers_closed === true, 'HOST_WRITERS_NOT_CLOSED');
      }
      need(progress.roles.filter((r: B2Record) => r.send_id !== null).length === approved.length, 'HOST_UNEXPECTED_CANONICAL_SEND');
    };
    for (const step of plan.steps) {
      phase = 'prepare'; operation = step.prepare_operation; sendCertainty = 'NOT_SENT'; currentContext();
      const observation: StepObservation = { prepare_operation: step.prepare_operation, observe_operation: step.observe_operation,
        role_id: null, send_id: null, task_name: null, send_certainty: 'NOT_SENT', observed: false }; steps.push(observation);
      portPending = true; commitCertainty = 'UNKNOWN';
      const raw = await store.prepare(job!, operation, structuredClone(step.grant_locator), projectHead!, jobHead!); portPending = false;
      const prepared = mutation(raw, job!, operation); commitCertainty = 'RETURNED';
      projectHead = prepared.project_head; jobHead = prepared.job_head;
      need(prepared.status === 'APPLIED', 'HOST_PREPARE_REPLAY_STOP');
      const { action, args } = actionShape(prepared, step, parent);
      need(attempt === null || action.attempt_id === attempt, 'HOST_ATTEMPT_BINDING'); attempt = action.attempt_id;
      need(!approved.some(r => r.role_id === action.role_id || r.send_id === action.send_id) &&
        !steps.slice(0, -1).some(s => s.task_name === '/root/' + args.task_name), 'HOST_ROLE_REUSE');
      observation.role_id = action.role_id; observation.send_id = action.send_id;
      currentContext(); need(Date.now() < b2Time(action.deadline), 'HOST_DEADLINE');
      phase = 'spawn'; sendCertainty = observation.send_certainty = 'UNKNOWN'; portPending = true;
      const spawned = await beforeDeadline(() => host.spawnAgent(args), action.deadline); portPending = false;
      exact(spawned, ['task_name']);
      // Public Host returns an agent path, not an actual thread/session UUID.
      need(spawned.task_name === '/root/' + args.task_name, 'HOST_SPAWN_RETURN');
      observation.task_name = spawned.task_name; sendCertainty = observation.send_certainty = 'RETURNED';
      phase = 'wait'; portPending = true;
      const final = await beforeDeadline(() => host.waitForFinal(spawned.task_name), action.deadline); portPending = false;
      exact(final, ['state', 'complete', 'final']);
      need(final.state === 'COMPLETED' && final.complete === true && typeof final.final === 'string' &&
        final.final.trim().length > 0 && Buffer.byteLength(final.final, 'utf8') <= 65536, 'HOST_FINAL_INCOMPLETE');
      phase = 'observe'; operation = step.observe_operation; portPending = true; commitCertainty = 'UNKNOWN';
      const observedRaw = await store.observe(job!, operation, projectHead!, jobHead!); portPending = false;
      const observed = mutation(observedRaw, job!, operation); noAction(observed); commitCertainty = 'RETURNED';
      need(observed.status === 'APPLIED', 'HOST_OBSERVE_REPLAY_STOP');
      projectHead = observed.project_head; jobHead = observed.job_head;
      phase = 'result'; portPending = true; const resultRaw = await store.result(job!); portPending = false;
      canonicalResult = query(resultRaw, job!, projectHead!, jobHead!);
      approved.push({ role_id: action.role_id, send_id: action.send_id, purposes: [...step.expected_purposes] });
      closedRoles(canonicalResult, false); observation.observed = true;
    }
    phase = 'outcome'; operation = outcomeOperation = plan.outcome_operation; portPending = true; commitCertainty = 'UNKNOWN';
    const outcomeRaw = await store.outcome(job!, operation, projectHead!, jobHead!); portPending = false;
    const outcome = mutation(outcomeRaw, job!, operation); noAction(outcome); commitCertainty = 'RETURNED';
    need(outcome.status === 'APPLIED', 'HOST_OUTCOME_REPLAY_STOP');
    projectHead = outcome.project_head; jobHead = outcome.job_head;
    phase = 'result'; portPending = true; const resultRaw = await store.result(job!); portPending = false;
    canonicalResult = query(resultRaw, job!, projectHead!, jobHead!); closedRoles(canonicalResult, true);
    return { status: 'CANONICAL_RESULT' as const, ...snapshot(), operations: { start: startOperation,
      steps: structuredClone(steps), outcome: plan.outcome_operation } };
  } catch (error) {
    return { status: portPending || sendCertainty === 'UNKNOWN' ? 'UNKNOWN' as const : 'BLOCKED' as const,
      ...snapshot(), reason: error instanceof Error ? error.message.slice(0, 1024) : 'B2_HOST_UNKNOWN_EXCEPTION' };
  }
}
