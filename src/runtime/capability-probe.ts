import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type CommandFact = {
  available: boolean;
  exitCode: number | null;
  output?: string;
};

export type CapabilitySnapshot = {
  capturedAt: string;
  ownerPolicy: "balanced";
  facts: {
    node: CommandFact;
    pnpm: CommandFact;
    codex: CommandFact;
    git: CommandFact;
    codexExecModelOverride: boolean;
  };
  limitations: string[];
};

export const PROBE_SPAWN_OPTIONS = {
  encoding: "utf8" as const,
  shell: false,
  timeout: 10_000,
};

export type CapabilityProbeEnvironment = {
  platform: NodeJS.Platform;
  npmExecPath?: string;
  execPath: string;
};

export function resolveCapabilityCommands(
  environment: CapabilityProbeEnvironment = {
    platform: process.platform,
    npmExecPath: process.env.npm_execpath,
    execPath: process.execPath,
  },
): Record<"node" | "pnpm" | "codex" | "git", { command: string; args: string[] }> {
  return {
    node: { command: environment.execPath, args: ["--version"] },
    pnpm: environment.npmExecPath
      ? { command: environment.execPath, args: [environment.npmExecPath, "--version"] }
      : { command: environment.platform === "win32" ? "pnpm.cmd" : "pnpm", args: ["--version"] },
    codex: { command: "codex", args: ["exec", "--help"] },
    git: { command: "git", args: ["--version"] },
  };
}

export function probeCommand(command: string, args: string[] = ["--version"]): CommandFact {
  const result = spawnSync(command, args, PROBE_SPAWN_OPTIONS);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const unavailable = Boolean(result.error) || result.status === null;

  return {
    available: !unavailable && result.status === 0,
    exitCode: result.status,
    ...(output ? { output } : {}),
  };
}

export function createCapabilitySnapshot(
  runCommand = probeCommand,
  environment?: CapabilityProbeEnvironment,
): CapabilitySnapshot {
  const commands = resolveCapabilityCommands(environment);
  const node = runCommand(commands.node.command, commands.node.args);
  const pnpm = runCommand(commands.pnpm.command, commands.pnpm.args);
  const codex = runCommand(commands.codex.command, commands.codex.args);
  const git = runCommand(commands.git.command, commands.git.args);
  const codexHelp = codex.output ?? "";
  const limitations: string[] = [];

  if (!pnpm.available) limitations.push("pnpm was not available on PATH.");
  if (!codex.available) limitations.push("Codex CLI was unavailable or could not report its help text.");
  if (!git.available) limitations.push("Git was unavailable on PATH.");
  limitations.push("This probe records local command availability only; it does not claim account-specific model availability.");

  return {
    capturedAt: new Date().toISOString(),
    ownerPolicy: "balanced",
    facts: {
      node,
      pnpm,
      codex,
      git,
      codexExecModelOverride: /(?:--model|\s-m[\s,])/.test(codexHelp),
    },
    limitations,
  };
}

/** Writes only to the repository's capability-snapshot directory via temp + rename. */
export function writeCapabilitySnapshot(
  projectRoot: string,
  repositoryRelativePath: string,
  snapshot = createCapabilitySnapshot(),
): string {
  if (isAbsolute(repositoryRelativePath)) {
    throw new Error("Capability snapshot output must be a repository-relative path.");
  }

  const root = resolve(projectRoot);
  const output = resolve(root, repositoryRelativePath);
  const snapshotsDirectory = resolve(root, ".xdev", "capability-snapshots");
  const directoryRelation = relative(snapshotsDirectory, output);
  if (
    directoryRelation === "" ||
    directoryRelation.startsWith(`..${sep}`) ||
    isAbsolute(directoryRelation) ||
    !output.endsWith(".json")
  ) {
    throw new Error("Capability snapshot output must be a .json file under .xdev/capability-snapshots.");
  }

  mkdirSync(snapshotsDirectory, { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(temporary, output);
  return output;
}

if (import.meta.main) {
  const snapshot = createCapabilitySnapshot();
  const writeIndex = process.argv.indexOf("--write");
  if (writeIndex !== -1) {
    const output = process.argv[writeIndex + 1];
    if (!output) throw new Error("--write requires a repository-relative output path.");
    writeCapabilitySnapshot(process.cwd(), output, snapshot);
  }
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}
