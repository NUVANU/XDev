import { closeSync, fstatSync, openSync, readSync, existsSync, readFileSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRoleQualityArgs } from './d1-role-quality-args.ts';
import { mapB2PatchPaths } from './d1-b2-patch-path.ts';
import { b2Exact as exact, b2Need as need, b2Hash, b2Time, b2List, type B2Record } from '../job-runtime/d1-b2-contracts.ts';
import { readNativeSources, readTestOnlyNativeSources, isNativeSourceSnapshot,
  type NativeActorContext, type NativeSourceSnapshot, type NativeView } from './d1-native-resolver.ts';
import { parseNativeEnvelope, parseNativeMetadata, parseNativeJson, nativeTurnHeader, nativeRelationshipEvent,
  validateNativeTurn, type NativeEnvelope, type NativeRef, type NativeTurnHeader } from './d1-native-records.ts';
import { checkedRelativeFile, readProjectFile, projectRootIdentity, sha256 } from '../project-model/init-receipt.ts';
import { jsonBytes, hash, uuid, nativeManifestHash, withB2NativeSourceCheck, type B2NativeSourceCheck,
  nativeFileIdentity, nativeCurrentSubject, nativeCandidate, scopeContains, b2ScopeReviewPaths, type Source } from './d1-b2-source.ts';

const PACKAGE = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ISSUER = '01a105d3-2c97-7c01-ae2b-932696475524';
const TARGET = '01a0e63e-2203-7640-8f4e-c33135213d0d';
const actualBundles = new WeakSet<object>();
const rechecks = new WeakMap<object, () => void>();
const same = (a: unknown, b: unknown) => nativeManifestHash(a) === nativeManifestHash(b);
export type GrantLocator = { thread_id: string; item_id: string; ordinal: number; raw_sha256: string };
export type TestNativeContext = { fixtureRoot: string; context: NativeActorContext; policyPath: string };
export type NativeRow = { record: NativeEnvelope; ref: NativeRef; raw: string };
export type B2NativeBundle = { mode: 'NATIVE_PARTIAL' | 'TEST_ONLY_NATIVE'; root: string; policy: B2Record;
  policy_sha256: string; accepted: B2Record; snapshot: NativeSourceSnapshot; rows: NativeRow[];
  headers: NativeTurnHeader[]; sources: Source[]; parent: NativeActorContext; parentTurn: string };

export function isActualNativeBundle(value: unknown): value is B2NativeBundle {
  return !!value && typeof value === 'object' && actualBundles.has(value);
}
export function assertB2ActualNativeBundle(value: unknown): asserts value is B2NativeBundle {
  need(isActualNativeBundle(value), 'ACTUAL_SOURCE_REQUIRED');
}
export function revalidateB2NativeBundle(bundle: B2NativeBundle) {
  const check = rechecks.get(bundle); need(check, 'SOURCE_PROVENANCE_REQUIRED'); check();
}
export function validateGrantLocator(value: unknown): asserts value is GrantLocator {
  exact(value, ['thread_id', 'item_id', 'ordinal', 'raw_sha256']); uuid(value.thread_id); hash(value.raw_sha256);
  need(typeof value.item_id === 'string' && value.item_id.length > 0 && value.item_id.length <= 256 &&
    Number.isSafeInteger(value.ordinal) && value.ordinal >= 0, 'GRANT_LOCATOR');
}
function canonicalFile(path: string) {
  nativeFileIdentity(path); const bytes = readFileSync(path, 'utf8'); need(Buffer.byteLength(bytes) <= 1048576, 'SOURCE_SIZE');
  const value = parseNativeJson(bytes) as B2Record; exact(value, Object.keys(value));
  need(jsonBytes(value) === bytes, 'SOURCE_NONCANONICAL'); return { value, bytes, sha256: sha256(bytes) };
}
function policyShape(p: B2Record, root: string, test: boolean, read: B2NativeSourceCheck) {
  exact(p, ['format', 'project', 'epoch_id', 'parent_enrollment', 'owner_decisions', 'history', 'product_manifest_sha256',
    'scope', 'profiles', 'roles', 'budget', 'valid_from', 'deadline', 'runtime', 'read_plan', 'test_plan', 'required_guarantees']);
  need(p.format === 'xdev-b2-accepted-policy-3', 'POLICY_VERSION'); uuid(p.epoch_id); hash(p.product_manifest_sha256);
  exact(p.project, ['project_id', 'physical_root', 'physical_identity']); uuid(p.project.project_id);
  need(p.project.physical_root === root && p.project.physical_identity === projectRootIdentity(root).identity, 'POLICY_PROJECT');
  const e = p.parent_enrollment; exact(e, ['issuer_thread', 'target_parent_thread', 'parent_session', 'fork_refs', 'session_refs', 'old_stop_refs', 'old_terminal_refs', 'digest']);
  for (const key of ['issuer_thread', 'target_parent_thread', 'parent_session']) uuid(e[key]);
  const { digest, ...enrollment } = e; need(b2Hash(enrollment) === digest, 'ENROLLMENT_DIGEST');
  need(test || e.issuer_thread === ISSUER && e.target_parent_thread === TARGET, 'FIXED_ENROLLMENT');
  for (const key of ['fork_refs', 'session_refs', 'old_stop_refs', 'old_terminal_refs']) b2List(e[key], key === 'session_refs' ? 1 : 0, 64, () => {});
  const h = p.history; exact(h, ['coverage', 'source_refs', 'unresolved', 'disposition', 'sha256']);
  const { sha256: historySha, ...history } = h;
  need(h.coverage === 'COMPLETE' && h.disposition === 'FRESH_DOMAIN_ONLY' && h.unresolved.length === 0 && b2Hash(history) === historySha, 'HISTORY_BLOCKED');
  const s = p.scope; exact(s, ['allowed_actions', 'forbidden_actions', 'allowed_paths', 'forbidden_paths', 'managed_inputs', 'candidate_exclusions']);
  const actions = ['INIT', 'CREATE', 'ALLOCATE', 'PREPARE_ROLE', 'OBSERVE', 'OUTCOME', 'CANCEL', 'RECONCILE'];
  for (const key of ['allowed_actions', 'forbidden_actions']) b2List(s[key], 0, 8, x => need(actions.includes(x), 'POLICY_ACTION'));
  need(!s.allowed_actions.some((a: string) => s.forbidden_actions.includes(a)), 'POLICY_SCOPE');
  for (const key of ['allowed_paths', 'forbidden_paths']) b2List(s[key], key === 'allowed_paths' ? 1 : 0, 64,
    x => checkedRelativeFile(x.endsWith('/**') ? x.slice(0, -3) : x));
  for (const key of ['managed_inputs', 'candidate_exclusions']) b2List(s[key], 0, 64, x => {
    checkedRelativeFile(x); need(!scopeContains(s.allowed_paths, x), 'POLICY_SCOPE');
  });
  for (const key of Object.keys(s)) need(new Set(s[key]).size === s[key].length, 'POLICY_DUPLICATE');
  need(s.candidate_exclusions.every((x: string) => s.managed_inputs.includes(x)), 'CANDIDATE_EXCLUSION');
  exact(p.budget, ['call_cap', 'attempt_cap', 'previous_spent_calls', 'previous_spent_attempts', 'previous_reserved_calls']);
  for (const key of Object.keys(p.budget)) need(Number.isSafeInteger(p.budget[key]) && p.budget[key] >= 0, 'POLICY_BUDGET');
  need(p.budget.call_cap <= 4096 && p.budget.attempt_cap <= 512, 'POLICY_BUDGET');
  b2List(p.profiles, 1, 3, x => need(['prototype', 'quick_verified', 'full_governance'].includes(x), 'POLICY_PROFILE'));
  b2List(p.roles, 1, 9, r => {
    exact(r, ['profile', 'ordinal', 'purposes', 'actor_policy', 'agent_type', 'model', 'reasoning_effort', 'fork_turns']);
    need(p.profiles.includes(r.profile) && Number.isInteger(r.ordinal) && r.ordinal >= 1 && r.ordinal <= 3 &&
      r.fork_turns === 'none' && ['AUTHOR', 'INDEPENDENT'].includes(r.actor_policy) &&
      ['worker', 'reviewer', 'verifier'].includes(r.agent_type), 'POLICY_ROLE');
    b2List(r.purposes, 1, 4, x => need(['worker', 'review', 'qa', 'integration'].includes(x), 'POLICY_ROLE'));
    need(typeof r.model === 'string' && r.model.length > 0 && typeof r.reasoning_effort === 'string' && r.reasoning_effort.length > 0, 'POLICY_ROLE');
  });
  b2List(p.read_plan, 1, 16, r => { exact(r, ['id', 'role_ordinal', 'paths', 'coverage']);
    b2List(r.paths, 1, 64, checkedRelativeFile); b2List(r.coverage, 1, 64, () => {}); });
  b2List(p.test_plan, 0, 16, r => { exact(r, ['id', 'role_ordinal', 'argv', 'cwd', 'timeout_ms', 'max_buffer', 'coverage', 'environment']);
    need(r.cwd === root && Number.isInteger(r.timeout_ms) && r.timeout_ms > 0 && r.timeout_ms <= 120000 &&
      Number.isInteger(r.max_buffer) && r.max_buffer > 0 && r.max_buffer <= 65536, 'TEST_PLAN');
    b2List(r.argv, 1, 64, x => need(typeof x === 'string' && x.length > 0 && x.length <= 8192, 'TEST_PLAN'));
    b2List(r.coverage, 1, 64, () => {}); b2List(r.environment, 0, 16, x => {
      exact(x, ['name', 'value']); need(typeof x.name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(x.name) &&
        !['HOME', 'CODEX_HOME', 'PATH', 'NODE_OPTIONS'].includes(x.name) && typeof x.value === 'string', 'TEST_ENVIRONMENT');
    });
  });
  b2List(p.required_guarantees, 0, 7, x => need(['controller_intent', 'native_call_linkage', 'execution_subject',
    'known_writer_closure', 'quality_evidence', 'scope_review_v1'].includes(x), 'UNSUPPORTED_REQUIRED_GUARANTEE'));
  // Source qualification survives expiry. New execution admission is checked separately.
  need(b2Time(p.valid_from) <= Date.now() && b2Time(p.deadline) > b2Time(p.valid_from), 'POLICY_TIME');
  read.environment(root, p.runtime);
  need(p.runtime.recorder.path === join(PACKAGE, 'src', 'host-surface', 'd1-b2-command-recorder.ts'), 'FIXED_RECORDER');
}

