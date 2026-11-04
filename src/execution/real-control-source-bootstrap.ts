/** R4.15 real control-source bootstrap and attach.
 *
 * This creates a private FileControlSourceBoundary bound to the already-applied
 * R4.14 XDev project identity, then attaches it to the R4.13 real control root.
 * The initial binding is deliberately UPSTREAM_UNBOUND_NO_BUDGET: it creates no
 * resource, allocation, charge, reservation, authorization or CURRENT source.
 * The resulting live-boundary snapshot is explicitly INCOMPLETE/UNKNOWN and
 * globally stopped until later real writer adapters are attached.
 */
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,rmdirSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {canonicalJson} from '../planning/governance-contracts.ts';
import {parseRfc3339Timestamp,parseUniqueJson} from '../planning/retry-history.ts';
import {controlBindingDigest,controlNoLinks,FileControlSourceBoundary,initializeUnboundControlSource,readControlBytes,type UnboundControlBinding} from './control-source-boundary.ts';
import {inspectProjectIdentity} from './project-identity-bootstrap.ts';
import {attachRealControlSource,inspectRealControlRoot,refreshRealControlRoot,REAL_CONTROL_ATTACH_ACK} from './real-control-root.ts';

export const REAL_CONTROL_SOURCE_ACK='DEPLOY_REAL_CONTROL_SOURCE_AND_ATTACH_NO_PERMISSION';
export const REAL_CONTROL_SOURCE_VALIDITY_MS=60*60*1000;

export type RealControlSourceProposal={
  format:'xdev-real-control-source-proposal-1';
  purpose:'DEPLOY_UPSTREAM_UNBOUND_REAL_CONTROL_SOURCE_AND_ATTACH';
  identity_root:string;
  control_source_root:string;
  workspace_root:string;
  project_id:string;
  authority_id:string;
  project_identity_proposal_sha256:string;
  identity_ref:UnboundControlBinding['identity_ref'];
  binding_sha256:string;
  prepared_at:string;
  valid_until:string;
  execution_permitted:false;
  reservation_created:false;
  worker_started:false;
  proposal_sha256:string;
};

type Receipt={
  format:'xdev-real-control-source-receipt-1';state:'APPLIED';proposal_sha256:string;binding_sha256:string;project_id:string;identity_root:string;control_source_root:string;real_control_root_status:string;live_generation:number;applied_at:string;execution_permitted:false;reservation_created:false;worker_started:false;
};

