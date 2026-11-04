import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseUniqueJson } from '../planning/retry-history.ts';
import { projectRootIdentity, readProjectFile, readVerifiedD1Init } from '../project-model/init-receipt.ts';
import { JobStore, canonical, productionJobRoot } from '../job-runtime/store.ts';
import { d1WorkerMessage, parseD1UniqueJson, validateD1CurrentObservation,
  validateD1HostObservationBytes } from '../job-runtime/contracts.ts';
import type { Job, JobId, TaskId } from '../job-runtime/contracts.ts';

function fail(code:string):never {throw Error(code);}
function need(ok:unknown,code:string):asserts ok {if(!ok)fail(code);}
function exact(value:unknown,keys:string[],code='D1_ROLE_SOURCE_INVALID'):asserts value is Record<string,any> {
  need(value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('|')===[...keys].sort().join('|'),code);
}
const word=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=8192;
const rawRecord=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=1024*1024;
const testMarker=(v:string)=>/\bTEST[_ -]?ONLY\b|\btest[-_ ]?harness\b/i.test(v);
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const hex=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const time=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)).toISOString()===v;
const integer=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
function plainFile(path:string):Buffer {
  need(isAbsolute(path)&&resolve(path)===path,'D1_ROLE_PATH_INVALID');
  for(let part=path;;){let stat;try{stat=lstatSync(part);}catch{fail('D1_ROLE_SOURCE_MISSING');}
    need(!stat.isSymbolicLink(),'D1_ROLE_LINKED_SOURCE');if(part===resolve(part, '..'))break;const parent=resolve(part,'..');if(parent===part)break;part=parent;}
  const stat=lstatSync(path);need(stat.isFile()&&stat.nlink===1&&stat.size<=1024*1024,'D1_ROLE_SOURCE_INVALID');
  need(realpathSync.native(path)===path,'D1_ROLE_PATH_ALIAS');return readFileSync(path);
}
function inside(parent:string,path:string){const rel=relative(parent,path);return rel!==''&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);}
/** Current project files outside .xdev, including existing changes; no historical-clean claim. */
export function workspaceDigest(root:string,protocol:'legacy'|'d1-a'='legacy'):string {
  const entries:{path:string;sha256:string}[]=[];
  const walk=(dir:string,prefix:string)=>{
    for(const name of readdirSync(dir).sort()){
      if(!prefix&&(name==='.xdev'||protocol==='d1-a'&&name==='.xdev-d1-control'))continue;
      const path=join(dir,name),rel=prefix?prefix+'/'+name:name,stat=lstatSync(path);
      need(!stat.isSymbolicLink(),'D1_ROLE_LINKED_SOURCE');
      if(stat.isDirectory())walk(path,rel);
      else {need(stat.isFile()&&stat.nlink===1&&stat.size<=16*1024*1024,'D1_ROLE_WORKSPACE_UNSUPPORTED');entries.push({path:rel,sha256:sha(readFileSync(path))});}
      need(entries.length<=10000,'D1_ROLE_WORKSPACE_TOO_LARGE');
    }
  };
  walk(root,'');return sha(canonical(entries));
}
export type RoleRegistration={
  format:'xdev-d1-role-registration-1';project_id:string;job_id:JobId;task_id:TaskId;task_key:string;
  workspace_root:string;control_root:string;workspace_identity:string;control_identity:string;contract_sha256:string;
  authorization:{source_kind:'TEST_ONLY'|'COORDINATOR_RECORDED_OWNER_MESSAGE';source_ref:string;excerpt:string;checked_by:string;checked_at:string;
    project_id:string;job_id:JobId;task_id:TaskId;contract_sha256:string;role:'Worker';model:string;effort:string;
    allowed_scope:string[];forbidden_scope:string[];expires_at:string;max_calls:number;project_slot_limit:number;task_slot_limit:number;
    external_effects:'NONE'|'PROJECT_WRITE_ONLY';hard_cost_limit_requested:boolean};
  resources:{project_resource_id:string;task_resource_id:string;project_limit:number;task_limit:number;ledger_root:string;ledger_version:'xdev-d1-role-domain-1'};
  history:{baseline:'NEW_REGISTERED_DOMAIN'|'OBSERVED_PRIOR_RECORDS'|'UNKNOWN';coverage:'THIS_REGISTERED_DOMAIN_ONLY';source_ref:string;parent_source_ref:string;
    project_consumed:number;project_holds:number;task_consumed:number;task_holds:number;
    prior_holds:{id:string;project_slots:number;task_slots:number;source_ref:string}[];known_stop:boolean;unknown_prior:boolean};
  workspace:{observed_at:string;workspace_identity:string;contract_sha256:string;files_sha256:string;write_access:'COORDINATOR_OBSERVED'|'UNKNOWN';
    writers:{id:string;state:'ENDED'|'ACTIVE'|'UNKNOWN';source_ref:string}[];known_external_writers:'NONE_OBSERVED'|'UNKNOWN'};
  host_observation:{kind:'TEST_ONLY'|'COORDINATOR_RECORDED_HOST_OBSERVATION';source_ref:string;observed_at:string;visible_fields:string[];
    uncovered_scope:string;has_unresolved_run:boolean};
};
export type RoleSource={registration:RoleRegistration;registration_path:string;registration_sha256:string;job:Job;job_revision:number;
  source_watermark:string;task_contract_sha256:string;create_input_sha256:string;test_only:boolean;dispatch_scope:string[]};

