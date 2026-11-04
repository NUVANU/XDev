import { B2Store } from '../job-runtime/d1-b2-store.ts';
import { performB2TaskSource } from '../job-runtime/d1-b2-storage.ts';
import { b2Need as need } from '../job-runtime/d1-b2-contracts.ts';
import { parseRoleQualityArgs } from '../host-surface/d1-role-quality-args.ts';
import { runB2TaskHostWorkflow, type B2HostWorkflowInput, type B2HostPort, type B2HostStorePort } from '../host-surface/d1-b2-host-driver.ts';

export type TaskHostPlan = Omit<B2HostWorkflowInput, 'source' | 'expected_head'>;
export type B2HostPrepareRequest = { project_root: string; job_id: string; operation_id: string;
  grant_locator: Parameters<B2HostStorePort['prepare']>[2]; project_head: string; job_head: string };
export type B2TaskHostPort = B2HostPort & {
  /** Run the enrolled canonical CLI in a separate parent Host exec call and
   * return only AFTER that complete tool call returns. An in-process call or
   * a nested still-open exec frame cannot satisfy prepareReturnBound(). The
   * Host must resolve the original managed grant file and pinned runtime/CLI,
   * preserve exact stdout/stderr/exit, and refuse an unknown/truncated return.
   * This callback is communication, not an authority/source-proof override. */
  prepareRole(request: B2HostPrepareRequest): Promise<unknown>;
};

/** Fixed production composition. Host preparation is communication through the
 * parent Host, while start/observe/outcome/result remain the original Store. */
export function createB2TaskHostStorePort(root: string, host: B2TaskHostPort): B2HostStorePort {
  need(host && typeof host.spawnAgent === 'function' && typeof host.waitForFinal === 'function', 'HOST_PORT_REQUIRED');
  need(typeof host.prepareRole === 'function', 'HOST_PREPARE_CLI_PORT_REQUIRED');
  const store = new B2Store(root);
  return {
    start: (source, head) => performB2TaskSource(root, 'start', [source, head]),
    prepare: (job, operation, grant, projectHead, jobHead) => host.prepareRole({ project_root: root,
      job_id: job, operation_id: operation, grant_locator: structuredClone(grant), project_head: projectHead, job_head: jobHead }),
    observe: (job, operation, projectHead, jobHead) => store.roleQualityObserve(job, operation, projectHead, jobHead),
    outcome: (job, operation, projectHead, jobHead) => store.roleQualityOutcome(job, operation, projectHead, jobHead),
    result: job => store.roleQualityResult(job),
  };
}

/** Codex Host front-end of the same task start grammar. The shell-only CLI has
 * no Host tools: its synchronous registration path deliberately stays intact.
 * The Host supplies tool callbacks, never injected policy, native facts or a
 * replacement Store. Every observation and result uses the original B2 route.
 */
export async function runTaskHostEntry(args: string[], plan: TaskHostPlan, host: B2TaskHostPort) {
  need(args[0] === 'start', 'ARGUMENT_ACTION');
  need(host && typeof host.spawnAgent === 'function' && typeof host.waitForFinal === 'function', 'HOST_PORT_REQUIRED');
  need(typeof host.prepareRole === 'function', 'HOST_PREPARE_CLI_PORT_REQUIRED');
  const { root, values } = parseRoleQualityArgs(['create', ...args.slice(1)]);
  // Never commit prepare in process: the original APPLIED action must first
  // return through the enrolled CLI/Host exec source boundary.
  const port = createB2TaskHostStorePort(root, host);
  return runB2TaskHostWorkflow({ ...structuredClone(plan), source: values['--source']!, expected_head: values['--expected-head']! }, port, host);
}
