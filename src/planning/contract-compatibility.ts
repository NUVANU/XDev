import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { validateDeliveryArtifact } from './legacy-validate.ts';
import { resolveWorktreeIdentity as resolveLegacyIdentity } from './legacy-governance-contracts.ts';
import { canonicalJson, validateCheckpointPolicy, validateWriteLease, validateFailureFingerprint, validateRetryBudget } from './governance-contracts.ts';

export type CompatibilityName='checkpointPolicy'|'writeLease'|'failureFingerprint'|'retryBudget';
export type CompatibilityContext={
  policyFacts?:Parameters<typeof validateCheckpointPolicy>[1];
  leaseContext?:Parameters<typeof validateWriteLease>[1];
  fingerprints?:Parameters<typeof validateFailureFingerprint>[1];
  fingerprintContext?:Parameters<typeof validateFailureFingerprint>[2];
  legacyFingerprint?:unknown;
};
export type CompatibilityResult =
 | {valid:false;errors:string[];execution_permitted:false;migration:'NONE'}
 | {valid:true;errors:string[];value:unknown;source_contract:string;target_contract:string;legacy_sha256:string;fingerprint_mapping:unknown;execution_permitted:false;migration:'READ_ONLY_ADAPTER';authority:'NON_AUTHORITATIVE_COMPATIBILITY_VIEW'};
/** Read-only conversion review. Caller must supply explicit versions and new facts.
 * A legacy approval, lease or retry record is never upgraded into execution permission. */
export function adaptLegacyPlanningContract(input:{source_contract:string;target_contract:string;name:CompatibilityName;legacy:unknown;proposed:unknown;context:CompatibilityContext}):CompatibilityResult {
  const invalid=(...errors:string[])=>({valid:false as const,errors,execution_permitted:false as const,migration:'NONE' as const});
  if(input.source_contract!=='delivery/0.1'||input.target_contract!=='planning/0.1')return invalid('EXPLICIT_CONTRACT_VERSION_REQUIRED');
  if(!['checkpointPolicy','writeLease','failureFingerprint','retryBudget'].includes(input.name))return invalid('CONTRACT_UNSUPPORTED');
  const legacy=validateDeliveryArtifact(input.name,input.legacy);if(!legacy.valid)return invalid(...legacy.errors);
  const c=input.context;
  if(input.name==='checkpointPolicy'&&!c.policyFacts||input.name==='writeLease'&&!c.leaseContext||['failureFingerprint','retryBudget'].includes(input.name)&&!c.fingerprintContext)return invalid('INDEPENDENT_TARGET_FACTS_REQUIRED');
  const next=input.name==='checkpointPolicy'?validateCheckpointPolicy(input.proposed,c.policyFacts):input.name==='writeLease'?validateWriteLease(input.proposed,c.leaseContext):input.name==='failureFingerprint'?validateFailureFingerprint(input.proposed,c.fingerprints,c.fingerprintContext):validateRetryBudget(input.proposed,c.fingerprints??[],c.fingerprintContext);
  if(!next.valid)return invalid(...next.errors);
  const old=legacy.value as any,value=next.value as any;
  // The old namespace binds the physical root in the fingerprint itself. The
  // new namespace binds it through trusted context; never discard that binding.
  if(input.name==='failureFingerprint'){
    try{if(old.repo_root_identity!==resolveLegacyIdentity(c.fingerprintContext!.repo_root).worktree_id)return invalid('LEGACY_REPOSITORY_BINDING_CHANGED');}
    catch{return invalid('LEGACY_REPOSITORY_IDENTITY_UNAVAILABLE');}
  }
  if(input.name==='writeLease'){
    try{const observed=resolveLegacyIdentity(old.canonical_real_path);if(old.worktree_id!==observed.worktree_id||!isDeepStrictEqual(old.filesystem_identity,observed.filesystem_identity))return invalid('LEGACY_LEASE_IDENTITY_CHANGED');}
    catch{return invalid('LEGACY_LEASE_IDENTITY_UNAVAILABLE');}
  }
  let fingerprintMapping:unknown=null;
  if(input.name==='retryBudget'){
    const oldFp=validateDeliveryArtifact('failureFingerprint',c.legacyFingerprint);
    if(!oldFp.valid||oldFp.value.fingerprint_id!==old.failure_fingerprint)return invalid('EXPLICIT_LEGACY_FINGERPRINT_REQUIRED');
    const newFp=c.fingerprints?.find(f=>f.fingerprint_id===value.failure_fingerprint);
    const reviewed=adaptLegacyPlanningContract({...input,name:'failureFingerprint',legacy:oldFp.value,proposed:newFp});
    if(!reviewed.valid)return invalid(...reviewed.errors);
    fingerprintMapping={source:old.failure_fingerprint,target:value.failure_fingerprint,legacy_sha256:reviewed.legacy_sha256};
  }
  const preserved:Record<CompatibilityName,string[]>={checkpointPolicy:['subject_task_id','subject_task_kind','subject_repository_access','disposition','derived_consumer_task_ids','source_decision_id','source_decision_digest','effective_at'],writeLease:['project_id','worktree_id','canonical_real_path','holder_run_id','allowed_scope','acquired_at','expires_at','status'],failureFingerprint:['stage','issue_code','contract_refs','affected_paths','root_cause_class'],retryBudget:['task_id','failure_fingerprint','attempts','max_attempts','next_action']};
  for(const field of preserved[input.name])if(!(input.name==='retryBudget'&&field==='failure_fingerprint')&&!isDeepStrictEqual(old[field],value[field]))return invalid('LEGACY_SAFETY_BINDING_CHANGED:'+field);
  return{valid:true as const,errors:[],value:structuredClone(next.value),source_contract:input.source_contract,target_contract:input.target_contract,legacy_sha256:createHash('sha256').update(canonicalJson(old)).digest('hex'),fingerprint_mapping:fingerprintMapping,execution_permitted:false as const,migration:'READ_ONLY_ADAPTER' as const,authority:'NON_AUTHORITATIVE_COMPATIBILITY_VIEW' as const};
}
