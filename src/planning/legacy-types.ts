import type {
  CriticalBoundary,
  MilestoneV02,
  RepositoryAccess,
  RequirementRegistryV02,
  TaskContractV02,
  TaskKind,
} from "../project-model/types.ts";

export type DeliveryProfile = "prototype" | "quick_verified" | "full_governance";

export type DeliveryProfileDecision = {
  schema_version: "0.1";
  profile_decision_id: string;
  requested_profile: DeliveryProfile;
  effective_profile: DeliveryProfile;
  recommendation_reason: string;
  risk_factors: string[];
  escalation_reasons: string[];
  owner_selected: boolean;
  created_at: string;
};

export type DeliveryOutcome = {
  schema_version: "0.1";
  delivery_outcome_id: string;
  profile_decision_id: string;
  task_id: string;
  status: "PROTOTYPE_UNVERIFIED" | "VERIFIED" | "REWORK" | "BLOCKED";
  gate_result_refs: string[];
  evidence_refs: string[];
  decided_at: string;
};

export type DeliveryReport = {
  schema_version: "0.1";
  delivery_report_id: string;
  project_id: string;
  profile_decision: DeliveryProfileDecision;
  delivery_outcome: DeliveryOutcome;
  project_status: "PROTOTYPE_DELIVERED" | "DELIVERED" | "REWORK" | "BLOCKED";
  assurance_label: "UNVERIFIED" | "VERIFIED" | "NOT_DELIVERED";
  limitations: string[];
  created_at: string;
};

export type CriticalBoundaryEvaluation = {
  boundary: CriticalBoundary;
  changed: boolean;
  producer_interface_refs: string[];
  consumer_task_ids: string[];
};

export type CheckpointPolicy = {
  schema_version: "0.1";
  policy_id: string;
  policy_digest: string;
  subject_task_id: string;
  subject_task_kind: TaskKind;
  subject_repository_access: RepositoryAccess;
  subject_risk_level: "low" | "medium" | "medium-high" | "high";
  critical_boundary_evaluations: CriticalBoundaryEvaluation[];
  derived_consumer_task_ids: string[];
  has_writable_outputs: boolean;
  has_writable_interfaces: boolean;
  reviewer_independence_required: boolean;
  trigger_reasons: Array<"critical_boundary_change" | "multiple_downstream_consumers" | "shared_interface_contract" | "control_exemption" | "no_checkpoint_trigger">;
  checkpoint_task_id?: string;
  disposition: "required" | "exempt_control" | "not_required";
  source_decision_id: string;
  source_decision_digest: string;
  effective_at: string;
  rationale: string;
};

export type CheckpointResult = {
  schema_version: "0.1";
  result_id: string;
  policy_id: string;
  policy_digest: string;
  source_decision_id: string;
  source_decision_digest: string;
  policy_effective_at: string;
  subject_task_id: string;
  subject_run_ids: string[];
  task_contract_digest: string;
  artifact_snapshot_id: string;
  artifact_snapshot_digest: string;
  reviewer_role_id: string;
  outcome: "PASS" | "FAIL";
  finding_refs: string[];
  created_at: string;
};

export type SpecHashEntry = { canonical_ref: string; sha256: string };
export type PathHashEntry = { canonical_repo_relative_path: string; kind: "regular_file" | "symlink" | "gitlink"; git_mode: string; sha256: string };
export type EvidenceHashEntry = { evidence_id: string; canonical_ref: string; sha256: string };

export type EvidenceSnapshot = {
  schema_version: "0.1";
  snapshot_id: string;
  snapshot_digest: string;
  task_id: string;
  run_ids: string[];
  repo_root_identity: string;
  spec_manifest: SpecHashEntry[];
  acceptance_criteria_ids: string[];
  repo_head: string;
  index_digest: string;
  path_hash_manifest: PathHashEntry[];
  evidence_manifest: EvidenceHashEntry[];
  frozen_at: string;
};

