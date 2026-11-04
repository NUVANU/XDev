import { B2_GUARANTEES, b2Hash, b2BytesHash, b2Need as need, b2Time, validateB2Inspection, validateB2NativeInspection,
  type B2Family, type B2Event, type B2Record } from './d1-b2-contracts.ts';
import { replayProject, replayJob, replayNativeProject, replayNativeJob, type B2JobView } from './d1-b2-state.ts';

/** Inspection replays bytes itself. It never accepts a caller's supposedly trusted view. */
export function inspectB2Pair(input: unknown) {
  return inspectPair(input, false, 2);
}
/** A source query supplies its already selected Job; omission preserves the original current-Job view. */
export function inspectB2NativeRules(input: unknown, targetJobId?: string) { return inspectPair(input, false, 3, targetJobId); }

/** Structural replay is shared by disk transactions. It grants no execution authority. */
export function inspectB2Structure(input: unknown) {
  const result = inspectPair(input, true, 2);
  return { scope: 'TEST_ONLY' as const, structurally_complete: result.reasons.length === 0,
    integrity_reasons: result.reasons, holds: result.holds, project_state: result.project_state,
    jobs: result.jobs, production_verification: false as const, delivery_claim_allowed: false as const };
}
export function inspectB2NativeStructure(input: unknown) {
  const result = inspectPair(input, true, 3);
  return { scope: 'NATIVE_RULES_ONLY' as const, structurally_complete: result.reasons.length === 0,
    integrity_reasons: result.reasons, holds: result.holds, project_state: result.project_state,
    jobs: result.jobs, production_verification: false as const, delivery_claim_allowed: false as const };
}

