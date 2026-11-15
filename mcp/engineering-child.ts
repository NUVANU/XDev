// Fixed public SDK entry; no Owner setup, arbitrary function or command surface.
import { readSync, writeSync } from 'node:fs';
import {bytes,hash} from './configure.ts';
import {canonical} from '../src/job-runtime/store.ts';
import {binding07,exact07,clock07,Phase07Frames,PHASE07_CUTOFF,wholeClock07,phaseDelay07} from './phase07-protocol.ts';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exact, loadConfig } from './configure.ts';
import { MemoryError, memoryCheck as check, memoryJson, dependencyRegistration } from './xmem-client.ts';
import { prepareEngineering, checkEngineeringStatus, engineeringValue, checkEngineeringCapture } from './engineering-memory.ts';
import { checkReadback } from './memory-bridge.ts';
import { E7_NATIVE_BUILD } from './sdk-builds.ts';
import { inspectMemoryOperation, reserveNativeCaptureStart } from './memory-operation.ts';
import { selectMemoryBoundary, boundaryOptions, UNIFIED_BUILD } from '../src/host-surface/project-memory-boundary.ts';
type ChildStage='ENTRY'|'INPUT_READY'|'CONFIG_READY'|'PREPARE_READY'|'ENGINEERING_SDK_READY'|'STANDALONE_SDK_READY'|'PATHS_READY'|'BODY_PREPARE_READY'|'STATUS_BEFORE_READY'|'READ_ENTER'|'READ_RETURN'|'STATUS_AFTER_READY'|'CORE_NORMAL_RETURN'|'CORE_ERROR_RETURN'|'RESULT_READY'|'ERROR_ENVELOPE'|'READ_GUARD_READY'|'IMAGE_ONE_ENTER'|'IMAGE_ONE_RETURN'|'QUERY_ENTER'|'QUERY_RETURN'|'IMAGE_TWO_ENTER'|'IMAGE_TWO_RETURN'|'READ_REVALIDATED';
let childTraceStart:bigint|undefined,childTraceCount=0,childPhysicalTrace=false;
const PHYSICAL_TRACE_STAGES:readonly string[]=["ENTRY","READ_ENTER","READ_GUARD_READY","IMAGE_ONE_ENTER","IMAGE_ONE_RETURN","QUERY_ENTER","QUERY_RETURN","IMAGE_TWO_ENTER","IMAGE_TWO_RETURN","READ_REVALIDATED","READ_RETURN","CORE_NORMAL_RETURN","CORE_ERROR_RETURN","RESULT_READY","ERROR_ENVELOPE"];
function childStage(stage:ChildStage){
 if(childPhysicalTrace&&!PHYSICAL_TRACE_STAGES.includes(stage))return;
 if(childTraceStart===undefined||childTraceCount>=14)return;
 childTraceCount++;const elapsed=Number((process.hrtime.bigint()-childTraceStart)/1000000n);
 const line='XDEV_J01_STAGE_V1|'+stage+'|'+elapsed+'\n';
 if(Buffer.byteLength(line,'utf8')>96)return;
 try{writeSync(2,line);}catch{/* Diagnostic loss never changes the business result. */}
}
function childCoreReturnStage(result:unknown){
 try{
  if(!result||typeof result!=='object')return;
  const format=(result as {format?:unknown}).format;
  if(format==='xdev-engineering-child-1')childStage('CORE_NORMAL_RETURN');
  else if(format==='xdev-engineering-child-j01-error-1'||format==='xdev-engineering-child-error-1')childStage('CORE_ERROR_RETURN');
 }catch{/* Diagnostic classification never changes the business result. */}
}
function guardNativeChild(local:ReturnType<typeof loadConfig>,input:any,p:ReturnType<typeof prepareEngineering>){
 if(p.e.build_id!==E7_NATIVE_BUILD)return;
 check(local.config.memory_bridge!.node.path===process.execPath,'ENGINEERING_NATIVE_NODE_DRIFT');
 check(Number.isSafeInteger(input.deadline_unix_ms)&&Date.now()<input.deadline_unix_ms,'ENGINEERING_TOTAL_DEADLINE');
 check(input.revision===null,'ENGINEERING_NATIVE_JOINT_CHILD_MODE');
 if(input.action==='worker-context'){
  check(input.mode==='query'&&!p.event,'ENGINEERING_NATIVE_JOINT_CHILD_MODE');
  return;
 }
 check(input.action==='engineering-capture'&&input.mode==='capture-only'&&p.event,'ENGINEERING_NATIVE_JOINT_CHILD_MODE');
 const state=inspectMemoryOperation(local.config.control_root,p.event.intent);
 check(!state.confirmation,'ENGINEERING_NATIVE_CAPTURE_ALREADY_CONFIRMED');
}
/** The fixed child body. Module-only SDK injection is TEST_ONLY; no config/tool
 * field selects modules, functions or clocks. Production imports its pinned SDK. */
