import { createHash } from 'node:crypto';
import { JobStore, canonical } from '../job-runtime/store.ts';
import { check, evidence, exact, timestamp } from '../job-runtime/state.ts';
import type { Job, JobId, TaskId, RunState, EvidenceRef } from '../job-runtime/contracts.ts';
import type { AdapterRunRef, WorkerAdapter, WorkerState, WorkerStatus } from '../worker-adapter/contracts.ts';

export const WORKER_STATE_MAPPING: Readonly<Record<WorkerState, RunState>> = Object.freeze({
  STARTING:'PENDING', ACTIVE:'ACTIVE', COMPLETED:'SUCCEEDED', FAILED:'FAILED',
  CANCEL_REQUESTED:'ACTIVE', CANCELLED_CONFIRMED:'CANCELLED', UNKNOWN:'UNKNOWN', NOT_READABLE:'UNKNOWN',
});
type Observer = Pick<WorkerAdapter,'getWorkerStatus'>;
export type ReconciliationRequest = { run_ref:AdapterRunRef; expected_job_revision:number };
export type ReconciliationBody = {
  format:'xdev-worker-reconciliation-1'; job_id:JobId; task_id:TaskId; run_ref:AdapterRunRef;
  expected_job_revision:number; observation:WorkerStatus; evidence_refs:EvidenceRef[];
  proposed_run_state:RunState; apply_allowed:boolean;
  status:'RECONCILIATION_READY'|'RECONCILIATION_REQUIRED'|'RECONCILIATION_EVIDENCE_INSUFFICIENT'|'INSPECTION_ONLY_PENDING';
  reconciliation_required:true; cancellation_observed:boolean; workspace_safe_to_reuse:false;
};
export type ReconciliationProposal = ReconciliationBody & { proposal_digest:string };
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);

function bind(j:Job,r:AdapterRunRef) {
  exact(r,['job','task','agent_run','workspace','worker_run','evidence_scope']);
  const t=j.tasks.find(t=>t.task_id===r.task.task_id),run=j.runs.find(x=>x.run_id===r.agent_run.run_id);
  check(t&&run&&same(r.job,{job_id:j.job_id})&&same(r.task,{job_id:j.job_id,task_id:t.task_id})&&
    same(r.agent_run,{task_id:t.task_id,run_id:run.run_id})&&run.task_id===t.task_id&&t.run_ids.includes(run.run_id)&&
    same(r.workspace,t.workspace)&&same(r.worker_run,run.worker_run),'RECONCILIATION_IDENTITY_MISMATCH');
  check(r.evidence_scope==='PRODUCTION'||r.evidence_scope==='TEST_ONLY_TRANSPORT','RECONCILIATION_IDENTITY_MISMATCH');
  return run;
}

function observedRefs(o:WorkerStatus):EvidenceRef[] {
  const refs=o.observation_evidence_refs??[];
  check(Array.isArray(refs),'RECONCILIATION_EVIDENCE_INVALID');refs.forEach(evidence);
  check(new Set(refs.map(r=>r.id)).size===refs.length,'RECONCILIATION_EVIDENCE_INVALID');
  return structuredClone(refs);
}

function proposalBody(request:ReconciliationRequest,o:WorkerStatus):ReconciliationBody {
  check(Object.hasOwn(WORKER_STATE_MAPPING,o.state),'RECONCILIATION_STATE_UNSUPPORTED');
  check(['NOT_SENT','SENT_NO_ACK','ACKED_NO_PERSISTED_ID','COMMITTED_ID_OBSERVED','TERMINAL_RESULT_OBSERVED','UNKNOWN'].includes(o.certainty),'RECONCILIATION_CERTAINTY_INVALID');
  timestamp(o.observed_at);check(o.workspace_safe_to_reuse===false,'RECONCILIATION_WORKSPACE_CLAIM_UNSUPPORTED');
  const proposed=WORKER_STATE_MAPPING[o.state],refs=observedRefs(o);
  const proven=refs.length>0&&(proposed==='ACTIVE'?o.certainty==='COMMITTED_ID_OBSERVED':o.certainty==='TERMINAL_RESULT_OBSERVED');
  const status=proposed==='PENDING'?'INSPECTION_ONLY_PENDING':proposed==='UNKNOWN'?'RECONCILIATION_REQUIRED':proven?'RECONCILIATION_READY':'RECONCILIATION_EVIDENCE_INSUFFICIENT';
  return {format:'xdev-worker-reconciliation-1',job_id:request.run_ref.job.job_id,task_id:request.run_ref.task.task_id,
    run_ref:structuredClone(request.run_ref),expected_job_revision:request.expected_job_revision,observation:structuredClone(o),
    evidence_refs:refs,proposed_run_state:proposed,apply_allowed:proposed==='UNKNOWN'||status==='RECONCILIATION_READY',
    status,reconciliation_required:true,cancellation_observed:o.state==='CANCEL_REQUESTED',workspace_safe_to_reuse:false};
}

/** Trusted composition injects one canonical store and an observer only. Requests never select roots.
 * Issued digests are ephemeral inspection tickets, not Job state or execution permission.
 * An unapplied ticket lost on process restart must be inspected again; committed replay is durable.
 */
