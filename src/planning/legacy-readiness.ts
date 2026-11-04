import type { CapabilitySnapshot } from "../runtime/capability-probe.ts";
import { validateEvidenceRecord, type EvidenceRecord } from "../runtime/evidence-schema.ts";
import { validatePlanBundle } from "./legacy-plan-validation.ts";
import { evaluateDeliveryProfilePolicy, type ProfilePolicyInput, type ProfilePolicyResult } from "./profile-policy.ts";
import type { ReadinessResult } from "./legacy-types.ts";

export type ReadinessDisposition = "PASS" | "NOT_READY" | "BLOCKED" | "UNKNOWN";
export type ReadinessRequirementKind = "dependency" | "interface" | "tool" | "permission" | "owner_gate" | "capability" | "evidence";

export type ReadinessRecordExpectation = {
  kind: ReadinessRequirementKind;
  ref: string;
  expected_statuses: string[];
  expected_sources: string[];
  expected_task_id?: string;
  subject_ref?: string;
  capability?: keyof CapabilitySnapshot["facts"];
  maximum_age_ms?: number;
};

export type TaskReadinessInput = {
  task_id: string;
  record_expectations: ReadinessRecordExpectation[];
  test_methods: string[];
  evidence_methods: string[];
};

export type ReadinessCapabilityRecord = CapabilitySnapshot & {
  capability_snapshot_id: string;
  status: string;
  source: string;
  freshness: "current" | "stale" | "superseded";
};

export type ReadinessEvidenceRecord = Omit<EvidenceRecord, "type"> & {
  type: string;
  status: string;
};

export type ReadinessInput = {
  schema_version: "0.1";
  plan: unknown;
  profile_policy: ProfilePolicyInput;
  tasks: TaskReadinessInput[];
  capability_records: ReadinessCapabilityRecord[];
  evidence_records: ReadinessEvidenceRecord[];
  checked_at: string;
  maximum_record_age_ms: number;
};

export type ImplementationReadinessIssue = {
  code: string;
  disposition: Exclude<ReadinessDisposition, "PASS">;
  artifact_ref: string;
  message: string;
  related_refs: string[];
};

export type TaskReadinessDisposition = {
  task_id: string;
  status: ReadinessDisposition;
  issues: ImplementationReadinessIssue[];
};

export type ImplementationReadinessEvaluation = {
  schema_version: "0.1";
  result: ReadinessResult;
  task_dispositions: TaskReadinessDisposition[];
  profile_policy: ProfilePolicyResult;
};

type UnknownRecord = Record<string, unknown>;

const dispositionRank: Record<ReadinessDisposition, number> = {
  PASS: 0,
  NOT_READY: 1,
  UNKNOWN: 2,
  BLOCKED: 3,
};

const blockingKinds = new Set<ReadinessRequirementKind>(["dependency", "interface", "tool", "permission", "owner_gate"]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function canonicalIssues(issues: ImplementationReadinessIssue[]): ImplementationReadinessIssue[] {
  const sorted = [...issues].sort((left, right) => (
    compareText(left.code, right.code)
    || compareText(left.artifact_ref, right.artifact_ref)
    || compareText(left.related_refs.join("\u0000"), right.related_refs.join("\u0000"))
    || compareText(left.message, right.message)
  ));
  return sorted.filter((item, index) => index === 0 || JSON.stringify(item) !== JSON.stringify(sorted[index - 1]));
}

function issue(
  issues: ImplementationReadinessIssue[],
  code: string,
  disposition: Exclude<ReadinessDisposition, "PASS">,
  artifactRef: string,
  message: string,
  relatedRefs: string[] = [],
): void {
  issues.push({ code, disposition, artifact_ref: artifactRef, message, related_refs: sortedUnique(relatedRefs) });
}

function disposition(issues: ImplementationReadinessIssue[]): ReadinessDisposition {
  return issues.reduce<ReadinessDisposition>((current, item) => (
    dispositionRank[item.disposition] > dispositionRank[current] ? item.disposition : current
  ), "PASS");
}

function exactArray(left: string[], right: string[]): boolean {
  const canonicalLeft = sortedUnique(left);
  const canonicalRight = sortedUnique(right);
  return canonicalLeft.length === canonicalRight.length
    && canonicalLeft.every((value, index) => value === canonicalRight[index]);
}

function exactOrderedStringArray(value: unknown, expected: string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => typeof item === "string" && item === expected[index]);
}

