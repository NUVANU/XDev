import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { NativeSourceError, needNative, nativeInteger, nativeUuid, nativeObject, nativeWord, nativeHash,
  parseNativeJson, parseNativeEnvelope, parseNativeMetadata, nativeRelationshipEvent, selectedNativeFact,
  nativeTurnHeader, nativeTurnRefKey, validateNativeTurn, parseNativeTelemetry, type NativeTurnHeader,
  type NativeMetadata, type NativeEnvelope, type NativeRef, type NativeFact, type NativeQuery, type NativeEvent } from './d1-native-records.ts';

export type NativeLimits = { catalogEntries: number; segments: number; threads: number; edges: number;
  sessionBytes: number; totalBytes: number; records: number; lineBytes: number; facts: number; factBytes: number;
  telemetryBytes: number; telemetryRecords: number };
const MAX: Readonly<NativeLimits> = Object.freeze({ catalogEntries: 4096, segments: 8, threads: 32, edges: 4,
  sessionBytes: 128 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, records: 250000,
  lineBytes: 2 * 1024 * 1024, facts: 64, factBytes: 1024 * 1024, telemetryBytes: 65536, telemetryRecords: 32 });
export type NativeReadRequest = { threadIds: string[]; queries: NativeQuery[]; limits?: Partial<NativeLimits> };
export type NativeActorContext = { threadId: string; sessionId: string };
type Entry = { path: string; locator: string; logical: string };
type Meta = Entry & { metadata: NativeMetadata; metadataHash: string; dev: string; ino: string };
export type NativeView = { threadId: string; sessionId: string; locator: string; path: string;
  prefixBytes: number; prefixSha256: string; startOrdinal: number; endOrdinal: number;
  dev: string; ino: string; currentHead: boolean; initialCapturedAt: string; lastValidatedAt: string | null;
  telemetryTail: { fromByte: number; toByte: number; startOrdinal: number; endOrdinal: number;
    bytes: number; records: number; sha256: string; capturedAt: string; validatedAt: string } | null };
type Scan = { meta: Meta; view: NativeView; facts: NativeFact[]; events: NativeEvent[]; headers: NativeTurnHeader[] };
export type NativeSourceSnapshot = {
  kind: 'NATIVE_SOURCE_OBSERVATIONS' | 'TEST_ONLY_SOURCE_OBSERVATIONS';
  coverage: { status: 'COMPLETE' | 'INCOMPLETE'; diagnostics: string[]; views: NativeView[];
    capturedAt: string; completedAt: string; semantics: 'HISTORICAL_PREFIX_OBSERVATION_V1';
    freshness: 'NOT_LIVE_AUTHORITY'; activeTurnIdMeaning: 'OBSERVED_IN_INITIAL_PREFIX';
    activeTurnId: string | null; limitations: readonly string[] };
  facts: NativeFact[];
};
const nativeSnapshots = new WeakSet<object>();
/** A local provenance tag, never an authorization capability or malicious-process boundary. */
export function isNativeSourceSnapshot(value: unknown): value is NativeSourceSnapshot {
  return typeof value === 'object' && value !== null && nativeSnapshots.has(value);
}
const limitations = Object.freeze(['READ_ONLY_HISTORICAL_OBSERVATIONS', 'NO_EXECUTION_OR_AUTHORIZATION_DECISION',
  'NO_STRONG_OWNER_AUTHENTICATION', 'OPAQUE_MATCH_IS_NOT_PLAINTEXT_EQUIVALENCE',
  'NO_GLOBAL_QUEUE_OR_PROCESS_CLOSURE', 'COMMAND_CONTENT_REMAINS_IN_ORIGINAL_SOURCE',
  'PER_FILE_INITIAL_PREFIX_VECTOR_NOT_ATOMIC_OR_LATEST', 'CAPTURED_AT_IS_RESULT_CONSTRUCTION_TIME',
  'CURRENT_HEAD_MEANS_INITIAL_UNIQUE_TIP', 'POST_VALIDATION_WRITES_OUTSIDE_OBSERVED_THROUGH',
  'TELEMETRY_IS_NOT_COST_OR_BUDGET_EVIDENCE']);
