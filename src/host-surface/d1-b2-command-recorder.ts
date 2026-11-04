import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { b2Exact as exact, b2Need as need, b2List, b2Time, type B2Record } from '../job-runtime/d1-b2-contracts.ts';
import { checkedRelativeFile, projectRootIdentity, readProjectFile, sha256 } from '../project-model/init-receipt.ts';
import { parseD1UniqueJson } from '../job-runtime/contracts.ts';
import { jsonBytes, nativeCurrentSubject, nativeFileIdentity, nativeManifestHash } from './d1-b2-source.ts';

/** A foreground recorder, never a worker loop or an authority issuer. The port independently binds its request and output. */
export function recordB2Command(projectRoot: string, requestPath: string) {
  need(arguments.length === 2, 'RECORDER_ARGUMENTS'); const root = projectRootIdentity(projectRoot).root;
  need(root === projectRoot && isAbsolute(requestPath), 'RECORDER_ROOT');
  const rel = relative(root, requestPath).replaceAll('\\', '/'); checkedRelativeFile(rel);
  const requestBytes = readProjectFile(root, rel); need(requestBytes.length <= 1048576, 'RECORDER_REQUEST_SIZE');
  const r = parseD1UniqueJson(requestBytes.toString('utf8')) as B2Record;
  exact(r, ['format', 'job_id', 'task_id', 'attempt_id', 'role_id', 'subject', 'contract_ref', 'criteria_ref',
    'candidate_manifest', 'environment', 'mode', 'read_plan', 'test_plan', 'managed_request_identity']);
  need(r.format === 'xdev-native-recorder-request-3' && ['READ', 'QA'].includes(r.mode) &&
    jsonBytes(r) === requestBytes.toString('utf8'), 'RECORDER_REQUEST');
  const identity = r.managed_request_identity; exact(identity, ['dev', 'ino', 'relativepath']);
  const stat = lstatSync(requestPath, { bigint: true });
  need(identity.dev === String(stat.dev) && identity.ino === String(stat.ino) && identity.relativepath === rel, 'RECORDER_REQUEST_IDENTITY');
  const taskBytes = readProjectFile(root, r.contract_ref.id.slice(5));
  need(sha256(taskBytes) === r.contract_ref.sha256, 'SOURCE_DRIFT');
  const task = parseD1UniqueJson(taskBytes.toString('utf8')) as B2Record;
  need(task.format === 'xdev-b2-task-source-3', 'SOURCE_CONTRACT');
  const managed = r.candidate_manifest.excluded.filter((x: B2Record) => x.reason === 'MANAGED_INPUT').map((x: B2Record) => x.path);
  need(managed.includes(rel), 'RECORDER_MANAGED_REQUEST');
  const policy = { project: { project_id: r.subject.workspace_id.split(':')[1] }, epoch_id: r.subject.workspace_id.split(':')[2],
    runtime: r.environment.runtime, scope: { managed_inputs: managed, candidate_exclusions: managed,
      allowed_paths: task.allowed_scope, forbidden_paths: task.forbidden_scope } };
  const before = nativeCurrentSubject(root, policy, r.contract_ref);
  // Record the actual pre-command candidate even after an author patch. This grants no authority:
  // the native port separately requires a worker role, original patch records and accepted scope for any difference.
  need(['physical_root', 'physical_identity', 'workspace_id', 'contract_sha256', 'criteria_sha256', 'environment_sha256']
    .every(k => before.subject[k as keyof typeof before.subject] === r.subject[k]) &&
    nativeManifestHash(before.environment) === nativeManifestHash(r.environment), 'RECORDER_SUBJECT_DRIFT');
  b2List(r.read_plan, 1, 16, plan => { exact(plan, ['id', 'role_ordinal', 'paths', 'coverage']); b2List(plan.paths, 1, 64, checkedRelativeFile); });
  const paths: string[] = [...new Set<string>(r.read_plan.flatMap((p: B2Record) => p.paths))];
  need(paths.includes(r.contract_ref.id.slice(5)) && task.criteria.every((c: B2Record) => paths.includes(c.source_ref.path)), 'RECORDER_TASK_AC_READ');
  const startedAt = new Date().toISOString();
  const reads = paths.map(path => { const bytes = readProjectFile(root, path);
    need(bytes.length <= 65536, 'RECORDER_READ_LIMIT'); const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { path, bytes: bytes.length, sha256: sha256(bytes), body, identity: nativeFileIdentity(join(root, path)) }; });
  const tests: B2Record[] = []; let status = 'completed';
  b2List(r.test_plan, 0, 16, p => {
    exact(p, ['id', 'role_ordinal', 'argv', 'cwd', 'timeout_ms', 'max_buffer', 'coverage', 'environment']);
    need(p.cwd === root && Number.isSafeInteger(p.timeout_ms) && p.timeout_ms > 0 && p.timeout_ms <= 120000 &&
      Number.isSafeInteger(p.max_buffer) && p.max_buffer > 0 && p.max_buffer <= 65536, 'RECORDER_TEST_PLAN');
    b2List(p.argv, 1, 64, x => need(typeof x === 'string' && x.length > 0 && x.length <= 8192, 'RECORDER_ARGV'));
    // This bounded recorder supports the pinned Node runtime only; no supplied shell command is interpreted.
    need(p.argv[0] === r.environment.runtime.node.path, 'RECORDER_RUNTIME');
    b2List(p.environment, 0, 16, x => { exact(x, ['name', 'value']);
      need(typeof x.name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(x.name) &&
        !['HOME', 'CODEX_HOME', 'PATH', 'NODE_OPTIONS'].includes(x.name) && typeof x.value === 'string', 'RECORDER_ENVIRONMENT'); });
  });
  if (r.mode === 'QA') for (const plan of r.test_plan) {
    const started = new Date().toISOString();
    const child = spawnSync(plan.argv[0], plan.argv.slice(1), { cwd: root, shell: false, windowsHide: true,
      timeout: plan.timeout_ms, maxBuffer: plan.max_buffer, encoding: 'utf8',
      env: { ...process.env, ...Object.fromEntries(plan.environment.map((e: B2Record) => [e.name, e.value])) } });
    const ended = new Date().toISOString();
    const known = !child.error && !child.signal && Number.isSafeInteger(child.status) &&
      typeof child.stdout === 'string' && typeof child.stderr === 'string' &&
      Buffer.byteLength(child.stdout) <= plan.max_buffer && Buffer.byteLength(child.stderr) <= plan.max_buffer;
    const stdout = typeof child.stdout === 'string' ? child.stdout : '', stderr = typeof child.stderr === 'string' ? child.stderr : '';
    tests.push({ id: plan.id, argv: plan.argv, cwd: root, started_at: started, ended_at: ended,
      status: known ? 'completed' : 'unknown', exit_code: known ? child.status : null, stdout, stderr,
      stdout_sha256: sha256(stdout), stderr_sha256: sha256(stderr) });
    if (!known) { status = 'unknown'; break; }
    if (child.status !== 0) status = 'failed';
  }
  const after = nativeCurrentSubject(root, policy, r.contract_ref), endedAt = new Date().toISOString();
  need(b2Time(endedAt) >= b2Time(startedAt) && sha256(readProjectFile(root, rel)) === sha256(requestBytes), 'RECORDER_REQUEST_DRIFT');
  const result = { format: 'xdev-native-recorder-result-3', job_id: r.job_id, task_id: r.task_id,
    attempt_id: r.attempt_id, role_id: r.role_id, mode: r.mode, subject_before: before.subject, subject_after: after.subject,
    candidate_before: before.candidate, candidate_after: after.candidate, environment_before: before.environment,
    environment_after: after.environment, reads, tests, started_at: startedAt, ended_at: endedAt, status };
  need(Buffer.byteLength(jsonBytes(result)) <= 65536, 'RECORDER_OUTPUT_LIMIT'); return result;
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2); need(args.length === 4 && args[0] === '--project-root' && args[2] === '--request', 'RECORDER_ARGUMENTS');
    const result = recordB2Command(args[1]!, args[3]!); process.stdout.write(jsonBytes(result));
    process.exitCode = result.status === 'completed' ? 0 : result.status === 'failed' ? 1 : 2;
  } catch (error) { process.stdout.write(jsonBytes({ error: error instanceof Error ? error.message : String(error) })); process.exitCode = 2; }
}
