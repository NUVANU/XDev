import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson, resolveWorktreeIdentity, validateEvidenceSnapshot, validateFailureFingerprint } from "./governance-contracts.ts";
import { validatePlanningArtifact } from "./validate.ts";
import type { EvidenceSnapshot, FailureFingerprint, RetryHistoryAuthority, RetrySourceEventRef, TrustedProjectContext } from "./types.ts";

const authorityPath = ".xdev/retry-history.json";
const snapshotPath = ".xdev/evidence/retry-history-authority-snapshot.json";
const statePath = ".xdev/project-state.json";
const ledgerPath = ".xdev/task-ledger.jsonl";
const legacyPath = ".xdev/diagnostics/M2-T002-STAGE-A-LEGACY-PROJECTION-002.json";
// Bounded bootstrap exception, not a generic missing-field migration adapter.
// SHA-256 of canonical LEGACY-PROJECTION-002.worker_runs pins all four charge
// rows AND their supplemental event/payload hashes and chronology constraints.
const legacyPinsDigest = "f3b016b642a45e609f77d923239e84679b97eb7e328fa77538b874066563a398";
const workerTypes = new Set(["run_started", "run_completed", "task_worker_implemented", "mechanism_slice_worker_implemented", "run_interrupted", "run_cancelled", "run_crashed", "run_unreachable"]);
type JsonObject = Record<string, any>;
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown) => sha(canonicalJson(value as Parameters<typeof canonicalJson>[0]));
const equal = (a: unknown, b: unknown) => canonicalJson(a as Parameters<typeof canonicalJson>[0]) === canonicalJson(b as Parameters<typeof canonicalJson>[0]);
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a,"utf8"),Buffer.from(b,"utf8"));
const record = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

class AuthorityFailure extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = `RETRY_AUTHORITY_${code}`; }
}
function requireFact(condition: unknown, code: string): asserts condition { if (!condition) throw new AuthorityFailure(code); }

/** JSON.parse alone silently overwrites duplicate object keys. Reject that loss
 * before using parsed trust material, including escaped spellings of one key. */
export function parseUniqueJson(text: string): unknown {
  const value:unknown=JSON.parse(text);
  const stack:Array<{object:boolean;key:boolean;keys:Set<string>}>=[];
  for(const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],]/g)){
    const t=token[0],parent=stack.at(-1);
    if(t==="{"||t==="[")stack.push({object:t==="{",key:t==="{",keys:new Set()});
    else if(t==="}"||t==="]")stack.pop();
    else if(t===","){if(parent?.object)parent.key=true;}
    else if(parent?.object&&parent.key){const key=JSON.parse(t) as string;requireFact(!parent.keys.has(key),"SCHEMA_INVALID");parent.keys.add(key);parent.key=false;}
  }
  return value;
}

function canonicalAuthority(value: RetryHistoryAuthority): unknown {
  const { authority_id: _id, authority_digest: _hash, ...core } = structuredClone(value);
  core.lineages.sort((a,b)=>compare(a.root_task_id,b.root_task_id));
  for (const l of core.lineages) {
    l.nodes.sort((a,b)=>compare(a.task_id,b.task_id));
    l.edges.sort((a,b)=>compare([a.parent_task_id,a.child_task_id,a.relation,a.source_event_id].join("\0"),[b.parent_task_id,b.child_task_id,b.relation,b.source_event_id].join("\0")));
  }
  core.fingerprints.sort((a,b)=>compare(a.fingerprint_id,b.fingerprint_id));
  core.runs.sort((a,b)=>compare(a.run_id,b.run_id));
  for (const r of core.runs) r.source_event_refs.sort((a,b)=>a.ledger_line-b.ledger_line||compare(a.event_id,b.event_id));
  core.derived_counts.sort((a,b)=>compare([a.lineage_root_task_id,a.failure_fingerprint_id??""].join("\0"),[b.lineage_root_task_id,b.failure_fingerprint_id??""].join("\0")));
  return core;
}


/** Privileged Host dependency. Never populated from a validation JSON object. */
export type HostClockDependencies = Readonly<{ clock?: () => string }>;
/** @internal Instances are issued by captureHostObservation and checked at runtime. */
export type HostObservation = Readonly<{ iso: string; epochMs: number }>;
export type HostClockFailure = { ok: false; code: "HOST_CLOCK_UNAVAILABLE" | "HOST_CLOCK_INVALID" };
export type HostClockResult = { ok: true; time: HostObservation } | HostClockFailure;
const hostObservations = new WeakSet<object>();

