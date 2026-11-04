import { validateDeliveryArtifact } from "./validate.ts";
import type { DeliveryOutcome, DeliveryProfile, DeliveryProfileDecision } from "./types.ts";

export type DeliveryRiskCategory =
  | "payment"
  | "authentication"
  | "privacy"
  | "security"
  | "data_migration"
  | "destructive_operation"
  | "formal_release"
  | "equivalent_high_risk"
  | "other";

export type DeliveryRiskFactor = {
  category: DeliveryRiskCategory;
  rationale: string;
};

export type ProfilePolicyInput = {
  schema_version: "0.1";
  profile_decision_id: string;
  requested_profile: DeliveryProfile;
  owner_selected: boolean;
  purpose: "prototype_candidate" | "formal_delivery";
  complexity: "simple" | "complex";
  change_scope: "single_module" | "multi_module" | "cross_domain";
  interface_stability: "stable" | "changed" | "unstable";
  risk_factors: DeliveryRiskFactor[];
  created_at: string;
};

export type ProfilePolicyIssue = {
  code: "REQUESTED_PROFILE_BELOW_RISK_FLOOR" | "RISK_RATIONALE_MISSING" | "PROFILE_DECISION_INVALID";
  message: string;
};

export type ProfileAssuranceObligations = {
  profile: DeliveryProfile;
  obligations: string[];
  verified_outcome_available_in_m2: false;
};

export type ProfilePolicyResult = {
  schema_version: "0.1";
  accepted: boolean;
  recommended_profile: DeliveryProfile;
  risk_floor: DeliveryProfile;
  escalated: boolean;
  decision: DeliveryProfileDecision;
  issues: ProfilePolicyIssue[];
  assurance: ProfileAssuranceObligations;
};

export type DeliveryOutcomeInvariantResult = {
  valid: boolean;
  issues: string[];
  verification_derivation: "UNSUPPORTED_UNTIL_M6";
};

const profileRank: Record<DeliveryProfile, number> = {
  prototype: 0,
  quick_verified: 1,
  full_governance: 2,
};

const mandatoryHighRiskCategories = new Set<DeliveryRiskCategory>([
  "payment",
  "authentication",
  "privacy",
  "security",
  "data_migration",
  "destructive_operation",
  "formal_release",
  "equivalent_high_risk",
]);

