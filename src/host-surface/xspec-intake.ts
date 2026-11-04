/** Local XSpec adapter. Packages and producer claims remain untrusted data. */
import { createHash } from 'node:crypto';
import { closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,writeFileSync } from 'node:fs';
import { basename,dirname,isAbsolute,join,relative,resolve,sep } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formats from 'ajv-formats';
import { canonical } from '../job-runtime/store.ts';
import { parseD1UniqueJson } from '../job-runtime/contracts.ts';
import { inspectSupervisedWriterCapability,withSupervisedWriterLock } from './supervised-writer-lock.ts';
export type FileRef={path:string;sha256:string};
export type IntakeSubject={projectId:string;projectRoot:string;controlRoot:string};
export type IntakeAccess=IntakeSubject&{inputRoot:string;receiveSpecs:boolean;approvedSources:FileRef[];approvedMappings:FileRef[]};
export const XSPEC_FILES=['manifest.json','xspec.json','PRODUCT-VISION.md','TARGET-USERS.md','USER-JOURNEYS.md','FUNCTIONAL-REQUIREMENTS.md','NON-FUNCTIONAL-REQUIREMENTS.md','DATA-AND-PERMISSIONS.md','INTEGRATIONS.md','TECHNICAL-SOLUTION-BLUEPRINT.md','ACCEPTANCE-CRITERIA.md','DECISIONS.md','OUT-OF-SCOPE.md','OPEN-QUESTIONS.md','READINESS-REPORT.md','CHANGELOG.md'];
export const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
export function need(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
export function exact(v:any,keys:string[]){need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|'),'XSPEC_FIELDS_INVALID');}
export const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
export function noLinks(path:string):void{need(isAbsolute(path)&&resolve(path)===path,'XSPEC_CANONICAL_PATH_REQUIRED');const parent=dirname(path);if(parent!==path)noLinks(parent);if(existsSync(path))need(!lstatSync(path).isSymbolicLink(),'XSPEC_LINK_REJECTED');}
export function data(path:string){noLinks(path);const st=lstatSync(path);need(st.isFile()&&st.nlink===1&&st.size<=2*1024*1024,'XSPEC_FILE_INVALID');return readFileSync(path);}
export function text(b:Buffer){return new TextDecoder('utf-8',{fatal:true}).decode(b);}
export function readRef(ref:FileRef){exact(ref,['path','sha256']);need(typeof ref.path==='string'&&typeof ref.sha256==='string'&&/^[a-f0-9]{64}$/.test(ref.sha256),'XSPEC_REF_INVALID');const b=data(ref.path);need(hash(b)===ref.sha256,'XSPEC_INPUT_DRIFT');return text(b);}
export const json=(b:Buffer)=>parseD1UniqueJson(text(b)) as any;
const ajv=new Ajv2020({allErrors:true,coerceTypes:false,removeAdditional:false,useDefaults:false,strict:false});
(formats as unknown as {default:(a:Ajv2020)=>void}).default(ajv);
const xspecValidator=ajv.compile(json(readFileSync(new URL('../../schemas/xmi/xspec-0.3.0.schema.json',import.meta.url))));
const producerValidator=ajv.compile(json(readFileSync(new URL('../../schemas/xmi/producer-evidence.schema.json',import.meta.url))));
export const collections=['product_vision','actors','goals','out_of_scope','user_flows','requirements','acceptance_criteria','data_entities','permission_rules','integrations','non_functional_requirements','decisions','risks'];
export function rows(x:any):any[]{return collections.flatMap(k=>Array.isArray(x[k])?x[k]:[x[k]]);}
const rank:Record<string,number>={FAST_VALIDATION:0,FAST_DEVELOPMENT:1,PRODUCT_GRADE:2};
export const profiles:Record<string,string>={FAST_VALIDATION:'prototype',FAST_DEVELOPMENT:'quick_verified',PRODUCT_GRADE:'full_governance'};
function references(x:any){
 const all=[...rows(x),...x.reference_records],ids=all.map(r=>r.id);need(new Set(ids).size===ids.length,'XSPEC_DUPLICATE_ID');
 for(const row of rows(x))for(const field of ['links','actor_ids','acceptance_criterion_ids','requirement_ids'])for(const id of row[field]??[]){
  need(ids.includes(id),'XSPEC_REFERENCE_MISSING');const target=({actor_ids:'actors',acceptance_criterion_ids:'acceptance_criteria',requirement_ids:'requirements'} as any)[field];
  if(target)need(x[target].some((r:any)=>r.id===id),'XSPEC_REFERENCE_TYPE_INVALID');
 }
 for(const o of x.delivery_profile.scope_overrides){need(o.scope_ids.every((id:string)=>rows(x).some(r=>r.id===id)||x.reference_records.some((r:any)=>r.id===id&&r.kind==='CONFIRMED_CONSTRAINT')),'XSPEC_SCOPE_REFERENCE_INVALID');need(rank[o.minimum_mode]!>=rank[x.delivery_profile.project_mode]!,'XSPEC_SCOPE_FLOOR_INVALID');need(o.resolution!=='UPGRADE_PROJECT'||o.minimum_mode===x.delivery_profile.project_mode,'XSPEC_PROJECT_UPGRADE_INVALID');}
}
function producer(x:any,m:any){
 const e=m.producer_evidence;if(e===undefined)return {status:'NOT_PROVIDED',source_coverage:'UNAVAILABLE',sufficient:false};
 need((producerValidator as (v:any)=>boolean)(e),'XSPEC_PRODUCER_SCHEMA_INVALID');
 const subject={project_id:m.project_id,product_model_version:m.product_model_version,spec_id:m.spec_id,spec_version:m.spec_version,canonical_xspec_sha256:m.canonical_xspec_sha256};
 need(same(e.subject,subject),'XSPEC_PRODUCER_SUBJECT_MISMATCH');
 need(e.mode_selection.project_mode===x.delivery_profile.project_mode&&e.mode_selection.selection_source===x.delivery_profile.selection_source,'XSPEC_PRODUCER_MODE_MISMATCH');
 const required=[...rows(x),...x.reference_records.filter((r:any)=>r.kind==='CONFIRMED_CONSTRAINT')],confirmations=e.item_confirmations as any[];
 need(new Set(confirmations.map(c=>c.item_id)).size===confirmations.length,'XSPEC_PRODUCER_DUPLICATE_ITEM');
 need(required.every(r=>confirmations.some(c=>c.item_id===r.id)),'XSPEC_PRODUCER_ITEM_SET_MISMATCH');
 // R2: exactly one extra ID commits to the single no-ID blueprint position.
 // The shared subject canonical hash binds that position, not native identity.
 const extra=confirmations.filter(c=>!required.some(r=>r.id===c.item_id));
 need(extra.length===1,'XSPEC_PRODUCER_BLUEPRINT_REFERENCE_UNAVAILABLE');
 need(!x.reference_records.some((r:any)=>r.id===extra[0].item_id),'XSPEC_PRODUCER_BLUEPRINT_ID_CONFLICT');
 const blueprintKind=x.solution_blueprint.status==='DELEGATED_TO_XDEV'?'SOLUTION_BLUEPRINT_DELEGATED':'SOLUTION_BLUEPRINT_APPROVED';
 if(extra[0].event)need(extra[0].event.command_kind===blueprintKind,'XSPEC_PRODUCER_BLUEPRINT_KIND_MISMATCH');
 const refs=(value:any[])=>value.map(v=>({type:v.type,ref:v.ref}));
 const sourceMatch=(list:any[],event:any)=>list.some(r=>same({type:r.type,ref:r.ref},event.owner_source_ref));
 for(const c of confirmations)need(Number.isSafeInteger(c.item_version)&&c.item_version>=1&&c.item_version<=m.product_model_version,'XSPEC_PRODUCER_ITEM_VERSION_INVALID');
 for(const r of required){const c=confirmations.find(c=>c.item_id===r.id);
  if(r.item_version!==undefined)need(c.item_version===r.item_version,'XSPEC_PRODUCER_ITEM_VERSION_MISMATCH');
  if(c.event){need(c.event.command_kind===(x.decisions.some((d:any)=>d.id===r.id)?'DECISION_APPROVED':'ITEM_CONFIRMED'),'XSPEC_PRODUCER_ITEM_KIND_MISMATCH');
   need(Array.isArray(r.source_refs)&&sourceMatch(r.source_refs,c.event),'XSPEC_PRODUCER_ITEM_SOURCE_MISMATCH');}
 }
 need(e.scope_dispositions.length===x.delivery_profile.scope_overrides.length&&new Set(e.scope_dispositions.map((o:any)=>o.id)).size===e.scope_dispositions.length,'XSPEC_PRODUCER_SCOPE_SET_MISMATCH');
 for(const o of x.delivery_profile.scope_overrides){const p=e.scope_dispositions.find((v:any)=>v.id===o.id);
  need(p&&same([...p.scope_ids].sort(),[...o.scope_ids].sort())&&p.minimum_mode===o.minimum_mode&&p.resolution===o.resolution,'XSPEC_PRODUCER_SCOPE_MISMATCH');
  need(new Set(p.source_refs.map((r:any)=>canonical(r))).size===p.source_refs.length,'XSPEC_PRODUCER_SCOPE_SOURCE_DUPLICATE');
  if(o.source_refs!==undefined)need(same(refs(o.source_refs).sort((a:any,b:any)=>canonical(a).localeCompare(canonical(b))),refs(p.source_refs).sort((a:any,b:any)=>canonical(a).localeCompare(canonical(b)))),'XSPEC_PRODUCER_SCOPE_SOURCE_MISMATCH');
  if(p.event)need(p.event.command_kind==='MODE_OVERRIDE_RESOLVED'&&sourceMatch(p.source_refs,p.event),'XSPEC_PRODUCER_SCOPE_SOURCE_MISMATCH');
 }
 const parts=[{key:'mode',value:e.mode_selection},...confirmations.map(c=>({key:'item:'+c.item_id,value:c})),...e.scope_dispositions.map((o:any)=>({key:'scope:'+o.id,value:o}))];
 const eventIds=new Map<string,string>(),versions=new Set<number>(),hashes=new Set<string>();
 for(const p of parts)if(p.value.event){const event=p.value.event;
  need(Number.isSafeInteger(event.event_version)&&event.event_version>=1&&event.event_version<=m.product_model_version,'XSPEC_PRODUCER_EVENT_VERSION_INVALID');
  // One domain command event cannot confirm two different exported subjects.
  need(!eventIds.has(event.event_id)&&!versions.has(event.event_version)&&!hashes.has(event.event_hash),'XSPEC_PRODUCER_EVENT_ASSOCIATION_CONFLICT');
  eventIds.set(event.event_id,p.key);versions.add(event.event_version);hashes.add(event.event_hash);
 }
 const available=parts.filter(p=>p.value.status==='SOURCE_REFERENCED_NOT_AUTHENTICATED').length,coverage=available===parts.length?'COMPLETE':available===0?'UNAVAILABLE':'PARTIAL';
 need(e.source_coverage===coverage,'XSPEC_PRODUCER_COVERAGE_MISMATCH');
 return {status:e.evidence_status,source_coverage:coverage,sufficient:coverage==='COMPLETE',authentication:'NOT_AUTHENTICATED',blueprint_identity:'PRODUCER_REFERENCE_ONLY',simple_item_versions:'PRODUCER_REFERENCE_ONLY',scope_sources:'PRODUCER_REFERENCE_ONLY',visible_item_source:'EXACT_EVENT_SOURCE_TYPE_REF_MEMBER',event_hash:'PRODUCER_REFERENCE_ONLY',sufficiency:'R2_SOURCE_REFERENCES_ONLY_NOT_EXECUTION_APPROVAL'};
}
export function inspectXspecPackage(manifest:FileRef){
 need(basename(manifest.path)==='manifest.json','XSPEC_MANIFEST_NAME_REQUIRED');const manifestText=readRef(manifest),m=parseD1UniqueJson(manifestText) as any,root=dirname(manifest.path);
 need(same(readdirSync(root).sort(),[...XSPEC_FILES].sort()),'XSPEC_FILESET_INVALID');
 exact(m,['package_version','xspec_schema_version','spec_id','spec_version','project_id','product_model_version','generated_at','xmi_version','xdev_min_version','xui_min_version','canonical_xspec_sha256','files','file_sha256','manifest_self_hash_policy','compatibility_note',...(m.producer_evidence===undefined?[]:['producer_evidence'])]);
 need(m.package_version==='0.3.0'&&m.xspec_schema_version==='0.3.0'&&same(m.files,XSPEC_FILES)&&m.manifest_self_hash_policy==='MANIFEST_NOT_SELF_HASHED_TO_AVOID_RECURSION','XSPEC_MANIFEST_INVALID');
 exact(m.file_sha256,XSPEC_FILES.slice(1));
 const members=XSPEC_FILES.map(name=>{const b=data(join(root,name));text(b);need(name==='manifest.json'||hash(b)===m.file_sha256[name],'XSPEC_PAYLOAD_HASH_MISMATCH');return {name,sha256:hash(b),bytes:b};});
 need(members.reduce((n,b)=>n+b.bytes.length,0)<=2*1024*1024,'XSPEC_PACKAGE_TOO_LARGE');
 const x=json(members.find(m=>m.name==='xspec.json')!.bytes);need((xspecValidator as (v:any)=>boolean)(x),'XSPEC_SCHEMA_INVALID');
 const {integrity,...body}=x;need(integrity&&hash(canonical(body))===integrity.canonical_sha256&&m.canonical_xspec_sha256===integrity.canonical_sha256,'XSPEC_CANONICAL_HASH_MISMATCH');
 need(m.spec_id===x.spec_id&&m.spec_version===x.spec_version&&m.project_id===x.project.project_id&&Number.isSafeInteger(m.product_model_version)&&m.product_model_version>0&&m.generated_at===x.generated_at,'XSPEC_IDENTITY_MISMATCH');
 need((x.delivery_profile.handoff_contract_version??'1')==='1','XSPEC_HANDOFF_UNSUPPORTED');references(x);
 const source=producer(x,m),p=x.delivery_profile;
 need(p.readiness_target===({FAST_VALIDATION:'PROTOTYPE_READY',FAST_DEVELOPMENT:'BUILD_READY',PRODUCT_GRADE:'PRODUCT_SPEC_READY'} as any)[p.project_mode],'XSPEC_MODE_INCONSISTENT');
 const missing:string[]=[];
 if(x.readiness.status!=='READY_FOR_XDEV'||x.readiness.blocking_count!==0||!x.readiness.owner_confirmed_export||x.readiness.hard_gates.some((g:any)=>!g.passed)||x.readiness.mode_gap_count!==0)missing.push('PRODUCER_NOT_READY');
 if(!x.profile.supported)missing.push('PRODUCT_PROFILE_UNSUPPORTED');
 if(!source.sufficient)missing.push('PRODUCER_SOURCE_UNAVAILABLE');
 if(x.requirements.some((r:any)=>!r.acceptance_criterion_ids.length))missing.push('REQUIREMENT_AC_MISSING');
 if(x.open_questions?.some((q:any)=>q.status==='BLOCKING'))missing.push('UNRESOLVED_QUESTION');
 return {manifest:m,xspec:x,members,source,readiness:missing.length?'NOT_READY':'SPEC_SUPPORTED',missing,mapped_profile:profiles[p.project_mode]!};
}
function within(root:string,path:string){const r=relative(root,path);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));}
export function validateMapping(s:IntakeSubject,mapping:FileRef,pkg:ReturnType<typeof inspectXspecPackage>){
 const m=parseD1UniqueJson(readRef(mapping)) as any;exact(m,['format','source','target']);exact(m.source,['project_id','spec_id','spec_version','product_model_version']);exact(m.target,['project_id','project_root']);
 need(m.format==='xdev-xspec-mapping-1'&&same(m.source,Object.fromEntries(['project_id','spec_id','spec_version','product_model_version'].map(k=>[k,pkg.manifest[k]])))&&same(m.target,{project_id:s.projectId,project_root:s.projectRoot}),'XSPEC_MAPPING_MISMATCH');return m;
}
export function intakeIdentity(s:IntakeSubject,pkg:ReturnType<typeof inspectXspecPackage>){return hash(canonical({project_id:s.projectId,source_project_id:pkg.manifest.project_id,spec_id:pkg.manifest.spec_id,spec_version:pkg.manifest.spec_version,product_model_version:pkg.manifest.product_model_version}));}
export function intakeDirectory(s:IntakeSubject,id:string){need(/^[a-f0-9]{64}$/.test(id),'XSPEC_INTAKE_ID_INVALID');return join(s.controlRoot,'xspec-intakes',id);}
function receiptValue(s:IntakeSubject,manifest:FileRef,mapping:FileRef,pkg:ReturnType<typeof inspectXspecPackage>){return {format:'xdev-xspec-intake-1',logical_id:intakeIdentity(s,pkg),project_id:s.projectId,project_root:s.projectRoot,manifest,mapping,members:pkg.members.map(m=>({name:m.name,sha256:m.sha256})),readiness:pkg.readiness,missing:pkg.missing,source:pkg.source,mapped_profile:pkg.mapped_profile,execution_allowed:false};}
export function readIntake(s:IntakeSubject,manifest:FileRef,mapping:FileRef){
 const pkg=inspectXspecPackage(manifest);validateMapping(s,mapping,pkg);const expected=receiptValue(s,manifest,mapping,pkg),dir=intakeDirectory(s,expected.logical_id),raw=data(join(dir,'receipt.json'));
 need(text(raw)===canonical(expected)+'\n','XSPEC_INTAKE_CONFLICT');
 need(same(readdirSync(dir).sort(),['receipt.json','mapping.json',...XSPEC_FILES].sort()),'XSPEC_INTAKE_INCOMPLETE');
 need(hash(data(join(dir,'mapping.json')))===mapping.sha256,'XSPEC_MAPPING_COPY_DRIFT');
 for(const m of pkg.members)need(hash(data(join(dir,m.name)))===m.sha256,'XSPEC_INTAKE_COPY_DRIFT');
 return {receipt:expected,receipt_sha256:hash(raw),pkg,replayed:true};
}
export function receiveXspec(s:IntakeAccess,manifest:FileRef,mapping:FileRef,beforeWrite:()=>void=()=>{}){
 need(s.receiveSpecs===true,'XSPEC_RECEIVE_PERMISSION_REQUIRED');
 need(s.approvedSources.some(r=>same(r,manifest))&&s.approvedMappings.some(r=>same(r,mapping)),'XSPEC_RECEIVE_NOT_APPROVED');
 need(within(s.inputRoot,manifest.path)&&within(s.inputRoot,mapping.path),'XSPEC_SOURCE_OUTSIDE_INPUT_ROOT');
 for(const a of [s.projectRoot,s.controlRoot,s.inputRoot]){noLinks(a);need(lstatSync(a).isDirectory(),'XSPEC_ROOT_INVALID');}
 need([s.projectRoot,s.controlRoot,s.inputRoot].every((a,i,all)=>all.every((b,j)=>i===j||!within(a,b))),'XSPEC_ROOTS_OVERLAP');
 const pkg=inspectXspecPackage(manifest);validateMapping(s,mapping,pkg);const receipt=receiptValue(s,manifest,mapping,pkg),dir=intakeDirectory(s,receipt.logical_id);
 if(existsSync(dir)){need(existsSync(join(dir,'receipt.json')),'XSPEC_INTAKE_UNKNOWN_RECONCILE_ONLY');return readIntake(s,manifest,mapping);}
 const capability=inspectSupervisedWriterCapability(s.controlRoot);need(capability.status==='SUPPORTED','XSPEC_WRITER_UNSUPPORTED');
 const id=receipt.logical_id.slice(0,32),jobId='job:'+id.slice(0,8)+'-'+id.slice(8,12)+'-'+id.slice(12,16)+'-'+id.slice(16,20)+'-'+id.slice(20);
 beforeWrite();return withSupervisedWriterLock(s.controlRoot,jobId,assertHeld=>{
  if(existsSync(dir)){need(existsSync(join(dir,'receipt.json')),'XSPEC_INTAKE_UNKNOWN_RECONCILE_ONLY');return readIntake(s,manifest,mapping);}
  const fresh=inspectXspecPackage(manifest);validateMapping(s,mapping,fresh);need(same(receiptValue(s,manifest,mapping,fresh),receipt),'XSPEC_SOURCE_DRIFT');
  mkdirSync(dirname(dir),{recursive:true});assertHeld();mkdirSync(dir);
  const save=(path:string,b:Buffer|string)=>{assertHeld();const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,b);fsyncSync(fd);}finally{closeSync(fd);}};
  for(const m of fresh.members)save(join(dir,m.name),m.bytes);save(join(dir,'mapping.json'),data(mapping.path));
  inspectXspecPackage(manifest);readRef(mapping);assertHeld();save(join(dir,'receipt.json'),canonical(receipt)+'\n');
  const result=readIntake(s,manifest,mapping);return {...result,replayed:false};
 });
}
export function intakeResult(r:ReturnType<typeof readIntake>){return {...r.receipt,receipt_sha256:r.receipt_sha256,replayed:r.replayed,readback:'COMPLETE',received:true,adoption:'NOT_OBSERVED',execution_allowed:false};}

