import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { canonical, JobStore, productionJobRoot } from '../job-runtime/store.ts';
import { d1WorkerContext, d1WorkerMessageV2, type AgentRunId, type D1ContextRefreshReceipt,
  type D1WorkerObservationCommand, type D1WorkerSendCommand, type D1WorkerSendPacket } from '../job-runtime/contracts.ts';
import { readD1ContextRefresh, verifyD1ContextRefreshSource } from '../execution/d1-context-refresh.ts';
import { D1RoleIntentStore, type RoleSendIntent } from '../execution/d1-role-intent-store.ts';
import { readCurrentWorkerObservation, readFrozenRegistrationBytes, readFrozenRoleSource, readWorkerHostObservation,
  workspaceManifest, workerMessage } from '../execution/d1-preparation-source.ts';
import { assertD1ExecutionClosed, type RoleSubject } from './d1-role-preparation.ts';

const sha=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function need(value:unknown,code:string):asserts value {if(!value)throw Error(code);}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Stores={roles?:D1RoleIntentStore;jobs?:JobStore};
function stores(s:RoleSubject,override:Stores={}){
  need(isAbsolute(s.controlRoot)&&resolve(s.controlRoot)===s.controlRoot&&
    isAbsolute(s.workspaceRoot)&&resolve(s.workspaceRoot)===s.workspaceRoot&&s.projectId.trim(),
    'D1_WORKER_SUBJECT_INVALID');
  return {roles:override.roles??new D1RoleIntentStore(s.controlRoot,s.projectId),
    jobs:override.jobs??new JobStore(productionJobRoot(s.controlRoot,s.projectId),
      {project_id:s.projectId,workspace_root:s.workspaceRoot})};
}
function pair(resource:ReturnType<D1RoleIntentStore['inspectSendDomain']>,
  job:ReturnType<JobStore['inspectD1Journal']>){
  if(!resource.send&&!job.d1_send)return 'NONE' as const;
  need(resource.send&&job.d1_send&&resource.revision===2&&
    resource.send.attempt_id===job.d1_send.attempt_id&&resource.send.send_id===job.d1_send.send_id&&
    resource.send.packet_sha256===job.d1_send.packet_sha256&&
    resource.head_sha256===job.d1_send.resource_head_sha256&&
    canonical(resource.send.packet)===canonical(job.d1_send.packet),'D1_WORKER_CROSS_JOURNAL_STOP');
  return 'MATCHED' as const;
}
function packet(subject:RoleSubject,source:ReturnType<typeof readFrozenRoleSource>,
  current:ReturnType<typeof readCurrentWorkerObservation>,attemptId:string,sendId:string,
  resource:ReturnType<D1RoleIntentStore['inspectSendDomain']>,job:ReturnType<JobStore['inspectD1Journal']>,
  sendRefresh:D1ContextRefreshReceipt|null):D1WorkerSendPacket{
  const a=source.registration.authorization,task=source.job.tasks.find(t=>t.task_id===subject.taskId)!;
  const context=task.d1_context&&resource.prepared?.context_refresh&&sendRefresh?
    d1WorkerContext(task.d1_context,resource.prepared.context_refresh,sendRefresh,
      resource.prepared_event_at!,new Date().toISOString()):null;
  const args={task_name:`d1_worker_${attemptId.replaceAll('-','')}`,agent_type:'worker' as const,model:a.model,
    reasoning_effort:a.effort,fork_turns:'none' as const,
    message:context?d1WorkerMessageV2(task.key,subject.taskId,subject.workspaceRoot,
      task.contract_ref.sha256,source.dispatch_scope,a.forbidden_scope,current.manifest,context):
      workerMessage(task.key,subject.taskId,subject.workspaceRoot,task.contract_ref.sha256,
        source.dispatch_scope,a.forbidden_scope,current.manifest)};
  return {format:context?'xdev-d1-worker-send-2':'xdev-d1-worker-send-1',
    project_id:subject.projectId,job_id:subject.jobId,task_id:subject.taskId,
    attempt_id:attemptId,send_id:sendId,registration_sha256:source.registration_sha256,
    create_input_sha256:source.create_input_sha256,contract_sha256:task.contract_ref.sha256,
    workspace_root:subject.workspaceRoot,authorization_expires_at:a.expires_at,
    resource_revision:resource.revision,resource_head_sha256:resource.head_sha256,
    job_revision:job.revision,job_head_sha256:job.head_sha256,current_observation_path:current.path,
    current_observation_sha256:current.sha256,test_only:source.test_only,
    manifest:current.manifest,allowed_scope:source.dispatch_scope,forbidden_scope:a.forbidden_scope,
    context_pack_refs:job.job.context_pack_refs,
    authority_source_refs:[...new Set([a.source_ref,source.registration.history.source_ref,
      source.registration.history.parent_source_ref,current.value.owner.source_ref])],
    spawn_args:args,host_context:{session_ref:current.value.host.session_ref,parent_cwd:current.value.host.parent_cwd,
      skill_path:current.value.host.skill_path,skill_sha256:current.value.host.skill_sha256,
      tool_schema_sha256:current.value.host.tool_schema_sha256,context_control:'PARTIAL'},
    observation_limit:current.value.observation_limit,deadline_at:current.value.deadline_at,
    stop_conditions:['OWNER_GATE','CANCELLATION','SOURCE_DRIFT','WRITER_CONFLICT','SCOPE_VIOLATION','UNKNOWN_HOST_RESULT'],
    ...(context?{context}:{})};
}

