/** XDev-local execution control, not an engineering-state/XMem store.
 *
 * v1/v2 bindings sit on a pinned producer receipt and an existing budget store.
 * v3 is the R4.15 bootstrap state: it binds the current XDev project identity
 * and a private control root but has NO upstream execution-fact producer and NO
 * resource budget. v3 therefore exposes only an explicit INCOMPLETE/UNKNOWN,
 * globally stopped ProjectFacts view. It cannot reserve, execute, manufacture a
 * resource, or silently promote historical/workspace records to live facts.
 */
import {assertNativeSourceCurrent} from './native-project-source.ts';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,lstatSync,readFileSync,writeFileSync,openSync,fsyncSync,closeSync,renameSync,unlinkSync,rmdirSync} from 'node:fs';
import {dirname,join,resolve,isAbsolute,relative,sep} from 'node:path';
import {overlayBootstrapDecision,assertBootstrapDecisionTime,type BootstrapDecision} from './control-bootstrap-decision.ts';
import {canonicalJson} from '../planning/governance-contracts.ts';
import {parseUniqueJson,parseRfc3339Timestamp} from '../planning/retry-history.ts';
import {actionDigest,type Action,type AuthorizationFact,type ProjectFacts,type TaskFact,validateProjectFacts} from './admission.ts';
import {FileResourceBudget,budgetBindingDigest,type BudgetBinding,type BudgetSnapshotBoundary,observeBudgetJournal,type BudgetJournalObservation} from './file-resource-budget.ts';

type ControlBindingBase={project_id:string;authority_id:string;
  budget_root:string;budget_binding_sha256:string;source_ref:{path:string;sha256:string};scope_ref:string;valid_until:string};
export type UnboundControlBinding={
  format:'xdev-control-binding-3';mode:'UPSTREAM_UNBOUND_NO_BUDGET';project_id:string;authority_id:string;scope_ref:string;workspace_root:string;
  identity_ref:{identity_path:string;identity_sha256:string;bootstrap_path:string;bootstrap_sha256:string};
};
export type ControlBinding=(ControlBindingBase & ({format:'xdev-control-binding-1'}|{format:'xdev-control-binding-2';decision_ref:{path:string;sha256:string};activation_ref:{path:string;plan_sha256:string};registry_ref:{path:string;identity:string;claims:{path:string;sha256:string}[]}}))|UnboundControlBinding;
export type CurrentAllocationBudgetReceipt={
  format:'xdev-current-allocation-budget-1';state:'APPLIED';proposal_sha256:string;proposal_bytes_sha256:string;
  project_id:string;control_binding_sha256:string;allocation_id:string;allocation_ref:string;historical_relation:'NEW_CURRENT_ALLOCATION_NO_HISTORICAL_BALANCE_INFERENCE';
  task_fact:TaskFact;action:Action;resource_fact:ProjectFacts['resources'][number];authorization_fact:AuthorizationFact;
  budget_root:string;budget_binding:BudgetBinding;budget_binding_sha256:string;valid_until:string;applied_at:string;
  execution_permitted:false;reservation_created:false;worker_started:false;
};
/** support is an alias for immutable_support only; never includes the journal. */
export type CurrentAllocationBudgetAttachment={receipt:CurrentAllocationBudgetReceipt;stale:boolean;support:{path:string;sha256:string}[];immutable_support:{path:string;sha256:string}[];budget_observation:BudgetJournalObservation};
export type FinalReserveSourceReceipt={
  format:'xdev-final-reserve-source-1';state:'APPLIED';proposal_sha256:string;proposal_bytes_sha256:string;project_id:string;control_binding_sha256:string;
  task_id:string;action_id:string;authorization_id:string;resource_id:string;allocation_id:string;budget_root:string;action_sha256:string;
  control_revision:number;control_state_digest:string;finalization_valid_until:string;support_refs:{path:string;sha256:string}[];applied_at:string;
  scope:'CURRENT_XDEV_PROJECT_RESERVE_ONLY_CONTROL_DOMAIN';
  charges_treatment:'NEW_CURRENT_ALLOCATION_RESERVE_ONLY_NO_EXECUTION_CHARGE_WRITER_ZERO_CURRENT_CHARGES';
  stop_unknown_treatment:'CURRENT_CONTROL_STATE_AUTHORITATIVE_BOOTSTRAP_PLACEHOLDER_SUPERSEDED_WORKSPACE_HISTORY_PRESERVED_AS_EVIDENCE';
  identity_treatment:'XDEV_CONTROL_IDENTITY_SUFFICIENT_RESERVE_ONLY_NO_HOST_WORKER';
  historical_constraints:'PRESERVE_LEGACY_RECORDS_NO_CURRENT_PROJECT_REBIND_NO_OLD_STOP_CLEARANCE';
  bootstrap_placeholder:'SUPERSEDE_REAL_CONTROL_SOURCE_UPSTREAM_UNBOUND_ONLY';old_stop_cleared:false;execution_permitted:false;reservation_created:false;worker_started:false;
};
export type FinalReserveSourceAttachment={receipt:FinalReserveSourceReceipt;stale:boolean;support:{path:string;sha256:string}[]};
export type CurrentAllocationRenewalReceipt={
  format:'xdev-current-allocation-renewal-1';state:'APPLIED';proposal_sha256:string;proposal_bytes_sha256:string;project_id:string;control_binding_sha256:string;
  base_allocation_proposal_sha256:string;allocation_id:string;allocation_ref:string;resource_id:string;authorization_id:string;action_id:string;budget_root:string;budget_binding_sha256:string;
  prior_authorization_valid_until:string;renewed_authorization_valid_until:string;owner_scope_proposal_sha256:string;applied_at:string;execution_permitted:false;reservation_created:false;worker_started:false;
};
type RestrictionOp={kind:'REVOKE_AUTHORIZATION';authorization_id:string}|{kind:'LOWER_LIMIT';resource_id:string;limit:number}|{kind:'ADD_GLOBAL_STOP';stop_id:string};
export type ControlRestriction={format:'xdev-control-restriction-1';change_id:string;expected_revision:number;expected_digest:string;evidence_ref:string;operations:RestrictionOp[]};
type State={format:'xdev-control-state-1';binding_sha256:string;revision:number;
  changes:{change:ControlRestriction;change_sha256:string}[]};
