/** R4.17 current M2 closeout task + Owner scope bootstrap.
 *
 * This is an XDev execution-control record, not XMem engineering state and not
 * a resource grant. It establishes one current administrative task and a
 * current Owner-authorized RESERVE_ONLY_NO_DISPATCH scope. Resource allocation
 * and the admission AuthorizationFact remain deferred until a later explicit
 * allocation/budget decision. No Worker or reservation permission is created.
 */
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,rmdirSync,writeFileSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {canonicalJson} from '../planning/governance-contracts.ts';
import {parseRfc3339Timestamp,parseUniqueJson} from '../planning/retry-history.ts';
import {type Action,type TaskFact,actionDigest} from './admission.ts';
import {FileControlSourceBoundary,controlNoLinks,readControlBytes} from './control-source-boundary.ts';
import {inspectLiveExecutionEvidence} from './live-execution-facts.ts';
import type {LiveCoverageRow} from './live-boundary-deployment.ts';

export const CURRENT_M2_TASK_AUTH_ACK='ESTABLISH_CURRENT_M2_RESERVE_ONLY_SCOPE_NO_RESOURCE_GRANT';
export const CURRENT_M2_TASK_AUTH_PROPOSAL_VALIDITY_MS=60*60*1000;
export const CURRENT_M2_TASK_AUTH_SCOPE_VALIDITY_MS=8*60*60*1000;

export type CurrentM2TaskContract={
  format:'xdev-current-task-contract-1';task_id:string;root_id:string;project_id:string;workspace_id:string;
  objective:'M2_RECOVERY_CLOSEOUT_RESERVE_ONLY_VALIDATION';dependency_ids:string[];delivery_mode:'FAST_VALIDATION';
  required_checks:string[];constraints:string[];
};
export type CurrentOwnerScope={
  format:'xdev-current-owner-scope-1';authorization_id:string;task_id:string;contract_sha256:string;action_id:string;kind:'VERIFY';
  purpose:'RESERVE_ONLY_NO_DISPATCH';resource_grant_state:'DEFERRED_UNTIL_CURRENT_ALLOCATION';valid_until:string;
  historical_constraints:'PRESERVE_ALL';execution_permitted:false;
};
export type CurrentTaskAuthProposal={
  format:'xdev-current-m2-task-authorization-proposal-1';purpose:'ESTABLISH_CURRENT_M2_RESERVE_ONLY_SCOPE_NO_RESOURCE_GRANT';
  project_id:string;control_root:string;control_binding_sha256:string;workspace_root:string;prepared_at:string;valid_until:string;
  upstream_evidence:{receipt_path:string;receipt_sha256:string;proposal_path:string;proposal_sha256:string};
  task_contract:CurrentM2TaskContract;contract_sha256:string;task_fact:TaskFact;action:Action;owner_scope:CurrentOwnerScope;
  proposal_sha256:string;execution_permitted:false;reservation_created:false;worker_started:false;
};
export type CurrentTaskAuthReceipt={
  format:'xdev-current-m2-task-authorization-1';state:'APPLIED';proposal_sha256:string;project_id:string;control_binding_sha256:string;
  workspace_root:string;upstream_evidence:CurrentTaskAuthProposal['upstream_evidence'];task_contract:CurrentM2TaskContract;contract_sha256:string;
  task_fact:TaskFact;action:Action;owner_scope:CurrentOwnerScope;applied_at:string;execution_permitted:false;reservation_created:false;worker_started:false;
};