/** Expands only views admitted by the existing resolver; no catalog or pagination implementation is duplicated. */
function expand(snapshot: NativeSourceSnapshot, selected: NativeRef[]) {
  need(snapshot.coverage.status === 'COMPLETE', 'NATIVE_SOURCE_INCOMPLETE');
  const rows: NativeRow[] = [], headers: NativeTurnHeader[] = []; let relevant = 0;
  for (const view of snapshot.coverage.views) {
    const fd = openSync(view.path, 'r'); let bytes: Buffer;
    try {
      const stat = fstatSync(fd, { bigint: true });
      need(String(stat.dev) === view.dev && String(stat.ino) === view.ino && stat.size >= BigInt(view.prefixBytes), 'NATIVE_SOURCE_DRIFT');
      need(view.prefixBytes <= 128 * 1024 * 1024, 'NATIVE_PREFIX_LIMIT'); bytes = Buffer.alloc(view.prefixBytes);
      let pos = 0; while (pos < bytes.length) { const n = readSync(fd, bytes, pos, bytes.length - pos, pos); need(n > 0, 'NATIVE_SHORT_READ'); pos += n; }
      need(sha256(bytes) === view.prefixSha256, 'NATIVE_SOURCE_DRIFT');
    } finally { closeSync(fd); }
    const selectedHere = selected.filter(ref => ref.locator === view.locator && ref.threadId === view.threadId);
    const turns = new Set<string>(); if (snapshot.coverage.activeTurnId) turns.add(snapshot.coverage.activeTurnId);
    for (const ref of selectedHere) {
      need(ref.byteOffset >= 0 && ref.byteLength > 0 && ref.byteOffset + ref.byteLength <= bytes.length, 'NATIVE_REF_BOUND');
      const r = parseNativeEnvelope(bytes.subarray(ref.byteOffset, ref.byteOffset + ref.byteLength - 1));
      const turn = r.type === 'response_item' ? r.payload.internal_chat_message_metadata_passthrough?.turn_id : r.payload.turn_id;
      if (typeof turn === 'string') turns.add(turn);
    }
    // Retain original returns only for spawn calls already selected in this validated prefix.
    const spawnCallIds = new Set<string>(); let scanOffset = 0;
    while (scanOffset < bytes.length) {
      const end = bytes.indexOf(10, scanOffset); need(end >= scanOffset, 'NATIVE_TORN_PREFIX');
      const record = parseNativeEnvelope(bytes.subarray(scanOffset, end));
      const turn = record.type === 'response_item' ? record.payload.internal_chat_message_metadata_passthrough?.turn_id : record.payload.turn_id;
      if (record.type === 'response_item' && record.payload.type === 'function_call' &&
        record.payload.namespace === 'collaboration' && record.payload.name === 'spawn_agent' &&
        (turns.has(turn) || selectedHere.some(r => r.ordinal === record.ordinal))) {
        spawnCallIds.add(record.payload.call_id); need(spawnCallIds.size <= 4096, 'NATIVE_HEAD_LIMIT');
      }
      scanOffset = end + 1;
    }
    let childView = false, offset = 0, line = 0, expected = view.startOrdinal;
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset); need(end >= offset, 'NATIVE_TORN_PREFIX'); const rawBytes = bytes.subarray(offset, end);
      const record = parseNativeEnvelope(rawBytes); need(record.ordinal === expected++, 'NATIVE_ORDINAL'); line++;
      const ref: NativeRef = { threadId: view.threadId, locator: view.locator, path: view.path, ordinal: record.ordinal,
        line, byteOffset: offset, byteLength: end - offset + 1, sha256: sha256(rawBytes), prefixBytes: view.prefixBytes,
        prefixSha256: view.prefixSha256, dev: view.dev, ino: view.ino };
      if (line === 1) { const metadata = parseNativeMetadata(record); need(metadata.threadId === view.threadId, 'NATIVE_OWNERSHIP'); childView = metadata.shape === 'DIRECT_CHILD'; }
      const turn = record.type === 'response_item' ? record.payload.internal_chat_message_metadata_passthrough?.turn_id : record.payload.turn_id;
      const wanted = line === 1 || childView || turns.has(turn) || selectedHere.some(r => r.ordinal === record.ordinal) ||
        record.type === 'response_item' && record.payload.type === 'function_call_output' && spawnCallIds.has(record.payload.call_id) ||
        record.type === 'event_msg' && record.payload.item?.type === 'McpToolCall' &&
        snapshot.facts.some(f => f.kind === 'authority' && f.ref.threadId === view.threadId && record.ordinal >= f.ref.ordinal);
      const header = wanted ? nativeTurnHeader(record, ref) : null; if (header) headers.push(header);
      // Raw message bodies remain text; no recursive event recognition.
      if (wanted && ['session_meta', 'turn_context', 'response_item', 'event_msg'].includes(record.type)) {
        need(++relevant <= 4096, 'NATIVE_HEAD_LIMIT'); rows.push({ record, ref, raw: rawBytes.toString('utf8') });
      }
      offset = end + 1;
    }
    need(expected === view.endOrdinal, 'NATIVE_VIEW_BOUND');
  }
  return { rows, headers };
}
export function nativeRowRef(row: NativeRow) { return { id: `native:${row.ref.threadId}:${row.ref.locator}:${row.ref.ordinal}`, sha256: row.ref.sha256 }; }
export function nativeRowSource(row: NativeRow): Source { return { ...nativeRowRef(row), path: null, bytes: row.raw }; }
export function verifyOriginalRef(bundle: B2NativeBundle, ref: NativeRef) {
  return verifyOriginalRefs(bundle, [ref])[0]!;
}
/** One bounded read group per validation boundary; no bytes survive this call. */
export function verifyOriginalRefs(bundle: B2NativeBundle, refs: NativeRef[]) {
  const rows = refs.map(ref => {
    exact(ref, ['threadId', 'locator', 'path', 'ordinal', 'line', 'byteOffset', 'byteLength', 'sha256', 'prefixBytes', 'prefixSha256', 'dev', 'ino']);
    const row = bundle.rows.find(x => x.ref.threadId === ref.threadId && x.ref.locator === ref.locator && x.ref.ordinal === ref.ordinal);
    need(row && ['path', 'line', 'byteOffset', 'byteLength', 'sha256', 'dev', 'ino'].every(k => (row.ref as any)[k] === (ref as any)[k]), 'NATIVE_REF_DRIFT');
    need(ref.prefixBytes >= ref.byteOffset + ref.byteLength && ref.prefixBytes <= row.ref.prefixBytes && ref.prefixBytes <= 128 * 1024 * 1024, 'NATIVE_REF_PREFIX');
    return row;
  });
  for (const path of new Set(refs.map(r => r.path))) {
    const group = refs.filter(r => r.path === path), length = group.reduce((max, r) => Math.max(max, r.prefixBytes), 0);
    const fd = openSync(path, 'r');
    try {
      const before = fstatSync(fd, { bigint: true });
      need(group.every(r => r.dev === String(before.dev) && r.ino === String(before.ino)) && before.size >= BigInt(length), 'NATIVE_REF_DRIFT');
      const bytes = Buffer.alloc(length), read = () => { let n = 0;
        while (n < length) { const count = readSync(fd, bytes, n, length - n, n); need(count > 0, 'NATIVE_SHORT_READ'); n += count; } return sha256(bytes); };
      const first = read(), second = read(), after = fstatSync(fd, { bigint: true });
      need(first === second && before.dev === after.dev && before.ino === after.ino && after.size >= BigInt(length), 'NATIVE_REF_DRIFT');
      const prefixes = new Map<number, string>();
      for (const ref of group) {
        if (!prefixes.has(ref.prefixBytes)) prefixes.set(ref.prefixBytes, ref.prefixBytes === length ? second : sha256(bytes.subarray(0, ref.prefixBytes)));
        need(prefixes.get(ref.prefixBytes) === ref.prefixSha256 && bytes[ref.byteOffset + ref.byteLength - 1] === 10 &&
          sha256(bytes.subarray(ref.byteOffset, ref.byteOffset + ref.byteLength - 1)) === ref.sha256, 'NATIVE_REF_DRIFT');
      }
    } finally { closeSync(fd); }
  }
  return rows;
}
function authority(bundle: B2NativeBundle, locator: GrantLocator) {
  validateGrantLocator(locator); need(locator.thread_id === bundle.policy.parent_enrollment.issuer_thread, 'GRANT_ISSUER');
  const row = bundle.rows.find(x => x.ref.threadId === locator.thread_id && x.record.ordinal === locator.ordinal);
  need(row && row.ref.sha256 === locator.raw_sha256, 'GRANT_SOURCE'); const r = row.record, p = r.payload, item = p.item;
  need(r.type === 'event_msg' && p.type === 'item_completed' && p.thread_id === locator.thread_id && item?.id === locator.item_id &&
    item.type === 'McpToolCall' && item.server === 'codex_app' && item.tool === 'send_message_to_thread' && item.status === 'completed', 'GRANT_MCP');
  need(Number.isSafeInteger(p.started_at_ms) && Number.isSafeInteger(p.completed_at_ms) && p.completed_at_ms >= p.started_at_ms, 'GRANT_TIME');
  validateNativeTurn(bundle.headers, locator.thread_id, p.turn_id, { operationOrdinal: r.ordinal });
  exact(item.arguments, ['threadId', 'prompt']); need(item.arguments.threadId === bundle.parent.threadId && typeof item.arguments.prompt === 'string', 'GRANT_TARGET');
  need(item.result?.isError === false && Array.isArray(item.result.content) && item.result.content.length === 1 &&
    item.result.content[0].type === 'text', 'GRANT_TRANSPORT');
  const business = parseNativeJson(item.result.content[0].text) as B2Record;
  need(business.threadId === bundle.parent.threadId, 'GRANT_BUSINESS_TARGET');
  const body = parseNativeJson(item.arguments.prompt) as B2Record; exact(body, Object.keys(body)); return { body, row };
}

