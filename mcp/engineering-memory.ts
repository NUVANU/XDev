import {launchReadonlyPhase07} from './phase07-readonly-transport.ts';
import {PHASE07_CUTOFF,wholeClock07} from './phase07-protocol.ts';
import { selectMemoryBoundary, selectMemoryBoundaryManifest } from '../src/host-surface/project-memory-boundary.ts';
/** Thin, explicit consumer of the frozen public engineering SDK.
 * Memory bodies are data; this module neither dispatches nor authorizes work. */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { canonical } from '../src/job-runtime/store.ts';
import { inspectSupervisedInput, supervisedManifest } from '../src/host-surface/supervised-quality.ts';
import { bytes, exact, hash, refShape, within } from './configure.ts';
import type { EngineeringConfig, FileRef, LocalConfig } from './configure.ts';
import { MemoryError, memoryCheck as check, memoryJson, companionLocationHash, verifyBoundEngineeringPins, memoryBoundaryOperation, readStandaloneChild, approvedDependencies, checkDependencyLifecycle } from './xmem-client.ts';
import { beginMemoryOperation, inspectMemoryOperation, confirmMemoryOperation } from './memory-operation.ts';
import type { MemoryIntent, MemoryConfirmation } from './memory-operation.ts';
import { checkReadback, memoryScope, currentMemoryFacts } from './memory-bridge.ts';
import { createInputReader } from './input-reader.ts';
import { SOURCE02_BUILD, BETA04_BUILD, E7_NATIVE_BUILD, ENGINEERING_CONTRACTS, SDK_MEMBERS, PHYSICAL_BUILD, nativeJointQuery, sdkCompanionContract, sdkOrdinaryToolCount } from './sdk-builds.ts';
import { nativeRelatedHealth } from './related-memory.ts';
import { RelatedProtocolError } from './related-unified-protocol.ts';

export const ENGINEERING_BUILD=SOURCE02_BUILD;
type Local=ReturnType<typeof import('./configure.ts').loadConfig>;
type Enabled=Extract<EngineeringConfig,{enabled:true}>;
export type EngineeringAction='worker-context'|'engineering-capture'|'engineering-reconcile';
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const hex=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const word=(v:unknown,max=512):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\x00-\x1f]/.test(v);
const prose=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=4096&&!v.includes('\0');
const list=(v:unknown,max=16):v is string[]=>Array.isArray(v)&&v.length<=max&&v.every(x=>word(x))&&new Set(v).size===v.length;
const file=(v:unknown):v is string=>word(v)&&!v.includes('\\')&&!v.includes(':')&&v.split('/').every(s=>s!==''&&s!=='.'&&s!=='..')&&(process.platform!=='win32'||v===v.toLowerCase());
const json=(b:Buffer)=>memoryJson(new TextDecoder('utf-8',{fatal:true}).decode(b));
function pinned(ref:FileRef,limit=2*1024*1024){refShape(ref);const b=bytes(ref.path,limit);check(hash(b)===ref.sha256,'ENGINEERING_PIN_DRIFT');return b;}
function enabled(c:LocalConfig):Enabled {const e=c.memory_bridge?.engineering;check(e?.enabled===true,'ENGINEERING_NOT_ENABLED');return e;}
export function engineeringScope(c:LocalConfig){return{xdev_project_id:c.project_id,...memoryScope(c)};}

/** Disk pins are observations, not loaded-module or actor authentication. */
export function guardEngineering(local:Local){
 const c=local.config,m=c.memory_bridge!,e=enabled(c);
 check(hash(bytes(local.configPath))===local.configHash,'ENGINEERING_LOCAL_CONFIG_DRIFT');
 // Exact approval is followed by the same complete input graph as ordinary MCP.
 // This precedes every Core reader, SDK child and operation intent.
 check(c.approved_requests?.some(r=>same(r,e.request)),'ENGINEERING_REQUEST_NOT_APPROVED');
 let request:any;
 try{request=createInputReader(c).source(e.request);}
 catch(error){throw new MemoryError('CONTRACT','ENGINEERING_TASK_INPUT_REFUSED',{input_error_sha256:hash(error instanceof Error?error.message:String(error))});}
 const selected=verifyBoundEngineeringPins(c),mode=selected?.boundary.mode??'CUSTOM_LOCAL';check(request.format==='xdev-supervised-request-3'||request.format==='xdev-supervised-request-4'&&selected&&same(request,selected.request),'ENGINEERING_V3_OR_BOUND_V4_REQUIRED');
 const native=e.build_id===E7_NATIVE_BUILD;
 if(native)check(request.format==='xdev-supervised-request-4'&&selected?.boundary.sdk_build_id===E7_NATIVE_BUILD&&nativeJointQuery(c),'ENGINEERING_NATIVE_JOINT_BOUNDARY_REQUIRED');
 // This is an intermediate S, not another operation entry. validateRequest
 // still checks the entire request/descriptor graph before the static manifest.
 inspectSupervisedInput({projectRoot:c.project_root,controlRoot:c.control_root,projectId:c.project_id,boundaryHealth:()=>null},'request',e.request.path);
 const inv=json(pinned(m.deployment)),root=inv.runtime_root;
 check(Object.hasOwn(ENGINEERING_CONTRACTS,e.build_id)&&e.sdk.path===join(root,'dist','src','engineering-memory.js')&&e.standalone_sdk.path===join(root,'dist','src','standalone.js'),'ENGINEERING_PUBLIC_SDK_REQUIRED');
 const names=readdirSync(join(root,'dist','src')).filter(n=>n.endsWith('.js')).sort();
 const members=new Map<string,string>(inv.files.map((f:any)=>[f.path,f.sha256]));
 const counts=SDK_MEMBERS[e.build_id as keyof typeof SDK_MEMBERS],extras=native?['dist/src/xmem-win-physical.exe']:[];
 check(counts&&names.length===counts.js&&inv.files.length===counts.runtime&&same([...members.keys()].sort(),[...names.map(n=>'dist/src/'+n),'package.json','npm-shrinkwrap.json',...extras].sort()),'ENGINEERING_RUNTIME_MEMBERS');
 const build=hash(JSON.stringify({files:names.map(name=>({name,sha256:members.get('dist/src/'+name)})),package_sha256:members.get('package.json'),lock_sha256:members.get('npm-shrinkwrap.json')}));
 check(build===e.build_id,'ENGINEERING_BUILD_DRIFT');
 const pkg=json(bytes(join(root,'package.json')));
 check(pkg.name==='xmem'&&pkg.exports?.['./engineering-memory']==='./dist/src/engineering-memory.js'&&pkg.exports?.['./standalone']==='./dist/src/standalone.js','ENGINEERING_EXPORT_DRIFT');
 check(hash(pinned(e.sdk))===members.get('dist/src/engineering-memory.js')&&hash(pinned(e.standalone_sdk))===members.get('dist/src/standalone.js'),'ENGINEERING_SDK_PIN_MISMATCH');
 const p=json(bytes(join(c.project_root,'.xmem','standalone-v1.json')));
 check(hash(canonical(p))===m.policy_hash&&p.schema_version===1&&p.mode==='SEMI_AUTO'&&p.enabled===true&&p.workspace_id===m.workspace_id&&p.default_role==='developer'&&same(p.allowed_roles,['developer'])&&Number.isSafeInteger(p.payload_budget_bytes)&&m.limits.payload_bytes<=p.payload_budget_bytes,'ENGINEERING_POLICY_DRIFT');
 check(companionLocationHash(m.project_id,m.storage_root,mode)===m.location_hash,'ENGINEERING_LOCATION_BINDING');
 const identity=json(bytes(join(c.project_root,'.xmem','config.json')));exact(identity,['schema_version','project_id','root']);
 check(identity.schema_version===1&&identity.project_id===m.project_id&&identity.root===c.project_root,'ENGINEERING_PROJECT_IDENTITY');
 const location=json(bytes(join(c.project_root,'.xmem','storage-location-v1.json')));exact(location,['schema_version','project_id','mode','storage_root']);
 check(same(location,{schema_version:1,project_id:m.project_id,mode,storage_root:m.storage_root}),'ENGINEERING_LOCATION_DRIFT');
 if(mode==='CUSTOM_LOCAL'){const storageIdentity=json(bytes(join(m.storage_root,'xmem-storage-identity-v1.json')));exact(storageIdentity,['schema_version','project_id']);
 check(storageIdentity.schema_version===1&&storageIdentity.project_id===m.project_id,'ENGINEERING_STORAGE_IDENTITY');}
 const map=json(pinned(e.mapping,16384));
 exact(map,['format','scope','request','spec','files','modules','topics','intent']);
 check(map.format==='xdev-engineering-map-1'&&same(map.scope,engineeringScope(c))&&same(map.request,e.request)&&same(map.spec,request.spec),'ENGINEERING_MAP_BINDING');
 check(list(map.files)&&map.files.length>0&&map.files.every((p:string)=>file(p)&&request.allowed_scope.includes(p))&&list(map.topics)&&typeof map.intent==='string'&&map.intent.length<=256&&!map.intent.includes('\0'),'ENGINEERING_MAP_SCOPE');
 check(Array.isArray(map.modules)&&map.modules.length<=16,'ENGINEERING_MODULE_MAP');const modules=new Set<string>();
 for(const item of map.modules){exact(item,['name','files']);check(word(item.name)&&!modules.has(item.name)&&list(item.files)&&item.files.length>0&&item.files.every((p:string)=>map.files.includes(p)),'ENGINEERING_MODULE_MAP');modules.add(item.name);}
 return{e,request,map};
}