const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function check(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
function exact(v:any,keys:string[]){return v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');}
const digest=(v:unknown)=>createHash('sha256').update(canonicalJson(v as any)).digest('hex');
const bytesSha=(path:string)=>createHash('sha256').update(readControlBytes(path)).digest('hex');
function canonicalAbs(p:string,code='REAL_CONTROL_SOURCE_PATH_NOT_CANONICAL'){check(isAbsolute(p)&&resolve(p)===p,code);controlNoLinks(p);return p;}
function inside(root:string,p:string){const r=relative(root,p);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));}
function ordinaryDir(p:string,code:string){canonicalAbs(p);const s=lstatSync(p);check(s.isDirectory()&&!s.isSymbolicLink()&&realpathSync(p)===p,code);}
function writeNew(path:string,value:unknown){controlNoLinks(path);let fd:number|undefined;try{fd=openSync(path,'wx',0o600);writeFileSync(fd,canonicalJson(value as any));fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}}
function core(p:Omit<RealControlSourceProposal,'proposal_sha256'>|RealControlSourceProposal){const {proposal_sha256:_,...v}=p as RealControlSourceProposal;return v;}
function projectId(v:unknown):v is string{return typeof v==='string'&&/^xdev-project:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);}
function authorityId(v:unknown):v is string{return typeof v==='string'&&/^xdev-control-source:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);}
function paths(root:string){return{proposal:join(root,'control-source-proposal.json'),receipt:join(root,'control-source-bootstrap.json')};}
function identityFiles(root:string){return{identity:join(root,'identity.json'),bootstrap:join(root,'identity-bootstrap.json')};}
function ensureLayout(identityRoot:string,sourceRoot:string,workspace:string,proposalPath?:string){
  canonicalAbs(identityRoot);canonicalAbs(sourceRoot);canonicalAbs(workspace);ordinaryDir(identityRoot,'REAL_CONTROL_SOURCE_IDENTITY_ROOT_INVALID');ordinaryDir(workspace,'REAL_CONTROL_SOURCE_WORKSPACE_INVALID');ordinaryDir(dirname(sourceRoot),'REAL_CONTROL_SOURCE_PARENT_INVALID');
  check(!inside(workspace,sourceRoot)&&!inside(sourceRoot,workspace)&&!inside(identityRoot,sourceRoot)&&!inside(sourceRoot,identityRoot),'REAL_CONTROL_SOURCE_ROOT_OVERLAP');
  if(proposalPath){canonicalAbs(proposalPath);ordinaryDir(dirname(proposalPath),'REAL_CONTROL_SOURCE_PROPOSAL_PARENT_INVALID');check(!inside(workspace,proposalPath)&&!inside(identityRoot,proposalPath)&&!inside(sourceRoot,proposalPath),'REAL_CONTROL_SOURCE_PROPOSAL_OVERLAP');}
}
function validateProposal(v:any):asserts v is RealControlSourceProposal{
  const keys=['format','purpose','identity_root','control_source_root','workspace_root','project_id','authority_id','project_identity_proposal_sha256','identity_ref','binding_sha256','prepared_at','valid_until','execution_permitted','reservation_created','worker_started','proposal_sha256'];
  check(exact(v,keys)&&v.format==='xdev-real-control-source-proposal-1'&&v.purpose==='DEPLOY_UPSTREAM_UNBOUND_REAL_CONTROL_SOURCE_AND_ATTACH','REAL_CONTROL_SOURCE_PROPOSAL_INVALID');
  check(projectId(v.project_id)&&authorityId(v.authority_id)&&sha(v.project_identity_proposal_sha256)&&sha(v.binding_sha256)&&sha(v.proposal_sha256)&&v.execution_permitted===false&&v.reservation_created===false&&v.worker_started===false,'REAL_CONTROL_SOURCE_PROPOSAL_INVALID');
  check(exact(v.identity_ref,['identity_path','identity_sha256','bootstrap_path','bootstrap_sha256'])&&sha(v.identity_ref.identity_sha256)&&sha(v.identity_ref.bootstrap_sha256),'REAL_CONTROL_SOURCE_PROPOSAL_INVALID');
  const prepared=parseRfc3339Timestamp(v.prepared_at),until=parseRfc3339Timestamp(v.valid_until);check(prepared!==null&&until!==null&&until>prepared,'REAL_CONTROL_SOURCE_PROPOSAL_TIME_INVALID');
  ensureLayout(v.identity_root,v.control_source_root,v.workspace_root);controlNoLinks(v.identity_ref.identity_path);controlNoLinks(v.identity_ref.bootstrap_path);
  check(digest(core(v))===v.proposal_sha256,'REAL_CONTROL_SOURCE_PROPOSAL_DIGEST_INVALID');
  const binding:UnboundControlBinding={format:'xdev-control-binding-3',mode:'UPSTREAM_UNBOUND_NO_BUDGET',project_id:v.project_id,authority_id:v.authority_id,scope_ref:'project-identity:'+v.project_identity_proposal_sha256,workspace_root:v.workspace_root,identity_ref:structuredClone(v.identity_ref)};
  check(controlBindingDigest(binding)===v.binding_sha256,'REAL_CONTROL_SOURCE_BINDING_DIGEST_INVALID');
}
function validateReceipt(v:any):asserts v is Receipt{
  const keys=['format','state','proposal_sha256','binding_sha256','project_id','identity_root','control_source_root','real_control_root_status','live_generation','applied_at','execution_permitted','reservation_created','worker_started'];
  check(exact(v,keys)&&v.format==='xdev-real-control-source-receipt-1'&&v.state==='APPLIED','REAL_CONTROL_SOURCE_RECEIPT_INVALID');
  check(sha(v.proposal_sha256)&&sha(v.binding_sha256)&&projectId(v.project_id)&&text(v.identity_root)&&text(v.control_source_root)&&text(v.real_control_root_status)&&Number.isSafeInteger(v.live_generation)&&v.live_generation>=1&&parseRfc3339Timestamp(v.applied_at)!==null,'REAL_CONTROL_SOURCE_RECEIPT_INVALID');
  check(v.execution_permitted===false&&v.reservation_created===false&&v.worker_started===false,'REAL_CONTROL_SOURCE_RECEIPT_INVALID');
}
async function currentIdentity(identityRoot:string,clock:()=>number=Date.now){
  const status=await inspectProjectIdentity(identityRoot,clock);check(status.status==='PROJECT_IDENTITY_ESTABLISHED_NOT_AUTHORIZED','REAL_CONTROL_SOURCE_PROJECT_IDENTITY_NOT_READY');
  const f=identityFiles(identityRoot);const identitySha=bytesSha(f.identity),bootstrapSha=bytesSha(f.bootstrap);
  return{status,identity_ref:{identity_path:f.identity,identity_sha256:identitySha,bootstrap_path:f.bootstrap,bootstrap_sha256:bootstrapSha}};
}

