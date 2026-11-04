/** Execution decisions over independent Host/XMem facts. This module neither
 * stores engineering state nor resolves source authority. No JSON-file override
 * or caller-supplied history/clock is an execution-permit entry point. */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../planning/governance-contracts.ts';
import { parseRfc3339Timestamp } from '../planning/retry-history.ts';
export type ActionKind = 'DEVELOP'|'REVIEW'|'VERIFY';
export type DeliveryMode = 'FAST_VALIDATION'|'FAST_DEVELOPMENT'|'PRODUCT_GRADE';
export type Action = { action_id:string; project_id:string; task_id:string; contract_sha256:string; authorization_id:string; kind:ActionKind };
export type ImpactScope = { extent:'BOUNDED_VERIFIED'|'UNBOUNDED'; task_ids:string[]; root_ids:string[]; resource_ids:string[]; workspace_ids:string[]; evidence_refs:string[] };
export type TaskFact = { task_id:string; root_id:string; contract_sha256:string; dependency_ids:string[]; workspace_id:string; state:'PENDING'|'VERIFIED'|'UNKNOWN'; evidence_ref:string; required_checks:string[]; delivery_mode:DeliveryMode };
export type AuthorizationFact = { authorization_id:string; task_id:string; contract_sha256:string; kind:ActionKind; purpose?:'RESERVE_ONLY'; action_id?:string; revoked:boolean; expires_at:string; evidence_ref:string; reservations:{resource_id:string; units:number}[] };
export type ProjectFacts = {
  format:'xdev-execution-source-1'; execution_restriction?:'RESERVATION_ONLY'; control_action_sha256?:string; project_id:string; revision:string; legacy_source_sha256?:string; legacy_observed?:{source_sha256:string;fixed_pin_status:string;known_pin_run_ids:string[];known_pin_worker_charges:number|null;run_label_count:number};
  coverage:'COMPLETE_PROJECT'|'INCOMPLETE'; freshness:'CURRENT'|'STALE'|'UNKNOWN'; evidence_refs:string[];
  compatibility:{policy:'H1'|'H2'|null; adoption_ref:string|null};
  tasks:TaskFact[];
  resources:{resource_id:string; unit:'DISPATCH_SLOT'|'RECOVERY_TOKEN'|'MONEY_MINOR'; limit:number; evidence_ref:string}[];
  charges:{charge_id:string; resource_id:string; units:number|null; evidence_ref:string}[];
  reservations:{reservation_id:string; resource_id:string; units:number; evidence_ref:string;action_id?:string;action_sha256?:string;group_ref?:string}[];
  unknowns:{fact_id:string; legacy:boolean; scope:ImpactScope; reason:string}[];
  stops:{stop_id:string; scope:ImpactScope; active:boolean; evidence_ref:string}[];
  authorizations:AuthorizationFact[];
};
/** Implemented by trusted product integration, not by an Agent's task JSON.
 * captureProject MUST read the whole registered project source, without task/
 * root/candidate filters. Missing XMem integration must throw, never synthesize
 * COMPLETE_PROJECT or CURRENT. Scope evidence is verified by the source plane. */
