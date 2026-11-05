import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { bytes, hash, loadConfig, need, within } from './configure.ts';
import { runLocalSetup } from './local.ts';
import { COMMUNITY_XMEM_BUILD, SDK_MEMBERS } from './sdk-builds.ts';
import { connectXmem, pinTools } from './xmem-client.ts';

const sdkPath = (runtime: string, name: string) => join(runtime, 'dist', 'src', name + '.js');
const ref = (path: string, limit?: number) => ({ path, sha256: hash(bytes(path, limit)) });
const save = (path: string, value: unknown) => {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  return ref(path);
};

async function setup() {
  const { values } = parseArgs({ options: {
    project: { type: 'string' }, data: { type: 'string' },
    runtime: { type: 'string' }, snapshot: { type: 'string' }, consent: { type: 'boolean' },
  } });
  need(values.project && values.data && values.runtime && values.snapshot && values.consent,
    'Usage: node mcp/setup-community-memory.ts --project ABS --data NEW_ABS --runtime ABS --snapshot PROJECT_FILE --consent');
  need(process.platform === 'win32' && process.arch === 'x64' && process.versions.node === '24.20.0',
    'COMMUNITY_SETUP_REQUIRES_WINDOWS_X64_NODE_24_20_0');
  need([values.project, values.data, values.runtime].every(isAbsolute), 'COMMUNITY_SETUP_ABSOLUTE_PATHS_REQUIRED');
  const project = realpathSync.native(values.project);
  const runtime = realpathSync.native(values.runtime);
  const data = resolve(values.data);
  const snapshot = values.snapshot;
  const snapshotPath = resolve(project, snapshot);
  need(snapshot.split('/').every(part => part && part !== '.' && part !== '..') &&
    !/[\\:]/.test(snapshot) && within(project, snapshotPath) && snapshotPath !== project,
    'COMMUNITY_SETUP_SNAPSHOT_MUST_BE_A_PROJECT_FILE');
  bytes(snapshotPath);
  need(!existsSync(join(project, '.xmem')), 'COMMUNITY_SETUP_REQUIRES_A_NEW_XMEM_PROJECT');
  need(!within(project, runtime) && !within(runtime, project) &&
    !within(data, runtime) && !within(runtime, data), 'COMMUNITY_SETUP_RUNTIME_PATH_OVERLAP');

  const names = readdirSync(join(runtime, 'dist', 'src')).filter(name => name.endsWith('.js')).sort();
  const js = names.map(name => ({ name, sha256: ref(join(runtime, 'dist', 'src', name)).sha256 }));
  const packagePath = join(runtime, 'package.json'), lockPath = join(runtime, 'npm-shrinkwrap.json');
  const build = hash(JSON.stringify({ files: js, package_sha256: ref(packagePath).sha256,
    lock_sha256: ref(lockPath).sha256 }));
  need(build === COMMUNITY_XMEM_BUILD && names.length === SDK_MEMBERS[COMMUNITY_XMEM_BUILD].js,
    'COMMUNITY_XMEM_BUILD_MISMATCH');

  const companion = sdkPath(runtime, 'companion');
  const transport = new StdioClientTransport({ command: process.execPath, args: [companion], cwd: project, stderr: 'pipe' });
  const client = new Client({ name: 'xdev-community-setup', version: '1.0.0' });
  const timeout = { timeout: 10000 };
  let tools: Awaited<ReturnType<typeof client.listTools>>['tools'];
  try {
    await client.connect(transport, timeout);
    const list = await client.listTools({}, timeout);
    need(!list.nextCursor && client.getServerVersion()?.name === 'xmem-companion', 'COMMUNITY_COMPANION_UNAVAILABLE');
    pinTools(list.tools, build);
    tools = list.tools;
  } finally {
    await client.close();
  }

  const setup = runLocalSetup(['init', '--project-root', project, '--data-root', data,
    '--project-id', 'xdev-' + hash(project).slice(0, 20), '--stage-inputs']);
  need(setup.exit_code === 0 && 'config' in setup.result, JSON.stringify(setup.result));
  const base = setup.result.config!.path;
  const { config } = loadConfig(base);
  const sdk = (name: string) => import(pathToFileURL(sdkPath(runtime, name)).href);
  const [core, locations, standalone, local] = await Promise.all(
    ['index', 'storage-location', 'standalone', 'local-api'].map(sdk));
  const storageRoot = join(data, 'memory');
  mkdirSync(storageRoot);
  const xmem = core!.initProject(project).config;
  const location = locations!.configureStorageLocation(project, xmem.project_id, {
    consent: true, expected_location_hash: null, mode: 'CUSTOM_LOCAL', storage_root: storageRoot,
  });
  const workspace = config.project_id;
  const configured = standalone!.configureStandalone(project, { consent: true, expected_policy_hash: null, policy: {
    schema_version: 1, mode: 'SEMI_AUTO', enabled: true, workspace_id: workspace,
    default_role: 'developer', allowed_roles: ['developer'], snapshot_files: [snapshot],
    payload_budget_bytes: 16384, max_depth: 0, max_nodes: 64,
    capture_categories: ['DECISION', 'CONSTRAINT', 'REQUIREMENT_CHANGE', 'FAILED_APPROACH',
      'ROOT_CAUSE_HYPOTHESIS', 'IMPORTANT_DISCOVERY', 'HANDOFF_STATE'], visible_receipts: true,
  } });
  need(configured.ok, JSON.stringify(configured.error));
  const captured = local!.captureLocalSnapshot(project, { workspace_id: workspace, files: [snapshot] });
  need(captured.ok, JSON.stringify(captured.error));
  const status = standalone!.standaloneStatus(project, 'sdk');
  need(status.ok && location.location_hash === status.value.storage_location.location_hash,
    'COMMUNITY_XMEM_POLICY_OR_LOCATION_INVALID');

  const members = [...names.map(name => 'dist/src/' + name), 'package.json', 'npm-shrinkwrap.json'];
  const files = members.map(path => {
    const content = bytes(join(runtime, path));
    return { path, bytes: content.length, sha256: hash(content) };
  });
  config.memory_bridge = {
    format: 'xdev-xmem-companion-bridge-1',
    node: ref(process.execPath, 128 * 1024 * 1024), server: ref(companion),
    deployment: save(join(config.input_root, 'xmem-deployment.json'), {
      format: 'XMEM_DEPLOYED_FILE_INVENTORY_NOT_LOADED_PROCESS_IDENTITY',
      runtime_root: runtime, count: files.length, files,
    }),
    tool_pins: save(join(config.input_root, 'xmem-tools.json'), { tools }),
    project_id: xmem.project_id, workspace_id: workspace, task_ref: 'community-project',
    task_version: hash('community-project-v1'), role: 'developer', recipient: 'project-coordinator',
    policy_hash: status.value.policy_hash, location_hash: status.value.storage_location.location_hash,
    storage_root: storageRoot, event_namespace: workspace,
    permissions: { recall: true, capture: true, reconcile: true, checkpoint: true },
    approved_sources: [], required_context: true,
    limits: { call_ms: 10000, total_ms: 60000, payload_bytes: 16384, response_bytes: 262144, stderr_bytes: 8192 },
  };
  const peer = await connectXmem(config);
  await peer.close();
  const configPath = save(join(data, 'community-config.json'), config).path;
  loadConfig(configPath);
  const server = fileURLToPath(new URL('./server.ts', import.meta.url));
  const source = fileURLToPath(new URL('../', import.meta.url));
  const plugin = join(data, 'codex-xdev');
  const marketplace = join(plugin, '.agents', 'plugins');
  mkdirSync(marketplace, { recursive: true });
  cpSync(join(source, '.codex-plugin'), join(plugin, '.codex-plugin'), { recursive: true });
  cpSync(join(source, 'skills'), join(plugin, 'skills'), { recursive: true });
  mkdirSync(join(plugin, 'docs'));
  cpSync(join(source, 'docs', 'COMMUNITY.md'), join(plugin, 'docs', 'COMMUNITY.md'));
  save(join(marketplace, 'marketplace.json'), {
    name: 'xsuite-community-local', interface: { displayName: 'X Suite Community' },
    plugins: [{ name: 'xdev', source: { source: 'local', path: './' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools' }],
  });
  save(join(plugin, '.mcp.json'), { mcpServers: { xdev: {
    type: 'stdio', command: process.execPath, args: ['--experimental-strip-types', server, '--config', configPath],
  } } });
  console.log(JSON.stringify({ config: configPath, sdk_build: build, xmem_project_id: xmem.project_id,
    xdev_plugin_directory: plugin,
    xmem: ['codex', 'mcp', 'add', 'xmem', '--', process.execPath, sdkPath(runtime, 'engineering-companion')],
  }, null, 2));
}

try {
  await setup();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
