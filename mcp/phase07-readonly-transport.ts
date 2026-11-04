// Async fixed-readonly launcher. No reconnect, resend, fallback or SDK import.
import {fork} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
import {bytes,hash,exact} from './configure.ts';
import {canonical} from '../src/job-runtime/store.ts';
import {binding07,frame07,makeFrame07,clock07,PHASE07_CUTOFF,PHASE07_STREAM_BYTES,Phase07Frames,wholeClock07,phaseDelay07} from './phase07-protocol.ts';
function qualification(){const raw=bytes(fileURLToPath(new URL('../PHASE07-SOURCE-MANIFEST.json',import.meta.url)),262144);const expected=process.env.XDEV_J01_PHASE07_QUALIFICATION_SHA256;if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected)||hash(raw)!==expected)throw Error('P07_QUALIFICATION_ADMISSION');const q=JSON.parse(raw.toString('utf8'));if(q.format!=='xdev-phase07-qualified-source-1'||q.files.length!==183)throw Error('P07_QUALIFICATION');for(const f of q.files){exact(f,['path','bytes','sha256']);if(typeof f.path!=='string'||f.path.startsWith('/')||f.path.includes('..')||f.path.includes('\\'))throw Error('P07_QUALIFIED_PATH');const b=bytes(fileURLToPath(new URL('../'+f.path,import.meta.url)),262144);if(b.length!==f.bytes||hash(b)!==f.sha256)throw Error('P07_QUALIFIED_DRIFT');}return hash(raw);}
const ref=(r:any)=>({path:r.path,sha256:r.sha256});
export async function launchReadonlyPhase07(local:any,source:any,revision:string|null,totalEnd:number,prepared:any,intentSha:string,beforeRun:()=>void,whole:ReturnType<typeof wholeClock07>){
 whole.guard();const m=local.config.memory_bridge,wall=Date.now(),mono=process.hrtime.bigint(),prepBudget=Math.min(10000,m.limits.call_ms),runBudget=Math.min(10000,m.limits.call_ms),prepareEnd=Math.min(wall+prepBudget,totalEnd,wall+Math.floor(whole.remaining()),whole.wallEnd,PHASE07_CUTOFF);
 let child:any=null,timer:any,cleanup:any,failed:any=null,state='SPAWN',received=0,frames=0,done=false,disconnected=false,stdoutEOF=false,stderrEOF=false,closeObserved=false,run:any=null,runMono:bigint|undefined,closedGuard=false,sendCount=0,acknowledged=false,qualificationHash='';const chunks:Buffer[]=[],errs:Buffer[]=[];let stdoutBytes=0,stderrBytes=0;
 const prepareGuard=()=>{whole.guard();clock07(prepareEnd,mono,prepBudget,wall);};
 const runGuard=()=>{if(!run||runMono===undefined||failed)throw Error('P07_RUN_NOT_VALID');whole.guard();clock07(run.run_deadline_ms,runMono,Math.min(runBudget,run.run_deadline_ms-run.run_started_ms),run.run_started_ms);};
 const finalGuard=()=>{if(!done||!disconnected||!stdoutEOF||!stderrEOF||!closeObserved||!acknowledged||failed)throw Error('P07_INCOMPLETE');runGuard();};
 qualificationHash=qualification();prepareGuard();const childPath=fileURLToPath(new URL('./engineering-child.ts',import.meta.url));const b=binding07({format:'xdev-phase07-binding-1',nonce:randomBytes(16).toString('hex'),operation_id:prepared.event.intent.id,intent_sha256:intentSha,claim_consumed:true,action:'engineering-reconcile',mode:'read',revision,config:{path:local.configPath,sha256:local.configHash},source:ref(source),child:{path:childPath,sha256:hash(bytes(childPath))},sdk:ref(prepared.e.sdk),standalone_sdk:ref(prepared.e.standalone_sdk),node:ref(m.node),build_id:prepared.e.build_id,qualification_sha256:qualificationHash,whole_started_ms:whole.wallStart,whole_budget_ms:whole.budget,prepare_started_ms:wall,prepare_deadline_ms:prepareEnd,total_deadline_ms:Math.min(totalEnd,PHASE07_CUTOFF),cutoff_ms:PHASE07_CUTOFF,prepare_budget_ms:prepBudget,run_budget_ms:runBudget});const bh=hash(canonical(b)),protocol=new Phase07Frames('parent',b,bh);
 const input={config_path:local.configPath,config_sha256:local.configHash,action:'engineering-reconcile',source,mode:'read',revision,deadline_unix_ms:b.total_deadline_ms,phase07:b};const stdin=Buffer.from(JSON.stringify(input));if(stdin.length>16384)throw Error('P07_STDIN_BOUND');
 const env=getDefaultEnvironment();delete env.NODE_OPTIONS;delete env.NODE_PATH;
 return await new Promise<{
  pid:number|undefined;status:number|null;signal:NodeJS.Signals|null;
  error:{code:NonNullable<NodeJS.ErrnoException['code']>;phase07:true}|undefined;stdout:Buffer;stderr:Buffer;
  phase07:{guard:()=>void;closeGuard:()=>void;timing:()=>{
   parent_checks_complete_ms:number;parent_run_elapsed_ms:number|null;parent_whole_elapsed_ms:number;
  };evidence:{
   prepare_started_ms:number;prepare_deadline_ms:number;run_started_ms:number|null;run_deadline_ms:number|null;
   total_deadline_ms:number;send_RUN:number;received_frames:number;received_bytes:number;
   ACK:boolean;DONE:boolean;IPC_disconnect:boolean;stdoutEOF:boolean;stderrEOF:boolean;closeObserved:boolean;
   exitObserved:boolean;exitEventCode:number|null;exitEventSignal:NodeJS.Signals|null;
   failed:boolean;failure_code:string|null;global_descendants:'UNKNOWN';
  }};
 }>(resolve=>{
  let finished=false,exitCode:any=null,exitSignal:any=null,exitObserved=false,exitEventCode:any=null,exitEventSignal:any=null;
  function maybeFinish(){if(closeObserved&&done&&disconnected&&stdoutEOF&&stderrEOF)finish(exitCode,exitSignal,true);}
  function closeGuard(){if(closedGuard)return;closedGuard=true;clearTimeout(timer);clearTimeout(cleanup);}
  function finish(code:any,signal:any,observed:boolean){if(finished)return;finished=true;closeObserved=closeObserved||observed;if(closeObserved){code=exitCode;signal=exitSignal;}const stdout=Buffer.concat(chunks),stderr=Buffer.concat(errs);try{if(!failed){finalGuard();if(hash(stdout)!==(doneDigest??''))throw Error('P07_STDOUT_DIGEST');}}catch(e){failed??=e;}if(failed){clearTimeout(timer);clearTimeout(cleanup);}resolve({pid:child?.pid,status:code,signal,error:failed?{code:/EXPIRED|TIMEOUT/.test(String(failed?.message))?'ETIMEDOUT':'EPHASE07',phase07:true}:undefined,stdout,stderr,phase07:{guard:finalGuard,closeGuard,timing:()=>{finalGuard();return{parent_checks_complete_ms:Date.now(),parent_run_elapsed_ms:runMono===undefined?null:Number(process.hrtime.bigint()-runMono)/1e6,parent_whole_elapsed_ms:Number(process.hrtime.bigint()-whole.monoStart)/1e6};},evidence:{prepare_started_ms:wall,prepare_deadline_ms:prepareEnd,run_started_ms:run?.run_started_ms??null,run_deadline_ms:run?.run_deadline_ms??null,total_deadline_ms:b.total_deadline_ms,send_RUN:sendCount,received_frames:frames,received_bytes:received,ACK:acknowledged,DONE:done,IPC_disconnect:disconnected,stdoutEOF,stderrEOF,closeObserved,exitObserved,exitEventCode,exitEventSignal,failed:failed!==null,failure_code:typeof failed?.message==='string'&&/^[A-Z0-9_]{1,96}$/.test(failed.message)?failed.message:null,global_descendants:'UNKNOWN'}}});}
  function stop(reason:any){if(finished){failed??=reason;return;}protocol.stop();failed??=reason;clearTimeout(timer);try{child?.kill();}catch{}if(closeObserved){finish(exitCode,exitSignal,true);return;}if(!cleanup)cleanup=setTimeout(()=>{child?.stdin?.destroy();child?.stdout?.destroy();child?.stderr?.destroy();try{child?.disconnect();}catch{}child?.unref();finish(exitCode,exitSignal,closeObserved);},10000);}
  let doneDigest:string|undefined;
  timer=setTimeout(()=>stop(Error('P07_PREPARE_TIMEOUT')),phaseDelay07(prepareEnd,mono,prepBudget,wall,whole));
  try{prepareGuard();child=fork(childPath,[],{execPath:m.node.path,execArgv:['--experimental-strip-types'],cwd:local.config.project_root,env,windowsHide:true,shell:false,serialization:'json',stdio:['pipe','pipe','pipe','ignore','ipc']} as any);}catch(e){stop(e);finish(null,null,false);return;}
  child.on('error',stop);child.stdin.on('error',stop);child.stdout.on('error',stop);child.stderr.on('error',stop);
  child.stdout.on('data',(v:Buffer)=>{stdoutBytes+=v.length;if(stdoutBytes+stderrBytes>m.limits.response_bytes){stop(Error('P07_STDIO_OVERFLOW'));return;}chunks.push(v);});child.stderr.on('data',(v:Buffer)=>{stderrBytes+=v.length;if(stderrBytes>m.limits.stderr_bytes||stdoutBytes+stderrBytes>m.limits.response_bytes){stop(Error('P07_STDIO_OVERFLOW'));return;}errs.push(v);});
  child.stdout.on('end',()=>{stdoutEOF=true;maybeFinish();});child.stderr.on('end',()=>{stderrEOF=true;maybeFinish();});
  child.on('disconnect',()=>{disconnected=true;try{protocol.disconnect();}catch(e){stop(e);}if(!done)stop(Error('P07_EARLY_DISCONNECT'));else maybeFinish();});
  child.on('message',(raw:any,handle:any)=>{try{if(handle||typeof raw!=='string'||frames>=3)throw Error('P07_FRAME_COUNT_OR_TYPE');received+=Buffer.byteLength(raw);frames++;if(received>PHASE07_STREAM_BYTES)throw Error('P07_CONTROL_BYTES');const inbound=protocol.receive(raw,handle);
   if(state==='SPAWN'){if(inbound.type!=='READY')throw Error('P07_READY');state='FRESH_GATE';prepareGuard();beforeRun();if(qualification()!==qualificationHash)throw Error('P07_QUALIFICATION_DRIFT');prepareGuard();const start=Date.now();run={run_started_ms:start,run_deadline_ms:Math.min(start+runBudget,b.total_deadline_ms,start+Math.floor(whole.remaining()),whole.wallEnd,PHASE07_CUTOFF)};if(run.run_deadline_ms<=start)throw Error('P07_RUN_WINDOW');runMono=process.hrtime.bigint();const runTimer=setTimeout(()=>stop(Error('P07_RUN_TIMEOUT')),phaseDelay07(run.run_deadline_ms,runMono,Math.min(runBudget,run.run_deadline_ms-run.run_started_ms),run.run_started_ms,whole));clearTimeout(timer);timer=runTimer;state='RUN_SENT';const wire=protocol.send('RUN',run);prepareGuard();runGuard();sendCount++;child.send(wire,undefined,undefined,(error:any)=>{if(error)stop(error);});}
   else if(state==='RUN_SENT'){const a=inbound;if(a.run_started_ms!==run.run_started_ms||a.run_deadline_ms!==run.run_deadline_ms)throw Error('P07_ACK_DEADLINE');runGuard();acknowledged=true;state='ACK';}
   else if(state==='ACK'){const d=inbound;runGuard();doneDigest=d.stdout_sha256;done=true;state='DONE';maybeFinish();}
   else throw Error('P07_DUPLICATE_OR_LATE_FRAME');
  }catch(e){stop(e);}});
  child.on('exit',(code:any,signal:any)=>{exitObserved=true;exitEventCode=code;exitEventSignal=signal;});
  child.on('close',(code:any,signal:any)=>{closeObserved=true;exitCode=code;exitSignal=signal;if(failed||code!==0||signal!==null){failed??=Error('P07_CHILD_EXIT');finish(code,signal,true);}else maybeFinish();});
  try{child.stdin.end(stdin);}catch(e){stop(e);}
 });
}