/** Strict public record validation before creating a local write intent.
 * Canonical file names avoid an SDK normalization changing the committed body. */
export function checkEngineeringRecord(r:any,allowed:{files:string[];modules:any[];topics:string[]}){
 exact(r,['format','information_type','title','associations','conditions','constraints','unknowns','details','experience','sources']);
 check(r.format==='xmem-engineering/1'&&['CONSTRAINT','DECISION','INTERFACE','FAILURE','UNKNOWN','NOTE'].includes(r.information_type)&&word(r.title,160)&&prose(r.details),'ENGINEERING_RECORD_INVALID');
 exact(r.associations,['files','modules','topics']);const a=r.associations;
 check(list(a.files)&&a.files.every((p:string)=>file(p)&&allowed.files.includes(p))&&list(a.modules)&&a.modules.every((n:string)=>allowed.modules.some((v:any)=>v.name===n))&&list(a.topics)&&a.topics.every((n:string)=>allowed.topics.includes(n))&&a.files.length+a.modules.length+a.topics.length>0,'ENGINEERING_RECORD_SCOPE');
 const lines=(v:any)=>Array.isArray(v)&&v.length<=16&&v.every(prose)&&new Set(v).size===v.length;
 check([r.conditions,r.constraints,r.unknowns].every(lines),'ENGINEERING_RECORD_LINES');
 check(Array.isArray(r.sources)&&r.sources.length>=1&&r.sources.length<=16,'ENGINEERING_RECORD_SOURCES');
 for(const source of r.sources){exact(source,['source_id','locator','sha256']);check(word(source.source_id)&&word(source.locator)&&(hex(source.sha256)||source.sha256==='UNKNOWN'),'ENGINEERING_RECORD_SOURCES');}
 if(r.information_type==='FAILURE'){
  const x=r.experience;exact(x,['problem','attempts','analysis','avoid_when','retry_when','next_steps']);exact(x.analysis,['status','reason']);
  check(prose(x.problem)&&Array.isArray(x.attempts)&&x.attempts.length>=1&&x.attempts.length<=16&&['UNKNOWN','HYPOTHESIS','SUPPORTED_BY_REFERENCES'].includes(x.analysis.status)&&prose(x.analysis.reason)&&[x.avoid_when,x.retry_when,x.next_steps].every(lines),'ENGINEERING_EXPERIENCE_INVALID');
  for(const attempt of x.attempts){exact(attempt,['action','result']);check(prose(attempt.action)&&prose(attempt.result),'ENGINEERING_ATTEMPT_INVALID');}
  check(x.analysis.status!=='UNKNOWN'||x.analysis.reason==='UNKNOWN','ENGINEERING_UNKNOWN_CAUSE');
  check(x.analysis.status!=='SUPPORTED_BY_REFERENCES'||r.sources.some((s:any)=>s.sha256!=='UNKNOWN'&&s.locator!=='UNKNOWN'),'ENGINEERING_REFERENCE_REQUIRED');
 }else check(r.experience===null,'ENGINEERING_EXPERIENCE_INVALID');
 check(Buffer.byteLength(canonical(r))<=16384,'ENGINEERING_RECORD_BYTE_BOUND');
}
function approved(c:LocalConfig,source:FileRef){refShape(source);check(within(c.input_root,source.path)&&c.memory_bridge!.approved_sources.some(r=>same(r,source)),'ENGINEERING_SOURCE_NOT_APPROVED');return json(pinned(source,16384));}
/** Optional explicit Owner correction basis. Its original public material and
 * prior event stay independently pinned; this is not native authentication. */
