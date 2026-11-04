import { win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Graph, alg } from "@dagrejs/graphlib";
import { validateCheckpointPolicy, validateCheckpointResult, type CheckpointResultBindings } from "./governance-contracts.ts";
import { validatePlanningArtifact } from "./validate.ts";
import type {
  ArchitectureInterface,
  CheckpointPolicy,
  CheckpointResult,
  PlanBundle,
  PlanValidationResult,
  StableValidationIssue,
} from "./types.ts";

type UnknownRecord = Record<string, unknown>;
type InterfaceUse = { interfaceId: string; version: string; role: "producer" | "consumer" };

const interfaceUsePattern = /^(IF-[A-Z0-9]+(?:-[A-Z0-9]+)+)@([0-9]+\.[0-9]+):(producer|consumer)$/;

/** Independently supplied current facts, never inferred from a submitted PASS. */
export type PlanCheckpointInput = {
  subject_task_id: string;
  policy: CheckpointPolicy;
  result?: CheckpointResult;
  bindings: Omit<CheckpointResultBindings, "policy">;
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function issue(
  issues: StableValidationIssue[],
  code: string,
  artifactRef: string,
  message: string,
  relatedRefs: string[] = [],
): void {
  issues.push({
    code,
    severity: "error",
    artifact_ref: artifactRef,
    message,
    related_refs: sortedUnique(relatedRefs),
  });
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort(compareText);
}

function indexBy(recordsToIndex: UnknownRecord[], idField: string): Map<string, UnknownRecord> {
  const index = new Map<string, UnknownRecord>();
  for (const record of recordsToIndex) {
    const id = text(record[idField]);
    if (id && !index.has(id)) index.set(id, record);
  }
  return index;
}

function reportDuplicateIds(
  issues: StableValidationIssue[],
  values: UnknownRecord[],
  idField: string,
  code: string,
  artifactRoot: string,
): void {
  for (const id of duplicateValues(values.map((value) => text(value[idField])).filter(Boolean))) {
    issue(issues, code, `${artifactRoot}/${id}`, `${idField} must be unique.`, [id]);
  }
}

function reportDuplicateRefs(
  issues: StableValidationIssue[],
  values: string[],
  code: string,
  artifactRef: string,
): void {
  for (const value of duplicateValues(values)) {
    issue(issues, code, artifactRef, "A reference appears more than once.", [value]);
  }
}

function sameSet(left: string[], right: string[]): boolean {
  const leftSet = sortedUnique(left);
  const rightSet = sortedUnique(right);
  return leftSet.length === rightSet.length && leftSet.every((value, index) => value === rightSet[index]);
}

function buildTaskGraph(taskIds: string[], dependenciesByTask: ReadonlyMap<string, string[]>): Graph {
  const graph = new Graph({ directed: true });
  graph.setNodes(sortedUnique(taskIds));
  const known = new Set(taskIds);
  for (const taskId of sortedUnique(taskIds)) {
    for (const dependencyId of sortedUnique(dependenciesByTask.get(taskId) ?? [])) {
      if (known.has(dependencyId) && dependencyId !== taskId) graph.setEdge(dependencyId, taskId);
    }
  }
  return graph;
}

/** Return graphlib's deterministic topological order for our sorted graph construction. */
export function stableTopologicalOrder(graph: Graph): string[] {
  if (!alg.isAcyclic(graph)) return [];
  return (alg.topsort(graph) as string[]);
}

/** Return deterministic transitive successors for every graph node. */
export function stableReachability(graph: Graph): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const source of graph.nodes().sort(compareText)) {
    const paths = alg.dijkstra(graph, source) as Record<string, { distance: number }>;
    result[source] = Object.entries(paths)
      .filter(([target, path]) => target !== source && Number.isFinite(path.distance))
      .map(([target]) => target)
      .sort(compareText);
  }
  return result;
}

type ScopePath = { original: string; normalized: string };

function normalizeLocalScope(value: string): ScopePath | null {
  const segments = value.split(/[\\/]+/);
  if (
    value.length === 0
    || win32.isAbsolute(value)
    || /^[A-Za-z]:/.test(value)
    || segments.includes("..")
  ) return null;

  // Inspect raw segments before normalization: trimming can hide Win32 aliases.
  // Exact dot segments and repeated separators can safely use node:path rules.
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (/[. ]$/.test(segment) || /[<>:"|?*\u0000-\u001f]/.test(segment)) return null;
    const deviceName = segment.split(".")[0].replace(/ +$/, "");
    if (/^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]|conin\$|conout\$)$/i.test(deviceName)) return null;
  }

  const normalized = win32.normalize(value).replace(/\\+/g, "/").replace(/^\.\//, "").replace(/\/$/, "").toLowerCase();
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  return { original: value, normalized };
}

