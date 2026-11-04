/** R4.16 real workspace execution-fact evidence wiring.
 *
 * This module does NOT manufacture ProjectFacts, CURRENT coverage, a resource
 * allocation or execution permission. It pins the current workspace evidence
 * that actually exists and publishes an honest per-area coverage map beside the
 * already-deployed R4.15 control source. The live boundary may use this map for
 * observability/support-byte drift detection only; admission remains blocked
 * until a real whole-project producer + budget are attached.
 */
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,renameSync,rmdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {canonicalJson} from '../planning/governance-contracts.ts';
import {parseRfc3339Timestamp,parseUniqueJson} from '../planning/retry-history.ts';
import {FileControlSourceBoundary,controlNoLinks,readControlBytes} from './control-source-boundary.ts';

export const LIVE_EXECUTION_EVIDENCE_ACK='BIND_REAL_WORKSPACE_EXECUTION_EVIDENCE_NO_PERMISSION';
export const LIVE_EXECUTION_EVIDENCE_VALIDITY_MS=60*60*1000;
export const liveExecutionEvidenceAreas=['TASKS_DEPENDENCIES','AUTHORIZATION','RESOURCES','CHARGES','RESERVATIONS','STOP_UNKNOWN','IDENTITY'] as const;
export type LiveExecutionEvidenceArea=typeof liveExecutionEvidenceAreas[number];
export type LiveExecutionEvidenceStatus='LIVE_COVERED'|'READ_ONLY'|'HISTORICAL_ONLY'|'MISSING';
export type LiveExecutionEvidenceRow={area:LiveExecutionEvidenceArea;status:LiveExecutionEvidenceStatus;reason:string;evidence_refs:string[]};
export type LiveExecutionSourceRef={kind:'PROJECT_STATE'|'TASK_LEDGER'|'PHASE'|'CURRENT_BASELINE'|'TASK_CONTRACT'|'OWNER_DECISION';path:string;sha256:string;size:number};
export type LiveExecutionEvidenceProposal={
  format:'xdev-live-execution-evidence-proposal-1';purpose:'BIND_REAL_WORKSPACE_EXECUTION_EVIDENCE_NO_PERMISSION';
  project_id:string;control_root:string;control_binding_sha256:string;workspace_root:string;
  prepared_at:string;valid_until:string;sources:LiveExecutionSourceRef[];
  task_summary:{task_files:number;malformed_task_files:number;active_task_ids:string[];missing_active_task_ids:string[]};
  owner_decision_count:number;coverage:LiveExecutionEvidenceRow[];proposal_sha256:string;
  execution_permitted:false;reservation_created:false;worker_started:false;
};
export type LiveExecutionEvidenceReceipt={
  format:'xdev-live-execution-evidence-1';state:'APPLIED';proposal_sha256:string;project_id:string;control_binding_sha256:string;workspace_root:string;
  sources:LiveExecutionSourceRef[];task_summary:LiveExecutionEvidenceProposal['task_summary'];owner_decision_count:number;coverage:LiveExecutionEvidenceRow[];applied_at:string;
  execution_permitted:false;reservation_created:false;worker_started:false;
};

