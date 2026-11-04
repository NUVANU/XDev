import { createHash } from 'node:crypto';

/** Parsing is not authentication. These codecs grant no execution permission. */
export class NativeSourceError extends Error {
  readonly code: string;
  readonly detail: string | null;
  constructor(code: string, detail: string | null = null) { super(code); this.code = code; this.detail = detail; }
}
export function needNative(value: unknown, code: string): asserts value {
  if (!value) throw new NativeSourceError(code);
}
export type NativeObject = Record<string, any>;
export function nativeObject(value: unknown): NativeObject {
  needNative(value !== null && typeof value === 'object' && !Array.isArray(value), 'RECORD_OBJECT');
  return value as NativeObject;
}
export const NATIVE_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export function nativeUuid(value: unknown): string {
  needNative(typeof value === 'string' && NATIVE_UUID.test(value), 'IDENTITY_UUID'); return value;
}
export function nativeWord(value: unknown, limit = 8192): string {
  needNative(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= limit, 'RECORD_TEXT');
  return value;
}
export function nativeInteger(value: unknown, minimum = 0): number {
  needNative(Number.isSafeInteger(value) && (value as number) >= minimum, 'RECORD_INTEGER'); return value as number;
}
export const nativeHash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

/** Reject duplicate keys before any field is used; JSON.parse alone loses them. */
export function parseNativeJson(text: string): unknown {
  try {
    const result: unknown = JSON.parse(text);
    const stack: Array<{ object: boolean; key: boolean; keys: Set<string> }> = [];
    for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],]/g)) {
      const t = token[0], p = stack.at(-1);
      if (t === '{' || t === '[') {
        stack.push({ object: t === '{', key: t === '{', keys: new Set() });
        needNative(stack.length <= 128, 'JSON_DEPTH');
      } else if (t === '}' || t === ']') stack.pop();
      else if (t === ',') { if (p?.object) p.key = true; }
      else if (p?.object && p.key) {
        const k = JSON.parse(t) as string; needNative(!p.keys.has(k), 'JSON_DUPLICATE_KEY');
        p.keys.add(k); p.key = false;
      }
    }
    return result;
  } catch (error) {
    if (error instanceof NativeSourceError) throw error;
    // Never return SyntaxError snippets containing private source text.
    throw new NativeSourceError('JSON_INVALID');
  }
}

export type NativeEnvelope = { ordinal: number; timestamp: string; type: string; payload: NativeObject };
const outerTypes = new Set(['session_meta', 'event_msg', 'response_item', 'world_state', 'turn_context',
  'token_usage_record', 'compacted', 'inter_agent_communication_metadata']);
export function parseNativeEnvelope(bytes: Uint8Array, maxLineBytes = 2 * 1024 * 1024): NativeEnvelope {
  needNative(bytes.byteLength > 0 && bytes.byteLength <= maxLineBytes, 'LINE_LIMIT');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new NativeSourceError('UTF8_INVALID'); }
  const r = nativeObject(parseNativeJson(text));
  needNative(Object.keys(r).every(k => ['ordinal', 'timestamp', 'type', 'payload', 'metadata'].includes(k)), 'ENVELOPE_KEYS');
  nativeInteger(r.ordinal);
  needNative(typeof r.timestamp === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(r.timestamp)
    && Number.isFinite(Date.parse(r.timestamp)), 'ENVELOPE_TIME');
  needNative(outerTypes.has(r.type), 'ENVELOPE_TYPE');
  nativeObject(r.payload); if (r.metadata !== undefined) nativeObject(r.metadata);
  return { ordinal: r.ordinal, timestamp: r.timestamp, type: r.type, payload: r.payload };
}