export function openB2NativeBundle(root: string, locator?: GrantLocator, test?: TestNativeContext, children: string[] = [], priorRefs: NativeRef[] = []): B2NativeBundle {
  return withB2NativeSourceCheck(read => openNativeBundle(root, locator, test, children, priorRefs, read));
}
function openNativeBundle(root: string, locator: GrantLocator | undefined, test: TestNativeContext | undefined,
  children: string[], priorRefs: NativeRef[], read: B2NativeSourceCheck): B2NativeBundle {
  const identity = projectRootIdentity(root); need(identity.root === root, 'SOURCE_ALIAS');
  if (existsSync(join(root, '.xdev-d1-control', 'binding.json'))) {
    const binding = canonicalFile(join(root, '.xdev-d1-control', 'binding.json')).value;
    need(binding.domain?.protocol_version === 3 && binding.domain.mode === (test ? 'TEST_ONLY_NATIVE' : 'NATIVE_PARTIAL'), 'DOMAIN_MISMATCH');
  }
  // This check precedes every real native read, including the absent-authority branch.
  const deployment = test ? dirname(join(root, test.policyPath)) : join(PACKAGE, '.xdev-accepted-deployment');
  need(existsSync(join(deployment, 'accepted.json')) && existsSync(test ? join(root, test.policyPath) : join(deployment, 'policy.json')), 'AUTHORITY_UNAVAILABLE');
  const acceptedFile = canonicalFile(join(deployment, 'accepted.json')), accepted = acceptedFile.value;
  exact(accepted, ['format', 'product_manifest', 'policy_ref', 'acceptance_locator']);
  need(accepted.format === 'xdev-accepted-deployment-3', 'DEPLOYMENT_VERSION'); exact(accepted.policy_ref, ['path', 'sha256']);
  need(accepted.policy_ref.path === 'policy.json', 'FIXED_POLICY');
  const policyFile = canonicalFile(test ? join(root, test.policyPath) : join(deployment, 'policy.json')), policy = policyFile.value;
  need(policyFile.sha256 === accepted.policy_ref.sha256, 'POLICY_DRIFT'); policyShape(policy, root, !!test, read);
  need(same(accepted.product_manifest, read.productManifest(PACKAGE, policy.runtime)) &&
    nativeManifestHash(accepted.product_manifest) === policy.product_manifest_sha256, 'IMPLEMENTATION_DRIFT');
  const parent = { threadId: policy.parent_enrollment.target_parent_thread, sessionId: policy.parent_enrollment.parent_session };
  if (test) { exact(test.context, ['threadId', 'sessionId']); need(same(test.context, parent), 'PARENT_CONTEXT');
    need(resolve(test.fixtureRoot) === test.fixtureRoot && test.fixtureRoot !== join(process.env.CODEX_HOME ?? '', 'sessions'), 'TEST_SOURCE_SEPARATION'); }
  const threadIds = [...new Set([parent.threadId, policy.parent_enrollment.issuer_thread, ...children])];
  const queries = [accepted.acceptance_locator, ...(locator ? [locator] : [])].map(l => {
    validateGrantLocator(l); return { threadId: l.thread_id, kind: 'authority' as const, ordinal: l.ordinal };
  });
  const snapshot = test ? readTestOnlyNativeSources(test.fixtureRoot, test.context, { threadIds, queries }) : readNativeSources({ threadIds, queries });
  need(test ? snapshot.kind === 'TEST_ONLY_SOURCE_OBSERVATIONS' && !isNativeSourceSnapshot(snapshot) : isNativeSourceSnapshot(snapshot), 'ACTUAL_SOURCE_REQUIRED');
  const selected = [...snapshot.facts.map(f => f.ref), ...policy.parent_enrollment.session_refs, ...policy.parent_enrollment.fork_refs,
    ...policy.parent_enrollment.old_terminal_refs, ...policy.owner_decisions.map((d: B2Record) => d.native_ref), ...priorRefs];
  const expanded = expand(snapshot, selected), parentTurn = snapshot.coverage.activeTurnId; need(parentTurn, 'PARENT_TURN_UNAVAILABLE');
  validateNativeTurn(expanded.headers, parent.threadId, parentTurn);
  const bundle: B2NativeBundle = { mode: test ? 'TEST_ONLY_NATIVE' : 'NATIVE_PARTIAL', root, policy, policy_sha256: policyFile.sha256,
    accepted, snapshot, ...expanded, sources: [], parent, parentTurn };
  const enrollment = policy.parent_enrollment;
  for (const ref of [...enrollment.session_refs, ...enrollment.fork_refs, ...enrollment.old_terminal_refs]) verifyOriginalRef(bundle, ref);
  for (const ref of enrollment.old_stop_refs) need(sha256(readProjectFile(root, ref.path)) === ref.sha256, 'HISTORY_SOURCE_DRIFT');
  for (const decision of policy.owner_decisions) {
    exact(decision, ['native_ref', 'verbatim_sha256', 'scope_sha256', 'acceptance_kind']);
    const row = verifyOriginalRef(bundle, decision.native_ref), content = row.record.payload.item?.content;
    need(row.record.payload.item?.type === 'UserMessage' && Array.isArray(content) && content.length === 1 &&
      typeof content[0].text === 'string' && sha256(content[0].text) === decision.verbatim_sha256 &&
      decision.scope_sha256 === b2Hash(policy.scope) && decision.acceptance_kind === 'INDEPENDENT_MANUAL_SCOPE_ACCEPTANCE', 'OWNER_SOURCE');
  }
  const acceptance = authority(bundle, accepted.acceptance_locator);
  const expected = { format: 'xdev-native-deployment-acceptance-3', issuer_thread: enrollment.issuer_thread,
    target_parent_thread: parent.threadId, owner_decision_ref: policy.owner_decisions[0].native_ref,
    parent_enrollment_digest: enrollment.digest, product_manifest_sha256: policy.product_manifest_sha256,
    policy_sha256: policyFile.sha256, trial_root: root, physical_identity: identity.identity, history_digest: policy.history.sha256,
    valid_from: policy.valid_from, deadline: policy.deadline, decision_kind: 'PRODUCT_DEPLOYMENT_AND_TRIAL', scope_sha256: b2Hash(policy.scope) };
  need(same(acceptance.body, expected), 'DEPLOYMENT_ACCEPTANCE');
  bundle.sources.push(nativeRowSource(acceptance.row));
  const captured = expanded.rows.map(x => ({ ref: x.ref, raw: x.raw }));
  const candidateAtRead = existsSync(join(root, '.xdev-d1-control')) ? nativeManifestHash(nativeCandidate(root, policy)) : null;
  rechecks.set(bundle, () => withB2NativeSourceCheck(freshRead => {
    need(canonicalFile(test ? join(root, test.policyPath) : join(deployment, 'policy.json')).sha256 === policyFile.sha256 &&
      canonicalFile(join(deployment, 'accepted.json')).sha256 === acceptedFile.sha256, 'AUTHORITY_DRIFT');
    policyShape(policy, root, !!test, freshRead); need(same(freshRead.productManifest(PACKAGE, policy.runtime), accepted.product_manifest), 'IMPLEMENTATION_DRIFT');
    if (candidateAtRead !== null) need(nativeManifestHash(nativeCandidate(root, policy)) === candidateAtRead, 'CURRENT_SUBJECT_DRIFT');
    verifyOriginalRefs(bundle, captured.map(({ ref }) => ref));
    const fresh = test ? readTestOnlyNativeSources(test.fixtureRoot, test.context, { threadIds, queries }) : readNativeSources({ threadIds, queries });
    need(fresh.coverage.status === 'COMPLETE' && same(fresh.coverage.views.map(v => [v.locator, v.prefixBytes, v.prefixSha256]),
      snapshot.coverage.views.map(v => [v.locator, v.prefixBytes, v.prefixSha256])), 'NATIVE_FRESHNESS_DRIFT');
  }));
  const freeze = (value: any): void => { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child); Object.freeze(value); };
  freeze(bundle); if (!test) actualBundles.add(bundle); return bundle;
}

