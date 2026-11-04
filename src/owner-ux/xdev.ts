import { loadConfig,hash as intakeHash,bytes as intakeBytes } from '../../mcp/configure.ts';
import { createInputReader } from '../../mcp/input-reader.ts';
import { runXspecAction } from '../host-surface/xspec-intake.ts';
import { runTaskBasisAction } from '../host-surface/task-basis.ts';
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { validatePlanCommandFromProject } from "../planning/plan-command.ts";
import { initializeProject, type InitializeProjectOptions, type InitializeProjectResult } from "../project-model/initialize-project.ts";
import { JobStore, canonical, productionJobRoot } from "../job-runtime/store.ts";
import { UUID } from "../job-runtime/state.ts";
import type { JobId, TaskId } from "../job-runtime/contracts.ts";
import { JobControlSurface } from "../host-surface/control.ts";
import { readProfile, registerD1Job } from "../host-surface/job-intake.ts";
import { registerRoleDomain, inspectRole, prepareRole, type RoleSubject } from "../host-surface/d1-role-preparation.ts";
import { bindD1Context } from "../host-surface/d1-context-binding.ts";
import { sendWorker, recordWorker } from "../host-surface/d1-worker-dispatch.ts";
import { D1RoleIntentStore } from "../execution/d1-role-intent-store.ts";
import { formatOwnerStatus, readOwnerStatus } from "./status.ts";
import { assertD1LocalControl, initializeD1LocalProject } from "../host-surface/d1-local-control.ts";
import { runB2Entry } from "../host-surface/d1-b2-entry.ts";
import { sha256 } from "../project-model/init-receipt.ts";
import { prepareD1TaskEntry } from "./d1-task-entry.ts";
import { B2Store } from '../job-runtime/d1-b2-store.ts';
import { b2Need as need } from '../job-runtime/d1-b2-contracts.ts';
import { parseRoleQualityArgs } from '../host-surface/d1-role-quality-args.ts';
export { parseRoleQualityArgs } from '../host-surface/d1-role-quality-args.ts';
export { runTaskHostEntry, type TaskHostPlan, type B2TaskHostPort, type B2HostPrepareRequest } from './d1-task-host-entry.ts';
import { checkedRelativeFile, readProjectFile } from '../project-model/init-receipt.ts';
import { parseD1UniqueJson } from '../job-runtime/contracts.ts';
import { validateGrantLocator } from '../host-surface/d1-b2-native-port.ts';
import { performB2TaskSource } from '../job-runtime/d1-b2-storage.ts';
import { exportPublicHostObservation } from '../host-surface/d1-public-host-export.ts';
import { runSupervisedEntry } from '../host-surface/supervised-quality.ts';

