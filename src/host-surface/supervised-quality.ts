import type { PrimaryProgress } from './primary-next-step.ts';
import { validateTaskContext } from './task-basis.ts';
import { primaryNextStep,projectPrimaryNextStep } from './primary-next-step.ts';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { JobStore, canonical, productionJobRoot } from '../job-runtime/store.ts';
import type { EvidenceRef, Job, JobCommand, JobId } from '../job-runtime/contracts.ts';
import { inspectSupervisedProfile, assertSupervisedWindow } from './supervised-profile.ts';
import { parseD1UniqueJson } from '../job-runtime/contracts.ts';
import { inspectSupervisedPreparation, requireSupervisedPreparation, supervisedPreparationGuidance } from './supervised-preparation.ts';
import { withSupervisedWriterLock, inspectSupervisedWriterCapability } from './supervised-writer-lock.ts';
import { boundaryManifest, validateBoundary, boundaryHealth } from './project-memory-boundary.ts';

// Explicit supervised provenance. This does not authenticate native roles or
// satisfy the historical strict D1 admission/trace protocol.
type FileRef = { path: string; sha256: string };
type Member = { path: string; sha256: string };
type Criterion = { id: string; text: string };
type Command = { id: string; argv: string[]; criteria: string[]; timeout_ms: number; required_output: string[] };
type Request = { format: 'xdev-supervised-request-1'|'xdev-supervised-request-2'|'xdev-supervised-request-3'|'xdev-supervised-request-4'; task_context?:FileRef|null; memory_boundary?:FileRef|null; preparation?:FileRef; profile?:any; authorization?:any; spec: FileRef; allowed_scope: string[]; forbidden_scope: string[];
  acceptance_criteria: Criterion[]; commands: Command[]; excluded_scope: string[] };
type Session = { format: 'xdev-supervised-public-session-1'|'xdev-supervised-public-session-2'; role: 'implementation'|'review'|'qa'; session_ref: string;
  source_claim: 'COORDINATOR_TRANSFERRED_PUBLIC_TOOLS'; native_authenticated: false;
  dispatch_request: FileRef; dispatch_return: FileRef; natural_final: FileRef|null; natural_end: boolean; stop_requested: false;
  qa_continuation?: FileRef; completion_observation?: FileRef|null };
type Subject = { projectRoot: string; controlRoot: string; projectId: string; boundaryHealth?:(ref:FileRef)=>unknown };
function inspectRequestHealth(s:Pick<Subject,'boundaryHealth'>,r:any){if(r.memory_boundary)(s.boundaryHealth??(ref=>boundaryHealth(ref,Date.now()+10000)))(r.memory_boundary);}
function need(v: unknown, why: string): asserts v { if (!v) throw Error(why); }
const sha = (v: string|Buffer) => createHash('sha256').update(v).digest('hex');
const digest = (v: unknown) => sha(canonical(v));
const word = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length < 8192;
const hex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
function exact(v: any, keys: string[]) {
  need(v&&typeof v==='object'&&!Array.isArray(v),'SUPERVISED_SCHEMA_INVALID:object');
  const missing=keys.filter(k=>!Object.hasOwn(v,k)),unknown=Object.keys(v).filter(k=>!keys.includes(k));
  need(!missing.length&&!unknown.length,'SUPERVISED_SCHEMA_INVALID:missing='+missing.join(',')+';unknown='+unknown.join(','));
}
function safePath(path: string) {
  need(isAbsolute(path) && resolve(path) === path, 'SUPERVISED_ABSOLUTE_PATH_REQUIRED');
  const parent = dirname(path); if (parent !== path) safePath(parent);
  if (existsSync(path)) need(!lstatSync(path).isSymbolicLink(), 'SUPERVISED_LINK_REJECTED');
}
function file(path: string) { safePath(path); const s = lstatSync(path); need(s.isFile() && s.nlink === 1 && s.size <= 2*1024*1024, 'SUPERVISED_FILE_INVALID'); return readFileSync(path); }
function readRef(ref: FileRef) { exact(ref, ['path','sha256']); need(word(ref.path) && hex(ref.sha256), 'SUPERVISED_FILE_REF_INVALID'); const bytes = file(ref.path); need(sha(bytes) === ref.sha256, 'SUPERVISED_EVIDENCE_DRIFT'); return bytes.toString('utf8'); }
function json(path: string): any { return parseD1UniqueJson(file(path).toString('utf8')); }
function validRelative(p: unknown): p is string { return word(p) && !isAbsolute(p) && !p.includes('\\') && !p.includes(':') && !p.split('/').some(s => !s || s === '.' || s === '..'); }
function strings(v: unknown): v is string[] { return Array.isArray(v) && v.every(word) && new Set(v).size === v.length; }
export function supervisedManifest(root: string,boundary?:FileRef|null): Member[] {
  if(boundary)return boundaryManifest(root,boundary);
  safePath(root); need(lstatSync(root).isDirectory(), 'SUPERVISED_PROJECT_INVALID'); const out: Member[] = [];
  const visit = (dir: string) => { for (const name of readdirSync(dir).sort()) { const path=join(dir,name), st=lstatSync(path);
    need(!st.isSymbolicLink(), 'SUPERVISED_LINK_REJECTED');
    if (st.isDirectory()) visit(path); else { need(st.isFile(), 'SUPERVISED_MEMBER_INVALID'); out.push({path:relative(root,path).split(sep).join('/'),sha256:sha(file(path))}); }
    need(out.length <= 4096, 'SUPERVISED_PROJECT_TOO_LARGE');
  }}; visit(root); return out.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}
