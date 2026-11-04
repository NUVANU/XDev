import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { bytes, hash, loadConfig, need } from './configure.ts';
import { capacityActual } from './capacity.ts';
import type { FileRef } from './configure.ts';
import type { inspectSupervisedWriterCapability } from '../src/host-surface/supervised-writer-lock.ts';

export type PreflightOptions = {expected?:Record<string,string>;request?:FileRef;record?:FileRef};
export const bindingFields=['project_root','project_id','control_root','input_root','server_path','server_sha256','node_path','node_sha256','node_version','config_sha256'] as const;
type Check={field:string;status:'CHECKED'|'MISMATCH'|'INVALID'|'UNSUPPORTED';code?:string;expected?:string;actual?:string;required?:boolean};
/** Reports observed bytes and delegated existing adapter checks. Never opens a
 * writable Store, writes a claim, changes configuration or infers a project. */
export function inspectPreflight(local:ReturnType<typeof loadConfig>,options:PreflightOptions,inspect:(kind:'request'|'record',ref:FileRef)=>unknown,capabilities:{runtimeSupported:boolean;qaNodeVersions:readonly string[];maxSyncQaMs:number;finalWriter?:ReturnType<typeof inspectSupervisedWriterCapability>;finalWriterRequired?:boolean}) {
  const c=local.config,server=fileURLToPath(new URL('./server.ts',import.meta.url));
  const actual:Record<string,string>={project_root:c.project_root,project_id:c.project_id,control_root:c.control_root,input_root:c.input_root,server_path:server,server_sha256:hash(bytes(server)),node_path:process.execPath,node_sha256:hash(bytes(process.execPath,256*1024*1024)),node_version:process.versions.node,config_sha256:local.configHash};
  const checks:Check[]=[{field:'binding.config',status:'CHECKED'}];
  need(options&&typeof options==='object'&&!Array.isArray(options),'MCP_PREFLIGHT_OPTIONS_INVALID');
  for(const key of Object.keys(options))need(['expected','request','record'].includes(key),'MCP_PREFLIGHT_UNKNOWN_FIELD:'+key);
  if(options.expected!==undefined) {
    need(options.expected&&typeof options.expected==='object'&&!Array.isArray(options.expected),'MCP_PREFLIGHT_EXPECTED_INVALID');
    for(const [field,value] of Object.entries(options.expected)){
      need((bindingFields as readonly string[]).includes(field),'MCP_PREFLIGHT_UNKNOWN_EXPECTED_FIELD:'+field);
      need(typeof value==='string','MCP_PREFLIGHT_EXPECTED_STRING_REQUIRED:'+field);
      checks.push({field:'binding.'+field,status:actual[field]===value?'CHECKED':'MISMATCH',expected:value,actual:actual[field]});
    }
  }
  checks.push({field:'capability.qa_runtime',status:capabilities.runtimeSupported?'CHECKED':'UNSUPPORTED',actual:process.versions.node});
  const artifacts:Record<string,unknown>={};
  // Do not read task artifacts when the caller's explicit binding is wrong.
  if(!checks.some(c=>c.status==='MISMATCH'))for(const kind of ['request','record'] as const)if(options[kind]!==undefined){
    try {artifacts[kind]=inspect(kind,options[kind]!);checks.push({field:kind,status:'CHECKED'});}
    catch(e){const code=e instanceof Error?e.message:String(e),detail=capacityActual(e,code);checks.push({field:kind,status:code.includes('UNSUPPORTED')?'UNSUPPORTED':'INVALID',code,...(detail===undefined?{}:{actual:detail})});}
  }
  if(capabilities.finalWriter)checks.push({field:'capability.final_writer',status:capabilities.finalWriter.status==='SUPPORTED'?'CHECKED':'UNSUPPORTED',required:capabilities.finalWriterRequired!==false,...('code'in capabilities.finalWriter?{code:capabilities.finalWriter.code}:{})});
  return {format:'xdev-preflight-1',status:checks.some(c=>c.status==='MISMATCH'||c.status==='INVALID')?'REFUSED':checks.some(c=>c.status==='UNSUPPORTED'&&c.required!==false)?'UNSUPPORTED':'CHECKED',binding:actual,checks,artifacts,
    requested_checks:{expected_fields:Object.keys(options.expected??{}),request:options.request!==undefined,record:options.record!==undefined},writer_capability:{...(capabilities.finalWriter??{status:'NOT_EVALUATED',read_only:true}),required_for_selected_artifacts:capabilities.finalWriterRequired!==false},
    permissions:{stage_inputs:false,write_jobs:false,execute_qa:false,...c.permissions},enabled_permission_count:Object.values(c.permissions??{}).filter(v=>v===true).length,approved_request_count:(c.approved_requests??[]).length,
    capabilities:{request_versions:['xdev-supervised-request-3','xdev-supervised-request-4'],memory_boundary:'EXPLICIT_REQUEST4_PHYSICAL_CLOSED_V1_ONLY',record_versions:['xdev-supervised-record-1'],public_session_versions:['xdev-supervised-public-session-1','xdev-supervised-public-session-2'],qa_node_versions:capabilities.qaNodeVersions,qa_max_frozen_commands:1,max_sync_qa_timeout_ms:capabilities.maxSyncQaMs},
    unsupported:['NATIVE_IDENTITY_AUTHENTICATION','AUTOMATIC_ROLE_DISPATCH','HOST_ACCEPTANCE','GENERAL_SHELL','QA_MORE_THAN_ONE_FROZEN_COMMAND'],
    real_review:'NOT_EVALUATED',actual_qa:'NOT_RUN',native_identity_authenticated:false,current_job_executability:'NOT_EVALUATED',execution_allowed:false,delivery_allowed:false,claim_consumed:false};
}

// Same adapter and readers as the MCP tool, with no transport or server start.
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  // Finish this module's evaluation before tools imports its shared reporter;
  // awaiting that reverse import at module level would create an ESM cycle.
  void (async()=>{
  try {
    const args=process.argv.slice(2);need(args.length===2||args.length===4,'Usage: preflight.ts --config ABS [--input ABS_OPTIONS_JSON]');
    need(args[0]==='--config'&&(args.length===2||args[2]==='--input'),'MCP_PREFLIGHT_USAGE');
    const local=loadConfig(args[1]!);
    const {parseD1UniqueJson}=await import('../src/job-runtime/contracts.ts');
    const options=args.length===4?parseD1UniqueJson(bytes(args[3]!,16384).toString('utf8')) as PreflightOptions:{};
    const {preflightXdev}=await import('./tools.ts');const result=preflightXdev(local,options);
    process.stdout.write(JSON.stringify(result)+'\n');if(result.status!=='CHECKED')process.exitCode=1;
  }catch(e){process.stdout.write(JSON.stringify({format:'xdev-preflight-1',status:'REFUSED',code:e instanceof Error?e.message:String(e),execution_allowed:false,delivery_allowed:false,claim_consumed:false})+'\n');process.exitCode=1;}
  })();
}
