import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { b2Exact as exact, b2Need as need, b2Hash, b2Time, b2List, type B2Record, type B2Event } from '../job-runtime/d1-b2-contracts.ts';
import { inspectB2NativeRules, inspectB2NativeStructure } from '../job-runtime/d1-b2-pair.ts';
import { replayNativeProject, replayNativeJob } from '../job-runtime/d1-b2-state.ts';
import { canonical } from '../job-runtime/storage-identity.ts';
import { checkedRelativeFile, readProjectFile, projectRootIdentity, sha256 } from '../project-model/init-receipt.ts';
import { parseD1UniqueJson } from '../job-runtime/contracts.ts';
import { appendNativeEvent, eventId, eventRef, bootstrapNativeSources, jobNativeSources, domainSource,
  nativeCurrentSubject, withB2NativeSourceCheck, nativeManifestHash, assertB2ScopeReviewBinding, b2RoleReadPlan, b2ScopeReviewPaths,
  scopeContains, jsonBytes, uuid, hash, type Source, type NativeDomain } from './d1-b2-source.ts';
import { openB2NativeBundle, isActualNativeBundle, assertB2ActualNativeBundle, readB2NativeGrant, observeB2Role,
  observedB2Children, verifyOriginalRefs, prepareReturnBound, assertAfterPrepare,
  nativeRowRef, nativeRowSource, revalidateB2NativeBundle,
  type B2NativeBundle, type GrantLocator, type TestNativeContext, type ObservedB2Role } from './d1-b2-native-port.ts';
import { resolveB2OperationJob, type B2Loaded, type B2DiskPlan } from '../job-runtime/d1-b2-storage.ts';
import { mapB2PatchPaths } from './d1-b2-patch-path.ts';
export { assertB2ActualNativeBundle } from './d1-b2-native-port.ts';
export { inspectB2NativeRules } from '../job-runtime/d1-b2-pair.ts';

const same = (a: unknown, b: unknown) => nativeManifestHash(a) === nativeManifestHash(b);
const LIMITATIONS = ['COOPERATIVE_NATIVE_PARTIAL', 'OPAQUE_MESSAGE_NOT_PLAINTEXT_PROOF',
  'NO_STRONG_OWNER_AUTHENTICATION', 'NO_GLOBAL_WRITER_CLOSURE'];
const merge = (old: Source[], additions: Source[]) => {
  const all = [...old]; for (const s of additions) { const previous = all.find(x => x.id === s.id);
    need(!previous || same(previous, s), 'SOURCE_REBOUND'); if (!previous) all.push(s); }
  need(all.length <= 64, 'SOURCE_CAPACITY'); return all;
};
function sourceFile(root: string, path: string): Source {
  checkedRelativeFile(path); const bytes = readProjectFile(root, path).toString('utf8');
  need(Buffer.byteLength(bytes) <= 1048576, 'SOURCE_SIZE'); return { id: 'file:' + path, path, bytes, sha256: sha256(bytes) };
}
function sourceJson(root: string, path: string) {
  const source = sourceFile(root, path), value = parseD1UniqueJson(source.bytes) as B2Record;
  exact(value, Object.keys(value)); need(jsonBytes(value) === source.bytes, 'SOURCE_NONCANONICAL'); return { source, value };
}
function actionAllowed(bundle: B2NativeBundle, action: string) {
  need(bundle.policy.scope.allowed_actions.includes(action) && !bundle.policy.scope.forbidden_actions.includes(action), 'ACTION_NOT_ALLOWED');
}
function canonicalRoles(bundle: B2NativeBundle, binding: B2Record) {
  const roles = bundle.policy.roles.filter((r: B2Record) => r.profile === binding.profile.selected_profile)
    .sort((a: B2Record, b: B2Record) => a.ordinal - b.ordinal);
  need(bundle.policy.profiles.includes(binding.profile.selected_profile) && roles.length > 0 &&
    roles.every((r: B2Record, i: number) => r.ordinal === i + 1), 'ROLE_PLAN');
  return roles as B2Record[];
}
function roleProofs(loaded: B2Loaded | null) {
  return loaded?.operations.map(o => o.begin.source_proof).filter((p): p is B2Record => !!p?.plan && p.action === 'PREPARE_ROLE') ?? [];
}
function withChildren(root: string, loaded: B2Loaded | null, locator: GrantLocator | undefined, test?: TestNativeContext) {
  const refs = loaded?.operations.flatMap(o => o.begin.source_proof?.native_refs ?? []) ?? [];
  const first = openB2NativeBundle(root, locator, test, [], refs);
  const plans = roleProofs(loaded), children = observedB2Children(first, plans.map(p => p.plan.request_fields.task_name));
  if (!children.length) return first;
  const final = openB2NativeBundle(root, locator, test, children, refs);
  for (const old of first.rows) { const fresh = final.rows.find(r => r.ref.locator === old.ref.locator && r.record.ordinal === old.record.ordinal);
    need(fresh?.ref.sha256 === old.ref.sha256, 'NATIVE_SOURCE_DRIFT'); }
  return final;
}
type SubjectCheck = (bundle: B2NativeBundle, binding: B2Record) => ReturnType<typeof nativeCurrentSubject>;
function withSubjectCheck<T>(work: (subject: SubjectCheck) => T): T {
  return withB2NativeSourceCheck(read => {
    let active = true; const subjects = new Map<string, ReturnType<typeof nativeCurrentSubject>>();
    const subject: SubjectCheck = (bundle, binding) => {
      need(active, 'SOURCE_CHECK_CLOSED');
      need(same(binding.operative.allowed_scope, bundle.policy.scope.allowed_paths) &&
        same(binding.operative.forbidden_scope, bundle.policy.scope.forbidden_paths), 'TASK_POLICY_SCOPE');
      need([...new Set([...binding.operative.required_guarantees, ...bundle.policy.required_guarantees])]
        .every(g => !['message_plaintext_equivalence', 'identity_authentication'].includes(g)), 'UNSUPPORTED_REQUIRED_GUARANTEE');
      const key = canonical({ root: bundle.root, mode: bundle.mode, policy_sha256: bundle.policy_sha256,
        policy: bundle.policy, binding });
      let current = subjects.get(key);
      if (!current) { current = read.currentSubject(bundle.root, bundle.policy, binding.operative.contract_ref); subjects.set(key, current); }
      assertB2ScopeReviewBinding(binding.operative, current.task, bundle.policy);
      need(current.subject.contract_sha256 === binding.operative.contract_ref.sha256 &&
        current.subject.environment_sha256 === nativeManifestHash(current.environment), 'SOURCE_SUBJECT_BINDING');
      // Historical reconstruction changes its local subject/candidate; never expose the retained value.
      return structuredClone(current);
    };
    try { return work(subject); } finally { active = false; subjects.clear(); }
  });
}
function requestRefs(bundle: B2NativeBundle, binding: B2Record, ids: B2Record, role: B2Record, current: ReturnType<typeof nativeCurrentSubject>) {
  const refs: B2Record[] = [], sources: Source[] = [];
  for (const path of bundle.policy.scope.managed_inputs as string[]) {
    if (!existsSync(join(bundle.root, path))) continue;
    const s = sourceFile(bundle.root, path); if (!s.bytes.startsWith('{')) continue;
    let request: B2Record; try { request = parseD1UniqueJson(s.bytes) as B2Record; } catch { continue; }
    if (request?.format !== 'xdev-native-recorder-request-3' || request.role_id !== ids.role_id) continue;
    exact(request, ['format', 'job_id', 'task_id', 'attempt_id', 'role_id', 'subject', 'contract_ref', 'criteria_ref',
      'candidate_manifest', 'environment', 'mode', 'read_plan', 'test_plan', 'managed_request_identity']);
    need(['job_id', 'task_id', 'attempt_id', 'role_id'].every(k => request[k] === ids[k]) &&
      same(request.subject, current.subject) && same(request.candidate_manifest, current.candidate) &&
      same(request.environment, current.environment) && same(request.contract_ref, binding.operative.contract_ref), 'RECORDER_REQUEST_BINDING');
    need(current.task.criteria.some((ac: B2Record) => same(request.criteria_ref,
      { id: 'file:' + ac.source_ref.path, sha256: ac.source_ref.sha256 })), 'RECORDER_CRITERIA_BINDING');
    need(same(request.read_plan, b2RoleReadPlan(bundle.policy, binding, role, ids.ordinal)) &&
      same(request.test_plan, bundle.policy.test_plan.filter((p: B2Record) => p.role_ordinal === role.ordinal)), 'RECORDER_PLAN_BINDING');
    exact(request.managed_request_identity, ['dev', 'ino', 'relativepath']); const stat = lstatSync(join(bundle.root, path), { bigint: true });
    need(request.managed_request_identity.relativepath === path && request.managed_request_identity.dev === String(stat.dev) &&
      request.managed_request_identity.ino === String(stat.ino), 'RECORDER_REQUEST_IDENTITY');
    need(['READ', 'QA'].includes(request.mode) && jsonBytes(request) === s.bytes, 'RECORDER_REQUEST');
    refs.push({ id: s.id, path, sha256: s.sha256, mode: request.mode }); sources.push(s);
  }
  need(refs.filter(r => r.mode === 'READ').length === 1 && refs.filter(r => r.mode === 'QA').length ===
    (role.purposes.includes('qa') ? 1 : 0), 'RECORDER_REQUEST_REQUIRED');
  if (binding.operative.required_guarantees.includes('scope_review_v1') && role.purposes.includes('review'))
    need(refs.find(r => r.mode === 'READ')!.path === b2ScopeReviewPaths(ids.ordinal).request, 'SCOPE_ATTEMPT_REQUEST');
  refs.sort((a, b) => a.mode === b.mode ? 0 : a.mode === 'READ' ? -1 : 1);
  return { refs: refs.map(({ mode, ...r }) => r), sources };
}
function prepareBinding(bundle: B2NativeBundle, loaded: B2Loaded, jobId: string, operation: string, action: string, grant: B2Record,
  subject: SubjectCheck, historicalCurrent?: ReturnType<typeof nativeCurrentSubject>) {
  const p = loaded.structure.project_state, j = loaded.structure.jobs.find(j => j.binding.job_id === jobId); need(j, 'JOB_NOT_FOUND');
  const b = j.binding, roles = canonicalRoles(bundle, b), actualCurrent = subject(bundle, b), current = historicalCurrent ?? actualCurrent,
    previous = j.attempts.at(-1);
  need(['physical_root', 'physical_identity', 'workspace_id', 'contract_sha256', 'criteria_sha256', 'environment_sha256']
    .every(k => current.subject[k as keyof typeof current.subject] === actualCurrent.subject[k as keyof typeof actualCurrent.subject]), 'SOURCE_SUBJECT_BINDING');
  let ordinal = previous?.command.ordinal ?? 1, seed = previous ?
    loaded.operations.find(o => o.begin.source_proof?.plan?.attempt_id === previous.command.attempt_id)?.begin.operation_id : operation;
  if (action === 'PREPARE_ROLE' && previous?.outcome) {
    need(j.state === 'REJECTED' && previous.closed && !previous.cancel && previous.command.ordinal === 1, 'REPAIR_REQUIRED');
    ordinal++; seed = operation;
  }
  need(seed && ordinal <= 2, 'ATTEMPT_LIMIT');
  let roleOrdinal = 1;
  if (action === 'PREPARE_ROLE' && previous && !previous.outcome) {
    need(!previous.cancel && p.sends.every(s => !s.hold) && !(p.controls ?? []).some(c => c.hold), 'SEND_BLOCKED');
    need(previous.sends.every((s: B2Record) => s.terminal && s.terminal.command.sessions.every((x: B2Record) => x.state === 'CLOSED')), 'ROLE_ACTIVE_OR_UNKNOWN');
    roleOrdinal = previous.sends.length + 1;
  } else if (action !== 'PREPARE_ROLE') {
    const original = roleProofs(loaded).find(proof => proof.plan.role_id ===
      grantRoleId(bundle, b, eventRef(j.create), seed!, ordinal, grant.planned_binding_sha256, operation, action, roles, current.subject, p.head, j.head));
    // Reconcile/cancel may target any already sent role, but never manufacture a fresh role.
    if (original) roleOrdinal = original.plan.role_ordinal;
    else roleOrdinal = previous?.sends.at(-1)?.command.purposes.includes('worker') ? 1 : previous?.sends.length ?? 1;
  }
  const role = roles[roleOrdinal - 1]; need(role, 'ROLE_PLAN');
  const ids = { job_id: b.job_id, task_id: b.task_id, attempt_id: eventId(seed, 'attempt'), ordinal,
    role_id: eventId(seed, 'role:' + roleOrdinal), reservation_id: eventId(seed, 'reservation:' + roleOrdinal), send_id: eventId(seed, 'send:' + roleOrdinal) };
  const planRoles = roles.map(r => ({ role_id: eventId(seed!, 'role:' + r.ordinal), purposes: r.purposes, actor_policy: r.actor_policy }));
  const requestFields = { task_name: `d1_${bundle.policy.epoch_id.slice(0, 8)}_${b.request_id.slice(0, 8)}_a${ordinal}_r${roleOrdinal}`,
    agent_type: role.agent_type, model: role.model, reasoning_effort: role.reasoning_effort, fork_turns: 'none' };
  const planned = { epoch_id: bundle.policy.epoch_id, project_id: p.project.project_id, job_id: b.job_id, task_id: b.task_id,
    create_ref: eventRef(j.create), operation_id: operation, action, attempt_id: ids.attempt_id, ordinal, role_id: ids.role_id,
    reservation_id: ids.reservation_id, send_id: ids.send_id, role_ordinal: roleOrdinal, subject_sha256: b2Hash(current.subject),
    role_plan_sha256: b2Hash(planRoles), request_fields: requestFields, project_head: p.head, job_head: j.head };
  const checks = { create_ref: eventRef(j.create), job_id: b.job_id, task_id: b.task_id, contract_sha256: current.subject.contract_sha256,
    criteria_sha256: current.subject.criteria_sha256, operative_sha256: b.operative_sha256, project_head: p.head, job_head: j.head,
    operation_id: operation, action, planned_binding_sha256: b2Hash(planned), subject_sha256: b2Hash(current.subject), role_plan_sha256: b2Hash(planRoles),
    allowed_scope_sha256: b2Hash({ actions: bundle.policy.scope.allowed_actions, paths: b.operative.allowed_scope }),
    forbidden_scope_sha256: b2Hash({ actions: bundle.policy.scope.forbidden_actions, paths: b.operative.forbidden_scope }),
    previous_spent_calls: p.spent_calls, previous_spent_attempts: p.spent_attempts, previous_reserved_calls: p.reservations.filter(r => !r.sent).length,
    call_cap: p.allocation!.call_cap, attempt_cap: p.allocation!.attempt_cap, deadline: p.allocation!.deadline,
    required_guarantees: [...new Set([...b.operative.required_guarantees, ...bundle.policy.required_guarantees])] };
  for (const [k, v] of Object.entries(checks)) need(same(grant[k], v), k === 'create_ref' ? 'GRANT_CREATE_BINDING' : 'GRANT_CANONICAL_BINDING');
  return { p, j, b, role, roles, ids, planRoles, requestFields, planned, current, seed, first: !previous || !!previous.outcome };
}
function grantRoleId(bundle: B2NativeBundle, b: B2Record, createRef: B2Record, seed: string, ordinal: number, digest: string, operation: string,
  action: string, roles: B2Record[], currentSubject: B2Record, projectHead: string, jobHead: string) {
  const planRoles = roles.map(r => ({ role_id: eventId(seed, 'role:' + r.ordinal), purposes: r.purposes, actor_policy: r.actor_policy }));
  for (const r of roles) {
    const planned = { epoch_id: bundle.policy.epoch_id, project_id: b.project.project_id, job_id: b.job_id, task_id: b.task_id,
      create_ref: createRef, operation_id: operation, action, attempt_id: eventId(seed, 'attempt'), ordinal,
      role_id: eventId(seed, 'role:' + r.ordinal), reservation_id: eventId(seed, 'reservation:' + r.ordinal), send_id: eventId(seed, 'send:' + r.ordinal),
      role_ordinal: r.ordinal, subject_sha256: b2Hash(currentSubject), role_plan_sha256: b2Hash(planRoles),
      request_fields: { task_name: `d1_${bundle.policy.epoch_id.slice(0, 8)}_${b.request_id.slice(0, 8)}_a${ordinal}_r${r.ordinal}`,
        agent_type: r.agent_type, model: r.model, reasoning_effort: r.reasoning_effort, fork_turns: 'none' }, project_head: projectHead, job_head: jobHead };
    // The caller supplies only the digest; role identity is still selected from the canonical sent plan below.
    if (b2Hash(planned) === digest) return planned.role_id;
  }
  return null;
}

