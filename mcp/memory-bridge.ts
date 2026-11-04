import { canonical } from '../src/job-runtime/store.ts';
import { supervisedManifest } from '../src/host-surface/supervised-quality.ts';
import { bytes, exact, hash, refShape, within } from './configure.ts';
import type { FileRef, LocalConfig } from './configure.ts';
import { connectXmem, MemoryError, memoryCheck, memoryJson, memoryBoundaryOperation, readStandaloneChild, approvedDependencies, standaloneDependencyPeer } from './xmem-client.ts';
import type { XmemPeer } from './xmem-client.ts';
import { beginMemoryOperation, inspectMemoryOperation, confirmMemoryOperation } from './memory-operation.ts';
import type { MemoryConfirmation, MemoryIntent } from './memory-operation.ts';

import { bridgeRelated } from './related-memory.ts';
import { projectCurrentMemoryFacts } from './current-memory-facts.ts';
import { selectMemoryBoundary, E7_NATIVE_BUILD, isUnifiedBuild } from '../src/host-surface/project-memory-boundary.ts';

import { nativeOrdinaryAllowed } from './sdk-builds.ts';

export type MemoryAction='recall'|'capture'|'reconcile'|'checkpoint'|'related'|'worker-context'|'engineering-capture'|'engineering-reconcile';
type MemoryReadback={status:string;readback:string;persisted:string;applicability:string;revision_id?:string;record_id?:string;source_id?:string;payload_sha256?:string;source_content_sha256?:string;current?:any};
const categories=['DECISION','CONSTRAINT','REQUIREMENT_CHANGE','FAILED_APPROACH','ROOT_CAUSE_HYPOTHESIS','IMPORTANT_DISCOVERY','HANDOFF_STATE'];
export function memoryScope(c:LocalConfig) {const m=c.memory_bridge!;return{project_id:m.project_id,workspace_id:m.workspace_id,task_ref:m.task_ref,task_version:m.task_version,role:m.role};}
const word=(v:unknown)=>typeof v==='string'&&v.trim().length>0&&Buffer.byteLength(v)<=256&&!/[\x00-\x1f]/.test(v);
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function continuity(value:any) {exact(value,['completed','pending','blocked','next_steps']);const normalized:Record<string,string[]>={};for(const [key,list] of Object.entries(value)){memoryCheck(Array.isArray(list)&&list.length<=64&&list.every(x=>typeof x==='string'&&x.trim().length>0&&Buffer.byteLength(x)<=2048)&&new Set(list).size===list.length,'MEMORY_CONTINUITY_INVALID');normalized[key]=[...list].sort();}return normalized;}
function approvedSource(c:LocalConfig,ref:FileRef):any {
  refShape(ref);memoryCheck(within(c.input_root,ref.path)&&(c.memory_bridge!.approved_sources.some(r=>same(r,ref))),'MEMORY_SOURCE_NOT_APPROVED');
  const b=bytes(ref.path,16384);memoryCheck(hash(b)===ref.sha256,'MEMORY_SOURCE_DRIFT');return memoryJson(new TextDecoder('utf-8',{fatal:true}).decode(b));
}
/** Current public facts never replace historical handoff text or grant rights. */
export function currentMemoryFacts(c:LocalConfig){
 const m=c.memory_bridge!;if(m.current_facts===undefined)return null;
 const result=projectCurrentMemoryFacts({xdev_project_id:c.project_id,project_root:c.project_root,project_id:m.project_id,workspace_id:m.workspace_id,task_ref:m.task_ref,task_version:m.task_version,role:m.role},m.current_facts,r=>{
  refShape(r);memoryCheck(within(c.input_root,r.path)&&m.approved_sources.some(a=>same(a,r)),'MEMORY_CURRENT_FACT_SOURCE_NOT_APPROVED');const b=bytes(r.path,65536);memoryCheck(hash(b)===r.sha256,'MEMORY_CURRENT_FACT_SOURCE_DRIFT');return new TextDecoder('utf-8',{fatal:true}).decode(b);
 });memoryCheck(Buffer.byteLength(canonical(result))<=m.limits.payload_bytes,'MEMORY_CURRENT_FACTS_PAYLOAD_BOUND');return result;
}
function eventInput(c:LocalConfig,action:MemoryAction,source:FileRef) {
  const v=approvedSource(c,source),m=c.memory_bridge!,checkpoint=action==='checkpoint';
  const base=['format','namespace','event_id','scope','visibility','audience','provenance','coverage','epistemic_state','execution_verified','private_material'];
  exact(v,[...base,...(checkpoint?['completed','pending','blocked','next_steps']:['category','content'])]);
  memoryCheck(v.format===(checkpoint?'xdev-public-memory-checkpoint-1':'xdev-public-memory-event-1')&&v.namespace===m.event_namespace&&word(v.event_id),'MEMORY_EVENT_ID_INVALID');
  memoryCheck(same(v.scope,{xdev_project_id:c.project_id,...memoryScope(c)}),'MEMORY_EVENT_SCOPE_MISMATCH');
  memoryCheck(v.visibility==='PUBLIC_SHARED'&&same(v.audience,['developer'])&&v.provenance==='COORDINATOR_TRANSFERRED'&&v.private_material===false&&v.execution_verified===false&&['INCOMPLETE','PUBLIC_EVENT_DECLARATION'].includes(v.coverage),'MEMORY_PUBLIC_SOURCE_REQUIRED');
  if(checkpoint){memoryCheck(v.epistemic_state==='ASSERTED','MEMORY_EPISTEMIC_STATE');continuity(Object.fromEntries(['completed','pending','blocked','next_steps'].map(k=>[k,v[k]])));}
  else memoryCheck(categories.includes(v.category)&&v.epistemic_state===(v.category==='ROOT_CAUSE_HYPOTHESIS'?'HYPOTHESIS':'ASSERTED')&&typeof v.content==='string'&&v.content.trim().length>0&&!v.content.includes('\0'),'MEMORY_EVENT_CONTENT_INVALID');
  const content=canonical(v);memoryCheck(Buffer.byteLength(content)<=m.limits.payload_bytes&&Buffer.byteLength(content)<=16384,'MEMORY_EVENT_BYTE_BOUND');
  const id=hash(canonical([v.namespace,v.event_id]));
  const intent:MemoryIntent={format:'xdev-memory-operation-1',id,kind:checkpoint?'checkpoint':'capture',scope_sha256:hash(canonical({xdev_project_id:c.project_id,...memoryScope(c),policy_hash:m.policy_hash,location_hash:m.location_hash,recipient:m.recipient})),source,content_sha256:hash(content),memory_key:checkpoint?null:'xdev-event-'+id};
  return{value:v,content,intent};
}
export function checkReadback(c:LocalConfig,value:any,content:string,revision:string|null=null,expectedPrevious:string|null=null,observedBuild?:string):MemoryReadback {
  const m=c.memory_bridge!;
  memoryCheck(expectedPrevious===null||word(expectedPrevious),'MEMORY_READ_PREDECESSOR_EXPECTATION_INVALID');
  memoryCheck(value.contract==='CORE_HOST_CAPTURE_READBACK_V1'&&value.policy_hash===m.policy_hash&&value.execution_verified===false&&value.owner_confirmation_verified===false&&value.actor_identity_verified===false&&value.applicability==='NOT_EVALUATED'&&value.budget_unit==='utf8-bytes'&&value.payload_budget_bytes===m.limits.payload_bytes,'MEMORY_READ_CONTRACT_MISMATCH');
  if(value.status==='NOT_FOUND_WITHIN_SCOPE'){memoryCheck(value.persisted==='UNKNOWN'&&value.payload===null&&value.payload_bytes===0,'MEMORY_READ_NOT_FOUND_INVALID');return{status:'UNKNOWN',readback:'NOT_FOUND_WITHIN_SCOPE',persisted:'UNKNOWN',applicability:'NOT_EVALUATED'};}
  if(value.status==='BUDGET_UNSATISFIABLE'){memoryCheck(value.payload===null&&value.payload_bytes===0,'MEMORY_READ_BUDGET_INVALID');return{status:'INCOMPLETE',readback:'BUDGET_UNSATISFIABLE',persisted:'UNKNOWN',applicability:'NOT_EVALUATED'};}
  memoryCheck(value.status==='COMPLETE'&&value.persisted==='SAVED'&&typeof value.payload==='string'&&Buffer.byteLength(value.payload)===value.payload_bytes&&value.payload_bytes===value.required_payload_bytes&&value.payload_bytes<=m.limits.payload_bytes&&hash(value.payload)===value.content_hash,'MEMORY_READ_PAYLOAD_HASH_OR_BOUND');
  const p=memoryJson(value.payload);memoryCheck(p.schema_version===1&&same(p.scope,memoryScope(c))&&same(p.binding?.roles,['developer'])&&p.binding.mandatory===false,'MEMORY_READ_SCOPE_MISMATCH');
  memoryCheck(p.record?.content===content&&p.source_content_hash===hash(content)&&p.record.previous_revision_id===expectedPrevious&&['ASSERTED','HYPOTHESIS'].includes(p.record.epistemic_state),'MEMORY_READ_SOURCE_CONTENT_MISMATCH');
  memoryCheck(word(p.record.record_id)&&word(p.record.revision_id)&&word(p.source?.source_id)&&p.source.kind==='agent'&&same(p.binding.allowed_source_ids,[p.source.source_id])&&(revision===null||p.record.revision_id===revision),'MEMORY_READ_REFERENCE_MISMATCH');
  memoryCheck(p.durable_receipt?.kind==='CORE_HOST_CAPTURE'&&digest(p.durable_receipt.event_payload_hash)&&p.durable_receipt.event_id==='host-capture-'+p.record.revision_id&&p.durable_receipt.idempotency_key===p.durable_receipt.event_id,'MEMORY_READ_DURABLE_RECEIPT_INVALID');
  const boundaryBuild=isUnifiedBuild(observedBuild)?observedBuild:selectMemoryBoundary(c)?.boundary.sdk_build_id;
  const unified=isUnifiedBuild(boundaryBuild)||nativeOrdinaryAllowed(c,boundaryBuild)||(m.engineering?.enabled===true&&isUnifiedBuild(m.engineering.build_id));
  if(unified){exact(p.current,['revision_id','lifecycle','is_current']);memoryCheck(typeof p.current.is_current==='boolean'&&(p.current.is_current===false?p.current.revision_id===null&&p.current.lifecycle==='UNKNOWN':p.current.revision_id===p.record.revision_id&&word(p.current.revision_id)&&typeof p.current.lifecycle==='string'),'MEMORY_READ_CURRENT_INVALID');}
  else memoryCheck(typeof p.current?.is_current==='boolean'&&word(p.current.revision_id)&&typeof p.current.lifecycle==='string'&&p.current.is_current===(p.current.revision_id===p.record.revision_id),'MEMORY_READ_CURRENT_INVALID');
  return{status:p.current.is_current&&p.current.lifecycle==='ACTIVE'?'SAVED':'STALE',readback:'COMPLETE',persisted:'SAVED',applicability:'NOT_EVALUATED',revision_id:p.record.revision_id,record_id:p.record.record_id,source_id:p.source.source_id,payload_sha256:value.content_hash,source_content_sha256:p.source_content_hash,current:p.current};
}
export function checkContext(c:LocalConfig,value:any,observedBuild?:unknown) {
  const m=c.memory_bridge!,ctx=value.context;
  const boundaryBuild=observedBuild??selectMemoryBoundary(c)?.boundary.sdk_build_id;
  const unified=isUnifiedBuild(boundaryBuild)||nativeOrdinaryAllowed(c,boundaryBuild);
  memoryCheck(value.project_root===c.project_root&&value.project_id===m.project_id&&value.policy_hash===m.policy_hash&&value.automatic_hooks===false&&same(value.session,{workspace_id:m.workspace_id,task_ref:m.task_ref,task_version:m.task_version,role:'developer'}),'MEMORY_CONTEXT_SCOPE_MISMATCH');
  memoryCheck(ctx?.kind==='ContextPack'&&ctx.compiler_version==='context-v2'&&ctx.budget_unit==='utf8-bytes'&&ctx.diagnostics?.execution_verified===false,'MEMORY_CONTEXT_CONTRACT');
  const r=ctx.request;for(const [k,v] of Object.entries(memoryScope(c)))memoryCheck(r?.[k]===v,'MEMORY_CONTEXT_REQUEST_SCOPE');
  memoryCheck(typeof ctx.payload==='string'&&Buffer.byteLength(ctx.payload)===ctx.payload_bytes&&ctx.payload_bytes<=m.limits.payload_bytes&&r.payload_budget_bytes<=m.limits.payload_bytes&&ctx.mcp_projection?.schema_version===1&&ctx.mcp_projection.representation==='MCP_REDACTED_CONTEXT_PAYLOAD'&&ctx.mcp_projection.payload_sha256===hash(ctx.payload)&&digest(ctx.content_hash)&&digest(ctx.manifest_hash),'MEMORY_CONTEXT_PAYLOAD_HASH_OR_BOUND');
  if(unified){const p=ctx.mcp_projection,b=value.budget;exact(p,['schema_version','representation','internal_payload_bytes','payload_sha256','content_hash_scope','manifest_hash_scope','budget_basis']);memoryCheck(Number.isSafeInteger(p.internal_payload_bytes)&&p.internal_payload_bytes>=ctx.payload_bytes&&p.internal_payload_bytes<=r.payload_budget_bytes&&p.content_hash_scope==='INTERNAL_CONTEXT_PACK_BODY'&&p.manifest_hash_scope==='INTERNAL_CONTEXT_MANIFEST'&&p.budget_basis==='INTERNAL_PRE_REDACTION_PAYLOAD_UTF8'&&value.telemetry?.context_payload_measurement==='INTERNAL_PRE_MCP_REDACTION_UTF8','MEMORY_CONTEXT_INTERNAL_MEASUREMENT');exact(b,['approved_limit_bytes','effective_limit_bytes','unit','basis','measured_bytes']);exact(b.measured_bytes,['context','continuity','interpretation','total']);memoryCheck(b.unit==='utf8-bytes'&&['INTERNAL_PRE_REDACTION_CONTEXT_PLUS_CONTINUITY','INTERNAL_PRE_REDACTION_CONTEXT_PLUS_RETURNED_CONTINUITY_PLUS_INTERPRETATION'].includes(b.basis)&&Object.values(b.measured_bytes).every(n=>Number.isSafeInteger(n)&&Number(n)>=0)&&b.measured_bytes.context===p.internal_payload_bytes&&b.measured_bytes.total===b.measured_bytes.context+b.measured_bytes.continuity+b.measured_bytes.interpretation&&Number.isSafeInteger(b.effective_limit_bytes)&&Number.isSafeInteger(b.approved_limit_bytes)&&b.measured_bytes.total<=b.effective_limit_bytes&&b.effective_limit_bytes<=b.approved_limit_bytes&&b.approved_limit_bytes<=m.limits.payload_bytes,'MEMORY_CONTEXT_INTERNAL_BUDGET');}
  memoryCheck(Array.isArray(ctx.revisions)&&ctx.revisions.length<=512&&Array.isArray(ctx.coverage)&&ctx.coverage.length<=512&&typeof ctx.traversal_incomplete==='boolean'&&['READY','EMPTY','INCOMPLETE'].includes(ctx.diagnostics.status),'MEMORY_CONTEXT_COMPLETENESS');
  const records=ctx.payload===''?[]:ctx.payload.split('\n').map((line:string)=>memoryJson(line));
  memoryCheck(records.every((x:any)=>word(x.revision_id)&&['ASSERTED','HYPOTHESIS'].includes(x.epistemic_state)&&typeof x.content==='string'&&word(x.source?.source_id)&&['agent','user'].includes(x.source.kind))&&same(records.map((x:any)=>x.revision_id),ctx.revisions),'MEMORY_CONTEXT_RECORDS_INVALID');
  let handoff:any=null;
  if(value.handoff!==null){const h=value.handoff;memoryCheck(word(h?.package_id)&&['VALID','STALE','INCOMPLETE'].includes(h.validation?.status),'MEMORY_HANDOFF_INVALID');handoff={package_id:h.package_id,status:h.validation.status,continuity:h.validation.status==='VALID'?continuity(h.continuity):null};if(unified){const i=h.interpretation;exact(i,['kind','applicability','material_validation_only','scope','basis','next_host_action']);exact(i.basis,['package_id','context_manifest_hash']);memoryCheck(i.kind==='HISTORICAL_CHECKPOINT_SNAPSHOT'&&i.applicability==='NOT_EVALUATED'&&i.material_validation_only===true&&same(i.scope,memoryScope(c))&&i.basis.package_id===h.package_id&&digest(i.basis.context_manifest_hash)&&i.next_host_action===(h.validation.status==='VALID'?'VERIFY_CURRENT_FACTS_BEFORE_ACTING_ON_HISTORICAL_PENDING':'REVIEW_WITHHELD_MATERIAL_BEFORE_RESUME'),'MEMORY_HANDOFF_HISTORICAL_INTERPRETATION');handoff={...handoff,interpretation:structuredClone(i)};}}
  if(ctx.diagnostics.status==='EMPTY')memoryCheck(ctx.payload===''&&ctx.revisions.length===0,'MEMORY_EMPTY_CONTEXT_INVALID');
  const incomplete=ctx.diagnostics.status==='INCOMPLETE'||ctx.traversal_incomplete||handoff?.status==='INCOMPLETE'||ctx.coverage.some((x:any)=>x?.state!=='included_inline');
  const status=handoff?.status==='STALE'?'STALE':incomplete?'INCOMPLETE':ctx.diagnostics.status;
  return{status,context_status:ctx.diagnostics.status,applicability:'NOT_EVALUATED',usable_as_verified_constraint:false,payload:m.required_context&&(incomplete||status==='STALE')?null:ctx.payload,payload_sha256:ctx.mcp_projection.payload_sha256,payload_bytes:ctx.payload_bytes,internal_content_hash:ctx.content_hash,internal_manifest_hash:ctx.manifest_hash,handoff,required_context_available:!m.required_context||(!incomplete&&status!=='STALE'),...(m.current_facts===undefined?{}:{current_public_facts:currentMemoryFacts(c)})};
}
/** Dependency injection is a module-only test seam; public arguments cannot choose a client. */
export async function bridgeMemory(local:ReturnType<typeof import('./configure.ts').loadConfig>,args:{action:MemoryAction;source?:FileRef},onSideEffect:()=>void,connect:(c:LocalConfig,totalDeadline?:number)=>Promise<XmemPeer>=connectXmem) {
  if(args.action==='related')return bridgeRelated(local,args,onSideEffect);
  if(args.action==='worker-context'||args.action==='engineering-capture'||args.action==='engineering-reconcile'){const engineering=await import('./engineering-memory.ts');return args.action==='engineering-reconcile'&&process.env.XDEV_J01_PHASE07_READONLY==='1'?engineering.bridgeEngineeringReadonlyPhase07(local,args,onSideEffect):engineering.bridgeEngineering(local,args,onSideEffect);}
  const started=Date.now(),c=local.config,m=c.memory_bridge;let operation:ReturnType<typeof memoryBoundaryOperation>|undefined;let peer:XmemPeer|undefined,attempted=false,claimed=false,saveAcknowledged=false,readbackAcknowledged=false;
  let event:ReturnType<typeof eventInput>|undefined;let response:any;let before:string|undefined;let acknowledgedCapture:any=null;
  const base={format:'xdev-memory-result-1',action:args.action,delivery_allowed:false,execution_allowed:false,claim_reset:false,native_identity_authenticated:false,execution_verified:false,applicability:'NOT_EVALUATED',authority:'UNTRUSTED_MEMORY_DATA_ONLY'};
  try{
    memoryCheck(m&&['recall','capture','reconcile','checkpoint'].includes(args.action),'MEMORY_ACTION_INVALID');
    memoryCheck((!m.related?.enabled||m.related.build_id!==E7_NATIVE_BUILD)&&(!m.engineering?.enabled||m.engineering.build_id!==E7_NATIVE_BUILD),'MEMORY_NATIVE_ORDINARY_UNSUPPORTED');
    exact(args,['action',...(args.action==='recall'?[]:['source'])]);memoryCheck(m.permissions[args.action]===true,'MEMORY_PERMISSION_REQUIRED:'+args.action);
    currentMemoryFacts(c);operation=memoryBoundaryOperation(c,started,undefined,{path:local.configPath,sha256:local.configHash});operation.health();const manifest=()=>operation!.manifest()??supervisedManifest(c.project_root);const finish=()=>{operation!.health();currentMemoryFacts(c);operation!.check();};
    const checkLocal=()=>memoryCheck(hash(bytes(local.configPath))===local.configHash,'MEMORY_LOCAL_CONFIG_DRIFT');checkLocal();
    if(args.action!=='recall'){memoryCheck(args.source,'MEMORY_SOURCE_REQUIRED');event=eventInput(c,args.action,args.source);}
    before=hash(canonical(manifest()));const dependencyView=['recall','checkpoint'].includes(args.action)&&approvedDependencies(c,'ordinary')!==null;peer=dependencyView?standaloneDependencyPeer(local,operation.deadline()):await connect(c,operation.total);checkLocal();if(event)eventInput(c,args.action,args.source!);
    const task={task_ref:m.task_ref,task_version:m.task_version,role:'developer'};
    if(args.action==='recall') {onSideEffect();attempted=true;response={context:checkContext(c,await peer.call('xmem_session_start',task),peer.diagnostic().sdk_build),saved:'NOT_REQUESTED',readback:'NOT_REQUESTED'};}
    else {
      const e=event!;let state:ReturnType<typeof beginMemoryOperation>;
      if(args.action==='reconcile'){state=inspectMemoryOperation(c.control_root,e.intent);claimed=true;}
      else{onSideEffect();claimed=true;state=beginMemoryOperation(c.control_root,e.intent);}
      if(args.action==='checkpoint'){
        if(!state.created){response={status:state.confirmation?'CHECKPOINT_CONFIRMED':'UNKNOWN',saved:state.confirmation?'CONFIRMED':'UNKNOWN',readback:'NOT_SUPPORTED_FOR_CHECKPOINT',package_id:state.confirmation?.package_id??null,replayed_locally:true};}
        else{
          const continuityInput=Object.fromEntries(['completed','pending','blocked','next_steps'].map(k=>[k,e.value[k]]));onSideEffect();attempted=true;
          const q=await peer.call('xmem_session_checkpoint',{...task,...continuityInput});
          memoryCheck(q.project_root===c.project_root&&q.project_id===m.project_id&&q.policy_hash===m.policy_hash&&q.execution_verified===false&&q.owner_confirmation_verified===false&&word(q.package_id)&&digest(q.content_hash)&&q.package_id==='handoff-'+q.content_hash&&same(continuity(q.continuity),continuity(continuityInput))&&q.checkpoint_semantics==='IMMUTABLE_CONTENT_REPLAY_DOES_NOT_REORDER'&&typeof q.selected_for_resume==='boolean','MEMORY_CHECKPOINT_RESPONSE_MISMATCH');
          saveAcknowledged=true;const confirmation:MemoryConfirmation={format:'xdev-memory-confirmation-1',intent_sha256:state.intent_sha256,revision_id:null,record_id:null,source_id:null,package_id:q.package_id,payload_sha256:q.content_hash,source_content_sha256:e.intent.content_sha256};
          response={status:'CHECKPOINT_CONFIRMED',saved:'CONFIRMED',readback:'NOT_SUPPORTED_FOR_CHECKPOINT',package_id:q.package_id,selected_for_resume:q.selected_for_resume};
          await peer.guard();checkLocal();memoryCheck(before===hash(canonical(manifest())),'MEMORY_PROJECT_MANIFEST_DRIFT');eventInput(c,args.action,args.source!);finish();confirmMemoryOperation(c.control_root,e.intent,confirmation);return{...base,...response,save_acknowledged:true,delivery:{recipient:m.recipient,status:'PREPARED_FOR_COORDINATOR_RETURN',received:'NOT_OBSERVED',host_injected:false},operation_id:e.intent.id,diagnostic:peer.diagnostic()};
        }
      } else {
        let revision:string|null=state.confirmation?.revision_id??null;let captureReference:any=null;
        if(args.action==='capture'&&state.created){onSideEffect();attempted=true;captureReference=await peer.call('xmem_session_capture',{task_ref:m.task_ref,task_version:m.task_version,memory_key:e.intent.memory_key,category:e.value.category,declared_actor:'agent',content:e.content,previous_revision_id:null});
          memoryCheck(captureReference.project_id===m.project_id&&captureReference.workspace_id===m.workspace_id&&captureReference.task_ref===m.task_ref&&captureReference.task_version===m.task_version&&captureReference.category===e.value.category&&captureReference.epistemic_state===e.value.epistemic_state&&captureReference.mandatory===false&&captureReference.execution_verified===false&&captureReference.owner_confirmation_verified===false&&captureReference.actor_identity_verified===false&&word(captureReference.revision_id)&&word(captureReference.source_id)&&word(captureReference.record_id),'MEMORY_CAPTURE_RESPONSE_MISMATCH');saveAcknowledged=true;revision=captureReference.revision_id;acknowledgedCapture={scope:memoryScope(c),memory_key:e.intent.memory_key,revision_id:revision,record_id:captureReference.record_id,source_id:captureReference.source_id};
        }
        const readInput={...task,memory_key:e.intent.memory_key,revision_id:revision,payload_budget_bytes:m.limits.payload_bytes};const q=operation.selected?readStandaloneChild(local,readInput,operation.deadline()):await peer.call('xmem_session_read',readInput);
        const sdkBuild=peer.diagnostic().sdk_build;const read=checkReadback(c,q,e.content,revision,null,typeof sdkBuild==='string'?sdkBuild:undefined);readbackAcknowledged=read.readback==='COMPLETE';
        if(captureReference&&readbackAcknowledged)memoryCheck(read.source_id===captureReference.source_id&&read.record_id===captureReference.record_id,'MEMORY_CAPTURE_READ_REFERENCE_MISMATCH');
        response={...read,saved:read.persisted,replayed_locally:!state.created,memory_key:e.intent.memory_key};
        if(readbackAcknowledged){const confirmation:MemoryConfirmation={format:'xdev-memory-confirmation-1',intent_sha256:state.intent_sha256,revision_id:read.revision_id!,record_id:read.record_id!,source_id:read.source_id!,package_id:null,payload_sha256:read.payload_sha256!,source_content_sha256:e.intent.content_sha256};
          onSideEffect();
          await peer.guard();finish();checkLocal();
          memoryCheck(before===hash(canonical(manifest())),'MEMORY_PROJECT_MANIFEST_DRIFT');
          eventInput(c,args.action,args.source!);operation.check();
          confirmMemoryOperation(c.control_root,e.intent,confirmation);
          return{...base,...response,save_acknowledged:saveAcknowledged,readback_acknowledged:true,operation_id:e.intent.id,delivery:{recipient:m.recipient,status:'PREPARED_FOR_COORDINATOR_RETURN',received:'NOT_OBSERVED',host_injected:false},diagnostic:peer.diagnostic()};
        }
      }
    }
    await peer.guard();memoryCheck(hash(bytes(local.configPath))===local.configHash,'MEMORY_LOCAL_CONFIG_DRIFT');memoryCheck(before===hash(canonical(manifest())),'MEMORY_PROJECT_MANIFEST_DRIFT');if(event)eventInput(c,args.action,args.source!);
    finish();return{...base,status:response.context?.status??response.status,...response,save_acknowledged:saveAcknowledged,readback_acknowledged:readbackAcknowledged,operation_id:event?.intent.id??null,delivery:{recipient:m.recipient,status:'PREPARED_FOR_COORDINATOR_RETURN',received:'NOT_OBSERVED',host_injected:false},diagnostic:peer.diagnostic()};
  }catch(e){const error=e instanceof MemoryError?e:new MemoryError('LOCAL','MEMORY_LOCAL_VALIDATION_ERROR',{error_sha256:hash(e instanceof Error?e.message:String(e))});
    return{...base,status:attempted||claimed?'UNKNOWN':'REFUSED',saved:'UNKNOWN',readback:'NOT_CONFIRMED',save_acknowledged:saveAcknowledged,readback_acknowledged:readbackAcknowledged,acknowledged_capture:acknowledgedCapture,operation_id:event?.intent.id??null,memory_key:event?.intent.memory_key??null,error:{layer:error.layer,code:error.code,...error.diagnostic},automatic_retry:false,diagnostic:peer?.diagnostic()??null};
  }finally{await peer?.close().catch(()=>{});}
}
