import { b2Hash, b2Need as need, b2Time, validateB2Journal, validateB2NativeJournal, type B2Family, type B2Event, type B2Record } from './d1-b2-contracts.ts';
import { resolve } from 'node:path';

const same = (a: unknown, b: unknown) => b2Hash(a) === b2Hash(b);
const refIs = (r: B2Record, e: B2Event) => r.id === e.operation_id && r.sha256 === e.sha256;
const alive = (e: B2Event, deadline: string) => need(b2Time(e.occurred_at) < b2Time(deadline), 'EXPIRED');
const sameRole = (a: B2Record, b: B2Record) => {
  for (const k of ['job_id', 'task_id', 'attempt_id', 'ordinal', 'role_id', 'send_id', 'reservation_id']) need(a[k] === b[k], 'ROLE_BINDING');
};
const sameNative = (a: B2Record, b: B2Record) => {
  for (const k of ['parent_thread', 'child_thread', 'turn_id', 'call_id', 'agent_path', 'actor_id']) need(a[k] === b[k], 'NATIVE_BINDING');
  need(same(a.message, b.message), 'NATIVE_MESSAGE_BINDING');
  need(same(a.request_fields, b.request_fields), 'NATIVE_REQUEST_BINDING');
};
const nativeComplete = (n: B2Record) => need(n.coverage === 'COMPLETE' && n.message.parent_value === n.message.child_value, 'NATIVE_COVERAGE');
export type B2ProjectView = { scope: 'TEST_ONLY' | 'NATIVE_RULES_ONLY'; events: B2Event[]; project: B2Record; allocation: B2Record | null;
  catalog: B2Record[]; pending: B2Event | null; active_job: string | null; reservations: B2Record[];
  sends: B2Record[]; controls?: B2Record[]; spent_calls: number; spent_attempts: number; stopped: boolean; head: string };

