/** Local execution-resource reservations, NOT an engineering-state/XMem store.
 * The upstream owns facts, grants, historical charges, STOP and freshness. This
 * module stores only immutable binding + monotonically accumulating holds.
 * No reset, refund, billing inference, forced unlock or automatic bootstrap.
 * Requires private local storage and a real upstream snapshot boundary; a JSON
 * file or repeated read is not an implementation of that boundary.
 */
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync,lstatSync,readFileSync,writeFileSync,openSync,closeSync,fsyncSync,renameSync,unlinkSync,rmdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {canonicalJson} from '../planning/governance-contracts.ts';
import {parseUniqueJson} from '../planning/retry-history.ts';
import {actionDigest,assessAction,isIssuedAdmission,type Action,type Admission,type ProjectFacts,type ProjectFactsPort} from './admission.ts';
import type {BudgetIntent,PreparedResourceObservation,ReservationReceipt} from './resource-budget-contract.ts';
import {assertBudgetAdmission} from './trusted-execution-context.ts';

/** Trusted product adapter must hold a consistent CURRENT whole-project source
 * through the awaited operation, including any source-authorized limit/grant
 * changes. Never implement as captureProject followed by an unguarded callback.
 * This is an XDev integration dependency, not a new API imposed on XMem.
 */
export interface BudgetSnapshotBoundary {
  readonly controlSourceIdentity?:{control_root:string;binding_sha256:string};
  withProjectSnapshot<T>(projectId:string,operation:(source:ProjectFacts,assertSourceCurrent?:()=>void)=>Promise<T>):Promise<T>;
  captureProjectReadOnly?(projectId:string):Promise<ProjectFacts>;
}
export type BudgetBinding={
  format:'xdev-budget-binding-1';project_id:string;authority_id:string;
  action_id_prefix:string;resource_ids:string[];allocation_ref:string;
};
type Hold={action:Action;action_sha256:string;group_ref:string;
  vector:{resource_id:string;units:number}[];receipt:ReservationReceipt};