export type NativeMetadata = {
  threadId: string; sessionId: string; version: string; firstOrdinal: number;
  shape: 'ROOT' | 'FORK_ROOT' | 'DIRECT_CHILD';
  historyBase: { locator: string; endOrdinal: number; endByte: number } | null;
  forkedFrom: string | null; parentId: string | null; agentPath: string | null; role: string | null;
};
const versions = new Set(['0.154.0-alpha.6.2', '0.155.0-alpha.9.2', '0.155.0-alpha.16', '0.158.0-alpha.2.1']);
export function parseNativeMetadata(r: NativeEnvelope): NativeMetadata {
  needNative(r.type === 'session_meta', 'METADATA_REQUIRED'); const m = r.payload;
  const threadId = nativeUuid(m.id), sessionId = nativeUuid(m.session_id);
  needNative(versions.has(m.cli_version) && m.history_mode === 'paginated', 'METADATA_SCHEMA');
  let historyBase: NativeMetadata['historyBase'] = null;
  if (m.history_base !== undefined) {
    const b = nativeObject(m.history_base);
    needNative(Object.keys(b).sort().join(',') === 'end_byte_offset,end_ordinal_exclusive,thread_id', 'HISTORY_FIELDS');
    historyBase = { locator: nativeUuid(b.thread_id), endOrdinal: nativeInteger(b.end_ordinal_exclusive),
      endByte: nativeInteger(b.end_byte_offset, 1) };
    needNative(historyBase.endOrdinal === r.ordinal, 'HISTORY_START');
  } else needNative(r.ordinal === 0, 'HISTORY_MISSING');
  const forkedFrom = m.forked_from_id === undefined ? null : nativeUuid(m.forked_from_id);
  let shape: NativeMetadata['shape'], parentId: string | null = null, agentPath: string | null = null, role: string | null = null;
  if (m.thread_source === 'subagent') {
    const spawn = nativeObject(nativeObject(nativeObject(m.source).subagent).thread_spawn);
    parentId = nativeUuid(spawn.parent_thread_id);
    needNative(spawn.depth === 1 && m.parent_thread_id === parentId && threadId !== sessionId,
      'CHILD_LINEAGE');
    agentPath = nativeWord(spawn.agent_path, 256); role = nativeWord(spawn.agent_role, 64);
    needNative(/^\/root\/[a-z0-9_]+$/.test(agentPath) && m.agent_path === agentPath && m.agent_role === role,
      'CHILD_PATH_ROLE');
    needNative(['reviewer', 'verifier', 'worker', 'architect', 'explorer', 'default'].includes(role), 'CHILD_ROLE');
    needNative(!historyBase && !forkedFrom && m.cli_version === '0.158.0-alpha.2.1', 'CHILD_HISTORY_UNSUPPORTED');
    shape = 'DIRECT_CHILD';
  } else {
    needNative(['user', 'agent_forked_thread'].includes(m.thread_source) && threadId === sessionId
      && typeof m.source === 'string' && m.parent_thread_id === undefined, 'ROOT_IDENTITY');
    needNative(m.agent_path === undefined && m.agent_role === undefined, 'ROOT_LINEAGE');
    needNative(!forkedFrom || historyBase !== null, 'FORK_HISTORY');
    shape = forkedFrom ? 'FORK_ROOT' : 'ROOT';
  }
  return { threadId, sessionId, version: m.cli_version, firstOrdinal: r.ordinal, shape, historyBase,
    forkedFrom, parentId, agentPath, role };
}

export type NativeRef = {
  threadId: string; locator: string; path: string; ordinal: number; line: number;
  byteOffset: number; byteLength: number; sha256: string;
  prefixBytes: number; prefixSha256: string; dev: string; ino: string;
};
export type NativeFact = { kind: 'authority' | 'call' | 'command' | 'child'; ref: NativeRef; data: Readonly<Record<string, unknown>> };
export type NativeQuery = { threadId: string; kind: 'authority' | 'call' | 'command'; ordinal: number }
  | { threadId: string; kind: 'child' };
