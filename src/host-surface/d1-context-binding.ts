import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { D1ContextProjectLock } from '../execution/d1-context-project-lock.ts';
import { D1_XMEM_R4_BUILD, d1Canonical, parseD1UniqueJson, validateD1ContextBinding,
  type D1ContextBindCommand, type Job, type JobId, type TaskId } from '../job-runtime/contracts.ts';
import { JobStore, productionJobRoot } from '../job-runtime/store.ts';
import { readVerifiedD1Init } from '../project-model/init-receipt.ts';
import { assertD1ExecutionClosed, type RoleSubject } from './d1-role-preparation.ts';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex=/^[0-9a-f]{64}$/;
function need(v:unknown,code:string):asserts v {if(!v)throw Error(code);}
function exact(v:unknown,keys:string[],code:string):asserts v is Record<string,any>{
  need(v&&typeof v==='object'&&!Array.isArray(v)&&
    Object.keys(v).sort().join('|')===[...keys].sort().join('|'),code);
}
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
function inside(root:string,path:string){const r=relative(root,path);return r===''||
  (!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));}
function noLinkedComponents(root:string,path:string,code:string){
  need(inside(root,path)&&existsSync(root),code);
  need(!lstatSync(root).isSymbolicLink(),code);
  const rest=relative(root,path);let here=root;
  for(const part of rest.split(sep).filter(Boolean)){
    here=join(here,part);need(existsSync(here)&&!lstatSync(here).isSymbolicLink(),code);
  }
}
function readBounded(path:string,root:string,max:number,code:string):Buffer{
  need(isAbsolute(path)&&resolve(path)===path&&inside(root,path),code);
  noLinkedComponents(root,path,code);
  const stat=lstatSync(path);need(stat.isFile()&&stat.nlink===1&&stat.size<=max,code);
  return readFileSync(path);
}
function parse(bytes:Buffer,code:string):any{
  let v:unknown;try{v=parseD1UniqueJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch{throw Error(code);}need(v&&typeof v==='object'&&!Array.isArray(v),code);return v;
}

/** Coordinator-transferred XMem bytes only. No MCP call, Host send, or role
 * reservation can occur here. The real Host transcript is checked separately. */
export function bindD1Context(subject:RoleSubject,bindingFile:string){
  assertD1ExecutionClosed(subject);
  need(isAbsolute(subject.controlRoot)&&resolve(subject.controlRoot)===subject.controlRoot&&
    isAbsolute(subject.workspaceRoot)&&resolve(subject.workspaceRoot)===subject.workspaceRoot&&
    subject.projectId.trim().length>0,'D1_CONTEXT_SUBJECT_INVALID');
  const guard=new D1ContextProjectLock(subject.controlRoot,subject.projectId);
  const store=new JobStore(productionJobRoot(subject.controlRoot,subject.projectId),
    {project_id:subject.projectId,workspace_root:subject.workspaceRoot});
  const commandFrom=(job:Job):D1ContextBindCommand=>{
    const raw=readBounded(bindingFile,subject.controlRoot,32*1024,'D1_CONTEXT_SOURCE_INVALID');
    const input=parse(raw,'D1_CONTEXT_SOURCE_INVALID');
    exact(input,['format','request_id','expected_job_revision','context_relation','xmem_project_root',
      'xmem_project_id','xmem_workspace_id','current_task','source_scope','revision_id','source_id',
      'retrieved_at','mcp_request','mcp_result','summary','authority_files'],
      'D1_CONTEXT_SOURCE_INVALID');
    need(input.format==='xdev-d1-context-input-1'&&uuid.test(input.request_id)&&
      input.expected_job_revision===0&&input.context_relation==='PARENT_ENGINEERING_PROJECT_TO_ISOLATED_ASSET'&&
      isAbsolute(input.xmem_project_root)&&resolve(input.xmem_project_root)===input.xmem_project_root&&
      input.xmem_project_root!==subject.workspaceRoot&&inside(input.xmem_project_root,subject.workspaceRoot)&&
      input.mcp_request&&input.mcp_result&&typeof input.summary!=='undefined',
      'D1_CONTEXT_SOURCE_INVALID');
    const age=Date.now()-Date.parse(input.retrieved_at);
    need(Number.isFinite(age)&&age>=0&&age<=5*60*1000,'D1_CONTEXT_SOURCE_EXPIRED');
    const config=parse(readBounded(join(input.xmem_project_root,'.xmem','config.json'),
      input.xmem_project_root,8192,'D1_CONTEXT_PROJECT_IDENTITY'),
      'D1_CONTEXT_PROJECT_IDENTITY');
    const xmemPolicy=parse(readBounded(join(input.xmem_project_root,'.xmem','standalone-v1.json'),
      input.xmem_project_root,8192,'D1_CONTEXT_PROJECT_IDENTITY'),
      'D1_CONTEXT_PROJECT_IDENTITY');
    need(config.project_id===input.xmem_project_id&&resolve(config.root)===input.xmem_project_root&&
      xmemPolicy.workspace_id===input.xmem_workspace_id&&
      Array.isArray(xmemPolicy.allowed_roles)&&xmemPolicy.allowed_roles.includes('developer'),
      'D1_CONTEXT_PROJECT_IDENTITY');
    need(Array.isArray(input.authority_files)&&input.authority_files.length>0&&
      input.authority_files.length<=8,'D1_CONTEXT_AUTHORITY_INVALID');
    for(const file of input.authority_files){
      exact(file,['path','sha256'],'D1_CONTEXT_AUTHORITY_INVALID');
      need(typeof file.path==='string'&&typeof file.sha256==='string'&&hex.test(file.sha256)&&
        isAbsolute(file.path)&&resolve(file.path)===file.path&&
        !inside(subject.workspaceRoot,file.path)&&
        sha(readBounded(file.path,input.xmem_project_root,1024*1024,
          'D1_CONTEXT_AUTHORITY_INVALID'))===file.sha256,'D1_CONTEXT_AUTHORITY_INVALID');
    }
    const source=readVerifiedD1Init(subject.workspaceRoot);
    need(job.d1_intake?.receipt_sha256===source.receipt_sha256&&job.project.project_id===subject.projectId&&
      job.project.workspace_root===subject.workspaceRoot&&job.revision>=0&&job.tasks.length===1,
      'D1_CONTEXT_JOB_SOURCE_DRIFT');
    const task=job.tasks.find(t=>t.task_id===subject.taskId);
    need(task&&task.key===source.seed.tasks[0]?.task_id&&task.generation===0,
      'D1_CONTEXT_TASK_SOURCE_DRIFT');
    const taskBytes=readBounded(join(subject.workspaceRoot,'.xdev','tasks',task.key+'.json'),
      subject.workspaceRoot,1024*1024,'D1_CONTEXT_TASK_SOURCE_DRIFT');
    need(sha(taskBytes)===task.contract_ref.sha256,'D1_CONTEXT_TASK_SOURCE_DRIFT');
    const policyPath='xmem-context.json';
    need(source.seed.approved_design_refs.includes(policyPath),'D1_CONTEXT_POLICY_NOT_APPROVED');
    const policyBytes=readBounded(join(subject.workspaceRoot,policyPath),subject.workspaceRoot,
      8192,'D1_CONTEXT_POLICY_INVALID');
    const policySha=sha(policyBytes);
    need(source.receipt.source_files.some(f=>f.path===policyPath&&f.sha256===policySha),
      'D1_CONTEXT_POLICY_DRIFT');
    const policy=parse(policyBytes,'D1_CONTEXT_POLICY_INVALID');
    exact(policy,['format','task_key','xmem_project_id','xmem_workspace_id','current_task',
      'source_scope','revision_id','source_id'],'D1_CONTEXT_POLICY_INVALID');
    need(policy.format==='xdev-d1-xmem-context-policy-1'&&policy.task_key===task.key&&
      policy.xmem_project_id===input.xmem_project_id&&
      policy.xmem_workspace_id===input.xmem_workspace_id&&
      d1Canonical(policy.current_task)===d1Canonical(input.current_task)&&
      d1Canonical(policy.source_scope)===d1Canonical(input.source_scope)&&
      policy.revision_id===input.revision_id&&policy.source_id===input.source_id,
      'D1_CONTEXT_POLICY_MISMATCH');
    const request=input.mcp_request;
    exact(request,['project_root','input'],'D1_CONTEXT_MCP_REQUEST_INVALID');
    exact(request.input,['task_ref','task_version','role','scopes','revision_ids','query',
      'payload_budget_bytes'],'D1_CONTEXT_MCP_REQUEST_INVALID');
    need(request.project_root===input.xmem_project_root&&
      request.input.task_ref===policy.current_task.task_ref&&
      request.input.task_version===policy.current_task.task_version&&
      request.input.role===policy.current_task.role&&
      d1Canonical(request.input.scopes)===d1Canonical([policy.source_scope])&&
      d1Canonical(request.input.revision_ids)===d1Canonical([policy.revision_id])&&
      typeof request.input.query==='string'&&
      Number.isSafeInteger(request.input.payload_budget_bytes)&&
      request.input.payload_budget_bytes>0&&request.input.payload_budget_bytes<=8192,
      'D1_CONTEXT_MCP_REQUEST_INVALID');
    const result=input.mcp_result;
    need(result&&typeof result==='object'&&!Array.isArray(result)&&result.isError!==true&&
      Array.isArray(result.content)&&result.content.length===1&&
      result.content[0]?.type==='text'&&typeof result.content[0].text==='string'&&
      Buffer.byteLength(result.content[0].text,'utf8')<=16000,
      'D1_CONTEXT_MCP_ENVELOPE_INVALID');
    const responseText=result.content[0].text as string;
    const response=parse(Buffer.from(responseText,'utf8'),'D1_CONTEXT_RESPONSE_INVALID');
    need(response.ok===true&&response.runtime?.build_id===D1_XMEM_R4_BUILD&&
      response.value?.items?.length===1&&typeof response.value.items[0].content==='string',
      'D1_CONTEXT_RESPONSE_INVALID');
    const content=response.value.items[0].content as string;
    const binding={format:'xdev-d1-xmem-context-1' as const,request_id:input.request_id,
      task_id:subject.taskId as TaskId,task_key:task.key,task_generation:0 as const,
      contract_sha256:task.contract_ref.sha256,xmem_project_root:input.xmem_project_root,
      xmem_project_id:input.xmem_project_id,xmem_workspace_id:input.xmem_workspace_id,
      current_task:input.current_task,source_scope:input.source_scope,revision_id:input.revision_id,
      source_id:input.source_id,context_relation:input.context_relation,runtime_build:D1_XMEM_R4_BUILD,
      retrieved_at:input.retrieved_at,response_text:responseText,response_sha256:sha(responseText),
      mcp_request_text:d1Canonical(request),mcp_request_sha256:sha(d1Canonical(request)),
      mcp_result_text:d1Canonical(result),mcp_result_sha256:sha(d1Canonical(result)),
      context_policy_path:policyPath,context_policy_sha256:policySha,
      input_file_sha256:sha(raw),
      mcp_is_error:false as const,content,content_sha256:sha(content),summary:input.summary,
      summary_sha256:input.summary===null?null:sha(input.summary),authority_files:input.authority_files,
      source_claim:'COORDINATOR_TRANSFERRED_XMEM_RESPONSE' as const,
      xmem_receipt_authenticated:false as const};
    validateD1ContextBinding(binding);
    return {kind:'D1_CONTEXT_BIND',task_id:subject.taskId as TaskId,
      request_id:input.request_id,binding};
  };
  return guard.withLock(()=>{
    const before=store.getJob(subject.jobId as JobId);
    const saved=before.tasks.find(t=>t.task_id===subject.taskId)?.d1_context;
    const first:D1ContextBindCommand=saved?(()=>{
      const raw=readBounded(bindingFile,subject.controlRoot,32*1024,'D1_CONTEXT_SOURCE_INVALID');
      need(sha(raw)===saved.input_file_sha256,'D1_CONTEXT_ALREADY_BOUND');
      return {kind:'D1_CONTEXT_BIND',task_id:subject.taskId as TaskId,
        request_id:saved.request_id,binding:saved};
    })():commandFrom(before);
    const result=store.bindD1Context(subject.jobId as JobId,first,guard,commandFrom);
    return {...result,project_id:subject.projectId,workspace_root:subject.workspaceRoot,
      source_claim:'COORDINATOR_TRANSFERRED_XMEM_RESPONSE' as const,
      xmem_receipt_authenticated:false as const,host_spawned:false as const,
      role_reserved:false as const};
  });
}
