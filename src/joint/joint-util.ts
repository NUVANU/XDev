import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonical } from '../job-runtime/store.ts';
import { parseD1UniqueJson } from '../job-runtime/contracts.ts';
import type { Job, Task, CreateCommand } from '../job-runtime/contracts.ts';

export const PROTOCOL='xmem-xdev-trusted-controller/1';
export const PROFILE='TRUSTED_CONTROLLER_LOCAL';
export const SCHEMA_SHA256='2ecc8ec80f27e316f3c8b80c3848f8a40a77f6e597666f3ed4bc0f4cb0fc05c0';
export const CONTRACT_SHA256='14f43791eafee83678949ad7dffcc0c0ae80a59d8f544500771c155824272d09';
export const AUTHENTICATION='TRUSTED_CALLER_ASSUMPTION_ONLY';
export const NOT_PROVEN='NOT_PROVEN';
export const idPattern=/^[-a-zA-Z0-9_.:]{1,160}$/;
export const shaPattern=/^[a-f0-9]{64}$/;
export const digest=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
export const objectDigest=(v:unknown)=>digest(canonical(v));
export function fail(code:string):never{throw Error(code);}
export function need(value:unknown,code:string):asserts value{if(!value)fail(code);}
export function exact(v:unknown,keys:string[],code='INVALID_REQUEST'):asserts v is Record<string,any>{
  need(v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|'),code);
}
export function plain(path:string,max=1024*1024):Buffer{
  need(isAbsolute(path)&&resolve(path)===path,'SCOPE_MISMATCH');
  for(let current=path;;){const s=lstatSync(current);need(!s.isSymbolicLink(),'SCOPE_MISMATCH');
    const parent=resolve(current,'..');if(parent===current)break;current=parent;}
  const s=lstatSync(path);need(s.isFile()&&s.nlink===1&&s.size<=max&&realpathSync.native(path)===path,'SCOPE_MISMATCH');
  return readFileSync(path);
}
export function inside(parent:string,path:string){const r=relative(parent,path);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));}
export function parseJson(bytes:Buffer|string):any{const s=bytes.toString();let v;try{v=parseD1UniqueJson(s);}catch{fail('INVALID_REQUEST');}need(v&&typeof v==='object'&&!Array.isArray(v),'INVALID_REQUEST');return v;}

export type JointConfig={format:'xdev-joint-controller-config-1';domain_id:string;project_id:string;control_root:string;
  workspace_root:string;budget_path:string;schema_path:string;new_isolated_test_project:boolean;history_source_ref:string;
  profile_files:string[];peer:{node_path:string;cli_path:string;config_path:string;build_sha256:string;domain_id:string}};
export function loadConfig(path:string):JointConfig{
  const v=parseJson(plain(path,65536));exact(v,['format','domain_id','project_id','control_root','workspace_root','budget_path','schema_path',
    'new_isolated_test_project','history_source_ref','profile_files','peer'],'INVALID_REQUEST');
  need(v.format==='xdev-joint-controller-config-1'&&idPattern.test(v.domain_id)&&idPattern.test(v.project_id)&&
    typeof v.history_source_ref==='string'&&v.history_source_ref.length>0&&
    typeof v.new_isolated_test_project==='boolean'&&Array.isArray(v.profile_files)&&v.profile_files.length<=1000,
    'INVALID_REQUEST');
  exact(v.peer,['node_path','cli_path','config_path','build_sha256','domain_id'],'INVALID_REQUEST');
  for(const key of ['control_root','workspace_root','budget_path','schema_path'] as const)need(isAbsolute(v[key])&&resolve(v[key])===v[key],'SCOPE_MISMATCH');
  for(const key of ['node_path','cli_path','config_path'] as const)need(isAbsolute(v.peer[key])&&resolve(v.peer[key])===v.peer[key],'SCOPE_MISMATCH');
  need(shaPattern.test(v.peer.build_sha256)&&idPattern.test(v.peer.domain_id)&&
    !inside(v.workspace_root,v.control_root)&&!inside(v.control_root,v.workspace_root),'SCOPE_MISMATCH');
  need(lstatSync(v.control_root).isDirectory()&&lstatSync(v.workspace_root).isDirectory(),'SCOPE_MISMATCH');
  need(digest(plain(v.schema_path,128*1024))===SCHEMA_SHA256,'SCHEMA_MISMATCH');
  plain(v.budget_path,65536);need(lstatSync(v.peer.node_path).isFile()&&!lstatSync(v.peer.node_path).isSymbolicLink(),'SCOPE_MISMATCH');
  plain(v.peer.cli_path,1024*1024);
  need(v.profile_files.every((x:unknown)=>typeof x==='string'&&safeRel(x))&&new Set(v.profile_files).size===v.profile_files.length,'SCOPE_MISMATCH');
  return v as JointConfig;
}
export function safeRel(path:string):boolean{return path.length>0&&path.length<=4096&&!isAbsolute(path)&&!path.includes('\\')&&
  !path.split('/').some(p=>p===''||p==='.'||p==='..'||p.includes(':'));}
