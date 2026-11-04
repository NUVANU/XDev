// Fixed SDK83 plain public read-only SDK child. No Owner configure or arbitrary function API.
import { readSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bytes, exact, hash, loadConfig } from './configure.ts';
import { E7_NATIVE_BUILD, E7_NODE_SHA256 } from './sdk-builds.ts';
import { RelatedProtocolError as MemoryError, memoryCheck as check, memoryJson, prepareRelatedChildStart, prepareRelatedOperation, prepareNativeRelatedHealth, checkRelatedPhase } from './related-unified-protocol.ts';

/** Same fixed child body in production and module-only controlled tests. */
export function executeRelatedUnifiedChild(local:ReturnType<typeof loadConfig>,input:any,sdk:any,standalone:any,paths:any=(local as any)[Symbol.for('xdev.TEST_ONLY.fixed-child-paths')]){
 try{
  exact(input,['config_path','config_sha256','source',...(input.deadline_unix_ms===undefined?[]:['deadline_unix_ms'])]);check(local.configPath===input.config_path&&local.configHash===input.config_sha256,'RELATED_LOCAL_CONFIG_DRIFT');const {prepared:p,options}=prepareRelatedOperation(local,input.source,input.deadline_unix_ms);
  check(!options||typeof paths?.withPathValidationScope==='function','RELATED_PATH_SCOPE_API_UNSUPPORTED');
  // Each status gets a fresh operation scope; no scope spans the query or peer.
  const sdkCall=(operation:()=>any)=>options?paths.withPathValidationScope(operation,()=>options.deadline_unix_ms-Date.now()):operation();
  const deadline=()=>{if(options)check(Date.now()<options.deadline_unix_ms,'RELATED_TOTAL_DEADLINE');};deadline();
  const before=sdkCall(()=>standalone.standaloneStatus(local.config.project_root,'sdk'));checkRelatedPhase(local,before);
  deadline();const result=sdk.querySharedMemory(local.config.project_root,p.query,options);deadline();
  const after=sdkCall(()=>standalone.standaloneStatus(local.config.project_root,'sdk'));checkRelatedPhase(local,after);
  deadline();return{format:'xdev-related-child-1',before,result,after};
 }catch(e){const code=e instanceof MemoryError&&/^[A-Z0-9_:-]{1,128}$/.test(e.code)?e.code:'RELATED_CHILD_REFUSED_OR_UNKNOWN';return{format:'xdev-related-child-error-1',error:{layer:e instanceof MemoryError&&e.layer==='SDK_BUSINESS'?'SDK_BUSINESS':'CONTRACT',code}};}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  check(process.argv.length===2&&process.versions.node==='24.20.0','RELATED_EXACT_NODE_REQUIRED');
  const buffer=Buffer.alloc(16385);let used=0,n=0;while(used<buffer.length&&(n=readSync(0,buffer,used,buffer.length-used,null))>0)used+=n;check(used<buffer.length,'RELATED_CHILD_INPUT_BOUND');
  const input=memoryJson(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,used)));
  const health=input.format==='xdev-e7-related-doctor-1';
  exact(input,['config_path','config_sha256','source',...(input.deadline_unix_ms===undefined?[]:['deadline_unix_ms']),...(health?['format']:[])]);
  const {local,prepared:p,doctor}=prepareRelatedChildStart({path:input.config_path,sha256:input.config_sha256},input.source,health,input.deadline_unix_ms);
  const m=local.config.memory_bridge;
  if(m?.related?.enabled===true&&m.related.build_id===E7_NATIVE_BUILD){
   check(m.node.path===process.execPath&&m.node.sha256===E7_NODE_SHA256&&hash(bytes(process.execPath,128*1024*1024))===m.node.sha256,'RELATED_NODE_DRIFT');
   check(Number.isSafeInteger(input.deadline_unix_ms)&&Date.now()<input.deadline_unix_ms,'RELATED_TOTAL_DEADLINE');
  }
  if(doctor){
   const {boundary,options,indexPath}=doctor;
   const sdk=await import(pathToFileURL(indexPath).href);
   check(Date.now()<options.deadline_unix_ms,'RELATED_TOTAL_DEADLINE');
   const value=sdk.doctorProject(boundary.project_root,options);
   prepareNativeRelatedHealth(local,input.source,input.deadline_unix_ms);
   check(Date.now()<options.deadline_unix_ms,'RELATED_TOTAL_DEADLINE');
   process.stdout.write(JSON.stringify(value)+'\n');
  }else{
   const sdk=await import(pathToFileURL(p.r.sdk.path).href),standalone=await import(pathToFileURL(p.r.standalone_sdk.path).href);
   // The startup phase verifies the closed inventory and the fixed public
   // paths. The execution phase prepares again after all SDK imports.
   const paths=await import(pathToFileURL(join(dirname(p.r.sdk.path),'paths.js')).href);
   process.stdout.write(JSON.stringify(executeRelatedUnifiedChild(local,input,sdk,standalone,paths))+'\n');
  }
 }catch(e){process.stdout.write(JSON.stringify({format:'xdev-related-child-error-1',error:{layer:e instanceof MemoryError&&e.layer==='SDK_BUSINESS'?'SDK_BUSINESS':'CONTRACT',code:e instanceof MemoryError?e.code:'RELATED_CHILD_REFUSED_OR_UNKNOWN'}})+'\n');}
}
