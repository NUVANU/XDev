import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { canonical } from '../src/job-runtime/store.ts';
import { parseD1UniqueJson } from '../src/job-runtime/contracts.ts';
import { bytes, exact, hash, need, noLinks, within } from './configure.ts';
import type { FileRef, LocalConfig, MemoryBridgeConfig } from './configure.ts';
import { selectMemoryBoundary, selectMemoryBoundaryWithDeployment, boundaryHealth, boundaryOptions, boundaryManifest, boundaryDeployment } from '../src/host-surface/project-memory-boundary.ts';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readdirSync, lstatSync } from 'node:fs';
import { isUnifiedBuild, E7_NATIVE_BUILD, E7_NODE_SHA256, SDK_MEMBERS, RELATED_BUILDS, nativeOrdinaryAllowed } from './sdk-builds.ts';
import { inspectSupervisedInput } from '../src/host-surface/supervised-quality.ts';
import { createInputReader } from './input-reader.ts';

export const COMPANION_NAMES=Object.freeze(['xmem_project_discover','xmem_storage_location_status','xmem_standalone_status','xmem_session_start','xmem_session_capture','xmem_session_read','xmem_session_checkpoint']);
export const COMPANION3_NAMES=Object.freeze([...COMPANION_NAMES,'xmem_dependency_register','xmem_dependency_revoke']);
export class MemoryError extends Error {
  layer:string;code:string;diagnostic:Record<string,unknown>;
  constructor(layer:string,code:string,diagnostic:Record<string,unknown>={}){super(code);this.layer=layer;this.code=code;this.diagnostic=diagnostic;}
}
export function memoryCheck(value:unknown,code:string):asserts value {if(!value)throw new MemoryError('CONTRACT',code);}
export function memoryJson(text:string):any { try{return parseD1UniqueJson(text);}catch{throw new MemoryError('MALFORMED_RESPONSE','MEMORY_INVALID_JSON',{raw_sha256:hash(text)});} }
export function decodeXmem(raw:any,limit:number):any {
  const encoded=JSON.stringify(raw);memoryCheck(typeof encoded==='string'&&Buffer.byteLength(encoded)<=limit,'MEMORY_RESPONSE_BOUND');
  memoryCheck(raw&&Array.isArray(raw.content)&&raw.content.length===1&&raw.content[0]?.type==='text'&&typeof raw.content[0].text==='string','MEMORY_RESPONSE_ENVELOPE');
  if(raw.isError!==undefined&&typeof raw.isError!=='boolean')throw new MemoryError('MALFORMED_RESPONSE','MEMORY_ERROR_FLAG_INVALID');
  const text=raw.content[0].text;let parsed:any;
  try{parsed=parseD1UniqueJson(text);}catch{
    if(raw.isError===true)throw new MemoryError('MCP','MEMORY_MCP_NON_JSON_ERROR',{remote_code:/MCP error (-?\d+)/.exec(text)?.[1]??null,raw_sha256:hash(text)});
    throw new MemoryError('MALFORMED_RESPONSE','MEMORY_NON_JSON_SUCCESS',{raw_sha256:hash(text)});
  }
  if(parsed?.ok===false){const code=typeof parsed.error?.code==='string'&&/^[A-Z0-9_:-]{1,128}$/.test(parsed.error.code)?parsed.error.code:'REMOTE_BUSINESS_ERROR';throw new MemoryError(raw.isError===true?'MCP_BUSINESS':'BUSINESS',code,{raw_sha256:hash(text)});}
  memoryCheck(raw.isError!==true&&parsed?.ok===true&&parsed.value&&typeof parsed.value==='object'&&!Array.isArray(parsed.value),'MEMORY_MALFORMED_SUCCESS');
  if(raw.structuredContent!==undefined)memoryCheck(canonical(raw.structuredContent)===canonical(parsed),'MEMORY_AMBIGUOUS_RESPONSE');
  return parsed.value;
}
export function pinTools(tools:any,build?:string):string {
  const unified=build!==undefined&&(isUnifiedBuild(build)||build===E7_NATIVE_BUILD),namesExpected=unified?COMPANION3_NAMES:COMPANION_NAMES;
  memoryCheck(Array.isArray(tools)&&tools.length===namesExpected.length,unified?'MEMORY_NINE_TOOLS_REQUIRED':'MEMORY_SEVEN_TOOLS_REQUIRED');
  memoryCheck(tools.every(t=>t&&typeof t==='object'&&typeof t.name==='string'),'MEMORY_TOOL_SCHEMA_INVALID');
  const names=tools.map(t=>t?.name).sort();memoryCheck(canonical(names)===canonical([...namesExpected].sort()),'MEMORY_TOOL_SET_CHANGED');
  const normalized=tools.map(t=>{
    memoryCheck(t.inputSchema?.type==='object'&&t.inputSchema.additionalProperties===false,'MEMORY_TOOL_SCHEMA_INVALID');
    const readonly=['xmem_project_discover','xmem_storage_location_status','xmem_standalone_status','xmem_session_read'].includes(t.name);
    const idempotent=!['xmem_dependency_register','xmem_dependency_revoke'].includes(t.name);
    memoryCheck(t.annotations?.readOnlyHint===readonly&&t.annotations.destructiveHint===false&&t.annotations.idempotentHint===idempotent&&t.annotations.openWorldHint===false,'MEMORY_TOOL_ANNOTATIONS_CHANGED');
    return{name:t.name,inputSchema:t.inputSchema,annotations:t.annotations};
  }).sort((a,b)=>a.name.localeCompare(b.name));
  return canonical(normalized);
}
/** No MCP dependency enrollment can fit the unchanged guarded six-call chain. */
export function ordinaryMcpCallGuard(name:string,calls:number){
 if(['xmem_dependency_register','xmem_dependency_revoke'].includes(name))throw new MemoryError('CAPACITY','UNSUPPORTED_WITHIN_6_CALL_CONTRACT');
 memoryCheck(COMPANION_NAMES.includes(name)&&name!=='xmem_project_discover','MEMORY_TOOL_NOT_ALLOWED');memoryCheck(Number.isSafeInteger(calls)&&calls>=0&&calls<6,'MEMORY_CALL_LIMIT');
}
/** Explicit immutable data only; no registration occurs in this reader. */
export function approvedDependencies(c:LocalConfig,channel:'ordinary'|'engineering'|'related'){
 const m=c.memory_bridge!,ref=m.dependencies?.[channel];if(ref===undefined)return null;
 memoryCheck(within(c.input_root,ref.path)&&m.approved_sources.some(a=>canonical(a)===canonical(ref)),'MEMORY_DEPENDENCY_SOURCE_NOT_APPROVED');const b=bytes(ref.path,16384);memoryCheck(hash(b)===ref.sha256,'MEMORY_DEPENDENCY_SOURCE_DRIFT');const v=memoryJson(new TextDecoder('utf-8',{fatal:true}).decode(b));
 exact(v,['format','channel','scope','registration',...(v.dependency_budget===undefined?[]:['dependency_budget'])]);
 memoryCheck(v.format==='xdev-memory-dependency-registration-1'&&v.channel===channel&&canonical(v.scope)===canonical({xdev_project_id:c.project_id,project_id:m.project_id,workspace_id:m.workspace_id,task_ref:m.task_ref,task_version:m.task_version,role:m.role}),'MEMORY_DEPENDENCY_SCOPE');
 if(channel==='ordinary'){
  verifyMemoryPinsAtBoundary(c,{kind:'ordinary'});
 }else{
  const selected=selectMemoryBoundary(c);
  memoryCheck(isUnifiedBuild(selected?.boundary.sdk_build_id)&&verifyMemoryPins(c).build===selected?.boundary.sdk_build_id,
   'MEMORY_DEPENDENCY_BUILD_OR_PHYSICAL_UNSUPPORTED');
 }
 const r=v.registration;exact(r,['task_ref','task_version','role','expected_scope','relation_ids',...(r.allowed_source_ids===undefined?[]:['allowed_source_ids']),...(channel==='related'?['target_scope','expected_sharing_policy_hash']:[])]);
 const word=(s:any)=>typeof s==='string'&&s.trim().length>0&&Buffer.byteLength(s)<=512&&!/[\x00-\x1f]/.test(s),list=(a:any,max:number)=>Array.isArray(a)&&a.length<=max&&a.every(word)&&new Set(a).size===a.length;
 memoryCheck(word(r.task_ref)&&word(r.task_version)&&r.role==='developer'&&canonical(r.expected_scope)===canonical({project_id:m.project_id,workspace_id:m.workspace_id,policy_hash:m.policy_hash,storage_location_hash:m.location_hash})&&list(r.relation_ids,32)&&(r.allowed_source_ids===undefined||list(r.allowed_source_ids,64)),'MEMORY_DEPENDENCY_REGISTRATION_INVALID');
 if(channel!=='related')memoryCheck(r.task_ref===m.task_ref&&r.task_version===m.task_version,'MEMORY_DEPENDENCY_TASK_MISMATCH');
 else{const related=m.related;memoryCheck(related?.enabled===true&&r.expected_sharing_policy_hash===related.sharing_policy_hash&&canonical(r.target_scope)===canonical({task_ref:m.task_ref,task_version:m.task_version})&&Array.isArray(r.allowed_source_ids)&&r.allowed_source_ids.every((id:string)=>related.allowed_source_ids.includes(id)),'MEMORY_SHARED_DEPENDENCY_SCOPE');const raw=bytes(related.sharing_file.path);memoryCheck(hash(raw)===related.sharing_file.sha256,'MEMORY_SHARED_DEPENDENCY_POLICY_DRIFT');const sharing=memoryJson(raw.toString('utf8'));memoryCheck(hash(canonical(sharing))===related.sharing_policy_hash&&Array.isArray(sharing.grants),'MEMORY_SHARED_DEPENDENCY_POLICY_DRIFT');const grants=sharing.grants.filter((g:any)=>canonical(g.source_scope)===canonical({task_ref:r.task_ref,task_version:r.task_version})&&canonical(g.target_scope)===canonical(r.target_scope)&&Array.isArray(g.roles)&&g.roles.includes('developer')&&g.purpose==='TASK_RECALL'&&(g.expires_at===null||Date.parse(g.expires_at)>Date.now()));memoryCheck(grants.length>0&&r.allowed_source_ids.every((id:string)=>grants.some((g:any)=>Array.isArray(g.revisions)&&g.revisions.some((v:any)=>v.source_id===id))),'MEMORY_SHARED_DEPENDENCY_NOT_GRANTED');}
 if(v.dependency_budget!==undefined){const caps:Record<string,number>={sourceBytes:2097152,sqlQueries:1024,sqlNodes:128,edges:512,depth:16,work:4096};memoryCheck(v.dependency_budget&&typeof v.dependency_budget==='object'&&!Array.isArray(v.dependency_budget)&&Object.entries(v.dependency_budget).every(([k,n])=>Object.hasOwn(caps,k)&&Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<=caps[k]!),'MEMORY_DEPENDENCY_BUDGET_INVALID');}
 return{ref,channel,registration:r,...(v.dependency_budget===undefined?{}:{dependency_budget:v.dependency_budget})};
}
export function dependencyRegistration(raw:any){
 if(raw?.ok===false)throw new MemoryError('SDK_BUSINESS',typeof raw.error?.code==='string'&&/^[A-Z0-9_:-]{1,128}$/.test(raw.error.code)?raw.error.code:'MEMORY_DEPENDENCY_REGISTRATION_REFUSED');
 memoryCheck(raw?.ok===true&&raw.value&&raw.value.handle&&typeof raw.value.handle==='object'&&!Array.isArray(raw.value.handle)&&Number.isSafeInteger(raw.value.registered_edges)&&raw.value.registered_edges>=0&&raw.value.registered_edges<=32&&raw.value.authority==='LOCAL_SDK_EXPLICIT_ENROLLMENT'&&raw.value.actor_identity_verified===false&&raw.value.read_permission_granted===false,'MEMORY_DEPENDENCY_REGISTRATION_ENVELOPE');return raw.value;
}
function validateDependencyLifecycle(d:NonNullable<ReturnType<typeof approvedDependencies>>,value:any){
 exact(value,['channel','source','registered_edges','revoked','handle_serialized','authority']);
 memoryCheck(value.channel===d.channel&&canonical(value.source)===canonical(d.ref)&&
  value.registered_edges===d.registration.relation_ids.length&&value.revoked===true&&
  value.handle_serialized===false&&value.authority==='SDK_PROCESS_LOCAL_HANDLE_NOT_MCP_TOKEN','MEMORY_DEPENDENCY_LIFECYCLE');
 return value;
}
export function checkDependencyLifecycle(c:LocalConfig,channel:'ordinary'|'engineering'|'related',value:any){
 const approval=approvedDependencies(c,channel);
 memoryCheck(approval,'MEMORY_DEPENDENCY_REQUIRED');
 return validateDependencyLifecycle(approval,value);
}
export function checkOrdinarySdkStatus(c:LocalConfig,raw:any){
 memoryCheck(raw?.ok===true&&raw.value&&typeof raw.value==='object','MEMORY_VIEW_STATUS_ENVELOPE');const v=raw.value,m=c.memory_bridge!,selected=selectMemoryBoundary(c),p=v.policy,l=v.storage_location,rt=v.runtime;
 const selectedBuild=selected?.boundary.sdk_build_id;
 memoryCheck(selected&&(isUnifiedBuild(selectedBuild)||nativeOrdinaryAllowed(c,selectedBuild))&&v.project_root===c.project_root&&v.project_id===m.project_id&&v.configured===true&&v.automatic_hooks===false&&v.policy_hash===m.policy_hash&&hash(canonical(p))===m.policy_hash&&p?.schema_version===1&&p.mode==='SEMI_AUTO'&&p.enabled===true&&p.workspace_id===m.workspace_id&&p.default_role==='developer'&&canonical(p.allowed_roles)===canonical(['developer'])&&Number.isSafeInteger(p.payload_budget_bytes)&&p.payload_budget_bytes>=1024&&p.payload_budget_bytes<=m.limits.payload_bytes,'MEMORY_VIEW_STATUS_POLICY');
 memoryCheck(rt?.build_id===selectedBuild&&rt.contract_version==='xmem-companion/3'&&rt.profile==='sdk'&&rt.identity_observation==='ON_DISK_AT_STATUS_CALL_NOT_LOADED_MODULE_ATTESTATION'&&rt.capabilities?.ordinary_tool_count===9&&rt.capabilities.authenticated_identity===false,'MEMORY_VIEW_STATUS_BUILD');
 memoryCheck(l?.configured===true&&l.mode===selected.boundary.mode&&l.storage_root===m.storage_root&&l.location_hash===m.location_hash&&l.custom_identity_verified===(selected.boundary.mode==='CUSTOM_LOCAL'),'MEMORY_VIEW_STATUS_LOCATION');
}
/** One fixed child lifetime owns registration, real safe-view operation and
 * revocation. This is SDK delivery, never an MCP token or seventh MCP call. */