function makeProof(bundle: B2NativeBundle, action: string, sources: Source[], fields: B2Record = {}) {
  const nativeRefs = sources.filter(s => s.id.startsWith('native:')).map(s => {
    const row = bundle.rows.find(r => nativeRowRef(r).id === s.id && r.ref.sha256 === s.sha256); need(row, 'NATIVE_SOURCE_BINDING'); return row.ref;
  });
  return { format: 'xdev-b2-role-source-proof-3', mode: bundle.mode, project_id: bundle.policy.project.project_id,
    epoch_id: bundle.policy.epoch_id, policy_sha256: bundle.policy_sha256,
    product_manifest_sha256: bundle.policy.product_manifest_sha256, action, native_refs: nativeRefs, ...fields };
}
function policySources(bundle: B2NativeBundle, test?: TestNativeContext): Source[] {
  if (test) return [sourceFile(bundle.root, test.policyPath), sourceFile(bundle.root, join(test.policyPath.split('/').slice(0, -1).join('/'), 'accepted.json').replaceAll('\\', '/'))];
  const policyBytes = jsonBytes(bundle.policy), acceptedBytes = jsonBytes(bundle.accepted);
  return [{ id: 'DEPLOYMENT_POLICY', path: null, bytes: policyBytes, sha256: sha256(policyBytes) },
    { id: 'DEPLOYMENT_ACCEPTANCE', path: null, bytes: acceptedBytes, sha256: sha256(acceptedBytes) }];
}
function inspection(l: B2Loaded, facts = l.facts) {
  return { format: 'xdev-b2-inspection-native-3', project_events: l.journals['project.json'],
    job_journals: Object.entries(l.journals).filter(([k]) => k !== 'project.json').map(([, j]) => j),
    facts: { format: 'B2_SOURCE_DERIVED_RULES_ONLY', coverage: 'COMPLETE', project: l.structure.project_state.project,
      source_refs: l.sources.map(({ id, sha256 }) => ({ id, sha256 })), ...facts }, now: new Date().toISOString() };
}
function envelope(bundle: B2NativeBundle, plan: B2Record, operation: string, grantRef: B2Record,
  projectHead: string, jobHead: string, tool: string, args: B2Record) {
  return { format: 'xdev-b2-host-action-3', operation_id: operation, job_id: plan.job_id, attempt_id: plan.attempt_id,
    role_id: plan.role_id, send_id: plan.send_id, tool, arguments: args, parent_thread_id: bundle.parent.threadId,
    parent_session_id: bundle.parent.sessionId, parent_turn_id: bundle.parentTurn, packet_sha256: plan.packet_sha256,
    subject_sha256: b2Hash(plan.subject), project_head: projectHead, job_head: jobHead, grant_ref: grantRef, deadline: plan.deadline };
}
/** Inputs are business locators. All journal commands below are derived from current disk and original native records. */
export function buildB2RoleSourcePlan(root: string, action: string, args: any[], loaded: B2Loaded | null, test?: TestNativeContext): B2DiskPlan {
  return withSubjectCheck(subject => buildRoleSourcePlan(root, action, args, loaded, test, subject));
}
function buildRoleSourcePlan(root: string, action: string, args: any[], loaded: B2Loaded | null,
  test: TestNativeContext | undefined, subject: SubjectCheck): B2DiskPlan {
  const counts: Record<string, number> = { init: 1, create: 2, prepare: 5, observe: 4, outcome: 4, cancel: 5, reconcile: 5 };
  need(Object.hasOwn(counts, action) && args.length === counts[action], 'STORE_OPTIONS_UNSUPPORTED');
  const locator = ['prepare', 'cancel', 'reconcile'].includes(action) ? args[2] as GrantLocator : undefined;
  const bundle = withChildren(root, loaded, locator, test);
  need(test ? bundle.mode === 'TEST_ONLY_NATIVE' : isActualNativeBundle(bundle), 'ACTUAL_SOURCE_REQUIRED');
  const policyAdds = [...policySources(bundle, test), ...bundle.sources];
  const none = { current_subject: null, native_records: [], controller_packets: [] };
  if (action === 'init') {
    actionAllowed(bundle, 'INIT'); need(!loaded, 'EXISTING_HISTORY_STOP'); checkedRelativeFile(args[0]);
    const src = bootstrapNativeSources(root, args[0], bundle.mode), input = sourceJson(root, args[0]);
    need(src.project.project_id === bundle.policy.project.project_id && src.allocation.call_cap === bundle.policy.budget.call_cap &&
      src.allocation.attempt_cap === bundle.policy.budget.attempt_cap && src.allocation.deadline === bundle.policy.deadline &&
      bundle.policy.budget.previous_spent_calls === 0 && bundle.policy.budget.previous_spent_attempts === 0 &&
      bundle.policy.budget.previous_reserved_calls === 0, 'POLICY_BUDGET_BINDING');
    const p: B2Event[] = [], at = input.value.created_at, op = src.operation;
    appendNativeEvent(p, 'project', { kind: 'PROJECT_INIT', project: src.project, protocol_version: 3,
      history: { protocol: 'FRESH_B2', coverage: 'COMPLETE', source_refs: src.history_refs, unresolved: [] } }, op, 'init', at);
    appendNativeEvent(p, 'project', { kind: 'ALLOCATION_SET', allocation_id: src.allocation.allocation_id,
      authorization_ref: { id: 'file:' + src.allocation.decision_source.path, sha256: src.allocation.decision_source.sha256 },
      previous_allocation_id: src.allocation.previous_allocation_id, previous_project_head: p.at(-1)!.sha256,
      call_cap: src.allocation.call_cap, attempt_cap: src.allocation.attempt_cap, deadline: src.allocation.deadline }, op, 'allocation', at);
    const sources = merge(src.sources, policyAdds);
    return { domain: src.domain as NativeDomain, operation: op, kind: 'INIT', input_path: args[0], input_sha256: input.source.sha256,
      journals: { 'project.json': p }, sources, facts: none, writes: [{ target: 'project.json', events: p }],
      source_proof: makeProof(bundle, 'INIT', sources), bundle, test, host_action: null };
  }
  need(loaded && loaded.domain.protocol_version === 3 && loaded.domain.mode === bundle.mode, 'DOMAIN_MISMATCH');
  const p = structuredClone(loaded.journals['project.json']!), journals = structuredClone(loaded.journals), writes: B2DiskPlan['writes'] = [];
  let sources = merge(loaded.sources, policyAdds), facts = structuredClone(loaded.facts);
  if (action === 'create') {
    actionAllowed(bundle, 'CREATE'); need(args[1] === loaded.structure.project_state.head, 'REVISION_CONFLICT');
    const src = jobNativeSources(root, args[0], loaded.structure.project_state, loaded.sources), input = sourceJson(root, args[0]), b = src.binding;
    canonicalRoles(bundle, b); subject(bundle, b); sources = merge(sources, src.sources); const op = src.operation, at = input.value.created_at;
    const intent = appendNativeEvent(p, 'project', { kind: 'CREATE_INTENT', binding: b, binding_sha256: b2Hash(b) }, op, 'create-intent', at);
    writes.push({ target: 'project.json', events: structuredClone(p) }); const j: B2Event[] = [];
    const create = appendNativeEvent(j, 'job', { kind: 'D1_B2_CREATE', binding: b, binding_sha256: b2Hash(b), project_intent_ref: eventRef(intent) }, op, 'job-create', at);
    const target = `jobs/${b.job_id.slice(4)}.json`; journals[target] = j; writes.push({ target, events: structuredClone(j) });
    appendNativeEvent(p, 'project', { kind: 'CREATE_COMMIT', job_id: b.job_id, intent_ref: eventRef(intent), job_create_ref: eventRef(create) }, op, 'create-commit', at);
    writes.push({ target: 'project.json', events: structuredClone(p) }); journals['project.json'] = p;
    return { domain: loaded.domain, operation: op, kind: 'CREATE', input_path: args[0], input_sha256: input.source.sha256,
      journals, sources, facts, writes, source_proof: makeProof(bundle, 'CREATE', sources), bundle, test, host_action: null };
  }
  const jobId = args[0], op = args[1]; uuid(op); const target = `jobs/${jobId.slice(4)}.json`, j = journals[target]; need(j, 'JOB_NOT_FOUND');
  const b = j[0]!.command.binding, current = subject(bundle, b), projectHead = loaded.structure.project_state.head,
    jobView = loaded.structure.jobs.find(j => j.binding.job_id === jobId)!;
  need(args[locator ? 3 : 2] === projectHead && args[locator ? 4 : 3] === jobView.head, 'REVISION_CONFLICT');
  const input = sourceFile(root, b.operative.contract_ref.id.slice(5));
  let proof: B2Record, hostAction: B2Record | null = null;
  const pushProject = (command: B2Record, label: string, at: string) => {
    const e = appendNativeEvent(p, 'project', command, op, label, at); writes.push({ target: 'project.json', events: structuredClone(p) }); return e;
  };
  const pushJob = (command: B2Record, label: string, at: string) => {
    const e = appendNativeEvent(j, 'job', command, op, label, at); writes.push({ target, events: structuredClone(j) }); return e;
  };
  if (locator) {
    const actionName = action === 'prepare' ? 'PREPARE_ROLE' : action.toUpperCase(); actionAllowed(bundle, actionName);
    const nativeGrant = readB2NativeGrant(bundle, locator, action !== 'reconcile'), grant = nativeGrant.grant;
    sources = merge(sources, [nativeGrant.source]);
    const prepared = prepareBinding(bundle, loaded, jobId, op, actionName, grant, subject);
    const { role, roles, ids, planRoles, requestFields, first } = prepared, at = grant.valid_from;
    if (action === 'prepare') {
      need(!loaded.structure.project_state.sends.some(s => s.hold) && !(loaded.structure.project_state.controls ?? []).some(c => c.hold), 'SEND_BLOCKED');
      const refs = requestRefs(bundle, b, ids, role, current); sources = merge(sources, refs.sources);
      const taskPath = b.operative.contract_ref.id.slice(5);
      const packet = { format: 'xdev-b2-task-packet-3', project_id: bundle.policy.project.project_id, epoch_id: bundle.policy.epoch_id,
        job_id: b.job_id, task_id: b.task_id, attempt_id: ids.attempt_id, ordinal: ids.ordinal, role_id: ids.role_id,
        role_ordinal: role.ordinal, purposes: role.purposes, actor_policy: role.actor_policy, subject: current.subject,
        task_source: { path: taskPath, sha256: input.sha256, body: input.bytes },
        criteria_sources: current.task.criteria.map((c: B2Record) => ({ id: c.id, path: c.source_ref.path, sha256: c.source_ref.sha256,
          body: readProjectFile(root, c.source_ref.path).toString('utf8') })), allowed_scope: b.operative.allowed_scope,
        forbidden_scope: b.operative.forbidden_scope, required_guarantees: grant.required_guarantees,
        read_plan: b2RoleReadPlan(bundle.policy, b, role, ids.ordinal),
        test_plan: bundle.policy.test_plan.filter((r: B2Record) => r.role_ordinal === role.ordinal), recorder_request_refs: refs.refs,
        request_fields: requestFields, deadline: grant.deadline, limitations: LIMITATIONS };
      const message = canonical(packet); need(Buffer.byteLength(message) <= 65536, 'PACKET_LIMIT');
      const plaintext = sha256(message), packetSha = b2Hash({ request_fields: requestFields, plaintext_sha256: plaintext });
      const intentSource = { id: 'packet:' + ids.send_id, path: null, bytes: message, sha256: plaintext }; sources = merge(sources, [intentSource]);
      const plan = { ...ids, role_ordinal: role.ordinal, purposes: role.purposes, request_fields: requestFields,
        subject: current.subject, packet_sha256: packetSha, packet, message, recorder_request_refs: refs.refs,
        parent_thread_id: bundle.parent.threadId, parent_session_id: bundle.parent.sessionId, parent_turn_id: bundle.parentTurn,
        committed_at: at, deadline: grant.deadline };
      if (first) {
        need(prepared.p.spent_calls + prepared.p.reservations.filter(r => !r.sent).length + roles.length <= prepared.p.allocation!.call_cap &&
          prepared.p.spent_attempts + 1 <= prepared.p.allocation!.attempt_cap, 'BUDGET');
        let repair = prepared.j.attempts.at(-1)?.repair as B2Event | null | undefined;
        const previous = prepared.j.attempts.at(-1);
        if (previous?.outcome && !repair) repair = pushJob({ kind: 'REPAIR_AUTHORIZE', job_id: b.job_id, task_id: b.task_id,
          attempt_id: previous.command.attempt_id, ordinal: previous.command.ordinal, failed_outcome_ref: eventRef(previous.outcome),
          candidate_sha256: previous.subject.candidate_sha256, authorization_ref: nativeGrant.ref,
          allocation_id: b.allocation_id, deadline: grant.deadline }, 'repair', at);
        const reserve = (r: B2Record) => pushProject({ kind: 'RESERVE', job_id: b.job_id, task_id: b.task_id,
          attempt_id: ids.attempt_id, ordinal: ids.ordinal, role_id: eventId(prepared.seed, 'role:' + r.ordinal),
          reservation_id: eventId(prepared.seed, 'reservation:' + r.ordinal), send_id: eventId(prepared.seed, 'send:' + r.ordinal),
          purposes: r.purposes, allocation_id: b.allocation_id, call_units: 1, attempt_units: r.purposes.includes('worker') ? 1 : 0,
          deadline: grant.deadline }, 'reserve:' + r.ordinal, at);
        const worker = reserve(roles[0]!);
        pushJob({ kind: 'ATTEMPT_PREPARE', job_id: b.job_id, task_id: b.task_id, attempt_id: ids.attempt_id,
          ordinal: ids.ordinal, subject: current.subject, allocation_id: b.allocation_id, deadline: grant.deadline,
          roles: planRoles, reservation_refs: [eventRef(worker)], repair_ref: repair ? eventRef(repair) : null }, 'attempt', at);
        for (const r of roles.slice(1)) reserve(r);
      }
      const projectSend = pushProject({ kind: 'ROLE_SEND_INTENT', ...ids, purposes: role.purposes,
        packet_sha256: packetSha, expected_job_head: j.at(-1)!.sha256 }, 'project-send', at);
      pushJob({ kind: 'ROLE_SEND_INTENT', ...ids, purposes: role.purposes, packet_sha256: packetSha,
        project_send_ref: eventRef(projectSend), expected_project_head: projectSend.sha256, expected_job_head: j.at(-1)!.sha256 }, 'job-send', at);
      facts.current_subject = current.subject; facts.controller_packets.push({ send_id: ids.send_id, sha256: packetSha,
        request_fields: requestFields, plaintext_sha256: plaintext });
      hostAction = envelope(bundle, plan, op, nativeGrant.ref, p.at(-1)!.sha256, j.at(-1)!.sha256, 'collaboration.spawn_agent', { ...requestFields, message });
      proof = makeProof(bundle, actionName, sources, { locator, planned_binding: prepared.planned, plan, subject: current.subject, grant_ref: nativeGrant.ref });
    } else {
      const original = roleProofs(loaded).find(proof => proof.plan.send_id === ids.send_id); need(original, 'SEND_NOT_FOUND');
      const observed = observeRole(bundle, loaded, original.plan); sources = merge(sources, observed.sources);
      const attempt = prepared.j.attempts.at(-1)!, send = attempt.sends.find((s: B2Record) => s.command.send_id === ids.send_id);
      need(send?.receipt?.command.status === 'ACK' && observed.native && same(send.receipt.command.native, observed.native), 'RECONCILIATION_SOURCE_REQUIRED');
      if (action === 'reconcile') {
        need(observed.closed && observed.terminal && send.terminal && loaded.structure.project_state.sends.some(s => s.command.send_id === ids.send_id && s.hold), 'HOLD_UNRESOLVED');
        pushProject({ kind: 'HOLD_RESOLVE', ...ids, job_receipt_ref: eventRef(send.receipt), reconciliation_refs: observed.sources.map(s => ({ id: s.id, sha256: s.sha256 })),
          authorization_ref: nativeGrant.ref }, 'hold-resolve', at);
      } else {
        need(!attempt.cancel && observed.native.child_thread, 'CANCEL_STATE');
        pushJob({ kind: 'CANCEL_REQUESTED', job_id: b.job_id, task_id: b.task_id, attempt_id: ids.attempt_id, ordinal: ids.ordinal,
          target_send_id: ids.send_id, authorization_ref: nativeGrant.ref }, 'cancel-request', at);
        pushProject({ kind: 'CONTROL_SEND_INTENT', control_id: eventId(op, 'cancel-control'), job_id: b.job_id,
          attempt_id: ids.attempt_id, send_id: ids.send_id, child_thread: observed.native.child_thread, action: 'CANCEL',
          operation_id: op, grant_ref: nativeGrant.ref, deadline: grant.deadline }, 'cancel-control', at);
        hostAction = envelope(bundle, original.plan, op, nativeGrant.ref, p.at(-1)!.sha256, j.at(-1)!.sha256,
          'collaboration.interrupt_agent', { target: observed.native.agent_path });
      }
      proof = makeProof(bundle, actionName, sources, { locator, planned_binding: prepared.planned, subject: current.subject, grant_ref: nativeGrant.ref });
    }
  } else {
    actionAllowed(bundle, action.toUpperCase()); const at = new Date().toISOString(), attempt = jobView.attempts.at(-1); need(attempt, 'ATTEMPT_REQUIRED');
    if (action === 'outcome') {
      const ids = { job_id: b.job_id, task_id: b.task_id, attempt_id: attempt.command.attempt_id, ordinal: attempt.command.ordinal };
      const outcome = pushJob({ kind: 'ATTEMPT_OUTCOME', ...ids, evidence_sha256: b2Hash(attempt.evidence.map((e: B2Event) => e.sha256)) }, 'outcome', at);
      const result = replayNativeJob(j);
      if (['SATISFIED_NATIVE_RULES_ONLY', 'STOP'].includes(result.state))
        pushProject({ kind: 'JOB_SETTLED', job_id: b.job_id, job_terminal_ref: eventRef(outcome),
          closure_refs: [eventRef(attempt.closed), ...attempt.sends.map((s: B2Record) => eventRef(s.terminal))] }, 'settlement', at);
    } else observeIntoPlan(bundle, loaded, jobView, op, at, sources, facts, pushProject, pushJob);
    facts.current_subject = current.subject;
    proof = makeProof(bundle, action.toUpperCase(), sources, { subject: current.subject });
  }
  journals['project.json'] = p; journals[target] = j;
  return { domain: loaded.domain, operation: op, kind: 'ROLE_SOURCE', input_path: input.path!, input_sha256: input.sha256,
    journals, sources, facts, writes, source_proof: proof, bundle, test, host_action: hostAction };
}