export function readRoleSource(registrationPath:string,controlRoot:string,projectId:string,workspaceRoot:string,jobId:JobId,taskId:TaskId,
  mode:'INITIAL'|'FROZEN_FOR_SEND'='INITIAL'):RoleSource {
  need(isAbsolute(controlRoot)&&resolve(controlRoot)===controlRoot&&isAbsolute(workspaceRoot)&&resolve(workspaceRoot)===workspaceRoot,'D1_ROLE_PATH_INVALID');
  need(inside(controlRoot,registrationPath)&&!inside(workspaceRoot,registrationPath),'D1_ROLE_REGISTRATION_LOCATION');
  const bytes=plainFile(registrationPath),registration_sha256=sha(bytes);
  let raw:unknown;try{raw=parseUniqueJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('D1_ROLE_SOURCE_INVALID');}
  exact(raw,['format','project_id','job_id','task_id','task_key','workspace_root','control_root','workspace_identity','control_identity','contract_sha256','authorization','resources','history','workspace','host_observation']);
  const r=raw as RoleRegistration;
  need(r.format==='xdev-d1-role-registration-1'&&r.project_id===projectId&&r.job_id===jobId&&r.task_id===taskId&&
    r.workspace_root===workspaceRoot&&r.control_root===controlRoot&&hex(r.contract_sha256),'D1_ROLE_SUBJECT_DRIFT');
  const workspaceIdentity=projectRootIdentity(workspaceRoot).identity,controlIdentity=projectRootIdentity(controlRoot).identity;
  need(r.workspace_identity===workspaceIdentity&&r.control_identity===controlIdentity,'D1_ROLE_ROOT_DRIFT');
  const store=new JobStore(productionJobRoot(controlRoot,projectId),{project_id:projectId,workspace_root:workspaceRoot});
  const {job,create}=store.inspectJobSource(jobId),task=job.tasks.find(x=>x.task_id===taskId);
  const create_input_sha256=sha(canonical(create.input));
  need(job.d1_intake?.admission==='NOT_ADMITTED'&&task&&task.key===r.task_key&&task.state==='PENDING'&&
    !job.cancellation_requested&&!['BLOCKED','CANCELLED','FAILED'].includes(job.state)&&job.runs.length===0,'D1_ROLE_JOB_UNAVAILABLE');
  const createdTask=create.input.tasks.find(x=>x.key===task.key);
  need(createdTask&&createdTask.contract_ref.sha256===r.contract_sha256&&task.contract_ref.sha256===r.contract_sha256,'D1_ROLE_CONTRACT_DRIFT');
  const artifact=readProjectFile(workspaceRoot,`.xdev/tasks/${task.key}.json`);
  need(sha(artifact)===r.contract_sha256,'D1_ROLE_CONTRACT_DRIFT');
  const source=readVerifiedD1Init(workspaceRoot),seedTask=source.seed.tasks.find(x=>x.task_id===task.key);
  need(seedTask&&source.receipt.root_identity===workspaceIdentity,'D1_ROLE_SOURCE_DRIFT');
  let taskArtifact:unknown;try{taskArtifact=parseUniqueJson(new TextDecoder('utf-8',{fatal:true}).decode(artifact));}
  catch{fail('D1_ROLE_CONTRACT_DRIFT');}
  need(taskArtifact!==null&&typeof taskArtifact==='object'&&!Array.isArray(taskArtifact),
    'D1_ROLE_CONTRACT_DRIFT');
  const expectedOutputs=(taskArtifact as {expected_outputs?:unknown}).expected_outputs;
  const exactFile=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=8192&&
    !value.startsWith('/')&&!value.includes('\\')&&!value.endsWith('/')&&
    !value.split('/').some(part=>part===''||part==='.'||part==='..'||part.includes(':'));
  // B1 accepts descriptive expected outputs. Exact file targets are a B2 send
  // prerequisite only; registration, inspection and preparation retain B1 semantics.
  if(mode==='FROZEN_FOR_SEND')need(Array.isArray(expectedOutputs)&&expectedOutputs.length>0&&
    expectedOutputs.every(exactFile)&&new Set(expectedOutputs).size===expectedOutputs.length&&
    canonical(expectedOutputs)===canonical(seedTask.expected_outputs),'D1_ROLE_EXACT_OUTPUT_SCOPE_INVALID');
  exact(r.authorization,['source_kind','source_ref','excerpt','checked_by','checked_at','project_id','job_id','task_id','contract_sha256','role','model','effort','allowed_scope','forbidden_scope','expires_at','max_calls','project_slot_limit','task_slot_limit','external_effects','hard_cost_limit_requested']);
  const a=r.authorization;
  need(['TEST_ONLY','COORDINATOR_RECORDED_OWNER_MESSAGE'].includes(a.source_kind)&&word(a.source_ref)&&word(a.excerpt)&&word(a.checked_by)&&time(a.checked_at)&&time(a.expires_at)&&
    Date.parse(a.checked_at)<=Date.now()&&Date.parse(a.expires_at)>Date.now()&&a.project_id===projectId&&a.job_id===jobId&&a.task_id===taskId&&
    a.contract_sha256===r.contract_sha256&&a.role==='Worker'&&word(a.model)&&word(a.effort)&&a.max_calls===1&&
    integer(a.project_slot_limit)&&integer(a.task_slot_limit)&&a.project_slot_limit>0&&a.task_slot_limit>0&&
    ['NONE','PROJECT_WRITE_ONLY'].includes(a.external_effects)&&a.hard_cost_limit_requested===false,'D1_ROLE_AUTHORIZATION_INVALID');
  need(canonical(a.allowed_scope)===canonical(seedTask.allowed_scope)&&canonical(a.forbidden_scope)===canonical(seedTask.forbidden_scope),'D1_ROLE_SCOPE_DRIFT');
  const within=(path:string,scope:string)=>path===scope||path.startsWith(scope.endsWith('/')?scope:scope+'/');
  if(mode==='FROZEN_FOR_SEND')need((expectedOutputs as string[]).every(output=>
    a.allowed_scope.some(scope=>within(output,scope))&&
    !a.forbidden_scope.some(scope=>within(output,scope))),'D1_ROLE_EXACT_OUTPUT_SCOPE_INVALID');
  exact(r.resources,['project_resource_id','task_resource_id','project_limit','task_limit','ledger_root','ledger_version']);
  need(word(r.resources.project_resource_id)&&word(r.resources.task_resource_id)&&integer(r.resources.project_limit)&&integer(r.resources.task_limit)&&
    r.resources.project_limit===a.project_slot_limit&&r.resources.task_limit===a.task_slot_limit&&
    r.resources.ledger_root===controlRoot&&r.resources.ledger_version==='xdev-d1-role-domain-1','D1_ROLE_RESOURCE_INVALID');
  exact(r.history,['baseline','coverage','source_ref','parent_source_ref','project_consumed','project_holds','task_consumed','task_holds','prior_holds','known_stop','unknown_prior']);
  const h=r.history;
  need(h.baseline!=='UNKNOWN'&&['NEW_REGISTERED_DOMAIN','OBSERVED_PRIOR_RECORDS'].includes(h.baseline)&&h.coverage==='THIS_REGISTERED_DOMAIN_ONLY'&&
    word(h.source_ref)&&word(h.parent_source_ref)&&[h.project_consumed,h.project_holds,h.task_consumed,h.task_holds].every(integer)&&
    Array.isArray(h.prior_holds)&&h.known_stop===false&&h.unknown_prior===false,'D1_ROLE_HISTORY_UNKNOWN_OR_STOP');
  for(const hold of h.prior_holds){exact(hold,['id','project_slots','task_slots','source_ref']);
    need(word(hold.id)&&word(hold.source_ref)&&integer(hold.project_slots)&&integer(hold.task_slots)&&
      hold.project_slots+hold.task_slots>0,'D1_ROLE_HISTORY_UNKNOWN_OR_STOP');}
  need(new Set(h.prior_holds.map(hold=>hold.id)).size===h.prior_holds.length&&
    h.prior_holds.reduce((n,hold)=>n+hold.project_slots,0)===h.project_holds&&
    h.prior_holds.reduce((n,hold)=>n+hold.task_slots,0)===h.task_holds,'D1_ROLE_HISTORY_CONFLICT');
  if(h.baseline==='NEW_REGISTERED_DOMAIN')need(h.project_consumed+h.project_holds+h.task_consumed+h.task_holds===0,'D1_ROLE_HISTORY_CONFLICT');
  need(h.project_consumed+h.project_holds<=r.resources.project_limit&&
    h.task_consumed+h.task_holds<=r.resources.task_limit,'D1_ROLE_QUOTA_EXHAUSTED');
  exact(r.workspace,['observed_at','workspace_identity','contract_sha256','files_sha256','write_access','writers','known_external_writers']);
  const w=r.workspace;
  need(time(w.observed_at)&&Date.parse(w.observed_at)<=Date.now()&&(mode==='FROZEN_FOR_SEND'||Date.now()-Date.parse(w.observed_at)<=15*60*1000)&&
    w.workspace_identity===workspaceIdentity&&w.contract_sha256===r.contract_sha256&&w.files_sha256===workspaceDigest(workspaceRoot)&&
    w.write_access==='COORDINATOR_OBSERVED'&&w.known_external_writers==='NONE_OBSERVED'&&Array.isArray(w.writers),'D1_ROLE_WORKSPACE_UNKNOWN_OR_DRIFT');
  for(const writer of w.writers){exact(writer,['id','state','source_ref']);need(word(writer.id)&&word(writer.source_ref)&&writer.state==='ENDED','D1_ROLE_WRITER_ACTIVE_OR_UNKNOWN');}
  exact(r.host_observation,['kind','source_ref','observed_at','visible_fields','uncovered_scope','has_unresolved_run']);
  const host=r.host_observation;
  need(host.kind===(a.source_kind==='TEST_ONLY'?'TEST_ONLY':'COORDINATOR_RECORDED_HOST_OBSERVATION')&&word(host.source_ref)&&time(host.observed_at)&&
    Date.parse(host.observed_at)<=Date.now()&&(mode==='FROZEN_FOR_SEND'||Date.now()-Date.parse(host.observed_at)<=15*60*1000)&&Array.isArray(host.visible_fields)&&
    host.visible_fields.length>0&&host.visible_fields.every(word)&&word(host.uncovered_scope)&&host.has_unresolved_run===false,'D1_ROLE_HOST_OBSERVATION_UNKNOWN');
  if(a.source_kind!=='TEST_ONLY'){
    const provenance=[a.source_ref,a.excerpt,a.checked_by,h.source_ref,h.parent_source_ref,
      ...h.prior_holds.flatMap(hold=>[hold.id,hold.source_ref]),
      ...w.writers.flatMap(writer=>[writer.id,writer.source_ref]),
      host.source_ref,host.uncovered_scope,...host.visible_fields];
    need(!provenance.some(testMarker),'D1_ROLE_TEST_SOURCE_CLAIM');
  }
  const source_watermark=sha(canonical({registration_sha256,job_revision:job.revision,receipt_sha256:source.receipt_sha256,
    contract_sha256:r.contract_sha256,create_input_sha256,workspace_sha256:w.files_sha256,host_observed_at:host.observed_at}));
  return {registration:r,registration_path:registrationPath,registration_sha256,job,job_revision:job.revision,
    source_watermark,task_contract_sha256:r.contract_sha256,create_input_sha256,test_only:a.source_kind==='TEST_ONLY',
    dispatch_scope:mode==='FROZEN_FOR_SEND'?expectedOutputs as string[]:[]};
}

