import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from '../job-runtime/store.ts';
import { digest, fail, need, objectDigest, parseJson, plain } from './joint-util.ts';
import type { JointConfig } from './joint-util.ts';

export type Binding=Record<string,any>;
export type BindingRecord={binding:Binding;source:{task_generation:number;job_head_sha256:string;workspace_fingerprint:string;
  profile_sha256:string;budget_sha256:string;history_source_ref:string}};
export type OperationRecord={kind:string;request_id:string;operation_id:string;input_sha256:string;receipt_id:string;
  committed_state:string;binding_handle:string;value:any};
export type JointState={format:'xdev-trusted-joint-journal-1';revision:number;operations:OperationRecord[];
  bindings:BindingRecord[];head_sha256:string};
const empty=():JointState=>({format:'xdev-trusted-joint-journal-1',revision:0,operations:[],bindings:[],head_sha256:''});
function seal(state:JointState){const {head_sha256,...body}=state;return {...body,head_sha256:objectDigest(body)};}
export class JointStore{
  readonly root:string;private held=false;
  private readonly fault?: (point:'BEFORE_REPLACE'|'AFTER_REPLACE')=>void;
  constructor(config:JointConfig,fault?: (point:'BEFORE_REPLACE'|'AFTER_REPLACE')=>void){
    this.root=join(config.control_root,`xmem-joint-trusted-${digest(config.project_id)}`);this.fault=fault;}
  private file(){return join(this.root,'journal.json');}
  read():JointState{
    if(!existsSync(this.file())){if(existsSync(this.root))need(lstatSync(this.root).isDirectory(),'SCOPE_MISMATCH');return empty();}
    const bytes=plain(this.file(),8*1024*1024),s=bytes.toString('utf8'),v=parseJson(bytes);
    need(canonical(v)+'\n'===s&&v.format==='xdev-trusted-joint-journal-1'&&Number.isSafeInteger(v.revision)&&v.revision>=0&&
      Array.isArray(v.operations)&&Array.isArray(v.bindings)&&typeof v.head_sha256==='string','AUTHORITY_STALE');
    const {head_sha256,...body}=v;need(objectDigest(body)===head_sha256&&v.operations.length===v.revision,'AUTHORITY_STALE');
    return v as JointState;
  }
  withLock<T>(fn:(state:JointState,commit:(state:JointState)=>void)=>T):T{
    need(!this.held,'OPERATION_RECONCILIATION_REQUIRED');
    if(!existsSync(this.root))mkdirSync(this.root,{mode:0o700});
    need(lstatSync(this.root).isDirectory()&&!lstatSync(this.root).isSymbolicLink(),'SCOPE_MISMATCH');
    const lock=join(this.root,'writer.lock'),deadline=Date.now()+5000;
    while(true){try{mkdirSync(lock,{mode:0o700});break;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
      need(Date.now()<deadline,'OPERATION_RECONCILIATION_REQUIRED');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}
    const stat=lstatSync(lock),identity=`${stat.dev}:${stat.ino}`;this.held=true;
    try{return fn(this.read(),state=>this.commit(state));}
    finally{this.held=false;const end=lstatSync(lock);need(end.isDirectory()&&`${end.dev}:${end.ino}`===identity,
      'OPERATION_RECONCILIATION_REQUIRED');rmdirSync(lock);}
  }
  private commit(state:JointState){
    need(this.held&&state.operations.length===state.revision,'OPERATION_RECONCILIATION_REQUIRED');
    const current=this.read();need(state.revision===current.revision+1,'REVISION_CONFLICT');
    const next=seal(state),file=this.file(),tmp=join(this.root,`.${randomUUID()}.tmp`);
    let fd:number|undefined,committed=false;
    try{fd=openSync(tmp,'wx',0o600);writeFileSync(fd,canonical(next)+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;
      this.fault?.('BEFORE_REPLACE');
      renameSync(tmp,file);committed=true;
      if(process.platform!=='win32'){const dir=openSync(this.root,'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
      this.fault?.('AFTER_REPLACE');
    }catch{fail(committed?'OPERATION_RECONCILIATION_REQUIRED':'INTERNAL_ERROR');}
    finally{if(fd!==undefined)closeSync(fd);if(existsSync(tmp))unlinkSync(tmp);}
  }
}
export function findOperation(state:JointState,kind:string,requestId:string,input:unknown){
  const key=state.operations.find(x=>x.kind===kind&&x.request_id===requestId);if(!key)return null;
  need(key.input_sha256===objectDigest(input),'IDEMPOTENCY_CONFLICT');return key;
}
export function checkOperationId(state:JointState,operationId:string){
  need(!state.operations.some(x=>x.operation_id===operationId),'IDEMPOTENCY_CONFLICT');
}
export function bindingByHandle(state:JointState,handle:string){
  const record=state.bindings.find(x=>x.binding.preparation_handle===handle);
  need(record,'OPERATION_NOT_FOUND');return record;
}
export function addOperation(state:JointState,op:OperationRecord){
  state.operations.push(op);state.revision++;return state;
}