const assuranceByProfile: Record<DeliveryProfile, string[]> = {
  prototype: [
    "bounded_task_contract",
    "implementation_readiness",
    "worker_self_test_evidence",
    "prototype_unverified_only",
  ],
  quick_verified: [
    "bounded_task_contract",
    "implementation_readiness",
    "implementer_verifier_independence",
    "code_review",
    "qa",
    "evidence_check",
    "spec_compliance",
  ],
  full_governance: [
    "bounded_task_contract",
    "implementation_readiness",
    "implementer_reviewer_qa_separation",
    "independent_reviewer",
    "independent_qa_verifier",
    "evidence_check",
    "spec_compliance",
    "integration_when_required",
  ],
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalRiskFactors(factors: DeliveryRiskFactor[]): DeliveryRiskFactor[] {
  return [...factors].sort((left, right) => (
    compareText(left.category, right.category) || compareText(left.rationale, right.rationale)
  ));
}

/**
 * Apply the approved assurance floor without authoring a plan or executing work.
 * The caller supplies the timestamp so identical input always yields identical bytes.
 */
export function evaluateDeliveryProfilePolicy(input: ProfilePolicyInput): ProfilePolicyResult {
  const risks = canonicalRiskFactors(input.risk_factors);
  const missingRationales = risks.filter((factor) => factor.rationale.trim().length === 0);
  const hardRisks = risks.filter((factor) => mandatoryHighRiskCategories.has(factor.category));
  const highRiskReasons = hardRisks.map((factor) => `mandatory-risk:${factor.category}`).sort(compareText);
  const validationDepthReasons = [
    ...(input.complexity === "complex" ? ["complex-work"] : []),
    ...(input.change_scope !== "single_module" ? [`scope:${input.change_scope}`] : []),
    ...(input.interface_stability !== "stable" ? [`interface:${input.interface_stability}`] : []),
  ].sort(compareText);

  const riskFloor: DeliveryProfile = highRiskReasons.length > 0
    ? "full_governance"
    : input.purpose === "prototype_candidate"
      ? "prototype"
      : "quick_verified";
  const belowFloor = profileRank[input.requested_profile] < profileRank[riskFloor];
  const effectiveProfile = belowFloor ? riskFloor : input.requested_profile;
  const escalationReasons = belowFloor ? highRiskReasons.length > 0
    ? highRiskReasons
    : [`assurance-floor:${riskFloor}`] : [];
  const riskLabels = risks.map((factor) => `${factor.category}:${factor.rationale.trim()}`);
  const depthNote = validationDepthReasons.length > 0
    ? ` Verification depth must account for ${validationDepthReasons.join(", ")}.`
    : "";

  const decision: DeliveryProfileDecision = {
    schema_version: "0.1",
    profile_decision_id: input.profile_decision_id,
    requested_profile: input.requested_profile,
    effective_profile: effectiveProfile,
    recommendation_reason: riskFloor === "full_governance"
      ? `Full Governance is required by declared high-risk factors.${depthNote}`
      : riskFloor === "quick_verified"
        ? `Quick Verified is the default for simple, low-risk formal work.${depthNote}`
        : `Prototype is suitable only for bounded, low-risk idea validation and remains unverified.${depthNote}`,
    risk_factors: riskLabels,
    escalation_reasons: escalationReasons,
    owner_selected: input.owner_selected,
    created_at: input.created_at,
  };

  const issues: ProfilePolicyIssue[] = [];
  for (const factor of missingRationales) {
    issues.push({
      code: "RISK_RATIONALE_MISSING",
      message: `Risk category ${factor.category} requires a non-empty rationale.`,
    });
  }
  if (belowFloor) {
    issues.push({
      code: "REQUESTED_PROFILE_BELOW_RISK_FLOOR",
      message: `Requested profile ${input.requested_profile} is below the required ${riskFloor} assurance floor.`,
    });
  }
  const structural = validateDeliveryArtifact("deliveryProfileDecision", decision);
  if (!structural.valid) {
    issues.push({ code: "PROFILE_DECISION_INVALID", message: structural.errors.join("; ") });
  }
  issues.sort((left, right) => compareText(left.code, right.code) || compareText(left.message, right.message));

  return {
    schema_version: "0.1",
    accepted: issues.length === 0,
    recommended_profile: riskFloor,
    risk_floor: riskFloor,
    escalated: effectiveProfile !== input.requested_profile,
    decision,
    issues,
    assurance: {
      profile: effectiveProfile,
      obligations: [...assuranceByProfile[effectiveProfile]],
      verified_outcome_available_in_m2: false,
    },
  };
}

/**
 * Validate only the M2 structural/profile boundary. In particular, this never
 * converts gate/evidence references into a Quick or Full VERIFIED outcome.
 */
export function validateDeliveryOutcomeInvariant(
  decision: unknown,
  outcome: unknown,
): DeliveryOutcomeInvariantResult {
  const issues: string[] = [];
  const decisionValidation = validateDeliveryArtifact("deliveryProfileDecision", decision);
  const outcomeValidation = validateDeliveryArtifact("deliveryOutcome", outcome);
  if (!decisionValidation.valid) issues.push(...decisionValidation.errors.map((error) => `decision: ${error}`));
  if (!outcomeValidation.valid) issues.push(...outcomeValidation.errors.map((error) => `outcome: ${error}`));

  if (decisionValidation.valid && outcomeValidation.valid) {
    const typedDecision = decisionValidation.value;
    const typedOutcome = outcomeValidation.value as DeliveryOutcome;
    if (typedOutcome.profile_decision_id !== typedDecision.profile_decision_id) {
      issues.push("outcome: profile_decision_id does not resolve to the supplied decision.");
    }
    if (typedDecision.effective_profile === "prototype" && typedOutcome.status === "VERIFIED") {
      issues.push("outcome: Prototype can never have VERIFIED status.");
    }
    if (typedDecision.effective_profile !== "prototype" && typedOutcome.status === "PROTOTYPE_UNVERIFIED") {
      issues.push("outcome: PROTOTYPE_UNVERIFIED requires the Prototype profile.");
    }
  }

  return {
    valid: issues.length === 0,
    issues: [...issues].sort(compareText),
    verification_derivation: "UNSUPPORTED_UNTIL_M6",
  };
}
