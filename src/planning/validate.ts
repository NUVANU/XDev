import type { ValidationResult } from "../project-model/validate.ts";
import { isDeepStrictEqual } from "node:util";
import { formatSchemaErrors } from "../project-model/schema-registry.ts";
import { createPlanningSchemaRegistry, type DeliverySchemaName, type PlanningSchemaName } from "./schema-registry.ts";
import type { ArchitectureProposal, CheckpointPolicy, CheckpointResult, ClosureManifest, DeliveryOutcome, DeliveryProfileDecision, DeliveryReport, EvidenceSnapshot, FailureFingerprint, PlanBundle, PlanDag, ReadinessResult, RetryBudget, WriteLease } from "./types.ts";
import type { ProjectModelBundleV02 } from "../project-model/types.ts";
import type { RetryHistoryAuthority } from "./types.ts";

type PlanningValueByName = {
  architectureProposal: ArchitectureProposal;
  planDag: PlanDag;
  planBundle: PlanBundle;
  readinessResult: ReadinessResult;
  checkpointPolicy: CheckpointPolicy;
  writeLease: WriteLease;
  failureFingerprint: FailureFingerprint;
  retryBudget: RetryBudget;
  retryHistoryAuthority: RetryHistoryAuthority;
};

type DeliveryValueByName = {
  deliveryProfileDecision: DeliveryProfileDecision;
  deliveryOutcome: DeliveryOutcome;
  deliveryReport: DeliveryReport;
  evidenceSnapshot: EvidenceSnapshot;
  checkpointResult: CheckpointResult;
  closureManifest: ClosureManifest;
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
export { projectModelBundleDeliveryInvariantErrors, validateDeliveryArtifact } from "./legacy-validate.ts";

export function validatePlanningArtifact<TName extends PlanningSchemaName>(schemaName: TName, value: unknown): ValidationResult<PlanningValueByName[TName]> {
  const validator = registry.planning[schemaName];
  if (validator(value)) return { valid: true, value: value as PlanningValueByName[TName], errors: [] };
  return { valid: false, errors: formatSchemaErrors(validator.errors) };
}

export function validateExecutionDeliveryArtifact<TName extends DeliverySchemaName>(schemaName: TName, value: unknown): ValidationResult<DeliveryValueByName[TName]> {
  const validator = registry.delivery[schemaName];
  if (!validator(value)) return { valid: false, errors: formatSchemaErrors(validator.errors) };

  const semanticErrors = schemaName === "deliveryProfileDecision"
    ? profileDecisionInvariantErrors(value as DeliveryProfileDecision, "delivery_profile_decision")
    : schemaName === "deliveryReport"
      ? deliveryReportInvariantErrors(value as DeliveryReport)
      : [];
  if (semanticErrors.length > 0) return { valid: false, errors: semanticErrors };

  return { valid: true, value: value as DeliveryValueByName[TName], errors: [] };
}