const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function check(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
const digest=(v:unknown)=>createHash('sha256').update(canonicalJson(v as any)).digest('hex');
const bytesSha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const exact=(v:any,k:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...k].sort().join(',');
function canonicalAbs(p:string){check(isAbsolute(p)&&resolve(p)===p,'CURRENT_M2_TASK_AUTH_PATH_NOT_CANONICAL');controlNoLinks(p);return p;}
function ordinary(path:string){controlNoLinks(path);const s=lstatSync(path);check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=8*1024*1024,'CURRENT_M2_TASK_AUTH_FILE_UNSAFE');return s;}
function writeNew(path:string,v:unknown){controlNoLinks(path);let fd:number|undefined;try{fd=openSync(path,'wx',0o600);writeFileSync(fd,canonicalJson(v as any));fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}}
function paths(root:string){return{proposal:join(root,'current-task-authorization-proposal.json'),receipt:join(root,'current-task-authorization.json'),lock:join(root,'source.lock'),upstreamReceipt:join(root,'execution-facts.json'),upstreamProposal:join(root,'execution-facts-proposal.json')};}
function core(p:CurrentTaskAuthProposal){const {proposal_sha256,...rest}=p;return rest;}
function validateContract(v:any):asserts v is CurrentM2TaskContract{
  check(exact(v,['format','task_id','root_id','project_id','workspace_id','objective','dependency_ids','delivery_mode','required_checks','constraints'])&&v.format==='xdev-current-task-contract-1'&&v.objective==='M2_RECOVERY_CLOSEOUT_RESERVE_ONLY_VALIDATION'&&v.delivery_mode==='FAST_VALIDATION','CURRENT_M2_TASK_CONTRACT_INVALID');
  check([v.task_id,v.root_id,v.project_id,v.workspace_id].every(text)&&v.root_id===v.task_id&&Array.isArray(v.dependency_ids)&&v.dependency_ids.length===0&&Array.isArray(v.required_checks)&&v.required_checks.length>=4&&v.required_checks.every(text)&&new Set(v.required_checks).size===v.required_checks.length&&Array.isArray(v.constraints)&&v.constraints.length>=4&&v.constraints.every(text),'CURRENT_M2_TASK_CONTRACT_INVALID');
}
function validateTask(v:any,contractSha:string,taskId:string,workspace:string){
  check(exact(v,['task_id','root_id','contract_sha256','dependency_ids','workspace_id','state','evidence_ref','required_checks','delivery_mode'])&&v.task_id===taskId&&v.root_id===taskId&&v.contract_sha256===contractSha&&Array.isArray(v.dependency_ids)&&v.dependency_ids.length===0&&v.workspace_id===workspace&&v.state==='PENDING'&&text(v.evidence_ref)&&Array.isArray(v.required_checks)&&v.required_checks.length>=4&&v.required_checks.every(text)&&v.delivery_mode==='FAST_VALIDATION','CURRENT_M2_TASK_FACT_INVALID');
}
function validateScope(v:any,taskId:string,contractSha:string,actionId:string){
  check(exact(v,['format','authorization_id','task_id','contract_sha256','action_id','kind','purpose','resource_grant_state','valid_until','historical_constraints','execution_permitted'])&&v.format==='xdev-current-owner-scope-1'&&[v.authorization_id,v.task_id,v.action_id].every(text)&&v.task_id===taskId&&v.contract_sha256===contractSha&&v.action_id===actionId&&v.kind==='VERIFY'&&v.purpose==='RESERVE_ONLY_NO_DISPATCH'&&v.resource_grant_state==='DEFERRED_UNTIL_CURRENT_ALLOCATION'&&parseRfc3339Timestamp(v.valid_until)!==null&&v.historical_constraints==='PRESERVE_ALL'&&v.execution_permitted===false,'CURRENT_M2_OWNER_SCOPE_INVALID');
}
function validateUpstream(v:any){check(exact(v,['receipt_path','receipt_sha256','proposal_path','proposal_sha256'])&&sha(v.receipt_sha256)&&sha(v.proposal_sha256),'CURRENT_M2_TASK_AUTH_UPSTREAM_INVALID');canonicalAbs(v.receipt_path);canonicalAbs(v.proposal_path);}
function validateProposal(v:any):asserts v is CurrentTaskAuthProposal{
  check(exact(v,['format','purpose','project_id','control_root','control_binding_sha256','workspace_root','prepared_at','valid_until','upstream_evidence','task_contract','contract_sha256','task_fact','action','owner_scope','proposal_sha256','execution_permitted','reservation_created','worker_started'])&&v.format==='xdev-current-m2-task-authorization-proposal-1'&&v.purpose==='ESTABLISH_CURRENT_M2_RESERVE_ONLY_SCOPE_NO_RESOURCE_GRANT','CURRENT_M2_TASK_AUTH_PROPOSAL_INVALID');
  check(text(v.project_id)&&sha(v.control_binding_sha256)&&parseRfc3339Timestamp(v.prepared_at)!==null&&parseRfc3339Timestamp(v.valid_until)!==null&&sha(v.contract_sha256)&&sha(v.proposal_sha256)&&v.execution_permitted===false&&v.reservation_created===false&&v.worker_started===false,'CURRENT_M2_TASK_AUTH_PROPOSAL_INVALID');
  canonicalAbs(v.control_root);canonicalAbs(v.workspace_root);validateUpstream(v.upstream_evidence);validateContract(v.task_contract);check(digest(v.task_contract)===v.contract_sha256,'CURRENT_M2_TASK_CONTRACT_DIGEST_INVALID');validateTask(v.task_fact,v.contract_sha256,v.task_contract.task_id,v.workspace_root);
  actionDigest(v.action);check(v.action.project_id===v.project_id&&v.action.task_id===v.task_contract.task_id&&v.action.contract_sha256===v.contract_sha256&&v.action.authorization_id===v.owner_scope.authorization_id&&v.action.kind==='VERIFY','CURRENT_M2_ACTION_INVALID');validateScope(v.owner_scope,v.task_contract.task_id,v.contract_sha256,v.action.action_id);check(digest(core(v))===v.proposal_sha256,'CURRENT_M2_TASK_AUTH_PROPOSAL_DIGEST_INVALID');
}
function validateReceipt(v:any):asserts v is CurrentTaskAuthReceipt{
  check(exact(v,['format','state','proposal_sha256','project_id','control_binding_sha256','workspace_root','upstream_evidence','task_contract','contract_sha256','task_fact','action','owner_scope','applied_at','execution_permitted','reservation_created','worker_started'])&&v.format==='xdev-current-m2-task-authorization-1'&&v.state==='APPLIED'&&sha(v.proposal_sha256)&&text(v.project_id)&&sha(v.control_binding_sha256)&&parseRfc3339Timestamp(v.applied_at)!==null&&v.execution_permitted===false&&v.reservation_created===false&&v.worker_started===false,'CURRENT_M2_TASK_AUTH_RECEIPT_INVALID');
  canonicalAbs(v.workspace_root);validateUpstream(v.upstream_evidence);validateContract(v.task_contract);check(digest(v.task_contract)===v.contract_sha256,'CURRENT_M2_TASK_CONTRACT_DIGEST_INVALID');validateTask(v.task_fact,v.contract_sha256,v.task_contract.task_id,v.workspace_root);actionDigest(v.action);check(v.action.project_id===v.project_id&&v.action.task_id===v.task_contract.task_id&&v.action.contract_sha256===v.contract_sha256&&v.action.authorization_id===v.owner_scope.authorization_id,'CURRENT_M2_ACTION_INVALID');validateScope(v.owner_scope,v.task_contract.task_id,v.contract_sha256,v.action.action_id);
}
function verifyUpstream(ref:CurrentTaskAuthProposal['upstream_evidence']){for(const [p,h] of [[ref.receipt_path,ref.receipt_sha256],[ref.proposal_path,ref.proposal_sha256]] as const){ordinary(p);check(bytesSha(readControlBytes(p))===h,'CURRENT_M2_TASK_AUTH_UPSTREAM_DRIFT');}}
function upstreamRefs(root:string){const p=paths(root);check(existsSync(p.upstreamReceipt)&&existsSync(p.upstreamProposal),'CURRENT_M2_TASK_AUTH_REQUIRES_LIVE_EXECUTION_EVIDENCE');ordinary(p.upstreamReceipt);ordinary(p.upstreamProposal);return{receipt_path:p.upstreamReceipt,receipt_sha256:bytesSha(readControlBytes(p.upstreamReceipt)),proposal_path:p.upstreamProposal,proposal_sha256:bytesSha(readControlBytes(p.upstreamProposal))};}