/** Preserve the original registration bytes and all fixed bindings while requiring
 * a separate current observation at send time. Expired B1 snapshots are never
 * promoted to fresh Host or writer facts. */
export function readFrozenRoleSource(registrationPath:string,controlRoot:string,projectId:string,workspaceRoot:string,jobId:JobId,taskId:TaskId){
  return readRoleSource(registrationPath,controlRoot,projectId,workspaceRoot,jobId,taskId,'FROZEN_FOR_SEND');
}

export type WorkspaceFile={path:string;sha256:string};
export function workerMessage(taskKey:string,taskId:TaskId,workspaceRoot:string,contractSha:string,
  allowedScope:string[],forbiddenScope:string[],manifest:WorkspaceFile[]){
  return d1WorkerMessage(taskKey,taskId,workspaceRoot,contractSha,allowedScope,forbiddenScope,manifest);
}
export function workspaceManifest(root:string,protocol:'legacy'|'d1-a'='legacy'):WorkspaceFile[]{
  const entries:WorkspaceFile[]=[];
  const walk=(dir:string,prefix:string)=>{
    for(const name of readdirSync(dir).sort()){
      if(!prefix&&(name==='.xdev'||protocol==='d1-a'&&name==='.xdev-d1-control'))continue;
      const path=join(dir,name),rel=prefix?`${prefix}/${name}`:name,stat=lstatSync(path);
      need(!stat.isSymbolicLink(),'D1_ROLE_LINKED_SOURCE');
      if(stat.isDirectory())walk(path,rel);
      else {need(stat.isFile()&&stat.nlink===1&&stat.size<=16*1024*1024,'D1_ROLE_WORKSPACE_UNSUPPORTED');entries.push({path:rel,sha256:sha(readFileSync(path))});}
      need(entries.length<=10000,'D1_ROLE_WORKSPACE_TOO_LARGE');
    }
  };
  walk(root,'');return entries;
}