function exactProfileDecision(value: UnknownRecord, expected: ProfilePolicyResult["decision"]): boolean {
  const expectedKeys = [
    "created_at",
    "effective_profile",
    "escalation_reasons",
    "owner_selected",
    "profile_decision_id",
    "recommendation_reason",
    "requested_profile",
    "risk_factors",
    "schema_version",
  ];
  const actualKeys = Object.keys(value).sort(compareText);
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
    && value.schema_version === expected.schema_version
    && value.profile_decision_id === expected.profile_decision_id
    && value.requested_profile === expected.requested_profile
    && value.effective_profile === expected.effective_profile
    && value.recommendation_reason === expected.recommendation_reason
    && exactOrderedStringArray(value.risk_factors, expected.risk_factors)
    && exactOrderedStringArray(value.escalation_reasons, expected.escalation_reasons)
    && value.owner_selected === expected.owner_selected
    && value.created_at === expected.created_at;
}

function forbiddenLifecycleClaims(value: unknown, artifactRef = "plan"): Array<{ artifactRef: string; value: string }> {
  const claims: Array<{ artifactRef: string; value: string }> = [];
  const terminalValues = new Set(["TASK_VERIFIED", "VERIFIED", "DELIVERED", "PROTOTYPE_READY", "PROTOTYPE_DELIVERED", "prototype_unverified"]);
  const visit = (current: unknown, path: string): void => {
    if (typeof current === "string" && terminalValues.has(current)) claims.push({ artifactRef: path, value: current });
    else if (Array.isArray(current)) current.forEach((item, index) => visit(item, `${path}/${index}`));
    else if (isRecord(current)) {
      for (const key of Object.keys(current).sort(compareText)) {
        if (/^(?:delivery_?outcome|delivery_?report)$/i.test(key)) claims.push({ artifactRef: `${path}/${key}`, value: key });
        visit(current[key], `${path}/${key}`);
      }
    }
  };
  visit(value, artifactRef);
  return claims;
}

function duplicateIds(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort(compareText);
}

function validateTimestamp(
  capturedAt: string,
  checkedAtMs: number,
  maximumAgeMs: number,
): "valid" | "invalid" | "future" | "stale" {
  const capturedAtMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedAtMs)) return "invalid";
  if (capturedAtMs > checkedAtMs) return "future";
  return checkedAtMs - capturedAtMs > maximumAgeMs ? "stale" : "valid";
}

