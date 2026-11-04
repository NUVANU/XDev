/** R4.13 real XDev management control-root bootstrap.
 *
 * This deploys the durable management root BEFORE a live FileControlSourceBoundary
 * exists. It deliberately does not invent ProjectFacts, a budget allocation, a
 * resource id, authorization, STOP exception, or execution permission. A real
 * control source may later be attached in a separate, guarded transition; only
 * then does the existing R4.12 live-boundary deployment become available.
 *
 * The management root must live outside the project workspace so normal Workers
 * do not receive it as an ordinary workspace path. OS ACL quality remains a
 * deployment responsibility; path separation is not an ACL proof.
 */
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,renameSync,rmdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {canonicalJson} from '../planning/governance-contracts.ts';
import {parseRfc3339Timestamp,parseUniqueJson} from '../planning/retry-history.ts';
import {FileControlSourceBoundary,controlNoLinks,readControlBytes} from './control-source-boundary.ts';
import {initializeLiveBoundaryDeployment,inspectLiveBoundaryDeployment,refreshLiveBoundaryDeployment,LIVE_BOUNDARY_ACK,type LiveBoundaryCoverage,liveFactAreas} from './live-boundary-deployment.ts';

export const REAL_CONTROL_ROOT_ACK='DEPLOY_REAL_CONTROL_ROOT_NO_PERMISSION';
export const REAL_CONTROL_ATTACH_ACK='ATTACH_EXISTING_CONTROL_SOURCE_NO_PERMISSION';

type Identity={
  format:'xdev-real-control-root-identity-1';root_id:string;project_id:string;
  workspace_root:string;created_at:string;
};
type Attachment={
  state:'PREPARED'|'APPLIED';control_root:string;binding_sha256:string;
  live_deployment_root:string;prepared_at:string;applied_at?:string;
};
type State={format:'xdev-real-control-root-state-1';identity_sha256:string;revision:number;attachment:Attachment|null};
export type RealControlRootStatus={
  status:'REAL_CONTROL_ROOT_DEPLOYED_UNBOUND'|'REAL_CONTROL_ROOT_ATTACH_PREPARED_MANUAL_REVIEW_REQUIRED'|'BOUNDARY_COVERAGE_INCOMPLETE'|'LIVE_BOUNDARY_COVERAGE_COMPLETE_NOT_AUTHORIZED';
  identity:Identity;state:State;coverage:LiveBoundaryCoverage;live:null|Awaited<ReturnType<typeof inspectLiveBoundaryDeployment>>;
  execution_permitted:false;reservation_created:false;worker_started:false;
};

