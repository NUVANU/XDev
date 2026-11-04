import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { record } from '../integrations/codex/rpc.ts';
import { parseUniqueJson } from '../planning/retry-history.ts';
import { checkedRelativeFile, projectRootIdentity, readProjectFile, sha256 } from '../project-model/init-receipt.ts';

const MAX_ITEMS=128, MAX_FIELD_BYTES=8192;
const publicTypes=new Set(['commandExecution','functionCall','functionCallOutput','customToolCall','customToolCallOutput',
  'agentMessage','userMessage','subAgentActivity','error']);
const stringFields=['id','name','namespace','command','cwd','status','phase','text','arguments','output',
  'aggregatedOutput','stdout','stderr','kind','agentThreadId','agentPath','message','code','details','call_id','callId','toolCallId'];
type Scope={thread_id:string;turn_id:string;task_ref:string;task_version:string;workspace_id:string};
function need(value:unknown,code:string):asserts value{if(!value)throw Error(code);}
function exact(value:unknown,keys:string[]):asserts value is Record<string,unknown>{
  need(record(value)&&Object.keys(value).sort().join('|')===[...keys].sort().join('|'),'PUBLIC_EXPORT_SHAPE');
}
function word(value:unknown):asserts value is string{
  need(typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=256&&!/[\x00-\x1f]/.test(value),'PUBLIC_EXPORT_SCOPE');
}
function checkedScope(value:unknown):asserts value is Scope{
  exact(value,['thread_id','turn_id','task_ref','task_version','workspace_id']);
  for(const v of Object.values(value))word(v);
}
function count(value:unknown):number{
  need(Number.isSafeInteger(value)&&Number(value)>=0,'PUBLIC_EXPORT_COUNT');return Number(value);
}
function safeFields(value:Record<string,unknown>,omitted:string[]){
  const result:Record<string,unknown>={};
  for(const key of stringFields){
    const text=value[key];if(text===undefined)continue;
    if(key==='output'&&record(text)&&typeof text.text==='string'&&typeof text.truncated==='boolean'){
      const bytes=Buffer.byteLength(text.text);
      result.output={text:bytes<=MAX_FIELD_BYTES?text.text:{content_omitted:true,bytes,sha256:sha256(text.text)},
        truncated:text.truncated,...(Number.isSafeInteger(text.originalChars)&&Number(text.originalChars)>=0?{originalChars:text.originalChars}:{})};
      if(text.truncated)omitted.push('API_OUTPUT_TRUNCATED');
      if(bytes>MAX_FIELD_BYTES)omitted.push('PUBLIC_FIELD_OVER_LIMIT:output.text');
      if(Object.keys(text).some(k=>!['text','truncated','originalChars'].includes(k)))omitted.push('PUBLIC_OUTPUT_FIELDS_OMITTED');
      continue;
    }
    if(key==='code'&&typeof text==='number'&&Number.isFinite(text))continue;
    if(typeof text!=='string'){omitted.push('NON_STRING_PUBLIC_FIELD:'+key);continue;}
    const bytes=Buffer.byteLength(text);
    if(bytes>MAX_FIELD_BYTES){result[key]={content_omitted:true,bytes,sha256:sha256(text)};omitted.push('PUBLIC_FIELD_OVER_LIMIT:'+key);}
    else result[key]=text;
  }
  for(const key of ['exitCode','durationMs','code']){
    if(value[key]===null)result[key]=null;
    else if(typeof value[key]==='number'&&Number.isFinite(value[key]))result[key]=value[key];
  }
  return result;
}
/** Selected public API observations only. Never constructs a native-source brand or execution credential. */
export function selectPublicHostData(source:unknown,scope:Scope){
  checkedScope(scope);
  need(record(source)&&source.format==='xdev-codex-public-thread-read-1'&&record(source.request)&&
    record(source.response)&&record(source.response.thread)&&Array.isArray(source.response.turns),'PUBLIC_EXPORT_SOURCE');
  need(source.request.threadId===scope.thread_id&&source.request.turnLimit===1&&
    typeof source.request.includeOutputs==='boolean'&&Number.isSafeInteger(source.request.maxOutputCharsPerItem)&&
    Number(source.request.maxOutputCharsPerItem)>0&&Number(source.request.maxOutputCharsPerItem)<=16000&&
    source.response.thread.id===scope.thread_id,'PUBLIC_EXPORT_THREAD_MISMATCH');
  const turns=source.response.turns.filter((t:unknown)=>record(t)&&t.id===scope.turn_id);
  need(turns.length===1&&record(turns[0])&&Array.isArray(turns[0].items),'PUBLIC_EXPORT_TURN_MISMATCH');
  const turn=turns[0],items=turn.items as unknown[];
  const reasons=new Set(['PUBLIC_API_COMPLETENESS_UNPROVEN','COORDINATOR_TRANSFERRED_SOURCE','NATIVE_IDENTITY_UNAUTHENTICATED',
    'NATURAL_TERMINATION_UNPROVEN','WRITER_CLOSURE_UNPROVEN','API_OUTPUT_CAP_MAY_TRUNCATE']);
  const records:Record<string,unknown>[]=[];const omitted:string[]=[];
  let reasoning=count(source.filtered_reasoning_items),unsupported=count(source.filtered_unsupported_items),dropped=0;
  for(const [ordinal,value] of items.entries()){
    need(record(value)&&typeof value.type==='string','PUBLIC_EXPORT_ITEM');
    if(value.type==='reasoning'){reasoning++;continue;} // Never inspect or retain its body.
    if(!publicTypes.has(value.type)){unsupported++;continue;}
    if(records.length===MAX_ITEMS){dropped++;continue;}
    const fields=safeFields(value,omitted);
    if(value.type==='userMessage'){delete fields.text;fields.body_omitted_by_policy=true;}
    if(value.type==='functionCallOutput'||value.type==='customToolCallOutput'||value.type==='commandExecution'){
      if(!['output','text','aggregatedOutput'].some(k=>typeof value[k]==='string')&&
        !(record(value.output)&&typeof value.output.text==='string'&&typeof value.output.truncated==='boolean'))reasons.add('PUBLIC_TOOL_OUTPUT_BODY_MISSING');
    }
    if(record(value.error))fields.error=safeFields(value.error,omitted);
    records.push({source_item_ordinal:ordinal,type:value.type,...fields});
  }
  if(reasoning)reasons.add('REASONING_EXCLUDED');
  if(unsupported)reasons.add('UNSUPPORTED_PUBLIC_ITEMS_OMITTED');
  if(dropped)reasons.add('PUBLIC_ITEM_OVERFLOW');
  const turnError=record(turn.error)?safeFields(turn.error,omitted):turn.error===null?null:'UNKNOWN';
  if(omitted.length)reasons.add('PUBLIC_FIELDS_OMITTED');
  if(omitted.includes('API_OUTPUT_TRUNCATED'))reasons.add('API_OUTPUT_TRUNCATED');
  if(!source.request.includeOutputs)reasons.add('OUTPUTS_NOT_REQUESTED');
  const page=record(source.response.page)?source.response.page:null;
  if(!page||typeof page.hasMore!=='boolean')reasons.add('PAGINATION_UNKNOWN');
  if(page?.hasMore===true)reasons.add('ADDITIONAL_HISTORY_NOT_READ');
  return {
    format:'xdev-public-host-observation-1',provider:'CODEX_APP_READ_THREAD',scope:{...scope},
    binding_claim:'COORDINATOR_DECLARED_TASK_SCOPE_NOT_NATIVE_IDENTITY',
    source_request:{threadId:scope.thread_id,turnLimit:1,includeOutputs:source.request.includeOutputs,
      maxOutputCharsPerItem:source.request.maxOutputCharsPerItem},
    turn:{id:scope.turn_id,status:typeof turn.status==='string'?turn.status:'UNKNOWN',
      startedAt:typeof turn.startedAt==='number'?turn.startedAt:null,completedAt:typeof turn.completedAt==='number'?turn.completedAt:null,
      error:turnError},
    coverage:{status:'INCOMPLETE',native_identity_authenticated:false,tool_trajectory_complete:false,
      natural_termination_proven:false,host_complete:false,remote_worker_stopped:false,writer_closure_proven:false,
      source_items:items.length,retained_public_items:records.length,dropped_public_items:dropped,
      excluded_reasoning_items:reasoning,unsupported_items:unsupported,
      page:page?{hasMore:page.hasMore===true,nextCursor:typeof page.nextCursor==='string'?page.nextCursor:null}:null,
      incomplete_reasons:[...reasons].sort(),omitted_fields:omitted},
    records
  };
}
export function exportPublicHostObservation(projectRoot:string,requestRef:string){
  const root=projectRootIdentity(projectRoot).root;
  const requestBytes=readProjectFile(root,requestRef);need(requestBytes.length<=16384,'PUBLIC_EXPORT_REQUEST_LIMIT');
  const request=parseUniqueJson(new TextDecoder('utf-8',{fatal:true}).decode(requestBytes));
  exact(request,['format','source','scope','output_dir']);
  need(request.format==='xdev-public-host-export-request-1','PUBLIC_EXPORT_FORMAT');
  exact(request.source,['path','sha256']);checkedScope(request.scope);
  need(typeof request.source.path==='string'&&typeof request.source.sha256==='string'&&
    /^[0-9a-f]{64}$/.test(request.source.sha256)&&typeof request.output_dir==='string','PUBLIC_EXPORT_SOURCE');
  checkedRelativeFile(request.source.path);checkedRelativeFile(request.output_dir);
  const sourceBytes=readProjectFile(root,request.source.path);
  need(sourceBytes.length<=1024*1024&&sha256(sourceBytes)===request.source.sha256,'PUBLIC_EXPORT_SOURCE_DRIFT');
  const source=parseUniqueJson(new TextDecoder('utf-8',{fatal:true}).decode(sourceBytes));
  const selected=selectPublicHostData(source,request.scope);
  const output=join(root,request.output_dir);projectRootIdentity(dirname(output));
  need(resolve(output)===output,'PUBLIC_EXPORT_OUTPUT_PATH');
  const modulePath=fileURLToPath(import.meta.url);
  const packet={...selected,exported_at:new Date().toISOString(),observed_execution_source_version_verified:false,
    collector_module_sha256:sha256(readFileSync(modulePath)),
    source:{path:request.source.path,sha256:request.source.sha256,
      provenance:'COORDINATOR_TRANSFERRED_PUBLIC_API_SELECTION_NOT_NATIVE_TRANSCRIPT',
      source_version_binding:'UNPROVEN; task_version identifies this export task, not the observed Host execution'}};
  const body=JSON.stringify(packet,null,2)+'\n',packetRef=request.output_dir+'/observation.json';
  const memory=JSON.stringify({format:'xdev-host-observation-memory-1',task_ref:request.scope.task_ref,
    task_version:request.scope.task_version,thread_id:request.scope.thread_id,turn_id:request.scope.turn_id,
    artifact:{path:packetRef,sha256:sha256(body)},source:packet.source,
    epistemic_state:'ASSERTED',execution_verified:false,native_evidence_accepted:false,
    binding_claim:packet.binding_claim,observed_execution_source_version_verified:false,
    coverage:'INCOMPLETE',retained_public_items:packet.coverage.retained_public_items,
    dropped_public_items:packet.coverage.dropped_public_items,incomplete_reasons:packet.coverage.incomplete_reasons,
    meaning:'Selected public observations and evidence references only; not authenticated native execution or D1 acceptance.'});
  const sourceRef=request.output_dir+'/memory-source.txt';
  const capture={project_root:root,input:{excerpt:memory,kind:'Observation',mandatory:false,
    memory_key:'host-observation-'+sha256(JSON.stringify(request.scope)+request.source.sha256).slice(0,24),
    previous_revision_id:null,roles:['developer'],source_path:sourceRef,task_ref:request.scope.task_ref,
    task_version:request.scope.task_version,workspace_id:request.scope.workspace_id}};
  // Recheck selected input immediately before creating a fresh output. Never overwrite an old capture.
  need(sha256(readProjectFile(root,request.source.path))===request.source.sha256,'PUBLIC_EXPORT_SOURCE_DRIFT');
  mkdirSync(output);
  writeFileSync(join(output,'observation.json'),body,{flag:'wx'});
  writeFileSync(join(output,'memory-source.txt'),memory+'\n',{flag:'wx'});
  writeFileSync(join(output,'memory-capture-request.json'),JSON.stringify(capture,null,2)+'\n',{flag:'wx'});
  return {format:'xdev-public-host-export-result-1',artifact:{path:packetRef,sha256:sha256(body)},
    memory_capture_request:request.output_dir+'/memory-capture-request.json',
    xmem_written:false,native_evidence_accepted:false,D1:false,coverage:packet.coverage};
}

