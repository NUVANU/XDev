import type { AgentRunRef, ContextPackRef, EvidenceRef, HandoffRef, JobRef, ProjectRef, TaskRef, WorkerRunRef, WorkspaceRef } from '../job-runtime/contracts.ts';
import type { TrustedExecutionContext } from '../execution/trusted-execution-context.ts';
export type SideEffectCertainty = 'NOT_SENT'|'SENT_NO_ACK'|'ACKED_NO_PERSISTED_ID'|'COMMITTED_ID_OBSERVED'|'TERMINAL_RESULT_OBSERVED'|'UNKNOWN';
export type WorkerState = 'STARTING'|'ACTIVE'|'COMPLETED'|'FAILED'|'CANCEL_REQUESTED'|'CANCELLED_CONFIRMED'|'UNKNOWN'|'NOT_READABLE';
export type Capability = {
  worker_kind:string; launch_mode:'HOST_NATIVE'|'MANAGED'; execution_control:'HOST_NATIVE'|'LIMITED'|'MANAGED'|'NOT_YET_PROVEN';
  context_control:'PARTIAL'|'FULL'|'NOT_YET_PROVEN'; resume_supported:false; structured_events:'OBSERVED'|'UNKNOWN';
  usage_metrics_available:'OBSERVED'|'UNKNOWN'; workspace_control:'FULL'|'PARTIAL'|'NONE'|'UNKNOWN';
  cancellation_supported:'REQUEST_PROTOCOL_ONLY'|'UNKNOWN'; evidence_scope:'PRODUCTION'|'TEST_ONLY_TRANSPORT';
  capability_evidence:EvidenceRef[]; real_managed_acceptance:'NOT_RUN';
};
export type AdapterRunRef = {
  job:JobRef; task:TaskRef; agent_run:AgentRunRef; workspace:WorkspaceRef; worker_run:WorkerRunRef;
  evidence_scope:'PRODUCTION'|'TEST_ONLY_TRANSPORT';
};
export type WorkerStartInput = {
  project:ProjectRef; job:JobRef; task:TaskRef; agent_run:AgentRunRef; workspace:WorkspaceRef;
  task_contract:{ref:EvidenceRef;content:string}; context:{ref:ContextPackRef;content:string;handoff_ref:HandoffRef|null};
  execution_context:TrustedExecutionContext|null;
};
export type WorkerStatus = { state:WorkerState; run_ref:AdapterRunRef; certainty:SideEffectCertainty; observed_at:string; adapter_evidence:unknown; workspace_safe_to_reuse:false;
  /** Actual receipt/output refs for this observation, bound by run_ref. Absence is insufficient evidence. */
  observation_evidence_refs?:EvidenceRef[] };
export type RunEvidence = {
  run_ref:AdapterRunRef; workspace:WorkspaceRef; base_revision:string; observed_head:'UNKNOWN'; changed_files:'UNKNOWN'|string[];
  commands:{id:string;command:string;exit_code:number|'UNKNOWN';output_ref:EvidenceRef|'UNKNOWN'}[];
  terminal_status:WorkerState; observed_at:string; usage:'UNKNOWN'|Record<string,unknown>;
  runtime_output_refs:EvidenceRef[]; narrative_is_verification:false; adapter_evidence:unknown;
};
export interface WorkerAdapter {
  probeCapabilities():Promise<Capability>;
  startWorker(input:WorkerStartInput):Promise<WorkerStatus>;
  resumeWorker(run:AdapterRunRef,context:WorkerStartInput['context']):Promise<{status:'RESUME_NOT_SUPPORTED'|'RECONCILIATION_REQUIRED';run_ref:AdapterRunRef;new_run_created:false}>;
  getWorkerStatus(run:AdapterRunRef):Promise<WorkerStatus>;
  cancelWorker(run:AdapterRunRef):Promise<WorkerStatus>;
  collectRunEvidence(run:AdapterRunRef):Promise<RunEvidence>;
  closeWorker(run:AdapterRunRef):Promise<{transport_closed:boolean;remote_worker_stopped:false;workspace_safe_to_reuse:false;run_ref:AdapterRunRef}>;
}