export async function prepareCurrentM2TaskAuthorization(controlRootInput:string,bindingSha:string,outInput:string,clock:()=>number=Date.now){
  const root=canonicalAbs(controlRootInput),out=canonicalAbs(outInput);check(sha(bindingSha),'CURRENT_M2_TASK_AUTH_BINDING_DIGEST_INVALID');check(!existsSync(out),'CURRENT_M2_TASK_AUTH_OUTPUT_EXISTS');const boundary=new FileControlSourceBoundary(root,bindingSha,clock);check(boundary.binding.format==='xdev-control-binding-3','CURRENT_M2_TASK_AUTH_REQUIRES_REAL_CONTROL_SOURCE');
  const evidence=await inspectLiveExecutionEvidence(root,bindingSha,clock);check(!evidence.stale,'CURRENT_M2_TASK_AUTH_REQUIRES_CURRENT_LIVE_EVIDENCE');const upstream=upstreamRefs(root);verifyUpstream(upstream);
  const now=clock();check(Number.isFinite(now)&&now>=0,'CURRENT_M2_TASK_AUTH_TIME_INVALID');const until=now+CURRENT_M2_TASK_AUTH_PROPOSAL_VALIDITY_MS,scopeUntil=now+CURRENT_M2_TASK_AUTH_SCOPE_VALIDITY_MS;check(Number.isSafeInteger(until)&&Number.isSafeInteger(scopeUntil),'CURRENT_M2_TASK_AUTH_TIME_INVALID');
  const taskId='M2-RECOVERY-CLOSEOUT:'+randomUUID(),actionId='M2-RESERVE-ONLY-VERIFY:'+randomUUID(),authorizationId='M2-RESERVE-ONLY-AUTH:'+randomUUID();
  const task_contract:CurrentM2TaskContract={format:'xdev-current-task-contract-1',task_id:taskId,root_id:taskId,project_id:boundary.binding.project_id,workspace_id:boundary.binding.workspace_root,objective:'M2_RECOVERY_CLOSEOUT_RESERVE_ONLY_VALIDATION',dependency_ids:[],delivery_mode:'FAST_VALIDATION',required_checks:['CURRENT_SOURCE_COMPLETE_BEFORE_RESERVE','CURRENT_ALLOCATION_BOUND_BEFORE_RESOURCE_GRANT','STOP_UNKNOWN_PRESERVED','RESERVE_IDEMPOTENT_NO_DOUBLE_HOLD','NO_WORKER_OR_MODEL_STARTED'],constraints:['RESERVE_ONLY_NO_DISPATCH','PRESERVE_ALL_HISTORICAL_CONSTRAINTS','NO_BUDGET_OR_ALLOCATION_CREATED_BY_THIS_DECISION','NO_STOP_GATE_XMEM_MUTATION']};
  const contractSha=digest(task_contract),evidenceRef='current-m2-task-scope:'+contractSha;
  const task_fact:TaskFact={task_id:taskId,root_id:taskId,contract_sha256:contractSha,dependency_ids:[],workspace_id:boundary.binding.workspace_root,state:'PENDING',evidence_ref:evidenceRef,required_checks:[...task_contract.required_checks],delivery_mode:'FAST_VALIDATION'};
  const owner_scope:CurrentOwnerScope={format:'xdev-current-owner-scope-1',authorization_id:authorizationId,task_id:taskId,contract_sha256:contractSha,action_id:actionId,kind:'VERIFY',purpose:'RESERVE_ONLY_NO_DISPATCH',resource_grant_state:'DEFERRED_UNTIL_CURRENT_ALLOCATION',valid_until:new Date(scopeUntil).toISOString(),historical_constraints:'PRESERVE_ALL',execution_permitted:false};
  const action:Action={action_id:actionId,project_id:boundary.binding.project_id,task_id:taskId,contract_sha256:contractSha,authorization_id:authorizationId,kind:'VERIFY'};
  const c={format:'xdev-current-m2-task-authorization-proposal-1' as const,purpose:'ESTABLISH_CURRENT_M2_RESERVE_ONLY_SCOPE_NO_RESOURCE_GRANT' as const,project_id:boundary.binding.project_id,control_root:root,control_binding_sha256:bindingSha,workspace_root:boundary.binding.workspace_root,prepared_at:new Date(now).toISOString(),valid_until:new Date(until).toISOString(),upstream_evidence:upstream,task_contract,contract_sha256:contractSha,task_fact,action,owner_scope,execution_permitted:false as const,reservation_created:false as const,worker_started:false as const};
  const proposal:CurrentTaskAuthProposal={...c,proposal_sha256:digest(c)};validateProposal(proposal);writeNew(out,proposal);return{status:'CURRENT_M2_TASK_AUTHORIZATION_PROPOSAL_PREPARED' as const,proposal_path:out,proposal_sha256:proposal.proposal_sha256,project_id:proposal.project_id,task_id:taskId,action_id:actionId,authorization_id:authorizationId,contract_sha256:contractSha,scope_valid_until:owner_scope.valid_until,valid_until:proposal.valid_until,resource_grant_state:owner_scope.resource_grant_state,execution_permitted:false,reservation_created:false,worker_started:false};
}