export function readWorkspaceFile(root:string,rel:string):Buffer{
  need(safeRel(rel),'SCOPE_MISMATCH');const path=join(root,...rel.split('/'));
  need(inside(root,path),'SCOPE_MISMATCH');return plain(path,16*1024*1024);
}

function conforms(rule:any,value:any,defs:Record<string,any>):boolean{
  if(rule.$ref){const name=String(rule.$ref).replace('#/$defs/','');return rule.$ref===`#/$defs/${name}`&&
    Object.hasOwn(defs,name)&&conforms(defs[name],value,defs);}
  if(rule.anyOf)return Array.isArray(rule.anyOf)&&rule.anyOf.some((x:any)=>conforms(x,value,defs));
  if('const'in rule&&value!==rule.const)return false;
  if(rule.enum&&!rule.enum.includes(value))return false;
  if(rule.type==='null')return value===null;
  if(rule.type==='integer'&&(!Number.isSafeInteger(value)||('minimum'in rule&&value<rule.minimum)||
    ('maximum'in rule&&value>rule.maximum)))return false;
  if(rule.type==='string'&&(typeof value!=='string'||('minLength'in rule&&value.length<rule.minLength)||
    ('maxLength'in rule&&value.length>rule.maxLength)||(rule.pattern&&!new RegExp(rule.pattern).test(value))))return false;
  if(rule.type==='boolean'&&typeof value!=='boolean')return false;
  if(rule.type==='array'){
    if(!Array.isArray(value)||('minItems'in rule&&value.length<rule.minItems)||
      ('maxItems'in rule&&value.length>rule.maxItems))return false;
    if(rule.items&&!value.every((x:any)=>conforms(rule.items,x,defs)))return false;
  }
  if(rule.type==='object'){
    if(value===null||typeof value!=='object'||Array.isArray(value))return false;
    if(rule.required&&!rule.required.every((k:string)=>Object.hasOwn(value,k)))return false;
    for(const [k,v] of Object.entries(value)){
      if(rule.properties?.[k]){if(!conforms(rule.properties[k],v,defs))return false;}
      else if(rule.additionalProperties===false)return false;
      else if(rule.additionalProperties&&typeof rule.additionalProperties==='object'&&
        !conforms(rule.additionalProperties,v,defs))return false;
    }
  }
  return true;
}
export function schema(config:JointConfig){const raw=parseJson(plain(config.schema_path,128*1024)),defs=raw.$defs as Record<string,any>;
  const validate=(v:unknown)=>Array.isArray(raw.oneOf)&&raw.oneOf.some((x:any)=>conforms(x,v,defs));
  const budget=(v:unknown)=>conforms(defs.budget_authority,v,defs);
  const values=new Map<string,(v:unknown)=>boolean>();
  for(const [op,def] of Object.entries(raw['x-response-definitions'] as Record<string,string>))
    values.set(op,(v:unknown)=>conforms(defs[def],v,defs));
  return {raw,validate,budget,values};}

