/** Trusted current execution-source publisher.
 *
 * This module does not discover engineering facts and does not authenticate an
 * Owner. A product integration must provide a CurrentSourceSnapshotBoundary
 * that holds one consistent whole-project snapshot for the entire awaited
 * callback. The publisher only validates, freezes, and serializes that snapshot
 * into the existing native-source format. It never issues an Admission,
 * reservation, Worker permission, or XMem state.
 */
import {randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {canonicalJson} from '../planning/governance-contracts.ts';
import {parseRfc3339Timestamp} from '../planning/retry-history.ts';
import {validateProjectFacts,type ProjectFacts} from './admission.ts';
import {controlNoLinks} from './control-source-boundary.ts';
import {nativeBytesHash,readNativeBoundFile,sourceSections,type NativeSourceIndex,type NativeSourcePart,type NativeSourceRef,type SourceSection} from './native-project-source.ts';

export type CurrentSourceSnapshot={
  format:'xdev-current-source-snapshot-1';
  project_id:string;
  revision:string;
  producer_ref:string;
  issued_at:string;
  valid_until:string;
  coverage:'COMPLETE_PROJECT'|'INCOMPLETE';
  freshness:'CURRENT'|'STALE'|'UNKNOWN';
  sections:Record<SourceSection,unknown|undefined>;
  support_refs:NativeSourceRef[];
};

/** Integration contract: the callback is called exactly once and the snapshot
 * stays valid until the awaited callback returns. assertCurrent(), if supplied,
 * must fail when any fact/authorization/resource input in the held snapshot is
 * no longer current. A simple read-then-callback adapter does not satisfy this.
 */
export interface CurrentSourceSnapshotBoundary {
  withCurrentSnapshot<T>(projectId:string,operation:(snapshot:CurrentSourceSnapshot,assertCurrent?:()=>void)=>Promise<T>):Promise<T>;
}

export type CurrentSourceReadiness={
  status:'READY_FOR_SOURCE_PUBLICATION'|'BLOCKED';
  project_id:string;
  revision:string|null;
  coverage:CurrentSourceSnapshot['coverage']|null;
  freshness:CurrentSourceSnapshot['freshness']|null;
  missing_sections:SourceSection[];
  reasons:string[];
  valid_until:string|null;
  execution_permitted:false;
  reservation_created:false;
  worker_started:false;
};

const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v:any,k:readonly string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...k].sort().join(',');
function check(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
const inside=(root:string,p:string)=>{const r=relative(root,p);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));};
function assertOrdinaryDir(path:string){controlNoLinks(path);const s=lstatSync(path);check(s.isDirectory()&&realpathSync(path)===path,'CURRENT_SOURCE_OUTPUT_PARENT_INVALID');}
function validateRef(r:NativeSourceRef){check(exact(r,['path','sha256'])&&text(r.path)&&sha(r.sha256),'CURRENT_SOURCE_SUPPORT_REFERENCE_INVALID');readNativeBoundFile(r);}
function validateSnapshot(s:CurrentSourceSnapshot,projectId:string,now:number){
  check(exact(s,['format','project_id','revision','producer_ref','issued_at','valid_until','coverage','freshness','sections','support_refs'])&&s.format==='xdev-current-source-snapshot-1','CURRENT_SOURCE_SNAPSHOT_INVALID');
  check(s.project_id===projectId&&[s.project_id,s.revision,s.producer_ref].every(text),'CURRENT_SOURCE_IDENTITY_INVALID');
  check(exact(s.sections,sourceSections)&&Array.isArray(s.support_refs)&&s.support_refs.length<=64,'CURRENT_SOURCE_SECTIONS_INVALID');
  check(['COMPLETE_PROJECT','INCOMPLETE'].includes(s.coverage)&&['CURRENT','STALE','UNKNOWN'].includes(s.freshness),'CURRENT_SOURCE_STATUS_INVALID');
  const issued=parseRfc3339Timestamp(s.issued_at),until=parseRfc3339Timestamp(s.valid_until);
  check(Number.isFinite(now)&&now>=0&&issued!==null&&until!==null&&issued<until,'CURRENT_SOURCE_WINDOW_INVALID');
  check(issued<=now&&now<until,'CURRENT_SOURCE_OUTSIDE_WINDOW');
  const paths=new Set<string>();for(const r of s.support_refs){validateRef(r);check(!paths.has(r.path),'CURRENT_SOURCE_SUPPORT_DUPLICATE');paths.add(r.path);}
}
function factsFromSnapshot(s:CurrentSourceSnapshot):ProjectFacts|null{
  const missing=sourceSections.filter(k=>s.sections[k]===undefined);
  if(missing.length)return null;
  const {legacy,execution_constraints,evidence_refs,...collections}=s.sections;
  check(Array.isArray(evidence_refs)&&evidence_refs.every(text),'CURRENT_SOURCE_EVIDENCE_INVALID');
  const f:any={...collections,format:'xdev-execution-source-1',project_id:s.project_id,revision:'current-snapshot:'+nativeBytesHash(canonicalJson({revision:s.revision,producer_ref:s.producer_ref})),coverage:s.coverage,freshness:s.freshness,evidence_refs:[...evidence_refs,s.producer_ref,...s.support_refs.map(r=>'file-sha256:'+r.sha256)]};
  if(execution_constraints!==null)Object.assign(f,execution_constraints);
  if(legacy!==null)Object.assign(f,legacy);
  validateProjectFacts(f);return f;
}
function readinessFor(s:CurrentSourceSnapshot,projectId:string,now:number):CurrentSourceReadiness{
  validateSnapshot(s,projectId,now);
  const missing=sourceSections.filter(k=>s.sections[k]===undefined),reasons:string[]=[];
  if(missing.length)reasons.push(...missing.map(k=>'MISSING_SECTION:'+k));
  if(s.coverage!=='COMPLETE_PROJECT')reasons.push('PROJECT_SOURCE_INCOMPLETE');
  if(s.freshness!=='CURRENT')reasons.push('PROJECT_SOURCE_NOT_CURRENT');
  if(!missing.length){try{factsFromSnapshot(s);}catch(e){reasons.push(e instanceof Error?e.message:'CURRENT_SOURCE_FACTS_INVALID');}}
  return{status:reasons.length?'BLOCKED':'READY_FOR_SOURCE_PUBLICATION',project_id:s.project_id,revision:s.revision,coverage:s.coverage,freshness:s.freshness,missing_sections:missing,reasons,valid_until:s.valid_until,execution_permitted:false,reservation_created:false,worker_started:false};
}