export function replayProject(input: unknown): B2ProjectView {
  return replayProjectFamily(input, 2);
}
export function replayNativeProject(input: unknown): B2ProjectView { return replayProjectFamily(input, 3); }
function replayProjectFamily(input: unknown, family: B2Family): B2ProjectView {
  const events = (family === 2 ? validateB2Journal : validateB2NativeJournal)(input, 'project');
  need(events[0]!.command.kind === 'PROJECT_INIT', 'PROJECT_INIT_REQUIRED');
  const first = events[0]!.command;
  need(first.history.protocol === 'FRESH_B2' && first.history.coverage === 'COMPLETE' && first.history.unresolved.length === 0, 'HISTORY_BLOCKED');
  need(first.project.control_root === resolve(first.project.physical_root, '.xdev-d1-control'), 'CONTROL_ROOT');
  const v: B2ProjectView = { scope: family === 2 ? 'TEST_ONLY' : 'NATIVE_RULES_ONLY', events, project: first.project, allocation: null, catalog: [],
    pending: null, active_job: null, reservations: [], sends: [], ...(family === 3 ? { controls: [] } : {}), spent_calls: 0, spent_attempts: 0, stopped: false, head: events.at(-1)!.sha256 };
  const controls = v.controls ?? [];
  const allocations = new Set<string>(); const nativeCalls = new Set<string>();
  const pendingCalls = () => v.reservations.filter(r => !r.sent).length;
  const uncertain = () => v.sends.some(s => s.hold) || controls.some(c => c.hold);
  const allocation = (e: B2Event) => { need(v.allocation, 'ALLOCATION_REQUIRED'); alive(e, v.allocation.deadline); };
  for (const e of events.slice(1)) {
    const c = e.command;
    const admitting = ['ALLOCATION_SET', 'CREATE_INTENT', 'RESERVE', 'ROLE_SEND_INTENT'].includes(c.kind);
    if (admitting) need(!v.stopped, 'PROJECT_STOPPED');
    switch (c.kind) {
      case 'PROJECT_INIT': throw Error('B2_DUPLICATE_INIT');
      case 'ALLOCATION_SET': {
        need(!v.pending && !uncertain() && !v.active_job && pendingCalls() === 0, 'ALLOCATION_HELD');
        need(c.previous_project_head === e.previous_sha256 && c.previous_allocation_id === (v.allocation?.allocation_id ?? null), 'ALLOCATION_LINEAGE');
        need(!allocations.has(c.allocation_id) && c.call_cap >= v.spent_calls && c.attempt_cap >= v.spent_attempts, 'ALLOCATION_BALANCE');
        alive(e, c.deadline); allocations.add(c.allocation_id); v.allocation = c; break;
      }
      case 'CREATE_INTENT': {
        allocation(e); const b = c.binding;
        need(!v.pending && !v.active_job && !uncertain() && pendingCalls() === 0, 'PROJECT_BUSY');
        need(v.catalog.length < 256 && same(b.project, v.project) && b.prior_project_head === e.previous_sha256 &&
          b.project_sequence === v.catalog.length + 1 && b.allocation_id === v.allocation!.allocation_id, 'CREATE_PROJECT_BINDING');
        need(!v.catalog.some(x => x.binding.job_id === b.job_id || x.binding.task_id === b.task_id ||
          x.binding.request_id === b.request_id || x.binding.operative_sha256 === b.operative_sha256 ||
          x.binding.work_item === b.work_item || x.binding.change_request === b.change_request || same(x.binding.request_ref, b.request_ref)), 'LINEAGE_REUSE');
        need(b.predecessor_job === (v.catalog.at(-1)?.binding.job_id ?? null), 'PREDECESSOR');
        need(first.history.source_refs.every((r: B2Record) => b.history_refs.some((x: B2Record) => same(r, x))), 'HISTORY_COVERAGE');
        need(v.catalog.every(x => x.settlement && b.history_refs.some((r: B2Record) => refIs(r, x.settlement))), 'HISTORY_COVERAGE');
        v.pending = e; break;
      }
      case 'CREATE_COMMIT': {
        need(v.pending && c.job_id === v.pending.command.binding.job_id && refIs(c.intent_ref, v.pending), 'CREATE_PAIR');
        v.catalog.push({ binding: v.pending.command.binding, intent: v.pending, commit: e, settlement: null });
        v.active_job = c.job_id; v.pending = null; break;
      }
      case 'RESERVE': {
        allocation(e); need(!v.pending && !uncertain() && v.active_job === c.job_id, 'RESERVATION_BLOCKED');
        const cat = v.catalog.find(x => x.binding.job_id === c.job_id); need(cat && cat.binding.task_id === c.task_id, 'CATALOG_BINDING');
        need(!cat.binding.operative.required_guarantees.some((g: string) => ['message_plaintext_equivalence', 'identity_authentication'].includes(g)), 'UNSUPPORTED_REQUIRED_GUARANTEE');
        need(c.allocation_id === v.allocation!.allocation_id && b2Time(c.deadline) <= b2Time(v.allocation!.deadline), 'RESERVATION_ALLOCATION'); alive(e, c.deadline);
        need(!v.reservations.some(r => r.command.reservation_id === c.reservation_id || r.command.send_id === c.send_id ||
          r.command.role_id === c.role_id && r.command.attempt_id === c.attempt_id), 'DUPLICATE_RESERVATION');
        const previous = v.reservations.filter(r => r.command.job_id === c.job_id);
        const ordinalRows = previous.filter(r => r.command.ordinal === c.ordinal);
        need(ordinalRows.every(r => r.command.attempt_id === c.attempt_id), 'ATTEMPT_ID_REBOUND');
        const isWorker = c.purposes.includes('worker');
        need(c.attempt_units === (isWorker ? 1 : 0), 'ATTEMPT_CHARGE');
        if (isWorker) {
          need(!ordinalRows.length && (c.ordinal === 1 ? !previous.length : previous.some(r => r.command.ordinal === 1)), 'ATTEMPT_ORDER');
        } else need(ordinalRows.some(r => r.command.purposes.includes('worker')), 'WORKER_RESERVATION_REQUIRED');
        need(v.spent_calls + pendingCalls() + 1 <= v.allocation!.call_cap &&
          v.spent_attempts + c.attempt_units <= v.allocation!.attempt_cap, 'BUDGET');
        v.spent_attempts += c.attempt_units; v.reservations.push({ event: e, command: c, sent: false }); break;
      }
      case 'ROLE_SEND_INTENT': {
        allocation(e); need(!uncertain() && v.active_job === c.job_id && !v.pending, 'SEND_BLOCKED');
        const r = v.reservations.find(x => x.command.reservation_id === c.reservation_id);
        need(r && !r.sent, 'SEND_RESERVATION'); sameRole(r.command, c); alive(e, r.command.deadline);
        need(same(r.command.purposes, c.purposes), 'PURPOSE_BINDING');
        r.sent = true; v.spent_calls++; v.sends.push({ event: e, command: c, receipt: null, hold: true, reconciled: false }); break;
      }
      case 'ROLE_RECEIPT': {
        const s = v.sends.find(x => x.command.send_id === c.send_id); need(s, 'SEND_NOT_FOUND'); sameRole(s.command, c);
        need(!s.receipt || s.receipt.command.status === 'UNKNOWN' && c.status === 'ACK', 'DUPLICATE_RECEIPT');
        if (c.native) { nativeComplete(c.native);
          if (s.receipt?.command.native) sameNative(s.receipt.command.native, c.native);
          if (!s.receipt?.command.native) { need(!nativeCalls.has(c.native.call_id), 'NATIVE_CALL_REUSE'); nativeCalls.add(c.native.call_id); } }
        const priorUnknown = s.receipt?.command.status === 'UNKNOWN'; s.receipt = e;
        s.hold = family === 3 || c.status !== 'ACK' || !!priorUnknown; break;
      }
      case 'HOLD_RESOLVE': {
        const s = v.sends.find(x => x.command.send_id === c.send_id); need(s && s.hold && s.receipt?.command.status === 'ACK', 'HOLD_UNRESOLVED');
        sameRole(s.command, c); need(same(c.job_receipt_ref, s.receipt.command.job_receipt_ref), 'HOLD_RECEIPT');
        s.hold = false; s.reconciled = true; s.resolution = e; break;
      }
      case 'JOB_SETTLED': {
        need(!v.pending && !uncertain() && v.active_job === c.job_id && pendingCalls() === 0, 'SETTLEMENT_HELD');
        const cat = v.catalog.find(x => x.binding.job_id === c.job_id); need(cat && !cat.settlement, 'SETTLEMENT');
        cat.settlement = e; v.active_job = null; break;
      }
      case 'CONTROL_SEND_INTENT': {
        need(family === 3 && !v.stopped && !v.pending && v.active_job === c.job_id, 'CONTROL_BLOCKED');
        allocation(e); alive(e, c.deadline);
        const s = v.sends.find(s => s.command.send_id === c.send_id);
        need(s?.receipt?.command.status === 'ACK' && s.command.job_id === c.job_id &&
          s.command.attempt_id === c.attempt_id && s.receipt.command.native.child_thread === c.child_thread, 'CONTROL_TARGET');
        need(!controls.some(x => x.command.control_id === c.control_id || x.command.send_id === c.send_id), 'CONTROL_ALREADY_CONSUMED');
        need(v.spent_calls + pendingCalls() + 1 <= v.allocation!.call_cap, 'BUDGET');
        v.spent_calls++; controls.push({ event: e, command: c, receipt: null, hold: true, state: 'CONTROL_UNCERTAIN' }); break;
      }
      case 'CONTROL_RECEIPT': {
        need(family === 3, 'VERSION'); const control = controls.find(x => x.command.control_id === c.control_id);
        need(control && !control.receipt, 'CONTROL_RECEIPT');
        if (c.status === 'ACK') { need(c.call_id && !nativeCalls.has(c.call_id), 'NATIVE_CALL_REUSE'); nativeCalls.add(c.call_id); }
        control.receipt = e; control.state = c.status === 'ACK' ? 'CONTROL_ACK_PENDING' : 'CONTROL_UNCERTAIN';
        // Transport acknowledgement never clears either the control or writer hold.
        break;
      }
      case 'EXECUTION_VIOLATION': {
        need(v.catalog.some(x => x.binding.job_id === c.job_id) && v.reservations.some(r => r.command.job_id === c.job_id && r.command.attempt_id === c.attempt_id), 'VIOLATION_BINDING');
        for (const id of c.native_call_ids) { need(!nativeCalls.has(id), 'VIOLATION_ALREADY_COUNTED'); nativeCalls.add(id); }
        v.spent_calls += c.native_call_ids.length; v.stopped = true; break;
      }
      default: throw Error('B2_PROJECT_COMMAND');
    }
  }
  return v;
}

