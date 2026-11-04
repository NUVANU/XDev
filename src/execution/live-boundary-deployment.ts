/** R4.12/R4.15 live XDev boundary deployment and writer-coverage adapter.
 *
 * Budget-backed v1/v2 control bindings expose the durable reservation writer.
 * R4.15 v3 bindings are real management-side control roots bound to the current
 * XDev project identity, but intentionally have no upstream fact producer and no
 * resource budget. Their coverage therefore remains incomplete and cannot issue
 * execution/reservation permission. No XMem context is treated as a control fact.
 */
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {canonicalJson} from '../planning/governance-contracts.ts';
import {parseRfc3339Timestamp,parseUniqueJson} from '../planning/retry-history.ts';
import {type ProjectFacts,validateProjectFacts} from './admission.ts';
import {FileControlSourceBoundary,controlNoLinks,readControlBytes,readCurrentAllocationBudgetAttachment,readFinalReserveSourceAttachment} from './control-source-boundary.ts';
import {FileCurrentSourceSnapshotBoundary,initializeFileCurrentSourceBoundary,inspectFileCurrentSourceBoundary,updateCurrentSourceSnapshot} from './file-current-source-boundary.ts';
import {inspectCurrentSourceReadiness,type CurrentSourceSnapshot,type CurrentSourceSnapshotBoundary} from './current-source-publisher.ts';
import {nativeBytesHash,type NativeSourceRef} from './native-project-source.ts';
import {readLiveExecutionCoverage} from './live-execution-facts.ts';
import {readCurrentM2TaskAuthorization} from './current-task-authorization.ts';

export const liveFactAreas=['TASKS_DEPENDENCIES','AUTHORIZATION','RESOURCES','CHARGES','RESERVATIONS','STOP_UNKNOWN','IDENTITY'] as const;
export type LiveFactArea=typeof liveFactAreas[number];
export type LiveCoverageStatus='LIVE_COVERED'|'READ_ONLY'|'HISTORICAL_ONLY'|'MISSING';
export type LiveCoverageRow={area:LiveFactArea;status:LiveCoverageStatus;reason:string;evidence_refs:string[]};
export type LiveBoundaryAdapter='CONTROL_BUDGET'|'CONTROL_SOURCE_UNBOUND';
export type LiveBoundaryCoverage={format:'xdev-live-boundary-coverage-1';project_id:string;adapter:LiveBoundaryAdapter;areas:LiveCoverageRow[];all_live_covered:boolean;execution_permitted:false};
export type LiveBoundaryDeployment={format:'xdev-live-boundary-deployment-1';deployment_id:string;project_id:string;adapter:LiveBoundaryAdapter;control_root:string;control_binding_sha256:string;boundary_root:string;created_at:string};

