import { canonical } from '../job-runtime/store.ts';
import { inspectSupervisedAuthorization } from './supervised-profile.ts';
import { parsePreparationJson } from './supervised-preparation.ts';
function need(v:unknown,code:string):asserts v {if(!v)throw Error(code);}
function exact(v:any,keys:string[]) {need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|'),'SUPERVISED_REQUIREMENTS_SCHEMA_INVALID');}
const checks=['review','qa-execution','qa-session'];
/** The coordinator transfers an approved confirmation, not authenticated identity.
 * No inferred risk tier, default profile, Store or execution loop lives here. */
export function inspectSupervisedRequirements(r:any,spec:any,preparation:any,read:(ref:any)=>string,projectId:string,projectRoot:string) {
  need(!Object.hasOwn(spec,'entry_profile')&&!Object.hasOwn(spec,'profile'),'SUPERVISED_V5_PROFILE_FORBIDDEN');
  const q=r.check_requirements;
  exact(q,['format','artifact_kind','required_checks','checker_independence','review_qa_separation','behavior_criteria','regression_criteria']);
  need(q.format==='xdev-check-requirements-1','SUPERVISED_REQUIREMENTS_VERSION_UNSUPPORTED');
  need(q.artifact_kind==='formal_code','SUPERVISED_REQUIREMENTS_ARTIFACT_UNSUPPORTED');
  need(Array.isArray(q.required_checks)&&q.required_checks.length===checks.length&&new Set(q.required_checks).size===checks.length&&q.required_checks.every((c:unknown)=>checks.includes(c as string)),'SUPERVISED_FORMAL_CHECK_FLOOR_REQUIRED');
  need(q.checker_independence==='non_author'&&['distinct_checkers','same_checker_allowed'].includes(q.review_qa_separation),'SUPERVISED_REQUIREMENTS_INDEPENDENCE_REQUIRED');
  const ids=r.acceptance_criteria.map((c:any)=>c.id);
  for(const group of [q.behavior_criteria,q.regression_criteria])need(Array.isArray(group)&&group.length>0&&new Set(group).size===group.length&&group.every((id:unknown)=>ids.includes(id)),'SUPERVISED_BEHAVIOR_AND_REGRESSION_REQUIRED');
  need(ids.every((id:string)=>[...q.behavior_criteria,...q.regression_criteria].includes(id)),'SUPERVISED_REQUIREMENTS_COVERAGE_MISSING');
  need(canonical(spec.check_requirements)===canonical(q),'SUPERVISED_REQUIREMENTS_SPEC_MISMATCH');
  const confirmed=parsePreparationJson(read(preparation.confirmation_source)) as any;
  need(confirmed&&confirmed.source_claim==='COORDINATOR_RECORDED_OWNER_CONFIRMATION'&&confirmed.project_id===projectId&&confirmed.project_root===projectRoot&&canonical(confirmed.confirmed_spec)===canonical(r.spec)&&canonical(confirmed.check_requirements)===canonical(q),'SUPERVISED_REQUIREMENTS_CONFIRMATION_MISMATCH');
  const authorization=inspectSupervisedAuthorization(r.authorization,spec,read);
  // The typed preparation already retains the exact confirmation FileRef.
  // Duplicating it as an untyped graph reference would parse BOM/text through
  // the ordinary JSON reader when MCP reopens the persisted entry.
  return {format:'xdev-supervised-entry-3',requirements:q,authorization,preparation,native_identity_authenticated:false};
}
export function allowsCombinedChecker(c:any):boolean {
  if(c.request.format==='xdev-supervised-request-5')return c.entry?.requirements?.review_qa_separation==='same_checker_allowed';
  return ['xdev-supervised-request-2','xdev-supervised-request-3','xdev-supervised-request-4'].includes(c.request.format)&&c.entry?.decision?.selected_profile==='quick_verified';
}
