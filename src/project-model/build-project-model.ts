import type { DesignSeed, Milestone, OwnerGate, ProjectState, RequirementRegistry, TaskContract } from "./types.ts";
import { assertReferenceIntegrity } from "./reference-integrity.ts";
import { validateProjectModel } from "./validate.ts";

export type ProjectModelBundle = { requirement_registry: RequirementRegistry; milestones: Milestone[]; tasks: TaskContract[]; owner_gates: OwnerGate[]; project_state: ProjectState };
export type ProjectModelClock = () => string;

function activeMilestone(seed: DesignSeed): Milestone {
  const active = seed.milestones.filter((milestone) => milestone.status === "ACTIVE");
  if (active.length !== 1) throw new Error(`Project model requires exactly one ACTIVE milestone; found ${active.length}.`);
  return active[0];
}

export function buildProjectModel(seed: DesignSeed, clock: ProjectModelClock): ProjectModelBundle {
  const schemaResult = validateProjectModel("designSeed", seed);
  if (!schemaResult.valid) throw new Error(`DesignSeed schema validation failed: ${schemaResult.errors.join(" ")}`);
  assertReferenceIntegrity(seed);
  const source = structuredClone(seed);
  const milestone = activeMilestone(source);
  const updatedAt = clock();
  const bundle: ProjectModelBundle = {
    requirement_registry: { schema_version: "0.1", project_id: source.project_id, requirements: source.requirements, acceptance_criteria: source.acceptance_criteria },
    milestones: source.milestones,
    tasks: source.tasks,
    owner_gates: source.owner_gates,
    project_state: {
      schema_version: "0.1", project_id: source.project_id, name: source.name, owner_policy: source.owner_policy, project_state: "EXECUTING", current_milestone_id: milestone.milestone_id, approved_design_refs: source.approved_design_refs, provider: "local", flow: source.flow,
      git: { initialized: false, default_branch: "main", head: null }, readiness: { status: "NOT_RUN", checked_at: updatedAt },
      active_task_ids: milestone.task_ids.filter((taskId) => { const task = source.tasks.find((candidate) => candidate.task_id === taskId); return task !== undefined && !["TASK_VERIFIED", "BLOCKED"].includes(task.state); }),
      last_verified_milestone_id: null, last_verification_report_ref: null, owner_gate_ids: source.owner_gates.map((gate) => gate.owner_gate_id),
      diagnostics: { provider: "local", collection: "structured_minimum", external_transmission: false, owner_feedback_optional: true, diagnostic_bundle_refs: [], improvement_report_refs: [] },
      self_improvement: { runtime_adaptation: "approved_rules_only", product_evolution: "candidate_only", silent_self_modification: false, self_review: false, automatic_install_or_publish: false, candidate_refs: [] }, updated_at: updatedAt,
    },
  };
  const projectStateResult = validateProjectModel("projectState", bundle.project_state);
  if (!projectStateResult.valid) throw new Error(`Generated ProjectState schema validation failed: ${projectStateResult.errors.join(" ")}`);
  return bundle;
}