const ACK='DEPLOY_LIVE_BOUNDARY_NO_PERMISSION';
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function check(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
const digest=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
function canonicalAbs(p:string){check(isAbsolute(p)&&resolve(p)===p,'LIVE_BOUNDARY_PATH_NOT_CANONICAL');return p;}
function inside(root:string,p:string){const r=relative(root,p);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));}
function assertOrdinaryDir(p:string){controlNoLinks(p);const s=lstatSync(p);check(s.isDirectory()&&!s.isSymbolicLink()&&realpathSync(p)===p,'LIVE_BOUNDARY_PARENT_INVALID');}
function writeNew(path:string,value:unknown){let fd:number|undefined;try{fd=openSync(path,'wx',0o600);writeFileSync(fd,canonicalJson(value as any));fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}}
function fileRef(path:string):NativeSourceRef{const b=readControlBytes(path);return{path,sha256:digest(b)};}
function exactKeys(v:any,keys:string[]){return v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');}
function validateDeployment(d:any):asserts d is LiveBoundaryDeployment{
  check(exactKeys(d,['format','deployment_id','project_id','adapter','control_root','control_binding_sha256','boundary_root','created_at'])&&d.format==='xdev-live-boundary-deployment-1'&&['CONTROL_BUDGET','CONTROL_SOURCE_UNBOUND'].includes(d.adapter),'LIVE_BOUNDARY_DEPLOYMENT_INVALID');
  check([d.deployment_id,d.project_id].every(text)&&sha(d.control_binding_sha256)&&parseRfc3339Timestamp(d.created_at)!==null,'LIVE_BOUNDARY_DEPLOYMENT_INVALID');
  canonicalAbs(d.control_root);canonicalAbs(d.boundary_root);controlNoLinks(d.control_root);controlNoLinks(d.boundary_root);
}
function readDeployment(rootInput:string):LiveBoundaryDeployment{
  const root=canonicalAbs(rootInput);controlNoLinks(root);const p=join(root,'deployment.json');const d=parseUniqueJson(readControlBytes(p).toString('utf8'));validateDeployment(d);check(dirname(d.boundary_root)===root&&d.boundary_root===join(root,'boundary'),'LIVE_BOUNDARY_LAYOUT_INVALID');return d;
}

function coverage(control:FileControlSourceBoundary,clock:()=>number=Date.now):LiveBoundaryCoverage{
  const e='control-binding:'+control.binding_sha256;
  if(control.binding.format==='xdev-control-binding-3'){
    const id='project-identity:'+control.binding.identity_ref.identity_sha256;
    let areas:LiveCoverageRow[]=[
      {area:'TASKS_DEPENDENCIES',status:'MISSING',reason:'UPSTREAM_TASK_FACT_SOURCE_NOT_ATTACHED',evidence_refs:[e]},
      {area:'AUTHORIZATION',status:'MISSING',reason:'UPSTREAM_AUTHORIZATION_SOURCE_NOT_ATTACHED',evidence_refs:[e]},
      {area:'RESOURCES',status:'MISSING',reason:'UPSTREAM_RESOURCE_ALLOCATION_SOURCE_NOT_ATTACHED',evidence_refs:[e]},
      {area:'CHARGES',status:'MISSING',reason:'UPSTREAM_CHARGE_SOURCE_NOT_ATTACHED',evidence_refs:[e]},
      {area:'RESERVATIONS',status:'MISSING',reason:'RESOURCE_BUDGET_NOT_ATTACHED',evidence_refs:[e]},
      {area:'STOP_UNKNOWN',status:'READ_ONLY',reason:'LOCAL_FAIL_CLOSED_STOP_LIVE_BUT_UPSTREAM_STOP_UNKNOWN_SOURCE_NOT_ATTACHED',evidence_refs:[e]},
      {area:'IDENTITY',status:'READ_ONLY',reason:'XDEV_PROJECT_IDENTITY_BOUND_BUT_HOST_XMEM_EXECUTION_IDENTITY_NOT_BOUND',evidence_refs:[e,id]},
    ];
    const observed=readLiveExecutionCoverage(control.root,control.binding_sha256);
    if(observed){const by=new Map(observed.rows.map(x=>[x.area,x]));areas=areas.map(base=>{const row=by.get(base.area);return row?{area:base.area,status:row.status,reason:row.reason,evidence_refs:[...new Set([...base.evidence_refs,...row.evidence_refs])]}:base;});}
    const current=readCurrentM2TaskAuthorization(control.root,control.binding_sha256,clock);
    if(current){const by=new Map(current.rows.map(x=>[x.area,x]));areas=areas.map(base=>{const row=by.get(base.area);return row?{area:base.area,status:row.status,reason:row.reason,evidence_refs:[...new Set([...base.evidence_refs,...row.evidence_refs])]}:base;});}
    const allocation=readCurrentAllocationBudgetAttachment(control.root,control.binding_sha256,clock);
    if(allocation){const refs=allocation.immutable_support.map(x=>'control-file:'+x.sha256),replace=(area:LiveFactArea,status:LiveCoverageStatus,reason:string)=>{areas=areas.map(row=>row.area===area?{area,status,reason,evidence_refs:[...new Set([...row.evidence_refs,...refs])]}:row);};
      if(allocation.stale){replace('AUTHORIZATION','MISSING','CURRENT_ALLOCATION_EXPIRED');replace('RESOURCES','READ_ONLY','CURRENT_ALLOCATION_EXPIRED_RESOURCE_RETAINED_FOR_AUDIT');replace('RESERVATIONS','READ_ONLY','BUDGET_RETAINED_AFTER_CURRENT_ALLOCATION_EXPIRY');}
      else{replace('AUTHORIZATION','LIVE_COVERED','CURRENT_RESOURCE_BOUND_RESERVE_ONLY_AUTHORIZATION_AND_REVOCATION_WRITER_BOUND');replace('RESOURCES','LIVE_COVERED','CURRENT_DISPATCH_SLOT_ALLOCATION_AND_LIMIT_REDUCTION_WRITER_BOUND');replace('RESERVATIONS','LIVE_COVERED','FILE_RESOURCE_BUDGET_TRANSACTION_WRITER_BOUND');replace('CHARGES','READ_ONLY','RESERVE_ONLY_CURRENT_ALLOCATION_HAS_NO_EXECUTION_CHARGE_WRITER');}
    }
    const final=readFinalReserveSourceAttachment(control.root,control.binding_sha256,clock);
    if(final&&!final.stale){const refs=final.support.map(x=>'control-file:'+x.sha256),replace=(area:LiveFactArea,status:LiveCoverageStatus,reason:string)=>{areas=areas.map(row=>row.area===area?{area,status,reason,evidence_refs:[...new Set([...row.evidence_refs,...refs])]}:row);};
      replace('CHARGES','LIVE_COVERED','FINAL_RESERVE_ONLY_CURRENT_ALLOCATION_ZERO_EXECUTION_CHARGES_COMPLETE');
      replace('STOP_UNKNOWN','LIVE_COVERED','FINAL_CURRENT_CONTROL_STATE_AUTHORITATIVE_BOOTSTRAP_PLACEHOLDER_SUPERSEDED_HISTORY_PRESERVED');
      replace('IDENTITY','LIVE_COVERED','FINAL_XDEV_CONTROL_IDENTITY_SUFFICIENT_FOR_NO_DISPATCH_RESERVE_ONLY_ACTION');
    }
    return{format:'xdev-live-boundary-coverage-1',project_id:control.binding.project_id,adapter:'CONTROL_SOURCE_UNBOUND',areas,all_live_covered:areas.every(x=>x.status==='LIVE_COVERED'),execution_permitted:false};
  }
  const areas:LiveCoverageRow[]=[
    {area:'TASKS_DEPENDENCIES',status:'READ_ONLY',reason:'UPSTREAM_TASK_WRITER_NOT_BOUND_TO_LIVE_BOUNDARY',evidence_refs:[e]},
    {area:'AUTHORIZATION',status:'READ_ONLY',reason:'LOCAL_REVOCATION_WRITER_COVERED_BUT_BASE_GRANT_WRITER_NOT_BOUND',evidence_refs:[e]},
    {area:'RESOURCES',status:'READ_ONLY',reason:'LOCAL_LIMIT_REDUCTION_WRITER_COVERED_BUT_BASE_ALLOCATION_WRITER_NOT_BOUND',evidence_refs:[e]},
    {area:'CHARGES',status:'READ_ONLY',reason:'NO_LIVE_CHARGE_OR_SETTLEMENT_WRITER_BOUND',evidence_refs:[e]},
    {area:'RESERVATIONS',status:'LIVE_COVERED',reason:'FILE_RESOURCE_BUDGET_TRANSACTION_WRITER_BOUND',evidence_refs:[e]},
    {area:'STOP_UNKNOWN',status:'READ_ONLY',reason:'LOCAL_ADD_STOP_WRITER_COVERED_BUT_UPSTREAM_STOP_UNKNOWN_WRITERS_NOT_BOUND',evidence_refs:[e]},
    {area:'IDENTITY',status:'READ_ONLY',reason:'CONTROL_BUDGET_PROJECT_BINDING_COVERED_BUT_HOST_XMEM_EXECUTION_IDENTITY_WRITER_NOT_BOUND',evidence_refs:[e]},
  ];
  return{format:'xdev-live-boundary-coverage-1',project_id:control.binding.project_id,adapter:'CONTROL_BUDGET',areas,all_live_covered:areas.every(x=>x.status==='LIVE_COVERED'),execution_permitted:false};
}

function factsSections(f:ProjectFacts):CurrentSourceSnapshot['sections']{
  validateProjectFacts(f);
  const hasExec=Object.hasOwn(f,'execution_restriction')||Object.hasOwn(f,'control_action_sha256');
  if(hasExec)check(f.execution_restriction==='RESERVATION_ONLY'&&sha(f.control_action_sha256),'LIVE_BOUNDARY_EXECUTION_CONSTRAINTS_PARTIAL');
  const hasLegacy=Object.hasOwn(f,'legacy_source_sha256')||Object.hasOwn(f,'legacy_observed');
  if(hasLegacy)check(sha(f.legacy_source_sha256)&&f.legacy_observed&&typeof f.legacy_observed==='object','LIVE_BOUNDARY_LEGACY_PARTIAL');
  return{
    tasks:structuredClone(f.tasks),resources:structuredClone(f.resources),charges:structuredClone(f.charges),reservations:structuredClone(f.reservations),unknowns:structuredClone(f.unknowns),stops:structuredClone(f.stops),authorizations:structuredClone(f.authorizations),compatibility:structuredClone(f.compatibility),evidence_refs:structuredClone(f.evidence_refs),
    execution_constraints:hasExec?{execution_restriction:f.execution_restriction,control_action_sha256:f.control_action_sha256}:null,
    legacy:hasLegacy?{legacy_source_sha256:f.legacy_source_sha256,legacy_observed:structuredClone(f.legacy_observed)}:null,
  };
}

/** S2a.3: v3 publishes the control/authorization base, never a local hold overlay.
 * The journal remains validated through allocation observations and is overlaid
 * only by FileResourceBudget at consumption. Historical v1/v2 keep their prior
 * budget snapshot behavior. An unattached v3 source remains blocked. */
export class ControlBudgetCurrentSourceBoundary implements CurrentSourceSnapshotBoundary{
  readonly control:FileControlSourceBoundary;readonly projectId:string;readonly coverage:LiveBoundaryCoverage;private readonly clock:()=>number;
  constructor(controlRoot:string,bindingSha:string,clock:()=>number=Date.now){this.clock=clock;this.control=new FileControlSourceBoundary(canonicalAbs(controlRoot),bindingSha,clock);this.projectId=this.control.binding.project_id;this.coverage=coverage(this.control,this.clock);}
  private snapshotFor(f:ProjectFacts):CurrentSourceSnapshot{
    validateProjectFacts(f);const now=this.clock();check(Number.isFinite(now)&&now>=0,'LIVE_BOUNDARY_TIME_INVALID');
    let shortUntil=now+60_000;
    if(this.control.binding.format!=='xdev-control-binding-3'){
      const controlUntil=parseRfc3339Timestamp(this.control.binding.valid_until);check(controlUntil!==null&&now<controlUntil,'LIVE_BOUNDARY_SOURCE_WINDOW_EXPIRED');shortUntil=Math.min(controlUntil,shortUntil);
    }
    check(shortUntil>now,'LIVE_BOUNDARY_SOURCE_WINDOW_EXPIRED');
    const support=[fileRef(join(this.control.root,'binding.json')),fileRef(join(this.control.root,'control.json'))];
    if(this.control.binding.format==='xdev-control-binding-3'){
      support.push(fileRef(this.control.binding.identity_ref.identity_path),fileRef(this.control.binding.identity_ref.bootstrap_path));
      const observed=readLiveExecutionCoverage(this.control.root,this.control.binding_sha256);if(observed)for(const r of observed.support)if(!support.some(x=>x.path===r.path))support.push(r);
      const current=readCurrentM2TaskAuthorization(this.control.root,this.control.binding_sha256,this.clock);if(current)for(const r of current.support)if(!support.some(x=>x.path===r.path))support.push(r);
      const allocation=readCurrentAllocationBudgetAttachment(this.control.root,this.control.binding_sha256,this.clock);if(allocation)for(const r of allocation.immutable_support)if(!support.some(x=>x.path===r.path))support.push(r);
    }else{
      support.push(fileRef(join(this.control.binding.budget_root,'binding.json')),fileRef(join(this.control.binding.budget_root,'reservations.json')),fileRef(this.control.binding.source_ref.path));
    }
    const full=this.coverage.all_live_covered&&f.coverage==='COMPLETE_PROJECT';
    const sections=factsSections(f);
    if(this.control.binding.format==='xdev-control-binding-3'){const current=readCurrentM2TaskAuthorization(this.control.root,this.control.binding_sha256,this.clock);const tasks=sections.tasks as any[];if(current&&!current.stale&&!tasks.some((t:any)=>t.task_id===current.task_fact.task_id))tasks.push(structuredClone(current.task_fact));}
    return{format:'xdev-current-source-snapshot-1',project_id:f.project_id,revision:'live-control:'+nativeBytesHash(canonicalJson({source_revision:f.revision,control_binding:this.control.binding_sha256,adapter:this.coverage.adapter,coverage:this.coverage.areas.map(x=>[x.area,x.status])})),producer_ref:'xdev-live-control:'+this.control.binding_sha256,issued_at:new Date(now).toISOString(),valid_until:new Date(shortUntil).toISOString(),coverage:full?'COMPLETE_PROJECT':'INCOMPLETE',freshness:full?f.freshness:'UNKNOWN',sections,support_refs:support};
  }
  async withCurrentSnapshot<T>(projectId:string,operation:(snapshot:CurrentSourceSnapshot,assertCurrent?:()=>void)=>Promise<T>):Promise<T>{
    check(projectId===this.projectId,'LIVE_BOUNDARY_PROJECT_MISMATCH');
    const consume=async(f:ProjectFacts,guard?:()=>void)=>{guard?.();const snapshot=this.snapshotFor(f);guard?.();const result=await operation(snapshot,guard);guard?.();return result;};
    if(this.control.binding.format!=='xdev-control-binding-3'&&this.control.budgetBacked)return this.control.openBudget().withProjectSnapshot(projectId,consume);
    return this.control.withProjectSnapshot(projectId,consume);
  }
  /** Read-only status/prepare snapshot. It never creates source.lock or
   * transaction.lock. Active writer locks fail closed, and facts/support bytes
   * are re-read after the awaited operation to detect drift. */
  async withCurrentSnapshotReadOnly<T>(projectId:string,operation:(snapshot:CurrentSourceSnapshot,assertCurrent?:()=>void)=>Promise<T>):Promise<T>{
    check(projectId===this.projectId,'LIVE_BOUNDARY_PROJECT_MISMATCH');
    const capture=async()=>this.control.binding.format!=='xdev-control-binding-3'&&this.control.budgetBacked?this.control.openBudget().captureProjectReadOnly(projectId):this.control.captureProjectReadOnly(projectId);
    const before=await capture(),beforeDigest=nativeBytesHash(canonicalJson(before as any)),snapshot=this.snapshotFor(before),support=structuredClone(snapshot.support_refs);
    const result=await operation(structuredClone(snapshot));
    const after=await capture();check(nativeBytesHash(canonicalJson(after as any))===beforeDigest,'LIVE_BOUNDARY_READ_ONLY_SOURCE_DRIFT');
    for(const ref of support){const current=fileRef(ref.path);check(current.sha256===ref.sha256,'LIVE_BOUNDARY_READ_ONLY_SUPPORT_DRIFT');}
    return result;
  }
}

export function initializeLiveBoundaryDeployment(deploymentRootInput:string,controlRootInput:string,bindingSha:string,ack:string,clock:()=>number=Date.now){
  check(ack===ACK,'LIVE_BOUNDARY_EXPLICIT_ACK_REQUIRED');const deploymentRoot=canonicalAbs(deploymentRootInput),controlRoot=canonicalAbs(controlRootInput);check(sha(bindingSha),'LIVE_BOUNDARY_BINDING_DIGEST_INVALID');
  controlNoLinks(deploymentRoot);check(!existsSync(deploymentRoot),'LIVE_BOUNDARY_DEPLOYMENT_EXISTS');assertOrdinaryDir(dirname(deploymentRoot));
  const source=new ControlBudgetCurrentSourceBoundary(controlRoot,bindingSha,clock);
  check(!inside(controlRoot,deploymentRoot)&&!inside(deploymentRoot,controlRoot),'LIVE_BOUNDARY_DIRECTORIES_OVERLAP');
  if(source.control.binding.format!=='xdev-control-binding-3'){
    const budgetRoot=source.control.binding.budget_root,sourcePath=source.control.binding.source_ref.path;
    check(!inside(budgetRoot,deploymentRoot)&&!inside(deploymentRoot,budgetRoot)&&!inside(deploymentRoot,sourcePath),'LIVE_BOUNDARY_DIRECTORIES_OVERLAP');
  }
  const now=clock();check(Number.isFinite(now)&&now>=0,'LIVE_BOUNDARY_TIME_INVALID');
  mkdirSync(deploymentRoot,{mode:0o700});const boundaryRoot=join(deploymentRoot,'boundary'),deployment:LiveBoundaryDeployment={format:'xdev-live-boundary-deployment-1',deployment_id:'live-boundary:'+randomUUID(),project_id:source.projectId,adapter:source.coverage.adapter,control_root:controlRoot,control_binding_sha256:bindingSha,boundary_root:boundaryRoot,created_at:new Date(now).toISOString()};
  initializeFileCurrentSourceBoundary(boundaryRoot,source.projectId,deployment.deployment_id);writeNew(join(deploymentRoot,'deployment.json'),deployment);
  return{status:'LIVE_BOUNDARY_DEPLOYED_EMPTY_NOT_AUTHORIZED',deployment,coverage:source.coverage,execution_permitted:false,reservation_created:false,worker_started:false};
}

export async function refreshLiveBoundaryDeployment(deploymentRootInput:string,clock:()=>number=Date.now){
  const d=readDeployment(deploymentRootInput),source=new ControlBudgetCurrentSourceBoundary(d.control_root,d.control_binding_sha256,clock);check(source.projectId===d.project_id&&source.coverage.adapter===d.adapter,'LIVE_BOUNDARY_PROJECT_MISMATCH');
  return source.withCurrentSnapshot(d.project_id,async(snapshot,guard)=>{guard?.();const current=inspectFileCurrentSourceBoundary(d.boundary_root),expected=current.generation===0?null:current.generation;const write=updateCurrentSourceSnapshot(d.boundary_root,d.project_id,snapshot,expected);guard?.();return{status:'LIVE_BOUNDARY_REFRESHED_NOT_AUTHORIZED',deployment_id:d.deployment_id,generation:write.generation,snapshot_coverage:snapshot.coverage,snapshot_freshness:snapshot.freshness,coverage:source.coverage,execution_permitted:false,reservation_created:false,worker_started:false};});
}

export async function inspectLiveBoundaryDeployment(deploymentRootInput:string,clock:()=>number=Date.now){
  const d=readDeployment(deploymentRootInput),source=new ControlBudgetCurrentSourceBoundary(d.control_root,d.control_binding_sha256,clock);check(source.projectId===d.project_id&&source.coverage.adapter===d.adapter,'LIVE_BOUNDARY_PROJECT_MISMATCH');
  const store=inspectFileCurrentSourceBoundary(d.boundary_root);let readiness:any=null;let readiness_error:string|null=null;
  if(store.generation>0){try{readiness=await inspectCurrentSourceReadiness(new FileCurrentSourceSnapshotBoundary(d.boundary_root,d.project_id),d.project_id,clock);}catch(e){readiness_error=e instanceof Error?e.message:'LIVE_BOUNDARY_READINESS_UNAVAILABLE';}}
  return{status:source.coverage.all_live_covered?'LIVE_BOUNDARY_COVERAGE_COMPLETE_NOT_AUTHORIZED':'BOUNDARY_COVERAGE_INCOMPLETE',deployment:d,store,coverage:source.coverage,readiness,readiness_error,execution_permitted:false,reservation_created:false,worker_started:false};
}

export const LIVE_BOUNDARY_ACK=ACK;
