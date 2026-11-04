/** J04/J12: bounded projection of explicitly approved PUBLIC facts. No SDK,
 * native memory, semantic comparison, dispatch, authorization or writes. The
 * coordinator declares claims; this module checks their exact byte bindings. */
import { createHash } from 'node:crypto';
import { canonical } from '../src/job-runtime/store.ts';
import { parseD1UniqueJson } from '../src/job-runtime/contracts.ts';

export type PublicFactRef={path:string;sha256:string};
export type PublicFactScope={xdev_project_id:string;project_root:string;project_id:string;workspace_id:string;task_ref:string;task_version:string;role:'developer'};
export type PublicFactsDeclaration={source:PublicFactRef;scope:PublicFactScope;spec:PublicFactRef};
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
function check(v:unknown,code:string):asserts v{if(!v)throw Error('CURRENT_MEMORY_'+code);}
function exact(v:any,keys:string[]){check(v&&typeof v==='object'&&!Array.isArray(v)&&canonical(Object.keys(v).sort())===canonical([...keys].sort()),'SHAPE');}
const word=(v:any):v is string=>typeof v==='string'&&v.trim().length>0&&Buffer.byteLength(v)<=512&&!/[\x00-\x1f]/.test(v);
const prose=(v:any):v is string=>typeof v==='string'&&v.trim().length>0&&Buffer.byteLength(v)<=4096&&!v.includes('\0');
const iso=(v:any)=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const same=(a:any,b:any)=>canonical(a)===canonical(b);
function ref(v:any):asserts v is PublicFactRef{exact(v,['path','sha256']);check(word(v.path)&&typeof v.sha256==='string'&&/^[a-f0-9]{64}$/.test(v.sha256),'REF');}
function scope(v:any){exact(v,['xdev_project_id','project_root','project_id','workspace_id','task_ref','task_version','role']);check(Object.values(v).every(word)&&v.role==='developer','SCOPE');}
function pinned(r:PublicFactRef,read:(r:PublicFactRef)=>string){ref(r);const raw=read(r);check(typeof raw==='string'&&Buffer.byteLength(raw)<=65536&&hash(raw)===r.sha256,'SOURCE_DRIFT');return raw;}
function source(v:any,approved:PublicFactRef[],read:(r:PublicFactRef)=>string){
 exact(v,['ref','source_id','kind','observed_at']);ref(v.ref);
 check(word(v.source_id)&&['OWNER_PUBLIC','COORDINATOR_PUBLIC'].includes(v.kind)&&iso(v.observed_at),'PUBLIC_SOURCE');
 check(approved.some(r=>same(r,v.ref)),'SOURCE_NOT_APPROVED');check(pinned(v.ref,read).trim().length>0,'SOURCE_EMPTY');
}
export function inspectPublicFactsDeclaration(v:any,subject:{projectId:string;projectRoot:string},expectedSpec:PublicFactRef,read:(r:PublicFactRef)=>string){
 exact(v,['source','scope','spec']);ref(v.source);ref(v.spec);ref(expectedSpec);scope(v.scope);
 check(v.scope.xdev_project_id===subject.projectId&&v.scope.project_root===subject.projectRoot,'PROJECT_MISMATCH');
 check(same(v.spec,expectedSpec),'SPEC_MISMATCH');const material=read(v.spec);check(typeof material==='string'&&Buffer.byteLength(material)>0&&Buffer.byteLength(material)<=2*1024*1024&&hash(material)===v.spec.sha256,'SPEC_SOURCE_DRIFT');
 return v as PublicFactsDeclaration;
}
/** The injected reader must enforce its existing approved input domain. Every
 * source is read again on every supported boundary, including replay/recovery. */
