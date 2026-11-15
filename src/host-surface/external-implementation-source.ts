import { isAbsolute, resolve, sep } from 'node:path';
import { canonical } from '../job-runtime/store.ts';
import { parseD1UniqueJson } from '../job-runtime/contracts.ts';

type FileRef = { path:string; sha256:string };
type Member = { path:string; sha256:string };
type Reader = (ref:FileRef)=>string;
export const externalImplementationFormat='xdev-external-implementation-source-1';
export const externalImplementationProvenance='COORDINATOR_RECORDED_EXTERNAL_ARTIFACT';
export type ExternalImplementationSource={format:typeof externalImplementationFormat;role:'implementation';session_ref:string;
  source_claim:typeof externalImplementationProvenance;native_authenticated:false;adoption:FileRef};
type Policy={format:'xdev-implementation-source-policy-1';allow_external_artifact_adoption:true;author_input_manifest:FileRef};
type PolicyData={policy:Policy;initial:Member[]};
export type ExternalBinding={requestFormat:string;spec:FileRef;jobId:string;taskId:string;baseline:Member[];
  baselineSha:string;candidate:Member[];candidateSha:string;projectRoot:string;controlRoot:string};
export type ExternalDependencies={readRef:Reader;manifest:(root:string)=>Member[]};
function need(v:unknown,why:string):asserts v {if(!v)throw Error('SUPERVISED_EXTERNAL_SOURCE_'+why);}
function exact(v:any,keys:string[]){need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),'SCHEMA_INVALID');}
const word=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<8192;
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const relativePath=(v:unknown):v is string=>word(v)&&!isAbsolute(v)&&!v.includes('\\')&&!v.includes(':')&&!v.split('/').some(p=>!p||p==='.'||p==='..');
function refShape(ref:any){exact(ref,['path','sha256']);need(word(ref.path)&&hex(ref.sha256),'REF_INVALID');}
function members(ref:FileRef,read:Reader):Member[]{
  refShape(ref);const rows=parseD1UniqueJson(read(ref)) as any;
  need(Array.isArray(rows)&&rows.length<=4096,'MANIFEST_INVALID');
  const seen=new Set<string>();
  for(const row of rows){exact(row,['path','sha256']);need(relativePath(row.path)&&hex(row.sha256)&&!seen.has(row.path),'MANIFEST_INVALID');seen.add(row.path);}
  return rows;
}
function memberMap(rows:Member[]){return new Map(rows.map(m=>[m.path,m.sha256]));}
function sameMembers(a:Member[],b:Member[]){const map=memberMap(a);return a.length===b.length&&b.every(m=>map.get(m.path)===m.sha256);}
function changes(before:Member[],after:Member[]){const a=memberMap(before),b=memberMap(after);return [...new Set([...a.keys(),...b.keys()])].filter(p=>a.get(p)!==b.get(p)).sort();}
export function isExternalImplementation(value:any):value is ExternalImplementationSource{return value?.format===externalImplementationFormat;}
export function externalSourceShape(source:ExternalImplementationSource){
  exact(source,['format','role','session_ref','source_claim','native_authenticated','adoption']);
  need(source.format===externalImplementationFormat&&source.role==='implementation'&&word(source.session_ref)&&source.source_claim===externalImplementationProvenance&&source.native_authenticated===false,'INVALID');
  refShape(source.adoption);
}
/** Reads only the explicit frozen opt-in. No defaults are added to persisted entries. */
export function externalPolicy(spec:any,requestFormat:string|null,read:Reader):PolicyData|null{
  if(!spec||typeof spec!=='object'||!Object.hasOwn(spec,'implementation_source_policy'))return null;
  need(requestFormat===null||requestFormat==='xdev-supervised-request-5','REQUEST_UNSUPPORTED');
  const p=spec.implementation_source_policy;
  exact(p,['format','allow_external_artifact_adoption','author_input_manifest']);
  need(p.format==='xdev-implementation-source-policy-1'&&p.allow_external_artifact_adoption===true,'POLICY_INVALID');
  return {policy:p,initial:members(p.author_input_manifest,read)};
}
export function externalInputSubset(policy:PolicyData|null,baseline:Member[]){
  if(!policy)return;const allowed=memberMap(baseline);
  need(policy.initial.every(m=>allowed.get(m.path)===m.sha256),'INPUT_BASELINE_MISMATCH');
}
function overlaps(a:string,b:string){
  const norm=(p:string)=>process.platform==='win32'?p.toLowerCase():p;
  const x=norm(a),y=norm(b);return x===y||x.startsWith(y+sep)||y.startsWith(x+sep);
}
/** The result is a coordinator assertion bound to bytes, never native actor authentication. */
export function verifyExternalImplementation(source:ExternalImplementationSource,b:ExternalBinding,deps:ExternalDependencies){
  externalSourceShape(source);
  const spec=parseD1UniqueJson(deps.readRef(b.spec));
  const admitted=externalPolicy(spec,b.requestFormat,deps.readRef);need(admitted,'POLICY_REQUIRED');externalInputSubset(admitted,b.baseline);
  const a=parseD1UniqueJson(deps.readRef(source.adoption)) as any;
  exact(a,['format','job_id','task_id','spec_sha256','baseline_manifest_sha256','candidate_manifest_sha256','known_author_refs','adopting_host_ref','source_host',
    'completion_state','all_known_writers_ended','unknown_relevant_writers','public_evidence','artifact_root','author_input_manifest','artifact_manifest','transfers']);
  need(a.format==='xdev-external-artifact-adoption-1'&&a.job_id===b.jobId&&a.task_id===b.taskId&&a.spec_sha256===b.spec.sha256&&
    a.baseline_manifest_sha256===b.baselineSha&&a.candidate_manifest_sha256===b.candidateSha,'BINDING_MISMATCH');
  need(word(a.adopting_host_ref)&&a.adopting_host_ref===source.session_ref,'HOST_MISMATCH');
  need(Array.isArray(a.known_author_refs)&&a.known_author_refs.length>=2&&a.known_author_refs.length<=16&&a.known_author_refs.every(word)&&
    new Set(a.known_author_refs).size===a.known_author_refs.length&&a.known_author_refs.includes(a.adopting_host_ref),'AUTHORS_REQUIRED');
  exact(a.source_host,['name','version','model_label']);need(Object.values(a.source_host).every(word),'HOST_LABEL_INVALID');
  need(a.completion_state==='COMPLETED'&&a.all_known_writers_ended===true&&a.unknown_relevant_writers===false,'COMPLETION_UNPROVEN');
  need(Array.isArray(a.public_evidence)&&a.public_evidence.length>=1&&a.public_evidence.length<=8,'PUBLIC_EVIDENCE_REQUIRED');
  const seen=new Set<string>();for(const ref of a.public_evidence){refShape(ref);const key=canonical(ref);need(!seen.has(key),'PUBLIC_EVIDENCE_DUPLICATE');seen.add(key);deps.readRef(ref);}
  need(canonical(a.author_input_manifest)===canonical(admitted.policy.author_input_manifest),'INPUT_REF_MISMATCH');
  need(word(a.artifact_root)&&isAbsolute(a.artifact_root)&&resolve(a.artifact_root)===a.artifact_root&&!overlaps(a.artifact_root,b.projectRoot)&&!overlaps(a.artifact_root,b.controlRoot),'ARTIFACT_ROOT_INVALID');
  const final=members(a.artifact_manifest,deps.readRef),observed=deps.manifest(a.artifact_root);
  need(sameMembers(final,observed),'ARTIFACT_DRIFT');
  const initial=memberMap(admitted.initial),origin=memberMap(final),before=memberMap(b.baseline),target=memberMap(b.candidate);
  need([...initial.keys()].every(p=>origin.has(p))&&[...before.keys()].every(p=>target.has(p)),'DELETION_UNSUPPORTED');
  const sourceDelta=changes(admitted.initial,final),candidateDelta=changes(b.baseline,b.candidate);
  need(Array.isArray(a.transfers)&&a.transfers.length<=4096,'TRANSFERS_INVALID');
  const transferred=new Set<string>();
  for(const m of a.transfers){exact(m,['source_path','target_path','sha256']);
    need(relativePath(m.source_path)&&m.source_path===m.target_path&&hex(m.sha256)&&!transferred.has(m.target_path),'TRANSFER_INVALID');transferred.add(m.target_path);
    need(origin.get(m.source_path)===m.sha256&&target.get(m.target_path)===m.sha256,'TRANSFER_DRIFT');
  }
  const mapped=[...transferred].sort();need(canonical(mapped)===canonical(sourceDelta)&&canonical(mapped)===canonical(candidateDelta),'DELTA_MISMATCH');
  return {kind:'EXTERNAL_ARTIFACT' as const,authors:a.known_author_refs as string[],provenance:externalImplementationProvenance};
}
