// Fixed public read-only SDK child. No Owner configure or arbitrary function API.
import { readSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exact, loadConfig } from './configure.ts';
import { MemoryError, memoryCheck as check, memoryJson, dependencyRegistration } from './xmem-client.ts';
import { prepareRelated, guardRelated, checkRelatedStatus } from './related-memory.ts';
import { E7_NATIVE_BUILD } from './sdk-builds.ts';
import { selectMemoryBoundary, boundaryOptions } from '../src/host-surface/project-memory-boundary.ts';

/** Same fixed child body in production and module-only controlled tests. */
export function executeRelatedChild(local:ReturnType<typeof loadConfig>,input:any,sdk:any,standalone:any,paths:any=(local as any)[Symbol.for('xdev.TEST_ONLY.fixed-child-paths')]){
 try{
  exact(input,['config_path','config_sha256','source',...(input.deadline_unix_ms===undefined?[]:['deadline_unix_ms'])]);check(local.configPath===input.config_path&&local.configHash===input.config_sha256,'RELATED_LOCAL_CONFIG_DRIFT');const p=prepareRelated(local,input.source),selected=selectMemoryBoundary(local.config),options=selected?boundaryOptions(selected.boundary,input.deadline_unix_ms,p.r.limits.payload_bytes):undefined;check(selected!==null||input.deadline_unix_ms===undefined,'RELATED_UNEXPECTED_DEADLINE');
  check(!options||typeof paths?.withPathValidationScope==='function','RELATED_PATH_SCOPE_API_UNSUPPORTED');
  // Each status gets a fresh operation scope; no scope spans the query or peer.
  const sdkCall=(operation:()=>any)=>options?paths.withPathValidationScope(operation,()=>options.deadline_unix_ms-Date.now()):operation();
  const deadline=()=>{if(options)check(Date.now()<options.deadline_unix_ms,'RELATED_TOTAL_DEADLINE');};deadline();
  const before=sdkCall(()=>standalone.standaloneStatus(local.config.project_root,'sdk'));checkRelatedStatus(local.config,before);guardRelated(local);
  deadline();let result:any,lifecycle:any=null;
  if(p.dependency){check(options&&typeof sdk.registerSharedMemoryDependencies==='function'&&typeof standalone.revokeMemoryDependencies==='function','RELATED_DEPENDENCY_API_UNSUPPORTED');const registered=dependencyRegistration(sdk.registerSharedMemoryDependencies(local.config.project_root,p.dependency.registration,options));try{deadline();result=sdk.querySharedMemory(local.config.project_root,p.query,options,{dependencies:[registered.handle],...(p.dependency.dependency_budget===undefined?{}:{dependency_budget:p.dependency.dependency_budget})});}finally{check(standalone.revokeMemoryDependencies(registered.handle)===true,'RELATED_DEPENDENCY_REVOKE_UNKNOWN');}lifecycle={channel:'related',source:p.dependency.ref,registered_edges:registered.registered_edges,revoked:true,handle_serialized:false,authority:'SDK_PROCESS_LOCAL_HANDLE_NOT_MCP_TOKEN'};}
  else result=sdk.querySharedMemory(local.config.project_root,p.query,options);deadline();
  const after=sdkCall(()=>standalone.standaloneStatus(local.config.project_root,'sdk'));checkRelatedStatus(local.config,after);guardRelated(local);
  deadline();return{format:'xdev-related-child-1',before,result,after,...(p.dependency?{dependency_lifecycle:lifecycle}:{})};
 }catch(e){const code=e instanceof MemoryError&&/^[A-Z0-9_:-]{1,128}$/.test(e.code)?e.code:'RELATED_CHILD_REFUSED_OR_UNKNOWN';return{format:'xdev-related-child-error-1',error:{layer:e instanceof MemoryError&&e.layer==='SDK_BUSINESS'?'SDK_BUSINESS':'CONTRACT',code}};}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  check(process.argv.length===2&&process.versions.node==='24.20.0','RELATED_EXACT_NODE_REQUIRED');
  const buffer=Buffer.alloc(16385);let used=0,n=0;while(used<buffer.length&&(n=readSync(0,buffer,used,buffer.length-used,null))>0)used+=n;check(used<buffer.length,'RELATED_CHILD_INPUT_BOUND');
  const input=memoryJson(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,used)));exact(input,['config_path','config_sha256','source',...(input.deadline_unix_ms===undefined?[]:['deadline_unix_ms'])]);const local=loadConfig(input.config_path);check(local.configHash===input.config_sha256,'RELATED_LOCAL_CONFIG_DRIFT');const r=local.config.memory_bridge?.related;check(!r?.enabled||r.build_id!==E7_NATIVE_BUILD,'RELATED_E7_FIXED_CHILD_REQUIRED');const p=prepareRelated(local,input.source),sdk=await import(pathToFileURL(p.r.sdk.path).href),standalone=await import(pathToFileURL(p.r.standalone_sdk.path).href);
  // prepareRelated verifies the complete closed inventory and this fixed
  // runtime_root/dist/src/shared-memory.js path before loading its paths.js peer.
  const paths=selectMemoryBoundary(local.config)?await import(pathToFileURL(join(dirname(p.r.sdk.path),'paths.js')).href):undefined;
  process.stdout.write(JSON.stringify(executeRelatedChild(local,input,sdk,standalone,paths))+'\n');
 }catch(e){process.stdout.write(JSON.stringify({format:'xdev-related-child-error-1',error:{layer:e instanceof MemoryError&&e.layer==='SDK_BUSINESS'?'SDK_BUSINESS':'CONTRACT',code:e instanceof MemoryError?e.code:'RELATED_CHILD_REFUSED_OR_UNKNOWN'}})+'\n');}
}
