/** The existing MCP input capability reader, shared before any Core task reader.
 * Only TaskContract/input graphs are traversed; memory text and deployment are not. */
import { isAbsolute, join } from 'node:path';
import { productionJobRoot } from '../src/job-runtime/store.ts';
import { parseD1UniqueJson } from '../src/job-runtime/contracts.ts';
import { bytes, exact, hash, need, noLinks, refShape, within } from './configure.ts';
import type { FileRef, LocalConfig } from './configure.ts';
import { validateBoundary, boundaryWithin } from '../src/host-surface/project-memory-boundary.ts';

export function createInputReader(c:LocalConfig){
  const storeRoot=productionJobRoot(c.control_root,c.project_id);
  const read=(ref:FileRef,internal=false)=>{
    refShape(ref);noLinks(ref.path);
    const claim=internal&&ref.path===join(c.control_root,'supervised-start-consumed',ref.path.split(/[\\/]/).at(-1)! )&&/^[a-f0-9]{64}\.json$/.test(ref.path.split(/[\\/]/).at(-1)!);
    need(within(c.input_root,ref.path)||claim,'MCP_REFERENCE_OUTSIDE_INPUT_ROOT');
    const b=bytes(ref.path);need(hash(b)===ref.sha256,'MCP_INPUT_DRIFT');return b.toString('utf8');
  };
  const readEvidence=(ref:any)=>{exact(ref,['id','sha256']);need(typeof ref.sha256==='string'&&/^[a-f0-9]{64}$/.test(ref.sha256)&&ref.id===join(storeRoot,'evidence',ref.sha256+'.json'),'MCP_EVIDENCE_OUTSIDE_STORE');const b=bytes(ref.id);need(hash(b)===ref.sha256,'MCP_EVIDENCE_DRIFT');return parseD1UniqueJson(b.toString('utf8'));};
  // Traverse every reference reachable from an artifact BEFORE any core reader.
  // Public payload text is not interpreted as instructions or scanned for paths.
  const graph=(value:any,internal=false,seen=new Set<string>(),depth=0):void=>{
    need(depth<=64&&seen.size<=512,'MCP_REFERENCE_GRAPH_TOO_LARGE');if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){for(const item of value)graph(item,internal,seen,depth+1);return;}
    if('path' in value&&'sha256' in value){
      if(internal&&!isAbsolute(value.path))return; // Core project manifest member.
      refShape(value);const key=value.path+'#'+value.sha256;if(seen.has(key))return;need(seen.size<512,'MCP_REFERENCE_GRAPH_TOO_LARGE');seen.add(key);
      const text=read(value,internal);if(text.trimStart().startsWith('{')||text.trimStart().startsWith('[')){const parsed=parseD1UniqueJson(text) as any;if(parsed?.format==='xdev-project-memory-boundary-1'){need(boundaryWithin(c.input_root,parsed.deployment?.path),'MCP_BOUNDARY_DEPLOYMENT_OUTSIDE_INPUT');validateBoundary(value,{projectRoot:c.project_root,projectId:c.project_id,controlRoot:c.control_root});}else graph(parsed,internal,seen,depth+1);}return;
    }
    if('source_ref' in value||'source_sha256' in value){need(typeof value.source_ref==='string'&&typeof value.source_sha256==='string','MCP_SOURCE_REF_INVALID');graph({path:value.source_ref,sha256:value.source_sha256},internal,seen,depth+1);}
    if('id' in value&&'sha256' in value&&isAbsolute(value.id)){const key=value.id+'#'+value.sha256;if(seen.has(key))return;need(seen.size<512,'MCP_REFERENCE_GRAPH_TOO_LARGE');seen.add(key);graph(readEvidence(value),true,seen,depth+1);return;}
    for(const item of Object.values(value))graph(item,internal,seen,depth+1);
  };
  const source=(ref:FileRef)=>{const text=read(ref);const value=parseD1UniqueJson(text);graph(value);return value as any;};
  return {read,readEvidence,graph,source};
}
