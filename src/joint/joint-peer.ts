import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { JointConfig } from './joint-util.ts';
import { AUTHENTICATION, digest, need, parseJson, PROTOCOL, SCHEMA_SHA256, schema } from './joint-util.ts';

export function callXMem(config:JointConfig,operation:string,input:unknown):any{
  const validator=schema(config),cap={protocol:PROTOCOL,schema_sha256:SCHEMA_SHA256,operation:'capabilities',input:{}};
  const send=(request:unknown)=>{
    const run=spawnSync(config.peer.node_path,[config.peer.cli_path,config.peer.config_path],{
      input:JSON.stringify(request)+'\n',encoding:'utf8',timeout:15000,maxBuffer:256*1024,windowsHide:true});
    need(!run.error&&run.status===0&&typeof run.stdout==='string'&&Buffer.byteLength(run.stdout,'utf8')<=131072,
      'PEER_UNAVAILABLE');
    const out=parseJson(run.stdout);need(typeof out.ok==='boolean'&&Object.keys(out).sort().join('|')===(out.ok?'ok|value':'error|ok'),
      'PEER_UNAVAILABLE');
    if(!out.ok){need(validator.values.get('capabilities')!==undefined,'PEER_UNAVAILABLE');
      throw Error(out.error?.code??'PEER_UNAVAILABLE');}
    return out.value;
  };
  const capability=send(cap);
  need(validator.values.get('capabilities')?.(capability)&&capability.implementation==='XMEM'&&
    capability.build_sha256===config.peer.build_sha256&&capability.domain_id===config.peer.domain_id&&
    capability.schema_sha256===SCHEMA_SHA256&&capability.authentication===AUTHENTICATION&&
    capability.worker_impersonation_resistance==='NOT_PROVEN'&&capability.managed_issuer_validation===false&&
    capability.host_send===false&&capability.model_execution===false&&capability.supported===true,
    'PEER_BUILD_MISMATCH');
  need(capability.operations.includes(operation),'UNSUPPORTED_CAPABILITY');
  const value=send({protocol:PROTOCOL,schema_sha256:SCHEMA_SHA256,operation,input});
  need(validator.values.get(operation)?.(value),'PEER_UNAVAILABLE');
  return value;
}

export function xdevBuildSha(root:string,paths:string[]):string{
  const sorted=[...paths].map(path=>({path,rel:relative(root,path).replaceAll('\\','/')})).sort((a,b)=>a.rel.localeCompare(b.rel));
  return digest(sorted.map(({path,rel})=>`${rel}\0${digest(readFileSync(path))}\n`).join(''));
}