function isPathLikeForbiddenScope(value: string): boolean {
  return !/\s/.test(value.trim()) || /[\\/]/.test(value) || value.startsWith(".");
}

function scopesOverlap(left: ScopePath, right: ScopePath): boolean {
  return left.normalized === right.normalized
    || left.normalized.startsWith(`${right.normalized}/`)
    || right.normalized.startsWith(`${left.normalized}/`);
}

function parseInterfaceUse(value: string): InterfaceUse | null {
  const match = interfaceUsePattern.exec(value);
  return match ? { interfaceId: match[1], version: match[2], role: match[3] as InterfaceUse["role"] } : null;
}

function validateInterfaces(
  issues: StableValidationIssue[],
  interfaces: UnknownRecord[],
  components: UnknownRecord[],
  tasks: UnknownRecord[],
  reachability: Record<string, string[]>,
): void {
  const componentIds = new Set(components.map((component) => text(component.component_id)).filter(Boolean));
  const interfaceIndex = indexBy(interfaces, "interface_id");
  const uses = new Map<string, Array<InterfaceUse & { taskId: string }>>();

  reportDuplicateIds(issues, components, "component_id", "DUPLICATE_ARCHITECTURE_COMPONENT_ID", "architecture/components");
  reportDuplicateIds(issues, interfaces, "interface_id", "DUPLICATE_INTERFACE_ID", "architecture/interfaces");

  for (const contract of interfaces) {
    const interfaceId = text(contract.interface_id);
    const artifactRef = `architecture/interfaces/${interfaceId || "unknown"}`;
    const producer = text(contract.producer_component_id);
    const consumers = strings(contract.consumer_component_ids);
    reportDuplicateRefs(issues, consumers, "DUPLICATE_INTERFACE_CONSUMER_COMPONENT", artifactRef);
    if (!componentIds.has(producer)) {
      issue(issues, "INTERFACE_PRODUCER_COMPONENT_NOT_FOUND", artifactRef, "The producer component does not resolve.", [producer]);
    }
    for (const consumer of consumers) {
      if (!componentIds.has(consumer)) {
        issue(issues, "INTERFACE_CONSUMER_COMPONENT_NOT_FOUND", artifactRef, "A consumer component does not resolve.", [consumer]);
      }
      if (consumer === producer) {
        issue(issues, "INTERFACE_COMPONENT_ROLE_CONFLICT", artifactRef, "The producer component cannot also consume the same interface.", [consumer]);
      }
    }
    if (contract.frozen !== true) {
      issue(issues, "INTERFACE_NOT_FROZEN", artifactRef, "The interface must be frozen before implementation.", [interfaceId]);
    }
  }

  for (const task of tasks) {
    const taskId = text(task.task_id);
    const artifactRef = `tasks/${taskId || "unknown"}`;
    const contracts = strings(task.interface_contracts);
    reportDuplicateRefs(issues, contracts, "DUPLICATE_TASK_INTERFACE_BACKLINK", artifactRef);
    for (const contract of contracts) {
      if (!contract.startsWith("IF-")) continue;
      const parsed = parseInterfaceUse(contract);
      if (!parsed) {
        issue(issues, "INTERFACE_BACKLINK_INVALID", artifactRef, "Interface backlinks must use IF-ID@version:producer or IF-ID@version:consumer.");
        continue;
      }
      const catalogEntry = interfaceIndex.get(parsed.interfaceId);
      if (!catalogEntry) {
        issue(issues, "INTERFACE_BACKLINK_NOT_FOUND", artifactRef, "The interface backlink does not resolve.", [parsed.interfaceId]);
        continue;
      }
      if (parsed.version !== text(catalogEntry.version)) {
        issue(issues, "INTERFACE_VERSION_MISMATCH", artifactRef, "The task backlink version does not match the interface catalog.", [parsed.interfaceId]);
      }
      const existing = uses.get(parsed.interfaceId) ?? [];
      existing.push({ ...parsed, taskId });
      uses.set(parsed.interfaceId, existing);
    }
  }

  for (const contract of interfaces) {
    const interfaceId = text(contract.interface_id);
    const artifactRef = `architecture/interfaces/${interfaceId || "unknown"}`;
    const contractUses = uses.get(interfaceId) ?? [];
    const producers = sortedUnique(contractUses.filter((use) => use.role === "producer").map((use) => use.taskId));
    const consumers = sortedUnique(contractUses.filter((use) => use.role === "consumer").map((use) => use.taskId));
    if (producers.length === 0) {
      issue(issues, "INTERFACE_PRODUCER_MISSING", artifactRef, "The interface has no producer task backlink.", [interfaceId]);
    } else if (producers.length > 1) {
      issue(issues, "INTERFACE_MULTIPLE_PRODUCERS", artifactRef, "The interface must have exactly one producer task.", producers);
    }
    if (strings(contract.consumer_component_ids).length > 0 && consumers.length === 0) {
      issue(issues, "INTERFACE_CONSUMER_MISSING", artifactRef, "The interface has declared consumers but no consumer task backlink.", [interfaceId]);
    }
    for (const producer of producers) {
      for (const consumer of consumers) {
        if (!(reachability[producer] ?? []).includes(consumer)) {
          issue(issues, "INTERFACE_DEPENDENCY_ORDER_INVALID", artifactRef, "Every consumer task must transitively depend on the producer task.", [producer, consumer]);
        }
      }
    }
  }
}