export function projectCurrentMemoryFacts(expected:PublicFactScope,document:PublicFactRef,read:(r:PublicFactRef)=>string,now=Date.now()){
 scope(expected);check(Number.isSafeInteger(now),'TIME');
 const value=parseD1UniqueJson(pinned(document,read)) as any;
 exact(value,['format','scope','observed_at','valid_until','approved_public_sources','historical','facts']);
 check(value.format==='xdev-public-current-memory-facts-1'&&same(value.scope,expected),'SCOPE_MISMATCH');
 check(iso(value.observed_at)&&iso(value.valid_until)&&Date.parse(value.observed_at)<=now&&now<Date.parse(value.valid_until)&&Date.parse(value.observed_at)<Date.parse(value.valid_until),'OBSERVATION_TIME');
 const approved=value.approved_public_sources;check(Array.isArray(approved)&&approved.length<=32,'SOURCE_BOUND');
 for(const r of approved){ref(r);check(pinned(r,read).trim().length>0,'SOURCE_EMPTY');}check(new Set(approved.map(r=>r.path)).size===approved.length,'SOURCE_DUPLICATE');
 check(Array.isArray(value.historical)&&value.historical.length<=32&&Array.isArray(value.facts)&&value.facts.length<=32,'FACT_BOUND');
 const factIds=new Set<string>();
 for(const f of value.facts){
  exact(f,['id','issue_id','observation_scope','claim','state','source','memory_reference','corrects']);
  check(word(f.id)&&!factIds.has(f.id)&&word(f.issue_id)&&word(f.observation_scope)&&prose(f.claim)&&['CURRENT_MATCH','PENDING','RETRACTED'].includes(f.state),'FACT');factIds.add(f.id);
  source(f.source,approved,read);check(Date.parse(f.source.observed_at)<=now&&Date.parse(f.source.observed_at)>=Date.parse(value.observed_at),'FACT_TIME');
  if(f.memory_reference!==null){exact(f.memory_reference,['memory_key','revision_id','source_id']);check(Object.values(f.memory_reference).every(word),'REFERENCE');}
  if(f.corrects!==null){exact(f.corrects,['memory_key','previous_revision_id','owner_source']);check(word(f.corrects.memory_key)&&word(f.corrects.previous_revision_id)&&f.memory_reference?.memory_key===f.corrects.memory_key,'CORRECTION_REFERENCE');source(f.corrects.owner_source,approved,read);check(f.corrects.owner_source.kind==='OWNER_PUBLIC'&&Date.parse(f.corrects.owner_source.observed_at)<=now&&Date.parse(f.corrects.owner_source.observed_at)>=Date.parse(value.observed_at),'OWNER_CORRECTION_REQUIRED');}
 }
 const seen=new Set<string>();
 const rows=value.historical.map((h:any)=>{
  exact(h,['issue_id','observation_scope','pending','material_validation','source']);
  check(word(h.issue_id)&&word(h.observation_scope)&&Array.isArray(h.pending)&&h.pending.length<=32&&h.pending.every(prose)&&['VALID','STALE','UNKNOWN'].includes(h.material_validation),'HISTORY');
  source(h.source,approved,read);check(Date.parse(h.source.observed_at)<=Date.parse(value.observed_at),'HISTORY_TIME');
  const key=canonical([h.issue_id,h.observation_scope]);check(!seen.has(key),'HISTORY_DUPLICATE');seen.add(key);
  const facts=value.facts.filter((f:any)=>f.issue_id===h.issue_id&&f.observation_scope===h.observation_scope);
  // Equality is only declared string equality, never semantic equivalence or a
  // preferred tool/source. Both conflicting originals remain visible.
  const claims=new Set(facts.map((f:any)=>canonical([f.state,f.claim,f.memory_reference,f.corrects])));
  const status=claims.size>1?'CONFLICT':facts.length===0?'UNKNOWN':facts[0].state==='CURRENT_MATCH'?'CURRENT_MATCH':facts[0].state==='RETRACTED'?'RETRACTED':'PENDING';
  return{issue_id:h.issue_id,observation_scope:h.observation_scope,historical:structuredClone(h),current_status:status,public_facts:structuredClone(facts),historical_pending_preserved:true};
 });
 const result={format:'xdev-current-memory-facts-result-1',scope:structuredClone(expected),source:document,observed_at:value.observed_at,valid_until:value.valid_until,rows,
  unmatched_public_facts:structuredClone(value.facts.filter((f:any)=>!seen.has(canonical([f.issue_id,f.observation_scope])))),
  hidden_native_memory:'UNKNOWN',material_validity_is_current_applicability:false,authority:'COORDINATOR_PUBLIC_DECLARATIONS_AND_EXACT_BYTE_BINDINGS_ONLY',
  native_identity_authenticated:false,semantic_truth_verified:false,execution_allowed:false,delivery_allowed:false,permission_granted:false,
  delivery:{status:'PREPARED_FOR_COORDINATOR_RETURN',received:'NOT_OBSERVED',adoption:'NOT_OBSERVED'}};
 check(Buffer.byteLength(canonical(result))<=65536,'OUTPUT_BOUND');return result;
}