export interface ProjectFactsPort { captureProject(projectId:string):Promise<ProjectFacts>; }
export type Admission = { purpose:'EXECUTE'|'RESERVE_ONLY'; allowed:boolean; reasons:string[]; action:Action; source_revision:string|null; source_digest:string|null; task:TaskFact|null; authorization:AuthorizationFact|null; ignored_unknown_ids:string[]; relevant_unknown_ids:string[]; resource_totals:{resource_id:string; known:number; reserved:number; requested:number; limit:number; has_unknown:boolean}[]; delivery_claim:'NONE';reusable_reservation_ref:string|null };
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v as any)).digest('hex');
const sha=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const list=(v:unknown):v is string[]=>Array.isArray(v)&&v.every(text)&&new Set(v).size===v.length;
const units=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
function check(ok:unknown,code:string):asserts ok {if(!ok)throw Error(code);}
export function actionDigest(action:Action):string { validateAction(action);return hash(action); }
function validateAction(a:Action) {
  check(a&&typeof a==='object'&&!Array.isArray(a),'ACTION_INVALID');
  check(Object.keys(a).sort().join(',')==='action_id,authorization_id,contract_sha256,kind,project_id,task_id','ACTION_FIELDS_INVALID');
  check([a.action_id,a.project_id,a.task_id,a.authorization_id].every(text)&&sha(a.contract_sha256)&&['DEVELOP','REVIEW','VERIFY'].includes(a.kind),'ACTION_INVALID');
}
function validateScope(s:ImpactScope) {
  check(s&&['BOUNDED_VERIFIED','UNBOUNDED'].includes(s.extent)&&[s.task_ids,s.root_ids,s.resource_ids,s.workspace_ids,s.evidence_refs].every(list),'SOURCE_SCOPE_INVALID');
  if(s.extent==='BOUNDED_VERIFIED')check(s.evidence_refs.length>0&&[...s.task_ids,...s.root_ids,...s.resource_ids,...s.workspace_ids].length>0,'SOURCE_SCOPE_UNPROVEN');
}
function validateFacts(f:ProjectFacts) {
  check(f&&f.format==='xdev-execution-source-1'&&text(f.project_id)&&text(f.revision)&&list(f.evidence_refs)&&f.evidence_refs.length>0,'SOURCE_IDENTITY_INVALID');
  check(!Object.hasOwn(f,'control_action_sha256')||sha(f.control_action_sha256),'SOURCE_CONTROL_ACTION_INVALID');
  check(!Object.hasOwn(f,'execution_restriction')||f.execution_restriction==='RESERVATION_ONLY','SOURCE_EXECUTION_RESTRICTION_INVALID');
  check(['COMPLETE_PROJECT','INCOMPLETE'].includes(f.coverage)&&['CURRENT','STALE','UNKNOWN'].includes(f.freshness),'SOURCE_COVERAGE_INVALID');
  for(const [items,key]of [[f.tasks,'task_id'],[f.resources,'resource_id'],[f.charges,'charge_id'],[f.reservations,'reservation_id'],[f.unknowns,'fact_id'],[f.stops,'stop_id'],[f.authorizations,'authorization_id']] as const){
    check(Array.isArray(items),'SOURCE_COLLECTION_MISSING');const ids=new Set<string>();
    for(const row of items){const id=(row as any)?.[key];check(text(id)&&!ids.has(id),'SOURCE_DUPLICATE_OR_MISSING_ID');ids.add(id);}
  }
  check(f.compatibility&&[null,'H1','H2'].includes(f.compatibility.policy)&&(f.compatibility.adoption_ref===null||text(f.compatibility.adoption_ref)),'COMPATIBILITY_FACT_INVALID');
  for(const t of f.tasks)check(text(t.root_id)&&sha(t.contract_sha256)&&list(t.dependency_ids)&&text(t.workspace_id)&&['PENDING','VERIFIED','UNKNOWN'].includes(t.state)&&text(t.evidence_ref)&&list(t.required_checks)&&t.required_checks.length>0&&['FAST_VALIDATION','FAST_DEVELOPMENT','PRODUCT_GRADE'].includes(t.delivery_mode),'TASK_FACT_INVALID');
  const resources=new Set(f.resources.map(r=>r.resource_id));
  for(const r of f.resources)check(['DISPATCH_SLOT','RECOVERY_TOKEN','MONEY_MINOR'].includes(r.unit)&&units(r.limit)&&text(r.evidence_ref),'RESOURCE_FACT_INVALID');
  for(const c of f.charges)check(resources.has(c.resource_id)&&(c.units===null||units(c.units))&&text(c.evidence_ref),'CHARGE_FACT_INVALID');
  for(const r of f.reservations){
    check(resources.has(r.resource_id)&&units(r.units)&&text(r.evidence_ref),'RESERVATION_FACT_INVALID');
    if(['action_id','action_sha256','group_ref'].some(k=>Object.hasOwn(r,k)))check(text(r.action_id)&&sha(r.action_sha256)&&text(r.group_ref),'RESERVATION_ACTION_BINDING_INVALID');
  }
  const groupOwners=new Map<string,string>();
  for(const r of f.reservations)if(r.group_ref){const owner=JSON.stringify([r.action_id,r.action_sha256]);check(!groupOwners.has(r.group_ref)||groupOwners.get(r.group_ref)===owner,'RESERVATION_GROUP_REBOUND');groupOwners.set(r.group_ref,owner);}
  for(const u of f.unknowns){check(typeof u.legacy==='boolean'&&text(u.reason),'UNKNOWN_FACT_INVALID');validateScope(u.scope);}
  for(const s of f.stops){check(typeof s.active==='boolean'&&text(s.evidence_ref),'STOP_FACT_INVALID');validateScope(s.scope);}
  for(const a of f.authorizations){check(!Object.hasOwn(a,'action_id')||text(a.action_id),'AUTHORIZATION_ACTION_ID_INVALID');check(!Object.hasOwn(a,'purpose')||a.purpose==='RESERVE_ONLY','AUTHORIZATION_PURPOSE_INVALID');check(text(a.task_id)&&sha(a.contract_sha256)&&['DEVELOP','REVIEW','VERIFY'].includes(a.kind)&&typeof a.revoked==='boolean'&&parseRfc3339Timestamp(a.expires_at)!==null&&text(a.evidence_ref)&&Array.isArray(a.reservations)&&a.reservations.length>0,'AUTHORIZATION_FACT_INVALID');
    const seen=new Set<string>();for(const r of a.reservations){check(resources.has(r.resource_id)&&!seen.has(r.resource_id)&&units(r.units)&&r.units>0,'AUTHORIZATION_RESOURCE_INVALID');seen.add(r.resource_id);}}
}

