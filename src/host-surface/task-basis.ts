/** A bounded derived view, never a replacement for the original XSpec. */
import { canonical } from '../job-runtime/store.ts';
import { parseD1UniqueJson } from '../job-runtime/contracts.ts';
import { exact,need,readRef,readIntake,same,rows,hash,profiles,data } from './xspec-intake.ts';
import type { FileRef,IntakeSubject } from './xspec-intake.ts';
import { inspectPublicFactsDeclaration, projectCurrentMemoryFacts } from '../../mcp/current-memory-facts.ts';
const unique=(v:any):v is string[]=>Array.isArray(v)&&v.length<=128&&v.every(x=>typeof x==='string'&&x.trim().length>0)&&new Set(v).size===v.length;
export function buildTaskBasis(s:IntakeSubject,source:FileRef,read:(ref:FileRef)=>string=readRef){
 const q=parseD1UniqueJson(read(source)) as any;
 exact(q,['format','intake','spec','selected_ids','ac_mapping','max_bytes',...(q.current_memory_facts===undefined?[]:['current_memory_facts'])]);exact(q.intake,['manifest','mapping','logical_id','receipt_sha256']);
 need(q.format==='xdev-task-basis-request-1'&&unique(q.selected_ids)&&q.selected_ids.length>0&&Number.isSafeInteger(q.max_bytes)&&q.max_bytes>=1024&&q.max_bytes<=131072,'XSPEC_BASIS_REQUEST_INVALID');
 // Explicit input references remain subject to the MCP input graph. The receipt
 // uses a typed logical ID, not an arbitrary caller-controlled control path.
 read(q.intake.manifest);read(q.intake.mapping);
 const r=readIntake(s,q.intake.manifest,q.intake.mapping),x=r.pkg.xspec;
 need(q.intake.logical_id===r.receipt.logical_id&&q.intake.receipt_sha256===r.receipt_sha256,'XSPEC_BASIS_INTAKE_DRIFT');
 const spec=parseD1UniqueJson(read(q.spec)) as any;
 need(typeof spec.goal==='string'&&spec.goal.trim()&&unique(spec.allowed_scope)&&spec.allowed_scope.length>0&&unique(spec.forbidden_scope)&&Array.isArray(spec.acceptance_criteria)&&spec.acceptance_criteria.length>0,'XSPEC_TASK_SPEC_INVALID');
 const all=[...rows(x),...x.reference_records],workRoots=new Set(q.selected_ids as string[]);
 need(q.selected_ids.every((id:string)=>all.some(r=>r.id===id)),'XSPEC_BASIS_SELECTION_MISSING');
 need(!q.selected_ids.some((id:string)=>x.reference_records.some((r:any)=>r.id===id&&r.kind==='HISTORICAL')),'XSPEC_HISTORICAL_SELECTION_UNSUPPORTED');
 need(Array.isArray(q.ac_mapping)&&q.ac_mapping.length===spec.acceptance_criteria.length&&new Set(q.ac_mapping.map((m:any)=>m.task_ac_id)).size===q.ac_mapping.length,'XSPEC_BASIS_AC_MAPPING_INVALID');
 // Collect every work root BEFORE expanding: mapped ACs can introduce new
 // requirements, constraints, acceptance coverage and scope risk floors.
 for(const ac of spec.acceptance_criteria){const m=q.ac_mapping.find((m:any)=>m.task_ac_id===ac.id);exact(m,['task_ac_id','xspec_ac_ids','technical_basis']);need(unique(m.xspec_ac_ids)&&(m.xspec_ac_ids.length>0||m.technical_basis!==null),'XSPEC_BASIS_AC_SOURCE_REQUIRED');
  for(const id of m.xspec_ac_ids){need(x.acceptance_criteria.some((a:any)=>a.id===id),'XSPEC_BASIS_AC_MISSING');workRoots.add(id);}
  if(m.technical_basis!==null)need(read(m.technical_basis).trim().length>0,'XSPEC_BASIS_TECHNICAL_SOURCE_EMPTY');
 }
 const expand=(roots:Set<string>)=>{const closure=new Set(roots);let changed=true;while(changed){changed=false;for(const row of all.filter(r=>closure.has(r.id)))for(const k of ['links','actor_ids','requirement_ids','acceptance_criterion_ids'])for(const id of row[k]??[])if(!closure.has(id)){need(all.some(r=>r.id===id),'XSPEC_BASIS_REFERENCE_MISSING');closure.add(id);changed=true;}}return closure;};
 const work=expand(workRoots),backgroundRoots=new Set<string>([...x.out_of_scope,...x.risks,...x.permission_rules,...x.decisions,...x.reference_records.filter((r:any)=>r.kind==='CONFIRMED_CONSTRAINT')].map((r:any)=>r.id));
 const selected=new Set([...work,...expand(backgroundRoots)]),covered=new Set(q.ac_mapping.flatMap((m:any)=>m.xspec_ac_ids));
 need(x.requirements.filter((r:any)=>work.has(r.id)).every((r:any)=>r.acceptance_criterion_ids.length>0&&r.acceptance_criterion_ids.every((id:string)=>covered.has(id))),'XSPEC_BASIS_AC_COVERAGE_MISSING');
 const levels=['prototype','quick_verified','full_governance'];let floor=levels.indexOf(r.pkg.mapped_profile);
 for(const o of x.delivery_profile.scope_overrides)if(o.scope_ids.some((id:string)=>work.has(id))){
  need(!['DEFER_OR_EXCLUDE','STUB_OR_SANDBOX'].includes(o.resolution),'XSPEC_SCOPE_NOT_IMPLEMENTABLE');
  if(['UPGRADE_SCOPE','UPGRADE_PROJECT'].includes(o.resolution))floor=Math.max(floor,levels.indexOf(profiles[o.minimum_mode]!));
 }
 need(levels.indexOf(spec.entry_profile?.requested_profile)>=floor,'XSPEC_TASK_PROFILE_BELOW_FLOOR');
 const missing=[...r.pkg.missing];if(x.open_questions?.length)missing.push('OPEN_QUESTIONS_RETAINED');
 const declaration=q.current_memory_facts===undefined?null:inspectPublicFactsDeclaration(q.current_memory_facts,s,q.spec,read);
 const currentFacts=declaration===null?null:{...projectCurrentMemoryFacts(declaration.scope,declaration.source,read),bound_spec:declaration.spec};
 const value={format:'xdev-task-context-1',basis_request:source,spec:q.spec,intake:{logical_id:r.receipt.logical_id,receipt_sha256:r.receipt_sha256},status:missing.length?'INCOMPLETE':'READY',missing,
  goal:spec.goal,allowed_scope:spec.allowed_scope,forbidden_scope:spec.forbidden_scope,acceptance_criteria:spec.acceptance_criteria,ac_mapping:q.ac_mapping,
  work_ids:[...work].filter(id=>!x.reference_records.some((r:any)=>r.id===id&&r.kind==='HISTORICAL')).sort(),background_ids:[...selected].filter(id=>!work.has(id)).sort(),selected_ids:[...selected].sort(),items:all.filter(r=>selected.has(r.id)),original_goal:x.product_vision,exclusions:x.out_of_scope,risks:x.risks,delivery_profile:x.delivery_profile,
  solution_blueprint:x.solution_blueprint,open_questions:x.open_questions??[],producer_source:r.pkg.source,parent_manifest:q.intake.manifest,parent_mapping:q.intake.mapping,
  authority:'DERIVED_VIEW_ORIGINAL_PACKAGE_REMAINS_AUTHORITATIVE',delivery:{status:'PREPARED_FOR_COORDINATOR_RETURN',received:'NOT_OBSERVED',adoption:'NOT_OBSERVED'},execution_allowed:false,...(currentFacts===null?{}:{current_public_facts:currentFacts})};
 need(Buffer.byteLength(canonical(value))<=q.max_bytes,'XSPEC_TASK_PACKET_BUDGET_EXCEEDED');return value;
}
export function validateTaskContext(s:IntakeSubject,ref:FileRef,spec:FileRef,read:(ref:FileRef)=>string,request?:any){
 const context=parseD1UniqueJson(read(ref)) as any;need(context.format==='xdev-task-context-1'&&context.basis_request,'XSPEC_TASK_CONTEXT_INVALID');
 const fresh=buildTaskBasis(s,context.basis_request,read);need(same(fresh,context),'XSPEC_TASK_CONTEXT_DRIFT');need(same(context.spec,spec),'XSPEC_TASK_CONTEXT_SPEC_MISMATCH');need(context.status==='READY','XSPEC_TASK_CONTEXT_NOT_READY');
 if(request)need(same(context.allowed_scope,request.allowed_scope)&&same(context.forbidden_scope,request.forbidden_scope)&&same(context.acceptance_criteria,request.acceptance_criteria),'XSPEC_TASK_CONTEXT_REQUEST_MISMATCH');
 return {status:context.status,sha256:hash(canonical(context)),receipt_sha256:context.intake.receipt_sha256};
}

export function runTaskBasisAction(local:{config:any;configPath:string;configHash:string},source:FileRef,read:(r:FileRef)=>string){
 const c=local.config,i=c.spec_intake;need(hash(data(local.configPath))===local.configHash,'XSPEC_LOCAL_CONFIG_DRIFT');need(i?.enabled===true,'XSPEC_INTAKE_UNSUPPORTED');
 const q=parseD1UniqueJson(read(source)) as any;need(q.intake&&i.approved_sources.some((r:FileRef)=>same(r,q.intake.manifest))&&i.approved_mappings.some((r:FileRef)=>same(r,q.intake.mapping)),'XSPEC_RECEIVE_NOT_APPROVED');
 return buildTaskBasis({projectId:c.project_id,projectRoot:c.project_root,controlRoot:c.control_root},source,read);
}
