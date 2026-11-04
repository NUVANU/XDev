/** Non-authorizing, lossless view of the fixed project history. This is not
 * XMem storage, authority resolution or a replacement for execution readiness. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, isAbsolute, resolve, sep } from 'node:path';
import { verifyProjectStateTransition } from '../project-model/project-state-transition.ts';
import { canonicalJson } from './governance-contracts.ts';
import { parseUniqueJson, parseRfc3339Timestamp } from './retry-history.ts';
import type { TrustedProjectContext } from './types.ts';

const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const object = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const PROJECT_STATE = '.xdev/project-state.json';
const LEDGER = '.xdev/task-ledger.jsonl';
const PROJECTION = '.xdev/diagnostics/M2-T002-STAGE-A-LEGACY-PROJECTION-002.json';
const PINS_DIGEST = 'f3b016b642a45e609f77d923239e84679b97eb7e328fa77538b874066563a398';
const CUTOFF_DIGEST = '7dd816370946e9e8477f00984d8b2826e93c1758a857577af10ecc98b1cf131b';

export type HistoryIssue = {code: string; line: number | null; detail: string};
export type HistoryRow = {line: number; raw: string; sha256: string; event: Record<string, unknown> | null};
export type HistoryInspection = {
  format: 'xdev-history-inspection-1'; readable: boolean; source_stable: boolean;
  project_id: string | null; source_sha256: string | null; physical_lines: number;
  record_count: number; raw_ledger: string | null; rows: HistoryRow[];
  registrations: {task_id: string | null; line: number; missing: string[]}[];
  run_labels: {run_id: string; task_ids: string[]; event_ids: string[]; charge_count: 'UNKNOWN'}[];
  legacy_pins: {status: 'VERIFIED' | 'INVALID' | 'NOT_PRESENT'; verified_run_ids: string[]; known_worker_charges: number | null; automatic_rework_charges: 'UNKNOWN'};
  issues: HistoryIssue[]; automatic_execution_permitted: false; delivery_claim: 'NONE';
};

/** Fixed files only. Caller cannot select a history subset or substitute bytes.
 * A second read catches observed changes, not an adversarial writer/OS attack. */