/** Read-only readiness against the same boundary that publication would use. */
export async function inspectCurrentSourceReadiness(boundary:CurrentSourceSnapshotBoundary,projectId:string,clock:()=>number=Date.now):Promise<CurrentSourceReadiness>{
  check(boundary&&typeof boundary.withCurrentSnapshot==='function','CURRENT_SOURCE_BOUNDARY_REQUIRED');
  let called=false,finished=false,active=true;let guard:(()=>void)|undefined;let out:CurrentSourceReadiness|undefined;
  try{out=await boundary.withCurrentSnapshot(projectId,async(s,g)=>{
    check(!called,'CURRENT_SOURCE_CALLBACK_REPEATED');called=true;check(g===undefined||typeof g==='function','CURRENT_SOURCE_GUARD_INVALID');guard=g;
    const assertActive=()=>{check(active,'CURRENT_SOURCE_TRANSACTION_ENDED');if(guard)check(guard()===undefined,'CURRENT_SOURCE_GUARD_INVALID');};
    assertActive();const r=readinessFor(structuredClone(s),projectId,clock());assertActive();finished=true;return r;
  });}finally{active=false;}
  check(called&&finished&&out,'CURRENT_SOURCE_BOUNDARY_INVALID');return out;
}

/** Publish one immutable current snapshot into native source files. This is a
 * serialization step only. The returned index still grants nothing by itself. */
