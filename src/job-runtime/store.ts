import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CreateJobInput, Job, JobId, TaskId, ProjectRef, Journal, JournalEvent, JobCommand, CreateCommand, ResumeObservation,
  D1WorkerSendCommand, D1WorkerObservationCommand, D1ContextBindCommand } from './contracts.ts';
import { d1WorkerMessage, d1WorkerMessageV2, parseD1UniqueJson,
  validateD1CurrentObservation, validateD1HostObservationBytes,
  validateD1WorkerContext } from './contracts.ts';
import { verifyD1ContextRefreshSource } from '../execution/d1-context-refresh.ts';
import { assertD1LocalControl, hasD1LocalControlLock } from '../host-surface/d1-local-control.ts';
import { readProfile, deriveD1IntakeInput, checkFirstSourceAge } from '../host-surface/d1-intake-source.ts';
import { canonical, productionJobRoot } from './storage-identity.ts';
import { observeD1QualityUnavailable } from '../host-surface/d1-quality-observer.ts';
import { check, createState, exact, inspectResumeState, jobId, reduce, terminalJob, UUID } from './state.ts';

export { canonical, productionJobRoot } from './storage-identity.ts';

/** Provider-neutral callback boundary. The D1 resource domain owns source and
 * Host provenance checks; Core owns its lock, journal and replay. */
type D1ResourceGuard={assertProjectLockHeld:(controlRoot:string,projectId:string)=>void;
  controlRoot:string;projectId:string;domain:string;journalPath:string;
  inspectSendDomain:()=>any;
  verifyLockedSendSource:(command:D1WorkerSendCommand,job:Job,headSha:string)=>void;
  verifyLockedObservationSource:(command:D1WorkerObservationCommand,job:Job,evidence:Record<string,any>)=>void};

const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
function noLinks(path:string) {
  const parent=dirname(path);if(parent!==path)noLinks(parent);
  if(existsSync(path))check(!lstatSync(path).isSymbolicLink(),'JOB_STORAGE_LINK_REJECTED');
}
function inside(a:string,b:string) {const r=relative(a,b);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));}
export type WriteFault = (point:'BEFORE_REPLACE'|'AFTER_COMMIT')=>void;
export class JobWriteError extends Error {
  readonly phase:'PRE_COMMIT_REJECTED'|'COMMITTED_THEN_ERROR';
  readonly job_id:JobId; readonly committed_revision:number|null;
  constructor(phase:'PRE_COMMIT_REJECTED'|'COMMITTED_THEN_ERROR',id:JobId,revision:number|null,cause:unknown){super(phase,{cause});this.phase=phase;this.job_id=id;this.committed_revision=revision;}
}

/** Trusted local controller API. Explicit external control root; constructor/queries never write.
 * No OS-administrator tamper resistance or remote execution permission is claimed.
 */
