import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseD1UniqueJson } from '../src/job-runtime/contracts.ts';
import { E7_NATIVE_BUILD, ENGINEERING_CONTRACTS, RELATED_BUILDS, nativeJointQuery } from './sdk-builds.ts';
import { selectMemoryBoundary, selectMemoryBoundaryWithDeployment } from '../src/host-surface/project-memory-boundary.ts';

export type FileRef = { path:string; sha256:string };
export type EngineeringConfig={enabled:false}|{enabled:true;format:'xdev-engineering-memory-config-1';sdk:FileRef;standalone_sdk:FileRef;build_id:string;request:FileRef;mapping:FileRef};
export type RelatedConfig={enabled:false}|{enabled:true;format:'xdev-related-memory-config-1';deployment:FileRef;sdk:FileRef;standalone_sdk:FileRef;build_id:string;sharing_file:FileRef;sharing_policy_hash:string;allowed_source_ids:string[];tags:string[];approved_queries:FileRef[];limits:{calls:number;call_ms:number;total_ms:number;payload_bytes:number;total_payload_bytes:number;result_limit:number;response_bytes:number;stderr_bytes:number}};
export type MemoryBridgeConfig = {
  format:'xdev-xmem-companion-bridge-1'; node:FileRef; server:FileRef; deployment:FileRef; tool_pins:FileRef;
  project_id:string; workspace_id:string; task_ref:string; task_version:string; role:'developer'; recipient:string;
  policy_hash:string; location_hash:string; storage_root:string; event_namespace:string;
  permissions:{recall:boolean;capture:boolean;reconcile:boolean;checkpoint:boolean}; approved_sources:FileRef[];
  required_context:boolean; limits:{call_ms:number;total_ms:number;payload_bytes:number;response_bytes:number;stderr_bytes:number};
  related?:RelatedConfig;
  engineering?:EngineeringConfig;
  current_facts?:FileRef;
  dependencies?:{ordinary?:FileRef;engineering?:FileRef;related?:FileRef};
};
export type LocalConfig = { format:'xdev-local-mcp-1'; project_id:string; project_root:string; control_root:string; input_root:string;
  permissions?:{stage_inputs?:boolean;write_jobs?:boolean;execute_qa?:boolean;receive_specs?:boolean}; spec_intake?:{enabled:false}|{enabled:true;approved_sources:FileRef[];approved_mappings:FileRef[]}; approved_requests?:FileRef[]; memory_bridge?:MemoryBridgeConfig;
  recovery?:{enabled:false}|{enabled:true;format:'xdev-local-recovery-1';approved_permits:FileRef[]} };
