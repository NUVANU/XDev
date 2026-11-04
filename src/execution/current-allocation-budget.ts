/** R4.18 current allocation + empty reservation budget bootstrap.
 *
 * Creates a NEW, explicit one-unit DISPATCH_SLOT allocation for the already
 * approved M2 reserve-only closeout action. It never derives a balance from
 * historical 60/87/88 counts or the legacy task ledger. Apply creates the
 * resource-bound RESERVE_ONLY AuthorizationFact and an empty FileResourceBudget,
 * but DOES NOT reserve, dispatch, settle, refund, clear STOPs or grant execution.
 */
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,rmdirSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {canonicalJson} from '../planning/governance-contracts.ts';
import {parseRfc3339Timestamp,parseUniqueJson} from '../planning/retry-history.ts';
import {actionDigest,type AuthorizationFact,type ProjectFacts} from './admission.ts';
import {budgetBindingDigest,initializeFileResourceBudget,type BudgetBinding} from './file-resource-budget.ts';
import {FileControlSourceBoundary,controlNoLinks,readControlBytes,readCurrentAllocationBudgetAttachment,type CurrentAllocationBudgetReceipt} from './control-source-boundary.ts';
import {inspectCurrentM2TaskAuthorization,readCurrentM2TaskAuthorization} from './current-task-authorization.ts';

export const CURRENT_ALLOCATION_BUDGET_ACK='ESTABLISH_CURRENT_ALLOCATION_AND_EMPTY_BUDGET_NO_RESERVE';
export const CURRENT_ALLOCATION_PROPOSAL_VALIDITY_MS=60*60*1000;
export const CURRENT_ALLOCATION_CEILING_UNITS=1;
export const CURRENT_ALLOCATION_REQUEST_UNITS=1;
export const CURRENT_ALLOCATION_HISTORICAL_RELATION='NEW_CURRENT_ALLOCATION_NO_HISTORICAL_BALANCE_INFERENCE' as const;

export type CurrentAllocationProposal={
  format:'xdev-current-allocation-budget-proposal-1';purpose:'ESTABLISH_CURRENT_ALLOCATION_AND_EMPTY_BUDGET_NO_RESERVE';
  project_id:string;control_root:string;control_binding_sha256:string;workspace_root:string;prepared_at:string;valid_until:string;
  current_task_ref:{receipt_path:string;receipt_sha256:string;proposal_path:string;proposal_sha256:string;task_auth_proposal_sha256:string};
  allocation_id:string;allocation_ref:string;historical_relation:typeof CURRENT_ALLOCATION_HISTORICAL_RELATION;
  resource_fact:ProjectFacts['resources'][number];authorization_fact:AuthorizationFact;action:any;task_fact:any;
  requested_hold_units:1;proposed_total_ceiling_units:1;budget_root:string;budget_binding:BudgetBinding;budget_binding_sha256:string;
  resource_grant_state:'RESOURCE_BOUND_RESERVE_ONLY';proposal_sha256:string;execution_permitted:false;reservation_created:false;worker_started:false;
};

