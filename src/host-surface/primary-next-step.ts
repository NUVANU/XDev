/** Read-only projection. Progress, quality and transport permissions are distinct. */
export type PrimaryPermissions={source:'CORE_CONTRACT_NO_ADDITIONAL_LOCAL_GATE'|'MCP_LOCAL_CONFIG'|'UNKNOWN';write_jobs:boolean|null;execute_qa:boolean|null};
export type PrimaryProgress={binding:'CHECKED'|'UNKNOWN';binding_error?:string;persisted_state:string|null;profile:string|null;authorization:'CURRENT'|'STOPPED_OR_EXPIRED'|'UNKNOWN';permissions:PrimaryPermissions;implementation_recorded:boolean|null;review_recorded:boolean|null;review_passed:boolean|null;qa_claimed:boolean|null;qa_run:'NOT_RUN'|'PASSED'|'FAILED'|'UNKNOWN';qa_final_recorded:boolean|null;delivery_verified:boolean|null};
export function primaryNextStep(s:{progress?:PrimaryProgress;reasons?:string[]}){
 const result=(status:string,reason:string,action:unknown=null,missing:string[]=[])=>({status,reason,action,missing_observations:missing,automatic_execution:false});
 const p=s.progress;
 if(!p)return result('UNKNOWN','CURRENT_PROGRESS_NOT_OBSERVED',null,['progress']);
 if(p.binding!=='CHECKED')return result(p.binding_error?.includes('UNSUPPORTED')?'UNSUPPORTED':'BLOCKED','CURRENT_MATERIAL_CHAIN_NOT_CHECKED',null,['progress.binding']);
 if(p.delivery_verified===true)return result('COMPLETE','CURRENT_RESULT_ALREADY_REGISTERED');
 if(p.review_recorded===true&&p.review_passed===false)return result('BLOCKED','INDEPENDENT_REVIEW_FAILED_OR_BLOCKED');
 if(p.qa_run==='FAILED')return result('BLOCKED','ORIGINAL_QA_RESULT_FAILED_NO_AUTOMATIC_RETRY');
 if(p.profile==='prototype'&&p.qa_run==='PASSED')return result('COMPLETE_UNVERIFIED','PROTOTYPE_SELF_CHECK_RECORDED_NO_FORMAL_DELIVERY');
 if(p.qa_run==='PASSED'&&p.qa_final_recorded===false)return result('BLOCKED','ORIGINAL_QA_FINAL_REQUIRED',{entry:'task recovery-status',permission:'READ_ONLY',replacement_final_allowed:false,rerun_qa_allowed:false});
 if(p.qa_final_recorded===true)return result('BLOCKED','REGISTERED_RESULT_NOT_VERIFIED');
 if(p.qa_claimed===true)return result('BLOCKED','QA_ALREADY_CLAIMED_WAIT_FOR_ORIGINAL_RESULT');
 if(['VERIFIED','VERIFYING','INTEGRATING'].includes(p.persisted_state??''))return result('BLOCKED','PERSISTED_CLOSURE_REQUIRES_ORIGINAL_RESULT');
 if(['FAILED','CANCELLED'].includes(p.persisted_state??''))return result('BLOCKED','PERSISTED_JOB_STOPPED');
 const missing:string[]=[];
 for(const key of ['implementation_recorded','review_recorded','qa_claimed','qa_final_recorded'] as const)if(p[key]===null)missing.push('progress.'+key);
 if(p.qa_run==='UNKNOWN')missing.push('progress.qa_run');if(p.persisted_state===null)missing.push('progress.persisted_state');
 if(missing.length)return result('UNKNOWN','CURRENT_STAGE_NOT_FULLY_OBSERVED',null,missing);
 if(p.authorization!=='CURRENT')return result(p.authorization==='UNKNOWN'?'UNKNOWN':'BLOCKED','CURRENT_AUTHORIZATION_REQUIRED',null,['progress.authorization']);
 const permit=(name:'write_jobs'|'execute_qa')=>p.permissions[name]===true?null:result(p.permissions[name]===false?'BLOCKED':'UNKNOWN','CURRENT_LOCAL_PERMISSION_REQUIRED',null,['permissions.'+name]);
 // A missing ledger record says nothing about a live Host Worker. Coordinate
 // or await the original implementer after checking actual writers; record is
 // a later step only when that implementer's natural final exists.
 if(p.implementation_recorded===false)return permit('write_jobs')??result('ACTION_REQUIRED','PUBLIC_HOST_IMPLEMENTATION_COORDINATION_REQUIRED',{kind:'PUBLIC_HOST_ACTION',role:'implementation',action:'CHECK_CURRENT_WRITERS_THEN_COORDINATE_OR_AWAIT_ORIGINAL_IMPLEMENTER',registered_dispatch_entry:null,requires:'HOST_CHECK_CURRENT_WRITERS_AND_EXISTING_DISPATCH',redispatch_when_writers_unknown:false,after_original_natural_final:{entry:'task record',requires:'ORIGINAL_IMPLEMENTER_NATURAL_FINAL'},permission_source:p.permissions.source});
 if(p.profile==='prototype')return permit('write_jobs')??permit('execute_qa')??result('ACTION_REQUIRED','PROTOTYPE_SELF_CHECK_REQUIRED',{entry:'task self-check',required_permission:'execute_qa',requires:'ORIGINAL_IMPLEMENTATION_SESSION'});
 if(p.review_recorded===false)return result('ACTION_REQUIRED','INDEPENDENT_REVIEW_REQUIRED',{kind:'PUBLIC_HOST_ACTION',role:'review',registered_dispatch_entry:null});
 if(p.review_passed===null)return result('UNKNOWN','REVIEW_DECISION_NOT_OBSERVED',null,['progress.review_passed']);
 // Job state can remain PLANNING while its single task is TESTING. The task
 // stage is bound by the complete rechecked history, not the quality-green bit.
 if(p.review_passed===true&&p.qa_run==='NOT_RUN')return permit('write_jobs')??permit('execute_qa')??result('ACTION_REQUIRED','INDEPENDENT_QA_REQUIRED',{entry:'task qa',required_permission:'execute_qa',requires:'INDEPENDENT_QA_SESSION',permission_source:p.permissions.source});
 return result('UNKNOWN','NO_SUPPORTED_NEXT_STEP_FROM_OBSERVED_STAGE');
}
export function projectPrimaryNextStep<T extends object>(value:T,permissions?:PrimaryPermissions):T&{primary_next_step:ReturnType<typeof primaryNextStep>}{
 const v=value as any,progress=v.progress?(permissions?{...v.progress,permissions}:v.progress):undefined;
 return {...value,...(progress?{progress}:{}),primary_next_step:primaryNextStep({progress,reasons:v.reasons})};
}
