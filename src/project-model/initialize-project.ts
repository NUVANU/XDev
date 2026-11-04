import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type BigIntStats,
  type MakeDirectoryOptions,
  type RmOptions,
  type Stats,
  type WriteFileOptions,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { buildProjectModel, type ProjectModelBundle, type ProjectModelClock } from "./build-project-model.ts";
import type { DesignSeed } from "./types.ts";
import { validateProjectModel } from "./validate.ts";
import { D1_RECEIPT, makeD1InitReceipt } from "./init-receipt.ts";

export type InitializerFileSystem = {
  statSync(path: string): Stats;
  lstatSync(path: string): BigIntStats;
  realpathSync(path: string): string;
  mkdirSync(path: string, options?: MakeDirectoryOptions): string | undefined;
  readdirSync(path: string): string[];
  writeFileSync(path: string, data: string, options: WriteFileOptions): void;
  renameSync(oldPath: string, newPath: string): void;
  rmSync(path: string, options: RmOptions): void;
  randomId(): string;
};

export type InitializerHooks = {
  beforeWrite?(relativePath: string): void;
  beforePublish?(): void;
};

export type InitializeProjectOptions = {
  targetRoot: string;
  seed: unknown;
  clock: ProjectModelClock;
  fileSystem?: InitializerFileSystem;
  hooks?: InitializerHooks;
  /** Explicit D1 mode: bind the original project-local seed bytes in the atomic publication. */
  d1IntakeSource?: { seedRef: string; seedBytes: string };
};

export type InitializeProjectResult = {
  projectId: string;
  targetDirectory: string;
  relativeFiles: string[];
};

export const nodeInitializerFileSystem: InitializerFileSystem = {
  statSync,
  lstatSync: (path: string) => lstatSync(path, { bigint: true }),
  realpathSync,
  mkdirSync,
  readdirSync: (path: string) => readdirSync(path),
  writeFileSync,
  renameSync,
  rmSync,
  randomId: randomUUID,
};

export class ProjectInitializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectInitializationError";
  }
}

type OutputFile = { relativePath: string; value: unknown };
type EntryIdentity = {
  dev: bigint;
  ino: bigint;
  birthtimeMs: bigint;
  realPath: string;
  type: "directory" | "file";
};

function externalFailure(message: string): ProjectInitializationError {
  return new ProjectInitializationError(message);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function pathExists(fileSystem: InitializerFileSystem, path: string, failureMessage: string): boolean {
  try {
    fileSystem.lstatSync(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw externalFailure(failureMessage);
  }
}

function captureEntryIdentity(
  fileSystem: InitializerFileSystem,
  path: string,
  expectedType: EntryIdentity["type"],
  kind: "staging" | "output",
): EntryIdentity {
  try {
    const stats = fileSystem.lstatSync(path);
    const realPath = fileSystem.realpathSync(path);
    const correctType = expectedType === "directory" ? stats.isDirectory() : stats.isFile();
    if (!correctType || stats.isSymbolicLink() || realPath !== path) {
      throw new Error("not an exact non-reparse entry");
    }
    return { dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs, realPath, type: expectedType };
  } catch {
    throw new ProjectInitializationError(`Initialization stopped because ${kind} ownership was lost.`);
  }
}

function assertEntryIdentity(
  fileSystem: InitializerFileSystem,
  path: string,
  expected: EntryIdentity,
  kind: "staging" | "output",
  expectedRealPath = expected.realPath,
): void {
  const current = captureEntryIdentity(fileSystem, path, expected.type, kind);
  if (current.dev !== expected.dev
    || current.ino !== expected.ino
    || current.birthtimeMs !== expected.birthtimeMs
    || current.type !== expected.type
    || current.realPath !== expectedRealPath) {
    throw new ProjectInitializationError(`Initialization stopped because ${kind} ownership was lost.`);
  }
}

function assertExactOwnedTree(
  fileSystem: InitializerFileSystem,
  root: string,
  rootIdentity: EntryIdentity,
  manifest: Map<string, EntryIdentity>,
  published = false,
): void {
  assertEntryIdentity(fileSystem, root, rootIdentity, "staging", published ? root : rootIdentity.realPath);
  const seen = new Set<string>();
  const visit = (relativeDirectory: string): void => {
    const directory = relativeDirectory ? resolveContainedPath(root, relativeDirectory) : root;
    let names: string[];
    try {
      names = [...fileSystem.readdirSync(directory)].sort((left, right) => left.localeCompare(right, "en"));
    } catch {
      throw new ProjectInitializationError("Initialization stopped because staging ownership was lost.");
    }
    for (const name of names) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const expected = manifest.get(relativePath);
      if (!expected) throw new ProjectInitializationError("Initialization stopped because staging ownership was lost.");
      const absolutePath = resolveContainedPath(root, relativePath);
      assertEntryIdentity(fileSystem, absolutePath, expected, "output", published ? absolutePath : expected.realPath);
      seen.add(relativePath);
      if (expected.type === "directory") visit(relativePath);
    }
  }
  visit("");
  if (seen.size !== manifest.size) throw new ProjectInitializationError("Initialization stopped because staging ownership was lost.");
}

export function resolveContainedPath(root: string, repositoryRelativePath: string): string {
  if (!repositoryRelativePath || isAbsolute(repositoryRelativePath)) {
    throw new ProjectInitializationError("Initializer output path must remain inside the target .xdev directory.");
  }
  const normalizedRoot = resolve(root);
  const output = resolve(normalizedRoot, repositoryRelativePath);
  const relation = relative(normalizedRoot, output);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new ProjectInitializationError("Initializer output path must remain inside the target .xdev directory.");
  }
  return output;
}

