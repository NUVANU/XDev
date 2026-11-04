import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
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