export async function prepareRealControlSource(identityRootInput:string,sourceRootInput:string,outputInput:string,clock:()=>number=Date.now){
  const identityRoot=canonicalAbs(identityRootInput),sourceRoot=canonicalAbs(sourceRootInput),out=canonicalAbs(outputInput);const cur=await currentIdentity(identityRoot,clock);ensureLayout(identityRoot,sourceRoot,cur.status.workspace_root,out);
  check(!existsSync(sourceRoot),'REAL_CONTROL_SOURCE_ROOT_EXISTS');check(!existsSync(out),'REAL_CONTROL_SOURCE_PROPOSAL_OUTPUT_EXISTS');
  const now=clock();check(Number.isFinite(now)&&now>=0,'REAL_CONTROL_SOURCE_TIME_INVALID');const until=now+REAL_CONTROL_SOURCE_VALIDITY_MS;check(Number.isSafeInteger(until),'REAL_CONTROL_SOURCE_TIME_INVALID');
  const authority='xdev-control-source:'+randomUUID();const binding:UnboundControlBinding={format:'xdev-control-binding-3',mode:'UPSTREAM_UNBOUND_NO_BUDGET',project_id:cur.status.project_id,authority_id:authority,scope_ref:'project-identity:'+cur.status.proposal_sha256,workspace_root:cur.status.workspace_root,identity_ref:cur.identity_ref};
  const bindingSha=controlBindingDigest(binding);
  const c:Omit<RealControlSourceProposal,'proposal_sha256'>={format:'xdev-real-control-source-proposal-1',purpose:'DEPLOY_UPSTREAM_UNBOUND_REAL_CONTROL_SOURCE_AND_ATTACH',identity_root:identityRoot,control_source_root:sourceRoot,workspace_root:cur.status.workspace_root,project_id:cur.status.project_id,authority_id:authority,project_identity_proposal_sha256:cur.status.proposal_sha256,identity_ref:cur.identity_ref,binding_sha256:bindingSha,prepared_at:new Date(now).toISOString(),valid_until:new Date(until).toISOString(),execution_permitted:false,reservation_created:false,worker_started:false};
  const p:RealControlSourceProposal={...c,proposal_sha256:digest(c)};writeNew(out,p);
  return{status:'REAL_CONTROL_SOURCE_PROPOSAL_PREPARED' as const,proposal_path:out,proposal_sha256:p.proposal_sha256,project_id:p.project_id,control_source_root:p.control_source_root,binding_sha256:p.binding_sha256,valid_until:p.valid_until,execution_permitted:false,reservation_created:false,worker_started:false};
}