export type NativeEvent = { kind: string; ref: NativeRef; timestamp: string; data: NativeObject };
function turnFields(p: NativeObject): { turnId: string; rootTurnId: string } {
  return { turnId: nativeUuid(p.turn_id), rootTurnId: nativeUuid(p.root_turn_id) };
}
export function nativeErrorFlag(result: NativeObject): 'ABSENT' | 'FALSE' | 'TRUE' {
  if (!Object.hasOwn(result, 'isError')) return 'ABSENT';
  needNative(typeof result.isError === 'boolean', 'MCP_ERROR_FLAG'); return result.isError ? 'TRUE' : 'FALSE';
}

/** B0 headers retain original ownership and refs, including contradictory matching heads. */
export type NativeTurnHeader = { threadId: string; ordinal: number; ref: NativeRef;
  kind: 'start' | 'context' | 'terminal' | 'unsupported'; turnId: string; rootTurnId: unknown;
  state: 'COMPLETED' | 'ABORTED' | null; unsupportedReason?: 'WRONG_OUTER_LIFECYCLE' | 'MALFORMED_KNOWN_ITEM' };

// Only complete, observed item wrappers are ordinary observations. The item body
// is inspected at its native structural position; text/content is never scanned.
function ordinaryCompletedItem(p: NativeObject): 'complete' | 'malformed' | 'unknown' {
  if (p.item === null || typeof p.item !== 'object' || Array.isArray(p.item)) return 'malformed';
  const it = p.item as NativeObject;
  const word = (v: unknown, limit = 8192) => typeof v === 'string' && v.length > 0
    && Buffer.byteLength(v) <= limit;
  const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string');
  const object = (v: unknown): v is NativeObject => v !== null && typeof v === 'object' && !Array.isArray(v);
  const known = new Set(['AgentMessage', 'CollabAgentToolCall', 'CommandExecution', 'ContextCompaction',
    'Extension', 'FileChange', 'FunctionCallOutput', 'McpToolCall', 'Reasoning', 'SubAgentActivity', 'UserMessage']);
  if (!known.has(it.type)) return 'unknown';
  if (!word(it.id, 256)) return 'malformed';
  let complete = false;
  switch (it.type) {
    case 'AgentMessage': complete = Array.isArray(it.content) && word(it.phase, 64); break;
    case 'UserMessage': {
      complete = Array.isArray(it.content) && it.content.every((x: unknown) =>
        object(x) && x.type === 'text' && word(x.text, 65536))
        && Buffer.byteLength(it.content.map((x: NativeObject) => x.text).join('')) <= 65536;
      break;
    }
    case 'CollabAgentToolCall': complete = Object.hasOwn(it, 'tool') && word(it.status, 64)
      && Object.hasOwn(it, 'agents_states') && Object.hasOwn(it, 'receiver_agents')
      && Object.hasOwn(it, 'receiver_thread_ids') && Object.hasOwn(it, 'sender_thread_id'); break;
    case 'CommandExecution': complete = strings(it.command)
      && ['completed', 'failed', 'inProgress'].includes(it.status)
      && (it.exit_code === null || Number.isSafeInteger(it.exit_code))
      && typeof it.stdout === 'string' && typeof it.stderr === 'string'; break;
    case 'ContextCompaction': complete = true; break;
    case 'Extension': complete = word(it.kind, 64) && (
      Object.hasOwn(it, 'durationMs') ||
      Object.hasOwn(it, 'action') && Object.hasOwn(it, 'query') && Object.hasOwn(it, 'results')); break;
    case 'FileChange': {
      const changes = it.changes;
      const entries = object(changes) ? Object.entries(changes) : [];
      const observedMap = entries.length > 0 && entries.every(([file, change]) => {
        if (!word(file) || !object(change)) return false;
        const keys = Object.keys(change);
        if (change.type === 'add' || change.type === 'delete') {
          return keys.length === 2 && keys.every(k => ['type', 'content'].includes(k))
            && typeof change.content === 'string';
        }
        return change.type === 'update' && keys.length === 3
          && keys.every(k => ['type', 'unified_diff', 'move_path'].includes(k))
          && typeof change.unified_diff === 'string' && change.move_path === null;
      });
      complete = (Array.isArray(changes) || observedMap) && word(it.status, 64)
        && typeof it.stdout === 'string' && typeof it.stderr === 'string';
      break;
    }
    case 'FunctionCallOutput': complete = word(it.name) && word(it.namespace) && Object.hasOwn(it, 'output'); break;
    case 'McpToolCall': {
      const args = it.arguments, result = it.result;
      complete = word(it.server) && word(it.tool) && word(it.status, 64)
        && object(args) && (object(result) || Object.hasOwn(it, 'error') && it.error !== null);
      if (complete && it.server === 'codex_app' && ['send_message_to_thread', 'fork_thread'].includes(it.tool)) {
        complete = object(result) && (!Object.hasOwn(result, 'isError') || typeof result.isError === 'boolean')
          && typeof args.threadId === 'string' && NATIVE_UUID.test(args.threadId)
          && (it.tool === 'send_message_to_thread' ? word(args.prompt, 65536)
            : object(args.environment) && word(args.environment.type, 64));
      }
      break;
    }
    case 'Reasoning': complete = Array.isArray(it.summary_text) && Array.isArray(it.raw_content); break;
    case 'SubAgentActivity': complete = word(it.kind, 64) && typeof it.agent_thread_id === 'string'
      && NATIVE_UUID.test(it.agent_thread_id) && word(it.agent_path, 256); break;
  }
  if (p.thread_id !== undefined && p.thread_id !== null && typeof p.thread_id !== 'string') complete = false;
  if (p.started_at_ms !== undefined && !Number.isSafeInteger(p.started_at_ms)) complete = false;
  if (p.completed_at_ms !== undefined && !Number.isSafeInteger(p.completed_at_ms)) complete = false;
  return complete ? 'complete' : 'malformed';
}
export function nativeTurnHeader(r: NativeEnvelope, ref: NativeRef): NativeTurnHeader | null {
  const p = r.payload;
  const lifecycle = ['task_started', 'turn_context', 'task_complete', 'turn_aborted'].includes(p.type);
  let unsupportedReason: NativeTurnHeader['unsupportedReason'];
  let kind: NativeTurnHeader['kind'] | null;
  if (r.type === 'turn_context') kind = 'context';
  else if (r.type === 'event_msg' && p.type === 'task_started') kind = 'start';
  else if (r.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_aborted')) kind = 'terminal';
  else if (lifecycle && Object.hasOwn(p, 'turn_id')) {
    kind = 'unsupported'; unsupportedReason = 'WRONG_OUTER_LIFECYCLE';
  } else if (r.type === 'event_msg' && p.type === 'item_completed') {
    const item = ordinaryCompletedItem(p);
    kind = item === 'malformed' && Object.hasOwn(p, 'turn_id') ? 'unsupported' : null;
    if (kind) unsupportedReason = 'MALFORMED_KNOWN_ITEM';
  } else kind = r.type === 'event_msg' && Object.hasOwn(p, 'turn_id') ? 'unsupported' : null;
  if (!kind) return null;
  const turnId = nativeUuid(p.turn_id);
  return { threadId: ref.threadId, ordinal: r.ordinal, ref, kind, turnId,
    rootTurnId: kind === 'start' || kind === 'context' ? p.root_turn_id : null,
    state: kind !== 'terminal' ? null : p.type === 'task_complete' ? 'COMPLETED' : 'ABORTED',
    ...(unsupportedReason ? { unsupportedReason } : {}) };
}

/** Exact original-record identity, never a content-hash deduplication key. */
export function nativeTurnRefKey(ref: NativeRef): string {
  return JSON.stringify([ref.threadId, ref.locator, ref.path, ref.dev, ref.ino, ref.ordinal,
    ref.line, ref.byteOffset, ref.byteLength, ref.sha256, ref.prefixBytes, ref.prefixSha256]);
}

/** One filesystem-free lifecycle rule for consumed (original logical thread, turn) keys. */
export function validateNativeTurn(headers: readonly NativeTurnHeader[], threadId: string, turnId: string,
  options: { rootTurnId?: string; operationOrdinal?: number } = {}) {
  nativeUuid(threadId); nativeUuid(turnId);
  const unique = new Map<string, NativeTurnHeader>();
  for (const h of headers) {
    if (h.threadId !== threadId || h.turnId !== turnId) continue;
    needNative(h.ref.threadId === threadId && h.ref.ordinal === h.ordinal, 'TURN_SOURCE_MISMATCH');
    const key = nativeTurnRefKey(h.ref), old = unique.get(key);
    needNative(!old || old.kind === h.kind && old.turnId === h.turnId
      && old.rootTurnId === h.rootTurnId && old.state === h.state, 'TURN_SOURCE_CONFLICT');
    unique.set(key, h);
  }
  const same = [...unique.values()];
  const unsupported = same.find(h => h.kind === 'unsupported');
  if (unsupported) {
    const detail = unsupported.unsupportedReason
      ? `${unsupported.unsupportedReason}@${unsupported.ref.threadId}:${unsupported.ref.locator}:${unsupported.ref.ordinal}:${unsupported.ref.sha256}`
      : null;
    throw new NativeSourceError('TURN_HEAD_UNSUPPORTED', detail);
  }
  const starts = same.filter(h => h.kind === 'start');
  needNative(starts.length === 1, 'TURN_START_UNAVAILABLE'); const start = starts[0]!;
  const rootTurnId = nativeUuid(start.rootTurnId);
  needNative(options.rootTurnId === undefined || rootTurnId === options.rootTurnId, 'TURN_CONTEXT_MISMATCH');
  const contexts = same.filter(h => h.kind === 'context').sort((a, b) => a.ordinal - b.ordinal);
  needNative(contexts.length > 0 && contexts.every(h => h.rootTurnId === rootTurnId), 'TURN_CONTEXT_MISMATCH');
  const terminals = same.filter(h => h.kind === 'terminal');
  needNative(terminals.length <= 1 && terminals.every(h => h.ordinal > start.ordinal
    && (h.state === 'COMPLETED' || h.state === 'ABORTED')), 'TURN_TERMINAL_MISMATCH');
  const terminal = terminals[0];
  needNative(contexts.every(h => h.ordinal > start.ordinal && (!terminal || h.ordinal < terminal.ordinal)), 'TURN_CONTEXT_ORDER');
  if (options.operationOrdinal !== undefined) {
    const at = nativeInteger(options.operationOrdinal);
    needNative(start.ordinal < at && contexts.some(h => h.ordinal < at)
      && (!terminal || at < terminal.ordinal), 'CALL_OUTSIDE_TURN');
  }
  return { start, contexts, terminal };
}

/** Classify one observed accounting record. No values are exposed as cost/budget facts. */
export function parseNativeTelemetry(bytes: Uint8Array, metadata: NativeMetadata,
  headers: readonly NativeTurnHeader[], maxLineBytes: number): NativeEnvelope {
  needNative(metadata.version === '0.158.0-alpha.2.1', 'TELEMETRY_VERSION_UNSUPPORTED');
  const r = parseNativeEnvelope(bytes, maxLineBytes);
  // The normal envelope permits optional metadata; this narrow exception does not.
  const outer = nativeObject(parseNativeJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const keys = (v: object, expected: string[], code: string) =>
    needNative(Object.keys(v).sort().join(',') === [...expected].sort().join(','), code);
  keys(outer, ['timestamp', 'ordinal', 'type', 'payload'], 'TELEMETRY_OUTER_KEYS');
  needNative(r.type === 'token_usage_record', 'TELEMETRY_TYPE_UNSUPPORTED');
  const p = r.payload;
  keys(p, ['thread_id', 'turn_id', 'session_id', 'root_turn_id', 'response_id', 'usage', 'turn_token_usage', 'thread_token_usage'], 'TELEMETRY_PAYLOAD_KEYS');
  needNative(nativeUuid(p.thread_id) === metadata.threadId && nativeUuid(p.session_id) === metadata.sessionId,
    'TELEMETRY_SOURCE_IDENTITY');
  const turn = nativeUuid(p.turn_id), rootTurn = nativeUuid(p.root_turn_id);
  try { validateNativeTurn(headers, metadata.threadId, turn, { rootTurnId: rootTurn }); }
  catch (error) {
    if (error instanceof NativeSourceError) throw new NativeSourceError('TELEMETRY_TURN_UNAVAILABLE',
      error.detail ? `${error.code}:${error.detail}` : null);
    throw error;
  }
  needNative(typeof p.response_id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(p.response_id), 'TELEMETRY_RESPONSE_ID');
  const counters = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
  for (const field of ['usage', 'turn_token_usage', 'thread_token_usage']) {
    const value = nativeObject(p[field]); keys(value, counters, 'TELEMETRY_USAGE_KEYS');
    Object.values(value).forEach(v => nativeInteger(v));
  }
  return r;
}

/** Internal relationship observations only: unrelated message bodies never survive this projection. */
export function nativeRelationshipEvent(r: NativeEnvelope, ref: NativeRef): NativeEvent | null {
  const p = r.payload, event = (kind: string, data: NativeObject): NativeEvent => ({ kind, data, ref, timestamp: r.timestamp });
  if (r.type === 'turn_context') return event('context', { ...turnFields(p), model: nativeWord(p.model, 128), effort: p.effort ?? null });
  if (r.type === 'event_msg') {
    if (p.type === 'task_started') return event('start', turnFields(p));
    if (p.type === 'task_complete' || p.type === 'turn_aborted') return event('terminal', {
      turnId: nativeUuid(p.turn_id), state: p.type === 'task_complete' ? 'COMPLETED' : 'ABORTED' });
    if (p.type === 'item_completed' && p.item?.type === 'SubAgentActivity') {
      const it = nativeObject(p.item);
      if (!['started', 'interacted'].includes(it.kind)) return null;
      return event('activity', { callId: nativeWord(it.id, 256),
        childId: nativeUuid(it.agent_thread_id), agentPath: nativeWord(it.agent_path, 256), activity: nativeWord(it.kind, 64) });
    }
  }
  if (r.type !== 'response_item') return null;
  if (p.type === 'function_call' && p.namespace === 'collaboration' && ['spawn_agent', 'followup_task', 'send_message', 'interrupt_agent'].includes(p.name)) {
    const args = nativeObject(parseNativeJson(nativeWord(p.arguments, 2 * 1024 * 1024)));
    const data: NativeObject = { callId: nativeWord(p.call_id, 256), name: p.name,
      turnId: nativeUuid(nativeObject(p.internal_chat_message_metadata_passthrough).turn_id),
      target: args.target ?? null, taskName: args.task_name ?? null, role: args.agent_type ?? 'default',
      model: args.model ?? null, effort: args.reasoning_effort ?? null };
    if (args.message !== undefined) { const message = nativeWord(args.message, 2 * 1024 * 1024);
      data.messageHash = nativeHash(message); data.messageBytes = Buffer.byteLength(message); }
    return event('call', data);
  }
  if (p.type === 'function_call_output') {
    const output = typeof p.output === 'string' ? p.output : null;
    if (output === null) return null;
    // Read the result's own native turn; never inherit it from a matching call.
    const turnId = nativeUuid(nativeObject(p.internal_chat_message_metadata_passthrough).turn_id);
    return event('output', { callId: nativeWord(p.call_id, 256), turnId, outputHash: nativeHash(output),
      outputBytes: Buffer.byteLength(output), output });
  }
  if (p.type === 'agent_message') {
    needNative(Array.isArray(p.content), 'MESSAGE_SHAPE');
    const opaque = p.content.filter((x: unknown) => nativeObject(x).type === 'encrypted_content');
    needNative(opaque.length === 1, 'MESSAGE_OPAQUE_UNAVAILABLE'); const bytes = nativeWord(opaque[0].encrypted_content, 2 * 1024 * 1024);
    return event('message', { author: nativeWord(p.author, 256), recipient: nativeWord(p.recipient, 256),
      messageHash: nativeHash(bytes), messageBytes: Buffer.byteLength(bytes) });
  }
  return null;
}

export function selectedNativeFact(r: NativeEnvelope, ref: NativeRef, query: NativeQuery): NativeFact {
  needNative(query.kind !== 'child', 'QUERY_KIND'); const p = r.payload;
  if (query.kind === 'call') {
    const event = nativeRelationshipEvent(r, ref);
    needNative(event?.kind === 'call', 'QUERY_CALL_SHAPE');
    return { kind: 'call', ref, data: event.data };
  }
  needNative(r.type === 'event_msg' && p.type === 'item_completed', 'QUERY_OUTER_EVENT');
  const it = nativeObject(p.item);
  if (query.kind === 'command') {
    needNative(it.type === 'CommandExecution' && Array.isArray(it.command) && it.command.every((x: unknown) => typeof x === 'string'), 'QUERY_COMMAND_SHAPE');
    needNative(typeof it.stdout === 'string' && typeof it.stderr === 'string', 'COMMAND_OUTPUT_UNAVAILABLE');
    needNative(['completed', 'failed', 'inProgress'].includes(it.status), 'COMMAND_STATUS');
    needNative(it.exit_code === null || Number.isSafeInteger(it.exit_code), 'COMMAND_EXIT');
    return { kind: 'command', ref, data: { itemId: nativeWord(it.id, 256), processId: it.process_id ?? null,
      processIdMeaning: 'OPAQUE_HOST_ID_NOT_OS_PID', status: it.status, exitCode: it.exit_code,
      commandSha256: nativeHash(JSON.stringify(it.command)), argumentCount: it.command.length,
      stdoutSha256: nativeHash(it.stdout), stdoutBytes: Buffer.byteLength(it.stdout),
      stderrSha256: nativeHash(it.stderr), stderrBytes: Buffer.byteLength(it.stderr),
      outputDisclosure: 'HASH_AND_LENGTH_ONLY_NO_RECURSIVE_EVENT_DECODING' } };
  }
  if (it.type === 'UserMessage') {
    needNative(Array.isArray(it.content) && it.content.every((x: unknown) => nativeObject(x).type === 'text'), 'AUTHORITY_MESSAGE_SHAPE');
    const text = it.content.map((x: NativeObject) => nativeWord(x.text, 65536)).join('');
    needNative(Buffer.byteLength(text) <= 65536, 'FACT_SIZE');
    return { kind: 'authority', ref, data: { sourceType: 'UserMessage', itemId: nativeWord(it.id, 256), text,
      meaning: 'ORIGINAL_MESSAGE_NOT_AUTHORIZATION_DECISION' } };
  }
  needNative(it.type === 'McpToolCall' && it.server === 'codex_app'
    && ['send_message_to_thread', 'fork_thread'].includes(it.tool), 'AUTHORITY_TOOL_SHAPE');
  const args = nativeObject(it.arguments), result = nativeObject(it.result);
  const data: NativeObject = { sourceType: 'McpToolCall', itemId: nativeWord(it.id, 256), server: it.server,
    tool: it.tool, status: nativeWord(it.status, 64), isError: nativeErrorFlag(result),
    targetThreadId: nativeUuid(args.threadId), resultSha256: nativeHash(JSON.stringify(result)),
    meaning: 'ORIGINAL_TOOL_OBSERVATION_NOT_EXECUTION_GRANT' };
  if (it.tool === 'send_message_to_thread') data.prompt = nativeWord(args.prompt, 65536);
  if (it.tool === 'fork_thread') {
    const environment = nativeObject(args.environment); data.environmentType = nativeWord(environment.type, 64);
  }
  return { kind: 'authority', ref, data };
}
