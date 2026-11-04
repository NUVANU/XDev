// Fixed private readonly transport. Pure frame validation; not execution authority.
import {parseD1UniqueJson} from '../src/job-runtime/contracts.ts';
export const PHASE07_CUTOFF=Date.parse('2026-11-01T14:00:00.000Z');
export const PHASE07_FRAME_BYTES=4096,PHASE07_STREAM_BYTES=16384;
const need=(v:unknown,c:string)=>{if(!v)throw Error(c);};
const record=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function exact07(v:any,keys:string[]){need(record(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|'),'P07_SCHEMA');}
const hex=(v:any)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const stamp=(v:any)=>Number.isSafeInteger(v)&&v>0;
function ref(v:any){exact07(v,['path','sha256']);need(typeof v.path==='string'&&v.path.length>0&&v.path.length<2048&&!/[\0\r\n]/.test(v.path)&&hex(v.sha256),'P07_REF');}
export function binding07(b:any){
 exact07(b,['format','nonce','operation_id','intent_sha256','claim_consumed','action','mode','revision','config','source','child','sdk','standalone_sdk','node','build_id','qualification_sha256','whole_started_ms','whole_budget_ms','prepare_started_ms','prepare_deadline_ms','total_deadline_ms','cutoff_ms','prepare_budget_ms','run_budget_ms']);
 need(b.format==='xdev-phase07-binding-1'&&typeof b.nonce==='string'&&/^[a-f0-9]{32}$/.test(b.nonce)&&hex(b.operation_id)&&hex(b.intent_sha256)&&b.claim_consumed===true&&b.action==='engineering-reconcile'&&b.mode==='read'&&(b.revision===null||typeof b.revision==='string'&&b.revision.length>0&&b.revision.length<=512)&&hex(b.build_id)&&hex(b.qualification_sha256),'P07_FIXED_BINDING');
 for(const key of ['config','source','child','sdk','standalone_sdk','node'])ref(b[key]);
 need([b.whole_started_ms,b.prepare_started_ms,b.prepare_deadline_ms,b.total_deadline_ms,b.cutoff_ms].every(stamp)&&Number.isSafeInteger(b.whole_budget_ms)&&b.whole_budget_ms>0&&b.whole_budget_ms<=60000&&b.prepare_started_ms>=b.whole_started_ms&&b.total_deadline_ms<=b.whole_started_ms+b.whole_budget_ms&&b.cutoff_ms===PHASE07_CUTOFF&&Number.isSafeInteger(b.prepare_budget_ms)&&b.prepare_budget_ms>0&&b.prepare_budget_ms<=10000&&Number.isSafeInteger(b.run_budget_ms)&&b.run_budget_ms>0&&b.run_budget_ms<=10000&&b.prepare_deadline_ms>b.prepare_started_ms&&b.prepare_deadline_ms<=Math.min(b.prepare_started_ms+b.prepare_budget_ms,b.total_deadline_ms,b.cutoff_ms)&&b.total_deadline_ms<=b.cutoff_ms,'P07_BINDING_DEADLINES');return b;
}
export function frame07(raw:unknown,expected:string,b:any,bindingHash:string){
 need(typeof raw==='string'&&Buffer.byteLength(raw,'utf8')<=PHASE07_FRAME_BYTES&&Buffer.from(raw,'utf8').toString('utf8')===raw,'P07_FRAME_BYTES_OR_UTF8');
 const f:any=parseD1UniqueJson(raw as string);let extra=expected==='RUN'||expected==='ACK'?['run_started_ms','run_deadline_ms']:expected==='DONE'?['stdout_sha256']:[];
 exact07(f,['format','type','nonce','binding_sha256',...extra]);need(f.format==='xdev-phase07-frame-1'&&f.type===expected&&f.nonce===b.nonce&&f.binding_sha256===bindingHash,'P07_FRAME_BINDING');
 if(expected==='RUN'||expected==='ACK')need(stamp(f.run_started_ms)&&stamp(f.run_deadline_ms)&&f.run_started_ms>=b.prepare_started_ms&&f.run_started_ms<b.prepare_deadline_ms&&f.run_deadline_ms>f.run_started_ms&&f.run_deadline_ms<=Math.min(f.run_started_ms+b.run_budget_ms,b.total_deadline_ms,b.cutoff_ms),'P07_RUN_DEADLINE');
 if(expected==='DONE')need(hex(f.stdout_sha256),'P07_DONE_DIGEST');return f;
}
export function makeFrame07(type:string,b:any,bindingHash:string,extra:any={}){const value={format:'xdev-phase07-frame-1',type,nonce:b.nonce,binding_sha256:bindingHash,...extra};const text=JSON.stringify(value);frame07(text,type,b,bindingHash);return text;}
export function clock07(end:number,start:bigint,budget:number,notBefore:number){need(Date.now()>=notBefore&&Date.now()<Math.min(end,PHASE07_CUTOFF)&&Number(process.hrtime.bigint()-start)/1e6<budget,'P07_EXPIRED');}

export class Phase07Frames {
 role:'parent'|'child';b:any;h:string;sent=0;received=0;bytes=0;failed=false;
 constructor(role:'parent'|'child',b:any,h:string){this.role=role;this.b=binding07(b);this.h=h;}
 private charge(text:string){this.bytes+=Buffer.byteLength(text);if(this.bytes>PHASE07_STREAM_BYTES)throw Error('P07_STREAM_BYTES');}
 send(type:string,extra:any={}){try{if(this.failed)throw Error('P07_CLOSED');const sequence=this.role==='parent'?['RUN']:['READY','ACK','DONE'];if(sequence[this.sent]!==type||this.role==='parent'&&this.received!==1||this.role==='child'&&type!=='READY'&&this.received!==1)throw Error('P07_SEND_SEQUENCE');const text=makeFrame07(type,this.b,this.h,extra);this.charge(text);this.sent++;return text;}catch(e){this.failed=true;throw e;}}
 receive(raw:any,handle?:any){try{if(this.failed||handle||typeof raw!=='string')throw Error('P07_CONTROL_TYPE');const sequence=this.role==='parent'?['READY','ACK','DONE']:['RUN'];const expected=sequence[this.received];if(!expected||this.role==='parent'&&expected!=='READY'&&this.sent!==1||this.role==='child'&&this.sent!==1)throw Error('P07_RECEIVE_SEQUENCE');const frame=frame07(raw,expected,this.b,this.h);this.charge(raw);this.received++;return frame;}catch(e){this.failed=true;throw e;}}
 disconnect(){if(this.failed||this.role==='parent'&&this.received!==3||this.role==='child'&&this.sent!==3){this.failed=true;throw Error('P07_EARLY_DISCONNECT');}}
 stop(){this.failed=true;}
}

// Parent whole-operation origin is captured before all original prelaunch guards.
export function wholeClock07(wallStart:number,monoStart:bigint,budget:number){
 const wallEnd=Math.min(wallStart+budget,PHASE07_CUTOFF);
 if(!Number.isSafeInteger(budget)||budget<=0||budget>60000)throw Error('P07_TOTAL_BUDGET');
 const remaining=()=>{const now=Date.now(),monoLeft=budget-Number(process.hrtime.bigint()-monoStart)/1e6,wallLeft=wallEnd-now;if(now<wallStart||monoLeft<=0||wallLeft<=0)throw Error('P07_TOTAL_EXPIRED');return Math.min(monoLeft,wallLeft,PHASE07_CUTOFF-now);};
 return{wallStart,monoStart,budget,wallEnd,remaining,guard:()=>{remaining();}};
}
export function phaseDelay07(end:number,start:bigint,budget:number,notBefore:number,whole:ReturnType<typeof wholeClock07>){clock07(end,start,budget,notBefore);const left=Math.min(end-Date.now(),budget-Number(process.hrtime.bigint()-start)/1e6,whole.remaining(),PHASE07_CUTOFF-Date.now());if(left<1)throw Error('P07_EXPIRED');return Math.floor(left);}