export async function publishCurrentSource(boundary:CurrentSourceSnapshotBoundary,projectId:string,outputRootInput:string,clock:()=>number=Date.now){
  check(boundary&&typeof boundary.withCurrentSnapshot==='function','CURRENT_SOURCE_BOUNDARY_REQUIRED');
  const outputRoot=resolve(outputRootInput);check(isAbsolute(outputRootInput)&&outputRoot===outputRootInput,'CURRENT_SOURCE_OUTPUT_NOT_CANONICAL');
  const parent=dirname(outputRoot);assertOrdinaryDir(parent);controlNoLinks(outputRoot);check(!existsSync(outputRoot),'CURRENT_SOURCE_OUTPUT_EXISTS');
  let called=false,finished=false,active=true;
  try{return await boundary.withCurrentSnapshot(projectId,async(snapshot,guard)=>{
    check(!called,'CURRENT_SOURCE_CALLBACK_REPEATED');called=true;check(guard===undefined||typeof guard==='function','CURRENT_SOURCE_GUARD_INVALID');
    const assertActive=()=>{check(active,'CURRENT_SOURCE_TRANSACTION_ENDED');if(guard)check(guard()===undefined,'CURRENT_SOURCE_GUARD_INVALID');};
    const now=clock();assertActive();const s=structuredClone(snapshot),ready=readinessFor(s,projectId,now);
    check(ready.status==='READY_FOR_SOURCE_PUBLICATION','CURRENT_SOURCE_NOT_READY:'+ready.reasons.join(';'));
    const facts=factsFromSnapshot(s);check(facts,'CURRENT_SOURCE_FACTS_MISSING');
    for(const r of s.support_refs){check(!inside(outputRoot,r.path),'CURRENT_SOURCE_SUPPORT_OVERLAPS_OUTPUT');readNativeBoundFile(r);}
    const temp=join(parent,'.'+outputRoot.split(sep).pop()+'.'+randomUUID()+'.tmp');mkdirSync(temp,{mode:0o700});
    try{
      const sections={} as Record<SourceSection,NativeSourceRef|null>;
      for(const section of sourceSections){const part:NativeSourcePart={format:'xdev-native-source-part-1',project_id:s.project_id,revision:s.revision,section,value:s.sections[section]};
        const bytes=canonicalJson(part as any),path=join(temp,section+'.json');let fd:number|undefined;try{fd=openSync(path,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}sections[section]={path:join(outputRoot,section+'.json'),sha256:nativeBytesHash(bytes)};}
      const index:NativeSourceIndex={format:'xdev-native-source-index-1',project_id:s.project_id,revision:s.revision,producer_ref:s.producer_ref,issued_at:s.issued_at,valid_until:s.valid_until,coverage:s.coverage,freshness:s.freshness,sections,support_refs:s.support_refs};
      const indexBytes=canonicalJson(index as any),indexPath=join(temp,'index.json');let fd:number|undefined;try{fd=openSync(indexPath,'wx',0o600);writeFileSync(fd,indexBytes);fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}
      // Final guard and support-byte check happen before atomic directory rename.
      assertActive();for(const r of s.support_refs)readNativeBoundFile(r);assertActive();renameSync(temp,outputRoot);
      const finalRef={path:join(outputRoot,'index.json'),sha256:nativeBytesHash(indexBytes)};readNativeBoundFile(finalRef);finished=true;
      return{status:'CURRENT_SOURCE_PUBLISHED_NOT_AUTHORIZED',project_id:s.project_id,revision:s.revision,index_ref:finalRef,valid_until:s.valid_until,files_written:sourceSections.length+1,execution_permitted:false,reservation_created:false,worker_started:false};
    }catch(e){try{rmSync(temp,{recursive:true,force:true});}catch{}throw e;}
  });}finally{active=false;check(called&&finished||!existsSync(outputRoot),'CURRENT_SOURCE_PARTIAL_COMMIT');}
}
