/** Codex JSONL framing. Adapted from R4.22 correlation/error invariants; no policy or spawning. */
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { parseUniqueJson } from '../../planning/retry-history.ts';
import type { SideEffectCertainty } from '../../worker-adapter/contracts.ts';
export type RpcRecord=Record<string,unknown>;
export const record=(x:unknown):x is RpcRecord=>!!x&&typeof x==='object'&&!Array.isArray(x);
export const text=(x:unknown):x is string=>typeof x==='string'&&x.length>0;
export type RpcScope={phase:string;thread_ref?:string;turn_ref?:string;mutating:boolean};
export type RpcReceipt={method:string;rpc_id:number|null;phase:string;thread_ref:string|null;turn_ref:string|null;certainty:SideEffectCertainty;observed_at:string;kind:'RESULT'|'APPLICATION_ERROR'|'TRANSPORT_ERROR'|'TIMEOUT'|'MALFORMED_RESPONSE'|'CLOSED';code:number|null;message:string;data:unknown;response_sha256:string|null};
export class RpcFailure extends Error {
  readonly receipt:RpcReceipt;
  constructor(receipt:RpcReceipt){super(receipt.kind+': '+receipt.message);this.name='RpcFailure';this.receipt=receipt;}
}
export interface JsonlConnection {
  readonly evidence_scope:'TEST_ONLY_TRANSPORT'|'PRODUCTION';
  write(frame:string):void;
  onData(fn:(bytes:Uint8Array|string)=>void):()=>void;
  onFailure(fn:(message:string)=>void):()=>void;
  close():void|Promise<void>;
}
export type RpcResult={value:unknown;receipt:RpcReceipt};
type Pending={method:string;scope:RpcScope;sent:boolean;resolve:(r:RpcResult)=>void;reject:(e:RpcFailure)=>void;timer:ReturnType<typeof setTimeout>};
// This is a bounded public-wire observation, not a transcript or a lifecycle authority.
// Raw RPC results/receipts keep their existing contract; this projection is not a
// general-purpose sanitizer for those existing APIs. Only fixed enums, counters,
// numeric RPC IDs and hashes of explicitly named structural IDs are retained here.
const OBSERVATION_LIMIT=128;
const PUBLIC_METHODS=['thread/started','turn/started','turn/completed','item/started','item/completed'] as const;
const RESPONSE_METHODS=['initialize','thread/start','turn/start','thread/read','turn/interrupt'] as const;
const ITEM_TYPES=['agentMessage','userMessage','commandExecution','fileChange','mcpToolCall'] as const;
const TURN_STATUSES=['inProgress','completed','failed','interrupted'] as const;
type PublicMethod=typeof PUBLIC_METHODS[number];
type ResponseMethod=typeof RESPONSE_METHODS[number]|'OTHER';
type TurnStatus=typeof TURN_STATUSES[number];
export type RpcObservationReason=
  |'SOURCE_COMPLETENESS_UNPROVEN'|'LIFECYCLE_SCOPE_UNPROVEN'|'EVENT_OVERFLOW'|'RESPONSE_OVERFLOW'|'COUNTER_SATURATED'
  |'UNSUPPORTED_EVENT'|'UNSUPPORTED_ITEM_TYPE'|'UNSUPPORTED_PUBLIC_SHAPE'|'SERVER_REQUEST_REJECTED'
  |'MALFORMED_FRAME'|'INVALID_UTF8'|'TRUNCATED_FRAME'|'TRANSPORT_FAILURE'|'CLIENT_CLOSED'
  |'MISSING_RESPONSE'|'PENDING_RESPONSE'|'DUPLICATE_RESPONSE'|'UNCORRELATED_RESPONSE'|'APPLICATION_ERROR'
  |'ORDER_AMBIGUITY'|'MISSING_TERMINAL'|'MISSING_ITEM_COMPLETION'|'DUPLICATE_ITEM_COMPLETION'|'ITEM_TYPE_CONFLICT'|'LIFECYCLE_ID_NOT_OBSERVED_IN_RESPONSE';
export type RpcPublicEvent=Readonly<{
  sequence:number;method:PublicMethod|'UNSUPPORTED_EVENT'|'SERVER_REQUEST_REJECTED';supported:boolean;
  thread_id_sha256:string|null;turn_id_sha256:string|null;item_id_sha256:string|null;
  item_type:typeof ITEM_TYPES[number]|null;turn_status:TurnStatus|null;
}>;
export type RpcPublicResponse=Readonly<{
  sequence:number;rpc_id:number;method:ResponseMethod;outcome:'RESULT'|'APPLICATION_ERROR';
  thread_id_sha256:string|null;turn_id_sha256:string|null;turn_status:TurnStatus|null;
}>;
const member=<T extends string>(values:readonly T[],value:unknown):value is T=>typeof value==='string'&&values.includes(value as T);
const idHash=(value:unknown):string|null=>typeof value==='string'&&value.length>0&&value.length<=256
  ?createHash('sha256').update(value).digest('hex'):null;
