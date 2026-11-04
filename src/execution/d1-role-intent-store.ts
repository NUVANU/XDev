import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonical, JobStore, productionJobRoot } from '../job-runtime/store.ts';
import type { D1WorkerSendPacket, D1WorkerSendCommand, D1WorkerObservationCommand, Job,
  D1ContextRefreshReceipt } from '../job-runtime/contracts.ts';
import { d1Canonical, d1WorkerMessageV2, validateD1ContextRefreshReceipt,
  validateD1WorkerContext } from '../job-runtime/contracts.ts';
import { readD1ContextRefresh, verifyD1ContextRefreshSource } from './d1-context-refresh.ts';
import { readCurrentWorkerObservation, readRoleSource, readFrozenRoleSource, readFrozenRegistrationBytes,
  readWorkerHostObservation, parseWorkerHostObservationBytes, workerMessage, workspaceManifest } from './d1-preparation-source.ts';
import type { RoleSource } from './d1-preparation-source.ts';

const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function check(v:unknown,code:string):asserts v {if(!v)throw Error(code);}
function exact(v:unknown,keys:string[]):asserts v is Record<string,any> {check(v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|'),'D1_ROLE_JOURNAL_INVALID');}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function noLink(path:string){for(let p=path;;p=dirname(p)){if(existsSync(p))check(!lstatSync(p).isSymbolicLink(),'D1_ROLE_STORAGE_LINKED');if(dirname(p)===p)break;}}
export type RoleIntent={kind:'ROLE_PREPARED';role:'Worker';request_id:string;attempt_id:string;reservation_id:string;
  project_id:string;job_id:string;task_id:string;contract_sha256:string;create_input_sha256:string;job_revision:number;registration_sha256:string;source_watermark:string;
  project_resource_id:string;task_resource_id:string;project_charge:1;task_charge:1;prepared_at:string;host_path:'NATIVE_AGENT_PENDING_REVALIDATION';
  context_refresh?:D1ContextRefreshReceipt};
type Register={kind:'REGISTER';registration_path:string;registration_sha256:string;source_watermark:string;create_input_sha256:string;job_revision:number;registration:RoleSource['registration']};
export type RoleSendIntent={kind:'SEND_INTENT';attempt_id:string;send_id:string;reservation_id:string;packet_sha256:string;
  packet:D1WorkerSendPacket;job_revision:number;job_head_sha256:string};
type Command=Register|RoleIntent|RoleSendIntent;
type Event={revision:number;previous_sha256:string|null;at:string;command:Command;sha256:string};
type Journal={format:'xdev-d1-role-domain-1';events:Event[]};
export type RoleFault=(phase:'BEFORE_REPLACE'|'AFTER_COMMIT')=>void;
export class RoleWriteError extends Error {
  readonly phase:'PRE_COMMIT_REJECTED'|'COMMITTED_THEN_ERROR';readonly revision:number|null;
  constructor(phase:'PRE_COMMIT_REJECTED'|'COMMITTED_THEN_ERROR',revision:number|null,cause:unknown){super(phase,{cause});this.phase=phase;this.revision=revision;}
}

/** One registered control domain, one pending Worker reservation/intent. */
export class D1RoleIntentStore {
  private rejectWrite():void {throw Error('D1_INTAKE_READ_ONLY');}
  readonly domain:string;readonly journalPath:string;
  readonly controlRoot:string;readonly projectId:string;private readonly fault?:RoleFault;private holding=false;
  constructor(controlRoot:string,projectId:string,fault?:RoleFault){
    this.controlRoot=controlRoot;this.projectId=projectId;this.fault=fault;
    this.domain=join(controlRoot,'d1-role-domains',createHash('sha256').update(projectId).digest('hex'));
    this.journalPath=join(this.domain,'journal.json');noLink(controlRoot);noLink(this.domain);
    check(existsSync(controlRoot)&&lstatSync(controlRoot).isDirectory(),'D1_ROLE_CONTROL_ROOT_MISSING');
  }
  private event(command:Command,revision:number,previous_sha256:string|null,at?:string):Event{
    const body={revision,previous_sha256,at:at??new Date().toISOString(),command};return {...body,sha256:hash(body)};
  }
  private read():Journal {
    noLink(this.domain);noLink(this.journalPath);
    check(existsSync(this.domain),'D1_ROLE_DOMAIN_NOT_REGISTERED');
    check(lstatSync(this.domain).isDirectory()&&existsSync(this.journalPath),'D1_ROLE_JOURNAL_MISSING_OR_CORRUPT');
    check(lstatSync(this.journalPath).isFile(),'D1_ROLE_JOURNAL_MISSING_OR_CORRUPT');
    const text=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(this.journalPath));
    let raw:unknown;try{raw=JSON.parse(text);}catch{throw Error('D1_ROLE_JOURNAL_MISSING_OR_CORRUPT');}
    check(canonical(raw)+'\n'===text,'D1_ROLE_JOURNAL_MISSING_OR_CORRUPT');exact(raw,['format','events']);
    check(raw.format==='xdev-d1-role-domain-1'&&Array.isArray(raw.events)&&raw.events.length>=1&&raw.events.length<=3,'D1_ROLE_JOURNAL_INVALID');
    let previous:string|null=null;
    raw.events.forEach((event:unknown,i:number)=>{
      exact(event,['revision','previous_sha256','at','command','sha256']);
      const {sha256,...body}=event;
      check(event.revision===i&&event.previous_sha256===previous&&event.sha256===hash(body),'D1_ROLE_HISTORY_DRIFT');
      const c=event.command;
      if(i===0){exact(c,['kind','registration_path','registration_sha256','source_watermark','create_input_sha256','job_revision','registration']);
        check(c.kind==='REGISTER'&&c.registration.project_id===this.projectId&&/^[0-9a-f]{64}$/.test(c.registration_sha256)&&
          /^[0-9a-f]{64}$/.test(c.create_input_sha256),'D1_ROLE_REGISTER_INVALID');}
      else if(i===1){exact(c,['kind','role','request_id','attempt_id','reservation_id','project_id','job_id','task_id','contract_sha256','create_input_sha256','job_revision','registration_sha256','source_watermark','project_resource_id','task_resource_id','project_charge','task_charge','prepared_at','host_path',...(Object.hasOwn(c,'context_refresh')?['context_refresh']:[])]);
        check(c.kind==='ROLE_PREPARED'&&c.role==='Worker'&&uuid.test(c.request_id)&&uuid.test(c.attempt_id)&&uuid.test(c.reservation_id)&&
          c.project_id===this.projectId&&c.project_charge===1&&c.task_charge===1&&c.host_path==='NATIVE_AGENT_PENDING_REVALIDATION','D1_ROLE_INTENT_INVALID');
        if(c.context_refresh){const r=c.context_refresh;
          check(r.phase==='PREPARE'&&r.format==='xdev-d1-xmem-refresh-1'&&
            typeof r.host_call_at==='string'&&Number.isFinite(Date.parse(r.host_call_at))&&
            Date.parse(event.at)-Date.parse(r.host_call_at)>=0&&
            Date.parse(event.at)-Date.parse(r.host_call_at)<=5*60*1000&&
            r.source_claim==='COORDINATOR_TRANSFERRED_XMEM_RESPONSE'&&
            r.xmem_receipt_authenticated===false,'D1_ROLE_CONTEXT_REFRESH_INVALID');}}
      else {exact(c,['kind','attempt_id','send_id','reservation_id','packet_sha256','packet','job_revision','job_head_sha256']);
        const prepared=raw.events[1].command as RoleIntent,packet=c.packet as D1WorkerSendPacket;
        check(c.kind==='SEND_INTENT'&&uuid.test(c.send_id)&&c.attempt_id===prepared.attempt_id&&
          c.reservation_id===prepared.reservation_id&&c.packet_sha256===hash(packet)&&
          c.job_revision===prepared.job_revision&&/^[0-9a-f]{64}$/.test(c.job_head_sha256)&&
          ['xdev-d1-worker-send-1','xdev-d1-worker-send-2'].includes(packet.format)&&
          (packet.format==='xdev-d1-worker-send-1'?!packet.context:
            !!packet.context&&!!prepared.context_refresh&&
            packet.context.prepare_event_at===raw.events[1].at&&
            packet.context.send_event_at===event.at&&
            d1Canonical(packet.context.prepare_refresh)===d1Canonical(prepared.context_refresh)&&
            typeof packet.context.send_refresh?.host_call_at==='string'&&
            Date.parse(event.at)-Date.parse(packet.context.send_refresh.host_call_at)>=0&&
            Date.parse(event.at)-Date.parse(packet.context.send_refresh.host_call_at)<=5*60*1000)&&
          packet.attempt_id===c.attempt_id&&packet.send_id===c.send_id&&
          packet.registration_sha256===prepared.registration_sha256&&packet.create_input_sha256===prepared.create_input_sha256&&
          packet.contract_sha256===prepared.contract_sha256&&packet.resource_revision===1&&
          packet.resource_head_sha256===raw.events[1].sha256&&packet.job_revision===c.job_revision&&
          packet.job_head_sha256===c.job_head_sha256,'D1_ROLE_SEND_INVALID');}
      if(i===1){const registered=raw.events[0].command as Register,intent=c as RoleIntent;
        check(intent.job_id===registered.registration.job_id&&intent.task_id===registered.registration.task_id&&
          intent.contract_sha256===registered.registration.contract_sha256&&intent.create_input_sha256===registered.create_input_sha256&&
          intent.registration_sha256===registered.registration_sha256&&
          intent.source_watermark===registered.source_watermark&&intent.job_revision===registered.job_revision&&
          intent.project_resource_id===registered.registration.resources.project_resource_id&&
          intent.task_resource_id===registered.registration.resources.task_resource_id,'D1_ROLE_INTENT_SOURCE_DRIFT');}
      previous=sha256;
    });
    return raw as Journal;
  }
  private lock<T>(fn:()=>T):T{
    check(!this.holding,'D1_ROLE_LOCK_REENTRY');
    const path=join(this.domain,'writer.lock'),deadline=Date.now()+5000;
    while(true){try{mkdirSync(path,{mode:0o700});break;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;noLink(path);
      check(Date.now()<deadline,'D1_ROLE_WRITER_BUSY_OR_UNKNOWN');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}
    const stat=lstatSync(path),identity=`${stat.dev}:${stat.ino}`;
    try{this.holding=true;return fn();}
    finally{this.holding=false;const end=lstatSync(path);check(end.isDirectory()&&`${end.dev}:${end.ino}`===identity,'D1_ROLE_WRITER_OWNERSHIP_LOST');rmdirSync(path);}
  }
  private commit(journal:Journal,revision:number){
    const tmp=this.journalPath+'.'+randomUUID()+'.tmp';let fd:number|undefined,committed=false;
    try {fd=openSync(tmp,'wx',0o600);writeFileSync(fd,canonical(journal)+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;
      this.fault?.('BEFORE_REPLACE');noLink(this.journalPath);renameSync(tmp,this.journalPath);committed=true;
      if(process.platform!=='win32'){const dir=openSync(this.domain,'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
      this.fault?.('AFTER_COMMIT');
    }catch(cause){throw new RoleWriteError(committed?'COMMITTED_THEN_ERROR':'PRE_COMMIT_REJECTED',committed?revision:null,cause);}
    finally{if(fd!==undefined)closeSync(fd);if(existsSync(tmp))unlinkSync(tmp);}
  }
  private match(journal:Journal,source:RoleSource){const c=journal.events[0]!.command as Register;
    check(c.registration_path===source.registration_path&&c.registration_sha256===source.registration_sha256&&
      c.source_watermark===source.source_watermark&&c.create_input_sha256===source.create_input_sha256&&c.job_revision===source.job_revision&&
      canonical(c.registration)===canonical(source.registration),'D1_ROLE_REGISTRATION_CONFLICT');}
  registrationPath(){return (this.read().events[0]!.command as Register).registration_path;}
  /** Caller must acquire this project lock before the Job lock. */
  withProjectLock<T>(fn:()=>T):T {return this.lock(fn);}
  assertProjectLockHeld(controlRoot:string,projectId:string){
    check(this.holding&&this.controlRoot===controlRoot&&this.projectId===projectId,'D1_ROLE_LOCK_REQUIRED');
  }
  /** Revalidate the same physical sources after the irreversible resource append,
   * while the resource lock and then the Job lock are both still held. */
  verifyLockedSendSource(command:D1WorkerSendCommand,job:Job,jobHeadSha:string){
    this.assertProjectLockHeld(this.controlRoot,this.projectId);
    const resource=this.inspectSendDomain(),packet=command.packet;
    check(resource.send&&resource.send.send_id===command.send_id&&
      resource.send.packet_sha256===command.packet_sha256,'D1_WORKER_RESOURCE_PAIR_REQUIRED');
    const source=readFrozenRoleSource(resource.registration.registration_path,this.controlRoot,this.projectId,
      job.project.workspace_root,job.job_id,command.task_id);
    check(source.registration_sha256===resource.registration.registration_sha256&&
      source.source_watermark===resource.registration.source_watermark&&
      source.create_input_sha256===resource.registration.create_input_sha256&&
      source.test_only===packet.test_only&&packet.registration_sha256===source.registration_sha256&&
      packet.create_input_sha256===source.create_input_sha256&&
      canonical(source.dispatch_scope)===canonical(packet.allowed_scope)&&
      canonical(source.registration.authorization.forbidden_scope)===canonical(packet.forbidden_scope)&&
      packet.authorization_expires_at===source.registration.authorization.expires_at&&
      packet.spawn_args.model===source.registration.authorization.model&&
      packet.spawn_args.reasoning_effort===source.registration.authorization.effort,
      'D1_WORKER_SOURCE_PROOF_REQUIRED');
    const current=readCurrentWorkerObservation(packet.current_observation_path,source,command.attempt_id,
      {job_revision:job.revision,job_head_sha256:jobHeadSha,resource_revision:1,
        resource_head_sha256:resource.send.packet.resource_head_sha256});
    const task=job.tasks.find(t=>t.task_id===command.task_id);
    if(task?.d1_context){
      check(packet.format==='xdev-d1-worker-send-2'&&!!packet.context,
        'D1_WORKER_CONTEXT_REQUIRED');
      validateD1WorkerContext(packet.context,task.d1_context,resource.send_at!);
      check(resource.prepared_event_at===packet.context.prepare_event_at&&
        d1Canonical(resource.prepared?.context_refresh)===
          d1Canonical(packet.context.prepare_refresh)&&
        packet.context.send_refresh.host_session_ref===current.value.host.session_ref,
        'D1_WORKER_CONTEXT_DRIFT');
      verifyD1ContextRefreshSource(packet.context.prepare_refresh,this.controlRoot,
        job.project.workspace_root,task.d1_context,'PREPARE',packet.context.prepare_event_at);
      verifyD1ContextRefreshSource(packet.context.send_refresh,this.controlRoot,
        job.project.workspace_root,task.d1_context,'SEND',resource.send_at!);
    }else check(packet.format==='xdev-d1-worker-send-1'&&!packet.context,
      'D1_WORKER_CONTEXT_DRIFT');
    check(task&&current.sha256===packet.current_observation_sha256&&
      canonical(current.manifest)===canonical(packet.manifest)&&
      packet.spawn_args.task_name===`d1_worker_${command.attempt_id.replaceAll('-','')}`&&
      packet.spawn_args.message===(packet.context?
        d1WorkerMessageV2(task.key,task.task_id,job.project.workspace_root,
          task.contract_ref.sha256,source.dispatch_scope,
          source.registration.authorization.forbidden_scope,current.manifest,packet.context):
        workerMessage(task.key,task.task_id,job.project.workspace_root,
          task.contract_ref.sha256,source.dispatch_scope,
          source.registration.authorization.forbidden_scope,current.manifest))&&
      canonical(packet.context_pack_refs)===canonical(job.context_pack_refs)&&
      canonical(packet.authority_source_refs)===canonical([...new Set([
        source.registration.authorization.source_ref,source.registration.history.source_ref,
        source.registration.history.parent_source_ref,current.value.owner.source_ref])])&&
      canonical(packet.host_context)===canonical({session_ref:current.value.host.session_ref,
        parent_cwd:current.value.host.parent_cwd,skill_path:current.value.host.skill_path,
        skill_sha256:current.value.host.skill_sha256,tool_schema_sha256:current.value.host.tool_schema_sha256,
        context_control:'PARTIAL'})&&packet.observation_limit===current.value.observation_limit&&
      packet.deadline_at===current.value.deadline_at,
      'D1_WORKER_SOURCE_PROOF_REQUIRED');
  }
  verifyLockedObservationSource(command:D1WorkerObservationCommand,job:Job,evidence:Record<string,any>){
    this.assertProjectLockHeld(this.controlRoot,this.projectId);
    const resource=this.inspectSendDomain(),run=job.runs.find(r=>r.run_id===command.run_id),packet=run?.d1_worker?.packet;
    check(resource.send&&packet&&resource.send.send_id===command.send_id&&
      packet.send_id===command.send_id&&packet.attempt_id===command.attempt_id,
      'D1_WORKER_RESOURCE_PAIR_REQUIRED');
    readFrozenRegistrationBytes(resource.registration.registration_path,this.controlRoot,
      resource.registration.registration_sha256,resource.registration.registration);
    check(canonical(workspaceManifest(job.project.workspace_root))===
      canonical(evidence.current_workspace_manifest),'D1_WORKER_CURRENT_WORKSPACE_DRIFT');
    const expected={project_id:packet.project_id,job_id:packet.job_id,task_id:packet.task_id,
      attempt_id:packet.attempt_id,send_id:packet.send_id,session_ref:packet.host_context.session_ref,
      test_only:packet.test_only,spawn_args:packet.spawn_args,send_at:resource.send_at??undefined};
    const observed=readWorkerHostObservation(evidence.source_file_path,this.controlRoot,expected);
    check(observed.sha256===evidence.source_file_sha256&&
      observed.bytes.toString('utf8')===evidence.source_file_utf8,'D1_WORKER_EVIDENCE_SOURCE_MISMATCH');
    const parsed=parseWorkerHostObservationBytes(Buffer.from(evidence.source_file_utf8,'utf8'),expected),v=parsed.value;
    const final=v.final_manifest,mismatch=final!==null&&canonical(final)!==canonical(evidence.current_workspace_manifest);
    check(evidence.current_workspace_mismatch===mismatch&&command.observed_state===v.state&&
      command.host_agent_id===v.host_agent_id&&command.host_task_path===v.host_task_path&&
      command.observed_at===v.observed_at&&command.final_manifest_sha256===(final===null?null:hash(final))&&
      canonical(command.final_manifest)===canonical(final)&&canonical(command.active_writers)===canonical(v.active_writers)&&
      canonical(command.unknown_writers)===canonical([...v.unknown_writers,...(mismatch?['CURRENT_WORKSPACE_MISMATCH']:[])])&&
      command.actual_model===v.actual_model&&command.actual_effort===v.actual_effort,
      'D1_WORKER_EVIDENCE_COMMAND_MISMATCH');
  }
  inspectSendDomain(){const j=this.read();return {revision:j.events.length-1,head_sha256:j.events.at(-1)!.sha256,
    registration:structuredClone(j.events[0]!.command as Register),
    prepared:j.events[1]?structuredClone(j.events[1].command as RoleIntent):null,
    prepared_event_at:j.events[1]?.at??null,
    send:j.events[2]?structuredClone(j.events[2].command as RoleSendIntent):null,
    send_at:j.events[2]?.at??null};}
  inspectSendDomainIfPresent(){return existsSync(this.domain)?this.inspectSendDomain():null;}
  appendSendLocked(command:RoleSendIntent){
    this.rejectWrite();
    check(this.holding,'D1_ROLE_LOCK_REQUIRED');const j=this.read();
    check(j.events.length===2,'D1_ROLE_SEND_ALREADY_EXISTS');
    const prepared=j.events[1]!.command as RoleIntent;
    check(command.attempt_id===prepared.attempt_id&&command.reservation_id===prepared.reservation_id&&
      command.packet.resource_head_sha256===j.events[1]!.sha256&&command.packet_sha256===hash(command.packet),
      'D1_ROLE_SEND_CONFLICT');
    const sendAt=command.packet.context?.send_event_at;
    if(sendAt){const now=Date.now(),at=Date.parse(sendAt),call=Date.parse(command.packet.context!.send_refresh.host_call_at);
      check(Number.isFinite(at)&&now-at>=0&&now-at<=5000&&Number.isFinite(call)&&
        at-call>=0&&at-call<=5*60*1000&&
        command.packet.context!.prepare_event_at===j.events[1]!.at,
        'D1_CONTEXT_REFRESH_INVALID');}
    j.events.push(this.event(command,2,j.events[1]!.sha256,sendAt));this.commit(j,2);
    const after=this.read();check(canonical(after.events[2]!.command)===canonical(command),'D1_ROLE_SEND_COMMIT_UNCERTAIN');
    return {revision:2,head_sha256:after.events[2]!.sha256};
  }
  register(source:RoleSource,revalidate:()=>RoleSource){
    this.rejectWrite();
    const parent=dirname(this.domain);noLink(parent);
    if(!existsSync(parent))mkdirSync(parent,{mode:0o700});
    noLink(parent);check(lstatSync(parent).isDirectory(),'D1_ROLE_STORAGE_INVALID');
    if(existsSync(this.domain)){const current=this.read();this.match(current,source);this.match(current,revalidate());return {status:'ROLE_DOMAIN_REPLAY' as const,revision:current.events.length-1};}
    try{mkdirSync(this.domain,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw Error('D1_ROLE_DOMAIN_CONFLICT');throw error;}
    // A directory without a complete Journal is deliberately not reconstructed.
    return this.lock(()=>{const current=revalidate();
      check(current.registration_path===source.registration_path&&current.registration_sha256===source.registration_sha256&&
        current.source_watermark===source.source_watermark&&current.create_input_sha256===source.create_input_sha256&&current.job_revision===source.job_revision&&
        canonical(current.registration)===canonical(source.registration),'D1_ROLE_SOURCE_DRIFT');
      const command:Register={kind:'REGISTER',registration_path:current.registration_path,registration_sha256:current.registration_sha256,
      source_watermark:current.source_watermark,create_input_sha256:current.create_input_sha256,job_revision:current.job_revision,registration:current.registration};
      const journal:Journal={format:'xdev-d1-role-domain-1',events:[this.event(command,0,null)]};
      this.commit(journal,0);return {status:'ROLE_DOMAIN_REGISTERED' as const,revision:0};});
  }
  inspect(source:RoleSource){const journal=this.read();this.match(journal,source);
    const prepared=journal.events[1]?.command as RoleIntent|undefined;
    return {revision:journal.events.length-1,registered:true,intent:prepared??null,
      project_slots_used:source.registration.history.project_consumed+source.registration.history.project_holds+(prepared?1:0),
      task_slots_used:source.registration.history.task_consumed+source.registration.history.task_holds+(prepared?1:0)};
  }
  prepare(source:RoleSource,requestId:string,revalidate:()=>RoleSource,refreshPath?:string){
    this.rejectWrite();
    check(uuid.test(requestId),'D1_ROLE_REQUEST_INVALID');
    return this.lock(()=>{
      const journal=this.read();this.match(journal,source);
      // The legacy callback may veto a request, but it cannot supply admission
      // facts. Run it before taking the Job lock; never call caller code between
      // the authoritative Job read and the resource commit.
      this.match(journal,revalidate());
      const registered=journal.events[0]!.command as Register,r=registered.registration;
      const jobs=new JobStore(productionJobRoot(this.controlRoot,this.projectId),
        {project_id:this.projectId,workspace_root:r.workspace_root});
      noLink(jobs.root);
      check(existsSync(jobs.root)&&lstatSync(jobs.root).isDirectory(),'D1_ROLE_JOB_STORAGE_MISSING');
      // Use the existing resource -> Job lock order and retain both through the
      // hold commit. IDs and paths come from the persistent REGISTER, not source.
      return jobs.withD1JobLock(r.job_id,this,tx=>{
        const locked=tx.inspect();
        const current=readRoleSource(registered.registration_path,this.controlRoot,
          this.projectId,r.workspace_root,r.job_id,r.task_id);
        this.match(journal,current);
        check(locked.revision===registered.job_revision&&canonical(locked.job)===canonical(current.job),
          'D1_ROLE_PERSISTENT_JOB_DRIFT');
        const task=locked.job.tasks.find(t=>t.task_id===r.task_id);
        check(task&&task.key===r.task_key&&task.contract_ref.sha256===r.contract_sha256,
          'D1_ROLE_PERSISTENT_TASK_DRIFT');
        const existing=journal.events[1]?.command as RoleIntent|undefined;
        if(existing){check(existing.request_id===requestId&&existing.source_watermark===current.source_watermark&&
          existing.create_input_sha256===current.create_input_sha256&&
          existing.job_revision===current.job_revision&&
          (!!task.d1_context)===(!!existing.context_refresh)&&
          (!refreshPath||existing.context_refresh?.file_path===refreshPath),
          'D1_ROLE_INTENT_ALREADY_EXISTS');return {intent:existing,revision:1,replayed:true as const};}
        check(journal.events.length===1,'D1_ROLE_JOURNAL_INVALID');
        check((!!task.d1_context)===(!!refreshPath),'D1_CONTEXT_REFRESH_REQUIRED_BEFORE_PREPARE');
        const refresh=task.d1_context?readD1ContextRefresh(refreshPath!,this.controlRoot,
          r.workspace_root,task.d1_context,'PREPARE',new Date().toISOString()):null;
        const h=current.registration.history;
        check(h.project_consumed+h.project_holds+1<=r.resources.project_limit&&
          h.task_consumed+h.task_holds+1<=r.resources.task_limit,'D1_ROLE_QUOTA_EXHAUSTED');
        const preparedAt=refresh?new Date().toISOString():undefined;
        if(refresh)validateD1ContextRefreshReceipt(refresh,task.d1_context!,'PREPARE',preparedAt!);
        const intent:RoleIntent={kind:'ROLE_PREPARED',role:'Worker',request_id:requestId,attempt_id:randomUUID(),reservation_id:randomUUID(),
          project_id:r.project_id,job_id:r.job_id,task_id:r.task_id,contract_sha256:r.contract_sha256,
          create_input_sha256:current.create_input_sha256,job_revision:current.job_revision,
          registration_sha256:current.registration_sha256,source_watermark:current.source_watermark,
          project_resource_id:r.resources.project_resource_id,task_resource_id:r.resources.task_resource_id,project_charge:1,task_charge:1,
          prepared_at:preparedAt??new Date().toISOString(),host_path:'NATIVE_AGENT_PENDING_REVALIDATION',
          ...(refresh?{context_refresh:refresh}:{})};
        journal.events.push(this.event(intent,1,journal.events[0]!.sha256,preparedAt));this.commit(journal,1);
        const after=this.read();check(canonical(after.events[1]!.command)===canonical(intent),'D1_ROLE_COMMIT_UNCERTAIN');
        if(refresh)verifyD1ContextRefreshSource(refresh,this.controlRoot,r.workspace_root,
          task.d1_context!,'PREPARE',after.events[1]!.at);
        return {intent,revision:1,replayed:false as const};
      });
    });
  }
}