export type ClosureManifest = {
  schema_version: "0.1";
  closure_id: string;
  snapshot_id: string;
  snapshot_digest: string;
  gate_run_id: string;
  gate_result: "PASS" | "FAIL";
  report_refs: string[];
  evidence_refs: string[];
  closed_at: string;
};

export type FilesystemIdentity = { platform: "win32" | "linux" | "darwin"; volume_id: string; file_id: string };

export type WriteLease = {
  schema_version: "0.1";
  lease_id: string;
  project_id: string;
  worktree_id: string;
  worktree_identity_version: "filesystem-v0.1";
  canonical_real_path: string;
  filesystem_identity: FilesystemIdentity;
  fencing_token: string;
  holder_run_id: string;
  allowed_scope: string[];
  acquired_at: string;
  expires_at: string;
  status: "active" | "released" | "expired" | "orphaned";
};

export type FailureStage = "planning" | "readiness" | "dispatch" | "implementation" | "checkpoint" | "code_review" | "qa" | "evidence_check" | "spec_check" | "integration" | "recovery";
export type RootCauseClass = "model_reasoning" | "implementation" | "contract" | "environment" | "permission" | "dependency" | "test_infrastructure";

export type FailureFingerprint = {
  schema_version: "0.1";
  fingerprint_id: string;
  repo_root_identity: string;
  stage: FailureStage;
  issue_code: string;
  contract_refs: string[];
  affected_paths: string[];
  root_cause_class: RootCauseClass;
};

export type RetryBudget = {
  schema_version: "0.1";
  task_id: string;
  failure_fingerprint: string;
  attempts: 0 | 1 | 2;
  max_attempts: 2;
  next_action: "retry" | "replan" | "reassign" | "blocked" | "owner_gate";
};

export type ArchitectureComponent = {
  component_id: string;
  name: string;
  responsibilities: string[];
  owned_paths: string[];
};

export type ArchitectureInterface = {
  interface_id: string;
  name: string;
  version: string;
  producer_component_id: string;
  consumer_component_ids: string[];
  contract: string;
  frozen: boolean;
};

export type ArchitectureProposal = {
  schema_version: "0.1";
  architecture_proposal_id: string;
  project_id: string;
  source_requirement_ids: string[];
  summary: string;
  components: ArchitectureComponent[];
  interfaces: ArchitectureInterface[];
  decisions: string[];
  risks: string[];
};

/** The architecture-owned interface catalog embedded in a PlanBundle. */
export type InterfaceCatalog = ArchitectureProposal["interfaces"];

export type PlanDag = {
  schema_version: "0.1";
  nodes: Array<{ task_id: string; depends_on: string[] }>;
};

export type PlanBundle = {
  schema_version: "0.1";
  plan_id: string;
  project_id: string;
  architecture: ArchitectureProposal;
  requirement_registry: RequirementRegistryV02;
  milestones: Array<MilestoneV02 & { status: "PLANNED" }>;
  tasks: Array<TaskContractV02 & { state: "PLANNED" }>;
  dag: PlanDag;
  delivery_profile_decision: DeliveryProfileDecision;
  created_at: string;
};

export type ReadinessResult = {
  schema_version: "0.1";
  plan_id: string;
  status: "PASS" | "NOT_READY" | "BLOCKED" | "UNKNOWN";
  issues: Array<{ code: string; severity: "error" | "warning"; artifact_ref?: string; message: string }>;
  checked_at: string;
};

export type StableValidationIssue = {
  code: string;
  severity: "error" | "warning";
  artifact_ref: string;
  message: string;
  related_refs: string[];
};

/**
 * Pure semantic validation result. Its arrays, issue order, and reachability
 * keys are canonical so serializing the same input produces identical bytes.
 */
export type PlanValidationResult = {
  valid: boolean;
  issues: StableValidationIssue[];
  topological_order: string[];
  reachability: Record<string, string[]>;
};
