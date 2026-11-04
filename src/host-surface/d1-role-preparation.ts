import { isAbsolute, resolve } from 'node:path';
import type { JobId, TaskId } from '../job-runtime/contracts.ts';
import { readRoleSource } from '../execution/d1-preparation-source.ts';
import { D1RoleIntentStore } from '../execution/d1-role-intent-store.ts';
import { D1ContextProjectLock } from '../execution/d1-context-project-lock.ts';
import { JobStore, productionJobRoot } from '../job-runtime/store.ts';

export type RoleSubject={jobId:JobId;taskId:TaskId;controlRoot:string;projectId:string;workspaceRoot:string};
export function assertD1ExecutionClosed(subject:RoleSubject){
  const job=new JobStore(productionJobRoot(subject.controlRoot,subject.projectId),
    {project_id:subject.projectId,workspace_root:subject.workspaceRoot}).getJob(subject.jobId);
  if(job.d1_intake)throw Error('D1_INTAKE_READ_ONLY');
  throw Error('D1_ROLE_REQUIRES_SEPARATE_ADMISSION_PROTOCOL');
}
const pending=['CURRENT_OWNER_SOURCE_AND_SCOPE','CURRENT_HOST_IDENTITY_AND_WRITER_STATE','CURRENT_JOB_REVISION_AND_CONTRACT',
  'CURRENT_RESOURCE_AND_PRIOR_HISTORY','WORKSPACE_BYTES_AND_PERMISSIONS','HOST_WIRE_SEND_ADMISSION'];
function domain(subject:RoleSubject){
  if(!isAbsolute(subject.controlRoot)||resolve(subject.controlRoot)!==subject.controlRoot||
    !isAbsolute(subject.workspaceRoot)||resolve(subject.workspaceRoot)!==subject.workspaceRoot||!subject.projectId.trim())throw Error('D1_ROLE_SUBJECT_INVALID');
  return new D1RoleIntentStore(subject.controlRoot,subject.projectId);
}
function source(path:string,subject:RoleSubject){return readRoleSource(path,subject.controlRoot,subject.projectId,subject.workspaceRoot,subject.jobId,subject.taskId);}
const boundary={execution_permitted:false,host_spawned:false,owner_identity_authenticated:false,host_receipt_authenticated:false,
  delivery_claim:'NONE' as const,cost_observation:'UNKNOWN' as const,pending_host_revalidation:pending};

/** The coordinator supplies a cited registration; this CLI verifies bytes and scope,
 * not the actual authorship of an Owner message or Host observation. */
export function registerRoleDomain(subject:RoleSubject,registrationPath:string){
  assertD1ExecutionClosed(subject);
  return new D1ContextProjectLock(subject.controlRoot,subject.projectId).withLock(()=>{
    const observed=source(registrationPath,subject),store=domain(subject),result=store.register(observed,()=>source(registrationPath,subject));
    return {status:result.status,revision:result.revision,project_id:subject.projectId,job_id:subject.jobId,task_id:subject.taskId,
      registration_sha256:observed.registration_sha256,source_watermark:observed.source_watermark,test_only:observed.test_only,...boundary};
  });
}
export function inspectRole(subject:RoleSubject){
  const job=new JobStore(productionJobRoot(subject.controlRoot,subject.projectId),
    {project_id:subject.projectId,workspace_root:subject.workspaceRoot}).getJob(subject.jobId);
  if(job.d1_intake)return {status:job.d1_intake.profile?'D1_PROFILE_ONLY_NOT_EXECUTABLE':'D1_LEGACY_INTAKE_READ_ONLY',
    job_id:subject.jobId,task_id:subject.taskId,profile:job.d1_intake.profile??null,execution_permitted:false};
  const store=domain(subject),path=store.registrationPath(),observed=source(path,subject),view=store.inspect(observed);
  return {status:'ROLE_DOMAIN_INSPECTION',project_id:subject.projectId,job_id:subject.jobId,task_id:subject.taskId,
    registration_sha256:observed.registration_sha256,source_watermark:observed.source_watermark,test_only:observed.test_only,
    ...view,...boundary};
}
export function prepareRole(subject:RoleSubject,requestId:string,refreshPath?:string){
  assertD1ExecutionClosed(subject);
  const store=domain(subject),path=store.registrationPath(),observed=source(path,subject);
  const result=store.prepare(observed,requestId,()=>source(path,subject),refreshPath);
  return {status:'ROLE_INTENT_PREPARED_REQUIRES_HOST_REVALIDATION',project_id:subject.projectId,job_id:subject.jobId,task_id:subject.taskId,
    revision:result.revision,replayed:result.replayed,intent:result.intent,test_only:observed.test_only,...boundary};
}
