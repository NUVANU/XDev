export type OwnerPolicy = "quality_first" | "balanced" | "economy";

export type AcceptanceCriterion = {
  schema_version: "0.1";
  id: string;
  statement: string;
  verification_method: string;
  status: "draft" | "approved" | "verified" | "blocked" | "superseded";
};

export type Requirement = {
  schema_version: "0.1";
  requirement_id: string;
  source_refs: string[];
  statement: string;
  status: "draft" | "approved" | "blocked" | "superseded" | "delivered";
  acceptance_criteria_ids: string[];
  milestone_ids: string[];
  task_ids: string[];
  code_refs: string[];
  evidence_refs: string[];
  delivery_status: "not_started" | "in_progress" | "blocked" | "verified" | "not_delivered";
};

export type RequirementRegistry = {
  schema_version: "0.1";
  project_id: string;
  requirements: Requirement[];
  acceptance_criteria: AcceptanceCriterion[];
};

export type Milestone = {
  schema_version: "0.1";
  milestone_id: string;
  title: string;
  status: "BACKLOG" | "PLANNED" | "ACTIVE" | "VERIFIED" | "BLOCKED";
  task_ids: string[];
  dependencies: string[];
  exit_criteria: string[];
};

export type ComplexityDimension = { score: number; rationale: string };

export type ComplexityProfile = {
  reasoning: ComplexityDimension;
  ambiguity: ComplexityDimension;
  scope: ComplexityDimension;
  dependencies: ComplexityDimension;
  interface_impact: ComplexityDimension;
  failure_cost: ComplexityDimension;
  security: ComplexityDimension;
  novelty: ComplexityDimension;
  verification: ComplexityDimension;
};

export type TaskContract = {
  schema_version: "0.1";
  task_id: string;
  title: string;
  objective: string;
  source_requirement_ids: string[];
  acceptance_criteria: string[];
  workstream_id?: string;
  allowed_scope: string[];
  forbidden_scope: string[];
  dependencies: string[];
  interface_contracts: string[];
  expected_outputs: string[];
  required_tests: string[];
  required_evidence: string[];
  risk_level: "low" | "medium" | "medium-high" | "high";
  complexity_profile: ComplexityProfile;
  model_policy_constraints?: {
    minimum_model_tier: "FAST" | "BALANCED" | "STRONG" | "MAX";
    minimum_reasoning_tier: "LOW" | "MEDIUM" | "HIGH" | "XHIGH_OR_MAX";
  };
  owner_gate_conditions: string[];
  state: "BACKLOG" | "PLANNED" | "READINESS_CHECK" | "READY" | "IN_PROGRESS" | "IMPLEMENTED" | "CODE_REVIEW" | "QA" | "EVIDENCE_CHECK" | "SPEC_CHECK" | "TASK_VERIFIED" | "REWORK" | "BLOCKED" | "REPEATED_FAILURE";
};

export type OwnerGate = {
  schema_version: "0.1";
  owner_gate_id: string;
  title: string;
  occurred: string;
  reason: string;
  question: string;
  options: Array<{ option_id: string; title: string; description: string; cost: string; experience: string; risk: string; follow_up_impact: string }>;
  recommendation: { option_id: string; reason: string };
  affected_requirement_ids: string[];
  affected_task_ids: string[];
  affected_artifact_refs: string[];
  status: "pending" | "approved" | "rejected" | "resolved";
  decision_ref?: string;
  created_at: string;
  resolved_at?: string;
};

export type Flow = { type: "quick" | "full_governance"; reason: string };

export type ProjectState = {
  schema_version: "0.1";
  project_id: string;
  name: string;
  owner_policy: OwnerPolicy;
  project_state: "PLANNING" | "APPROVED" | "EXECUTING" | "WORKSTREAMS_VERIFIED" | "PROJECT_INTEGRATION" | "FINAL_SPEC_CHECK" | "OWNER_REVIEW" | "DELIVERED" | "BLOCKED";
  current_milestone_id: string;
  approved_design_refs: string[];
  provider: "local";
  flow: Flow;
  git: { initialized: boolean; default_branch: string; head: string | null; head_semantics?: string; probe_note?: string };
  readiness: { status: "PASS" | "FAIL" | "NOT_RUN"; checked_at: string; evidence_ref?: string };
  active_task_ids: string[];
  last_verified_milestone_id: string | null;
  last_verification_report_ref: string | null;
  owner_gate_ids: string[];
  diagnostics: { provider: "local"; collection: "structured_minimum"; external_transmission: false; owner_feedback_optional: boolean; diagnostic_bundle_refs: string[]; improvement_report_refs: string[] };
  self_improvement: { runtime_adaptation: "approved_rules_only"; product_evolution: "candidate_only"; silent_self_modification: false; self_review: false; automatic_install_or_publish: false; candidate_refs: string[] };
  updated_at: string;
};

