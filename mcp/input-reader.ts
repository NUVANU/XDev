/** The existing MCP input capability reader, shared before any Core task reader.
 * Only TaskContract/input graphs are traversed; memory text and deployment are not. */
import { isAbsolute, join } from 'node:path';
import { productionJobRoot } from '../src/job-runtime/store.ts';
import { parseD1UniqueJson } from '../src/job-runtime/contracts.ts';
import { parsePreparationJson, supervisedPreparationFormat } from '../src/host-surface/supervised-preparation.ts';
import { bytes, exact, hash, need, noLinks, refShape, within } from './configure.ts';
import type { FileRef, LocalConfig } from './configure.ts';
import { validateBoundary, boundaryWithin } from '../src/host-surface/project-memory-boundary.ts';
import { externalPolicy } from '../src/host-surface/external-implementation-source.ts';

const preparationMaterial = new Set(['original_intent', 'minimal_design', 'confirmation_source']);

function parseArtifact(text: string): any {
  if (text.startsWith('\uFEFF')) {
    const preparation = parsePreparationJson(text) as any;
    if (typeof preparation?.format === 'string' && /^xdev-supervised-preparation-\d+$/.test(preparation.format)) return preparation;
  }
  return parseD1UniqueJson(text);
}

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
    // These slots contain protocol data, not a graph of executable FileRefs.
    // Keep semantic keys separate: an opaque read must never suppress a later
    // ordinary graph read of the same path/hash (or vice versa).
    const material=(ref:FileRef,kind:string,consume:(text:string)=>void)=>{
      refShape(ref);const key=kind+ref.path+'#'+ref.sha256;if(seen.has(key))return;
      need(seen.size<512,'MCP_REFERENCE_GRAPH_TOO_LARGE');seen.add(key);consume(read(ref));
    };
    const members=(ref:FileRef)=>material(ref,'external-members:',text=>{
      // Reuse the Core's exact relative-member shape/path/hash/count rules.
      externalPolicy({implementation_source_policy:{format:'xdev-implementation-source-policy-1',allow_external_artifact_adoption:true,author_input_manifest:ref}},'xdev-supervised-request-5',()=>text);
    });
    if(value.format==='xdev-implementation-source-policy-1'){
      exact(value,['format','allow_external_artifact_adoption','author_input_manifest']);
      need(value.allow_external_artifact_adoption===true,'MCP_EXTERNAL_SOURCE_POLICY_INVALID');members(value.author_input_manifest);return;
    }
    if(value.format==='xdev-external-artifact-adoption-1'){
      exact(value,['format','job_id','task_id','spec_sha256','baseline_manifest_sha256','candidate_manifest_sha256','known_author_refs','adopting_host_ref','source_host',
        'completion_state','all_known_writers_ended','unknown_relevant_writers','public_evidence','artifact_root','author_input_manifest','artifact_manifest','transfers']);
      noLinks(value.artifact_root);need(within(c.input_root,value.artifact_root),'MCP_EXTERNAL_ARTIFACT_OUTSIDE_INPUT_ROOT');
      members(value.author_input_manifest);members(value.artifact_manifest);
      need(Array.isArray(value.public_evidence)&&value.public_evidence.length>=1&&value.public_evidence.length<=8,'MCP_EXTERNAL_PUBLIC_EVIDENCE_INVALID');
      for(const ref of value.public_evidence)material(ref,'external-public:',()=>{});
      for(const [key,item] of Object.entries(value))if(!['author_input_manifest','artifact_manifest','public_evidence'].includes(key))graph(item,internal,seen,depth+1);
      return;
    }
    if('path' in value&&'sha256' in value){
      if(internal&&!isAbsolute(value.path))return; // Core project manifest member.
      refShape(value);const key=value.path+'#'+value.sha256;if(seen.has(key))return;need(seen.size<512,'MCP_REFERENCE_GRAPH_TOO_LARGE');seen.add(key);
      const text=read(value,internal);if(text.trimStart().startsWith('{')||text.trimStart().startsWith('[')){const parsed=parseArtifact(text);if(parsed?.format==='xdev-project-memory-boundary-1'){need(boundaryWithin(c.input_root,parsed.deployment?.path),'MCP_BOUNDARY_DEPLOYMENT_OUTSIDE_INPUT');validateBoundary(value,{projectRoot:c.project_root,projectId:c.project_id,controlRoot:c.control_root});}else graph(parsed,internal,seen,depth+1);}return;
    }
    if('source_ref' in value||'source_sha256' in value){need(typeof value.source_ref==='string'&&typeof value.source_sha256==='string','MCP_SOURCE_REF_INVALID');graph({path:value.source_ref,sha256:value.source_sha256},internal,seen,depth+1);}
    if('id' in value&&'sha256' in value&&isAbsolute(value.id)){const key=value.id+'#'+value.sha256;if(seen.has(key))return;need(seen.size<512,'MCP_REFERENCE_GRAPH_TOO_LARGE');seen.add(key);graph(readEvidence(value),true,seen,depth+1);return;}
    const preparation = value.format === supervisedPreparationFormat ||
      (internal && value.format === 'xdev-supervised-preparation-result-1');
    for(const [key,item] of Object.entries(value)) {
      if (preparation && preparationMaterial.has(key)) {
        if (item === null) continue;
        // Core interprets these slots on admission. The persisted projection
        // holds the same references, so reopen checks the same input bytes.
        refShape(item);
        const materialKey = 'preparation-material:' + item.path + '#' + item.sha256;
        if (seen.has(materialKey)) continue;
        need(seen.size < 512, 'MCP_REFERENCE_GRAPH_TOO_LARGE');
        seen.add(materialKey);
        read(item);
      } else graph(item,internal,seen,depth+1);
    }
  };
  const source=(ref:FileRef)=>{const text=read(ref);const value=parseArtifact(text);graph(value);return value;};
  return {read,readEvidence,graph,source};
}
