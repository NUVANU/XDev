/** Narrow, pure transition proposal for the Decision/Gate type confusion.
 * Never mutates state, invents historical facts or issues execution permission.
 * Applying a proposal remains a Host/Owner-authorized persistence operation. */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../planning/governance-contracts.ts';
import { parseUniqueJson, parseRfc3339Timestamp } from '../planning/retry-history.ts';
import { validateProjectModel } from './validate.ts';
import type { OwnerGate, ProjectState, TaskContract } from './types.ts';
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const canonical=(v:unknown)=>canonicalJson(v as Parameters<typeof canonicalJson>[0]);
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function fail(m:string):never{throw Error(m);}
const clone=<T>(v:T):T=>structuredClone(v);
export type StateTransitionProposal = {
  format:'xdev-state-type-transition-1'; project_id:string; created_at:string;
  before_sha256:string; after_sha256:string; proposal_sha256:string;
  historical_state_utf8:string; historical_decision_ids:string[];
  state:ProjectState; gate:OwnerGate;
  tasks: {task_id:string; before_sha256:string; after_sha256:string; historical_utf8:string; current:TaskContract}[];
  execution_permitted:false; old_stop_cleared:false;
};
export type PrepareStateTransition = { state_utf8:string; task_utf8:string[]; new_gate:unknown; observed_at:string };

/** Proposal validates exact old bytes and only changes the typed reference plus
 * required backlinks. BLOCKED/NOT_RUN are explicit, never a completion upgrade. */
export function prepareProjectStateTransition(input:PrepareStateTransition):StateTransitionProposal {
  if(!object(input)||typeof input.state_utf8!=='string'||!Array.isArray(input.task_utf8)||input.task_utf8.some(v=>typeof v!=='string'))fail('TRANSITION_INPUT_INVALID');
  const now=parseRfc3339Timestamp(input.observed_at);if(now===null)fail('TRANSITION_CLOCK_INVALID');
  const source=parseUniqueJson(input.state_utf8);if(!object(source)||source.schema_version!=='0.1'||!Array.isArray(source.owner_gate_ids))fail('TRANSITION_SOURCE_INVALID');
  const ids=source.owner_gate_ids as unknown[];
  if(ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)fail('TRANSITION_IDS_INVALID');
  const decisions=(ids as string[]).filter(id=>/^OWNER-DECISION-\d+$/.test(id));
  if(decisions.length===0)fail('TRANSITION_NOT_NEEDED');
  if((ids as string[]).some(id=>!decisions.includes(id)&&!/^OG-[A-Z0-9-]+$/.test(id)))fail('TRANSITION_UNSUPPORTED_ID');
  const gateValidation=validateProjectModel('ownerGate',input.new_gate);if(!gateValidation.valid)fail('TRANSITION_GATE_INVALID');
  const gate=clone(input.new_gate as OwnerGate);
  // This gate is a NEW pending repair question, not renamed old Decisions.
  if(gate.status!=='pending'||gate.decision_ref!==undefined||gate.resolved_at!==undefined||ids.includes(gate.owner_gate_id))fail('TRANSITION_GATE_NOT_NEW_PENDING');
  if(parseRfc3339Timestamp(gate.created_at)!==now||!gate.affected_artifact_refs.includes('.xdev/project-state.json'))fail('TRANSITION_GATE_SCOPE');
  const tasks:StateTransitionProposal['tasks']=[];
  for(const raw of input.task_utf8){
    const task=parseUniqueJson(raw);const validation=validateProjectModel('taskContract',task);
    if(!validation.valid)fail('TRANSITION_TASK_INVALID');
    const current=clone(task as TaskContract);
    if(tasks.some(t=>t.task_id===current.task_id))fail('TRANSITION_TASK_DUPLICATE');
    if(!gate.affected_task_ids.includes(current.task_id))fail('TRANSITION_TASK_SCOPE');
    if(!current.owner_gate_conditions.includes(gate.owner_gate_id))current.owner_gate_conditions.push(gate.owner_gate_id);
    tasks.push({task_id:current.task_id,before_sha256:sha(raw),after_sha256:sha(canonical(current)),historical_utf8:raw,current});
  }
  if(gate.affected_task_ids.length!==tasks.length||gate.affected_task_ids.some(id=>!tasks.some(t=>t.task_id===id)))fail('TRANSITION_BACKLINK_INCOMPLETE');
  if(!Array.isArray(source.active_task_ids)||source.active_task_ids.some((id:unknown)=>typeof id!=='string'||!gate.affected_task_ids.includes(id)))fail('TRANSITION_ACTIVE_TASK_UNCOVERED');
  const state=clone(source) as ProjectState;
  const oldTime=parseRfc3339Timestamp(state.updated_at);if(oldTime===null||now!<oldTime)fail('TRANSITION_TIME_REVERSED');
  state.owner_gate_ids=[...(ids as string[]).filter(id=>!decisions.includes(id)),gate.owner_gate_id];
  state.project_state='BLOCKED';state.readiness={status:'NOT_RUN',checked_at:input.observed_at};state.updated_at=input.observed_at;
  const valid=validateProjectModel('projectState',state);if(!valid.valid)fail('TRANSITION_OTHER_STATE_DEFECT: '+valid.errors.join(';'));
  const body={format:'xdev-state-type-transition-1' as const,project_id:state.project_id,created_at:input.observed_at,
    before_sha256:sha(input.state_utf8),after_sha256:sha(canonical(state)),historical_state_utf8:input.state_utf8,historical_decision_ids:decisions,
    state,gate,tasks,execution_permitted:false as const,old_stop_cleared:false as const};
  return {...body,proposal_sha256:sha(canonical(body))};
}

/** Verify an unchanged pending proposal. Authorization is deliberately NOT part
 * of this function: a matching hash is identity, not Owner consent. */
export function verifyProjectStateTransition(proposal:unknown, currentStateUtf8:string, currentTaskUtf8:string[]):
  {valid:true;proposal:StateTransitionProposal;execution_permitted:false}|{valid:false;code:string} {
  try{
    if(!object(proposal)||proposal.format!=='xdev-state-type-transition-1')fail('TRANSITION_FORMAT');
    if(proposal.historical_state_utf8!==currentStateUtf8||proposal.before_sha256!==sha(currentStateUtf8))fail('TRANSITION_SOURCE_CHANGED');
    const expected=prepareProjectStateTransition({state_utf8:currentStateUtf8,task_utf8:currentTaskUtf8,new_gate:proposal.gate,observed_at:proposal.created_at});
    if(canonical(proposal)!==canonical(expected))fail('TRANSITION_PROPOSAL_CHANGED');
    return {valid:true,proposal:expected,execution_permitted:false};
  }catch(e){return {valid:false,code:e instanceof Error?e.message:'TRANSITION_INVALID'};}
}
