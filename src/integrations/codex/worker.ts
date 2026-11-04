import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { AdapterRunRef, RunEvidence, WorkerAdapter, WorkerStartInput, WorkerStatus } from '../../worker-adapter/contracts.ts';
import { capability } from './host.ts';
import { ADAPTER_VERSION, CodexClient, type CodexRunMetadata } from './client.ts';
import { JsonlRpcClient, RpcFailure, record, text, type RpcReceipt } from './rpc.ts';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function requireFact(ok:unknown,code:string):asserts ok{if(!ok)throw Error(code);}
const idPattern='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
function identities(input:Pick<WorkerStartInput,'job'|'task'|'agent_run'>){requireFact(new RegExp('^job:'+idPattern+'$').test(input.job.job_id)&&input.task.job_id===input.job.job_id&&new RegExp('^task:'+input.job.job_id.slice(4)+':'+idPattern+'$').test(input.task.task_id)&&input.agent_run.task_id===input.task.task_id&&new RegExp('^run:'+idPattern+'$').test(input.agent_run.run_id),'CORE_IDENTITY_INVALID');}
function context(c:WorkerStartInput['context']){requireFact(record(c)&&Object.keys(c).sort().join(',')==='content,handoff_ref,ref'&&typeof c.content==='string'&&Buffer.byteLength(c.content)<=32768&&c.ref?.sha256===sha(c.content),'BOUNDED_CONTEXT_INVALID');}
function metadata(run:AdapterRunRef):CodexRunMetadata{
  identities(run);const m=run.worker_run.adapter_metadata;
  requireFact(m.provider==='codex'&&m.adapter_version===ADAPTER_VERSION&&m.launch_mode==='HOST_NATIVE'&&text(m.capability_snapshot)&&text(m.cwd)&&isAbsolute(m.cwd)&&run.workspace.worktree_ref!==null&&resolve(run.workspace.worktree_ref)===m.cwd,'ADAPTER_RUN_SCOPE_INVALID');
  return m as unknown as CodexRunMetadata;
}
export class AdapterStartFailure extends Error {
  readonly run_ref:AdapterRunRef;readonly effects:RpcReceipt[];readonly cause:unknown;
  constructor(run_ref:AdapterRunRef,effects:RpcReceipt[],cause:unknown){super('ADAPTER_START_INCOMPLETE',{cause});this.run_ref=structuredClone(run_ref);this.effects=structuredClone(effects);this.cause=cause;}
}
/** Protocol-only engine. The production resolver cannot construct/select this test driver.
 * No execution authority is represented by the TEST_ONLY_TRANSPORT marker.
 */