function validateRequest(r: Request,projectId?:string,projectRoot?:string,controlRoot?:string) {
  const v4=r.format==='xdev-supervised-request-4',v3=r.format==='xdev-supervised-request-3'||v4,v2=r.format==='xdev-supervised-request-2'||v3;exact(r,['format','spec','allowed_scope','forbidden_scope','acceptance_criteria','commands','excluded_scope',...(v2?['profile','authorization']:[]),...(v3?['preparation']:[]),...(v4?['task_context','memory_boundary']:[])]);
  need((r.format==='xdev-supervised-request-1'||v2) && strings(r.allowed_scope) && r.allowed_scope.length>0 && r.allowed_scope.every(validRelative) && strings(r.forbidden_scope) && r.forbidden_scope.every(validRelative) && Array.isArray(r.excluded_scope) && r.excluded_scope.length===0, 'SUPERVISED_SCOPE_INVALID');
  const spec=parseD1UniqueJson(readRef(r.spec)) as any;
  need(word(spec.goal)&&canonical(spec.acceptance_criteria)===canonical(r.acceptance_criteria)&&
    canonical(spec.allowed_scope)===canonical(r.allowed_scope)&&canonical(spec.forbidden_scope)===canonical(r.forbidden_scope)&&
    canonical(spec.quality_commands)===canonical(r.commands),'SUPERVISED_SPEC_REQUEST_MISMATCH');
  need(Array.isArray(r.acceptance_criteria) && r.acceptance_criteria.length>0 && r.acceptance_criteria.length<=64, 'SUPERVISED_AC_INVALID');
  for(const c of r.acceptance_criteria){exact(c,['id','text']);need(word(c.id)&&word(c.text),'SUPERVISED_AC_INVALID');}
  need(new Set(r.acceptance_criteria.map(c=>c.id)).size===r.acceptance_criteria.length, 'SUPERVISED_AC_INVALID');
  const ids=r.acceptance_criteria.map(c=>c.id);
  need(Array.isArray(r.commands)&&r.commands.length>0&&r.commands.length<=4,'SUPERVISED_COMMAND_INVALID');
  for(const c of r.commands){exact(c,['id','argv','criteria','timeout_ms','required_output']);
    need(word(c.id)&&Array.isArray(c.argv)&&c.argv.length>0&&c.argv.every(word)&&strings(c.criteria)&&c.criteria.length>0&&c.criteria.every(id=>ids.includes(id))&&Number.isSafeInteger(c.timeout_ms)&&c.timeout_ms>=1&&c.timeout_ms<=60000&&strings(c.required_output)&&c.required_output.length>0,'SUPERVISED_COMMAND_INVALID');
    // Node only, no eval/preload/alternate executable. Every named file is a
    // project member; the frozen Node flags are deliberately narrow.
    need(c.argv.every(a=>a==='--test'||a==='--test-reporter=tap'||(validRelative(a)&&!a.startsWith('-'))) && c.argv.some(a=>validRelative(a)&&!a.startsWith('-')), 'SUPERVISED_COMMAND_INVALID');
    // Only explicit TAP protocol tokens are interpreted, never role/goal prose.
    // Freeze both flags before start's first Store/claim side effect.
    const tap=c.required_output.some(v=>/^(?:TAP version \d+|(?:not )?ok \d+(?:\b|$)|1\.\.\d+(?:\b|$)|# (?:tests|pass|fail) \d+(?:\b|$))/.test(v));
    const firstFile=c.argv.findIndex(a=>a!=='--test'&&a!=='--test-reporter=tap');
    need(!tap||(c.argv.indexOf('--test')>=0&&c.argv.indexOf('--test')<firstFile&&c.argv.indexOf('--test-reporter=tap')>=0&&c.argv.indexOf('--test-reporter=tap')<firstFile),'SUPERVISED_TAP_REPORTER_REQUIRED:commands.'+c.id+'.argv');
  }
  need(new Set(r.commands.map(c=>c.id)).size===r.commands.length && ids.every(id=>r.commands.some(c=>c.criteria.includes(id))), 'SUPERVISED_COMMAND_COVERAGE_MISSING');
  if(v4){
    need(r.task_context!==null||r.memory_boundary!==null,'SUPERVISED_TASK_MATERIAL_REQUIRED');
    if(r.memory_boundary!==null||spec.memory_boundary!==undefined)need(spec.memory_boundary!==undefined&&canonical(spec.memory_boundary)===canonical(r.memory_boundary),'SUPERVISED_SPEC_BOUNDARY_MISMATCH');
    if(r.memory_boundary!==null)validateBoundary(r.memory_boundary!,{projectId:projectId!,projectRoot:projectRoot!,controlRoot});
    if(r.task_context!==null){need(controlRoot,'SUPERVISED_TASK_CONTEXT_REQUIRED');validateTaskContext({projectId:projectId!,projectRoot:projectRoot!,controlRoot},r.task_context!,r.spec,readRef,r);}
  }
  const preparation=v3?requireSupervisedPreparation({projectId:projectId!,projectRoot:projectRoot!},r.preparation!,readRef,r.spec):null;
  const entry=v2?inspectSupervisedProfile(r,spec,readRef,projectId):null;
  return v3?{...entry!,preparation}:entry;
}
// Version 2 is a narrow dot public-tools adapter, not native role authentication.
// Captures are coordinator assertions; both raw final text and public completion
// must agree. No hidden transcript lookup or role-keyword inference is used.
function dotFinal(s: Session): any {
  const f=parseD1UniqueJson(readRef(s.natural_final!)) as any;
  exact(f,['message_type','sender','payload','truncated']);
  need(f.message_type==='FINAL_ANSWER'&&f.sender===s.session_ref&&f.truncated===false&&word(f.payload),'SUPERVISED_FINAL_OWNERSHIP_MISSING');
  need(s.completion_observation,'SUPERVISED_NATURAL_FINAL_REQUIRED');
  const observation=parseD1UniqueJson(readRef(s.completion_observation)) as any;
  need(Array.isArray(observation.agents),'SUPERVISED_DOT_COMPLETION_UNKNOWN');
  const matches=observation.agents.filter((a:any)=>a.agent_name===s.session_ref);
  need(matches.length===1&&matches[0].agent_status?.completed===f.payload,'SUPERVISED_DOT_COMPLETION_UNKNOWN');
  const result=parseD1UniqueJson(f.payload) as any;
  need(result.session_ref===s.session_ref,'SUPERVISED_FINAL_OWNERSHIP_MISSING');
  return result;
}
function dotBinding(c:any,j:Job,manifest:string) {
  return {job_id:j.job_id,task_id:j.tasks[0]!.task_id,spec_sha256:c.request.spec.sha256,
    baseline_manifest_sha256:c.baseline_sha256,candidate_manifest_sha256:manifest};
}
function sessionShape(s:Session,quick=false) {
  need(s&&typeof s==='object','SUPERVISED_SESSION_INVALID:session');
  exact(s,['format','role','session_ref','source_claim','native_authenticated','dispatch_request','dispatch_return','natural_final','natural_end','stop_requested',...(s.format==='xdev-supervised-public-session-2'?['completion_observation']:quick&&s.role==='qa'&&s.qa_continuation?['qa_continuation']:[])]);
}
function dotProof(s:Session,role:Session['role'],completed:boolean,b:any) {
  sessionShape(s);
  need(s.role===role&&/^\/[^\s]+\/[^\s/]+$/.test(s.session_ref)&&s.source_claim==='COORDINATOR_TRANSFERRED_PUBLIC_TOOLS'&&s.native_authenticated===false&&s.stop_requested===false,'SUPERVISED_SESSION_INVALID');
  const req=parseD1UniqueJson(readRef(s.dispatch_request)) as any,ret=parseD1UniqueJson(readRef(s.dispatch_return)) as any;
  need(Object.keys(req).every(k=>['task_name','message','fork_turns','model','reasoning_effort'].includes(k))&&req.fork_turns==='none'&&word(req.message)&&req.task_name===s.session_ref.split('/').at(-1)&&ret.task_name===s.session_ref,'SUPERVISED_DISPATCH_OWNERSHIP_MISSING');
  const marker='XDEV_DOT_ROLE_CONTRACT=',lines=(req.message as string).split(/\r?\n/).filter(l=>l.includes(marker));
  need(lines.length===1&&lines[0]!.startsWith(marker),'SUPERVISED_DOT_ROLE_CONTRACT_REQUIRED');
  const contract=parseD1UniqueJson(lines[0]!.slice(marker.length)) as any;
  exact(contract,['format','role','task_name','job_id','task_id','spec_sha256','candidate_manifest_sha256','writer']);
  need(b&&contract.format==='xdev-dot-role-contract-1'&&contract.role===role&&contract.task_name===req.task_name&&contract.job_id===b.job_id&&contract.task_id===b.task_id&&contract.spec_sha256===b.spec_sha256&&contract.candidate_manifest_sha256===(role==='implementation'?b.baseline_manifest_sha256:b.candidate_manifest_sha256)&&contract.writer===(role==='implementation'),'SUPERVISED_DOT_ROLE_BINDING_MISMATCH');
  if(completed){
    need(s.natural_end===true&&s.natural_final!==null,'SUPERVISED_NATURAL_FINAL_REQUIRED');const f=dotFinal(s);
    need(f.role===role&&f.job_id===b.job_id&&f.task_id===b.task_id&&f.spec_sha256===b.spec_sha256&&f.manifest_sha256===b.candidate_manifest_sha256,'SUPERVISED_DOT_FINAL_BINDING_MISMATCH');
  }else need(s.natural_end===false&&s.natural_final===null&&s.completion_observation===null,'SUPERVISED_QA_MUST_START_BEFORE_FINAL');
  return 'dot-explicit-role-contract';
}
function dotWriters(r:any,impl:string,manifest:string) {
  if(r.session?.format!=='xdev-supervised-public-session-2')return;
  need(r.writer_status,'SUPERVISED_DOT_WRITERS_UNKNOWN');
  const status=parseD1UniqueJson(readRef(r.writer_status)) as any;
  exact(status,['format','job_id','manifest_sha256','scope','unknown_writers','writers','observation']);
  need(status.format==='xdev-dot-public-writers-1'&&status.job_id===r.job_id&&status.manifest_sha256===manifest&&status.scope==='PUBLIC_HOST_ONLY'&&status.unknown_writers===false&&strings(status.writers)&&status.writers.includes(impl),'SUPERVISED_DOT_WRITERS_UNKNOWN');
  const observed=parseD1UniqueJson(readRef(status.observation)) as any;
  need(Array.isArray(observed.agents),'SUPERVISED_DOT_WRITERS_UNKNOWN');
  for(const name of status.writers){const matches=observed.agents.filter((a:any)=>a.agent_name===name);need(matches.length===1&&word(matches[0].agent_status?.completed),'SUPERVISED_DOT_WRITER_ACTIVE_OR_UNKNOWN');}
}
function proof(s: Session, role: Session['role'], completed: boolean, quick=false,binding?:any) {
  if(s.format==='xdev-supervised-public-session-2')return dotProof(s,role,completed,binding);
  sessionShape(s,quick);
  need(s.format==='xdev-supervised-public-session-1'&&s.role===role&&word(s.session_ref)&&s.source_claim==='COORDINATOR_TRANSFERRED_PUBLIC_TOOLS'&&s.native_authenticated===false&&s.stop_requested===false, 'SUPERVISED_SESSION_INVALID');
  const req=parseD1UniqueJson(readRef(s.dispatch_request)) as any, ret=parseD1UniqueJson(readRef(s.dispatch_return)) as any, taskName=s.session_ref.split('/').at(-1)!;
  const type={implementation:'worker',review:'reviewer',qa:'verifier'}[role];
  need((req.agent_type===type||(quick&&role==='review'&&req.agent_type==='verifier'))&&req.task_name===taskName&&ret.task_name===s.session_ref, 'SUPERVISED_DISPATCH_OWNERSHIP_MISSING');
  if(completed){need(s.natural_end===true&&s.natural_final!==null,'SUPERVISED_NATURAL_FINAL_REQUIRED');const final=parseD1UniqueJson(readRef(s.natural_final)) as any;need(final.task_name===s.session_ref&&final.status==='completed'&&final.stop_requested===false&&word(final.final),'SUPERVISED_FINAL_OWNERSHIP_MISSING');}
  else need(s.natural_end===false&&s.natural_final===null,'SUPERVISED_QA_MUST_START_BEFORE_FINAL');
  return req.agent_type as string;
}
function quickEntry(c:any){return ['xdev-supervised-request-2','xdev-supervised-request-3','xdev-supervised-request-4'].includes(c.request.format)&&c.entry?.decision.selected_profile==='quick_verified';}
function checkerSeparation(c:any,id:JobId,impl:string,review:Session,qa:Session,completed:boolean,manifestSha:string){
  need(impl!==review.session_ref&&impl!==qa.session_ref,'SUPERVISED_INDEPENDENCE_REQUIRED');
  if(review.session_ref!==qa.session_ref)return;
  need(review.format!=='xdev-supervised-public-session-2'&&qa.format!=='xdev-supervised-public-session-2','SUPERVISED_INDEPENDENCE_REQUIRED');
  need(quickEntry(c),'SUPERVISED_INDEPENDENCE_REQUIRED');
  need(proof(review,'review',true,true)==='verifier'&&proof(qa,'qa',completed,true)==='verifier'&&
    canonical(review.dispatch_request)===canonical(qa.dispatch_request)&&canonical(review.dispatch_return)===canonical(qa.dispatch_return),'SUPERVISED_QUICK_CHECKER_SOURCE_MISMATCH');
  need(qa.qa_continuation,'SUPERVISED_QA_CONTINUATION_REQUIRED');
  const next=parseD1UniqueJson(readRef(qa.qa_continuation)) as any;
  exact(next,['format','tool','target','job_id','review_final','request','response']);
  need(next.format==='xdev-supervised-qa-continuation-1'&&next.tool==='collaboration.followup_task'&&next.target===qa.session_ref&&next.job_id===id&&canonical(next.review_final)===canonical(review.natural_final),'SUPERVISED_QA_CONTINUATION_MISMATCH');
  const request=parseD1UniqueJson(readRef(next.request)) as any;
  need(request.target===qa.session_ref&&word(request.message),'SUPERVISED_QA_CONTINUATION_MISMATCH');
  const marker='XDEV_QA_RELEASE=',lines=(request.message as string).split(/\r?\n/).filter(line=>line.includes(marker));
  need(lines.length===1&&lines[0]!.startsWith(marker),'SUPERVISED_QA_RELEASE_REQUIRED');
  const release=parseD1UniqueJson(lines[0]!.slice(marker.length)) as any;
  exact(release,['stage','job_id','manifest_sha256','review_final']);
  need(release.stage==='qa'&&release.job_id===id&&release.manifest_sha256===manifestSha&&canonical(release.review_final)===canonical(review.natural_final),'SUPERVISED_QA_RELEASE_MISMATCH');
  readRef(next.response);
  if(completed)need(qa.natural_final?.path!==review.natural_final?.path&&qa.natural_final?.sha256!==review.natural_final?.sha256,'SUPERVISED_DISTINCT_FINALS_REQUIRED');
}
function open(s: Subject) { safePath(s.projectRoot);safePath(s.controlRoot);need(lstatSync(s.controlRoot).isDirectory(),'SUPERVISED_CONTROL_PARENT_REQUIRED');return new JobStore(productionJobRoot(s.controlRoot,s.projectId),{project_id:s.projectId,workspace_root:s.projectRoot}); }
function evidence(store: JobStore, ref: EvidenceRef): any { need(ref.id===join(store.root,'evidence',ref.sha256+'.json'),'SUPERVISED_EVIDENCE_OUTSIDE_STORE');const bytes=file(ref.id);need(sha(bytes)===ref.sha256,'SUPERVISED_EVIDENCE_DRIFT');const value=parseD1UniqueJson(bytes.toString('utf8'));need(canonical(value)+'\n'===bytes.toString('utf8'),'SUPERVISED_EVIDENCE_INVALID');return value; }
function contract(store: JobStore,j: Job) { need(!j.d1_intake&&j.tasks.length===1,'SUPERVISED_JOB_REQUIRED');const c=evidence(store,j.tasks[0]!.contract_ref);need(c.format==='xdev-supervised-contract-1','SUPERVISED_JOB_REQUIRED');const entry=validateRequest(c.request,j.project.project_id,j.project.workspace_root,dirname(store.root));if(entry){need(canonical(entry)===canonical(c.entry),'SUPERVISED_ENTRY_DECISION_DRIFT');const claim=parseD1UniqueJson(readRef(c.start_claim)) as any;need(claim.format==='xdev-supervised-start-consumed-1'&&canonical(claim.authorization_source)===canonical(entry.authorization.source)&&claim.request_sha256===c.source.sha256&&claim.project_id===j.project.project_id&&claim.project_root===j.project.workspace_root,'SUPERVISED_START_CLAIM_MISMATCH');}readRef(c.source);return c; }
function consumeStart(s:Subject,source:string,requestSha:string,entry:any){
  const dir=join(s.controlRoot,'supervised-start-consumed');safePath(dir);if(!existsSync(dir))try{mkdirSync(dir,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}safePath(dir);need(lstatSync(dir).isDirectory(),'SUPERVISED_START_DOMAIN_INVALID');
  const key=digest(entry.authorization.source),path=join(dir,key+'.json');safePath(path);
  const value={format:'xdev-supervised-start-consumed-1',authorization_source:entry.authorization.source,request_path:source,request_sha256:requestSha,project_id:s.projectId,project_root:s.projectRoot,consumed_at:new Date().toISOString(),implementation_limit:1,execution_limit:1,semantics:'ONE_START_NO_RETRY_AFTER_UNKNOWN'};
  const bytes=canonical(value)+'\n';let fd:number;try{fd=openSync(path,'wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw Error('SUPERVISED_AUTHORIZATION_ALREADY_CONSUMED');throw error;}
  // A failed/partial write also consumes the slot. Never delete or repair it.
  try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}return{path,sha256:sha(bytes)};
}
function stages(store: JobStore,j: Job) { return j.tasks[0]!.verification.receipts.map(v=>({ref:v.decision_ref,value:evidence(store,v.decision_ref)})); }
function latest(store: JobStore,j: Job, kind: string) { return stages(store,j).filter(s=>s.value.format===kind).at(-1); }
function mutation(store: JobStore,id: JobId,c: JobCommand) {return store.mutate(id,store.getJob(id).revision,c);}
function scope(c: any,current: Member[]) {const before=new Map<string,string>(c.baseline.map((m:Member)=>[m.path,m.sha256])),after=new Map(current.map(m=>[m.path,m.sha256]));const changed=[...new Set([...before.keys(),...after.keys()])].filter(p=>before.get(p)!==after.get(p));need(changed.every(p=>c.request.allowed_scope.includes(p)&&!c.request.forbidden_scope.some((f:string)=>p===f||p.startsWith(f+'/'))),'SUPERVISED_SCOPE_VIOLATION');return changed;}
function checkManifest(r: any,current: Member[]) {need(hex(r.manifest_sha256)&&r.manifest_sha256===digest(current),'SUPERVISED_VERSION_DRIFT');}
/** Read-only shape/version inspection. It grants no role decision, Job readiness
 * or execution permission; recordSupervised remains the stateful authority. */
export function inspectSupervisedInput(s:Subject,kind:'request'|'record',source:string,requestFormat?:string,quick=false,boundary?:FileRef|null) {
  const r=json(source);
  if(kind==='request') {const entry=validateRequest(r,s.projectId,s.projectRoot,s.controlRoot);inspectRequestHealth(s,r);return {kind,shape_checked:true,entry,role_decision:'NOT_EVALUATED',job_executability:'NOT_EVALUATED'};}
  need(r.format==='xdev-supervised-record-1'&&['implementation','review','qa'].includes(r.role),'SUPERVISED_RECORD_INVALID:format|role');
  const role=r.role;
  const preparationFields=['xdev-supervised-request-3','xdev-supervised-request-4'].includes(requestFormat??'')||r.preparation_conformance!==undefined||r.review_burden_justified!==undefined?['preparation_conformance','review_burden_justified']:[];
  exact(r,['format','job_id','role','session','manifest_sha256',...(r.session?.format==='xdev-supervised-public-session-2'?['writer_status']:[]),...(role==='implementation'?['job_release']:['decision','checks']),...(role==='review'?['scope_pass',...preparationFields]:role==='qa'?['qa_pass','qa_receipt']:[])]);
  need(typeof r.job_id==='string'&&/^job:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(r.job_id),'SUPERVISED_RECORD_INVALID:job_id');
  need(r.session&&r.session.role===role&&['xdev-supervised-public-session-1','xdev-supervised-public-session-2'].includes(r.session.format),'SUPERVISED_SESSION_INVALID:session.role|format');
  sessionShape(r.session,quick);
  for(const key of ['natural_end','stop_requested','native_authenticated'])need(typeof r.session[key]==='boolean','SUPERVISED_BOOLEAN_REQUIRED:session.'+key);
  if(role!=='implementation') {
    need(['PASS','FAIL','BLOCKED'].includes(r.decision)&&Array.isArray(r.checks),'SUPERVISED_DECISION_INCOMPLETE:decision|checks');
    for(const [i,c] of r.checks.entries()){exact(c,['id','passed','reason']);need(word(c.id)&&word(c.reason),'SUPERVISED_DECISION_INCOMPLETE:checks.'+i);need(typeof c.passed==='boolean','SUPERVISED_BOOLEAN_REQUIRED:checks.'+i+'.passed');}
    for(const key of role==='qa'?['qa_pass']:['scope_pass',...preparationFields])need(typeof r[key]==='boolean','SUPERVISED_BOOLEAN_REQUIRED:'+key);
  }
  if(boundary)inspectRequestHealth(s,{memory_boundary:boundary});checkManifest(r,supervisedManifest(s.projectRoot,boundary));
  return {kind,shape_checked:true,manifest_checked:true,role_decision:'NOT_EVALUATED',job_executability:'NOT_EVALUATED',session_proof:'NOT_EVALUATED',record_contract:'JOB_SPECIFIC_REQUIREMENTS_NOT_EVALUATED'};
}
function independentDecision(r: any,c: any) {
  need(['PASS','FAIL','BLOCKED'].includes(r.decision)&&Array.isArray(r.checks)&&r.checks.length===c.request.acceptance_criteria.length,'SUPERVISED_DECISION_INCOMPLETE');
  const ids=c.request.acceptance_criteria.map((a:Criterion)=>a.id);need(new Set(r.checks.map((x:any)=>x.id)).size===ids.length&&r.checks.every((x:any)=>ids.includes(x.id)&&typeof x.passed==='boolean'&&word(x.reason)),'SUPERVISED_DECISION_INCOMPLETE');
  const natural=r.session.format==='xdev-supervised-public-session-2'?dotFinal(r.session):parseD1UniqueJson(readRef(r.session.natural_final)) as any;
  need(natural.decision===r.decision&&canonical(natural.checks)===canonical(r.checks),'SUPERVISED_FINAL_DECISION_MISMATCH');
  if(r.role==='review'){
    need(typeof r.scope_pass==='boolean'&&natural.scope_pass===r.scope_pass,'SUPERVISED_REVIEW_INCOMPLETE');
    if(['xdev-supervised-request-3','xdev-supervised-request-4'].includes(c.request.format))for(const key of ['preparation_conformance','review_burden_justified'])
      need(typeof r[key]==='boolean'&&natural[key]===r[key],'SUPERVISED_REVIEW_PREPARATION_INCOMPLETE');
  }
  else {need(typeof r.qa_pass==='boolean'&&natural.qa_pass===r.qa_pass&&(r.decision==='PASS')===r.qa_pass,'SUPERVISED_QA_DECISION_INVALID');
    if(quickEntry(c)||r.session.format==='xdev-supervised-public-session-2')need(natural.qa_receipt&&r.qa_receipt&&canonical(natural.qa_receipt)===canonical(r.qa_receipt),'SUPERVISED_QA_FINAL_RECEIPT_MISMATCH');}
  return r.decision==='PASS'&&r.checks.every((x:any)=>x.passed)&&
    (r.role!=='review'||!['xdev-supervised-request-3','xdev-supervised-request-4'].includes(c.request.format)||(r.preparation_conformance===true&&r.review_burden_justified===true));
}
function receipt(store: JobStore,j: Job,value: any,outcome: 'VERIFIED'|'PARTIALLY_VERIFIED'|'STALE',checks: {requirement:string;passed:boolean;evidence_refs:EvidenceRef[]}[],expectedRevision?:number) {const ref=store.persistEvidence(value),t=j.tasks[0]!,command:JobCommand={kind:'VERIFICATION',task_id:t.task_id,receipt:{decision_ref:ref,authority_ref:t.contract_ref,subject_generation:t.generation,workspace_head:t.workspace.observed_head,outcome,checks}};if(expectedRevision===undefined)mutation(store,j.job_id,command);else store.mutate(j.job_id,expectedRevision,command);return ref;}
function claimForRun(store: JobStore,j: Job,run: any) {
  const claim=latest(store,j,'xdev-supervised-qa-claim-1');need(claim&&claim.value.job_id===j.job_id&&
    run.value.claim_ref?.id===claim.ref.id&&run.value.claim_ref.sha256===claim.ref.sha256&&
    run.value.session.session_ref===claim.value.session.session_ref&&run.value.manifest_sha256===claim.value.manifest_sha256,
    'SUPERVISED_QA_CLAIM_MISMATCH');return claim;
}

// Recovery only reads the original execution. It never discovers orphan evidence
// as a stage, dispatches a role, or treats a permit as a QA decision.
function checkedQaRun(store:JobStore,j:Job,c:any,run:any,claim:any) {
  claimForRun(store,j,run);const q=json(run.value.source.path);
  need(claim.value.prototype===false&&run.value.prototype===false&&claim.value.job_id===j.job_id&&
    canonical(claim.value.source)===canonical(run.value.source)&&canonical(claim.value.session)===canonical(run.value.session)&&
    q.format==='xdev-supervised-qa-request-1'&&q.job_id===j.job_id&&canonical(q.session)===canonical(run.value.session)&&
    q.manifest_sha256===run.value.manifest_sha256,'SUPERVISED_QA_RUN_SOURCE_MISMATCH');
  readRef(claim.value.source);readRef(run.value.source);
  proof(q.session,'qa',false,quickEntry(c),dotBinding(c,j,run.value.manifest_sha256));
  dotWriters(q,j.runs[0]!.worker_run.worker.worker_id,run.value.manifest_sha256);
  need(Array.isArray(run.value.outputs)&&run.value.outputs.length===c.request.commands.length&&
    run.value.global_descendant_closure==='NOT_CLAIMED','SUPERVISED_QA_OUTPUT_INVALID');
  let all=true;
  for(let i=0;i<c.request.commands.length;i++){
    const cmd=c.request.commands[i],o=run.value.outputs[i];
    exact(o,['id','executable','executable_sha256','argv','cwd','started_at','ended_at','stdout','stderr','stdout_base64','stderr_base64','stdout_sha256','stderr_sha256','stdout_bytes','stderr_bytes','exit_code','signal','error','timeout_ms','output_limit_bytes_per_stream','complete','skipped_or_failed_summary','passed']);
    need(o.id===cmd.id&&canonical(o.argv)===canonical(cmd.argv)&&o.cwd===j.project.workspace_root&&o.timeout_ms===cmd.timeout_ms&&o.output_limit_bytes_per_stream===65536&&
      word(o.executable)&&hex(o.executable_sha256)&&[o.started_at,o.ended_at].every(v=>typeof v==='string'&&Number.isFinite(Date.parse(v)))&&o.ended_at>=o.started_at,'SUPERVISED_QA_OUTPUT_BINDING_MISMATCH');
    safePath(o.executable);const exe=lstatSync(o.executable);need(exe.isFile()&&exe.nlink===1&&exe.size<=256*1024*1024&&sha(readFileSync(o.executable))===o.executable_sha256,'SUPERVISED_QA_RUNTIME_DRIFT');
    for(const stream of ['stdout','stderr']){need(typeof o[stream]==='string'&&typeof o[stream+'_base64']==='string','SUPERVISED_QA_OUTPUT_INVALID');const raw=Buffer.from(o[stream+'_base64'],'base64');
      need(raw.toString('base64')===o[stream+'_base64']&&raw.length===o[stream+'_bytes']&&raw.length<=196608&&sha(raw)===o[stream+'_sha256']&&raw.toString('utf8')===o[stream],'SUPERVISED_QA_OUTPUT_BYTES_MISMATCH');}
    need((o.exit_code===null||Number.isSafeInteger(o.exit_code))&&(o.signal===null||typeof o.signal==='string')&&(o.error===null||typeof o.error==='object'),'SUPERVISED_QA_OUTPUT_INVALID');
    const complete=o.error===null&&o.exit_code!==null&&o.signal===null;
    const skipped=/(?:#|ℹ)\s*(?:skipped|cancelled|todo|fail)\s+[1-9]\d*\b/.test(o.stdout+'\n'+o.stderr);
    const passed=complete&&o.exit_code===0&&!skipped&&cmd.required_output.every((text:string)=>o.stdout.includes(text)||o.stderr.includes(text));
    need(o.complete===complete&&o.skipped_or_failed_summary===skipped&&o.passed===passed,'SUPERVISED_QA_OUTPUT_DECISION_MISMATCH');all=all&&passed;
  }
  need(typeof run.value.passed==='boolean'&&run.value.passed===(all&&run.value.manifest_sha256===run.value.after_manifest_sha256),'SUPERVISED_QA_RUN_DECISION_MISMATCH');
}
function recoveryContext(s:Subject,store:JobStore,j:Job){
  const c=contract(store,j),current=supervisedManifest(s.projectRoot,c.request.memory_boundary),manifest=digest(current);scope(c,current);
  need(c.entry?.decision.selected_profile!=='prototype','SUPERVISED_RECOVERY_PROTOTYPE_UNSUPPORTED');
  need(j.runs.length===1,'SUPERVISED_IMPLEMENTATION_REQUIRED');const implementation=evidence(store,j.runs[0]!.evidence_refs[0]!);
  readRef(implementation.source);readRef(implementation.record.job_release);checkManifest(implementation,current);
  proof(implementation.record.session,'implementation',true,false,dotBinding(c,j,manifest));dotWriters(implementation.record,implementation.record.session.session_ref,manifest);
  const all=stages(store,j);for(const kind of ['xdev-supervised-review-1','xdev-supervised-qa-claim-1','xdev-supervised-qa-run-1','xdev-supervised-qa-final-1'])need(all.filter(x=>x.value.format===kind).length<=1,'SUPERVISED_DUPLICATE_STAGE');
  const review=latest(store,j,'xdev-supervised-review-1'),claim=latest(store,j,'xdev-supervised-qa-claim-1'),run=latest(store,j,'xdev-supervised-qa-run-1'),final=latest(store,j,'xdev-supervised-qa-final-1');
  need(review?.value.passed===true,'SUPERVISED_REVIEW_PASS_REQUIRED');readRef(review.value.source);checkManifest(review.value,current);
  need(review.value.record.session.format===implementation.record.session.format,'SUPERVISED_SESSION_VERSION_MISMATCH');proof(review.value.record.session,'review',true,quickEntry(c),dotBinding(c,j,manifest));dotWriters(review.value.record,implementation.record.session.session_ref,manifest);
  need(independentDecision(review.value.record,c)&&review.value.record.scope_pass===true,'SUPERVISED_REVIEW_PASS_REQUIRED');
  if(claim){readRef(claim.value.source);checkManifest(claim.value,current);proof(claim.value.session,'qa',false,quickEntry(c),dotBinding(c,j,manifest));need(claim.value.prototype===false&&claim.value.job_id===j.job_id,'SUPERVISED_QA_CLAIM_MISMATCH');}
  if(run){need(claim,'SUPERVISED_QA_CLAIM_MISMATCH');checkManifest(run.value,current);checkedQaRun(store,j,c,run,claim);}
  return{c,current,manifest,implementation,review,claim,run,final};
}
function originalQaRecord(s:Subject,store:JobStore,j:Job,ctx:ReturnType<typeof recoveryContext>,source:FileRef){
  readRef(source);inspectSupervisedInput(s,'record',source.path,ctx.c.request.format,quickEntry(ctx.c),ctx.c.request.memory_boundary);const r=json(source.path);
  need(r.role==='qa'&&r.job_id===j.job_id&&ctx.run&&ctx.claim,'SUPERVISED_QA_RECEIPT_MISMATCH');
  proof(r.session,'qa',true,quickEntry(ctx.c),dotBinding(ctx.c,j,ctx.manifest));dotWriters(r,ctx.implementation.record.session.session_ref,ctx.manifest);
  need(r.session.format===ctx.implementation.record.session.format,'SUPERVISED_SESSION_VERSION_MISMATCH');
  checkerSeparation(ctx.c,j.job_id,ctx.implementation.record.session.session_ref,ctx.review!.value.record.session,r.session,true,ctx.manifest);
  need(canonical(r.qa_receipt)===canonical(ctx.run.ref)&&r.session.session_ref===ctx.run.value.session.session_ref,'SUPERVISED_QA_RECEIPT_MISMATCH');
  // Preserve ordinary legacy full-governance's session_ref binding. Quick and
  // public-session-v2 already bind the complete active/completed session pair.
  if(quickEntry(ctx.c)||r.session.format==='xdev-supervised-public-session-2')need(canonical({...r.session,natural_final:null,natural_end:false,...(r.session.format==='xdev-supervised-public-session-2'?{completion_observation:null}:{})})===canonical(ctx.run.value.session),'SUPERVISED_QA_SESSION_MISMATCH');
  const decisionPass=independentDecision(r,ctx.c);return{r,passed:ctx.run.value.passed===true&&decisionPass&&r.qa_pass===true};
}
type FinalExpected={revision:number;head_sha256:string};
const recoveryFields=['job_id','task_id','spec_sha256','manifest_sha256','operation_key','claim_ref','qa_receipt','qa_request','original_request','record','expected_revision','expected_head_sha256'];
function recoveryPermit(s:Subject,j:Job,ctx:ReturnType<typeof recoveryContext>,request:any,currentWindow:boolean){
  exact(request,['format','operation',...recoveryFields,'permit']);need(request.format==='xdev-supervised-recovery-request-1'&&request.operation==='ORIGINAL_FINAL_REPLAY','SUPERVISED_RECOVERY_REQUEST_INVALID');
  const p=parseD1UniqueJson(readRef(request.permit)) as any;
  exact(p,['format','operation','source_claim','project_id','project_root','control_root',...recoveryFields,'not_before','expires_at','stop','revoked','logical_completion_limit','execute_qa']);
  need(p.format==='xdev-supervised-recovery-permit-1'&&p.operation==='ORIGINAL_FINAL_REPLAY'&&p.source_claim==='COORDINATOR_RECORDED_CURRENT_RECOVERY_AUTHORIZATION'&&p.project_id===s.projectId&&p.project_root===s.projectRoot&&p.control_root===s.controlRoot&&p.execute_qa===false&&p.logical_completion_limit===1&&typeof p.stop==='boolean'&&typeof p.revoked==='boolean','SUPERVISED_RECOVERY_PERMIT_INVALID');
  for(const k of recoveryFields)need(canonical(p[k])===canonical(request[k]),'SUPERVISED_RECOVERY_PERMIT_BINDING_MISMATCH');
  need(ctx.claim&&ctx.run&&request.job_id===j.job_id&&request.task_id===j.tasks[0]!.task_id&&request.spec_sha256===ctx.c.request.spec.sha256&&request.manifest_sha256===ctx.manifest&&request.operation_key===ctx.claim.ref.sha256&&canonical(request.claim_ref)===canonical(ctx.claim.ref)&&canonical(request.qa_receipt)===canonical(ctx.run.ref)&&canonical(request.qa_request)===canonical(ctx.run.value.source)&&canonical(request.original_request)===canonical(ctx.c.source)&&Number.isSafeInteger(request.expected_revision)&&request.expected_revision>=0&&hex(request.expected_head_sha256),'SUPERVISED_RECOVERY_BINDING_MISMATCH');
  need([p.not_before,p.expires_at].every(v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)).toISOString()===v)&&p.not_before<p.expires_at,'SUPERVISED_RECOVERY_WINDOW_INVALID');
  if(currentWindow)need(!p.stop&&!p.revoked&&Date.now()>=Date.parse(p.not_before)&&Date.now()<Date.parse(p.expires_at),'SUPERVISED_RECOVERY_STOP_EXPIRED_OR_REVOKED');
  return p;
}
function finalizeQa(s:Subject,id:JobId,source:FileRef,expected:FinalExpected,recovery?:{request:any;source:FileRef;guard:()=>void}){
  const store=open(s);
  const replay=(view:{job:Job},ctx:ReturnType<typeof recoveryContext>)=>{
    if(!ctx.final)return false;
    originalQaRecord(s,store,view.job,ctx,source);
    const key=ctx.claim!.ref.sha256,requestDigest=source.sha256;
    if(recovery){recovery.guard();readRef(recovery.source);recoveryPermit(s,view.job,ctx,recovery.request,false);need(ctx.run!.value.passed===true,'SUPERVISED_RECOVERY_QA_NOT_PASSED');}
    const f=ctx.final.value;readRef(f.source);originalQaRecord(s,store,view.job,ctx,f.source);
    need((f.finalization?.operation_key??key)===key&&(f.finalization?.request_digest??f.source.sha256)===requestDigest,'SUPERVISED_FINAL_IDEMPOTENCY_CONFLICT');
    if(recovery&&f.finalization)need(f.finalization.expected_revision===expected.revision&&f.finalization.expected_head_sha256===expected.head_sha256,'SUPERVISED_FINAL_CAS_MISMATCH');
    need(f.passed!==true||view.job.state==='VERIFIED','SUPERVISED_FINAL_PARTIAL_COMMIT_BLOCKED');
    return true;
  };
  // A fully committed same-operation replay is pure inspection, including when
  // a crashed legacy process left an unknown directory lock. No evidence write.
  if(store.inspectSupervisedFinalReplay(id,view=>replay(view,recoveryContext(s,store,view.job))))return querySupervised(s,id);
  store.withSupervisedFinal(id,view=>{
    const ctx=recoveryContext(s,store,view.job),original=originalQaRecord(s,store,view.job,ctx,source),key=ctx.claim!.ref.sha256,requestDigest=source.sha256;
    if(recovery){recovery.guard();readRef(recovery.source);recoveryPermit(s,view.job,ctx,recovery.request,false);need(ctx.run!.value.passed===true,'SUPERVISED_RECOVERY_QA_NOT_PASSED');}
    if(replay(view,ctx)){
      return{expected_revision:expected.revision,expected_head_sha256:expected.head_sha256,commands:[],result:null,revalidate:()=>{}};
    }
    need(view.revision===expected.revision&&view.head_sha256===expected.head_sha256,'SUPERVISED_FINAL_CAS_MISMATCH');
    need(view.job.tasks[0]!.state==='TESTING'&&!view.job.cancellation_requested,'SUPERVISED_FINAL_STATE_BLOCKED');
    const revalidate=()=>{const fresh=recoveryContext(s,store,view.job);originalQaRecord(s,store,view.job,fresh,source);
      if(recovery){recovery.guard();readRef(recovery.source);recoveryPermit(s,view.job,fresh,recovery.request,true);need(fresh.run!.value.passed===true,'SUPERVISED_RECOVERY_QA_NOT_PASSED');}else assertSupervisedWindow(fresh.c.entry);};
    revalidate();const value={format:'xdev-supervised-qa-final-1',record:original.r,source,manifest_sha256:ctx.manifest,passed:original.passed,qa_receipt:ctx.run!.ref,
      finalization:{format:'xdev-supervised-finalization-1',operation:'QA_ORIGINAL_FINAL',operation_key:key,request_digest:requestDigest,expected_revision:expected.revision,expected_head_sha256:expected.head_sha256,submission:recovery?'RECOVERY':'NORMAL_RECORD',recovery_permit:recovery?.request.permit??null}};
    const finalRef=store.persistEvidence(value),t=view.job.tasks[0]!,commands:JobCommand[]=[{kind:'VERIFICATION',task_id:t.task_id,receipt:{decision_ref:finalRef,authority_ref:t.contract_ref,subject_generation:t.generation,workspace_head:t.workspace.observed_head,outcome:original.passed?'VERIFIED':'STALE',checks:[{requirement:'review',passed:true,evidence_refs:[ctx.review!.ref]},{requirement:'qa-execution',passed:original.passed,evidence_refs:original.passed?[ctx.run!.ref]:[]},{requirement:'qa-session',passed:true,evidence_refs:[finalRef]}]}}];
    if(original.passed)commands.push({kind:'TASK_STATE',task_id:t.task_id,state:'VERIFIED'},{kind:'JOB_STATE',state:'VERIFYING',result_refs:[]},{kind:'JOB_STATE',state:'INTEGRATING',result_refs:[]},{kind:'JOB_STATE',state:'VERIFIED',result_refs:[finalRef]});
    return{expected_revision:expected.revision,expected_head_sha256:expected.head_sha256,commands,result:null,revalidate};
  },fn=>withSupervisedWriterLock(store.root,id,fn));
  return querySupervised(s,id);
}
export function recoverSupervisedQa(s:Subject,id:JobId,source:string,guard:()=>void=()=>{}){
  const sourceRef={path:source,sha256:sha(file(source))},request=json(source);guard();
  need(request.job_id===id,'SUPERVISED_RECOVERY_BINDING_MISMATCH');
  readRef(request.record);return finalizeQa(s,id,request.record,{revision:request.expected_revision,head_sha256:request.expected_head_sha256},{request,source:sourceRef,guard});
}
export function inspectSupervisedRecovery(s:Subject,id:JobId,record?:FileRef){
  const base={format:'xdev-supervised-recovery-status-1',job_id:id,execution_allowed:false,claim_reset:false,qa_rerun_allowed:false,native_identity_authenticated:false,global_descendant_closure:'NOT_CLAIMED'};
  let expected_revision:number|null=null,expected_head_sha256:string|null=null,refs:any=null,execution_status='NOT_KNOWN';
  try{const store=open(s),view=store.inspectD1Journal(id);expected_revision=view.revision;expected_head_sha256=view.head_sha256;
    const ctx=recoveryContext(s,store,view.job);refs={task_id:view.job.tasks[0]!.task_id,spec_sha256:ctx.c.request.spec.sha256,manifest_sha256:ctx.manifest,original_request:ctx.c.source,qa_request:ctx.run?.value.source??ctx.claim?.value.source??null,claim_ref:ctx.claim?.ref??null,qa_receipt:ctx.run?.ref??null,operation_key:ctx.claim?.ref.sha256??null};
    execution_status=ctx.run?(ctx.run.value.passed?'PASSED_PERSISTED':'FAILED_OR_INCOMPLETE'):ctx.claim?'UNKNOWN_CLAIM_ONLY':'NOT_CLAIMED';
    if(ctx.final){originalQaRecord(s,store,view.job,ctx,ctx.final.value.source);need(ctx.final.value.passed!==true||view.job.state==='VERIFIED','SUPERVISED_FINAL_PARTIAL_COMMIT_BLOCKED');return{...base,status:'ALREADY_FINALIZED',execution_status,closure_status:'ORIGINAL_FINAL_RECORDED',recovery_status:'READ_ONLY_RECONCILED',expected_revision,expected_head_sha256,final_expected:ctx.final.value.finalization??null,refs,missing_items:[],next_steps:[],delivery_allowed:querySupervised(s,id).delivery_allowed};}
    need(ctx.run?.value.passed===true,ctx.run?'SUPERVISED_RECOVERY_QA_NOT_PASSED':ctx.claim?'SUPERVISED_RECOVERY_CLAIM_ONLY_UNKNOWN':'SUPERVISED_RECOVERY_QA_NOT_RUN');
    if(!record)return{...base,status:'ORIGINAL_QA_FINAL_UNAVAILABLE',execution_status,closure_status:'ORIGINAL_FINAL_UNAVAILABLE',recovery_status:'BLOCKED',expected_revision,expected_head_sha256,refs,missing_items:['original_record','original_qa_natural_final','original_completion_observation_if_v2','writer_status_if_v2'],next_steps:['Obtain the original QA final and completion observation from that same session. If unavailable, keep BLOCKED; do not substitute a signer, rerun QA, or reset the claim.'],delivery_allowed:false};
    const original=originalQaRecord(s,store,view.job,ctx,record);return{...base,status:'READY_FOR_ORIGINAL_FINAL_REPLAY',execution_status,closure_status:'ORIGINAL_FINAL_AND_COMPLETION_CHECKED',recovery_status:'NEW_EXPLICIT_PERMIT_REQUIRED',original_decision:original.r.decision,expected_revision,expected_head_sha256,refs,missing_items:['current_recovery_permit'],next_steps:['Authorize one ORIGINAL_FINAL_REPLAY for these exact refs and head, then use recover-qa or the dedicated MCP recovery tool.'],delivery_allowed:false};
  }catch(e){return{...base,status:'BLOCKED',execution_status,closure_status:'NOT_PROVEN',recovery_status:'BLOCKED',expected_revision,expected_head_sha256,refs,missing_items:[e instanceof Error?e.message:String(e)],next_steps:['Preserve evidence and resolve the named missing or inconsistent original source; no automatic QA retry or replacement final.'],delivery_allowed:false};}
}

export function startSupervised(s: Subject, source: string) {
  const bytes=file(source),request=json(source) as Request;const entry=validateRequest(request,s.projectId,s.projectRoot,s.controlRoot);assertSupervisedWindow(entry);inspectRequestHealth(s,request);const baseline=supervisedManifest(s.projectRoot,request.memory_boundary),store=open(s);
  const startClaim=entry?consumeStart(s,source,sha(bytes),entry):null;
  const value={format:'xdev-supervised-contract-1',source:{path:source,sha256:sha(bytes)},request,baseline,baseline_sha256:digest(baseline),...(entry?{entry,start_claim:startClaim}:{})};
  const encoded=canonical(value)+'\n',ref={id:join(store.root,'evidence',sha(encoded)+'.json'),sha256:sha(encoded)},controls={budget_ref:ref,control_ref:ref,allocation_ref:ref};
  const created=store.createJob({tasks:[{key:'supervised-code-quality',contract_ref:ref,dependency_keys:[],workspace:{workspace_id:s.projectId,repository_id:s.projectId,base_revision:digest(baseline),branch_ref:null,worktree_ref:null,observed_head:digest(baseline),allowed_scope_ref:ref,forbidden_scope_ref:ref,mutability:'MUTABLE'},verification_required:entry?.decision.selected_profile==='prototype'?['implementation','self-check']:['review','qa-execution','qa-session'],control_refs:controls}],control_refs:controls,handoff_refs:[],context_pack_refs:[]},-1);
  store.persistEvidence(value);mutation(store,created.job_id,{kind:'JOB_STATE',state:'PLANNING',result_refs:[]});
  return currentProgressResult(s,created.job_id,{...created,task_id:store.getJob(created.job_id).tasks[0]!.task_id,revision:store.getJob(created.job_id).revision,mode:'supervised',entry,preparation_verified:['xdev-supervised-request-3','xdev-supervised-request-4'].includes(request.format),baseline_sha256:digest(baseline),next_host_action:{role:'implementation',action:'DISPATCH_SEPARATE_PUBLIC_WORKER_THEN_RECORD_NATURAL_FINAL'},strict_d1_pass:false});
}
export function recordSupervised(s: Subject,id: JobId,source: string) {
  const store=open(s),view=store.inspectD1Journal(id),j=view.job,c=contract(store,j),r=json(source),sourceRef={path:source,sha256:sha(file(source))};
  inspectRequestHealth(s,c.request);
  if(r.role==='qa'){need(c.entry?.decision.selected_profile!=='prototype','SUPERVISED_PROTOTYPE_NO_FORMAL_RECORD');return finalizeQa(s,id,{path:source,sha256:sha(file(source))},{revision:view.revision,head_sha256:view.head_sha256});}
  const inspect=(job:Job)=>{
    const c=contract(store,job),current=supervisedManifest(s.projectRoot,c.request.memory_boundary),t=job.tasks[0]!;
    need(sha(file(source))===sourceRef.sha256&&canonical(json(source))===canonical(r),'SUPERVISED_RECORD_ORIGINAL_SOURCE_DRIFT');
    need(!(r.session?.format==='xdev-supervised-public-session-2'&&c.entry?.decision.selected_profile==='prototype'),'SUPERVISED_DOT_PROTOTYPE_UNSUPPORTED');
    need(r.format==='xdev-supervised-record-1'&&r.job_id===id&&['implementation','review'].includes(r.role),'SUPERVISED_RECORD_INVALID');
    proof(r.session,r.role,true,quickEntry(c),dotBinding(c,job,digest(current)));dotWriters(r,job.runs[0]?.worker_run.worker.worker_id??r.session.session_ref,digest(current));scope(c,current);checkManifest(r,current);
    need(c.entry?.decision.selected_profile!=='prototype'||r.role==='implementation','SUPERVISED_PROTOTYPE_NO_FORMAL_RECORD');
    if(r.role==='implementation'){
      const release=parseD1UniqueJson(readRef(r.job_release)) as any;need(release.job_id===id&&release.task_name===r.session.session_ref&&word(release.message),'SUPERVISED_JOB_RELEASE_MISSING');
    }else{
      const impl=job.runs[0]?.worker_run.worker.worker_id;need(impl&&impl!==r.session.session_ref,'SUPERVISED_INDEPENDENCE_REQUIRED');
      const implementation=evidence(store,job.runs[0]!.evidence_refs[0]!);need(r.session.format===implementation.record.session.format,'SUPERVISED_SESSION_VERSION_MISMATCH');checkManifest(implementation,current);proof(implementation.record.session,'implementation',true,false,dotBinding(c,job,digest(current)));readRef(implementation.source);
    }
    return{c,current,t};
  };
  const original=(value:any)=>need(canonical(value.source)===canonical(sourceRef)&&canonical(value.record)===canonical(r)&&value.manifest_sha256===r.manifest_sha256,'SUPERVISED_RECORD_IDEMPOTENCY_CONFLICT');
  const implementationResult=(job:Job,ref:EvidenceRef,replayed:boolean)=>({job_id:id,manifest_sha256:r.manifest_sha256,implementation_ref:ref,replayed,
    next_host_action:job.tasks[0]!.state==='REVIEWING'&&!latest(store,job,'xdev-supervised-review-1')?(c.entry?.decision.selected_profile==='prototype'?{role:'implementation',action:'RUN_SELF_CHECK_CLI'}:quickEntry(c)&&r.session.format!=='xdev-supervised-public-session-2'?{role:'review',action:'DISPATCH_INDEPENDENT_REVIEW',allowed_agent_types:['reviewer','verifier'],same_verifier_may_continue_qa:true}:{role:'review',action:'DISPATCH_INDEPENDENT_REVIEW'}):null,strict_d1_pass:false});
  const reviewResult=(job:Job,ref:EvidenceRef,passed:boolean,replayed:boolean)=>({job_id:id,review_passed:passed,review_ref:ref,replayed,
    next_host_action:passed&&job.tasks[0]!.state==='TESTING'&&!latest(store,job,'xdev-supervised-qa-claim-1')?(quickEntry(c)&&r.session.format!=='xdev-supervised-public-session-2'?{role:'qa',action:'CONTINUE_VERIFIER_OR_DISPATCH_INDEPENDENT_QA_TO_EXECUTE_CLI',same_verifier_may_continue:proof(r.session,'review',true,true,dotBinding(c,job,r.manifest_sha256))==='verifier',distinct_natural_final_required:true}:{role:'qa',action:'DISPATCH_DIFFERENT_QA_TO_EXECUTE_CLI'}):null,strict_d1_pass:false});
  const completed=(job:Job,replayed=true):ReturnType<typeof implementationResult>|ReturnType<typeof reviewResult>|null=>{
    const {t}=inspect(job);
    if(r.role==='implementation'){
      const run=job.runs[0];if(!run)return null;need(job.runs.length===1,'SUPERVISED_IMPLEMENTATION_ALREADY_RECORDED');
      need(run.evidence_refs[0],'SUPERVISED_IMPLEMENTATION_ORIGINAL_RECORD_UNAVAILABLE');const value=evidence(store,run.evidence_refs[0]!);need(value.format==='xdev-supervised-implementation-1','SUPERVISED_IMPLEMENTATION_ORIGINAL_RECORD_UNAVAILABLE');original(value);
      return run.state==='SUCCEEDED'&&['REVIEWING','TESTING','VERIFIED'].includes(t.state)?implementationResult(job,run.evidence_refs[0]!,replayed):null;
    }
    const saved=latest(store,job,'xdev-supervised-review-1');if(!saved)return null;original(saved.value);
    const passed=r.scope_pass===true&&independentDecision(r,c);need(saved.value.passed===passed,'SUPERVISED_RECORD_IDEMPOTENCY_CONFLICT');
    if(passed&&t.state==='REVIEWING')return null;
    need(!passed||['TESTING','VERIFIED'].includes(t.state),'SUPERVISED_REVIEW_PARTIAL_STATE_BLOCKED');return reviewResult(job,saved.ref,passed,replayed);
  };
  let replay:ReturnType<typeof completed>=null;
  if(store.inspectSupervisedRecordReplay(id,v=>{replay=completed(v.job);return replay!==null;}))return currentProgressResult(s,id,replay!);
  const result=store.withSupervisedRecord(id,fresh=>{
    const done=completed(fresh.job);if(done)return{role:r.role,expected_revision:view.revision,expected_head_sha256:view.head_sha256,commands:[],result:done,revalidate:()=>{}};
    need(fresh.revision===view.revision&&fresh.head_sha256===view.head_sha256,'SUPERVISED_RECORD_CAS_MISMATCH');
    const {c,current,t}=inspect(fresh.job);assertSupervisedWindow(c.entry);
    const revalidate=()=>{const value=inspect(fresh.job);assertSupervisedWindow(value.c.entry);};
    let commands:JobCommand[]=[];
    if(r.role==='implementation'){
      const old=fresh.job.runs[0];let ref:EvidenceRef,run_id:`run:${string}`;
      if(!old){
        need(t.state==='PENDING','SUPERVISED_IMPLEMENTATION_ORIGINAL_RECORD_UNAVAILABLE');
        ref=store.persistEvidence({format:'xdev-supervised-implementation-1',record:r,source:sourceRef,manifest:current,manifest_sha256:digest(current)});run_id=`run:${randomUUID()}`;
        commands=[{kind:'TASK_STATE',task_id:t.task_id,state:'READY'},{kind:'INTENT',task_id:t.task_id,run_id,intent_id:randomUUID(),attempt:'INITIAL',worker_run:{worker:{worker_id:r.session.session_ref,adapter_id:'supervised-public-session'},adapter_metadata:{provenance:'COORDINATOR_TRANSFERRED_PUBLIC_TOOLS'}}},{kind:'RUN_OBSERVATION',run_id,state:'ACTIVE',evidence_refs:[ref],reconciliation_ref:null},{kind:'TASK_STATE',task_id:t.task_id,state:'RUNNING'},{kind:'RUN_OBSERVATION',run_id,state:'SUCCEEDED',evidence_refs:[ref],reconciliation_ref:null},{kind:'TASK_STATE',task_id:t.task_id,state:'REVIEWING'}];
      }else{
        need(old.evidence_refs[0],'SUPERVISED_IMPLEMENTATION_ORIGINAL_RECORD_UNAVAILABLE');ref=old.evidence_refs[0]!;original(evidence(store,ref));run_id=old.run_id;
        need((t.state==='READY'&&old.state==='ACTIVE')||(t.state==='RUNNING'&&['ACTIVE','SUCCEEDED'].includes(old.state)),'SUPERVISED_IMPLEMENTATION_PARTIAL_STATE_BLOCKED');
        if(t.state==='READY')commands.push({kind:'TASK_STATE',task_id:t.task_id,state:'RUNNING'});
        if(old.state==='ACTIVE')commands.push({kind:'RUN_OBSERVATION',run_id,state:'SUCCEEDED',evidence_refs:[ref],reconciliation_ref:null});
        commands.push({kind:'TASK_STATE',task_id:t.task_id,state:'REVIEWING'});
      }
    }else{
      const saved=latest(store,fresh.job,'xdev-supervised-review-1');
      if(saved){original(saved.value);need(saved.value.passed===true&&r.scope_pass===true&&independentDecision(r,c)&&t.state==='REVIEWING','SUPERVISED_REVIEW_ALREADY_RECORDED');commands=[{kind:'TASK_STATE',task_id:t.task_id,state:'TESTING'}];}
      else{
        need(t.state==='REVIEWING','SUPERVISED_REVIEW_ALREADY_RECORDED');
        const passed=independentDecision(r,c)&&r.scope_pass===true;
        const value={format:'xdev-supervised-review-1',record:r,source:sourceRef,manifest_sha256:digest(current),passed};
        const ref=store.persistEvidence(value);
        commands=[{kind:'VERIFICATION',task_id:t.task_id,receipt:{decision_ref:ref,authority_ref:t.contract_ref,subject_generation:t.generation,workspace_head:t.workspace.observed_head,outcome:passed?'PARTIALLY_VERIFIED':'STALE',checks:[{requirement:'review',passed,evidence_refs:passed?[ref]:[]}]}}];
        if(passed)commands.push({kind:'TASK_STATE',task_id:t.task_id,state:'TESTING'});
      }
    }
    return{role:r.role,expected_revision:view.revision,expected_head_sha256:view.head_sha256,commands,result:null,revalidate};
  },c.entry?.decision.selected_profile==='prototype'?undefined:fn=>withSupervisedWriterLock(store.root,id,fn));
  return currentProgressResult(s,id,result??completed(store.getJob(id),false)!);
}
export function qaSupervised(s: Subject,id: JobId,source: string,selfCheck=false) {
  const store=open(s),j=store.getJob(id),c=contract(store,j),r=json(source),current=supervisedManifest(s.projectRoot,c.request.memory_boundary),review=latest(store,j,'xdev-supervised-review-1');
  inspectRequestHealth(s,c.request);
  const prototype=c.entry?.decision.selected_profile==='prototype';need(!(prototype&&r.session?.format==='xdev-supervised-public-session-2'),'SUPERVISED_DOT_PROTOTYPE_UNSUPPORTED');need(prototype===selfCheck,'SUPERVISED_PROFILE_EXECUTION_MISMATCH');assertSupervisedWindow(c.entry);
  if(!prototype&&review)need(independentDecision(review.value.record,c)&&review.value.record.scope_pass===true,'SUPERVISED_REVIEW_PASS_REQUIRED');
  need(r.format===(prototype?'xdev-supervised-self-check-request-1':'xdev-supervised-qa-request-1')&&r.job_id===id&&(prototype?j.tasks[0]!.state==='REVIEWING':j.tasks[0]!.state==='TESTING'&&review?.value.passed===true),'SUPERVISED_REVIEW_PASS_REQUIRED');proof(r.session,prototype?'implementation':'qa',prototype,quickEntry(c),dotBinding(c,j,digest(current)));dotWriters(r,j.runs[0]!.worker_run.worker.worker_id,digest(current));checkManifest(r,current);scope(c,current);
  if(prototype)need(r.session.session_ref===j.runs[0]!.worker_run.worker.worker_id,'SUPERVISED_INDEPENDENCE_REQUIRED');else checkerSeparation(c,id,j.runs[0]!.worker_run.worker.worker_id,review!.value.record.session,r.session,false,digest(current));
  const implementation=evidence(store,j.runs[0]!.evidence_refs[0]!);need(r.session.format===implementation.record.session.format,'SUPERVISED_SESSION_VERSION_MISMATCH');readRef(implementation.source);proof(implementation.record.session,'implementation',true,false,dotBinding(c,j,digest(current)));readRef(implementation.record.job_release);checkManifest(implementation,current);
  need(!latest(store,j,'xdev-supervised-qa-claim-1')&&!latest(store,j,'xdev-supervised-qa-run-1'),'SUPERVISED_QA_ALREADY_CLAIMED');if(!prototype){proof(review!.value.record.session,'review',true,quickEntry(c),dotBinding(c,j,digest(current)));readRef(review!.value.source);checkManifest(review!.value,current);
    const writer=inspectSupervisedWriterCapability(store.root,id);need(writer.status==='SUPPORTED',writer.status==='UNSUPPORTED'?writer.code:'SUPERVISED_WRITER_CAPABILITY_UNAVAILABLE');}
  // The original revision is the atomic compare-and-append boundary. Never
  // refresh it after checking for a claim. A crash consumes this Job's QA slot.
  const priorCheck=prototype?{requirement:'implementation',passed:true,evidence_refs:[j.runs[0]!.evidence_refs[0]!]}:{requirement:'review',passed:true,evidence_refs:[review!.ref]};
  const claim={format:'xdev-supervised-qa-claim-1',prototype,job_id:id,claim_id:randomUUID(),session:r.session,
    source:{path:source,sha256:sha(file(source))},manifest_sha256:digest(current),expected_revision:j.revision,claimed_at:new Date().toISOString(),review_ref:review?.ref??null};
  const claimRef=receipt(store,j,claim,'PARTIALLY_VERIFIED',[priorCheck],j.revision);
  const outputs=c.request.commands.map((cmd:Command)=>{assertSupervisedWindow(c.entry,cmd.timeout_ms);const started_at=new Date().toISOString(),result=spawnSync(process.execPath,cmd.argv,{cwd:s.projectRoot,shell:false,windowsHide:true,encoding:'buffer',timeout:cmd.timeout_ms,maxBuffer:65536}),ended_at=new Date().toISOString();
    const stdout=(result.stdout??Buffer.alloc(0)).toString('utf8'),stderr=(result.stderr??Buffer.alloc(0)).toString('utf8');const complete=!result.error&&result.status!==null&&result.signal===null;
    const skipped=/(?:#|ℹ)\s*(?:skipped|cancelled|todo|fail)\s+[1-9]\d*\b/.test(stdout+'\n'+stderr);
    return {id:cmd.id,executable:process.execPath,executable_sha256:sha(readFileSync(process.execPath)),argv:cmd.argv,cwd:s.projectRoot,started_at,ended_at,stdout,stderr,stdout_base64:(result.stdout??Buffer.alloc(0)).toString('base64'),stderr_base64:(result.stderr??Buffer.alloc(0)).toString('base64'),stdout_sha256:sha(result.stdout??Buffer.alloc(0)),stderr_sha256:sha(result.stderr??Buffer.alloc(0)),stdout_bytes:result.stdout?.length??0,stderr_bytes:result.stderr?.length??0,exit_code:result.status,signal:result.signal,error:result.error?{code:(result.error as NodeJS.ErrnoException).code??null,message:result.error.message}:null,timeout_ms:cmd.timeout_ms,output_limit_bytes_per_stream:65536,complete,skipped_or_failed_summary:skipped,passed:complete&&result.status===0&&!skipped&&cmd.required_output.every((text:string)=>stdout.includes(text)||stderr.includes(text))};});
  contract(store,j); // Recheck imported materials after command execution.
  inspectRequestHealth(s,c.request);const after=supervisedManifest(s.projectRoot,c.request.memory_boundary),passed=digest(current)===digest(after)&&outputs.every((o:any)=>o.passed);
  const value={format:'xdev-supervised-qa-run-1',prototype,claim_ref:claimRef,session:r.session,source:{path:source,sha256:sha(file(source))},manifest_sha256:digest(current),after_manifest_sha256:digest(after),outputs,passed,global_descendant_closure:'NOT_CLAIMED'};
  const ref=store.persistEvidence(value);receipt(store,j,value,'PARTIALLY_VERIFIED',[priorCheck,{requirement:prototype?'self-check':'qa-execution',passed,evidence_refs:passed?[ref]:[]}],j.revision+1);
  return currentProgressResult(s,id,{job_id:id,qa_receipt:ref,commands_passed:passed,delivery_allowed:false,next_host_action:prototype?null:{role:'qa',action:'AWAIT_NATURAL_FINAL_THEN_RECORD_QA'},status:prototype?'PROTOTYPE_UNVERIFIED':'QA_EXECUTED_PENDING_FINAL',strict_d1_pass:false});
}
export function querySupervised(s: Subject,id: JobId) {
  const store=open(s),j=store.getJob(id);let reasons:string[]=[],version:string|null=null,entry:any=null,prototype=false,selfCheckState='NOT_RUN';
  let progress:PrimaryProgress={binding:'UNKNOWN',persisted_state:j.state,profile:null,authorization:'UNKNOWN',permissions:{source:'CORE_CONTRACT_NO_ADDITIONAL_LOCAL_GATE',write_jobs:true,execute_qa:true},implementation_recorded:null,review_recorded:null,review_passed:null,qa_claimed:null,qa_run:'UNKNOWN',qa_final_recorded:null,delivery_verified:null};
  try{const c=contract(store,j);inspectRequestHealth(s,c.request);const current=supervisedManifest(s.projectRoot,c.request.memory_boundary);entry=c.entry??null;prototype=entry?.decision.selected_profile==='prototype';version=digest(current);scope(c,current);
    progress.profile=entry?.decision.selected_profile??null;try{assertSupervisedWindow(entry);progress.authorization=entry?'CURRENT':'UNKNOWN';}catch{progress.authorization='STOPPED_OR_EXPIRED';}
    if(j.runs.length===0){need(stages(store,j).length===0,'SUPERVISED_STAGE_WITHOUT_IMPLEMENTATION');progress={...progress,binding:'CHECKED',implementation_recorded:false,review_recorded:false,review_passed:null,qa_claimed:false,qa_run:'NOT_RUN',qa_final_recorded:false};}
    let reviewed:boolean|null=null;
    need(j.runs.length===1,'IMPLEMENTATION_MISSING');const impl=evidence(store,j.runs[0]!.evidence_refs[0]!);readRef(impl.source);readRef(impl.record.job_release);proof(impl.record.session,'implementation',true,false,dotBinding(c,j,digest(current)));dotWriters(impl.record,impl.record.session.session_ref,digest(current));checkManifest(impl,current);
     for(const stage of stages(store,j)){readRef(stage.value.source);checkManifest(stage.value,current);if(stage.value.record?.session){need(stage.value.record.session.format===impl.record.session.format,'SUPERVISED_SESSION_VERSION_MISMATCH');proof(stage.value.record.session,stage.value.record.role,true,quickEntry(c),dotBinding(c,j,digest(current)));dotWriters(stage.value.record,impl.record.session.session_ref,digest(current));const passed=independentDecision(stage.value.record,c);if(stage.value.record.role==='review'){reviewed=passed&&stage.value.record.scope_pass===true;need(stage.value.passed===reviewed,'SUPERVISED_REVIEW_DECISION_MISMATCH');}}if(['xdev-supervised-qa-run-1','xdev-supervised-qa-claim-1'].includes(stage.value.format))proof(stage.value.session,stage.value.prototype?'implementation':'qa',stage.value.prototype===true,quickEntry(c),dotBinding(c,j,digest(current)));if(stage.value.format==='xdev-supervised-qa-run-1'){const claim=claimForRun(store,j,stage);if(!stage.value.prototype)checkedQaRun(store,j,c,stage,claim);}}
    const review=latest(store,j,'xdev-supervised-review-1'),qa=latest(store,j,'xdev-supervised-qa-run-1'),final=latest(store,j,'xdev-supervised-qa-final-1');
    progress={...progress,binding:'CHECKED',implementation_recorded:true,review_recorded:!!review,review_passed:reviewed,qa_claimed:!!latest(store,j,'xdev-supervised-qa-claim-1'),qa_run:qa?(qa.value.passed?'PASSED':'FAILED'):'NOT_RUN',qa_final_recorded:!!final};
    if(review&&['xdev-supervised-request-3','xdev-supervised-request-4'].includes(c.request.format))need(reviewed===true,'SUPERVISED_REVIEW_PREPARATION_REFUSED');
    if(prototype){selfCheckState=qa?(qa.value.passed?'PASSED':'FAILED'):'NOT_RUN';}else{need(review?.value.passed===true,'REVIEW_MISSING_OR_FAILED');need(qa?.value.passed===true,'QA_MISSING_OR_FAILED');need(final?.value.passed===true&&j.state==='VERIFIED','QA_NATURAL_FINAL_MISSING_OR_FAILED');
     checkerSeparation(c,id,impl.record.session.session_ref,review.value.record.session,final.value.record.session,true,version);
     need(final.value.record.qa_receipt?.id===qa.ref.id&&final.value.record.qa_receipt.sha256===qa.ref.sha256&&final.value.record.session.session_ref===qa.value.session.session_ref,'SUPERVISED_QA_RECEIPT_MISMATCH');
     if(quickEntry(c)||final.value.record.session.format==='xdev-supervised-public-session-2')need(canonical({...final.value.record.session,natural_final:null,natural_end:false,...(final.value.record.session.format==='xdev-supervised-public-session-2'?{completion_observation:null}:{})})===canonical(qa.value.session),'SUPERVISED_QA_SESSION_MISMATCH');}
  }catch(error){const reason=error instanceof Error?error.message:String(error);reasons.push(reason);if(!['IMPLEMENTATION_MISSING','REVIEW_MISSING_OR_FAILED','QA_MISSING_OR_FAILED','QA_NATURAL_FINAL_MISSING_OR_FAILED','SUPERVISED_REVIEW_PREPARATION_REFUSED'].includes(reason))progress={...progress,binding:'UNKNOWN',binding_error:reason};}
  const green=!prototype&&reasons.length===0;let executionAllowed=reasons.length===0&&!latest(store,j,'xdev-supervised-qa-claim-1')&&!['VERIFIED','PARTIALLY_VERIFIED','FAILED','CANCELLED'].includes(j.state);try{assertSupervisedWindow(entry);}catch{executionAllowed=false;}
  progress.delivery_verified=green;
  return {progress,primary_next_step:primaryNextStep({progress,reasons}),mode:'supervised',job_id:id,revision:j.revision,persisted_state:j.state,entry,preparation_verified:entry?.preparation?.preparation_verified===true,execution_allowed:executionAllowed,self_check_state:prototype?selfCheckState:null,status:prototype?'PROTOTYPE_UNVERIFIED':green?'SUPERVISED_CODE_QUALITY_VERIFIED':(reasons.some(r=>/DRIFT|STALE|SCOPE/.test(r))?'STALE':'SUPERVISED_QUALITY_NOT_VERIFIED'),delivery_allowed:green,manifest_sha256:version,reasons,strict_d1_pass:false,native_identity_authenticated:false,provenance:'COORDINATOR_TRANSFERRED_PUBLIC_TOOLS',global_descendant_closure:'NOT_CLAIMED',result_refs:j.result_refs};
}
function currentProgressResult<T extends object>(s:Subject,id:JobId,value:T){const observed=querySupervised({...s,boundaryHealth:()=>null},id);return {...value,progress:observed.progress,primary_next_step:observed.primary_next_step};}
export function prepareSupervised(s: Pick<Subject,'projectRoot'|'projectId'|'boundaryHealth'>, source: string,boundary?:FileRef|null) {
  try { const bytes=file(source),prepared=inspectSupervisedPreparation(s,{path:source,sha256:sha(bytes)},readRef);if(boundary){need(prepared.confirmed_spec!==null,'SUPERVISED_PREPARATION_BOUNDARY_NOT_APPROVED');const confirmedSpec=parseD1UniqueJson(readRef(prepared.confirmed_spec)) as any;need(confirmedSpec!==null&&confirmedSpec!==undefined&&confirmedSpec.memory_boundary!==undefined,'SUPERVISED_PREPARATION_BOUNDARY_NOT_APPROVED');need(canonical(confirmedSpec.memory_boundary)===canonical(boundary),'SUPERVISED_PREPARATION_BOUNDARY_NOT_APPROVED');validateBoundary(boundary,s);inspectRequestHealth(s,{memory_boundary:boundary});}return {...prepared,memory_boundary_checked:boundary!==undefined&&boundary!==null}; }
  catch(error){return {format:'xdev-supervised-preparation-result-1',status:'UNSUPPORTED' as const,
    reason:error instanceof Error?error.message:String(error),questions:['Repair the named preparation version, project binding or source reference from the original public discussion; then explicitly reassess readiness.'],
    project_id:s.projectId,project_root:s.projectRoot,preparation_verified:false,native_identity_authenticated:false,xmi:supervisedPreparationGuidance};}
}
export function runSupervisedEntry(args: string[]) {
  const [operation,...tail]=args,values=new Map<string,string>();need(tail.length%2===0,'SUPERVISED_USAGE');
  for(let i=0;i<tail.length;i+=2){const key=tail[i]!,value=tail[i+1]!;need(['--mode','--project-root','--control-root','--project-id','--source','--job',...(operation==='prepare'?['--memory-boundary','--memory-boundary-sha256']:[])].includes(key)&&!values.has(key)&&word(value),'SUPERVISED_USAGE');values.set(key,value);}
  need(values.get('--mode')==='supervised'&&['prepare','start','record','qa','self-check','run-status','run-result','recovery-status','recover-qa'].includes(operation!),'SUPERVISED_USAGE');
  if(operation==='prepare'){
    const path=values.get('--memory-boundary'),hash=values.get('--memory-boundary-sha256'),paired=path!==undefined||hash!==undefined;
    need(!paired||typeof path==='string'&&isAbsolute(path)&&resolve(path)===path&&hex(hash),'SUPERVISED_USAGE');
    const count=values.size-(paired?2:0);need((count===4||count===5&&values.has('--control-root'))&&values.has('--source')&&!values.has('--job')&&word(values.get('--project-root'))&&word(values.get('--project-id')),'SUPERVISED_USAGE');
    return prepareSupervised({projectRoot:values.get('--project-root')!,projectId:values.get('--project-id')!},values.get('--source')!,paired?{path:path!,sha256:hash!}:undefined);
  }
  const s={projectRoot:values.get('--project-root')!,controlRoot:values.get('--control-root')!,projectId:values.get('--project-id')!};need(word(s.projectRoot)&&word(s.controlRoot)&&word(s.projectId),'SUPERVISED_USAGE');
  if(operation==='start'){need(values.size===5&&values.has('--source')&&!values.has('--job'),'SUPERVISED_USAGE');return projectPrimaryNextStep(startSupervised(s,values.get('--source')!));}
  const id=values.get('--job') as JobId;need(/^job:[0-9a-f-]{36}$/.test(id??''),'SUPERVISED_USAGE');
  if(operation==='run-status'||operation==='run-result'){need(values.size===5&&!values.has('--source'),'SUPERVISED_USAGE');return querySupervised(s,id);}
  if(operation==='recovery-status'){need(values.size===5||values.size===6&&values.has('--source'),'SUPERVISED_USAGE');const path=values.get('--source');return inspectSupervisedRecovery(s,id,path?{path,sha256:sha(file(path))}:undefined);}
  if(operation==='recover-qa'){need(values.size===6&&values.has('--source'),'SUPERVISED_USAGE');return recoverSupervisedQa(s,id,values.get('--source')!);}
  need(values.size===6&&values.has('--source'),'SUPERVISED_USAGE');return projectPrimaryNextStep(operation==='record'?recordSupervised(s,id,values.get('--source')!):qaSupervised(s,id,values.get('--source')!,operation==='self-check'));
}