export type CurrentWorkerObservation={
  format:'xdev-d1-worker-current-1';source_kind:'TEST_ONLY'|'COORDINATOR_RECORDED_CURRENT';source_ref:string;
  project_id:string;job_id:JobId;task_id:TaskId;attempt_id:string;registration_sha256:string;
  observed_at:string;expires_at:string;job_revision:number;job_head_sha256:string;resource_revision:number;resource_head_sha256:string;
  owner:{source_ref:string;checked_at:string;excerpt:string;applicable_to_current_task:true};
  host:{source_ref:string;observed_at:string;session_ref:string;parent_cwd:string;skill_path:string;skill_sha256:string;
    tool_schema_sha256:string;visible_fields:string[];uncovered_scope:string;active_writers:string[];unknown_writers:string[];
    unresolved_runs:false;context_control:'PARTIAL'};
  workspace:{identity:string;files_sha256:string;manifest:WorkspaceFile[];write_access:'COORDINATOR_OBSERVED'};
  history:{source_ref:string;parent_source_ref:string;relevant_stop:false;relevant_unknown:false;
    project_used_slots:number;task_used_slots:number;project_limit:number;task_limit:number};
  observation_limit:number;deadline_at:string;
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function readCurrentWorkerObservation(path:string,source:RoleSource,attemptId:string,
  expected:{job_revision:number;job_head_sha256:string;resource_revision:number;resource_head_sha256:string}){
  need(inside(source.registration.control_root,path)&&!inside(source.registration.workspace_root,path),'D1_WORKER_CURRENT_LOCATION');
  const bytes=plainFile(path);let raw:unknown;
  try{raw=parseD1UniqueJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch{fail('D1_WORKER_CURRENT_INVALID');}
  const manifest=workspaceManifest(source.registration.workspace_root);
  const v=validateD1CurrentObservation(raw,{registration:source.registration as unknown as Record<string,any>,
    registration_sha256:source.registration_sha256,test_only:source.test_only,
    project_id:source.registration.project_id,job_id:source.registration.job_id,task_id:source.registration.task_id,
    attempt_id:attemptId,now:Date.now(),...expected,workspace_manifest:manifest,
    workspace_digest:workspaceDigest(source.registration.workspace_root)});
  return {value:v as CurrentWorkerObservation,path,sha256:sha(bytes),manifest};
}

export function readFrozenRegistrationBytes(path:string,controlRoot:string,expectedSha:string,expected:RoleRegistration){
  need(inside(controlRoot,path),'D1_WORKER_REGISTRATION_LOCATION');const bytes=plainFile(path);
  need(sha(bytes)===expectedSha,'D1_WORKER_REGISTRATION_DRIFT');let raw:unknown;
  try{raw=parseUniqueJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('D1_WORKER_REGISTRATION_DRIFT');}
  need(canonical(raw)===canonical(expected),'D1_WORKER_REGISTRATION_DRIFT');
  return bytes;
}

export type WorkerHostObservation={format:'xdev-d1-worker-host-observation-1';source_kind:'TEST_ONLY'|'COORDINATOR_TRANSFERRED_HOST_OBSERVATION';
  source_ref:string;project_id:string;job_id:JobId;task_id:TaskId;attempt_id:string;send_id:string;
  observed_at:string;host_session_ref:string;spawn_input_source_ref:string;spawn_output_source_ref:string;
  spawn_input_raw:string;spawn_output_raw:string;observation_tool:string;observation_input_raw:string;observation_output_raw:string;
  host_agent_id:string|null;host_task_path:string|null;state:'ACTIVE'|'SUCCEEDED'|'FAILED'|'CANCELLED'|'UNKNOWN';
  actual_model:string|null;actual_effort:string|null;final_manifest:WorkspaceFile[]|null;
  writer_source_ref:string;active_writers:string[];unknown_writers:string[]};
type ExpectedHostTransfer={project_id:string;job_id:JobId;task_id:TaskId;
  attempt_id:string;send_id:string;session_ref:string;test_only:boolean;spawn_args:unknown;send_at?:string};
/** The raw bytes are authoritative only as transferred evidence, not as an
 * authenticated Host receipt. Replay uses this same strict parser. */
export function parseWorkerHostObservationBytes(bytes:Buffer,expected:ExpectedHostTransfer){
  const value=validateD1HostObservationBytes(bytes,{...expected,now:Date.now()}) as WorkerHostObservation;
  return {value,bytes,sha256:sha(bytes)};
}
export function readWorkerHostObservation(path:string,controlRoot:string,expected:ExpectedHostTransfer){
  need(inside(controlRoot,path),'D1_WORKER_HOST_LOCATION');
  return parseWorkerHostObservationBytes(plainFile(path),expected);
}