export const controlDigest=(v:unknown)=>createHash('sha256').update(canonicalJson(v as any)).digest('hex');
const check=(ok:unknown,code:string)=>{if(!ok)throw Error(code);};
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v:any,k:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...k].sort().join(',');
export function controlNoLinks(p:string){
  check(isAbsolute(p)&&resolve(p)===p,'CONTROL_PATH_NOT_CANONICAL');
  for(let q=p;;q=dirname(q)){try{check(!lstatSync(q).isSymbolicLink(),'CONTROL_LINK');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}if(dirname(q)===q)break;}
}
export function readControlBytes(p:string):Buffer{
  controlNoLinks(p);const st=lstatSync(p);check(st.isFile()&&st.nlink===1&&st.size<=8*1024*1024,'CONTROL_FILE_UNSAFE');return readFileSync(p);
}
const read=(p:string)=>parseUniqueJson(readControlBytes(p).toString('utf8'));

const allocationPaths=(root:string)=>({proposal:join(root,'current-allocation-budget-proposal.json'),receipt:join(root,'current-allocation-budget.json'),renewalProposal:join(root,'current-allocation-renewal-proposal.json'),renewalReceipt:join(root,'current-allocation-renewal.json')});
const finalReservePaths=(root:string)=>({proposal:join(root,'final-reserve-source-proposal.json'),receipt:join(root,'final-reserve-source.json'),action:join(root,'final-reserve-action.json')});
function validateAllocationReceipt(v:any):asserts v is CurrentAllocationBudgetReceipt{
  check(exact(v,['format','state','proposal_sha256','proposal_bytes_sha256','project_id','control_binding_sha256','allocation_id','allocation_ref','historical_relation','task_fact','action','resource_fact','authorization_fact','budget_root','budget_binding','budget_binding_sha256','valid_until','applied_at','execution_permitted','reservation_created','worker_started'])&&v.format==='xdev-current-allocation-budget-1'&&v.state==='APPLIED','CONTROL_CURRENT_ALLOCATION_INVALID');
  check([v.proposal_sha256,v.proposal_bytes_sha256,v.control_binding_sha256,v.budget_binding_sha256].every(sha)&&[v.project_id,v.allocation_id,v.allocation_ref,v.budget_root].every(text)&&v.historical_relation==='NEW_CURRENT_ALLOCATION_NO_HISTORICAL_BALANCE_INFERENCE'&&parseRfc3339Timestamp(v.valid_until)!==null&&parseRfc3339Timestamp(v.applied_at)!==null&&v.execution_permitted===false&&v.reservation_created===false&&v.worker_started===false,'CONTROL_CURRENT_ALLOCATION_INVALID');
  controlNoLinks(v.budget_root);check(budgetBindingDigest(v.budget_binding)===v.budget_binding_sha256&&v.budget_binding.project_id===v.project_id&&v.budget_binding.authority_id===v.authorization_fact.authorization_id&&v.budget_binding.resource_ids.length===1&&v.budget_binding.resource_ids[0]===v.resource_fact.resource_id,'CONTROL_CURRENT_ALLOCATION_BUDGET_BINDING_INVALID');
  actionDigest(v.action);check(v.action.project_id===v.project_id&&v.action.task_id===v.task_fact.task_id&&v.action.authorization_id===v.authorization_fact.authorization_id&&v.action.contract_sha256===v.task_fact.contract_sha256,'CONTROL_CURRENT_ALLOCATION_ACTION_INVALID');
  const facts:ProjectFacts={format:'xdev-execution-source-1',execution_restriction:'RESERVATION_ONLY',control_action_sha256:actionDigest(v.action),project_id:v.project_id,revision:'current-allocation-validation',coverage:'INCOMPLETE',freshness:'UNKNOWN',evidence_refs:[v.allocation_ref],compatibility:{policy:null,adoption_ref:null},tasks:[structuredClone(v.task_fact)],resources:[structuredClone(v.resource_fact)],charges:[],reservations:[],unknowns:[],stops:[],authorizations:[structuredClone(v.authorization_fact)]};validateProjectFacts(facts);
  check(v.authorization_fact.action_id===v.action.action_id&&v.authorization_fact.purpose==='RESERVE_ONLY'&&v.authorization_fact.revoked===false&&v.authorization_fact.expires_at===v.valid_until&&v.authorization_fact.reservations.length===1&&v.authorization_fact.reservations[0].resource_id===v.resource_fact.resource_id&&v.authorization_fact.reservations[0].units===1&&v.resource_fact.unit==='DISPATCH_SLOT'&&v.resource_fact.limit===1,'CONTROL_CURRENT_ALLOCATION_FACT_INVALID');
}
function validateAllocationRenewalReceipt(v:any):asserts v is CurrentAllocationRenewalReceipt{
  check(exact(v,['format','state','proposal_sha256','proposal_bytes_sha256','project_id','control_binding_sha256','base_allocation_proposal_sha256','allocation_id','allocation_ref','resource_id','authorization_id','action_id','budget_root','budget_binding_sha256','prior_authorization_valid_until','renewed_authorization_valid_until','owner_scope_proposal_sha256','applied_at','execution_permitted','reservation_created','worker_started'])&&v.format==='xdev-current-allocation-renewal-1'&&v.state==='APPLIED','CONTROL_CURRENT_ALLOCATION_RENEWAL_INVALID');
  check([v.proposal_sha256,v.proposal_bytes_sha256,v.control_binding_sha256,v.base_allocation_proposal_sha256,v.budget_binding_sha256,v.owner_scope_proposal_sha256].every(sha)&&[v.project_id,v.allocation_id,v.allocation_ref,v.resource_id,v.authorization_id,v.action_id].every(text)&&parseRfc3339Timestamp(v.prior_authorization_valid_until)!==null&&parseRfc3339Timestamp(v.renewed_authorization_valid_until)!==null&&parseRfc3339Timestamp(v.applied_at)!==null&&v.execution_permitted===false&&v.reservation_created===false&&v.worker_started===false,'CONTROL_CURRENT_ALLOCATION_RENEWAL_INVALID');
  controlNoLinks(v.budget_root);
}
function overlayAllocationRenewal(root:string,p:ReturnType<typeof allocationPaths>,bindingSha:string,receipt:CurrentAllocationBudgetReceipt,support:{path:string;sha256:string}[]){
  const hasP=existsSync(p.renewalProposal),hasR=existsSync(p.renewalReceipt);if(!hasP&&!hasR)return receipt;check(hasP&&hasR,'CONTROL_CURRENT_ALLOCATION_RENEWAL_PARTIAL_MANUAL_REVIEW_REQUIRED');
  const proposalBytes=readControlBytes(p.renewalProposal),renewal=parseUniqueJson(readControlBytes(p.renewalReceipt).toString('utf8'));validateAllocationRenewalReceipt(renewal);
  check(renewal.control_binding_sha256===bindingSha&&renewal.project_id===receipt.project_id&&renewal.base_allocation_proposal_sha256===receipt.proposal_sha256&&renewal.allocation_id===receipt.allocation_id&&renewal.allocation_ref===receipt.allocation_ref&&renewal.resource_id===receipt.resource_fact.resource_id&&renewal.authorization_id===receipt.authorization_fact.authorization_id&&renewal.action_id===receipt.action.action_id&&renewal.budget_root===receipt.budget_root&&renewal.budget_binding_sha256===receipt.budget_binding_sha256&&renewal.prior_authorization_valid_until===receipt.authorization_fact.expires_at,'CONTROL_CURRENT_ALLOCATION_RENEWAL_BINDING_MISMATCH');
  check(renewal.proposal_bytes_sha256===createHash('sha256').update(proposalBytes).digest('hex'),'CONTROL_CURRENT_ALLOCATION_RENEWAL_PROPOSAL_DRIFT');
  const proposal=parseUniqueJson(proposalBytes.toString('utf8')) as any;check(proposal?.format==='xdev-current-allocation-renewal-proposal-1'&&proposal.proposal_sha256===renewal.proposal_sha256&&proposal.renewed_authorization_valid_until===renewal.renewed_authorization_valid_until&&proposal.owner_scope?.proposal_sha256===renewal.owner_scope_proposal_sha256,'CONTROL_CURRENT_ALLOCATION_RENEWAL_PROPOSAL_INVALID');
  const effective=structuredClone(receipt);effective.valid_until=renewal.renewed_authorization_valid_until;effective.authorization_fact.expires_at=renewal.renewed_authorization_valid_until;effective.authorization_fact.evidence_ref='current-allocation-renewal:'+renewal.proposal_sha256;support.push(...[p.renewalProposal,p.renewalReceipt].map(path=>({path,sha256:createHash('sha256').update(readControlBytes(path)).digest('hex')})));return effective;
}
export function readCurrentAllocationBudgetAttachment(rootInput:string,bindingSha:string,clock:()=>number=Date.now):CurrentAllocationBudgetAttachment|null{
  const root=resolve(rootInput);controlNoLinks(root);check(sha(bindingSha),'CONTROL_CURRENT_ALLOCATION_BINDING_INVALID');const p=allocationPaths(root),hasP=existsSync(p.proposal),hasR=existsSync(p.receipt);if(!hasP&&!hasR)return null;check(hasP&&hasR,'CONTROL_CURRENT_ALLOCATION_PARTIAL_MANUAL_REVIEW_REQUIRED');
  const proposalBytes=readControlBytes(p.proposal),receipt=parseUniqueJson(readControlBytes(p.receipt).toString('utf8'));validateAllocationReceipt(receipt);check(receipt.control_binding_sha256===bindingSha&&receipt.proposal_bytes_sha256===createHash('sha256').update(proposalBytes).digest('hex'),'CONTROL_CURRENT_ALLOCATION_BINDING_MISMATCH');
  const budgetBinding=read(join(receipt.budget_root,'binding.json')) as BudgetBinding;check(budgetBindingDigest(budgetBinding)===receipt.budget_binding_sha256&&controlDigest(budgetBinding)===controlDigest(receipt.budget_binding),'CONTROL_CURRENT_ALLOCATION_BUDGET_DRIFT');
  const peer=read(join(receipt.budget_root,'control-source-binding.json')) as any;check(exact(peer,['control_root','binding_sha256'])&&peer.control_root===root&&peer.binding_sha256===bindingSha,'CONTROL_BUDGET_PEER_MISMATCH');
  const budget_observation=observeBudgetJournal(receipt.budget_root,receipt.budget_binding_sha256);
  const support=[p.proposal,p.receipt,join(receipt.budget_root,'binding.json'),join(receipt.budget_root,'control-source-binding.json')].map(path=>({path,sha256:createHash('sha256').update(readControlBytes(path)).digest('hex')}));
  const effective=overlayAllocationRenewal(root,p,bindingSha,structuredClone(receipt),support);const now=clock();check(Number.isFinite(now)&&now>=0,'CONTROL_TIME_INVALID');const until=parseRfc3339Timestamp(effective.valid_until)!;
  return{receipt:effective,stale:now>=until,support,immutable_support:support,budget_observation};
}
function validateFinalReserveReceipt(v:any):asserts v is FinalReserveSourceReceipt{
  check(exact(v,['format','state','proposal_sha256','proposal_bytes_sha256','project_id','control_binding_sha256','task_id','action_id','authorization_id','resource_id','allocation_id','budget_root','action_sha256','control_revision','control_state_digest','finalization_valid_until','support_refs','applied_at','scope','charges_treatment','stop_unknown_treatment','identity_treatment','historical_constraints','bootstrap_placeholder','old_stop_cleared','execution_permitted','reservation_created','worker_started'])&&v.format==='xdev-final-reserve-source-1'&&v.state==='APPLIED','CONTROL_FINAL_RESERVE_SOURCE_INVALID');
  check([v.proposal_sha256,v.proposal_bytes_sha256,v.control_binding_sha256,v.action_sha256,v.control_state_digest].every(sha)&&[v.project_id,v.task_id,v.action_id,v.authorization_id,v.resource_id,v.allocation_id,v.budget_root].every(text)&&Number.isSafeInteger(v.control_revision)&&v.control_revision>=0&&parseRfc3339Timestamp(v.finalization_valid_until)!==null&&parseRfc3339Timestamp(v.applied_at)!==null&&Array.isArray(v.support_refs)&&v.support_refs.length>=6&&v.support_refs.length<=128,'CONTROL_FINAL_RESERVE_SOURCE_INVALID');
  controlNoLinks(v.budget_root);const seen=new Set<string>();for(const r of v.support_refs){check(exact(r,['path','sha256'])&&text(r.path)&&sha(r.sha256)&&!seen.has(r.path),'CONTROL_FINAL_RESERVE_SUPPORT_INVALID');controlNoLinks(r.path);seen.add(r.path);}
  check(v.scope==='CURRENT_XDEV_PROJECT_RESERVE_ONLY_CONTROL_DOMAIN'&&v.charges_treatment==='NEW_CURRENT_ALLOCATION_RESERVE_ONLY_NO_EXECUTION_CHARGE_WRITER_ZERO_CURRENT_CHARGES'&&v.stop_unknown_treatment==='CURRENT_CONTROL_STATE_AUTHORITATIVE_BOOTSTRAP_PLACEHOLDER_SUPERSEDED_WORKSPACE_HISTORY_PRESERVED_AS_EVIDENCE'&&v.identity_treatment==='XDEV_CONTROL_IDENTITY_SUFFICIENT_RESERVE_ONLY_NO_HOST_WORKER'&&v.historical_constraints==='PRESERVE_LEGACY_RECORDS_NO_CURRENT_PROJECT_REBIND_NO_OLD_STOP_CLEARANCE'&&v.bootstrap_placeholder==='SUPERSEDE_REAL_CONTROL_SOURCE_UPSTREAM_UNBOUND_ONLY'&&v.old_stop_cleared===false&&v.execution_permitted===false&&v.reservation_created===false&&v.worker_started===false,'CONTROL_FINAL_RESERVE_SOURCE_SEMANTICS_INVALID');
}
export function readFinalReserveSourceAttachment(rootInput:string,bindingSha:string,clock:()=>number=Date.now):FinalReserveSourceAttachment|null{
  const root=resolve(rootInput);controlNoLinks(root);check(sha(bindingSha),'CONTROL_FINAL_RESERVE_BINDING_INVALID');const p=finalReservePaths(root),hasP=existsSync(p.proposal),hasR=existsSync(p.receipt),hasA=existsSync(p.action);if(!hasP&&!hasR&&!hasA)return null;check(hasP&&hasR&&hasA,'CONTROL_FINAL_RESERVE_PARTIAL_MANUAL_REVIEW_REQUIRED');
  const proposalBytes=readControlBytes(p.proposal),receipt=parseUniqueJson(readControlBytes(p.receipt).toString('utf8'));validateFinalReserveReceipt(receipt);check(receipt.control_binding_sha256===bindingSha&&receipt.proposal_bytes_sha256===createHash('sha256').update(proposalBytes).digest('hex'),'CONTROL_FINAL_RESERVE_BINDING_MISMATCH');const proposal=parseUniqueJson(proposalBytes.toString('utf8')) as any;check(proposal?.format==='xdev-final-reserve-source-proposal-1'&&proposal.proposal_sha256===receipt.proposal_sha256&&proposal.project_id===receipt.project_id&&proposal.control_binding_sha256===bindingSha&&proposal.finalization_valid_until===receipt.finalization_valid_until&&proposal.control_state_digest===receipt.control_state_digest&&proposal.control_revision===receipt.control_revision,'CONTROL_FINAL_RESERVE_PROPOSAL_INVALID');
  for(const r of receipt.support_refs)check(createHash('sha256').update(readControlBytes(r.path)).digest('hex')===r.sha256,'CONTROL_FINAL_RESERVE_SUPPORT_DRIFT');const action=parseUniqueJson(readControlBytes(p.action).toString('utf8')) as Action;check(actionDigest(action)===receipt.action_sha256&&action.project_id===receipt.project_id&&action.task_id===receipt.task_id&&action.action_id===receipt.action_id&&action.authorization_id===receipt.authorization_id,'CONTROL_FINAL_RESERVE_ACTION_DRIFT');
  const state=read(join(root,'control.json')) as State;check(state.revision===receipt.control_revision&&controlDigest(state)===receipt.control_state_digest,'CONTROL_FINAL_RESERVE_CONTROL_DRIFT');const allocation=readCurrentAllocationBudgetAttachment(root,bindingSha,clock);if(!allocation)throw Error('CONTROL_FINAL_RESERVE_ALLOCATION_MISSING');check(allocation.receipt.project_id===receipt.project_id&&allocation.receipt.allocation_id===receipt.allocation_id&&allocation.receipt.resource_fact.resource_id===receipt.resource_id&&allocation.receipt.authorization_fact.authorization_id===receipt.authorization_id&&allocation.receipt.action.action_id===receipt.action_id&&allocation.receipt.budget_root===receipt.budget_root,'CONTROL_FINAL_RESERVE_ALLOCATION_DRIFT');
  const now=clock();check(Number.isFinite(now)&&now>=0,'CONTROL_TIME_INVALID');const until=parseRfc3339Timestamp(receipt.finalization_valid_until)!;const support=[p.proposal,p.receipt,p.action,...receipt.support_refs.map(r=>r.path)].map(path=>({path,sha256:createHash('sha256').update(readControlBytes(path)).digest('hex')}));return{receipt,stale:now>=until||allocation.stale,support};
}
function writeAtomic(p:string,value:unknown){
  controlNoLinks(p);const tmp=p+'.'+randomUUID()+'.tmp';let fd:number|undefined;
  try{fd=openSync(tmp,'wx',0o600);writeFileSync(fd,canonicalJson(value as any));fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(tmp,p);}
  finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(tmp);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function assertIdentityRef(ref:UnboundControlBinding['identity_ref']){
  check(exact(ref,['identity_path','identity_sha256','bootstrap_path','bootstrap_sha256'])&&sha(ref.identity_sha256)&&sha(ref.bootstrap_sha256),'CONTROL_IDENTITY_REFERENCE_INVALID');
  controlNoLinks(ref.identity_path);controlNoLinks(ref.bootstrap_path);
}
function bindingValid(b:ControlBinding){
  check(b&&['xdev-control-binding-1','xdev-control-binding-2','xdev-control-binding-3'].includes(b.format),'CONTROL_BINDING_INVALID');
  if(b.format==='xdev-control-binding-3'){
    check(exact(b,['format','mode','project_id','authority_id','scope_ref','workspace_root','identity_ref'])&&b.mode==='UPSTREAM_UNBOUND_NO_BUDGET','CONTROL_BINDING_INVALID');
    check([b.project_id,b.authority_id,b.scope_ref,b.workspace_root].every(text),'CONTROL_BINDING_INVALID');controlNoLinks(b.workspace_root);assertIdentityRef(b.identity_ref);return;
  }
  const fields=['format','project_id','authority_id','budget_root','budget_binding_sha256','source_ref','scope_ref','valid_until'];
  if(b.format==='xdev-control-binding-2'){
    fields.push('decision_ref','activation_ref','registry_ref');
    check(exact(b.registry_ref,['path','identity','claims'])&&text(b.registry_ref.identity)&&Array.isArray(b.registry_ref.claims)&&b.registry_ref.claims.length>0,'CONTROL_REGISTRY_REFERENCE_INVALID');
    controlNoLinks(b.registry_ref.path);
    for(const c of b.registry_ref.claims){check(exact(c,['path','sha256'])&&sha(c.sha256),'CONTROL_REGISTRY_REFERENCE_INVALID');controlNoLinks(c.path);}
    check(exact(b.decision_ref,['path','sha256'])&&sha(b.decision_ref.sha256),'CONTROL_DECISION_REFERENCE_INVALID');
    check(exact(b.activation_ref,['path','plan_sha256'])&&sha(b.activation_ref.plan_sha256),'CONTROL_ACTIVATION_REFERENCE_INVALID');
    controlNoLinks(b.decision_ref.path);controlNoLinks(b.activation_ref.path);
  }
  check(exact(b,fields),'CONTROL_BINDING_INVALID');
  check([b.project_id,b.authority_id,b.scope_ref].every(text)&&sha(b.budget_binding_sha256),'CONTROL_BINDING_INVALID');
  check(exact(b.source_ref,['path','sha256'])&&text(b.source_ref.path)&&sha(b.source_ref.sha256),'CONTROL_SOURCE_REFERENCE_INVALID');
  controlNoLinks(b.budget_root);controlNoLinks(b.source_ref.path);
  check(parseRfc3339Timestamp(b.valid_until)!==null,'CONTROL_VALIDITY_INVALID');
}
export function controlBindingDigest(binding:ControlBinding){bindingValid(binding);return controlDigest(binding);}
function validateChange(c:ControlRestriction){
  check(exact(c,['format','change_id','expected_revision','expected_digest','evidence_ref','operations'])&&c.format==='xdev-control-restriction-1','CONTROL_CHANGE_INVALID');
  check(text(c.change_id)&&text(c.evidence_ref)&&Number.isSafeInteger(c.expected_revision)&&c.expected_revision>=0&&sha(c.expected_digest)&&Array.isArray(c.operations)&&c.operations.length>0,'CONTROL_CHANGE_INVALID');
  const seen=new Set<string>();
  for(const o of c.operations){
    check(o&&typeof o==='object','CONTROL_OPERATION_INVALID');let key:string;
    switch(o.kind){
      case 'REVOKE_AUTHORIZATION':check(exact(o,['kind','authorization_id'])&&text(o.authorization_id),'CONTROL_OPERATION_INVALID');key=o.kind+':'+o.authorization_id;break;
      case 'LOWER_LIMIT':check(exact(o,['kind','resource_id','limit'])&&text(o.resource_id)&&Number.isSafeInteger(o.limit)&&o.limit>=0,'CONTROL_OPERATION_INVALID');key=o.kind+':'+o.resource_id;break;
      case 'ADD_GLOBAL_STOP':check(exact(o,['kind','stop_id'])&&text(o.stop_id),'CONTROL_OPERATION_INVALID');key=o.kind+':'+o.stop_id;break;
      default:throw Error('CONTROL_OPERATION_NOT_SUPPORTED');
    }
    check(!seen.has(key),'CONTROL_OPERATION_DUPLICATE');seen.add(key);
  }
}
export function controlChangeDigest(change:ControlRestriction){validateChange(change);return controlDigest(change);}
function verifyIdentityBinding(b:UnboundControlBinding){
  const identityBytes=readControlBytes(b.identity_ref.identity_path),receiptBytes=readControlBytes(b.identity_ref.bootstrap_path);
  check(createHash('sha256').update(identityBytes).digest('hex')===b.identity_ref.identity_sha256,'CONTROL_PROJECT_IDENTITY_DRIFT');
  check(createHash('sha256').update(receiptBytes).digest('hex')===b.identity_ref.bootstrap_sha256,'CONTROL_PROJECT_IDENTITY_RECEIPT_DRIFT');
  const identity=parseUniqueJson(identityBytes.toString('utf8')) as any,receipt=parseUniqueJson(receiptBytes.toString('utf8')) as any;
  check(identity?.format==='xdev-real-control-root-identity-1'&&identity.project_id===b.project_id&&identity.workspace_root===b.workspace_root,'CONTROL_PROJECT_IDENTITY_MISMATCH');
  check(receipt?.format==='xdev-project-identity-receipt-1'&&receipt.state==='APPLIED'&&receipt.project_id===b.project_id&&receipt.workspace_root===b.workspace_root,'CONTROL_PROJECT_IDENTITY_RECEIPT_MISMATCH');
}
function unboundFacts(binding:UnboundControlBinding,bindingSha:string,state:State,root?:string,clock:()=>number=Date.now):ProjectFacts{
  verifyIdentityBinding(binding);const evidence=`real-control-source-binding:${bindingSha}`,missing='REAL_UPSTREAM_EXECUTION_FACT_SOURCE_NOT_ATTACHED';
  const scope={extent:'UNBOUNDED' as const,task_ids:[],root_ids:[],resource_ids:[],workspace_ids:[],evidence_refs:[evidence]};
  const f:ProjectFacts={format:'xdev-execution-source-1',project_id:binding.project_id,revision:'real-control-source-unbound:'+controlDigest({binding:bindingSha,state}),coverage:'INCOMPLETE',freshness:'UNKNOWN',evidence_refs:[evidence,'project-identity:'+binding.identity_ref.identity_sha256,'project-identity-receipt:'+binding.identity_ref.bootstrap_sha256],compatibility:{policy:null,adoption_ref:null},tasks:[],resources:[],charges:[],reservations:[],unknowns:[{fact_id:'real-control-source:upstream-unbound',legacy:false,scope,reason:missing}],stops:[{stop_id:'real-control-source:upstream-unbound',scope,active:true,evidence_ref:evidence}],authorizations:[]};
  if(root){const allocation=readCurrentAllocationBudgetAttachment(root,bindingSha,clock);if(allocation){const a=allocation.receipt;f.tasks=[structuredClone(a.task_fact)];f.resources=[structuredClone(a.resource_fact)];f.authorizations=[structuredClone(a.authorization_fact)];f.execution_restriction='RESERVATION_ONLY';f.control_action_sha256=actionDigest(a.action);f.evidence_refs.push(a.allocation_ref,'current-allocation-budget:'+a.proposal_sha256);if(allocation.stale)f.unknowns.push({fact_id:'current-allocation:expired',legacy:false,scope:{extent:'BOUNDED_VERIFIED',task_ids:[a.task_fact.task_id],root_ids:[a.task_fact.root_id],resource_ids:[a.resource_fact.resource_id],workspace_ids:[a.task_fact.workspace_id],evidence_refs:[a.allocation_ref]},reason:'CURRENT_ALLOCATION_EXPIRED'});}
    const final=readFinalReserveSourceAttachment(root,bindingSha,clock);if(final&&!final.stale&&allocation&&!allocation.stale){f.coverage='COMPLETE_PROJECT';f.freshness='CURRENT';f.unknowns=[];f.stops=[];f.charges=[];f.compatibility={policy:null,adoption_ref:null};f.evidence_refs.push('final-reserve-source:'+final.receipt.proposal_sha256,'historical-constraints:'+final.receipt.historical_constraints,'bootstrap-placeholder:'+final.receipt.bootstrap_placeholder);}
  }
  validateProjectFacts(f);return f;
}
function consumeReceipt(binding:ControlBinding,clock:()=>number=Date.now):ProjectFacts{
  if(binding.format==='xdev-control-binding-3')return unboundFacts(binding,controlBindingDigest(binding),{format:'xdev-control-state-1',binding_sha256:controlBindingDigest(binding),revision:0,changes:[]},undefined,clock);
  const bytes=readControlBytes(binding.source_ref.path);check(createHash('sha256').update(bytes).digest('hex')===binding.source_ref.sha256,'CONTROL_SOURCE_DRIFT');
  const f=readJsonFacts(bytes);check(f.project_id===binding.project_id,'CONTROL_SOURCE_PROJECT_MISMATCH');
  if(Object.hasOwn(f,'native_source'))assertNativeSourceCurrent(f,clock());
  if(binding.format==='xdev-control-binding-2'){
    const d=readBoundDecision(binding);
    return overlayBootstrapDecision(f,d);
  }return f;
}
function readBoundDecision(b:ControlBinding & {format:'xdev-control-binding-2'}):BootstrapDecision {
  const bytes=readControlBytes(b.decision_ref.path);check(createHash('sha256').update(bytes).digest('hex')===b.decision_ref.sha256,'CONTROL_DECISION_DRIFT');
  const d=parseUniqueJson(bytes.toString('utf8')) as BootstrapDecision;check(d.source_sha256===b.source_ref.sha256&&d.project_id===b.project_id&&d.valid_until===b.valid_until&&d.scope_ref===b.scope_ref,'CONTROL_DECISION_BINDING_MISMATCH');return d;
}
function readJsonFacts(bytes:Buffer):ProjectFacts{const f=parseUniqueJson(bytes.toString('utf8'));validateProjectFacts(f);return f;}
/** Trusted budget-backed integration bootstrap only. */
export function initializeControlSource(rootInput:string,binding:ControlBinding,confirmation:string){
  check(binding.format!=='xdev-control-binding-3','CONTROL_UNBOUND_BINDING_REQUIRES_UNBOUND_INITIALIZER');
  const b=structuredClone(binding) as Exclude<ControlBinding,UnboundControlBinding>,digest=controlBindingDigest(binding);check(digest===confirmation,'CONTROL_CONFIRMATION_MISMATCH');
  const root=resolve(rootInput);controlNoLinks(root);
  const inside=(a:string,p:string)=>{const r=relative(a,p);return r===''||!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep);};
  check(!inside(root,b.source_ref.path)&&!inside(root,b.budget_root)&&!inside(b.budget_root,root),'CONTROL_DIRECTORIES_OVERLAP');
  consumeReceipt(b);
  const budgetBinding=read(join(b.budget_root,'binding.json')) as BudgetBinding;
  check(budgetBindingDigest(budgetBinding)===b.budget_binding_sha256&&budgetBinding.project_id===b.project_id,'CONTROL_BUDGET_BINDING_MISMATCH');
  const lock=join(b.budget_root,'transaction.lock');controlNoLinks(lock);
  try{mkdirSync(lock,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('BUDGET_BUSY_OR_OWNER_UNKNOWN');throw e;}
  try{
    const peer=join(b.budget_root,'control-source-binding.json');
    try{lstatSync(peer);throw Error('CONTROL_BUDGET_ALREADY_PAIRED');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    mkdirSync(root,{mode:0o700});writeAtomic(join(root,'binding.json'),b);
    writeAtomic(join(root,'control.json'),{format:'xdev-control-state-1',binding_sha256:digest,revision:0,changes:[]} satisfies State);
    let fd:number|undefined;try{fd=openSync(peer,'wx',0o600);writeFileSync(fd,canonicalJson({control_root:root,binding_sha256:digest}));fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}
  }finally{rmdirSync(lock);}
  return{binding_sha256:digest,execution_permitted:false};
}
/** R4.15 bootstrap: establishes a real control root bound only to the current
 * XDev project identity. No producer, resource or budget is created. */
export function initializeUnboundControlSource(rootInput:string,bindingInput:UnboundControlBinding,confirmation:string){
  const b=structuredClone(bindingInput);bindingValid(b);const digest=controlBindingDigest(b);check(digest===confirmation,'CONTROL_CONFIRMATION_MISMATCH');
  const root=resolve(rootInput);controlNoLinks(root);
  const inside=(a:string,p:string)=>{const r=relative(a,p);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));};
  check(!inside(b.workspace_root,root)&&!inside(root,b.workspace_root),'CONTROL_DIRECTORIES_OVERLAP');verifyIdentityBinding(b);
  mkdirSync(root,{mode:0o700});writeAtomic(join(root,'binding.json'),b);writeAtomic(join(root,'control.json'),{format:'xdev-control-state-1',binding_sha256:digest,revision:0,changes:[]} satisfies State);
  return{binding_sha256:digest,status:'REAL_CONTROL_SOURCE_DEPLOYED_UPSTREAM_UNBOUND' as const,execution_permitted:false,reservation_created:false,worker_started:false};
}
export class FileControlSourceBoundary implements BudgetSnapshotBoundary {
  readonly root:string;readonly binding:ControlBinding;readonly binding_sha256:string;
  readonly controlSourceIdentity:{control_root:string;binding_sha256:string};
  private readonly identity:string;private readonly clock:()=>number;
  constructor(rootInput:string,expectedDigest:string,clock:()=>number=Date.now){
    this.root=resolve(rootInput);controlNoLinks(this.root);const s=lstatSync(this.root);check(s.isDirectory(),'CONTROL_ROOT_INVALID');this.identity=`${s.dev}:${s.ino}`;
    this.binding=read(join(this.root,'binding.json')) as ControlBinding;this.binding_sha256=controlBindingDigest(this.binding);
    check(this.binding_sha256===expectedDigest,'CONTROL_BINDING_MISMATCH');freeze(this.binding);this.clock=clock;
    this.controlSourceIdentity=freeze({control_root:this.root,binding_sha256:this.binding_sha256});this.rootCheck();this.load();
  }
  get budgetBacked(){return this.binding.format!=='xdev-control-binding-3'||readCurrentAllocationBudgetAttachment(this.root,this.binding_sha256,this.clock)!==null;}
  private rootCheck(){
    controlNoLinks(this.root);const s=lstatSync(this.root);check(s.isDirectory()&&`${s.dev}:${s.ino}`===this.identity,'CONTROL_ROOT_REPLACED');
    check(controlBindingDigest(read(join(this.root,'binding.json')) as ControlBinding)===this.binding_sha256,'CONTROL_BINDING_MISMATCH');
    if(this.binding.format==='xdev-control-binding-3'){verifyIdentityBinding(this.binding);readCurrentAllocationBudgetAttachment(this.root,this.binding_sha256,this.clock);return;}
    check(controlDigest(read(join(this.binding.budget_root,'control-source-binding.json')))===controlDigest(this.controlSourceIdentity),'CONTROL_BUDGET_PEER_MISMATCH');
    if(this.binding.format==='xdev-control-binding-2'){
      const reg=lstatSync(this.binding.registry_ref.path);controlNoLinks(this.binding.registry_ref.path);
      check(reg.isDirectory()&&`${reg.dev}:${reg.ino}`===this.binding.registry_ref.identity,'CONTROL_REGISTRY_REPLACED');
      for(const c of this.binding.registry_ref.claims)check(createHash('sha256').update(readControlBytes(c.path)).digest('hex')===c.sha256,'CONTROL_RESOURCE_CLAIM_CHANGED');
      const a=read(this.binding.activation_ref.path) as any;
      check(a&&a.format==='xdev-control-bootstrap-receipt-1'&&a.state==='APPLIED'&&a.plan_sha256===this.binding.activation_ref.plan_sha256&&a.control_root===this.root&&a.control_binding_sha256===this.binding_sha256&&a.budget_root===this.binding.budget_root,'CONTROL_BOOTSTRAP_NOT_ACTIVATED');
    }
  }
  private load():State{
    const s=read(join(this.root,'control.json')) as State;
    check(exact(s,['format','binding_sha256','revision','changes'])&&s.format==='xdev-control-state-1'&&s.binding_sha256===this.binding_sha256&&Number.isSafeInteger(s.revision)&&s.revision>=0&&Array.isArray(s.changes)&&s.revision===s.changes.length,'CONTROL_STATE_INVALID');
    const ids=new Set<string>();const prior:State={format:s.format,binding_sha256:s.binding_sha256,revision:0,changes:[]};
    for(const row of s.changes){check(exact(row,['change','change_sha256'])&&controlChangeDigest(row.change)===row.change_sha256,'CONTROL_CHANGE_CORRUPT');
      check(!ids.has(row.change.change_id)&&row.change.expected_revision===prior.revision&&row.change.expected_digest===controlDigest(prior),'CONTROL_CHANGE_CHAIN_INVALID');
      ids.add(row.change.change_id);prior.changes.push(row);prior.revision++;
    }
    return s;
  }
  private async locked<T>(fn:()=>Promise<T>):Promise<T>{
    this.rootCheck();const lock=join(this.root,'source.lock');controlNoLinks(lock);
    try{mkdirSync(lock,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('CONTROL_BUSY_OR_OWNER_UNKNOWN');throw e;}
    const st=lstatSync(lock),identity=`${st.dev}:${st.ino}`;
    try{this.rootCheck();return await fn();}finally{
      const last=lstatSync(lock);check(last.isDirectory()&&!last.isSymbolicLink()&&`${last.dev}:${last.ino}`===identity,'CONTROL_LOCK_REPLACED');rmdirSync(lock);
    }
  }
  private compose(s:State):ProjectFacts{
    const f=this.binding.format==='xdev-control-binding-3'?unboundFacts(this.binding,this.binding_sha256,s,this.root,this.clock):consumeReceipt(this.binding,this.clock);
    for(const row of s.changes)for(const op of row.change.operations){
      if(op.kind==='REVOKE_AUTHORIZATION'){
        const a=f.authorizations.find(a=>a.authorization_id===op.authorization_id);check(a,'CONTROL_UNKNOWN_AUTHORIZATION');a!.revoked=true;
      }else if(op.kind==='LOWER_LIMIT'){
        const r=f.resources.find(r=>r.resource_id===op.resource_id);check(r,'CONTROL_UNKNOWN_RESOURCE');check(op.limit<=r!.limit,'CONTROL_LIMIT_INCREASE_FORBIDDEN');r!.limit=op.limit;r!.evidence_ref=row.change.evidence_ref;
      }else{
        check(!f.stops.some(x=>x.stop_id===op.stop_id),'CONTROL_STOP_ID_COLLISION');
        f.stops.push({stop_id:op.stop_id,active:true,evidence_ref:row.change.evidence_ref,scope:{extent:'UNBOUNDED',task_ids:[],root_ids:[],resource_ids:[],workspace_ids:[],evidence_refs:[row.change.evidence_ref]}});
      }
    }
    const producerRevision=this.binding.format==='xdev-control-binding-3'?'UPSTREAM_UNBOUND':f.revision;
    const producerSha=this.binding.format==='xdev-control-binding-3'?null:this.binding.source_ref.sha256;
    f.revision='local-control-view:'+controlDigest({producer_revision:producerRevision,producer_sha256:producerSha,binding:this.binding_sha256,control:s});
    if(!f.evidence_refs.includes('local-control-binding:'+this.binding_sha256))f.evidence_refs.push('local-control-binding:'+this.binding_sha256);
    for(const r of s.changes)if(!f.evidence_refs.includes(r.change.evidence_ref))f.evidence_refs.push(r.change.evidence_ref);
    validateProjectFacts(f);return f;
  }
  /** Read-only diagnostic view. It deliberately does not acquire source.lock.
   * Writers remain serialized by locked(); status instead double-reads the
   * immutable/pinned inputs and control state and fails closed if they drift. */
  async describe(){
    this.rootCheck();
    const before=this.load(),beforeDigest=controlDigest(before),beforeFacts=this.compose(before),beforeFactsDigest=controlDigest(beforeFacts);
    this.rootCheck();
    const after=this.load(),afterDigest=controlDigest(after);check(afterDigest===beforeDigest,'CONTROL_UNCOORDINATED_WRITE');
    const f=this.compose(after);check(controlDigest(f)===beforeFactsDigest,'CONTROL_UNCOORDINATED_SOURCE_DRIFT');
    this.rootCheck();const finalDigest=controlDigest(this.load());check(finalDigest===afterDigest,'CONTROL_UNCOORDINATED_WRITE');
    return {binding_sha256:this.binding_sha256,binding_format:this.binding.format,budget_backed:this.budgetBacked,revision:after.revision,state_digest:afterDigest,source_ref:this.binding.format==='xdev-control-binding-3'?null:structuredClone(this.binding.source_ref),source_coverage:f.coverage,source_freshness:f.freshness,restrictions:after.changes.length,execution_permitted:false};
  }
  /** Stable read-only whole-project facts. No source.lock is created. An
   * already-active writer lock blocks the read, and repeated state/fact digests
   * must match before returning. This is for diagnostic/prepare paths only. */
  async captureProjectReadOnly(projectId:string):Promise<ProjectFacts>{
    check(projectId===this.binding.project_id,'CONTROL_PROJECT_MISMATCH');
    const assertNoWriter=()=>{const lock=join(this.root,'source.lock');controlNoLinks(lock);try{lstatSync(lock);throw Error('CONTROL_BUSY_OR_OWNER_UNKNOWN');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}};
    const round=()=>{assertNoWriter();this.rootCheck();const t=this.clock();check(Number.isFinite(t)&&t>=0,'CONTROL_TIME_INVALID');if(this.binding.format!=='xdev-control-binding-3')check(t<parseRfc3339Timestamp(this.binding.valid_until)!,'CONTROL_SOURCE_WINDOW_EXPIRED');if(this.binding.format==='xdev-control-binding-2')assertBootstrapDecisionTime(readBoundDecision(this.binding),t);const state=this.load(),stateDigest=controlDigest(state),facts=this.compose(state),factsDigest=controlDigest(facts);this.rootCheck();assertNoWriter();return{stateDigest,facts,factsDigest};};
    const a=round(),b=round();check(a.stateDigest===b.stateDigest,'CONTROL_UNCOORDINATED_WRITE');check(a.factsDigest===b.factsDigest,'CONTROL_UNCOORDINATED_SOURCE_DRIFT');const c=round();check(c.stateDigest===b.stateDigest,'CONTROL_UNCOORDINATED_WRITE');check(c.factsDigest===b.factsDigest,'CONTROL_UNCOORDINATED_SOURCE_DRIFT');return structuredClone(c.facts);
  }
  async withProjectSnapshot<T>(projectId:string,operation:(source:ProjectFacts,assertSourceCurrent?:()=>void)=>Promise<T>):Promise<T>{
    check(projectId===this.binding.project_id,'CONTROL_PROJECT_MISMATCH');check(typeof operation==='function','CONTROL_CALLBACK_REQUIRED');
    return this.locked(async()=>{
      const t=this.clock();check(Number.isFinite(t)&&t>=0,'CONTROL_TIME_INVALID');
      if(this.binding.format!=='xdev-control-binding-3')check(t<parseRfc3339Timestamp(this.binding.valid_until)!,'CONTROL_SOURCE_WINDOW_EXPIRED');
      if(this.binding.format==='xdev-control-binding-2')assertBootstrapDecisionTime(readBoundDecision(this.binding),t);
      const s=this.load(),before=controlDigest(s),f=freeze(this.compose(s));let active=true;
      const assertCurrent=()=>{check(active,'CONTROL_SNAPSHOT_ENDED');const current=this.clock();check(Number.isFinite(current)&&current>=0,'CONTROL_TIME_INVALID');
        if(this.binding.format!=='xdev-control-binding-3')check(current<parseRfc3339Timestamp(this.binding.valid_until)!,'CONTROL_SOURCE_WINDOW_EXPIRED');
        if(this.binding.format==='xdev-control-binding-2')assertBootstrapDecisionTime(readBoundDecision(this.binding),current);
        this.rootCheck();check(controlDigest(this.load())===before,'CONTROL_UNCOORDINATED_WRITE');if(this.binding.format==='xdev-control-binding-3')verifyIdentityBinding(this.binding);else consumeReceipt(this.binding,this.clock);};
      try {const result=await operation(f,assertCurrent);assertCurrent();return result;}finally{active=false;}
    });
  }
  async restrict(input:ControlRestriction,confirmation:string){
    const c=structuredClone(input),d=controlChangeDigest(c);check(d===confirmation,'CONTROL_CHANGE_CONFIRMATION_MISMATCH');
    return this.locked(async()=>{
      const s=this.load(),prior=s.changes.find(r=>r.change.change_id===c.change_id);
      if(prior){check(prior.change_sha256===d,'CONTROL_CHANGE_ID_REBOUND');return {status:'ALREADY_APPLIED' as const,revision:s.revision,state_digest:controlDigest(s),change_sha256:d,execution_permitted:false};}
      check(s.revision===c.expected_revision&&controlDigest(s)===c.expected_digest,'CONTROL_CHANGE_STALE');
      if(this.binding.format==='xdev-control-binding-3'){const allocation=readCurrentAllocationBudgetAttachment(this.root,this.binding_sha256,this.clock);check(c.operations.every(o=>o.kind==='ADD_GLOBAL_STOP'||!!allocation&&(o.kind==='REVOKE_AUTHORIZATION'&&o.authorization_id===allocation.receipt.authorization_fact.authorization_id||o.kind==='LOWER_LIMIT'&&o.resource_id===allocation.receipt.resource_fact.resource_id)),'CONTROL_UPSTREAM_UNBOUND_RESTRICT_ONLY_STOP');}
      const next=structuredClone(s);next.changes.push({change:c,change_sha256:d});next.revision++;
      this.compose(next);this.rootCheck();writeAtomic(join(this.root,'control.json'),next);
      return {status:'APPLIED' as const,revision:next.revision,state_digest:controlDigest(next),change_sha256:d,execution_permitted:false};
    });
  }
  openBudget(){if(this.binding.format==='xdev-control-binding-3'){const a=readCurrentAllocationBudgetAttachment(this.root,this.binding_sha256,this.clock);if(!a)throw Error('CONTROL_BUDGET_NOT_ATTACHED');return new FileResourceBudget(a.receipt.budget_root,a.receipt.budget_binding_sha256,this,this.clock);}const b=this.binding;return new FileResourceBudget(b.budget_root,b.budget_binding_sha256,this,this.clock);}
}