function observeIntoPlan(bundle: B2NativeBundle, loaded: B2Loaded, job: B2Loaded['structure']['jobs'][number], operation: string, at: string,
  sources: Source[], facts: B2Loaded['facts'], project: (c: B2Record, label: string, at: string) => B2Event,
  event: (c: B2Record, label: string, at: string) => B2Event) {
  const attempt = job.attempts.at(-1)!, base = { job_id: job.binding.job_id, task_id: job.binding.task_id,
    attempt_id: attempt.command.attempt_id, ordinal: attempt.command.ordinal };
  const addSources = (more: Source[]) => { const merged = merge(sources, more); sources.splice(0, sources.length, ...merged); };
  const observations = new Map<string, ObservedB2Role>(), closedSends = new Set<string>(attempt.sends
    .filter((s: B2Record) => s.terminal && s.terminal.command.sessions.every((x: B2Record) => x.state === 'CLOSED'))
    .map((s: B2Record) => s.command.send_id));
  let changed = false;
  for (const owner of job.attempts) for (const [index, send] of owner.sends.entries()) {
    const attempt = owner, base = { job_id: job.binding.job_id, task_id: job.binding.task_id,
      attempt_id: attempt.command.attempt_id, ordinal: attempt.command.ordinal };
    const labelPrefix = owner === job.attempts.at(-1) ? String(index) : `old:${attempt.command.ordinal}:${index}`;
    const proof = roleProofs(loaded).find(p => p.plan.send_id === send.command.send_id); need(proof, 'SOURCE_PLAN_REQUIRED');
    const observed = observeRole(bundle, loaded, proof.plan, owner !== job.attempts.at(-1) ||
      b2Time(at) >= b2Time(owner.command.deadline) || !!owner.outcome);
    observations.set(send.command.send_id, observed); addSources(observed.sources);
    const c = send.command, ids = { ...base, role_id: c.role_id, send_id: c.send_id, reservation_id: c.reservation_id };
    if (!send.receipt || send.receipt.command.status === 'UNKNOWN' && observed.native) {
      const status = observed.native ? 'ACK' : 'UNKNOWN';
      const jr = event({ kind: 'ROLE_RECEIPT', ...ids, status, native: observed.native,
        project_send_ref: c.project_send_ref }, `receipt:${labelPrefix}`, at);
      project({ kind: 'ROLE_RECEIPT', ...ids, job_receipt_ref: eventRef(jr), status, native: observed.native }, `project-receipt:${labelPrefix}`, at);
      if (observed.native) { const old = facts.native_records.find(n => n.send_id === ids.send_id);
        need(!old || same(old.native, observed.native), 'NATIVE_SOURCE_REBOUND');
        if (!old) facts.native_records.push({ send_id: ids.send_id, native: observed.native }); }
      changed = true;
    }
    if (send.terminal) continue;
    if (observed.native && observed.terminal && (b2Time(at) >= b2Time(attempt.command.deadline) ||
      owner !== job.attempts.at(-1) || attempt.outcome)) {
      const ref = nativeRowRef(observed.terminal);
      if (!attempt.late.some((e: B2Event) => same(e.command.source_ref, ref))) {
        event({ kind: 'LATE_OR_REJECTED_OBSERVATION', ...base, send_id: c.send_id, native: observed.native,
          source_ref: ref, reason: b2Time(at) >= b2Time(attempt.command.deadline) ? 'EXPIRED' : 'REJECTED', received_at: at },
          `late:${labelPrefix}`, at); changed = true;
      }
      continue;
    }
    if (!observed.native || !observed.closed || !observed.terminal || send.terminal) continue;
    if (!observed.commands.some(c => c.request.mode === 'READ') && observed.failures.length) {
      const ref = nativeRowRef(observed.failures[0]!);
      if (!attempt.late.some((e: B2Event) => same(e.command.source_ref, ref))) {
        event({ kind: 'LATE_OR_REJECTED_OBSERVATION', ...base, send_id: c.send_id, native: observed.native,
          source_ref: ref, reason: 'REJECTED', received_at: at }, `failed-uncovered:${labelPrefix}`, at); changed = true;
      }
      continue;
    }
    const terminalResult = observed.commands.at(-1)?.result;
    need(terminalResult, 'PERSONAL_READ_REQUIRED');
    const readCommand = observed.commands.find(c => c.request.mode === 'READ'); need(readCommand, 'PERSONAL_READ_REQUIRED');
    const observation = { subject: terminalResult.subject_after,
      contract_read_ref: nativeRowRef(readCommand.row), criteria_read_ref: nativeRowRef(readCommand.row),
      workspace_read_ref: nativeRowRef(readCommand.row), before_sha256: attempt.subject.candidate_sha256,
      after_sha256: terminalResult.subject_after.candidate_sha256, coverage: 'COMPLETE' };
    event({ kind: 'ROLE_TERMINAL', ...ids, native: observed.native, status: observed.status, observation,
      terminal_ref: nativeRowRef(observed.terminal), sessions: observed.sessions }, `terminal:${index}`, at); changed = true;
    closedSends.add(ids.send_id);
    if (c.purposes.includes('worker') && !attempt.closed)
      event({ kind: 'WRITERS_CLOSED', ...base, send_ids: [ids.send_id],
        source_refs: [nativeRowRef(observed.terminal), ...observed.sessions.map(s => s.source_ref)] }, 'writers-closed', at);
    if (attempt.cancel) continue;
    const requirements = [...job.binding.profile.test_depth, ...job.binding.operative.criteria.map((id: string) => 'criterion:' + id)];
    if (c.purposes.includes('review') && observed.opinion) {
      const opinion = observed.opinion;
      need(same(opinion.body.contract_ref, job.binding.operative.contract_ref) &&
        opinion.body.subject_sha256 === b2Hash(observation.subject), 'OPINION_SUBJECT');
      const coverage = [...new Set<string>(readCommand.request.read_plan.flatMap((p: B2Record) => p.coverage))]
        .filter(v => requirements.includes(v));
      if (job.binding.operative.required_guarantees.includes('scope_review_v1') && !opinion.scope_blockers.length) coverage.push('scope_review_v1');
      const findings = [...new Set([...opinion.body.findings, ...opinion.scope_blockers])];
      if (opinion.body.verdict === 'FAIL' && !findings.length) findings.push('REVIEW_FAILED');
      event({ kind: 'REVIEW_RESULT', ...base, evidence: { evidence_id: eventId(operation, `review:${index}`), kind: 'review',
        send_id: ids.send_id, native: observed.native, observation, coverage, findings, execution: null,
        original_output_ref: nativeRowRef(opinion.row) } }, `review:${index}`, at);
    }
    for (const [commandIndex, command] of observed.commands.entries()) {
      if (command.request.mode !== 'QA') continue;
      for (const [testIndex, test] of command.result.tests.entries()) {
        const testPlan = command.request.test_plan.find((p: B2Record) => p.id === test.id); need(testPlan, 'ACTUAL_TEST_PLAN');
        const coverage = testPlan.coverage.filter((v: string) => requirements.includes(v));
        const execution = { argv: test.argv, cwd: test.cwd, started_at: test.started_at, ended_at: test.ended_at,
          exit_code: test.exit_code, stdout: test.stdout, stderr: test.stderr, stdout_sha256: test.stdout_sha256,
          stderr_sha256: test.stderr_sha256, invocation_ref: nativeRowRef(command.row), untested: [] };
        for (const kind of ['qa', 'integration']) if (c.purposes.includes(kind)) {
          const label = `${kind}:${index}:${commandIndex}:${testIndex}`;
          event({ kind: kind === 'qa' ? 'QA_RESULT' : 'INTEGRATION_RESULT', ...base, evidence: {
            evidence_id: eventId(operation, label), kind, send_id: ids.send_id, native: observed.native,
            observation: { ...observation, before_sha256: observation.after_sha256 },
            coverage, findings: [], execution, original_output_ref: nativeRowRef(command.row) } }, label, at);
        }
      }
    }
  }
  for (const control of loaded.structure.project_state.controls ?? []) {
    if (control.command.job_id !== job.binding.job_id || control.state === 'OBSERVED_CLOSED') continue;
    const proof = loaded.operations.find(o => o.begin.operation_id === control.command.operation_id)?.begin.source_proof;
    need(proof, 'CONTROL_SOURCE_REQUIRED');
    const sendProof = roleProofs(loaded).find(p => p.plan.send_id === control.command.send_id); need(sendProof, 'CONTROL_SOURCE_REQUIRED');
    const native = facts.native_records.find(n => n.send_id === control.command.send_id)?.native; need(native, 'CONTROL_SOURCE_REQUIRED');
    const calls = bundle.rows.filter(r => r.ref.threadId === bundle.parent.threadId && r.record.type === 'response_item' &&
      r.record.payload.type === 'function_call' && r.record.payload.namespace === 'collaboration' && r.record.payload.name === 'interrupt_agent' &&
      (parseD1UniqueJson(r.record.payload.arguments) as B2Record).target === native.agent_path &&
      Date.parse(r.record.timestamp) >= b2Time(control.event.occurred_at));
    need(calls.length <= 1, 'EXTRA_NATIVE_CONTROL_CALL'); const call = calls[0];
    if (!call) continue;
    const p = call.record.payload;
    const bound = prepareReturnBound(bundle, prepareExpected(bundle, loaded, control.command.operation_id));
    assertAfterPrepare(call, bound); addSources(bound.sources);
    need(Date.parse(call.record.timestamp) < b2Time(control.command.deadline), 'CONTROL_CALL_DEADLINE');
    need(p.internal_chat_message_metadata_passthrough?.turn_id === sendProof.plan.parent_turn_id, 'CONTROL_CALL_TURN');
    const returns = bundle.rows.filter(r => r.ref.threadId === bundle.parent.threadId && r.record.type === 'response_item' &&
      r.record.payload.type === 'function_call_output' && r.record.payload.call_id === p.call_id);
    if (!returns.length) continue; need(returns.length === 1 && returns[0]!.record.ordinal > call.record.ordinal &&
      returns[0]!.record.payload.internal_chat_message_metadata_passthrough?.turn_id === p.internal_chat_message_metadata_passthrough.turn_id, 'CONTROL_RETURN_TURN');
    const output = parseD1UniqueJson(returns[0]!.record.payload.output) as B2Record; exact(output, ['previous_status']);
    need(['running', 'idle', 'completed', 'errored', 'interrupted', 'pending_init', 'shutdown'].includes(output.previous_status), 'CONTROL_RETURN');
    addSources([nativeRowSource(call), nativeRowSource(returns[0]!)]);
    if (!control.receipt) {
      project({ kind: 'CONTROL_RECEIPT', control_id: control.command.control_id, status: 'ACK', call_id: p.call_id, native }, 'control-receipt', at);
      changed = true;
    }
    const observed = observations.get(control.command.send_id);
    if (attempt.cancel && !attempt.cancel.observed && observed?.terminal && observed.closed &&
      closedSends.size === attempt.sends.length && (attempt.closed || attempt.sends.some((s: B2Record) =>
        s.command.purposes.includes('worker') && closedSends.has(s.command.send_id)))) {
      event({ kind: 'CANCEL_OBSERVED', ...base, target_send_id: control.command.send_id, native,
        interrupt_ref: nativeRowRef(returns[0]!), closure_refs: [nativeRowRef(observed.terminal),
          ...observed.sessions.map(s => s.source_ref)] }, 'cancel-observed', at); changed = true;
    }
  }
  need(changed, 'NO_NEW_NATIVE_OBSERVATION');
}

