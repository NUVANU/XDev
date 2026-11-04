import { isAbsolute, resolve } from 'node:path';
import { JsonlRpcClient, RpcFailure, record, text, type RpcReceipt, type RpcResult } from './rpc.ts';
export const ADAPTER_VERSION='s3b-foundation-1';
export type CodexRunMetadata={provider:'codex';thread_id?:string;turn_id?:string;cwd:string;launch_mode:'HOST_NATIVE'|'MANAGED';adapter_version:string;capability_snapshot:string};
export function invalid(result:RpcResult,message:string,id?:string):never {throw new RpcFailure({...result.receipt,kind:'MALFORMED_RESPONSE',message,thread_ref:id&&result.receipt.method==='thread/start'?id:result.receipt.thread_ref,turn_ref:id&&result.receipt.method==='turn/start'?id:result.receipt.turn_ref,certainty:id?'COMMITTED_ID_OBSERVED':result.receipt.certainty});}
export class CodexClient {
  readonly rpc:JsonlRpcClient;private initialized=false;
  constructor(rpc:JsonlRpcClient){this.rpc=rpc;}
  async initialize(){if(this.initialized)return;const r=await this.rpc.request('initialize',{clientInfo:{name:'xdev',version:ADAPTER_VERSION},capabilities:{experimentalApi:true}},{phase:'initialize',mutating:false});if(!record(r.value)||!text(r.value.userAgent))invalid(r,'INITIALIZE_SCHEMA_UNSUPPORTED');this.rpc.notify('initialized',{});this.initialized=true;}
  private ready(){if(!this.initialized)throw Error('CLIENT_NOT_INITIALIZED');}
  async startThread(cwd:string,mutability:'READ_ONLY'|'MUTABLE'){
    this.ready();const r=await this.rpc.request('thread/start',{cwd,sandbox:mutability==='READ_ONLY'?'read-only':'workspace-write',approvalPolicy:'never'},{phase:'thread_start',mutating:true});
    const thread=record(r.value)&&record(r.value.thread)?r.value.thread:null,id=thread&&text(thread.id)?thread.id:undefined;
    if(!id)invalid(r,'THREAD_ID_NOT_OBSERVED');
    if(!thread||!text(thread.cwd)||!isAbsolute(thread.cwd)||resolve(thread.cwd)!==cwd)invalid(r,'THREAD_WORKSPACE_MISMATCH',id);
    return {id,receipt:{...r.receipt,thread_ref:id,certainty:'COMMITTED_ID_OBSERVED' as const}};
  }
  async startTurn(thread_id:string,prompt:string,mutability:'READ_ONLY'|'MUTABLE'){
    this.ready();const r=await this.rpc.request('turn/start',{threadId:thread_id,input:[{type:'text',text:prompt}],approvalPolicy:'never',sandboxPolicy:mutability==='READ_ONLY'?{type:'readOnly',networkAccess:false}:{type:'workspaceWrite',writableRoots:[],networkAccess:false}},{phase:'turn_start',mutating:true,thread_ref:thread_id});
    const turn=record(r.value)&&record(r.value.turn)?r.value.turn:null,id=turn&&text(turn.id)?turn.id:undefined;
    if(!id)invalid(r,'TURN_ID_NOT_OBSERVED');
    return {id,receipt:{...r.receipt,turn_ref:id,certainty:'COMMITTED_ID_OBSERVED' as const}};
  }
  async read(metadata:CodexRunMetadata){
    this.ready();if(!metadata.thread_id)throw Error('RECONCILIATION_REQUIRED');
    const r=await this.rpc.request('thread/read',{threadId:metadata.thread_id,includeTurns:true},{phase:'status',thread_ref:metadata.thread_id,turn_ref:metadata.turn_id,mutating:false});
    const thread=record(r.value)&&record(r.value.thread)?r.value.thread:null;
    if(!thread||thread.id!==metadata.thread_id||!text(thread.cwd)||!isAbsolute(thread.cwd)||resolve(thread.cwd)!==metadata.cwd)invalid(r,'THREAD_SCOPE_MISMATCH');
    if(!Array.isArray(thread.turns))invalid(r,'TURN_HISTORY_NOT_READABLE');
    const turns=thread.turns;if(turns.some(t=>!record(t)||!text(t.id))||new Set(turns.map(t=>t.id)).size!==turns.length)invalid(r,'TURN_HISTORY_AMBIGUOUS');
    return {turn:turns.find(t=>t.id===metadata.turn_id) as Record<string,unknown>|undefined,receipt:r.receipt};
  }
  async interrupt(metadata:CodexRunMetadata):Promise<RpcReceipt>{this.ready();if(!metadata.thread_id||!metadata.turn_id)throw Error('RECONCILIATION_REQUIRED');const r=await this.rpc.request('turn/interrupt',{threadId:metadata.thread_id,turnId:metadata.turn_id},{phase:'cancel_request',thread_ref:metadata.thread_id,turn_ref:metadata.turn_id,mutating:true});return r.receipt;}
}