/** This method records one irreversible send intention. It never invokes Host. */
export function sendWorker(subject:RoleSubject,attemptId:string,currentPath:string,override:Stores={},refreshPath?:string){
  assertD1ExecutionClosed(subject);
  need(uuid.test(attemptId),'D1_WORKER_ATTEMPT_INVALID');const {roles,jobs}=stores(subject,override);
  return roles.withProjectLock(()=>jobs.withD1JobLock(subject.jobId,roles,tx=>{
    const resource=roles.inspectSendDomain(),job=tx.inspect();
    need(resource.prepared?.attempt_id===attemptId&&resource.registration.registration.job_id===subject.jobId&&
      resource.registration.registration.task_id===subject.taskId,'D1_WORKER_PREPARED_MISMATCH');
    if(pair(resource,job)==='MATCHED')return {status:'SEND_ALREADY_PERSISTED_STOP' as const,
      host_send_required_once:false as const,attempt_id:attemptId,send_id:resource.send!.send_id,
      job_revision:job.revision,resource_revision:resource.revision};
    need(resource.revision===1&&job.revision===resource.prepared.job_revision,'D1_WORKER_PRE_SEND_DRIFT');
    const source=readFrozenRoleSource(resource.registration.registration_path,subject.controlRoot,subject.projectId,
      subject.workspaceRoot,subject.jobId,subject.taskId);
    need(source.registration_sha256===resource.registration.registration_sha256&&
      source.source_watermark===resource.registration.source_watermark&&
      source.create_input_sha256===resource.registration.create_input_sha256&&
      canonical(source.registration)===canonical(resource.registration.registration),'D1_WORKER_REGISTRATION_DRIFT');
    need(job.job.d1_intake?.admission==='NOT_ADMITTED'&&job.job.state==='QUEUED'&&job.job.runs.length===0&&
      !job.job.cancellation_requested&&job.job.owner_gates.every(g=>g.resolved_ref!==null),'D1_WORKER_ADMISSION_DENIED');
    const task=job.job.tasks.find(t=>t.task_id===subject.taskId);
    need(task?.state==='PENDING'&&task.dependencies.length===0&&task.current_run_id===null&&task.run_ids.length===0,
      'D1_WORKER_TASK_NOT_ROOT_PENDING');
    need((!!task.d1_context)===(!!resource.prepared.context_refresh)&&
      (!!task.d1_context)===(!!refreshPath),'D1_CONTEXT_REFRESH_REQUIRED_BEFORE_SEND');
    if(task.d1_context)verifyD1ContextRefreshSource(resource.prepared.context_refresh!,
      subject.controlRoot,subject.workspaceRoot,task.d1_context,'PREPARE',
      resource.prepared_event_at!);
    const current=readCurrentWorkerObservation(currentPath,source,attemptId,
      {job_revision:job.revision,job_head_sha256:job.head_sha256,resource_revision:resource.revision,
        resource_head_sha256:resource.head_sha256});
    const sendRefresh=task.d1_context?readD1ContextRefresh(refreshPath!,subject.controlRoot,
      subject.workspaceRoot,task.d1_context,'SEND',new Date().toISOString()):null;
    need(!sendRefresh||sendRefresh.host_session_ref===current.value.host.session_ref,
      'D1_CONTEXT_REFRESH_HOST_SESSION_DRIFT');
    const sendId=randomUUID(),runId=`run:${randomUUID()}` as AgentRunId;
    const frozen=packet(subject,source,current,attemptId,sendId,resource,job,sendRefresh),packetSha=sha(frozen);
    const roleCommand:RoleSendIntent={kind:'SEND_INTENT',attempt_id:attemptId,send_id:sendId,
      reservation_id:resource.prepared.reservation_id,packet_sha256:packetSha,packet:frozen,
      job_revision:job.revision,job_head_sha256:job.head_sha256};
    const committedResource=roles.appendSendLocked(roleCommand);
    const jobCommand:D1WorkerSendCommand={kind:'D1_WORKER_SEND_INTENT',task_id:subject.taskId,run_id:runId,
      attempt_id:attemptId,send_id:sendId,reservation_id:resource.prepared.reservation_id,
      packet_sha256:packetSha,packet:frozen,resource_revision:2,resource_head_sha256:committedResource.head_sha256};
    const committedJob=tx.append(job.revision,jobCommand);
    const finalResource=roles.inspectSendDomain(),finalJob=tx.inspect();need(pair(finalResource,finalJob)==='MATCHED'&&
      committedJob.job.revision===finalJob.revision,'D1_WORKER_CROSS_JOURNAL_STOP');
    return {status:'HOST_SEND_REQUIRED_ONCE_IN_CURRENT_TURN' as const,host_send_required_once:true as const,
      host_spawned:false as const,host_receipt_authenticated:false as const,owner_identity_authenticated:false as const,
      job_id:subject.jobId,task_id:subject.taskId,attempt_id:attemptId,send_id:sendId,run_id:runId,
      packet_sha256:packetSha,packet:frozen,job_revision:finalJob.revision,resource_revision:finalResource.revision,
      test_only:source.test_only};
  }));
}