const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function check(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
const digest=(v:unknown)=>createHash('sha256').update(canonicalJson(v as any)).digest('hex');
const bytesSha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const exact=(v:any,k:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...k].sort().join(',');
function canonicalAbs(p:string){check(isAbsolute(p)&&resolve(p)===p,'CURRENT_ALLOCATION_PATH_NOT_CANONICAL');controlNoLinks(p);return p;}
function inside(a:string,p:string){const r=relative(a,p);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));}
function ordinary(path:string){controlNoLinks(path);const s=lstatSync(path);check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=8*1024*1024,'CURRENT_ALLOCATION_FILE_UNSAFE');return s;}
function parentDir(path:string){const p=dirname(path);controlNoLinks(p);const s=lstatSync(p);check(s.isDirectory()&&!s.isSymbolicLink(),'CURRENT_ALLOCATION_PARENT_UNSAFE');return p;}
function writeNew(path:string,v:unknown){controlNoLinks(path);let fd:number|undefined;try{fd=openSync(path,'wx',0o600);writeFileSync(fd,canonicalJson(v as any));fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}}
function core(p:CurrentAllocationProposal){const {proposal_sha256,...rest}=p;return rest;}
function sidecars(root:string){return{proposal:join(root,'current-allocation-budget-proposal.json'),receipt:join(root,'current-allocation-budget.json'),lock:join(root,'source.lock'),taskProposal:join(root,'current-task-authorization-proposal.json'),taskReceipt:join(root,'current-task-authorization.json')};}
function validateCurrentTaskRef(v:any){check(exact(v,['receipt_path','receipt_sha256','proposal_path','proposal_sha256','task_auth_proposal_sha256'])&&[v.receipt_sha256,v.proposal_sha256,v.task_auth_proposal_sha256].every(sha),'CURRENT_ALLOCATION_TASK_REF_INVALID');canonicalAbs(v.receipt_path);canonicalAbs(v.proposal_path);}
function verifyCurrentTaskRef(v:CurrentAllocationProposal['current_task_ref']){ordinary(v.receipt_path);ordinary(v.proposal_path);check(bytesSha(readControlBytes(v.receipt_path))===v.receipt_sha256&&bytesSha(readControlBytes(v.proposal_path))===v.proposal_sha256,'CURRENT_ALLOCATION_TASK_REF_DRIFT');const p=parseUniqueJson(readControlBytes(v.proposal_path).toString('utf8')) as any;check(p?.proposal_sha256===v.task_auth_proposal_sha256,'CURRENT_ALLOCATION_TASK_PROPOSAL_DIGEST_DRIFT');}
function validateProposal(v:any):asserts v is CurrentAllocationProposal{
  check(exact(v,['format','purpose','project_id','control_root','control_binding_sha256','workspace_root','prepared_at','valid_until','current_task_ref','allocation_id','allocation_ref','historical_relation','resource_fact','authorization_fact','action','task_fact','requested_hold_units','proposed_total_ceiling_units','budget_root','budget_binding','budget_binding_sha256','resource_grant_state','proposal_sha256','execution_permitted','reservation_created','worker_started'])&&v.format==='xdev-current-allocation-budget-proposal-1'&&v.purpose==='ESTABLISH_CURRENT_ALLOCATION_AND_EMPTY_BUDGET_NO_RESERVE','CURRENT_ALLOCATION_PROPOSAL_INVALID');
  check([v.project_id,v.allocation_id,v.allocation_ref].every(text)&&[v.control_binding_sha256,v.budget_binding_sha256,v.proposal_sha256].every(sha)&&parseRfc3339Timestamp(v.prepared_at)!==null&&parseRfc3339Timestamp(v.valid_until)!==null&&v.historical_relation===CURRENT_ALLOCATION_HISTORICAL_RELATION&&v.requested_hold_units===1&&v.proposed_total_ceiling_units===1&&v.resource_grant_state==='RESOURCE_BOUND_RESERVE_ONLY'&&v.execution_permitted===false&&v.reservation_created===false&&v.worker_started===false,'CURRENT_ALLOCATION_PROPOSAL_INVALID');
  canonicalAbs(v.control_root);canonicalAbs(v.workspace_root);canonicalAbs(v.budget_root);validateCurrentTaskRef(v.current_task_ref);
  actionDigest(v.action);check(v.action.project_id===v.project_id&&v.action.task_id===v.task_fact.task_id&&v.action.authorization_id===v.authorization_fact.authorization_id&&v.action.contract_sha256===v.task_fact.contract_sha256&&v.action.kind==='VERIFY','CURRENT_ALLOCATION_ACTION_INVALID');
  check(v.resource_fact&&text(v.resource_fact.resource_id)&&v.resource_fact.unit==='DISPATCH_SLOT'&&v.resource_fact.limit===1&&text(v.resource_fact.evidence_ref),'CURRENT_ALLOCATION_RESOURCE_INVALID');
  const a=v.authorization_fact;check(a&&a.authorization_id===v.action.authorization_id&&a.task_id===v.action.task_id&&a.contract_sha256===v.action.contract_sha256&&a.kind==='VERIFY'&&a.purpose==='RESERVE_ONLY'&&a.action_id===v.action.action_id&&a.revoked===false&&parseRfc3339Timestamp(a.expires_at)!==null&&a.expires_at===v.valid_until&&text(a.evidence_ref)&&Array.isArray(a.reservations)&&a.reservations.length===1&&a.reservations[0].resource_id===v.resource_fact.resource_id&&a.reservations[0].units===1,'CURRENT_ALLOCATION_AUTHORIZATION_INVALID');
  check(budgetBindingDigest(v.budget_binding)===v.budget_binding_sha256&&v.budget_binding.project_id===v.project_id&&v.budget_binding.authority_id===a.authorization_id&&v.budget_binding.action_id_prefix===v.action.action_id&&v.budget_binding.resource_ids.length===1&&v.budget_binding.resource_ids[0]===v.resource_fact.resource_id&&v.budget_binding.allocation_ref===v.allocation_ref,'CURRENT_ALLOCATION_BUDGET_BINDING_INVALID');
  check(digest(core(v))===v.proposal_sha256,'CURRENT_ALLOCATION_PROPOSAL_DIGEST_INVALID');
}
function currentTaskRef(root:string){const p=sidecars(root);check(existsSync(p.taskReceipt)&&existsSync(p.taskProposal),'CURRENT_ALLOCATION_REQUIRES_CURRENT_TASK_AUTH');ordinary(p.taskReceipt);ordinary(p.taskProposal);const proposal=parseUniqueJson(readControlBytes(p.taskProposal).toString('utf8')) as any;check(sha(proposal?.proposal_sha256),'CURRENT_ALLOCATION_TASK_PROPOSAL_INVALID');return{receipt_path:p.taskReceipt,receipt_sha256:bytesSha(readControlBytes(p.taskReceipt)),proposal_path:p.taskProposal,proposal_sha256:bytesSha(readControlBytes(p.taskProposal)),task_auth_proposal_sha256:proposal.proposal_sha256};}