const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function check(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
const digest=(v:unknown)=>createHash('sha256').update(canonicalJson(v as any)).digest('hex');
const bytesSha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const exact=(v:any,k:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...k].sort().join(',');
function canonicalAbs(p:string,code='LIVE_EXECUTION_EVIDENCE_PATH_NOT_CANONICAL'){check(isAbsolute(p)&&resolve(p)===p,code);controlNoLinks(p);return p;}
function ordinaryFile(path:string,max=8*1024*1024){controlNoLinks(path);const s=lstatSync(path);check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=max,'LIVE_EXECUTION_EVIDENCE_FILE_UNSAFE');return s;}
function pin(kind:LiveExecutionSourceRef['kind'],path:string):LiveExecutionSourceRef{const s=ordinaryFile(path);const b=readFileSync(path);return{kind,path,sha256:bytesSha(b),size:s.size};}
function writeNew(path:string,value:unknown){controlNoLinks(path);let fd:number|undefined;try{fd=openSync(path,'wx',0o600);writeFileSync(fd,canonicalJson(value as any));fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}}
function writeAtomic(path:string,value:unknown){controlNoLinks(path);const tmp=path+'.'+randomUUID()+'.tmp';let fd:number|undefined;try{fd=openSync(tmp,'wx',0o600);writeFileSync(fd,canonicalJson(value as any));fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(tmp,path);}finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(tmp);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}}
function listOrdinaryJson(dir:string,kind:LiveExecutionSourceRef['kind']){
  if(!existsSync(dir))return [] as LiveExecutionSourceRef[];controlNoLinks(dir);const st=lstatSync(dir);check(st.isDirectory()&&!st.isSymbolicLink(),'LIVE_EXECUTION_EVIDENCE_DIRECTORY_UNSAFE');
  const names=readdirSync(dir).filter(n=>n.endsWith('.json')).sort();check(names.length<=2048,'LIVE_EXECUTION_EVIDENCE_TOO_MANY_FILES');
  return names.map(n=>pin(kind,join(dir,n)));
}
function readJsonOrNull(path:string){try{return parseUniqueJson(readControlBytes(path).toString('utf8')) as any;}catch{return null;}}
function evidence(refs:LiveExecutionSourceRef[]){return refs.map(r=>`workspace-file:${r.sha256}`);}
function classify(workspace:string,sources:LiveExecutionSourceRef[]){
  const byKind=(k:LiveExecutionSourceRef['kind'])=>sources.filter(x=>x.kind===k);
  const taskRefs=byKind('TASK_CONTRACT'),stateRef=byKind('PROJECT_STATE')[0],phaseRef=byKind('PHASE')[0],ledgerRef=byKind('TASK_LEDGER')[0],ownerRefs=byKind('OWNER_DECISION');
  let malformed=0;const taskIds=new Set<string>();for(const r of taskRefs){const v=readJsonOrNull(r.path);if(!v||!text(v.task_id)||taskIds.has(v.task_id)){malformed++;continue;}taskIds.add(v.task_id);}
  const state=stateRef?readJsonOrNull(stateRef.path):null,stateActiveValid=!!state&&Array.isArray(state.active_task_ids)&&state.active_task_ids.every(text);const active=stateActiveValid?[...state.active_task_ids] as string[]:[];
  const missing=active.filter(id=>!taskIds.has(id));
  const taskStatus:LiveExecutionEvidenceStatus=stateRef&&stateActiveValid&&taskRefs.length>0&&malformed===0&&missing.length===0?'READ_ONLY':taskRefs.length>0?'HISTORICAL_ONLY':'MISSING';
  const taskReason=taskStatus==='READ_ONLY'?'WORKSPACE_PROJECT_STATE_AND_ACTIVE_TASK_CONTRACTS_PINNED_READ_ONLY':taskStatus==='HISTORICAL_ONLY'?'TASK_FILES_PRESENT_BUT_CURRENT_ACTIVE_TASK_COVERAGE_NOT_PROVEN':'NO_WORKSPACE_TASK_SOURCE_FOUND';
  const authStatus:LiveExecutionEvidenceStatus=ownerRefs.length?'HISTORICAL_ONLY':'MISSING';
  const chargeStatus:LiveExecutionEvidenceStatus=ledgerRef?'HISTORICAL_ONLY':'MISSING';
  const phase=phaseRef?readJsonOrNull(phaseRef.path):null;const stopStatus:LiveExecutionEvidenceStatus=(stateRef&&state!==null)||(phaseRef&&phase!==null)?'READ_ONLY':'MISSING';
  const rows:LiveExecutionEvidenceRow[]=[
    {area:'TASKS_DEPENDENCIES',status:taskStatus,reason:taskReason,evidence_refs:evidence([...byKind('PROJECT_STATE'),...taskRefs])},
    {area:'AUTHORIZATION',status:authStatus,reason:authStatus==='HISTORICAL_ONLY'?'OWNER_DECISIONS_PINNED_BUT_NO_CURRENT_NORMALIZED_AUTHORIZATION_WRITER':'NO_CURRENT_AUTHORIZATION_SOURCE_FOUND',evidence_refs:evidence(ownerRefs)},
    {area:'RESOURCES',status:'MISSING',reason:'CURRENT_UNIFIED_RESOURCE_ALLOCATION_NOT_DEPLOYED',evidence_refs:[]},
    {area:'CHARGES',status:chargeStatus,reason:chargeStatus==='HISTORICAL_ONLY'?'TASK_LEDGER_PINNED_BUT_NOT_A_CURRENT_CHARGE_LEDGER':'NO_CURRENT_CHARGE_SOURCE_FOUND',evidence_refs:evidence(ledgerRef?[ledgerRef]:[])},
    {area:'RESERVATIONS',status:'MISSING',reason:'RESOURCE_BUDGET_NOT_ATTACHED',evidence_refs:[]},
    {area:'STOP_UNKNOWN',status:stopStatus,reason:stopStatus==='READ_ONLY'?'WORKSPACE_PHASE_OR_PROJECT_STATE_PINNED_READ_ONLY':'NO_CURRENT_STOP_UNKNOWN_SOURCE_FOUND',evidence_refs:evidence([...(stateRef?[stateRef]:[]),...(phaseRef?[phaseRef]:[])])},
    {area:'IDENTITY',status:'READ_ONLY',reason:'XDEV_PROJECT_IDENTITY_BOUND_HOST_XMEM_EXECUTION_IDENTITY_NOT_BOUND',evidence_refs:[]},
  ];
  return{rows,task_summary:{task_files:taskRefs.length,malformed_task_files:malformed,active_task_ids:active,missing_active_task_ids:missing},owner_decision_count:ownerRefs.length};
}
function proposalCore(p:LiveExecutionEvidenceProposal){const {proposal_sha256,...rest}=p;return rest;}
function validateRow(r:any){check(exact(r,['area','status','reason','evidence_refs'])&&liveExecutionEvidenceAreas.includes(r.area)&&['LIVE_COVERED','READ_ONLY','HISTORICAL_ONLY','MISSING'].includes(r.status)&&text(r.reason)&&Array.isArray(r.evidence_refs)&&r.evidence_refs.every(text),'LIVE_EXECUTION_EVIDENCE_COVERAGE_INVALID');}
function validateSource(r:any){check(exact(r,['kind','path','sha256','size'])&&['PROJECT_STATE','TASK_LEDGER','PHASE','CURRENT_BASELINE','TASK_CONTRACT','OWNER_DECISION'].includes(r.kind)&&text(r.path)&&sha(r.sha256)&&Number.isSafeInteger(r.size)&&r.size>=0,'LIVE_EXECUTION_EVIDENCE_SOURCE_INVALID');canonicalAbs(r.path);}
function validateProposal(v:any):asserts v is LiveExecutionEvidenceProposal{
  check(exact(v,['format','purpose','project_id','control_root','control_binding_sha256','workspace_root','prepared_at','valid_until','sources','task_summary','owner_decision_count','coverage','proposal_sha256','execution_permitted','reservation_created','worker_started'])&&v.format==='xdev-live-execution-evidence-proposal-1'&&v.purpose==='BIND_REAL_WORKSPACE_EXECUTION_EVIDENCE_NO_PERMISSION','LIVE_EXECUTION_EVIDENCE_PROPOSAL_INVALID');
  check(text(v.project_id)&&sha(v.control_binding_sha256)&&parseRfc3339Timestamp(v.prepared_at)!==null&&parseRfc3339Timestamp(v.valid_until)!==null&&Array.isArray(v.sources)&&v.sources.length<=4096&&Array.isArray(v.coverage)&&v.coverage.length===liveExecutionEvidenceAreas.length&&sha(v.proposal_sha256),'LIVE_EXECUTION_EVIDENCE_PROPOSAL_INVALID');
  canonicalAbs(v.control_root);canonicalAbs(v.workspace_root);for(const r of v.sources)validateSource(r);for(const r of v.coverage)validateRow(r);
  check(v.task_summary&&Number.isSafeInteger(v.task_summary.task_files)&&Number.isSafeInteger(v.task_summary.malformed_task_files)&&Array.isArray(v.task_summary.active_task_ids)&&v.task_summary.active_task_ids.every(text)&&Array.isArray(v.task_summary.missing_active_task_ids)&&v.task_summary.missing_active_task_ids.every(text)&&Number.isSafeInteger(v.owner_decision_count)&&v.owner_decision_count>=0,'LIVE_EXECUTION_EVIDENCE_SUMMARY_INVALID');
  check(v.execution_permitted===false&&v.reservation_created===false&&v.worker_started===false,'LIVE_EXECUTION_EVIDENCE_PROPOSAL_INVALID');
  check(digest(proposalCore(v))===v.proposal_sha256,'LIVE_EXECUTION_EVIDENCE_PROPOSAL_DIGEST_INVALID');
}
function validateReceipt(v:any):asserts v is LiveExecutionEvidenceReceipt{
  check(exact(v,['format','state','proposal_sha256','project_id','control_binding_sha256','workspace_root','sources','task_summary','owner_decision_count','coverage','applied_at','execution_permitted','reservation_created','worker_started'])&&v.format==='xdev-live-execution-evidence-1'&&v.state==='APPLIED','LIVE_EXECUTION_EVIDENCE_RECEIPT_INVALID');
  check(sha(v.proposal_sha256)&&text(v.project_id)&&sha(v.control_binding_sha256)&&parseRfc3339Timestamp(v.applied_at)!==null&&Array.isArray(v.sources)&&Array.isArray(v.coverage)&&v.coverage.length===liveExecutionEvidenceAreas.length,'LIVE_EXECUTION_EVIDENCE_RECEIPT_INVALID');canonicalAbs(v.workspace_root);for(const r of v.sources)validateSource(r);for(const r of v.coverage)validateRow(r);check(v.execution_permitted===false&&v.reservation_created===false&&v.worker_started===false,'LIVE_EXECUTION_EVIDENCE_RECEIPT_INVALID');
}
function paths(root:string){return{proposal:join(root,'execution-facts-proposal.json'),receipt:join(root,'execution-facts.json'),lock:join(root,'source.lock')};}
function verifySources(sources:LiveExecutionSourceRef[]){for(const r of sources){const st=ordinaryFile(r.path);check(st.size===r.size,'LIVE_EXECUTION_EVIDENCE_SOURCE_DRIFT');const b=readFileSync(r.path);check(bytesSha(b)===r.sha256,'LIVE_EXECUTION_EVIDENCE_SOURCE_DRIFT');}}
function collectSources(workspace:string){
  const refs:LiveExecutionSourceRef[]=[];const add=(kind:LiveExecutionSourceRef['kind'],p:string)=>{if(existsSync(p))refs.push(pin(kind,p));};
  add('PROJECT_STATE',join(workspace,'.xdev','project-state.json'));add('TASK_LEDGER',join(workspace,'.xdev','task-ledger.jsonl'));add('PHASE',join(workspace,'.xdev','phase.json'));add('CURRENT_BASELINE',join(workspace,'CURRENT-BASELINE.md'));
  refs.push(...listOrdinaryJson(join(workspace,'.xdev','tasks'),'TASK_CONTRACT'));refs.push(...listOrdinaryJson(join(workspace,'.xdev','owner-decisions'),'OWNER_DECISION'));
  check(refs.length<=4096,'LIVE_EXECUTION_EVIDENCE_TOO_MANY_FILES');check(refs.reduce((n,r)=>n+r.size,0)<=64*1024*1024,'LIVE_EXECUTION_EVIDENCE_TOO_MANY_BYTES');return refs;
}

