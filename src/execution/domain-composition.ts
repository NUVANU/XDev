/** S2 publication binds established reserve-only artifacts; it creates no authority. */
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,readdirSync,lstatSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,sep,dirname} from 'node:path';
import {parseUniqueJson,parseRfc3339Timestamp} from '../planning/retry-history.ts';
import {canonicalJson} from '../planning/governance-contracts.ts';
import {actionDigest,type Action} from './admission.ts';
import {budgetBindingDigest,type BudgetBinding} from './file-resource-budget.ts';
import {FileControlSourceBoundary,readControlBytes,controlNoLinks,readCurrentAllocationBudgetAttachment,readFinalReserveSourceAttachment} from './control-source-boundary.ts';
import {inspectCurrentM2TaskAuthorization} from './current-task-authorization.ts';
import {inspectRealControlSource} from './real-control-source-bootstrap.ts';
import {inspectProjectIdentity} from './project-identity-bootstrap.ts';
import {inspectNativeProjectSource,readNativeBoundFile,nativeBytesHash,nativeValueHash,type NativeSourceRef} from './native-project-source.ts';

export const DOMAIN_PUBLICATION_ACK='PUBLISH_CURRENT_RESERVE_ONLY_CONTROL_DOMAIN_NO_ENROLLMENT_NO_EXECUTION';
const clock=Date.now.bind(Date);
export function check(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
export const same=(a:unknown,b:unknown)=>nativeValueHash(a)===nativeValueHash(b);
export function read(ref:NativeSourceRef):any{return parseUniqueJson(readNativeBoundFile(ref).toString('utf8'));}
export function ref(path:string):NativeSourceRef{return{path,sha256:nativeBytesHash(readControlBytes(path))};}
function exact(v:any,keys:string[]){return v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.sort().join(',');}
const time=(s:string)=>{const n=parseRfc3339Timestamp(s);check(n!==null,'DOMAIN_TIME_INVALID');return n;};
const overlaps=(a:string,b:string)=>{const r=relative(a.toLowerCase(),b.toLowerCase());return r===''||!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep);};
export type DomainInputs={control_root:string;control_binding_sha256:string;source_index_ref:NativeSourceRef;valid_until:string};
export type DomainComposition={format:'xdev-domain-composition-1';composition_id:string;project_id:string;domain:'RESERVE_ONLY_CONTROL';identity_ref:NativeSourceRef;authority_refs:NativeSourceRef[];producer_ref:string;control_root:string;control_binding_sha256:string;source_index_ref:NativeSourceRef;allocation_ref:string;budget_root:string;budget_binding:BudgetBinding;budget_binding_sha256:string;action:Action;authorization_ref:NativeSourceRef;issued_at:string;valid_until:string;upstream_receipt_refs:NativeSourceRef[];upstream_refs:NativeSourceRef[]};
export type DomainPins={composition_ref:NativeSourceRef;confirmation_ref:NativeSourceRef};
export type DomainProposal={format:'xdev-domain-publication-proposal-1';publication_root:string;composition:DomainComposition;composition_sha256:string;proposal_sha256:string};
// S4 must supply its independently applied allocation/authorization/budget evidence.
// There is deliberately no S4 establishment or publication implementation here.
export interface FutureExecutionDomainEvidence{domain:'EXECUTION';allocation_receipt:NativeSourceRef;authorization_receipt:NativeSourceRef;budget_binding:NativeSourceRef;current_source:NativeSourceRef;control_binding:NativeSourceRef;}