function inspectPair(input: unknown, structuralOnly: boolean, family: B2Family, targetJobId?: string) {
  const x = (family === 2 ? validateB2Inspection : validateB2NativeInspection)(input);
  const p = (family === 2 ? replayProject : replayNativeProject)(x.project_events);
  const jobs: B2JobView[] = x.job_journals.map((j: unknown) => (family === 2 ? replayJob : replayNativeJob)(j));
  const reasons = new Set<string>(); const reject = (ok: unknown, reason: string) => { if (!ok) reasons.add(reason); };
  const same = (a: unknown, b: unknown) => b2Hash(a) === b2Hash(b);
  const refIs = (r: B2Record, e: B2Event) => r.id === e.operation_id && r.sha256 === e.sha256;
  const ordered = (a: B2Event, b: B2Event) => b2Time(a.occurred_at) <= b2Time(b.occurred_at);
  const sameRole = (a: B2Record, b: B2Record) => ['job_id', 'task_id', 'attempt_id', 'ordinal', 'role_id', 'send_id', 'reservation_id'].every(k => a[k] === b[k]);
  const allEvents: B2Event[] = [...p.events, ...jobs.flatMap(j => j.events)];
  need(new Set(allEvents.map(e => e.operation_id)).size === allEvents.length, 'CROSS_JOURNAL_OPERATION_REUSE');
  need(new Set(jobs.map(j => j.binding.job_id)).size === jobs.length, 'DUPLICATE_JOB');
  reject(allEvents.every(e => b2Time(e.occurred_at) <= b2Time(x.now)), 'FUTURE_EVENT');
  reject(x.facts.coverage === 'COMPLETE' && same(x.facts.project, p.project), 'SOURCE_COVERAGE');
  const holds: string[] = [];
  // Control closure is a projection of the paired job's original closure, never an ACK-derived terminal.
  if (family === 3) for (const control of p.controls ?? []) {
    const job = jobs.find(j => j.binding.job_id === control.command.job_id);
    const attempt = job?.attempts.find(a => a.command.attempt_id === control.command.attempt_id);
    const closed = attempt?.cancel?.observed;
    if (closed && control.receipt?.command.status === 'ACK' && closed.command.target_send_id === control.command.send_id &&
      same(closed.command.native, control.receipt.command.native) && attempt!.closed &&
      attempt!.sends.every((s: B2Record) => s.terminal && s.terminal.command.sessions.every((x: B2Record) => x.state === 'CLOSED'))) {
      control.hold = false; control.state = 'OBSERVED_CLOSED';
    }
  }
  if (p.stopped) holds.push('EXECUTION_VIOLATION');
  if (p.sends.some(s => s.hold)) holds.push('SEND_UNCERTAIN');
  if (p.reservations.some(r => !r.sent)) holds.push('RESERVATION_UNSENT');
  if (p.controls?.some(c => c.hold)) holds.push('CONTROL_UNCERTAIN');
  if (!structuralOnly) { reject(!p.stopped, 'EXECUTION_VIOLATION'); reject(p.sends.every(s => !s.hold), 'SEND_UNCERTAIN'); }
  reject(!p.pending, 'CREATE_INCOMPLETE');

  const knownRefs = allEvents.map(e => ({ id: e.operation_id, sha256: e.sha256 }));
  const sourceRefs = x.facts.source_refs as B2Record[];
  const allRefs: B2Record[] = [];
  const collect = (v: any): void => {
    if (!v || typeof v !== 'object') return;
    if (!Array.isArray(v) && Object.keys(v).sort().join(',') === 'id,sha256') allRefs.push(v);
    else for (const child of Object.values(v)) collect(child);
  };
  for (const e of allEvents) collect(e.command);
  reject(allRefs.every(r => knownRefs.some(k => same(k, r)) || sourceRefs.some(k => same(k, r))), 'SOURCE_REFERENCE_MISSING');
  const names = new Map<string, string>();
  for (const r of [...knownRefs, ...sourceRefs, ...allRefs]) {
    reject(!names.has(r.id) || names.get(r.id) === r.sha256, 'SOURCE_REFERENCE_REBOUND'); names.set(r.id, r.sha256);
  }
  const nativeRecords = x.facts.native_records as B2Record[];
  const packets = x.facts.controller_packets as B2Record[];
  reject(nativeRecords.every(n => p.sends.some(s => s.command.send_id === n.send_id)), 'ORPHAN_NATIVE_SOURCE');
  reject(packets.every(n => p.sends.some(s => s.command.send_id === n.send_id)), 'ORPHAN_PACKET');

  for (const cat of p.catalog) {
    const j = jobs.find(j => j.binding.job_id === cat.binding.job_id);
    reject(!!j, 'JOB_HISTORY_MISSING'); if (!j) continue;
    reject(same(j.binding, cat.binding) && refIs(j.create.command.project_intent_ref, cat.intent) &&
      refIs(cat.commit.command.job_create_ref, j.create) && ordered(cat.intent, j.create) && ordered(j.create, cat.commit), 'CREATE_PAIR_MISMATCH');
    const allocationEvent = p.events.find(e => e.command.kind === 'ALLOCATION_SET' && e.command.allocation_id === cat.binding.allocation_id);
    reject(!!allocationEvent && ordered(allocationEvent, cat.intent), 'CREATE_ALLOCATION');
    if (cat.settlement) {
      const final = j.attempts.at(-1); const terminal = final?.outcome ?? final?.cancel?.observed;
      reject(!!terminal && ['SATISFIED_TEST_ONLY', 'SATISFIED_NATIVE_RULES_ONLY', 'REJECTED', 'STOP', 'CANCELLED'].includes(j.state) &&
        refIs(cat.settlement.command.job_terminal_ref, terminal) && ordered(terminal, cat.settlement) &&
        !final?.repair && !!final?.closed, 'SETTLEMENT_PAIR');
    }
    for (const a of j.attempts) {
      reject(ordered(cat.commit, a.event) && !!allocationEvent && b2Time(a.command.deadline) <= b2Time(allocationEvent.command.deadline), 'ATTEMPT_AUTHORITY');
      const reserves = p.reservations.filter(r => r.command.job_id === j.binding.job_id && r.command.attempt_id === a.command.attempt_id);
      const worker = reserves.filter(r => r.command.purposes.includes('worker'));
      reject(worker.length === 1 && a.command.reservation_refs.length === 1 && worker.some(r =>
        refIs(a.command.reservation_refs[0], r.event) && ordered(r.event, a.event)), 'ATTEMPT_RESERVATION_PAIR');
      if (a.command.ordinal === 2) {
        const prior = j.attempts[0]!;
        reject(!!prior.repair && worker.every(r => ordered(prior.repair, r.event)), 'REPAIR_RESERVATION_ORDER');
      }
      for (const r of reserves) {
        const role = a.command.roles.find((z: B2Record) => z.role_id === r.command.role_id);
        reject(!!role && r.command.task_id === j.binding.task_id && r.command.ordinal === a.command.ordinal &&
          same(role.purposes, r.command.purposes) && r.command.allocation_id === a.command.allocation_id &&
          b2Time(r.command.deadline) === b2Time(a.command.deadline), 'RESERVATION_PLAN');
        if (!r.command.purposes.includes('worker')) reject(ordered(a.event, r.event), 'ROLE_RESERVATION_ORDER');
      }
      const workerSend = a.sends.find((s: B2Record) => s.command.purposes.includes('worker'));
      if (workerSend?.receipt?.command.native) {
        const n = workerSend.receipt.command.native;
        reject(nativeRecords.some(z => z.send_id === workerSend.command.send_id && same(z.native, n)), 'WORKER_NATIVE_SOURCE');
      }
      for (const s of a.sends) {
        const ps = p.sends.find(z => z.command.send_id === s.command.send_id);
        reject(!!ps, 'JOB_SEND_UNPAIRED'); if (!ps) continue;
        reject(sameRole(s.command, ps.command) && same(s.command.purposes, ps.command.purposes) &&
          s.command.packet_sha256 === ps.command.packet_sha256 && refIs(s.command.project_send_ref, ps.event) &&
          s.command.expected_project_head === ps.event.sha256 && ps.command.expected_job_head === s.event.previous_sha256 &&
          ordered(a.event, ps.event) && ordered(ps.event, s.event), 'SEND_PAIR_MISMATCH');
        const packet = packets.find(z => z.send_id === s.command.send_id);
        reject(!!packet && packet.sha256 === s.command.packet_sha256 && packet.sha256 === b2Hash({
          request_fields: packet.request_fields, plaintext_sha256: packet.plaintext_sha256 }), 'CONTROLLER_PACKET_MISSING');
        const receipts = j.events.filter(e => e.command.kind === 'ROLE_RECEIPT' && e.command.send_id === s.command.send_id);
        const projectReceipts = p.events.filter(e => e.command.kind === 'ROLE_RECEIPT' && e.command.send_id === s.command.send_id);
        reject(receipts.length === projectReceipts.length && (structuralOnly || receipts.length > 0), 'RECEIPT_PAIR_MISSING');
        for (const jr of receipts) {
          reject(projectReceipts.some(pr => refIs(pr.command.job_receipt_ref, jr) && sameRole(pr.command, jr.command) &&
            pr.command.status === jr.command.status && same(pr.command.native, jr.command.native) && ordered(jr, pr)), 'RECEIPT_PAIR_MISMATCH');
          if (jr.command.native) {
            const n = jr.command.native;
            reject(nativeRecords.some(z => z.send_id === s.command.send_id && same(z.native, n)), 'NATIVE_SOURCE_MISSING');
            reject(!!packet && same(n.request_fields, packet.request_fields) && n.agent_path.endsWith('/' + n.request_fields.task_name), 'NATIVE_VISIBLE_REQUEST_MISMATCH');
            if (n.message.representation === 'visible_plaintext') reject(!!packet && b2BytesHash(n.message.parent_value) === packet.plaintext_sha256, 'VISIBLE_PLAINTEXT_MISMATCH');
          }
        }
        if (ps.resolution) reject(!!s.receipt && s.receipt.command.status === 'ACK' && refIs(ps.resolution.command.job_receipt_ref, s.receipt), 'HOLD_RESOLUTION_PAIR');
      }
    }
  }
  for (const j of jobs) reject(p.catalog.some(c => c.binding.job_id === j.binding.job_id) ||
    !!p.pending && same(p.pending.command.binding, j.binding) && refIs(j.create.command.project_intent_ref, p.pending), 'ORPHAN_JOB');
  for (const r of p.reservations) reject(jobs.some(j => j.attempts.some(a => a.command.attempt_id === r.command.attempt_id &&
    j.binding.job_id === r.command.job_id && a.command.roles.some((z: B2Record) => z.role_id === r.command.role_id))), 'RESERVATION_UNPAIRED');
  for (const s of p.sends) reject(jobs.some(j => j.attempts.some(a => a.sends.some((z: B2Record) => z.command.send_id === s.command.send_id))), 'PROJECT_SEND_UNPAIRED');

  // An explicit missing target never falls back to the active or last Job.
  const current = targetJobId !== undefined ? jobs.find(j => j.binding.job_id === targetJobId) :
    jobs.find(j => j.binding.job_id === p.active_job) ?? jobs.find(j => j.binding.job_id === p.catalog.at(-1)?.binding.job_id);
  const attempt = current?.attempts.at(-1);
  const allCurrentNative = !!attempt && attempt.sends.length > 0 && attempt.sends.every((s: B2Record) => s.receipt?.command.status === 'ACK' &&
    nativeRecords.some(n => n.send_id === s.command.send_id && same(n.native, s.receipt.command.native)));
  const subjectMatches = !!attempt && x.facts.current_subject !== null && same(attempt.subject, x.facts.current_subject);
  const closed = !!attempt?.closed && attempt.sends.every((s: B2Record) => s.terminal && s.terminal.command.sessions.every((z: B2Record) => z.state === 'CLOSED'));
  const quality = current?.state === (family === 2 ? 'SATISFIED_TEST_ONLY' : 'SATISFIED_NATIVE_RULES_ONLY');
  const guarantees: Record<string, string> = {
    controller_intent: current ? 'LOCALLY_BOUND_TEST_ONLY' : 'INCOMPLETE',
    native_call_linkage: allCurrentNative ? 'OBSERVED_TEST_ONLY' : 'INCOMPLETE',
    message_plaintext_equivalence: allCurrentNative && attempt!.sends.every((s: B2Record) => s.receipt.command.native.message.representation === 'visible_plaintext') ? 'OBSERVED_TEST_ONLY' : 'UNSUPPORTED',
    execution_subject: subjectMatches && attempt!.sends.length > 0 && attempt!.sends.every((s: B2Record) => s.terminal) ? 'OBSERVED_TEST_ONLY' : 'INCOMPLETE',
    known_writer_closure: closed ? 'OBSERVED_TEST_ONLY' : 'INCOMPLETE',
    quality_evidence: quality ? 'OBSERVED_TEST_ONLY' : 'INCOMPLETE',
    identity_authentication: 'UNSUPPORTED',
    scope_review_v1: 'UNSUPPORTED',
  };
  if (family === 3) {
    guarantees.controller_intent = current ? 'LOCALLY_BOUND' : 'INCOMPLETE';
    guarantees.native_call_linkage = allCurrentNative ? 'OBSERVED_NATIVE_PARTIAL' : 'INCOMPLETE';
    guarantees.message_plaintext_equivalence = 'UNSUPPORTED';
    guarantees.execution_subject = subjectMatches && attempt!.sends.length > 0 && attempt!.sends.every((s: B2Record) => s.terminal)
      ? 'OBSERVED_CURRENT_RECORDER_SUBJECT' : 'INCOMPLETE';
    guarantees.known_writer_closure = closed ? 'ALL_KNOWN_SUPPORTED_TURN_TOOLS_CLOSED' : 'INCOMPLETE';
    guarantees.quality_evidence = quality ? 'ACTUAL_APPLICABLE_NATIVE_COMMANDS' : 'INCOMPLETE';
    guarantees.identity_authentication = 'COOPERATIVE_DELEGATE_PARTIAL';
    // This existing evidence coverage token is derived/rechecked against the original opinion,
    // READ bytes, first authorized baseline and deterministic diff recomputation by the native source consumer.
    // As with all pair facts, plain caller-supplied events never confer a native source brand.
    const scopeEvidence = attempt?.evidence.filter((e: B2Event) => e.command.evidence.kind === 'review') ?? [];
    const scopeComplete = quality && scopeEvidence.length === 1 && scopeEvidence[0]!.command.evidence.coverage.includes('scope_review_v1') &&
      scopeEvidence[0]!.command.evidence.findings.length === 0;
    guarantees.scope_review_v1 = current?.binding.operative.required_guarantees.includes('scope_review_v1')
      ? scopeComplete ? 'SOURCE_BOUND_SCOPE_REVIEW' : 'INCOMPLETE' : 'NOT_REQUIRED';
  }
  if (!structuralOnly) reject(!!current, 'CURRENT_JOB_MISSING');
  if (current && !structuralOnly) {
    reject(subjectMatches, 'CURRENT_SUBJECT_MISMATCH');
    reject(!attempt?.cancel || !!attempt.cancel.observed, 'CANCELLATION_PENDING');
    const required = new Set(['controller_intent', 'native_call_linkage', 'execution_subject', 'known_writer_closure', 'quality_evidence',
      ...current.binding.operative.required_guarantees]);
    const satisfied: Record<string, string[]> = {
      controller_intent: ['LOCALLY_BOUND_TEST_ONLY', 'LOCALLY_BOUND'],
      native_call_linkage: ['OBSERVED_TEST_ONLY', 'OBSERVED_NATIVE_PARTIAL'],
      message_plaintext_equivalence: ['OBSERVED_TEST_ONLY'],
      execution_subject: ['OBSERVED_TEST_ONLY', 'OBSERVED_CURRENT_RECORDER_SUBJECT'],
      known_writer_closure: ['OBSERVED_TEST_ONLY', 'ALL_KNOWN_SUPPORTED_TURN_TOOLS_CLOSED'],
      quality_evidence: ['OBSERVED_TEST_ONLY', 'ACTUAL_APPLICABLE_NATIVE_COMMANDS'],
      identity_authentication: [], scope_review_v1: ['SOURCE_BOUND_SCOPE_REVIEW'],
    };
    for (const g of required) reject(satisfied[g]?.includes(guarantees[g]!) === true,
      guarantees[g] === 'UNSUPPORTED' ? `UNSUPPORTED_REQUIRED:${g}` : `MISSING_REQUIRED:${g}`);
    if (required.has('scope_review_v1') && guarantees.scope_review_v1 !== 'SOURCE_BOUND_SCOPE_REVIEW') reject(false, 'SCOPE_REVIEW_INCOMPLETE');
    reject(!!attempt && b2Time(x.now) < b2Time(attempt.command.deadline), 'CURRENT_EXPIRED');
    reject(quality, 'QUALITY_NOT_SATISFIED');
  }
  // A guarantee is a simulated observation only if all its required source pairing succeeded.
  if (reasons.size) for (const g of B2_GUARANTEES) if (guarantees[g] === 'OBSERVED_TEST_ONLY') guarantees[g] = 'INCOMPLETE';
  if (family === 3 && reasons.size) for (const g of B2_GUARANTEES)
    if (!['UNSUPPORTED', 'INCOMPLETE', 'NOT_REQUIRED', 'COOPERATIVE_DELEGATE_PARTIAL'].includes(guarantees[g]!)) guarantees[g] = 'INCOMPLETE';
  return { scope: family === 2 ? 'TEST_ONLY' as const : 'NATIVE_RULES_ONLY' as const, production_verification: false as const, delivery_claim_allowed: false as const,
    eligible: reasons.size === 0, decision: reasons.size ? 'TEST_ONLY_INCOMPLETE_OR_REJECTED' :
      current?.binding.profile.selected_profile === 'prototype' ? 'PROTOTYPE_UNVERIFIED' :
        family === 2 ? 'TEST_ONLY_REQUIREMENTS_SATISFIED' : 'NATIVE_RULES_REQUIREMENTS_SATISFIED',
    reasons: [...reasons], holds, guarantees, spent_calls: p.spent_calls, spent_attempts: p.spent_attempts,
    reserved_calls: p.reservations.filter(r => !r.sent).length, current_job: current?.binding.job_id ?? null,
    current_attempt: attempt?.command.ordinal ?? null, project_state: p, jobs };
}