export async function prepareLiveExecutionEvidence(controlRootInput:string,bindingSha:string,outInput:string,clock:()=>number=Date.now){
  const controlRoot=canonicalAbs(controlRootInput),out=canonicalAbs(outInput);check(sha(bindingSha),'LIVE_EXECUTION_EVIDENCE_BINDING_DIGEST_INVALID');check(!existsSync(out),'LIVE_EXECUTION_EVIDENCE_PROPOSAL_OUTPUT_EXISTS');
  const boundary=new FileControlSourceBoundary(controlRoot,bindingSha,clock),binding=boundary.binding;check(binding.format==='xdev-control-binding-3','LIVE_EXECUTION_EVIDENCE_REQUIRES_REAL_UNBOUND_SOURCE');const workspace=binding.workspace_root;canonicalAbs(workspace);
  const sources=collectSources(workspace),classified=classify(workspace,sources),now=clock();check(Number.isFinite(now)&&now>=0,'LIVE_EXECUTION_EVIDENCE_TIME_INVALID');const until=now+LIVE_EXECUTION_EVIDENCE_VALIDITY_MS;check(Number.isSafeInteger(until),'LIVE_EXECUTION_EVIDENCE_TIME_INVALID');
  const core={format:'xdev-live-execution-evidence-proposal-1' as const,purpose:'BIND_REAL_WORKSPACE_EXECUTION_EVIDENCE_NO_PERMISSION' as const,project_id:boundary.binding.project_id,control_root:controlRoot,control_binding_sha256:bindingSha,workspace_root:workspace,prepared_at:new Date(now).toISOString(),valid_until:new Date(until).toISOString(),sources,task_summary:classified.task_summary,owner_decision_count:classified.owner_decision_count,coverage:classified.rows,execution_permitted:false as const,reservation_created:false as const,worker_started:false as const};
  const proposal:LiveExecutionEvidenceProposal={...core,proposal_sha256:digest(core)};writeNew(out,proposal);return{status:'LIVE_EXECUTION_EVIDENCE_PROPOSAL_PREPARED' as const,proposal_path:out,proposal_sha256:proposal.proposal_sha256,project_id:proposal.project_id,coverage:proposal.coverage,task_summary:proposal.task_summary,owner_decision_count:proposal.owner_decision_count,valid_until:proposal.valid_until,execution_permitted:false,reservation_created:false,worker_started:false};
}

