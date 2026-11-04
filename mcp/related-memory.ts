import { selectMemoryBoundary, selectMemoryBoundaryManifest, selectMemoryBoundaryWithDeployment, PHYSICAL_BUILD, checkBoundaryHealth } from '../src/host-surface/project-memory-boundary.ts';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { canonical } from '../src/job-runtime/store.ts';
import { supervisedManifest } from '../src/host-surface/supervised-quality.ts';
import { bytes, exact, hash, noLinks, refShape, within } from './configure.ts';
import type { FileRef, LocalConfig, RelatedConfig } from './configure.ts';
import { MemoryError, memoryCheck as check, memoryJson, memoryBoundaryOperation, approvedDependencies, checkDependencyLifecycle } from './xmem-client.ts';

import { RELATED_BUILDS, LEGACY_RELATED_BUILD, E7_NATIVE_BUILD, E7_NODE_SHA256, sdkCompanionContract, sdkOrdinaryToolCount } from './sdk-builds.ts';
import { currentMemoryFacts } from './memory-bridge.ts';
import { isUnifiedPlainRelated, prepareRelated as prepareUnifiedRelated, prepareNativeRelatedHealth, RelatedProtocolError, verifyNativeRelatedReturn } from './related-unified-protocol.ts';
export const RELATED_BUILD=LEGACY_RELATED_BUILD;
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
export function guardRelated(local:Local){
 const c=local.config,m=c.memory_bridge!,r=enabled(c);
 check(hash(bytes(local.configPath))===local.configHash,'RELATED_LOCAL_CONFIG_DRIFT');
 check(r.build_id!==E7_NATIVE_BUILD,'RELATED_E7_FIXED_CHILD_REQUIRED');
 currentMemoryFacts(c);
 const selected=selectMemoryBoundaryWithDeployment(c),mode=selected?.boundary.mode??'CUSTOM_LOCAL';
 if(selected)check(r.build_id===selected.boundary.sdk_build_id&&same(r.deployment,selected.boundary.deployment),'RELATED_BOUNDARY_DEPLOYMENT_MISMATCH');
 check(RELATED_BUILDS.includes(r.build_id),'RELATED_BUILD_UNSUPPORTED');
 check(hash(bytes(m.node.path,128*1024*1024))===m.node.sha256,'RELATED_NODE_DRIFT');
 check(within(c.input_root,r.deployment.path),'RELATED_DEPLOYMENT_OUTSIDE_INPUT');
 const inv=json(pinned(r.deployment)),root=inv.runtime_root;if(selected)check(same(inv,selected.deployment),'RELATED_DEPLOYMENT_DRIFT');check(inv.format==='XMEM_DEPLOYED_FILE_INVENTORY_NOT_LOADED_PROCESS_IDENTITY'&&typeof root==='string'&&isAbsolute(root)&&Array.isArray(inv.files)&&inv.files.length>0&&inv.files.length<=128&&inv.count===inv.files.length,'RELATED_DEPLOYMENT_INVALID');
 check(r.sdk.path===join(root,'dist','src','shared-memory.js')&&r.standalone_sdk.path===join(root,'dist','src','standalone.js'),'RELATED_PUBLIC_SDK_REQUIRED');
 const members=new Map<string,string>();
 for(const f of inv.files){exact(f,['path','bytes','sha256']);check(text(f.path)&&!f.path.includes('\\')&&!f.path.includes(':')&&f.path.split('/').every((p:string)=>p!=='.'&&p!=='..'&&p!=='')&&hex(f.sha256)&&Number.isSafeInteger(f.bytes)&&f.bytes>=0&&f.bytes<=2*1024*1024&&!members.has(f.path),'RELATED_DEPLOYMENT_MEMBER_INVALID');const p=resolve(root,f.path);check(within(root,p),'RELATED_DEPLOYMENT_ESCAPE');if(!selected){const b=bytes(p);check(b.length===f.bytes&&hash(b)===f.sha256,'RELATED_DEPLOYMENT_DRIFT');}members.set(f.path,f.sha256);}
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
export function prepareRelated(local:Local,source:FileRef){
 if(local.config.memory_bridge?.related?.enabled===true&&local.config.memory_bridge.related.build_id===E7_NATIVE_BUILD){
  return prepareUnifiedRelated(local,source);
 }
 const c=local.config,{r,sharing}=guardRelated(local);refShape(source);check(within(c.input_root,source.path)&&r.approved_queries.some(v=>same(v,source)),'RELATED_QUERY_NOT_APPROVED');
 check(Buffer.byteLength(JSON.stringify({config_path:local.configPath,config_sha256:local.configHash,source}))<=16384,'RELATED_CHILD_INPUT_BOUND');
 const v=json(pinned(source,16384));exact(v,['format','query','tags','allowed_source_ids','limit','payload_budget_bytes']);
 check(v.format==='xdev-related-memory-request-1'&&typeof v.query==='string'&&v.query.length<=256&&!v.query.includes('\0')&&list(v.tags,8)&&list(v.allowed_source_ids,64)&&v.allowed_source_ids.every((x:string)=>r.allowed_source_ids.includes(x))&&v.tags.every((x:string)=>r.tags.includes(x)),'RELATED_QUERY_INVALID');
 check(Number.isSafeInteger(v.limit)&&v.limit>=1&&v.limit<=r.limits.result_limit&&Number.isSafeInteger(v.payload_budget_bytes)&&v.payload_budget_bytes>=0&&v.payload_budget_bytes<=r.limits.payload_bytes,'RELATED_QUERY_LIMIT');
 const m=c.memory_bridge!;return{r,sharing,query:{project_id:m.project_id,workspace_id:m.workspace_id,target_scope:{task_ref:m.task_ref,task_version:m.task_version},role:'developer',purpose:'TASK_RECALL',allowed_source_ids:v.allowed_source_ids,query:v.query,tags:v.tags,limit:v.limit,payload_budget_bytes:v.payload_budget_bytes},dependency:approvedDependencies(c,'related')};
}

/** Only an immutable scope/limit commitment and <=8 numbered consumption files.
 * No event IDs, query/response bodies or second Job/QA state. */
export function reserveRelated(c:LocalConfig,onSideEffect:()=>void){
 const r=enabled(c),scope=relatedScope(c),id=hash(canonical(scope)),root=join(c.control_root,'xmem-related-budget');noLinks(root);
 const slots=Math.min(8,r.limits.calls,Math.floor(r.limits.total_ms/r.limits.call_ms),Math.floor(r.limits.total_payload_bytes/r.limits.payload_bytes));check(slots>=1,'RELATED_BUDGET_UNSATISFIABLE');
 const header={format:'xdev-related-budget-1',scope,slots,calls:r.limits.calls,call_ms:r.limits.call_ms,total_ms:r.limits.total_ms,payload_bytes:r.limits.payload_bytes,total_payload_bytes:r.limits.total_payload_bytes},body=canonical(header)+'\n',headerPath=join(root,id+'.json'),slotPath=(i:number)=>join(root,id+'-'+i+'.json');
 if(!existsSync(headerPath))check(Array.from({length:8},(_,i)=>slotPath(i)).every(p=>!existsSync(p)),'RELATED_BUDGET_HEADER_MISSING_NO_REBUILD');
 const immutable=(p:string,value:string)=>{noLinks(p);const fd=openSync(p,'wx',0o600);try{writeFileSync(fd,value);fsyncSync(fd);}finally{closeSync(fd);}};
 onSideEffect();if(!existsSync(root)){try{mkdirSync(root,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}noLinks(root);}
 try{immutable(headerPath,body);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;check(bytes(headerPath,8192).equals(Buffer.from(body)),'RELATED_BUDGET_HEADER_CONFLICT_NO_REPAIR');}
 for(let i=0;i<slots;i++){const p=slotPath(i);noLinks(p);try{immutable(p,canonical({format:'xdev-related-budget-slot-1',header_sha256:hash(body),slot:i,call_ms:r.limits.call_ms,payload_bytes:r.limits.payload_bytes})+'\n');return{domain:id,slot:i,slot_count:slots,precharged_ms:r.limits.call_ms,precharged_payload_bytes:r.limits.payload_bytes,refund:false};}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;bytes(p,8192);/* Existence, including partial bytes, consumes the slot. */}}
 throw new MemoryError('BUDGET','RELATED_BUDGET_EXHAUSTED');
}
export function checkRelatedStatus(c:LocalConfig,raw:any){
 if(raw?.ok===false)throw new MemoryError('SDK_BUSINESS',safeCode(raw.error?.code));
 check(raw?.ok===true&&raw.value&&typeof raw.value==='object','RELATED_STATUS_ENVELOPE');const v=raw.value,m=c.memory_bridge!,p=v.policy,rt=v.runtime,l=v.storage_location,mode=selectMemoryBoundary(c)?.boundary.mode??'CUSTOM_LOCAL';
 check(v.project_root===c.project_root&&v.project_id===m.project_id&&v.configured===true&&v.automatic_hooks===false&&v.policy_hash===m.policy_hash&&hash(canonical(p))===m.policy_hash&&p?.enabled===true&&p.workspace_id===m.workspace_id&&p.default_role==='developer'&&same(p.allowed_roles,['developer']),'RELATED_STATUS_POLICY');
 check(rt?.build_id===enabled(c).build_id&&RELATED_BUILDS.includes(rt.build_id)&&rt.contract_version===sdkCompanionContract(rt.build_id)&&rt.profile==='sdk'&&rt.identity_observation==='ON_DISK_AT_STATUS_CALL_NOT_LOADED_MODULE_ATTESTATION'&&rt.capabilities?.ordinary_tool_count===sdkOrdinaryToolCount(rt.build_id)&&rt.capabilities.authenticated_identity===false,'RELATED_STATUS_BUILD');
 check(l?.configured===true&&l.mode===mode&&l.storage_root===m.storage_root&&l.location_hash===m.location_hash&&l.custom_identity_verified===(mode==='CUSTOM_LOCAL'),'RELATED_STATUS_LOCATION');
}
const safeCode=(v:unknown)=>typeof v==='string'&&/^[A-Z0-9_:-]{1,128}$/.test(v)?v:'RELATED_SDK_BUSINESS_ERROR';
export function checkRelatedResponse(c:LocalConfig,prepared:ReturnType<typeof prepareRelated>,raw:any){
 if(raw?.ok===false)throw new MemoryError('SDK_BUSINESS',safeCode(raw.error?.code));
 exact(raw,['ok','value']);check(raw.ok===true,'RELATED_SDK_ENVELOPE');const v=raw.value,q=prepared.query;
 check(v&&typeof v==='object'&&!Array.isArray(v),'RELATED_SDK_VALUE');
 exact(v,['kind','contract_version','read_only','scope','payload_budget_bytes','budget_unit','budget_basis','mandatory','execution_verified','actor_identity_verified','owner_confirmation_verified','status','payload','payload_bytes','payload_sha256','coverage',...(v.status==='EMPTY'?['reason']:['authorization_hash','compiler'])]);
 check(v.kind==='AuthorizedRelatedMemoryCandidates'&&v.contract_version==='xmem-shared-memory/1'&&v.read_only===true&&same(v.scope,{project_id:q.project_id,workspace_id:q.workspace_id,...q.target_scope,role:q.role})&&v.payload_budget_bytes===q.payload_budget_bytes&&v.budget_unit==='utf8-bytes'&&v.budget_basis==='PUBLIC_PAYLOAD_INCLUDING_ORIGIN_AND_APPLICABILITY'&&[v.mandatory,v.execution_verified,v.actor_identity_verified,v.owner_confirmation_verified].every(x=>x===false),'RELATED_RESPONSE_BINDING');
 check(typeof v.payload==='string'&&Buffer.byteLength(v.payload)===v.payload_bytes&&v.payload_bytes<=q.payload_budget_bytes&&hash(v.payload)===v.payload_sha256,'RELATED_PAYLOAD_HASH_OR_BOUND');
 exact(v.coverage,['incomplete','reasons']);check(typeof v.coverage.incomplete==='boolean'&&list(v.coverage.reasons,3)&&v.coverage.reasons.every((x:string)=>['NODE_BUDGET','PAYLOAD_BUDGET','RESULT_LIMIT'].includes(x)),'RELATED_COVERAGE_INVALID');
 check(['READY','EMPTY','INCOMPLETE'].includes(v.status)&&v.coverage.incomplete===(v.status==='INCOMPLETE')&&(v.coverage.reasons.length>0)===v.coverage.incomplete,'RELATED_STATUS_INVALID');
 if(v.status==='EMPTY')check(v.payload===''&&v.reason==='NO_AUTHORIZED_MATCHES','RELATED_EMPTY_INVALID');
 else{exact(v.compiler,['version','policy_version','view']);check(hex(v.authorization_hash)&&v.compiler.version==='context-v2'&&v.compiler.policy_version==='context-policy-v5'&&v.compiler.view==='TRANSIENT_AUTHORIZED_VIEW_NOT_PERSISTED','RELATED_AUTHORIZATION_VIEW');if(v.status==='READY')check(v.payload.length>0,'RELATED_READY_EMPTY');}
 const lines=v.payload===''?[]:v.payload.split('\n').map((s:string)=>memoryJson(s));check(lines.length<=q.limit,'RELATED_RESULT_LIMIT');const seen=new Set<string>();
 for(const x of lines){
  const withheld=['STALE_OR_SUPERSEDED','CONFLICT'].includes(x.applicability);exact(x,['revision_id','source_id','source_content_hash','origin','applicability','basis_match','applicability_authority','epistemic_state','mandatory','execution_verified','owner_confirmation_verified',withheld?'content_withheld':'content']);
  check(text(x.revision_id)&&!seen.has(x.revision_id)&&q.allowed_source_ids.includes(x.source_id)&&hex(x.source_content_hash)&&['ASSERTED','HYPOTHESIS'].includes(x.epistemic_state)&&[x.mandatory,x.execution_verified,x.owner_confirmation_verified].every(z=>z===false),'RELATED_CANDIDATE_INVALID');seen.add(x.revision_id);
  check(['NOT_EVALUATED','CURRENT_CONFIRMED','REQUIRES_VERIFICATION','STALE_OR_SUPERSEDED','CONFLICT'].includes(x.applicability)&&(x.basis_match===null||typeof x.basis_match==='boolean')&&['NOT_EVALUATED','OWNER_DECLARED_REVIEW_WITH_APPROVED_FILE_HASHES'].includes(x.applicability_authority),'RELATED_APPLICABILITY_INVALID');
  if(x.applicability==='CURRENT_CONFIRMED')check(x.basis_match===true&&x.applicability_authority==='OWNER_DECLARED_REVIEW_WITH_APPROVED_FILE_HASHES','RELATED_CURRENT_UNPROVEN');
  if(withheld)check(x.content_withheld===true,'RELATED_NOTICE_CONTENT');else{check(typeof x.content==='string','RELATED_CONTENT_INVALID');check(hash(x.content)===x.source_content_hash,'RELATED_CONTENT_HASH_MISMATCH');}
  const declarations=prepared.sharing.grants.filter((g:any)=>same(g.target_scope,q.target_scope)&&same(g.source_scope,x.origin)&&Array.isArray(g.roles)&&g.roles.includes(q.role)&&g.purpose==='TASK_RECALL'&&(g.expires_at===null||Date.parse(g.expires_at)>Date.now())).flatMap((g:any)=>g.revisions.filter((r:any)=>r.revision_id===x.revision_id&&r.source_id===x.source_id&&q.tags.every((tag:string)=>r.tags.includes(tag))));
  check(declarations.length===1,'RELATED_ORIGIN_NOT_AUTHORIZED');
  const review=declarations[0].review;
  check(x.applicability_authority===(review?'OWNER_DECLARED_REVIEW_WITH_APPROVED_FILE_HASHES':'NOT_EVALUATED')&&(review?typeof x.basis_match==='boolean':x.basis_match===null),'RELATED_OWNER_DECLARATION_MISMATCH');
  if(review)check(['APPLICABLE','CONFLICT','REQUIRES_VERIFICATION'].includes(review.decision)&&Array.isArray(review.basis)&&review.basis.length>0,'RELATED_OWNER_REVIEW_INVALID');
  // Match the fixed public SDK's declaration/basis mapping; do not infer semantics.
  // A known stale revision may override any assessed state, and is always withheld.
  const assessed=!review?'NOT_EVALUATED':x.basis_match===false?'REQUIRES_VERIFICATION':review.decision==='APPLICABLE'?'CURRENT_CONFIRMED':review.decision;
  check(x.applicability==='STALE_OR_SUPERSEDED'||x.applicability===assessed,'RELATED_APPLICABILITY_DECLARATION_MISMATCH');
 }
 return{status:v.status,scope:v.scope,payload:v.payload,payload_bytes:v.payload_bytes,payload_sha256:v.payload_sha256,coverage:v.coverage,authorization_hash:v.authorization_hash??null,applicability:'NOT_EVALUATED',candidate_applicability:'PER_CANDIDATE_OWNER_DECLARATION_NOT_EXECUTION_PROOF',mandatory:false};
}

// Fixed literals only: config/input cannot select an executable or module.
function relatedChildPath(local:Local){return fileURLToPath(isUnifiedPlainRelated(local.config)?new URL('./related-unified-child.ts',import.meta.url):new URL('./related-child.ts',import.meta.url));}
function relatedProtocolPath(local:Local){return isUnifiedPlainRelated(local.config)?fileURLToPath(new URL('./related-unified-protocol.ts',import.meta.url)):undefined;}
export type RelatedLaunch={stdout:Buffer;stderr:Buffer;pid:number|undefined;status:number|null;signal:string|null;error?:{code?:string;message?:string}};
export function launchRelated(local:Local,source:FileRef,spawn:typeof spawnSync=spawnSync,deadline?:number,onSpawn=()=>{}):RelatedLaunch {
 const c=local.config,r=enabled(c),child=relatedChildPath(local);bytes(child);const protocol=relatedProtocolPath(local);if(protocol)bytes(protocol);
 if(r.build_id===E7_NATIVE_BUILD){
  const node=c.memory_bridge!.node;
  check(node.sha256===E7_NODE_SHA256&&hash(bytes(node.path,128*1024*1024))===node.sha256,'RELATED_NODE_DRIFT');
  check(deadline!==undefined,'RELATED_TOTAL_DEADLINE');
 }
 const options={cwd:c.project_root,shell:false,windowsHide:true,timeout:deadline===undefined?r.limits.call_ms:Math.max(1,deadline-Date.now()),maxBuffer:r.limits.response_bytes,env:getDefaultEnvironment(),input:Buffer.from(JSON.stringify({config_path:local.configPath,config_sha256:local.configHash,source,...(deadline===undefined?{}:{deadline_unix_ms:deadline})}),'utf8'),encoding:'buffer' as const};
 if(r.build_id===E7_NATIVE_BUILD)check(Date.now()<deadline!,'RELATED_TOTAL_DEADLINE');
 onSpawn();
 return spawn(c.memory_bridge!.node.path,['--experimental-strip-types',child],options);
}
export function nativeRelatedHealth(local:Local,source:FileRef,deadline:number){
 const {boundary,options}=prepareNativeRelatedHealth(local,source,deadline),node=local.config.memory_bridge!.node;
 check(node.sha256===E7_NODE_SHA256&&hash(bytes(node.path,128*1024*1024))===node.sha256,'RELATED_NODE_DRIFT');
 const child=relatedChildPath(local);bytes(child);
 const input=Buffer.from(JSON.stringify({format:'xdev-e7-related-doctor-1',config_path:local.configPath,config_sha256:local.configHash,source,deadline_unix_ms:deadline}),'utf8');
 const env=getDefaultEnvironment(),remaining=deadline-Date.now();
 check(input.length<=16384&&remaining>0,'RELATED_HEALTH_INPUT_OR_DEADLINE');
 const out=spawnSync(node.path,['--experimental-strip-types',child],{input,env,encoding:'buffer',windowsHide:true,shell:false,timeout:remaining,maxBuffer:65536});
 check(!out.error&&!out.signal&&out.status===0&&out.stderr.length<=8192&&Date.now()<deadline,'RELATED_HEALTH_TRANSPORT');
 const value=json(out.stdout);
 if(value?.format==='xdev-related-child-error-1')throw new MemoryError('CONTRACT',safeCode(value.error?.code));
 prepareNativeRelatedHealth(local,source,deadline);
 return checkBoundaryHealth(boundary,value,options.payload_budget_bytes);
}
/** Optional launcher is a module-only TEST_ONLY seam, never a tool/config field. */
export function bridgeRelated(local:Local,args:{action:string;source?:FileRef},onSideEffect:()=>void,launch:typeof launchRelated=launchRelated){
 const base={format:'xdev-memory-result-1',action:'related',execution_allowed:false,delivery_allowed:false,claim_reset:false,native_identity_authenticated:false,actor_identity_verified:false,owner_confirmation_verified:false,execution_verified:false,applicability:'NOT_EVALUATED',mandatory:false,authority:'UNTRUSTED_MEMORY_DATA_ONLY',sdk_read_only:true,saved:'NOT_REQUESTED',automatic_retry:false};
 const operationStarted=Date.now();let operation:ReturnType<typeof memoryBoundaryOperation>|undefined;let reservation:ReturnType<typeof reserveRelated>|undefined,entered=false,called=false,sdkCall:false|true|'UNKNOWN'=false,diagnostic:any=null;
 try{
  exact(args,['action','source']);check(args.action==='related'&&args.source,'RELATED_SOURCE_REQUIRED');const p=prepareRelated(local,args.source),m=local.config.memory_bridge!,native=p.r.build_id===E7_NATIVE_BUILD,selected=native?null:selectMemoryBoundary(local.config);
  // One original slot's time includes H-before, the child, and H-after. The
  // durable reserve remains after H-before; all failures after it consume it.
  const slotDeadline=Math.min(operationStarted+m.limits.total_ms,operationStarted+m.limits.call_ms,operationStarted+p.r.limits.total_ms,operationStarted+p.r.limits.call_ms);
  operation=memoryBoundaryOperation(local.config,operationStarted,native||selected?slotDeadline:undefined);
  if(native)check(operation.selected?.boundary.sdk_build_id===E7_NATIVE_BUILD,'RELATED_E7_BOUNDARY_REQUIRED');
  const health=()=>native?nativeRelatedHealth(local,args.source!,operation!.deadline()):operation!.health();
  const nativeManifest=()=>{const manifest=selectMemoryBoundaryManifest(local.config);check(manifest,'RELATED_E7_BOUNDARY_REQUIRED');return manifest;};
  health();operation.check();const before=hash(canonical(native?nativeManifest():supervisedManifest(local.config.project_root,selected?.ref))),childPath=relatedChildPath(local),childHash=hash(bytes(childPath)),protocolPath=relatedProtocolPath(local),protocolHash=protocolPath?hash(bytes(protocolPath)):null;
  operation.check();reservation=reserveRelated(local.config,()=>{entered=true;onSideEffect();});operation.check();
  const markLaunch=()=>{called=true;sdkCall='UNKNOWN';},started=Date.now();
  const launchDeadline=operation.selected?operation.deadline(p.r.limits.call_ms):undefined;
  if(launch!==launchRelated)markLaunch();
  const out=launch(local,args.source,undefined,launchDeadline,markLaunch);
  diagnostic={pid:out.pid??null,exit_code:out.status,signal:out.signal,error_code:out.error?.code??null,elapsed_ms:Date.now()-started,stdout_bytes:out.stdout?.length??0,stdout_sha256:hash(out.stdout??Buffer.alloc(0)),stderr_bytes:out.stderr?.length??0,stderr_sha256:hash(out.stderr??Buffer.alloc(0)),node_sha256:local.config.memory_bridge!.node.sha256,child_sha256:childHash,sdk_build:p.r.build_id,global_descendant_closure:'NOT_CLAIMED'};
  const postValidate=(frames?:{before:unknown;after:unknown})=>{
   if(native)verifyNativeRelatedReturn(local,args.source!,before,frames);
   else{
    if(!isUnifiedPlainRelated(local.config))guardRelated(local);
    prepareRelated(local,args.source!);
    check(before===hash(canonical(supervisedManifest(local.config.project_root,selectMemoryBoundary(local.config)?.ref))),'RELATED_PROJECT_MANIFEST_DRIFT');
   }
   check(childPath===relatedChildPath(local)&&protocolPath===relatedProtocolPath(local)&&childHash===hash(bytes(childPath))&&(!protocolPath||protocolHash===hash(bytes(protocolPath))),'RELATED_CHILD_DRIFT');
  };
  if(!native)postValidate();
  if(out.error||out.signal||out.status!==0){if(native)postValidate();throw new MemoryError('TRANSPORT',out.error?.code==='ETIMEDOUT'?'RELATED_CHILD_TIMEOUT':out.error?.code==='ENOBUFS'?'RELATED_CHILD_OVERFLOW':'RELATED_CHILD_EXIT');}
  check(Buffer.isBuffer(out.stdout)&&Buffer.isBuffer(out.stderr)&&out.stdout.length+out.stderr.length<=p.r.limits.response_bytes&&out.stderr.length<=p.r.limits.stderr_bytes,'RELATED_STDIO_BOUND');
  const value=json(out.stdout);if(value?.format==='xdev-related-child-error-1'){if(native)postValidate();exact(value,['format','error']);exact(value.error,['layer','code']);throw new MemoryError(value.error.layer==='SDK_BUSINESS'?'SDK_BUSINESS':'CONTRACT',safeCode(value.error.code));}
  exact(value,['format','before','result','after',...(p.dependency?['dependency_lifecycle']:[])]);check(value.format==='xdev-related-child-1','RELATED_CHILD_ENVELOPE');
  if(native)postValidate(value);else{checkRelatedStatus(local.config,value.before);checkRelatedStatus(local.config,value.after);}
  if(p.dependency)checkDependencyLifecycle(local.config,'related',value.dependency_lifecycle);
  sdkCall=true;const result=checkRelatedResponse(local.config,p,value.result);
  health();operation.check();return{...base,...result,...(p.dependency?{dependency_lifecycle:value.dependency_lifecycle}:{}),sdk_call_occurred:sdkCall,child_launch_attempted:called,local_budget:{side_effects:true,reservation:'DURABLE',...reservation},diagnostic,delivery:{recipient:local.config.memory_bridge!.recipient,status:'PREPARED_FOR_COORDINATOR_RETURN',received:'NOT_OBSERVED',host_injected:false}};
 }catch(e){const error=e instanceof MemoryError||e instanceof RelatedProtocolError?e:new MemoryError('LOCAL','RELATED_VALIDATION_ERROR',{error_sha256:hash(e instanceof Error?e.message:String(e))});return{...base,status:['SDK_BUSINESS','BUDGET'].includes(error.layer)||!entered?'REFUSED':'UNKNOWN',sdk_call_occurred:sdkCall,child_launch_attempted:called,local_budget:{side_effects:entered,reservation:reservation?'DURABLE':entered?'UNKNOWN':'NOT_REQUESTED',...(reservation??{})},error:{layer:error.layer,code:error.code,...error.diagnostic},diagnostic,payload:null};}
}
