import type { ValidationResult } from "../project-model/validate.ts";
import { isDeepStrictEqual } from "node:util";
import { formatSchemaErrors } from "../project-model/schema-registry.ts";
import { createPlanningSchemaRegistry, type DeliverySchemaName, type PlanningSchemaName } from "./legacy-schema-registry.ts";
import type {
  ArchitectureProposal, CheckpointPolicy, CheckpointResult, ClosureManifest, DeliveryOutcome,
  DeliveryProfileDecision, DeliveryReport, EvidenceSnapshot, FailureFingerprint, PlanBundle, PlanDag,
  ReadinessResult, RetryBudget, WriteLease,
} from "./legacy-types.ts";
import type { ProjectModelBundleV02 } from "../project-model/types.ts";
import {
  checkpointPolicyInvariantErrors, checkpointResultInvariantErrors, closureManifestInvariantErrors,
  evidenceSnapshotInvariantErrors, failureFingerprintInvariantErrors, retryBudgetInvariantErrors,
  writeLeaseInvariantErrors,
} from "./legacy-governance-contracts.ts";

type PlanningValueByName = {
  architectureProposal: ArchitectureProposal;
  planDag: PlanDag;
  planBundle: PlanBundle;
  readinessResult: ReadinessResult;
};

type DeliveryValueByName = {
  deliveryProfileDecision: DeliveryProfileDecision;
  deliveryOutcome: DeliveryOutcome;
  deliveryReport: DeliveryReport;
  checkpointPolicy: CheckpointPolicy;
  checkpointResult: CheckpointResult;
  evidenceSnapshot: EvidenceSnapshot;
  closureManifest: ClosureManifest;
  writeLease: WriteLease;
  failureFingerprint: FailureFingerprint;
  retryBudget: RetryBudget;
};

const registry = createPlanningSchemaRegistry();

const profileRank: Record<DeliveryProfileDecision["requested_profile"], number> = {
  prototype: 0,
  quick_verified: 1,
  full_governance: 2,
};

function profileDecisionInvariantErrors(decision: DeliveryProfileDecision, path = "profile_decision"): string[] {
  return profileRank[decision.effective_profile] < profileRank[decision.requested_profile]
    ? [`${path}.effective_profile: cannot be lower assurance than ${path}.requested_profile.`]
    : [];
}

function deliveryReportInvariantErrors(report: DeliveryReport, path = "delivery_report"): string[] {
  const errors = profileDecisionInvariantErrors(report.profile_decision, `${path}.profile_decision`);
  if (report.delivery_outcome.profile_decision_id !== report.profile_decision.profile_decision_id) {
    errors.push(`${path}.delivery_outcome.profile_decision_id: must identify ${path}.profile_decision.`);
  }
  return errors;
}

/**
 * Cross-artifact rules that standard JSON Schema cannot express without
 * implementation-specific dynamic-data extensions. Callers run this only
 * after strict structural schema validation has succeeded.
 */