async function observe(input:DomainInputs){
 const now=clock();check(time(input.valid_until)>now,'DOMAIN_EXPIRED');
 const boundary=new FileControlSourceBoundary(input.control_root,input.control_binding_sha256,clock);
 const b=boundary.binding;check(b.format==='xdev-control-binding-3'&&b.mode==='UPSTREAM_UNBOUND_NO_BUDGET','DOMAIN_CONTROL_BINDING_VERSION_UNSUPPORTED');
 const a=readCurrentAllocationBudgetAttachment(input.control_root,input.control_binding_sha256,clock),f=readFinalReserveSourceAttachment(input.control_root,input.control_binding_sha256,clock);
 check(a&&!a.stale,'DOMAIN_CURRENT_ALLOCATION_REQUIRED');check(f&&!f.stale,'DOMAIN_FINAL_SOURCE_REQUIRED');
 await inspectProjectIdentity(dirname(b.identity_ref.identity_path),clock);
 await inspectRealControlSource(input.control_root,clock);
 await inspectCurrentM2TaskAuthorization(input.control_root,input.control_binding_sha256,clock);
 const taskRef=ref(join(input.control_root,'current-task-authorization.json')),task=read(taskRef);
 const controlFacts=await boundary.captureProjectReadOnly(b.project_id);
 const native=inspectNativeProjectSource(input.source_index_ref,clock()),index=read(input.source_index_ref);
 check(native.status==='SOURCE_ASSEMBLED_NOT_AUTHORIZED'&&native.facts&&native.project_id===b.project_id,'DOMAIN_NATIVE_SOURCE_REQUIRED');
 const facts=native.facts;
 check(controlFacts.coverage==='COMPLETE_PROJECT'&&controlFacts.freshness==='CURRENT'&&facts.coverage==='COMPLETE_PROJECT'&&facts.freshness==='CURRENT','DOMAIN_SOURCE_NOT_CURRENT');
 for(const key of ['tasks','resources','charges','reservations','unknowns','stops','authorizations','compatibility','execution_restriction','control_action_sha256'] as const)check(same(facts[key]??null,controlFacts[key]??null),'DOMAIN_NATIVE_CONTROL_MISMATCH:'+key);
 check(facts.execution_restriction==='RESERVATION_ONLY'&&facts.control_action_sha256===actionDigest(a.receipt.action),'DOMAIN_RESERVE_ONLY_REQUIRED');
 check(task.owner_scope.purpose==='RESERVE_ONLY_NO_DISPATCH'&&task.project_id===b.project_id&&task.control_binding_sha256===input.control_binding_sha256&&task.action.action_id===a.receipt.action.action_id,'DOMAIN_TASK_BINDING_MISMATCH');
 const upper=Math.min(time(index.valid_until),time(task.owner_scope.valid_until),time(a.receipt.valid_until),time(a.receipt.authorization_fact.expires_at),time(f.receipt.finalization_valid_until));
 check(time(input.valid_until)<=upper,'DOMAIN_VALIDITY_EXCEEDS_UPSTREAM');
 const identity_ref={path:b.identity_ref.identity_path,sha256:b.identity_ref.identity_sha256};
 const receipts=[{path:b.identity_ref.bootstrap_path,sha256:b.identity_ref.bootstrap_sha256},ref(join(input.control_root,'control-source-bootstrap.json')),taskRef,ref(join(input.control_root,'current-allocation-budget.json')),ref(join(input.control_root,'final-reserve-source.json'))];
 const renewal=join(input.control_root,'current-allocation-renewal.json');if(existsSync(renewal))receipts.push(ref(renewal));
 const all=[identity_ref,...receipts,ref(join(input.control_root,'binding.json')),...a.immutable_support,...f.support,...native.files,input.source_index_ref];
 check(!all.some(r=>r.path.toLowerCase()===join(a.receipt.budget_root,'reservations.json').toLowerCase()),'MUTABLE_JOURNAL_IN_IMMUTABLE_SUPPORT');
 const refs=[...new Map(all.map(r=>[r.path,r])).values()].sort((x,y)=>x.path.localeCompare(y.path));refs.forEach(readNativeBoundFile);check(clock()<time(input.valid_until),'DOMAIN_EXPIRED');
 // All formal source dependencies remain independently pinned, even when the
 // native publisher's support closure contains only its direct snapshot refs.
 return{project_id:b.project_id,identity_ref,authority_refs:[taskRef],producer_ref:native.producer_ref,control_root:input.control_root,control_binding_sha256:input.control_binding_sha256,source_index_ref:input.source_index_ref,allocation_ref:a.receipt.allocation_ref,budget_root:a.receipt.budget_root,budget_binding:a.receipt.budget_binding,budget_binding_sha256:a.receipt.budget_binding_sha256,action:a.receipt.action,authorization_ref:taskRef,valid_until:input.valid_until,upstream_receipt_refs:receipts,upstream_refs:refs,facts,workspace_root:b.workspace_root};
}
function body(c:DomainComposition){const {format,composition_id,domain,issued_at,...rest}=c;return rest;}
export async function validateDomainCurrent(c:DomainComposition){
 check((c as any)?.format!=='xdev-trusted-composition-1','OLD_COMPOSITION_FORMAT_NOT_PRODUCTION_AUTHORITY');
 check(exact(c,['format','composition_id','project_id','domain','identity_ref','authority_refs','producer_ref','control_root','control_binding_sha256','source_index_ref','allocation_ref','budget_root','budget_binding','budget_binding_sha256','action','authorization_ref','issued_at','valid_until','upstream_receipt_refs','upstream_refs'])&&c.format==='xdev-domain-composition-1','DOMAIN_COMPOSITION_INVALID');
 check(c.domain==='RESERVE_ONLY_CONTROL','EXECUTION_DOMAIN_NOT_ESTABLISHED');check(time(c.issued_at)<=clock()&&time(c.issued_at)<time(c.valid_until),'DOMAIN_TIME_INVALID');
 c.upstream_refs.forEach(readNativeBoundFile);const {facts,workspace_root,...actual}=await observe(c);check(same(body(c),actual),'DOMAIN_UPSTREAM_DRIFT');return{facts,workspace_root};
}
function validateRoot(root:string,c:DomainComposition,workspace:string){
 controlNoLinks(root);check(resolve(root)===root,'DOMAIN_ROOT_NOT_CANONICAL');
 for(const forbidden of [workspace,c.control_root,c.budget_root,...[process.env.CODEX_HOME,process.env.LOCALAPPDATA?join(process.env.LOCALAPPDATA,'OpenAI'):null,'D:\\XMem',process.env.USERPROFILE?join(process.env.USERPROFILE,'.codex'):null].filter((x):x is string=>!!x)])check(!overlaps(forbidden,root)&&!overlaps(root,forbidden),'DOMAIN_PUBLICATION_ROOT_OVERLAP');
 check(lstatSync(dirname(root)).isDirectory()&&dirname(root).split(sep).pop()===c.domain,'DOMAIN_PARENT_REQUIRED');
}
// S2 publishes only reserve-only. Inspect all sibling composition directories;
// no caller-provided partial peer list can suppress a cross-domain collision.
function conflicts(root:string,c:DomainComposition){
 const project=dirname(dirname(root));for(const domain of ['RESERVE_ONLY_CONTROL','EXECUTION']){const parent=join(project,domain);if(!existsSync(parent))continue;controlNoLinks(parent);for(const e of readdirSync(parent,{withFileTypes:true})){const dir=join(parent,e.name);if(dir===root)continue;check(!e.isSymbolicLink(),'DOMAIN_PUBLICATION_LINK');if(!e.isDirectory())continue;const path=join(dir,'composition.json');if(!existsSync(path))continue;const peer=read(ref(path));check(peer.format==='xdev-domain-composition-1','DOMAIN_PEER_INVALID');if(peer.domain!==c.domain)check(peer.budget_root?.toLowerCase()!==c.budget_root.toLowerCase()&&peer.budget_binding_sha256!==c.budget_binding_sha256,'DOMAIN_CROSS_DOMAIN_CONFLICT');}}
}
export async function prepareDomainCompositionPublication(input:DomainInputs,publication_root:string):Promise<DomainProposal>{
 check(arguments.length===2,'DOMAIN_ARGUMENTS_INVALID');const {facts,workspace_root,...observed}=await observe(structuredClone(input));
 const composition:DomainComposition={format:'xdev-domain-composition-1',composition_id:randomUUID(),domain:'RESERVE_ONLY_CONTROL',issued_at:new Date(clock()).toISOString(),...observed};
 validateRoot(publication_root,composition,workspace_root);check(!existsSync(publication_root),'DOMAIN_PUBLICATION_EXISTS');conflicts(publication_root,composition);
 const core={format:'xdev-domain-publication-proposal-1' as const,publication_root,composition,composition_sha256:nativeValueHash(composition)};return{...core,proposal_sha256:nativeValueHash(core)};
}
function writeNew(path:string,value:unknown){const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,canonicalJson(value as any));fsyncSync(fd);}finally{closeSync(fd);}}
export async function applyDomainCompositionPublication(proposalRef:NativeSourceRef,digest:string,ack:string):Promise<DomainPins>{
 check(arguments.length===3&&ack===DOMAIN_PUBLICATION_ACK,'DOMAIN_EXACT_ACK_REQUIRED');const p=read(proposalRef) as DomainProposal;
 const {proposal_sha256,...core}=p;check(exact(p,['format','publication_root','composition','composition_sha256','proposal_sha256'])&&p.format==='xdev-domain-publication-proposal-1'&&digest===proposal_sha256&&nativeValueHash(core)===digest&&nativeValueHash(p.composition)===p.composition_sha256&&nativeValueHash(p)===proposalRef.sha256,'DOMAIN_PROPOSAL_DIGEST_MISMATCH');
 const {workspace_root}=await validateDomainCurrent(p.composition);validateRoot(p.publication_root,p.composition,workspace_root);check(!existsSync(p.publication_root),'DOMAIN_PUBLICATION_EXISTS');conflicts(p.publication_root,p.composition);
 const confirmation={format:'xdev-domain-publication-confirmation-1',proposal_sha256:digest,proposal_bytes_sha256:proposalRef.sha256,composition_sha256:p.composition_sha256,composition_id:p.composition.composition_id,project_id:p.composition.project_id,domain:p.composition.domain,budget_root:p.composition.budget_root,budget_binding_sha256:p.composition.budget_binding_sha256,valid_until:p.composition.valid_until,ack,owner_confirmation:'EXPLICIT_LOCAL_CONFIRMATION',actor_cryptographic_identity:'NOT_CLAIMED',execution_permitted:false,reservation_created:false,worker_started:false};
 const staging=p.publication_root+'.'+randomUUID()+'.tmp';mkdirSync(staging,{mode:0o700});
 // Failed staging is retained as evidence, never mistaken for a committed root.
 writeNew(join(staging,'proposal.json'),p);writeNew(join(staging,'composition.json'),p.composition);writeNew(join(staging,'confirmation.json'),confirmation);
 await validateDomainCurrent(p.composition);read(proposalRef);conflicts(p.publication_root,p.composition);check(!existsSync(p.publication_root),'DOMAIN_PUBLICATION_EXISTS');renameSync(staging,p.publication_root);
 return{composition_ref:ref(join(p.publication_root,'composition.json')),confirmation_ref:ref(join(p.publication_root,'confirmation.json'))};
}
export async function inspectDomainCompositionPublication(pins:DomainPins){
 const c=read(pins.composition_ref) as DomainComposition;
 if((c as any)?.format==='xdev-trusted-composition-1')throw Error('OLD_COMPOSITION_FORMAT_NOT_PRODUCTION_AUTHORITY');
 const r=read(pins.confirmation_ref),p=read(ref(join(dirname(pins.composition_ref.path),'proposal.json'))) as DomainProposal;
 check(dirname(pins.composition_ref.path)===dirname(pins.confirmation_ref.path)&&p.publication_root===dirname(pins.composition_ref.path),'DOMAIN_PUBLICATION_PATH_MISMATCH');
 const {proposal_sha256,...core}=p;
 check(nativeValueHash(core)===proposal_sha256&&same(p.composition,c)&&p.composition_sha256===pins.composition_ref.sha256,'DOMAIN_RECEIPT_PROPOSAL_MISMATCH');
 check(exact(r,['format','proposal_sha256','proposal_bytes_sha256','composition_sha256','composition_id','project_id','domain','budget_root','budget_binding_sha256','valid_until','ack','owner_confirmation','actor_cryptographic_identity','execution_permitted','reservation_created','worker_started'])&&r.format==='xdev-domain-publication-confirmation-1'&&r.proposal_sha256===proposal_sha256&&r.proposal_bytes_sha256===ref(join(p.publication_root,'proposal.json')).sha256&&r.composition_sha256===pins.composition_ref.sha256&&r.composition_id===c.composition_id&&r.project_id===c.project_id&&r.domain===c.domain&&r.budget_root===c.budget_root&&r.budget_binding_sha256===c.budget_binding_sha256&&r.valid_until===c.valid_until&&r.ack===DOMAIN_PUBLICATION_ACK&&r.owner_confirmation==='EXPLICIT_LOCAL_CONFIRMATION'&&r.actor_cryptographic_identity==='NOT_CLAIMED'&&r.execution_permitted===false&&r.reservation_created===false&&r.worker_started===false,'DOMAIN_CONFIRMATION_INVALID');
 const {facts,workspace_root}=await validateDomainCurrent(c);validateRoot(p.publication_root,c,workspace_root);conflicts(p.publication_root,c);check(budgetBindingDigest(read(ref(join(c.budget_root,'binding.json'))))===c.budget_binding_sha256,'DOMAIN_BUDGET_BINDING_DRIFT');return{composition:c,facts,execution_permitted:false as const,reservation_created:false as const,worker_started:false as const};
}
