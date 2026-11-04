/** Per-domain installation reader. Registry events remain authoritative. */
import {parseRfc3339Timestamp} from '../planning/retry-history.ts';
import {evaluateAction,actionDigest,type Action,type Admission} from './admission.ts';
import {FileResourceBudget,type BudgetSnapshotBoundary} from './file-resource-budget.ts';
import {FileControlSourceBoundary} from './control-source-boundary.ts';
import {nativeBytesHash,nativeValueHash,readNativeBoundFile} from './native-project-source.ts';
import {check,read,same,type DomainPins,type DomainComposition} from './domain-composition.ts';
import {inspectResolvedInstallationTrustRegistry,resolveInstallationTrustRegistryRoot} from './installation-trust.ts';
import {inspectTypedDomainPublication as inspectDomainCompositionPublication} from './typed-domain-publication.ts';
import {ExecutionSourceBoundary,type ExecutionDomainComposition} from './execution-domain.ts';
import type {BudgetDomain,BudgetIntent,ReservationReceipt,PreparedResourceObservation} from './resource-budget-contract.ts';
export type {DomainPins} from './domain-composition.ts';
const clock=Date.now.bind(Date);
declare const brand:unique symbol;
export interface TrustedExecutionContext{readonly [brand]:true;readonly identity:string;readonly domain:BudgetDomain;readonly time_source:'SYSTEM_WALL_CLOCK';readonly owner_confirmation:'EXPLICIT_LOCAL_CONFIRMATION';readonly actor_cryptographic_identity:'NOT_CLAIMED';}
export interface DomainBoundBudget{readonly domain:BudgetDomain;readonly execution_permitted:false;reserve(admission:Admission):Promise<ReservationReceipt>;inspect(intent:BudgetIntent):Promise<PreparedResourceObservation>;}
type State={pins:DomainPins;domain:BudgetDomain;composition:DomainComposition|ExecutionDomainComposition;registryRoot:string;registryDigest:string;boundary:BudgetSnapshotBoundary;budget?:FileResourceBudget;access?:DomainBoundBudget};
const contexts=new WeakMap<object,State>(),permits=new WeakMap<object,{s:State;digest:string}>();
function enrolled(registryRoot:string,pins:DomainPins,domain:BudgetDomain){
 const r=inspectResolvedInstallationTrustRegistry(registryRoot);check(r.derived_matches,'INSTALLATION_REGISTRY_DERIVED_STATE_MISMATCH');
 const selected=r.entries.filter(e=>e.domain===domain&&e.state==='ACTIVE'&&same(e.pins,pins));
 check(selected.length===1,domain==='EXECUTION'?'EXECUTION_DOMAIN_NOT_ESTABLISHED':'AUTHORITY_NOT_ENROLLED');
 const e=selected[0],until=parseRfc3339Timestamp(e.valid_until);check(until!==null&&clock()<until,'ENROLLMENT_EXPIRED');
 return{digest:r.history_digest,entry:e};
}
function get(c:TrustedExecutionContext){const s=contexts.get(c);check(s,'TRUSTED_CONTEXT_REQUIRED');return s;}
function assertRegistryCurrent(s:State){const registry=inspectResolvedInstallationTrustRegistry(s.registryRoot);check(registry.derived_matches,'INSTALLATION_REGISTRY_DERIVED_STATE_MISMATCH');check(registry.history_digest===s.registryDigest,'AUTHORITY_INSTALLATION_CHANGED');}
async function current(s:State){assertRegistryCurrent(s);const e=enrolled(s.registryRoot,s.pins,s.domain);check(e.digest===s.registryDigest,'AUTHORITY_INSTALLATION_CHANGED');const o=await inspectDomainCompositionPublication(s.pins);check(same(o.composition,s.composition),'COMPOSITION_CHANGED');return o;}
export async function createTrustedExecutionContext(pins:DomainPins,domain:BudgetDomain):Promise<TrustedExecutionContext>{
 check(arguments.length===2,'PRODUCTION_FACTORY_ARGUMENTS_INVALID');if((pins as any)?.catalog_ref)throw Error('OLD_COMPOSITION_FORMAT_NOT_PRODUCTION_AUTHORITY');
 check(pins&&Object.keys(pins).sort().join(',')==='composition_ref,confirmation_ref','COMPOSITION_PIN_FIELDS_INVALID');
 const clone=structuredClone(pins),registryRoot=resolveInstallationTrustRegistryRoot(),e=enrolled(registryRoot,clone,domain),o=await inspectDomainCompositionPublication(clone),c=o.composition;
 check(c.domain===domain&&c.project_id===e.entry.project_id,'BUDGET_DOMAIN_MISMATCH');
 const s:State={pins:clone,domain,composition:c,registryRoot,registryDigest:e.digest,boundary:null!},control=c.domain==='EXECUTION'?new ExecutionSourceBoundary(c.allocation_ref):new FileControlSourceBoundary(c.control_root,c.control_binding_sha256,clock);
 const syncGuard=()=>{assertRegistryCurrent(s);check(enrolled(s.registryRoot,s.pins,s.domain).digest===s.registryDigest,'AUTHORITY_INSTALLATION_CHANGED');read(s.pins.composition_ref);read(s.pins.confirmation_ref);s.composition.upstream_refs.forEach(readNativeBoundFile);check(clock()<Date.parse(c.valid_until),'COMPOSITION_EXPIRED');};
 s.boundary=Object.freeze({controlSourceIdentity:{control_root:c.control_root,binding_sha256:c.control_binding_sha256},async captureProjectReadOnly(projectId:string){check(projectId===c.project_id,'CONTEXT_PROJECT_MISMATCH');return(await current(s)).facts;},async withProjectSnapshot<T>(projectId:string,operation:(facts:any,guard?:()=>void)=>Promise<T>){check(projectId===c.project_id,'CONTEXT_PROJECT_MISMATCH');const facts=(await current(s)).facts;return control.withProjectSnapshot(projectId,async(_f,guard)=>{const checkAll=()=>{guard?.();syncGuard();};checkAll();const value=await operation(facts,checkAll);checkAll();return value;});}});
 const context=Object.freeze({identity:'trusted-domain:'+nativeValueHash({pins:clone,domain}),domain,time_source:'SYSTEM_WALL_CLOCK',owner_confirmation:'EXPLICIT_LOCAL_CONFIRMATION',actor_cryptographic_identity:'NOT_CLAIMED'}) as unknown as TrustedExecutionContext;contexts.set(context,s);return context;
}
async function open(context:TrustedExecutionContext,domain:BudgetDomain){const s=get(context);check(s.domain===domain,'BUDGET_DOMAIN_MISMATCH');await current(s);if(s.access)return s.access;const c=s.composition,budget=new FileResourceBudget(c.budget_root,c.budget_binding_sha256,s.boundary,clock);s.budget=budget;s.access=Object.freeze({domain,execution_permitted:false as const,reserve:(a:Admission)=>budget.reserve(a),inspect:(i:BudgetIntent)=>budget.inspect(i,domain==='RESERVE_ONLY_CONTROL'?'RESERVE_ONLY':'EXECUTE')});return s.access;}
export async function openReserveOnlyControlBudget(c:TrustedExecutionContext){check(arguments.length===1,'PRODUCTION_OPENER_ARGUMENTS_INVALID');return open(c,'RESERVE_ONLY_CONTROL');}
export async function openExecutionBudget(c:TrustedExecutionContext){check(arguments.length===1,'PRODUCTION_OPENER_ARGUMENTS_INVALID');return open(c,'EXECUTION');}
export async function issueTrustedAdmission(action:Action,context:TrustedExecutionContext,purpose:Admission['purpose']):Promise<Admission>{check(arguments.length===3,'PRODUCTION_ISSUANCE_ARGUMENTS_INVALID');const s=get(context);check(purpose===(s.domain==='RESERVE_ONLY_CONTROL'?'RESERVE_ONLY':'EXECUTE'),'ADMISSION_DOMAIN_MISMATCH');check(actionDigest(action)===actionDigest(s.composition.action),'DOMAIN_ACTION_MISMATCH');await current(s);check(s.budget,'DOMAIN_BOUND_BUDGET_REQUIRED');const a=await evaluateAction(action,s.budget,clock,purpose);await current(s);if(a.allowed)permits.set(a,{s,digest:nativeValueHash(a)});return a;}
export function isIssuedAdmission(a:Admission){const p=permits.get(a);return !!p&&a.allowed&&p.digest===nativeValueHash(a);}
export async function assertBudgetAdmission(a:Admission,root:string,binding:string,boundary:BudgetSnapshotBoundary){const p=permits.get(a);check(p&&isIssuedAdmission(a)&&p.s.boundary===boundary&&p.s.composition.budget_root===root&&p.s.composition.budget_binding_sha256===binding,'BUDGET_TRUST_DOMAIN_REQUIRED');await current(p.s);}
export function describeIssuedAdmission(a:Admission){const p=permits.get(a);check(p&&isIssuedAdmission(a),'ISSUED_ADMISSION_REQUIRED');return{domain:p.s.domain,source_revision:a.source_revision,source_digest:a.source_digest,time_source:'SYSTEM_WALL_CLOCK',owner_confirmation:'EXPLICIT_LOCAL_CONFIRMATION',actor_cryptographic_identity:'NOT_CLAIMED'};}
export async function describeExecutionScope(context:TrustedExecutionContext){const s=get(context);check(s.domain==='EXECUTION','EXECUTION_DOMAIN_NOT_ESTABLISHED');const o=await current(s);check(o.composition.domain==='EXECUTION'&&'scope' in o,'EXECUTION_DOMAIN_NOT_ESTABLISHED');return structuredClone(o.scope);}
/** Last synchronous guard immediately before an already-approved wire send. */
export function assertExecutionSendCurrent(context:TrustedExecutionContext){const s=get(context);check(s.domain==='EXECUTION','EXECUTION_DOMAIN_NOT_ESTABLISHED');assertRegistryCurrent(s);enrolled(s.registryRoot,s.pins,s.domain);read(s.pins.composition_ref);read(s.pins.confirmation_ref);s.composition.upstream_refs.forEach(readNativeBoundFile);check(clock()<Date.parse(s.composition.valid_until),'COMPOSITION_EXPIRED');}