const uuidPart = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const filename = new RegExp('^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(' + uuidPart + ')(?:_(' + uuidPart + '))?\\.jsonl$');
function exactKeys(x: object, allowed: string[]): void {
  needNative(Object.keys(x).every(k => allowed.includes(k)), 'REQUEST_FIELDS');
}
function freeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.values(v).forEach(freeze); Object.freeze(v);
  }
  return v;
}
function plainPath(path: string): void {
  for (let p = path;; p = dirname(p)) {
    needNative(!lstatSync(p).isSymbolicLink(), 'SOURCE_LINK');
    if (dirname(p) === p) break;
  }
  needNative(realpathSync.native(path) === resolve(path), 'SOURCE_ALIAS');
}
function fileStat(path: string) {
  plainPath(path); const s = lstatSync(path, { bigint: true });
  needNative(s.isFile() && s.nlink === 1n, 'SOURCE_NOT_ORDINARY'); return s;
}
function inventory(root: string, limits: NativeLimits): Map<string, Entry> {
  plainPath(root); needNative(lstatSync(root).isDirectory(), 'SOURCE_ROOT');
  const map = new Map<string, Entry>(); let entries = 0;
  const walk = (p: string, depth: number) => {
    needNative(depth <= 3, 'CATALOG_DEPTH');
    for (const d of readdirSync(p, { withFileTypes: true })) {
      needNative(++entries <= limits.catalogEntries, 'CATALOG_LIMIT');
      const f = join(p, d.name); needNative(!d.isSymbolicLink(), 'CATALOG_LINK');
      if (d.isDirectory()) {
        needNative((depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(d.name), 'CATALOG_PARTITION'); walk(f, depth + 1);
      } else {
        const m = filename.exec(d.name); if (!m) continue;
        needNative(d.isFile(), 'CATALOG_SOURCE_TYPE'); const locator = m[2] ?? m[1]!;
        needNative(!map.has(locator), 'CATALOG_DUPLICATE_LOCATOR'); map.set(locator, { path: f, locator, logical: m[1]! });
      }
    }
  };
  walk(root, 0); return map;
}
function metadata(entry: Entry, limits: NativeLimits): Meta {
  const before = fileStat(entry.path), fd = openSync(entry.path, 'r');
  try {
    const opened = fstatSync(fd, { bigint: true });
    needNative(opened.dev === before.dev && opened.ino === before.ino, 'SOURCE_REPLACED');
    let b: Buffer = Buffer.alloc(0), offset = 0;
    while (b.indexOf(10) < 0) {
      const chunk = Buffer.alloc(Math.min(65536, limits.lineBytes + 1 - offset));
      needNative(chunk.length > 0, 'LINE_LIMIT'); const n = readSync(fd, chunk, 0, chunk.length, offset);
      needNative(n > 0, 'METADATA_TORN'); b = Buffer.concat([b, chunk.subarray(0, n)]); offset += n;
    }
    const raw = b.subarray(0, b.indexOf(10)), m = parseNativeMetadata(parseNativeEnvelope(raw, limits.lineBytes));
    needNative(m.threadId === entry.logical, 'FILENAME_LOGICAL_MISMATCH');
    const after = fileStat(entry.path);
    needNative(after.dev === before.dev && after.ino === before.ino, 'SOURCE_REPLACED');
    return { ...entry, metadata: m, metadataHash: nativeHash(raw), dev: String(before.dev), ino: String(before.ino) };
  } finally { closeSync(fd); }
}
function prefixHash(meta: Meta, bytes: number): string {
  const before = fileStat(meta.path);
  needNative(String(before.dev) === meta.dev && String(before.ino) === meta.ino && before.size >= BigInt(bytes), 'SOURCE_DRIFT');
  const fd = openSync(meta.path, 'r'), h = createHash('sha256'), chunk = Buffer.alloc(65536);
  try {
    const s = fstatSync(fd, { bigint: true });
    needNative(s.dev === before.dev && s.ino === before.ino, 'SOURCE_REPLACED');
    for (let offset = 0; offset < bytes;) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, bytes - offset), offset);
      needNative(n > 0, 'SOURCE_SHORT_READ'); h.update(chunk.subarray(0, n)); offset += n;
    }
    const after = fileStat(meta.path);
    needNative(after.dev === before.dev && after.ino === before.ino && after.size >= BigInt(bytes), 'SOURCE_DRIFT');
    return h.digest('hex');
  } finally { closeSync(fd); }
}