export type DesignSeed = {
  schema_version: "0.1";
  project_id: string;
  name: string;
  owner_policy: OwnerPolicy;
  approved_design_refs: string[];
  flow: Flow;
  requirements: Requirement[];
  acceptance_criteria: AcceptanceCriterion[];
  milestones: Milestone[];
  tasks: TaskContract[];
  owner_gates: OwnerGate[];
};

export type ProjectModelSchemaVersion = "0.1" | "0.2";

export type TaskKind = "implementation" | "checkpoint_control" | "review_control" | "verification_control";
export type RepositoryAccess = "read_only" | "write_scoped";
export type CriticalBoundary = "security" | "state_migration" | "evidence" | "permission" | "privacy" | "payment" | "authentication" | "write_scope" | "public_schema" | "plan_validation" | "readiness";

export type AcceptanceCriterionV02 = Omit<AcceptanceCriterion, "schema_version"> & { schema_version: "0.2" };

export type RequirementV02 = Omit<Requirement, "schema_version" | "delivery_status"> & {
  schema_version: "0.2";
  delivery_status: Requirement["delivery_status"] | "prototype_unverified";
};

export type RequirementRegistryV02 = {
  schema_version: "0.2";
  project_id: string;
  requirements: RequirementV02[];
  acceptance_criteria: AcceptanceCriterionV02[];
};

export type MilestoneV02 = Omit<Milestone, "schema_version" | "status"> & {
  schema_version: "0.2";
  status: Milestone["status"] | "PROTOTYPE_READY";
};

export type TaskContractV02 = Omit<TaskContract, "schema_version" | "state"> & {
  schema_version: "0.2";
  task_kind: TaskKind;
  repository_access: RepositoryAccess;
  critical_boundaries: CriticalBoundary[];
  state: TaskContract["state"] | "PROTOTYPE_READY";
};

export type OwnerGateV02 = Omit<OwnerGate, "schema_version"> & { schema_version: "0.2" };

export type ProjectStateV02 = Omit<ProjectState, "schema_version" | "project_state" | "flow"> & {
  schema_version: "0.2";
  project_state: ProjectState["project_state"] | "PROTOTYPE_DELIVERED";
  delivery_profile_decision_ref: string;
  delivery_outcome_ref?: string;
  delivery_report_ref?: string;
};

export type ProjectModelBundleV02 = {
  schema_version: "0.2";
  requirement_registry: RequirementRegistryV02;
  milestones: MilestoneV02[];
  tasks: TaskContractV02[];
  owner_gates: OwnerGateV02[];
  project_state: ProjectStateV02;
  delivery_profile_decision: import("../planning/types.ts").DeliveryProfileDecision;
  delivery_outcome?: import("../planning/types.ts").DeliveryOutcome;
  delivery_report?: import("../planning/types.ts").DeliveryReport;
};

export type ProjectModelContainerV02 =
  | { schema_version: "0.2"; artifact_kind: "requirement_registry"; artifact: RequirementRegistryV02 }
  | { schema_version: "0.2"; artifact_kind: "milestone"; artifact: MilestoneV02 }
  | { schema_version: "0.2"; artifact_kind: "task_contract"; artifact: TaskContractV02 }
  | { schema_version: "0.2"; artifact_kind: "owner_gate"; artifact: OwnerGateV02 }
  | { schema_version: "0.2"; artifact_kind: "project_state"; artifact: ProjectStateV02 }
  | { schema_version: "0.2"; artifact_kind: "project_model_bundle"; artifact: ProjectModelBundleV02 };