const terminal=(status:TurnStatus|null)=>status==='completed'||status==='failed'||status==='interrupted';
export class JsonlRpcClient {
  private readonly connection:JsonlConnection;
  readonly evidence_scope:'TEST_ONLY_TRANSPORT'|'PRODUCTION';
  readonly receipts:RpcReceipt[]=[];
  private readonly observedEvents:RpcPublicEvent[]=[];
  private readonly observedResponses:RpcPublicResponse[]=[];
  private readonly observationReasons=new Set<RpcObservationReason>(['SOURCE_COMPLETENESS_UNPROVEN','LIFECYCLE_SCOPE_UNPROVEN']);
  private observationSequence=0;private eventCount=0;private eventDrops=0;private responseCount=0;private responseDrops=0;
  // Local observation-client state only; close may still be pending or reject.
  private clientState:'OPEN'|'FAILED'|'CLOSED'='OPEN';private framingFinished=false;
  /** Compatibility view: a safe immutable prefix, never arbitrary notification params. */
  get events():readonly RpcPublicEvent[]{return Object.freeze(this.observedEvents.map(e=>Object.freeze({...e})));}
  private increment(value:number){if(value===Number.MAX_SAFE_INTEGER){this.observationReasons.add('COUNTER_SATURATED');return value;}return value+1;}
  private observeEvent(m:RpcRecord){
    this.eventCount=this.increment(this.eventCount);
    const e:{-readonly [K in keyof RpcPublicEvent]:RpcPublicEvent[K]}={sequence:this.observationSequence,method:'UNSUPPORTED_EVENT',supported:false,thread_id_sha256:null,turn_id_sha256:null,item_id_sha256:null,item_type:null,turn_status:null};
    if('id' in m){e.method='SERVER_REQUEST_REJECTED';this.observationReasons.add('SERVER_REQUEST_REJECTED');}
    else if(!member(PUBLIC_METHODS,m.method))this.observationReasons.add('UNSUPPORTED_EVENT');
    else{
      e.method=m.method;
      const p=record(m.params)?m.params:{};
      if(m.method==='thread/started'){
        e.thread_id_sha256=record(p.thread)?idHash(p.thread.id):null;e.supported=e.thread_id_sha256!==null;
      }else{
        e.thread_id_sha256=idHash(p.threadId);
        if(m.method==='turn/started'||m.method==='turn/completed'){
          const turn=record(p.turn)?p.turn:{};e.turn_id_sha256=idHash(turn.id);e.turn_status=member(TURN_STATUSES,turn.status)?turn.status:null;
          e.supported=!!e.thread_id_sha256&&!!e.turn_id_sha256&&(m.method==='turn/completed'?terminal(e.turn_status):e.turn_status==='inProgress');
        }else{
          const item=record(p.item)?p.item:{};e.turn_id_sha256=idHash(p.turnId);e.item_id_sha256=idHash(item.id);
          e.item_type=member(ITEM_TYPES,item.type)?item.type:null;
          if(!e.item_type)this.observationReasons.add('UNSUPPORTED_ITEM_TYPE');
          e.supported=!!e.thread_id_sha256&&!!e.turn_id_sha256&&!!e.item_id_sha256&&!!e.item_type;
        }
      }
      if(!e.supported)this.observationReasons.add('UNSUPPORTED_PUBLIC_SHAPE');
    }
    if(this.observedEvents.length<OBSERVATION_LIMIT)this.observedEvents.push(Object.freeze(e));
    else{this.eventDrops=this.increment(this.eventDrops);this.observationReasons.add('EVENT_OVERFLOW');}
  }
  private observeResponse(id:number,method:string,m:RpcRecord){
    this.responseCount=this.increment(this.responseCount);
    const publicMethod:ResponseMethod=member(RESPONSE_METHODS,method)?method:'OTHER';
    const r=record(m.result)?m.result:{};
    // Never fill IDs from request params, scope, order, or a previously seen thread.
    const thread=(publicMethod==='thread/start'||publicMethod==='thread/read')&&record(r.thread)?r.thread:null;
    const turn=publicMethod==='turn/start'&&record(r.turn)?r.turn:null;
    const e:RpcPublicResponse=Object.freeze({sequence:this.observationSequence,rpc_id:id,method:publicMethod,outcome:'error' in m?'APPLICATION_ERROR':'RESULT',
      thread_id_sha256:thread?idHash(thread.id):null,turn_id_sha256:turn?idHash(turn.id):null,turn_status:turn&&member(TURN_STATUSES,turn.status)?turn.status:null});
    if('error' in m)this.observationReasons.add('APPLICATION_ERROR');
    else if(((publicMethod==='thread/start'||publicMethod==='thread/read')&&!e.thread_id_sha256)||(publicMethod==='turn/start'&&!e.turn_id_sha256)||(turn&&'status' in turn&&!e.turn_status))this.observationReasons.add('UNSUPPORTED_PUBLIC_SHAPE');
    if(this.observedResponses.length<OBSERVATION_LIMIT)this.observedResponses.push(e);
    else{this.responseDrops=this.increment(this.responseDrops);this.observationReasons.add('RESPONSE_OVERFLOW');}
  }
  /** Snapshot only. No full-source, Host, identity-binding, or writer-closure claim. */
  observationDiagnostics(){
    const reasons=new Set(this.observationReasons),events=this.events,responses=Object.freeze(this.observedResponses.map(r=>Object.freeze({...r})));
    const terminals=events.filter(e=>e.supported&&e.method==='turn/completed'&&terminal(e.turn_status));
    const responseTurns=responses.filter(r=>r.outcome==='RESULT'&&r.turn_id_sha256);
    if(!terminals.length&&!responseTurns.some(r=>terminal(r.turn_status)))reasons.add('MISSING_TERMINAL');
    for(const r of responseTurns)if(!terminal(r.turn_status)&&!terminals.some(e=>e.sequence>r.sequence&&e.turn_id_sha256===r.turn_id_sha256))reasons.add('MISSING_TERMINAL');
    for(const e of events){
      if(!e.supported||!e.turn_id_sha256)continue;
      if(!responseTurns.some(r=>r.turn_id_sha256===e.turn_id_sha256&&r.sequence<e.sequence))reasons.add('LIFECYCLE_ID_NOT_OBSERVED_IN_RESPONSE');
      const before=events.filter(p=>p.supported&&p.sequence<e.sequence&&p.thread_id_sha256===e.thread_id_sha256&&p.turn_id_sha256===e.turn_id_sha256);
      if(e.method==='turn/completed'&&!before.some(p=>p.method==='turn/started'))reasons.add('ORDER_AMBIGUITY');
      if(e.method==='turn/started'){
        if(before.some(p=>p.method==='turn/started'))reasons.add('ORDER_AMBIGUITY');
        if(!terminals.some(p=>p.sequence>e.sequence&&p.thread_id_sha256===e.thread_id_sha256&&p.turn_id_sha256===e.turn_id_sha256))reasons.add('MISSING_TERMINAL');
      }
      if(before.some(p=>p.method==='turn/completed'))reasons.add('ORDER_AMBIGUITY');
      if(e.method==='item/started'||e.method==='item/completed'){
        const priorItems=before.filter(p=>p.item_id_sha256===e.item_id_sha256);
        if(!before.some(p=>p.method==='turn/started'))reasons.add('ORDER_AMBIGUITY');
        if(priorItems.some(p=>p.item_type!==e.item_type)){reasons.add('ITEM_TYPE_CONFLICT');reasons.add('ORDER_AMBIGUITY');}
        if(e.method==='item/completed'){
          if(!priorItems.some(p=>p.method==='item/started'&&p.item_type===e.item_type))reasons.add('ORDER_AMBIGUITY');
          if(priorItems.some(p=>p.method==='item/completed')){reasons.add('DUPLICATE_ITEM_COMPLETION');reasons.add('ORDER_AMBIGUITY');}
        }else{
          if(priorItems.length)reasons.add('ORDER_AMBIGUITY');
          if(!events.some(p=>p.supported&&p.sequence>e.sequence&&p.method==='item/completed'&&p.thread_id_sha256===e.thread_id_sha256&&p.turn_id_sha256===e.turn_id_sha256&&p.item_id_sha256===e.item_id_sha256&&p.item_type===e.item_type))reasons.add('MISSING_ITEM_COMPLETION');
        }
      }
    }
    if(this.pending.size)reasons.add('PENDING_RESPONSE');
    const pendingIds:number[]=[];for(const id of this.pending.keys()){if(pendingIds.length===OBSERVATION_LIMIT)break;pendingIds.push(id);}
    return Object.freeze({scope:'BOUNDED_PUBLIC_JSONL_PREFIX' as const,evidence_scope:this.evidence_scope,
      observation_complete:false as const,host_complete:false as const,remote_worker_stopped:false as const,writer_closure_proven:false as const,
      lifecycle_scope:'UNPROVEN' as const,client_state:this.clientState,limit_per_collection:OBSERVATION_LIMIT,
      event_count_seen:this.eventCount,event_count_retained:events.length,event_count_dropped:this.eventDrops,
      response_count_seen:this.responseCount,response_count_retained:responses.length,response_count_dropped:this.responseDrops,
      pending_response_count:this.pending.size,pending_rpc_ids:Object.freeze(pendingIds),
      // A matching hashed ID is only a wire fact, not a proven thread/turn binding.
      retained_terminal_event_count:terminals.length,retained_terminal_response_count:responseTurns.filter(r=>terminal(r.turn_status)).length,
      incomplete_reasons:Object.freeze([...reasons].sort()),events,responses});
  }
  private finishFraming(){
    if(this.framingFinished)return;this.framingFinished=true;
    try{this.buffer+=this.decoder.decode();}catch{this.observationReasons.add('INVALID_UTF8');this.observationReasons.add('TRUNCATED_FRAME');}
    if(this.buffer.trim())this.observationReasons.add('TRUNCATED_FRAME');
    this.buffer='';
  }
  private readonly pending=new Map<number,Pending>();
  private sequence=0;private buffer='';private failed:string|null=null;private disposed=false;
  private readonly decoder=new TextDecoder('utf-8',{fatal:true});private readonly unsub:(()=>void)[]=[];
  private readonly timeoutMs:number;private readonly maxBytes:number;
  constructor(connection:JsonlConnection,options:{timeoutMs?:number;maxMessageBytes?:number}={}){
    this.connection=connection;this.evidence_scope=connection.evidence_scope;this.timeoutMs=options.timeoutMs??1000;this.maxBytes=options.maxMessageBytes??1024*1024;
    if(!Number.isSafeInteger(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>120000||!Number.isSafeInteger(this.maxBytes)||this.maxBytes<256||this.maxBytes>8*1024*1024)throw Error('RPC_LIMIT_INVALID');
    this.unsub.push(connection.onData(b=>this.receive(b)),connection.onFailure(message=>this.fail('TRANSPORT_ERROR',message)));
  }
  private receipt(id:number|null,method:string,scope:RpcScope,kind:RpcReceipt['kind'],certainty:SideEffectCertainty,message='',code:number|null=null,data:unknown=null,response:string|null=null):RpcReceipt{
    return {method,rpc_id:id,phase:scope.phase,thread_ref:scope.thread_ref??null,turn_ref:scope.turn_ref??null,certainty,observed_at:new Date().toISOString(),kind,code,message,data,response_sha256:response===null?null:createHash('sha256').update(response).digest('hex')};
  }
  private fail(kind:RpcReceipt['kind'],message:string){
    if(this.failed!==null)return;
    if(kind==='TRANSPORT_ERROR')this.observationReasons.add('TRANSPORT_FAILURE');
    if(kind==='CLOSED')this.observationReasons.add('CLIENT_CLOSED');
    if(kind==='MALFORMED_RESPONSE')this.observationReasons.add('MALFORMED_FRAME');
    if(message==='INVALID_UTF8')this.observationReasons.add('INVALID_UTF8');
    if(this.pending.size)this.observationReasons.add('MISSING_RESPONSE');
    this.finishFraming();this.clientState=kind==='CLOSED'?'CLOSED':'FAILED';this.failed=message;
    for(const [id,p] of this.pending){clearTimeout(p.timer);const r=this.receipt(id,p.method,p.scope,kind,p.sent?'SENT_NO_ACK':'NOT_SENT',message);this.receipts.push(r);p.reject(new RpcFailure(r));}this.pending.clear();
  }
  private receive(bytes:Uint8Array|string){
    if(this.failed!==null||this.disposed)return;
    try{this.buffer+=typeof bytes==='string'?bytes:this.decoder.decode(bytes,{stream:true});}catch{this.fail('MALFORMED_RESPONSE','INVALID_UTF8');return;}
    let pos:number;
    while((pos=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,pos);this.buffer=this.buffer.slice(pos+1);if(Buffer.byteLength(line)>this.maxBytes){this.fail('MALFORMED_RESPONSE','MESSAGE_TOO_LARGE');return;}if(line.trim())this.parse(line);if(this.failed!==null)return;}
    if(Buffer.byteLength(this.buffer)>this.maxBytes)this.fail('MALFORMED_RESPONSE','MESSAGE_TOO_LARGE');
  }
  private parse(line:string){
    let m:unknown;try{m=parseUniqueJson(line);}catch{this.fail('MALFORMED_RESPONSE','INVALID_JSON');return;}
    if(!record(m)){this.fail('MALFORMED_RESPONSE','INVALID_ENVELOPE');return;}
    if('jsonrpc' in m&&m.jsonrpc!=='2.0'){this.fail('MALFORMED_RESPONSE','UNSUPPORTED_RPC_VERSION');return;}
    this.observationSequence=this.increment(this.observationSequence);
    if('method' in m){
      if(!text(m.method)||'result' in m||'error' in m){this.fail('MALFORMED_RESPONSE','INVALID_EVENT');return;}
      // Server-initiated tools/approvals are never proxy-dispatched by this foundation.
      if('id' in m){this.observeEvent(m);try{this.connection.write(JSON.stringify({id:m.id,error:{code:-32601,message:'No server-initiated actions authorized'}})+'\n');}catch{this.fail('TRANSPORT_ERROR','APPROVAL_REJECTION_WRITE_FAILED');}return;}
      this.observeEvent(m);return;
    }
    if(typeof m.id!=='number'||!this.pending.has(m.id)){this.observationReasons.add(this.observedResponses.some(r=>r.rpc_id===m.id)?'DUPLICATE_RESPONSE':'UNCORRELATED_RESPONSE');this.fail('MALFORMED_RESPONSE','UNCORRELATED_RESPONSE');return;}
    const id=m.id,p=this.pending.get(id)!;
    if(('result' in m)===('error' in m)){this.fail('MALFORMED_RESPONSE','RESULT_ERROR_EXCLUSIVITY');return;}
    if('error' in m&&(!record(m.error)||!Number.isInteger(m.error.code)||typeof m.error.message!=='string')){this.fail('MALFORMED_RESPONSE','INVALID_RPC_ERROR');return;}
    this.observeResponse(id,p.method,m);
    this.pending.delete(id);clearTimeout(p.timer);
    if('error' in m){const error=m.error as RpcRecord;const r=this.receipt(id,p.method,p.scope,'APPLICATION_ERROR',p.scope.mutating?'UNKNOWN':'ACKED_NO_PERSISTED_ID',error.message as string,error.code as number,error.data??null,line);this.receipts.push(r);p.reject(new RpcFailure(r));}
    else{const r=this.receipt(id,p.method,p.scope,'RESULT','ACKED_NO_PERSISTED_ID','',null,null,line);this.receipts.push(r);p.resolve({value:m.result,receipt:r});}
  }
  request(method:string,params:RpcRecord,scope:RpcScope):Promise<RpcResult>{
    if(this.failed!==null||this.disposed)return Promise.reject(new RpcFailure(this.receipt(null,method,scope,'CLOSED','NOT_SENT',this.failed??'TRANSPORT_CLOSED')));
    let frame:string;const id=++this.sequence;
    try{frame=JSON.stringify({id,method,params})+'\n';if(Buffer.byteLength(frame)>this.maxBytes)throw Error('REQUEST_TOO_LARGE');}catch(e){return Promise.reject(new RpcFailure(this.receipt(id,method,scope,'MALFORMED_RESPONSE','NOT_SENT',(e as Error).message)));}
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>this.fail('TIMEOUT','REQUEST_DEADLINE_EXCEEDED'),this.timeoutMs);const pending:Pending={method,scope,sent:false,resolve,reject,timer};this.pending.set(id,pending);
      // Set before write: even a synchronous write exception can follow a partial send.
      pending.sent=true;try{this.connection.write(frame);}catch(e){this.fail('TRANSPORT_ERROR',(e as Error).message);}
    });
  }
  notify(method:string,params:RpcRecord):void {if(this.failed!==null||this.disposed)throw Error('TRANSPORT_CLOSED');try{this.connection.write(JSON.stringify({method,params})+'\n');}catch(e){this.fail('TRANSPORT_ERROR',(e as Error).message);throw e;}}
  async close():Promise<void>{if(this.disposed)return;this.disposed=true;this.fail('CLOSED','TRANSPORT_CLOSED');this.clientState='CLOSED';this.observationReasons.add('CLIENT_CLOSED');this.unsub.forEach(fn=>fn());await this.connection.close();}
}