function validateScopes(
  issues: StableValidationIssue[],
  tasks: UnknownRecord[],
  reachability: Record<string, string[]>,
): void {
  const taskScopes = new Map<string, ScopePath[]>();
  for (const task of tasks) {
    const taskId = text(task.task_id);
    const artifactRef = `tasks/${taskId || "unknown"}`;
    const allowed: ScopePath[] = [];
    for (const value of strings(task.allowed_scope)) {
      const normalized = normalizeLocalScope(value);
      if (!normalized) issue(issues, "WRITE_SCOPE_INVALID", artifactRef, "Allowed write scopes must be Windows-local relative paths without traversal, trailing dots/spaces, reserved devices, or invalid characters.");
      else allowed.push(normalized);
    }
    for (const duplicate of duplicateValues(allowed.map((scope) => scope.normalized))) {
      issue(issues, "DUPLICATE_NORMALIZED_WRITE_SCOPE", artifactRef, "Allowed write scopes must be unique after Windows normalization.", [duplicate]);
    }
    taskScopes.set(taskId, allowed);

    const forbidden: ScopePath[] = [];
    for (const value of strings(task.forbidden_scope).filter(isPathLikeForbiddenScope)) {
      const normalized = normalizeLocalScope(value);
      if (!normalized) issue(issues, "FORBIDDEN_SCOPE_INVALID", artifactRef, "Path-like forbidden scopes must be Windows-local relative paths without traversal, trailing dots/spaces, reserved devices, or invalid characters.");
      else forbidden.push(normalized);
    }
    for (const allowedScope of allowed) {
      for (const forbiddenScope of forbidden) {
        if (scopesOverlap(allowedScope, forbiddenScope)) {
          issue(issues, "ALLOWED_FORBIDDEN_SCOPE_CONTRADICTION", artifactRef, "Allowed and forbidden path scopes overlap.");
        }
      }
    }
  }

  const taskIds = [...taskScopes.keys()].sort(compareText);
  for (let leftIndex = 0; leftIndex < taskIds.length; leftIndex += 1) {
    const leftId = taskIds[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < taskIds.length; rightIndex += 1) {
      const rightId = taskIds[rightIndex];
      const ordered = (reachability[leftId] ?? []).includes(rightId) || (reachability[rightId] ?? []).includes(leftId);
      if (ordered) continue;
      if ((taskScopes.get(leftId) ?? []).some((left) => (taskScopes.get(rightId) ?? []).some((right) => scopesOverlap(left, right)))) {
        issue(issues, "UNORDERED_WRITE_SCOPE_CONFLICT", `tasks/${leftId}`, "Unordered tasks have exact, ancestor, or subtree write-scope overlap.", [leftId, rightId]);
      }
    }
  }
}

function validateNormativeStatus(
  issues: StableValidationIssue[],
  value: unknown,
  accepted: string[],
  codePrefix: string,
  artifactRef: string,
): void {
  const status = text(value);
  if (accepted.includes(status)) return;
  const suffix = ["draft", "blocked", "superseded"].includes(status) ? status.toUpperCase() : "UNRESOLVED";
  issue(issues, `${codePrefix}_${suffix}`, artifactRef, "The normative artifact status is not ready for implementation.");
}