/** Structural validation only; does not authenticate facts or issue a permit. */
export function validateProjectFacts(input: unknown): asserts input is ProjectFacts { validateFacts(input as ProjectFacts); }

// Evaluation never registers executable capabilities.
export {isIssuedAdmission} from './trusted-execution-context.ts';
function freeze<T>(v:T):T { if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v; }
/** Diagnostic evaluation only. Even an allowed result is NOT an issued permit.
 * Source/clock injection is permitted here solely for evaluation and testing. */
export async function evaluateAction(actionInput:Action,source:ProjectFactsPort,clock:()=>number=Date.now,purpose:'EXECUTE'|'RESERVE_ONLY'='EXECUTE'):Promise<Admission> {
  const action=structuredClone(actionInput);
  const out:Admission={purpose,allowed:false,reasons:[],action,source_revision:null,source_digest:null,task:null,authorization:null,ignored_unknown_ids:[],relevant_unknown_ids:[],resource_totals:[],delivery_claim:'NONE',reusable_reservation_ref:null};
  try {
    check(purpose==='EXECUTE'||purpose==='RESERVE_ONLY','ADMISSION_PURPOSE_INVALID');
    validateAction(action);
    const now=clock();check(Number.isFinite(now)&&now>=0,'OBSERVED_TIME_INVALID');
    const f=structuredClone(await source.captureProject(action.project_id));validateFacts(f);
    check(f.project_id===action.project_id,'SOURCE_PROJECT_MISMATCH');
    out.source_revision=f.revision;out.source_digest=hash(f);
    if(f.control_action_sha256!==undefined&&f.control_action_sha256!==actionDigest(action))out.reasons.push('ACTION_OUTSIDE_CONTROL_DOMAIN');
    if(f.execution_restriction==='RESERVATION_ONLY'&&purpose!=='RESERVE_ONLY')out.reasons.push('DOMAIN_RESERVATION_ONLY');
    if(f.coverage!=='COMPLETE_PROJECT')out.reasons.push('PROJECT_SOURCE_INCOMPLETE');
    if(f.freshness!=='CURRENT')out.reasons.push('PROJECT_SOURCE_NOT_CURRENT');
    const tasks=new Map(f.tasks.map(t=>[t.task_id,t]));const task=tasks.get(action.task_id);check(task,'TASK_NOT_REGISTERED');out.task=task;
    if(task.contract_sha256!==action.contract_sha256)out.reasons.push('TASK_CONTRACT_CHANGED');
    if(task.state==='UNKNOWN')out.reasons.push('TASK_STATE_UNKNOWN');
    const closure=new Set<string>(),visiting=new Set<string>();
    function visit(id:string){check(!visiting.has(id),'TASK_DEPENDENCY_CYCLE');if(closure.has(id))return;const t=tasks.get(id);check(t,'DEPENDENCY_NOT_REGISTERED');visiting.add(id);for(const d of t.dependency_ids)visit(d);visiting.delete(id);closure.add(id);}
    visit(task.task_id);
    const roots=new Set([...closure].map(id=>tasks.get(id)!.root_id));const workspaces=new Set([...closure].map(id=>tasks.get(id)!.workspace_id));
    for(const id of closure)if(id!==task.task_id&&tasks.get(id)!.state!=='VERIFIED')out.reasons.push('DEPENDENCY_NOT_VERIFIED:'+id);
    const auth=f.authorizations.find(a=>a.authorization_id===action.authorization_id);check(auth,'AUTHORIZATION_NOT_FOUND');out.authorization=auth;
    if(auth.action_id!==undefined&&auth.action_id!==action.action_id)out.reasons.push('AUTHORIZATION_ACTION_ID_MISMATCH');
    if(auth.purpose==='RESERVE_ONLY'&&purpose!=='RESERVE_ONLY')out.reasons.push('AUTHORIZATION_RESERVATION_ONLY');
    if(auth.revoked||auth.task_id!==action.task_id||auth.contract_sha256!==action.contract_sha256||auth.kind!==action.kind||parseRfc3339Timestamp(auth.expires_at)!<=now)out.reasons.push('AUTHORIZATION_NOT_APPLICABLE_OR_EXPIRED');
    const resources=new Set(auth.reservations.map(r=>r.resource_id));
    if(!auth.reservations.some(r=>f.resources.find(x=>x.resource_id===r.resource_id)?.unit==='DISPATCH_SLOT'))out.reasons.push('DISPATCH_BOUND_MISSING');
    function relevant(s:ImpactScope){return s.extent==='UNBOUNDED'||s.task_ids.some(x=>closure.has(x))||s.root_ids.some(x=>roots.has(x))||s.workspace_ids.some(x=>workspaces.has(x))||s.resource_ids.some(x=>resources.has(x));}
    // Unknown identity, writer scope or global resource impact is not erased by
    // a new task name/directory. Ignoring requires independently proven bounds.
    for(const u of f.unknowns){if(relevant(u.scope)){out.relevant_unknown_ids.push(u.fact_id);out.reasons.push('APPLICABLE_FACT_UNKNOWN:'+u.fact_id);}else out.ignored_unknown_ids.push(u.fact_id);}
    if(f.unknowns.some(u=>u.legacy)&&(f.compatibility.policy!=='H2'||!text(f.compatibility.adoption_ref)))out.reasons.push('HISTORICAL_POLICY_NOT_ADOPTED');
    for(const s of f.stops)if(s.active&&relevant(s.scope))out.reasons.push('APPLICABLE_STOP:'+s.stop_id);
    const ownHolds=f.reservations.filter(r=>r.action_id===action.action_id);
    if(ownHolds.length){
      check(ownHolds.every(r=>r.action_sha256===actionDigest(action)),'RESERVATION_ACTION_REBOUND');
      check(new Set(ownHolds.map(r=>r.group_ref)).size===1,'RESERVATION_GROUP_AMBIGUOUS');
      check(ownHolds.length===auth.reservations.length&&auth.reservations.every(req=>ownHolds.filter(r=>r.resource_id===req.resource_id&&r.units===req.units).length===1),'RESERVATION_VECTOR_MISMATCH');
      out.reusable_reservation_ref=ownHolds[0].group_ref!;
    }
    for(const req of auth.reservations){const r=f.resources.find(r=>r.resource_id===req.resource_id)!;const charges=f.charges.filter(c=>c.resource_id===r.resource_id),holds=f.reservations.filter(x=>x.resource_id===r.resource_id);
      const known=charges.reduce((n,c)=>n+(c.units??0),0),reserved=holds.reduce((n,h)=>n+h.units,0),unknown=charges.some(c=>c.units===null);
      const requested=out.reusable_reservation_ref?0:req.units;
      check(units(known)&&units(reserved)&&units(known+reserved+requested),'RESOURCE_SUM_OVERFLOW');
      out.resource_totals.push({resource_id:r.resource_id,known,reserved,requested,limit:r.limit,has_unknown:unknown});
      if(unknown)out.reasons.push('RESOURCE_CONSUMPTION_UNKNOWN:'+r.resource_id);
      else if(known+reserved+requested>r.limit)out.reasons.push('RESOURCE_LIMIT:'+r.resource_id);
    }
    out.allowed=out.reasons.length===0;
  }catch(e){out.reasons.push(e instanceof Error?e.message:'SOURCE_UNAVAILABLE');out.allowed=false;}
  freeze(out);
  return out;
}

/** Compatibility alias: non-issued evaluation only. */
export const assessAction=evaluateAction;