/** Reopen re-reads actual originals. Disk source proofs are locators, never a restored native brand. */
function priorProjection(loaded: B2Loaded, sequence: number): B2Loaded {
  const journals: B2Loaded['journals'] = {}, sources: Source[] = [], operations = loaded.operations.slice(0, sequence);
  let facts: B2Loaded['facts'] = { current_subject: null, native_records: [], controller_packets: [] };
  for (const operation of operations) {
    for (const meta of operation.begin.sources) { const source = loaded.sources.find(s => s.id === meta.id); need(source, 'SOURCE_MISSING'); sources.push(source); }
    for (const step of operation.begin.steps) journals[step.target] = [...(journals[step.target] ?? []), ...step.append];
    facts = operation.begin.facts;
  }
  const before = { ...loaded, journals, sources, operations, facts };
  before.structure = inspectB2NativeStructure(inspection(before)); return before;
}
/** Expected bytes derive only from the completed original operation, never caller summaries. */
function prepareExpected(bundle: B2NativeBundle, loaded: B2Loaded, operation: string) {
  const stored = loaded.operations.find(o => o.begin.operation_id === operation); need(stored, 'PREPARE_OPERATION_REQUIRED');
  const proof = stored.begin.source_proof; need(proof?.locator && ['PREPARE_ROLE', 'CANCEL'].includes(proof.action), 'PREPARE_OPERATION_REQUIRED');
  const plan = proof.plan ?? roleProofs(loaded).find(p => p.plan.send_id === proof.planned_binding.send_id)?.plan;
  need(plan, 'PREPARE_PLAN_REQUIRED');
  const after = priorProjection(loaded, stored.begin.sequence + 1), grant = readB2NativeGrant(bundle, proof.locator, false).grant;
  const jobHead = stored.begin.after_heads[`jobs/${plan.job_id.slice(4)}.json`], projectHead = stored.begin.after_heads['project.json'];
  const tool = proof.action === 'PREPARE_ROLE' ? 'collaboration.spawn_agent' : 'collaboration.interrupt_agent';
  const native = loaded.facts.native_records.find(n => n.send_id === plan.send_id)?.native;
  need(proof.action === 'PREPARE_ROLE' || native?.agent_path, 'CONTROL_SOURCE_REQUIRED');
  const args = proof.action === 'PREPARE_ROLE' ? { ...plan.request_fields, message: plan.message } : { target: native.agent_path };
  const host = envelope({ ...bundle, parentTurn: plan.parent_turn_id }, plan, operation, proof.grant_ref, projectHead, jobHead, tool, args);
  return { parameters: { project_root: bundle.root, project_id: bundle.policy.project.project_id, job_id: plan.job_id,
    operation_id: operation, action: proof.action, grant_ref: proof.locator,
    expected_project_head: stored.begin.before_heads['project.json'], expected_job_head: stored.begin.before_heads[`jobs/${plan.job_id.slice(4)}.json`] },
    result: roleSourceResponse(after, false, operation, host), parentTurn: plan.parent_turn_id,
    validFrom: grant.valid_from, deadline: grant.deadline };
}
function observeRole(bundle: B2NativeBundle, loaded: B2Loaded, plan: B2Record, historical = false) {
  const operation = loaded.operations.find(o => o.begin.source_proof?.plan?.send_id === plan.send_id); need(operation, 'PREPARE_OPERATION_REQUIRED');
  const binding = loaded.structure.jobs.find(j => j.binding.job_id === plan.job_id)?.binding; need(binding, 'SOURCE_PLAN_JOB');
  let baseline;
  if (binding.operative.required_guarantees.includes('scope_review_v1') && plan.purposes.includes('review')) {
    // Never reset the baseline on a repair: it is the first authorized pre-execution snapshot of this Job.
    const first = roleProofs(loaded).filter(p => p.plan.job_id === plan.job_id && p.plan.ordinal === 1 && p.plan.purposes.includes('worker'));
    need(first.length === 1, 'SCOPE_BASELINE_SOURCE_UNAVAILABLE');
    const proof = first[0]!, grant = readB2NativeGrant(bundle, proof.locator, false);
    need(same(grant.ref, proof.grant_ref) && grant.grant.subject_sha256 === b2Hash(proof.plan.subject) &&
      grant.grant.planned_binding_sha256 === b2Hash(proof.planned_binding), 'SCOPE_BASELINE_GRANT');
    const reads = proof.plan.recorder_request_refs.map((ref: B2Record) => {
      const source = loaded.sources.find(s => s.id === ref.id);
      need(source && source.sha256 === ref.sha256 && source.path === ref.path, 'SCOPE_BASELINE_SOURCE');
      return { requestRef: ref, request: parseD1UniqueJson(source.bytes) as B2Record };
    }).filter((r: B2Record) => r.request.mode === 'READ');
    need(reads.length === 1, 'SCOPE_BASELINE_SOURCE');
    baseline = { plan: proof.plan, grant: grant.grant, ...reads[0] };
  }
  return observeB2Role(bundle, plan, historical, prepareExpected(bundle, loaded, operation.begin.operation_id), baseline);
}
function validateDerivedRole(bundle: B2NativeBundle, loaded: B2Loaded, plan: B2Record) {
  const job = loaded.structure.jobs.find(j => j.binding.job_id === plan.job_id); need(job, 'SOURCE_PLAN_JOB');
  const attempt = job.attempts.find(a => a.command.attempt_id === plan.attempt_id); need(attempt, 'SOURCE_PLAN_ATTEMPT');
  const send = attempt.sends.find((s: B2Record) => s.command.send_id === plan.send_id); need(send, 'SOURCE_PLAN_SEND');
  const observed = observeRole(bundle, loaded, plan, true);
  for (const late of attempt.late.filter((e: B2Event) => e.command.send_id === plan.send_id)) {
    need(observed.native && observed.terminal && same(late.command.native, observed.native) &&
      (same(late.command.source_ref, nativeRowRef(observed.terminal)) || late.command.reason === 'REJECTED' &&
        observed.failures.some(r => same(late.command.source_ref, nativeRowRef(r)))) &&
      (late.command.reason !== 'EXPIRED' || b2Time(late.occurred_at) >= b2Time(attempt.command.deadline)), 'DERIVED_LATE_SOURCE');
  }
  for (const receipt of job.events.filter(e => e.command.kind === 'ROLE_RECEIPT' && e.command.send_id === plan.send_id)) {
    // UNKNOWN remains a historical fact if an original return arrived later. It cannot close a hold by itself.
    if (receipt.command.status === 'ACK') need(observed.native && same(receipt.command.native, observed.native), 'DERIVED_RECEIPT_DRIFT');
    else need(receipt.command.native === null, 'DERIVED_UNKNOWN_RECEIPT');
  }
  if (!send.terminal) return;
  const terminal = send.terminal.command, read = observed.commands.find(c => c.request.mode === 'READ'), result = observed.commands.at(-1)?.result;
  need(observed.closed && observed.terminal && observed.native && read && result, 'DERIVED_TERMINAL_INCOMPLETE');
  const observation = { subject: result.subject_after, contract_read_ref: nativeRowRef(read.row), criteria_read_ref: nativeRowRef(read.row),
    workspace_read_ref: nativeRowRef(read.row), before_sha256: plan.subject.candidate_sha256,
    after_sha256: result.subject_after.candidate_sha256, coverage: 'COMPLETE' };
  need(same(terminal.native, observed.native) && same(terminal.sessions, observed.sessions) && terminal.status === observed.status &&
    same(terminal.terminal_ref, nativeRowRef(observed.terminal)) && same(terminal.observation, observation), 'DERIVED_TERMINAL_DRIFT');
  need(b2Time(send.terminal.occurred_at) >= Date.parse(observed.terminal.record.timestamp), 'DERIVED_TERMINAL_TIME');
  const requirements = [...job.binding.profile.test_depth, ...job.binding.operative.criteria.map((id: string) => 'criterion:' + id)];
  const expected: B2Record[] = [];
  if (plan.purposes.includes('review') && observed.opinion) {
    const opinion = observed.opinion;
    need(same(opinion.body.contract_ref, job.binding.operative.contract_ref) && opinion.body.subject_sha256 === b2Hash(observation.subject), 'OPINION_SUBJECT');
    const coverage = [...new Set<string>(read.request.read_plan.flatMap((p: B2Record) => p.coverage))].filter(v => requirements.includes(v));
    if (job.binding.operative.required_guarantees.includes('scope_review_v1') && !opinion.scope_blockers.length) coverage.push('scope_review_v1');
    const findings = [...new Set([...opinion.body.findings, ...opinion.scope_blockers])];
    if (opinion.body.verdict === 'FAIL' && !findings.length) findings.push('REVIEW_FAILED');
    expected.push({ kind: 'review', send_id: plan.send_id, native: observed.native, observation, coverage, findings,
      execution: null, original_output_ref: nativeRowRef(opinion.row) });
  }
  for (const command of observed.commands) if (command.request.mode === 'QA') for (const test of command.result.tests) {
    const testPlan = command.request.test_plan.find((p: B2Record) => p.id === test.id); need(testPlan, 'ACTUAL_TEST_PLAN');
    const execution = { argv: test.argv, cwd: test.cwd, started_at: test.started_at, ended_at: test.ended_at, exit_code: test.exit_code,
      stdout: test.stdout, stderr: test.stderr, stdout_sha256: test.stdout_sha256, stderr_sha256: test.stderr_sha256,
      invocation_ref: nativeRowRef(command.row), untested: [] };
    for (const kind of ['qa', 'integration']) if (plan.purposes.includes(kind)) expected.push({ kind, send_id: plan.send_id,
      native: observed.native, observation: { ...observation, before_sha256: observation.after_sha256 },
      coverage: testPlan.coverage.filter((v: string) => requirements.includes(v)), findings: [], execution,
      original_output_ref: nativeRowRef(command.row) });
  }
  const actual = attempt.evidence.filter((e: B2Event) => e.command.evidence.send_id === plan.send_id).map((e: B2Event) => {
    const { evidence_id, ...body } = e.command.evidence; return body;
  });
  const cancelledBeforeTerminal = attempt.cancel && attempt.cancel.request.revision < send.terminal.revision;
  need(same(actual, cancelledBeforeTerminal ? [] : expected), 'DERIVED_QUALITY_EVIDENCE_DRIFT');
}
export function validateB2StoredSources(root: string, loaded: B2Loaded, test?: TestNativeContext) {
  return withSubjectCheck(subject => validateStoredSources(root, loaded, test, subject));
}
function validateStoredSources(root: string, loaded: B2Loaded, test: TestNativeContext | undefined, subject: SubjectCheck) {
  need(loaded.domain.protocol_version === 3 && loaded.domain.mode === (test ? 'TEST_ONLY_NATIVE' : 'NATIVE_PARTIAL'), 'DOMAIN_MISMATCH');
  const bundle = withChildren(root, loaded, undefined, test);
  need(test ? bundle.mode === 'TEST_ONLY_NATIVE' : isActualNativeBundle(bundle), 'ACTUAL_SOURCE_REQUIRED');
  const nativeSources = loaded.sources.filter(s => s.id.startsWith('native:'));
  for (const source of nativeSources) {
    const row = bundle.rows.find(r => nativeRowRef(r).id === source.id);
    need(row && row.raw === source.bytes && row.ref.sha256 === source.sha256, 'NATIVE_SOURCE_DRIFT');
  }
  verifyOriginalRefs(bundle, loaded.operations.flatMap(o => o.begin.source_proof?.native_refs ?? []));
  for (const o of loaded.operations) {
    const proof = o.begin.source_proof; need(proof?.format === 'xdev-b2-role-source-proof-3' && proof.mode === bundle.mode &&
      proof.project_id === bundle.policy.project.project_id && proof.epoch_id === bundle.policy.epoch_id &&
      proof.policy_sha256 === bundle.policy_sha256 && proof.product_manifest_sha256 === bundle.policy.product_manifest_sha256, 'SOURCE_PROOF_DOMAIN');
    b2List(proof.native_refs, 1, 64, () => {});
    const permitted: Record<string, string[]> = { INIT: ['PROJECT_INIT', 'ALLOCATION_SET'], CREATE: ['CREATE_INTENT', 'D1_B2_CREATE', 'CREATE_COMMIT'],
      PREPARE_ROLE: ['REPAIR_AUTHORIZE', 'RESERVE', 'ATTEMPT_PREPARE', 'ROLE_SEND_INTENT'],
      OBSERVE: ['ROLE_RECEIPT', 'ROLE_TERMINAL', 'WRITERS_CLOSED', 'REVIEW_RESULT', 'QA_RESULT', 'INTEGRATION_RESULT', 'CONTROL_RECEIPT', 'CANCEL_OBSERVED', 'LATE_OR_REJECTED_OBSERVATION'],
      OUTCOME: ['ATTEMPT_OUTCOME', 'JOB_SETTLED'], CANCEL: ['CANCEL_REQUESTED', 'CONTROL_SEND_INTENT'], RECONCILE: ['HOLD_RESOLVE'] };
    need(permitted[proof.action] && o.begin.steps.every(s => s.append.every(e => permitted[proof.action]!.includes(e.command.kind))), 'SOURCE_ACTION_COMMAND');
    if (proof.action === 'INIT') {
      const allocation = o.begin.steps.flatMap(s => s.append).find(e => e.command.kind === 'ALLOCATION_SET')!.command;
      need(allocation.call_cap === bundle.policy.budget.call_cap && allocation.attempt_cap === bundle.policy.budget.attempt_cap &&
        allocation.deadline === bundle.policy.deadline && bundle.policy.budget.previous_spent_calls === 0 &&
        bundle.policy.budget.previous_spent_attempts === 0 && bundle.policy.budget.previous_reserved_calls === 0, 'POLICY_BUDGET_BINDING');
    } else if (proof.action === 'CREATE') {
      const before = priorProjection(loaded, o.begin.sequence), original = jobNativeSources(root, o.begin.input_path, before.structure.project_state, before.sources, false);
      const created = o.begin.steps.flatMap(s => s.append).find(e => e.command.kind === 'D1_B2_CREATE')!;
      need(same(original.binding, created.command.binding), 'DERIVED_CREATE_DRIFT'); canonicalRoles(bundle, original.binding);
    }
    if (proof.locator) {
      const actual = readB2NativeGrant(bundle, proof.locator, false), before = priorProjection(loaded, o.begin.sequence);
      const jobId = proof.plan?.job_id ?? o.begin.steps.flatMap(s => s.append).find(e => e.command.job_id)?.command.job_id;
      const job = before.structure.jobs.find(j => j.binding.job_id === jobId); need(job, 'SOURCE_PLAN_JOB');
      const current = subject(bundle, job.binding);
      if (proof.plan) {
        const ref = proof.plan.recorder_request_refs[0], source = loaded.sources.find(s => s.id === ref.id); need(source, 'RECORDER_REQUEST_SOURCE');
        const request = parseD1UniqueJson(source.bytes) as B2Record;
        need(same(request.subject, proof.subject) && nativeManifestHash(request.candidate_manifest) === request.subject.candidate_sha256 &&
          same(request.environment, current.environment), 'SOURCE_PLAN_SUBJECT');
        current.subject = request.subject; current.candidate = request.candidate_manifest;
      } else current.subject = proof.subject;
      const derived = prepareBinding(bundle, before, jobId, o.begin.operation_id, proof.action, actual.grant, subject, current);
      need(same(derived.planned, proof.planned_binding) && same(actual.ref, proof.grant_ref), 'SOURCE_GRANT_REBOUND');
      if (proof.plan) {
        const refs = requestRefs(bundle, job.binding, derived.ids, derived.role, current);
        need(same(refs.refs, proof.plan.recorder_request_refs) && same(derived.ids,
          Object.fromEntries(Object.keys(derived.ids).map(k => [k, proof.plan[k]]))) &&
          same(derived.requestFields, proof.plan.request_fields) && same(derived.role.purposes, proof.plan.purposes), 'SOURCE_PLAN_CANONICAL');
      }
      for (const event of o.begin.steps.flatMap(s => s.append)) if (['REPAIR_AUTHORIZE', 'HOLD_RESOLVE', 'CANCEL_REQUESTED'].includes(event.command.kind))
        need(same(event.command.authorization_ref, actual.ref), 'SOURCE_ACTION_AUTHORIZATION');
      if (proof.action === 'RECONCILE') for (const event of o.begin.steps.flatMap(s => s.append)) {
        const plan = roleProofs(loaded).find(p => p.plan.send_id === event.command.send_id)?.plan; need(plan, 'SOURCE_PLAN_REQUIRED');
        const observed = observeRole(bundle, loaded, plan, true);
        need(observed.closed && observed.terminal && b2Time(event.occurred_at) >= Date.parse(observed.terminal.record.timestamp) &&
          same(event.command.reconciliation_refs, observed.sources.map(s => ({ id: s.id, sha256: s.sha256 }))), 'DERIVED_RECONCILIATION_DRIFT');
      }
    }
    if (!proof.plan) continue;
    need(proof.action === 'PREPARE_ROLE' && proof.locator, 'SOURCE_PLAN_REQUIRED');
    const actualGrant = readB2NativeGrant(bundle, proof.locator, false); need(same(actualGrant.ref, proof.grant_ref), 'SOURCE_GRANT_REBOUND');
    const plan = proof.plan, grant = actualGrant.grant;
    need(plan.attempt_id === eventId(loaded.operations.find(x => x.begin.source_proof?.plan?.attempt_id === plan.attempt_id)!.begin.operation_id, 'attempt') &&
      grant.planned_binding_sha256 === b2Hash(proof.planned_binding) && grant.subject_sha256 === b2Hash(plan.subject) &&
      proof.planned_binding.project_head === grant.project_head && proof.planned_binding.job_head === grant.job_head &&
      proof.planned_binding.operation_id === o.begin.operation_id && same(proof.planned_binding.request_fields, plan.request_fields), 'SOURCE_PLAN_GRANT');
    const packetSource = loaded.sources.find(s => s.id === 'packet:' + plan.send_id); need(packetSource && packetSource.bytes === plan.message &&
      canonical(plan.packet) === plan.message && plan.packet_sha256 === b2Hash({ request_fields: plan.request_fields, plaintext_sha256: packetSource.sha256 }), 'CONTROLLER_INTENT_SOURCE');
    const send = loaded.journals[`jobs/${plan.job_id.slice(4)}.json`]?.find(e => e.command.kind === 'ROLE_SEND_INTENT' && e.command.send_id === plan.send_id);
    need(send && send.command.packet_sha256 === plan.packet_sha256 && send.command.role_id === plan.role_id &&
      send.command.attempt_id === plan.attempt_id && plan.parent_thread_id === bundle.parent.threadId &&
      plan.parent_session_id === bundle.parent.sessionId, 'SOURCE_PLAN_SEND');
    for (const ref of plan.recorder_request_refs) { const source = loaded.sources.find(s => s.id === ref.id);
      need(source && source.sha256 === ref.sha256 && source.path === ref.path, 'RECORDER_REQUEST_SOURCE'); }
    need(plan.packet.task_source.body === readProjectFile(root, plan.packet.task_source.path).toString('utf8') &&
      plan.packet.task_source.sha256 === sha256(plan.packet.task_source.body) && same(plan.packet.subject, plan.subject) &&
      same(plan.packet.request_fields, plan.request_fields) && same(plan.packet.recorder_request_refs, plan.recorder_request_refs), 'SOURCE_PACKET_BINDING');
    validateDerivedRole(bundle, loaded, plan);
  }
  const latest = loaded.operations.at(-1)?.begin.source_proof;
  for (const job of loaded.structure.jobs) for (const attempt of job.attempts) {
    for (const send of attempt.sends) need(roleProofs(loaded).filter(p => p.plan.send_id === send.command.send_id).length === 1, 'SOURCE_PLAN_REQUIRED');
    if (attempt.closed) {
      const writers = attempt.sends.filter((s: B2Record) => s.command.purposes.includes('worker'));
      const refs = writers.flatMap((s: B2Record) => [s.terminal.command.terminal_ref, ...s.terminal.command.sessions.map((session: B2Record) => session.source_ref)]);
      need(same(attempt.closed.command.source_refs, refs), 'DERIVED_WRITER_CLOSURE_DRIFT');
    }
  }
  for (const control of loaded.structure.project_state.controls ?? []) {
    const job = loaded.structure.jobs.find(j => j.binding.job_id === control.command.job_id),
      attempt = job?.attempts.find(a => a.command.attempt_id === control.command.attempt_id),
      send = attempt?.sends.find((s: B2Record) => s.command.send_id === control.command.send_id);
    need(send?.receipt?.command.native && attempt?.cancel && same(control.command.grant_ref, attempt.cancel.request.command.authorization_ref), 'CONTROL_SOURCE_REQUIRED');
    if (!control.receipt) continue;
    const c = control.receipt.command, native = send.receipt.command.native;
    const call = bundle.rows.find(r => r.ref.threadId === bundle.parent.threadId && r.record.type === 'response_item' &&
      r.record.payload.type === 'function_call' && r.record.payload.call_id === c.call_id);
    need(call, 'DERIVED_CONTROL_CALL');
    assertAfterPrepare(call, prepareReturnBound(bundle, prepareExpected(bundle, loaded, control.command.operation_id)));
    need(call && call.record.payload.namespace === 'collaboration' && call.record.payload.name === 'interrupt_agent' &&
      same(parseD1UniqueJson(call.record.payload.arguments), { target: native.agent_path }) &&
      Date.parse(call.record.timestamp) >= b2Time(control.event.occurred_at) && Date.parse(call.record.timestamp) < b2Time(control.command.deadline), 'DERIVED_CONTROL_CALL');
    const returns = bundle.rows.filter(r => r.ref.threadId === bundle.parent.threadId && r.record.type === 'response_item' &&
      r.record.payload.type === 'function_call_output' && r.record.payload.call_id === c.call_id);
    need(returns.length === 1 && returns[0]!.record.ordinal > call.record.ordinal &&
      returns[0]!.record.payload.internal_chat_message_metadata_passthrough?.turn_id === call.record.payload.internal_chat_message_metadata_passthrough?.turn_id &&
      same(c.native, native) && c.status === 'ACK', 'DERIVED_CONTROL_RECEIPT');
    const output = parseD1UniqueJson(returns[0]!.record.payload.output) as B2Record; exact(output, ['previous_status']);
    need(['running', 'idle', 'completed', 'errored', 'interrupted', 'pending_init', 'shutdown'].includes(output.previous_status), 'CONTROL_RETURN');
    if (attempt.cancel.observed) need(same(attempt.cancel.observed.command.interrupt_ref, nativeRowRef(returns[0]!)) &&
      same(attempt.cancel.observed.command.closure_refs, [send.terminal.command.terminal_ref,
        ...send.terminal.command.sessions.map((session: B2Record) => session.source_ref)]), 'DERIVED_CANCEL_CLOSURE');
  }
  const currentJob = loaded.structure.jobs.find(j => j.binding.job_id === loaded.structure.project_state.active_job) ?? loaded.structure.jobs.at(-1);
  if (latest?.subject && currentJob) {
    const actual = subject(bundle, currentJob.binding), current = actual.subject;
    if (!same(current, latest.subject)) {
      const attempt = currentJob.attempts.at(-1), worker = attempt?.sends.find((s: B2Record) => s.command.purposes.includes('worker'));
      const plan = worker && roleProofs(loaded).find(p => p.plan.send_id === worker.command.send_id)?.plan;
      need(plan && !worker.terminal && !attempt!.outcome, 'CURRENT_SUBJECT_DRIFT');
      const observed = observeRole(bundle, loaded, plan, true); need(observed.native, 'CURRENT_SUBJECT_DRIFT');
      const requestSource = loaded.sources.find(s => s.id === plan.recorder_request_refs[0].id); need(requestSource, 'RECORDER_REQUEST_SOURCE');
      const before = (parseD1UniqueJson(requestSource.bytes) as B2Record).candidate_manifest;
      const changed = new Set<string>([...before.files, ...actual.candidate.files].map((m: B2Record) => m.path));
      for (const path of changed) if (!same(before.files.find((m: B2Record) => m.path === path) ?? null,
        actual.candidate.files.find(m => m.path === path) ?? null)) need(scopeContains(bundle.policy.scope.allowed_paths, path) &&
          !scopeContains(bundle.policy.scope.forbidden_paths, path) && observed.sources.some(s => {
            const row = parseD1UniqueJson(s.bytes) as B2Record; return row.type === 'event_msg' && row.payload?.item?.type === 'FileChange' &&
              row.payload.item.status === 'completed' && mapB2PatchPaths(bundle.root, row.payload.item.changes, bundle.policy.scope).has(path);
          }), 'CURRENT_SUBJECT_DRIFT');
      // An active writer may be interrupted, but only a final recorder observation can close it or support quality.
      if (observed.closed) need(observed.terminal && observed.commands.at(-1)?.result &&
        same(observed.commands.at(-1)!.result.subject_after, current), 'CURRENT_SUBJECT_DRIFT');
    }
  }
  return bundle;
}
function holds(loaded: B2Loaded) {
  const p = loaded.structure.project_state, result: B2Record[] = [];
  for (const s of p.sends) if (s.hold) result.push({ kind: s.receipt?.command.status === 'UNKNOWN' ? 'SEND_UNKNOWN' : 'SEND_UNCERTAIN',
    id: s.command.send_id, job_id: s.command.job_id });
  for (const r of p.reservations) if (!r.sent) result.push({ kind: 'UNSENT_RESERVATION', id: r.command.reservation_id, job_id: r.command.job_id });
  for (const c of p.controls ?? []) if (c.hold) result.push({ kind: c.state, id: c.command.control_id, job_id: c.command.job_id });
  return result.sort((a, b) => `${a.kind}/${a.id}` < `${b.kind}/${b.id}` ? -1 : 1);
}
export function roleSourceResponse(loaded: B2Loaded, replayed: boolean, operation: string, hostAction: B2Record | null) {
  const p = loaded.structure.project_state, target = resolveB2OperationJob(loaded, operation);
  need(hostAction === null || hostAction.job_id === target, 'OPERATION_HOST_TARGET');
  const job = target === null ? undefined : loaded.structure.jobs.find(j => j.binding.job_id === target);
  const epoch = loaded.operations[0]!.begin.source_proof!.epoch_id, test = loaded.domain.mode === 'TEST_ONLY_NATIVE';
  const result = { status: replayed ? 'ALREADY_APPLIED' : 'APPLIED', operation_id: operation, mode: loaded.domain.mode,
    project_id: loaded.domain.project_id, epoch_id: epoch, project_head: p.head, job_id: job?.binding.job_id ?? null,
    job_head: job?.head ?? null, spent_calls: p.spent_calls, spent_attempts: p.spent_attempts,
    reserved_calls: p.reservations.filter(r => !r.sent).length, holds: holds(loaded),
    execution_permitted: !test && !replayed && hostAction !== null, host_action: !test && !replayed ? hostAction : null,
    source_level: test ? 'TEST_ONLY' : 'COOPERATIVE_NATIVE_PARTIAL', production_verification: false, delivery_claim_allowed: false };
  return test ? { format: 'xdev-b2-test-write-result-3', result, diagnostic_host_action: replayed ? null : hostAction, actual_source_brand: false } : result;
}
export function roleSourceQuery(root: string, loaded: B2Loaded, jobId: string, test?: TestNativeContext) {
  return withSubjectCheck(subject => queryRoleSource(root, loaded, jobId, test, subject));
}
/** Progress is a projection of the validated canonical Job, never a Host reply
 * importer. It lets a coordinator stop before advancing past an unclosed role.
 * It does not add quality evidence or change any acceptance decision. */