function evaluateExpectation(
  expectation: ReadinessRecordExpectation,
  capabilities: ReadonlyMap<string, ReadinessCapabilityRecord>,
  evidence: ReadonlyMap<string, ReadinessEvidenceRecord>,
  duplicateCapabilityIds: ReadonlySet<string>,
  duplicateEvidenceIds: ReadonlySet<string>,
  checkedAtMs: number,
  defaultMaximumAgeMs: number,
  artifactRef: string,
  currentTaskId: string,
  dependencyIds: ReadonlySet<string>,
  ownerGateIds: ReadonlySet<string>,
): ImplementationReadinessIssue[] {
  const issues: ImplementationReadinessIssue[] = [];
  const missingDisposition = blockingKinds.has(expectation.kind) ? "BLOCKED" : "UNKNOWN";
  const useCapability = expectation.kind === "capability" || (expectation.kind === "tool" && expectation.capability !== undefined);
  const records = useCapability ? capabilities : evidence;
  const duplicateIdsForKind = useCapability ? duplicateCapabilityIds : duplicateEvidenceIds;
  const record = records.get(expectation.ref);

  const subjectRef = expectation.subject_ref?.trim();
  if (expectation.kind === "dependency" && (!subjectRef || !dependencyIds.has(subjectRef))) {
    issue(issues, "DEPENDENCY_EVIDENCE_SUBJECT_MISMATCH", "BLOCKED", artifactRef, "Dependency evidence must name a dependency of the current task as subject_ref.", [expectation.ref, ...(subjectRef ? [subjectRef] : [])]);
  }
  if (expectation.kind === "owner_gate" && (!subjectRef || !ownerGateIds.has(subjectRef))) {
    issue(issues, "OWNER_GATE_EVIDENCE_SUBJECT_MISMATCH", "BLOCKED", artifactRef, "Owner Gate evidence must name an Owner Gate condition of the current task as subject_ref.", [expectation.ref, ...(subjectRef ? [subjectRef] : [])]);
  }

  if (duplicateIdsForKind.has(expectation.ref)) {
    issue(issues, "READINESS_RECORD_DUPLICATE", "UNKNOWN", artifactRef, "The referenced record identifier is ambiguous.", [expectation.ref]);
    return issues;
  }
  if (!record) {
    issue(issues, "READINESS_RECORD_UNRESOLVED", missingDisposition, artifactRef, "The referenced readiness record does not resolve.", [expectation.ref]);
    return issues;
  }
  if (expectation.expected_sources.length === 0 || !expectation.expected_sources.includes(record.source)) {
    issue(issues, "READINESS_RECORD_SOURCE_MISMATCH", "UNKNOWN", artifactRef, "The record source does not match an explicitly allowed source.", [expectation.ref]);
  }
  if (expectation.expected_statuses.length === 0 || !expectation.expected_statuses.includes(record.status)) {
    issue(issues, "READINESS_RECORD_STATUS_MISMATCH", missingDisposition, artifactRef, "The record status does not satisfy the readiness expectation.", [expectation.ref]);
  }
  if (record.freshness !== "current") {
    issue(issues, "READINESS_RECORD_NOT_CURRENT", "NOT_READY", artifactRef, "The record is stale or superseded.", [expectation.ref]);
  }

  const capturedAt = "capturedAt" in record ? record.capturedAt : record.captured_at;
  const age = validateTimestamp(capturedAt, checkedAtMs, expectation.maximum_age_ms ?? defaultMaximumAgeMs);
  if (age === "invalid") issue(issues, "READINESS_RECORD_TIMESTAMP_INVALID", "UNKNOWN", artifactRef, "The record timestamp is invalid.", [expectation.ref]);
  else if (age === "future") issue(issues, "READINESS_RECORD_TIMESTAMP_FUTURE", "UNKNOWN", artifactRef, "The record timestamp is later than checked_at.", [expectation.ref]);
  else if (age === "stale") issue(issues, "READINESS_RECORD_TOO_OLD", "NOT_READY", artifactRef, "The record exceeds the allowed freshness window.", [expectation.ref]);

  if (useCapability) {
    const capabilityRecord = record as ReadinessCapabilityRecord;
    if (!expectation.capability) {
      issue(issues, "CAPABILITY_NAME_MISSING", "UNKNOWN", artifactRef, "A capability expectation must name the observed capability.", [expectation.ref]);
    } else {
      const fact = isRecord(capabilityRecord.facts) ? capabilityRecord.facts[expectation.capability] : undefined;
      if (!isRecord(fact) || fact.available !== true || fact.exitCode !== 0) {
        issue(issues, "CAPABILITY_OBSERVATION_MISSING", missingDisposition, artifactRef, "A boolean, prose assertion, or failed command is not capability evidence.", [expectation.ref]);
      }
    }
  } else {
    const evidenceRecord = record as ReadinessEvidenceRecord;
    const hasPortableShape = [
      evidenceRecord.evidence_id,
      evidenceRecord.task_id,
      evidenceRecord.run_id,
      evidenceRecord.command,
      evidenceRecord.cwd,
      evidenceRecord.output_summary,
      evidenceRecord.captured_at,
      evidenceRecord.source,
    ].every((value) => typeof value === "string")
      && Array.isArray(evidenceRecord.related_files)
      && (evidenceRecord.exit_code === null || Number.isInteger(evidenceRecord.exit_code));
    const structuralErrors = hasPortableShape
      ? validateEvidenceRecord(evidenceRecord as EvidenceRecord)
      : ["Evidence record does not have the portable EvidenceRecord shape."];
    if (structuralErrors.length > 0 || evidenceRecord.exit_code === null) {
      issue(issues, "EVIDENCE_ASSERTION_ONLY", "NOT_READY", artifactRef, "Evidence must contain a portable observed command and exit status, not only an assertion.", [expectation.ref]);
    }
    if (evidenceRecord.exit_code !== 0) {
      issue(issues, "EVIDENCE_COMMAND_FAILED", missingDisposition, artifactRef, "The referenced evidence command did not exit successfully.", [expectation.ref]);
    }
    const requiredTaskId = expectation.kind === "dependency" && subjectRef ? subjectRef : currentTaskId;
    if (evidenceRecord.task_id !== requiredTaskId) {
      issue(issues, "EVIDENCE_TASK_MISMATCH", "UNKNOWN", artifactRef, "The evidence task_id does not match the subject required by the current task context.", [expectation.ref, requiredTaskId]);
    }
    if (expectation.expected_task_id !== undefined && expectation.expected_task_id !== requiredTaskId) {
      issue(issues, "EVIDENCE_EXPECTED_TASK_MISMATCH", "UNKNOWN", artifactRef, "expected_task_id contradicts the subject required by the current task context.", [expectation.ref, expectation.expected_task_id, requiredTaskId]);
    }
  }
  return canonicalIssues(issues);
}