/** Strict calendar parsing, including RFC3339 offsets. Date.parse alone normalizes
 * invalid dates (e.g. February 30). Observation precision is milliseconds; source
 * fractions are preserved in original bytes, not used as a sub-ms ordering claim. */
export function parseRfc3339Timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const fraction = (m[7] ?? "").padEnd(3, "0").slice(0, 3);
  const local = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${fraction}Z`);
  const d = new Date(local);
  if (!Number.isFinite(local) || d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) return null;
  const oh = Number(m[10] ?? 0), om = Number(m[11] ?? 0);
  if (oh > 23 || om > 59) return null;
  const offset = (oh * 60 + om) * 60_000 * (m[9] === "-" ? -1 : 1);
  const epoch = local - offset;
  return Number.isSafeInteger(epoch) && Number.isFinite(new Date(epoch).getTime()) ? epoch : null;
}

export function captureHostObservation(deps?: HostClockDependencies): HostClockResult {
  let value: unknown;
  try {
    if (deps !== undefined && (!record(deps) || (Object.hasOwn(deps, "clock") && typeof deps.clock !== "function")))
      return { ok: false, code: "HOST_CLOCK_UNAVAILABLE" };
    value = deps !== undefined && Object.hasOwn(deps, "clock") ? deps.clock!() : new Date().toISOString();
  } catch { return { ok: false, code: "HOST_CLOCK_UNAVAILABLE" }; }
  if (value === undefined || value === null) return { ok: false, code: "HOST_CLOCK_UNAVAILABLE" };
  const epochMs = parseRfc3339Timestamp(value);
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || epochMs === null || new Date(epochMs).toISOString() !== value)
    return { ok: false, code: "HOST_CLOCK_INVALID" };
  const time = Object.freeze({ iso: value, epochMs });
  hostObservations.add(time);
  return { ok: true, time };
}

/** @internal A structural/JSON/TypeScript lookalike is not a clock capability. */
export function isHostObservation(value: unknown): value is HostObservation {
  return typeof value === "object" && value !== null && hostObservations.has(value);
}

/** No cache across calls, no writes, and no externally supplied support list. */
export type RetryHistoryAuthorityLoadResult =
  | { valid: true; authority: RetryHistoryAuthority; snapshot: EvidenceSnapshot; fingerprints: FailureFingerprint[]; task_contracts: Map<string, unknown>; project_root: string; project_blocked: boolean }
  | { valid: false; code: string };

export function loadRetryHistoryAuthority(context: TrustedProjectContext, deps?: HostClockDependencies): RetryHistoryAuthorityLoadResult {
  const observation = captureHostObservation(deps);
  return observation.ok ? loadRetryHistoryWithObservation(context, observation.time) : { valid: false, code: observation.code };
}

/** @internal Privileged cross-module plumbing; never accepts an unbranded time. */
export function loadRetryHistoryWithObservation(context: TrustedProjectContext, observation: unknown): RetryHistoryAuthorityLoadResult {
  if (!isHostObservation(observation)) return { valid: false, code: "HOST_CLOCK_UNAVAILABLE" };
  try {
    requireFact(record(context) && typeof context.project_root === "string" && context.project_root.trim(), "ROOT_UNVERIFIABLE");
    const requestedRoot = resolve(context.project_root);
    const checkAncestors = (path: string) => {
      for (let current = path;; current = dirname(current)) {
        const stat = lstatSync(current);
        requireFact(!stat.isSymbolicLink(), "LINKED_INPUT");
        requireFact(current === path || stat.isDirectory(), "INPUT_UNSUPPORTED");
        if (dirname(current) === current) break;
      }
    };
    try { checkAncestors(requestedRoot); requireFact(lstatSync(requestedRoot).isDirectory(), "ROOT_UNVERIFIABLE"); }
    catch (error) { if (error instanceof AuthorityFailure) throw error; throw new AuthorityFailure("ROOT_UNVERIFIABLE"); }
    const root = realpathSync.native(requestedRoot);
    const identity = resolveWorktreeIdentity(root);
    requireFact(identity.valid, "ROOT_UNVERIFIABLE");
    const observed = new Map<string, {bytes: Buffer; identity: string}>();
    const aliases = new Map<string,string>();
    const safePath = (ref: string) => {
      requireFact(typeof ref === "string" && ref.startsWith(".xdev/") && !ref.includes("\\") && !/[\x00-\x1f<>:"|?*]/.test(ref)
        && ref.split("/").every(s=>s && s!=="." && s!==".." && !/[. ]$/.test(s) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)), "SOURCE_PATH_INVALID");
      const folded = ref.toLowerCase();
      requireFact(!aliases.has(folded) || aliases.get(folded) === ref, "SOURCE_PATH_INVALID"); aliases.set(folded,ref);
      const path = join(root,ref); checkAncestors(path);
      const stat = lstatSync(path,{bigint:true});
      requireFact(stat.isFile() && stat.nlink === 1n, "INPUT_UNSUPPORTED");
      const actual = realpathSync.native(path), rel = relative(root,actual);
      requireFact(rel && !isAbsolute(rel) && rel!==".." && !rel.startsWith("../") && !rel.startsWith("..\\"), "CROSS_ROOT");
      requireFact(relative(path,actual)==="", "REPARSE_INPUT");
      return {path,identity:`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`};
    };
    const read = (ref: string, missing = "SOURCE_UNRESOLVED") => {
      try {
        const facts = safePath(ref), bytes = readFileSync(facts.path);
        const previous = observed.get(ref);
        requireFact(!previous || (previous.identity===facts.identity && previous.bytes.equals(bytes)), "SNAPSHOT_STALE");
        observed.set(ref,{bytes,identity:facts.identity}); return bytes;
      } catch (error) { if (error instanceof AuthorityFailure) throw error; throw new AuthorityFailure(missing); }
    };
    const parse = (ref: string, missing?: string): JsonObject => {
      const bytes = read(ref,missing);
      try { const value = parseUniqueJson(new TextDecoder("utf-8",{fatal:true}).decode(bytes)); requireFact(record(value), "SCHEMA_INVALID"); return value; }
      catch (error) { if (error instanceof AuthorityFailure) throw error; throw new AuthorityFailure("SCHEMA_INVALID"); }
    };
    // These are observation/creation timestamps, not deadlines (expires_at).
    const observationFields = new Set(["created_at", "updated_at", "recorded_at", "captured_at", "capturedAt", "checked_at", "frozen_at", "snapshot_frozen_at"]);
    const timestamps = (value: unknown, ceiling: number, futureCode: string): void => {
      if (Array.isArray(value)) { for (const item of value) timestamps(item, ceiling, futureCode); return; }
      if (!record(value)) return;
      for (const [key, item] of Object.entries(value)) {
        if (observationFields.has(key)) {
          const parsed = parseRfc3339Timestamp(item);
          requireFact(parsed !== null, "TIMESTAMP_INVALID");
          requireFact(parsed <= ceiling, futureCode);
        } else if (item !== null && typeof item === "object") timestamps(item, ceiling, futureCode);
      }
    };
    const rawAuthority = parse(authorityPath,"MISSING");
    requireFact(rawAuthority.schema_version==="0.1", "VERSION_UNSUPPORTED");
    requireFact(parseRfc3339Timestamp(rawAuthority.created_at) !== null, "TIMESTAMP_INVALID");
    const validated = validatePlanningArtifact("retryHistoryAuthority",rawAuthority);
    requireFact(validated.valid, "SCHEMA_INVALID"); const a = validated.value;
    requireFact(a.authority_digest===digest(canonicalAuthority(a)) && a.authority_id===`rha-v0.1:${a.authority_digest}`, "DIGEST_MISMATCH");
    requireFact(a.root_binding.repo_root_identity===identity.value.filesystem_identity && a.root_binding.canonical_root_path_sha256===sha(identity.value.canonical_real_path), "ROOT_MISMATCH");
    const rawSnapshot=parse(snapshotPath,"SNAPSHOT_MISSING");
    requireFact(parseRfc3339Timestamp(rawSnapshot.frozen_at) !== null, "TIMESTAMP_INVALID");
    const snapshotValidation = validateEvidenceSnapshot(rawSnapshot);
    requireFact(snapshotValidation.valid, "SNAPSHOT_INVALID"); const snapshot=snapshotValidation.value;
    requireFact(rawSnapshot.path_hash_manifest.length===snapshot.path_hash_manifest.length&&rawSnapshot.spec_manifest.length===snapshot.spec_manifest.length&&rawSnapshot.evidence_manifest.length===snapshot.evidence_manifest.length,"SNAPSHOT_INVALID");
    const binding=a.snapshot_binding;
    requireFact(binding.snapshot_id===snapshot.snapshot_id && binding.snapshot_digest===snapshot.snapshot_digest && binding.snapshot_frozen_at===snapshot.frozen_at, "SNAPSHOT_INVALID");
    requireFact(snapshot.repo_root_identity===identity.value.filesystem_identity, "ROOT_MISMATCH");
    const frozen = parseRfc3339Timestamp(snapshot.frozen_at)!;
    const created = parseRfc3339Timestamp(a.created_at)!;
    requireFact(created >= frozen, "SNAPSHOT_INVALID");
    requireFact(frozen <= observation.epochMs && created <= observation.epochMs, "TIMESTAMP_FUTURE");
    timestamps(rawSnapshot, observation.epochMs, "TIMESTAMP_FUTURE");
    timestamps(rawAuthority, observation.epochMs, "TIMESTAMP_FUTURE");
    const support = new Map(snapshot.path_hash_manifest.map(e=>[e.canonical_repo_relative_path,e]));
    requireFact(support.size===snapshot.path_hash_manifest.length && !support.has(authorityPath) && !support.has(snapshotPath), "SNAPSHOT_INVALID");
    const readSupport = (ref: string, hash?: string) => {
      const bytes=read(ref), entry=support.get(ref);
      requireFact(entry && entry.kind==="regular_file" && entry.git_mode==="100644", "INCOMPLETE");
      requireFact(entry.sha256===sha(bytes) && (hash===undefined || hash===sha(bytes)), "SNAPSHOT_STALE");
      return bytes;
    };
    const sourceJson=(ref:string,hash?:string):JsonObject=>{
      readSupport(ref,hash);
      const value = parse(ref);
      timestamps(value, frozen, "SOURCE_AFTER_SNAPSHOT");
      return value;
    };
    const state=sourceJson(statePath,a.root_binding.project_state_sha256);
    requireFact(state.project_id===a.project_id, "PROJECT_MISMATCH");
    // Bind this reusable validator to the project's current subject, never a personal task constant.
    requireFact(Array.isArray(state.active_task_ids) && state.active_task_ids.includes(snapshot.task_id), "SNAPSHOT_INVALID");
    const ledgerBytes=readSupport(ledgerPath), rawLines=new TextDecoder("utf-8",{fatal:true}).decode(ledgerBytes).split(/\r?\n/);
    if(rawLines.at(-1)==="")rawLines.pop();
    requireFact(rawLines.length>0 && rawLines.every(l=>l.trim()), "SOURCE_EVENT_INVALID");
    const events:JsonObject[]=rawLines.map(line=>{try{const v=parseUniqueJson(line);requireFact(record(v)&&typeof v.event_id==="string"&&typeof v.event_type==="string","SOURCE_EVENT_INVALID");return v;}catch(e){if(e instanceof AuthorityFailure)throw e;throw new AuthorityFailure("SOURCE_EVENT_INVALID");}});
    const byId=new Map(events.map((e,i)=>[e.event_id,{e,line:i+1}]));
    requireFact(byId.size===events.length,"SOURCE_EVENT_DUPLICATE");
    const w=a.source_watermark,last=events.at(-1)!;
    requireFact(w.ledger_sha256===sha(ledgerBytes) && w.ledger_line_count===events.length && w.last_event_id===last.event_id && w.last_event_sha256===digest(last),"SNAPSHOT_STALE");
    const sourceTime = (e: JsonObject) => {
      const time = parseRfc3339Timestamp(e.created_at);
      requireFact(time !== null, "TIMESTAMP_INVALID");
      requireFact(time <= frozen, "SOURCE_AFTER_SNAPSHOT");
    };
    for (const event of events) { sourceTime(event); timestamps(event, frozen, "SOURCE_AFTER_SNAPSHOT"); }
    const taskContracts=new Map<string,unknown>(), taskRoots=new Map<string,string>(), roots=new Set<string>();
    for(const l of a.lineages){
      requireFact(!roots.has(l.root_task_id),"LINEAGE_ROOT_DUPLICATE");roots.add(l.root_task_id);
      const nodes=new Map(l.nodes.map(n=>[n.task_id,n]));
      requireFact(nodes.size===l.nodes.length && l.nodes.every(n=>!taskRoots.has(n.task_id)),"LINEAGE_TASK_AMBIGUOUS");
      requireFact(nodes.has(l.root_task_id),"LINEAGE_PARENT_INVALID");
      for(const edge of l.edges)requireFact(nodes.has(edge.parent_task_id)&&nodes.has(edge.child_task_id),"LINEAGE_CROSS_ROOT");
      for(const n of l.nodes){
        const incoming=l.edges.filter(e=>e.child_task_id===n.task_id);
        requireFact(n.task_id===l.root_task_id ? n.origin==="initial"&&incoming.length===0 : n.origin!=="initial"&&incoming.length===1&&incoming[0].relation===n.origin&&incoming[0].source_event_id===n.source_event_id,"LINEAGE_PARENT_INVALID");
        taskRoots.set(n.task_id,l.root_task_id);
      }
      const visited=new Set<string>(),visiting=new Set<string>();
      const walk=(id:string)=>{requireFact(!visiting.has(id),"LINEAGE_CYCLE");if(visited.has(id))return;visiting.add(id);for(const e of l.edges.filter(e=>e.parent_task_id===id))walk(e.child_task_id);visiting.delete(id);visited.add(id);};
      // Check disconnected cycles too, then independently prove root reachability.
      for(const n of l.nodes)walk(n.task_id);
      visited.clear();walk(l.root_task_id);requireFact(visited.size===nodes.size,"LINEAGE_UNREACHABLE");
      for(const n of l.nodes){
        requireFact(n.task_contract_ref.startsWith(".xdev/tasks/"),"SOURCE_PATH_INVALID");
        const task=sourceJson(n.task_contract_ref,n.task_contract_sha256);requireFact(task.task_id===n.task_id&&(!Object.hasOwn(task,"project_id")||task.project_id===a.project_id),"PROJECT_MISMATCH");taskContracts.set(n.task_id,task);
        const event=byId.get(n.source_event_id)?.e;requireFact(event,"SOURCE_UNRESOLVED");
        const parent=l.edges.find(e=>e.child_task_id===n.task_id)?.parent_task_id;
        requireFact(event.project_id===a.project_id&&event.task_id===n.task_id&&event.lineage_root_task_id===l.root_task_id&&event.origin===n.origin&&event.event_type===(n.origin==="initial"?"task_created":"task_lineage_linked")&&event.payload_ref===n.task_contract_ref&&event.payload_sha256===n.task_contract_sha256&&(parent===undefined?event.parent_task_id===undefined:event.parent_task_id===parent),"SOURCE_EVENT_MISMATCH");sourceTime(event);
      }
    }
    // Derive registration identity from the complete, snapshot-bound ledger,
    // never from the candidate's selection of nodes. This optional successor
    // candidate enforces the complete same-project universe. It is not H2
    // adoption and does not grant missing-history inputs execution permission.
    const registrations=events.filter(e=>e.event_type==="task_created"||e.event_type==="task_lineage_linked");
    for (const event of registrations)
      requireFact(typeof event.project_id === "string" && event.project_id.trim(), "PROJECT_MISMATCH");
    const registered=new Map<string,JsonObject>();
    for(const e of registrations.filter(e=>e.project_id===a.project_id)){
      requireFact(typeof e.task_id==="string"&&e.task_id.trim()&&!registered.has(e.task_id),"LINEAGE_TASK_AMBIGUOUS");
      registered.set(e.task_id,e);
    }
    const ledgerRoots=new Map<string,string>(),resolving=new Set<string>();
    const registeredRoot=(id:string):string=>{
      const cached=ledgerRoots.get(id);if(cached!==undefined)return cached;
      const e=registered.get(id);requireFact(e,"INCOMPLETE");
      requireFact(!resolving.has(id),"LINEAGE_CYCLE");resolving.add(id);
      requireFact(!Object.hasOwn(e,"source_contract_version")||e.source_contract_version==="retry-source-event-0.1","SOURCE_EVENT_INVALID");
      sourceTime(e);
      let rootId:string;
      if(e.event_type==="task_created"){
        requireFact(e.origin==="initial"&&e.parent_task_id===undefined&&e.lineage_root_task_id===id,"LINEAGE_PARENT_INVALID");rootId=id;
      }else{
        requireFact(["rename","split","reassignment","replan"].includes(e.origin)&&typeof e.parent_task_id==="string","LINEAGE_PARENT_INVALID");
        rootId=registeredRoot(e.parent_task_id);
        requireFact(e.lineage_root_task_id===rootId,"LINEAGE_CROSS_ROOT");
      }
      resolving.delete(id);ledgerRoots.set(id,rootId);return rootId;
    };
    // Scope comes from the fixed source, not from active or candidate membership.
    // Complete registration coverage is separate from per-root consumption.
    for (const id of registered.keys()) registeredRoot(id);
    for (const id of [snapshot.task_id, ...state.active_task_ids]) {
      requireFact(typeof id === "string", "INCOMPLETE");
      registeredRoot(id);
    }
    const requiredTasks = new Set(ledgerRoots.keys());
    for(const e of events){
      const registrationLike=e.event_type.startsWith("task_lineage_")||Object.hasOwn(e,"origin")&&(Object.hasOwn(e,"parent_task_id")||Object.hasOwn(e,"lineage_root_task_id"));
      if(registrationLike&&(e.project_id===a.project_id||requiredTasks.has(e.task_id)||requiredTasks.has(e.parent_task_id)||requiredTasks.has(e.lineage_root_task_id)))
        requireFact(e.event_type==="task_created"||e.event_type==="task_lineage_linked","SOURCE_EVENT_INVALID");
    }
    for(const e of registrations){
      // A foreign/missing project label cannot conceal an edge into our forest.
      if(e.project_id!==a.project_id){
        requireFact(!requiredTasks.has(e.task_id)&&!requiredTasks.has(e.parent_task_id)&&!requiredTasks.has(e.lineage_root_task_id),"PROJECT_MISMATCH");continue;
      }
      if(!requiredTasks.has(e.task_id))continue;
      requireFact(taskRoots.get(e.task_id)===ledgerRoots.get(e.task_id)&&a.lineages.some(l=>l.nodes.some(n=>n.task_id===e.task_id&&n.source_event_id===e.event_id)),"INCOMPLETE");
    }
    const fingerprints:FailureFingerprint[]=[],fpById=new Map<string,RetryHistoryAuthority["fingerprints"][number]>();
    const evidenceRef=(ref:string)=>requireFact(typeof ref==="string"&&(ref.startsWith(".xdev/evidence/")||ref.startsWith(".xdev/reports/")),"SOURCE_PATH_INVALID");
    for(const f of a.fingerprints){
      requireFact(!fpById.has(f.fingerprint_id),"FINGERPRINT_MISMATCH");evidenceRef(f.fingerprint_ref);
      const value=sourceJson(f.fingerprint_ref,f.fingerprint_sha256),validation=validateFailureFingerprint(value,[],{repo_root:root});
      requireFact(validation.valid,"FINGERPRINT_MISMATCH");
      const {fingerprint_id,...tuple}=validation.value;
      requireFact(fingerprint_id===f.fingerprint_id&&equal(tuple,f.canonical_tuple)&&digest(tuple)===f.canonical_tuple_sha256,"FINGERPRINT_MISMATCH");
      fpById.set(f.fingerprint_id,f);fingerprints.push(validation.value);
    }
    const runIds=new Set<string>(),dispatchIds=new Set<string>(),usedEvents=new Set<string>();
    const legacyRuns=a.runs.filter(r=>r.source_class==="legacy");
    if(legacyRuns.length){
      const b=a.legacy_transition_binding;requireFact(b&&b.projection_ref===legacyPath,"INCOMPLETE");
      const projection=sourceJson(b.projection_ref,b.projection_sha256);
      requireFact(projection.project_binding?.project_id===a.project_id&&projection.project_binding.project_state_ref===statePath&&projection.project_binding.project_state_sha256===sha(readSupport(statePath)),"PROJECT_MISMATCH");
      const pins=projection.worker_runs;
      requireFact(Array.isArray(pins)&&pins.length===4&&legacyRuns.length===4&&new Set(pins.map(p=>p.run_id)).size===4,"INCOMPLETE");
      requireFact(digest(pins)===legacyPinsDigest && projection.task_id==="M2-T002" && a.project_id==="xdev-v0","SOURCE_EVENT_MISMATCH");
      const cutoff=projection.transition?.legacy_cutoff;requireFact(record(cutoff)&&Number.isSafeInteger(cutoff.ledger_line),"SOURCE_EVENT_INVALID");
      const cutoffEvent=events[cutoff.ledger_line-1];requireFact(cutoff.ledger_line===273&&cutoff.event_id==="EVT-0273"&&cutoff.event_sha256==="7dd816370946e9e8477f00984d8b2826e93c1758a857577af10ecc98b1cf131b"&&cutoffEvent?.event_id===cutoff.event_id&&sha(rawLines[cutoff.ledger_line-1])===cutoff.event_sha256,"SOURCE_EVENT_MISMATCH");
      for(const r of legacyRuns){
        requireFact(r.source_class==="legacy"&&r.legacy_projection_ref===b.projection_ref&&r.legacy_projection_sha256===b.projection_sha256,"SOURCE_EVENT_MISMATCH");
        const pin=pins.find(p=>p.run_id===r.run_id);requireFact(pin&&pin.classification?.attempt_kind==="UNKNOWN"&&pin.classification?.dispatch_id==="UNKNOWN"&&pin.classification?.failure_fingerprint_id==="UNKNOWN","SOURCE_EVENT_INVALID");
        const bindings=[pin.charge_proof,...pin.supplemental_events];
        requireFact(r.task_id==="M2-T002"&&r.charge_event_id===pin.charge_proof.event_id&&r.source_event_refs.length===bindings.length&&new Set(r.source_event_refs.map(ref=>ref.event_id)).size===bindings.length&&r.terminal_disposition==="implemented","SOURCE_EVENT_MISMATCH");
        for(const p of bindings){
          const e=events[p.ledger_line-1];requireFact(p.ledger_line<=cutoff.ledger_line&&e&&e.event_id===p.event_id&&e.event_type===p.event_type&&sha(rawLines[p.ledger_line-1])===p.event_sha256&&e.project_id===a.project_id&&e.task_id===r.task_id&&e.run_id===r.run_id&&e.payload_ref===p.payload_ref,"SOURCE_EVENT_MISMATCH");
          requireFact(!usedEvents.has(e.event_id),"SOURCE_EVENT_DUPLICATE");usedEvents.add(e.event_id);sourceTime(e);
          requireFact(/^\.xdev\/(evidence|reports|model-decisions|owner-decisions)\//.test(p.payload_ref),"SOURCE_PATH_INVALID");
          const payload=sourceJson(p.payload_ref,p.current_payload_sha256);
          if(p===pin.charge_proof){requireFact(!Object.hasOwn(payload,"project_id")&&payload.task_id===r.task_id&&payload.run_id===r.run_id&&typeof payload.status==="string"&&payload.status.startsWith("IMPLEMENTED"),"SOURCE_EVENT_MISMATCH");}
          const ref=r.source_event_refs.find(ref=>ref.event_id===e.event_id);
          requireFact(ref&&ref.ledger_line===p.ledger_line&&ref.event_sha256===p.event_sha256&&ref.payload_ref===p.payload_ref&&ref.payload_sha256===p.current_payload_sha256&&ref.project_id===a.project_id&&ref.task_id===r.task_id&&ref.run_id===r.run_id&&ref.event_type===e.event_type&&ref.created_at===e.created_at,"SOURCE_EVENT_MISMATCH");
        }
      }
    }else requireFact(a.legacy_transition_binding===null,"INCOMPLETE");
    for(const r of a.runs){
      requireFact(!runIds.has(r.run_id),"RUN_DUPLICATE");runIds.add(r.run_id);
      requireFact(taskRoots.get(r.task_id)===r.lineage_root_task_id,"RUN_LINK_MISMATCH");
      if(r.source_class==="legacy")continue;
      requireFact(!dispatchIds.has(r.dispatch_id),"DISPATCH_REPLAY");dispatchIds.add(r.dispatch_id);
      if(r.predecessor_run_id!==null){const predecessor=a.runs.find(p=>p.run_id===r.predecessor_run_id);requireFact(predecessor&&predecessor!==r&&predecessor.lineage_root_task_id===r.lineage_root_task_id&&Math.min(...predecessor.source_event_refs.map(e=>e.ledger_line))<Math.min(...r.source_event_refs.map(e=>e.ledger_line)),"RUN_LINK_MISMATCH");}
      requireFact(r.attempt_kind==="initial"?r.failure_fingerprint_id===null:typeof r.failure_fingerprint_id==="string"&&fpById.has(r.failure_fingerprint_id),"FINGERPRINT_UNRESOLVED");
      const refs=[...r.source_event_refs].sort((x,y)=>x.ledger_line-y.ledger_line);
      requireFact(r.charge_event_id===refs[0].event_id,"SOURCE_EVENT_REPLAY");
      let terminal="active", previousTime=-Infinity;
      for(let i=0;i<refs.length;i++){
        const ref=refs[i],e=events[ref.ledger_line-1];
        requireFact(e&&workerTypes.has(e.event_type)&&e.source_contract_version==="retry-source-event-0.1","SOURCE_EVENT_INVALID");
        requireFact(!usedEvents.has(e.event_id),"SOURCE_EVENT_DUPLICATE");usedEvents.add(e.event_id);
        const expected:RetrySourceEventRef={event_id:e.event_id,event_type:e.event_type,ledger_line:ref.ledger_line,event_sha256:digest(e),project_id:a.project_id,task_id:r.task_id,run_id:r.run_id,dispatch_id:r.dispatch_id,attempt_kind:r.attempt_kind,failure_fingerprint_id:r.failure_fingerprint_id,payload_ref:e.payload_ref,payload_sha256:e.payload_sha256,created_at:e.created_at};
        requireFact(equal(ref,expected)&&e.project_id===a.project_id&&e.task_id===r.task_id&&e.run_id===r.run_id&&e.dispatch_id===r.dispatch_id&&e.attempt_kind===r.attempt_kind&&e.failure_fingerprint_id===r.failure_fingerprint_id&&e.lineage_root_task_id===r.lineage_root_task_id&&e.predecessor_run_id===r.predecessor_run_id,"SOURCE_EVENT_MISMATCH");
        requireFact(terminal==="active" && (i===0||e.event_type!=="run_started"),"SOURCE_EVENT_REPLAY");
        sourceTime(e);requireFact(Date.parse(e.created_at)>=previousTime,"SOURCE_EVENT_INVALID");previousTime=Date.parse(e.created_at);
        if(e.event_type==="run_started")requireFact(e.terminal_disposition==="active","SOURCE_EVENT_INVALID");
        else if(e.event_type==="run_completed")requireFact(["implemented","failed"].includes(e.terminal_disposition),"SOURCE_EVENT_INVALID");
        else requireFact(e.terminal_disposition===(e.event_type.endsWith("_implemented")?"implemented":e.event_type.slice(4)),"SOURCE_EVENT_INVALID");
        terminal=e.terminal_disposition;evidenceRef(e.payload_ref);
        const payload=sourceJson(e.payload_ref,e.payload_sha256);
        requireFact(payload.project_id===a.project_id&&payload.task_id===r.task_id&&payload.run_id===r.run_id&&payload.dispatch_id===r.dispatch_id&&payload.attempt_kind===r.attempt_kind&&payload.failure_fingerprint_id===r.failure_fingerprint_id&&typeof payload.command==="string"&&payload.command.trim()&&(terminal==="active"?payload.exit_code===null:Number.isInteger(payload.exit_code)),"SOURCE_EVENT_MISMATCH");
        if(r.failure_fingerprint_id!==null){const f=fpById.get(r.failure_fingerprint_id)!;requireFact(e.fingerprint_ref===f.fingerprint_ref,"FINGERPRINT_MISMATCH");readSupport(e.fingerprint_ref,f.fingerprint_sha256);}
        else requireFact(e.fingerprint_ref===null,"FINGERPRINT_MISMATCH");
      }
      requireFact(r.terminal_disposition===terminal,"RUN_LINK_MISMATCH");
      if(r.attempt_kind==="initial")requireFact(r.task_id===r.lineage_root_task_id&&!a.runs.some(other=>other!==r&&other.lineage_root_task_id===r.lineage_root_task_id&&Math.min(...other.source_event_refs.map(e=>e.ledger_line))<refs[0].ledger_line),"INITIAL_ATTEMPT_REUSED");
    }
    // Never hide an unknown or malformed Worker by omitting its authority row.
    for(const e of events){
      const worker=workerTypes.has(e.event_type)||e.event_type.startsWith("run_")||e.event_type==="worker_evidence_persisted_late"||Object.hasOwn(e,"source_contract_version")&&e.event_type!=="task_created"&&e.event_type!=="task_lineage_linked";
      if(!worker)continue;
      requireFact(typeof e.project_id === "string" && e.project_id.trim(), "PROJECT_MISMATCH");
      if (e.project_id === a.project_id || requiredTasks.has(e.task_id) || requiredTasks.has(e.lineage_root_task_id))
        requireFact(e.project_id === a.project_id && registered.has(e.task_id) && usedEvents.has(e.event_id), "INCOMPLETE");
    }
    const derived:RetryHistoryAuthority["derived_counts"]=a.lineages.flatMap(l=>[null,...fpById.keys()].map(f=>{
      const lineageRuns=a.runs.filter(r=>r.lineage_root_task_id===l.root_task_id),unknown=lineageRuns.some(r=>r.source_class==="legacy");
      const selected=lineageRuns.filter(r=>f===null||(r.source_class==="current"&&r.failure_fingerprint_id===f));
      return {lineage_root_task_id:l.root_task_id,failure_fingerprint_id:f,automatic_rework_charges:unknown?"UNKNOWN":f===null?0:selected.filter(r=>r.source_class==="current"&&r.attempt_kind==="automatic_rework").length,owner_granted_recovery_charges:f===null?0:selected.filter(r=>r.source_class==="current"&&r.attempt_kind==="owner_granted_recovery").length,all_worker_charges:selected.length};
    }));
    const sortCounts=(v:typeof derived)=>[...v].sort((x,y)=>compare([x.lineage_root_task_id,x.failure_fingerprint_id??""].join("\0"),[y.lineage_root_task_id,y.failure_fingerprint_id??""].join("\0")));
    requireFact(equal(sortCounts(derived),sortCounts(a.derived_counts)),"COUNT_MISMATCH");
    // A second complete read detects changes during evaluation; it is not a lock.
    for(const ref of observed.keys())read(ref);
    const finalIdentity=resolveWorktreeIdentity(root);requireFact(finalIdentity.valid&&equal(finalIdentity.value,identity.value),"ROOT_MISMATCH");
    return {valid:true,authority:a,snapshot,fingerprints,task_contracts:taskContracts,project_root:root,project_blocked:state.project_state === "BLOCKED"};
  }catch(error){return {valid:false,code:error instanceof AuthorityFailure?error.code:"RETRY_AUTHORITY_SOURCE_UNRESOLVED"};}
}