export function readBudget(config:JointConfig,expectedSha:string,validate:(v:unknown)=>boolean,now=Date.now()){
  const seen=new Set<string>();let child:any=null,leaf:any=null,ref:{path:string;sha256:string}|null={path:config.budget_path,sha256:expectedSha};
  for(let depth=0;ref;depth++){
    need(depth<8&&!seen.has(ref.path)&&shaPattern.test(ref.sha256),'BUDGET_UNKNOWN_OR_EXHAUSTED');seen.add(ref.path);
    const bytes=plain(ref.path,65536);need(digest(bytes)===ref.sha256,'BUDGET_UNKNOWN_OR_EXHAUSTED');
    const value=parseJson(bytes);need(validate(value),'BUDGET_UNKNOWN_OR_EXHAUSTED');
    need(value.project_id===config.project_id&&value.valid_from_ms<=now&&now<value.expires_at_ms&&
      value.stop===false&&value.host_send===false&&value.model_execution===false&&
      value.holds.every((h:any)=>h.state==='HELD')&&new Set(value.holds.map((h:any)=>h.id)).size===value.holds.length&&
      Number.isSafeInteger(value.consumed_units+value.holds.reduce((sum:number,h:any)=>sum+h.units,0))&&
      value.consumed_units+value.holds.reduce((sum:number,h:any)=>sum+h.units,0)<=value.limit_units,
      'BUDGET_UNKNOWN_OR_EXHAUSTED');
    if(child){need(child.consumed_units>=value.consumed_units&&child.limit_units<=value.limit_units&&
      child.expires_at_ms<=value.expires_at_ms&&value.holds.every((h:any)=>child.holds.some((c:any)=>canonical(c)===canonical(h))),
      'BUDGET_UNKNOWN_OR_EXHAUSTED');}
    if(depth===0)leaf=value;
    child=value;ref=value.parent_source_ref;
    if(!ref&&depth===0)need(config.new_isolated_test_project===true,'BUDGET_UNKNOWN_OR_EXHAUSTED');
  }
  return leaf;
}

export function checkNewProjectHistory(config:JointConfig){
  need(config.new_isolated_test_project,'BUDGET_UNKNOWN_OR_EXHAUSTED');
  need(isAbsolute(config.history_source_ref)&&resolve(config.history_source_ref)===config.history_source_ref&&
    inside(config.control_root,config.history_source_ref),'BUDGET_UNKNOWN_OR_EXHAUSTED');
  const bytes=plain(config.history_source_ref,65536),proof=parseJson(bytes);
  exact(proof,['format','project_id','control_root','workspace_root','control_identity','workspace_identity',
    'created_at_ms','new_isolated_project','external_authorization_known','prior_execution_records','source_ref'],
    'BUDGET_UNKNOWN_OR_EXHAUSTED');
  const cs=statSync(config.control_root),ws=statSync(config.workspace_root);
  need(proof.format==='xdev-joint-isolated-history-receipt-1'&&proof.project_id===config.project_id&&
    proof.control_root===config.control_root&&proof.workspace_root===config.workspace_root&&
    proof.control_identity===`${cs.dev}:${cs.ino}`&&proof.workspace_identity===`${ws.dev}:${ws.ino}`&&
    Number.isSafeInteger(proof.created_at_ms)&&proof.created_at_ms>0&&proof.created_at_ms<=Date.now()&&
    proof.new_isolated_project===true&&proof.external_authorization_known===false&&
    Array.isArray(proof.prior_execution_records)&&proof.prior_execution_records.length===0&&
    typeof proof.source_ref==='string'&&proof.source_ref.length>0,
    'BUDGET_UNKNOWN_OR_EXHAUSTED');
  const entries=readdirSync(config.control_root);
  need(!entries.some(e=>e==='d1-role-domains'||e==='d1-intake-requests'||e==='execution'||e==='legacy'||e==='m2'||
    e.startsWith('d1-role-domain')||e.startsWith('m2-')),
    'BUDGET_UNKNOWN_OR_EXHAUSTED');
  const otherJobs=entries.filter(e=>e.startsWith('recoverable-jobs-'));
  need(otherJobs.length===1&&otherJobs[0]===`recoverable-jobs-${digest(config.project_id)}`,
    'BUDGET_UNKNOWN_OR_EXHAUSTED');
  const jobs=readdirSync(join(config.control_root,otherJobs[0]!)).filter(e=>e.endsWith('.json'));
  need(jobs.length===1,'BUDGET_UNKNOWN_OR_EXHAUSTED');
  return digest(bytes);
}