export async function applyCurrentM2TaskAuthorization(proposalPathInput:string,confirmedDigest:string,ack:string,clock:()=>number=Date.now){
  check(ack===CURRENT_M2_TASK_AUTH_ACK,'CURRENT_M2_TASK_AUTH_EXPLICIT_ACK_REQUIRED');check(sha(confirmedDigest),'CURRENT_M2_TASK_AUTH_CONFIRMATION_INVALID');const proposalPath=canonicalAbs(proposalPathInput);const proposal=parseUniqueJson(readControlBytes(proposalPath).toString('utf8'));validateProposal(proposal);check(proposal.proposal_sha256===confirmedDigest,'CURRENT_M2_TASK_AUTH_CONFIRMATION_MISMATCH');
  const now=clock(),prepared=parseRfc3339Timestamp(proposal.prepared_at),until=parseRfc3339Timestamp(proposal.valid_until),scopeUntil=parseRfc3339Timestamp(proposal.owner_scope.valid_until);check(Number.isFinite(now)&&prepared!==null&&until!==null&&scopeUntil!==null&&now>=prepared&&now<until&&now<scopeUntil,'CURRENT_M2_TASK_AUTH_PROPOSAL_EXPIRED_OR_CLOCK_INVALID');verifyUpstream(proposal.upstream_evidence);
  const evidence=await inspectLiveExecutionEvidence(proposal.control_root,proposal.control_binding_sha256,clock);check(!evidence.stale&&evidence.project_id===proposal.project_id&&evidence.workspace_root===proposal.workspace_root,'CURRENT_M2_TASK_AUTH_UPSTREAM_CHANGED');const boundary=new FileControlSourceBoundary(proposal.control_root,proposal.control_binding_sha256,clock);check(boundary.binding.format==='xdev-control-binding-3'&&boundary.binding.project_id===proposal.project_id&&boundary.binding.workspace_root===proposal.workspace_root,'CURRENT_M2_TASK_AUTH_CONTROL_CHANGED');
  const p=paths(proposal.control_root);if(existsSync(p.receipt)||existsSync(p.proposal)){check(existsSync(p.receipt)&&existsSync(p.proposal),'CURRENT_M2_TASK_AUTH_PARTIAL_MANUAL_REVIEW_REQUIRED');const stored=parseUniqueJson(readControlBytes(p.proposal).toString('utf8'));validateProposal(stored);const receipt=parseUniqueJson(readControlBytes(p.receipt).toString('utf8'));validateReceipt(receipt);check(stored.proposal_sha256===proposal.proposal_sha256&&receipt.proposal_sha256===proposal.proposal_sha256,'CURRENT_M2_TASK_AUTH_BOUND_TO_DIFFERENT_PROPOSAL');return inspectCurrentM2TaskAuthorization(proposal.control_root,proposal.control_binding_sha256,clock);}
  controlNoLinks(p.lock);let lockId:string|null=null;try{mkdirSync(p.lock,{mode:0o700});const s=lstatSync(p.lock);check(s.isDirectory()&&!s.isSymbolicLink(),'CURRENT_M2_TASK_AUTH_LOCK_INVALID');lockId=`${s.dev}:${s.ino}`;}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('CURRENT_M2_TASK_AUTH_BUSY_OR_OWNER_UNKNOWN');throw e;}
  try{verifyUpstream(proposal.upstream_evidence);const current=parseUniqueJson(readControlBytes(proposalPath).toString('utf8'));validateProposal(current);check(current.proposal_sha256===confirmedDigest&&canonicalJson(current as any)===canonicalJson(proposal as any),'CURRENT_M2_TASK_AUTH_PROPOSAL_CHANGED');writeNew(p.proposal,proposal);const receipt:CurrentTaskAuthReceipt={format:'xdev-current-m2-task-authorization-1',state:'APPLIED',proposal_sha256:proposal.proposal_sha256,project_id:proposal.project_id,control_binding_sha256:proposal.control_binding_sha256,workspace_root:proposal.workspace_root,upstream_evidence:structuredClone(proposal.upstream_evidence),task_contract:structuredClone(proposal.task_contract),contract_sha256:proposal.contract_sha256,task_fact:structuredClone(proposal.task_fact),action:structuredClone(proposal.action),owner_scope:structuredClone(proposal.owner_scope),applied_at:new Date(now).toISOString(),execution_permitted:false,reservation_created:false,worker_started:false};writeNew(p.receipt,receipt);}finally{const s=lstatSync(p.lock);check(s.isDirectory()&&!s.isSymbolicLink()&&`${s.dev}:${s.ino}`===lockId,'CURRENT_M2_TASK_AUTH_LOCK_REPLACED');rmdirSync(p.lock);}
  return inspectCurrentM2TaskAuthorization(proposal.control_root,proposal.control_binding_sha256,clock);
}