export async function applyLiveExecutionEvidence(proposalPathInput:string,confirmedDigest:string,ack:string,clock:()=>number=Date.now){
  check(ack===LIVE_EXECUTION_EVIDENCE_ACK,'LIVE_EXECUTION_EVIDENCE_EXPLICIT_ACK_REQUIRED');check(sha(confirmedDigest),'LIVE_EXECUTION_EVIDENCE_CONFIRMATION_INVALID');const proposalPath=canonicalAbs(proposalPathInput);const proposal=parseUniqueJson(readControlBytes(proposalPath).toString('utf8'));validateProposal(proposal);check(proposal.proposal_sha256===confirmedDigest,'LIVE_EXECUTION_EVIDENCE_CONFIRMATION_MISMATCH');
  const now=clock(),prepared=parseRfc3339Timestamp(proposal.prepared_at),until=parseRfc3339Timestamp(proposal.valid_until);check(Number.isFinite(now)&&prepared!==null&&until!==null&&now>=prepared&&now<until,'LIVE_EXECUTION_EVIDENCE_PROPOSAL_EXPIRED_OR_CLOCK_INVALID');verifySources(proposal.sources);
  const boundary=new FileControlSourceBoundary(proposal.control_root,proposal.control_binding_sha256,clock),binding=boundary.binding;check(binding.format==='xdev-control-binding-3','LIVE_EXECUTION_EVIDENCE_CONTROL_CHANGED');check(binding.project_id===proposal.project_id&&binding.workspace_root===proposal.workspace_root,'LIVE_EXECUTION_EVIDENCE_CONTROL_CHANGED');
  const p=paths(proposal.control_root);if(existsSync(p.receipt)||existsSync(p.proposal)){check(existsSync(p.receipt)&&existsSync(p.proposal),'LIVE_EXECUTION_EVIDENCE_PARTIAL_MANUAL_REVIEW_REQUIRED');const stored=parseUniqueJson(readControlBytes(p.proposal).toString('utf8'));validateProposal(stored);const receipt=parseUniqueJson(readControlBytes(p.receipt).toString('utf8'));validateReceipt(receipt);check(stored.proposal_sha256===proposal.proposal_sha256&&receipt.proposal_sha256===proposal.proposal_sha256,'LIVE_EXECUTION_EVIDENCE_BOUND_TO_DIFFERENT_PROPOSAL');return inspectLiveExecutionEvidence(proposal.control_root,proposal.control_binding_sha256,clock);}
  controlNoLinks(p.lock);let lockId:string|null=null;try{mkdirSync(p.lock,{mode:0o700});const s=lstatSync(p.lock);check(s.isDirectory()&&!s.isSymbolicLink(),'LIVE_EXECUTION_EVIDENCE_LOCK_INVALID');lockId=`${s.dev}:${s.ino}`;}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('LIVE_EXECUTION_EVIDENCE_BUSY_OR_OWNER_UNKNOWN');throw e;}
  try{verifySources(proposal.sources);const current=parseUniqueJson(readControlBytes(proposalPath).toString('utf8'));validateProposal(current);check(current.proposal_sha256===confirmedDigest&&canonicalJson(current as any)===canonicalJson(proposal as any),'LIVE_EXECUTION_EVIDENCE_PROPOSAL_CHANGED');writeNew(p.proposal,proposal);const receipt:LiveExecutionEvidenceReceipt={format:'xdev-live-execution-evidence-1',state:'APPLIED',proposal_sha256:proposal.proposal_sha256,project_id:proposal.project_id,control_binding_sha256:proposal.control_binding_sha256,workspace_root:proposal.workspace_root,sources:structuredClone(proposal.sources),task_summary:structuredClone(proposal.task_summary),owner_decision_count:proposal.owner_decision_count,coverage:structuredClone(proposal.coverage),applied_at:new Date(now).toISOString(),execution_permitted:false,reservation_created:false,worker_started:false};writeNew(p.receipt,receipt);}finally{const s=lstatSync(p.lock);check(s.isDirectory()&&!s.isSymbolicLink()&&`${s.dev}:${s.ino}`===lockId,'LIVE_EXECUTION_EVIDENCE_LOCK_REPLACED');rmdirSync(p.lock);}
  return inspectLiveExecutionEvidence(proposal.control_root,proposal.control_binding_sha256,clock);
}