export function b2RoleProgress(job: B2Record) {
  const attempt = job.attempts.at(-1);
  return {
    attempt_id: attempt?.command.attempt_id ?? null,
    known_writers_closed: !!attempt?.closed,
    outcome_recorded: !!attempt?.outcome,
    roles: (attempt?.command.roles ?? []).map((role: B2Record) => {
      const send = attempt.sends.find((s: B2Record) => s.command.role_id === role.role_id);
      return { role_id: role.role_id, purposes: [...role.purposes],
        send_id: send?.command.send_id ?? null,
        receipt_status: send?.receipt?.command.status ?? 'NOT_OBSERVED',
        terminal_status: send?.terminal?.command.status ?? 'NOT_OBSERVED',
        sessions_closed: !!send?.terminal && send.terminal.command.sessions.every((s: B2Record) => s.state === 'CLOSED') };
    })
  };
}
function queryRoleSource(root: string, loaded: B2Loaded, jobId: string, test: TestNativeContext | undefined, subject: SubjectCheck) {
  const bundle = validateStoredSources(root, loaded, test, subject), job = loaded.structure.jobs.find(j => j.binding.job_id === jobId); need(job, 'JOB_NOT_FOUND');
  const current = subject(bundle, job.binding), facts = { ...loaded.facts, current_subject: current.subject };
  const quality = inspectB2NativeRules(inspection(loaded, facts), jobId), simulated = loaded.domain.mode === 'TEST_ONLY_NATIVE';
  need(quality.current_job === jobId, 'QUALITY_JOB_MISMATCH');
  const prototype = job.binding.profile.selected_profile === 'prototype';
  const policyCurrent = b2Time(bundle.policy.valid_from) <= Date.now() && Date.now() < b2Time(bundle.policy.deadline);
  const eligible = policyCurrent && quality.eligible && job.state === 'SATISFIED_NATIVE_RULES_ONLY' && !holds(loaded).length;
  const production = !simulated && isActualNativeBundle(bundle) && eligible && !prototype;
  return { format: 'xdev-b2-role-quality-result-3', mode: loaded.domain.mode, project_id: loaded.domain.project_id,
    epoch_id: bundle.policy.epoch_id, job_id: jobId, project_head: loaded.structure.project_state.head, job_head: job.head,
    state: job.state, execution_progress: b2RoleProgress(job), spent_calls: quality.spent_calls, spent_attempts: quality.spent_attempts, reserved_calls: quality.reserved_calls,
    holds: holds(loaded), quality: { scope: simulated ? 'TEST_ONLY' : 'COOPERATIVE_NATIVE_PARTIAL', eligible,
      decision: eligible ? prototype ? 'PROTOTYPE_UNVERIFIED' : 'REQUIREMENTS_SATISFIED' : 'INCOMPLETE_OR_REJECTED',
      reasons: policyCurrent ? quality.reasons : [...quality.reasons, 'POLICY_EXPIRED'],
      guarantees: quality.guarantees, production_verification: production, delivery_claim_allowed: production },
    source_level: simulated ? 'TEST_ONLY' : 'COOPERATIVE_NATIVE_PARTIAL', limitations: LIMITATIONS, resume_action: 'READ_ONLY_NO_RETRY' };
}