export async function inspectCurrentM2TaskAuthorization(controlRootInput:string,bindingSha:string,clock:()=>number=Date.now){
  const root=canonicalAbs(controlRootInput);check(sha(bindingSha),'CURRENT_M2_TASK_AUTH_BINDING_DIGEST_INVALID');const boundary=new FileControlSourceBoundary(root,bindingSha,clock);const p=paths(root);check(existsSync(p.receipt)&&existsSync(p.proposal),'CURRENT_M2_TASK_AUTH_NOT_ATTACHED');const proposal=parseUniqueJson(readControlBytes(p.proposal).toString('utf8'));validateProposal(proposal);const receipt=parseUniqueJson(readControlBytes(p.receipt).toString('utf8'));validateReceipt(receipt);check(receipt.proposal_sha256===proposal.proposal_sha256&&receipt.control_binding_sha256===bindingSha&&receipt.project_id===boundary.binding.project_id&&receipt.workspace_root===(boundary.binding as any).workspace_root,'CURRENT_M2_TASK_AUTH_RECEIPT_BINDING_MISMATCH');
  let stale=false,error:string|null=null;try{verifyUpstream(receipt.upstream_evidence);const e=await inspectLiveExecutionEvidence(root,bindingSha,clock);check(!e.stale,'CURRENT_M2_TASK_AUTH_UPSTREAM_STALE');const now=clock(),scopeUntil=parseRfc3339Timestamp(receipt.owner_scope.valid_until);check(Number.isFinite(now)&&scopeUntil!==null&&now<scopeUntil,'CURRENT_M2_TASK_AUTH_SCOPE_EXPIRED');}catch(e){stale=true;error=e instanceof Error?e.message:'CURRENT_M2_TASK_AUTH_STALE';}
  return{status:stale?'CURRENT_M2_TASK_AUTHORIZATION_STALE_NOT_AUTHORIZED' as const:'CURRENT_M2_TASK_AUTHORIZATION_ATTACHED_SCOPE_ONLY_NOT_AUTHORIZED' as const,project_id:receipt.project_id,control_root:root,control_binding_sha256:bindingSha,workspace_root:receipt.workspace_root,task_fact:structuredClone(receipt.task_fact),action:structuredClone(receipt.action),owner_scope:structuredClone(receipt.owner_scope),stale,error,execution_permitted:false,reservation_created:false,worker_started:false};
}

