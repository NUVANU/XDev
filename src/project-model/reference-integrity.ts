import type { DesignSeed, Milestone, TaskContract } from "./types.ts";

export type ReferenceIntegrityResult = { valid: true; errors: [] } | { valid: false; errors: string[] };

type Identified = { [key: string]: unknown };

function indexById<T extends Identified>(records: T[], idField: string, kind: string, errors: string[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const record of records) {
    const id = record[idField];
    if (typeof id !== "string") continue;
    if (index.has(id)) errors.push(`${kind} ${id}: duplicate identifier.`);
    else index.set(id, record);
  }
  return index;
}

function missing(errors: string[], objectId: string, field: string, id: string): void {
  errors.push(`${objectId}.${field}: ${id} does not resolve.`);
}

function requireBackLink(errors: string[], sourceId: string, field: string, targetId: string): void {
  errors.push(`${sourceId}.${field}: missing reverse link to ${targetId}.`);
}

function hasTaskForRequirement(milestone: Milestone, tasks: Map<string, TaskContract>, requirementId: string): boolean {
  return milestone.task_ids.some((taskId) => tasks.get(taskId)?.source_requirement_ids.includes(requirementId));
}

export function validateReferenceIntegrity(seed: DesignSeed): ReferenceIntegrityResult {
  const errors: string[] = [];
  const requirements = indexById(seed.requirements, "requirement_id", "Requirement", errors);
  const criteria = indexById(seed.acceptance_criteria, "id", "AcceptanceCriterion", errors);
  const milestones = indexById(seed.milestones, "milestone_id", "Milestone", errors);
  const tasks = indexById(seed.tasks, "task_id", "TaskContract", errors);
  const ownerGates = indexById(seed.owner_gates, "owner_gate_id", "OwnerGate", errors);

  for (const requirement of seed.requirements) {
    for (const criterionId of requirement.acceptance_criteria_ids) {
      if (!criteria.has(criterionId)) missing(errors, requirement.requirement_id, "acceptance_criteria_ids", criterionId);
    }
    for (const milestoneId of requirement.milestone_ids) {
      const milestone = milestones.get(milestoneId);
      if (!milestone) missing(errors, requirement.requirement_id, "milestone_ids", milestoneId);
      else if (!hasTaskForRequirement(milestone, tasks, requirement.requirement_id)) requireBackLink(errors, milestone.milestone_id, "task_ids", requirement.requirement_id);
    }
    for (const taskId of requirement.task_ids) {
      const task = tasks.get(taskId);
      if (!task) missing(errors, requirement.requirement_id, "task_ids", taskId);
      else if (!task.source_requirement_ids.includes(requirement.requirement_id)) requireBackLink(errors, task.task_id, "source_requirement_ids", requirement.requirement_id);
      else if (!requirement.milestone_ids.some((milestoneId) => milestones.get(milestoneId)?.task_ids.includes(taskId))) requireBackLink(errors, requirement.requirement_id, "milestone_ids", taskId);
    }
  }

  for (const milestone of seed.milestones) {
    for (const dependencyId of milestone.dependencies) if (!milestones.has(dependencyId)) missing(errors, milestone.milestone_id, "dependencies", dependencyId);
    for (const taskId of milestone.task_ids) {
      const task = tasks.get(taskId);
      if (!task) { missing(errors, milestone.milestone_id, "task_ids", taskId); continue; }
      for (const requirementId of task.source_requirement_ids) {
        const requirement = requirements.get(requirementId);
        if (!requirement) missing(errors, task.task_id, "source_requirement_ids", requirementId);
        else if (!requirement.milestone_ids.includes(milestone.milestone_id)) requireBackLink(errors, requirement.requirement_id, "milestone_ids", milestone.milestone_id);
      }
    }
  }

  for (const task of seed.tasks) {
    if (!seed.milestones.some((milestone) => milestone.task_ids.includes(task.task_id))) errors.push(`${task.task_id}: is not assigned to any Milestone.task_ids.`);
    for (const requirementId of task.source_requirement_ids) {
      const requirement = requirements.get(requirementId);
      if (!requirement) { missing(errors, task.task_id, "source_requirement_ids", requirementId); continue; }
      if (!requirement.task_ids.includes(task.task_id)) requireBackLink(errors, requirement.requirement_id, "task_ids", task.task_id);
    }
    for (const criterionId of task.acceptance_criteria) {
      if (!criteria.has(criterionId)) { missing(errors, task.task_id, "acceptance_criteria", criterionId); continue; }
      if (!task.source_requirement_ids.some((requirementId) => requirements.get(requirementId)?.acceptance_criteria_ids.includes(criterionId))) errors.push(`${task.task_id}.acceptance_criteria: ${criterionId} is not linked by a source requirement.`);
    }
    for (const dependencyId of task.dependencies) if (!tasks.has(dependencyId)) missing(errors, task.task_id, "dependencies", dependencyId);
    for (const gateId of task.owner_gate_conditions) {
      const gate = ownerGates.get(gateId);
      if (!gate) missing(errors, task.task_id, "owner_gate_conditions", gateId);
      else if (!gate.affected_task_ids.includes(task.task_id)) requireBackLink(errors, gate.owner_gate_id, "affected_task_ids", task.task_id);
    }
  }

  for (const gate of seed.owner_gates) {
    const options = indexById(gate.options, "option_id", `OwnerGate ${gate.owner_gate_id} option`, errors);
    if (!options.has(gate.recommendation.option_id)) missing(errors, gate.owner_gate_id, "recommendation.option_id", gate.recommendation.option_id);
    for (const requirementId of gate.affected_requirement_ids) if (!requirements.has(requirementId)) missing(errors, gate.owner_gate_id, "affected_requirement_ids", requirementId);
    for (const taskId of gate.affected_task_ids) {
      const task = tasks.get(taskId);
      if (!task) missing(errors, gate.owner_gate_id, "affected_task_ids", taskId);
      else if (!task.owner_gate_conditions.includes(gate.owner_gate_id)) requireBackLink(errors, task.task_id, "owner_gate_conditions", gate.owner_gate_id);
    }
  }

  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

export function assertReferenceIntegrity(seed: DesignSeed): void {
  const result = validateReferenceIntegrity(seed);
  if (!result.valid) throw new Error(`Reference integrity failed: ${result.errors.join(" ")}`);
}