export function standaloneDependencyPeer(local:ReturnType<typeof import('./configure.ts').loadConfig>,deadline:number):XmemPeer{
 const c=local.config,m=c.memory_bridge!;memoryCheck(approvedDependencies(c,'ordinary'),'MEMORY_DEPENDENCY_REQUIRED');let calls=0,diagnostic:Record<string,unknown>={sdk_path:'SDK_WITH_COMPANION_SAFE_VIEW',mcp_calls:0,derived_state_writes:true};
 const guard=(response?:{dependency_lifecycle:unknown})=>{
  memoryCheck(Date.now()<deadline,'MEMORY_VIEW_TOTAL_DEADLINE');
  memoryCheck(hash(bytes(local.configPath))===local.configHash,'MEMORY_VIEW_LOCAL_CONFIG_DRIFT');
  // Approval also verifies the complete boundary, Node and deployment pins.
  const approval=approvedDependencies(c,'ordinary');
  memoryCheck(approval,'MEMORY_DEPENDENCY_REQUIRED');
  if(response){
   const lifecycle=validateDependencyLifecycle(approval,response.dependency_lifecycle);
   diagnostic={...diagnostic,dependency_lifecycle:lifecycle,sdk_public_calls:5};
  }
  memoryCheck(Date.now()<deadline,'MEMORY_VIEW_TOTAL_DEADLINE');
 };
 return{call:async(name,input={})=>{memoryCheck(calls===0&&['xmem_session_start','xmem_session_checkpoint'].includes(name),'MEMORY_VIEW_SINGLE_OPERATION');calls++;guard();const child=fileURLToPath(new URL('./standalone-read-child.ts',import.meta.url)),childHash=hash(bytes(child)),started=Date.now();const out=spawnSync(m.node.path,['--experimental-strip-types',child],{cwd:c.project_root,windowsHide:true,shell:false,timeout:Math.max(1,deadline-Date.now()),maxBuffer:m.limits.response_bytes,env:getDefaultEnvironment(),input:Buffer.from(JSON.stringify({config_path:local.configPath,config_sha256:local.configHash,input,deadline_unix_ms:deadline,action:name==='xmem_session_start'?'recall':'checkpoint'})),encoding:'buffer'});
  diagnostic={...diagnostic,pid:out.pid??null,exit_code:out.status,signal:out.signal,error_code:(out.error as NodeJS.ErrnoException | undefined)?.code??null,elapsed_ms:Date.now()-started,stdout_bytes:out.stdout?.length??0,stdout_sha256:hash(out.stdout??Buffer.alloc(0)),stderr_bytes:out.stderr?.length??0,stderr_sha256:hash(out.stderr??Buffer.alloc(0)),sdk_build:selectMemoryBoundary(c)?.boundary.sdk_build_id,child_sha256:childHash,global_descendant_closure:'NOT_CLAIMED'};
  memoryCheck(!out.error&&!out.signal&&out.status===0&&out.stdout.length+out.stderr.length<=m.limits.response_bytes&&out.stderr.length<=m.limits.stderr_bytes&&hash(bytes(child))===childHash,'MEMORY_VIEW_CHILD_UNKNOWN');const value=memoryJson(out.stdout.toString('utf8'));exact(value,['format','before','result','after','dependency_lifecycle','sdk_path','derived_state_writes']);memoryCheck(value.format==='xdev-standalone-view-child-1'&&value.sdk_path==='SDK_WITH_COMPANION_SAFE_VIEW'&&value.derived_state_writes===true,'MEMORY_VIEW_CHILD_ENVELOPE');checkOrdinarySdkStatus(c,value.before);checkOrdinarySdkStatus(c,value.after);guard(value);return value.result;},guard:async()=>{memoryCheck(calls===1,'MEMORY_VIEW_OPERATION_NOT_OBSERVED');guard();},close:async()=>{},diagnostic:()=>diagnostic};
}
export type XmemPeer={call:(name:string,input?:Record<string,unknown>)=>Promise<any>;guard:()=>Promise<void>;close:()=>Promise<void>;diagnostic:()=>Record<string,unknown>};
// Deployed storage-location.js hashes this fixed insertion order, not canonical JSON.
export const companionLocationHash=(project_id:string,storage_root:string,mode:'PROJECT_LOCAL'|'CUSTOM_LOCAL'='CUSTOM_LOCAL')=>hash(JSON.stringify({schema_version:1,project_id,mode,storage_root}));
export function memoryBoundaryOperation(c:LocalConfig,started=Date.now(),callerDeadline?:number,ordinaryConfig?:FileRef){
 const m=c.memory_bridge!,total=Math.min(started+m.limits.total_ms,callerDeadline??Infinity);
 const native=m.related?.enabled===true&&m.related.build_id===E7_NATIVE_BUILD?selectMemoryBoundaryWithDeployment(c):null;
 const selected=native?{ref:native.ref,boundary:native.boundary,request:native.request}:selectMemoryBoundary(c);
 const nativeOrdinary=nativeOrdinaryAllowed(c,selected?.boundary.sdk_build_id);
 if(nativeOrdinary)memoryCheck(ordinaryConfig,'MEMORY_NATIVE_ORDINARY_CONFIG_REQUIRED');
 const callEnd=callerDeadline===undefined?undefined:Math.min(total,callerDeadline);
 if(selected){const pinSource=native?.boundary.sdk_build_id===E7_NATIVE_BUILD?{kind:'native' as const,inventory:native.deployment}:undefined;verifyMemoryPinsAtBoundary(c,nativeOrdinary?{kind:'ordinary'}:pinSource);const refs=[];for(const r of c.approved_requests??[]){const request=createInputReader(c).source(r);inspectSupervisedInput({projectRoot:c.project_root,projectId:c.project_id,controlRoot:c.control_root,boundaryHealth:()=>null},'request',r.path);if(canonical(request)===canonical(selected.request))refs.push(r);}memoryCheck(refs.length===1,'MEMORY_BOUNDARY_UNIQUE_REQUEST_REQUIRED');}
 const deadline=(call=m.limits.call_ms)=>{const end=Math.min(total,callEnd??Date.now()+call);memoryCheck(end>Date.now(),'MEMORY_TOTAL_DEADLINE');return end;};
 const check=()=>memoryCheck(Date.now()<total,'MEMORY_TOTAL_DEADLINE');
 const health=()=>{check();if(selected){const value=boundaryHealth(selected.ref,deadline(),m.node.path,Math.min(16384,m.limits.payload_bytes),nativeOrdinary?ordinaryConfig:undefined);check();return value;}return null;};
 return{selected,total,deadline,check,health,options:(end:number,payload=m.limits.payload_bytes)=>selected?boundaryOptions(selected.boundary,end,Math.min(16384,payload)):undefined,manifest:()=>selected?boundaryManifest(c.project_root,selected.ref,c.project_id):null};
}
export function readStandaloneChild(local:ReturnType<typeof import('./configure.ts').loadConfig>,input:Record<string,unknown>,deadline:number,source?:FileRef){
 const m=local.config.memory_bridge!,child=fileURLToPath(new URL('./standalone-read-child.ts',import.meta.url));bytes(child);const started=Date.now(),out=spawnSync(m.node.path,['--experimental-strip-types',child],{cwd:local.config.project_root,windowsHide:true,shell:false,timeout:Math.max(1,deadline-Date.now()),maxBuffer:m.limits.response_bytes,env:getDefaultEnvironment(),input:Buffer.from(JSON.stringify({config_path:local.configPath,config_sha256:local.configHash,input,deadline_unix_ms:deadline,...(source===undefined?{}:{source})}),'utf8'),encoding:'buffer'});
 // Diagnostic-only local transport facts. No new SDK call, observer input or
 // business field; absent child stages remain absent and closure is not inferred.
 const stdout=out.stdout??Buffer.alloc(0),stderr=out.stderr??Buffer.alloc(0);
 const transport={format:'xdev-fixed-read-transport-1',started_unix_ms:started,elapsed_ms:Date.now()-started,pid:out.pid??null,exit_code:out.status??null,signal:out.signal??null,error_code:(out.error as NodeJS.ErrnoException|undefined)?.code??null,stdout_bytes:stdout.length,stdout_sha256:hash(stdout),stderr_bytes:stderr.length,stderr_sha256:hash(stderr),global_descendant_closure:'NOT_CLAIMED'};
 if(out.error||out.signal||out.status!==0||out.stderr.length>m.limits.stderr_bytes||Date.now()>=deadline)throw new MemoryError('CONTRACT','MEMORY_READ_CHILD_UNKNOWN',{fixed_read_transport:transport});
 try{const value=memoryJson(stdout.toString('utf8'));exact(value,['format','result']);memoryCheck(value.format==='xdev-standalone-read-child-j01-1','MEMORY_READ_CHILD_ENVELOPE');const raw=value.result;if(raw?.ok===false){exact(raw,['ok','error']);exact(raw.error,['code','message']);memoryCheck(typeof raw.error.code==='string'&&/^[A-Z0-9_:-]{1,128}$/.test(raw.error.code)&&typeof raw.error.message==='string','MEMORY_READ_SDK_ERROR');throw new MemoryError('SDK_BUSINESS',raw.error.code);}exact(raw,['ok','value']);memoryCheck(raw.ok===true&&raw.value&&typeof raw.value==='object','MEMORY_READ_SDK_ENVELOPE');Object.defineProperty(raw.value,Symbol.for('xdev.fixed-read.transport'),{value:{...transport,stdout_utf8:stdout.toString('utf8'),stderr_utf8:stderr.toString('utf8')},enumerable:false});return raw.value;}
 catch(error){if(error instanceof MemoryError){error.diagnostic={...error.diagnostic,fixed_read_transport:transport};throw error;}throw new MemoryError('CONTRACT','MEMORY_READ_CHILD_ENVELOPE',{fixed_read_transport:transport,validation_error_sha256:hash(error instanceof Error?error.message:String(error))});}
}
export function verifyMemoryPins(c:LocalConfig):{m:MemoryBridgeConfig;tools:string;build:string} {
  return verifyMemoryPinsAtBoundary(c);
}
/** Reuse only the inventory checked during this synchronous selection. */
export function verifyBoundEngineeringPins(c:LocalConfig){
  const selected=selectMemoryBoundaryWithDeployment(c);
  verifyMemoryPinsAtBoundary(c,selected?{kind:'engineering',inventory:selected.deployment}:undefined);
  return selected;
}
/** A closed inventory is supplied only by a fresh selection within the same
 * synchronous guard. The native E7 launch has its own executable pin. */
