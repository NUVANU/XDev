import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobStore, productionJobRoot } from '../job-runtime/store.ts';
import type { CreateCommand, Job, JobId, Task, TaskId } from '../job-runtime/contracts.ts';
import { callXMem, xdevBuildSha } from './joint-peer.ts';
import { addOperation, bindingByHandle, checkOperationId, findOperation, JointStore } from './joint-store.ts';
import type { Binding, BindingRecord, JointState, OperationRecord } from './joint-store.ts';
import { AUTHENTICATION, checkNewProjectHistory, CONTRACT_SHA256, currentProfile, digest, fail, idPattern, need,
  objectDigest, operative, PROFILE, PROTOCOL, readBudget, SCHEMA_SHA256, schema } from './joint-util.ts';
import type { JointConfig } from './joint-util.ts';

const here=fileURLToPath(new URL('.',import.meta.url));
const buildFiles=['joint-cli.ts','joint-controller.ts','joint-store.ts','joint-peer.ts','joint-util.ts']
  .map(name=>join(here,name)).concat(['store.ts','state.ts','contracts.ts'].map(name=>join(here,'../job-runtime',name)));
const uuid=()=>randomUUID();
type Source={job:Job;task:Task;create:CreateCommand;job_head_sha256:string;contract_ref:any;
  profile:any;workspace_fingerprint:string;budget:any};