export const XDEV_USAGE = "Usage: xdev status [--json] [project-root]\n       xdev init <design-seed.json> [project-root]\n       xdev init --d1-intake <project-local-design-seed.json> [project-root]\n       xdev plan validate <plan-file> [project-root]\n       xdev job intake <request-uuid> --profile-request <absolute-path> --control-root <absolute-path> --project-id <id> --workspace-root <absolute-path>\n       xdev job status|result <job-id> --control-root <absolute-path> --project-id <id> --workspace-root <absolute-path>\n       xdev job inspect-legacy <job-id> --control-root <absolute-path> --project-id <id> --workspace-root <absolute-path>\n       xdev job inspect-resume <job-id> <expected-revision> --control-root <absolute-path> --project-id <id> --workspace-root <absolute-path>\n       xdev job bind-context <job-id> <task-id> <binding-file> --control-root <absolute-path> --project-id <id> --workspace-root <absolute-path>\n       xdev job register-role-domain <job-id> <task-id> <registration-file> --control-root <absolute-path> --project-id <id> --workspace-root <absolute-path>\n       xdev job inspect-role <job-id> <task-id> --control-root <absolute-path> --project-id <id> --workspace-root <absolute-path>\n       xdev job prepare-role <job-id> <task-id> <request-uuid> [refresh-file] --control-root <absolute-path> --project-id <id> --workspace-root <absolute-path>\n       xdev job send-worker <job-id> <task-id> <attempt-uuid> <observation-file> [refresh-file] --control-root <absolute-path> --project-id <id> --workspace-root <absolute-path>\n       xdev job record-worker|reconcile-worker <job-id> <task-id> <attempt-uuid> <observation-file> --control-root <absolute-path> --project-id <id> --workspace-root <absolute-path>" + "\n       xdev task intake <coordinator-collected goal/purpose/risk flags> [--workspace-root <absolute-path>]\n       xdev task status|result|inspect-resume [--workspace-root <absolute-path>]" + "\n       xdev task prepare --mode supervised --project-root <absolute-root> --project-id <id> --source <absolute-preparation.json>\n       xdev task start|record|qa|self-check|run-status|run-result --mode supervised --project-root <absolute-root> --control-root <absolute-root> --project-id <id> [--source <absolute-file>] [--job <job-id>]\n       xdev task start --project-root <absolute-root> --source <relative-file> --expected-head <sha256>\n       xdev task run-status|run-result --project-root <absolute-root> --job <job-id>\n       xdev role-quality init|create --project-root <absolute-root> --source <relative-file> [--expected-head <sha256>]\n       xdev role-quality prepare|cancel|reconcile --project-root <absolute-root> --job <job-id> --operation <uuid> --grant-ref <absolute-locator-file> --expected-head <sha256> --expected-job-head <sha256>\n       xdev role-quality observe|outcome --project-root <absolute-root> --job <job-id> --operation <uuid> --expected-head <sha256> --expected-job-head <sha256>\n       xdev role-quality quality|result --project-root <absolute-root> --job <job-id>\n       xdev host-evidence export --project-root <absolute-root> --request <relative-request.json>";

export function parseWorkerArgs(args:string[]):{operation:'send-worker'|'record-worker'|'reconcile-worker';subject:RoleSubject;attemptId:string;file:string;refreshFile?:string}{
  const [operation,jobId,taskId,attemptId,file,...tail]=args;
  const refreshFile=operation==='send-worker'&&tail[0]&&isAbsolute(tail[0])?tail.shift():undefined;
  const options=tail;
  if(!['send-worker','record-worker','reconcile-worker'].includes(operation??'')||
    !new RegExp('^job:'+UUID+'$').test(jobId??'')||!new RegExp('^task:'+UUID+':'+UUID+'$').test(taskId??'')||
    taskId?.split(':')[1]!==jobId?.slice(4)||!new RegExp('^'+UUID+'$').test(attemptId??'')||
    !file||!isAbsolute(file)||resolve(file)!==file||options.length!==6)throw Error(XDEV_USAGE);
  const values=new Map<string,string>();
  for(let i=0;i<options.length;i+=2){const key=options[i],value=options[i+1];
    if(!['--control-root','--project-id','--workspace-root'].includes(key)||values.has(key)||!value||value.startsWith('--'))throw Error(XDEV_USAGE);
    values.set(key,value);}
  const controlRoot=values.get('--control-root')!,projectId=values.get('--project-id')!,workspaceRoot=values.get('--workspace-root')!;
  if(!isAbsolute(controlRoot)||resolve(controlRoot)!==controlRoot||!isAbsolute(workspaceRoot)||resolve(workspaceRoot)!==workspaceRoot||!projectId.trim())throw Error(XDEV_USAGE);
  return {operation:operation as 'send-worker'|'record-worker'|'reconcile-worker',
    subject:{jobId:jobId as JobId,taskId:taskId as TaskId,controlRoot,projectId,workspaceRoot},attemptId,file,refreshFile};
}