/** Shared CLI/MCP receive/read route; no second Store and no implicit approval. */
export function runXspecAction(local:{config:any;configPath:string;configHash:string},action:'receive'|'read',source:FileRef,read:(r:FileRef)=>string,beforeWrite:()=>void=()=>{}){
 const c=local.config;need(hash(data(local.configPath))===local.configHash,'XSPEC_LOCAL_CONFIG_DRIFT');
 const i=c.spec_intake;need(i?.enabled===true,'XSPEC_INTAKE_UNSUPPORTED');
 const q=parseD1UniqueJson(read(source)) as any;exact(q,['format','manifest','mapping']);need(q.format==='xdev-xspec-intake-request-1','XSPEC_INTAKE_REQUEST_INVALID');
 read(q.manifest);read(q.mapping);need(i.approved_sources.some((r:FileRef)=>same(r,q.manifest))&&i.approved_mappings.some((r:FileRef)=>same(r,q.mapping)),'XSPEC_RECEIVE_NOT_APPROVED');
 const s={projectId:c.project_id,projectRoot:c.project_root,controlRoot:c.control_root,inputRoot:c.input_root,receiveSpecs:c.permissions?.receive_specs===true,approvedSources:i.approved_sources,approvedMappings:i.approved_mappings};
 return intakeResult(action==='receive'?receiveXspec(s,q.manifest,q.mapping,()=>{need(hash(data(local.configPath))===local.configHash,'XSPEC_LOCAL_CONFIG_DRIFT');beforeWrite();}):readIntake(s,q.manifest,q.mapping));
}