export function readB2NativeGrant(bundle: B2NativeBundle, locator: GrantLocator, current = true) {
  const { body, row } = authority(bundle, locator);
  exact(body, ['format', 'grant_id', 'issuer_thread', 'target_parent_thread', 'deployment_policy_sha256', 'implementation_manifest_sha256',
    'epoch_id', 'project_id', 'physical_root', 'physical_identity', 'create_ref', 'job_id', 'task_id', 'contract_sha256', 'criteria_sha256',
    'operative_sha256', 'project_head', 'job_head', 'operation_id', 'action', 'planned_binding_sha256', 'subject_sha256', 'role_plan_sha256',
    'allowed_scope_sha256', 'forbidden_scope_sha256', 'previous_spent_calls', 'previous_spent_attempts', 'previous_reserved_calls',
    'call_cap', 'attempt_cap', 'valid_from', 'deadline', 'required_guarantees']);
  need(body.format === 'xdev-native-role-grant-3' && body.issuer_thread === bundle.policy.parent_enrollment.issuer_thread &&
    body.target_parent_thread === bundle.parent.threadId && body.deployment_policy_sha256 === bundle.policy_sha256 &&
    body.implementation_manifest_sha256 === bundle.policy.product_manifest_sha256 && body.epoch_id === bundle.policy.epoch_id &&
    body.project_id === bundle.policy.project.project_id && body.physical_root === bundle.root &&
    body.physical_identity === bundle.policy.project.physical_identity, 'GRANT_SCOPE');
  uuid(body.grant_id); uuid(body.operation_id);
  const originalAt = Date.parse(row.record.timestamp);
  need(b2Time(body.valid_from) >= b2Time(bundle.policy.valid_from) && b2Time(body.valid_from) <= originalAt &&
    b2Time(body.deadline) <= b2Time(bundle.policy.deadline) && b2Time(body.deadline) > originalAt &&
    (!current || b2Time(body.valid_from) <= Date.now() && b2Time(body.deadline) > Date.now()), 'GRANT_EXPIRED');
  for (const later of bundle.rows.filter(x => x.ref.threadId === row.ref.threadId && x.record.ordinal > row.record.ordinal &&
    x.record.type === 'event_msg' && x.record.payload.item?.type === 'McpToolCall' &&
    x.record.payload.item.arguments?.threadId === bundle.parent.threadId)) {
    const next = authority(bundle, { thread_id: later.ref.threadId, item_id: later.record.payload.item.id,
      ordinal: later.record.ordinal, raw_sha256: later.ref.sha256 });
    if (same(next.body, body)) continue;
    if (!current && next.body.format === 'xdev-native-role-grant-3' && next.body.operation_id !== body.operation_id &&
      next.body.issuer_thread === body.issuer_thread && next.body.target_parent_thread === body.target_parent_thread &&
      next.body.deployment_policy_sha256 === body.deployment_policy_sha256 && next.body.epoch_id === body.epoch_id &&
      next.body.project_id === body.project_id && next.body.physical_identity === body.physical_identity &&
      ['PREPARE_ROLE', 'CANCEL', 'RECONCILE'].includes(next.body.action)) continue;
    need(false, next.body.format === 'xdev-native-role-grant-revocation-3' && next.body.grant_id === body.grant_id ? 'GRANT_REVOKED' : 'AUTHORITY_SUFFIX_AMBIGUOUS');
  }
  return { grant: body, ref: nativeRowRef(row), source: nativeRowSource(row), original: row };
}

const rowTurn = (row: NativeRow) => row.record.type === 'response_item'
  ? row.record.payload.internal_chat_message_metadata_passthrough?.turn_id : row.record.payload.turn_id;
function oneRow(rows: NativeRow[], code: string) { need(rows.length === 1, code); return rows[0]!; }
export type PrepareExpectation = { parameters: B2Record; result: B2Record; parentTurn: string; validFrom: string; deadline: string };
export type PrepareReturnBound = { kind: 'PREPARE_RETURN_BOUND'; returnedAt: number; ordinal: number; sources: Source[] };
export function prepareReturnBound(bundle: B2NativeBundle, expected: PrepareExpectation): PrepareReturnBound {
  const rows = bundle.rows.filter(r => r.ref.threadId === bundle.parent.threadId);
  const wanted = expected.parameters, name = wanted.action === 'PREPARE_ROLE' ? 'role_quality_prepare' : 'role_quality_prepare_control';
  const own = (r: NativeRow) => rowTurn(r) === expected.parentTurn;
  let call: NativeRow, output: NativeRow, command: NativeRow | undefined;
  if (bundle.mode === 'TEST_ONLY_NATIVE') {
    const candidates = rows.filter(r => r.record.type === 'response_item' && r.record.payload.type === 'function_call' &&
      r.record.payload.namespace === 'xdev_test_fixture' && r.record.payload.name === name &&
      (parseNativeJson(r.record.payload.arguments) as B2Record).operation_id === wanted.operation_id);
    call = oneRow(candidates, 'PREPARE_COMPLETION_UNKNOWN');
    need(own(call) && same(parseNativeJson(call.record.payload.arguments), wanted), 'PREPARE_PARAMETERS');
    output = oneRow(rows.filter(r => r.record.type === 'response_item' && r.record.payload.type === 'function_call_output' &&
      r.record.payload.call_id === call.record.payload.call_id), 'PREPARE_RETURN_UNKNOWN');
    const value = parseNativeJson(output.record.payload.output) as B2Record;
    need(value.actual_source_brand === false && value.result?.mode === 'TEST_ONLY_NATIVE' &&
      value.result.execution_permitted === false && value.result.host_action === null && same(value, expected.result), 'PREPARE_RESULT_BINDING');
  } else {
    need(!rows.some(r => r.record.type === 'response_item' && r.record.payload.namespace === 'xdev_test_fixture'), 'SYNTHETIC_PREPARE_IN_ACTUAL_SOURCE');
    const action = wanted.action === 'PREPARE_ROLE' ? 'prepare' : 'cancel', runtime = bundle.policy.runtime;
    const cli = join(PACKAGE, 'src', 'owner-ux', 'xdev.ts'), sq = (s: string) => "'" + s.replaceAll("'", "''") + "'";
    // The enrolled policy pins the fixed CLI/product/runtime/dependencies. Grant files remain original managed input locators.
    const tuples: string[][] = [];
    for (const path of bundle.policy.scope.managed_inputs as string[]) {
      if (!existsSync(join(bundle.root, path))) continue;
      let locator: unknown; try { locator = parseNativeJson(readProjectFile(bundle.root, path).toString('utf8')); } catch { continue; }
      if (!same(locator, wanted.grant_ref)) continue;
      const argv = ['role-quality', action, '--project-root', bundle.root, '--job', wanted.job_id, '--operation', wanted.operation_id,
        '--grant-ref', join(bundle.root, path), '--expected-head', wanted.expected_project_head, '--expected-job-head', wanted.expected_job_head];
      const parsed = parseRoleQualityArgs(argv.slice(1)); need(parsed.action === action && parsed.root === bundle.root, 'PREPARE_CLI_PARAMETERS');
      tuples.push([runtime.node.path, '--experimental-strip-types', cli, ...argv],
        [runtime.powershell.path, '-Command', `& ${[runtime.node.path, '--experimental-strip-types', cli, ...argv].map(sq).join(' ')}`],
        [runtime.powershell.path, '-Command', `& ${sq(runtime.node.path)} --experimental-strip-types ${sq(cli)} role-quality ${action} ` +
          argv.slice(2).map((s, i) => i % 2 === 0 ? s : sq(s)).join(' ')]);
    }
    command = oneRow(rows.filter(r => r.record.type === 'event_msg' && r.record.payload.type === 'item_completed' &&
      r.record.payload.item?.type === 'CommandExecution' && tuples.some(t => same(t, r.record.payload.item.command))), 'PREPARE_COMMAND_UNKNOWN');
    const item = command.record.payload.item;
    need(own(command) && command.record.payload.thread_id === bundle.parent.threadId && item.status === 'completed' && item.exit_code === 0 &&
      typeof item.stdout === 'string' && typeof item.stderr === 'string' && item.stderr === '' &&
      Buffer.byteLength(item.stdout) <= 65536 && typeof item.cwd === 'string' && item.cwd.startsWith('file:') &&
      fileURLToPath(item.cwd) === bundle.root && same(parseNativeJson(item.stdout), expected.result) &&
      expected.result.mode === 'NATIVE_PARTIAL' && expected.result.status === 'APPLIED' && expected.result.execution_permitted === true &&
      expected.result.host_action !== null, 'PREPARE_COMMAND_RESULT');
    const pairs = rows.filter(r => r.record.type === 'response_item' && r.record.payload.type === 'custom_tool_call' && r.record.payload.name === 'exec' && own(r))
      .map(c => ({ call: c, outputs: rows.filter(r => r.record.type === 'response_item' && r.record.payload.type === 'custom_tool_call_output' &&
        r.record.payload.call_id === c.record.payload.call_id) }))
      .filter(p => p.outputs.length === 1 && p.call.record.ordinal < command!.record.ordinal && p.outputs[0]!.record.ordinal > command!.record.ordinal);
    need(pairs.length === 1, 'PREPARE_TOOL_ASSOCIATION_UNKNOWN'); call = pairs[0]!.call; output = pairs[0]!.outputs[0]!;
    need(rows.filter(r => r.record.type === 'event_msg' && r.record.payload.type === 'item_completed' &&
      r.record.ordinal > call.record.ordinal && r.record.ordinal < output.record.ordinal &&
      ['CommandExecution', 'FileChange'].includes(r.record.payload.item?.type)).length === 1 &&
      typeof output.record.payload.output === 'string' && output.record.payload.output.length > 0 &&
      !output.record.payload.output.includes('truncated'), 'PREPARE_TOOL_ASSOCIATION_UNKNOWN');
  }
  const from = Date.parse(call.record.timestamp), returnedAt = Date.parse(output.record.timestamp);
  need(typeof call.record.payload.call_id === 'string' && call.record.payload.call_id.length > 0 &&
    own(output) && output.record.ordinal > call.record.ordinal && Number.isFinite(from) && Number.isFinite(returnedAt) &&
    from <= returnedAt && from >= b2Time(expected.validFrom) && returnedAt < b2Time(expected.deadline), 'PREPARE_RETURN_TIME');
  validateNativeTurn(bundle.headers, bundle.parent.threadId, expected.parentTurn, { operationOrdinal: call.record.ordinal });
  if (command) {
    const p = command.record.payload, anyInterval = p.started_at_ms !== undefined || p.completed_at_ms !== undefined;
    need(Date.parse(command.record.timestamp) >= from && Date.parse(command.record.timestamp) <= returnedAt, 'PREPARE_COMMAND_TIME');
    need(!anyInterval || Number.isSafeInteger(p.started_at_ms) && Number.isSafeInteger(p.completed_at_ms) &&
      from <= p.started_at_ms && p.started_at_ms <= p.completed_at_ms && p.completed_at_ms <= returnedAt, 'PREPARE_COMMAND_INTERVAL');
  }
  return { kind: 'PREPARE_RETURN_BOUND', returnedAt, ordinal: output.record.ordinal,
    sources: [call, ...(command ? [command] : []), output].map(nativeRowSource) };
}
export function assertAfterPrepare(call: NativeRow, bound: PrepareReturnBound) {
  need(call.record.ordinal > bound.ordinal && Date.parse(call.record.timestamp) > bound.returnedAt, 'HOST_ACTION_BEFORE_PREPARE_RETURN');
}
export function observedB2Children(bundle: B2NativeBundle, taskNames: string[]) {
  const pRows = bundle.rows.filter(r => r.ref.threadId === bundle.parent.threadId);
  const calls = pRows.filter(r => r.record.type === 'response_item' && r.record.payload.type === 'function_call' &&
    r.record.payload.namespace === 'collaboration' && r.record.payload.name === 'spawn_agent' &&
    taskNames.includes((parseNativeJson(r.record.payload.arguments) as B2Record).task_name));
  const ids: string[] = [];
  for (const call of calls) {
    const args = parseNativeJson(call.record.payload.arguments) as B2Record;
    const outputs = pRows.filter(r => r.record.type === 'response_item' && r.record.payload.type === 'function_call_output' &&
      r.record.payload.call_id === call.record.payload.call_id);
    if (outputs.length !== 1 || rowTurn(outputs[0]!) !== rowTurn(call) || outputs[0]!.record.ordinal <= call.record.ordinal) continue;
    const result = parseNativeJson(outputs[0]!.record.payload.output) as B2Record; exact(result, ['task_name']);
    const activities = pRows.filter(r => r.record.type === 'event_msg' && r.record.payload.item?.type === 'SubAgentActivity' &&
      r.record.payload.item.kind === 'started' && r.record.payload.item.id === call.record.payload.call_id &&
      r.record.payload.turn_id === rowTurn(call) && result.task_name === r.record.payload.item.agent_path &&
      r.record.payload.item.agent_path === '/root/' + args.task_name);
    ids.push(...activities.map(r => r.record.payload.item.agent_thread_id));
  }
  ids.forEach(uuid); need(new Set(ids).size === ids.length, 'CHILD_SOURCE_REUSE'); return ids as string[];
}
export function fixedRecorderCommand(root: string, runtime: B2Record, request: string) {
  const sq = (s: string) => "'" + s.replaceAll("'", "''") + "'";
  return [runtime.powershell.path, '-Command', `& ${sq(runtime.node.path)} --experimental-strip-types ${sq(runtime.recorder.path)} --project-root ${sq(root)} --request ${sq(join(root, request))}`];
}
export type ObservedB2Role = { native: B2Record | null; terminal: NativeRow | null; status: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
  sessions: B2Record[]; closed: boolean; commands: Array<{ row: NativeRow; request: B2Record; result: B2Record; requestRef: B2Record }>;
  failures: NativeRow[]; opinion: { row: NativeRow; body: B2Record; scope_blockers: string[] } | null; sources: Source[]; reasons: string[] };