function assertValidBundle(bundle: ProjectModelBundle): void {
  const validate = (schemaName: Parameters<typeof validateProjectModel>[0], objectId: string, value: unknown): void => {
    const result = validateProjectModel(schemaName, value);
    if (!result.valid) {
      throw new ProjectInitializationError(`${objectId} schema validation failed: ${result.errors.join(" ")}`);
    }
  };

  validate("requirementRegistry", "RequirementRegistry", bundle.requirement_registry);
  validate("projectState", "ProjectState", bundle.project_state);
  for (const milestone of bundle.milestones) validate("milestone", milestone.milestone_id, milestone);
  for (const task of bundle.tasks) validate("taskContract", task.task_id, task);
  for (const gate of bundle.owner_gates) validate("ownerGate", gate.owner_gate_id, gate);

  const milestoneIds = new Set(bundle.milestones.map((milestone) => milestone.milestone_id));
  const taskIds = new Set(bundle.tasks.map((task) => task.task_id));
  const gateIds = new Set(bundle.owner_gates.map((gate) => gate.owner_gate_id));
  const state = bundle.project_state;
  if (bundle.requirement_registry.project_id !== state.project_id) {
    throw new ProjectInitializationError("ProjectState.project_id does not match RequirementRegistry.project_id.");
  }
  if (!milestoneIds.has(state.current_milestone_id)) {
    throw new ProjectInitializationError(`ProjectState.current_milestone_id: ${state.current_milestone_id} does not resolve.`);
  }
  for (const taskId of state.active_task_ids) {
    if (!taskIds.has(taskId)) throw new ProjectInitializationError(`ProjectState.active_task_ids: ${taskId} does not resolve.`);
  }
  for (const gateId of state.owner_gate_ids) {
    if (!gateIds.has(gateId)) throw new ProjectInitializationError(`ProjectState.owner_gate_ids: ${gateId} does not resolve.`);
  }
}