export function inspectProjectHistory(context: TrustedProjectContext): HistoryInspection {
  const result: HistoryInspection = {format:'xdev-history-inspection-1',readable:false,source_stable:false,
    project_id:null,source_sha256:null,physical_lines:0,record_count:0,raw_ledger:null,rows:[],registrations:[],run_labels:[],
    legacy_pins:{status:'NOT_PRESENT',verified_run_ids:[],known_worker_charges:null,automatic_rework_charges:'UNKNOWN'},
    issues:[],automatic_execution_permitted:false,delivery_claim:'NONE'};
  const issue=(code:string,line:number|null,detail:string)=>result.issues.push({code,line,detail});
  const reads=new Map<string,Buffer>();
  try {
    if (!object(context)||!nonempty(context.project_root)) throw Error('ROOT_INVALID');
    const root=resolve(context.project_root);
    function noLinks(p:string) { for(let v=p;;v=dirname(v)) { if(lstatSync(v).isSymbolicLink())throw Error('LINKED_INPUT');if(dirname(v)===v)break; } }
    noLinks(root); if(!lstatSync(root).isDirectory())throw Error('ROOT_INVALID');
    const actualRoot=realpathSync.native(root);
    const read=(ref:string):Buffer=>{
      if(!ref.startsWith('.xdev/')||ref.includes('\\')||/[\x00-\x1f<>:"|?*]/.test(ref)
        ||ref.split('/').some(s=>!s||s==='.'||s==='..'||/[. ]$/.test(s)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)))throw Error('SOURCE_PATH_INVALID');
      const path=join(root,ref);noLinks(path);const stat=lstatSync(path);
      if(!stat.isFile()||stat.nlink!==1||stat.size>64*1024*1024)throw Error('INPUT_UNSUPPORTED');
      const rel=relative(actualRoot,realpathSync.native(path));
      if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw Error('CROSS_ROOT');
      const bytes=readFileSync(path);const old=reads.get(ref);
      if(old&&!old.equals(bytes))throw Error('SOURCE_CHANGED');reads.set(ref,bytes);return bytes;
    };
    const decode=(b:Buffer)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b);
    const state=parseUniqueJson(decode(read(PROJECT_STATE)));
    if(!object(state)||!nonempty(state.project_id))throw Error('PROJECT_ID_UNKNOWN');
    result.project_id=state.project_id;
    const bytes=read(LEDGER);result.source_sha256=sha(bytes);const text=decode(bytes);result.raw_ledger=text;
    // Keep physical numbering and every raw row, including blank/malformed rows.
    const lines=text.split(/\r?\n/);if(lines.at(-1)==='')lines.pop();result.physical_lines=lines.length;
    const ids=new Set<string>(),runs=new Map<string,{tasks:Set<string>;events:string[]}>();
    lines.forEach((raw,i)=>{
      const row:HistoryRow={line:i+1,raw,sha256:sha(raw),event:null};result.rows.push(row);
      if(!raw.trim()){issue('BLANK_PHYSICAL_LINE',i+1,'Preserved; not accepted as a runtime source event.');return;}
      try { const e=parseUniqueJson(raw);if(!object(e))throw Error('NOT_OBJECT');row.event=e;result.record_count++;
        if(!nonempty(e.event_id)||!nonempty(e.event_type))issue('EVENT_IDENTITY_INCOMPLETE',i+1,'Missing event id/type.');
        else {if(ids.has(e.event_id))issue('EVENT_ID_DUPLICATE',i+1,e.event_id);ids.add(e.event_id);}
        if(!nonempty(e.project_id))issue('PROJECT_BINDING_UNKNOWN',i+1,'No project association can be inferred.');
        if(parseRfc3339Timestamp(e.created_at)===null)issue('EVENT_TIME_INVALID',i+1,'Invalid/missing timestamp.');
        if(['task_created','task_lineage_linked'].includes(e.event_type)&&e.project_id===state.project_id){
          const fields=['task_id','origin','lineage_root_task_id','payload_ref','payload_sha256'];
          if(e.event_type==='task_lineage_linked')fields.push('parent_task_id');
          const missing=fields.filter(k=>!nonempty(e[k]));
          result.registrations.push({task_id:nonempty(e.task_id)?e.task_id:null,line:i+1,missing});
          if(missing.length)issue('REGISTRATION_FACTS_MISSING',i+1,missing.join(','));
        }
        if(nonempty(e.run_id)) {const r=runs.get(e.run_id)??{tasks:new Set<string>(),events:[]};if(nonempty(e.task_id))r.tasks.add(e.task_id);if(nonempty(e.event_id))r.events.push(e.event_id);runs.set(e.run_id,r);}
      }catch{issue('ROW_NOT_INTERPRETABLE',i+1,'Original raw row retained; no zero/default facts generated.');}
    });
    result.run_labels=[...runs].map(([run_id,r])=>({run_id,task_ids:[...r.tasks],event_ids:r.events,charge_count:'UNKNOWN'}));
    // Pin inspection is intentionally still reached when other history has gaps.
    // It proves only the exact four frozen claims, not a complete runnable history.
    try {
      const projection=parseUniqueJson(decode(read(PROJECTION)));
      if(!object(projection)||projection.task_id!=='M2-T002'||state.project_id!=='xdev-v0'
        ||projection.project_binding?.project_id!==state.project_id
        ||projection.project_binding?.project_state_ref!==PROJECT_STATE)throw Error('PIN_PROJECT_BINDING');
      if(projection.project_binding.project_state_sha256!==sha(read(PROJECT_STATE))){
        // Explicit non-authorizing historical anchor after a type normalization.
        // The original projection stays byte-identical; no generic hash fallback.
        const anchor=parseUniqueJson(decode(read('.xdev/project-state-anchor.json'))) as any;
        if(anchor?.format!=='xdev-state-anchor-1'||anchor.execution_permitted!==false
          ||!/^\.xdev\/state-transitions\/[a-f0-9]{64}\/proposal\.json$/.test(anchor.proposal_ref)
          ||anchor.before_sha256!==projection.project_binding.project_state_sha256
          ||anchor.after_sha256!==sha(read(PROJECT_STATE)))throw Error('PIN_STATE_ANCHOR_INVALID');
        const proposal=parseUniqueJson(decode(read(anchor.proposal_ref))) as any;
        const validation=verifyProjectStateTransition(proposal,proposal.historical_state_utf8,proposal.tasks?.map((t:any)=>t.historical_utf8)??[]);
        if(!validation.valid||proposal.proposal_sha256!==anchor.proposal_sha256||proposal.before_sha256!==anchor.before_sha256
          ||proposal.after_sha256!==anchor.after_sha256||!anchor.proposal_ref.includes('/'+proposal.proposal_sha256+'/'))throw Error('PIN_STATE_ANCHOR_INVALID');
        const gateBytes=read(`.xdev/owner-gates/${proposal.gate.owner_gate_id}.json`);
        if(sha(gateBytes)!==sha(canonicalJson(proposal.gate)))throw Error('PIN_STATE_GATE_CHANGED');
        for(const task of proposal.tasks){
          if(!/^M(?:0|[1-9][0-9]*)-T[0-9]{3}$/.test(task.task_id)||sha(read(`.xdev/tasks/${task.task_id}.json`))!==task.after_sha256)throw Error('PIN_STATE_TASK_CHANGED');
        }
      }
      const pins=projection.worker_runs,cutoff=projection.transition?.legacy_cutoff;
      if(!Array.isArray(pins)||pins.length!==4||sha(canonicalJson(pins))!==PINS_DIGEST
        ||cutoff?.ledger_line!==273||cutoff?.event_id!=='EVT-0273'||cutoff?.event_sha256!==CUTOFF_DIGEST
        ||result.rows[272]?.sha256!==CUTOFF_DIGEST||result.rows[272]?.event?.event_id!=='EVT-0273')throw Error('PIN_FIXED_SOURCE_MISMATCH');
      const used=new Set<number>();
      for(const pin of pins) {
        if(pin.classification?.attempt_kind!=='UNKNOWN'||pin.classification?.dispatch_id!=='UNKNOWN'||pin.classification?.failure_fingerprint_id!=='UNKNOWN')throw Error('PIN_CLASSIFICATION');
        for(const p of [pin.charge_proof,...pin.supplemental_events]) {
          const row=result.rows[p.ledger_line-1],e=row?.event as Record<string,any>|null;
          if(!Number.isSafeInteger(p.ledger_line)||p.ledger_line<1||p.ledger_line>273||used.has(p.ledger_line)
            ||!e||row.sha256!==p.event_sha256||e.event_id!==p.event_id||e.event_type!==p.event_type
            ||e.project_id!==state.project_id||e.task_id!=='M2-T002'||e.run_id!==pin.run_id||e.payload_ref!==p.payload_ref)throw Error('PIN_EVENT_MISMATCH');
          used.add(p.ledger_line);
          if(!/^\.xdev\/(evidence|reports|model-decisions|owner-decisions)\//.test(p.payload_ref))throw Error('PIN_PATH_INVALID');
          const payloadBytes=read(p.payload_ref);if(sha(payloadBytes)!==p.current_payload_sha256)throw Error('PIN_PAYLOAD_MISMATCH');
          const payload=parseUniqueJson(decode(payloadBytes));if(!object(payload))throw Error('PIN_PAYLOAD_INVALID');
          if(p===pin.charge_proof&&(Object.hasOwn(payload,'project_id')||payload.task_id!=='M2-T002'||payload.run_id!==pin.run_id
            ||!nonempty(payload.status)||!payload.status.startsWith('IMPLEMENTED')))throw Error('PIN_PAYLOAD_IDENTITY');
        }
      }
      result.legacy_pins={status:'VERIFIED',verified_run_ids:pins.map(p=>p.run_id),known_worker_charges:4,automatic_rework_charges:'UNKNOWN'};
    }catch(e){
      if((e as NodeJS.ErrnoException).code==='ENOENT'&&!reads.has(PROJECTION))result.legacy_pins.status='NOT_PRESENT';
      else {result.legacy_pins.status='INVALID';issue('LEGACY_PIN_VERIFICATION_FAILED',null,e instanceof Error?e.message:'Unresolved fixed pin');}
    }
    for(const ref of reads.keys())read(ref);
    result.readable=true;result.source_stable=true;
  }catch(e){issue('SOURCE_UNAVAILABLE_OR_CHANGED',null,e instanceof Error?e.message:'Unresolved source');}
  return result;
}