export const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
export function need(v:unknown, code:string):asserts v { if(!v)throw Error(code); }
export function exact(v:any, keys:string[]) { need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|'),'MCP_UNKNOWN_OR_MISSING_FIELDS'); }
export function within(root:string,path:string) { const r=relative(root,path);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep)); }
export function noLinks(path:string) {
  need(typeof path==='string'&&isAbsolute(path)&&resolve(path)===path,'MCP_CANONICAL_ABSOLUTE_PATH_REQUIRED');
  const parent=dirname(path);if(parent!==path)noLinks(parent);
  let st;try{st=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  need(!st.isSymbolicLink(),'MCP_LINK_REJECTED');
}
export function bytes(path:string,limit=2*1024*1024) { noLinks(path);const st=lstatSync(path);need(st.isFile()&&st.nlink===1&&st.size<=limit,'MCP_FILE_INVALID');return readFileSync(path); }
export function refShape(ref:any):asserts ref is FileRef { exact(ref,['path','sha256']);need(typeof ref.path==='string'&&typeof ref.sha256==='string'&&/^[a-f0-9]{64}$/.test(ref.sha256),'MCP_FILE_REF_INVALID'); }
function memoryConfig(c:LocalConfig,select:()=>ReturnType<typeof selectMemoryBoundary>) {
  const m=c.memory_bridge;if(m===undefined)return;
  exact(m,['format','node','server','deployment','tool_pins','project_id','workspace_id','task_ref','task_version','role','recipient','policy_hash','location_hash','storage_root','event_namespace','permissions','approved_sources','required_context','limits',...(m.related===undefined?[]:['related']),...(m.engineering===undefined?[]:['engineering']),...(m.current_facts===undefined?[]:['current_facts']),...(m.dependencies===undefined?[]:['dependencies'])]);
  need(m.format==='xdev-xmem-companion-bridge-1'&&m.role==='developer'&&typeof m.required_context==='boolean','MEMORY_CONFIG_INVALID');
  for(const v of [m.project_id,m.workspace_id,m.task_ref,m.task_version,m.recipient,m.event_namespace])need(typeof v==='string'&&Buffer.byteLength(v)<=256&&v.trim().length>0&&!/[\x00-\x1f]/.test(v),'MEMORY_SCOPE_INVALID');
  for(const v of [m.policy_hash,m.location_hash])need(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),'MEMORY_HASH_INVALID');
  for(const r of [m.node,m.server,m.deployment,m.tool_pins]){refShape(r);noLinks(r.path);}
  for(const r of [m.deployment,m.tool_pins])need(within(c.input_root,r.path),'MEMORY_PIN_OUTSIDE_INPUT_ROOT');
  noLinks(m.storage_root);need(lstatSync(m.storage_root).isDirectory(),'MEMORY_STORAGE_DIRECTORY_REQUIRED');
  const boundary=select();
  if(!boundary)for(const r of [c.project_root,c.control_root,c.input_root])need(!within(r,m.storage_root)&&!within(m.storage_root,r),'MEMORY_STORAGE_MUST_BE_EXTERNAL');
  else for(const r of [c.control_root,c.input_root])need(!within(r,m.storage_root)&&!within(m.storage_root,r),'MEMORY_STORAGE_MUST_BE_EXTERNAL');
  exact(m.permissions,['recall','capture','reconcile','checkpoint']);for(const p of Object.values(m.permissions))need(typeof p==='boolean','MEMORY_PERMISSION_INVALID');
  need(Array.isArray(m.approved_sources)&&m.approved_sources.length<=64,'MEMORY_APPROVALS_INVALID');
  for(const r of m.approved_sources){refShape(r);noLinks(r.path);need(within(c.input_root,r.path),'MEMORY_SOURCE_OUTSIDE_INPUT_ROOT');}
  need(new Set(m.approved_sources.map(r=>r.path)).size===m.approved_sources.length,'MEMORY_DUPLICATE_APPROVAL');
  if(m.current_facts!==undefined){refShape(m.current_facts);noLinks(m.current_facts.path);need(within(c.input_root,m.current_facts.path)&&m.approved_sources.some(r=>r.path===m.current_facts!.path&&r.sha256===m.current_facts!.sha256),'MEMORY_CURRENT_FACTS_NOT_APPROVED');}
  if(m.dependencies!==undefined){need(m.dependencies&&typeof m.dependencies==='object'&&!Array.isArray(m.dependencies),'MEMORY_DEPENDENCIES_INVALID');const keys=Object.keys(m.dependencies);need(keys.length>=1&&keys.every(k=>['ordinary','engineering','related'].includes(k)),'MEMORY_DEPENDENCY_CHANNEL_INVALID');for(const r of Object.values(m.dependencies)){refShape(r);noLinks(r.path);need(within(c.input_root,r.path)&&m.approved_sources.some(a=>a.path===r.path&&a.sha256===r.sha256),'MEMORY_DEPENDENCY_SOURCE_NOT_APPROVED');}}
  exact(m.limits,['call_ms','total_ms','payload_bytes','response_bytes','stderr_bytes']);
  const bounds={call_ms:[100,10000],total_ms:[100,60000],payload_bytes:[1024,16384],response_bytes:[32768,262144],stderr_bytes:[0,8192]};
  for(const [k,[min,max]] of Object.entries(bounds)){const n=m.limits[k as keyof typeof m.limits];need(Number.isSafeInteger(n)&&n>=min!&&n<=max!,'MEMORY_LIMIT_INVALID');}
  need(m.limits.call_ms<=m.limits.total_ms,'MEMORY_LIMIT_INVALID');
  // Validate before related's disabled early return. Neither optional branch
  // can bypass validation of the other one.
  const e=m.engineering;if(e!==undefined){
    need(e&&typeof e==='object'&&typeof e.enabled==='boolean','ENGINEERING_CONFIG_INVALID');
    if(!e.enabled)exact(e,['enabled']);else{
      exact(e,['enabled','format','sdk','standalone_sdk','build_id','request','mapping']);
      need(e.format==='xdev-engineering-memory-config-1'&&Object.hasOwn(ENGINEERING_CONTRACTS,e.build_id),'ENGINEERING_BUILD_UNSUPPORTED');
      for(const ref of [e.sdk,e.standalone_sdk,e.request,e.mapping]){refShape(ref);noLinks(ref.path);}
      need([e.request,e.mapping].every(ref=>within(c.input_root,ref.path))&&c.approved_requests?.some(ref=>ref.path===e.request.path&&ref.sha256===e.request.sha256),'ENGINEERING_REQUEST_NOT_APPROVED');
    }
  }
  if(e?.enabled&&e.build_id===E7_NATIVE_BUILD)need(m.related?.enabled===true&&boundary?.boundary.sdk_build_id===E7_NATIVE_BUILD,'ENGINEERING_NATIVE_JOINT_BOUNDARY_REQUIRED');
  const r=m.related;if(r!==undefined){
    need(r&&typeof r==='object'&&typeof r.enabled==='boolean','RELATED_CONFIG_INVALID');
    if(!r.enabled){exact(r,['enabled']);return;}
    exact(r,['enabled','format','deployment','sdk','standalone_sdk','build_id','sharing_file','sharing_policy_hash','allowed_source_ids','tags','approved_queries','limits']);
    need(r.format==='xdev-related-memory-config-1'&&RELATED_BUILDS.includes(r.build_id),'RELATED_BUILD_UNSUPPORTED');
    for(const ref of [r.deployment,r.sdk,r.standalone_sdk,r.sharing_file]){refShape(ref);noLinks(ref.path);}
    need(basename(r.sdk.path)==='shared-memory.js'&&basename(r.standalone_sdk.path)==='standalone.js'&&dirname(r.sdk.path)===dirname(r.standalone_sdk.path),'RELATED_PUBLIC_SDK_REQUIRED');
    need(within(c.input_root,r.deployment.path),'RELATED_DEPLOYMENT_OUTSIDE_INPUT');
    need(r.sharing_file.path===resolve(c.project_root,'.xmem/sharing-v1.json')&&/^[a-f0-9]{64}$/.test(r.sharing_policy_hash),'RELATED_SHARING_PIN_INVALID');
    for(const [list,max] of [[r.allowed_source_ids,64],[r.tags,8]] as const)need(Array.isArray(list)&&list.length<=max&&new Set(list).size===list.length&&list.every(v=>typeof v==='string'&&v.trim().length>0&&Buffer.byteLength(v)<=512&&!/[\x00-\x1f]/.test(v)),'RELATED_ALLOWLIST_INVALID');
    need(r.allowed_source_ids.length>0&&Array.isArray(r.approved_queries)&&r.approved_queries.length>0&&r.approved_queries.length<=16,'RELATED_APPROVALS_INVALID');
    for(const ref of r.approved_queries){refShape(ref);noLinks(ref.path);need(within(c.input_root,ref.path),'RELATED_QUERY_OUTSIDE_INPUT');}
    need(new Set(r.approved_queries.map(v=>v.path)).size===r.approved_queries.length,'RELATED_DUPLICATE_APPROVAL');
    exact(r.limits,['calls','call_ms','total_ms','payload_bytes','total_payload_bytes','result_limit','response_bytes','stderr_bytes']);
    const bounds={calls:[1,8],call_ms:[100,10000],total_ms:[100,60000],payload_bytes:[1,8192],total_payload_bytes:[1,32768],result_limit:[1,32],response_bytes:[1024,65536],stderr_bytes:[0,8192]};
    for(const [key,[min,max]] of Object.entries(bounds)){const v=r.limits[key as keyof typeof r.limits];need(Number.isSafeInteger(v)&&v>=min!&&v<=max!,'RELATED_LIMIT_INVALID');}
    need(r.limits.call_ms<=Math.min(m.limits.call_ms,r.limits.total_ms)&&r.limits.total_ms<=m.limits.total_ms&&r.limits.payload_bytes<=Math.min(m.limits.payload_bytes,r.limits.total_payload_bytes)&&r.limits.response_bytes<=m.limits.response_bytes&&r.limits.stderr_bytes<=m.limits.stderr_bytes,'RELATED_PARENT_LIMIT_EXCEEDED');
  }
  if(e?.enabled&&e.build_id===E7_NATIVE_BUILD)need(nativeJointQuery(c),'ENGINEERING_NATIVE_JOINT_CONFIG_REQUIRED');
}
function loadConfigData(path:string,includeDeployment:boolean) {
  const data=bytes(path),c=parseD1UniqueJson(data.toString('utf8')) as LocalConfig;
  exact(c,['format','project_id','project_root','control_root','input_root',...(c.permissions===undefined?[]:['permissions']),...(c.approved_requests===undefined?[]:['approved_requests']),...(c.memory_bridge===undefined?[]:['memory_bridge']),...(c.recovery===undefined?[]:['recovery']),...(c.spec_intake===undefined?[]:['spec_intake'])]);
  need(c.format==='xdev-local-mcp-1'&&typeof c.project_id==='string'&&c.project_id.trim().length>0&&c.project_id.length<256,'MCP_CONFIG_INVALID');
  const roots=[c.project_root,c.control_root,c.input_root];for(const root of roots){noLinks(root);need(lstatSync(root).isDirectory(),'MCP_ROOT_DIRECTORY_REQUIRED');}
  need(roots.every((a,i)=>roots.every((d,j)=>i===j||!within(a,d))),'MCP_ROOTS_MUST_BE_DISJOINT');
  if(c.permissions!==undefined){need(c.permissions&&typeof c.permissions==='object'&&!Array.isArray(c.permissions),'MCP_PERMISSIONS_INVALID');for(const [k,v] of Object.entries(c.permissions))need(['stage_inputs','write_jobs','execute_qa','receive_specs'].includes(k)&&typeof v==='boolean','MCP_PERMISSIONS_INVALID');}
  need(!c.permissions?.execute_qa||c.permissions.write_jobs===true,'MCP_QA_REQUIRES_JOB_WRITE');
  need(c.approved_requests===undefined||Array.isArray(c.approved_requests)&&c.approved_requests.length<=16,'MCP_APPROVALS_INVALID');
  for(const ref of c.approved_requests??[]){refShape(ref);noLinks(ref.path);need(within(c.input_root,ref.path),'MCP_APPROVAL_OUTSIDE_INPUT_ROOT');}
  need(!c.permissions?.write_jobs||(c.approved_requests?.length??0)>0,'MCP_LOCAL_APPROVED_REQUEST_REQUIRED');
  if(c.spec_intake!==undefined){const i=c.spec_intake;need(i&&typeof i.enabled==='boolean','XSPEC_CONFIG_INVALID');if(!i.enabled)exact(i,['enabled']);else{
    exact(i,['enabled','approved_sources','approved_mappings']);
    for(const list of [i.approved_sources,i.approved_mappings]){need(Array.isArray(list)&&list.length>0&&list.length<=16,'XSPEC_APPROVAL_INVALID');for(const r of list){refShape(r);noLinks(r.path);need(within(c.input_root,r.path),'XSPEC_APPROVAL_OUTSIDE_INPUT_ROOT');}need(new Set(list.map(r=>r.path)).size===list.length,'XSPEC_APPROVAL_DUPLICATE');}
  }}
  need(!c.permissions?.receive_specs||c.spec_intake?.enabled===true,'XSPEC_RECEIVE_CONFIG_REQUIRED');
  let selected:ReturnType<typeof selectMemoryBoundaryWithDeployment>=null;
  memoryConfig(c,()=>includeDeployment?(selected=selectMemoryBoundaryWithDeployment(c)):selectMemoryBoundary(c));
  const recovery=c.recovery;if(recovery!==undefined){need(recovery&&typeof recovery==='object'&&typeof recovery.enabled==='boolean','MCP_RECOVERY_CONFIG_INVALID');
    if(!recovery.enabled)exact(recovery,['enabled']);else{exact(recovery,['enabled','format','approved_permits']);need(recovery.format==='xdev-local-recovery-1'&&Array.isArray(recovery.approved_permits)&&recovery.approved_permits.length<=16,'MCP_RECOVERY_CONFIG_INVALID');
      for(const ref of recovery.approved_permits){refShape(ref);noLinks(ref.path);need(within(c.input_root,ref.path),'MCP_RECOVERY_PERMIT_OUTSIDE_INPUT');}need(new Set(recovery.approved_permits.map(ref=>ref.path)).size===recovery.approved_permits.length,'MCP_RECOVERY_DUPLICATE_PERMIT');}}
  return {local:{config:structuredClone(c),configPath:path,configHash:hash(data)},selected};
}
export function loadConfig(path:string) {
  return loadConfigData(path,false).local;
}
/** The fixed child consumes this selection immediately, before any import. */
export function loadConfigWithDeployment(path:string) {
  return loadConfigData(path,true);
}