export function parseRoleArgs(args:string[]):{operation:'bind-context'|'register-role-domain'|'inspect-role'|'prepare-role';subject:RoleSubject;extra?:string;refreshFile?:string}{
  const [operation,jobId,taskId,...tail]=args;
  if(!['bind-context','register-role-domain','inspect-role','prepare-role'].includes(operation??'')||
    !new RegExp('^job:'+UUID+'$').test(jobId??'')||
    !new RegExp('^task:'+UUID+':'+UUID+'$').test(taskId??'')||
    taskId?.split(':')[1]!==jobId?.slice(4))throw Error(XDEV_USAGE);
  const needsExtra=operation!=='inspect-role',extra=needsExtra?tail[0]:undefined,rest=tail.slice(needsExtra?1:0);
  const refreshFile=operation==='prepare-role'&&rest[0]&&isAbsolute(rest[0])?rest.shift():undefined;
  const options=rest;
  if((needsExtra&&!extra)||options.length!==6)throw Error(XDEV_USAGE);
  if(['bind-context','register-role-domain'].includes(operation??'')&&(!isAbsolute(extra!)||resolve(extra!)!==extra))throw Error(XDEV_USAGE);
  if(operation==='prepare-role'&&!new RegExp('^'+UUID+'$').test(extra!))throw Error(XDEV_USAGE);
  const values=new Map<string,string>();
  for(let i=0;i<options.length;i+=2){const key=options[i],value=options[i+1];
    if(!['--control-root','--project-id','--workspace-root'].includes(key)||values.has(key)||!value||value.startsWith('--'))throw Error(XDEV_USAGE);
    values.set(key,value);}
  const controlRoot=values.get('--control-root')!,projectId=values.get('--project-id')!,workspaceRoot=values.get('--workspace-root')!;
  if(!isAbsolute(controlRoot)||resolve(controlRoot)!==controlRoot||!isAbsolute(workspaceRoot)||resolve(workspaceRoot)!==workspaceRoot||!projectId.trim())throw Error(XDEV_USAGE);
  return {operation:operation as 'bind-context'|'register-role-domain'|'inspect-role'|'prepare-role',subject:{jobId:jobId as JobId,taskId:taskId as TaskId,controlRoot,projectId,workspaceRoot},extra,refreshFile};
}

export type JobQueryArgs = {
  operation: "status" | "result" | "inspect-resume" | "inspect-legacy";
  jobId: JobId;
  expectedRevision?: number;
  controlRoot: string;
  projectId: string;
  workspaceRoot: string;
};

/** The caller must name the approved control and project identity. Queries never
 * discover a state root, create a JobStore, or select an active Host thread. */
export function parseJobQueryArgs(args: string[]): JobQueryArgs {
  const [operation, jobId, ...tail] = args;
  if (operation !== "status" && operation !== "result" && operation !== "inspect-resume" && operation !== "inspect-legacy") throw new Error(XDEV_USAGE);
  if (typeof jobId !== "string" || !/^job:[0-9a-f-]{36}$/.test(jobId)) throw new Error(XDEV_USAGE);
  let offset = 0;
  let expectedRevision: number | undefined;
  if (operation === "inspect-resume") {
    if (!/^(0|[1-9][0-9]*)$/.test(tail[0] ?? "")) throw new Error(XDEV_USAGE);
    expectedRevision = Number(tail[0]);
    if (!Number.isSafeInteger(expectedRevision)) throw new Error(XDEV_USAGE);
    offset = 1;
  }
  const values = new Map<string, string>();
  const options = tail.slice(offset);
  if (options.length !== 6) throw new Error(XDEV_USAGE);
  for (let i = 0; i < options.length; i += 2) {
    const key = options[i], value = options[i + 1];
    if (!["--control-root", "--project-id", "--workspace-root"].includes(key) || values.has(key) || !value || value.startsWith("--")) throw new Error(XDEV_USAGE);
    values.set(key, value);
  }
  const controlRoot = values.get("--control-root")!, projectId = values.get("--project-id")!, workspaceRoot = values.get("--workspace-root")!;
  if (!isAbsolute(controlRoot) || resolve(controlRoot) !== controlRoot || !isAbsolute(workspaceRoot) || resolve(workspaceRoot) !== workspaceRoot || !projectId.trim()) throw new Error(XDEV_USAGE);
  return { operation, jobId: jobId as JobId, expectedRevision, controlRoot, projectId, workspaceRoot };
}