export async function applyRealControlSource(proposalPathInput:string,confirmedDigest:string,ack:string,clock:()=>number=Date.now){
  check(ack===REAL_CONTROL_SOURCE_ACK,'REAL_CONTROL_SOURCE_EXPLICIT_ACK_REQUIRED');check(sha(confirmedDigest),'REAL_CONTROL_SOURCE_CONFIRMATION_INVALID');
  const proposalPath=canonicalAbs(proposalPathInput),proposal=parseUniqueJson(readControlBytes(proposalPath).toString('utf8'));validateProposal(proposal);check(proposal.proposal_sha256===confirmedDigest,'REAL_CONTROL_SOURCE_CONFIRMATION_MISMATCH');ensureLayout(proposal.identity_root,proposal.control_source_root,proposal.workspace_root,proposalPath);
  const sourceRoot=proposal.control_source_root,{proposal:proposalCopy,receipt:receiptPath}=paths(sourceRoot);
  if(existsSync(sourceRoot)){
    if(!existsSync(proposalCopy)||!existsSync(receiptPath))throw Error('REAL_CONTROL_SOURCE_PARTIAL_MANUAL_REVIEW_REQUIRED');
    const stored=parseUniqueJson(readControlBytes(proposalCopy).toString('utf8'));validateProposal(stored);const receipt=parseUniqueJson(readControlBytes(receiptPath).toString('utf8'));validateReceipt(receipt);check(stored.proposal_sha256===proposal.proposal_sha256&&receipt.proposal_sha256===proposal.proposal_sha256,'REAL_CONTROL_SOURCE_BOUND_TO_DIFFERENT_PROPOSAL');
    return{...(await inspectRealControlSource(sourceRoot,clock)),status:'REAL_CONTROL_SOURCE_ALREADY_APPLIED' as const};
  }
  const now=clock(),prepared=parseRfc3339Timestamp(proposal.prepared_at),until=parseRfc3339Timestamp(proposal.valid_until);check(Number.isFinite(now)&&prepared!==null&&until!==null&&now>=prepared&&now<until,'REAL_CONTROL_SOURCE_PROPOSAL_EXPIRED_OR_CLOCK_INVALID');
  const cur=await currentIdentity(proposal.identity_root,clock);check(cur.status.project_id===proposal.project_id&&cur.status.workspace_root===proposal.workspace_root&&cur.status.proposal_sha256===proposal.project_identity_proposal_sha256,'REAL_CONTROL_SOURCE_PROJECT_IDENTITY_CHANGED');check(cur.identity_ref.identity_sha256===proposal.identity_ref.identity_sha256&&cur.identity_ref.bootstrap_sha256===proposal.identity_ref.bootstrap_sha256,'REAL_CONTROL_SOURCE_PROJECT_IDENTITY_DRIFT');
  const lock=sourceRoot+'.real-control-source.lock';controlNoLinks(lock);let lockId:string|null=null;
  try{mkdirSync(lock,{mode:0o700});const s=lstatSync(lock);check(s.isDirectory()&&!s.isSymbolicLink(),'REAL_CONTROL_SOURCE_LOCK_INVALID');lockId=`${s.dev}:${s.ino}`;}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('REAL_CONTROL_SOURCE_BUSY_OR_OWNER_UNKNOWN');throw e;}
  try{
    const again=parseUniqueJson(readControlBytes(proposalPath).toString('utf8'));validateProposal(again);check(again.proposal_sha256===confirmedDigest&&canonicalJson(again as any)===canonicalJson(proposal as any),'REAL_CONTROL_SOURCE_PROPOSAL_CHANGED');
    const binding:UnboundControlBinding={format:'xdev-control-binding-3',mode:'UPSTREAM_UNBOUND_NO_BUDGET',project_id:proposal.project_id,authority_id:proposal.authority_id,scope_ref:'project-identity:'+proposal.project_identity_proposal_sha256,workspace_root:proposal.workspace_root,identity_ref:structuredClone(proposal.identity_ref)};
    const deployed=initializeUnboundControlSource(sourceRoot,binding,proposal.binding_sha256);writeNew(proposalCopy,proposal);
    const attached=await attachRealControlSource(proposal.identity_root,sourceRoot,proposal.binding_sha256,REAL_CONTROL_ATTACH_ACK,clock);check(attached.status==='REAL_CONTROL_ROOT_ATTACHED_NOT_AUTHORIZED','REAL_CONTROL_SOURCE_ATTACH_UNEXPECTED');
    const refreshed=await refreshRealControlRoot(proposal.identity_root,clock);check(refreshed.refresh.snapshot_coverage==='INCOMPLETE'&&refreshed.refresh.snapshot_freshness==='UNKNOWN','REAL_CONTROL_SOURCE_UNEXPECTED_COMPLETE_SNAPSHOT');
    const rootStatus=await inspectRealControlRoot(proposal.identity_root,clock);check(rootStatus.status==='BOUNDARY_COVERAGE_INCOMPLETE','REAL_CONTROL_SOURCE_UNEXPECTED_LIVE_COVERAGE');
    const appliedAt=clock();check(Number.isFinite(appliedAt)&&appliedAt>=now,'REAL_CONTROL_SOURCE_TIME_INVALID');const receipt:Receipt={format:'xdev-real-control-source-receipt-1',state:'APPLIED',proposal_sha256:proposal.proposal_sha256,binding_sha256:deployed.binding_sha256,project_id:proposal.project_id,identity_root:proposal.identity_root,control_source_root:sourceRoot,real_control_root_status:rootStatus.status,live_generation:refreshed.refresh.generation,applied_at:new Date(appliedAt).toISOString(),execution_permitted:false,reservation_created:false,worker_started:false};writeNew(receiptPath,receipt);
    return{status:'REAL_CONTROL_SOURCE_ATTACHED_INCOMPLETE_NOT_AUTHORIZED' as const,project_id:proposal.project_id,control_source_root:sourceRoot,binding_sha256:proposal.binding_sha256,real_control_root_status:rootStatus.status,coverage:rootStatus.coverage,live_generation:receipt.live_generation,execution_permitted:false,reservation_created:false,worker_started:false};
  }finally{const s=lstatSync(lock);check(s.isDirectory()&&!s.isSymbolicLink()&&`${s.dev}:${s.ino}`===lockId,'REAL_CONTROL_SOURCE_LOCK_REPLACED');rmdirSync(lock);}
}