function validateReferencesAndCoverage(
  issues: StableValidationIssue[],
  architecture: UnknownRecord,
  registry: UnknownRecord,
  milestones: UnknownRecord[],
  tasks: UnknownRecord[],
): void {
  const requirements = records(registry.requirements);
  const criteria = records(registry.acceptance_criteria);
  reportDuplicateIds(issues, requirements, "requirement_id", "DUPLICATE_REQUIREMENT_ID", "requirements");
  reportDuplicateIds(issues, criteria, "id", "DUPLICATE_ACCEPTANCE_CRITERION_ID", "acceptance-criteria");
  reportDuplicateIds(issues, milestones, "milestone_id", "DUPLICATE_MILESTONE_ID", "milestones");
  reportDuplicateIds(issues, tasks, "task_id", "DUPLICATE_TASK_ID", "tasks");

  const requirementIndex = indexBy(requirements, "requirement_id");
  const criterionIndex = indexBy(criteria, "id");
  const milestoneIndex = indexBy(milestones, "milestone_id");
  const taskIndex = indexBy(tasks, "task_id");
  const activeRequirementIds = sortedUnique(requirements.filter((requirement) => text(requirement.status) !== "superseded").map((requirement) => text(requirement.requirement_id)).filter(Boolean));
  const activeCriterionIds = sortedUnique(criteria.filter((criterion) => text(criterion.status) !== "superseded").map((criterion) => text(criterion.id)).filter(Boolean));

  const architectureRequirements = strings(architecture.source_requirement_ids);
  reportDuplicateRefs(issues, architectureRequirements, "DUPLICATE_ARCHITECTURE_REQUIREMENT_REF", "architecture");
  for (const requirementId of activeRequirementIds.filter((id) => !architectureRequirements.includes(id))) {
    issue(issues, "ARCHITECTURE_REQUIREMENT_COVERAGE_MISSING", "architecture", "An active requirement is missing from architecture coverage.", [requirementId]);
  }
  for (const requirementId of architectureRequirements.filter((id) => !requirementIndex.has(id))) {
    issue(issues, "ARCHITECTURE_REQUIREMENT_REF_NOT_FOUND", "architecture", "An architecture requirement reference does not resolve.", [requirementId]);
  }

  for (const requirement of requirements) {
    const requirementId = text(requirement.requirement_id);
    const artifactRef = `requirements/${requirementId || "unknown"}`;
    validateNormativeStatus(issues, requirement.status, ["approved"], "REQUIREMENT_STATUS", `${artifactRef}/status`);
    validateNormativeStatus(issues, requirement.delivery_status, ["not_started", "in_progress", "not_delivered"], "REQUIREMENT_DELIVERY_STATUS", `${artifactRef}/delivery_status`);
    const acceptanceIds = strings(requirement.acceptance_criteria_ids);
    const taskIds = strings(requirement.task_ids);
    const milestoneIds = strings(requirement.milestone_ids);
    reportDuplicateRefs(issues, acceptanceIds, "DUPLICATE_REQUIREMENT_ACCEPTANCE_REF", artifactRef);
    reportDuplicateRefs(issues, taskIds, "DUPLICATE_REQUIREMENT_TASK_REF", artifactRef);
    reportDuplicateRefs(issues, milestoneIds, "DUPLICATE_REQUIREMENT_MILESTONE_REF", artifactRef);
    for (const criterionId of acceptanceIds.filter((id) => !criterionIndex.has(id))) {
      issue(issues, "REQUIREMENT_ACCEPTANCE_REF_NOT_FOUND", artifactRef, "A requirement acceptance-criterion reference does not resolve.", [criterionId]);
    }
    for (const taskId of taskIds.filter((id) => !taskIndex.has(id))) {
      issue(issues, "REQUIREMENT_TASK_REF_NOT_FOUND", artifactRef, "A requirement task backlink does not resolve.", [taskId]);
    }
    for (const milestoneId of milestoneIds.filter((id) => !milestoneIndex.has(id))) {
      issue(issues, "REQUIREMENT_MILESTONE_REF_NOT_FOUND", artifactRef, "A requirement milestone reference does not resolve.", [milestoneId]);
    }
    const expectedTaskIds = sortedUnique(tasks.filter((task) => strings(task.source_requirement_ids).includes(requirementId)).map((task) => text(task.task_id)).filter(Boolean));
    if (!sameSet(taskIds, expectedTaskIds)) {
      issue(issues, "REQUIREMENT_TASK_BACKLINK_MISMATCH", artifactRef, "Requirement task backlinks must exactly match task source references.", [...taskIds, ...expectedTaskIds]);
    }
    const expectedMilestoneIds = sortedUnique(milestones.filter((milestone) => strings(milestone.task_ids).some((taskId) => expectedTaskIds.includes(taskId))).map((milestone) => text(milestone.milestone_id)).filter(Boolean));
    if (!sameSet(milestoneIds, expectedMilestoneIds)) {
      issue(issues, "REQUIREMENT_MILESTONE_BACKLINK_MISMATCH", artifactRef, "Requirement milestone backlinks must exactly match milestones containing its tasks.", [...milestoneIds, ...expectedMilestoneIds]);
    }
  }

  for (const criterion of criteria) {
    const criterionId = text(criterion.id);
    validateNormativeStatus(issues, criterion.status, ["approved"], "ACCEPTANCE_CRITERION_STATUS", `acceptance-criteria/${criterionId || "unknown"}/status`);
  }

  for (const milestone of milestones) {
    const milestoneId = text(milestone.milestone_id);
    const artifactRef = `milestones/${milestoneId || "unknown"}`;
    const taskIds = strings(milestone.task_ids);
    const dependencies = strings(milestone.dependencies);
    reportDuplicateRefs(issues, taskIds, "DUPLICATE_MILESTONE_TASK_REF", artifactRef);
    reportDuplicateRefs(issues, dependencies, "DUPLICATE_MILESTONE_DEPENDENCY", artifactRef);
    for (const taskId of taskIds.filter((id) => !taskIndex.has(id))) {
      issue(issues, "MILESTONE_TASK_REF_NOT_FOUND", artifactRef, "A milestone task reference does not resolve.", [taskId]);
    }
    for (const dependency of dependencies) {
      if (dependency === milestoneId) issue(issues, "MILESTONE_SELF_DEPENDENCY", artifactRef, "A milestone cannot depend on itself.", [milestoneId]);
      else if (!milestoneIndex.has(dependency)) issue(issues, "MILESTONE_DEPENDENCY_NOT_FOUND", artifactRef, "A milestone dependency does not resolve.", [dependency]);
    }
  }

  for (const task of tasks) {
    const taskId = text(task.task_id);
    const artifactRef = `tasks/${taskId || "unknown"}`;
    const requirementIds = strings(task.source_requirement_ids);
    const criterionIds = strings(task.acceptance_criteria);
    reportDuplicateRefs(issues, requirementIds, "DUPLICATE_TASK_REQUIREMENT_REF", artifactRef);
    reportDuplicateRefs(issues, criterionIds, "DUPLICATE_TASK_ACCEPTANCE_REF", artifactRef);
    for (const requirementId of requirementIds.filter((id) => !requirementIndex.has(id))) {
      issue(issues, "TASK_REQUIREMENT_REF_NOT_FOUND", artifactRef, "A task requirement reference does not resolve.", [requirementId]);
    }
    for (const criterionId of criterionIds.filter((id) => !criterionIndex.has(id))) {
      issue(issues, "TASK_ACCEPTANCE_REF_NOT_FOUND", artifactRef, "A task acceptance-criterion reference does not resolve.", [criterionId]);
    }
    const allowedCriteria = new Set(requirementIds.flatMap((id) => strings(requirementIndex.get(id)?.acceptance_criteria_ids)));
    for (const criterionId of criterionIds.filter((id) => criterionIndex.has(id) && !allowedCriteria.has(id))) {
      issue(issues, "TASK_ACCEPTANCE_REQUIREMENT_MISMATCH", artifactRef, "A task acceptance criterion is not owned by one of its source requirements.", [criterionId]);
    }
  }

  for (const requirementId of activeRequirementIds) {
    if (!tasks.some((task) => strings(task.source_requirement_ids).includes(requirementId))) {
      issue(issues, "REQUIREMENT_COVERAGE_MISSING", `requirements/${requirementId}`, "An active requirement has no covering task.", [requirementId]);
    }
  }
  for (const criterionId of activeCriterionIds) {
    if (!requirements.some((requirement) => strings(requirement.acceptance_criteria_ids).includes(criterionId))) {
      issue(issues, "ACCEPTANCE_REQUIREMENT_BACKLINK_MISSING", `acceptance-criteria/${criterionId}`, "The acceptance criterion is not linked from a requirement.", [criterionId]);
    }
    if (!tasks.some((task) => strings(task.acceptance_criteria).includes(criterionId))) {
      issue(issues, "ACCEPTANCE_CRITERION_COVERAGE_MISSING", `acceptance-criteria/${criterionId}`, "An active acceptance criterion has no covering task.", [criterionId]);
    }
  }
  for (const taskId of taskIndex.keys()) {
    const containingMilestones = milestones.filter((milestone) => strings(milestone.task_ids).includes(taskId));
    if (containingMilestones.length === 0) issue(issues, "TASK_MILESTONE_BACKLINK_MISSING", `tasks/${taskId}`, "The task is not linked from a milestone.", [taskId]);
    else if (containingMilestones.length > 1) issue(issues, "TASK_MILESTONE_BACKLINK_AMBIGUOUS", `tasks/${taskId}`, "The task is linked from more than one milestone.", containingMilestones.map((milestone) => text(milestone.milestone_id)));
  }
}