function correctionBasis(c:LocalConfig,v:any,map:any){
 if(v.revises?.owner_source===undefined)return null;
 const r=v.revises,owner=approved(c,r.owner_source),old=approved(c,r.previous_event);
 exact(owner,['format','scope','memory_key','previous_revision_id','replacement_record_sha256','public_original','source_claim']);
 check(owner.format==='xdev-public-owner-memory-correction-1'&&same(owner.scope,engineeringScope(c))&&owner.memory_key===r.memory_key&&owner.previous_revision_id===r.previous_revision_id&&owner.replacement_record_sha256===hash(canonical(v.record))&&owner.source_claim==='COORDINATOR_TRANSFERRED_PUBLIC_OWNER_MESSAGE','ENGINEERING_OWNER_CORRECTION_BINDING');
 refShape(owner.public_original);check(within(c.input_root,owner.public_original.path)&&c.memory_bridge!.approved_sources.some(a=>same(a,owner.public_original))&&pinned(owner.public_original,16384).length>0,'ENGINEERING_OWNER_PUBLIC_SOURCE_REQUIRED');
 check(old.format==='xdev-public-engineering-event-1'&&same(old.scope,engineeringScope(c))&&old.namespace===v.namespace&&old.visibility==='PUBLIC_SHARED'&&same(old.audience,['developer'])&&old.provenance==='COORDINATOR_TRANSFERRED'&&old.private_material===false&&old.execution_verified===false,'ENGINEERING_PREVIOUS_PUBLIC_EVENT');
 checkEngineeringRecord(old.record,map);const key=old.revises?.memory_key??'xdev-engineering-'+hash(canonical(['xdev-engineering-event-1',old.namespace,old.event_id]));
 check(key===r.memory_key,'ENGINEERING_CORRECTION_SAME_KEY_REQUIRED');
 return{owner_source:r.owner_source,public_original:owner.public_original,previous_event:r.previous_event,content:canonical(old.record),previous_revision_id:old.revises?.previous_revision_id??null};
}
export function prepareEngineering(local:Local,action:EngineeringAction,source:FileRef){
 const c=local.config,m=c.memory_bridge!,g=guardEngineering(local),v=approved(c,source);
 currentMemoryFacts(c);
 check(['worker-context','engineering-capture','engineering-reconcile'].includes(action),'ENGINEERING_ACTION_INVALID');
 check(m.permissions[action==='worker-context'?'recall':action==='engineering-capture'?'capture':'reconcile']===true,'ENGINEERING_PERMISSION_REQUIRED');
 const manifest=hash(canonical(selectMemoryBoundaryManifest(c)??supervisedManifest(c.project_root)));
 check(v&&same(v.scope,engineeringScope(c))&&hex(v.manifest_sha256)&&v.manifest_sha256===manifest,'ENGINEERING_BOUNDARY_SCOPE_OR_MANIFEST');
 if(action==='worker-context'){
  exact(v,['format','scope','request','manifest_sha256','boundary','files','modules','topics','payload_budget_bytes','limit']);exact(v.boundary,['id','kind','worker_ref']);
  check(v.format==='xdev-worker-memory-boundary-1'&&same(v.request,g.e.request)&&word(v.boundary.id)&&['CREATE','CONTINUE','REPLACE'].includes(v.boundary.kind)&&word(v.boundary.worker_ref),'ENGINEERING_BOUNDARY_INVALID');
  if(g.e.build_id===E7_NATIVE_BUILD)check(v.boundary.kind==='CREATE','ENGINEERING_NATIVE_JOINT_CREATE_ONLY');
  check(list(v.files)&&v.files.every((p:string)=>g.map.files.includes(p))&&list(v.modules)&&v.modules.every((n:string)=>g.map.modules.some((x:any)=>x.name===n&&x.files.every((p:string)=>v.files.includes(p))))&&list(v.topics)&&v.topics.every((n:string)=>g.map.topics.includes(n)),'ENGINEERING_SELECTOR_WIDENING');
  check(Number.isSafeInteger(v.payload_budget_bytes)&&v.payload_budget_bytes>=0&&v.payload_budget_bytes<=m.limits.payload_bytes&&Number.isSafeInteger(v.limit)&&v.limit>=1&&v.limit<=32,'ENGINEERING_QUERY_LIMIT');
  const dependency=approvedDependencies(c,'engineering');
  return{...g,value:v,manifest,query:{task_ref:m.task_ref,task_version:m.task_version,role:'developer',files:v.files,modules:v.modules,topics:v.topics,query:g.map.intent,mode:'context',limit:v.limit,payload_budget_bytes:v.payload_budget_bytes,...(dependency?.registration.allowed_source_ids===undefined?{}:{allowed_source_ids:dependency.registration.allowed_source_ids})},event:null,dependency};
 }
 exact(v,['format','namespace','event_id','scope','manifest_sha256','visibility','audience','provenance','coverage','epistemic_state','execution_verified','private_material','record',...(v.revises===undefined?[]:['revises'])]);
 check(v.format==='xdev-public-engineering-event-1'&&v.namespace===m.event_namespace&&word(v.event_id)&&v.visibility==='PUBLIC_SHARED'&&same(v.audience,['developer'])&&v.provenance==='COORDINATOR_TRANSFERRED'&&['INCOMPLETE','PUBLIC_EVENT_DECLARATION'].includes(v.coverage)&&v.execution_verified===false&&v.private_material===false,'ENGINEERING_PUBLIC_SOURCE_REQUIRED');
 checkEngineeringRecord(v.record,g.map);check(v.epistemic_state===(v.record.information_type==='UNKNOWN'?'HYPOTHESIS':'ASSERTED'),'ENGINEERING_EVENT_EPISTEMIC');
 const content=canonical(v.record);check(Buffer.byteLength(content)<=m.limits.payload_bytes,'ENGINEERING_CAPTURE_BYTE_BOUND');
 const id=hash(canonical(['xdev-engineering-event-1',v.namespace,v.event_id]));
 if(g.e.build_id===E7_NATIVE_BUILD)check(v.revises===undefined,'ENGINEERING_NATIVE_JOINT_FRESH_EVENT_REQUIRED');
 if(v.revises!==undefined){exact(v.revises,['memory_key','previous_revision_id',...(v.revises.owner_source===undefined?[]:['owner_source','previous_event'])]);check(typeof v.revises.memory_key==='string'&&/^xdev-engineering-[a-f0-9]{64}$/.test(v.revises.memory_key)&&word(v.revises.previous_revision_id),'ENGINEERING_EXPLICIT_PREDECESSOR_REQUIRED');}
 if(v.revises!==undefined&&![SOURCE02_BUILD,BETA04_BUILD,PHYSICAL_BUILD].includes(g.e.build_id))check(v.revises.owner_source!==undefined,'ENGINEERING_PUBLIC_OWNER_CORRECTION_BASIS_REQUIRED');
 const correction=correctionBasis(c,v,g.map);
 const intent:MemoryIntent={format:'xdev-memory-operation-1',id,kind:'capture',scope_sha256:hash(canonical({protocol:'xdev-engineering-event-1',scope:engineeringScope(c),request:g.e.request,mapping:g.e.mapping,policy_hash:m.policy_hash,location_hash:m.location_hash,recipient:m.recipient,...(v.revises===undefined?{}:{revises:v.revises})})),source,content_sha256:hash(content),memory_key:v.revises?.memory_key??'xdev-engineering-'+id};
 return{...g,value:v,manifest,query:null,event:{content,intent,record:v.record,previous_revision_id:v.revises?.previous_revision_id??null,correction},dependency:null};
}
const safeCode=(v:unknown)=>typeof v==='string'&&/^[A-Z0-9_:-]{1,128}$/.test(v)?v:'ENGINEERING_SDK_BUSINESS_ERROR';
export function engineeringValue(raw:any){if(raw?.ok===false)throw new MemoryError('SDK_BUSINESS',safeCode(raw.error?.code));exact(raw,['ok','value']);check(raw.ok===true&&raw.value&&typeof raw.value==='object'&&!Array.isArray(raw.value),'ENGINEERING_SDK_ENVELOPE');return raw.value;}
export function checkEngineeringCapture(c:LocalConfig,p:ReturnType<typeof prepareEngineering>,raw:any){const q=engineeringValue(raw);check(p.event&&Object.entries(memoryScope(c)).filter(([k])=>k!=='role').every(([k,v])=>q[k]===v)&&word(q.revision_id)&&word(q.record_id)&&word(q.source_id)&&q.mandatory===false&&q.execution_verified===false&&q.owner_confirmation_verified===false&&q.actor_identity_verified===false&&q.epistemic_state===p.value.epistemic_state,'ENGINEERING_CAPTURE_REFERENCE');return q;}
/** Parse a complete acknowledged child envelope before a later local revalidation can fail. */
export function engineeringChildAcknowledgement(c:LocalConfig,p:ReturnType<typeof prepareEngineering>,raw:any){
 // This records a capture receipt only. The split caller separately validates
 // both status values and every current guard before authorizing physical read.
 if(raw?.format==='xdev-engineering-capture-child-1'){exact(raw,['format','before','capture','after','save_acknowledged','readback_acknowledged']);check(p.event&&p.event.previous_revision_id===null&&p.value.revises===undefined&&p.event.correction===null&&raw.save_acknowledged===true&&raw.readback_acknowledged===false,'ENGINEERING_CAPTURE_ONLY_ENVELOPE');checkEngineeringCapture(c,p,raw.capture);return true;}
 if(raw?.format==='xdev-engineering-child-j01-error-1'){exact(raw,['format','layer','code','capture','save_acknowledged','readback_acknowledged','health_after']);check(['SDK_BUSINESS','CONTRACT'].includes(raw.layer)&&typeof raw.code==='string'&&/^[A-Z0-9_:-]{1,128}$/.test(raw.code)&&raw.readback_acknowledged===false&&raw.health_after===null,'ENGINEERING_ERROR_ENVELOPE');if(raw.capture!==null)checkEngineeringCapture(c,p,raw.capture);check(raw.save_acknowledged===(raw.capture!==null),'ENGINEERING_ERROR_ACK');return raw.capture!==null;}
 if(raw?.format==='xdev-engineering-child-1'){exact(raw,['format','before','capture','result','after',...(p.event?.correction?['previous']:[]),...(p.dependency?['dependency_lifecycle']:[])]);if(raw.capture!==null)checkEngineeringCapture(c,p,raw.capture);return raw.capture!==null;}return false;
}
export function checkEngineeringStatus(c:LocalConfig,raw:any){
 const v=engineeringValue(raw),m=c.memory_bridge!,p=v.policy,rt=v.runtime,l=v.storage_location,mode=selectMemoryBoundary(c)?.boundary.mode??'CUSTOM_LOCAL';
 check(v.project_root===c.project_root&&v.project_id===m.project_id&&v.configured===true&&v.automatic_hooks===false&&v.policy_hash===m.policy_hash&&hash(canonical(p))===m.policy_hash&&p?.schema_version===1&&p.mode==='SEMI_AUTO'&&p.enabled===true&&p.workspace_id===m.workspace_id&&p.default_role==='developer'&&same(p.allowed_roles,['developer'])&&m.limits.payload_bytes<=p.payload_budget_bytes,'ENGINEERING_STATUS_POLICY');
 check(rt?.build_id===enabled(c).build_id&&Object.hasOwn(ENGINEERING_CONTRACTS,rt.build_id)&&rt.contract_version===sdkCompanionContract(rt.build_id)&&rt.profile==='sdk'&&rt.identity_observation==='ON_DISK_AT_STATUS_CALL_NOT_LOADED_MODULE_ATTESTATION'&&rt.capabilities?.ordinary_tool_count===sdkOrdinaryToolCount(rt.build_id)&&rt.capabilities.authenticated_identity===false,'ENGINEERING_STATUS_BUILD');
 check(l?.configured===true&&l.mode===mode&&l.storage_root===m.storage_root&&l.location_hash===m.location_hash&&l.custom_identity_verified===(mode==='CUSTOM_LOCAL'),'ENGINEERING_STATUS_LOCATION');
}
export function checkEngineeringContext(c:LocalConfig,prepared:ReturnType<typeof prepareEngineering>,raw:any){
 const v=engineeringValue(raw),q=prepared.query!;
 const contract=ENGINEERING_CONTRACTS[enabled(c).build_id],bodyHash=contract==='xmem-engineering/2';check(contract,'ENGINEERING_BUILD_UNSUPPORTED');
 exact(v,['contract','read_only','mode','status','payload','payload_bytes','payload_sha256','budget_basis','payload_budget_bytes','requested_files','coverage','telemetry']);
 check(v.contract===contract&&v.read_only===true&&v.mode==='context'&&['READY','EMPTY','INCOMPLETE'].includes(v.status)&&v.budget_basis==='UTF8_PUBLIC_JSONL_ITEMS_AND_EXPANSION_REFERENCES'&&v.payload_budget_bytes===q.payload_budget_bytes,'ENGINEERING_CONTEXT_CONTRACT');
 check(typeof v.payload==='string'&&Buffer.byteLength(v.payload)===v.payload_bytes&&v.payload_bytes<=q.payload_budget_bytes&&hash(v.payload)===v.payload_sha256,'ENGINEERING_CONTEXT_PAYLOAD');
 exact(v.coverage,['incomplete','reasons','semantic_completeness_guaranteed','expand']);
 check(typeof v.coverage.incomplete==='boolean'&&list(v.coverage.reasons,8)&&v.coverage.incomplete===(v.status==='INCOMPLETE')&&(v.coverage.reasons.length>0)===v.coverage.incomplete&&v.coverage.semantic_completeness_guaranteed===false&&v.coverage.expand==='USE_RETURNED_REFERENCE_OR_REPEAT_NARROWER_QUERY','ENGINEERING_CONTEXT_COVERAGE');
 check(Array.isArray(v.requested_files)&&v.requested_files.length===q.files.length&&v.requested_files.every((x:any,i:number)=>{exact(x,['path','status']);return x.path===q.files[i]&&['PRESENT','MISSING_OR_RENAMED'].includes(x.status);}), 'ENGINEERING_REQUESTED_FILES');
 const lines=v.payload===''?[]:v.payload.split('\n').map((line:string)=>memoryJson(line));let complete=0;const seen=new Set<string>();
 for(const item of lines){
  const r=item.reference;exact(r,['project_id','workspace_id','task_ref','task_version','role','revision_id','source_id','source_content_hash','binding_hash','policy_hash',...(bodyHash?['record_content_hash']:[])]);check(!bodyHash||hex(r.record_content_hash),'ENGINEERING_CONTEXT_RECORD_HASH');
  check(q.allowed_source_ids===undefined||q.allowed_source_ids.includes(r.source_id),'ENGINEERING_CONTEXT_SOURCE_ALLOWANCE');
  check(Object.entries(memoryScope(c)).every(([k,value])=>r[k]===value)&&r.policy_hash===c.memory_bridge!.policy_hash&&word(r.revision_id)&&word(r.source_id)&&hex(r.source_content_hash)&&hex(r.binding_hash)&&!seen.has(r.revision_id),'ENGINEERING_CONTEXT_REFERENCE');seen.add(r.revision_id);
  if(item.available_by_reference===true){exact(item,['available_by_reference','reference','reason']);check(v.status==='INCOMPLETE'&&['PAYLOAD_BUDGET','RESULT_OR_NODE_LIMIT'].includes(item.reason),'ENGINEERING_OMITTED_REFERENCE');continue;}
  exact(item,['revision_id','source_id','source_content_hash','information_type','match_reasons','persisted','epistemic_state','applicability','mandatory','execution_verified','actor_identity_verified','preview_only','reference','content',...(bodyHash?['record_content_hash']:[])]);
  check(item.revision_id===r.revision_id&&item.source_id===r.source_id&&item.source_content_hash===r.source_content_hash&&(!bodyHash||item.record_content_hash===r.record_content_hash)&&item.persisted==='SAVED'&&['ASSERTED','HYPOTHESIS'].includes(item.epistemic_state)&&item.applicability==='NOT_EVALUATED'&&typeof item.mandatory==='boolean'&&item.execution_verified===false&&item.actor_identity_verified===false&&item.preview_only===false&&typeof item.content==='string'&&hash(item.content)===(bodyHash?r.record_content_hash:r.source_content_hash)&&list(item.match_reasons,5),'ENGINEERING_CONTEXT_ITEM');complete++;
 }
 check(complete<=q.limit&&(v.status!=='EMPTY'||lines.length===0)&&(v.status!=='READY'||complete>0),'ENGINEERING_CONTEXT_STATUS');
 const withheld=c.memory_bridge!.required_context&&v.status==='INCOMPLETE';
 return{...v,payload:withheld?null:v.payload,required_context_available:!withheld,payload_withheld:withheld,selected_complete_items:complete,applicability:'NOT_EVALUATED',usable_as_verified_constraint:false,...(c.memory_bridge!.current_facts===undefined?{}:{current_public_facts:currentMemoryFacts(c)})};
}
const CHILD_PROGRESS_STAGES=['ENTRY','INPUT_READY','CONFIG_READY','PREPARE_READY','ENGINEERING_SDK_READY','STANDALONE_SDK_READY','PATHS_READY','BODY_PREPARE_READY','STATUS_BEFORE_READY','READ_ENTER','READ_RETURN','STATUS_AFTER_READY','CORE_NORMAL_RETURN','CORE_ERROR_RETURN','RESULT_READY','ERROR_ENVELOPE','READ_GUARD_READY','IMAGE_ONE_ENTER','IMAGE_ONE_RETURN','QUERY_ENTER','QUERY_RETURN','IMAGE_TWO_ENTER','IMAGE_TWO_RETURN','READ_REVALIDATED'];
function engineeringChildProgress(stderr:Buffer){
 const entries:{stage:string;elapsed_ms:number}[]=[],seen=new Set<string>();let previous=-1;
 const unavailable=(status:string)=>({format:'xdev-engineering-child-progress-1',status,entries:[],last_stage:null,authority:'DIAGNOSTIC_ONLY_NOT_READ_OR_SAVE_PROOF'});
 if(stderr.length>8192)return unavailable('INVALID_BOUND');
 for(const line of stderr.toString('utf8').split(/\r?\n/)){
  if(!line.startsWith('XDEV_J01_STAGE_V1|'))continue;
  const match=/^XDEV_J01_STAGE_V1\|([A-Z_]+)\|([0-9]{1,8})$/.exec(line);
  if(!match||Buffer.byteLength(line,'utf8')>96)return unavailable('INVALID_MARKER');
  const stage=match[1]!,elapsed_ms=Number(match[2]);
  if(!CHILD_PROGRESS_STAGES.includes(stage)||seen.has(stage)||entries.length>=14||elapsed_ms<previous)return unavailable('INVALID_MARKER');
  if((stage==='CORE_NORMAL_RETURN'&&seen.has('CORE_ERROR_RETURN'))||(stage==='CORE_ERROR_RETURN'&&seen.has('CORE_NORMAL_RETURN')))return unavailable('INVALID_MARKER');
  entries.push({stage,elapsed_ms});seen.add(stage);previous=elapsed_ms;
 }
 return{format:'xdev-engineering-child-progress-1',status:entries.length?'OBSERVED':'NOT_OBSERVED',entries,last_stage:entries.at(-1)?.stage??null,authority:'DIAGNOSTIC_ONLY_NOT_READ_OR_SAVE_PROOF'};
}
export type EngineeringLaunch={stdout:Buffer;stderr:Buffer;pid:number|undefined;status:number|null;signal:string|null;error?:{code?:string;message?:string}};
export function launchEngineering(local:Local,action:EngineeringAction,source:FileRef,mode:'capture'|'capture-only'|'read'|'query',revision:string|null,spawn:typeof spawnSync=spawnSync,deadline?:number):EngineeringLaunch{
 const m=local.config.memory_bridge!,child=fileURLToPath(new URL('./engineering-child.ts',import.meta.url));bytes(child);
 const input=Buffer.from(JSON.stringify({config_path:local.configPath,config_sha256:local.configHash,action,source,mode,revision,...(deadline===undefined?{}:{deadline_unix_ms:deadline})}));check(input.length<=16384,'ENGINEERING_CHILD_INPUT_BOUND');
 return spawn(m.node.path,['--experimental-strip-types',child],{cwd:local.config.project_root,shell:false,windowsHide:true,timeout:deadline===undefined?Math.min(m.limits.call_ms,m.limits.total_ms):Math.max(1,deadline-Date.now()),maxBuffer:m.limits.response_bytes,env:getDefaultEnvironment(),input,encoding:'buffer'});
}
/** Launcher and fixed-reader injection are module-only TEST_ONLY seams; neither
 * can be selected by a public tool argument or configuration field. */
