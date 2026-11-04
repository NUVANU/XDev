/** Cooperative local boundary for a current-source snapshot.
 *
 * This is the XDev-side deployment boundary. It does NOT discover project facts,
 * authenticate an Owner, or stop arbitrary external writers. A trusted publisher
 * must write snapshots through updateCurrentSourceSnapshot(), and every process
 * that can change the bound execution facts must obey the same private root.
 * The boundary holds an exclusive reader lease for the whole awaited callback;
 * cooperative writers cannot update while the callback is active.
 */
import {randomUUID,createHash} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {canonicalJson} from '../planning/governance-contracts.ts';
import {parseUniqueJson} from '../planning/retry-history.ts';
import {controlNoLinks} from './control-source-boundary.ts';
import type {CurrentSourceSnapshot,CurrentSourceSnapshotBoundary} from './current-source-publisher.ts';

export type FileCurrentSourceBinding={format:'xdev-current-source-boundary-binding-1';project_id:string;binding_id:string};
export type FileCurrentSourceState={format:'xdev-current-source-boundary-state-1';project_id:string;binding_id:string;generation:number;snapshot_sha256:string;snapshot:CurrentSourceSnapshot};
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function check(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
function canonicalAbs(p:string){check(isAbsolute(p)&&resolve(p)===p,'CURRENT_BOUNDARY_PATH_NOT_CANONICAL');return p;}
function inside(root:string,p:string){const r=relative(root,p);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));}
function assertOrdinaryTree(path:string){for(let p=path;;p=dirname(p)){check(!lstatSync(p).isSymbolicLink(),'CURRENT_BOUNDARY_LINK');if(dirname(p)===p)break;}}
function readJson(path:string){assertOrdinaryTree(path);const s=lstatSync(path);check(s.isFile()&&s.nlink===1&&realpathSync(path)===path,'CURRENT_BOUNDARY_FILE_UNSAFE');return parseUniqueJson(readFileSync(path,'utf8'));}
function writeAtomic(path:string,bytes:string){const dir=dirname(path);const tmp=join(dir,'.'+path.split(sep).pop()+'.'+randomUUID()+'.tmp');let fd:number|undefined;try{fd=openSync(tmp,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}renameSync(tmp,path);}
function bindingPath(root:string){return join(root,'binding.json');}
function statePath(root:string){return join(root,'state.json');}
function lockPath(root:string){return join(root,'boundary.lock');}
function validateBinding(v:any):asserts v is FileCurrentSourceBinding{check(v&&v.format==='xdev-current-source-boundary-binding-1'&&text(v.project_id)&&text(v.binding_id)&&Object.keys(v).sort().join(',')==='binding_id,format,project_id','CURRENT_BOUNDARY_BINDING_INVALID');}
function validateState(v:any,b:FileCurrentSourceBinding):asserts v is FileCurrentSourceState{check(v&&v.format==='xdev-current-source-boundary-state-1'&&v.project_id===b.project_id&&v.binding_id===b.binding_id&&Number.isSafeInteger(v.generation)&&v.generation>=1&&sha(v.snapshot_sha256)&&v.snapshot&&typeof v.snapshot==='object','CURRENT_BOUNDARY_STATE_INVALID');const bytes=canonicalJson(v.snapshot as any);check(hash(bytes)===v.snapshot_sha256,'CURRENT_BOUNDARY_SNAPSHOT_DIGEST_MISMATCH');}
function acquire(root:string,owner:string){const p=lockPath(root);try{mkdirSync(p,{mode:0o700});writeFileSync(join(p,'owner'),owner,{flag:'wx',mode:0o600});return p;}catch{throw Error('CURRENT_BOUNDARY_BUSY_OR_OWNER_UNKNOWN');}}
function release(p:string,owner:string){try{const o=readFileSync(join(p,'owner'),'utf8');check(o===owner,'CURRENT_BOUNDARY_LOCK_OWNER_CHANGED');rmSync(p,{recursive:true,force:false});}catch(e){throw e;}}

export function initializeFileCurrentSourceBoundary(rootInput:string,projectId:string,bindingId:string){
  const root=canonicalAbs(rootInput);check(text(projectId)&&text(bindingId),'CURRENT_BOUNDARY_IDENTITY_INVALID');
  controlNoLinks(root);check(!existsSync(root),'CURRENT_BOUNDARY_ROOT_EXISTS');assertOrdinaryTree(dirname(root));mkdirSync(root,{mode:0o700});
  const b:FileCurrentSourceBinding={format:'xdev-current-source-boundary-binding-1',project_id:projectId,binding_id:bindingId};writeAtomic(bindingPath(root),canonicalJson(b));
  return{status:'CURRENT_BOUNDARY_INITIALIZED_EMPTY',root,project_id:projectId,binding_id:bindingId,execution_permitted:false,reservation_created:false,worker_started:false};
}

export function updateCurrentSourceSnapshot(rootInput:string,projectId:string,snapshot:CurrentSourceSnapshot,expectedGeneration:number|null){
  const root=canonicalAbs(rootInput);controlNoLinks(root);check(inside(root,bindingPath(root)),'CURRENT_BOUNDARY_INTERNAL_PATH');
  const b=readJson(bindingPath(root)) as FileCurrentSourceBinding;validateBinding(b);check(b.project_id===projectId,'CURRENT_BOUNDARY_PROJECT_MISMATCH');
  const owner='writer:'+randomUUID(),lp=acquire(root,owner);try{
    let generation=0;if(existsSync(statePath(root))){const prev=readJson(statePath(root)) as FileCurrentSourceState;validateState(prev,b);generation=prev.generation;}
    check(expectedGeneration===null?generation===0:generation===expectedGeneration,'CURRENT_BOUNDARY_GENERATION_MISMATCH');
    check(snapshot&&snapshot.project_id===projectId,'CURRENT_BOUNDARY_SNAPSHOT_PROJECT_MISMATCH');
    const snapshotBytes=canonicalJson(snapshot as any),next:FileCurrentSourceState={format:'xdev-current-source-boundary-state-1',project_id:projectId,binding_id:b.binding_id,generation:generation+1,snapshot_sha256:hash(snapshotBytes),snapshot:structuredClone(snapshot)};
    writeAtomic(statePath(root),canonicalJson(next as any));
    return{status:'CURRENT_BOUNDARY_SNAPSHOT_UPDATED',project_id:projectId,generation:next.generation,snapshot_sha256:next.snapshot_sha256,execution_permitted:false,reservation_created:false,worker_started:false};
  }finally{release(lp,owner);}
}

export class FileCurrentSourceSnapshotBoundary implements CurrentSourceSnapshotBoundary{
  readonly root:string;readonly projectId:string;
  constructor(rootInput:string,projectId:string){this.root=canonicalAbs(rootInput);this.projectId=projectId;}
  async withCurrentSnapshot<T>(projectId:string,operation:(snapshot:CurrentSourceSnapshot,assertCurrent?:()=>void)=>Promise<T>):Promise<T>{
    check(projectId===this.projectId,'CURRENT_BOUNDARY_PROJECT_MISMATCH');const root=this.root;controlNoLinks(root);
    const b=readJson(bindingPath(root)) as FileCurrentSourceBinding;validateBinding(b);check(b.project_id===projectId,'CURRENT_BOUNDARY_PROJECT_MISMATCH');
    const owner='reader:'+randomUUID(),lp=acquire(root,owner);try{
      check(existsSync(statePath(root)),'CURRENT_BOUNDARY_SNAPSHOT_MISSING');const beforeBytes=readFileSync(statePath(root)),beforeHash=hash(beforeBytes),st=parseUniqueJson(beforeBytes.toString('utf8')) as FileCurrentSourceState;validateState(st,b);
      let active=true;const guard=()=>{check(active,'CURRENT_BOUNDARY_TRANSACTION_ENDED');check(existsSync(lp),'CURRENT_BOUNDARY_LOCK_LOST');const current=readFileSync(statePath(root));check(hash(current)===beforeHash,'CURRENT_BOUNDARY_STATE_DRIFT');};
      try{guard();const result=await operation(structuredClone(st.snapshot),guard);guard();return result;}finally{active=false;}
    }finally{release(lp,owner);}
  }
}

export function inspectFileCurrentSourceBoundary(rootInput:string){
  const root=canonicalAbs(rootInput);controlNoLinks(root);const b=readJson(bindingPath(root)) as FileCurrentSourceBinding;validateBinding(b);if(!existsSync(statePath(root)))return{status:'EMPTY',project_id:b.project_id,binding_id:b.binding_id,generation:0,execution_permitted:false};
  const s=readJson(statePath(root)) as FileCurrentSourceState;validateState(s,b);return{status:'SNAPSHOT_PRESENT_NOT_AUTHORIZED',project_id:b.project_id,binding_id:b.binding_id,generation:s.generation,snapshot_sha256:s.snapshot_sha256,execution_permitted:false};
}