export function queryJob(args: JobQueryArgs): unknown {
  if (!existsSync(args.workspaceRoot) || !lstatSync(args.workspaceRoot).isDirectory()) throw new Error("JOB_WORKSPACE_NOT_FOUND");
  const local=args.operation==='inspect-legacy'?null:
    assertD1LocalControl(args.workspaceRoot,args.controlRoot,args.projectId);
  if (!existsSync(args.controlRoot) || !lstatSync(args.controlRoot).isDirectory()) throw new Error("JOB_CONTROL_ROOT_NOT_FOUND");
  const jobRoot = productionJobRoot(args.controlRoot, args.projectId);
  if (!existsSync(jobRoot) || !lstatSync(jobRoot).isDirectory()) throw new Error("JOB_STORE_NOT_FOUND");
  const store = new JobStore(jobRoot, { project_id: args.projectId, workspace_root: args.workspaceRoot });
  const journal=store.inspectD1Journal(args.jobId);
  if(args.operation==='inspect-legacy'){
    if(journal.job.d1_intake?.profile)throw Error('D1_PROFILE_NOT_LEGACY');
    if(!journal.job.d1_intake)throw Error('D1_LEGACY_JOURNAL_REQUIRED');
    return {status:'UNBOUND_LEGACY',job_id:args.jobId,revision:journal.revision,
      persisted_state:journal.job.state,profile:null,execution_permitted:false,
      current_project_authority:'UNKNOWN',historical_journal_verified:true,
      historical_control_root:args.controlRoot};
  }
  if(local&&!journal.job.d1_intake?.profile)throw new Error("D1_LEGACY_INTAKE_READ_ONLY");
  if(local&&journal.job.d1_intake?.profile?.request_sha256!==sha256(readFileSync(join(local.root,"profile-request.json"))))
    throw new Error("D1_PROFILE_SOURCE_DRIFT");
  if(local){
    const decision=readProfile({requestId:journal.job.d1_intake!.request_id,projectId:args.projectId,
      workspaceRoot:args.workspaceRoot,controlRoot:args.controlRoot,
      profileFile:join(local.root,"profile-request.json")},local.init.receipt_sha256,local.init.bundle).decision;
    if(canonical(decision)!==canonical(journal.job.d1_intake!.profile))throw Error("D1_PROFILE_DECISION_DRIFT");
  }
  const profileView={profile:journal.job.d1_intake?.profile??null,gates:journal.job.d1_intake?.profile?.gates??[],
    execution_permitted:false,control_integrity:local?"HOST_NATIVE_PARTIAL_VERIFIED":"LEGACY_EXTERNAL_ROOT_READ_ONLY"};
  if(journal.job.d1_intake){
    let resource:ReturnType<D1RoleIntentStore['inspectSendDomainIfPresent']>;
    try{resource=new D1RoleIntentStore(args.controlRoot,args.projectId).inspectSendDomainIfPresent();}
    catch(error){return {status:'D1_WORKER_CROSS_JOURNAL_STOP',operation:args.operation,job_id:args.jobId,
      persisted_job_revision:journal.revision,persisted_job_state:journal.job.state,
      reason:`RESOURCE_JOURNAL_UNREADABLE:${error instanceof Error?error.message:String(error)}`,
      reconciliation_required:true,host_send_required_once:false,execution_permitted:false};}
    const send=resource?.send,jobSend=journal.d1_send;
    const matched=send&&jobSend&&resource?.revision===2&&send.attempt_id===jobSend.attempt_id&&
      send.send_id===jobSend.send_id&&send.packet_sha256===jobSend.packet_sha256&&
      resource.head_sha256===jobSend.resource_head_sha256&&
      canonical(send.packet)===canonical(jobSend.packet);
    if((send||jobSend)&&!matched)return {status:'D1_WORKER_CROSS_JOURNAL_STOP',operation:args.operation,
      job_id:args.jobId,persisted_job_revision:journal.revision,persisted_job_state:journal.job.state,
      resource_revision:resource?.revision??null,resource_send_id:send?.send_id??null,
      job_send_id:jobSend?.send_id??null,reconciliation_required:true,
      host_send_required_once:false,execution_permitted:false};
  }
  const observer = { async getWorkerStatus(): Promise<never> { throw new Error("READ_ONLY_JOB_QUERY_MUST_NOT_OBSERVE_WORKER"); } };
  const surface = new JobControlSurface(store, observer);
  const result = args.operation === "status" ? surface.getJobStatus(args.jobId)
    : args.operation === "result" ? surface.getJobResult(args.jobId)
    : surface.inspectResume(args.jobId, args.expectedRevision!);
  if (result.quality && (result.quality.source_revision !== journal.revision || result.quality.source_head_sha256 !== journal.head_sha256))
    throw Error('SOURCE_CHANGED_DURING_QUERY');
  return {...result,...profileView};
}