export async function prepareCurrentAllocationBudget(controlRootInput:string,bindingSha:string,budgetRootInput:string,outInput:string,clock:()=>number=Date.now){
  const root=canonicalAbs(controlRootInput),budgetRoot=canonicalAbs(budgetRootInput),out=canonicalAbs(outInput);check(sha(bindingSha),'CURRENT_ALLOCATION_BINDING_DIGEST_INVALID');check(!existsSync(out),'CURRENT_ALLOCATION_OUTPUT_EXISTS');parentDir(out);parentDir(budgetRoot);check(!existsSync(budgetRoot),'CURRENT_ALLOCATION_BUDGET_ROOT_EXISTS');
  const boundary=new FileControlSourceBoundary(root,bindingSha,clock);check(boundary.binding.format==='xdev-control-binding-3','CURRENT_ALLOCATION_REQUIRES_REAL_CONTROL_SOURCE');check(!inside(root,budgetRoot)&&!inside(budgetRoot,root)&&!inside(boundary.binding.workspace_root,budgetRoot)&&!inside(budgetRoot,boundary.binding.workspace_root),'CURRENT_ALLOCATION_DIRECTORIES_OVERLAP');check(readCurrentAllocationBudgetAttachment(root,bindingSha,clock)===null,'CURRENT_ALLOCATION_ALREADY_ATTACHED');
  const current=await inspectCurrentM2TaskAuthorization(root,bindingSha,clock);check(!current.stale&&current.owner_scope.resource_grant_state==='DEFERRED_UNTIL_CURRENT_ALLOCATION'&&current.owner_scope.purpose==='RESERVE_ONLY_NO_DISPATCH','CURRENT_ALLOCATION_REQUIRES_CURRENT_OWNER_SCOPE');const ref=currentTaskRef(root);verifyCurrentTaskRef(ref);
  const now=clock(),scopeUntil=parseRfc3339Timestamp(current.owner_scope.valid_until);check(Number.isFinite(now)&&now>=0&&scopeUntil!==null&&now<scopeUntil,'CURRENT_ALLOCATION_OWNER_SCOPE_EXPIRED');const proposalUntil=Math.min(now+CURRENT_ALLOCATION_PROPOSAL_VALIDITY_MS,scopeUntil);check(proposalUntil>now,'CURRENT_ALLOCATION_PROPOSAL_WINDOW_INVALID');
  const allocationId='M2-CLOSEOUT-ALLOCATION:'+randomUUID(),resourceId='M2-CLOSEOUT-DISPATCH-SLOT:'+randomUUID(),allocationRef='current-allocation:'+allocationId,evidenceRef=allocationRef;
  const resource_fact:ProjectFacts['resources'][number]={resource_id:resourceId,unit:'DISPATCH_SLOT',limit:CURRENT_ALLOCATION_CEILING_UNITS,evidence_ref:evidenceRef};
  const authorization_fact:AuthorizationFact={authorization_id:current.action.authorization_id,task_id:current.action.task_id,contract_sha256:current.action.contract_sha256,kind:current.action.kind,purpose:'RESERVE_ONLY',action_id:current.action.action_id,revoked:false,expires_at:new Date(scopeUntil).toISOString(),evidence_ref:evidenceRef,reservations:[{resource_id:resourceId,units:CURRENT_ALLOCATION_REQUEST_UNITS}]};
  const budget_binding:BudgetBinding={format:'xdev-budget-binding-1',project_id:current.project_id,authority_id:authorization_fact.authorization_id,action_id_prefix:current.action.action_id,resource_ids:[resourceId],allocation_ref:allocationRef};const budgetSha=budgetBindingDigest(budget_binding);
  const c={format:'xdev-current-allocation-budget-proposal-1' as const,purpose:'ESTABLISH_CURRENT_ALLOCATION_AND_EMPTY_BUDGET_NO_RESERVE' as const,project_id:current.project_id,control_root:root,control_binding_sha256:bindingSha,workspace_root:current.workspace_root,prepared_at:new Date(now).toISOString(),valid_until:new Date(scopeUntil).toISOString(),current_task_ref:ref,allocation_id:allocationId,allocation_ref:allocationRef,historical_relation:CURRENT_ALLOCATION_HISTORICAL_RELATION,resource_fact,authorization_fact,action:structuredClone(current.action),task_fact:structuredClone(current.task_fact),requested_hold_units:1 as const,proposed_total_ceiling_units:1 as const,budget_root:budgetRoot,budget_binding,budget_binding_sha256:budgetSha,resource_grant_state:'RESOURCE_BOUND_RESERVE_ONLY' as const,execution_permitted:false as const,reservation_created:false as const,worker_started:false as const};
  // Proposal confirmation window is recorded separately from the allocation/auth expiry.
  const proposal={...c,proposal_sha256:digest(c),proposal_confirmation_valid_until:new Date(proposalUntil).toISOString()} as any;
  // Keep the serialized contract exact: proposal_confirmation_valid_until is intentionally folded into valid_until only for confirmation.
  proposal.valid_until=proposal.proposal_confirmation_valid_until;delete proposal.proposal_confirmation_valid_until;
  // Authorization must not outlive the confirmed proposal in this bootstrap; Owner can issue a fresh proposal if it expires.
  proposal.authorization_fact.expires_at=proposal.valid_until;
  proposal.proposal_sha256=digest(core(proposal));validateProposal(proposal);writeNew(out,proposal);
  return{status:'CURRENT_ALLOCATION_BUDGET_PROPOSAL_PREPARED' as const,proposal_path:out,proposal_sha256:proposal.proposal_sha256,project_id:proposal.project_id,task_id:proposal.task_fact.task_id,action_id:proposal.action.action_id,authorization_id:proposal.authorization_fact.authorization_id,allocation_id:proposal.allocation_id,resource_id:proposal.resource_fact.resource_id,resource_unit:proposal.resource_fact.unit,proposed_total_ceiling_units:1,requested_hold_units:1,budget_root:proposal.budget_root,budget_binding_sha256:proposal.budget_binding_sha256,historical_relation:proposal.historical_relation,valid_until:proposal.valid_until,execution_permitted:false,reservation_created:false,worker_started:false};
}