function outputFiles(bundle: ProjectModelBundle): OutputFile[] {
  return [
    { relativePath: "project-state.json", value: bundle.project_state },
    { relativePath: "requirements/registry.json", value: bundle.requirement_registry },
    ...bundle.milestones.map((value) => ({ relativePath: `milestones/${value.milestone_id}.json`, value })),
    ...bundle.tasks.map((value) => ({ relativePath: `tasks/${value.task_id}.json`, value })),
    ...bundle.owner_gates.map((value) => ({ relativePath: `owner-gates/${value.owner_gate_id}.json`, value })),
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validatedRoot(fileSystem: InitializerFileSystem, targetRoot: string): string {
  try {
    if (!fileSystem.statSync(targetRoot).isDirectory()) throw externalFailure("Target project root must be an existing directory.");
    return fileSystem.realpathSync(targetRoot);
  } catch (error) {
    if (error instanceof ProjectInitializationError) throw error;
    throw externalFailure("Target project root must be an existing directory.");
  }
}

function isOwnedStagingPath(root: string, stagingPath: string, stagingName: string): boolean {
  return dirname(stagingPath) === root
    && basename(stagingPath) === stagingName
    && /^\.xdev\.staging-[A-Za-z0-9-]{8,}$/.test(stagingName);
}

export function initializeProject(options: InitializeProjectOptions): InitializeProjectResult {
  const fileSystem = options.fileSystem ?? nodeInitializerFileSystem;
  const schemaResult = validateProjectModel("designSeed", options.seed);
  if (!schemaResult.valid) {
    throw new ProjectInitializationError(`DesignSeed schema validation failed: ${schemaResult.errors.join(" ")}`);
  }

  let bundle: ProjectModelBundle;
  try {
    bundle = buildProjectModel(schemaResult.value as DesignSeed, options.clock);
  } catch (error) {
    throw error instanceof ProjectInitializationError
      ? error
      : new ProjectInitializationError(error instanceof Error ? error.message : "DesignSeed validation failed.");
  }
  assertValidBundle(bundle);
  const files = outputFiles(bundle);

  const root = validatedRoot(fileSystem, resolve(options.targetRoot));
  const target = resolveContainedPath(root, ".xdev");
  if (pathExists(fileSystem, target, "Unable to inspect the target .xdev path.")) {
    throw new ProjectInitializationError(".xdev already exists; initialization refuses overwrite.");
  }
  if (options.d1IntakeSource) {
    if (options.fileSystem) throw new ProjectInitializationError("D1 intake source requires the native project filesystem.");
    const receipt = makeD1InitReceipt(root, options.d1IntakeSource.seedRef, options.d1IntakeSource.seedBytes, schemaResult.value as DesignSeed, bundle);
    files.push({ relativePath: D1_RECEIPT, value: receipt });
  }

  const randomId = fileSystem.randomId();
  if (!/^[A-Za-z0-9-]{8,}$/.test(randomId)) throw new ProjectInitializationError("Initializer could not create a safe staging name.");
  const stagingName = `.xdev.staging-${randomId}`;
  const staging = resolveContainedPath(root, stagingName);
  if (!isOwnedStagingPath(root, staging, stagingName)) throw new ProjectInitializationError("Initializer staging path failed containment validation.");

  let stagingPresent = false;
  let ownershipUncertain = false;
  let stagingIdentity: EntryIdentity | undefined;
  const manifest = new Map<string, EntryIdentity>();
  try {
    if (pathExists(fileSystem, staging, "Unable to inspect the initializer staging path.")) {
      throw new ProjectInitializationError("Initializer staging path already exists.");
    }
    try {
      fileSystem.mkdirSync(staging);
      stagingPresent = true;
      ownershipUncertain = true;
      stagingIdentity = captureEntryIdentity(fileSystem, staging, "directory", "staging");
      ownershipUncertain = false;
      for (const directory of ["milestones", "owner-gates", "requirements", "tasks"]) {
        assertEntryIdentity(fileSystem, staging, stagingIdentity, "staging");
        const child = resolveContainedPath(staging, directory);
        ownershipUncertain = true;
        fileSystem.mkdirSync(child);
        manifest.set(directory, captureEntryIdentity(fileSystem, child, "directory", "output"));
        ownershipUncertain = false;
      }
    } catch (error) {
      if (error instanceof ProjectInitializationError) throw error;
      throw externalFailure("Initialization failed while creating the staging tree.");
    }

    for (const file of files) {
      let pendingOutputPath: string | undefined;
      try {
        options.hooks?.beforeWrite?.(file.relativePath);
        assertEntryIdentity(fileSystem, staging, stagingIdentity, "staging");
        const parent = dirname(file.relativePath).replaceAll("\\", "/");
        if (parent !== ".") {
          const parentIdentity = manifest.get(parent);
          if (!parentIdentity) throw new ProjectInitializationError("Initialization stopped because output directory ownership was lost.");
          assertEntryIdentity(fileSystem, resolveContainedPath(staging, parent), parentIdentity, "output");
        }
        const outputPath = resolveContainedPath(staging, file.relativePath);
        pendingOutputPath = outputPath;
        ownershipUncertain = true;
        fileSystem.writeFileSync(outputPath, stableJson(file.value), { encoding: "utf8", flag: "wx" });
        manifest.set(file.relativePath, captureEntryIdentity(fileSystem, outputPath, "file", "output"));
        ownershipUncertain = false;
      } catch (error) {
        if (ownershipUncertain && pendingOutputPath) {
          try {
            if (!pathExists(fileSystem, pendingOutputPath, "Unable to inspect an incomplete initializer output.")) {
              ownershipUncertain = false;
            }
          } catch {
            // Preserve the staging tree when the outcome of a write cannot be proven.
          }
        }
        if (error instanceof ProjectInitializationError) throw error;
        throw externalFailure(`Initialization failed while writing ${file.relativePath}.`);
      }
    }

    try {
      assertExactOwnedTree(fileSystem, staging, stagingIdentity, manifest);
      options.hooks?.beforePublish?.();
      assertExactOwnedTree(fileSystem, staging, stagingIdentity, manifest);
      if (pathExists(fileSystem, target, "Unable to inspect the target .xdev path before publication.")) {
        throw new ProjectInitializationError(".xdev appeared before publication; initialization refuses overwrite.");
      }
      assertExactOwnedTree(fileSystem, staging, stagingIdentity, manifest);
      fileSystem.renameSync(staging, target);
      stagingPresent = false;
      try {
        assertExactOwnedTree(fileSystem, target, stagingIdentity, manifest, true);
      } catch {
        throw externalFailure("Initialization failed because published .xdev ownership was lost; cleanup was skipped.");
      }
    } catch (error) {
      if (error instanceof ProjectInitializationError) throw error;
      throw externalFailure("Initialization failed while publishing .xdev; no existing target was overwritten.");
    }
  } catch (error) {
    if (stagingPresent) {
      try {
        if (!stagingIdentity || ownershipUncertain || !isOwnedStagingPath(root, staging, stagingName)) throw new Error("ownership lost");
        assertExactOwnedTree(fileSystem, staging, stagingIdentity, manifest);
        fileSystem.rmSync(staging, { recursive: true, force: true });
        stagingPresent = false;
      } catch {
        throw externalFailure("Initialization failed; staging ownership was lost, so cleanup was skipped or could not be performed.");
      }
    }
    throw error;
  }

  return { projectId: bundle.project_state.project_id, targetDirectory: target, relativeFiles: files.map((file) => file.relativePath) };
}
