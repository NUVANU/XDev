import type {
  MilestoneV02,
  RequirementRegistryV02,
  TaskContractV02,
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

export type CriticalBoundary = TaskContractV02["critical_boundaries"][number];
export type TaskKind = TaskContractV02["task_kind"];
export type RepositoryAccess = TaskContractV02["repository_access"];

export type CheckpointPolicy = {
  schema_version: "0.1";
  policy_id: string;
  policy_digest: string;
  subject_task_id: string;
  subject_task_kind: TaskKind;
  subject_repository_access: RepositoryAccess;
  critical_boundary_evaluations: Array<{ boundary: CriticalBoundary; derived_consumer_task_ids: string[] }>;
  derived_consumer_task_ids: string[];
  trigger_reasons: string[];
  checkpoint_task_id?: string;
  disposition: "required" | "exempt_control" | "not_required";
  source_decision_id: string;
  source_decision_digest: string;
  effective_at: string;
  rationale: string;
};

export type PathHashEntry = {
  canonical_repo_relative_path: string;
  kind: "regular_file" | "symlink" | "gitlink";
  git_mode: string;
  sha256: string;
};

export type SpecHashEntry = { canonical_ref: string; sha256: string };
export type EvidenceHashEntry = { evidence_id: string; canonical_ref: string; sha256: string };

export type EvidenceSnapshot = {
  evidence_class: "GIT_BACKED_EVIDENCE" | "HOST_ARTIFACT_EVIDENCE";
  schema_version: "0.1";
  snapshot_id: string;
  snapshot_digest: string;
  task_id: string;
  run_ids: string[];
  repo_root_identity: string;
  spec_manifest: SpecHashEntry[];
  acceptance_criteria_ids: string[];
  repo_head: string | null;
  index_digest: string;
  path_hash_manifest: PathHashEntry[];
  evidence_manifest: EvidenceHashEntry[];
  frozen_at: string;
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
  reviewer_run_id: string;
  reviewer_agent_id: string;
  reviewer_role_id: string;
  outcome: "PASS" | "FAIL";
  finding_refs: string[];
  created_at: string;
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

export type WriteLease = {
  schema_version: "0.1";
  lease_id: string;
  project_id: string;
  worktree_id: string;
  worktree_identity_version: "0.1";
  canonical_real_path: string;
  filesystem_identity: string;
  fencing_token: number;
  holder_run_id: string;
  allowed_scope: string[];
  acquired_at: string;
  expires_at: string;
  status: "active" | "released" | "expired" | "orphaned";
};

export type FailureFingerprint = {
  schema_version: "0.1";
  fingerprint_id: string;
  stage: "planning" | "dispatch" | "implementation" | "checkpoint" | "review" | "verification" | "integration";
  issue_code: string;
  contract_refs: string[];
  affected_paths: string[];
  root_cause_class: "requirements" | "design" | "implementation" | "test" | "environment" | "permission" | "dependency" | "model";
};

export type RetryBudget = {
  schema_version: "0.1";
  task_id: string;
  failure_fingerprint: string;
  attempts: number;
  max_attempts: 2;
  next_action: "retry" | "replan" | "reassign" | "blocked" | "owner_gate";
};

export type TrustedProjectContext = { readonly project_root: string };
export type RetrySourceEventRef = {
  event_id: string; event_type: string; ledger_line: number; event_sha256: string;
  project_id: string; task_id: string; run_id: string; dispatch_id: string;
  attempt_kind: "initial" | "automatic_rework" | "owner_granted_recovery" | "UNKNOWN";
  failure_fingerprint_id: string | null; payload_ref: string; payload_sha256: string; created_at: string;
};
export type RetryAuthorityRun = {
  run_id: string; task_id: string; lineage_root_task_id: string;
  terminal_disposition: "active" | "implemented" | "failed" | "interrupted" | "cancelled" | "crashed" | "unreachable";
  charge_event_id: string; source_event_refs: RetrySourceEventRef[];
} & ({source_class: "current"; dispatch_id: string; attempt_kind: "initial" | "automatic_rework" | "owner_granted_recovery"; failure_fingerprint_id: string | null; predecessor_run_id: string | null}
  | {source_class: "legacy"; dispatch_id_classification: "UNKNOWN"; attempt_kind_classification: "UNKNOWN"; failure_fingerprint_classification: "UNKNOWN"; legacy_projection_ref: string; legacy_projection_sha256: string});
export type RetryHistoryAuthority = {
  schema_version: "0.1"; authority_id: string; authority_digest: string; project_id: string;
  root_binding: {root_identity_version: "0.1"; repo_root_identity: string; canonical_root_path_sha256: string; project_state_ref: string; project_state_sha256: string};
  source_contract_version: "retry-source-event-0.1";
  source_paths: {project_state: string; ledger: string};
  snapshot_binding: {snapshot_ref: string; snapshot_id: string; snapshot_digest: string; snapshot_frozen_at: string};
  source_watermark: {ledger_ref: string; ledger_sha256: string; ledger_line_count: number; last_event_id: string; last_event_sha256: string};
  legacy_transition_binding: null | {projection_ref: string; projection_sha256: string};
  lineages: Array<{root_task_id: string; nodes: Array<{task_id: string; task_contract_ref: string; task_contract_sha256: string; origin: "initial" | "rename" | "split" | "replan" | "reassignment"; source_event_id: string}>; edges: Array<{parent_task_id: string; child_task_id: string; relation: "rename" | "split" | "replan" | "reassignment"; source_event_id: string}>}>;
  fingerprints: Array<{fingerprint_id: string; fingerprint_ref: string; fingerprint_sha256: string; canonical_tuple: Omit<FailureFingerprint,"fingerprint_id">; canonical_tuple_sha256: string}>;
  runs: RetryAuthorityRun[];
  /** null fingerprint is the lineage total; UNKNOWN never grants an automatic allowance. */
  derived_counts: Array<{lineage_root_task_id: string; failure_fingerprint_id: string | null; automatic_rework_charges: number | "UNKNOWN"; owner_granted_recovery_charges: number; all_worker_charges: number}>;
  created_at: string;
};

/**
 * Facts supplied by a later planner/runtime integration. M2 only validates
 * their cross-artifact consistency; it does not schedule, lease, or dispatch.
 */
export type GovernanceTaskFact = {
  task: TaskContractV02;
  independent_role: boolean;
  writable_output_refs: string[];
};

export type CheckpointPolicyFacts = {
  tasks: GovernanceTaskFact[];
  dag: PlanDag;
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