function executeEngineeringCore07(local:ReturnType<typeof loadConfig>,input:any,sdk:any,standalone:any,paths:any=(local as any)[Symbol.for('xdev.TEST_ONLY.fixed-child-paths')],prepared?:{selected:ReturnType<typeof selectMemoryBoundary>;p:ReturnType<typeof prepareEngineering>;guard:()=>void},observeRead?:<T>(operation:()=>T)=>T,deferCaptureOnlyTail=false){
 let capture:any=null,selected=prepared?prepared.selected:selectMemoryBoundary(local.config),p:ReturnType<typeof prepareEngineering>|undefined;
 try{
   if(prepared){p=prepared.p;}else{exact(input,['config_path','config_sha256','action','source','mode','revision',...(input.deadline_unix_ms===undefined?[]:['deadline_unix_ms'])]);check(local.configPath===input.config_path&&local.configHash===input.config_sha256,'ENGINEERING_LOCAL_CONFIG_DRIFT');p=prepareEngineering(local,input.action,input.source);childStage('BODY_PREPARE_READY');}const m=local.config.memory_bridge!;
  guardNativeChild(local,input,p);
  const options=selected?boundaryOptions(selected.boundary,input.deadline_unix_ms,m.limits.payload_bytes):undefined;check(selected!==null||input.deadline_unix_ms===undefined,'ENGINEERING_UNEXPECTED_DEADLINE');
  check(!options||typeof paths?.withPathValidationScope==='function','ENGINEERING_PATH_SCOPE_API_UNSUPPORTED');
  // One scope per public operation, with the same earlier absolute deadline.
  // The optional local symbol is only the existing module-only controlled seam.
  const sdkCall=(operation:()=>any)=>options?paths.withPathValidationScope(operation,()=>options.deadline_unix_ms-Date.now()):operation();
  const deadline=()=>{if(options)check(Date.now()<options.deadline_unix_ms,'ENGINEERING_TOTAL_DEADLINE');if(prepared)prepared.guard();};
  const captureOnly=input.mode==='capture-only';
  check((input.action==='worker-context'&&input.mode==='query'&&input.revision===null)||(p.event&&['capture','capture-only','read'].includes(input.mode)&&(input.revision===null||typeof input.revision==='string')&&(!['capture','capture-only'].includes(input.mode)||input.action==='engineering-capture'&&input.revision===null)),'ENGINEERING_CHILD_MODE');
  check(!captureOnly||selected!==null&&p.event&&p.event.previous_revision_id===null&&p.value.revises===undefined&&p.event.correction===null,'ENGINEERING_CAPTURE_ONLY_FRESH_REQUIRED');
  deadline();
  const before=sdkCall(()=>standalone.standaloneStatus(local.config.project_root,'sdk'));checkEngineeringStatus(local.config,before);childStage('STATUS_BEFORE_READY');prepareEngineering(local,input.action,input.source);deadline();
  let result:any,previous:any=null,lifecycle:any=null;
  if(input.mode==='query'){
   if(p.dependency){check(options&&typeof sdk.registerEngineeringDependencies==='function'&&typeof sdk.revokeEngineeringDependencies==='function','ENGINEERING_DEPENDENCY_API_UNSUPPORTED');const registered=dependencyRegistration(sdk.registerEngineeringDependencies(local.config.project_root,p.dependency.registration,options));try{deadline();result=sdk.queryEngineeringMemory(local.config.project_root,p.query,options,{dependencies:registered.handle,...(p.dependency.dependency_budget===undefined?{}:{dependency_budget:p.dependency.dependency_budget})});}finally{const revoked=sdk.revokeEngineeringDependencies(registered.handle);check(revoked===true,'ENGINEERING_DEPENDENCY_REVOKE_UNKNOWN');}lifecycle={channel:'engineering',source:p.dependency.ref,registered_edges:registered.registered_edges,revoked:true,handle_serialized:false,authority:'SDK_PROCESS_LOCAL_HANDLE_NOT_MCP_TOKEN'};}
   else result=sdk.queryEngineeringMemory(local.config.project_root,p.query,options);
  }
  else{
   const event=p.event!;let revision=input.revision;
   if(input.mode==='capture'||captureOnly){
    if(p.e.build_id===E7_NATIVE_BUILD){deadline();reserveNativeCaptureStart(local.config.control_root,event.intent);deadline();}
    capture=sdkCall(()=>sdk.captureEngineeringMemory(local.config.project_root,{task_ref:m.task_ref,task_version:m.task_version,memory_key:event.intent.memory_key,previous_revision_id:event.previous_revision_id,roles:['developer'],expected_scope:{project_id:m.project_id,workspace_id:m.workspace_id,policy_hash:m.policy_hash,storage_location_hash:m.location_hash},record:event.record}));
    revision=captureOnly?checkEngineeringCapture(local.config,p,capture).revision_id:engineeringValue(capture).revision_id;
   }
   if(!captureOnly){deadline();childStage('READ_ENTER');const read=()=>standalone.readStandaloneMemory(local.config.project_root,{task_ref:m.task_ref,task_version:m.task_version,role:'developer',memory_key:event.intent.memory_key,revision_id:revision,payload_budget_bytes:m.limits.payload_bytes},options);result=observeRead?observeRead(read):read();childStage('READ_RETURN');}
   if(event.correction){deadline();previous=standalone.readStandaloneMemory(local.config.project_root,{task_ref:m.task_ref,task_version:m.task_version,role:'developer',memory_key:event.intent.memory_key,revision_id:event.previous_revision_id,payload_budget_bytes:m.limits.payload_bytes},options);const old=checkReadback(local.config,engineeringValue(previous),event.correction.content,event.previous_revision_id,event.correction.previous_revision_id);check(old.readback==='COMPLETE','ENGINEERING_PREVIOUS_FULL_READBACK_REQUIRED');}
  }
  deadline();const after=sdkCall(()=>standalone.standaloneStatus(local.config.project_root,'sdk'));checkEngineeringStatus(local.config,after);childStage('STATUS_AFTER_READY');
  // The standard fresh capture-only CLI emits its save ACK before the parent
  // performs the full fresh preparation/source/SDK/boundary checks before read.
  // Legacy module callers and every other mode keep the original tail check.
  if(!(captureOnly&&deferCaptureOnlyTail))prepareEngineering(local,input.action,input.source);deadline();
  if(captureOnly)return{format:'xdev-engineering-capture-child-1',before,capture,after,save_acknowledged:true,readback_acknowledged:false};
  return{format:'xdev-engineering-child-1',before,capture,result,after,...(p.event?.correction?{previous}:{}),...(p.dependency?{dependency_lifecycle:lifecycle}:{})};
 }catch(e){const code=e instanceof MemoryError&&/^[A-Z0-9_:-]{1,128}$/.test(e.code)?e.code:'ENGINEERING_CHILD_REFUSED_OR_UNKNOWN';let acknowledged=false;
  try{if(capture!==null&&local&&p){checkEngineeringCapture(local.config,p,capture);acknowledged=true;}}catch{capture=null;}
  return selected?{format:'xdev-engineering-child-j01-error-1',layer:e instanceof MemoryError&&e.layer==='SDK_BUSINESS'?'SDK_BUSINESS':'CONTRACT',code,capture,save_acknowledged:acknowledged,readback_acknowledged:false,health_after:null}:{format:'xdev-engineering-child-error-1',layer:e instanceof MemoryError&&e.layer==='SDK_BUSINESS'?'SDK_BUSINESS':'CONTRACT',code};}
}