function suffixBytes(meta: Meta, from: number, to: number): Buffer {
  const before = fileStat(meta.path);
  needNative(String(before.dev) === meta.dev && String(before.ino) === meta.ino && before.size >= BigInt(to), 'SOURCE_DRIFT');
  const fd = openSync(meta.path, 'r'), bytes = Buffer.alloc(to - from);
  try {
    const opened = fstatSync(fd, { bigint: true });
    needNative(opened.dev === before.dev && opened.ino === before.ino, 'SOURCE_REPLACED');
    for (let at = 0; at < bytes.length;) {
      const n = readSync(fd, bytes, at, bytes.length - at, from + at);
      needNative(n > 0, 'SOURCE_SHORT_READ'); at += n;
    }
    const after = fileStat(meta.path);
    needNative(after.dev === before.dev && after.ino === before.ino && after.size >= BigInt(to), 'SOURCE_DRIFT');
    return bytes;
  } finally { closeSync(fd); }
}

type TailBudget = { bytes: number; records: number; totalBytes: number;
  sessionBytes: Map<string, number>; sessionRecords: Map<string, number> };
function validateFinalView(s: Scan, headers: NativeTurnHeader[], limits: NativeLimits, budget: TailBudget,
  afterTailCapture?: (locator: string) => void): void {
  const v = s.view;
  if (!v.currentHead) {
    needNative(prefixHash(s.meta, v.prefixBytes) === v.prefixSha256, 'PREFIX_CHANGED');
    v.lastValidatedAt = new Date().toISOString(); return;
  }
  const before = fileStat(s.meta.path), fd = openSync(s.meta.path, 'r');
  // Capture B1 from an opened handle and match it to the already validated path.
  let size: bigint;
  try {
    const opened = fstatSync(fd, { bigint: true });
    needNative(opened.dev === before.dev && opened.ino === before.ino
      && String(opened.dev) === s.meta.dev && String(opened.ino) === s.meta.ino, 'SOURCE_DRIFT');
    size = opened.size;
  } finally { closeSync(fd); }
  needNative(size >= BigInt(v.prefixBytes), 'SOURCE_DRIFT');
  const deltaBig = size - BigInt(v.prefixBytes);
  needNative(deltaBig <= BigInt(limits.telemetryBytes - budget.bytes), 'TELEMETRY_BYTE_LIMIT');
  const delta = Number(deltaBig), end = v.prefixBytes + delta, capturedAt = new Date().toISOString();
  needNative(Number.isSafeInteger(end), 'RECORD_INTEGER');
  afterTailCapture?.(v.locator);
  let tail: NativeView['telemetryTail'] = null;
  if (delta > 0) {
    budget.bytes += delta; budget.totalBytes += delta;
    const sessionBytes = (budget.sessionBytes.get(v.threadId) ?? 0) + delta;
    budget.sessionBytes.set(v.threadId, sessionBytes);
    needNative(sessionBytes <= limits.sessionBytes && budget.totalBytes <= limits.totalBytes, 'BYTE_LIMIT');
    const raw = suffixBytes(s.meta, v.prefixBytes, end);
    needNative(raw.at(-1) === 10, 'TELEMETRY_TORN_SUFFIX');
    let offset = 0, next = v.endOrdinal, count = 0;
    while (offset < raw.length) {
      const eol = raw.indexOf(10, offset); needNative(eol >= 0, 'TELEMETRY_TORN_SUFFIX');
      needNative(++budget.records <= limits.telemetryRecords, 'TELEMETRY_RECORD_LIMIT');
      const sessionRecords = (budget.sessionRecords.get(v.threadId) ?? 0) + 1;
      budget.sessionRecords.set(v.threadId, sessionRecords); needNative(sessionRecords <= limits.records, 'RECORD_LIMIT');
      const record = parseNativeTelemetry(raw.subarray(offset, eol), s.meta.metadata, headers, limits.lineBytes);
      needNative(record.ordinal === next++, 'ORDINAL_GAP_DUPLICATE'); count++; offset = eol + 1;
    }
    const sha = nativeHash(raw);
    needNative(nativeHash(suffixBytes(s.meta, v.prefixBytes, end)) === sha, 'TELEMETRY_SUFFIX_CHANGED');
    tail = { fromByte: v.prefixBytes, toByte: end, startOrdinal: v.endOrdinal, endOrdinal: next,
      bytes: delta, records: count, sha256: sha, capturedAt, validatedAt: '' };
  }
  needNative(prefixHash(s.meta, v.prefixBytes) === v.prefixSha256, 'PREFIX_CHANGED');
  // A fixed B1 is checked once. A third growth is never recaptured, even telemetry.
  const final = fileStat(s.meta.path);
  needNative(String(final.dev) === s.meta.dev && String(final.ino) === s.meta.ino, 'SOURCE_DRIFT');
  needNative(final.size === BigInt(end), 'CURRENT_HEAD_CHANGED');
  v.lastValidatedAt = new Date().toISOString();
  if (tail) { tail.validatedAt = v.lastValidatedAt; v.telemetryTail = tail; }
}
function scan(meta: Meta, bytes: number, currentHead: boolean, queries: NativeQuery[], relationships: boolean, limits: NativeLimits,
  callIds: Set<string>, initialCapturedAt: string): Scan {
  const before = fileStat(meta.path);
  needNative(before.size >= BigInt(bytes) && String(before.dev) === meta.dev && String(before.ino) === meta.ino, 'SOURCE_DRIFT');
  const fd = openSync(meta.path, 'r'), chunk = Buffer.alloc(65536), digest = createHash('sha256');
  const refs: NativeRef[] = [], facts: NativeFact[] = [], events: NativeEvent[] = [], headers: NativeTurnHeader[] = [];
  let pending: Buffer = Buffer.alloc(0), offset = 0, position = 0, line = 0, next = meta.metadata.firstOrdinal;
  try {
    const opened = fstatSync(fd, { bigint: true });
    needNative(opened.dev === before.dev && opened.ino === before.ino, 'SOURCE_REPLACED');
    while (offset < bytes) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, bytes - offset), offset);
      needNative(n > 0, 'SOURCE_SHORT_READ'); const b = chunk.subarray(0, n); digest.update(b); offset += n;
      pending = Buffer.concat([pending, b]); let eol: number;
      while ((eol = pending.indexOf(10)) >= 0) {
        const raw = pending.subarray(0, eol), r = parseNativeEnvelope(raw, limits.lineBytes);
        needNative(r.ordinal === next++, 'ORDINAL_GAP_DUPLICATE'); needNative(++line <= limits.records, 'RECORD_LIMIT');
        if (line === 1) needNative(nativeHash(raw) === meta.metadataHash && r.type === 'session_meta', 'METADATA_DRIFT');
        else needNative(r.type !== 'session_meta', 'DUPLICATE_METADATA');
        const wanted = queries.filter(q => q.kind !== 'child' && q.threadId === meta.metadata.threadId && q.ordinal === r.ordinal);
        const ref: NativeRef = { threadId: meta.metadata.threadId, locator: meta.locator, path: meta.path,
          ordinal: r.ordinal, line, byteOffset: position, byteLength: eol + 1, sha256: nativeHash(raw),
          prefixBytes: bytes, prefixSha256: '', dev: meta.dev, ino: meta.ino };
        const header = nativeTurnHeader(r, ref); if (header) { headers.push(header); refs.push(ref); }
        for (const q of wanted) { facts.push(selectedNativeFact(r, ref, q)); refs.push(ref); }
        if (relationships) {
          // Large unrelated function outputs are never retained or decoded as events.
          const output = r.type === 'response_item' && r.payload.type === 'function_call_output';
          // Parent inbox reports are not task deliveries to a child. Some native
          // reports contain text only; their bodies are outside this projection.
          const parentInbox = r.type === 'response_item' && r.payload.type === 'agent_message'
            && meta.metadata.shape !== 'DIRECT_CHILD';
          if (!parentInbox && (!output || callIds.has(r.payload.call_id))) {
            const event = nativeRelationshipEvent(r, ref);
            if (event) { events.push(event); refs.push(ref); if (event.kind === 'call') callIds.add(event.data.callId); }
          }
        }
        position += eol + 1; pending = pending.subarray(eol + 1);
      }
      needNative(pending.length <= limits.lineBytes, 'LINE_LIMIT');
    }
    needNative(pending.length === 0 && line > 0, 'TORN_PREFIX'); const sha = digest.digest('hex');
    needNative(prefixHash(meta, bytes) === sha, 'PREFIX_CHANGED'); refs.forEach(r => { r.prefixSha256 = sha; });
    return { meta, facts, events, headers, view: { threadId: meta.metadata.threadId, sessionId: meta.metadata.sessionId,
      locator: meta.locator, path: meta.path, prefixBytes: bytes, prefixSha256: sha, startOrdinal: meta.metadata.firstOrdinal,
      endOrdinal: next, dev: meta.dev, ino: meta.ino, currentHead, initialCapturedAt,
      lastValidatedAt: null, telemetryTail: null } };
  } finally { closeSync(fd); }
}
const one = <T>(xs: T[], code: string): T => { needNative(xs.length === 1, code); return xs[0]!; };
function turnContext(events: NativeEvent[], headers: readonly NativeTurnHeader[], threadId: string,
  turnId: string, operationOrdinal?: number) {
  const checked = validateNativeTurn(headers, threadId, turnId, { operationOrdinal });
  const event = (h: NativeTurnHeader) => one(events.filter(e => e.kind === h.kind
    && nativeTurnRefKey(e.ref) === nativeTurnRefKey(h.ref)), 'TURN_EVENT_UNAVAILABLE');
  return { start: event(checked.start), contexts: checked.contexts.map(event),
    terminal: checked.terminal ? event(checked.terminal) : undefined };
}
function childFact(child: Scan, parent: Scan[], ownRoot: string): NativeFact {
  const m = child.meta.metadata, pm = parent.at(-1)!.meta.metadata;
  needNative(m.shape === 'DIRECT_CHILD' && pm.shape !== 'DIRECT_CHILD' && m.parentId === pm.threadId
    && m.sessionId === pm.sessionId && m.sessionId === ownRoot && pm.threadId === ownRoot, 'CHILD_ROOT_PARENT_MISMATCH');
  const pe = parent.flatMap(s => s.events), ce = child.events;
  const activities = pe.filter(e => e.kind === 'activity' && e.data.childId === m.threadId);
  needNative(activities.length > 0, 'CHILD_ACTIVITY_MISSING');
  const starts = ce.filter(e => e.kind === 'start'), messages = ce.filter(e => e.kind === 'message');
  const links: Record<string, unknown>[] = [], used = new Set<number>(); let creations = 0;
  for (const activity of activities) {
    const call = one(pe.filter(e => e.kind === 'call' && e.data.callId === activity.data.callId), 'CHILD_CALL_MISSING');
    needNative(activity.data.agentPath === m.agentPath, 'CHILD_ACTIVITY_PATH');
    const output = one(pe.filter(e => e.kind === 'output' && e.data.callId === call.data.callId), 'CHILD_OUTPUT_UNAVAILABLE');
    needNative(output.ref.threadId === call.ref.threadId && call.ref.threadId === pm.threadId
      && output.data.turnId === call.data.turnId, 'OUTPUT_CALL_THREAD_TURN_MISMATCH');
    needNative(output.ref.ordinal > call.ref.ordinal && activity.ref.ordinal > call.ref.ordinal, 'CALL_ORDER');
    if (call.data.name === 'spawn_agent') {
      creations++; needNative(activity.data.activity === 'started' && '/root/' + call.data.taskName === m.agentPath
        && call.data.role === m.role, 'CHILD_SPAWN_LINEAGE');
      const result = nativeObject(parseNativeJson(output.data.output));
      needNative(Object.keys(result).length === 1 && result.task_name === m.agentPath, 'SPAWN_RESULT');
    } else {
      needNative(call.data.name === 'followup_task' && activity.data.activity === 'interacted'
        && call.data.target === m.agentPath && output.data.output === '', 'CHILD_FOLLOWUP_SHAPE');
    }
    const ph = parent.flatMap(s => s.headers);
    const pt = turnContext(pe, ph, pm.threadId, call.data.turnId, call.ref.ordinal);
    turnContext(pe, ph, pm.threadId, output.data.turnId, output.ref.ordinal);
    needNative(pt.start.data.rootTurnId === call.data.turnId, 'PARENT_ROOT_TURN');
    const message = one(messages.filter(e => e.data.messageHash === call.data.messageHash
      && e.data.messageBytes === call.data.messageBytes && e.data.author === '/root' && e.data.recipient === m.agentPath), 'CHILD_DELIVERY_UNAVAILABLE');
    needNative(!used.has(message.ref.ordinal), 'CHILD_DELIVERY_REUSED'); used.add(message.ref.ordinal);
    const start = starts.filter(e => e.ref.ordinal < message.ref.ordinal).at(-1);
    needNative(start && start.data.rootTurnId === call.data.turnId && start.data.turnId !== call.data.turnId, 'CHILD_TURN_MISMATCH');
    const ct = turnContext(ce, child.headers, m.threadId, start.data.turnId, message.ref.ordinal);
    if (call.data.name === 'spawn_agent') needNative(start === starts[0], 'SPAWN_OLD_TURN');
    else {
      const previous = starts[starts.indexOf(start) - 1]; needNative(previous, 'FOLLOWUP_INITIAL_TURN');
      const terminal = turnContext(ce, child.headers, m.threadId, previous.data.turnId).terminal;
      needNative(terminal && terminal.ref.ordinal < start.ref.ordinal && Date.parse(terminal.timestamp) <= Date.parse(call.timestamp), 'FOLLOWUP_PRIOR_OPEN');
    }
    links.push({ callRef: call.ref, activityRef: activity.ref, outputRef: output.ref, messageRef: message.ref,
      childTurnId: start.data.turnId, rootTurnId: start.data.rootTurnId, state: ct.terminal?.data.state ?? 'OPEN',
      terminalRef: ct.terminal?.ref ?? null, model: ct.contexts.at(-1)!.data.model,
      effort: ct.contexts.at(-1)!.data.effort, requestedModel: call.data.model,
      requestedEffort: call.data.effort, opaqueHash: call.data.messageHash, opaqueBytes: call.data.messageBytes });
  }
  needNative(creations === 1 && used.size === messages.length && links.length === starts.length, 'CHILD_UNMATCHED_HISTORY');
  const ref = child.events[0]?.ref; needNative(ref, 'CHILD_EVENTS_MISSING');
  return { kind: 'child', ref, data: { childThreadId: m.threadId, rootSessionId: m.sessionId,
    immediateParentId: m.parentId, agentPath: m.agentPath, role: m.role, depth: 1, links,
    meaning: 'OBSERVED_LINEAGE_NOT_EXECUTION_RECEIPT_OR_INDEPENDENCE_VERDICT' } };
}