/** Import coordinator-transferred original Host input/output bytes; independent
 * verification must still compare them to the actual Host record. */
export function recordWorker(subject:RoleSubject,attemptId:string,hostPath:string,
  operation:'record-worker'|'reconcile-worker'='record-worker',override:Stores={}){
  assertD1ExecutionClosed(subject);
  need(uuid.test(attemptId),'D1_WORKER_ATTEMPT_INVALID');const {roles,jobs}=stores(subject,override);
  return roles.withProjectLock(()=>jobs.withD1JobLock(subject.jobId,roles,tx=>{
    const resource=roles.inspectSendDomain(),job=tx.inspect();
    need(pair(resource,job)==='MATCHED','D1_WORKER_CROSS_JOURNAL_STOP');
    const send=resource.send!,jSend=job.d1_send!;
    need(send.attempt_id===attemptId&&send.packet.task_id===subject.taskId&&
      send.packet.project_id===subject.projectId,'D1_WORKER_ATTEMPT_MISMATCH');
    readFrozenRegistrationBytes(resource.registration.registration_path,subject.controlRoot,
      resource.registration.registration_sha256,resource.registration.registration);
    const observed=readWorkerHostObservation(hostPath,subject.controlRoot,
      {project_id:subject.projectId,job_id:subject.jobId,task_id:subject.taskId,attempt_id:attemptId,
        send_id:send.send_id,session_ref:send.packet.host_context.session_ref,
        test_only:resource.registration.registration.authorization.source_kind==='TEST_ONLY',
        spawn_args:send.packet.spawn_args,send_at:resource.send_at??undefined});
    need(resource.send_at&&observed.value.observed_at>=resource.send_at,'D1_WORKER_OBSERVATION_BEFORE_SEND');
    const run=job.job.runs.find(r=>r.run_id===jSend.run_id);
    need(run?.d1_worker&&run.d1_worker.attempt_id===attemptId,'D1_WORKER_RUN_MISSING');
    const actual=workspaceManifest(subject.workspaceRoot),value=observed.value;
    const final=value.final_manifest;
    const currentMismatch=final!==null&&canonical(final)!==canonical(actual);
    const evidence=jobs.persistEvidence({format:'xdev-d1-host-transfer-1',source_file_path:hostPath,source_file_sha256:observed.sha256,
      source_file_utf8:observed.bytes.toString('utf8'),current_workspace_manifest:actual,
      current_workspace_mismatch:currentMismatch,coordinator_transfer_only:true});
    const command:D1WorkerObservationCommand={kind:'D1_WORKER_OBSERVATION',run_id:jSend.run_id,
      attempt_id:attemptId,send_id:send.send_id,observed_state:value.state,host_agent_id:value.host_agent_id,
      host_task_path:value.host_task_path,observation_ref:evidence,observed_at:value.observed_at,
      final_manifest_sha256:final===null?null:sha(final),final_manifest:final,
      active_writers:value.active_writers,unknown_writers:[...value.unknown_writers,...(currentMismatch?['CURRENT_WORKSPACE_MISMATCH']:[])],
      actual_model:value.actual_model,actual_effort:value.actual_effort};
    const committed=tx.append(job.revision,command),target=committed.job.tasks.find(t=>t.task_id===subject.taskId)!;
    need(pair(roles.inspectSendDomain(),tx.inspect())==='MATCHED','D1_WORKER_CROSS_JOURNAL_STOP');
    return {status:operation==='reconcile-worker'?'WORKER_RECONCILIATION_RECORDED':'WORKER_OBSERVATION_RECORDED',
      host_send_required_once:false as const,host_spawned:'COORDINATOR_TRANSFERRED_UNAUTHENTICATED' as const,
      host_receipt_authenticated:false as const,owner_identity_authenticated:false as const,
      job_id:subject.jobId,task_id:subject.taskId,attempt_id:attemptId,send_id:send.send_id,run_id:jSend.run_id,
      job_revision:committed.revision,job_state:committed.job.state,task_state:target.state,
      run_state:committed.job.runs.find(r=>r.run_id===jSend.run_id)!.state,
      block_reason:target.d1_worker_block_reason??null,observation_ref:evidence,
      test_only:resource.registration.registration.authorization.source_kind==='TEST_ONLY'};
  }));
}
