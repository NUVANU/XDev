/** Fixed public SDK entries. No caller-selected module/function or serialized
 * SDK handle. The original exact physical read branch remains unchanged. */
import { readSync, writeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exact, loadConfig, bytes, hash } from './configure.ts';
import { memoryCheck as check, memoryJson, verifyMemoryPins, approvedDependencies, dependencyRegistration, decodeXmem, checkOrdinarySdkStatus } from './xmem-client.ts';
import { selectMemoryBoundary, boundaryOptions, boundaryDeployment } from '../src/host-surface/project-memory-boundary.ts';
import { E7_NATIVE_BUILD, UNIFIED_BUILD, nativeJointQuery, nativeOrdinaryAllowed } from './sdk-builds.ts';

/** Module-only SDK injection is a TEST_ONLY seam, never public input. */
export function executeStandaloneViewChild(local:ReturnType<typeof loadConfig>,input:any,sdk:any,views:any,paths:any){
 exact(input,['config_path','config_sha256','input','deadline_unix_ms','action']);
 check(['recall','checkpoint'].includes(input.action)&&local.configPath===input.config_path&&local.configHash===input.config_sha256,'MEMORY_VIEW_INPUT');
 const c=local.config,m=c.memory_bridge!,selected=selectMemoryBoundary(c),d=approvedDependencies(c,'ordinary');
 const build=selected?.boundary.sdk_build_id;
 check(selected&&(build===UNIFIED_BUILD||nativeOrdinaryAllowed(c,build))&&d,'MEMORY_VIEW_DEPENDENCY_REQUIRED');
 exact(input.input,['task_ref','task_version','role',...(input.action==='checkpoint'?['completed','pending','blocked','next_steps']:[])]);
 check(input.input.task_ref===m.task_ref&&input.input.task_version===m.task_version&&input.input.role==='developer','MEMORY_VIEW_SCOPE');
 const deadline=()=>check(Number.isSafeInteger(input.deadline_unix_ms)&&Date.now()<input.deadline_unix_ms,'MEMORY_VIEW_TOTAL_DEADLINE');
 check(typeof sdk.registerMemoryDependencies==='function'&&typeof sdk.revokeMemoryDependencies==='function'&&typeof paths.withPathValidationScope==='function'&&typeof views.startStandaloneSessionCompanionView==='function'&&typeof views.checkpointStandaloneSessionCompanionView==='function','MEMORY_VIEW_API_UNSUPPORTED');
 // Each guard has its own scope and the same earlier absolute deadline; no
 // scope or drive-decision cache spans two independent SDK operations.
 const status=()=>paths.withPathValidationScope(()=>sdk.standaloneStatus(c.project_root,'sdk'),()=>input.deadline_unix_ms-Date.now());
 deadline();const before=status();checkOrdinarySdkStatus(c,before);approvedDependencies(c,'ordinary');
 const options=boundaryOptions(selected.boundary,input.deadline_unix_ms,m.limits.payload_bytes);
 const registered=dependencyRegistration(sdk.registerMemoryDependencies(c.project_root,d.registration,options));let result:any;
 try{deadline();const dep={dependencies:registered.handle,...(d.dependency_budget===undefined?{}:{dependency_budget:d.dependency_budget})};const raw=paths.withPathValidationScope(()=>input.action==='recall'?views.startStandaloneSessionCompanionView(c.project_root,input.input,dep):views.checkpointStandaloneSessionCompanionView(c.project_root,input.input,dep),()=>input.deadline_unix_ms-Date.now());result=decodeXmem(raw,m.limits.response_bytes);}
 finally{check(sdk.revokeMemoryDependencies(registered.handle)===true,'MEMORY_VIEW_DEPENDENCY_REVOKE_UNKNOWN');}
 deadline();const after=status();checkOrdinarySdkStatus(c,after);approvedDependencies(c,'ordinary');selectMemoryBoundary(c);check(hash(bytes(local.configPath))===local.configHash,'MEMORY_VIEW_LOCAL_CONFIG_DRIFT');deadline();
 return{format:'xdev-standalone-view-child-1',before,result,after,dependency_lifecycle:{channel:'ordinary',source:d.ref,registered_edges:registered.registered_edges,revoked:true,handle_serialized:false,authority:'SDK_PROCESS_LOCAL_HANDLE_NOT_MCP_TOKEN'},sdk_path:'SDK_WITH_COMPANION_SAFE_VIEW',derived_state_writes:true};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  check(process.argv.length===2&&process.versions.node==='24.20.0','MEMORY_EXACT_NODE');const buffer=Buffer.alloc(16385);let used=0,n=0;while(used<buffer.length&&(n=readSync(0,buffer,used,buffer.length-used,null))>0)used+=n;check(used<buffer.length,'MEMORY_CHILD_INPUT_BOUND');
  const input=memoryJson(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,used)));
  exact(input,['config_path','config_sha256','input','deadline_unix_ms',...(input.action===undefined?[]:['action']),...(input.source===undefined?[]:['source'])]);
  const local=loadConfig(input.config_path);
  check(local.configHash===input.config_sha256,'MEMORY_LOCAL_CONFIG_DRIFT');
  verifyMemoryPins(local.config);
  const selected=selectMemoryBoundary(local.config);check(selected,'MEMORY_BOUNDARY_REQUIRED');
  if(selected.boundary.sdk_build_id===E7_NATIVE_BUILD)check(local.config.memory_bridge!.node.path===process.execPath,'MEMORY_E7_NODE_DRIFT');
  if(selected.boundary.sdk_build_id===E7_NATIVE_BUILD&&!nativeOrdinaryAllowed(local.config,selected.boundary.sdk_build_id)){
   check(nativeJointQuery(local.config)&&input.action===undefined&&input.source,'MEMORY_E7_ENGINEERING_EVENT_REQUIRED');
   const {prepareEngineering}=await import('./engineering-memory.ts');
   const {requireNativeCaptureStart}=await import('./memory-operation.ts');
   const p=prepareEngineering(local,'engineering-reconcile',input.source);
   check(p.event&&input.input?.memory_key===p.event.intent.memory_key,'MEMORY_E7_ENGINEERING_KEY_MISMATCH');
   const state=requireNativeCaptureStart(local.config.control_root,p.event.intent);
   check(!state.confirmation||input.input.revision_id===state.confirmation.revision_id,'MEMORY_E7_ENGINEERING_REVISION_MISMATCH');
  }else check(input.source===undefined,'MEMORY_UNEXPECTED_ENGINEERING_SOURCE');
  const options=boundaryOptions(selected.boundary,input.deadline_unix_ms,local.config.memory_bridge!.limits.payload_bytes),inv=boundaryDeployment(selected.boundary),sdk=await import(pathToFileURL(join(inv.runtime_root,'dist/src/standalone.js')).href);
  if(input.action!==undefined){check(selected.boundary.sdk_build_id===UNIFIED_BUILD||nativeOrdinaryAllowed(local.config,selected.boundary.sdk_build_id),'MEMORY_VIEW_BUILD_UNSUPPORTED');const views=await import(pathToFileURL(join(inv.runtime_root,'dist/src/mcp.js')).href),paths=await import(pathToFileURL(join(inv.runtime_root,'dist/src/paths.js')).href);process.stdout.write(JSON.stringify(executeStandaloneViewChild(local,input,sdk,views,paths))+'\n');}
  else{exact(input.input,['task_ref','task_version','role','memory_key','revision_id','payload_budget_bytes']);const m=local.config.memory_bridge!;check(input.input.task_ref===m.task_ref&&input.input.task_version===m.task_version&&input.input.role==='developer'&&input.input.payload_budget_bytes===m.limits.payload_bytes,'MEMORY_READ_SCOPE');const started=Date.now(),stage=(name:string)=>{try{writeSync(2,'XDEV_FIXED_READ_V1|'+name+'|'+(Date.now()-started)+'\n');}catch{/* Diagnostic loss is not a business result. */}};stage('READ_ENTER');const result=sdk.readStandaloneMemory(local.config.project_root,input.input,options);stage('READ_RETURN');selectMemoryBoundary(local.config);check(hash(bytes(local.configPath))===local.configHash&&Date.now()<input.deadline_unix_ms,'MEMORY_READ_FINAL_DRIFT');process.stdout.write(JSON.stringify({format:'xdev-standalone-read-child-j01-1',result})+'\n');}
 }catch{process.exitCode=1;}
}