export class JobControlSurface {
  private readonly store:JobStore;
  private readonly observer:Observer;
  private readonly issued=new Set<string>();
  constructor(store:JobStore,observer:Observer) { this.store=store;this.observer=observer; }
  getJobStatus(id:JobId) {
    const status=this.store.getJobStatus(id),j=this.store.getJob(id);check(status.revision===j.revision,'JOB_REVISION_DRIFT');
    return {...status,current_agent_runs:j.tasks.filter(t=>t.current_run_id!==null).map(t=>j.runs.find(r=>r.run_id===t.current_run_id)!)};
  }
  getJobResult(id:JobId) { return this.store.getJobResult(id); }
  getTask(id:TaskId) { return this.store.getTask(id); }
  inspectResume(id:JobId,expected_revision:number) {
    const plan=this.store.prepareResume(id,expected_revision);
    const j=this.store.getJob(id);check(j.revision===plan.revision,'JOB_REVISION_DRIFT');
    return {...plan,pending_tasks:plan.tasks.filter(t=>t.classification==='PENDING'),
      unknown_or_active_runs:j.runs.filter(r=>['UNKNOWN','ACTIVE','PENDING'].includes(r.state)),
      verification_rerun_requirements:plan.tasks.filter(t=>t.classification==='VERIFICATION_MUST_RERUN'),owner_gates:j.owner_gates,
      control_reference_observations:{stored_job_refs:j.control_refs,stored_task_refs:j.tasks.map(t=>({task_id:t.task_id,refs:t.control_refs})),current_validity:'NOT_OBSERVED' as const}};
  }
  async inspectWorkerReconciliation(input:ReconciliationRequest):Promise<ReconciliationProposal> {
    exact(input,['run_ref','expected_job_revision']);const request=structuredClone(input);
    const j=this.store.getJob(request.run_ref.job.job_id);check(j.revision===request.expected_job_revision,'JOB_REVISION_DRIFT');
    const run=bind(j,request.run_ref);check(['ACTIVE','PENDING','UNKNOWN'].includes(run.state),'RECONCILIATION_SUPERSEDED');
    check(this.issued.size<128,'RECONCILIATION_INSPECTION_LIMIT');
    const observation=structuredClone(await this.observer.getWorkerStatus(structuredClone(request.run_ref)));
    check(same(observation.run_ref,request.run_ref),'RECONCILIATION_IDENTITY_MISMATCH');
    const current=this.store.getJob(j.job_id);check(current.revision===j.revision,'JOB_REVISION_DRIFT');bind(current,observation.run_ref);
    const body=proposalBody(request,observation),proposal_digest=digest(body);
    if(body.apply_allowed)this.issued.add(proposal_digest);
    return {...body,proposal_digest};
  }
  applyWorkerReconciliation(input:ReconciliationProposal) {
    const p=structuredClone(input);
    exact(p,['format','job_id','task_id','run_ref','expected_job_revision','observation','evidence_refs','proposed_run_state','apply_allowed','status','reconciliation_required','cancellation_observed','workspace_safe_to_reuse','proposal_digest']);
    const {proposal_digest,...body}=p;
    check(proposal_digest===digest(body)&&same(body,proposalBody({run_ref:p.run_ref,expected_job_revision:p.expected_job_revision},p.observation)),'RECONCILIATION_PROPOSAL_DRIFT');
    check(same(p.run_ref,p.observation.run_ref),'RECONCILIATION_IDENTITY_MISMATCH');
    const j=this.store.getJob(p.job_id),run=bind(j,p.run_ref);
    const reconciliation_ref={id:'reconciliation:'+proposal_digest,sha256:proposal_digest};
    const last=run.observations.at(-1);
    if(j.revision===p.expected_job_revision+1&&last&&run.state===p.proposed_run_state&&last.state===p.proposed_run_state&&
      same(last.reconciliation_ref,reconciliation_ref)&&same(last.evidence_refs,p.evidence_refs)) {
      this.issued.delete(proposal_digest);
      return {status:'ALREADY_APPLIED' as const,job_id:j.job_id,revision:j.revision,run_id:run.run_id};
    }
    check(j.revision===p.expected_job_revision,'JOB_REVISION_DRIFT');
    check(['ACTIVE','PENDING','UNKNOWN'].includes(run.state),'RECONCILIATION_SUPERSEDED');
    check(p.apply_allowed,p.status);
    check(this.issued.has(proposal_digest),'RECONCILIATION_REINSPECTION_REQUIRED');
    const next=this.store.mutate(j.job_id,p.expected_job_revision,{kind:'RUN_OBSERVATION',run_id:run.run_id,
      state:p.proposed_run_state,evidence_refs:p.evidence_refs,reconciliation_ref});
    this.issued.delete(proposal_digest);
    return {status:'APPLIED' as const,job_id:next.job_id,revision:next.revision,run_id:run.run_id};
  }
  requestCancel(id:JobId,expected_revision:number) { return this.store.cancelJob(id,expected_revision); }
}