// Legacy exported API keeps the original preparation/business sequence.
export function executeEngineeringChild(local:ReturnType<typeof loadConfig>,input:any,sdk:any,standalone:any,paths:any=(local as any)[Symbol.for('xdev.TEST_ONLY.fixed-child-paths')],observeRead?:<T>(operation:()=>T)=>T){
 return executeEngineeringCore07(local,input,sdk,standalone,paths,undefined,observeRead);
}
function prepareBody07(local:ReturnType<typeof loadConfig>,input:any){
 const selected=selectMemoryBoundary(local.config);let p:any;
 exact(input,['config_path','config_sha256','action','source','mode','revision',...(input.deadline_unix_ms===undefined?[]:['deadline_unix_ms'])]);check(local.configPath===input.config_path&&local.configHash===input.config_sha256,'ENGINEERING_LOCAL_CONFIG_DRIFT');p=prepareEngineering(local,input.action,input.source);childStage('BODY_PREPARE_READY');
 check(input.action==='engineering-reconcile'&&input.mode==='read'&&(input.revision===null||typeof input.revision==='string')&&p.event,'P07_FIXED_READONLY');return{p,selected};
}
async function executePhase07CLI(input:any){
 exact07(input,['config_path','config_sha256','action','source','mode','revision','deadline_unix_ms','phase07']);const b=binding07(input.phase07);
 check(process.connected===true&&typeof process.send==='function'&&input.action===b.action&&input.mode===b.mode&&input.revision===b.revision&&input.config_path===b.config.path&&input.config_sha256===b.config.sha256&&canonical(input.source)===canonical(b.source)&&input.deadline_unix_ms===b.total_deadline_ms,'P07_INITIAL_BINDING');
 const clean={config_path:input.config_path,config_sha256:input.config_sha256,action:input.action,source:input.source,mode:input.mode,revision:input.revision,deadline_unix_ms:input.deadline_unix_ms};
 const childWall=Date.now(),mono=process.hrtime.bigint(),childWhole=wholeClock07(childWall,mono,Math.min(b.whole_budget_ms,Math.floor(Math.min(b.total_deadline_ms,b.whole_started_ms+b.whole_budget_ms)-childWall))),prepareGuard=()=>{childWhole.guard();clock07(b.prepare_deadline_ms,mono,Math.min(b.prepare_budget_ms,b.prepare_deadline_ms-childWall),b.prepare_started_ms);};prepareGuard();
 const local=loadConfig(clean.config_path);check(local.configHash===b.config.sha256,'ENGINEERING_LOCAL_CONFIG_DRIFT');childStage('CONFIG_READY');
 const s1=prepareEngineering(local,clean.action,clean.source);childStage('PREPARE_READY');prepareGuard();
 check(s1.e.build_id!==E7_NATIVE_BUILD,'ENGINEERING_NATIVE_PHASE07_UNSUPPORTED');
 const verify=(p:any)=>{check(p.event&&p.event.intent.id===b.operation_id&&hash(canonical(p.event.intent)+'\n')===b.intent_sha256&&canonical({path:local.configPath,sha256:local.configHash})===canonical(b.config)&&canonical(p.e.sdk)===canonical(b.sdk)&&canonical(p.e.standalone_sdk)===canonical(b.standalone_sdk)&&canonical(local.config.memory_bridge!.node)===canonical(b.node)&&p.e.build_id===b.build_id&&b.child.path===fileURLToPath(import.meta.url)&&hash(bytes(b.child.path))===b.child.sha256&&hash(bytes(fileURLToPath(new URL('../PHASE07-SOURCE-MANIFEST.json',import.meta.url)),262144))===b.qualification_sha256,'P07_CHILD_QUALIFICATION');};verify(s1);
 const sdk=await import(pathToFileURL(s1.e.sdk.path).href);childStage('ENGINEERING_SDK_READY');prepareGuard();
 const standalone=await import(pathToFileURL(s1.e.standalone_sdk.path).href);childStage('STANDALONE_SDK_READY');prepareGuard();
 const paths=selectMemoryBoundary(local.config)?await import(pathToFileURL(join(dirname(s1.e.sdk.path),'paths.js')).href):undefined;childStage('PATHS_READY');prepareGuard();
 const prepared=prepareBody07(local,clean);verify(prepared.p);prepareGuard();const bh=hash(canonical(b)),protocol=new Phase07Frames('child',b,bh);
 await new Promise<void>((resolve,reject)=>{
  let timer:any,finished=false,running=false,run:any,runMono:bigint|undefined;
  const cleanup=()=>{clearTimeout(timer);process.removeListener('message',message);process.removeListener('disconnect',disconnected);};
  const fail=(e:any)=>{if(finished)return;finished=true;protocol.stop();cleanup();try{if(process.connected)process.disconnect();}catch{}reject(e);};
  const disconnected=()=>{if(!finished)fail(Error('P07_EARLY_DISCONNECT'));};
  const runGuard=()=>{if(!run||runMono===undefined)throw Error('P07_RUN_MISSING');childWhole.guard();clock07(run.run_deadline_ms,runMono,Math.min(b.run_budget_ms,run.run_deadline_ms-run.run_started_ms),run.run_started_ms);};
  const send=(text:string,next:()=>void)=>{try{process.send!(text,undefined,undefined,(e:any)=>{if(e){fail(e);return;}if(finished)return;try{next();}catch(x){fail(x);}});}catch(e){fail(e);}};
  const message=(raw:any,handle:any)=>{try{if(running)throw Error('P07_DUPLICATE_RUN');run=protocol.receive(raw,handle);prepareGuard();if(run.run_started_ms>=b.prepare_deadline_ms)throw Error('P07_LATE_RUN');runMono=process.hrtime.bigint();runGuard();running=true;clearTimeout(timer);timer=setTimeout(()=>fail(Error('P07_RUN_TIMEOUT')),phaseDelay07(run.run_deadline_ms,runMono,Math.min(b.run_budget_ms,run.run_deadline_ms-run.run_started_ms),run.run_started_ms,childWhole));
   send(protocol.send('ACK',{run_started_ms:run.run_started_ms,run_deadline_ms:run.run_deadline_ms}),()=>{
    runGuard();const result=executeEngineeringCore07(local,{...clean,deadline_unix_ms:run.run_deadline_ms},sdk,standalone,paths,{...prepared,guard:runGuard});runGuard();childStage('RESULT_READY');const text=JSON.stringify(result)+'\n';
    process.stdout.write(text,()=>{if(finished)return;try{runGuard();send(protocol.send('DONE',{stdout_sha256:hash(Buffer.from(text))}),()=>{runGuard();protocol.disconnect();finished=true;cleanup();try{if(process.connected)process.disconnect();}catch(e){reject(e);return;}resolve();});}catch(e){fail(e);}});
   });
  }catch(e){fail(e);}};
  process.on('message',message);process.on('disconnect',disconnected);process.on('error',e=>{if(!finished)fail(e);});
  timer=setTimeout(()=>fail(Error('P07_PREPARE_TIMEOUT')),phaseDelay07(b.prepare_deadline_ms,mono,Math.min(b.prepare_budget_ms,b.prepare_deadline_ms-childWall),b.prepare_started_ms,childWhole));
  send(protocol.send('READY'),()=>{prepareGuard();});
 });
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 childTraceStart=process.hrtime.bigint();childStage('ENTRY');
 try{
  check(process.argv.length===2&&process.versions.node==='24.20.0','ENGINEERING_EXACT_NODE_REQUIRED');
  const buffer=Buffer.alloc(16385);let used=0,n=0;while(used<buffer.length&&(n=readSync(0,buffer,used,buffer.length-used,null))>0)used+=n;check(used<buffer.length,'ENGINEERING_CHILD_INPUT_BOUND');
  const input=memoryJson(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,used)));if(Object.hasOwn(input,'phase07')){childStage('INPUT_READY');await executePhase07CLI(input);}else{childPhysicalTrace=input.action==='engineering-reconcile'&&input.mode==='read';exact(input,['config_path','config_sha256','action','source','mode','revision',...(input.deadline_unix_ms===undefined?[]:['deadline_unix_ms'])]);childStage('INPUT_READY');const local=loadConfig(input.config_path);check(local.configHash===input.config_sha256,'ENGINEERING_LOCAL_CONFIG_DRIFT');childStage('CONFIG_READY');
  // S before imports; the fixed body repeats S after import under the same end.
  const p=prepareEngineering(local,input.action,input.source);childStage('PREPARE_READY');
  guardNativeChild(local,input,p);
  const sdk=await import(pathToFileURL(p.e.sdk.path).href);childStage('ENGINEERING_SDK_READY');
  const standalone=await import(pathToFileURL(p.e.standalone_sdk.path).href);childStage('STANDALONE_SDK_READY');
  // prepareEngineering has verified the full closed inventory and that this SDK
  // is runtime_root/dist/src/engineering-memory.js; paths.js is its fixed peer.
  const paths=selectMemoryBoundary(local.config)?await import(pathToFileURL(join(dirname(p.e.sdk.path),'paths.js')).href):undefined;childStage('PATHS_READY');
  const physical=childPhysicalTrace&&p.e.build_id===UNIFIED_BUILD?await import(pathToFileURL(join(dirname(p.e.sdk.path),'physical-readonly.js')).href):undefined;
  const observeRead=typeof physical?.withPhysicalReadObservation==='function'
   ?(operation:()=>any)=>physical.withPhysicalReadObservation((stage:ChildStage)=>childStage(stage),operation)
   :undefined;
  const result=executeEngineeringCore07(local,input,sdk,standalone,paths,undefined,observeRead,true);childCoreReturnStage(result);childStage('RESULT_READY');process.stdout.write(JSON.stringify(result)+'\n');
   }
 }catch(e){if(process.connected){try{process.disconnect();}catch{}process.exitCode=2;}childStage('ERROR_ENVELOPE');process.stdout.write(JSON.stringify({format:'xdev-engineering-child-error-1',layer:e instanceof MemoryError&&e.layer==='SDK_BUSINESS'?'SDK_BUSINESS':'CONTRACT',code:e instanceof MemoryError?e.code:'ENGINEERING_CHILD_REFUSED_OR_UNKNOWN'})+'\n');}
}