export async function inspectRealControlSource(sourceRootInput:string,clock:()=>number=Date.now){
  const root=canonicalAbs(sourceRootInput);ordinaryDir(root,'REAL_CONTROL_SOURCE_ROOT_INVALID');const {proposal:proposalPath,receipt:receiptPath}=paths(root);check(existsSync(proposalPath)&&existsSync(receiptPath),'REAL_CONTROL_SOURCE_PARTIAL_MANUAL_REVIEW_REQUIRED');
  const proposal=parseUniqueJson(readControlBytes(proposalPath).toString('utf8'));validateProposal(proposal);const receipt=parseUniqueJson(readControlBytes(receiptPath).toString('utf8'));validateReceipt(receipt);check(receipt.proposal_sha256===proposal.proposal_sha256&&receipt.binding_sha256===proposal.binding_sha256&&receipt.project_id===proposal.project_id&&receipt.control_source_root===root,'REAL_CONTROL_SOURCE_RECEIPT_BINDING_MISMATCH');
  const boundary=new FileControlSourceBoundary(root,proposal.binding_sha256,clock);check(boundary.binding.format==='xdev-control-binding-3'&&boundary.binding.project_id===proposal.project_id,'REAL_CONTROL_SOURCE_BOUNDARY_MISMATCH');const rootStatus=await inspectRealControlRoot(proposal.identity_root,clock);check(rootStatus.state.attachment?.state==='APPLIED'&&rootStatus.state.attachment.control_root===root&&rootStatus.state.attachment.binding_sha256===proposal.binding_sha256,'REAL_CONTROL_SOURCE_REAL_ROOT_MISMATCH');
  return{status:'REAL_CONTROL_SOURCE_ATTACHED_INCOMPLETE_NOT_AUTHORIZED' as const,project_id:proposal.project_id,identity_root:proposal.identity_root,control_source_root:root,binding_sha256:proposal.binding_sha256,boundary:await boundary.describe(),real_control_root_status:rootStatus.status,coverage:rootStatus.coverage,live:rootStatus.live,execution_permitted:false,reservation_created:false,worker_started:false};
}