/** Explicit test facade. Lazy test-only dispatch avoids a module-initialization cycle and never manufactures an actual brand. */
export function openB2NativeTestStore(root: string, nativeFixtureRoot: string, context: { threadId: string; sessionId: string }, policyFixturePath: string) {
  need(arguments.length === 4, 'STORE_OPTIONS_UNSUPPORTED'); projectRootIdentity(root); checkedRelativeFile(policyFixturePath);
  const test: TestNativeContext = { fixtureRoot: nativeFixtureRoot, context, policyPath: policyFixturePath };
  const call = async (action: string, args: any[]) => {
    const storage = await import('../job-runtime/d1-b2-storage.ts'); return storage.performB2TestRoleSource(root, action, args, test);
  };
  return {
    roleQualityInitialize(...args: any[]) { return call('init', args); }, roleQualityCreate(...args: any[]) { return call('create', args); },
    roleQualityPrepare(...args: any[]) { return call('prepare', args); }, roleQualityObserve(...args: any[]) { return call('observe', args); },
    roleQualityOutcome(...args: any[]) { return call('outcome', args); }, roleQualityCancel(...args: any[]) { return call('cancel', args); },
    roleQualityReconcile(...args: any[]) { return call('reconcile', args); }, roleQualityResult(...args: any[]) { return call('result', args); },
    readTestBundle() { need(arguments.length === 0, 'STORE_OPTIONS_UNSUPPORTED'); return openB2NativeBundle(root, undefined, test).snapshot; },
  };
}