export class JointController{
  readonly config:JointConfig;readonly store:JointStore;readonly jobs:JobStore;
  private readonly defs:ReturnType<typeof schema>;
  constructor(config:JointConfig){this.config=config;this.defs=schema(config);this.store=new JointStore(config);
    this.jobs=new JobStore(productionJobRoot(config.control_root,config.project_id),
      {project_id:config.project_id,workspace_root:config.workspace_root});}
  private current(jobId:string,taskId:string,source?:{job:Job;create:CreateCommand;head_sha256:string}):Source{
    need(idPattern.test(jobId)&&idPattern.test(taskId),'INVALID_REQUEST');
    checkNewProjectHistory(this.config);
    const raw=source??this.jobs.inspectD1Journal(jobId as JobId),job=raw.job,create=raw.create;
    need(job.job_id===jobId&&job.project.project_id===this.config.project_id&&
      job.project.workspace_root===this.config.workspace_root&&create.job_id===jobId,'SCOPE_MISMATCH');
    const task=job.tasks.find(t=>t.task_id===taskId);
    need(task&&task.state==='PENDING'&&task.dependencies.length===0&&task.current_run_id===null&&
      task.run_ids.length===0&&job.runs.length===0&&job.state==='QUEUED'&&
      job.cancellation_requested===false&&job.owner_gates.every(g=>g.resolved_ref!==null),'AUTHORITY_STALE');
    const contract=operative(this.config,job,create,task);
    need(task.control_refs.budget_ref.sha256===create.input.control_refs.budget_ref.sha256,'AUTHORITY_STALE');
    const budget=readBudget(this.config,task.control_refs.budget_ref.sha256,this.defs.budget);
    const profile=currentProfile(this.config,task);
    return {job,task,create,job_head_sha256:raw.head_sha256,contract_ref:contract.ref,
      profile:profile.profile,workspace_fingerprint:profile.fingerprint,budget};
  }
  private currentBinding(record:BindingRecord):Binding{
    const binding=record.binding;
    need(binding.domain_id===this.config.domain_id&&binding.project_id===this.config.project_id&&
      (binding.state==='PREPARED'||binding.state==='ADMITTED'),'BINDING_REVOKED');
    need(Date.now()<binding.expires_at_ms,'EXPIRED');
    const before=this.store.read().bindings.find(x=>x.binding.preparation_handle===binding.preparation_handle)?.binding;
    need(before&&before.joint_revision===binding.joint_revision&&before.state===binding.state,'AUTHORITY_STALE');
    const source=this.jobs.withJointJobLock(binding.job_id as JobId,s=>this.current(binding.job_id,binding.task_id,s));
    need(source.job.revision===binding.job_revision&&source.task.generation===record.source.task_generation&&
      source.job_head_sha256===record.source.job_head_sha256&&
      source.workspace_fingerprint===record.source.workspace_fingerprint&&
      objectDigest(source.profile)===record.source.profile_sha256&&
      source.task.control_refs.budget_ref.sha256===record.source.budget_sha256&&
      source.contract_ref.sha256===binding.contract_ref.sha256&&
      record.source.history_source_ref===`${this.config.history_source_ref}#sha256:${checkNewProjectHistory(this.config)}`,
      'AUTHORITY_STALE');
    const after=this.store.read().bindings.find(x=>x.binding.preparation_handle===binding.preparation_handle)?.binding;
    need(after&&after.joint_revision===binding.joint_revision&&after.state===binding.state,'AUTHORITY_STALE');
    return structuredClone(binding);
  }
  private capabilities(){return {protocol:PROTOCOL,profile:PROFILE,schema_sha256:SCHEMA_SHA256,implementation:'XDEV',
    build_sha256:xdevBuildSha(join(here,'../..'),buildFiles),domain_id:this.config.domain_id,
    supported:true,authentication:AUTHENTICATION,worker_impersonation_resistance:'NOT_PROVEN',
    managed_issuer_validation:false,host_send:false,model_execution:false,max_context_bytes:32768,
    max_request_bytes:131072,max_metadata_bytes:16384,
    operations:['capabilities','prepareRun','inspectPreparedRun','resolveBinding','revokeBinding',
      'admitPreparedRun','reconcileOperation']};}
  private prepare(input:any){return this.store.withLock((state,commit)=>{
    const replay=findOperation(state,'prepareRun',input.request_id,input);if(replay)return replay.value;
    checkOperationId(state,input.operation_id);need(state.revision===input.expected_joint_revision,'REVISION_CONFLICT');
    const historySha=checkNewProjectHistory(this.config);
    return this.jobs.withJointJobLock(input.job_id as JobId,s=>{
      const src=this.current(input.job_id,input.task_id,s);
      need(src.job.revision===input.expected_job_revision,'REVISION_CONFLICT');
      const prior=Math.max(src.task.generation,...state.bindings.filter(x=>x.binding.task_id===input.task_id)
        .map(x=>x.binding.generation));
      need(prior===input.expected_generation,'GENERATION_CONFLICT');
      need(!state.bindings.some(x=>x.binding.task_id===input.task_id),'UNSUPPORTED_CAPABILITY');
      const now=Date.now(),expires=Math.min(now+input.ttl_ms,src.budget.expires_at_ms);
      need(expires>now,'EXPIRED');
      const handle=`prep:${uuid()}`,runId=`run:${uuid()}`,generation=prior+1;
      const binding:Binding={domain_id:this.config.domain_id,preparation_handle:handle,
        project_id:this.config.project_id,repository_id:src.task.workspace.repository_id,
        job_id:input.job_id,task_id:input.task_id,run_id:runId,generation,
        job_revision:src.job.revision,joint_revision:state.revision+1,state:'PREPARED',revocation_version:0,
        created_at_ms:now,expires_at_ms:expires,contract_ref:src.contract_ref,
        workspace_ref:{root:this.config.workspace_root},profile:src.profile,
        budget_ref:{path:this.config.budget_path,sha256:src.task.control_refs.budget_ref.sha256},intent:null,
        authority_ref:{control_root:this.config.control_root,canonical_job_revision:src.job.revision,
          contract_sha256:src.contract_ref.sha256,
          budget_ref:{path:this.config.budget_path,sha256:src.task.control_refs.budget_ref.sha256}}};
      const record:BindingRecord={binding,source:{task_generation:src.task.generation,
        job_head_sha256:src.job_head_sha256,workspace_fingerprint:src.workspace_fingerprint,
        profile_sha256:objectDigest(src.profile),budget_sha256:src.task.control_refs.budget_ref.sha256,
        history_source_ref:`${this.config.history_source_ref}#sha256:${historySha}`}};
      const receipt_id=`receipt:${uuid()}`,value={operation_id:input.operation_id,receipt_id,certainty:'COMMITTED',binding};
      state.bindings.push(record);addOperation(state,{kind:'prepareRun',request_id:input.request_id,
        operation_id:input.operation_id,input_sha256:objectDigest(input),receipt_id,committed_state:'PREPARED',
        binding_handle:handle,value});commit(state);return value;
    });
  });}
  private inspect(input:any){const state=this.store.read(),record=bindingByHandle(state,input.preparation_handle);
    return this.currentBinding(record);}
  private revoke(input:any){return this.store.withLock((state,commit)=>{
    const replay=findOperation(state,'revokeBinding',input.request_id,input);if(replay)return replay.value;
    checkOperationId(state,input.operation_id);const record=bindingByHandle(state,input.preparation_handle);
    need(record.binding.joint_revision===input.expected_joint_revision,'REVISION_CONFLICT');
    need(record.binding.state!=='REVOKED','BINDING_REVOKED');
    const binding=record.binding;binding.state='REVOKED';binding.revocation_version++;
    binding.joint_revision=state.revision+1;
    const receipt_id=`receipt:${uuid()}`,value={operation_id:input.operation_id,receipt_id,certainty:'COMMITTED',
      binding:structuredClone(binding)};
    addOperation(state,{kind:'revokeBinding',request_id:input.request_id,operation_id:input.operation_id,
      input_sha256:objectDigest(input),receipt_id,committed_state:'REVOKED',binding_handle:input.preparation_handle,value});
    commit(state);return value;
  });}
  private admit(input:any){
    const known=this.store.read(),replay=findOperation(known,'admitPreparedRun',input.request_id,input);
    if(replay)return replay.value;
    const validation=callXMem(this.config,'validateForConsume',
      {package_id:input.package_id,context_sha256:input.context_sha256});
    const pkg=validation.package_ref;
    need(pkg.package_id===input.package_id&&pkg.preparation_handle===input.preparation_handle&&
      pkg.context_sha256===input.context_sha256&&pkg.context_bytes===input.context_bytes&&
      Date.now()<pkg.expires_at_ms,'CONTEXT_STALE');
    return this.store.withLock((state,commit)=>{
      const again=findOperation(state,'admitPreparedRun',input.request_id,input);if(again)return again.value;
      checkOperationId(state,input.operation_id);
      const record=bindingByHandle(state,input.preparation_handle),binding=record.binding;
      need(binding.state==='PREPARED'&&binding.joint_revision===input.expected_joint_revision&&
        binding.job_revision===input.expected_job_revision&&binding.run_id===input.run_id&&
        binding.generation===input.generation,'REVISION_CONFLICT');
      need(Date.now()<Math.min(binding.expires_at_ms,pkg.expires_at_ms),'EXPIRED');
      return this.jobs.withJointJobLock(binding.job_id as JobId,s=>{
        const src=this.current(binding.job_id,binding.task_id,s);
        need(src.job.revision===binding.job_revision&&src.task.generation===record.source.task_generation&&
          src.job_head_sha256===record.source.job_head_sha256&&
          src.workspace_fingerprint===record.source.workspace_fingerprint&&
          objectDigest(src.profile)===record.source.profile_sha256&&
          record.source.history_source_ref===`${this.config.history_source_ref}#sha256:${checkNewProjectHistory(this.config)}`,
          'AUTHORITY_STALE');
        binding.state='ADMITTED';binding.joint_revision=state.revision+1;
        binding.intent={operation_id:input.operation_id,package_id:input.package_id,
          context_sha256:input.context_sha256,context_bytes:input.context_bytes};
        const receipt_id=`receipt:${uuid()}`,value={operation_id:input.operation_id,receipt_id,
          certainty:'COMMITTED',binding:structuredClone(binding)};
        addOperation(state,{kind:'admitPreparedRun',request_id:input.request_id,operation_id:input.operation_id,
          input_sha256:objectDigest(input),receipt_id,committed_state:'ADMITTED',
          binding_handle:input.preparation_handle,value});commit(state);return value;
      });
    });
  }
  private reconcile(input:any){const state=this.store.read(),op=state.operations.find(x=>x.kind===input.operation&&
    x.request_id===input.request_id);need(op,'OPERATION_NOT_FOUND');
    const current=bindingByHandle(state,op.binding_handle).binding;
    return {operation_id:op.operation_id,receipt_id:op.receipt_id,committed_state:op.committed_state,
      current_state:current.state,certainty:'COMMITTED',execution_authorized:false};}
  execute(request:any){need(this.defs.validate(request)&&request.protocol===PROTOCOL&&
    request.schema_sha256===SCHEMA_SHA256,'INVALID_REQUEST');
    let value:any;switch(request.operation){
      case 'capabilities':value=this.capabilities();break;
      case 'prepareRun':value=this.prepare(request.input);break;
      case 'inspectPreparedRun':case 'resolveBinding':value=this.inspect(request.input);break;
      case 'revokeBinding':value=this.revoke(request.input);break;
      case 'admitPreparedRun':value=this.admit(request.input);break;
      case 'reconcileOperation':value=this.reconcile(request.input);break;
      default:fail('UNSUPPORTED_CAPABILITY');
    }
    need(this.defs.values.get(request.operation)?.(value),'INTERNAL_ERROR');return {ok:true,value};
  }
}
