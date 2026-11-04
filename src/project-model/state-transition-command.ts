/** Explicit operator-only type normalization, never called by the scheduler.
 * New gate stays pending; state stays BLOCKED; all old bytes are backed up.
 * Original authority/snapshot is NOT re-sealed, so old execution remains denied. */
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,existsSync,mkdirSync,writeFileSync,renameSync,unlinkSync,rmdirSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {resolve,join,dirname,relative,isAbsolute,sep} from 'node:path';
import {prepareProjectStateTransition,verifyProjectStateTransition,type StateTransitionProposal} from './project-state-transition.ts';
import {canonicalJson} from '../planning/governance-contracts.ts';
import {parseUniqueJson,parseRfc3339Timestamp} from '../planning/retry-history.ts';
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const canonical=(v:unknown)=>canonicalJson(v as Parameters<typeof canonicalJson>[0]);
function fail(s:string):never{throw Error(s);}
function pathIn(root:string,ref:string){
 if(!ref.startsWith('.xdev/')||ref.includes('\\')||/[\x00-\x1f<>:"|?*]/.test(ref)||ref.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)))fail('TRANSITION_PATH');
 const p=resolve(root,ref),rel=relative(root,p);if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))fail('TRANSITION_PATH');
 for(let v=p;;v=dirname(v)){let stat;try{stat=lstatSync(v);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}if(stat?.isSymbolicLink()||(stat?.isFile()&&stat.nlink!==1))fail('TRANSITION_LINKED_INPUT');if(dirname(v)===v)break;}
 return p;
}
function atomic(path:string,bytes:string){mkdirSync(dirname(path),{recursive:true});const temp=path+'.r3-'+process.pid+'.tmp';const fd=openSync(temp,'wx');try{writeFileSync(fd,bytes,'utf8');fsyncSync(fd);}finally{closeSync(fd);}try{renameSync(temp,path);}finally{if(existsSync(temp))unlinkSync(temp);}}
function read(root:string,p:string){return readFileSync(pathIn(root,p),'utf8');}
function taskPath(id:string){if(!/^M(?:0|[1-9][0-9]*)-T[0-9]{3}$/.test(id))fail('TRANSITION_TASK_ID');return `.xdev/tasks/${id}.json`;}
export function prepareStateTransitionFromProject(projectRoot:string,observedAt=new Date().toISOString()):StateTransitionProposal {
 const root=resolve(projectRoot),raw=read(root,'.xdev/project-state.json');const state=parseUniqueJson(raw) as any;
 if(!state||!Array.isArray(state.active_task_ids))fail('TRANSITION_STATE_INVALID');
 const taskTexts=state.active_task_ids.map((id:string)=>read(root,taskPath(id)));
 const gateId='OG-STATE-TYPE-'+sha(raw).slice(0,16).toUpperCase();
 const option=(option_id:string,title:string,description:string)=>({option_id,title,description,cost:'No model calls.',experience:'Existing source and history retained.',risk:'No execution permission is granted.',follow_up_impact:'A fresh execution readiness assessment is still required.'});
 return prepareProjectStateTransition({state_utf8:raw,task_utf8:taskTexts,observed_at:observedAt,new_gate:{schema_version:'0.1',owner_gate_id:gateId,
 title:'Correct Decision/Gate type references',occurred:'Current owner_gate_ids contains Owner Decision identifiers.',reason:'Introduce a new pending gate; do not rename old decisions or erase their history.',
 question:'Review this current normalization separately from authorization to resume old work.',options:[option('A','Review normalization','Inspect the exact transition and its historical anchors.'),option('B','Keep blocked','Do not authorize follow-on execution.')],
 recommendation:{option_id:'A',reason:'Repair typing without attributing a new meaning to old decisions.'},affected_requirement_ids:[],affected_task_ids:[...state.active_task_ids],
 affected_artifact_refs:['.xdev/project-state.json',...state.active_task_ids.map(taskPath)],status:'pending',created_at:observedAt}});
}

/** `confirmedDigest` must be an explicit native operator argument, not derived
 * automatically from proposal JSON. Local filesystem trust is still required. */
