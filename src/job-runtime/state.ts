import type { Job, JobCommand, CreateCommand, Task, AgentRun, VerificationReceipt, EvidenceRef, Counters, ResumeObservation, ResumeClass, JobState, TaskState } from './contracts.ts';
import { JOB_STATES, TASK_STATES, RUN_STATES, validateD1ContextBinding,
  validateD1WorkerContext } from './contracts.ts';
import { validateD1ProfileDecision } from '../host-surface/d1-profile-entry.ts';
import {createHash} from 'node:crypto';
const bindingHash=(v:unknown):string=>{const sort=(x:any):any=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;return createHash('sha256').update(JSON.stringify(sort(v))).digest('hex');};

export function check(condition: unknown, code: string): asserts condition { if (!condition) throw Error(code); }
export function exact(v: unknown, keys: string[]): asserts v is Record<string, any> {
  check(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|'), 'JOB_SCHEMA_INVALID');
}
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 8192;
export const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export function jobId(v: unknown) { check(typeof v === 'string' && new RegExp('^job:'+UUID+'$').test(v), 'JOB_ID_INVALID'); }
export function evidence(v: unknown): asserts v is EvidenceRef { exact(v,['id','sha256']); check(text(v.id) && /^[0-9a-f]{64}$/.test(v.sha256), 'JOB_REFERENCE_INVALID'); }
function refs(v: unknown): asserts v is EvidenceRef[] { check(Array.isArray(v), 'JOB_REFERENCE_INVALID'); v.forEach(evidence); check(new Set(v.map(x=>x.id)).size===v.length,'JOB_DUPLICATE_REFERENCE'); }
export function controls(v: unknown) { exact(v,['budget_ref','control_ref','allocation_ref']); Object.values(v).forEach(evidence); }
function strings(v: unknown): asserts v is string[] { check(Array.isArray(v)&&v.every(text)&&new Set(v).size===v.length,'JOB_STRING_LIST_INVALID'); }
function workspace(v: unknown) { exact(v,['workspace_id','repository_id','base_revision','branch_ref','worktree_ref','observed_head','allowed_scope_ref','forbidden_scope_ref','mutability']); for(const k of ['workspace_id','repository_id','base_revision'])check(text(v[k]),'JOB_WORKSPACE_INVALID');for(const k of ['branch_ref','worktree_ref','observed_head'])check(v[k]===null||text(v[k]),'JOB_WORKSPACE_INVALID');evidence(v.allowed_scope_ref);evidence(v.forbidden_scope_ref);check(['READ_ONLY','MUTABLE'].includes(v.mutability),'JOB_WORKSPACE_INVALID'); }
export function timestamp(v: unknown) { check(typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)).toISOString()===v,'JOB_TIME_INVALID'); }
const counts=():Counters=>({retry_count:0,replacement_count:0,escalation_count:0});
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const D1_REQUEST='D1_INTAKE_REQUEST:';
const D1_CONTROL='D1_EXECUTION_NOT_ADMITTED:';
const D1_BASE='D1_INIT_NO_EXECUTION_HEAD';
function d1Intake(c:CreateCommand):Job['d1_intake'] {
  const input=c.input;
  const controls=[input.control_refs,...input.tasks.map(t=>t.control_refs)];
  const marked=input.handoff_refs.some(r=>r.id.startsWith(D1_REQUEST))||
    controls.some(group=>Object.values(group).some(r=>r.id.startsWith(D1_CONTROL)))||
    input.tasks.some(t=>t.workspace.base_revision===D1_BASE);
  if(!marked){check(input.d1_profile===undefined,'D1_PROFILE_WITHOUT_INTAKE');return undefined;}
  check(input.handoff_refs.length===1,'D1_INTAKE_SOURCE_INVALID');
  const request=input.handoff_refs[0]!.id.slice(D1_REQUEST.length);
  check(input.handoff_refs[0]!.id===D1_REQUEST+request&&new RegExp('^'+UUID+'$').test(request)&&c.job_id===`job:${request}`,'D1_INTAKE_SOURCE_INVALID');
  const match=new RegExp('^'+D1_CONTROL+'budget:([0-9a-f]{64})$').exec(input.control_refs.budget_ref.id);
  check(match,'D1_INTAKE_SOURCE_INVALID');const receipt_sha256=match[1]!;
  for(const group of controls)for(const kind of ['budget','control','allocation'] as const){
    const ref=group[`${kind}_ref`];
    check(ref.id===`${D1_CONTROL}${kind}:${receipt_sha256}`&&ref.sha256===digest(kind),'D1_INTAKE_CONTROL_MIXED');
  }
  for(const task of input.tasks){
    check(task.workspace.base_revision===D1_BASE&&task.workspace.observed_head===null&&task.workspace.branch_ref===null&&
      task.workspace.worktree_ref===c.project.workspace_root&&task.contract_ref.id===`.xdev/tasks/${task.key}.json`,
      'D1_INTAKE_SOURCE_INVALID');
  }
  if(input.d1_profile!==undefined){
    validateD1ProfileDecision(input.d1_profile);
    const required=input.d1_profile.gates.map(g=>g.requirement);
    for(const task of input.tasks)check(required.every(g=>task.verification_required.includes(g)),
      'D1_PROFILE_GATES_MISSING');
  }
  return {kind:'D1_INTAKE',request_id:request,receipt_sha256,admission:'NOT_ADMITTED',
    ...(input.d1_profile?{profile:structuredClone(input.d1_profile)}:{})};
}
const safeRun=(r:AgentRun)=>!['PENDING','ACTIVE','UNKNOWN'].includes(r.state);
export const terminalJob=(s:JobState)=>['VERIFIED','PARTIALLY_VERIFIED','FAILED','CANCELLED'].includes(s);
export const JOB_TRANSITIONS: Record<JobState,JobState[]> = {
  QUEUED:['PLANNING','BLOCKED','OWNER_DECISION_REQUIRED','FAILED'], PLANNING:['RUNNING','BLOCKED','VERIFYING','OWNER_DECISION_REQUIRED','FAILED'],
  RUNNING:['BLOCKED','VERIFYING','OWNER_DECISION_REQUIRED','FAILED'], BLOCKED:['PLANNING','RUNNING','VERIFYING','OWNER_DECISION_REQUIRED','FAILED'],
  VERIFYING:['INTEGRATING','BLOCKED','OWNER_DECISION_REQUIRED','FAILED','PARTIALLY_VERIFIED'], INTEGRATING:['VERIFIED','PARTIALLY_VERIFIED','BLOCKED','OWNER_DECISION_REQUIRED','FAILED'],
  OWNER_DECISION_REQUIRED:['PLANNING','BLOCKED','VERIFYING','FAILED'], VERIFIED:[], PARTIALLY_VERIFIED:[], FAILED:[], CANCELLED:[]
};
export const TASK_TRANSITIONS: Record<TaskState,TaskState[]> = {
  PENDING:['READY','BLOCKED','CANCELLED'], READY:['RUNNING','BLOCKED','CANCELLED'], RUNNING:['REVIEWING','BLOCKED','FAILED'],
  BLOCKED:['READY','REVIEWING','TESTING','FAILED','CANCELLED'], REVIEWING:['TESTING','REJECTED','BLOCKED','FAILED'],
  TESTING:['VERIFIED','REJECTED','BLOCKED','FAILED'], REJECTED:['READY','FAILED','CANCELLED'], FAILED:['READY','CANCELLED'], VERIFIED:[], CANCELLED:[]
};
function addRefs(target:EvidenceRef[], incoming:EvidenceRef[]) { for(const r of incoming) { const old=target.find(x=>x.id===r.id);check(!old||old.sha256===r.sha256,'JOB_REFERENCE_REBOUND');if(!old)target.push(structuredClone(r)); } }
function task(j:Job,id:string) { const t=j.tasks.find(x=>x.task_id===id);check(t,'TASK_NOT_FOUND');return t; }
function run(j:Job,id:string) { const r=j.runs.find(x=>x.run_id===id);check(r,'AGENTRUN_NOT_FOUND');return r; }
function gates(j:Job) { return j.owner_gates.some(g=>g.resolved_ref===null); }
function unresolved(j:Job) { return j.runs.some(r=>!safeRun(r)); }
function verification(t:Task,v:VerificationReceipt) {
  exact(v,['decision_ref','authority_ref','subject_generation','workspace_head','outcome','checks']); evidence(v.decision_ref);evidence(v.authority_ref);
  check(v.subject_generation===t.generation&&v.workspace_head===t.workspace.observed_head,'JOB_VERIFICATION_SUBJECT_DRIFT');
  check(['VERIFIED','PARTIALLY_VERIFIED','STALE'].includes(v.outcome)&&Array.isArray(v.checks),'JOB_VERIFICATION_INVALID');
  for(const x of v.checks){exact(x,['requirement','passed','evidence_refs']);check(t.verification.required.includes(x.requirement)&&typeof x.passed==='boolean','JOB_VERIFICATION_INVALID');refs(x.evidence_refs);check(!x.passed||x.evidence_refs.length>0,'JOB_VERIFICATION_EVIDENCE_REQUIRED');}
  check(new Set(v.checks.map(x=>x.requirement)).size===v.checks.length,'JOB_VERIFICATION_DUPLICATE_CHECK');
  const complete=t.verification.required.every(k=>v.checks.some(x=>x.requirement===k&&x.passed&&x.evidence_refs.length));
  check(v.outcome!=='VERIFIED'||complete,'JOB_VERIFICATION_INCOMPLETE');
  check(v.outcome!=='PARTIALLY_VERIFIED'||v.checks.some(x=>x.passed),'JOB_VERIFICATION_INCOMPLETE');
}

