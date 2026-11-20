import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
function check(condition: unknown, code: string): asserts condition { if (!condition) throw Error(code); }

export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { check(Number.isFinite(value), "JOB_JSON_INVALID"); return JSON.stringify(value); }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  check(value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype, "JOB_JSON_INVALID");
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
}

export function productionJobRoot(approvedControlRoot: string, projectId: string): string {
  check(isAbsolute(approvedControlRoot) && resolve(approvedControlRoot) === approvedControlRoot, "JOB_STORAGE_PATH_INVALID");
  check(projectId.length > 0, "JOB_PROJECT_INVALID");
  return join(approvedControlRoot, "recoverable-jobs-" + createHash("sha256").update(projectId).digest("hex"));
}

export function projectLocalLayout(projectRoot: string) {
  const dataRoot = join(projectRoot, '.xdev');
  return {dataRoot, controlRoot: join(dataRoot, 'control'), inputRoot: join(dataRoot, 'input'), configPath: join(dataRoot, 'local-config.json')};
}

export function isProjectLocalControl(projectRoot: string, controlRoot?: string) {
  return controlRoot === projectLocalLayout(projectRoot).controlRoot;
}

function reservedDataPaths(projectRoot: string) {
  const {controlRoot, inputRoot, configPath} = projectLocalLayout(projectRoot);
  return [controlRoot, inputRoot, configPath];
}

export function isProjectLocalDataPath(projectRoot: string, path: string) {
  return reservedDataPaths(projectRoot).some(root => path === root || path.startsWith(root + sep));
}

export function isProjectLocalScopePath(projectRoot: string, path: string) {
  if (isProjectLocalDataPath(projectRoot, path)) return true;
  if (process.platform !== 'win32') return false;
  const folded = path.toLowerCase();
  return reservedDataPaths(projectRoot).some(root => {
    const candidate = path.slice(0, root.length);
    const reserved = root.toLowerCase();
    if (folded !== reserved && !folded.startsWith(reserved + sep)) return false;
    // Compare the reserved ancestor even when the requested leaf is new.
    // case-sensitive Windows directories can have two genuinely distinct names.
    try {
      return realpathSync.native(candidate) === realpathSync.native(root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      throw error;
    }
  });
}

export function assertProjectLocalDirectories(projectRoot: string) {
  const {dataRoot, controlRoot, inputRoot} = projectLocalLayout(projectRoot);
  check(process.platform !== 'win32' || /^[A-Za-z]:\\/.test(projectRoot), 'PROJECT_LOCAL_WINDOWS_NAMESPACE_UNSUPPORTED');
  for (const path of [projectRoot, dataRoot, controlRoot, inputRoot]) {
    const before = lstatSync(path, {bigint: true});
    check(before.isDirectory() && before.ino > 0n, 'PROJECT_LOCAL_DIRECTORY_REQUIRED');
    const physical = realpathSync.native(path);
    check(relative(path, physical) === '', 'PROJECT_LOCAL_PATH_ALIAS_UNSUPPORTED');
    // The project spelling can vary on ordinary Windows volumes. The three
    // reserved directory entries themselves must have the literal names.
    check(path === projectRoot || basename(path) === basename(physical), 'PROJECT_LOCAL_DIRECTORY_NAME_MISMATCH');
    const after = lstatSync(physical, {bigint: true});
    check(after.isDirectory() && before.dev === after.dev && before.ino === after.ino, 'PROJECT_LOCAL_DIRECTORY_IDENTITY_UNPROVEN');
  }
}