export function operative(config:JointConfig,job:Job,create:CreateCommand,task:Task){
  const seed=create.input.tasks.find(t=>t.key===task.key);
  need(seed&&seed.contract_ref.sha256===task.contract_ref.sha256&&
    seed.control_refs.budget_ref.sha256===task.control_refs.budget_ref.sha256&&
    create.input.control_refs.budget_ref.sha256===task.control_refs.budget_ref.sha256,
    'AUTHORITY_STALE');
  const rel=`.xdev/tasks/${task.key}.json`,path=join(config.workspace_root,rel);
  const bytes=readWorkspaceFile(config.workspace_root,rel);
  need(digest(bytes)===task.contract_ref.sha256,'AUTHORITY_STALE');
  const value=parseJson(bytes);need(typeof value.schema_version==='string','AUTHORITY_STALE');
  return {ref:{id:task.task_id,version:value.schema_version,sha256:task.contract_ref.sha256,path},bytes};
}

export function currentProfile(config:JointConfig,task:Task){
  const contractRel=`.xdev/tasks/${task.key}.json`,files=[...new Set([...config.profile_files,contractRel])].sort();
  need(files.length<=1000&&files.every(safeRel),'SCOPE_MISMATCH');
  const manifest=files.map(path=>({path,sha256:digest(readWorkspaceFile(config.workspace_root,path))}));
  let head:string|null=null,indexSha:string|null=null;
  if(existsSync(join(config.workspace_root,'.git'))){try{head=execFileSync('git',['-C',config.workspace_root,'rev-parse','HEAD'],{encoding:'utf8',timeout:2000}).trim();}
    catch{fail('AUTHORITY_STALE');}need(/^[a-f0-9]{40,64}$/.test(head),'AUTHORITY_STALE');
    need(task.workspace.base_revision===head,'AUTHORITY_STALE');
    if(task.workspace.observed_head)need(task.workspace.observed_head===head,'AUTHORITY_STALE');
    let indexPath:string;try{indexPath=execFileSync('git',['-C',config.workspace_root,'rev-parse','--path-format=absolute','--git-path','index'],
      {encoding:'utf8',timeout:2000}).trim();}catch{fail('AUTHORITY_STALE');}
    need(isAbsolute(indexPath),'AUTHORITY_STALE');indexPath=resolve(indexPath);
    indexSha=existsSync(indexPath)?digest(plain(indexPath,16*1024*1024)):null;}
  else need(task.workspace.observed_head===null&&
    ['NO_GIT','D1_INIT_NO_EXECUTION_HEAD'].includes(task.workspace.base_revision),'AUTHORITY_STALE');
  const profile={version:1,files,base_commit:head,environment:{node:process.version,protocol:PROTOCOL},
    command:['NO_HOST_SEND'],independent:false};
  const rootStat=statSync(config.workspace_root);
  return {profile,fingerprint:objectDigest({root:config.workspace_root,dev:rootStat.dev,ino:rootStat.ino,
    head,index_sha256:indexSha,manifest})};
}
