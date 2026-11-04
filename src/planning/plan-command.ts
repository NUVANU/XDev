import { isAbsolute, win32 } from "node:path";
import { validatePlanBundle } from "./plan-validation.ts";
import {
  evaluateReadinessWithObservation,
  isReadinessInput,
} from "./readiness.ts";
import type { PlanValidationResult, ReadinessResult, StableValidationIssue } from "./types.ts";
import { captureHostObservation, type HostClockDependencies, type HostClockResult } from "./retry-history.ts";
import type { TrustedProjectContext } from "./types.ts";

type UnknownRecord = Record<string, unknown>;

export type PlanValidationCommandResult = {
  schema_version: "0.1";
  command: "xdev plan validate";
  valid: boolean;
  ready_for_implementation: boolean;
  plan_validation: PlanValidationResult;
  readiness: ReadinessResult;
  owner_summary: string;
  delivery_claim: "NONE";
  prototype_warning: string;
};

export type PlanValidationCommandExecution = {
  exitCode: 0 | 1;
  result: PlanValidationCommandResult;
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function planId(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.plan) || typeof value.plan.plan_id !== "string") return "PLAN-UNKNOWN-01";
  return value.plan.plan_id;
}

function pathLikePrivate(value: string): boolean {
  return win32.isAbsolute(value) || isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function redactText(value: string, privateRoots: string[]): string {
  let redacted = value;
  for (const root of privateRoots.filter(Boolean).sort((left, right) => right.length - left.length)) {
    redacted = redacted.replaceAll(root, "[redacted-path]");
    redacted = redacted.replaceAll(root.replaceAll("\\", "/"), "[redacted-path]");
  }
  redacted = redacted.replace(/[A-Za-z]:[\\/][^\n\r;,)]*/g, "[redacted-path]");
  redacted = redacted.replace(/(?:\/Users\/|\/home\/)[^\s,;)]*/g, "[redacted-path]");
  return redacted;
}

function redactRef(value: string, privateRoots: string[]): string {
  return pathLikePrivate(value) ? "[redacted-path]" : redactText(value, privateRoots);
}

function redactPlanIssue(issue: StableValidationIssue, privateRoots: string[]): StableValidationIssue {
  return {
    ...issue,
    artifact_ref: redactRef(issue.artifact_ref, privateRoots),
    message: redactText(issue.message, privateRoots),
    related_refs: issue.related_refs.map((ref) => redactRef(ref, privateRoots)),
  };
}

function redactReadinessIssue(
  issue: ReadinessResult["issues"][number],
  privateRoots: string[],
): ReadinessResult["issues"][number] {
  return {
    ...issue,
    ...(issue.artifact_ref === undefined ? {} : { artifact_ref: redactRef(issue.artifact_ref, privateRoots) }),
    message: redactText(issue.message, privateRoots),
  };
}

function invalidInputResult(value: unknown): ReadinessResult {
  return {
    schema_version: "0.1",
    plan_id: planId(value),
    status: "UNKNOWN",
    issues: [{
      code: "VALIDATION_INPUT_INVALID",
      severity: "error",
      artifact_ref: "readiness",
      message: "The validation file must contain a plan and complete caller-supplied readiness facts.",
    }],
    checked_at: "1970-01-01T00:00:00.000Z",
  };
}

function ownerSummary(planValid: boolean, readiness: ReadinessResult): string {
  if (!planValid) return "The plan has structural problems. Implementation must not start.";
  if (readiness.status === "PASS") return "The plan and its current readiness evidence pass. Implementation may be considered by the Project Director.";
  if (readiness.status === "BLOCKED") return "The plan is blocked by an unresolved dependency, interface, permission, tool, risk, or Owner decision.";
  if (readiness.status === "NOT_READY") return "The plan is understandable, but required implementation details or evidence are incomplete.";
  return "Readiness cannot be established from the supplied records. Implementation must not start.";
}

/** Validate one caller-supplied file in memory. This function never reads, writes, executes, probes, or schedules. */
export function validatePlanCommandInput(value: unknown, privateRoots: string[] = []): PlanValidationCommandExecution {
  return validateCommand(value,undefined,privateRoots);
}

export function validatePlanCommandFromProject(value: unknown, context: TrustedProjectContext, privateRoots: string[] = [], deps?: HostClockDependencies): PlanValidationCommandExecution {
  const captured = captureHostObservation(deps);
  return validateCommand(value,context,privateRoots,captured);
}

function validateCommand(value: unknown, context: TrustedProjectContext | undefined, privateRoots: string[], captured?: HostClockResult): PlanValidationCommandExecution {
  const plan = isRecord(value) ? value.plan : undefined;
  const planValidation = validatePlanBundle(plan, isReadinessInput(value)?value.checkpoint_inputs:undefined);
  const readiness = context
    ? evaluateReadinessWithObservation(value,context,captured?.ok ? captured.time : captured).result
    : invalidInputResult(value);
  const ready = planValidation.valid && readiness.status === "PASS";
  const redactedPlanValidation: PlanValidationResult = {
    ...planValidation,
    issues: planValidation.issues.map((issue) => redactPlanIssue(issue, privateRoots)),
  };
  const redactedReadiness: ReadinessResult = {
    ...readiness,
    plan_id: redactRef(readiness.plan_id, privateRoots),
    issues: readiness.issues.map((issue) => redactReadinessIssue(issue, privateRoots)),
  };

  return {
    exitCode: ready ? 0 : 1,
    result: {
      schema_version: "0.1",
      command: "xdev plan validate",
      valid: ready,
      ready_for_implementation: ready,
      plan_validation: redactedPlanValidation,
      readiness: redactedReadiness,
      owner_summary: ownerSummary(planValidation.valid, readiness),
      delivery_claim: "NONE",
      prototype_warning: "Prototype remains UNVERIFIED and cannot claim TASK_VERIFIED, VERIFIED, DELIVERED, or release PASS.",
    },
  };
}
