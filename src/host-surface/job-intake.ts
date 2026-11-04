import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { readVerifiedD1Init, sha256 } from "../project-model/init-receipt.ts";
import { JobStore, canonical, productionJobRoot, type WriteFault } from "../job-runtime/store.ts";
import { assertD1LocalControl, d1ControlRoot, withD1LocalControlLock } from "./d1-local-control.ts";
import { checkFirstSourceAge, deriveD1IntakeInput, readProfile, type D1IntakeRequest } from "./d1-intake-source.ts";
import type { JobId } from "../job-runtime/contracts.ts";
export { readProfile } from "./d1-intake-source.ts";
export type { D1IntakeRequest } from "./d1-intake-source.ts";

function check(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }

/** Register a frozen 0.1 initialization as an unadmitted Job. No execution,
 * budget, Agent, or Host observation interface is reachable from this path. */
export function registerD1Job(request: D1IntakeRequest, fault?: WriteFault) {
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.requestId), "D1_REQUEST_ID_INVALID");
  check(typeof request.projectId === "string" && request.projectId.trim().length > 0, "D1_PROJECT_ID_INVALID");
  check(isAbsolute(request.workspaceRoot) && resolve(request.workspaceRoot) === request.workspaceRoot
    && isAbsolute(request.controlRoot) && resolve(request.controlRoot) === request.controlRoot, "D1_PATH_INVALID");
  check(request.controlRoot === d1ControlRoot(request.workspaceRoot), "D1_CONTROL_ROOT_MISMATCH");
  return withD1LocalControlLock(request.workspaceRoot, request.controlRoot, request.projectId,
    () => registerD1JobLocked(request,fault));
}

function registerD1JobLocked(request: D1IntakeRequest,fault?:WriteFault) {
  check(existsSync(request.workspaceRoot) && lstatSync(request.workspaceRoot).isDirectory(), "D1_WORKSPACE_NOT_FOUND");
  check(existsSync(request.controlRoot) && lstatSync(request.controlRoot).isDirectory(), "D1_CONTROL_ROOT_NOT_FOUND");
  const { receipt, receipt_sha256, bundle } = readVerifiedD1Init(request.workspaceRoot);
  assertD1LocalControl(request.workspaceRoot,request.controlRoot,request.projectId,
    {allowLock:true,allowNoProfile:true});
  const fixedProfile=join(request.controlRoot,"profile-request.json");
  const jobRoot=productionJobRoot(request.controlRoot,request.projectId);
  const indexRoot=join(request.controlRoot,"d1-intake-requests");
  const children=(path:string)=>existsSync(path)?readdirSync(path):[];
  const jobs=children(jobRoot),indexes=children(indexRoot);
  check(!jobs.some(name=>name.endsWith(".lock"))&&!indexes.some(name=>name.endsWith(".lock")),
    "D1_CONTROL_WRITER_UNKNOWN");
  check(jobs.length===indexes.length && jobs.every(name=>indexes.includes(name)),
    "D1_CONTROL_PARTIAL_COMMIT_STOP");
  if(jobs.length){
    const existingId=jobs[0]!.slice(0,-5);
    const existingStore=new JobStore(jobRoot,{project_id:request.projectId,workspace_root:request.workspaceRoot});
    existingStore.getJob(`job:${existingId}` as JobId); // Check frozen source and CREATE before any new input.
    check(existingId===request.requestId,"D1_A_SINGLE_PROFILE_JOB");
  }
  const candidate=readProfile(request,receipt_sha256,bundle);
  const {decision,bytes:profileBytes}=candidate;
  if(jobs.length){
    check(readFileSync(fixedProfile,"utf8")===profileBytes,"D1_REQUEST_IDENTITY_CONFLICT");
    const frozen=readProfile({...request,profileFile:fixedProfile},receipt_sha256,bundle);
    check(canonical(frozen.decision)===canonical(decision),"D1_REQUEST_IDENTITY_CONFLICT");
  }else{
    check(!existsSync(join(request.controlRoot,"profile-snapshot.json")),
      "D1_PROFILE_SNAPSHOT_PARTIAL_OR_DRIFT_STOP");
    check(request.profileFile===fixedProfile||!existsSync(fixedProfile),
      "D1_PROFILE_SNAPSHOT_PARTIAL_OR_DRIFT_STOP");
  }
  const input=deriveD1IntakeInput(request,{receipt,receipt_sha256,bundle},decision);
  const store = new JobStore(jobRoot, { project_id: request.projectId, workspace_root: request.workspaceRoot },{fault});
  if(!jobs.length)checkFirstSourceAge(receipt.created_at);
  store.prepareIntakeJob(request.requestId,`job:${request.requestId}` as JobId,input);
  if(!jobs.length){
    const snapshot={format:"xdev-d1-profile-snapshot-1",request_id:request.requestId,
      profile_sha256:sha256(profileBytes),root_identity:receipt.root_identity,
      project_id:request.projectId,receipt_sha256};
    const writeOnce=(path:string,bytes:string)=>{
      const fd=openSync(path,"wx",0o600);
      try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
    };
    writeOnce(join(request.controlRoot,"profile-snapshot.json"),canonical(snapshot)+"\n");
    if(request.profileFile!==fixedProfile)writeOnce(fixedProfile,profileBytes);
    check(readFileSync(fixedProfile,"utf8")===profileBytes,
      "D1_PROFILE_SNAPSHOT_PARTIAL_OR_DRIFT_STOP");
    check(canonical(readProfile({...request,profileFile:fixedProfile},receipt_sha256,bundle).decision)
      ===canonical(decision),"D1_PROFILE_DECISION_DRIFT");
  }
  const result = store.createIntakeJob(request.requestId, `job:${request.requestId}` as JobId, input, (replayed) => {
    const current = readVerifiedD1Init(request.workspaceRoot);
    check(current.receipt_sha256 === receipt_sha256 && canonical(current.bundle) === canonical(bundle), "D1_SOURCE_DRIFT");
    assertD1LocalControl(request.workspaceRoot,request.controlRoot,request.projectId,{allowLock:true});
    check(readFileSync(fixedProfile,"utf8")===profileBytes,"D1_PROFILE_SOURCE_DRIFT");
    if (!replayed) checkFirstSourceAge(current.receipt.created_at);
  });
  return { status: result.replayed ? "D1_INTAKE_REPLAY_EXISTING_JOB_QUERY_STATUS" as const : "D1_INTAKE_REGISTERED_EXECUTION_NOT_ADMITTED" as const, ...result,
    project_id: request.projectId, workspace_root: request.workspaceRoot, task_count: input.tasks.length,
    profile:decision,execution_permitted:false as const,
    source_claim: "CURRENT_PROJECT_FILES_MATCH_D1_INIT_RECEIPT_ONLY" as const,
    owner_approval: "UNVERIFIED" as const, prior_xdev_history: "UNKNOWN" as const,
    worker_calls_by_intake: 0 as const, budget_reservations_by_intake: 0 as const, execution_admitted_by_intake: false as const,
    ...(result.revision === 0 ? { worker_calls: 0 as const, budget_reservations: 0 as const, execution_admitted: false as const } : {}) };
}