type Store={format:'xdev-budget-store-1';binding_sha256:string;revision:number;holds:Hold[]};
const sha=(v:unknown)=>createHash('sha256').update(canonicalJson(v as any)).digest('hex');
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
const hashString=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v:any,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.sort().join(',');
const check=(v:unknown,code:string)=>{if(!v)throw Error(code);};
function noLinks(path:string){for(let p=resolve(path);;p=dirname(p)){
  try{check(!lstatSync(p).isSymbolicLink(),'BUDGET_LINK');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(dirname(p)===p)break;
}}
function read(path:string):unknown{
  noLinks(path);const stat=lstatSync(path);check(stat.isFile()&&stat.nlink===1&&stat.size<=8*1024*1024,'BUDGET_FILE_UNSAFE');
  return parseUniqueJson(readFileSync(path,'utf8'));
}
function bindingValid(b:BudgetBinding){
  check(exact(b,['format','project_id','authority_id','action_id_prefix','resource_ids','allocation_ref'])&&b.format==='xdev-budget-binding-1','BUDGET_BINDING_INVALID');
  check([b.project_id,b.authority_id,b.action_id_prefix,b.allocation_ref].every(text),'BUDGET_BINDING_INVALID');
  check(Array.isArray(b.resource_ids)&&b.resource_ids.length>0&&b.resource_ids.every(text)&&new Set(b.resource_ids).size===b.resource_ids.length,'BUDGET_BINDING_INVALID');
}
export function budgetBindingDigest(binding:BudgetBinding):string {bindingValid(binding);return sha(binding);}
function writeAtomic(path:string,value:unknown,beforeRename?:()=>void){
  noLinks(path);const tmp=path+'.'+randomUUID()+'.tmp';let fd:number|undefined;
  try{fd=openSync(tmp,'wx',0o600);writeFileSync(fd,canonicalJson(value as any));fsyncSync(fd);closeSync(fd);fd=undefined;beforeRename?.();renameSync(tmp,path);}
  finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(tmp);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
}
/** Explicit NEW control-store initialization. Confirmation selects exact bytes;
 * it is not an Owner identity proof or permission to discard old consumption.
 * Existing/incomplete stores are never recreated, even if empty or damaged.
 */
export function initializeFileResourceBudget(rootInput:string,binding:BudgetBinding,confirmation:string):{binding_sha256:string}{
  const b=structuredClone(binding),digest=budgetBindingDigest(b);check(digest===confirmation,'BUDGET_CONFIRMATION_MISMATCH');
  const root=resolve(rootInput);noLinks(root);mkdirSync(root,{mode:0o700});
  writeAtomic(join(root,'binding.json'),b);
  writeAtomic(join(root,'reservations.json'),{format:'xdev-budget-store-1',binding_sha256:digest,revision:0,holds:[]} satisfies Store);
  return{binding_sha256:digest};
}


/** Transaction-local observation, never a publication/authority pin. */
export type BudgetJournalObservation={path:string;binding_sha256:string;revision:number;sha256:string;hold_count:number};
function readJournal(root:string,binding:BudgetBinding,bindingSha:string):{store:Store;observation:BudgetJournalObservation}{
 check(resolve(root)===root,'BUDGET_PATH_NOT_CANONICAL');noLinks(root);
 const path=join(root,'reservations.json');noLinks(path);
 const stat=lstatSync(path);check(stat.isFile()&&stat.nlink===1&&stat.size<=8*1024*1024,'BUDGET_FILE_UNSAFE');
 const bytes=readFileSync(path),s=parseUniqueJson(bytes.toString('utf8')) as Store;
     check(exact(s,['format','binding_sha256','revision','holds'])&&s.format==='xdev-budget-store-1'&&s.binding_sha256===bindingSha&&Number.isSafeInteger(s.revision)&&s.revision>=0&&Array.isArray(s.holds)&&s.revision===s.holds.length,'BUDGET_STORE_INVALID');
    const actions=new Set<string>(),groups=new Set<string>();
    for(const h of s.holds){
      check(exact(h,['action','action_sha256','group_ref','vector','receipt'])&&h.action_sha256===actionDigest(h.action),'BUDGET_HOLD_INVALID');check(h.action.project_id===binding.project_id&&h.action.action_id.startsWith(binding.action_id_prefix),'BUDGET_ACTION_NAMESPACE_MISMATCH');
      check(!actions.has(h.action.action_id)&&!groups.has(h.group_ref),'BUDGET_DUPLICATE_HOLD');actions.add(h.action.action_id);groups.add(h.group_ref);
      check(h.group_ref==='local-budget:'+sha([bindingSha,h.action.action_id,actionDigest(h.action)])&&Array.isArray(h.vector)&&h.vector.length>0,'BUDGET_HOLD_INVALID');
      const resources=new Set<string>();
      for(const r of h.vector){check(exact(r,['resource_id','units'])&&binding.resource_ids.includes(r.resource_id)&&!resources.has(r.resource_id)&&Number.isSafeInteger(r.units)&&r.units>0,'BUDGET_VECTOR_INVALID');resources.add(r.resource_id);}
      const r=h.receipt;
      check(exact(r,['reservation_ref','source_revision','source_digest','committed_revision','committed_digest'])&&r.reservation_ref===h.group_ref&&text(r.source_revision)&&text(r.committed_revision)&&hashString(r.source_digest)&&hashString(r.committed_digest),'BUDGET_RECEIPT_INVALID');
    }

 return{store:s,observation:{path,binding_sha256:bindingSha,revision:s.revision,sha256:createHash('sha256').update(bytes).digest('hex'),hold_count:s.holds.length}};
}
/** Read-only, no implicit bootstrap or lock creation. Callers treat this as an
 * ephemeral read observation; FileResourceBudget owns transaction/CAS checks. */
export function observeBudgetJournal(root:string,expectedBinding:string):BudgetJournalObservation{
 check(resolve(root)===root,'BUDGET_PATH_NOT_CANONICAL');noLinks(root);
 const b=read(join(root,'binding.json')) as BudgetBinding;check(budgetBindingDigest(b)===expectedBinding,'BUDGET_BINDING_MISMATCH');
 const a=readJournal(root,b,expectedBinding),z=readJournal(root,b,expectedBinding);
 check(a.observation.sha256===z.observation.sha256,'BUDGET_JOURNAL_CHANGED_DURING_READ');return z.observation;
}
type JournalTransaction={start:BudgetJournalObservation;expected:BudgetJournalObservation;write_attempted:boolean;committed:boolean};

export class FileResourceBudget implements ProjectFactsPort {
  readonly root:string;readonly binding:BudgetBinding;readonly binding_sha256:string;
  private readonly boundary:BudgetSnapshotBoundary;private readonly clock:()=>number;
  private readonly rootIdentity:string;
  constructor(rootInput:string,expectedBindingDigest:string,boundary:BudgetSnapshotBoundary,clock:()=>number=Date.now){
    this.root=resolve(rootInput);noLinks(this.root);const st=lstatSync(this.root);check(st.isDirectory(),'BUDGET_ROOT_INVALID');
    this.rootIdentity=`${st.dev}:${st.ino}`;
    check(boundary&&typeof boundary.withProjectSnapshot==='function','BUDGET_SOURCE_BOUNDARY_REQUIRED');
    this.boundary=boundary;this.clock=clock;this.binding=read(join(this.root,'binding.json')) as BudgetBinding;
    this.binding_sha256=budgetBindingDigest(this.binding);check(this.binding_sha256===expectedBindingDigest,'BUDGET_BINDING_MISMATCH');
    Object.freeze(this.binding.resource_ids);Object.freeze(this.binding);
    this.load();
  }
  private rootCheck(){
    noLinks(this.root);const st=lstatSync(this.root);check(st.isDirectory()&&`${st.dev}:${st.ino}`===this.rootIdentity,'BUDGET_ROOT_REPLACED');
    const binding=read(join(this.root,'binding.json')) as BudgetBinding;
    check(budgetBindingDigest(binding)===this.binding_sha256,'BUDGET_BINDING_MISMATCH');
    const peer=join(this.root,'control-source-binding.json');
    let paired=false;try{lstatSync(peer);paired=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    if(paired){const identity=read(peer);check(exact(identity,['control_root','binding_sha256'])&&this.boundary.controlSourceIdentity&&sha(identity)===sha(this.boundary.controlSourceIdentity),'BUDGET_CONTROL_SOURCE_MISMATCH');}
  }
  private load():Store {return readJournal(this.root,this.binding,this.binding_sha256).store;}
  private checkAction(action:Action){actionDigest(action);check(action.project_id===this.binding.project_id,'BUDGET_PROJECT_MISMATCH');check(action.action_id.startsWith(this.binding.action_id_prefix),'BUDGET_ACTION_NAMESPACE_MISMATCH');}
  private group(action:Action){return 'local-budget:'+sha([this.binding_sha256,action.action_id,actionDigest(action)]);}
  private async locked<T>(fn:()=>Promise<T>):Promise<T>{
    this.rootCheck();const lock=join(this.root,'transaction.lock');noLinks(lock);
    try{mkdirSync(lock,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('BUDGET_BUSY_OR_OWNER_UNKNOWN');throw e;}
    // No stale-lock timer: a crash retains the lock and blocks all observations.
    try{this.rootCheck();return await fn();}finally{rmdirSync(lock);}
  }
  private async snapshot<T>(fn:(upstream:ProjectFacts,store:Store,assertActive:()=>void,journal:JournalTransaction)=>Promise<T>):Promise<T>{
    return this.locked(async()=>{
      const first=readJournal(this.root,this.binding,this.binding_sha256);
      const journal:JournalTransaction={start:first.observation,expected:first.observation,write_attempted:false,committed:false};
      let called=false,finished=false,active=true;
      let sourceGuard:(()=>void)|undefined;
      const assertActive=()=>{check(active,'BUDGET_SOURCE_TRANSACTION_ENDED');if(sourceGuard)check(sourceGuard()===undefined,'BUDGET_SOURCE_GUARD_INVALID');};
      let outcome:T;try{outcome=await this.boundary.withProjectSnapshot(this.binding.project_id,async (f,guard)=>{
        check(guard===undefined||typeof guard==='function','BUDGET_SOURCE_GUARD_INVALID');sourceGuard=guard;
        assertActive();check(!called,'BUDGET_SOURCE_CALLBACK_REPEATED');called=true;
        check(f?.project_id===this.binding.project_id,'BUDGET_SOURCE_PROJECT_MISMATCH');
        const out=await fn(structuredClone(f),first.store,assertActive,journal);assertActive();
        this.verifyJournal(journal.expected,journal.committed?'BUDGET_COMMIT_VERIFICATION_FAILED':'BUDGET_JOURNAL_DRIFT_BEFORE_COMMIT');finished=true;return out;
      });}finally{active=false;}
      check(called&&finished,'BUDGET_SOURCE_BOUNDARY_INVALID');return outcome;
    });
  }
  private verifyJournal(expected:BudgetJournalObservation,code:string){
    try{this.rootCheck();const current=readJournal(this.root,this.binding,this.binding_sha256).observation;
      check(sha(current)===sha(expected),code);
    }catch(e){throw Error(code,{cause:e});}
  }
  private compose(upstream:ProjectFacts,store:Store):ProjectFacts{
    const f=structuredClone(upstream);
    check(text(f.revision)&&Array.isArray(f.resources)&&Array.isArray(f.reservations)&&Array.isArray(f.evidence_refs),'BUDGET_UPSTREAM_INVALID');
    for(const id of this.binding.resource_ids){const rows=f.resources.filter(r=>r.resource_id===id);check(rows.length===1&&['DISPATCH_SLOT','RECOVERY_TOKEN'].includes(rows[0].unit),'BUDGET_RESOURCE_UNSUPPORTED');}
    // Do not mask or double count source rows under a local ownership label.
    for(const r of f.reservations)check(!store.holds.some(h=>r.action_id===h.action.action_id||r.group_ref===h.group_ref),'BUDGET_UPSTREAM_LOCAL_HOLD_COLLISION');
    for(const h of store.holds)for(const v of h.vector)f.reservations.push({reservation_id:h.group_ref+':'+v.resource_id,...v,evidence_ref:h.group_ref,action_id:h.action.action_id,action_sha256:h.action_sha256,group_ref:h.group_ref});
    f.revision='local-budget-view:'+sha({upstream_revision:upstream.revision,binding:this.binding_sha256,revision:store.revision,holds:store.holds.map(h=>({action_sha256:h.action_sha256,group_ref:h.group_ref,vector:h.vector}))});
    const bindingEvidence='local-budget-binding:'+this.binding_sha256;
    if(!f.evidence_refs.includes(bindingEvidence))f.evidence_refs.push(bindingEvidence);
    return f;
  }
  /** Guarded whole-project view including durable local reservations. This is
   * the live XDev-owned reservation writer boundary used by R4.12 adapters. It
   * does not upgrade the upstream producer's completeness, freshness or writer
   * coverage. */
  async withProjectSnapshot<T>(projectId:string,operation:(source:ProjectFacts,assertSourceCurrent?:()=>void)=>Promise<T>):Promise<T>{
    check(projectId===this.binding.project_id,'BUDGET_PROJECT_MISMATCH');check(typeof operation==='function','BUDGET_CALLBACK_REQUIRED');
    return this.snapshot(async(f,s,assertActive)=>{const view=this.compose(f,s);const result=await operation(structuredClone(view),assertActive);assertActive();return result;});
  }
  /** Read-only stable project view for status/prepare paths. It never creates
   * transaction.lock. An active writer lock blocks the observation; two full
   * source/store rounds must match before the view is returned. Reserve/commit
   * paths continue to use withProjectSnapshot()/reserve() and the write lock. */
  async captureProjectReadOnly(projectId:string):Promise<ProjectFacts>{
    check(projectId===this.binding.project_id,'BUDGET_PROJECT_MISMATCH');
    const source=this.boundary.captureProjectReadOnly?.bind(this.boundary);if(!source)throw Error('BUDGET_READ_ONLY_SOURCE_BOUNDARY_REQUIRED');
    const assertNoWriter=()=>{this.rootCheck();const lock=join(this.root,'transaction.lock');noLinks(lock);try{lstatSync(lock);throw Error('BUDGET_BUSY_OR_OWNER_UNKNOWN');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}};
    const round=async()=>{assertNoWriter();const store=this.load(),storeDigest=sha(store);const upstream=await source(projectId),upstreamDigest=sha(upstream);assertNoWriter();return{store,storeDigest,upstream,upstreamDigest};};
    const a=await round(),b=await round();check(a.storeDigest===b.storeDigest,'BUDGET_UNCOORDINATED_WRITE');check(a.upstreamDigest===b.upstreamDigest,'BUDGET_UNCOORDINATED_SOURCE_DRIFT');
    const view=this.compose(b.upstream,b.store),viewDigest=sha(view);const c=await round();check(c.storeDigest===b.storeDigest,'BUDGET_UNCOORDINATED_WRITE');check(c.upstreamDigest===b.upstreamDigest,'BUDGET_UNCOORDINATED_SOURCE_DRIFT');check(sha(this.compose(c.upstream,c.store))===viewDigest,'BUDGET_UNCOORDINATED_VIEW_DRIFT');
    assertNoWriter();return structuredClone(view);
  }
  async captureProject(projectId:string):Promise<ProjectFacts>{check(projectId===this.binding.project_id,'BUDGET_PROJECT_MISMATCH');return this.withProjectSnapshot(projectId,async f=>f);}
  async reserve(admission:Admission):Promise<ReservationReceipt>{
    let writeAttempted=false,ownCommit=false,attemptedReceipt:ReservationReceipt|null=null;
    try{
    await assertBudgetAdmission(admission,this.root,this.binding_sha256,this.boundary);check(isIssuedAdmission(admission),'BUDGET_ISSUED_ADMISSION_REQUIRED');const action=structuredClone(admission.action);this.checkAction(action);
    return await this.snapshot(async(upstream,store,assertActive,journal)=>{
      const current=this.compose(upstream,store);
      const fresh=await assessAction(action,{captureProject:async()=>structuredClone(current)},this.clock,admission.purpose);
      check(fresh.allowed,'BUDGET_ADMISSION_BLOCKED:'+fresh.reasons.join(';'));
      check(fresh.authorization!.reservations.every(r=>this.binding.resource_ids.includes(r.resource_id)),'BUDGET_RESOURCE_NOT_OWNED');
      const old=store.holds.find(h=>h.action.action_id===action.action_id);
      const exactCurrent=admission.source_revision===fresh.source_revision&&admission.source_digest===fresh.source_digest;
      if(old){
        check(old.action_sha256===actionDigest(action),'BUDGET_ACTION_REBOUND');
        check(fresh.reusable_reservation_ref===old.group_ref,'BUDGET_HOLD_NOT_REUSABLE');
        if(exactCurrent)return{reservation_ref:old.group_ref,source_revision:fresh.source_revision!,source_digest:fresh.source_digest!,committed_revision:fresh.source_revision!,committed_digest:fresh.source_digest!};
        // Same response lost: only the exact unchanged committed view may replay.
        check(admission.source_revision===old.receipt.source_revision&&admission.source_digest===old.receipt.source_digest&&fresh.source_revision===old.receipt.committed_revision&&fresh.source_digest===old.receipt.committed_digest,'BUDGET_ADMISSION_STALE');
        return structuredClone(old.receipt);
      }
      check(exactCurrent,'BUDGET_ADMISSION_STALE');
      // An upstream hold cannot be silently interpreted as absence of local spend.
      check(fresh.reusable_reservation_ref===null,'BUDGET_EXTERNAL_ACTION_HOLD');
      const group=this.group(action),next=structuredClone(store);
      const receipt:ReservationReceipt={reservation_ref:group,source_revision:fresh.source_revision!,source_digest:fresh.source_digest!,committed_revision:'pending',committed_digest:'0'.repeat(64)};
      const h:Hold={action,action_sha256:actionDigest(action),group_ref:group,vector:structuredClone(fresh.authorization!.reservations),receipt};
      next.holds.push(h);next.revision++;
      const committed=this.compose(upstream,next);receipt.committed_revision=committed.revision;receipt.committed_digest=sha(committed);
      assertActive();this.rootCheck();
      this.verifyJournal(journal.start,'BUDGET_JOURNAL_DRIFT_BEFORE_COMMIT');
      journal.expected={path:journal.start.path,binding_sha256:this.binding_sha256,revision:next.revision,sha256:sha(next),hold_count:next.holds.length};
      attemptedReceipt=structuredClone(receipt);
      writeAtomic(join(this.root,'reservations.json'),next,()=>{
        // Last guard/CAS is after temp fsync and immediately before replacement.
        assertActive();this.verifyJournal(journal.start,'BUDGET_JOURNAL_DRIFT_BEFORE_COMMIT');
        journal.write_attempted=true;writeAttempted=true;
      });journal.committed=true;ownCommit=true;
      this.verifyJournal(journal.expected,'BUDGET_COMMIT_VERIFICATION_FAILED');
      return structuredClone(receipt);
    });
    }catch(cause){
      let observation:BudgetJournalObservation|null=null,holdPresent:boolean|null=null;
      try{const current=readJournal(this.root,this.binding,this.binding_sha256);observation=current.observation;holdPresent=current.store.holds.some(h=>h.action_sha256===actionDigest(admission.action));}catch{}
      const outcome=ownCommit||writeAttempted&&holdPresent===true?'COMMITTED_THEN_ERROR':writeAttempted?'COMMIT_OUTCOME_UNKNOWN':'PRE_COMMIT_REJECTED';
      const error=new Error(cause instanceof Error?cause.message:'BUDGET_TRANSACTION_FAILED',{cause});
      Object.assign(error,{budget_outcome:outcome,reservation_created:ownCommit||holdPresent===true?true:writeAttempted?null:false,budget_observation:observation,reservation_receipt:attemptedReceipt});throw error;
    }
  }
  async inspect(intent:BudgetIntent, purpose:Admission['purpose']='EXECUTE'):Promise<PreparedResourceObservation>{
    this.checkAction(intent.action);check(intent.action_sha256===actionDigest(intent.action),'BUDGET_INTENT_BINDING_MISMATCH');
    return this.snapshot(async(upstream,store,assertActive)=>{
      const f=this.compose(upstream,store),old=store.holds.find(h=>h.action.action_id===intent.action.action_id);
      const out:PreparedResourceObservation={action_sha256:intent.action_sha256,state:'UNKNOWN',reservation_ref:old?.group_ref??null,source_revision:f.revision,source_digest:sha(f),evidence_ref:'local-budget-observation:'+sha([this.binding_sha256,store.revision,intent.action_sha256]),pending_operations:false};
      // This API is preparation reconciliation only, never a refund/settlement.
      if(intent.phase!=='PREPARED')return out;
      const permit=await assessAction(intent.action,{captureProject:async()=>structuredClone(f)},this.clock,purpose);
      if(!permit.allowed||!permit.authorization!.reservations.every(r=>this.binding.resource_ids.includes(r.resource_id)))return out;
      if(old){if(old.action_sha256===intent.action_sha256&&permit.reusable_reservation_ref===old.group_ref&&(!intent.reservation_ref||intent.reservation_ref===old.group_ref))out.state='HELD';}
      else if(intent.reservation_ref===null&&permit.reusable_reservation_ref===null)out.state='NONE';
      return out;
    });
  }
}