function canonicalIssues(issues: StableValidationIssue[]): StableValidationIssue[] {
  return [...issues].sort((left, right) => (
    compareText(left.code, right.code)
    || compareText(left.artifact_ref, right.artifact_ref)
    || compareText(left.related_refs.join("\u0000"), right.related_refs.join("\u0000"))
    || compareText(left.message, right.message)
  ));
}

function validatePlanCheckpoints(
  issues: StableValidationIssue[],
  tasks: UnknownRecord[],
  dag: UnknownRecord,
  checkpointInputs: readonly PlanCheckpointInput[] | undefined,
): void {
  if (checkpointInputs !== undefined && !Array.isArray(checkpointInputs)) {
    issue(issues, "CHECKPOINT_INPUT_INVALID", "plan/checkpoints", "Checkpoint inputs must be an array of current subject bindings.");
  }
  const inputs = records(checkpointInputs);
  if (Array.isArray(checkpointInputs) && inputs.length !== checkpointInputs.length) {
    issue(issues, "CHECKPOINT_INPUT_INVALID", "plan/checkpoints", "Every checkpoint input must identify a subject and its current bindings.");
  }
  for (const input of inputs) {
    if (!tasks.some((task) => task.task_id === input.subject_task_id)) {
      issue(issues, "CHECKPOINT_SUBJECT_MISMATCH", "plan/checkpoints", "The checkpoint subject must resolve to a plan task.");
    }
  }
  for (const task of tasks) {
    const taskId = text(task.task_id);
    const artifactRef = `tasks/${taskId || "unknown"}`;
    const produced = strings(task.interface_contracts).map(parseInterfaceUse).filter((use) => use?.role === "producer");
    const consumers = tasks.filter((candidate) => candidate.task_id !== taskId && candidate.task_kind === "implementation" && (
      strings(candidate.dependencies).includes(taskId)
      || records(dag.nodes).some((node) => node.task_id === candidate.task_id && strings(node.depends_on).includes(taskId))
      || strings(candidate.interface_contracts).map(parseInterfaceUse).some((use) => use?.role === "consumer" && produced.some((producer) => producer?.interfaceId === use.interfaceId && producer.version === use.version))
    )).map((candidate) => text(candidate.task_id));
    const required = consumers.length > 0
      && (task.task_kind === "implementation" || task.repository_access === "write_scoped")
      && (task.risk_level === "high" && strings(task.critical_boundaries).length > 0 || consumers.length >= 2);
    const matching = inputs.filter((input) => input.subject_task_id === taskId);
    if (matching.length === 0) {
      if (required) issue(issues, "CHECKPOINT_POLICY_MISSING", artifactRef, "This producer requires a current independent checkpoint policy and result.", consumers);
      continue;
    }
    if (matching.length !== 1) {
      issue(issues, "CHECKPOINT_INPUT_DUPLICATE", artifactRef, "The checkpoint subject has ambiguous policy/result bindings.");
      continue;
    }
    const input = matching[0];
    if (!isRecord(input.bindings)) {
      issue(issues, "CHECKPOINT_BINDINGS_MISSING", artifactRef, "Current adoption, task, run, snapshot and reviewer facts are required.");
      continue;
    }
    const bindings = input.bindings as unknown as PlanCheckpointInput["bindings"];
    // A caller cannot submit a weaker task or a different graph as policy facts.
    const facts = isRecord(input.bindings.policy_facts) ? input.bindings.policy_facts : {};
    const factTasks = records(facts.tasks);
    const factDag = isRecord(facts.dag) ? facts.dag : {};
    const sameTasks = Array.isArray(facts.tasks) && factTasks.length === tasks.length
      && tasks.every((planTask) => {
        const matches = factTasks.filter((fact) => isRecord(fact.task) && fact.task.task_id === planTask.task_id);
        return matches.length === 1 && isDeepStrictEqual(matches[0].task, planTask);
      });
    const planNodes = records(dag.nodes);
    const factNodes = records(factDag.nodes);
    const sameDag = factDag.schema_version === dag.schema_version && factNodes.length === planNodes.length
      && planNodes.every((node) => {
        const matches = factNodes.filter((fact) => fact.task_id === node.task_id);
        return matches.length === 1 && isDeepStrictEqual(matches[0], node);
      });
    if (!sameTasks || !sameDag) {
      issue(issues, "CHECKPOINT_PLAN_FACTS_MISMATCH", artifactRef, "Authoritative checkpoint Task/DAG facts must match the submitted plan.");
      continue;
    }
    if (!isRecord(input.policy)) {
      issue(issues, "CHECKPOINT_POLICY_MISSING", artifactRef, "A current checkpoint policy is required.");
      continue;
    }
    if (input.policy.subject_task_id !== taskId) {
      issue(issues, "CHECKPOINT_SUBJECT_MISMATCH", artifactRef, "The policy subject does not match its plan task.");
      continue;
    }
    const policy = validateCheckpointPolicy(input.policy, bindings.policy_facts);
    if (!policy.valid) {
      issue(issues, "CHECKPOINT_POLICY_INVALID", artifactRef, policy.errors.join(" "));
      continue;
    }
    if (required && policy.value.disposition !== "required") {
      issue(issues, "CHECKPOINT_POLICY_REQUIRED", artifactRef, "A writable required subject cannot use a control exemption or not_required disposition.", consumers);
      continue;
    }
    if (policy.value.source_decision_id !== bindings.current_source_decision_id
      || policy.value.source_decision_digest !== bindings.current_source_decision_digest
      || policy.value.effective_at !== bindings.current_policy_effective_at) {
      issue(issues, "CHECKPOINT_POLICY_STALE", artifactRef, "The policy must bind the current adoption id, complete-file digest and effective time.");
    }
    if (required || policy.value.disposition === "required" || input.result !== undefined) {
      if (input.result === undefined || input.result === null) {
        issue(issues, "CHECKPOINT_RESULT_MISSING", artifactRef, "The required independent checkpoint has no current result.", consumers);
        continue;
      }
      const result = validateCheckpointResult(input.result, { ...bindings, policy: policy.value });
      if (!result.valid) issue(issues, "CHECKPOINT_RESULT_INVALID", artifactRef, result.errors.join(" "), consumers);
    }
  }
}