export class JobStore {
  readonly root:string;
  private readonly project:ProjectRef;
  private readonly fault?:WriteFault;
  private readonly heldJobs=new Set<string>();
  private readonly localD1:boolean;
  private plannedIntake:{requestId:string;id:JobId;inputSha:string;at:string;command:CreateCommand}|null=null;
  constructor(root:string,project:ProjectRef,options:{fault?:WriteFault}={}) {
    check(isAbsolute(root)&&resolve(root)===root,'JOB_STORAGE_PATH_INVALID');
    exact(project,['project_id','workspace_root']);check(typeof project.project_id==='string'&&project.project_id.length>0&&isAbsolute(project.workspace_root)&&resolve(project.workspace_root)===project.workspace_root,'JOB_PROJECT_INVALID');
    const localD1=root===productionJobRoot(join(project.workspace_root,'.xdev-d1-control'),project.project_id);
    check(localD1||!inside(project.workspace_root,root)&&!inside(root,project.workspace_root),'JOB_STORAGE_WORKSPACE_OVERLAP');
    if(localD1)assertD1LocalControl(project.workspace_root,dirname(root),project.project_id,
      {allowLock:hasD1LocalControlLock(dirname(root)),allowNoProfile:true});
    noLinks(root);
    check(existsSync(dirname(root))&&lstatSync(dirname(root)).isDirectory(),'JOB_STORAGE_PARENT_REQUIRED');
    if(existsSync(root))check(lstatSync(root).isDirectory(),'JOB_STORAGE_INVALID');
    this.root=root;this.project=structuredClone(project);this.fault=options.fault;this.localD1=localD1;
  }
  private path(id:JobId) {jobId(id);noLinks(this.root);const file=join(this.root,id.slice(4)+'.json');noLinks(file);return file;}
  /** Read-only lookup. The global request index is independent of a Job's
   * self-hashed Journal, so stripping every CREATE marker cannot make an
   * indexed intake look like a legacy Job. */
  private requestIndex(id:JobId):{job_id:JobId;project:ProjectRef;input_sha256:string;job_root:string}|null {
    jobId(id);const dir=join(dirname(this.root),'d1-intake-requests'),file=join(dir,id.slice(4)+'.json');
    noLinks(dir);noLinks(file);
    let entry;try{entry=lstatSync(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
    check(entry.isFile()&&!entry.isSymbolicLink(),'D1_REQUEST_STORAGE_INVALID');
    const bytes=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(file));
    let value:unknown;try{value=JSON.parse(bytes);}catch{throw Error('D1_REQUEST_INDEX_INVALID');}
    check(canonical(value)+'\n'===bytes,'D1_REQUEST_INDEX_INVALID');
    exact(value,['job_id','project','input_sha256','job_root']);
    check(value.job_id===id&&typeof value.input_sha256==='string'&&/^[0-9a-f]{64}$/.test(value.input_sha256)&&
      typeof value.job_root==='string','D1_REQUEST_INDEX_INVALID');
    exact(value.project,['project_id','workspace_root']);
    check(typeof value.project.project_id==='string'&&typeof value.project.workspace_root==='string','D1_REQUEST_INDEX_INVALID');
    return value as {job_id:JobId;project:ProjectRef;input_sha256:string;job_root:string};
  }
  private assertAInputFromCurrentSource(requestId:string,input:CreateJobInput,
    local:ReturnType<typeof assertD1LocalControl>,firstCreate:boolean):void {
    const control=dirname(this.root),snapshot=local.snapshot;
    check(snapshot?.request_id===requestId,'D1_PROFILE_SNAPSHOT_PARTIAL_OR_DRIFT_STOP');
    const fixedProfile=join(control,'profile-request.json');
    const source=readProfile({requestId,controlRoot:control,projectId:this.project.project_id,
      workspaceRoot:this.project.workspace_root,profileFile:fixedProfile},
      local.init.receipt_sha256,local.init.bundle);
    check(snapshot.profile_sha256===createHash('sha256').update(source.bytes).digest('hex'),
      'D1_PROFILE_SNAPSHOT_PARTIAL_OR_DRIFT_STOP');
    const derived=deriveD1IntakeInput({requestId,controlRoot:control,
      projectId:this.project.project_id,workspaceRoot:this.project.workspace_root,
      profileFile:fixedProfile},local.init,source.decision);
    check(canonical(input)===canonical(derived),'D1_SOURCE_DERIVED_INPUT_DRIFT');
    if(firstCreate)checkFirstSourceAge(local.init.receipt.created_at);
  }
  private assertOnlyAJob(requestId:string):void {
    const control=dirname(this.root),indexRoot=join(control,'d1-intake-requests');
    for(const dir of [this.root,indexRoot]){
      noLinks(dir);
      if(!existsSync(dir))continue;
      check(lstatSync(dir).isDirectory(),'D1_REQUEST_STORAGE_INVALID');
      for(const name of readdirSync(dir)){
        if(name.endsWith('.lock'))continue;
        check(name===`${requestId}.json`,'D1_A_SINGLE_PROFILE_JOB');
      }
    }
  }
  private load(id:JobId,missingIndexRecovery?:{request_id:string;input_sha256:string},duringAWrite=false):{journal:Journal;job:Job} {
    const local=this.localD1?assertD1LocalControl(this.project.workspace_root,dirname(this.root),
      this.project.project_id,{allowLock:hasD1LocalControlLock(dirname(this.root))}):null;
    const index=this.requestIndex(id),file=this.path(id);
    if(!existsSync(file)){check(!index,'D1_REQUEST_JOURNAL_MISSING_OR_CORRUPT');throw Error('JOB_NOT_FOUND');}
    check(lstatSync(file).isFile(),'JOB_STORAGE_INVALID');
    const bytes=readFileSync(file),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    let v:unknown;try{v=JSON.parse(text);}catch{throw Error('JOB_JOURNAL_INVALID');}
    check(canonical(v)+'\n'===text,'JOB_NONCANONICAL_OR_DUPLICATE_JSON');exact(v,['format','events']);check(v.format==='xdev-recoverable-job-1'&&Array.isArray(v.events)&&v.events.length>0,'JOB_JOURNAL_INVALID');
    let state:Job|undefined,prior:string|null=null;
    for(let i=0;i<v.events.length;i++){
      const e=v.events[i];exact(e,['revision','at','previous_sha256','command','sha256']);check(e.revision===i&&e.previous_sha256===prior,'JOB_HISTORY_DRIFT');
      const {sha256,...body}=e;check(sha256===hash(body),'JOB_HISTORY_HASH_MISMATCH');
      if(i>0&&e.command.kind==='D1_WORKER_SEND_INTENT'){
        const command=e.command as D1WorkerSendCommand,create=v.events[0].command as CreateCommand;
        check(command.packet.create_input_sha256===hash(create.input)&&command.packet.job_head_sha256===prior&&
          command.packet.job_revision===i-1,'D1_WORKER_CREATE_OR_HEAD_DRIFT');
      }
      if(i>0&&e.command.kind==='D1_WORKER_OBSERVATION')this.verifyD1Evidence((e.command as D1WorkerObservationCommand).observation_ref);
      state=i===0?createState(e.command as CreateCommand,e.at):reduce(state!,e.command as JobCommand,e.at);check(state.job_id===id&&canonical(state.project)===canonical(this.project),'JOB_PROJECT_OR_ID_DRIFT');
      if(i===0){
        const create=e.command as CreateCommand,input_sha256=hash(create.input);
        if(index){
          check(state.d1_intake?.kind==='D1_INTAKE'&&state.d1_intake.request_id===id.slice(4)&&
            index.job_id===id&&index.job_root===this.root&&canonical(index.project)===canonical(this.project)&&
            index.input_sha256===input_sha256&&this.root===productionJobRoot(dirname(this.root),this.project.project_id),
            'D1_REQUEST_CREATE_MISMATCH');
        }else if(state.d1_intake){
          // Only createIntakeJob calls this exception while holding the global
          // request lock and matching the caller's frozen CREATE input.
          check(missingIndexRecovery?.request_id===id.slice(4)&&missingIndexRecovery.input_sha256===input_sha256&&
            this.root===productionJobRoot(dirname(this.root),this.project.project_id),'D1_REQUEST_INDEX_MISSING');
        }
      }
      prior=sha256;
    }
    if(local){
      check(state!.d1_intake?.profile!==undefined,'D1_LEGACY_INTAKE_READ_ONLY');
      this.assertAInputFromCurrentSource(state!.d1_intake.request_id,
        (v.events[0]!.command as CreateCommand).input,local,false);
    }
    return {journal:v as unknown as Journal,job:state!};
  }
  private lock<T>(id:JobId,fn:()=>T):T {
    check(!this.heldJobs.has(id),'D1_JOB_LOCK_REENTRY');
    this.path(id);if(!existsSync(this.root))try{mkdirSync(this.root,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    noLinks(this.root);const lock=join(this.root,id.slice(4)+'.lock'),deadline=Date.now()+5000;
    // Bounded synchronous contention wait only. No scheduler, polling service or dispatch.
    while(true){try{mkdirSync(lock,{mode:0o700});break;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;noLinks(lock);check(Date.now()<deadline,'JOB_WRITER_BUSY_OR_OWNER_UNKNOWN');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}
    const stat=lstatSync(lock),identity=`${stat.dev}:${stat.ino}`;
    try{this.heldJobs.add(id);return fn();}finally{this.heldJobs.delete(id);noLinks(lock);const end=lstatSync(lock);check(end.isDirectory()&&`${end.dev}:${end.ino}`===identity,'JOB_WRITER_OWNERSHIP_LOST');rmdirSync(lock);}
  }
  private verifyD1Evidence(ref:{id:string;sha256:string}){
    check(typeof ref.id==='string'&&/^[0-9a-f]{64}$/.test(ref.sha256),'D1_WORKER_EVIDENCE_INVALID');
    const path=join(this.root,'evidence',ref.sha256+'.json');noLinks(path);
    check(ref.id===path&&existsSync(path)&&lstatSync(path).isFile()&&
      createHash('sha256').update(readFileSync(path)).digest('hex')===ref.sha256,'D1_WORKER_EVIDENCE_MISSING_OR_DRIFT');
    const bytes=readFileSync(path,'utf8');let value:unknown;
    try{value=JSON.parse(bytes);}catch{throw Error('D1_WORKER_EVIDENCE_INVALID');}
    check(canonical(value)+'\n'===bytes,'D1_WORKER_EVIDENCE_INVALID');
    exact(value,['format','source_file_path','source_file_sha256','source_file_utf8',
      'current_workspace_manifest','current_workspace_mismatch','coordinator_transfer_only']);
    check(value.format==='xdev-d1-host-transfer-1'&&typeof value.source_file_path==='string'&&
      isAbsolute(value.source_file_path)&&inside(dirname(this.root),value.source_file_path)&&
      typeof value.source_file_utf8==='string'&&value.coordinator_transfer_only===true&&
      Array.isArray(value.current_workspace_manifest)&&typeof value.current_workspace_mismatch==='boolean',
      'D1_WORKER_EVIDENCE_INVALID');
    check(createHash('sha256').update(Buffer.from(value.source_file_utf8,'utf8')).digest('hex')===
      value.source_file_sha256,'D1_WORKER_EVIDENCE_INVALID');
    return value;
  }
  private commit(id:JobId,journal:Journal,revision:number,beforeReplace?:()=>void) {
    const file=this.path(id),tmp=file+'.'+randomUUID()+'.tmp';let fd:number|undefined,committed=false;
    try{
      fd=openSync(tmp,'wx',0o600);writeFileSync(fd,canonical(journal)+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;
      this.fault?.('BEFORE_REPLACE');beforeReplace?.();noLinks(file);renameSync(tmp,file);committed=true;
      // Windows exposes atomic replacement plus file fsync, not a portable directory fsync.
      // On POSIX flush directory metadata too; failure after rename is still committed.
      if(process.platform!=='win32'){const dir=openSync(this.root,'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
      this.fault?.('AFTER_COMMIT');
    }catch(cause){throw new JobWriteError(committed?'COMMITTED_THEN_ERROR':'PRE_COMMIT_REJECTED',id,committed?revision:null,cause);}
    finally{if(fd!==undefined)closeSync(fd);if(existsSync(tmp))unlinkSync(tmp);}
  }
  private event(command:CreateCommand|JobCommand,revision:number,at:string,previous_sha256:string|null):JournalEvent {
    const body={revision,at,previous_sha256,command};return {...body,sha256:hash(body)};
  }
  createJob(input:CreateJobInput,expected_revision:-1):{job_id:JobId;revision:0;worker_started:false;reservation_created:false} {
    check(!this.localD1,'D1_PROFILE_ONLY_NOT_EXECUTABLE');
    check(expected_revision===-1,'JOB_REVISION_DRIFT');
    const id=`job:${randomUUID()}` as JobId,at=new Date().toISOString();
    const c:CreateCommand={kind:'CREATE',job_id:id,project:this.project,input:structuredClone(input),task_ids:input.tasks.map(()=>`task:${id.slice(4)}:${randomUUID()}` as TaskId)};
    createState(c,at);
    return this.lock(id,()=>{check(!existsSync(this.path(id)),'JOB_REVISION_DRIFT');this.commit(id,{format:'xdev-recoverable-job-1',events:[this.event(c,0,at,null)]},0);return {job_id:id,revision:0,worker_started:false,reservation_created:false};});
  }
  /** D1 registration only. A request has one identity across every project under
   * the approved control root. A committed journal is discovered before retrying
   * an index write, including after COMMITTED_THEN_ERROR. */
  prepareIntakeJob(requestId:string,id:JobId,input:CreateJobInput):void {
    check(this.localD1&&hasD1LocalControlLock(dirname(this.root)),'D1_CONTROL_PROJECT_LOCK_REQUIRED');
    check(new RegExp('^'+UUID+'$').test(requestId),'D1_REQUEST_ID_INVALID');jobId(id);
    check(id===`job:${requestId}`&&input.handoff_refs.length===1&&
      input.handoff_refs[0]?.id===`D1_INTAKE_REQUEST:${requestId}`,'D1_REQUEST_BINDING_INVALID');
    check(this.root===productionJobRoot(dirname(this.root),this.project.project_id),
      'D1_JOB_ROOT_INVALID');
    check(input.d1_profile!==undefined,'D1_PROFILE_REQUIRED');
    const at=new Date().toISOString();
    const command:CreateCommand={kind:'CREATE',job_id:id,project:this.project,
      input:structuredClone(input),task_ids:input.tasks.map(()=>`task:${id.slice(4)}:${randomUUID()}` as TaskId)};
    createState(command,at);
    this.plannedIntake={requestId,id,inputSha:hash(input),at,command};
  }
  /** The callback is one read-only additional veto, evaluated before this call's
   * first persistent write. Store repeats every mandatory check after it. */
  createIntakeJob(requestId:string,id:JobId,input:CreateJobInput,precommit:(replayed:boolean)=>void=()=>{}):{job_id:JobId;revision:number;worker_started:false;reservation_created:false;replayed:boolean} {
    check(new RegExp('^'+UUID+'$').test(requestId),'D1_REQUEST_ID_INVALID');jobId(id);
    check(id===`job:${requestId}`&&input.handoff_refs.length===1&&input.handoff_refs[0]?.id===`D1_INTAKE_REQUEST:${requestId}`,'D1_REQUEST_BINDING_INVALID');
    check(this.root===productionJobRoot(dirname(this.root),this.project.project_id),'D1_JOB_ROOT_INVALID');
    if(!input.d1_profile){
      check(existsSync(this.path(id)),'D1_LEGACY_INTAKE_READ_ONLY');
      const loaded=this.load(id);
      const original=loaded.journal.events[0]!.command as CreateCommand;
      check(canonical(original.input)===canonical(input),'D1_REQUEST_IDENTITY_CONFLICT');
      precommit(true);
      return {job_id:id,revision:loaded.job.revision,worker_started:false,reservation_created:false,replayed:true};
    }
    check(this.localD1,'D1_PROFILE_CONTROL_ROOT_REQUIRED');
    const verifyA=(firstCreate:boolean)=>{
      const control=dirname(this.root),projectLock=join(control,'project.lock');
      check(hasD1LocalControlLock(control)&&existsSync(projectLock)&&lstatSync(projectLock).isDirectory(),
        'D1_CONTROL_PROJECT_LOCK_REQUIRED');
      const bound=assertD1LocalControl(this.project.workspace_root,control,this.project.project_id,
        {allowLock:true});
      this.assertAInputFromCurrentSource(requestId,input,bound,firstCreate);
      this.assertOnlyAJob(requestId);
    };
    verifyA(!existsSync(this.path(id)));
    const planned=this.plannedIntake;
    check(planned?.requestId===requestId&&planned.id===id&&planned.inputSha===hash(input),
      'D1_INTAKE_NOT_PREFLIGHTED');
    const at=planned.at,c=planned.command;
    createState(c,at); // Same canonical plan; no caller-supplied validation flag.
    const control=dirname(this.root), requestDir=join(control,'d1-intake-requests');
    noLinks(control);check(existsSync(control)&&lstatSync(control).isDirectory(),'JOB_STORAGE_PARENT_REQUIRED');
    // The project lock excludes another XDev writer. Resolve first/replay and run
    // the caller's single veto while this Store call is still read-only.
    const beforeIndex=this.requestIndex(id),beforeJournal=existsSync(this.path(id));
    check(!beforeIndex||beforeJournal,'D1_REQUEST_JOURNAL_MISSING_OR_CORRUPT');
    check(!beforeJournal||beforeIndex,'D1_CONTROL_PARTIAL_COMMIT_STOP');
    if(beforeJournal){
      const loaded=this.load(id),original=loaded.journal.events[0]!.command as CreateCommand;
      check(canonical(original.input)===canonical(input),'D1_REQUEST_IDENTITY_CONFLICT');
    }
    precommit(beforeJournal);
    verifyA(!beforeJournal);
    if(!existsSync(requestDir))try{mkdirSync(requestDir,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    noLinks(requestDir);check(lstatSync(requestDir).isDirectory(),'D1_REQUEST_STORAGE_INVALID');
    const lock=join(requestDir,requestId+'.lock'),index=join(requestDir,requestId+'.json'),deadline=Date.now()+5000;
    while(true){try{mkdirSync(lock,{mode:0o700});break;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;noLinks(lock);check(Date.now()<deadline,'D1_REQUEST_WRITER_BUSY_OR_OWNER_UNKNOWN');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}
    const stat=lstatSync(lock),identity=`${stat.dev}:${stat.ino}`;
    try {
      const record={job_id:id,project:this.project,input_sha256:hash(input),job_root:this.root};
      const indexBytes=canonical(record)+'\n';
      let indexed=false;
      try {const entry=lstatSync(index);indexed=true;check(!entry.isSymbolicLink()&&entry.isFile()&&readFileSync(index,'utf8')===indexBytes,'D1_REQUEST_IDENTITY_CONFLICT');}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(indexed)check(existsSync(this.path(id)),'D1_REQUEST_JOURNAL_MISSING_OR_CORRUPT');
      if(!indexed&&existsSync(this.path(id)))throw Error('D1_CONTROL_PARTIAL_COMMIT_STOP');
      // The journal is the authority. An index may be absent after a committed
      // journal, so scan project namespaces while holding the global request lock.
      for(const name of readdirSync(control))if(/^recoverable-jobs-[0-9a-f]{64}$/.test(name)){
        const dir=join(control,name);noLinks(dir);check(lstatSync(dir).isDirectory(),'D1_REQUEST_STORAGE_INVALID');
        const candidate=join(dir,id.slice(4)+'.json');noLinks(candidate);
        if(existsSync(candidate))check(dir===this.root,'D1_REQUEST_IDENTITY_CONFLICT');
      }
      let replayed=false,revision=0;
      if(existsSync(this.path(id))){
        const loaded=this.load(id,indexed?undefined:{request_id:requestId,input_sha256:hash(input)},true);const original=loaded.journal.events[0]!.command as CreateCommand;
        check(canonical(original.input)===canonical(input),'D1_REQUEST_IDENTITY_CONFLICT');
        verifyA(false);
        revision=loaded.job.revision;replayed=true;
      }else{
        this.lock(id,()=>{check(!existsSync(this.path(id)),'JOB_REVISION_DRIFT');verifyA(true);this.commit(id,{format:'xdev-recoverable-job-1',events:[this.event(c,0,at,null)]},0);});
      }
      if(!indexed){const fd=openSync(index,'wx',0o600);try{writeFileSync(fd,indexBytes);fsyncSync(fd);}finally{closeSync(fd);}}
      return {job_id:id,revision,worker_started:false,reservation_created:false,replayed};
    }finally{noLinks(lock);const end=lstatSync(lock);check(end.isDirectory()&&`${end.dev}:${end.ino}`===identity,'D1_REQUEST_WRITER_OWNERSHIP_LOST');rmdirSync(lock);}
  }
  mutate(id:JobId,expected_revision:number,command:JobCommand):Job {
    check(Number.isSafeInteger(expected_revision)&&expected_revision>=0,'JOB_REVISION_DRIFT');
    check(!this.getJob(id).d1_intake,'D1_INTAKE_READ_ONLY');
    check(command.kind!=='D1_WORKER_SEND_INTENT'&&command.kind!=='D1_WORKER_OBSERVATION'&&
      command.kind!=='D1_CONTEXT_BIND',
      'D1_WORKER_DEDICATED_TRANSACTION_REQUIRED');
    return this.lock(id,()=>{const {journal,job}=this.load(id);
      check(!job.d1_intake,'D1_INTAKE_READ_ONLY');
      if(command.kind==='RUN_REMOTE_BINDING'&&journal.events.some(e=>e.revision===expected_revision+1&&canonical(e.command)===canonical(command)))return job;check(job.revision===expected_revision,'JOB_REVISION_DRIFT');const at=new Date().toISOString();const next=reduce(job,command,at);journal.events.push(this.event(structuredClone(command),next.revision,at,journal.events.at(-1)!.sha256));this.commit(id,journal,next.revision);return next;});
  }
  private supervisedFinalView(id:JobId) {
    check(!this.localD1,'D1_INTAKE_READ_ONLY');
    const loaded=this.load(id),job=loaded.job;
    check(!job.d1_intake&&job.tasks.length===1,'SUPERVISED_JOB_REQUIRED');
    const ref=job.tasks[0]!.contract_ref,path=join(this.root,'evidence',ref.sha256+'.json');noLinks(path);
    check(ref.id===path&&existsSync(path),'SUPERVISED_JOB_REQUIRED');
    const stat=lstatSync(path);check(stat.isFile()&&stat.nlink===1&&stat.size<=1024*1024,'SUPERVISED_JOB_REQUIRED');
    const bytes=readFileSync(path),value=parseD1UniqueJson(bytes.toString('utf8')) as any;
    check(createHash('sha256').update(bytes).digest('hex')===ref.sha256&&canonical(value)+'\n'===bytes.toString('utf8')&&value?.format==='xdev-supervised-contract-1','SUPERVISED_JOB_REQUIRED');
    return loaded;
  }
  /** A pure completed-operation inspection. It never obtains a writer lock or
   * creates storage. The host must fully validate the original final. */
  inspectSupervisedFinalReplay(id:JobId,read:(view:{job:Job;revision:number;head_sha256:string})=>boolean):boolean {
    const before=this.supervisedFinalView(id),bytes=canonical(before.journal);
    const result=read({job:structuredClone(before.job),revision:before.job.revision,head_sha256:before.journal.events.at(-1)!.sha256});
    if(!result)return false; // A concurrent commit belongs to the locked fresh read.
    check(canonical(this.supervisedFinalView(id).journal)===bytes,'SUPERVISED_FINAL_READ_DRIFT');
    return result;
  }
  /** Only the supervised QA final's one verification and optional four terminal
   * transitions. All reducers run before one journal replacement. Empty plans
   * are read-only logical replay; D1 and other dedicated transactions stay out. */
  withSupervisedFinal<T>(id:JobId,prepare:(view:{job:Job;revision:number;head_sha256:string})=>{
    expected_revision:number;expected_head_sha256:string;commands:JobCommand[];result:T;revalidate:()=>void},
    writerBoundary?:<R>(fn:(assertHeld:()=>void)=>R)=>R):T {
    check(!this.localD1&&!this.getJob(id).d1_intake,'D1_INTAKE_READ_ONLY');
    const perform=(assertHeld:()=>void=()=>{})=>{
      assertHeld();
      const {journal,job}=this.supervisedFinalView(id);
      const head=journal.events.at(-1)!.sha256,plan=prepare({job:structuredClone(job),revision:job.revision,head_sha256:head});
      if(plan.commands.length===0)return plan.result;
      check(job.revision===plan.expected_revision&&head===plan.expected_head_sha256,'SUPERVISED_FINAL_CAS_MISMATCH');
      const [verification,...tail]=plan.commands;
      check(verification?.kind==='VERIFICATION'&&verification.task_id===job.tasks[0]!.task_id,'SUPERVISED_FINAL_COMMANDS_REQUIRED');
      const ref=verification.receipt.decision_ref;
      check((plan.commands.length===1&&verification.receipt.outcome==='STALE')||
        (verification.receipt.outcome==='VERIFIED'&&canonical(tail)===canonical([
          {kind:'TASK_STATE',task_id:job.tasks[0]!.task_id,state:'VERIFIED'},
          {kind:'JOB_STATE',state:'VERIFYING',result_refs:[]},{kind:'JOB_STATE',state:'INTEGRATING',result_refs:[]},
          {kind:'JOB_STATE',state:'VERIFIED',result_refs:[ref]}])),'SUPERVISED_FINAL_COMMANDS_REQUIRED');
      let next=job;const at=new Date().toISOString();
      for(const command of plan.commands){next=reduce(next,command,at);journal.events.push(this.event(structuredClone(command),next.revision,at,journal.events.at(-1)!.sha256));}
      const beforeReplace=()=>{assertHeld();plan.revalidate();assertHeld();const before=this.load(id);
        check(before.job.revision===job.revision&&before.journal.events.at(-1)!.sha256===head,'SUPERVISED_FINAL_CAS_MISMATCH');};
      beforeReplace();this.commit(id,journal,next.revision,beforeReplace);return plan.result;
    };
    if(!writerBoundary)return this.lock(id,()=>perform());
    check(!this.heldJobs.has(id),'D1_JOB_LOCK_REENTRY');
    return writerBoundary(assertHeld=>{this.heldJobs.add(id);try{return perform(assertHeld);}finally{this.heldJobs.delete(id);}});
  }
  /** Completed implementation/review inspection has the same snapshot guard as
   * final replay. It never acquires a lock or writes evidence/journal state. */
  inspectSupervisedRecordReplay(id:JobId,read:(view:{job:Job;revision:number;head_sha256:string})=>boolean):boolean {
    return this.inspectSupervisedFinalReplay(id,read);
  }
  /** Bounded registration batches only: the six implementation transitions or
   * one review receipt and its TESTING transition. Existing proven prefixes may
   * be completed by a suffix; the host revalidates the exact original record. */
  withSupervisedRecord<T>(id:JobId,prepare:(view:{job:Job;revision:number;head_sha256:string})=>{
    role:'implementation'|'review';expected_revision:number;expected_head_sha256:string;commands:JobCommand[];result:T;revalidate:()=>void},
    writerBoundary?:<R>(fn:(assertHeld:()=>void)=>R)=>R):T {
    check(!this.localD1&&!this.getJob(id).d1_intake,'D1_INTAKE_READ_ONLY');
    check(!this.heldJobs.has(id),'D1_JOB_LOCK_REENTRY');
    const perform=(assertHeld:()=>void=()=>{}):T=>{
      assertHeld();const {journal,job}=this.supervisedFinalView(id),head=journal.events.at(-1)!.sha256;
      if(!writerBoundary){
        const ref=job.tasks[0]!.contract_ref,bytes=readFileSync(ref.id),bound=parseD1UniqueJson(bytes.toString('utf8')) as any;
        check(createHash('sha256').update(bytes).digest('hex')===ref.sha256&&bound.entry?.decision.selected_profile==='prototype'&&bound.request?.profile?.requested_profile==='prototype','SUPERVISED_PROTOTYPE_DIRECTORY_WRITER_ONLY');
      }
      const plan=prepare({job:structuredClone(job),revision:job.revision,head_sha256:head});
      if(!writerBoundary)check(plan.role==='implementation','SUPERVISED_PROTOTYPE_DIRECTORY_WRITER_ONLY');
      if(plan.commands.length===0)return plan.result;
      check(job.revision===plan.expected_revision&&head===plan.expected_head_sha256,'SUPERVISED_RECORD_CAS_MISMATCH');
      const shape=plan.commands.map(command=>command.kind+('state'in command?':'+command.state:''));
      if(plan.role==='implementation'){
        const full=['TASK_STATE:READY','INTENT','RUN_OBSERVATION:ACTIVE','TASK_STATE:RUNNING','RUN_OBSERVATION:SUCCEEDED','TASK_STATE:REVIEWING'];
        check(shape.length>0&&shape.length<=full.length&&canonical(shape)===canonical(full.slice(-shape.length)),'SUPERVISED_RECORD_COMMANDS_REQUIRED');
        const intent=plan.commands.find(command=>command.kind==='INTENT'),runId=intent?.kind==='INTENT'?intent.run_id:job.runs[0]?.run_id;
        check(runId&&plan.commands.every(command=>!('run_id'in command)||command.run_id===runId),'SUPERVISED_RECORD_RUN_MISMATCH');
      }else{
        check(plan.role==='review'&&['VERIFICATION','VERIFICATION|TASK_STATE:TESTING','TASK_STATE:TESTING'].includes(shape.join('|')),'SUPERVISED_RECORD_COMMANDS_REQUIRED');
        const verification=plan.commands[0];
        if(verification?.kind==='VERIFICATION')check(verification.receipt.outcome===(plan.commands.length===2?'PARTIALLY_VERIFIED':'STALE'),'SUPERVISED_RECORD_COMMANDS_REQUIRED');
      }
      check(plan.commands.every(command=>!('task_id'in command)||command.task_id===job.tasks[0]!.task_id),'SUPERVISED_RECORD_TASK_MISMATCH');
      let next=job;const at=new Date().toISOString();
      for(const command of plan.commands){next=reduce(next,command,at);journal.events.push(this.event(structuredClone(command),next.revision,at,journal.events.at(-1)!.sha256));}
      const beforeReplace=()=>{assertHeld();plan.revalidate();assertHeld();const fresh=this.load(id);
        check(fresh.job.revision===job.revision&&fresh.journal.events.at(-1)!.sha256===head,'SUPERVISED_RECORD_CAS_MISMATCH');};
      beforeReplace();this.commit(id,journal,next.revision,beforeReplace);return plan.result;
    };
    if(!writerBoundary)return this.lock(id,()=>perform());
    return writerBoundary(assertHeld=>{this.heldJobs.add(id);try{return perform(assertHeld);}finally{this.heldJobs.delete(id);}});
  }
  applyRemoteBinding(id:JobId,expected_revision:number,command:Extract<JobCommand,{kind:'RUN_REMOTE_BINDING'}>){const before=this.getJob(id).revision;const job=this.mutate(id,expected_revision,command);return{status:job.revision===before?'ALREADY_APPLIED' as const:'APPLIED' as const,job};}
  /** The caller holds the separate project context/register lock. This entry is
   * only for a new, unregistered D1 Job and never grants execution. */
  bindD1Context(id:JobId,command:D1ContextBindCommand,guard:{controlRoot:string;projectId:string;
    assertHeld:(controlRoot:string,projectId:string)=>void},revalidate:(job:Job)=>D1ContextBindCommand){
    check(!this.getJob(id).d1_intake,'D1_INTAKE_READ_ONLY');
    const control=dirname(this.root);
    check(guard.controlRoot===control&&guard.projectId===this.project.project_id,
      'D1_CONTEXT_LOCK_SCOPE');guard.assertHeld(control,this.project.project_id);
    return this.lock(id,()=>{
      const {journal,job}=this.load(id),existing=journal.events.find(e=>e.command.kind==='D1_CONTEXT_BIND');
      if(existing){check(canonical(existing.command)===canonical(command),'D1_CONTEXT_ALREADY_BOUND');
        return {status:'D1_CONTEXT_BIND_REPLAY' as const,revision:job.revision,
          job_id:id,task_id:command.task_id,request_id:command.request_id,
          content_sha256:command.binding.content_sha256,execution_permitted:false as const};}
      const domain=join(control,'d1-role-domains',createHash('sha256').update(this.project.project_id).digest('hex'));
      noLinks(domain);check(!existsSync(domain),'D1_CONTEXT_RESOURCE_DOMAIN_EXISTS');
      check(job.revision===0&&job.d1_intake?.admission==='NOT_ADMITTED',
        'D1_CONTEXT_BIND_NOT_READY');
      const current=revalidate(job);check(canonical(current)===canonical(command),'D1_CONTEXT_SOURCE_DRIFT');
      const at=new Date().toISOString(),next=reduce(job,command,at);
      journal.events.push(this.event(structuredClone(command),next.revision,at,journal.events.at(-1)!.sha256));
      this.commit(id,journal,next.revision);
      const after=this.load(id);check(canonical(after.journal.events.at(-1)!.command)===canonical(command),
        'D1_CONTEXT_COMMIT_UNCERTAIN');
      return {status:'D1_CONTEXT_BOUND_NOT_ADMITTED' as const,revision:next.revision,
        job_id:id,task_id:command.task_id,request_id:command.request_id,
        content_sha256:command.binding.content_sha256,execution_permitted:false as const};
    });
  }
  getJob(id:JobId):Job {return this.load(id).job;}
  /** Joint controller read boundary. The joint resource lock is acquired first;
   * this callback never appends a legacy Job event or dispatches a Worker. */
  withJointJobLock<T>(id:JobId,fn:(source:{job:Job;create:CreateCommand;revision:number;head_sha256:string})=>T):T {
    check(!this.getJob(id).d1_intake,'D1_INTAKE_READ_ONLY');
    return this.lock(id,()=>{const {journal,job}=this.load(id);return fn({job:structuredClone(job),
      create:structuredClone(journal.events[0]!.command as CreateCommand),revision:job.revision,
      head_sha256:journal.events.at(-1)!.sha256});});
  }
  inspectD1Journal(id:JobId){const {journal,job}=this.load(id);return {job:structuredClone(job),
    create:structuredClone(journal.events[0]!.command as CreateCommand),revision:job.revision,
    head_sha256:journal.events.at(-1)!.sha256,
    d1_send:journal.events.find(e=>e.command.kind==='D1_WORKER_SEND_INTENT')?.command as D1WorkerSendCommand|undefined};}
  /** Non-reentrant D1 transaction entry. The resource lock must already be held;
   * callers receive the only write method and never call mutate under this lock. */
  withD1JobLock<T>(id:JobId,roles:D1ResourceGuard,fn:(tx:{inspect:()=>ReturnType<JobStore['inspectD1Journal']>;
    append:(expectedRevision:number,command:D1WorkerSendCommand|D1WorkerObservationCommand)=>{revision:number;head_sha256:string;job:Job}})=>T):T {
    check(!this.getJob(id).d1_intake,'D1_INTAKE_READ_ONLY');
    this.assertD1ResourceLock(roles);
    return this.lock(id,()=>fn({inspect:()=>this.inspectD1Journal(id),
      append:(expectedRevision,command)=>this.appendD1Locked(id,roles,expectedRevision,command)}));
  }
  private assertD1ResourceLock(roles:D1ResourceGuard){
    const control=dirname(this.root),domain=join(control,'d1-role-domains',
      createHash('sha256').update(this.project.project_id).digest('hex'));
    check(roles.controlRoot===control&&roles.projectId===this.project.project_id&&
      roles.domain===domain&&roles.journalPath===join(domain,'journal.json'),
      'D1_ROLE_DOMAIN_MISMATCH');
    roles.assertProjectLockHeld(control,this.project.project_id);
    const writerLock=join(domain,'writer.lock');noLinks(writerLock);
    check(existsSync(writerLock)&&lstatSync(writerLock).isDirectory(),'D1_ROLE_LOCK_REQUIRED');
  }
  /** These facts are checked by Core from files, not delegated to the caller's
   * structurally supplied resource adapter. The adapter can add checks, but its
   * no-op methods cannot authorize a dedicated append. */
  private d1SourceFile(path:string){
    check(isAbsolute(path)&&resolve(path)===path&&inside(dirname(this.root),path),'D1_WORKER_SOURCE_LOCATION');
    noLinks(path);check(existsSync(path)&&lstatSync(path).isFile()&&lstatSync(path).nlink===1&&
      lstatSync(path).size<=1024*1024,'D1_WORKER_SOURCE_INVALID');
    return readFileSync(path);
  }
  private d1WorkspaceManifest(protocol:'legacy'|'d1-a'='legacy'){
    const files:{path:string;sha256:string}[]=[];
    const walk=(dir:string,prefix:string)=>{
      for(const name of readdirSync(dir).sort()){
        if(!prefix&&(name==='.xdev'||protocol==='d1-a'&&name==='.xdev-d1-control'))continue;
        const path=join(dir,name),rel=prefix?`${prefix}/${name}`:name,stat=lstatSync(path);
        check(!stat.isSymbolicLink(),'D1_WORKER_WORKSPACE_LINKED');
        if(stat.isDirectory())walk(path,rel);
        else {check(stat.isFile()&&stat.nlink===1&&stat.size<=16*1024*1024,'D1_WORKER_WORKSPACE_INVALID');
          files.push({path:rel,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});}
        check(files.length<=10000,'D1_WORKER_WORKSPACE_TOO_LARGE');
      }
    };
    walk(this.project.workspace_root,'');return files;
  }
  private d1RawJson(bytes:Buffer|string,code:string):any{
    try{const value=JSON.parse(bytes.toString());check(value!==null&&typeof value==='object'&&!Array.isArray(value),code);return value;}
    catch{throw Error(code);}
  }
  private verifyD1SendFiles(command:D1WorkerSendCommand,job:Job,jobHeadSha:string,
    registered:any,prepared:any,preparedAt:string,sendAt:string){
    const p=command.packet,registration=registered.registration;
    const registrationBytes=this.d1SourceFile(registered.registration_path);
    check(createHash('sha256').update(registrationBytes).digest('hex')===registered.registration_sha256&&
      canonical(this.d1RawJson(registrationBytes,'D1_WORKER_REGISTRATION_DRIFT'))===canonical(registration)&&
      p.registration_sha256===registered.registration_sha256&&p.test_only===(registration.authorization.source_kind==='TEST_ONLY')&&
      registration.job_id===job.job_id&&registration.project_id===this.project.project_id&&
      registration.task_id===command.task_id&&registration.workspace_root===this.project.workspace_root&&
      registration.control_root===dirname(this.root)&&registration.contract_sha256===p.contract_sha256&&
      registered.create_input_sha256===p.create_input_sha256&&prepared.registration_sha256===registered.registration_sha256&&
      prepared.source_watermark===registered.source_watermark&&prepared.create_input_sha256===registered.create_input_sha256&&
      prepared.attempt_id===command.attempt_id&&prepared.reservation_id===command.reservation_id&&
      prepared.task_id===command.task_id&&prepared.job_id===job.job_id,'D1_WORKER_SOURCE_PROOF_REQUIRED');
    const task=job.tasks.find(t=>t.task_id===command.task_id);
    check(task&&task.contract_ref.sha256===p.contract_sha256&&task.state==='PENDING',
      'D1_WORKER_SOURCE_PROOF_REQUIRED');
    if(task.d1_context){
      check(p.format==='xdev-d1-worker-send-2'&&!!p.context&&
        p.context.prepare_event_at===preparedAt&&
        p.context.send_event_at===sendAt&&
        canonical(p.context.prepare_refresh)===canonical(prepared.context_refresh),
        'D1_WORKER_CONTEXT_DRIFT');
      validateD1WorkerContext(p.context,task.d1_context,sendAt);
      verifyD1ContextRefreshSource(p.context.prepare_refresh,dirname(this.root),
        this.project.workspace_root,task.d1_context,'PREPARE',preparedAt);
      verifyD1ContextRefreshSource(p.context.send_refresh,dirname(this.root),
        this.project.workspace_root,task.d1_context,'SEND',sendAt);
    }else check(p.format==='xdev-d1-worker-send-1'&&!p.context,
      'D1_WORKER_CONTEXT_DRIFT');
    const contractPath=join(this.project.workspace_root,'.xdev','tasks',task.key+'.json');
    noLinks(contractPath);check(existsSync(contractPath)&&lstatSync(contractPath).isFile(),
      'D1_WORKER_CONTRACT_DRIFT');
    const contractBytes=readFileSync(contractPath),contract=this.d1RawJson(contractBytes,'D1_WORKER_CONTRACT_DRIFT');
    check(createHash('sha256').update(contractBytes).digest('hex')===p.contract_sha256&&
      Array.isArray(contract.expected_outputs)&&contract.expected_outputs.length>0&&
      contract.expected_outputs.every((path:unknown)=>typeof path==='string'&&path.length>0&&
        !path.startsWith('/')&&!path.includes('\\')&&!path.endsWith('/')&&
        !path.split('/').some(part=>part===''||part==='.'||part==='..'||part.includes(':')))&&
      canonical(contract.expected_outputs)===canonical(p.allowed_scope)&&
      canonical(registration.authorization.forbidden_scope)===canonical(p.forbidden_scope)&&
      p.allowed_scope.every((path:string)=>registration.authorization.allowed_scope.some((scope:string)=>
        path===scope||path.startsWith(scope.endsWith('/')?scope:scope+'/'))&&
        !registration.authorization.forbidden_scope.some((scope:string)=>
          path===scope||path.startsWith(scope.endsWith('/')?scope:scope+'/'))),
      'D1_WORKER_EXACT_OUTPUT_SCOPE_INVALID');
    const currentBytes=this.d1SourceFile(p.current_observation_path);
    check(createHash('sha256').update(currentBytes).digest('hex')===p.current_observation_sha256,
      'D1_WORKER_CURRENT_SOURCE_PROOF_REQUIRED');
    let currentRaw:unknown;
    try{currentRaw=parseD1UniqueJson(new TextDecoder('utf-8',{fatal:true}).decode(currentBytes));}
    catch{throw Error('D1_WORKER_CURRENT_INVALID');}
    const actualManifest=this.d1WorkspaceManifest();
    const current=validateD1CurrentObservation(currentRaw,{registration,
      registration_sha256:registered.registration_sha256,test_only:p.test_only,
      project_id:p.project_id,job_id:p.job_id,task_id:p.task_id,attempt_id:p.attempt_id,now:Date.now(),
      job_revision:job.revision,job_head_sha256:jobHeadSha,resource_revision:1,
      resource_head_sha256:p.resource_head_sha256,workspace_manifest:actualManifest,
      workspace_digest:hash(actualManifest)});
    check(canonical(current.workspace.manifest)===canonical(p.manifest)&&
      canonical(actualManifest)===canonical(p.manifest)&&
      p.spawn_args.agent_type==='worker'&&p.spawn_args.fork_turns==='none'&&
      p.spawn_args.model===registration.authorization.model&&
      p.spawn_args.reasoning_effort===registration.authorization.effort&&
      p.authorization_expires_at===registration.authorization.expires_at&&
      Date.parse(p.authorization_expires_at)>Date.now()&&
      p.spawn_args.task_name===`d1_worker_${command.attempt_id.replaceAll('-','')}`&&
      p.spawn_args.message===(p.context?d1WorkerMessageV2(task.key,task.task_id,
        this.project.workspace_root,task.contract_ref.sha256,p.allowed_scope,
        p.forbidden_scope,p.manifest,p.context):
        d1WorkerMessage(task.key,task.task_id,this.project.workspace_root,
          task.contract_ref.sha256,p.allowed_scope,p.forbidden_scope,p.manifest))&&
      canonical(p.context_pack_refs)===canonical(job.context_pack_refs)&&
      canonical(p.authority_source_refs)===canonical([...new Set([
        registration.authorization.source_ref,registration.history.source_ref,
        registration.history.parent_source_ref,current.owner.source_ref])])&&
      canonical(p.host_context)===canonical({session_ref:current.host.session_ref,
        parent_cwd:current.host.parent_cwd,skill_path:current.host.skill_path,
        skill_sha256:current.host.skill_sha256,tool_schema_sha256:current.host.tool_schema_sha256,
        context_control:'PARTIAL'})&&p.observation_limit===current.observation_limit&&
      p.deadline_at===current.deadline_at,'D1_WORKER_CURRENT_SOURCE_PROOF_REQUIRED');
  }
  private verifyD1HostFiles(command:D1WorkerObservationCommand,job:Job,proof:Record<string,any>,sendAt:string){
    const run=job.runs.find(r=>r.run_id===command.run_id),p=run?.d1_worker?.packet;
    check(p&&p.attempt_id===command.attempt_id&&p.send_id===command.send_id,
      'D1_WORKER_HOST_SOURCE_PROOF_REQUIRED');
    const sourceBytes=this.d1SourceFile(proof.source_file_path);
    check(createHash('sha256').update(sourceBytes).digest('hex')===proof.source_file_sha256&&
      sourceBytes.toString('utf8')===proof.source_file_utf8,
      'D1_WORKER_EVIDENCE_SOURCE_MISMATCH');
    const v=validateD1HostObservationBytes(sourceBytes,{project_id:p.project_id,job_id:p.job_id,
      task_id:p.task_id,attempt_id:p.attempt_id,send_id:p.send_id,
      session_ref:p.host_context.session_ref,test_only:p.test_only,spawn_args:p.spawn_args,
      now:Date.now(),send_at:sendAt});
    const current=this.d1WorkspaceManifest(),final=v.final_manifest;
    const mismatch=final!==null&&canonical(final)!==canonical(current);
    check(v.state===command.observed_state&&v.host_agent_id===command.host_agent_id&&
      v.host_task_path===command.host_task_path&&v.observed_at===command.observed_at&&
      canonical(current)===canonical(proof.current_workspace_manifest)&&
      proof.current_workspace_mismatch===mismatch&&
      canonical(final)===canonical(command.final_manifest)&&
      command.final_manifest_sha256===(final===null?null:hash(final))&&
      canonical(v.active_writers)===canonical(command.active_writers)&&
      canonical([...v.unknown_writers,...(mismatch?['CURRENT_WORKSPACE_MISMATCH']:[])])===
        canonical(command.unknown_writers)&&v.actual_model===command.actual_model&&
      v.actual_effort===command.actual_effort,'D1_WORKER_HOST_SOURCE_PROOF_REQUIRED');
  }
  private appendD1Locked(id:JobId,roles:D1ResourceGuard,expectedRevision:number,
    command:D1WorkerSendCommand|D1WorkerObservationCommand){
    check(this.heldJobs.has(id),'D1_JOB_LOCK_REQUIRED');
    this.assertD1ResourceLock(roles);
    const {journal,job}=this.load(id);check(job.revision===expectedRevision,'JOB_REVISION_DRIFT');
    const resource=roles.inspectSendDomain();
    noLinks(roles.journalPath);const resourceBytes=readFileSync(roles.journalPath,'utf8');
    let resourceJournal:unknown;try{resourceJournal=JSON.parse(resourceBytes);}catch{throw Error('D1_ROLE_JOURNAL_INVALID');}
    check(canonical(resourceJournal)+'\n'===resourceBytes,'D1_ROLE_JOURNAL_INVALID');
    exact(resourceJournal,['format','events']);
    check(resourceJournal.format==='xdev-d1-role-domain-1'&&Array.isArray(resourceJournal.events)&&
      resourceJournal.events.length===3,'D1_ROLE_JOURNAL_INVALID');
    let previous:string|null=null;
    for(let i=0;i<3;i++){
      const event=resourceJournal.events[i];exact(event,['revision','previous_sha256','at','command','sha256']);
      const {sha256,...body}=event;
      check(event.revision===i&&event.previous_sha256===previous&&sha256===hash(body),
        'D1_ROLE_HISTORY_DRIFT');previous=sha256;
    }
    const registered=resourceJournal.events[0].command,prepared=resourceJournal.events[1].command;
    check(registered.kind==='REGISTER'&&prepared.kind==='ROLE_PREPARED'&&
      prepared.registration_sha256===registered.registration_sha256&&
      prepared.source_watermark===registered.source_watermark&&
      prepared.create_input_sha256===registered.create_input_sha256&&
      prepared.job_id===id&&prepared.project_id===this.project.project_id,
      'D1_ROLE_JOURNAL_INVALID');
    const resourceLast=resourceJournal.events[2];exact(resourceLast,['revision','previous_sha256','at','command','sha256']);
    const {sha256:resourceHash,...resourceBody}=resourceLast;
    check(resourceLast.revision===2&&resourceHash===hash(resourceBody)&&
      resourceHash===resource.head_sha256&&resourceLast.command.kind==='SEND_INTENT'&&
      canonical(resourceLast.command)===canonical(resource.send),'D1_WORKER_RESOURCE_PAIR_REQUIRED');
    check(resource.send&&resource.revision===2&&resource.send.attempt_id===command.attempt_id&&
      resource.send.send_id===command.send_id,'D1_WORKER_RESOURCE_PAIR_REQUIRED');
    if(command.kind==='D1_WORKER_SEND_INTENT'){
      const create=journal.events[0]!.command as CreateCommand;
      check(command.packet.create_input_sha256===hash(create.input)&&
        command.packet.job_head_sha256===journal.events.at(-1)!.sha256&&
        command.packet.job_revision===job.revision,'D1_WORKER_CREATE_OR_HEAD_DRIFT');
      check(command.packet_sha256===resource.send.packet_sha256&&
        canonical(command.packet)===canonical(resource.send.packet)&&
        command.resource_head_sha256===resource.head_sha256&&
        command.reservation_id===resource.prepared?.reservation_id,
        'D1_WORKER_RESOURCE_PAIR_REQUIRED');
      this.verifyD1SendFiles(command,job,journal.events.at(-1)!.sha256,registered,prepared,
        resourceJournal.events[1].at,resourceJournal.events[2].at);
      roles.verifyLockedSendSource(command,job,journal.events.at(-1)!.sha256);
    }else{
      const send=journal.events.find(e=>e.command.kind==='D1_WORKER_SEND_INTENT')?.command as D1WorkerSendCommand|undefined;
      check(send&&send.send_id===resource.send.send_id&&send.packet_sha256===resource.send.packet_sha256&&
        send.resource_head_sha256===resource.head_sha256,'D1_WORKER_RESOURCE_PAIR_REQUIRED');
      const proof=this.verifyD1Evidence(command.observation_ref);
      this.verifyD1HostFiles(command,job,proof,resourceLast.at);
      roles.verifyLockedObservationSource(command,job,proof);
    }
    const at=new Date().toISOString(),next=reduce(job,command,at);
    journal.events.push(this.event(structuredClone(command),next.revision,at,journal.events.at(-1)!.sha256));
    this.commit(id,journal,next.revision);
    const after=this.load(id);check(after.job.revision===next.revision&&
      canonical(after.journal.events.at(-1)!.command)===canonical(command),'D1_WORKER_JOB_COMMIT_UNCERTAIN');
    return {revision:after.job.revision,head_sha256:after.journal.events.at(-1)!.sha256,job:after.job};
  }
  /** One validated Journal read keeps the CREATE source and current Job revision together. */
  inspectJobSource(id:JobId):{job:Job;create:CreateCommand} {
    const {journal,job}=this.load(id);
    return {job:structuredClone(job),create:structuredClone(journal.events[0]!.command as CreateCommand)};
  }
  /** Content-addressed immutable evidence, never a second state snapshot. A failed
   * partial evidence write is retained and rejected, never repaired in place. */
  persistEvidence(value:unknown){check(!this.localD1,'D1_PROFILE_ONLY_NOT_EXECUTABLE');const bytes=canonical(value)+'\n';check(Buffer.byteLength(bytes)<=1024*1024,'JOB_EVIDENCE_TOO_LARGE');const digest=createHash('sha256').update(bytes).digest('hex');
    noLinks(this.root);check(existsSync(this.root),'JOB_STORAGE_REQUIRED');const dir=join(this.root,'evidence');noLinks(dir);if(!existsSync(dir))mkdirSync(dir,{mode:0o700});const path=join(dir,digest+'.json');noLinks(path);
    if(existsSync(path)){check(lstatSync(path).isFile()&&lstatSync(path).nlink===1&&readFileSync(path,'utf8')===bytes,'JOB_EVIDENCE_CONFLICT');return{id:path,sha256:digest};}
    const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}return{id:path,sha256:digest};
  }
  private d1QueryStop(id:JobId,j:Job,jobSend:D1WorkerSendCommand|undefined){
    if(!j.d1_intake)return null;
    const control=dirname(this.root),domain=join(control,'d1-role-domains',
      createHash('sha256').update(this.project.project_id).digest('hex'));
    let resourceRevision:number|null=null,resourceSend:any=null,reason:string|null=null;
    try{
      const file=join(domain,'journal.json');noLinks(file);
      if(existsSync(domain)){
        const bytes=readFileSync(file,'utf8'),journal=JSON.parse(bytes);
        check(canonical(journal)+'\n'===bytes,'D1_ROLE_JOURNAL_INVALID');
        exact(journal,['format','events']);check(journal.format==='xdev-d1-role-domain-1'&&
          Array.isArray(journal.events)&&journal.events.length>=1&&journal.events.length<=3,'D1_ROLE_JOURNAL_INVALID');
        let previous:string|null=null;
        for(let i=0;i<journal.events.length;i++){
          const event=journal.events[i];exact(event,['revision','previous_sha256','at','command','sha256']);
          const {sha256,...body}=event;check(event.revision===i&&event.previous_sha256===previous&&
            sha256===hash(body),'D1_ROLE_HISTORY_DRIFT');previous=sha256;
        }
        resourceRevision=journal.events.length-1;
        if(resourceRevision===2){const event=journal.events[2];check(event.command.kind==='SEND_INTENT','D1_ROLE_JOURNAL_INVALID');
          resourceSend={...event.command,head_sha256:event.sha256};}
      }
    }catch(error){reason=`RESOURCE_JOURNAL_UNREADABLE:${error instanceof Error?error.message:String(error)}`;}
    const matched=resourceSend&&jobSend&&resourceSend.attempt_id===jobSend.attempt_id&&
      resourceSend.send_id===jobSend.send_id&&resourceSend.packet_sha256===jobSend.packet_sha256&&
      resourceSend.head_sha256===jobSend.resource_head_sha256&&
      canonical(resourceSend.packet)===canonical(jobSend.packet);
    if(!reason&&!resourceSend&&!jobSend)return null;
    if(!reason&&matched)return null;
    return {status:'D1_WORKER_CROSS_JOURNAL_STOP' as const,job_id:id,persisted_job_revision:j.revision,
      persisted_job_state:j.state,resource_revision:resourceRevision,
      resource_send_id:resourceSend?.send_id??null,job_send_id:jobSend?.send_id??null,
      reason:reason??'RESOURCE_JOB_SEND_MISMATCH',reconciliation_required:true as const,
      host_send_required_once:false as const,execution_permitted:false as const};
  }
  private qualityView(view:ReturnType<JobStore['inspectD1Journal']>) {
    return observeD1QualityUnavailable(view.job,{revision:view.revision,head_sha256:view.head_sha256,
      create_sha256:hash(view.create)});
  }
  getD1Quality(id:JobId) {
    const view=this.inspectD1Journal(id);
    check(!!view.job.d1_intake,'D1_QUALITY_NOT_APPLICABLE');
    check(!this.d1QueryStop(id,view.job,view.d1_send),'D1_WORKER_CROSS_JOURNAL_STOP');
    return this.qualityView(view);
  }
  getJobStatus(id:JobId) {
    const view=this.inspectD1Journal(id),j=view.job,stop=this.d1QueryStop(id,j,view.d1_send);
    check(!stop,'D1_WORKER_CROSS_JOURNAL_STOP');const resume=inspectResumeState(j);return {job_id:id,revision:j.revision,state:j.state,task_counts:Object.fromEntries([...new Set(j.tasks.map(t=>t.state))].map(s=>[s,j.tasks.filter(t=>t.state===s).length])),task_summaries:j.tasks.map(t=>({task_id:t.task_id,state:t.state,generation:t.generation})),active_agent_runs:j.runs.filter(r=>['PENDING','ACTIVE','UNKNOWN'].includes(r.state)),pending_verification:j.tasks.filter(t=>t.verification.state!=='VERIFIED').map(t=>({task_id:t.task_id,verification:t.verification})),owner_gates:j.owner_gates,counters:j.counters,resume_required:resume.resume_required,reconciliation_required:resume.reconciliation_required,cancellation_requested:j.cancellation_requested,
      ...(j.d1_intake?{quality:this.qualityView(view)}:{})};
  }
  getJobResult(id:JobId) {
    const view=this.inspectD1Journal(id),j=view.job,stop=this.d1QueryStop(id,j,view.d1_send);
    check(!stop,'D1_WORKER_CROSS_JOURNAL_STOP');const quality=j.d1_intake?{quality:this.qualityView(view)}:{};
    if(!terminalJob(j.state))return {status:'RESULT_NOT_TERMINAL' as const,job_id:id,revision:j.revision,state:j.state,...quality};
    return {status:'TERMINAL_RESULT' as const,job_id:id,revision:j.revision,state:j.state,result_refs:j.result_refs,task_verification:j.tasks.map(t=>({task_id:t.task_id,state:t.state,verification:t.verification})),counters:j.counters,owner_gates:j.owner_gates,...quality};
  }
  getTask(id:TaskId) {
    const m=new RegExp('^task:('+UUID+'):('+UUID+')$').exec(id);check(m,'TASK_ID_INVALID');const j=this.getJob(`job:${m[1]}`);const t=j.tasks.find(t=>t.task_id===id);check(t,'TASK_NOT_FOUND');return {...t,parent_job:{job_id:j.job_id,revision:j.revision,state:j.state},current_agent_run:t.current_run_id?j.runs.find(r=>r.run_id===t.current_run_id)!:null};
  }
  prepareResume(id:JobId,expected_revision:number,observation?:ResumeObservation) {
    const view=this.inspectD1Journal(id),j=view.job,stop=this.d1QueryStop(id,j,view.d1_send);
    check(!stop,'D1_WORKER_CROSS_JOURNAL_STOP');check(j.revision===expected_revision,'JOB_REVISION_DRIFT');
    return {...inspectResumeState(j,observation),...(j.d1_intake?{quality:this.qualityView(view)}:{})};}
  cancelJob(id:JobId,expected_revision:number) {const j=this.mutate(id,expected_revision,{kind:'CANCEL'});return {job_id:id,revision:j.revision,state:j.state,status:j.state==='CANCELLED'?'CANCELLED_NO_ACTIVE_EXECUTION':'CANCEL_RECONCILIATION_REQUIRED',remote_worker_cancelled:false as const};}
}