export function projectModelBundleDeliveryInvariantErrors(bundle: ProjectModelBundleV02): string[] {
  const errors = profileDecisionInvariantErrors(bundle.delivery_profile_decision, "delivery_profile_decision");
  const outcome = bundle.delivery_outcome;
  const report = bundle.delivery_report;
  const state = bundle.project_state;

  if (state.project_id !== bundle.requirement_registry.project_id) {
    errors.push("project_state.project_id: must match requirement_registry.project_id.");
  }
  const artifactRefs = [state.delivery_profile_decision_ref, state.delivery_outcome_ref, state.delivery_report_ref].filter((value): value is string => typeof value === "string");
  if (new Set(artifactRefs).size !== artifactRefs.length) {
    errors.push("project_state delivery artifact refs: profile decision, outcome and report must use distinct references.");
  }

  if (outcome) {
    if (outcome.profile_decision_id !== bundle.delivery_profile_decision.profile_decision_id) {
      errors.push("delivery_outcome.profile_decision_id: must identify delivery_profile_decision.");
    }
    if (!bundle.tasks.some((task) => task.task_id === outcome.task_id)) {
      errors.push("delivery_outcome.task_id: must identify a task in the project-model bundle.");
    }
    if (!state.delivery_outcome_ref) {
      errors.push("project_state.delivery_outcome_ref: is required when delivery_outcome is present.");
    }

    const subjectTask = bundle.tasks.find((task) => task.task_id === outcome.task_id);
    const subjectMilestones = bundle.milestones.filter((milestone) => milestone.task_ids.includes(outcome.task_id));
    const subjectRequirements = bundle.requirement_registry.requirements.filter((requirement) => requirement.task_ids.includes(outcome.task_id));
    if (outcome.status === "PROTOTYPE_UNVERIFIED") {
      if (bundle.delivery_profile_decision.effective_profile !== "prototype") errors.push("delivery_outcome.status: PROTOTYPE_UNVERIFIED requires the prototype effective profile.");
      if (subjectTask?.state !== "PROTOTYPE_READY") errors.push("delivery_outcome.task_id: prototype subject task must be PROTOTYPE_READY.");
      if (subjectMilestones.length === 0 || subjectMilestones.some((milestone) => milestone.status !== "PROTOTYPE_READY")) errors.push("milestones: every milestone containing the prototype subject task must be PROTOTYPE_READY.");
      if (subjectRequirements.length === 0 || subjectRequirements.some((requirement) => requirement.delivery_status !== "prototype_unverified" || requirement.status === "delivered")) errors.push("requirements: prototype subject requirements must remain prototype_unverified and not delivered.");
      if (state.project_state !== "PROTOTYPE_DELIVERED") errors.push("project_state.project_state: prototype outcome requires PROTOTYPE_DELIVERED.");
    }
    if (outcome.status === "VERIFIED") {
      if (bundle.delivery_profile_decision.effective_profile === "prototype") errors.push("delivery_outcome.status: prototype can never be VERIFIED.");
      if (subjectTask?.state !== "TASK_VERIFIED") errors.push("delivery_outcome.task_id: verified subject task must be TASK_VERIFIED.");
      if (subjectMilestones.length === 0 || subjectMilestones.some((milestone) => milestone.status !== "VERIFIED")) errors.push("milestones: every milestone containing the verified subject task must be VERIFIED.");
      if (subjectRequirements.length === 0 || subjectRequirements.some((requirement) => requirement.delivery_status !== "verified" || requirement.status !== "delivered")) errors.push("requirements: verified subject requirements must be delivered and verified.");
      if (state.project_state !== "DELIVERED") errors.push("project_state.project_state: verified outcome requires DELIVERED.");
    }
    if (outcome.status === "BLOCKED" && state.project_state !== "BLOCKED") errors.push("project_state.project_state: BLOCKED outcome requires BLOCKED project state.");
    if (outcome.status === "REWORK" && (state.project_state === "DELIVERED" || state.project_state === "PROTOTYPE_DELIVERED")) errors.push("project_state.project_state: REWORK outcome cannot use a delivered state.");
  } else if (state.delivery_outcome_ref) {
    errors.push("project_state.delivery_outcome_ref: cannot reference an absent delivery_outcome.");
  }

  if (report) {
    errors.push(...deliveryReportInvariantErrors(report));
    if (!outcome) {
      errors.push("delivery_report: requires the bundle delivery_outcome artifact.");
    } else if (!isDeepStrictEqual(report.delivery_outcome, outcome)) {
      errors.push("delivery_report.delivery_outcome: must exactly match the bundle delivery_outcome artifact.");
    }
    if (!isDeepStrictEqual(report.profile_decision, bundle.delivery_profile_decision)) {
      errors.push("delivery_report.profile_decision: must exactly match the bundle delivery_profile_decision artifact.");
    }
    if (report.project_id !== state.project_id || report.project_id !== bundle.requirement_registry.project_id) {
      errors.push("delivery_report.project_id: must match project_state and requirement_registry.");
    }
    if (!state.delivery_report_ref) {
      errors.push("project_state.delivery_report_ref: is required when delivery_report is present.");
    }
  } else if (state.delivery_report_ref) {
    errors.push("project_state.delivery_report_ref: cannot reference an absent delivery_report.");
  }

  return errors;
}

export function validatePlanningArtifact<TName extends PlanningSchemaName>(schemaName: TName, value: unknown): ValidationResult<PlanningValueByName[TName]> {
  const validator = registry.planning[schemaName];
  if (validator(value)) return { valid: true, value: value as PlanningValueByName[TName], errors: [] };
  return { valid: false, errors: formatSchemaErrors(validator.errors) };
}

export function validateDeliveryArtifact<TName extends DeliverySchemaName>(schemaName: TName, value: unknown): ValidationResult<DeliveryValueByName[TName]> {
  const validator = registry.delivery[schemaName];
  if (!validator(value)) return { valid: false, errors: formatSchemaErrors(validator.errors) };

  const semanticErrors = schemaName === "deliveryProfileDecision"
    ? profileDecisionInvariantErrors(value as DeliveryProfileDecision, "delivery_profile_decision")
    : schemaName === "deliveryReport" ? deliveryReportInvariantErrors(value as DeliveryReport)
      : schemaName === "checkpointPolicy" ? checkpointPolicyInvariantErrors(value as CheckpointPolicy)
        : schemaName === "checkpointResult" ? checkpointResultInvariantErrors(value as CheckpointResult)
          : schemaName === "evidenceSnapshot" ? evidenceSnapshotInvariantErrors(value as EvidenceSnapshot)
            : schemaName === "closureManifest" ? closureManifestInvariantErrors(value as ClosureManifest)
              : schemaName === "writeLease" ? writeLeaseInvariantErrors(value as WriteLease)
                : schemaName === "failureFingerprint" ? failureFingerprintInvariantErrors(value as FailureFingerprint)
                  : schemaName === "retryBudget" ? retryBudgetInvariantErrors(value as RetryBudget)
                    : [];
  if (semanticErrors.length > 0) return { valid: false, errors: semanticErrors };

  return { valid: true, value: value as DeliveryValueByName[TName], errors: [] };
}
