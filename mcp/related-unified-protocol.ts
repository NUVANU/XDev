/** Fixed SDK83 plain-related protocol. No Host/Core, SDK imports or writes. */
import { readdirSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { canonical } from '../src/job-runtime/storage-identity.ts';
import { parseD1UniqueJson } from '../src/job-runtime/contracts.ts';
import { selectMemoryBoundary, selectMemoryBoundaryWithDeployment, boundaryOptions } from '../src/host-surface/project-memory-boundary.ts';
import { bytes, exact, hash, loadConfigWithDeployment, noLinks, refShape, within } from './configure.ts';
import type { FileRef, LocalConfig, RelatedConfig } from './configure.ts';
import { RELATED_BUILDS, isUnifiedBuild, E7_NATIVE_BUILD, E7_NODE_SHA256, nativeJointQuery, sdkCompanionContract, sdkOrdinaryToolCount } from './sdk-builds.ts';
// Private wire implementation: the external envelope retains the old layers/codes.
export class RelatedProtocolError extends Error {
 layer:string;code:string;diagnostic:Record<string,unknown>;
 constructor(layer:string,code:string,diagnostic:Record<string,unknown>={}){super(code);this.layer=layer;this.code=code;this.diagnostic=diagnostic;}
}
const MemoryError=RelatedProtocolError;
export function memoryCheck(value:unknown,code:string):asserts value {if(!value)throw new MemoryError('CONTRACT',code);}
const check:typeof memoryCheck=memoryCheck;
export function memoryJson(text:string):any {try{return parseD1UniqueJson(text);}catch{throw new MemoryError('MALFORMED_RESPONSE','MEMORY_INVALID_JSON',{raw_sha256:hash(text)});}}
/** Eligibility only selects between two fixed private children; it grants no access. */
export function isUnifiedPlainRelated(c:LocalConfig){const m=c.memory_bridge,r=m?.related;return m!==undefined&&r?.enabled===true&&(isUnifiedBuild(r.build_id)||r.build_id===E7_NATIVE_BUILD)&&m.current_facts===undefined&&m.dependencies?.related===undefined;}
type Enabled=Extract<RelatedConfig,{enabled:true}>;
type Local=ReturnType<typeof import('./configure.ts').loadConfig>;
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const hex=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&Buffer.byteLength(v)<=512&&!/[\x00-\x1f]/.test(v);
const list=(v:unknown,max:number):v is string[]=>Array.isArray(v)&&v.length<=max&&v.every(text)&&new Set(v).size===v.length;
function enabled(c:LocalConfig):Enabled {const r=c.memory_bridge?.related;check(r?.enabled===true,'RELATED_NOT_ENABLED');return r;}
function pinned(ref:FileRef,limit=2*1024*1024){refShape(ref);const b=bytes(ref.path,limit);check(hash(b)===ref.sha256,'RELATED_PIN_DRIFT');return b;}
const json=(b:Buffer)=>memoryJson(new TextDecoder('utf-8',{fatal:true}).decode(b));
export function relatedScope(c:LocalConfig){const m=c.memory_bridge!;return{xdev_project_id:c.project_id,project_root:c.project_root,project_id:m.project_id,workspace_id:m.workspace_id,task_ref:m.task_ref,task_version:m.task_version,role:m.role};}

/** Local reads only. The public SDK, not this adapter, owns record ACL/retrieval. */
type SelectedBoundary=ReturnType<typeof selectMemoryBoundaryWithDeployment>;
/** Only called synchronously with a freshly selected boundary. Never exported. */
function guardAtBoundary(local:Local,selected:SelectedBoundary){
 const c=local.config,m=c.memory_bridge!,r=enabled(c),mode=selected?.boundary.mode??'CUSTOM_LOCAL';check(hash(bytes(local.configPath))===local.configHash,'RELATED_LOCAL_CONFIG_DRIFT');
 check(isUnifiedPlainRelated(c),'RELATED_UNIFIED_BRANCH_REQUIRED');
 if(r.build_id===E7_NATIVE_BUILD){
  check(selected?.boundary.sdk_build_id===E7_NATIVE_BUILD&&process.platform==='win32'&&process.arch==='x64','RELATED_E7_BOUNDARY_REQUIRED');
  const joint=nativeJointQuery(c);
  if(selected.boundary.mode==='CUSTOM_LOCAL')check(joint,'RELATED_E7_CUSTOM_JOINT_REQUIRED');
  check(m.engineering?.enabled===true?joint:!m.required_context&&m.dependencies===undefined&&Object.values(m.permissions).every(v=>v===false),'RELATED_E7_CONFIG_RELATED_ONLY');
 }
 // selectMemoryBoundary already validates the complete closed deployment.
 // Do not walk it a second time in this SAME synchronous phase. The related
 // inventory, build, exports and SDK pins below still run in full.
 if(selected)check(r.build_id===selected.boundary.sdk_build_id&&same(r.deployment,selected.boundary.deployment),'RELATED_BOUNDARY_DEPLOYMENT_MISMATCH');
 check(RELATED_BUILDS.includes(r.build_id),'RELATED_BUILD_UNSUPPORTED');
 // The native branch hashes Node immediately before each spawn and once
 // at related-child entry. SDK status/validation phases do not spawn Node.
 if(r.build_id===E7_NATIVE_BUILD){refShape(m.node);noLinks(m.node.path);check(m.node.sha256===E7_NODE_SHA256,'RELATED_NODE_DRIFT');}
 else check(hash(bytes(m.node.path,128*1024*1024))===m.node.sha256,'RELATED_NODE_DRIFT');
 check(within(c.input_root,r.deployment.path),'RELATED_DEPLOYMENT_OUTSIDE_INPUT');
 // The E7 native branch uses the exact closed inventory freshly checked by
 // selectMemoryBoundaryWithDeployment in this phase. No reuse across phases.
 const verified=r.build_id===E7_NATIVE_BUILD?selected!.deployment:null;
 const inv=verified??json(pinned(r.deployment)),root=inv.runtime_root;check(inv.format==='XMEM_DEPLOYED_FILE_INVENTORY_NOT_LOADED_PROCESS_IDENTITY'&&typeof root==='string'&&isAbsolute(root)&&Array.isArray(inv.files)&&inv.files.length>0&&inv.files.length<=128&&inv.count===inv.files.length,'RELATED_DEPLOYMENT_INVALID');
 check(r.sdk.path===join(root,'dist','src','shared-memory.js')&&r.standalone_sdk.path===join(root,'dist','src','standalone.js'),'RELATED_PUBLIC_SDK_REQUIRED');
 const members=new Map<string,string>();
 for(const f of inv.files){exact(f,['path','bytes','sha256']);check(text(f.path)&&!f.path.includes('\\')&&!f.path.includes(':')&&f.path.split('/').every((p:string)=>p!=='.'&&p!=='..'&&p!=='')&&hex(f.sha256)&&Number.isSafeInteger(f.bytes)&&f.bytes>=0&&f.bytes<=2*1024*1024&&!members.has(f.path),'RELATED_DEPLOYMENT_MEMBER_INVALID');const p=resolve(root,f.path);check(within(root,p),'RELATED_DEPLOYMENT_ESCAPE');if(!verified){const b=bytes(p);check(b.length===f.bytes&&hash(b)===f.sha256,'RELATED_DEPLOYMENT_DRIFT');}members.set(f.path,f.sha256);}
 const names=readdirSync(join(root,'dist','src')).filter(n=>n.endsWith('.js')).sort();
 check(same(names,Array.from(members.keys()).filter(n=>/^dist\/src\/[^/]+\.js$/.test(n)).map(n=>n.slice(9)).sort()),'RELATED_BUILD_MEMBER_DRIFT');
 const build=hash(JSON.stringify({files:names.map(name=>({name,sha256:members.get('dist/src/'+name)})),package_sha256:members.get('package.json'),lock_sha256:members.get('npm-shrinkwrap.json')}));
 check(build===r.build_id,'RELATED_BUILD_DRIFT');
 const pkg=json(bytes(join(root,'package.json')));check(pkg.name==='xmem'&&pkg.exports?.['./shared-memory']==='./dist/src/shared-memory.js'&&pkg.exports?.['./standalone']==='./dist/src/standalone.js','RELATED_EXPORT_DRIFT');
 check(hash(pinned(r.sdk))===members.get('dist/src/shared-memory.js')&&hash(pinned(r.standalone_sdk))===members.get('dist/src/standalone.js'),'RELATED_SDK_PIN_MISMATCH');
 check(r.sharing_file.path===join(c.project_root,'.xmem','sharing-v1.json'),'RELATED_SHARING_PATH');
 const sharing=json(pinned(r.sharing_file));check(hash(canonical(sharing))===r.sharing_policy_hash&&sharing.schema_version===1&&sharing.project_id===m.project_id&&sharing.workspace_id===m.workspace_id&&Array.isArray(sharing.grants)&&sharing.grants.length<=32,'RELATED_SHARING_POLICY_DRIFT');
 const policy=json(bytes(join(c.project_root,'.xmem','standalone-v1.json')));check(hash(canonical(policy))===m.policy_hash&&policy.enabled===true&&policy.workspace_id===m.workspace_id&&same(policy.allowed_roles,['developer'])&&policy.default_role==='developer'&&r.limits.payload_bytes<=policy.payload_budget_bytes,'RELATED_STANDALONE_POLICY_DRIFT');
 check(m.role==='developer'&&hash(JSON.stringify({schema_version:1,project_id:m.project_id,mode,storage_root:m.storage_root}))===m.location_hash,'RELATED_LOCATION_BINDING');
 return{r,sharing,policy};
}
export function guardRelated(local:Local){
 enabled(local.config);
 return guardAtBoundary(local,selectMemoryBoundaryWithDeployment(local.config));
}
function prepareAtGuard(local:Local,source:FileRef,guard:ReturnType<typeof guardAtBoundary>){
 const c=local.config,{r,sharing}=guard;refShape(source);check(within(c.input_root,source.path)&&r.approved_queries.some(v=>same(v,source)),'RELATED_QUERY_NOT_APPROVED');
 check(Buffer.byteLength(JSON.stringify({config_path:local.configPath,config_sha256:local.configHash,source}))<=16384,'RELATED_CHILD_INPUT_BOUND');
 const v=json(pinned(source,16384));exact(v,['format','query','tags','allowed_source_ids','limit','payload_budget_bytes']);
 check(v.format==='xdev-related-memory-request-1'&&typeof v.query==='string'&&v.query.length<=256&&!v.query.includes('\0')&&list(v.tags,8)&&list(v.allowed_source_ids,64)&&v.allowed_source_ids.every((x:string)=>r.allowed_source_ids.includes(x))&&v.tags.every((x:string)=>r.tags.includes(x)),'RELATED_QUERY_INVALID');
 check(Number.isSafeInteger(v.limit)&&v.limit>=1&&v.limit<=r.limits.result_limit&&Number.isSafeInteger(v.payload_budget_bytes)&&v.payload_budget_bytes>=0&&v.payload_budget_bytes<=r.limits.payload_bytes,'RELATED_QUERY_LIMIT');
 const m=c.memory_bridge!;return{r,sharing,query:{project_id:m.project_id,workspace_id:m.workspace_id,target_scope:{task_ref:m.task_ref,task_version:m.task_version},role:'developer',purpose:'TASK_RECALL',allowed_source_ids:v.allowed_source_ids,query:v.query,tags:v.tags,limit:v.limit,payload_budget_bytes:v.payload_budget_bytes},dependency:null};
}

export function prepareRelated(local:Local,source:FileRef){
 return prepareAtGuard(local,source,guardRelated(local));
}
/** Fresh execution-phase preparation. No cached authorization, selected boundary
 * parameter, caller-supplied verdict, SDK call, or reusable authority handle. */
export function prepareRelatedOperation(local:Local,source:FileRef,deadline?:number){
 enabled(local.config);
 const selected=selectMemoryBoundaryWithDeployment(local.config);
 const prepared=prepareAtGuard(local,source,guardAtBoundary(local,selected));
 const options=selected?boundaryOptions(selected.boundary,deadline!,prepared.r.limits.payload_bytes):undefined;
 check(selected!==null||deadline===undefined,'RELATED_UNEXPECTED_DEADLINE');
 return{prepared,options,boundary:selected?.boundary};
}
/** Only the dedicated related wire may invoke the E7 doctor. */
export function prepareNativeRelatedHealth(local:Local,source:FileRef,deadline:number){
 const selected=selectMemoryBoundaryWithDeployment(local.config);
 const prepared=prepareAtGuard(local,source,guardAtBoundary(local,selected));
 return nativeHealthOptions(local,prepared,selected,deadline);
}
function nativeHealthOptions(local:Local,prepared:ReturnType<typeof prepareAtGuard>,selected:SelectedBoundary,deadline:number){
 check(prepared.r.build_id===E7_NATIVE_BUILD&&selected,'RELATED_E7_BOUNDARY_REQUIRED');
 const {boundary}=selected;
 return{boundary,options:boundaryOptions(boundary,deadline,Math.min(16384,local.config.memory_bridge!.limits.payload_bytes)),
  indexPath:join(dirname(prepared.r.sdk.path),'index.js')};
}
/** Load, check the config pin and verify the approved query in one synchronous
 * phase. Only fixed import paths and validated options leave this phase. */
export function prepareRelatedChildStart(config:FileRef,source:FileRef,health:boolean,deadline?:number){
 const {local,selected}=loadConfigWithDeployment(config.path);
 check(local.configHash===config.sha256,'RELATED_LOCAL_CONFIG_DRIFT');
 const prepared=prepareAtGuard(local,source,guardAtBoundary(local,selected));
 return {local,prepared,doctor:health?nativeHealthOptions(local,prepared,selected,deadline!):null};
}
function statusAtBoundary(c:LocalConfig,raw:any,select:()=>ReturnType<typeof selectMemoryBoundary>){
 if(raw?.ok===false)throw new MemoryError('SDK_BUSINESS',safeCode(raw.error?.code));
 check(raw?.ok===true&&raw.value&&typeof raw.value==='object','RELATED_STATUS_ENVELOPE');const v=raw.value,m=c.memory_bridge!,p=v.policy,rt=v.runtime,l=v.storage_location,mode=select()?.boundary.mode??'CUSTOM_LOCAL';
 check(v.project_root===c.project_root&&v.project_id===m.project_id&&v.configured===true&&v.automatic_hooks===false&&v.policy_hash===m.policy_hash&&hash(canonical(p))===m.policy_hash&&p?.enabled===true&&p.workspace_id===m.workspace_id&&p.default_role==='developer'&&same(p.allowed_roles,['developer']),'RELATED_STATUS_POLICY');
 check(rt?.build_id===enabled(c).build_id&&RELATED_BUILDS.includes(rt.build_id)&&rt.contract_version===sdkCompanionContract(rt.build_id)&&rt.profile==='sdk'&&rt.identity_observation==='ON_DISK_AT_STATUS_CALL_NOT_LOADED_MODULE_ATTESTATION'&&rt.capabilities?.ordinary_tool_count===sdkOrdinaryToolCount(rt.build_id)&&rt.capabilities.authenticated_identity===false,'RELATED_STATUS_BUILD');
 check(l?.configured===true&&l.mode===mode&&l.storage_root===m.storage_root&&l.location_hash===m.location_hash&&l.custom_identity_verified===(mode==='CUSTOM_LOCAL'),'RELATED_STATUS_LOCATION');
}
const safeCode=(v:unknown)=>typeof v==='string'&&/^[A-Z0-9_:-]{1,128}$/.test(v)?v:'RELATED_SDK_BUSINESS_ERROR';

/** Compatibility entry point: always starts a new validation phase. */
export function checkRelatedStatus(c:LocalConfig,raw:any){
 statusAtBoundary(c,raw,()=>selectMemoryBoundary(c));
}
/** One status + guard phase. Selection is local to this synchronous call and is
 * discarded on return. Invoked afresh after each SDK status; never across the
 * query or an external callback. All status/guard predicates still run. */
export function checkRelatedPhase(local:Local,raw:any){
 let selected:SelectedBoundary=null;
 statusAtBoundary(local.config,raw,()=>selected=selectMemoryBoundaryWithDeployment(local.config));
 return guardAtBoundary(local,selected);
}

/** Verify the two returned status frames against one fresh post-child phase.
 * The boundary, complete deployment and manifest are read in this call.
 * No selected state or verification handle is returned to another phase. */
export function verifyNativeRelatedReturn(local:Local,source:FileRef,before:string,frames?:{before:unknown;after:unknown}){
 const selected=selectMemoryBoundaryWithDeployment(local.config,true);
 check(selected?.boundary.sdk_build_id===E7_NATIVE_BUILD&&selected.manifest,'RELATED_E7_BOUNDARY_REQUIRED');
 prepareAtGuard(local,source,guardAtBoundary(local,selected));
 check(before===hash(canonical(selected.manifest)),'RELATED_PROJECT_MANIFEST_DRIFT');
 if(frames){
  statusAtBoundary(local.config,frames.before,()=>selected);
  statusAtBoundary(local.config,frames.after,()=>selected);
 }
}
