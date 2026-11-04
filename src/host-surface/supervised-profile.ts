import { createHash } from 'node:crypto';
import { canonical } from '../job-runtime/store.ts';
import { parseD1UniqueJson } from '../job-runtime/contracts.ts';
import { decideD1Profile } from './d1-profile-entry.ts';
function need(v:unknown,c:string):asserts v{if(!v)throw Error(c);}
export function inspectSupervisedProfile(r:any,spec:any,read:(ref:any)=>string,projectId?:string){
  const p=r.profile,a=r.authorization;
  need(p&&a&&p.receipt_sha256===r.spec.sha256&&(!projectId||p.project_id===projectId)&&p.goal===spec.goal,'SUPERVISED_PROFILE_BINDING_INVALID');
  need(canonical(spec.entry_profile)===canonical({purpose:p.purpose,requested_profile:p.requested_profile,impact:p.impact}),'SUPERVISED_PROFILE_SPEC_MISMATCH');
  const source=parseD1UniqueJson(read({path:p.purpose_source?.source_ref,sha256:p.purpose_source?.source_sha256})) as any;
  const fields=['purpose','goal','requested_profile','impact','risk_categories','risk_reason','complexity','legacy_flow_difference_reason'];
  for(const key of fields)need(canonical(source[key])===canonical(p[key]),'SUPERVISED_PROFILE_SOURCE_MISMATCH');
  need(canonical(source.facts)===canonical({fake_data_only:p.facts?.fake_data_only,production_permissions:p.facts?.production_permissions,external_effects:p.facts?.external_effects,reversible:p.facts?.reversible}),'SUPERVISED_PROFILE_SOURCE_MISMATCH');
  for(const ref of p.facts.evidence_refs)read(ref);
  const decision=decideD1Profile(p,createHash('sha256').update(canonical(p)).digest('hex'),r.spec.sha256,p.project_id,'prototype',r.acceptance_criteria.map((c:any)=>c.id));
  need(Object.keys(a).sort().join('|')==='execution_limit|expires_at|implementation_limit|not_before|source|stop'&&a.implementation_limit===1&&a.execution_limit===1&&typeof a.stop==='boolean','SUPERVISED_AUTHORIZATION_INVALID');
  const terms={not_before:a.not_before,expires_at:a.expires_at,implementation_limit:a.implementation_limit,execution_limit:a.execution_limit,stop:a.stop};
  need([a.not_before,a.expires_at].every(t=>typeof t==='string'&&new Date(Date.parse(t)).toISOString()===t)&&a.not_before<a.expires_at,'SUPERVISED_AUTHORIZATION_TIME_INVALID');
  need(canonical(spec.authorization)===canonical(terms)&&canonical((parseD1UniqueJson(read(a.source)) as any).authorization)===canonical(terms),'SUPERVISED_AUTHORIZATION_SOURCE_MISMATCH');
  return {format:'xdev-supervised-entry-2',decision,authorization:a};
}
export function assertSupervisedWindow(entry:any,timeout=0){if(!entry)return;const a=entry.authorization,now=Date.now();need(!a.stop&&now>=Date.parse(a.not_before)&&now+timeout<Date.parse(a.expires_at),'SUPERVISED_AUTHORIZATION_STOP_OR_EXPIRED');}
