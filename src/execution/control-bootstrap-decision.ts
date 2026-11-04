/** Administrative, prospective XDev control decisions. Not historical evidence,
 * an XMem state store, or an authentication mechanism. Only a trusted operator
 * may supply the decision and independently authenticated source receipt.
 */
import {createHash} from 'node:crypto';
import {canonicalJson} from '../planning/governance-contracts.ts';
import {parseRfc3339Timestamp} from '../planning/retry-history.ts';
import {actionDigest,validateProjectFacts,type Action,type ProjectFacts,type AuthorizationFact} from './admission.ts';
export type BootstrapDecision = {
  format:'xdev-control-bootstrap-decision-1'; decision_id:string; project_id:string;
  source_sha256:string; issued_at:string; valid_until:string; scope_ref:string;
  purpose:'RESERVE_ONLY_NO_DISPATCH'; historical_constraints:'PRESERVE_ALL';
  action:Action; authorization:AuthorizationFact;
  // Explicit TOTAL ceilings, not claimed remaining balances or refunds.
  ceilings:{resource_id:string;limit:number}[];
};
export const bootstrapHash=(v:unknown):string=>createHash('sha256').update(canonicalJson(v as any)).digest('hex');
export const bootstrapBytesHash=(v:Buffer|string):string=>createHash('sha256').update(v).digest('hex');
export function bootstrapCheck(ok:unknown,code:string):asserts ok {if(!ok)throw Error(code);}
export const bootstrapExact=(v:any,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const text=(v:unknown)=>typeof v==='string'&&v.trim().length>0;
const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
/** The result never changes tasks, history, unknown scopes, STOP, compatibility
 * or source completeness/freshness. The new grant is a NOW decision, not a
 * correction to old approvals. Existing authorizations remain intact.
 */
export function overlayBootstrapDecision(source:ProjectFacts,d:BootstrapDecision):ProjectFacts {
  validateProjectFacts(source);
  bootstrapCheck(bootstrapExact(d,['format','decision_id','project_id','source_sha256','issued_at','valid_until','scope_ref','purpose','historical_constraints','action','authorization','ceilings'])&&d.format==='xdev-control-bootstrap-decision-1','BOOTSTRAP_DECISION_INVALID');
  bootstrapCheck([d.decision_id,d.project_id,d.scope_ref].every(text)&&digest(d.source_sha256),'BOOTSTRAP_DECISION_IDENTITY_INVALID');
  bootstrapCheck(d.purpose==='RESERVE_ONLY_NO_DISPATCH'&&d.historical_constraints==='PRESERVE_ALL','BOOTSTRAP_DECISION_SCOPE_INVALID');
  const issued=parseRfc3339Timestamp(d.issued_at),until=parseRfc3339Timestamp(d.valid_until);
  bootstrapCheck(issued!==null&&until!==null&&issued<until,'BOOTSTRAP_DECISION_TIME_INVALID');
  actionDigest(d.action);bootstrapCheck(d.project_id===source.project_id&&d.action.project_id===source.project_id,'BOOTSTRAP_PROJECT_MISMATCH');
  const a=d.authorization;
  bootstrapCheck(bootstrapExact(a,['authorization_id','task_id','contract_sha256','kind','purpose','action_id','revoked','expires_at','evidence_ref','reservations']),'BOOTSTRAP_GRANT_INVALID');
  bootstrapCheck(a.authorization_id===d.action.authorization_id&&a.task_id===d.action.task_id&&a.contract_sha256===d.action.contract_sha256&&a.kind===d.action.kind&&a.revoked===false&&a.purpose==='RESERVE_ONLY'&&a.action_id===d.action.action_id,'BOOTSTRAP_GRANT_ACTION_MISMATCH');
  bootstrapCheck(a.expires_at===d.valid_until&&a.evidence_ref===d.scope_ref,'BOOTSTRAP_GRANT_EVIDENCE_MISMATCH');
  bootstrapCheck(!source.authorizations.some(x=>x.authorization_id===a.authorization_id),'BOOTSTRAP_GRANT_ALREADY_EXISTS');
  bootstrapCheck(Array.isArray(d.ceilings)&&d.ceilings.length>0&&Array.isArray(a.reservations)&&a.reservations.length===d.ceilings.length,'BOOTSTRAP_CEILINGS_INVALID');
  const ids=new Set<string>();
  for(const c of d.ceilings){
    bootstrapCheck(bootstrapExact(c,['resource_id','limit'])&&text(c.resource_id)&&Number.isSafeInteger(c.limit)&&c.limit>=0&&!ids.has(c.resource_id),'BOOTSTRAP_CEILING_INVALID');ids.add(c.resource_id);
    const r=source.resources.find(x=>x.resource_id===c.resource_id);
    bootstrapCheck(r,'BOOTSTRAP_RESOURCE_NOT_REGISTERED');
    bootstrapCheck(r.unit==='DISPATCH_SLOT'||r.unit==='RECOVERY_TOKEN','BOOTSTRAP_RESOURCE_UNIT_UNSUPPORTED');
    bootstrapCheck(a.reservations.filter(x=>x.resource_id===c.resource_id).length===1,'BOOTSTRAP_VECTOR_MISMATCH');
  }
  for(const r of a.reservations)bootstrapCheck(bootstrapExact(r,['resource_id','units'])&&ids.has(r.resource_id)&&Number.isSafeInteger(r.units)&&r.units>0,'BOOTSTRAP_VECTOR_INVALID');
  const f=structuredClone(source);
  bootstrapCheck(f.control_action_sha256===undefined||f.control_action_sha256===actionDigest(d.action),'BOOTSTRAP_EXISTING_ACTION_SCOPE');
  f.execution_restriction='RESERVATION_ONLY';
  f.control_action_sha256=actionDigest(d.action);
  for(const c of d.ceilings){const r=f.resources.find(x=>x.resource_id===c.resource_id)!;r.limit=c.limit;r.evidence_ref=d.scope_ref;}
  f.authorizations.push(structuredClone(a));
  f.evidence_refs.push('current-control-decision:'+bootstrapHash(d));
  f.revision='prospective-control:'+bootstrapHash({source_revision:source.revision,source_sha256:d.source_sha256,decision:d});
  validateProjectFacts(f);return f;
}
export function assertBootstrapDecisionTime(d:BootstrapDecision,now:number){
  bootstrapCheck(Number.isFinite(now)&&now>=0,'BOOTSTRAP_CLOCK_INVALID');
  const issued=parseRfc3339Timestamp(d.issued_at),until=parseRfc3339Timestamp(d.valid_until);
  bootstrapCheck(issued!==null&&until!==null&&issued<=now&&now<until,'BOOTSTRAP_DECISION_NOT_CURRENT');
}