/**
 * Evaluate caller-supplied plan and record facts without probing, executing,
 * scheduling, reading files, or persisting state.
 */
export function evaluateImplementationReadiness(input: ReadinessInput): ImplementationReadinessEvaluation {
  const globalIssues: ImplementationReadinessIssue[] = [];
  const plan = isRecord(input.plan) ? input.plan : {};
  const planId = typeof plan.plan_id === "string" ? plan.plan_id : "PLAN-UNKNOWN-01";
  const checkedAtMs = Date.parse(input.checked_at);
  const validClock = Number.isFinite(checkedAtMs);
  if (!validClock || !Number.isSafeInteger(input.maximum_record_age_ms) || input.maximum_record_age_ms <= 0) {
    issue(globalIssues, "READINESS_POLICY_INVALID", "UNKNOWN", "readiness", "checked_at and maximum_record_age_ms must define a valid deterministic freshness policy.");
  }

  const planValidation = validatePlanBundle(input.plan);
  for (const planIssue of planValidation.issues) {
    const planDisposition = /(?:DEPENDENCY_NOT_FOUND|INTERFACE_(?:NOT_FROZEN|BACKLINK_NOT_FOUND|VERSION_MISMATCH|DEPENDENCY_ORDER_INVALID|PRODUCER_MISSING|CONSUMER_MISSING))/.test(planIssue.code)
      ? "BLOCKED"
      : "NOT_READY";
    issue(globalIssues, `PLAN_${planIssue.code}`, planDisposition, planIssue.artifact_ref, planIssue.message, planIssue.related_refs);
  }
  for (const claim of forbiddenLifecycleClaims(input.plan)) {
    issue(globalIssues, "PLAN_TERMINAL_OUTCOME_FORBIDDEN", "NOT_READY", claim.artifactRef, "A plan cannot contain delivery outcomes or terminal delivery/verified states.", [claim.value]);
  }

  const profilePolicy = evaluateDeliveryProfilePolicy(input.profile_policy);
  if (!profilePolicy.accepted) {
    issue(globalIssues, "PROFILE_POLICY_REJECTED", "BLOCKED", "plan/delivery_profile_decision", "The requested profile violates the deterministic assurance floor.");
  }
  const planDecision = isRecord(plan.delivery_profile_decision) ? plan.delivery_profile_decision : {};
  const expectedDecision = profilePolicy.decision;
  const decisionMatches = exactProfileDecision(planDecision, expectedDecision);
  if (!decisionMatches) {
    issue(globalIssues, "PLAN_PROFILE_POLICY_MISMATCH", "BLOCKED", "plan/delivery_profile_decision", "The plan profile decision does not match the independently evaluated risk floor.");
  }

  const capabilityDuplicates = new Set(duplicateIds(input.capability_records.map((record) => record.capability_snapshot_id)));
  const evidenceDuplicates = new Set(duplicateIds(input.evidence_records.map((record) => record.evidence_id)));
  const capabilityIndex = new Map(input.capability_records.map((record) => [record.capability_snapshot_id, record]));
  const evidenceIndex = new Map(input.evidence_records.map((record) => [record.evidence_id, record]));
  const taskInputs = new Map<string, TaskReadinessInput>();
  const duplicateTaskInputs = new Set(duplicateIds(input.tasks.map((task) => task.task_id)));
  for (const task of input.tasks) if (!taskInputs.has(task.task_id)) taskInputs.set(task.task_id, task);
  const planTasks = Array.isArray(plan.tasks) ? plan.tasks.filter(isRecord) : [];
  const planTaskIds = sortedUnique(planTasks.map((task) => task.task_id).filter((value): value is string => typeof value === "string"));

  const taskDispositions: TaskReadinessDisposition[] = planTaskIds.map((taskId) => {
    const issues: ImplementationReadinessIssue[] = [];
    const artifactRef = `tasks/${taskId}`;
    const task = taskInputs.get(taskId);
    const planTask = planTasks.find((candidate) => candidate.task_id === taskId) ?? {};
    if (duplicateTaskInputs.has(taskId)) {
      issue(issues, "TASK_READINESS_INPUT_DUPLICATE", "UNKNOWN", artifactRef, "Task readiness input is ambiguous.", [taskId]);
    }
    if (!task) {
      issue(issues, "TASK_READINESS_INPUT_MISSING", "UNKNOWN", artifactRef, "The task has no readiness input.", [taskId]);
    } else {
      if (task.record_expectations.length === 0) {
        issue(issues, "READINESS_EXPECTATIONS_MISSING", "UNKNOWN", artifactRef, "Readiness requires resolvable capability and evidence expectations.", [taskId]);
      }
      if (!task.record_expectations.some((expectation) => expectation.kind === "capability" || (expectation.kind === "tool" && expectation.capability !== undefined))) {
        issue(issues, "CAPABILITY_EXPECTATION_MISSING", "UNKNOWN", artifactRef, "At least one observed capability or tool record is required.", [taskId]);
      }
      if (!task.record_expectations.some((expectation) => expectation.kind !== "capability" && !(expectation.kind === "tool" && expectation.capability !== undefined))) {
        issue(issues, "EVIDENCE_EXPECTATION_MISSING", "UNKNOWN", artifactRef, "At least one portable evidence record is required.", [taskId]);
      }
      if (task.test_methods.length === 0 || task.test_methods.some((method) => method.trim().length === 0)) {
        issue(issues, "TEST_METHOD_MISSING", "NOT_READY", artifactRef, "At least one concrete test method is required.", [taskId]);
      } else if (!exactArray(task.test_methods, Array.isArray(planTask.required_tests) ? planTask.required_tests.filter((value): value is string => typeof value === "string") : [])) {
        issue(issues, "TEST_METHOD_MISMATCH", "NOT_READY", artifactRef, "Readiness test methods must match the bounded Task Contract.", [taskId]);
      }
      if (task.evidence_methods.length === 0 || task.evidence_methods.some((method) => method.trim().length === 0)) {
        issue(issues, "EVIDENCE_METHOD_MISSING", "NOT_READY", artifactRef, "At least one concrete evidence method is required.", [taskId]);
      } else if (!exactArray(task.evidence_methods, Array.isArray(planTask.required_evidence) ? planTask.required_evidence.filter((value): value is string => typeof value === "string") : [])) {
        issue(issues, "EVIDENCE_METHOD_MISMATCH", "NOT_READY", artifactRef, "Readiness evidence methods must match the bounded Task Contract.", [taskId]);
      }
      const dependencyIds = new Set(Array.isArray(planTask.dependencies) ? planTask.dependencies.filter((value): value is string => typeof value === "string") : []);
      const ownerGateIds = new Set(Array.isArray(planTask.owner_gate_conditions) ? planTask.owner_gate_conditions.filter((value): value is string => typeof value === "string") : []);
      for (const dependencyId of dependencyIds) {
        if (!task.record_expectations.some((expectation) => expectation.kind === "dependency" && expectation.subject_ref === dependencyId)) {
          issue(issues, "DEPENDENCY_EVIDENCE_EXPECTATION_MISSING", "BLOCKED", artifactRef, "A task dependency lacks a matching evidence expectation.", [dependencyId]);
        }
      }
      for (const ownerGateId of ownerGateIds) {
        if (!task.record_expectations.some((expectation) => expectation.kind === "owner_gate" && expectation.subject_ref === ownerGateId)) {
          issue(issues, "OWNER_GATE_EVIDENCE_EXPECTATION_MISSING", "BLOCKED", artifactRef, "An Owner Gate condition lacks a matching resolved evidence expectation.", [ownerGateId]);
        }
      }
      for (const expectation of [...task.record_expectations].sort((left, right) => compareText(left.kind, right.kind) || compareText(left.ref, right.ref))) {
        issues.push(...evaluateExpectation(
          expectation,
          capabilityIndex,
          evidenceIndex,
          capabilityDuplicates,
          evidenceDuplicates,
          validClock ? checkedAtMs : Number.NaN,
          input.maximum_record_age_ms,
          artifactRef,
          taskId,
          dependencyIds,
          ownerGateIds,
        ));
      }
    }
    const canonical = canonicalIssues([...globalIssues, ...issues]);
    return { task_id: taskId, status: disposition(canonical), issues: canonical };
  });

  for (const taskId of sortedUnique(input.tasks.map((task) => task.task_id).filter((taskId) => !planTaskIds.includes(taskId)))) {
    issue(globalIssues, "TASK_READINESS_INPUT_EXTRA", "UNKNOWN", `tasks/${taskId}`, "Readiness input references a task absent from the plan.", [taskId]);
  }
  const canonicalGlobal = canonicalIssues(globalIssues);
  const overallStatus = disposition([
    ...canonicalGlobal,
    ...taskDispositions.flatMap((task) => task.issues),
  ]);
  const result: ReadinessResult = {
    schema_version: "0.1",
    plan_id: planId,
    status: overallStatus,
    issues: canonicalIssues([
      ...canonicalGlobal,
      ...taskDispositions.flatMap((task) => task.issues),
    ]).map(({ code, artifact_ref, message }) => ({ code, severity: "error", artifact_ref, message })),
    checked_at: validClock ? input.checked_at : "1970-01-01T00:00:00.000Z",
  };

  return {
    schema_version: "0.1",
    result,
    task_dispositions: taskDispositions,
    profile_policy: profilePolicy,
  };
}