export function bridgeEngineering(local:Local,args:{action:string;source?:FileRef},onSideEffect:()=>void,launch:typeof launchEngineering=launchEngineering,physicalRead:typeof readStandaloneChild=readStandaloneChild){
 const base={format:'xdev-memory-result-1',action:args.action,execution_allowed:false,delivery_allowed:false,claim_reset:false,native_identity_authenticated:false,actor_identity_verified:false,owner_confirmation_verified:false,execution_verified:false,applicability:'NOT_EVALUATED',authority:'UNTRUSTED_MEMORY_DATA_ONLY',automatic_retry:false};
 const startedOperation=Date.now();let operation:ReturnType<typeof memoryBoundaryOperation>|undefined;let state:ReturnType<typeof beginMemoryOperation>|undefined,p:ReturnType<typeof prepareEngineering>|undefined,called=false,claimed=false,saveAcknowledged=false,readbackAcknowledged=false,diagnostic:any=null,acknowledgedCapture:any=null;
 const health=()=>{
  const query=nativeJointQuery(local.config);
  if(!query)return operation!.health();
  operation!.check();
  const result=nativeRelatedHealth(local,query,operation!.deadline());
  operation!.check();
  return result;
 };
 try{
  operation=memoryBoundaryOperation(local.config,startedOperation);health();exact(args,['action','source']);check(args.source,'ENGINEERING_SOURCE_REQUIRED');const action=args.action as EngineeringAction;p=prepareEngineering(local,action,args.source);
  const childPath=fileURLToPath(new URL('./engineering-child.ts',import.meta.url)),childHash=hash(bytes(childPath));
  if(p.event){if(action==='engineering-reconcile')state=inspectMemoryOperation(local.config.control_root,p.event.intent);else{onSideEffect();claimed=true;state=beginMemoryOperation(local.config.control_root,p.event.intent);}}
  if(p.e.build_id===E7_NATIVE_BUILD&&action==='engineering-capture'&&state?.created===false){
   claimed=false;
   throw new MemoryError('CONTRACT','ENGINEERING_NATIVE_CAPTURE_INTENT_ALREADY_EXISTS');
  }
  // J01: an explicit, fresh-event reconcile is a read, not a capture/query.
  // Reuse the same fixed physical reader already used after split capture.
  // All parent preparation/health checks remain fresh; no validation cache,
  // retry, new intent, SDK change, or larger per-call/whole-operation budget.
  if(operation.selected&&action==='engineering-reconcile'&&p.event&&
     p.dependency===null&&p.event.previous_revision_id===null&&
     p.value.revises===undefined&&p.event.correction===null){
   const m=local.config.memory_bridge!,event=p.event;
   const readerPath=fileURLToPath(new URL('./standalone-read-child.ts',import.meta.url));
   const readerHash=hash(bytes(readerPath));
   const revalidateRead=()=>{
    operation!.check();
    // Intent/confirmation may have changed in a coordinator callback or while
    // reading. Fail closed before using a stale operation observation.
    check(same(state,inspectMemoryOperation(local.config.control_root,event.intent)),
     'ENGINEERING_OPERATION_DRIFT');
    check(same(p,prepareEngineering(local,action,args.source!)),'ENGINEERING_PREPARATION_DRIFT');
    check(same(operation!.selected,selectMemoryBoundary(local.config)),'ENGINEERING_BOUNDARY_DRIFT');
    check(childHash===hash(bytes(childPath))&&readerHash===hash(bytes(readerPath)),'ENGINEERING_CHILD_DRIFT');
    operation!.check();
   };
   revalidateRead();
   // The coordinator callback may consume budget or fail. It is not a grant
   // to use an earlier observation: revalidate again before the fixed read.
   onSideEffect();revalidateRead();
   const readEnd=operation.deadline(),started=Date.now();
   diagnostic={route:'BOUND_PHYSICAL_RECONCILE_V1',elapsed_ms:0,
    node_sha256:m.node.sha256,child_sha256:readerHash,sdk_build:p.e.build_id,
    read_deadline_unix_ms:readEnd,global_descendant_closure:'NOT_CLAIMED',
    transport_details:'OWNED_BY_FIXED_READER_NOT_OBSERVED_HERE'};
   called=true;let value:any;
   try{
    // readStandaloneChild returns the inner SDK value, not {ok,value}.
    value=physicalRead(local,{task_ref:m.task_ref,task_version:m.task_version,
     role:'developer',memory_key:event.intent.memory_key,
     revision_id:state!.confirmation?.revision_id??null,
     payload_budget_bytes:m.limits.payload_bytes},readEnd,p.e.build_id===E7_NATIVE_BUILD?args.source:undefined);
   }finally{diagnostic.elapsed_ms=Date.now()-started;}
   const fixedTransport=value?.[Symbol.for('xdev.fixed-read.transport')];
   if(fixedTransport!==undefined){
    const {stdout_utf8,stderr_utf8,...transportMetadata}=fixedTransport;
    diagnostic.fixed_read_transport=transportMetadata;
   }
   check(Date.now()<readEnd,'ENGINEERING_READ_DEADLINE');operation.check();
   const read=checkReadback(local.config,value,event.content,
    state!.confirmation?.revision_id??null,event.previous_revision_id);
   readbackAcknowledged=read.readback==='COMPLETE';
   // Complete historical content is a read ACK, never a CURRENT/ACTIVE
   // confirmation. Recheck current inputs/health even on NOT_FOUND/budget.
   if(readbackAcknowledged&&read.status==='SAVED'){
    const confirmation:MemoryConfirmation={format:'xdev-memory-confirmation-1',
     intent_sha256:state!.intent_sha256,revision_id:read.revision_id!,
     record_id:read.record_id!,source_id:read.source_id!,package_id:null,
     payload_sha256:read.payload_sha256!,source_content_sha256:event.intent.content_sha256};
    // Notification is not a purity/authority guarantee. Run the existing
    // final health + source checks AFTER it, with no intervening callback.
    onSideEffect();health();revalidateRead();
    confirmMemoryOperation(local.config.control_root,event.intent,confirmation);
   }else{health();revalidateRead();}
   operation.check();
   // The in-process audit uses the original stream only after scoped readback
   // validation and final revalidation. MCP projects this to metadata.
   if(readbackAcknowledged&&fixedTransport!==undefined)diagnostic.fixed_read_transport=fixedTransport;
   return{...base,...read,saved:read.persisted,memory_key:event.intent.memory_key,
    operation_id:event.intent.id,previous_revision_id:null,replacement_relation:'NONE',
    replayed_locally:true,sdk_read_only:true,child_launch_attempted:true,
    save_acknowledged:false,readback_acknowledged:readbackAcknowledged,boundary:null,
    delivery:{recipient:m.recipient,status:'PREPARED_FOR_COORDINATOR_RETURN',
     received:'NOT_OBSERVED',adoption:'NOT_OBSERVED',host_injected:false},diagnostic};
  }
  const mode=p.event?(action==='engineering-capture'&&state!.created?'capture':'read'):'query';
  const split=!!(operation.selected&&action==='engineering-capture'&&state?.created&&p.event&&p.event.previous_revision_id===null&&p.value.revises===undefined&&p.event.correction===null);
  const readChildPath=fileURLToPath(new URL('./standalone-read-child.ts',import.meta.url)),readChildHash=split?hash(bytes(readChildPath)):null;
  const revalidateSplit=()=>{operation!.check();check(same(p,prepareEngineering(local,action,args.source!)),'ENGINEERING_PREPARATION_DRIFT');check(same(operation!.selected,selectMemoryBoundary(local.config)),'ENGINEERING_BOUNDARY_DRIFT');check(childHash===hash(bytes(childPath))&&readChildHash===hash(bytes(readChildPath)),'ENGINEERING_CHILD_DRIFT');operation!.check();};
  onSideEffect();called=true;const started=Date.now(),captureEnd=operation.selected?operation.deadline():undefined,out=launch(local,action,args.source,split?'capture-only':mode,state?.confirmation?.revision_id??null,undefined,captureEnd);
  diagnostic={pid:out.pid??null,exit_code:out.status,signal:out.signal,error_code:out.error?.code??null,elapsed_ms:Date.now()-started,stdout_bytes:out.stdout?.length??0,stdout_sha256:hash(out.stdout??Buffer.alloc(0)),stderr_bytes:out.stderr?.length??0,stderr_sha256:hash(out.stderr??Buffer.alloc(0)),node_sha256:local.config.memory_bridge!.node.sha256,child_sha256:childHash,sdk_build:p.e.build_id,global_descendant_closure:'NOT_CLAIMED',progress:engineeringChildProgress(out.stderr??Buffer.alloc(0))};
  const limits=local.config.memory_bridge!.limits;
  if(operation.selected&&!out.error&&!out.signal&&out.status===0&&(split?Buffer.isBuffer(out.stdout)&&Buffer.isBuffer(out.stderr)&&out.stdout.length+out.stderr.length<=limits.response_bytes&&out.stderr.length<=limits.stderr_bytes:out.stdout?.length<=limits.response_bytes)){const observed=json(out.stdout);saveAcknowledged=engineeringChildAcknowledgement(local.config,p,observed);if(saveAcknowledged){const q=observed.capture.value;acknowledgedCapture={scope:memoryScope(local.config),memory_key:p.event?.intent.memory_key??null,revision_id:q.revision_id,record_id:q.record_id,source_id:q.source_id};}check(mode==='capture'||!saveAcknowledged,'ENGINEERING_UNEXPECTED_CAPTURE');}
  if(!split){prepareEngineering(local,action,args.source);check(childHash===hash(bytes(childPath)),'ENGINEERING_CHILD_DRIFT');}
  if(out.error||out.signal||out.status!==0)throw new MemoryError('TRANSPORT',out.error?.code==='ETIMEDOUT'?'ENGINEERING_CHILD_TIMEOUT':out.error?.code==='ENOBUFS'?'ENGINEERING_CHILD_OVERFLOW':'ENGINEERING_CHILD_EXIT');
  const m=local.config.memory_bridge!;check(Buffer.isBuffer(out.stdout)&&Buffer.isBuffer(out.stderr)&&out.stdout.length+out.stderr.length<=m.limits.response_bytes&&out.stderr.length<=m.limits.stderr_bytes,'ENGINEERING_STDIO_BOUND');
  const raw=json(out.stdout);if(raw?.format==='xdev-engineering-child-j01-error-1'){exact(raw,['format','layer','code','capture','save_acknowledged','readback_acknowledged','health_after']);if(raw.capture!==null){check(p.event&&mode==='capture','ENGINEERING_UNEXPECTED_CAPTURE');checkEngineeringCapture(local.config,p,raw.capture);saveAcknowledged=true;}check(raw.save_acknowledged===saveAcknowledged&&raw.readback_acknowledged===false,'ENGINEERING_ERROR_ACK');throw new MemoryError(raw.layer==='SDK_BUSINESS'?'SDK_BUSINESS':'CONTRACT',safeCode(raw.code));}if(raw?.format==='xdev-engineering-child-error-1'){exact(raw,['format','layer','code']);throw new MemoryError(raw.layer==='SDK_BUSINESS'?'SDK_BUSINESS':'CONTRACT',safeCode(raw.code));}
  if(split){
   // An error envelope may retain a factual save ACK, but never authorizes read.
   check(raw.format==='xdev-engineering-capture-child-1'&&engineeringChildAcknowledgement(local.config,p,raw),'ENGINEERING_CAPTURE_ONLY_ENVELOPE');
   checkEngineeringStatus(local.config,raw.before);checkEngineeringStatus(local.config,raw.after);
   check(captureEnd!==undefined&&Date.now()<captureEnd,'ENGINEERING_CAPTURE_DEADLINE');operation.check();
   // The complete capture-only response must validate inside its original
   // absolute call window. Caller graph work is a separate operation phase;
   // it still runs freshly here and again before read/confirmation below.
   revalidateSplit();
   const q=checkEngineeringCapture(local.config,p,raw.capture),event=p.event!;
   health();revalidateSplit();
   const readEnd=operation.deadline(),value=physicalRead(local,{task_ref:m.task_ref,task_version:m.task_version,role:'developer',memory_key:event.intent.memory_key,revision_id:q.revision_id,payload_budget_bytes:m.limits.payload_bytes},readEnd,p.e.build_id===E7_NATIVE_BUILD?args.source:undefined);
   check(Date.now()<readEnd,'ENGINEERING_READ_DEADLINE');operation.check();
   // The fixed reader already returns the inner SDK value. Do not unwrap it.
   const read=checkReadback(local.config,value,event.content,q.revision_id,event.previous_revision_id);
   if(read.readback==='COMPLETE'){check(read.record_id===q.record_id&&read.source_id===q.source_id,'ENGINEERING_CAPTURE_READ_REFERENCE');readbackAcknowledged=true;}
   // A complete historical read is an ACK, never a fresh-save confirmation.
   if(readbackAcknowledged&&read.status==='SAVED'){
    const confirmation:MemoryConfirmation={format:'xdev-memory-confirmation-1',intent_sha256:state!.intent_sha256,revision_id:read.revision_id!,record_id:read.record_id!,source_id:read.source_id!,package_id:null,payload_sha256:read.payload_sha256!,source_content_sha256:event.intent.content_sha256};
    // Move, rather than duplicate, the final validation phase. The callback
    // cannot turn a pre-callback observation into a fresh confirmation.
    onSideEffect();health();revalidateSplit();
    confirmMemoryOperation(local.config.control_root,event.intent,confirmation);
   }else{health();revalidateSplit();}
   operation.check();return{...base,...read,saved:read.persisted,memory_key:event.intent.memory_key,operation_id:event.intent.id,previous_revision_id:event.previous_revision_id,replacement_relation:'NONE',replayed_locally:false,sdk_read_only:false,child_launch_attempted:true,save_acknowledged:saveAcknowledged,readback_acknowledged:readbackAcknowledged,boundary:null,delivery:{recipient:m.recipient,status:'PREPARED_FOR_COORDINATOR_RETURN',received:'NOT_OBSERVED',adoption:'NOT_OBSERVED',host_injected:false},diagnostic};
  }
  exact(raw,['format','before','capture','result','after',...(p.event?.correction?['previous']:[]),...(p.dependency?['dependency_lifecycle']:[])]);check(raw.format==='xdev-engineering-child-1','ENGINEERING_CHILD_ENVELOPE');checkEngineeringStatus(local.config,raw.before);checkEngineeringStatus(local.config,raw.after);if(p.dependency)checkDependencyLifecycle(local.config,'engineering',raw.dependency_lifecycle);
  let response:any;
  if(!p.event){check(raw.capture===null,'ENGINEERING_UNEXPECTED_CAPTURE');
   // An indivisible mandatory item is never truncated to manufacture READY.
   response=raw.result?.ok===false&&raw.result.error?.code==='BUDGET_UNSATISFIABLE'?{status:'INCOMPLETE',payload:null,payload_bytes:0,payload_sha256:null,payload_withheld:true,required_context_available:!m.required_context,coverage:{incomplete:true,reasons:['BUDGET_UNSATISFIABLE'],semantic_completeness_guaranteed:false},error:{layer:'SDK_BUSINESS',code:'BUDGET_UNSATISFIABLE'}}:checkEngineeringContext(local.config,p,raw.result);
  }
  else{
   let revision=state!.confirmation?.revision_id??null;
   if(mode==='capture'){
    const q=engineeringValue(raw.capture);check(Object.entries(memoryScope(local.config)).filter(([k])=>k!=='role').every(([k,v])=>q[k]===v)&&word(q.revision_id)&&word(q.record_id)&&word(q.source_id)&&q.mandatory===false&&q.execution_verified===false&&q.owner_confirmation_verified===false&&q.actor_identity_verified===false&&q.epistemic_state===p.value.epistemic_state,'ENGINEERING_CAPTURE_REFERENCE');saveAcknowledged=true;revision=q.revision_id;
   }else check(raw.capture===null,'ENGINEERING_UNEXPECTED_CAPTURE');
   const read=checkReadback(local.config,engineeringValue(raw.result),p.event.content,revision,p.event.previous_revision_id);readbackAcknowledged=read.readback==='COMPLETE';
   if(saveAcknowledged&&readbackAcknowledged){const q=raw.capture.value;check(read.record_id===q.record_id&&read.source_id===q.source_id,'ENGINEERING_CAPTURE_READ_REFERENCE');}
   response={...read,saved:read.persisted,memory_key:p.event.intent.memory_key,operation_id:p.event.intent.id,previous_revision_id:p.event.previous_revision_id,replacement_relation:p.event.previous_revision_id===null?'NONE':'EXPLICIT_MEMORY_KEY_AND_PREDECESSOR_CAS',replayed_locally:!state!.created};
   if(p.event.correction){const previous=checkReadback(local.config,engineeringValue(raw.previous),p.event.correction.content,p.event.previous_revision_id,p.event.correction.previous_revision_id);check(previous.readback==='COMPLETE','ENGINEERING_PREVIOUS_FULL_READBACK_REQUIRED');response={...response,correction_basis:p.event.correction,full_readbacks:{current:raw.result,previous:raw.previous},previous_readback:previous};}
   if(readbackAcknowledged){
    const confirmation:MemoryConfirmation={format:'xdev-memory-confirmation-1',intent_sha256:state!.intent_sha256,revision_id:read.revision_id!,record_id:read.record_id!,source_id:read.source_id!,package_id:null,payload_sha256:read.payload_sha256!,source_content_sha256:p.event.intent.content_sha256};
    onSideEffect();health();operation.check();
    check(same(p,prepareEngineering(local,action,args.source)),'ENGINEERING_PREPARATION_DRIFT');
    check(same(operation.selected,selectMemoryBoundary(local.config)),'ENGINEERING_BOUNDARY_DRIFT');
    check(childHash===hash(bytes(childPath)),'ENGINEERING_CHILD_DRIFT');
    operation.check();confirmMemoryOperation(local.config.control_root,p.event.intent,confirmation);
   }
  }
  if(!p.event||!readbackAcknowledged){health();operation.check();}operation.check();return{...base,...response,...(p.dependency?{dependency_lifecycle:raw.dependency_lifecycle}:{}),sdk_read_only:mode!=='capture',child_launch_attempted:true,save_acknowledged:saveAcknowledged,readback_acknowledged:readbackAcknowledged,boundary:p.event?null:p.value.boundary,delivery:{recipient:m.recipient,status:'PREPARED_FOR_COORDINATOR_RETURN',received:'NOT_OBSERVED',adoption:'NOT_OBSERVED',host_injected:false},diagnostic};
 }catch(e){const error=e instanceof MemoryError||e instanceof RelatedProtocolError?e:engineeringValidationError(e);return{...base,status:called||claimed?'UNKNOWN':'REFUSED',saved:'UNKNOWN',readback:'NOT_CONFIRMED',operation_id:p?.event?.intent.id??null,memory_key:p?.event?.intent.memory_key??null,child_launch_attempted:called,save_acknowledged:saveAcknowledged,readback_acknowledged:readbackAcknowledged,acknowledged_capture:acknowledgedCapture,error:{layer:error.layer,code:error.code,...error.diagnostic},diagnostic};}
}