const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function check(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
const digest=(v:unknown)=>createHash('sha256').update(canonicalJson(v as any)).digest('hex');
function exactKeys(v:any,keys:string[]){return v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');}
function canonicalAbs(p:string,code='REAL_CONTROL_ROOT_PATH_NOT_CANONICAL'){check(isAbsolute(p)&&resolve(p)===p,code);controlNoLinks(p);return p;}
function inside(root:string,p:string){const r=relative(root,p);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));}
function ordinaryDir(p:string,code:string){canonicalAbs(p);const s=lstatSync(p);check(s.isDirectory()&&!s.isSymbolicLink()&&realpathSync(p)===p,code);}
function writeNew(path:string,value:unknown){let fd:number|undefined;try{fd=openSync(path,'wx',0o600);writeFileSync(fd,canonicalJson(value as any));fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}}
function writeAtomic(path:string,value:unknown){const tmp=path+'.'+randomUUID()+'.tmp';let fd:number|undefined;try{fd=openSync(tmp,'wx',0o600);writeFileSync(fd,canonicalJson(value as any));fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(tmp,path);}finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(tmp);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}}
function validateIdentity(v:any):asserts v is Identity{
  check(exactKeys(v,['format','root_id','project_id','workspace_root','created_at'])&&v.format==='xdev-real-control-root-identity-1','REAL_CONTROL_ROOT_IDENTITY_INVALID');
  check(text(v.root_id)&&text(v.project_id)&&parseRfc3339Timestamp(v.created_at)!==null,'REAL_CONTROL_ROOT_IDENTITY_INVALID');canonicalAbs(v.workspace_root);ordinaryDir(v.workspace_root,'REAL_CONTROL_ROOT_WORKSPACE_INVALID');
}
function validateAttachment(v:any){
  check(exactKeys(v,v?.state==='APPLIED'?['state','control_root','binding_sha256','live_deployment_root','prepared_at','applied_at']:['state','control_root','binding_sha256','live_deployment_root','prepared_at'])&&['PREPARED','APPLIED'].includes(v.state),'REAL_CONTROL_ROOT_ATTACHMENT_INVALID');
  check(sha(v.binding_sha256)&&parseRfc3339Timestamp(v.prepared_at)!==null&&(v.state!=='APPLIED'||parseRfc3339Timestamp(v.applied_at)!==null),'REAL_CONTROL_ROOT_ATTACHMENT_INVALID');
  canonicalAbs(v.control_root);canonicalAbs(v.live_deployment_root);
}
function validateState(v:any,identitySha:string):asserts v is State{
  check(exactKeys(v,['format','identity_sha256','revision','attachment'])&&v.format==='xdev-real-control-root-state-1'&&v.identity_sha256===identitySha&&Number.isSafeInteger(v.revision)&&v.revision>=0,'REAL_CONTROL_ROOT_STATE_INVALID');
  if(v.attachment!==null)validateAttachment(v.attachment);
}
function rootPaths(rootInput:string){const root=canonicalAbs(rootInput);return{root,identityPath:join(root,'identity.json'),statePath:join(root,'state.json'),lock:join(root,'management.lock'),live:join(root,'live-boundary')};}
function readRoot(rootInput:string){
  const p=rootPaths(rootInput);ordinaryDir(p.root,'REAL_CONTROL_ROOT_INVALID');
  const identity=parseUniqueJson(readControlBytes(p.identityPath).toString('utf8'));validateIdentity(identity);const identitySha=digest(identity);
  const state=parseUniqueJson(readControlBytes(p.statePath).toString('utf8'));validateState(state,identitySha);
  check(!inside(identity.workspace_root,p.root)&&!inside(p.root,identity.workspace_root),'REAL_CONTROL_ROOT_WORKSPACE_OVERLAP');
  return{...p,identity,state,identitySha};
}
async function locked<T>(rootInput:string,fn:(r:ReturnType<typeof readRoot>)=>Promise<T>):Promise<T>{
  const before=readRoot(rootInput);try{mkdirSync(before.lock,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('REAL_CONTROL_ROOT_BUSY_OR_OWNER_UNKNOWN');throw e;}
  const s=lstatSync(before.lock),id=`${s.dev}:${s.ino}`;
  try{return await fn(readRoot(rootInput));}finally{const end=lstatSync(before.lock);check(end.isDirectory()&&!end.isSymbolicLink()&&`${end.dev}:${end.ino}`===id,'REAL_CONTROL_ROOT_LOCK_REPLACED');rmdirSync(before.lock);}
}
function missingCoverage(projectId:string):LiveBoundaryCoverage{return{format:'xdev-live-boundary-coverage-1',project_id:projectId,adapter:'CONTROL_BUDGET',areas:liveFactAreas.map(area=>({area,status:'MISSING' as const,reason:'REAL_CONTROL_SOURCE_NOT_ATTACHED',evidence_refs:[]})),all_live_covered:false,execution_permitted:false};}

export function initializeRealControlRoot(rootInput:string,projectId:string,workspaceInput:string,ack:string,clock:()=>number=Date.now){
  check(ack===REAL_CONTROL_ROOT_ACK,'REAL_CONTROL_ROOT_EXPLICIT_ACK_REQUIRED');check(text(projectId),'REAL_CONTROL_ROOT_PROJECT_INVALID');
  const root=canonicalAbs(rootInput),workspace=canonicalAbs(workspaceInput);ordinaryDir(workspace,'REAL_CONTROL_ROOT_WORKSPACE_INVALID');
  check(!inside(workspace,root)&&!inside(root,workspace),'REAL_CONTROL_ROOT_WORKSPACE_OVERLAP');ordinaryDir(dirname(root),'REAL_CONTROL_ROOT_PARENT_INVALID');check(!existsSync(root),'REAL_CONTROL_ROOT_EXISTS');
  const now=clock();check(Number.isFinite(now)&&now>=0,'REAL_CONTROL_ROOT_TIME_INVALID');mkdirSync(root,{mode:0o700});
  const identity:Identity={format:'xdev-real-control-root-identity-1',root_id:'real-control-root:'+randomUUID(),project_id:projectId,workspace_root:workspace,created_at:new Date(now).toISOString()};
  writeNew(join(root,'identity.json'),identity);const identitySha=digest(identity);const state:State={format:'xdev-real-control-root-state-1',identity_sha256:identitySha,revision:0,attachment:null};writeNew(join(root,'state.json'),state);
  return{status:'REAL_CONTROL_ROOT_DEPLOYED_UNBOUND' as const,root,identity_sha256:identitySha,coverage:missingCoverage(projectId),execution_permitted:false,reservation_created:false,worker_started:false};
}

export async function attachRealControlSource(rootInput:string,controlRootInput:string,bindingSha:string,ack:string,clock:()=>number=Date.now){
  check(ack===REAL_CONTROL_ATTACH_ACK,'REAL_CONTROL_ROOT_ATTACH_ACK_REQUIRED');check(sha(bindingSha),'REAL_CONTROL_ROOT_BINDING_DIGEST_INVALID');
  const controlRoot=canonicalAbs(controlRootInput);return locked(rootInput,async r=>{
    if(r.state.attachment){
      const a=r.state.attachment;check(a.control_root===controlRoot&&a.binding_sha256===bindingSha,'REAL_CONTROL_ROOT_ALREADY_BOUND_DIFFERENT_SOURCE');
      if(a.state==='PREPARED')throw Error('REAL_CONTROL_ROOT_ATTACH_PREPARED_MANUAL_REVIEW_REQUIRED');
      return{status:'REAL_CONTROL_ROOT_ALREADY_ATTACHED' as const,attachment:structuredClone(a),execution_permitted:false,reservation_created:false,worker_started:false};
    }
    check(!inside(r.root,controlRoot)&&!inside(controlRoot,r.root)&&!inside(r.identity.workspace_root,controlRoot),'REAL_CONTROL_ROOT_CONTROL_OVERLAP');
    const boundary=new FileControlSourceBoundary(controlRoot,bindingSha,clock);check(boundary.binding.project_id===r.identity.project_id,'REAL_CONTROL_ROOT_PROJECT_MISMATCH');
    const now=clock();check(Number.isFinite(now)&&now>=0,'REAL_CONTROL_ROOT_TIME_INVALID');const live=r.live;
    const prepared:Attachment={state:'PREPARED',control_root:controlRoot,binding_sha256:bindingSha,live_deployment_root:live,prepared_at:new Date(now).toISOString()};
    const next:State={...r.state,revision:r.state.revision+1,attachment:prepared};writeAtomic(r.statePath,next);
    // A failure below intentionally leaves PREPARED. Do not auto-delete or infer
    // whether the live deployment partially committed.
    const deployed=initializeLiveBoundaryDeployment(live,controlRoot,bindingSha,LIVE_BOUNDARY_ACK,clock);
    const doneAt=clock();check(Number.isFinite(doneAt)&&doneAt>=now,'REAL_CONTROL_ROOT_TIME_INVALID');const applied:Attachment={...prepared,state:'APPLIED',applied_at:new Date(doneAt).toISOString()};
    writeAtomic(r.statePath,{...next,revision:next.revision+1,attachment:applied} satisfies State);
    return{status:'REAL_CONTROL_ROOT_ATTACHED_NOT_AUTHORIZED' as const,attachment:applied,live:deployed,execution_permitted:false,reservation_created:false,worker_started:false};
  });
}

export async function inspectRealControlRoot(rootInput:string,clock:()=>number=Date.now):Promise<RealControlRootStatus>{
  const r=readRoot(rootInput),a=r.state.attachment;
  if(!a)return{status:'REAL_CONTROL_ROOT_DEPLOYED_UNBOUND',identity:r.identity,state:r.state,coverage:missingCoverage(r.identity.project_id),live:null,execution_permitted:false,reservation_created:false,worker_started:false};
  if(a.state==='PREPARED')return{status:'REAL_CONTROL_ROOT_ATTACH_PREPARED_MANUAL_REVIEW_REQUIRED',identity:r.identity,state:r.state,coverage:missingCoverage(r.identity.project_id),live:null,execution_permitted:false,reservation_created:false,worker_started:false};
  const live=await inspectLiveBoundaryDeployment(a.live_deployment_root,clock);const status:RealControlRootStatus['status']=live.status==='LIVE_BOUNDARY_COVERAGE_COMPLETE_NOT_AUTHORIZED'?'LIVE_BOUNDARY_COVERAGE_COMPLETE_NOT_AUTHORIZED':'BOUNDARY_COVERAGE_INCOMPLETE';return{status,identity:r.identity,state:r.state,coverage:live.coverage,live,execution_permitted:false,reservation_created:false,worker_started:false};
}

export async function refreshRealControlRoot(rootInput:string,clock:()=>number=Date.now){
  const r=readRoot(rootInput),a=r.state.attachment;check(a&&a.state==='APPLIED','REAL_CONTROL_ROOT_CONTROL_SOURCE_UNBOUND');
  const refresh=await refreshLiveBoundaryDeployment(a.live_deployment_root,clock);return{status:refresh.status,root_id:r.identity.root_id,refresh,execution_permitted:false,reservation_created:false,worker_started:false};
}