export function applyStateTransitionFromProject(projectRoot:string,proposal:unknown,confirmedDigest:string,observedAt=new Date().toISOString()) {
 const root=resolve(projectRoot),p=proposal as StateTransitionProposal;
 if(root.split(sep).some(part=>part.toLowerCase()==='archive'))fail('TRANSITION_ARCHIVE_TARGET');
 if(!p||!/^([0-9a-f]{64})$/.test(confirmedDigest)||p.proposal_sha256!==confirmedDigest)fail('TRANSITION_CONFIRMATION_REQUIRED');
 const valid=verifyProjectStateTransition(p,p.historical_state_utf8,p.tasks?.map(t=>t.historical_utf8)??[]);if(!valid.valid)fail(valid.code);
 const now=parseRfc3339Timestamp(observedAt),created=parseRfc3339Timestamp(p.created_at);if(now===null||created===null||created>now)fail('TRANSITION_CLOCK_INVALID');
 const base=`.xdev/state-transitions/${confirmedDigest}`,journal=pathIn(root,base+'/journal.json');
 const rows=[...p.tasks.map(t=>({path:taskPath(t.task_id),before:t.historical_utf8,after:canonical(t.current)})),
  {path:`.xdev/owner-gates/${p.gate.owner_gate_id}.json`,before:null as string|null,after:canonical(p.gate)},
  {path:'.xdev/project-state-anchor.json',before:null as string|null,after:canonical({format:'xdev-state-anchor-1',proposal_ref:base+'/proposal.json',proposal_sha256:confirmedDigest,before_sha256:p.before_sha256,after_sha256:p.after_sha256,execution_permitted:false})},
  {path:'.xdev/project-state.json',before:p.historical_state_utf8,after:canonical(p.state)}];
 const lock=pathIn(root,'.xdev/state-transition.lock');mkdirSync(lock);
 try {
   const oldJournal=existsSync(journal)?parseUniqueJson(readFileSync(journal,'utf8')) as any:null;
   if(oldJournal&&(oldJournal.proposal_sha256!==confirmedDigest||!['PREPARED','APPLIED'].includes(oldJournal.state)))fail('TRANSITION_JOURNAL_MISMATCH');
   const current=rows.map(r=>{const target=pathIn(root,r.path);return existsSync(target)?readFileSync(target,'utf8'):null;});
   for(let i=0;i<rows.length;i++)if(current[i]!==rows[i].before&&current[i]!==rows[i].after)fail('TRANSITION_SOURCE_CHANGED: '+rows[i].path);
   if(current.some((v,i)=>v===rows[i].after)&&!oldJournal)fail('TRANSITION_MISSING_PREPARED_JOURNAL');
   const ledger=read(root,'.xdev/task-ledger.jsonl');
   if(oldJournal && oldJournal.ledger_sha256 !== sha(ledger))fail('TRANSITION_LEDGER_CHANGED');
   for(let i=0;i<rows.length;i++){
     if(rows[i].before===null)continue;
     const backup=pathIn(root,base+`/before-${i}.utf8`);
     if(existsSync(backup)){if(readFileSync(backup,'utf8')!==rows[i].before)fail('TRANSITION_BACKUP_CHANGED');}
     else {if(oldJournal)fail('TRANSITION_BACKUP_MISSING');mkdirSync(dirname(backup),{recursive:true});writeFileSync(backup,rows[i].before!,{encoding:'utf8',flag:'wx'});}
   }
   const proposalFile=pathIn(root,base+'/proposal.json');
   if(existsSync(proposalFile)){if(readFileSync(proposalFile,'utf8')!==canonical(p))fail('TRANSITION_PROPOSAL_BACKUP_CHANGED');}
   else {if(oldJournal)fail('TRANSITION_PROPOSAL_BACKUP_MISSING');writeFileSync(proposalFile,canonical(p),{encoding:'utf8',flag:'wx'});}
   if(oldJournal?.state==='APPLIED'&&current.every((v,i)=>v===rows[i].after))return {status:'ALREADY_APPLIED',proposal_sha256:confirmedDigest,execution_permitted:false,old_stop_cleared:false};
   atomic(journal,canonical({state:'PREPARED',proposal_sha256:confirmedDigest,ledger_sha256:sha(ledger),execution_permitted:false}));
   // State is written LAST; partial application leaves readiness bindings stale.
   for(let i=0;i<rows.length;i++){
     const r=rows[i],target=pathIn(root,r.path),value=existsSync(target)?readFileSync(target,'utf8'):null;
     if(value===r.after)continue;if(value!==r.before)fail('TRANSITION_CONCURRENT_CHANGE');atomic(target,r.after);
   }
   if(read(root,'.xdev/task-ledger.jsonl')!==ledger)fail('TRANSITION_LEDGER_CHANGED');
   for(const r of rows)if(read(root,r.path)!==r.after)fail('TRANSITION_POSTCHECK');
   atomic(journal,canonical({state:'APPLIED',proposal_sha256:confirmedDigest,ledger_sha256:sha(ledger),execution_permitted:false}));
   return {status:'APPLIED_BLOCKED_STATE',proposal_sha256:confirmedDigest,execution_permitted:false,old_stop_cleared:false,archive_ref:base};
 }finally{rmdirSync(lock);}
}