type TestHooks = { afterCapture?: () => void; beforeRecheck?: () => void; afterTailCapture?: (locator: string) => void };
function read(root: string, context: NativeActorContext, request: NativeReadRequest, testOnly: boolean, hooks: TestHooks = {}): NativeSourceSnapshot {
  const views: NativeView[] = []; let activeTurnId: string | null = null;
  const result = (status: 'COMPLETE' | 'INCOMPLETE', facts: NativeFact[], diagnostics: string[]): NativeSourceSnapshot => {
    const completedAt = new Date().toISOString();
    const value = freeze({ kind: testOnly ? 'TEST_ONLY_SOURCE_OBSERVATIONS' as const : 'NATIVE_SOURCE_OBSERVATIONS' as const,
      coverage: { status, diagnostics, views, capturedAt: completedAt, completedAt,
        semantics: 'HISTORICAL_PREFIX_OBSERVATION_V1' as const, freshness: 'NOT_LIVE_AUTHORITY' as const,
        activeTurnIdMeaning: 'OBSERVED_IN_INITIAL_PREFIX' as const, activeTurnId, limitations }, facts });
    if (!testOnly && status === 'COMPLETE') nativeSnapshots.add(value); return value;
  };
  try {
    nativeObject(request); exactKeys(request, ['threadIds', 'queries', 'limits']);
    nativeUuid(context.threadId); nativeUuid(context.sessionId);
    const limits: NativeLimits = { ...MAX };
    if (request.limits !== undefined) {
      nativeObject(request.limits); exactKeys(request.limits, Object.keys(MAX));
      for (const [key, value] of Object.entries(request.limits)) {
        const k = key as keyof NativeLimits; nativeInteger(value, 1); needNative(value! <= MAX[k], 'LIMIT_INCREASE'); limits[k] = value!;
      }
    }
    needNative(Array.isArray(request.threadIds) && request.threadIds.length > 0 && request.threadIds.length <= limits.threads, 'THREAD_LIMIT');
    request.threadIds.forEach(nativeUuid);
    needNative(new Set(request.threadIds).size === request.threadIds.length && request.threadIds.includes(context.threadId)
      && request.threadIds.includes(context.sessionId), 'CURRENT_CONTEXT_SCOPE');
    needNative(Array.isArray(request.queries) && request.queries.length <= limits.facts, 'FACT_LIMIT');
    for (const q of request.queries) {
      nativeObject(q); nativeUuid(q.threadId); needNative(request.threadIds.includes(q.threadId), 'QUERY_SCOPE');
      needNative(['authority', 'call', 'child', 'command'].includes(q.kind), 'QUERY_KIND');
      exactKeys(q, q.kind === 'child' ? ['threadId', 'kind'] : ['threadId', 'kind', 'ordinal']);
      if (q.kind !== 'child') nativeInteger(q.ordinal);
    }
    needNative(new Set(request.queries.map(q => `${q.threadId}:${q.kind}:${q.kind === 'child' ? '' : q.ordinal}`)).size === request.queries.length, 'DUPLICATE_QUERY');
    const catalog = inventory(root, limits), metas = new Map<string, Meta>();
    const get = (locator: string): Meta => {
      const existing = metas.get(locator); if (existing) return existing;
      const e = catalog.get(locator); needNative(e, 'HISTORY_SOURCE_MISSING');
      needNative(metas.size < limits.segments, 'SEGMENT_LIMIT'); const m = metadata(e, limits); metas.set(locator, m); return m;
    };
    type Cut = { meta: Meta; bytes: number; end?: number; current: boolean; capturedAt: string };
    const chains = new Map<string, Cut[]>();
    for (const logical of request.threadIds) {
      const local = [...catalog.values()].filter(x => x.logical === logical).map(x => get(x.locator));
      needNative(local.length > 0, 'THREAD_SOURCE_MISSING');
      const predecessors = new Set<string>();
      for (const x of local) if (x.metadata.historyBase) {
        const p = get(x.metadata.historyBase.locator);
        if (p.metadata.threadId === logical) {
          needNative(!predecessors.has(p.locator), 'HISTORY_BRANCH'); predecessors.add(p.locator);
        }
      }
      const tip = one(local.filter(x => !predecessors.has(x.locator)), 'HISTORY_TIP_AMBIGUOUS');
      const chain: Cut[] = [], visiting = new Set<string>();
      const visit = (m: Meta, bytes: number, end: number | undefined, current: boolean, depth: number, capturedAt: string) => {
        needNative(depth <= limits.edges && !visiting.has(m.locator), 'HISTORY_CYCLE_OR_DEPTH'); visiting.add(m.locator);
        const b = m.metadata.historyBase;
        if (b) {
          const p = get(b.locator); needNative(p.metadata.firstOrdinal < b.endOrdinal, 'HISTORY_INTERVAL');
          if (p.metadata.threadId === m.metadata.threadId) needNative(!m.metadata.forkedFrom
            && p.metadata.sessionId === m.metadata.sessionId && m.metadata.shape !== 'DIRECT_CHILD', 'CONTINUATION_IDENTITY');
          else needNative(m.metadata.forkedFrom === p.metadata.threadId && m.metadata.shape === 'FORK_ROOT', 'FORK_IDENTITY');
          visit(p, b.endByte, b.endOrdinal, false, depth + 1, new Date().toISOString());
        }
        chain.push({ meta: m, bytes, end, current, capturedAt });
      };
      const size = fileStat(tip.path).size; needNative(size <= BigInt(limits.sessionBytes), 'SESSION_BYTE_LIMIT');
      visit(tip, Number(size), undefined, true, 0, new Date().toISOString());
      needNative(local.every(x => chain.some(c => c.meta.locator === x.locator)), 'HISTORY_DISCONNECTED'); chains.set(logical, chain);
    }
    const ownMeta = chains.get(context.threadId)!.at(-1)!.meta.metadata;
    needNative(ownMeta.threadId === context.threadId && ownMeta.sessionId === context.sessionId, 'INJECTED_IDENTITY_MISMATCH');
    const rootMeta = chains.get(context.sessionId)!.at(-1)!.meta.metadata;
    needNative(rootMeta.threadId === rootMeta.sessionId && rootMeta.shape !== 'DIRECT_CHILD', 'ROOT_CONTEXT_MISMATCH');
    const capture = new Map<string, { meta: Meta; bytes: number; current: boolean; capturedAt: string }>();
    for (const chain of chains.values()) for (const x of chain) {
      const previous = capture.get(x.meta.locator);
      // A physical source may serve a fixed ancestor and a declared current view;
      // conflicting cuts need a separate view decoder and are not silently merged.
      needNative(!previous || previous.bytes === x.bytes, 'MULTIPLE_PREFIX_VIEWS_UNSUPPORTED');
      capture.set(x.meta.locator, { meta: x.meta, bytes: x.bytes, current: x.current || previous?.current === true,
        capturedAt: previous?.capturedAt ?? x.capturedAt });
    }
    const totals = new Map<string, number>(); let total = 0;
    for (const x of capture.values()) {
      nativeInteger(x.bytes, 1); total += x.bytes;
      const n = (totals.get(x.meta.metadata.threadId) ?? 0) + x.bytes; totals.set(x.meta.metadata.threadId, n);
      needNative(n <= limits.sessionBytes && total <= limits.totalBytes, 'BYTE_LIMIT');
    }
    hooks.afterCapture?.();
    const scans = new Map<string, Scan>(), records = new Map<string, number>(), pendingCalls = new Map<string, Set<string>>();
    for (const [locator, x] of capture) {
      const relationships = x.meta.metadata.threadId === context.sessionId || x.meta.metadata.shape === 'DIRECT_CHILD';
      const callIds = pendingCalls.get(x.meta.metadata.threadId) ?? new Set<string>(); pendingCalls.set(x.meta.metadata.threadId, callIds);
      const s = scan(x.meta, x.bytes, x.current, request.queries, relationships, limits, callIds, x.capturedAt); scans.set(locator, s); views.push(s.view);
      const n = (records.get(s.view.threadId) ?? 0) + s.view.endOrdinal - s.view.startOrdinal;
      needNative(n <= limits.records, 'RECORD_LIMIT'); records.set(s.view.threadId, n);
    }
    for (const chain of chains.values()) for (let i = 0; i < chain.length; i++) {
      const c = chain[i]!, s = scans.get(c.meta.locator)!;
      needNative(c.end === undefined || s.view.endOrdinal === c.end, 'HISTORY_CUTOFF_ORDINAL');
      if (i) needNative(scans.get(chain[i - 1]!.meta.locator)!.view.endOrdinal === s.view.startOrdinal, 'HISTORY_CHAIN_GAP');
    }
    const ownEvents = chains.get(context.threadId)!.filter(x => x.meta.metadata.threadId === context.threadId).flatMap(x => scans.get(x.meta.locator)!.events);
    const open = ownEvents.filter(e => e.kind === 'start' && !ownEvents.some(t => t.kind === 'terminal' && t.data.turnId === e.data.turnId));
    activeTurnId = one(open, 'CURRENT_TURN_UNAVAILABLE').data.turnId;
    const ownHeaders = chains.get(context.threadId)!.filter(x => x.meta.metadata.threadId === context.threadId)
      .flatMap(x => scans.get(x.meta.locator)!.headers);
    turnContext(ownEvents, ownHeaders, context.threadId, activeTurnId!);
    const facts = [...scans.values()].flatMap(s => s.facts);
    for (const logical of request.threadIds) {
      const c = chains.get(logical)!.at(-1)!, s = scans.get(c.meta.locator)!;
      if (s.meta.metadata.shape === 'DIRECT_CHILD') {
        const p = chains.get(s.meta.metadata.parentId!); needNative(p, 'CHILD_PARENT_SCOPE');
        const fact = childFact(s, p.filter(x => x.meta.metadata.threadId === s.meta.metadata.parentId).map(x => scans.get(x.meta.locator)!), context.sessionId);
        if (request.queries.some(q => q.kind === 'child' && q.threadId === logical)) facts.push(fact);
      }
    }
    needNative(facts.length === request.queries.length, 'QUERY_SOURCE_UNAVAILABLE');
    needNative(Buffer.byteLength(JSON.stringify(facts)) <= limits.factBytes, 'FACT_BYTE_LIMIT');
    hooks.beforeRecheck?.();
    const again = inventory(root, limits), logicalSet = new Set([...metas.values()].map(x => x.metadata.threadId));
    const relevant = (xs: Map<string, Entry>) => JSON.stringify([...xs.values()].filter(x => logicalSet.has(x.logical)).map(x => [x.locator, x.path]).sort());
    needNative(relevant(catalog) === relevant(again), 'CATALOG_CHANGED');
    const headers = [...scans.values()].flatMap(s => s.headers);
    const tailBudget: TailBudget = { bytes: 0, records: 0, totalBytes: total,
      sessionBytes: new Map(totals), sessionRecords: new Map(records) };
    for (const s of scans.values()) validateFinalView(s, headers, limits, tailBudget, hooks.afterTailCapture);
    needNative(relevant(catalog) === relevant(inventory(root, limits)), 'CATALOG_CHANGED');
    return result('COMPLETE', facts, []);
  } catch (error) {
    return result('INCOMPLETE', [], [error instanceof NativeSourceError
      ? error.detail ? `${error.code}:${error.detail}` : error.code : 'NATIVE_SOURCE_IO_UNAVAILABLE']);
  }
}

/** Reads only the current Host's existing native files. No path/identity override and no callbacks. */
export function readNativeSources(request: NativeReadRequest): NativeSourceSnapshot {
  return read(join(process.env.CODEX_HOME ?? '', 'sessions'), {
    threadId: process.env.CODEX_THREAD_ID ?? '', sessionId: process.env.CODEX_SESSION_ID ?? '' }, request, false);
}
/** Explicit synthetic-source entry: never creates a native brand, regardless of file contents. */
export function readTestOnlyNativeSources(root: string, context: NativeActorContext, request: NativeReadRequest,
  hooks: TestHooks = {}): NativeSourceSnapshot { return read(resolve(root), context, request, true, hooks); }
