import { B2Store } from '../job-runtime/d1-b2-store.ts';
import { b2Need as need } from '../job-runtime/d1-b2-contracts.ts';

/** Actual CLI entry. Native source reads and time cannot be injected. */
export function runB2Entry(args: string[], dependencies: object = {}) {
  need(!['readTextFile', 'clock', 'initialize'].some(k => Object.hasOwn(dependencies, k)), 'NATIVE_ENTRY_REQUIRED');
  const [command, ...rest] = args;
  need(['init', 'allocate', 'create', 'status', 'result', 'resume'].includes(command ?? ''), 'CLI_COMMAND');
  need(rest.length % 2 === 0, 'CLI_ARGUMENT'); const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) { const key = rest[i]!, value = rest[i + 1]!;
    need(['--project-root', '--source', '--expected-project-head', '--job-id'].includes(key) && !Object.hasOwn(flags, key) && value.length > 0, 'CLI_ARGUMENT'); flags[key] = value; }
  const mutation = ['init', 'allocate', 'create'].includes(command!);
  const required = mutation ? command === 'init' ? ['--project-root', '--source'] : ['--project-root', '--source', '--expected-project-head'] : ['--project-root'];
  need(required.every(k => Object.hasOwn(flags, k)) && Object.keys(flags).every(k => required.includes(k) || !mutation && k === '--job-id'), 'CLI_ARGUMENT');
  const store = new B2Store(flags['--project-root']!);
  if (command === 'init') return store.initialize(flags['--source']!);
  if (command === 'allocate') return store.allocate(flags['--source']!, flags['--expected-project-head']!);
  if (command === 'create') return store.create(flags['--source']!, flags['--expected-project-head']!);
  return store.query(flags['--job-id']);
}
