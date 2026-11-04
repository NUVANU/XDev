import { createHash } from 'node:crypto';
import type { Capability } from '../../worker-adapter/contracts.ts';
import type { JobRef, JobId, TaskId } from '../../job-runtime/contracts.ts';
import type { JobControlSurface, ReconciliationRequest, ReconciliationProposal } from '../../host-surface/control.ts';
import type { JsonlRpcClient } from './rpc.ts';
export function capability(scope:'PRODUCTION'|'TEST_ONLY_TRANSPORT',rpc?:JsonlRpcClient):Capability {
  const proof=rpc?.receipts.filter(r=>r.kind==='RESULT')??[];
  return {worker_kind:'codex',launch_mode:'HOST_NATIVE',execution_control:'NOT_YET_PROVEN',context_control:'PARTIAL',resume_supported:false,structured_events:rpc?.events.length?'OBSERVED':'UNKNOWN',usage_metrics_available:'UNKNOWN',workspace_control:'UNKNOWN',cancellation_supported:proof.some(r=>r.method==='turn/interrupt')?'REQUEST_PROTOCOL_ONLY':'UNKNOWN',evidence_scope:scope,capability_evidence:proof.filter(r=>r.response_sha256).map(r=>({id:'rpc-'+r.rpc_id,sha256:r.response_sha256!})),real_managed_acceptance:'NOT_RUN'};
}
/** Trusted composition wires canonical queries; display links convey no authority. */
export class CodexHostAdapter {
  private readonly surface?:JobControlSurface;
  constructor(surface?:JobControlSurface){this.surface=surface;}
  private wired(){if(!this.surface)throw Error('HOST_SURFACE_NOT_WIRED');return this.surface;}
  describe(){return {host_kind:'codex',context_control:'PARTIAL' as const,execution_control:'HOST_NATIVE' as const,host_memory_visible:'UNKNOWN',conversation_history_replaceable:'UNKNOWN',lifecycle_hooks:'UNKNOWN',usage_metrics_available:'UNKNOWN',async_job_start:'NOT_WIRED',job_status_query:this.surface?'WIRED':'NOT_WIRED',result_query:this.surface?'WIRED':'NOT_WIRED',unsolicited_result_push:false,real_host_acceptance:'NOT_RUN' as const};}
  getJobStatus(id:JobId){return this.wired().getJobStatus(id);}
  getJobResult(id:JobId){return this.wired().getJobResult(id);}
  getTask(id:TaskId){return this.wired().getTask(id);}
  inspectResume(id:JobId,revision:number){return this.wired().inspectResume(id,revision);}
  inspectWorkerReconciliation(request:ReconciliationRequest){return this.wired().inspectWorkerReconciliation(request);}
  applyWorkerReconciliation(proposal:ReconciliationProposal){return this.wired().applyWorkerReconciliation(proposal);}
  requestCancel(id:JobId,revision:number){return this.wired().requestCancel(id,revision);}
  link(job:JobRef,display_ref:string){if(!/^job:[0-9a-f-]{36}$/.test(job.job_id)||!display_ref)throw Error('HOST_LINK_INVALID');return {job_ref:structuredClone(job),host_reference:{provider:'codex',display_ref},canonical_identity_source:'XDEV_JOB_STORE',link_sha256:createHash('sha256').update(JSON.stringify([job.job_id,display_ref])).digest('hex')};}
}