// Prints a connection descriptor only. Does not install, approve or modify a host.
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { const args=process.argv.slice(2);
    const unbound=args.length===2&&args[0]==='--host',bound=args.length===4&&args[0]==='--config'&&args[2]==='--host';
    need(unbound||bound,'Usage: configure.ts [--config ABS] --host claude|workbuddy|deepseek|codex');
    const host=args[bound?3:1];need(['claude','workbuddy','deepseek','codex'].includes(host!),'MCP_HOST_UNSUPPORTED');
    const configPath=bound?loadConfig(resolve(args[1]!)).configPath:null;
    const server=fileURLToPath(new URL('./server.ts',import.meta.url)),entry={command:process.execPath,args:['--experimental-strip-types',server,...(configPath===null?[]:['--config',configPath])]};
    const output=host==='codex'?{host,install_argv:['codex','mcp','add','xdev','--',entry.command,...entry.args],executed:false}:host==='deepseek'?{id:'mcp-xdev',name:'@deepseek-ai/dsh-mcp-client',config:{serverName:'xdev',transport:'stdio',...entry,toolCallTimeoutMs:110000,reconnect:{enabled:false}}}:{mcpServers:{xdev:{type:'stdio',...entry}}};
    process.stdout.write(JSON.stringify(output,null,2)+'\n');
  } catch(e){process.stderr.write((e instanceof Error?e.message:String(e))+'\n');process.exitCode=1;}
}