/**
 * Validate, but never author, schedule, execute, or persist, a Codex-authored
 * PlanBundle. The returned value depends only on the supplied value.
 */
export function validatePlanBundle(value: unknown, checkpointInputs?: readonly PlanCheckpointInput[]): PlanValidationResult {
  const issues: StableValidationIssue[] = [];
  const structural = validatePlanningArtifact("planBundle", value);
  if (!structural.valid) {
    for (const error of [...structural.errors].sort(compareText)) {
      issue(issues, "PLAN_SCHEMA_INVALID", "plan", error);
    }
  }

  const plan = isRecord(value) ? value : {};
  const architecture = isRecord(plan.architecture) ? plan.architecture : {};
  const registry = isRecord(plan.requirement_registry) ? plan.requirement_registry : {};
  const milestones = records(plan.milestones);
  const tasks = records(plan.tasks);
  const dag = isRecord(plan.dag) ? plan.dag : {};
  const dagNodes = records(dag.nodes);

  const planProjectId = text(plan.project_id);
  for (const [artifactRef, projectId] of [
    ["architecture", text(architecture.project_id)],
    ["requirement-registry", text(registry.project_id)],
  ] as const) {
    if (projectId && planProjectId && projectId !== planProjectId) {
      issue(issues, "PLAN_PROJECT_ID_MISMATCH", artifactRef, "Artifact project_id must match the PlanBundle project_id.", [planProjectId, projectId]);
    }
  }

  validateReferencesAndCoverage(issues, architecture, registry, milestones, tasks);
  reportDuplicateIds(issues, dagNodes, "task_id", "DUPLICATE_DAG_NODE", "dag/nodes");

  const taskIds = tasks.map((task) => text(task.task_id)).filter(Boolean);
  const taskIndex = indexBy(tasks, "task_id");
  const dagIndex = indexBy(dagNodes, "task_id");
  const taskIdSet = new Set(taskIds);
  const dependenciesByTask = new Map<string, string[]>();

  for (const task of tasks) {
    const taskId = text(task.task_id);
    const dependencies = strings(task.dependencies);
    dependenciesByTask.set(taskId, dependencies);
    reportDuplicateRefs(issues, dependencies, "DUPLICATE_TASK_DEPENDENCY", `tasks/${taskId || "unknown"}`);
    for (const dependency of dependencies) {
      if (dependency === taskId) issue(issues, "TASK_SELF_DEPENDENCY", `tasks/${taskId}`, "A task cannot depend on itself.", [taskId]);
      else if (!taskIdSet.has(dependency)) issue(issues, "TASK_DEPENDENCY_NOT_FOUND", `tasks/${taskId}`, "A task dependency does not resolve.", [dependency]);
    }
  }

  for (const node of dagNodes) {
    const taskId = text(node.task_id);
    const dependencies = strings(node.depends_on);
    reportDuplicateRefs(issues, dependencies, "DUPLICATE_DAG_DEPENDENCY", `dag/nodes/${taskId || "unknown"}`);
    if (!taskIndex.has(taskId)) issue(issues, "DAG_EXTRA_NODE", `dag/nodes/${taskId || "unknown"}`, "A DAG node does not resolve to a task.", [taskId]);
    for (const dependency of dependencies) {
      if (dependency === taskId) issue(issues, "DAG_SELF_DEPENDENCY", `dag/nodes/${taskId}`, "A DAG node cannot depend on itself.", [taskId]);
      else if (!taskIdSet.has(dependency)) issue(issues, "DAG_DEPENDENCY_NOT_FOUND", `dag/nodes/${taskId}`, "A DAG dependency does not resolve to a task.", [dependency]);
    }
  }

  for (const taskId of sortedUnique(taskIds)) {
    const node = dagIndex.get(taskId);
    if (!node) issue(issues, "DAG_TASK_NODE_MISSING", `tasks/${taskId}`, "Every task must have exactly one DAG node.", [taskId]);
    else if (!sameSet(strings(taskIndex.get(taskId)?.dependencies), strings(node.depends_on))) {
      issue(issues, "DAG_DEPENDENCIES_MISMATCH", `dag/nodes/${taskId}`, "DAG dependencies must exactly match the task contract dependencies.", [taskId]);
    }
  }

  const graph = buildTaskGraph(taskIds, dependenciesByTask);
  const cycles = alg.findCycles(graph) as string[][];
  for (const cycle of cycles.map((members: string[]) => sortedUnique(members)).sort((left: string[], right: string[]) => compareText(left.join("\u0000"), right.join("\u0000")))) {
    issue(issues, "TASK_DEPENDENCY_CYCLE", `tasks/${cycle[0] ?? "unknown"}`, "The task dependency graph contains a cycle.", cycle);
  }

  const milestoneIds = milestones.map((milestone) => text(milestone.milestone_id)).filter(Boolean);
  const milestoneDependencies = new Map(milestones.map((milestone) => [text(milestone.milestone_id), strings(milestone.dependencies)]));
  const milestoneGraph = buildTaskGraph(milestoneIds, milestoneDependencies);
  const milestoneCycles = alg.findCycles(milestoneGraph) as string[][];
  for (const cycle of milestoneCycles.map((members: string[]) => sortedUnique(members)).sort((left: string[], right: string[]) => compareText(left.join("\u0000"), right.join("\u0000")))) {
    issue(issues, "MILESTONE_DEPENDENCY_CYCLE", `milestones/${cycle[0] ?? "unknown"}`, "The milestone dependency graph contains a cycle.", cycle);
  }

  const reachability = stableReachability(graph);
  validateScopes(issues, tasks, reachability);
  validateInterfaces(issues, records(architecture.interfaces), records(architecture.components), tasks, reachability);
  validatePlanCheckpoints(issues, tasks, dag, checkpointInputs);

  const canonical = canonicalIssues(issues);
  return {
    valid: canonical.every((item) => item.severity !== "error"),
    issues: canonical,
    topological_order: stableTopologicalOrder(graph),
    reachability,
  };
}

export type { PlanBundle, PlanValidationResult, StableValidationIssue };