export async function inspectLiveExecutionEvidence(controlRootInput:string,bindingSha:string,clock:()=>number=Date.now){
  const root=canonicalAbs(controlRootInput);check(sha(bindingSha),'LIVE_EXECUTION_EVIDENCE_BINDING_DIGEST_INVALID');const boundary=new FileControlSourceBoundary(root,bindingSha,clock);const p=paths(root);check(existsSync(p.proposal)&&existsSync(p.receipt),'LIVE_EXECUTION_EVIDENCE_NOT_ATTACHED');const proposal=parseUniqueJson(readControlBytes(p.proposal).toString('utf8'));validateProposal(proposal);const receipt=parseUniqueJson(readControlBytes(p.receipt).toString('utf8'));validateReceipt(receipt);check(receipt.proposal_sha256===proposal.proposal_sha256&&receipt.control_binding_sha256===bindingSha&&receipt.project_id===boundary.binding.project_id&&receipt.workspace_root===(boundary.binding as any).workspace_root,'LIVE_EXECUTION_EVIDENCE_RECEIPT_BINDING_MISMATCH');
  let stale=false;let error:string|null=null;try{verifySources(receipt.sources);}catch(e){stale=true;error=e instanceof Error?e.message:'LIVE_EXECUTION_EVIDENCE_SOURCE_DRIFT';}
  return{status:stale?'LIVE_EXECUTION_EVIDENCE_STALE_NOT_AUTHORIZED' as const:'LIVE_EXECUTION_EVIDENCE_ATTACHED_READ_ONLY_NOT_AUTHORIZED' as const,project_id:receipt.project_id,control_root:root,control_binding_sha256:bindingSha,workspace_root:receipt.workspace_root,coverage:structuredClone(receipt.coverage),task_summary:structuredClone(receipt.task_summary),owner_decision_count:receipt.owner_decision_count,sources:structuredClone(receipt.sources),stale,error,execution_permitted:false,reservation_created:false,worker_started:false};
}

export function readLiveExecutionCoverage(controlRootInput:string,bindingSha:string){
  const root=canonicalAbs(controlRootInput);const p=paths(root);if(!existsSync(p.receipt)||!existsSync(p.proposal))return null;const proposal=parseUniqueJson(readControlBytes(p.proposal).toString('utf8'));validateProposal(proposal);const receipt=parseUniqueJson(readControlBytes(p.receipt).toString('utf8'));validateReceipt(receipt);check(receipt.control_binding_sha256===bindingSha&&receipt.proposal_sha256===proposal.proposal_sha256,'LIVE_EXECUTION_EVIDENCE_RECEIPT_BINDING_MISMATCH');
  let stale=false;try{verifySources(receipt.sources);}catch{stale=true;}
  const rows=receipt.coverage.map(r=>stale?{...r,status:'MISSING' as const,reason:'PINNED_WORKSPACE_EVIDENCE_DRIFTED'}:structuredClone(r));
  const support=[...receipt.sources.map(r=>({path:r.path,sha256:r.sha256})),{path:p.receipt,sha256:bytesSha(readControlBytes(p.receipt))},{path:p.proposal,sha256:bytesSha(readControlBytes(p.proposal))}];
  return{stale,rows,support};
}
