/** Read-only adapter for a producer-owned, pinned execution projection.
 * This is NOT a facts publisher, historical interpreter or XMem replacement.
 * Completeness/currentness are upstream claims, never inferred from readable
 * files. Trust in the publisher and its immutable window is a deployment
 * precondition. Digests prove bytes, not authority or writer exclusion.
 */
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';
import {parseUniqueJson,parseRfc3339Timestamp} from '../planning/retry-history.ts';
import {canonicalJson} from '../planning/governance-contracts.ts';
import {validateProjectFacts,type ProjectFacts,type ProjectFactsPort} from './admission.ts';
export const sourceSections=['tasks','resources','charges','reservations','unknowns','stops','authorizations','compatibility','evidence_refs','execution_constraints','legacy'] as const;
export type SourceSection=typeof sourceSections[number];
export type NativeSourceRef={path:string;sha256:string};
export type NativeSourceIndex={format:'xdev-native-source-index-1';project_id:string;revision:string;producer_ref:string;
  issued_at:string;valid_until:string;coverage:'COMPLETE_PROJECT'|'INCOMPLETE';freshness:'CURRENT'|'STALE'|'UNKNOWN';
  sections:Record<SourceSection,NativeSourceRef|null>;support_refs:NativeSourceRef[]};
export type NativeSourcePart={format:'xdev-native-source-part-1';project_id:string;revision:string;section:SourceSection;value:unknown};
export type NativeSourceProvenance={format:'xdev-native-source-provenance-1';index_ref:NativeSourceRef};
export type NativeProjectFacts=ProjectFacts & {native_source:NativeSourceProvenance};
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v:any,k:readonly string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...k].sort().join(',');
function check(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
export const nativeBytesHash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
export const nativeValueHash=(v:unknown)=>nativeBytesHash(canonicalJson(v as any));
/** Ordinary private local files only. No links, devices, or oversized sources.
 * Before/after reads detect observed drift; they do not fence hostile writers.
 */
export function readNativeBoundFile(ref:NativeSourceRef):Buffer{
  check(exact(ref,['path','sha256'])&&text(ref.path)&&sha(ref.sha256),'NATIVE_SOURCE_REFERENCE_INVALID');
  check(isAbsolute(ref.path)&&resolve(ref.path)===ref.path,'NATIVE_SOURCE_PATH_INVALID');
  for(let p=ref.path;;p=dirname(p)){check(!lstatSync(p).isSymbolicLink(),'NATIVE_SOURCE_LINK');if(dirname(p)===p)break;}
  check(realpathSync(ref.path)===ref.path,'NATIVE_SOURCE_PATH_ALIAS');
  const a=lstatSync(ref.path);check(a.isFile()&&a.nlink===1&&a.size<=8*1024*1024,'NATIVE_SOURCE_FILE_UNSAFE');
  const b=readFileSync(ref.path),z=lstatSync(ref.path);
  check(z.isFile()&&!z.isSymbolicLink()&&z.nlink===1&&a.dev===z.dev&&a.ino===z.ino&&a.size===z.size&&a.mtimeMs===z.mtimeMs,'NATIVE_SOURCE_CHANGED');
  check(nativeBytesHash(b)===ref.sha256,'NATIVE_SOURCE_DIGEST_MISMATCH');return b;
}
function parse(ref:NativeSourceRef){return parseUniqueJson(readNativeBoundFile(ref).toString('utf8'));}
/** Reads EVERY index section, never an action/active-task-selected subset. */
export function inspectNativeProjectSource(input:NativeSourceRef,now:number=Date.now()){
  const ref=structuredClone(input),i=parse(ref) as NativeSourceIndex;
  check(exact(i,['format','project_id','revision','producer_ref','issued_at','valid_until','coverage','freshness','sections','support_refs'])&&i.format==='xdev-native-source-index-1','NATIVE_SOURCE_INDEX_INVALID');
  check([i.project_id,i.revision,i.producer_ref].every(text)&&exact(i.sections,sourceSections)&&Array.isArray(i.support_refs)&&i.support_refs.length<=64,'NATIVE_SOURCE_INDEX_INVALID');
  check(['COMPLETE_PROJECT','INCOMPLETE'].includes(i.coverage)&&['CURRENT','STALE','UNKNOWN'].includes(i.freshness),'NATIVE_SOURCE_STATUS_INVALID');
  const issued=parseRfc3339Timestamp(i.issued_at),until=parseRfc3339Timestamp(i.valid_until);
  check(Number.isFinite(now)&&now>=0&&issued!==null&&until!==null&&issued<until,'NATIVE_SOURCE_WINDOW_INVALID');
  check(issued<=now&&now<until,'NATIVE_SOURCE_OUTSIDE_WINDOW');
  const seen=new Set([ref.path]),refs:NativeSourceRef[]=[ref],parts:Partial<Record<SourceSection,unknown>>={},missing:SourceSection[]=[];
  function take(r:NativeSourceRef){check(r&&typeof r.path==='string'&&!seen.has(r.path),'NATIVE_SOURCE_DUPLICATE_FILE');seen.add(r.path);const b=readNativeBoundFile(r);refs.push(r);return b;}
  for(const section of sourceSections){const r=i.sections[section];if(r===null){missing.push(section);continue;}
    const p=parseUniqueJson(take(r).toString('utf8')) as NativeSourcePart;
    check(exact(p,['format','project_id','revision','section','value'])&&p.format==='xdev-native-source-part-1','NATIVE_SOURCE_PART_INVALID');
    check(p.project_id===i.project_id&&p.revision===i.revision&&p.section===section,'NATIVE_SOURCE_PART_BINDING_MISMATCH');parts[section]=p.value;
  }
  for(const r of i.support_refs)take(r);
  for(const r of refs)readNativeBoundFile(r);
  // A readable INCOMPLETE source stays INCOMPLETE. Missing collections are not
  // silently replaced by empty arrays. No inference of historical balances.
  let facts:NativeProjectFacts|null=null;
  if(missing.length===0){
    const {legacy,execution_constraints,evidence_refs,...collections}=parts;
    check(Array.isArray(evidence_refs)&&evidence_refs.every(text)&&new Set(evidence_refs).size===evidence_refs.length,'NATIVE_SOURCE_EVIDENCE_INVALID');
    const f:any={...collections,format:'xdev-execution-source-1',project_id:i.project_id,revision:'native-files:'+ref.sha256,
      coverage:i.coverage,freshness:i.freshness,evidence_refs:[...evidence_refs,...[i.producer_ref,...refs.map(r=>'file-sha256:'+r.sha256)].filter(v=>!evidence_refs.includes(v))],
      native_source:{format:'xdev-native-source-provenance-1',index_ref:ref}};
    if(execution_constraints!==null){
      if(exact(execution_constraints,['execution_contract','control_action_sha256'])&&(execution_constraints as any).execution_contract==='xdev-execution-current-source-1')f.control_action_sha256=(execution_constraints as any).control_action_sha256;
      else {check(exact(execution_constraints,['execution_restriction','control_action_sha256']),'NATIVE_SOURCE_EXECUTION_CONSTRAINTS_INVALID');Object.assign(f,execution_constraints);}
    }
    if(legacy!==null){check(exact(legacy,['legacy_source_sha256','legacy_observed'])&&sha((legacy as any).legacy_source_sha256),'NATIVE_SOURCE_LEGACY_INVALID');Object.assign(f,legacy);}
    validateProjectFacts(f);facts=f as NativeProjectFacts;
  }
  return {status:missing.length?'SOURCE_GAPS':i.coverage!=='COMPLETE_PROJECT'||i.freshness!=='CURRENT'?'SOURCE_NOT_ELIGIBLE':'SOURCE_ASSEMBLED_NOT_AUTHORIZED',
    project_id:i.project_id,producer_ref:i.producer_ref,declared_coverage:i.coverage,declared_freshness:i.freshness,
    index_sha256:ref.sha256,files:refs,missing_sections:missing,valid_until:i.valid_until,facts,
    authority_authenticated_by_reader:false,writer_exclusion_proven_by_reader:false,execution_permitted:false,reservation_created:false};
}
export class NativeProjectSource implements ProjectFactsPort{
  private readonly reference:NativeSourceRef;private readonly clock:()=>number;
  constructor(reference:NativeSourceRef,clock:()=>number=Date.now){this.reference=structuredClone(reference);this.clock=clock;}
  async captureProject(projectId:string):Promise<NativeProjectFacts>{
    const result=inspectNativeProjectSource(this.reference,this.clock());
    check(result.project_id===projectId,'NATIVE_SOURCE_PROJECT_MISMATCH');check(result.facts,'NATIVE_SOURCE_MISSING_SECTIONS:'+result.missing_sections.join(','));
    return result.facts;
  }
}
/** Called at bootstrap and again by the installed control boundary. Changing a
 * support file while keeping the generated source.json unchanged is rejected.
 * Old R4.7 receipt formats retain their documented immutable-producer contract.
 */
export function assertNativeSourceCurrent(f:ProjectFacts,now:number):void{
  if(!Object.hasOwn(f,'native_source'))return;
  const p=(f as NativeProjectFacts).native_source;
  check(exact(p,['format','index_ref'])&&p.format==='xdev-native-source-provenance-1','NATIVE_SOURCE_PROVENANCE_INVALID');
  const observed=inspectNativeProjectSource(p.index_ref,now);
  check(observed.facts&&nativeValueHash(observed.facts)===nativeValueHash(f),'NATIVE_SOURCE_PROJECTION_MISMATCH');
}
/** Create a new projection receipt; no grant, registry, budget or reservation.
 * The provenance reference remains in the receipt and is rechecked on use.
 * A failed postcheck may leave an unusable diagnostic file; never overwrite it.
 */
export async function prepareNativeSourceReceipt(indexRef:NativeSourceRef,outputPath:string,clock:()=>number=Date.now){
  const ref=structuredClone(indexRef),observed=inspectNativeProjectSource(ref,clock());
  check(observed.facts,'NATIVE_SOURCE_MISSING_SECTIONS:'+observed.missing_sections.join(','));
  check(observed.declared_coverage==='COMPLETE_PROJECT'&&observed.declared_freshness==='CURRENT','NATIVE_SOURCE_NOT_ELIGIBLE');
  check(isAbsolute(outputPath)&&resolve(outputPath)===outputPath,'NATIVE_OUTPUT_PATH_INVALID');
  for(let p=dirname(outputPath);;p=dirname(p)){check(!lstatSync(p).isSymbolicLink(),'NATIVE_SOURCE_LINK');if(dirname(p)===p)break;}
  check(realpathSync(dirname(outputPath))===dirname(outputPath),'NATIVE_OUTPUT_PATH_ALIAS');
  const bytes=canonicalJson(observed.facts as any);
  assertNativeSourceCurrent(observed.facts,clock());
  const {openSync,writeFileSync,fsyncSync,closeSync}=await import('node:fs');
  let fd:number|undefined;
  try{fd=openSync(outputPath,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}
  assertNativeSourceCurrent(observed.facts,clock());
  const source_ref={path:outputPath,sha256:nativeBytesHash(bytes)};readNativeBoundFile(source_ref);
  return {status:'SOURCE_RECEIPT_CREATED_NOT_AUTHORIZED',source_ref,index_ref:ref,project_id:observed.project_id,
    valid_until:observed.valid_until,files_checked:observed.files.length,execution_permitted:false,reservation_created:false,worker_started:false};
}