export function createState(c:CreateCommand,at:string):Job {
  exact(c,['kind','job_id','project','input','task_ids']);check(c.kind==='CREATE','JOB_SCHEMA_INVALID');jobId(c.job_id);timestamp(at);
  exact(c.project,['project_id','workspace_root']);check(text(c.project.project_id)&&text(c.project.workspace_root),'JOB_PROJECT_INVALID');
  exact(c.input,c.input.d1_profile===undefined?['tasks','control_refs','handoff_refs','context_pack_refs']:
    ['tasks','control_refs','handoff_refs','context_pack_refs','d1_profile']);
  controls(c.input.control_refs);refs(c.input.handoff_refs);refs(c.input.context_pack_refs);
  check(Array.isArray(c.input.tasks)&&c.input.tasks.length>0&&Array.isArray(c.task_ids)&&c.task_ids.length===c.input.tasks.length,'JOB_TASKS_REQUIRED');
  check(new Set(c.task_ids).size===c.task_ids.length,'JOB_DUPLICATE_TASK');
  const prefix=c.job_id.slice(4);c.task_ids.forEach(id=>check(new RegExp('^task:'+prefix+':'+UUID+'$').test(id),'TASK_ID_INVALID'));
  const keys=c.input.tasks.map(t=>t.key);strings(keys);
  const tasks:Task[]=c.input.tasks.map((t,i)=>{
    exact(t,['key','contract_ref','dependency_keys','workspace','verification_required','control_refs']);evidence(t.contract_ref);workspace(t.workspace);controls(t.control_refs);strings(t.dependency_keys);strings(t.verification_required);check(t.verification_required.length>0,'JOB_VERIFICATION_REQUIREMENTS_EMPTY');
    check(t.dependency_keys.every(k=>keys.includes(k)&&k!==t.key),'JOB_DEPENDENCY_INVALID');
    return {task_id:c.task_ids[i]!,job_id:c.job_id,key:t.key,state:'PENDING',contract_ref:t.contract_ref,dependencies:t.dependency_keys.map(k=>c.task_ids[keys.indexOf(k)]!),workspace:t.workspace,control_refs:t.control_refs,current_run_id:null,run_ids:[],generation:0,counters:counts(),verification:{required:t.verification_required,state:'PENDING',receipts:[]},evidence_refs:[]};
  });
  const visit=(id:string,path:Set<string>)=>{check(!path.has(id),'JOB_DEPENDENCY_CYCLE');const next=new Set(path).add(id);for(const d of tasks.find(t=>t.task_id===id)!.dependencies)visit(d,next);};tasks.forEach(t=>visit(t.task_id,new Set()));
  const intake=d1Intake(c);
  return structuredClone({job_id:c.job_id,authority:'XDEV_EXECUTION_CONTROL_STATE',revision:0,state:'QUEUED',project:c.project,created_at:at,updated_at:at,tasks,runs:[],control_refs:c.input.control_refs,owner_gates:[],counters:counts(),evidence_refs:[],handoff_refs:c.input.handoff_refs,context_pack_refs:c.input.context_pack_refs,cancellation_requested:false,result_refs:[],...(intake?{d1_intake:intake}:{})});
}