/** Fixed technical inputs carried by existing managed_inputs/read_plan, not another manifest. */
export const B2_SCOPE_BLOB_PREFIX = 'scope-review-inputs/baseline/';
export type B2ScopeBaseline = { plan: B2Record; grant: B2Record; request: B2Record; requestRef: B2Record };
type ScopeChange = { path: string; before: string | null; after: string | null };

/** Whole-file unified review diff; not an applicable patch, permission grant, or semantic verdict. */
export function renderB2ScopeDiff(changes: ScopeChange[]): string {
  let output = '';
  for (const change of changes) {
    if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(change.path) || change.path.split('/').some(x => x === '.' || x === '..')) throw Error('B2_SCOPE_DIFF_PATH');
    const lines = (body: string | null): string[] => {
      if (body === null || body === '') return [];
      if (!body.endsWith('\n') || /[\x00-\x08\x0b-\x1f\x7f\r\ufffd]/.test(body) || Buffer.byteLength(body) > 65536) throw Error('B2_SCOPE_DIFF_TEXT_UNSUPPORTED');
      return body.slice(0, -1).split('\n');
    };
    const before = lines(change.before), after = lines(change.after);
    output += `diff --git a/${change.path} b/${change.path}\n` +
      `--- ${change.before === null ? '/dev/null' : 'a/' + change.path}\n` +
      `+++ ${change.after === null ? '/dev/null' : 'b/' + change.path}\n` +
      `@@ -${before.length ? 1 : 0},${before.length} +${after.length ? 1 : 0},${after.length} @@\n` +
      before.map(line => '-' + line + '\n').join('') + after.map(line => '+' + line + '\n').join('');
  }
  if (Buffer.byteLength(output) > 65536) throw Error('B2_SCOPE_DIFF_LIMIT');
  return output;
}

/** Exact fixed Node argv for separately authorized future material preparation; never executes it.
 * The script reads frozen request manifests and small file bodies and writes stdout only.
 * The definition is pinned with the existing product/runtime. Running it is not a native receipt
 * or actual QA evidence. The quality consumer independently recomputes from original READ bytes.
 * It never creates the excluded diff or baseline blobs and grants no additional role permission.
 */
export function b2ScopeDiffCommand(node: string, baselineRequest: string, candidateRequest: string): string[] {
  checkedRelativeFile(baselineRequest); checkedRelativeFile(candidateRequest);
  const script = `import {readFileSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
` +
    `const render = ${renderB2ScopeDiff.toString()};
` +
    `const read = p => { if (!/^[A-Za-z0-9_.-]+(?:\\/[A-Za-z0-9_.-]+)*$/.test(p) || p.split('/').some(x => x === '.' || x === '..')) throw Error('path'); let n='.'; for(const part of p.split('/')){n+='/'+part;if(lstatSync(n).isSymbolicLink()) throw Error('link');} const b=readFileSync(p); if(b.length>65536) throw Error('limit'); return b; };
` +
    `const old=JSON.parse(read(process.argv[1]).toString('utf8')).candidate_manifest.files;
` +
    `const now=JSON.parse(read(process.argv[2]).toString('utf8')).candidate_manifest.files;
` +
    `const body=(p,m)=>{const b=read(p); if(b.length!==m.bytes || createHash('sha256').update(b).digest('hex')!==m.sha256) throw Error('bytes'); const t=b.toString('utf8'); if(!Buffer.from(t).equals(b)) throw Error('utf8'); return t;};
` +
    `const changes=[]; for(const p of [...new Set([...old,...now].map(x=>x.path))].sort()){ const a=old.find(x=>x.path===p), b=now.find(x=>x.path===p); if(a&&b&&a.sha256===b.sha256&&a.bytes===b.bytes) continue; changes.push({path:p,before:a?body('${B2_SCOPE_BLOB_PREFIX}'+a.sha256+'.txt',a):null,after:b?body(p,b):null}); }
` +
    `process.stdout.write(render(changes));
`;
  return [node, '--input-type=module', '-e', script, baselineRequest, candidateRequest];
}

/** Verifies derived bytes from the two existing source-bound manifests; never accepts a trusted flag.
 * Baseline means the same Job's FIRST authorized Worker PREPARE, not CREATE or a repair snapshot.
 * Its blob identity is deliberately not equated with the original physical file identity.
 */
