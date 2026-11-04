import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { d1Canonical, parseD1UniqueJson, validateD1ContextRefreshReceipt,
  type D1ContextBinding, type D1ContextRefreshReceipt } from '../job-runtime/contracts.ts';

const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
function need(value:unknown,code:string):asserts value {if(!value)throw Error(code);}
function exact(value:unknown,keys:string[],code:string):asserts value is Record<string,any>{
  need(value!==null&&typeof value==='object'&&!Array.isArray(value)&&
    Object.keys(value).sort().join('|')===[...keys].sort().join('|'),code);
}
function inside(root:string,path:string){const rel=relative(root,path);return rel===''||
  (!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep));}
function readSource(path:string,root:string,limit:number,code:string):Buffer{
  need(isAbsolute(path)&&resolve(path)===path&&inside(root,path)&&existsSync(root),code);
  const rel=relative(root,path);let current=root;
  for(const part of ['',...rel.split(sep).filter(Boolean)]){
    if(part)current=join(current,part);
    need(existsSync(current)&&!lstatSync(current).isSymbolicLink(),code);
  }
  const stat=lstatSync(path);need(stat.isFile()&&stat.nlink===1&&stat.size<=limit,code);
  return readFileSync(path);
}
function parse(bytes:Buffer,code:string):any{
  let value:unknown;
  try{value=parseD1UniqueJson(new TextDecoder('utf8',{fatal:true}).decode(bytes));}
  catch{throw Error(code);}
  need(value!==null&&typeof value==='object'&&!Array.isArray(value),code);
  return value;
}
function currentSources(binding:D1ContextBinding,workspaceRoot:string){
  const root=binding.xmem_project_root;
  need(isAbsolute(root)&&resolve(root)===root&&inside(root,workspaceRoot)&&root!==workspaceRoot,
    'D1_CONTEXT_REFRESH_PROJECT_DRIFT');
  const config=parse(readSource(join(root,'.xmem','config.json'),root,8192,'D1_CONTEXT_REFRESH_PROJECT_DRIFT'),
    'D1_CONTEXT_REFRESH_PROJECT_DRIFT');
  const policy=parse(readSource(join(root,'.xmem','standalone-v1.json'),root,8192,'D1_CONTEXT_REFRESH_PROJECT_DRIFT'),
    'D1_CONTEXT_REFRESH_PROJECT_DRIFT');
  need(config.project_id===binding.xmem_project_id&&resolve(config.root)===root&&
    policy.workspace_id===binding.xmem_workspace_id&&
    Array.isArray(policy.allowed_roles)&&policy.allowed_roles.includes(binding.current_task.role),
    'D1_CONTEXT_REFRESH_PROJECT_DRIFT');
  need(binding.context_policy_path==='xmem-context.json'&&
    sha(readSource(join(workspaceRoot,binding.context_policy_path),workspaceRoot,8192,
      'D1_CONTEXT_REFRESH_POLICY_DRIFT'))===binding.context_policy_sha256,
    'D1_CONTEXT_REFRESH_POLICY_DRIFT');
  for(const source of binding.authority_files){
    need(!inside(workspaceRoot,source.path)&&
      sha(readSource(source.path,root,1024*1024,'D1_CONTEXT_REFRESH_AUTHORITY_DRIFT'))===source.sha256,
      'D1_CONTEXT_REFRESH_AUTHORITY_DRIFT');
  }
}

/** Reads a coordinator-transferred expansion under the control root. Its Host
 * locator and time are assertions until an independent Host log check. */
export function readD1ContextRefresh(path:string,controlRoot:string,workspaceRoot:string,
  binding:D1ContextBinding,phase:'PREPARE'|'SEND',eventAt:string):D1ContextRefreshReceipt{
  currentSources(binding,workspaceRoot);
  const bytes=readSource(path,controlRoot,32*1024,'D1_CONTEXT_REFRESH_SOURCE_INVALID');
  const input=parse(bytes,'D1_CONTEXT_REFRESH_SOURCE_INVALID');
  exact(input,['format','phase','binding_sha256','host_session_ref','host_call_id','host_call_at',
    'mcp_request','mcp_result'],'D1_CONTEXT_REFRESH_SOURCE_INVALID');
  need(input.format==='xdev-d1-context-refresh-input-1'&&input.phase===phase&&
    input.binding_sha256===sha(d1Canonical(binding))&&
    typeof input.host_session_ref==='string'&&typeof input.host_call_id==='string',
    'D1_CONTEXT_REFRESH_SOURCE_INVALID');
  const receipt:D1ContextRefreshReceipt={format:'xdev-d1-xmem-refresh-1',phase,
    binding_sha256:input.binding_sha256,file_path:path,file_sha256:sha(bytes),
    host_session_ref:input.host_session_ref,host_call_id:input.host_call_id,
    host_call_at:input.host_call_at,mcp_request_text:d1Canonical(input.mcp_request),
    mcp_request_sha256:sha(d1Canonical(input.mcp_request)),
    mcp_result_text:d1Canonical(input.mcp_result),
    mcp_result_sha256:sha(d1Canonical(input.mcp_result)),
    content_sha256:binding.content_sha256,
    source_claim:'COORDINATOR_TRANSFERRED_XMEM_RESPONSE',xmem_receipt_authenticated:false};
  validateD1ContextRefreshReceipt(receipt,binding,phase,eventAt);
  return receipt;
}
export function verifyD1ContextRefreshSource(receipt:D1ContextRefreshReceipt,controlRoot:string,
  workspaceRoot:string,binding:D1ContextBinding,phase:'PREPARE'|'SEND',eventAt:string){
  const actual=readD1ContextRefresh(receipt.file_path,controlRoot,workspaceRoot,binding,phase,eventAt);
  need(d1Canonical(actual)===d1Canonical(receipt),'D1_CONTEXT_REFRESH_SOURCE_DRIFT');
}