export function parseJobIntakeArgs(args: string[]) {
  const [requestId, ...options] = args;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId ?? "") || options.length !== 8) throw new Error(XDEV_USAGE);
  const values = new Map<string, string>();
  for (let i = 0; i < options.length; i += 2) {
    const key = options[i], value = options[i + 1];
    if (!["--control-root", "--project-id", "--workspace-root", "--profile-request"].includes(key) || values.has(key) || !value || value.startsWith("--")) throw new Error(XDEV_USAGE);
    values.set(key, value);
  }
  const controlRoot = values.get("--control-root")!, projectId = values.get("--project-id")!, workspaceRoot = values.get("--workspace-root")!;
  const profileFile=values.get("--profile-request")!;
  if (!isAbsolute(controlRoot) || resolve(controlRoot) !== controlRoot || !isAbsolute(workspaceRoot) || resolve(workspaceRoot) !== workspaceRoot || !projectId.trim() || !isAbsolute(profileFile) || resolve(profileFile)!==profileFile) throw new Error(XDEV_USAGE);
  return { requestId, controlRoot, projectId, workspaceRoot,profileFile };
}

export function parseStatusArgs(args: string[], cwd = process.cwd()): { json: boolean; root: string } {
  let json = false;
  let root: string | undefined;
  let optionsEnded = false;

  for (const value of args) {
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && value === "--json") {
      json = true;
      continue;
    }
    if (value === "--force" || (!optionsEnded && value.startsWith("-"))) throw new Error(XDEV_USAGE);
    if (root !== undefined) throw new Error(XDEV_USAGE);
    root = value;
  }

  return { json, root: resolve(cwd, root ?? ".") };
}

export function parseInitArgs(args: string[], cwd = process.cwd()): { seedPath: string; root: string } {
  if (args.length < 1 || args.length > 2 || args.some((value) => value === "--" || value.startsWith("-"))) {
    throw new Error(XDEV_USAGE);
  }
  return { seedPath: resolve(cwd, args[0]), root: resolve(cwd, args[1] ?? ".") };
}

export function parsePlanValidateArgs(args: string[], cwd = process.cwd()): { planPath: string; root: string } {
  if (args.length < 1 || args.length > 2 || args.some((value) => value === "--" || value.startsWith("-"))) {
    throw new Error(XDEV_USAGE);
  }
  return { planPath: resolve(cwd, args[0]), root: resolve(cwd, args[1] ?? ".") };
}

export type XdevCliDependencies = {
  cwd?: string;
  stdout?: (text: string) => void;
  readTextFile?: (path: string) => string;
  clock?: () => string;
  initialize?: (options: InitializeProjectOptions) => InitializeProjectResult;
};

export function runRoleQualityEntry(args: string[]) {
  const { action, root, values: v } = parseRoleQualityArgs(args), store = new B2Store(root);
  const job = v['--job']!, operation = v['--operation']!, projectHead = v['--expected-head']!, jobHead = v['--expected-job-head']!;
  if (action === 'init') return store.roleQualityInitialize(v['--source']!);
  if (action === 'create') return store.roleQualityCreate(v['--source']!, projectHead);
  if (['quality', 'result'].includes(action)) return store.roleQualityResult(job);
  if (action === 'observe') return store.roleQualityObserve(job, operation, projectHead, jobHead);
  if (action === 'outcome') return store.roleQualityOutcome(job, operation, projectHead, jobHead);
  const file = v['--grant-ref']!, path = isAbsolute(file) ? relative(root, file).replaceAll('\\', '/') : file;
  checkedRelativeFile(path); const locator = parseD1UniqueJson(readProjectFile(root, path).toString('utf8')); validateGrantLocator(locator);
  if (action === 'prepare') return store.roleQualityPrepare(job, operation, locator, projectHead, jobHead);
  if (action === 'cancel') return store.roleQualityCancel(job, operation, locator, projectHead, jobHead);
  return store.roleQualityReconcile(job, operation, locator, projectHead, jobHead);
}