export async function applyCurrentAllocationBudget(proposalPathInput:string,confirmedDigest:string,ack:string,clock:()=>number=Date.now){
  check(ack===CURRENT_ALLOCATION_BUDGET_ACK,'CURRENT_ALLOCATION_EXPLICIT_ACK_REQUIRED');check(sha(confirmedDigest),'CURRENT_ALLOCATION_CONFIRMATION_INVALID');const proposalPath=canonicalAbs(proposalPathInput);const proposal=parseUniqueJson(readControlBytes(proposalPath).toString('utf8'));validateProposal(proposal);check(proposal.proposal_sha256===confirmedDigest,'CURRENT_ALLOCATION_CONFIRMATION_MISMATCH');
  const now=clock(),prepared=parseRfc3339Timestamp(proposal.prepared_at),until=parseRfc3339Timestamp(proposal.valid_until);check(Number.isFinite(now)&&prepared!==null&&until!==null&&now>=prepared&&now<until,'CURRENT_ALLOCATION_PROPOSAL_EXPIRED_OR_CLOCK_INVALID');verifyCurrentTaskRef(proposal.current_task_ref);
  const current=await inspectCurrentM2TaskAuthorization(proposal.control_root,proposal.control_binding_sha256,clock);check(!current.stale&&current.project_id===proposal.project_id&&current.workspace_root===proposal.workspace_root&&canonicalJson(current.task_fact as any)===canonicalJson(proposal.task_fact as any)&&canonicalJson(current.action as any)===canonicalJson(proposal.action as any)&&current.owner_scope.authorization_id===proposal.authorization_fact.authorization_id&&current.owner_scope.purpose==='RESERVE_ONLY_NO_DISPATCH'&&current.owner_scope.resource_grant_state==='DEFERRED_UNTIL_CURRENT_ALLOCATION','CURRENT_ALLOCATION_TASK_SCOPE_CHANGED');
  const boundary=new FileControlSourceBoundary(proposal.control_root,proposal.control_binding_sha256,clock);check(boundary.binding.format==='xdev-control-binding-3'&&boundary.binding.project_id===proposal.project_id,'CURRENT_ALLOCATION_CONTROL_CHANGED');const p=sidecars(proposal.control_root),existing=readCurrentAllocationBudgetAttachment(proposal.control_root,proposal.control_binding_sha256,clock);if(existing){check(existing.receipt.proposal_sha256===proposal.proposal_sha256,'CURRENT_ALLOCATION_BOUND_TO_DIFFERENT_PROPOSAL');return inspectCurrentAllocationBudget(proposal.control_root,proposal.control_binding_sha256,clock);}
  check(!existsSync(p.proposal)&&!existsSync(p.receipt),'CURRENT_ALLOCATION_PARTIAL_MANUAL_REVIEW_REQUIRED');check(!existsSync(proposal.budget_root),'CURRENT_ALLOCATION_BUDGET_ROOT_EXISTS');parentDir(proposal.budget_root);
  controlNoLinks(p.lock);let lockId:string|null=null;try{mkdirSync(p.lock,{mode:0o700});const s=lstatSync(p.lock);check(s.isDirectory()&&!s.isSymbolicLink(),'CURRENT_ALLOCATION_LOCK_INVALID');lockId=`${s.dev}:${s.ino}`;}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('CURRENT_ALLOCATION_BUSY_OR_OWNER_UNKNOWN');throw e;}
  try{
    verifyCurrentTaskRef(proposal.current_task_ref);const currentProposal=parseUniqueJson(readControlBytes(proposalPath).toString('utf8'));validateProposal(currentProposal);check(currentProposal.proposal_sha256===confirmedDigest&&canonicalJson(currentProposal as any)===canonicalJson(proposal as any),'CURRENT_ALLOCATION_PROPOSAL_CHANGED');
    initializeFileResourceBudget(proposal.budget_root,proposal.budget_binding,proposal.budget_binding_sha256);
    writeNew(join(proposal.budget_root,'control-source-binding.json'),boundary.controlSourceIdentity);
    writeNew(p.proposal,proposal);
    const receipt:CurrentAllocationBudgetReceipt={format:'xdev-current-allocation-budget-1',state:'APPLIED',proposal_sha256:proposal.proposal_sha256,proposal_bytes_sha256:bytesSha(readControlBytes(p.proposal)),project_id:proposal.project_id,control_binding_sha256:proposal.control_binding_sha256,allocation_id:proposal.allocation_id,allocation_ref:proposal.allocation_ref,historical_relation:proposal.historical_relation,task_fact:structuredClone(proposal.task_fact),action:structuredClone(proposal.action),resource_fact:structuredClone(proposal.resource_fact),authorization_fact:structuredClone(proposal.authorization_fact),budget_root:proposal.budget_root,budget_binding:structuredClone(proposal.budget_binding),budget_binding_sha256:proposal.budget_binding_sha256,valid_until:proposal.valid_until,applied_at:new Date(now).toISOString(),execution_permitted:false,reservation_created:false,worker_started:false};writeNew(p.receipt,receipt);
  }finally{const s=lstatSync(p.lock);check(s.isDirectory()&&!s.isSymbolicLink()&&`${s.dev}:${s.ino}`===lockId,'CURRENT_ALLOCATION_LOCK_REPLACED');rmdirSync(p.lock);}
  return inspectCurrentAllocationBudget(proposal.control_root,proposal.control_binding_sha256,clock);
}