/** Replay uses the same validator as mutation; there is no editable snapshot in storage. */
export function reduce(previous:Job, command:JobCommand,at:string):Job {
  const j=structuredClone(previous),c=structuredClone(command);timestamp(at);check(at>=j.updated_at,'JOB_TIME_REGRESSION');
  check(!terminalJob(j.state),'JOB_TERMINAL_IMMUTABLE');
  if(j.d1_intake!==undefined){
    check(j.d1_intake.kind==='D1_INTAKE'&&j.d1_intake.admission==='NOT_ADMITTED'&&j.d1_intake.request_id===j.job_id.slice(4),'D1_INTAKE_SOURCE_INVALID');
    check(j.d1_intake.profile===undefined,'D1_PROFILE_ONLY_NOT_EXECUTABLE');
    const prohibited=c.kind==='INTENT'||c.kind==='LAUNCH_INTENT'||c.kind==='RUN_REMOTE_BINDING'||
      c.kind==='RUN_OBSERVATION'||c.kind==='VERIFICATION'||
      (c.kind==='TASK_STATE'&&['READY','RUNNING','REVIEWING','TESTING','VERIFIED'].includes(c.state))||
      (c.kind==='JOB_STATE'&&['RUNNING','VERIFYING','INTEGRATING','VERIFIED','PARTIALLY_VERIFIED'].includes(c.state));
    check(!prohibited,'D1_EXECUTION_NOT_ADMITTED');
  }
  switch(c.kind){
    case 'D1_CONTEXT_BIND': {
      exact(c,['kind','task_id','request_id','binding']);
      check(j.d1_intake?.admission==='NOT_ADMITTED'&&j.revision===0&&j.state==='QUEUED'&&
        j.tasks.length===1&&j.runs.length===0&&!j.cancellation_requested&&!gates(j),
        'D1_CONTEXT_BIND_NOT_READY');
      const target=task(j,c.task_id);
      validateD1ContextBinding(c.binding);
      check(c.request_id===c.binding.request_id&&c.task_id===c.binding.task_id&&
        target.key===c.binding.task_key&&target.generation===0&&target.state==='PENDING'&&
        target.contract_ref.sha256===c.binding.contract_sha256&&target.d1_context===undefined,
        'D1_CONTEXT_BIND_MISMATCH');
      target.d1_context=structuredClone(c.binding);
      break;
    }
    case 'D1_WORKER_SEND_INTENT': {
      exact(c,['kind','task_id','run_id','attempt_id','send_id','reservation_id','packet_sha256','packet','resource_revision','resource_head_sha256']);
      const p=c.packet,t=task(j,c.task_id);
      check(t.d1_context?p.format==='xdev-d1-worker-send-2'&&!!p.context:
        p.format==='xdev-d1-worker-send-1'&&!p.context,'D1_CONTEXT_V1_SEND_FORBIDDEN');
      if(t.d1_context)validateD1WorkerContext(p.context,t.d1_context,at);
      exact(p,['format','project_id','job_id','task_id','attempt_id','send_id','registration_sha256','create_input_sha256',
        'contract_sha256','workspace_root','authorization_expires_at','resource_revision','resource_head_sha256','job_revision','job_head_sha256',
        'current_observation_path','current_observation_sha256','test_only','manifest','allowed_scope','forbidden_scope','context_pack_refs','authority_source_refs',
        'spawn_args','host_context','observation_limit','deadline_at','stop_conditions',
        ...(t.d1_context?['context']:[])]);
      exact(p.spawn_args,['task_name','message','agent_type','model','reasoning_effort','fork_turns']);
      exact(p.host_context,['session_ref','parent_cwd','skill_path','skill_sha256','tool_schema_sha256','context_control']);
      check(j.d1_intake?.admission==='NOT_ADMITTED'&&j.state==='QUEUED'&&!gates(j)&&!j.cancellation_requested&&
        t.state==='PENDING'&&t.dependencies.length===0&&t.current_run_id===null&&t.run_ids.length===0&&
        j.runs.length===0,'D1_WORKER_ADMISSION_DENIED');
      check(new RegExp('^run:'+UUID+'$').test(c.run_id)&&new RegExp('^'+UUID+'$').test(c.attempt_id)&&
        new RegExp('^'+UUID+'$').test(c.send_id)&&new RegExp('^'+UUID+'$').test(c.reservation_id)&&
        c.resource_revision===2&&/^[0-9a-f]{64}$/.test(c.resource_head_sha256)&&
        /^[0-9a-f]{64}$/.test(c.packet_sha256)&&c.packet_sha256===bindingHash(p),'D1_WORKER_SEND_INVALID');
      check(p.format===(t.d1_context?'xdev-d1-worker-send-2':'xdev-d1-worker-send-1')&&
        p.project_id===j.project.project_id&&p.job_id===j.job_id&&
        p.task_id===t.task_id&&p.attempt_id===c.attempt_id&&p.send_id===c.send_id&&
        p.contract_sha256===t.contract_ref.sha256&&p.workspace_root===j.project.workspace_root&&
        p.job_revision===previous.revision&&p.resource_revision===1&&text(p.current_observation_path)&&
        typeof p.test_only==='boolean'&&
        [p.registration_sha256,p.create_input_sha256,p.resource_head_sha256,p.job_head_sha256,p.current_observation_sha256]
          .every(x=>/^[0-9a-f]{64}$/.test(x)),'D1_WORKER_PACKET_DRIFT');
      timestamp(p.authorization_expires_at);check(p.authorization_expires_at>at,'D1_WORKER_AUTHORIZATION_EXPIRED');
      check(Array.isArray(p.manifest)&&p.manifest.length>0&&p.manifest.every(x=>{
        exact(x,['path','sha256']);return text(x.path)&&!x.path.startsWith('/')&&!x.path.includes('..')&&/^[0-9a-f]{64}$/.test(x.sha256);}),
        'D1_WORKER_MANIFEST_INVALID');
      strings(p.allowed_scope);strings(p.forbidden_scope);strings(p.authority_source_refs);refs(p.context_pack_refs);strings(p.stop_conditions);
      check(text(p.spawn_args.task_name)&&text(p.spawn_args.message)&&p.spawn_args.agent_type==='worker'&&
        text(p.spawn_args.model)&&text(p.spawn_args.reasoning_effort)&&p.spawn_args.fork_turns==='none'&&
        text(p.host_context.session_ref)&&p.host_context.parent_cwd===j.project.workspace_root&&
        text(p.host_context.skill_path)&&/^[0-9a-f]{64}$/.test(p.host_context.skill_sha256)&&
        /^[0-9a-f]{64}$/.test(p.host_context.tool_schema_sha256)&&p.host_context.context_control==='PARTIAL'&&
        Number.isSafeInteger(p.observation_limit)&&p.observation_limit>0&&p.observation_limit<=12,
        'D1_WORKER_PACKET_INVALID');timestamp(p.deadline_at);
      t.generation=1;t.current_run_id=c.run_id;t.run_ids.push(c.run_id);t.verification.state='PENDING';
      j.runs.push({run_id:c.run_id,task_id:t.task_id,generation:1,intent_id:`d1:${c.attempt_id}`,state:'PENDING',
        worker_run:{worker:{worker_id:'UNBOUND',adapter_id:'host-native-agent'},adapter_metadata:{}},
        evidence_refs:[],created_at:at,updated_at:at,observations:[],
        d1_worker:{attempt_id:c.attempt_id,send_id:c.send_id,packet_sha256:c.packet_sha256,
          resource_head_sha256:c.resource_head_sha256,host_agent_id:null,host_task_path:null,
          observation_count:0,observation_limit:p.observation_limit,deadline_at:p.deadline_at,
          last_observation_ref:null,block_reason:null,packet:p}});
      break;
    }
    case 'D1_WORKER_OBSERVATION': {
      exact(c,['kind','run_id','attempt_id','send_id','observed_state','host_agent_id','host_task_path','observation_ref',
        'observed_at','final_manifest_sha256','final_manifest','active_writers','unknown_writers','actual_model','actual_effort']);
      const r=run(j,c.run_id),d=r.d1_worker,t=task(j,r.task_id);
      check(j.d1_intake?.admission==='NOT_ADMITTED'&&d&&d.attempt_id===c.attempt_id&&d.send_id===c.send_id&&
        !safeRun(r)&&d.observation_count<d.observation_limit,'D1_WORKER_OBSERVATION_UNAVAILABLE');
      check(['ACTIVE','SUCCEEDED','FAILED','CANCELLED','UNKNOWN'].includes(c.observed_state),'D1_WORKER_OBSERVATION_INVALID');
      timestamp(c.observed_at);check(c.observed_at<=at,'D1_WORKER_OBSERVATION_TIME');evidence(c.observation_ref);
      check((c.host_agent_id===null&&c.host_task_path===null)||
        (text(c.host_agent_id)&&text(c.host_task_path)),'D1_WORKER_HOST_IDENTITY_INVALID');
      check(c.observed_state==='UNKNOWN'||(text(c.host_agent_id)&&text(c.host_task_path)),'D1_WORKER_HOST_IDENTITY_REQUIRED');
      check(!d.host_agent_id||d.host_agent_id===c.host_agent_id,'D1_WORKER_HOST_IDENTITY_CONFLICT');
      check(!d.host_task_path||d.host_task_path===c.host_task_path,'D1_WORKER_HOST_IDENTITY_CONFLICT');
      check(c.final_manifest_sha256===null||/^[0-9a-f]{64}$/.test(c.final_manifest_sha256),'D1_WORKER_MANIFEST_INVALID');
      check(c.final_manifest===null||(Array.isArray(c.final_manifest)&&c.final_manifest.every(x=>{
        exact(x,['path','sha256']);return text(x.path)&&/^[0-9a-f]{64}$/.test(x.sha256);})),
        'D1_WORKER_FINAL_MANIFEST_INVALID');
      check(c.observed_state!=='SUCCEEDED'||(c.final_manifest!==null&&c.final_manifest_sha256===bindingHash(c.final_manifest)),
        'D1_WORKER_FINAL_MANIFEST_REQUIRED');
      strings(c.active_writers);strings(c.unknown_writers);
      check(c.actual_model===null||text(c.actual_model),'D1_WORKER_OBSERVATION_INVALID');
      check(c.actual_effort===null||text(c.actual_effort),'D1_WORKER_OBSERVATION_INVALID');
      d.observation_count++;d.last_observation_ref=c.observation_ref;
      if(c.host_agent_id){d.host_agent_id=c.host_agent_id;d.host_task_path=c.host_task_path;r.worker_run.worker.worker_id=c.host_agent_id;}
      r.state=c.observed_state;r.updated_at=at;addRefs(r.evidence_refs,[c.observation_ref]);addRefs(t.evidence_refs,[c.observation_ref]);
      r.observations.push({state:c.observed_state,at:c.observed_at,evidence_refs:[c.observation_ref],reconciliation_ref:null});
      let scopeViolation=false;
      if(c.final_manifest){const before=new Map(d.packet.manifest.map(x=>[x.path,x.sha256])),after=new Map(c.final_manifest.map(x=>[x.path,x.sha256]));
        check(after.size===c.final_manifest.length,'D1_WORKER_FINAL_MANIFEST_INVALID');
        const changed=[...new Set([...before.keys(),...after.keys()])].filter(path=>before.get(path)!==after.get(path));
        const inScope=(path:string,scope:string)=>path===scope||path.startsWith(scope.endsWith('/')?scope:scope+'/');
        scopeViolation=changed.some(path=>!d.packet.allowed_scope.includes(path)||
          d.packet.forbidden_scope.some(scope=>inScope(path,scope)));
      }
      if(d.block_reason==='UNKNOWN_RECONCILIATION_REQUIRED'&&c.observed_state!=='UNKNOWN'&&c.host_agent_id)d.block_reason=null;
      if(scopeViolation)d.block_reason='SCOPE_VIOLATION';
      if(d.packet.authorization_expires_at<=c.observed_at)d.block_reason=d.block_reason??'AUTHORIZATION_EXPIRED';
      if(d.deadline_at<c.observed_at)d.block_reason=d.block_reason??'OBSERVATION_WINDOW_EXHAUSTED';
      if(c.active_writers.length||c.unknown_writers.length)d.block_reason=d.block_reason??'WRITER_CONFLICT_OR_UNKNOWN';
      const unsafe=gates(j)||j.cancellation_requested||d.block_reason!==null;
      if(unsafe){d.block_reason=d.block_reason??'OWNER_GATE_OR_CANCELLATION';t.d1_worker_block_reason=d.block_reason;}
      if(c.observed_state==='ACTIVE'&&!unsafe){t.state='RUNNING';j.state='RUNNING';}
      else {t.state='BLOCKED';j.state='BLOCKED';
        if(c.observed_state==='SUCCEEDED')d.block_reason=d.block_reason??'AWAITING_INDEPENDENT_REVIEW';
        else if(c.observed_state==='UNKNOWN')d.block_reason=d.block_reason??'UNKNOWN_RECONCILIATION_REQUIRED';
        else if(c.observed_state==='FAILED'||c.observed_state==='CANCELLED')d.block_reason=d.block_reason??'WORKER_TERMINAL_STOP';
        t.d1_worker_block_reason=d.block_reason;}
      break;
    }
    case 'LAUNCH_INTENT': {
      exact(c,['kind','task_id','run_id','intent_id','worker_run','attempt','launch']);const l=c.launch;
      exact(l,['launch_attempt_id','adapter_id','provider','remote_keys','workspace','action_ref','admission_ref','reservation_ref','dispatch_sha256','expected_job_revision']);
      check(new RegExp('^launch:'+UUID+'$').test(l.launch_attempt_id)&&text(l.provider)&&l.adapter_id===c.worker_run.worker.adapter_id&&l.expected_job_revision===previous.revision,'LAUNCH_INTENT_INVALID');
      strings(l.remote_keys);check(l.remote_keys.length>0&&l.remote_keys.every(k=>!['__proto__','constructor','prototype'].includes(k)),'LAUNCH_REMOTE_KEYS_INVALID');workspace(l.workspace);[l.action_ref,l.admission_ref,l.reservation_ref].forEach(evidence);
      check(/^[0-9a-f]{64}$/.test(l.dispatch_sha256)&&bindingHash(l.workspace)===bindingHash(task(j,c.task_id).workspace),'LAUNCH_SCOPE_MISMATCH');
      check(l.remote_keys.every(k=>!Object.hasOwn(c.worker_run.adapter_metadata,k)),'REMOTE_IDS_PREDECLARED');
      check(!j.runs.some(r=>r.launch?.launch_attempt_id===l.launch_attempt_id),'LAUNCH_ATTEMPT_DUPLICATE');
      const {launch,kind,...base}=c;const next=reduce(previous,{kind:'INTENT',...base},at),r=run(next,c.run_id);
      r.launch={...launch,binding_state:'UNBOUND',remote_ids:{},outcome:'PRE_SEND',binding_digest:bindingHash({launch_attempt_id:l.launch_attempt_id,remote_ids:{},outcome:'PRE_SEND'})};return next;
    }
    case 'RUN_REMOTE_BINDING': {
      exact(c,['kind','run_id','launch_attempt_id','adapter_id','provider','remote_ids','rpc_method','certainty','receipt_ref','observed_at','previous_binding_digest','outcome']);
      const r=run(j,c.run_id),l=r.launch;check(l&&!safeRun(r),'RUN_REMOTE_BINDING_UNAVAILABLE');
      check(c.launch_attempt_id===l.launch_attempt_id&&c.adapter_id===l.adapter_id&&c.provider===l.provider,'RUN_REMOTE_BINDING_IDENTITY');
      check(c.previous_binding_digest===l.binding_digest,'RUN_REMOTE_BINDING_DRIFT');timestamp(c.observed_at);check(c.observed_at<=at&&text(c.rpc_method)&&text(c.certainty),'RUN_REMOTE_BINDING_RECEIPT');evidence(c.receipt_ref);
      check(c.remote_ids&&typeof c.remote_ids==='object'&&!Array.isArray(c.remote_ids)&&Object.entries(c.remote_ids).every(([k,v])=>l.remote_keys.includes(k)&&text(v)),'RUN_REMOTE_BINDING_IDS');
      for(const [k,v]of Object.entries(l.remote_ids))check(!Object.hasOwn(c.remote_ids,k)||c.remote_ids[k]===v,'RUN_REMOTE_BINDING_CONFLICT');
      check(['OBSERVED','SENT_NO_ACK','UNKNOWN'].includes(c.outcome),'RUN_REMOTE_BINDING_OUTCOME');
      check(c.outcome!=='OBSERVED'||(Object.keys(c.remote_ids).length>0&&['COMMITTED_ID_OBSERVED','TERMINAL_RESULT_OBSERVED'].includes(c.certainty)),'RUN_REMOTE_BINDING_EVIDENCE_REQUIRED');
      for(const [k,v]of Object.entries(c.remote_ids)){l.remote_ids[k]=v;r.worker_run.adapter_metadata[k]=v;}
      l.binding_state=Object.keys(l.remote_ids).length===l.remote_keys.length?'BOUND':Object.keys(l.remote_ids).length?'PARTIAL_BOUND':'UNBOUND';
      l.outcome=c.outcome;l.binding_digest=bindingHash({previous:l.binding_digest,command:c});r.updated_at=at;
      if(c.outcome!=='OBSERVED')r.state='UNKNOWN';addRefs(r.evidence_refs,[c.receipt_ref]);addRefs(task(j,r.task_id).evidence_refs,[c.receipt_ref]);break;
    }
    case 'JOB_STATE': {
      exact(c,['kind','state','result_refs']);check(JOB_STATES.includes(c.state)&&JOB_TRANSITIONS[j.state].includes(c.state),'JOB_TRANSITION_INVALID');refs(c.result_refs);
      if(['RUNNING','VERIFYING','INTEGRATING','VERIFIED','PARTIALLY_VERIFIED'].includes(c.state))check(!gates(j)&&!j.cancellation_requested,'JOB_OWNER_OR_CANCEL_GATE');
      if(c.state==='RUNNING')check(j.tasks.some(t=>t.state==='RUNNING'&&t.current_run_id&&run(j,t.current_run_id).state==='ACTIVE'),'JOB_RUN_IDENTITY_REQUIRED');
      if(['VERIFYING','INTEGRATING','VERIFIED','PARTIALLY_VERIFIED','FAILED'].includes(c.state))check(!unresolved(j),'RECONCILIATION_REQUIRED');
      if(c.state==='OWNER_DECISION_REQUIRED')check(gates(j),'JOB_OWNER_GATE_REQUIRED');
      if(c.state==='VERIFIED')check(j.tasks.every(t=>t.state==='VERIFIED'&&t.verification.state==='VERIFIED'),'JOB_VERIFICATION_INCOMPLETE');
      if(c.state==='PARTIALLY_VERIFIED')check(j.tasks.some(t=>['VERIFIED','PARTIALLY_VERIFIED'].includes(t.verification.state)),'JOB_VERIFICATION_INCOMPLETE');
      check(terminalJob(c.state)?c.result_refs.length>0:c.result_refs.length===0,'JOB_RESULT_REFS_INVALID');j.state=c.state;addRefs(j.result_refs,c.result_refs);break;
    }
    case 'TASK_STATE': {
      exact(c,['kind','task_id','state']);const t=task(j,c.task_id);check(TASK_STATES.includes(c.state)&&TASK_TRANSITIONS[t.state].includes(c.state),'TASK_TRANSITION_INVALID');
      const r=t.current_run_id?run(j,t.current_run_id):null;
      if(['READY','RUNNING'].includes(c.state)){check(!gates(j)&&!j.cancellation_requested,'JOB_OWNER_OR_CANCEL_GATE');check(t.dependencies.every(id=>task(j,id).state==='VERIFIED'),'TASK_DEPENDENCY_NOT_VERIFIED');}
      if(c.state==='READY')check(!r||safeRun(r),'RECONCILIATION_REQUIRED');
      if(c.state==='RUNNING')check(r&&r.state==='ACTIVE','JOB_RUN_IDENTITY_REQUIRED');
      if(['REVIEWING','TESTING','VERIFIED','REJECTED','FAILED','CANCELLED'].includes(c.state))check(!r||safeRun(r),'RECONCILIATION_REQUIRED');
      if(['REVIEWING','TESTING','VERIFIED'].includes(c.state))check(r?.state==='SUCCEEDED','TASK_SUCCESSFUL_RUN_REQUIRED');
      if(c.state==='VERIFIED')check(t.verification.state==='VERIFIED'&&t.verification.receipts.length>0&&!gates(j),'JOB_VERIFICATION_INCOMPLETE');t.state=c.state;break;
    }
    case 'INTENT': {
      exact(c,['kind','task_id','run_id','intent_id','worker_run','attempt']);const t=task(j,c.task_id);check(!gates(j)&&!j.cancellation_requested,'JOB_OWNER_OR_CANCEL_GATE');
      check(!t.current_run_id||safeRun(run(j,t.current_run_id)),'RECONCILIATION_REQUIRED');
      check(t.state==='READY','TASK_NOT_READY');check(new RegExp('^run:'+UUID+'$').test(c.run_id)&&text(c.intent_id),'JOB_INTENT_INVALID');
      check(!j.runs.some(r=>r.run_id===c.run_id||r.intent_id===c.intent_id),'JOB_DUPLICATE_INTENT');
      const old=t.current_run_id?run(j,t.current_run_id):null;check(!old||safeRun(old),'RECONCILIATION_REQUIRED');
      check(old?['RETRY','REPLACEMENT'].includes(c.attempt):c.attempt==='INITIAL','JOB_ATTEMPT_INVALID');
      exact(c.worker_run,['worker','adapter_metadata']);exact(c.worker_run.worker,['worker_id','adapter_id']);check(Object.values(c.worker_run.worker).every(text),'JOB_WORKER_REF_INVALID');
      check(c.worker_run.adapter_metadata&&typeof c.worker_run.adapter_metadata==='object'&&!Array.isArray(c.worker_run.adapter_metadata)&&Object.entries(c.worker_run.adapter_metadata).every(([k,v])=>text(k)&&text(v)),'JOB_ADAPTER_METADATA_INVALID');
      if(old){const counter=c.attempt==='RETRY'?'retry_count':'replacement_count';t.counters[counter]++;j.counters[counter]++;}
      t.generation++;t.current_run_id=c.run_id;t.run_ids.push(c.run_id);t.verification.state='PENDING';
      j.runs.push({run_id:c.run_id,task_id:t.task_id,generation:t.generation,intent_id:c.intent_id,state:'PENDING',worker_run:c.worker_run,evidence_refs:[],created_at:at,updated_at:at,observations:[]});break;
    }
    case 'RUN_OBSERVATION': {
      exact(c,['kind','run_id','state','evidence_refs','reconciliation_ref']);const r=run(j,c.run_id);check(RUN_STATES.includes(c.state),'JOB_RUN_STATE_INVALID');refs(c.evidence_refs);if(c.reconciliation_ref!==null)evidence(c.reconciliation_ref);
      check(!safeRun(r)&&c.state!=='PENDING','AGENTRUN_TRANSITION_INVALID');
      if(r.state==='UNKNOWN'&&c.state!=='UNKNOWN')check(c.reconciliation_ref&&c.evidence_refs.length>0,'RECONCILIATION_REQUIRED');
      if(['ACTIVE','SUCCEEDED','FAILED','CANCELLED'].includes(c.state))check(c.evidence_refs.length>0,'JOB_OBSERVATION_EVIDENCE_REQUIRED');
      // Observation records facts, including execution discovered after a cancel/gate.
      r.state=c.state;r.updated_at=at;addRefs(r.evidence_refs,c.evidence_refs);r.observations.push({state:c.state,at,evidence_refs:c.evidence_refs,reconciliation_ref:c.reconciliation_ref});addRefs(task(j,r.task_id).evidence_refs,c.evidence_refs);break;
    }
    case 'VERIFICATION': {
      exact(c,['kind','task_id','receipt']);const t=task(j,c.task_id);check(['REVIEWING','TESTING','VERIFIED','BLOCKED'].includes(t.state),'TASK_NOT_VERIFYING');
      check(t.current_run_id&&run(j,t.current_run_id).state==='SUCCEEDED','TASK_SUCCESSFUL_RUN_REQUIRED');verification(t,c.receipt);
      check(!t.verification.receipts.some(v=>v.decision_ref.id===c.receipt.decision_ref.id),'JOB_VERIFICATION_RECEIPT_REPLAY');
      t.verification.receipts.push(c.receipt);t.verification.state=c.receipt.outcome;
      if(c.receipt.outcome==='STALE'){t.state='BLOCKED';j.state='BLOCKED';}
      for(const x of c.receipt.checks)addRefs(t.evidence_refs,x.evidence_refs);addRefs(j.evidence_refs,[c.receipt.decision_ref,c.receipt.authority_ref]);break;
    }
    case 'ESCALATION': {
      exact(c,['kind','task_id','decision_ref']);evidence(c.decision_ref);const t=task(j,c.task_id);check(!['VERIFIED','CANCELLED'].includes(t.state),'TASK_TRANSITION_INVALID');
      check(!j.evidence_refs.some(x=>x.id===c.decision_ref.id),'JOB_DECISION_REPLAY');t.counters.escalation_count++;j.counters.escalation_count++;addRefs(j.evidence_refs,[c.decision_ref]);break;
    }
    case 'GATE_REQUEST': {
      exact(c,['kind','gate']);exact(c.gate,['gate_ref','reason','category','requested_at','resolved_ref']);evidence(c.gate.gate_ref);timestamp(c.gate.requested_at);check(c.gate.requested_at<=at&&text(c.gate.reason)&&text(c.gate.category)&&c.gate.resolved_ref===null,'JOB_GATE_INVALID');check(!j.owner_gates.some(g=>g.gate_ref.id===c.gate.gate_ref.id),'JOB_GATE_EXISTS');j.owner_gates.push(c.gate);
      if(j.d1_intake)for(const r of j.runs)if(r.d1_worker){r.d1_worker.block_reason='OWNER_GATE_OR_CANCELLATION';task(j,r.task_id).d1_worker_block_reason='OWNER_GATE_OR_CANCELLATION';}
      j.state='OWNER_DECISION_REQUIRED';break;
    }
    case 'GATE_RESOLVE': {
      exact(c,['kind','gate_id','resolution_ref']);evidence(c.resolution_ref);const g=j.owner_gates.find(x=>x.gate_ref.id===c.gate_id);check(g&&g.resolved_ref===null,'JOB_GATE_NOT_PENDING');g.resolved_ref=c.resolution_ref;break;
    }
    case 'CANCEL': {
      exact(c,['kind']);j.cancellation_requested=true;
      if(j.d1_intake)for(const r of j.runs)if(r.d1_worker){r.d1_worker.block_reason='OWNER_GATE_OR_CANCELLATION';task(j,r.task_id).d1_worker_block_reason='OWNER_GATE_OR_CANCELLATION';}
      if(unresolved(j)){j.state='BLOCKED';}else{j.state='CANCELLED';for(const t of j.tasks)if(t.state!=='VERIFIED')t.state='CANCELLED';}break;
    }
    default: throw Error('JOB_COMMAND_INVALID');
  }
  j.revision++;j.updated_at=at;return j;
}

