import { isAbsolute, win32 } from "node:path";
import { validatePlanBundle } from "./legacy-plan-validation.ts";
import {
  evaluateImplementationReadiness,
  type ReadinessInput,
} from "./legacy-readiness.ts";
import type { PlanValidationResult, ReadinessResult, StableValidationIssue } from "./legacy-types.ts";

type UnknownRecord = Record<string, unknown>;

const readinessRequirementKinds = new Set([
  "dependency",
  "interface",
  "tool",
  "permission",
  "owner_gate",
  "capability",
  "evidence",
]);

const deliveryRiskCategories = new Set([
  "payment",
  "authentication",
  "privacy",
  "security",
  "data_migration",
  "destructive_operation",
  "formal_release",
  "equivalent_high_risk",
  "other",
]);

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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isReadinessInput(value: unknown): value is ReadinessInput {
  if (!isRecord(value) || value.schema_version !== "0.1" || !isRecord(value.profile_policy)) return false;
  const policy = value.profile_policy;
  if (
    policy.schema_version !== "0.1"
    || typeof policy.profile_decision_id !== "string"
    || !["prototype", "quick_verified", "full_governance"].includes(String(policy.requested_profile))
    || typeof policy.owner_selected !== "boolean"
    || !["prototype_candidate", "formal_delivery"].includes(String(policy.purpose))
    || !["simple", "complex"].includes(String(policy.complexity))
    || !["single_module", "multi_module", "cross_domain"].includes(String(policy.change_scope))
    || !["stable", "changed", "unstable"].includes(String(policy.interface_stability))
    || typeof policy.created_at !== "string"
    || !Array.isArray(policy.risk_factors)
    || !policy.risk_factors.every((risk) => isRecord(risk)
      && typeof risk.category === "string"
      && deliveryRiskCategories.has(risk.category)
      && typeof risk.rationale === "string")
  ) return false;

  if (
    !Array.isArray(value.tasks)
    || !value.tasks.every((task) => isRecord(task)
      && typeof task.task_id === "string"
      && isStringArray(task.test_methods)
      && isStringArray(task.evidence_methods)
      && Array.isArray(task.record_expectations)
      && task.record_expectations.every((expectation) => isRecord(expectation)
        && typeof expectation.kind === "string"
        && readinessRequirementKinds.has(expectation.kind)
        && typeof expectation.ref === "string"
        && isStringArray(expectation.expected_statuses)
        && isStringArray(expectation.expected_sources)
        && isOptionalString(expectation.expected_task_id)
        && isOptionalString(expectation.subject_ref)
        && isOptionalString(expectation.capability)
        && (expectation.maximum_age_ms === undefined
          || (Number.isSafeInteger(expectation.maximum_age_ms) && Number(expectation.maximum_age_ms) > 0))))
    || !Array.isArray(value.capability_records)
    || !value.capability_records.every(isRecord)
    || !Array.isArray(value.evidence_records)
    || !value.evidence_records.every(isRecord)
    || typeof value.checked_at !== "string"
    || !Number.isSafeInteger(value.maximum_record_age_ms)
  ) return false;

  return "plan" in value;
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
  const plan = isRecord(value) ? value.plan : undefined;
  const planValidation = validatePlanBundle(plan);
  const readiness = isReadinessInput(value)
    ? evaluateImplementationReadiness(value).result
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