export async function inspectCurrentAllocationBudget(controlRootInput:string,bindingSha:string,clock:()=>number=Date.now){
  const root=canonicalAbs(controlRootInput);check(sha(bindingSha),'CURRENT_ALLOCATION_BINDING_DIGEST_INVALID');const boundary=new FileControlSourceBoundary(root,bindingSha,clock),a=readCurrentAllocationBudgetAttachment(root,bindingSha,clock);check(a,'CURRENT_ALLOCATION_NOT_ATTACHED');const observation=a.budget_observation;
  return{status:a.stale?'CURRENT_ALLOCATION_BUDGET_STALE_NOT_AUTHORIZED' as const:observation.hold_count?'CURRENT_ALLOCATION_BUDGET_ATTACHED_WITH_HOLD_NOT_AUTHORIZED' as const:'CURRENT_ALLOCATION_BUDGET_ATTACHED_EMPTY_NOT_AUTHORIZED' as const,project_id:a.receipt.project_id,control_root:root,control_binding_sha256:bindingSha,allocation_id:a.receipt.allocation_id,allocation_ref:a.receipt.allocation_ref,historical_relation:a.receipt.historical_relation,task_id:a.receipt.task_fact.task_id,action_id:a.receipt.action.action_id,authorization_id:a.receipt.authorization_fact.authorization_id,resource_fact:structuredClone(a.receipt.resource_fact),authorization_fact:structuredClone(a.receipt.authorization_fact),budget_root:a.receipt.budget_root,budget_binding_sha256:a.receipt.budget_binding_sha256,budget_revision:observation.revision,hold_count:observation.hold_count,stale:a.stale,budget_backed:boundary.budgetBacked,execution_permitted:false,reservation_created:observation.hold_count>0,worker_started:false};
}