export function readCurrentM2TaskAuthorization(controlRootInput:string,bindingSha:string,clock:()=>number=Date.now){
  const root=canonicalAbs(controlRootInput),p=paths(root);if(!existsSync(p.receipt)||!existsSync(p.proposal))return null;const proposal=parseUniqueJson(readControlBytes(p.proposal).toString('utf8'));validateProposal(proposal);const receipt=parseUniqueJson(readControlBytes(p.receipt).toString('utf8'));validateReceipt(receipt);check(receipt.control_binding_sha256===bindingSha&&receipt.proposal_sha256===proposal.proposal_sha256,'CURRENT_M2_TASK_AUTH_RECEIPT_BINDING_MISMATCH');
  let stale=false;try{verifyUpstream(receipt.upstream_evidence);const now=clock(),until=parseRfc3339Timestamp(receipt.owner_scope.valid_until);check(Number.isFinite(now)&&until!==null&&now<until,'CURRENT_M2_TASK_AUTH_SCOPE_EXPIRED');}catch{stale=true;}
  const refs=[{path:p.receipt,sha256:bytesSha(readControlBytes(p.receipt))},{path:p.proposal,sha256:bytesSha(readControlBytes(p.proposal))}];
  const rows:LiveCoverageRow[]=stale?
    [{area:'TASKS_DEPENDENCIES',status:'MISSING',reason:'CURRENT_M2_TASK_AUTHORIZATION_STALE',evidence_refs:refs.map(x=>'control-file:'+x.sha256)},{area:'AUTHORIZATION',status:'MISSING',reason:'CURRENT_M2_TASK_AUTHORIZATION_STALE',evidence_refs:refs.map(x=>'control-file:'+x.sha256)}]:
    [{area:'TASKS_DEPENDENCIES',status:'LIVE_COVERED',reason:'CURRENT_M2_CLOSEOUT_TASK_CONTRACT_BOUND',evidence_refs:refs.map(x=>'control-file:'+x.sha256)},{area:'AUTHORIZATION',status:'READ_ONLY',reason:'CURRENT_OWNER_SCOPE_BOUND_RESOURCE_GRANT_DEFERRED_NO_EXECUTION_GRANT',evidence_refs:refs.map(x=>'control-file:'+x.sha256)}];
  return{stale,rows,support:refs,task_fact:structuredClone(receipt.task_fact),action:structuredClone(receipt.action),owner_scope:structuredClone(receipt.owner_scope),proposal_sha256:receipt.proposal_sha256};
}
