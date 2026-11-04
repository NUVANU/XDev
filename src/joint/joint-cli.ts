import { pathToFileURL } from 'node:url';
import { JointController } from './joint-controller.ts';
import { loadConfig, parseJson } from './joint-util.ts';

const codes=new Set(['INVALID_REQUEST','UNSUPPORTED_PROTOCOL','SCHEMA_MISMATCH','UNSUPPORTED_CAPABILITY',
  'PEER_UNAVAILABLE','PEER_BUILD_MISMATCH','SCOPE_MISMATCH','IDEMPOTENCY_CONFLICT','REVISION_CONFLICT',
  'GENERATION_CONFLICT','BINDING_REVOKED','AUTHORITY_STALE','EXPIRED','BUDGET_UNKNOWN_OR_EXHAUSTED',
  'CONTEXT_STALE','CONTEXT_BYTES_MISMATCH','CONTEXT_BUDGET_EXCEEDED','OPERATION_NOT_FOUND',
  'OPERATION_RECONCILIATION_REQUIRED','READ_ONLY','INTERNAL_ERROR']);
const writeOps=new Set(['prepareRun','admitPreparedRun','revokeBinding']);
function responseError(code:string,operationId:string|null,certainty:'NOT_COMMITTED'|'COMMITTED'|'UNKNOWN'='NOT_COMMITTED'){
  const selected=codes.has(code)?code:'INTERNAL_ERROR';return {ok:false,error:{code:selected,certainty,
    retryability:certainty==='NOT_COMMITTED'?'NEVER':'RECONCILE_SAME_OPERATION',operation_id:operationId}};}
export async function run(configPath:string,source:AsyncIterable<Buffer|string>=process.stdin){
  let raw='',request:any=null,controller:JointController|null=null;
  try{
    for await(const part of source){raw+=part.toString();if(Buffer.byteLength(raw,'utf8')>131072)throw Error('INVALID_REQUEST');}
    if(Buffer.byteLength(raw,'utf8')>16384)throw Error('INVALID_REQUEST');
    request=parseJson(raw);
    const config=loadConfig(configPath);controller=new JointController(config);
    return controller.execute(request);
  }catch(e){
    const operationId=typeof request?.input?.operation_id==='string'?request.input.operation_id:null;
    let certainty:'NOT_COMMITTED'|'COMMITTED'|'UNKNOWN'='NOT_COMMITTED';
    if(controller&&writeOps.has(request?.operation)&&typeof request?.input?.request_id==='string'){
      try{const op=controller.store.read().operations.find(x=>x.kind===request.operation&&
        x.request_id===request.input.request_id&&x.operation_id===operationId);
        if(op)certainty='COMMITTED';
        else if((e as Error).message==='OPERATION_RECONCILIATION_REQUIRED')certainty='UNKNOWN';
      }catch{certainty='UNKNOWN';}
    }
    return responseError(e instanceof Error?e.message:'INTERNAL_ERROR',operationId,certainty);
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const out=process.argv.length===3?await run(process.argv[2]!):responseError('INVALID_REQUEST',null);
  process.stdout.write(JSON.stringify(out)+'\n');
}