export type B2JobView = { scope: 'TEST_ONLY' | 'NATIVE_RULES_ONLY'; events: B2Event[]; binding: B2Record; create: B2Event;
  attempts: B2Record[]; state: 'CREATED' | 'ACTIVE' | 'REJECTED' | 'SATISFIED_TEST_ONLY' | 'SATISFIED_NATIVE_RULES_ONLY' | 'STOP' | 'CANCELLED'; head: string };
const observationKinds = new Set(['ROLE_RECEIPT', 'ROLE_TERMINAL', 'WRITERS_CLOSED', 'REVIEW_RESULT',
  'QA_RESULT', 'INTEGRATION_RESULT', 'CANCEL_OBSERVED', 'LATE_OR_REJECTED_OBSERVATION']);
const stableSubject = (a: B2Record, b: B2Record) => {
  for (const k of ['physical_root', 'physical_identity', 'workspace_id', 'contract_sha256', 'criteria_sha256']) need(a[k] === b[k], 'SUBJECT_BINDING');
};
function rolePlan(binding: B2Record, roles: B2Record[]) {
  const profile = binding.profile.selected_profile;
  const all = roles.flatMap(r => r.purposes);
  need(all.filter(x => x === 'worker').length === 1 && all.filter(x => x === 'qa').length === 1 &&
    all.filter(x => x === 'integration').length === 1, 'ROLE_PLAN');
  const worker = roles.find(r => r.purposes.includes('worker'))!;
  need(worker.actor_policy === 'AUTHOR', 'ROLE_PLAN');
  if (profile === 'prototype') need(roles.length === 1 && same(worker.purposes, ['worker', 'qa', 'integration']), 'ROLE_PLAN');
  else {
    need(same(worker.purposes, ['worker']) && all.filter(x => x === 'review').length === 1, 'ROLE_PLAN');
    need(roles.filter(r => r !== worker).every(r => r.actor_policy === 'INDEPENDENT'), 'ROLE_PLAN');
    if (profile === 'quick_verified') need(roles.length === 2 && roles.some(r => same(r.purposes, ['review', 'qa', 'integration'])) ||
      roles.length === 3 && roles.some(r => same(r.purposes, ['review'])) && roles.some(r => same(r.purposes, ['qa', 'integration'])), 'ROLE_PLAN');
    else need(roles.length === 3 && roles.some(r => same(r.purposes, ['review'])) && roles.some(r => same(r.purposes, ['qa', 'integration'])), 'ROLE_PLAN');
  }
}
function evidenceVerdict(a: B2Record, b: B2Record): 'REJECTED' | 'SATISFIED_TEST_ONLY' {
  if (a.sends.some((s: B2Record) => s.terminal?.command.status !== 'SUCCEEDED')) return 'REJECTED';
  if (a.evidence.some((e: B2Event) => e.command.evidence.findings.length || e.command.evidence.execution &&
    (e.command.evidence.execution.exit_code !== 0 || e.command.evidence.execution.untested.length))) return 'REJECTED';
  const get = (kind: string) => a.evidence.filter((e: B2Event) => e.command.evidence.kind === kind).map((e: B2Event) => e.command.evidence);
  const qa = get('qa'), review = get('review'), integration = get('integration');
  const requirements = [...b.profile.test_depth, ...b.operative.criteria.map((c: string) => `criterion:${c}`)];
  need(qa.length > 0 && requirements.every(r => qa.some((x: B2Record) => x.coverage.includes(r))), 'QA_INCOMPLETE');
  if (b.profile.selected_profile !== 'prototype') need(review.length > 0 && b.operative.criteria.every((r: string) => review.some((x: B2Record) => x.coverage.includes(`criterion:${r}`))), 'REVIEW_INCOMPLETE');
  if (a.subject.integration_target_sha256 !== a.subject.candidate_sha256 ||
    a.command.subject.integration_target_sha256 !== a.subject.integration_target_sha256) need(integration.length > 0 &&
    requirements.every(r => integration.some((x: B2Record) => x.coverage.includes(r))), 'INTEGRATION_INCOMPLETE');
  return 'SATISFIED_TEST_ONLY';
}