/** Fixed fields only: never echo caller values, paths or exception text. */
export function engineeringValidationError(error:unknown){
 const message=error instanceof Error?error.message:String(error);
 return message==='SUPERVISED_AUTHORIZATION_TIME_INVALID'?new MemoryError('CONTRACT','SUPERVISED_AUTHORIZATION_TIME_INVALID',{fields:['authorization.not_before','authorization.expires_at'],hint:'UTC_ISO_MILLISECONDS_REQUIRED'}):new MemoryError('LOCAL','ENGINEERING_VALIDATION_ERROR',{error_sha256:hash(message)});
}

export async function bridgeEngineeringReadonlyPhase07(local:Local,args:{action:string;source?:FileRef},onSideEffect:()=>void){
 const base={format:'xdev-memory-result-1',action:args.action,execution_allowed:false,delivery_allowed:false,claim_reset:false,native_identity_authenticated:false,actor_identity_verified:false,owner_confirmation_verified:false,execution_verified:false,applicability:'NOT_EVALUATED',authority:'UNTRUSTED_MEMORY_DATA_ONLY',automatic_retry:false};
 const startedOperation=Date.now(),startedMono=process.hrtime.bigint(),whole=wholeClock07(startedOperation,startedMono,Math.min(60000,local.config.memory_bridge?.limits?.total_ms??60000));let phase07Out:any=null;let operation:ReturnType<typeof memoryBoundaryOperation>|undefined;let state:ReturnType<typeof beginMemoryOperation>|undefined,p:ReturnType<typeof prepareEngineering>|undefined,called=false,claimed=false,saveAcknowledged=false,readbackAcknowledged=false,diagnostic:any=null,acknowledgedCapture:any=null;
 const prepare07=()=>{whole.guard();const value=prepareEngineering(local,args.action as EngineeringAction,args.source!);whole.guard();return value;};
 const inspect07=(control:string,intent:MemoryIntent)=>{whole.guard();const value=inspectMemoryOperation(control,intent);whole.guard();return value;};
 try{whole.guard();check(args.action==='engineering-reconcile','P07_FIXED_READONLY');
  const e=local.config.memory_bridge?.engineering;
  check(e?.enabled!==true||e.build_id!==E7_NATIVE_BUILD,'ENGINEERING_NATIVE_PHASE07_UNSUPPORTED');
  operation=memoryBoundaryOperation(local.config,startedOperation);whole.guard();operation.health();whole.guard();exact(args,['action','source']);check(args.source,'ENGINEERING_SOURCE_REQUIRED');const action=args.action as EngineeringAction;p=prepare07();
  const childPath=fileURLToPath(new URL('./engineering-child.ts',import.meta.url)),childHash=hash(bytes(childPath));
  if(p.event){if(action==='engineering-reconcile')state=inspect07(local.config.control_root,p.event.intent);else{whole.guard();onSideEffect();whole.guard();claimed=true;state=beginMemoryOperation(local.config.control_root,p.event.intent);}}
  const mode=p.event?(action==='engineering-capture'&&state!.created?'capture':'read'):'query';
  const split=!!(operation.selected&&action==='engineering-capture'&&state?.created&&p.event&&p.event.previous_revision_id===null&&p.value.revises===undefined&&p.event.correction===null);
  const readChildPath=fileURLToPath(new URL('./standalone-read-child.ts',import.meta.url)),readChildHash=split?hash(bytes(readChildPath)):null;
  const revalidateSplit=()=>{operation!.check();whole.guard();check(same(p,prepare07()),'ENGINEERING_PREPARATION_DRIFT');check(same(operation!.selected,selectMemoryBoundary(local.config)),'ENGINEERING_BOUNDARY_DRIFT');check(childHash===hash(bytes(childPath))&&readChildHash===hash(bytes(readChildPath)),'ENGINEERING_CHILD_DRIFT');operation!.check();whole.guard();};
  const physicalRead=readStandaloneChild;
  const revalidate07=()=>{whole.guard();operation!.check();whole.guard();whole.guard();operation!.health();whole.guard();check(same(p,prepare07()),'ENGINEERING_PREPARATION_DRIFT');check(same(operation!.selected,selectMemoryBoundary(local.config)),'ENGINEERING_BOUNDARY_DRIFT');check(childHash===hash(bytes(childPath)),'ENGINEERING_CHILD_DRIFT');operation!.check();whole.guard();whole.guard();};
  whole.guard();onSideEffect();whole.guard();called=true;const started=Date.now(),captureEnd:number|undefined=undefined,out=await launchReadonlyPhase07(local,args.source,state?.confirmation?.revision_id??null,Math.min(operation.total,whole.wallEnd,Date.now()+Math.floor(whole.remaining()),PHASE07_CUTOFF),p,state!.intent_sha256,revalidate07,whole);phase07Out=out;
  diagnostic={pid:out.pid??null,exit_code:out.status,signal:out.signal,error_code:out.error?.code??null,elapsed_ms:Date.now()-started,stdout_bytes:out.stdout?.length??0,stdout_sha256:hash(out.stdout??Buffer.alloc(0)),stderr_bytes:out.stderr?.length??0,stderr_sha256:hash(out.stderr??Buffer.alloc(0)),node_sha256:local.config.memory_bridge!.node.sha256,child_sha256:childHash,sdk_build:p.e.build_id,global_descendant_closure:'NOT_CLAIMED',progress:engineeringChildProgress(out.stderr??Buffer.alloc(0)),phase07:out.phase07.evidence};
  const limits=local.config.memory_bridge!.limits;
  if(operation.selected&&!out.error&&!out.signal&&out.status===0&&(split?Buffer.isBuffer(out.stdout)&&Buffer.isBuffer(out.stderr)&&out.stdout.length+out.stderr.length<=limits.response_bytes&&out.stderr.length<=limits.stderr_bytes:out.stdout?.length<=limits.response_bytes)){const observed=json(out.stdout);saveAcknowledged=engineeringChildAcknowledgement(local.config,p,observed);if(saveAcknowledged){const q=observed.capture.value;acknowledgedCapture={scope:memoryScope(local.config),memory_key:p.event?.intent.memory_key??null,revision_id:q.revision_id,record_id:q.record_id,source_id:q.source_id};}check(mode==='capture'||!saveAcknowledged,'ENGINEERING_UNEXPECTED_CAPTURE');}
  whole.guard();out.phase07.guard();
  if(split)revalidateSplit();else{prepare07();check(childHash===hash(bytes(childPath)),'ENGINEERING_CHILD_DRIFT');}whole.guard();phase07Out?.phase07.guard();
  if(out.error||out.signal||out.status!==0)throw new MemoryError('TRANSPORT',out.error?.code==='ETIMEDOUT'?'ENGINEERING_CHILD_TIMEOUT':out.error?.code==='ENOBUFS'?'ENGINEERING_CHILD_OVERFLOW':'ENGINEERING_CHILD_EXIT');
  const m=local.config.memory_bridge!;check(Buffer.isBuffer(out.stdout)&&Buffer.isBuffer(out.stderr)&&out.stdout.length+out.stderr.length<=m.limits.response_bytes&&out.stderr.length<=m.limits.stderr_bytes,'ENGINEERING_STDIO_BOUND');
  const raw=json(out.stdout);if(raw?.format==='xdev-engineering-child-j01-error-1'){exact(raw,['format','layer','code','capture','save_acknowledged','readback_acknowledged','health_after']);if(raw.capture!==null){check(p.event&&mode==='capture','ENGINEERING_UNEXPECTED_CAPTURE');checkEngineeringCapture(local.config,p,raw.capture);saveAcknowledged=true;}check(raw.save_acknowledged===saveAcknowledged&&raw.readback_acknowledged===false,'ENGINEERING_ERROR_ACK');throw new MemoryError(raw.layer==='SDK_BUSINESS'?'SDK_BUSINESS':'CONTRACT',safeCode(raw.code));}if(raw?.format==='xdev-engineering-child-error-1'){exact(raw,['format','layer','code']);throw new MemoryError(raw.layer==='SDK_BUSINESS'?'SDK_BUSINESS':'CONTRACT',safeCode(raw.code));}
  if(split){
   // An error envelope may retain a factual save ACK, but never authorizes read.
   check(raw.format==='xdev-engineering-capture-child-1'&&engineeringChildAcknowledgement(local.config,p,raw),'ENGINEERING_CAPTURE_ONLY_ENVELOPE');
   checkEngineeringStatus(local.config,raw.before);checkEngineeringStatus(local.config,raw.after);
   check(captureEnd!==undefined&&Date.now()<captureEnd,'ENGINEERING_CAPTURE_DEADLINE');operation.check();whole.guard();phase07Out?.phase07.guard();
   const q=checkEngineeringCapture(local.config,p,raw.capture),event=p.event!;
   whole.guard();operation.health();whole.guard();revalidateSplit();
   const readEnd=operation.deadline(),value=physicalRead(local,{task_ref:m.task_ref,task_version:m.task_version,role:'developer',memory_key:event.intent.memory_key,revision_id:q.revision_id,payload_budget_bytes:m.limits.payload_bytes},readEnd);
   check(Date.now()<readEnd,'ENGINEERING_READ_DEADLINE');operation.check();whole.guard();phase07Out?.phase07.guard();
   // The fixed reader already returns the inner SDK value. Do not unwrap it.
   const read=checkReadback(local.config,value,event.content,q.revision_id,event.previous_revision_id);
   if(read.readback==='COMPLETE'){check(read.record_id===q.record_id&&read.source_id===q.source_id,'ENGINEERING_CAPTURE_READ_REFERENCE');readbackAcknowledged=true;}
   // A complete historical read is an ACK, never a fresh-save confirmation.
   if(readbackAcknowledged&&read.status==='SAVED'){
    const confirmation:MemoryConfirmation={format:'xdev-memory-confirmation-1',intent_sha256:state!.intent_sha256,revision_id:read.revision_id!,record_id:read.record_id!,source_id:read.source_id!,package_id:null,payload_sha256:read.payload_sha256!,source_content_sha256:event.intent.content_sha256};
    whole.guard();onSideEffect();whole.guard();operation.health();whole.guard();revalidateSplit();
    whole.guard();phase07Out?.phase07.guard();confirmMemoryOperation(local.config.control_root,event.intent,confirmation);whole.guard();phase07Out?.phase07.guard();
   }else{whole.guard();operation.health();whole.guard();revalidateSplit();}
   operation.check();whole.guard();phase07Out?.phase07.guard();return{...base,...read,saved:read.persisted,memory_key:event.intent.memory_key,operation_id:event.intent.id,previous_revision_id:event.previous_revision_id,replacement_relation:'NONE',replayed_locally:false,sdk_read_only:false,child_launch_attempted:true,save_acknowledged:saveAcknowledged,readback_acknowledged:readbackAcknowledged,boundary:null,delivery:{recipient:m.recipient,status:'PREPARED_FOR_COORDINATOR_RETURN',received:'NOT_OBSERVED',adoption:'NOT_OBSERVED',host_injected:false},diagnostic};
  }
  exact(raw,['format','before','capture','result','after',...(p.event?.correction?['previous']:[]),...(p.dependency?['dependency_lifecycle']:[])]);check(raw.format==='xdev-engineering-child-1','ENGINEERING_CHILD_ENVELOPE');checkEngineeringStatus(local.config,raw.before);checkEngineeringStatus(local.config,raw.after);if(p.dependency)checkDependencyLifecycle(local.config,'engineering',raw.dependency_lifecycle);
  let response:any;
  if(!p.event){check(raw.capture===null,'ENGINEERING_UNEXPECTED_CAPTURE');
   // An indivisible mandatory item is never truncated to manufacture READY.
   response=raw.result?.ok===false&&raw.result.error?.code==='BUDGET_UNSATISFIABLE'?{status:'INCOMPLETE',payload:null,payload_bytes:0,payload_sha256:null,payload_withheld:true,required_context_available:!m.required_context,coverage:{incomplete:true,reasons:['BUDGET_UNSATISFIABLE'],semantic_completeness_guaranteed:false},error:{layer:'SDK_BUSINESS',code:'BUDGET_UNSATISFIABLE'}}:checkEngineeringContext(local.config,p,raw.result);
  }
  else{
   let revision=state!.confirmation?.revision_id??null;
   if(mode==='capture'){
    const q=engineeringValue(raw.capture);check(Object.entries(memoryScope(local.config)).filter(([k])=>k!=='role').every(([k,v])=>q[k]===v)&&word(q.revision_id)&&word(q.record_id)&&word(q.source_id)&&q.mandatory===false&&q.execution_verified===false&&q.owner_confirmation_verified===false&&q.actor_identity_verified===false&&q.epistemic_state===p.value.epistemic_state,'ENGINEERING_CAPTURE_REFERENCE');saveAcknowledged=true;revision=q.revision_id;
   }else check(raw.capture===null,'ENGINEERING_UNEXPECTED_CAPTURE');
   const read=checkReadback(local.config,engineeringValue(raw.result),p.event.content,revision,p.event.previous_revision_id);readbackAcknowledged=read.readback==='COMPLETE';
   if(saveAcknowledged&&readbackAcknowledged){const q=raw.capture.value;check(read.record_id===q.record_id&&read.source_id===q.source_id,'ENGINEERING_CAPTURE_READ_REFERENCE');}
   response={...read,saved:read.persisted,memory_key:p.event.intent.memory_key,operation_id:p.event.intent.id,previous_revision_id:p.event.previous_revision_id,replacement_relation:p.event.previous_revision_id===null?'NONE':'EXPLICIT_MEMORY_KEY_AND_PREDECESSOR_CAS',replayed_locally:!state!.created};
   if(p.event.correction){const previous=checkReadback(local.config,engineeringValue(raw.previous),p.event.correction.content,p.event.previous_revision_id,p.event.correction.previous_revision_id);check(previous.readback==='COMPLETE','ENGINEERING_PREVIOUS_FULL_READBACK_REQUIRED');response={...response,correction_basis:p.event.correction,full_readbacks:{current:raw.result,previous:raw.previous},previous_readback:previous};}
   if(readbackAcknowledged){
    const confirmation:MemoryConfirmation={format:'xdev-memory-confirmation-1',intent_sha256:state!.intent_sha256,revision_id:read.revision_id!,record_id:read.record_id!,source_id:read.source_id!,package_id:null,payload_sha256:read.payload_sha256!,source_content_sha256:p.event.intent.content_sha256};
    whole.guard();onSideEffect();whole.guard();revalidate07();
    whole.guard();phase07Out?.phase07.guard();confirmMemoryOperation(local.config.control_root,p.event.intent,confirmation);whole.guard();phase07Out?.phase07.guard();
   }
  }
  if(!p.event||!readbackAcknowledged){whole.guard();operation.health();whole.guard();operation.check();whole.guard();phase07Out?.phase07.guard();}operation.check();whole.guard();phase07Out?.phase07.guard();Object.assign(diagnostic.phase07,phase07Out.phase07.timing());whole.guard();phase07Out.phase07.guard();return{...base,...response,...(p.dependency?{dependency_lifecycle:raw.dependency_lifecycle}:{}),sdk_read_only:mode!=='capture',child_launch_attempted:true,save_acknowledged:saveAcknowledged,readback_acknowledged:readbackAcknowledged,boundary:p.event?null:p.value.boundary,delivery:{recipient:m.recipient,status:'PREPARED_FOR_COORDINATOR_RETURN',received:'NOT_OBSERVED',adoption:'NOT_OBSERVED',host_injected:false},diagnostic};
 }catch(e){const error=e instanceof MemoryError?e:engineeringValidationError(e);return{...base,status:called||claimed?'UNKNOWN':'REFUSED',saved:'UNKNOWN',readback:'NOT_CONFIRMED',operation_id:p?.event?.intent.id??null,memory_key:p?.event?.intent.memory_key??null,child_launch_attempted:called,save_acknowledged:saveAcknowledged,readback_acknowledged:readbackAcknowledged,acknowledged_capture:acknowledgedCapture,error:{layer:error.layer,code:error.code,...error.diagnostic},diagnostic};}finally{phase07Out?.phase07.closeGuard();}
}
