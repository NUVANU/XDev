import { isAbsolute, resolve } from 'node:path';

// Syntax-only equivalents of the existing predicates. Keep this module's runtime
// graph limited to node:path; source and grant authority belong to the runner.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
function need(ok: unknown, code: string): asserts ok { if (!ok) throw Error(`B2_${code}`); }
function exact(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  need(v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype, 'SCHEMA');
  const own = Reflect.ownKeys(v);
  need(own.every(k => typeof k === 'string') && own.length === keys.length && keys.every(k => own.includes(k)), 'SCHEMA');
  need(Object.values(Object.getOwnPropertyDescriptors(v)).every(d => 'value' in d && d.enumerable), 'SCHEMA');
}
function requireFact(ok: unknown, code: string): asserts ok { if (!ok) throw new Error(code); }
function checkedRelativeFile(value: string): string {
  requireFact(typeof value === "string" && value.length > 0 && !isAbsolute(value) && !value.includes("\\")
    && !/[\x00-\x1f<>:"|?*]/.test(value) && !/^[A-Za-z]:/.test(value), "D1_SOURCE_PATH_INVALID");
  requireFact(value.split("/").every(segment => segment && segment !== "." && segment !== ".."
    && !/[. ]$/.test(segment) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment)), "D1_SOURCE_PATH_INVALID");
  return value;
}

export function parseRoleQualityArgs(args: string[]) {
  const [action, ...tail] = args;
  const common = ['--project-root', '--job', '--operation', '--expected-head', '--expected-job-head'];
  const flags: Record<string, string[]> = {
    init: ['--project-root', '--source'], create: ['--project-root', '--source', '--expected-head'],
    prepare: [...common, '--grant-ref'], observe: common, outcome: common,
    cancel: [...common, '--grant-ref'], reconcile: [...common, '--grant-ref'],
    quality: ['--project-root', '--job'], result: ['--project-root', '--job'],
  };
  need(typeof action === 'string' && Object.hasOwn(flags, action), 'ARGUMENT_ACTION');
  const required = flags[action]!, values: Record<string, string> = {};
  need(tail.length === required.length * 2, 'ARGUMENT_FLAGS');
  for (let i = 0; i < tail.length; i += 2) {
    const key = tail[i]!, value = tail[i + 1]!;
    need(required.includes(key) && !Object.hasOwn(values, key) && typeof value === 'string' &&
      value.length > 0 && !value.startsWith('--'), 'ARGUMENT_FLAGS'); values[key] = value;
  }
  exact(values, required); const root = values['--project-root']!;
  need(isAbsolute(root) && resolve(root) === root, 'ARGUMENT_ROOT');
  if (values['--job']) need(new RegExp('^job:' + UUID + '$').test(values['--job']), 'ARGUMENT_JOB');
  if (values['--operation']) need(new RegExp('^' + UUID + '$').test(values['--operation']), 'ARGUMENT_OPERATION');
  for (const key of ['--expected-head', '--expected-job-head']) if (values[key]) need(/^[0-9a-f]{64}$/.test(values[key]), 'ARGUMENT_HEAD');
  if (values['--source']) checkedRelativeFile(values['--source']);
  return { action, root, values };
}
