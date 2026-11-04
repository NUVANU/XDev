import type { AcceptanceCriterion, DesignSeed, Milestone, OwnerGate, ProjectState, Requirement, RequirementRegistry, TaskContract } from "./types.ts";
import { createSchemaRegistry, formatSchemaErrors, type SchemaName } from "./schema-registry.ts";

type SchemaValueByName = {
  acceptanceCriterion: AcceptanceCriterion;
  requirement: Requirement;
  requirementRegistry: RequirementRegistry;
  milestone: Milestone;
  taskContract: TaskContract;
  ownerGate: OwnerGate;
  projectState: ProjectState;
  designSeed: DesignSeed;
};

export type ValidationResult<T> = { valid: true; value: T; errors: [] } | { valid: false; errors: string[] };
const registry = createSchemaRegistry();

export function validateProjectModel<TName extends SchemaName>(schemaName: TName, value: unknown): ValidationResult<SchemaValueByName[TName]> {
  const validator = registry[schemaName];
  if (validator(value)) return { valid: true, value: value as SchemaValueByName[TName], errors: [] };
  return { valid: false, errors: formatSchemaErrors(validator.errors) };
}
