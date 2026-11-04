import type { ValidateFunction } from "ajv";
import {
  createVersionedProjectModelSchemaRegistry,
  type ProjectModelSchemaNameV02,
  type SchemaName,
} from "./schema-registry.ts";
import type {
  AcceptanceCriterion,
  AcceptanceCriterionV02,
  DesignSeed,
  Milestone,
  MilestoneV02,
  OwnerGate,
  OwnerGateV02,
  ProjectModelBundleV02,
  ProjectModelContainerV02,
  ProjectState,
  ProjectStateV02,
  Requirement,
  RequirementRegistry,
  RequirementRegistryV02,
  RequirementV02,
  TaskContract,
  TaskContractV02,
} from "./types.ts";
import { formatSchemaErrors } from "./schema-registry.ts";
import type { ValidationResult } from "./validate.ts";
import { projectModelBundleDeliveryInvariantErrors } from "../planning/validate.ts";

type ProjectModelV01ByName = {
  acceptanceCriterion: AcceptanceCriterion;
  requirement: Requirement;
  requirementRegistry: RequirementRegistry;
  milestone: Milestone;
  taskContract: TaskContract;
  ownerGate: OwnerGate;
  projectState: ProjectState;
  designSeed: DesignSeed;
};

type ProjectModelV02ByName = {
  acceptanceCriterion: AcceptanceCriterionV02;
  requirement: RequirementV02;
  requirementRegistry: RequirementRegistryV02;
  milestone: MilestoneV02;
  taskContract: TaskContractV02;
  ownerGate: OwnerGateV02;
  projectState: ProjectStateV02;
  projectModelBundle: ProjectModelBundleV02;
  projectModelContainer: ProjectModelContainerV02;
};

export type VersionedProjectModelReadResult =
  | { valid: true; schemaVersion: "0.1"; value: ProjectModelV01ByName[SchemaName]; errors: [] }
  | { valid: true; schemaVersion: "0.2"; value: ProjectModelV02ByName[ProjectModelSchemaNameV02]; errors: [] }
  | { valid: false; errors: string[] };

export type CompatibilityProjection = {
  source_schema_version: "0.1";
  source_flow_type: "quick" | "full_governance";
  compatible_effective_profile: "quick_verified" | "full_governance";
  source: "legacy_flow";
  profile_decision_present: false;
};

export interface VersionedProjectModelReader {
  read(schemaName: SchemaName | ProjectModelSchemaNameV02, value: unknown): VersionedProjectModelReadResult;
  projectLegacyCompatibility(value: unknown): ValidationResult<CompatibilityProjection>;
}

const registry = createVersionedProjectModelSchemaRegistry();

function objectSchemaVersion(value: unknown): unknown {
  return typeof value === "object" && value !== null && "schema_version" in value
    ? (value as { schema_version?: unknown }).schema_version
    : undefined;
}

export function readVersionedProjectModel(
  schemaName: SchemaName | ProjectModelSchemaNameV02,
  value: unknown,
): VersionedProjectModelReadResult {
  const version = objectSchemaVersion(value);
  if (version !== "0.1" && version !== "0.2") {
    return { valid: false, errors: [`schema_version: unsupported project-model version ${JSON.stringify(version)}.`] };
  }

  const validators = registry[version] as Partial<Record<string, ValidateFunction>>;
  const validator = validators[schemaName];
  if (!validator) return { valid: false, errors: [`${schemaName}: is not defined for project-model ${version}.`] };
  if (!validator(value)) return { valid: false, errors: formatSchemaErrors(validator.errors) };

  if (version === "0.2") {
    const bundle = schemaName === "projectModelBundle"
      ? value as ProjectModelBundleV02
      : schemaName === "projectModelContainer"
        && (value as ProjectModelContainerV02).artifact_kind === "project_model_bundle"
        ? (value as Extract<ProjectModelContainerV02, { artifact_kind: "project_model_bundle" }>).artifact
        : undefined;
    if (bundle) {
      const errors = projectModelBundleDeliveryInvariantErrors(bundle);
      if (errors.length > 0) return { valid: false, errors };
    }
  }

  return version === "0.1"
    ? { valid: true, schemaVersion: version, value: value as ProjectModelV01ByName[SchemaName], errors: [] }
    : { valid: true, schemaVersion: version, value: value as ProjectModelV02ByName[ProjectModelSchemaNameV02], errors: [] };
}

export function projectLegacyCompatibility(value: unknown): ValidationResult<CompatibilityProjection> {
  const read = readVersionedProjectModel("projectState", value);
  if (!read.valid) return read;
  if (read.schemaVersion !== "0.1") return { valid: false, errors: ["schema_version: compatibility projection accepts only legacy project-model 0.1."] };
  const state = read.value as ProjectState;
  return {
    valid: true,
    value: {
      source_schema_version: "0.1",
      source_flow_type: state.flow.type,
      compatible_effective_profile: state.flow.type === "quick" ? "quick_verified" : "full_governance",
      source: "legacy_flow",
      profile_decision_present: false,
    },
    errors: [],
  };
}

export function legacyFlowAlias(profile: "prototype" | "quick_verified" | "full_governance"): "quick" | "full_governance" | null {
  if (profile === "prototype") return null;
  return profile === "quick_verified" ? "quick" : "full_governance";
}

export const versionedProjectModelReader: VersionedProjectModelReader = Object.freeze({
  read: readVersionedProjectModel,
  projectLegacyCompatibility,
});