export function verifyB2ScopeDiff(scope: B2Record, plan: B2Record, citedReads: ObservedB2Role['commands'],
  policy: B2Record, baseline: B2ScopeBaseline): void {
  const { plan: first, request, requestRef, grant } = baseline;
  const material = b2ScopeReviewPaths(plan.ordinal);
  need(first.job_id === plan.job_id && first.task_id === plan.task_id && first.ordinal === 1 && first.role_ordinal === 1 &&
    same(first.purposes, ['worker']) && grant.subject_sha256 === b2Hash(first.subject) &&
    ['physical_root', 'physical_identity', 'workspace_id', 'contract_sha256', 'criteria_sha256', 'environment_sha256']
      .every(k => first.subject[k] === plan.subject[k]) &&
    same(first.subject, request.subject) && ['job_id', 'task_id', 'attempt_id', 'role_id'].every(k => request[k] === first[k]) &&
    request.mode === 'READ' && nativeManifestHash(request.candidate_manifest) === first.subject.candidate_sha256, 'SCOPE_BASELINE_BINDING');
  need(scope.diff_ref.id === 'file:' + material.diff, 'SCOPE_DIFF_REF');
  const own = citedReads.find(c => c.result.reads.some((r: B2Record) => r.path === material.diff));
  need(own, 'SCOPE_DIFF_NOT_PERSONALLY_READ');
  need(own.requestRef.path === material.request, 'SCOPE_ATTEMPT_REQUEST');
  const allReads = citedReads.flatMap(c => c.result.reads) as B2Record[];
  const read = (path: string): B2Record => {
    const found = allReads.filter(r => r.path === path); need(found.length === 1, 'SCOPE_MATERIAL_READ');
    const row = found[0]!; need(typeof row.body === 'string' && row.bytes === Buffer.byteLength(row.body) && row.bytes <= 65536 &&
      row.sha256 === sha256(row.body), 'SCOPE_MATERIAL_BYTES'); return row;
  };
  for (const ref of [requestRef, own.requestRef]) {
    need(ref.id === 'file:' + ref.path && read(ref.path).sha256 === ref.sha256, 'SCOPE_REQUEST_READ');
  }
  need(same(parseNativeJson(read(requestRef.path).body), request) &&
    same(parseNativeJson(read(own.requestRef.path).body), own.request), 'SCOPE_REQUEST_READ');
  const before = request.candidate_manifest, after = own.result.candidate_after;
  need(before.format === 'xdev-b2-candidate-3' && after.format === before.format && same(before.excluded, after.excluded), 'SCOPE_MANIFEST_EXCLUSIONS');
  for (const manifest of [before, after]) {
    b2List(manifest.files, 0, 20000, m => { exact(m, ['path', 'bytes', 'sha256', 'identity']); checkedRelativeFile(m.path);
      hash(m.sha256); hash(m.identity); need(Number.isSafeInteger(m.bytes) && m.bytes >= 0, 'SCOPE_MANIFEST_MEMBER'); });
    need(new Set(manifest.files.map((m: B2Record) => m.path)).size === manifest.files.length, 'SCOPE_MANIFEST_DUPLICATE');
  }
  const excludedInput = (path: string) => {
    need(policy.scope.managed_inputs.includes(path) && policy.scope.candidate_exclusions.includes(path) &&
      !scopeContains(policy.scope.allowed_paths, path) && !before.files.some((m: B2Record) => m.path === path) &&
      !after.files.some((m: B2Record) => m.path === path), 'SCOPE_MATERIAL_EXCLUSION');
  };
  excludedInput(material.diff);
  const changes: ScopeChange[] = [];
  const paths = [...new Set<string>([...before.files, ...after.files].map((m: B2Record) => m.path))].sort();
  for (const path of paths) {
    const a = before.files.find((m: B2Record) => m.path === path), b = after.files.find((m: B2Record) => m.path === path);
    if (a && b && a.sha256 === b.sha256 && a.bytes === b.bytes) {
      need(a.identity === b.identity, 'SCOPE_IDENTITY_ONLY_UNSUPPORTED'); continue;
    }
    need(scopeContains(policy.scope.allowed_paths, path) && !scopeContains(policy.scope.forbidden_paths, path), 'SCOPE_CHANGED_PATH');
    const body = (m: B2Record, baselineBody: boolean): string => {
      const p = baselineBody ? B2_SCOPE_BLOB_PREFIX + m.sha256 + '.txt' : path;
      if (baselineBody) excludedInput(p);
      const r = read(p); need(r.bytes === m.bytes && r.sha256 === m.sha256 && (baselineBody || r.identity === m.identity), 'SCOPE_FILE_BYTES');
      return r.body;
    };
    changes.push({ path, before: a ? body(a, true) : null, after: b ? body(b, false) : null });
  }
  const expected = renderB2ScopeDiff(changes), diff = read(material.diff);
  need(diff.body === expected && diff.sha256 === scope.diff_ref.sha256, 'SCOPE_DIFF_RECOMPUTATION');
}

/**
 * Finite opinion/READ-chain rules, not a native receipt or a diff producer. The production caller
 * supplies the hash-pinned Task and commands only AFTER original recorder/native validation below.
 * read_refs name this role's READ requests, never files. The added diff_ref names a result.reads file.
 * Scope also requires the first authorized baseline, personally read blobs and candidate bodies,
 * and deterministic recomputation. No caller flag or claimed generation command certifies them.
 * Only the independent Review role on a marked Job uses the new format; other role messages retain
 * their prior format. Old unmarked Jobs cannot opt in by changing a query or an opinion's format.
 */
export function validateB2ReviewOpinion(value: B2Record, plan: B2Record, task: B2Record,
  commands: ObservedB2Role['commands'], context?: { policy: B2Record; baseline: B2ScopeBaseline }): string[] {
  const scoped = task.required_guarantees.includes('scope_review_v1') && plan.purposes.includes('review');
  exact(value, ['format', 'job_id', 'task_id', 'attempt_id', 'role_id', 'subject_sha256', 'contract_ref',
    'criteria_ref', 'read_refs', 'findings', 'verdict', ...(scoped ? ['scope_review'] : [])]);
  need(value.format === (scoped ? 'xdev-native-review-scope-1' : 'xdev-native-review-3') &&
    ['job_id', 'task_id', 'attempt_id', 'role_id'].every(k => value[k] === plan[k]) &&
    value.subject_sha256 === b2Hash(plan.subject) && ['PASS', 'FAIL'].includes(value.verdict), 'OPINION_BINDING');
  b2List(value.findings, 0, 64, finding => {
    need(typeof finding === 'string' && finding.length > 0 && finding.length <= 8192, 'OPINION_FINDING');
  });
  b2List(value.read_refs, 1, 64, ref => { exact(ref, ['id', 'sha256']); hash(ref.sha256); });
  const personalRead = commands.find(c => c.request.mode === 'READ');
  need(personalRead && same(value.contract_ref, personalRead.request.contract_ref) &&
    same(value.criteria_ref, personalRead.request.criteria_ref), 'OPINION_TASK_AC_BINDING');
  const citedReads = commands.filter(c => c.request.mode === 'READ' && value.read_refs.some((ref: B2Record) =>
    same({ id: c.requestRef.id, sha256: c.requestRef.sha256 }, ref)));
  need(value.read_refs.every((ref: B2Record) => citedReads.some(c =>
    same({ id: c.requestRef.id, sha256: c.requestRef.sha256 }, ref))), 'PERSONAL_REVIEW_READ_REQUIRED');
  if (!scoped) return [];
  // Preserve the recorder's whole-result cap as well as each read/diff cap.
  need(commands.every(c => Buffer.byteLength(jsonBytes(c.result)) <= 65536), 'SCOPE_RECORDER_OUTPUT_LIMIT');
  need(!plan.purposes.includes('worker') && plan.packet.actor_policy === 'INDEPENDENT', 'SCOPE_REVIEW_INDEPENDENCE');
  need(new Set(value.read_refs.map((r: B2Record) => r.id)).size === value.read_refs.length &&
    citedReads.length === value.read_refs.length, 'SCOPE_READ_AMBIGUOUS');
  const scope = value.scope_review;
  exact(scope, ['criterion_id', 'diff_ref', 'decision', 'assessment']);
  need(typeof scope.criterion_id === 'string' && scope.criterion_id.trim().length > 0 &&
    ['PASS', 'FAIL', 'UNKNOWN'].includes(scope.decision) && typeof scope.assessment === 'string' &&
    scope.assessment.trim().length > 0 && scope.assessment.length <= 8192, 'SCOPE_REVIEW_SHAPE');
  const criterion = task.criteria.find((ac: B2Record) => ac.id === scope.criterion_id);
  need(criterion && same(value.criteria_ref, { id: 'file:' + criterion.source_ref.path, sha256: criterion.source_ref.sha256 }) &&
    citedReads.some(c => c.request.read_plan.some((p: B2Record) => p.coverage.includes('criterion:' + criterion.id))), 'SCOPE_REVIEW_CRITERION');
  exact(scope.diff_ref, ['id', 'sha256']); hash(scope.diff_ref.sha256);
  need(typeof scope.diff_ref.id === 'string' && scope.diff_ref.id.startsWith('file:'), 'SCOPE_DIFF_REF');
  const diffPath = scope.diff_ref.id.slice(5); checkedRelativeFile(diffPath);
  const matches = citedReads.flatMap(c => c.result.reads.filter((read: B2Record) => read.path === diffPath)
    .map((read: B2Record) => ({ command: c, read })));
  need(matches.length === 1, 'SCOPE_DIFF_NOT_PERSONALLY_READ');
  const { command, read } = matches[0]!;
  exact(read, ['path', 'bytes', 'sha256', 'body', 'identity']); hash(read.identity);
  need(typeof read.body === 'string' && read.bytes === Buffer.byteLength(read.body) && read.bytes <= 65536 &&
    read.sha256 === sha256(read.body) && read.sha256 === scope.diff_ref.sha256, 'SCOPE_DIFF_READ_BYTES');
  need(['job_id', 'task_id', 'attempt_id', 'role_id'].every(k => command.request[k] === plan[k] && command.result[k] === plan[k]) &&
    same(command.result.subject_after, plan.subject) && same(command.request.subject, plan.subject) &&
    nativeManifestHash(command.result.candidate_after) === plan.subject.candidate_sha256 &&
    same(command.result.candidate_after, command.request.candidate_manifest), 'SCOPE_DIFF_CANDIDATE');
  if (!context) return ['SCOPE_BASELINE_SOURCE_UNAVAILABLE'];
  verifyB2ScopeDiff(scope, plan, citedReads, context.policy, context.baseline);
  return scope.decision === 'PASS' ? [] : ['SCOPE_REVIEW_' + scope.decision];
}