export class TestOnlyCodexWorkerAdapter implements WorkerAdapter {
  private readonly client:CodexClient;private readonly attempted=new Set<string>();private readonly cancellation=new Set<string>();
  constructor(rpc:JsonlRpcClient){requireFact(rpc.evidence_scope==='TEST_ONLY_TRANSPORT','TEST_ONLY_TRANSPORT_REQUIRED');this.client=new CodexClient(rpc);}
  async probeCapabilities(){return capability('TEST_ONLY_TRANSPORT',this.client.rpc);}
  private assertScope(run:AdapterRunRef){requireFact(run.evidence_scope==='TEST_ONLY_TRANSPORT','TEST_RUN_SCOPE_REQUIRED');return metadata(run);}
  async startWorker(input:WorkerStartInput):Promise<WorkerStatus>{
    requireFact(record(input)&&Object.keys(input).sort().join(',')==='agent_run,context,execution_context,job,project,task,task_contract,workspace','WORKER_INPUT_INVALID');identities(input);context(input.context);
    requireFact(typeof input.task_contract.content==='string'&&Buffer.byteLength(input.task_contract.content)<=32768&&input.task_contract.ref.sha256===sha(input.task_contract.content),'TASK_CONTRACT_INVALID');
    const cwd=input.workspace.worktree_ref;requireFact(cwd&&isAbsolute(cwd)&&resolve(cwd)===cwd&&['READ_ONLY','MUTABLE'].includes(input.workspace.mutability),'WORKSPACE_REF_REQUIRED');
    requireFact(!this.attempted.has(input.agent_run.run_id),'RECONCILIATION_REQUIRED');this.attempted.add(input.agent_run.run_id);
    const run:AdapterRunRef={job:structuredClone(input.job),task:structuredClone(input.task),agent_run:structuredClone(input.agent_run),workspace:structuredClone(input.workspace),worker_run:{worker:{worker_id:'codex-protocol-fixture',adapter_id:ADAPTER_VERSION},adapter_metadata:{provider:'codex',cwd,launch_mode:'HOST_NATIVE',adapter_version:ADAPTER_VERSION,capability_snapshot:sha(JSON.stringify(await this.probeCapabilities()))}},evidence_scope:'TEST_ONLY_TRANSPORT'};
    const effects:RpcReceipt[]=[];
    try{
      await this.client.initialize();const thread=await this.client.startThread(cwd,input.workspace.mutability);run.worker_run.adapter_metadata.thread_id=thread.id;effects.push(thread.receipt);
      const turn=await this.client.startTurn(thread.id,input.task_contract.content+'\n'+input.context.content,input.workspace.mutability);run.worker_run.adapter_metadata.turn_id=turn.id;effects.push(turn.receipt);
      return {state:'STARTING',run_ref:run,certainty:'COMMITTED_ID_OBSERVED',observed_at:new Date().toISOString(),adapter_evidence:{effects},workspace_safe_to_reuse:false};
    }catch(e){if(e instanceof RpcFailure){effects.push(e.receipt);if(e.receipt.thread_ref)run.worker_run.adapter_metadata.thread_id=e.receipt.thread_ref;if(e.receipt.turn_ref)run.worker_run.adapter_metadata.turn_id=e.receipt.turn_ref;}throw new AdapterStartFailure(run,effects,e);}
  }
  async getWorkerStatus(run:AdapterRunRef):Promise<WorkerStatus>{const m=this.assertScope(run);await this.client.initialize();
    const base={run_ref:structuredClone(run),observed_at:new Date().toISOString(),workspace_safe_to_reuse:false as const};
    if(!m.thread_id||!m.turn_id)return {...base,state:'UNKNOWN',certainty:'UNKNOWN',adapter_evidence:{reason:'MISSING_EXACT_REMOTE_ID',rpc_observation:this.client.rpc.observationDiagnostics()}};
    try{const r=await this.client.read(m),turn=r.turn;
      if(!turn||!text(turn.status)||!Array.isArray(turn.items))return {...base,state:'UNKNOWN',certainty:'UNKNOWN',adapter_evidence:{receipt:r.receipt,reason:'EXACT_TURN_NOT_OBSERVABLE',rpc_observation:this.client.rpc.observationDiagnostics()}};
      const mapped:Record<string,WorkerStatus['state']>={inProgress:'ACTIVE',completed:'COMPLETED',failed:'FAILED',interrupted:'CANCELLED_CONFIRMED'};
      let state=mapped[turn.status]??'UNKNOWN';if(state==='ACTIVE'&&this.cancellation.has(run.agent_run.run_id))state='CANCEL_REQUESTED';
      const observation_evidence_refs=r.receipt.kind==='RESULT'&&r.receipt.response_sha256?[{id:'rpc-observation:'+run.agent_run.run_id+':'+r.receipt.response_sha256,sha256:r.receipt.response_sha256}]:[];
      return {...base,state,certainty:['COMPLETED','FAILED','CANCELLED_CONFIRMED'].includes(state)?'TERMINAL_RESULT_OBSERVED':'COMMITTED_ID_OBSERVED',adapter_evidence:{receipt:r.receipt,turn,rpc_observation:this.client.rpc.observationDiagnostics()},observation_evidence_refs};
    }catch(e){if(!(e instanceof RpcFailure))throw e;return {...base,state:e.receipt.kind==='APPLICATION_ERROR'&&e.receipt.code===-32603?'NOT_READABLE':'UNKNOWN',certainty:'UNKNOWN',adapter_evidence:{receipt:e.receipt,reason:/empty|read thread|rollout/i.test(e.receipt.message)?'REMOTE_STATE_INCOMPLETE':'READ_UNRESOLVED',rpc_observation:this.client.rpc.observationDiagnostics()}};}
  }
  async cancelWorker(run:AdapterRunRef):Promise<WorkerStatus>{const m=this.assertScope(run);await this.client.initialize();this.cancellation.add(run.agent_run.run_id);const receipt=await this.client.interrupt(m);return {run_ref:structuredClone(run),state:'CANCEL_REQUESTED',certainty:receipt.certainty,observed_at:receipt.observed_at,workspace_safe_to_reuse:false,adapter_evidence:{receipt,request_acked:true,terminal_cancel_confirmed:false}};}
  async resumeWorker(run:AdapterRunRef,refreshed:WorkerStartInput['context']){this.assertScope(run);context(refreshed);const s=await this.getWorkerStatus(run);return {status:['UNKNOWN','NOT_READABLE','STARTING','ACTIVE','CANCEL_REQUESTED'].includes(s.state)?'RECONCILIATION_REQUIRED' as const:'RESUME_NOT_SUPPORTED' as const,run_ref:structuredClone(run),new_run_created:false as const};}
  async collectRunEvidence(run:AdapterRunRef):Promise<RunEvidence>{
    const status=await this.getWorkerStatus(run),raw=record(status.adapter_evidence)&&record(status.adapter_evidence.turn)?status.adapter_evidence.turn:null;
    const items=raw&&Array.isArray(raw.items)?raw.items:[],commands:RunEvidence['commands']=[],changed:string[]=[],outputs:RunEvidence['runtime_output_refs']=[];let sawFiles=false;
    for(const item of items){if(!record(item))continue;
      if(item.type==='commandExecution'&&text(item.id)&&text(item.command)){
        const output=typeof item.aggregatedOutput==='string'?{id:'codex-output:'+run.agent_run.run_id+':'+item.id,sha256:sha(item.aggregatedOutput)}:'UNKNOWN' as const;
        commands.push({id:item.id,command:item.command,exit_code:typeof item.exitCode==='number'&&Number.isInteger(item.exitCode)?item.exitCode:'UNKNOWN',output_ref:output});if(output!=='UNKNOWN')outputs.push(output);
      }
      if(item.type==='fileChange'&&Array.isArray(item.changes)&&item.changes.every(c=>record(c)&&text(c.path))){sawFiles=true;changed.push(...item.changes.map(c=>c.path as string));}
    }
    const usage=raw&&record(raw.usage)?raw.usage:'UNKNOWN';
    return {run_ref:structuredClone(run),workspace:structuredClone(run.workspace),base_revision:run.workspace.base_revision,observed_head:'UNKNOWN',changed_files:sawFiles?[...new Set(changed)]:'UNKNOWN',commands,terminal_status:status.state,observed_at:status.observed_at,usage,runtime_output_refs:outputs,narrative_is_verification:false,adapter_evidence:status.adapter_evidence};
  }
  async closeWorker(run:AdapterRunRef){this.assertScope(run);await this.client.rpc.close();return {transport_closed:true,remote_worker_stopped:false as const,workspace_safe_to_reuse:false as const,run_ref:structuredClone(run)};}
}
