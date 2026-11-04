import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as formatsPluginModule from "ajv-formats";

export const schemaNames = [
  "acceptanceCriterion", "requirement", "requirementRegistry", "milestone",
  "taskContract", "ownerGate", "projectState", "designSeed",
] as const;
export type SchemaName = (typeof schemaNames)[number];
export const projectModelSchemaNamesV02 = [
  "acceptanceCriterion", "requirement", "requirementRegistry", "milestone",
  "taskContract", "ownerGate", "projectState", "projectModelBundle", "projectModelContainer",
] as const;
export type ProjectModelSchemaNameV02 = (typeof projectModelSchemaNamesV02)[number];
type JsonSchema = Record<string, unknown>;

const schemaFiles: Record<SchemaName, string> = {
  acceptanceCriterion: "acceptance-criterion.schema.json",
  requirement: "requirement.schema.json",
  requirementRegistry: "requirement-registry.schema.json",
  milestone: "milestone.schema.json",
  taskContract: "task-contract.schema.json",
  ownerGate: "owner-gate.schema.json",
  projectState: "project-state.schema.json",
  designSeed: "design-seed.schema.json",
};

const schemaFilesV02: Record<ProjectModelSchemaNameV02, string> = {
  acceptanceCriterion: "acceptance-criterion.schema.json",
  requirement: "requirement.schema.json",
  requirementRegistry: "requirement-registry.schema.json",
  milestone: "milestone.schema.json",
  taskContract: "task-contract.schema.json",
  ownerGate: "owner-gate.schema.json",
  projectState: "project-state.schema.json",
  projectModelBundle: "project-model-bundle.schema.json",
  projectModelContainer: "project-model-container.schema.json",
};

function readSchema(fileName: string): JsonSchema {
  return JSON.parse(readFileSync(new URL(`../../schemas/project-model/0.1/${fileName}`, import.meta.url), "utf8")) as JsonSchema;
}

function readVersionedSchema(family: "project-model" | "delivery", version: string, fileName: string): JsonSchema {
  return JSON.parse(readFileSync(new URL(`../../schemas/${family}/${version}/${fileName}`, import.meta.url), "utf8")) as JsonSchema;
}

export function createSchemaRegistry(): Record<SchemaName, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, coerceTypes: false, removeAdditional: false, strict: true, useDefaults: false });
  const addFormats = (formatsPluginModule as unknown as { default: (validator: Ajv2020) => void }).default;
  addFormats(ajv);
  ajv.addSchema(readSchema("common.schema.json"));
  for (const name of schemaNames) ajv.addSchema(readSchema(schemaFiles[name]));
  return Object.fromEntries(schemaNames.map((name) => {
    const validator = ajv.getSchema(`https://xdev.local/schemas/project-model/0.1/${schemaFiles[name]}`);
    if (!validator) throw new Error(`Schema registry could not load ${name}.`);
    return [name, validator];
  })) as Record<SchemaName, ValidateFunction>;
}

export type VersionedProjectModelSchemaRegistry = {
  "0.1": Record<SchemaName, ValidateFunction>;
  "0.2": Record<ProjectModelSchemaNameV02, ValidateFunction>;
};

export function createVersionedProjectModelSchemaRegistry(): VersionedProjectModelSchemaRegistry {
  const ajv = new Ajv2020({ allErrors: true, coerceTypes: false, removeAdditional: false, strict: true, useDefaults: false });
  const addFormats = (formatsPluginModule as unknown as { default: (validator: Ajv2020) => void }).default;
  addFormats(ajv);

  ajv.addSchema(readVersionedSchema("project-model", "0.1", "common.schema.json"));
  for (const name of schemaNames) ajv.addSchema(readVersionedSchema("project-model", "0.1", schemaFiles[name]));

  ajv.addSchema(readVersionedSchema("delivery", "0.1", "common.schema.json"));
  for (const fileName of [
    "delivery-profile-decision.schema.json", "delivery-outcome.schema.json", "delivery-report.schema.json",
    "checkpoint-policy.schema.json", "checkpoint-result.schema.json", "evidence-snapshot.schema.json",
    "closure-manifest.schema.json", "write-lease.schema.json", "failure-fingerprint.schema.json", "retry-budget.schema.json",
  ]) {
    ajv.addSchema(readVersionedSchema("delivery", "0.1", fileName));
  }

  ajv.addSchema(readVersionedSchema("project-model", "0.2", "common.schema.json"));
  for (const name of projectModelSchemaNamesV02) ajv.addSchema(readVersionedSchema("project-model", "0.2", schemaFilesV02[name]));

  const resolve = <TName extends string>(version: "0.1" | "0.2", files: Record<TName, string>, names: readonly TName[]): Record<TName, ValidateFunction> => Object.fromEntries(names.map((name) => {
    const validator = ajv.getSchema(`https://xdev.local/schemas/project-model/${version}/${files[name]}`);
    if (!validator) throw new Error(`Schema registry could not load project-model ${version} ${name}.`);
    return [name, validator];
  })) as Record<TName, ValidateFunction>;

  return {
    "0.1": resolve("0.1", schemaFiles, schemaNames),
    "0.2": resolve("0.2", schemaFilesV02, projectModelSchemaNamesV02),
  };
}

export function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const field = typeof error.params.additionalProperty === "string" ? error.params.additionalProperty
      : typeof error.params.propertyName === "string" ? error.params.propertyName
      : typeof error.params.missingProperty === "string" ? error.params.missingProperty
      : error.instancePath || "<root>";
    return `${field}: ${error.message ?? error.keyword}`;
  });
}