export function replayJob(input: unknown): B2JobView {
  return replayJobFamily(input, 2);
}
export function replayNativeJob(input: unknown): B2JobView { return replayJobFamily(input, 3); }
function replayJobFamily(input: unknown, family: B2Family): B2JobView {
  const events = (family === 2 ? validateB2Journal : validateB2NativeJournal)(input, 'job'); const create = events[0]!;
  need(create.command.kind === 'D1_B2_CREATE', 'CREATE_REQUIRED');
  const b = create.command.binding;
  const v: B2JobView = { scope: family === 2 ? 'TEST_ONLY' : 'NATIVE_RULES_ONLY', events, binding: b, create, attempts: [], state: 'CREATED', head: events.at(-1)!.sha256 };
  const allCalls = new Set<string>(), allTurns = new Set<string>(), evidenceIds = new Set<string>();
  for (const e of events.slice(1)) {
    const c = e.command; need(c.job_id === b.job_id && c.task_id === b.task_id, 'JOB_BINDING');
    const a = v.attempts.at(-1);
    if (c.kind === 'ATTEMPT_PREPARE') {
      need(v.attempts.length < 2 && c.ordinal === v.attempts.length + 1 && !v.attempts.some(x => x.command.attempt_id === c.attempt_id), 'ATTEMPT_LIMIT');
      need(c.allocation_id === b.allocation_id, 'ATTEMPT_ALLOCATION'); alive(e, c.deadline);
      need(c.subject.physical_root === b.project.physical_root && c.subject.physical_identity === b.project.physical_identity &&
        c.subject.contract_sha256 === b.operative.contract_ref.sha256 &&
        (family === 3 || c.subject.criteria_sha256 === b2Hash(b.operative.criteria)), 'SUBJECT_BINDING');
      rolePlan(b, c.roles);
      if (a) {
        need(v.state === 'REJECTED' && a.repair && refIs(c.repair_ref, a.repair) && a.closed && !a.cancel &&
          c.subject.candidate_sha256 === a.subject.candidate_sha256 && b2Time(c.deadline) <= b2Time(a.repair.command.deadline), 'REPAIR_REQUIRED');
      } else need(c.repair_ref === null && v.state === 'CREATED', 'UNEXPECTED_REPAIR');
      v.attempts.push({ event: e, command: c, subject: c.subject, sends: [], evidence: [], closed: null,
        outcome: null, repair: null, cancel: null, late: [], observation_count: 0 }); v.state = 'ACTIVE'; continue;
    }
    need(a, 'ATTEMPT_REQUIRED');
    if (observationKinds.has(c.kind)) {
      const owner = c.kind === 'LATE_OR_REJECTED_OBSERVATION'
        ? v.attempts.find(x => x.command.attempt_id === c.attempt_id && x.command.ordinal === c.ordinal)
        : a;
      need(owner && owner.command.attempt_id === c.attempt_id && owner.command.ordinal === c.ordinal, 'OBSERVATION_ATTEMPT');
      // Reject authoritative replay overflow; future Store must retain raw diagnostics separately.
      // Only local cloned projection changes. Input journals and prior records are never mutated.
      need(owner.observation_count < 64, 'ATTEMPT_OBSERVATION_CAPACITY');
      owner.observation_count++;
    }
    if (c.kind === 'LATE_OR_REJECTED_OBSERVATION') {
      const old = v.attempts.find(x => x.command.attempt_id === c.attempt_id && x.command.ordinal === c.ordinal);
      const s = old?.sends.find((x: B2Record) => x.command.send_id === c.send_id);
      need(s?.receipt?.command.native && b2Time(c.received_at) <= b2Time(e.occurred_at), 'LATE_BINDING');
      sameNative(s.receipt.command.native, c.native); old!.late.push(e); continue;
    }
    need(c.attempt_id === a.command.attempt_id && c.ordinal === a.command.ordinal, 'CURRENT_ATTEMPT');
    const role = () => { const s = a.sends.find((x: B2Record) => x.command.send_id === c.send_id);
      need(s, 'SEND_NOT_FOUND'); sameRole(s.command, c); return s; };
    switch (c.kind) {
      case 'D1_B2_CREATE': throw Error('B2_DUPLICATE_CREATE');
      case 'ROLE_SEND_INTENT': {
        need(v.state === 'ACTIVE' && !a.cancel && !a.outcome, 'SEND_BLOCKED'); alive(e, a.command.deadline);
        need(!b.operative.required_guarantees.some((g: string) => ['message_plaintext_equivalence', 'identity_authentication'].includes(g)), 'UNSUPPORTED_REQUIRED_GUARANTEE');
        need(c.expected_job_head === e.previous_sha256 && c.expected_project_head === c.project_send_ref.sha256, 'SEND_HEAD');
        const p = a.command.roles.find((x: B2Record) => x.role_id === c.role_id);
        need(p && same(p.purposes, c.purposes) && !a.sends.some((x: B2Record) => x.command.role_id === c.role_id || x.command.send_id === c.send_id || x.command.reservation_id === c.reservation_id), 'ROLE_PLAN');
        need(a.sends.every((s: B2Record) => s.receipt?.command.status === 'ACK' && s.terminal), 'ROLE_ACTIVE_OR_UNKNOWN');
        if (c.purposes.includes('worker')) need(a.sends.length === 0, 'WORKER_ORDER');
        else {
          need(a.closed && a.sends.some((s: B2Record) => s.command.purposes.includes('worker') && s.terminal?.command.status === 'SUCCEEDED'), 'WRITERS_NOT_CLOSED');
          need(!a.evidence.some((x: B2Event) => x.command.evidence.findings.length || x.command.evidence.execution?.exit_code), 'FAILED_EVIDENCE');
          if (b.profile.selected_profile === 'full_governance' && c.purposes.includes('qa')) need(a.evidence.some((x: B2Event) => x.command.evidence.kind === 'review'), 'REVIEW_REQUIRED');
        }
        a.sends.push({ event: e, command: c, receipt: null, terminal: null }); break;
      }
      case 'ROLE_RECEIPT': {
        const s = role(); need(!s.terminal && (!s.receipt || s.receipt.command.status === 'UNKNOWN' && c.status === 'ACK'), 'DUPLICATE_RECEIPT');
        need(same(c.project_send_ref, s.command.project_send_ref), 'RECEIPT_SEND');
        if (c.native) {
          nativeComplete(c.native);
          if (s.receipt?.command.native) sameNative(s.receipt.command.native, c.native);
          else { need(!allCalls.has(c.native.call_id) && !allTurns.has(c.native.turn_id), 'NATIVE_RUN_REUSE');
            allCalls.add(c.native.call_id); allTurns.add(c.native.turn_id); }
          const authors = v.attempts.flatMap(x => x.sends.filter((r: B2Record) => r.command.purposes.includes('worker') && r.receipt?.command.native).map((r: B2Record) => r.receipt.command.native));
          if (!s.command.purposes.includes('worker')) need(authors.every(n => n.actor_id !== c.native.actor_id && n.child_thread !== c.native.child_thread), 'AUTHOR_NOT_INDEPENDENT');
          if (b.profile.selected_profile === 'full_governance' && !s.command.purposes.includes('worker')) need(a.sends.filter((r: B2Record) => r !== s && !r.command.purposes.includes('worker') && r.receipt?.command.native).every((r: B2Record) =>
            r.receipt.command.native.actor_id !== c.native.actor_id && r.receipt.command.native.child_thread !== c.native.child_thread), 'REVIEW_QA_NOT_SEPARATE');
        }
        s.receipt = e; break;
      }
      case 'ROLE_TERMINAL': {
        const s = role(); need(!s.terminal && s.receipt?.command.status === 'ACK', 'TERMINAL_RECEIPT'); sameNative(s.receipt.command.native, c.native); nativeComplete(c.native);
        need(c.observation.coverage === 'COMPLETE', 'SUBJECT_COVERAGE'); stableSubject(a.subject, c.observation.subject);
        need(c.observation.after_sha256 === c.observation.subject.candidate_sha256 && c.observation.before_sha256 === a.subject.candidate_sha256, 'CANDIDATE_DRIFT');
        if (s.command.purposes.includes('worker')) a.subject = c.observation.subject;
        else need(same(a.subject, c.observation.subject), 'CHECKER_CANDIDATE_DRIFT');
        need(new Set(c.sessions.map((x: B2Record) => x.id)).size === c.sessions.length, 'DUPLICATE_SESSION');
        s.terminal = e; break;
      }
      case 'WRITERS_CLOSED': {
        need(!a.closed && a.sends.length > 0, 'CLOSURE_DUPLICATE');
        const writers = a.sends.filter((s: B2Record) => s.command.purposes.includes('worker'));
        need(c.send_ids.length === writers.length && writers.every((s: B2Record) => c.send_ids.includes(s.command.send_id) &&
          s.terminal && s.terminal.command.sessions.every((x: B2Record) => x.state === 'CLOSED')), 'WRITERS_NOT_CLOSED');
        a.closed = e; break;
      }
      case 'REVIEW_RESULT': case 'QA_RESULT': case 'INTEGRATION_RESULT': {
        need(v.state === 'ACTIVE' && !a.cancel && !a.outcome, 'EVIDENCE_STATE'); alive(e, a.command.deadline);
        const q = c.evidence; const s = a.sends.find((x: B2Record) => x.command.send_id === q.send_id);
        need(s?.receipt?.command.status === 'ACK' && s.command.purposes.includes(q.kind), 'EVIDENCE_ROLE');
        sameNative(s.receipt.command.native, q.native); nativeComplete(q.native);
        need(!evidenceIds.has(q.evidence_id) && a.evidence.length < 64, 'EVIDENCE_LIMIT_OR_DUPLICATE');
        need(q.observation.coverage === 'COMPLETE' && same(q.observation.subject, a.subject) &&
          q.observation.before_sha256 === a.subject.candidate_sha256 && q.observation.after_sha256 === a.subject.candidate_sha256, 'EVIDENCE_SUBJECT');
        const requirements = [...b.profile.test_depth, ...b.operative.criteria.map((r: string) => `criterion:${r}`)];
        // Only the native marked Job's Review may carry the source-recomputed scope coverage token.
        if (family === 3 && b.operative.required_guarantees.includes('scope_review_v1') && q.kind === 'review')
          requirements.push('scope_review_v1');
        need(q.coverage.every((r: string) => requirements.includes(r)), 'UNKNOWN_CHECK');
        if (q.execution) need(q.execution.cwd === a.subject.physical_root && b2Time(q.execution.started_at) >= b2Time(s.event.occurred_at) &&
          b2Time(q.execution.ended_at) <= b2Time(e.occurred_at), 'EXECUTION_CONTEXT');
        evidenceIds.add(q.evidence_id); a.evidence.push(e); break;
      }
      case 'ATTEMPT_OUTCOME': {
        need(v.state === 'ACTIVE' && !a.cancel && !a.outcome && a.closed && a.sends.length > 0 &&
          a.sends.every((s: B2Record) => s.terminal && s.terminal.command.sessions.every((x: B2Record) => x.state === 'CLOSED')), 'OUTCOME_NOT_CLOSED');
        alive(e, a.command.deadline); need(c.evidence_sha256 === b2Hash(a.evidence.map((x: B2Event) => x.sha256)), 'OUTCOME_EVIDENCE');
        const verdict = evidenceVerdict(a, b); a.outcome = e; a.verdict = verdict;
        v.state = verdict === 'REJECTED' ? (c.ordinal === 2 ? 'STOP' : 'REJECTED') :
          family === 2 ? 'SATISFIED_TEST_ONLY' : 'SATISFIED_NATIVE_RULES_ONLY'; break;
      }
      case 'REPAIR_AUTHORIZE': {
        need(v.state === 'REJECTED' && c.ordinal === 1 && !a.repair && a.outcome && refIs(c.failed_outcome_ref, a.outcome) && a.closed && !a.cancel, 'REPAIR_STATE');
        need(c.candidate_sha256 === a.subject.candidate_sha256 && c.allocation_id === a.command.allocation_id, 'REPAIR_BINDING'); alive(e, c.deadline);
        a.repair = e; break;
      }
      case 'CANCEL_REQUESTED': {
        need(v.state === 'ACTIVE' && !a.cancel && a.sends.some((s: B2Record) => s.command.send_id === c.target_send_id), 'CANCEL_STATE');
        a.cancel = { request: e, observed: null }; break;
      }
      case 'CANCEL_OBSERVED': {
        need(a.cancel && !a.cancel.observed && c.target_send_id === a.cancel.request.command.target_send_id && a.closed &&
          a.sends.every((s: B2Record) => s.terminal && s.terminal.command.sessions.every((x: B2Record) => x.state === 'CLOSED')), 'CANCEL_NOT_CLOSED');
        const s = a.sends.find((x: B2Record) => x.command.send_id === c.target_send_id); sameNative(s.receipt.command.native, c.native); nativeComplete(c.native);
        a.cancel.observed = e; v.state = 'CANCELLED'; break;
      }
      default: throw Error('B2_JOB_COMMAND');
    }
  }
  return v;
}