type PinSource={kind:'ordinary'}|{kind:'native'|'engineering';inventory:NonNullable<ReturnType<typeof selectMemoryBoundaryWithDeployment>>['deployment']};
function verifyMemoryPinsAtBoundary(c:LocalConfig,source?:PinSource):{m:MemoryBridgeConfig;tools:string;build:string} {
  const m=c.memory_bridge;memoryCheck(m,'MEMORY_NOT_CONFIGURED');
  if(source?.kind==='native'){noLinks(m.node.path);memoryCheck(m.node.sha256===E7_NODE_SHA256,'MEMORY_NODE_DRIFT');}
  else memoryCheck(hash(bytes(m.node.path,128*1024*1024))===m.node.sha256,'MEMORY_NODE_DRIFT');
  memoryCheck(hash(bytes(m.server.path))===m.server.sha256,'MEMORY_SERVER_DRIFT');
  const pinned=(r:{path:string;sha256:string})=>{memoryCheck(within(c.input_root,r.path),'MEMORY_PIN_OUTSIDE_INPUT_ROOT');const b=bytes(r.path);memoryCheck(hash(b)===r.sha256,'MEMORY_PIN_DRIFT');return memoryJson(new TextDecoder('utf-8',{fatal:true}).decode(b));};
  memoryCheck(within(c.input_root,m.deployment.path),'MEMORY_PIN_OUTSIDE_INPUT_ROOT');
  const ordinary=source?.kind==='ordinary'?selectMemoryBoundaryWithDeployment(c):null;
  if(source?.kind==='ordinary'){
    const selectedBuild=ordinary?.boundary.sdk_build_id;
    memoryCheck(ordinary&&(isUnifiedBuild(selectedBuild)||nativeOrdinaryAllowed(c,selectedBuild)),'MEMORY_DEPENDENCY_BUILD_OR_PHYSICAL_UNSUPPORTED');
    memoryCheck(canonical(pinned(m.deployment))===canonical(ordinary.deployment),'MEMORY_DEPLOYMENT_DRIFT');
  }
  const closedInventory=source&&'inventory' in source?source.inventory:ordinary?.deployment;
  const inventory=closedInventory??pinned(m.deployment);memoryCheck(inventory.format==='XMEM_DEPLOYED_FILE_INVENTORY_NOT_LOADED_PROCESS_IDENTITY'&&Array.isArray(inventory.files)&&inventory.files.length>0&&inventory.files.length<=128&&inventory.count===inventory.files.length,'MEMORY_DEPLOYMENT_MANIFEST_INVALID');
  noLinks(inventory.runtime_root);memoryCheck(within(inventory.runtime_root,m.server.path)&&m.server.path===join(inventory.runtime_root,'dist','src','companion.js'),'MEMORY_COMPANION_ENTRY_REQUIRED');
  // This declaration digest selects only which original complete-read branch is used.
  // No deployment is qualified until all original declaration and payload guards pass.
  const members=new Map<string,string>(inventory.files.map((f:any)=>[f?.path,f?.sha256])),names=inventory.files.filter((f:any)=>typeof f?.path==='string'&&/^dist\/src\/[^/]+\.js$/.test(f.path)).map((f:any)=>f.path.slice(9)).sort();
  const build=hash(JSON.stringify({files:names.map((name:string)=>({name,sha256:members.get('dist/src/'+name)})),package_sha256:members.get('package.json'),lock_sha256:members.get('npm-shrinkwrap.json')}));
  const seen=new Set<string>(),expected=new Map<string,{bytes:number;sha256:string}>();let covered=false;
  for(const f of inventory.files){exact(f,['path','bytes','sha256']);memoryCheck(typeof f.path==='string'&&!f.path.includes('\\')&&f.path.split('/').every((s:string)=>s!==''&&s!=='.'&&s!=='..')&&/^[a-f0-9]{64}$/.test(f.sha256)&&Number.isSafeInteger(f.bytes)&&f.bytes>=0&&f.bytes<=2*1024*1024&&!seen.has(f.path),'MEMORY_DEPLOYMENT_MEMBER_INVALID');seen.add(f.path);const p=resolve(inventory.runtime_root,f.path);memoryCheck(within(inventory.runtime_root,p),'MEMORY_DEPLOYMENT_ESCAPE');if(!isUnifiedBuild(build)&&!closedInventory){const b=bytes(p);memoryCheck(b.length===f.bytes&&hash(b)===f.sha256,'MEMORY_DEPLOYMENT_DRIFT');}expected.set(f.path,{bytes:f.bytes,sha256:f.sha256});if(p===m.server.path){memoryCheck(f.sha256===m.server.sha256,'MEMORY_SERVER_PIN_MISMATCH');covered=true;}}
  memoryCheck(covered,'MEMORY_SERVER_NOT_IN_DEPLOYMENT');
  memoryCheck(RELATED_BUILDS.includes(build),'MEMORY_BUILD_UNSUPPORTED');
  if(isUnifiedBuild(build)&&!closedInventory){const counts=SDK_MEMBERS[build as keyof typeof SDK_MEMBERS];memoryCheck(names.length===counts.js&&inventory.files.length===counts.runtime&&canonical([...members.keys()].sort())===canonical([...names.map((n:string)=>'dist/src/'+n),'package.json','npm-shrinkwrap.json'].sort()),'MEMORY_UNIFIED_DEPLOYMENT_SET');const actual:string[]=[];const walk=(dir:string)=>{noLinks(dir);for(const name of readdirSync(dir)){const p=join(dir,name),st=lstatSync(p);if(p===join(inventory.runtime_root,'node_modules')){noLinks(p);memoryCheck(lstatSync(p).isDirectory(),'MEMORY_DEPENDENCY_ROOT');continue;}if(st.isDirectory()){memoryCheck([join(inventory.runtime_root,'dist'),join(inventory.runtime_root,'dist/src')].includes(p),'MEMORY_UNIFIED_DEPLOYMENT_SET');walk(p);}else{const b=bytes(p),rel=p.slice(inventory.runtime_root.length+1).replaceAll('\\','/'),pin=expected.get(rel);memoryCheck(pin&&b.length===pin.bytes&&hash(b)===pin.sha256,'MEMORY_DEPLOYMENT_DRIFT');actual.push(rel);memoryCheck(actual.length<=counts.runtime,'MEMORY_UNIFIED_DEPLOYMENT_SET');}}};walk(inventory.runtime_root);memoryCheck(canonical(actual.sort())===canonical([...members.keys()].sort()),'MEMORY_UNIFIED_DEPLOYMENT_SET');}
  return{m,tools:pinTools(pinned(m.tool_pins).tools,build),build};
}
/** The configured pins are supervised disk observations, not native identity authentication. */
export async function connectXmem(c:LocalConfig,totalDeadline?:number):Promise<XmemPeer> {
  const started=Date.now(),selected=selectMemoryBoundary(c),mode=selected?.boundary.mode??'CUSTOM_LOCAL';
  const nativeOrdinary=nativeOrdinaryAllowed(c,selected?.boundary.sdk_build_id);
  const verify=()=>verifyMemoryPinsAtBoundary(c,nativeOrdinary?{kind:'ordinary'}:undefined);
  const {m,tools,build}=verify();let calls=0,stderrBytes=0,overflow=false;const stderrHash=createHash('sha256');
  memoryCheck(build!==E7_NATIVE_BUILD||nativeOrdinary,'MEMORY_E7_BUILD_RELATED_ONLY');
  const remaining=()=>{const n=Math.min(started+m.limits.total_ms,totalDeadline??Infinity)-Date.now();memoryCheck(n>0,'MEMORY_TOTAL_DEADLINE');return Math.min(n,m.limits.call_ms);};
  let actual:string;try{actual=nativeOrdinary&&m.node.path===process.execPath?process.version:execFileSync(m.node.path,['--version'],{timeout:remaining(),maxBuffer:64,encoding:'utf8',windowsHide:true,env:getDefaultEnvironment()}).trim();}catch{throw new MemoryError('TRANSPORT','MEMORY_NODE_VERSION_UNAVAILABLE');}
  memoryCheck(actual==='v24.20.0','MEMORY_EXACT_NODE_24_20_REQUIRED');
  const transport=new StdioClientTransport({command:m.node.path,args:[m.server.path],cwd:c.project_root,stderr:'pipe',maxBufferSize:m.limits.response_bytes});
  const client=new Client({name:'xdev-same-task-memory-bridge',version:'1.0.0'});const abort=new AbortController();let protocolFailure:MemoryError|undefined;
  client.onerror=(e)=>{if(!protocolFailure){const malformed=e instanceof SyntaxError||e.name==='ZodError',bound=e.message.startsWith('ReadBuffer exceeded maximum size');protocolFailure=new MemoryError(malformed?'JSON_RPC':'TRANSPORT',bound?'MEMORY_STDOUT_BOUND':malformed?'MEMORY_JSON_RPC_PARSE_ERROR':'MEMORY_TRANSPORT_ERROR',{error_sha256:hash(e.message)});}abort.abort();};
  transport.stderr?.on('data',(b:Buffer)=>{stderrBytes+=b.length;stderrHash.update(b);if(stderrBytes>m.limits.stderr_bytes){overflow=true;abort.abort();void client.close().catch(()=>{});}});
  const options=()=>{const ms=remaining();return{timeout:ms,maxTotalTimeout:ms,resetTimeoutOnProgress:false,signal:abort.signal};};
  const diagnostic=()=>({node:m.node.path,node_sha256:m.node.sha256,node_version:actual,server:m.server.path,server_sha256:m.server.sha256,sdk_build:build,build_observation:'ON_DISK_PINNED_NOT_LOADED_MODULE_ATTESTATION',pid:transport.pid,calls,stderr_bytes:stderrBytes,stderr_sha256:stderrHash.copy().digest('hex'),native_authenticated:false,global_descendant_closure:'NOT_CLAIMED'});
  const translate=(e:unknown):MemoryError=>{
    if(e instanceof MemoryError)return e;if(overflow)return new MemoryError('TRANSPORT','MEMORY_STDERR_BOUND');if(protocolFailure)return protocolFailure;
    const code=(e as any)?.code,timeout=code===-32001,closed=code===-32000;
    return new MemoryError(typeof code==='number'&&!timeout&&!closed?'JSON_RPC':'TRANSPORT',timeout?'MEMORY_TRANSPORT_TIMEOUT':closed?'MEMORY_CONNECTION_CLOSED':typeof code==='number'?'MEMORY_JSON_RPC_ERROR':'MEMORY_TRANSPORT_ERROR',{remote_code:typeof code==='number'?code:null,error_sha256:hash(e instanceof Error?e.message:String(e))});
  };
  const call=async(name:string,input:Record<string,unknown>={})=>{
    ordinaryMcpCallGuard(name,calls);calls++;verify();
    let raw:any;try{raw=await client.callTool({name,arguments:{project_root:c.project_root,...(['xmem_standalone_status','xmem_storage_location_status'].includes(name)?{}:{input})}},undefined,options());}catch(e){throw translate(e);}
    memoryCheck(!overflow,'MEMORY_STDERR_BOUND');verify();return decodeXmem(raw,m.limits.response_bytes);
  };
  const guard=async()=>{
    const status=await call('xmem_standalone_status');
    if(isUnifiedBuild(build)||nativeOrdinary)memoryCheck(status.runtime?.build_id===build&&status.runtime.contract_version==='xmem-companion/3'&&status.runtime.profile==='companion'&&status.runtime.capabilities?.ordinary_tool_count===9&&status.runtime.capabilities.authenticated_identity===false,'MEMORY_UNIFIED_STATUS_BUILD');
    memoryCheck(status.project_root===c.project_root&&status.project_id===m.project_id&&status.configured===true&&status.policy_hash===m.policy_hash&&status.automatic_hooks===false,'MEMORY_PROJECT_POLICY_MISMATCH');
    const p=status.policy;memoryCheck(p?.schema_version===1&&p.mode==='SEMI_AUTO'&&p.enabled===true&&p.workspace_id===m.workspace_id&&p.default_role==='developer'&&Array.isArray(p.allowed_roles)&&canonical(p.allowed_roles)===canonical(['developer'])&&hash(canonical(p))===m.policy_hash,'MEMORY_POLICY_SCOPE_MISMATCH');
    memoryCheck(Number.isSafeInteger(p.payload_budget_bytes)&&p.payload_budget_bytes>=1024&&p.payload_budget_bytes<=m.limits.payload_bytes,'MEMORY_POLICY_BUDGET_UNSUPPORTED');
    // The pinned native Companion's standalone status derives these same
    // fields from readStorageLocationAtProjectRoot. Keep the pre/post guard
    // observations, while avoiding a duplicate RPC within each observation.
    const location=nativeOrdinary?status.storage_location:await call('xmem_storage_location_status');
    memoryCheck(location.configured===true&&location.mode===mode&&location.storage_root===m.storage_root&&location.location_hash===m.location_hash&&location.custom_identity_verified===(mode==='CUSTOM_LOCAL')&&status.storage_location?.location_hash===m.location_hash&&status.storage_location?.storage_root===m.storage_root,'MEMORY_STORAGE_LOCATION_MISMATCH');
    memoryCheck(companionLocationHash(m.project_id,m.storage_root,mode)===m.location_hash,'MEMORY_LOCATION_HASH_MISMATCH');
  };
  try{
    await client.connect(transport,options());memoryCheck(client.getServerVersion()?.name==='xmem-companion'&&client.getServerVersion()?.version==='0.0.1','MEMORY_SERVER_VERSION_MISMATCH');
    const list=await client.listTools({},options());memoryCheck(!list.nextCursor&&Buffer.byteLength(JSON.stringify(list))<=m.limits.response_bytes&&pinTools(list.tools,build)===tools,'MEMORY_TOOL_SCHEMA_DRIFT');
    await guard();
    return{call,guard,diagnostic,close:async()=>{await client.close();}};
  }catch(e){await client.close().catch(()=>{});throw translate(e);}
}