/** Separate B2 grammar; no A-ID migration, implicit initialization or goal text. */
export function parseTaskRunArgs(args: string[]) {
  const [operation, ...tail] = args;
  need(['start', 'run-status', 'run-result'].includes(operation ?? ''), 'ARGUMENT_ACTION');
  const parsed = parseRoleQualityArgs([operation === 'start' ? 'create' : 'result', ...tail]);
  return { operation: operation as 'start' | 'run-status' | 'run-result', root: parsed.root, values: parsed.values };
}

export function runTaskRunEntry(args: string[]) {
  const { operation, root, values } = parseTaskRunArgs(args);
  return operation === 'start'
    ? performB2TaskSource(root, 'start', [values['--source']!, values['--expected-head']!])
    : performB2TaskSource(root, 'result', [values['--job']!]);
}

export function runXdevCli(args: string[], dependencies: XdevCliDependencies = {}): 0 | 1 {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const [command, ...rest] = normalizedArgs;
  const cwd = dependencies.cwd ?? process.cwd();
  const stdout = dependencies.stdout ?? ((text: string) => process.stdout.write(text));

  if (command === 'host-evidence') {
    try {
      need(rest.length === 5 && rest[0] === 'export' && rest[1] === '--project-root' && rest[3] === '--request', 'PUBLIC_EXPORT_USAGE');
      need(!dependencies.clock && !dependencies.readTextFile && !dependencies.initialize, 'STORE_OPTIONS_UNSUPPORTED');
      stdout(JSON.stringify(exportPublicHostObservation(rest[2], rest[4])) + '\n'); return 0;
    } catch (error) { stdout(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n'); return 1; }
  }

  if (command === 'role-quality') {
    try {
      need(!dependencies.clock && !dependencies.readTextFile && !dependencies.initialize, 'STORE_OPTIONS_UNSUPPORTED');
      stdout(JSON.stringify(runRoleQualityEntry(rest)) + '\n'); return 0;
    } catch (error) { stdout(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n'); return 1; }
  }

  if (command === "task") {
    if(rest[0]==='spec'){
      need(!dependencies.clock&&!dependencies.readTextFile&&!dependencies.initialize,'STORE_OPTIONS_UNSUPPORTED');
      need(rest.length===6&&['receive','read','basis'].includes(rest[1]??'')&&rest[2]==='--config'&&rest[4]==='--source','XSPEC_CLI_USAGE');
      const local=loadConfig(rest[3]!),source={path:rest[5]!,sha256:intakeHash(intakeBytes(rest[5]!))},reader=createInputReader(local.config);
      reader.source(source);const c=local.config;
      const value=rest[1]==='basis'?runTaskBasisAction(local,source,reader.read):runXspecAction(local,rest[1] as 'receive'|'read',source,reader.read);
      stdout(JSON.stringify(value)+'\n');return 0;
    }
    if (rest.includes('--mode')) {
      try {
        need(!dependencies.clock && !dependencies.readTextFile && !dependencies.initialize, 'STORE_OPTIONS_UNSUPPORTED');
        stdout(JSON.stringify(runSupervisedEntry(rest)) + '\n'); return 0;
      } catch (error) { stdout(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n'); return 1; }
    }
    if (['start', 'run-status', 'run-result'].includes(rest[0] ?? '')) {
      try {
        need(!dependencies.clock && !dependencies.readTextFile && !dependencies.initialize, 'STORE_OPTIONS_UNSUPPORTED');
        stdout(JSON.stringify(runTaskRunEntry(rest)) + '\n'); return 0;
      } catch (error) { stdout(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n'); return 1; }
    }
    const prepared = prepareD1TaskEntry(rest, cwd);
    const result = prepared.operation === "intake" ? registerD1Job(prepared.intake) : queryJob(prepared.query);
    stdout(`${JSON.stringify({ ...(result as object), task_entry: prepared.task_entry }, null, 2)}\n`);
    return 0;
  }

  if (command === "b2") {
    stdout(`${JSON.stringify(runB2Entry(rest, dependencies), null, 2)}\n`);
    return 0;
  }

  if (command === "job") {
    if (rest[0] === "intake") {
      const result = registerD1Job(parseJobIntakeArgs(rest.slice(1)));
      stdout(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    if (['send-worker','record-worker','reconcile-worker'].includes(rest[0]??'')) {
      const worker=parseWorkerArgs(rest);
      assertD1LocalControl(worker.subject.workspaceRoot,worker.subject.controlRoot,worker.subject.projectId);
      const result=worker.operation==='send-worker'?
        sendWorker(worker.subject,worker.attemptId,worker.file,{},worker.refreshFile):
        recordWorker(worker.subject,worker.attemptId,worker.file,worker.operation);
      stdout(`${JSON.stringify(result,null,2)}\n`);return 0;
    }
    if (['bind-context','register-role-domain','inspect-role','prepare-role'].includes(rest[0]??'')) {
      const role=parseRoleArgs(rest);
      assertD1LocalControl(role.subject.workspaceRoot,role.subject.controlRoot,role.subject.projectId);
      const result=role.operation==='bind-context'?bindD1Context(role.subject,role.extra!):
        role.operation==='register-role-domain'?registerRoleDomain(role.subject,role.extra!):
        role.operation==='inspect-role'?inspectRole(role.subject):prepareRole(role.subject,role.extra!,role.refreshFile);
      stdout(`${JSON.stringify(result,null,2)}\n`);return 0;
    }
    const result = queryJob(parseJobQueryArgs(rest));
    stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (command === "status") {
    const { json, root } = parseStatusArgs(rest, cwd);
    const status = readOwnerStatus(root);
    stdout(`${json ? JSON.stringify(status, null, 2) : formatOwnerStatus(status)}\n`);
    return 0;
  }

  if (command === "init") {
    const d1Intake = rest[0] === "--d1-intake";
    const { seedPath, root } = parseInitArgs(d1Intake ? rest.slice(1) : rest, cwd);
    if (d1Intake && (dependencies.initialize || dependencies.readTextFile || dependencies.clock)) throw new Error("D1_NATIVE_INIT_REQUIRED");
    let source: string;
    try {
      source = (dependencies.readTextFile ?? ((path: string) => readFileSync(path, "utf8")))(seedPath);
    } catch {
      throw new Error("DesignSeed could not be read.\n" + XDEV_USAGE);
    }
    let seed: unknown;
    try {
      seed = JSON.parse(source);
    } catch {
      throw new Error("DesignSeed JSON could not be parsed.");
    }
    const result = (d1Intake?initializeD1LocalProject:dependencies.initialize ?? initializeProject)({
      targetRoot: root,
      seed,
      clock: dependencies.clock ?? (() => new Date().toISOString()),
      ...(d1Intake ? { d1IntakeSource: { seedRef: relative(root, seedPath).replaceAll("\\", "/"), seedBytes: source } } : {}),
    });
    stdout(`Initialized .xdev for ${result.projectId}.\n`);
    return 0;
  }

  if (command === "plan" && rest[0] === "validate") {
    const { planPath, root } = parsePlanValidateArgs(rest.slice(1), cwd);
    let source: string;
    try {
      source = (dependencies.readTextFile ?? ((path: string) => readFileSync(path, "utf8")))(planPath);
    } catch {
      throw new Error("Plan validation file could not be read.\n" + XDEV_USAGE);
    }
    let input: unknown;
    try {
      input = JSON.parse(source);
    } catch {
      throw new Error("Plan validation JSON could not be parsed.");
    }
    const execution = validatePlanCommandFromProject(input, { project_root: root },
      [root, cwd, planPath], dependencies.clock ? { clock: dependencies.clock } : undefined);
    stdout(`${JSON.stringify(execution.result, null, 2)}\n`);
    return execution.exitCode;
  }

  throw new Error(XDEV_USAGE);
}

if (import.meta.main) {
  try {
    process.exitCode = runXdevCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