export function inspectResumeState(j:Job,observation?:ResumeObservation) {
  if(observation){exact(observation,['workspace_heads','current_control_refs','task_control_refs','verification_current_refs']);check(observation.workspace_heads&&typeof observation.workspace_heads==='object'&&!Array.isArray(observation.workspace_heads)&&Object.values(observation.workspace_heads).every(text),'JOB_RESUME_OBSERVATION_INVALID');if(observation.current_control_refs!==null)controls(observation.current_control_refs);check(observation.task_control_refs&&typeof observation.task_control_refs==='object'&&!Array.isArray(observation.task_control_refs),'JOB_RESUME_OBSERVATION_INVALID');Object.values(observation.task_control_refs).forEach(controls);refs(observation.verification_current_refs);}
  const reasons:string[]=[];
  if(gates(j))reasons.push('OWNER_GATE_PENDING');if(j.cancellation_requested)reasons.push('CANCELLATION_INTENT');
  if(!observation?.current_control_refs||(['budget_ref','control_ref','allocation_ref'] as const).some(k=>observation.current_control_refs![k].id!==j.control_refs[k].id||observation.current_control_refs![k].sha256!==j.control_refs[k].sha256))reasons.push('CURRENT_CONTROL_REVALIDATION_REQUIRED');
  const tasks=j.tasks.map(t=>{
    const tc=observation?.task_control_refs[t.task_id];
    if(!tc||(['budget_ref','control_ref','allocation_ref'] as const).some(k=>tc[k].id!==t.control_refs[k].id||tc[k].sha256!==t.control_refs[k].sha256))reasons.push('TASK_CONTROL_REVALIDATION_REQUIRED:'+t.task_id);
    const r=t.current_run_id?run(j,t.current_run_id):null;let classification:ResumeClass;
    if(r?.state==='UNKNOWN')classification='UNKNOWN_RECONCILIATION_REQUIRED';
    else if(r&&['ACTIVE','PENDING'].includes(r.state))classification='ACTIVE_OR_POSSIBLY_ACTIVE';
    else if(observation&&(!Object.hasOwn(observation.workspace_heads,t.workspace.workspace_id)||observation.workspace_heads[t.workspace.workspace_id]!==t.workspace.observed_head))classification='UNKNOWN_RECONCILIATION_REQUIRED';
    else if(t.verification.state==='VERIFIED'){
      const v=t.verification.receipts.at(-1)!;classification=observation?.verification_current_refs.some(x=>x.id===v.decision_ref.id&&x.sha256===v.decision_ref.sha256)?'COMPLETED_AND_EVIDENCED':'VERIFICATION_MUST_RERUN';
    }else if(t.verification.state==='STALE'||r?.state==='SUCCEEDED')classification='VERIFICATION_MUST_RERUN';
    else if(['BLOCKED','FAILED','REJECTED','CANCELLED'].includes(t.state)||gates(j))classification='BLOCKED';else classification='PENDING';
    return {task_id:t.task_id,classification,current_run_id:t.current_run_id,generation:t.generation};
  });
  if(!observation)reasons.push('WORKSPACE_OBSERVATION_REQUIRED');
  const reconciliation_required=reasons.length>0||tasks.some(t=>['UNKNOWN_RECONCILIATION_REQUIRED','ACTIVE_OR_POSSIBLY_ACTIVE','VERIFICATION_MUST_RERUN'].includes(t.classification));
  return {job_id:j.job_id,revision:j.revision,status:reconciliation_required?'RECONCILIATION_REQUIRED' as const:'RESUME_PLAN' as const,tasks,reasons,resume_required:!terminalJob(j.state),reconciliation_required,execution_permitted:false as const,worker_started:false as const,reservation_created:false as const};
}