export function observeB2Role(bundle: B2NativeBundle, plan: B2Record, historical = false, expected?: PrepareExpectation, baseline?: B2ScopeBaseline): ObservedB2Role {
  const pRows = bundle.rows.filter(r => r.ref.threadId === bundle.parent.threadId);
  const calls = pRows.filter(r => r.record.type === 'response_item' && r.record.payload.type === 'function_call' &&
    r.record.payload.namespace === 'collaboration' && r.record.payload.name === 'spawn_agent' &&
    (parseNativeJson(r.record.payload.arguments) as B2Record).task_name === plan.request_fields.task_name);
  const empty: ObservedB2Role = { native: null, terminal: null, status: 'FAILED', sessions: [], closed: false,
    commands: [], failures: [], opinion: null, sources: [], reasons: ['NATIVE_SEND_UNKNOWN'] };
  if (calls.length === 0) return empty;
  const call = oneRow(calls, 'EXTRA_NATIVE_CALL'), cp = call.record.payload, args = parseNativeJson(cp.arguments) as B2Record;
  need(expected, 'PREPARE_EXPECTATION_REQUIRED'); const bound = prepareReturnBound(bundle, expected); assertAfterPrepare(call, bound);
  exact(args, ['task_name', 'agent_type', 'model', 'reasoning_effort', 'fork_turns', 'message']);
  const { message, ...fields } = args; need(same(fields, plan.request_fields), 'NATIVE_REQUEST_MISMATCH');
  need(rowTurn(call) === plan.parent_turn_id && Date.parse(call.record.timestamp) >= b2Time(plan.committed_at) &&
    Date.parse(call.record.timestamp) < b2Time(plan.deadline), 'NATIVE_CALL_CONTEXT');
  validateNativeTurn(bundle.headers, bundle.parent.threadId, rowTurn(call), { operationOrdinal: call.record.ordinal });
  const outputRows = pRows.filter(r => r.record.type === 'response_item' && r.record.payload.type === 'function_call_output' && r.record.payload.call_id === cp.call_id);
  if (!outputRows.length) return { ...empty, sources: [...bound.sources, nativeRowSource(call)] };
  const output = oneRow(outputRows, 'NATIVE_RETURN_DUPLICATE');
  need(rowTurn(output) === rowTurn(call) && output.record.ordinal > call.record.ordinal, 'NATIVE_RETURN_TURN');
  const result = parseNativeJson(output.record.payload.output) as B2Record; exact(result, ['task_name']);
  const activity = oneRow(pRows.filter(r => r.record.type === 'event_msg' && r.record.payload.item?.type === 'SubAgentActivity' &&
    r.record.payload.item.kind === 'started' && r.record.payload.item.id === cp.call_id), 'NATIVE_CHILD_ACTIVITY');
  const child = activity.record.payload.item.agent_thread_id, agentPath = activity.record.payload.item.agent_path;
  need(activity.record.payload.turn_id === rowTurn(call) && result.task_name === agentPath &&
    agentPath === '/root/' + fields.task_name, 'NATIVE_CHILD_PATH'); uuid(child);
  need(!pRows.some(r => r.record.type === 'response_item' && r.record.payload.type === 'function_call' &&
    r.record.payload.namespace === 'collaboration' && r.record.payload.name === 'followup_task' &&
    (parseNativeJson(r.record.payload.arguments) as B2Record).target === agentPath), 'UNPLANNED_ROLE_REACTIVATION');
  const childRows = bundle.rows.filter(r => r.ref.threadId === child);
  const metadataRow = oneRow(childRows.filter(r => r.record.type === 'session_meta'), 'NATIVE_CHILD_METADATA');
  const meta = parseNativeMetadata(metadataRow.record);
  need(meta.shape === 'DIRECT_CHILD' && meta.parentId === bundle.parent.threadId && meta.sessionId === bundle.parent.sessionId &&
    meta.agentPath === agentPath && meta.role === fields.agent_type, 'NATIVE_CHILD_LINEAGE');
  const starts = childRows.filter(r => r.record.type === 'event_msg' && r.record.payload.type === 'task_started');
  const start = oneRow(starts, 'NATIVE_CHILD_TURN'); const turn = start.record.payload.turn_id;
  const lifecycle = validateNativeTurn(bundle.headers, child, turn, { rootTurnId: rowTurn(call) });
  const contextRows = childRows.filter(r => r.record.type === 'turn_context');
  need(contextRows.length > 0 && contextRows.every(r => r.record.payload.turn_id === turn &&
    r.record.payload.model === fields.model && r.record.payload.effort === fields.reasoning_effort &&
    r.record.payload.sandbox_policy && r.record.payload.permission_profile), 'NATIVE_ACTUAL_CONTEXT');
  const body = oneRow(childRows.filter(r => r.record.type === 'response_item' && r.record.payload.type === 'agent_message' &&
    r.record.payload.author === '/root' && r.record.payload.recipient === agentPath), 'NATIVE_CHILD_BODY');
  const bodyEvent = nativeRelationshipEvent(body.record, body.ref); need(bodyEvent?.kind === 'message', 'NATIVE_CHILD_BODY');
  need(typeof message === 'string' && sha256(message) === bodyEvent.data.messageHash, 'NATIVE_OPAQUE_MISMATCH');
  const native = { parent_thread: bundle.parent.threadId, child_thread: child, turn_id: turn, call_id: cp.call_id,
    agent_path: agentPath, actor_id: child, request_fields: fields, coverage: 'COMPLETE',
    message: { representation: 'opaque', parent_value: sha256(message), child_value: bodyEvent.data.messageHash },
    source_refs: [nativeRowRef(call), nativeRowRef(output), nativeRowRef(activity), nativeRowRef(metadataRow), nativeRowRef(body)] };
  // Each retained ref pins the complete consumed prefix. Context and custom outputs are re-read from that prefix,
  // rather than consuming a second source slot for an unreferenced duplicate of the same provenance.
  const sources = [...bound.sources, ...[call, output, activity, metadataRow, body].map(nativeRowSource)];
  const terminal = lifecycle.terminal ? childRows.find(r => r.record.ordinal === lifecycle.terminal!.ordinal)! : null;
  const ownRows = childRows.filter(r => rowTurn(r) === turn);
  const intervals: Array<{ call: NativeRow; output: NativeRow | null; items: NativeRow[] }> = [];
  const toolCalls = ownRows.filter(r => r.record.type === 'response_item' &&
    ['custom_tool_call', 'function_call'].includes(r.record.payload.type));
  need(toolCalls.length <= 64, 'NATIVE_TOOL_LIMIT');
  const reasons: string[] = [];
  for (const callRow of toolCalls) {
    const p = callRow.record.payload;
    if (p.type !== 'custom_tool_call' || p.name !== 'exec') { sources.push(nativeRowSource(callRow)); reasons.push('UNSUPPORTED_TURN_TOOL'); continue; }
    const returns = ownRows.filter(r => r.record.type === 'response_item' && r.record.payload.type === 'custom_tool_call_output' && r.record.payload.call_id === p.call_id);
    need(returns.length <= 1 && (!returns.length || returns[0]!.record.ordinal > callRow.record.ordinal), 'NATIVE_TOOL_PAIR');
    const out = returns[0] ?? null;
    const items = ownRows.filter(r => r.record.type === 'event_msg' && r.record.payload.type === 'item_completed' &&
      ['CommandExecution', 'FileChange'].includes(r.record.payload.item?.type) && r.record.ordinal > callRow.record.ordinal &&
      (!out || r.record.ordinal < out.record.ordinal));
    if (!out || items.length !== 1) reasons.push('NATIVE_TOOL_UNKNOWN');
    need(intervals.every(i => (i.output?.record.ordinal ?? Infinity) < callRow.record.ordinal), 'NATIVE_TOOL_OVERLAP');
    intervals.push({ call: callRow, output: out, items }); sources.push(nativeRowSource(callRow));
  }
  const hostItems = ownRows.filter(r => r.record.type === 'event_msg' && r.record.payload.type === 'item_completed' &&
    ['CommandExecution', 'FileChange'].includes(r.record.payload.item?.type));
  for (const row of ownRows.filter(r => r.record.type === 'event_msg' && r.record.payload.type === 'item_completed' &&
    !['CommandExecution', 'FileChange', 'AgentMessage', 'Reasoning'].includes(r.record.payload.item?.type))) {
    sources.push(nativeRowSource(row)); reasons.push('UNSUPPORTED_TURN_TOOL');
  }
  need(hostItems.every(r => intervals.filter(i => i.items.includes(r)).length === 1), 'NATIVE_ORPHAN_ITEM');
  need(ownRows.filter(r => r.record.type === 'response_item' && r.record.payload.type === 'custom_tool_call_output')
    .every(r => intervals.some(i => i.output === r)), 'NATIVE_ORPHAN_RETURN');
  const commands: ObservedB2Role['commands'] = [], failures: NativeRow[] = []; let failed = false;
  for (const row of hostItems) {
    sources.push(nativeRowSource(row)); const wrapper = row.record.payload, item = wrapper.item;
    need(wrapper.thread_id === child && Number.isSafeInteger(wrapper.started_at_ms) && Number.isSafeInteger(wrapper.completed_at_ms) &&
      wrapper.started_at_ms <= wrapper.completed_at_ms && wrapper.started_at_ms >= Date.parse(start.record.timestamp) &&
      (historical || wrapper.completed_at_ms < b2Time(plan.deadline)), 'NATIVE_ITEM_CONTEXT');
    if (item.type === 'FileChange') {
      need(plan.purposes.includes('worker'), 'CHECKER_WRITE'); exact(item.changes, Object.keys(item.changes));
      for (const rawPath of mapB2PatchPaths(bundle.root, item.changes, bundle.policy.scope).values()) {
        const change = item.changes[rawPath];
        need(['add', 'delete', 'update'].includes(change.type) && (change.type !== 'update' || change.move_path === null), 'PATCH_SHAPE');
      }
      if (item.status !== 'completed') failed = true; continue;
    }
    need(['completed', 'failed'].includes(item.status) && Number.isSafeInteger(item.exit_code) && typeof item.stdout === 'string' &&
      typeof item.stderr === 'string' && Buffer.byteLength(item.stdout) <= 65536 && Buffer.byteLength(item.stderr) <= 65536, 'NATIVE_COMMAND_UNKNOWN');
    need(typeof item.cwd === 'string' && item.cwd.startsWith('file:') && fileURLToPath(item.cwd) === bundle.root, 'NATIVE_COMMAND_CWD');
    const requestRef = plan.recorder_request_refs.find((r: B2Record) => same(fixedRecorderCommand(bundle.root, bundle.policy.runtime, r.path), item.command));
    need(requestRef, 'NATIVE_COMMAND_NOT_PLANNED');
    const rawRequest = readProjectFile(bundle.root, requestRef.path);
    need(sha256(rawRequest) === requestRef.sha256, 'RECORDER_REQUEST_DRIFT');
    const request = parseNativeJson(rawRequest.toString('utf8')) as B2Record;
    const knownFailure = item.status === 'failed' || item.exit_code !== 0;
    if (knownFailure) { failed = true; failures.push(row); }
    let recorded: B2Record;
    try { recorded = parseNativeJson(item.stdout) as B2Record; }
    catch (error) { if (knownFailure) continue; throw error; }
    // A closed failed process need not have produced the recorder's successful schema.
    // Preserve its raw negative source; never manufacture QA coverage or a recorder read.
    if (knownFailure && recorded?.format !== 'xdev-native-recorder-result-3') continue;
    exact(recorded, ['format', 'job_id', 'task_id', 'attempt_id', 'role_id', 'mode', 'subject_before', 'subject_after',
      'candidate_before', 'candidate_after', 'environment_before', 'environment_after', 'reads', 'tests', 'started_at', 'ended_at', 'status']);
    need(recorded.format === 'xdev-native-recorder-result-3' && ['job_id', 'task_id', 'attempt_id', 'role_id'].every(k => recorded[k] === plan[k]) &&
      recorded.mode === request.mode && (plan.purposes.includes('worker') || same(recorded.subject_before, request.subject) && same(recorded.candidate_before, request.candidate_manifest)) &&
      same(recorded.environment_before, request.environment), 'RECORDER_BINDING');
    const current = nativeCurrentSubject(bundle.root, bundle.policy, request.contract_ref);
    need(recorded.subject_after.candidate_sha256 === nativeManifestHash(recorded.candidate_after) &&
      recorded.subject_before.candidate_sha256 === nativeManifestHash(recorded.candidate_before) &&
      recorded.subject_after.environment_sha256 === nativeManifestHash(recorded.environment_after) &&
      same(recorded.environment_before, recorded.environment_after) &&
      ['physical_root', 'physical_identity', 'workspace_id', 'contract_sha256', 'criteria_sha256'].every(k =>
        recorded.subject_before[k] === recorded.subject_after[k]), 'RECORDER_SUBJECT_BINDING');
    if (!historical && !plan.purposes.includes('worker')) need(same(recorded.subject_after, current.subject) && same(recorded.candidate_after, current.candidate) &&
      same(recorded.environment_after, current.environment), 'RECORDER_CURRENT_SUBJECT');
    if (!plan.purposes.includes('worker')) need(same(recorded.subject_before, recorded.subject_after), 'CHECKER_CANDIDATE_DRIFT');
    const beforeFiles = recorded.candidate_before.files as B2Record[], afterFiles = recorded.candidate_after.files as B2Record[];
    b2List(afterFiles, 0, 20000, member => { exact(member, ['path', 'bytes', 'sha256', 'identity']); checkedRelativeFile(member.path);
      hash(member.sha256); hash(member.identity); need(Number.isSafeInteger(member.bytes) && member.bytes >= 0, 'MEMBER_SIZE'); });
    need(new Set(afterFiles.map(m => m.path)).size === afterFiles.length && same(recorded.candidate_before.excluded, recorded.candidate_after.excluded), 'RECORDER_MANIFEST');
    for (const recordedFiles of [beforeFiles, afterFiles]) for (const path of new Set([...request.candidate_manifest.files, ...recordedFiles].map(m => m.path))) {
      if (same(request.candidate_manifest.files.find((m: B2Record) => m.path === path) ?? null, recordedFiles.find(m => m.path === path) ?? null)) continue;
      need(plan.purposes.includes('worker') && scopeContains(bundle.policy.scope.allowed_paths, path) &&
        !scopeContains(bundle.policy.scope.forbidden_paths, path) && hostItems.some(patch => patch.record.payload.item.type === 'FileChange' &&
          patch.record.payload.item.status === 'completed' && mapB2PatchPaths(bundle.root, patch.record.payload.item.changes, bundle.policy.scope).has(path) &&
          patch.record.ordinal < row.record.ordinal), 'RECORDER_PATCH_SCOPE');
    }
    need(b2Time(recorded.started_at) >= wrapper.started_at_ms && b2Time(recorded.ended_at) >= b2Time(recorded.started_at) &&
      b2Time(recorded.ended_at) <= wrapper.completed_at_ms, 'RECORDER_TIME');
    b2List(recorded.reads, 1, 64, read => {
      exact(read, ['path', 'bytes', 'sha256', 'body', 'identity']); checkedRelativeFile(read.path);
      need(typeof read.body === 'string' && read.bytes === Buffer.byteLength(read.body) && read.bytes <= 65536 &&
        read.sha256 === sha256(read.body), 'RECORDER_READ_BYTES');
      const pinned = beforeFiles.find(m => m.path === read.path);
      if (pinned) need(read.bytes === pinned.bytes && read.sha256 === pinned.sha256 && read.identity === pinned.identity, 'RECORDER_READ_BINDING');
      else { const bytes = readProjectFile(bundle.root, read.path);
        need(read.body === bytes.toString('utf8') && read.bytes === bytes.length && read.sha256 === sha256(bytes) &&
          read.identity === nativeFileIdentity(join(bundle.root, read.path)), 'RECORDER_READ_DRIFT'); }
    });
    const expectedReads = [...new Set(request.read_plan.flatMap((r: B2Record) => r.paths))];
    need(same([...recorded.reads.map((r: B2Record) => r.path)].sort(), expectedReads.sort()), 'RECORDER_READ_INCOMPLETE');
    need(recorded.reads.some((r: B2Record) => 'file:' + r.path === request.contract_ref.id) &&
      current.task.criteria.every((r: B2Record) => recorded.reads.some((read: B2Record) => read.path === r.source_ref.path)), 'PERSONAL_TASK_AC_READ_REQUIRED');
    b2List(recorded.tests, 0, 16, test => {
      exact(test, ['id', 'argv', 'cwd', 'started_at', 'ended_at', 'status', 'exit_code', 'stdout', 'stderr', 'stdout_sha256', 'stderr_sha256']);
      const expected = request.test_plan.find((r: B2Record) => r.id === test.id);
      need(expected && same(expected.argv, test.argv) && expected.cwd === test.cwd && test.status === 'completed' &&
        Number.isSafeInteger(test.exit_code) && typeof test.stdout === 'string' && typeof test.stderr === 'string' &&
        sha256(test.stdout) === test.stdout_sha256 && sha256(test.stderr) === test.stderr_sha256 &&
        Buffer.byteLength(test.stdout) <= expected.max_buffer && Buffer.byteLength(test.stderr) <= expected.max_buffer &&
        b2Time(test.started_at) >= b2Time(recorded.started_at) && b2Time(test.ended_at) <= b2Time(recorded.ended_at), 'ACTUAL_TEST_BINDING');
      if (test.exit_code !== 0) failed = true;
    });
    need(recorded.mode !== 'QA' || recorded.tests.length === request.test_plan.length &&
      new Set(recorded.tests.map((t: B2Record) => t.id)).size === recorded.tests.length, 'ACTUAL_QA_INCOMPLETE');
    need(recorded.mode !== 'READ' || recorded.tests.length === 0, 'READ_NOT_QA');
    if (item.status === 'failed' || item.exit_code !== 0 || item.stderr.length || recorded.status !== 'completed') failed = true;
    commands.push({ row, request, result: recorded, requestRef });
  }
  const qaCommands = commands.filter(c => c.request.mode === 'QA');
  need(new Set(qaCommands.map(c => c.requestRef.id)).size === qaCommands.length, 'RECORDER_DUPLICATE_COMMAND');
  if (!historical && plan.purposes.includes('worker') && commands.length && terminal) {
    const current = nativeCurrentSubject(bundle.root, bundle.policy, commands.at(-1)!.request.contract_ref);
    need(same(commands.at(-1)!.result.subject_after, current.subject) && same(commands.at(-1)!.result.candidate_after, current.candidate), 'RECORDER_CURRENT_SUBJECT');
    need(!hostItems.some(r => r.record.payload.item.type === 'FileChange' && r.record.ordinal > commands.at(-1)!.row.record.ordinal), 'POST_RECORD_PATCH');
  }
  const opinionRows = ownRows.filter(r => r.record.type === 'event_msg' && r.record.payload.item?.type === 'AgentMessage' && r.record.payload.item.phase === 'final_answer');
  need(opinionRows.length <= 1, 'OPINION_DUPLICATE'); let opinion: ObservedB2Role['opinion'] = null;
  if (opinionRows.length) {
    const row = opinionRows[0]!, content = row.record.payload.item.content;
    need(Array.isArray(content) && content.length === 1 && content[0].type === 'Text', 'OPINION_SHAPE');
    const value = parseNativeJson(content[0].text) as B2Record;
    const personalRead = commands.find(c => c.request.mode === 'READ');
    need(personalRead, 'PERSONAL_REVIEW_READ_REQUIRED');
    const task = nativeCurrentSubject(bundle.root, bundle.policy, personalRead.request.contract_ref).task;
    const scopeBlockers = validateB2ReviewOpinion(value, plan, task, commands, baseline ? { policy: bundle.policy, baseline } : undefined);
    if (value.format === 'xdev-native-review-scope-1') need(commands.every(c => c.row.record.ordinal < row.record.ordinal), 'SCOPE_OPINION_BEFORE_EVIDENCE');
    if (value.verdict === 'FAIL' || value.findings.length) failed = true;
    if (scopeBlockers.some(reason => reason === 'SCOPE_REVIEW_FAIL' || reason === 'SCOPE_REVIEW_UNKNOWN')) failed = true;
    opinion = { row, body: value, scope_blockers: scopeBlockers }; sources.push(nativeRowSource(row));
  }
  if (terminal) { sources.push(nativeRowSource(terminal));
    need(hostItems.every(r => r.record.ordinal < terminal.record.ordinal), 'AFTER_TERMINAL_TOOL'); }
  const closed = !!terminal && reasons.length === 0;
  const sessions = intervals.map(i => ({ id: i.call.record.payload.call_id, state: i.output && i.items.length === 1 ? 'CLOSED' : 'OPEN', source_ref: nativeRowRef(i.call) }));
  return { native, terminal, closed, sessions, commands, failures, opinion, sources, reasons,
    status: lifecycle.terminal?.state === 'ABORTED' ? 'INTERRUPTED' : failed ? 'FAILED' : 'SUCCEEDED' };
}
