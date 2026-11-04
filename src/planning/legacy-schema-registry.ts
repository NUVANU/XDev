import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import * as formatsPluginModule from "ajv-formats";

export const planningSchemaNames = ["architectureProposal", "planDag", "planBundle", "readinessResult"] as const;
export type PlanningSchemaName = (typeof planningSchemaNames)[number];
export const deliverySchemaNames = [
  "deliveryProfileDecision", "deliveryOutcome", "deliveryReport",
  "checkpointPolicy", "checkpointResult", "evidenceSnapshot", "closureManifest",
  "writeLease", "failureFingerprint", "retryBudget",
] as const;
export type DeliverySchemaName = (typeof deliverySchemaNames)[number];

const planningFiles: Record<PlanningSchemaName, string> = {
  architectureProposal: "architecture-proposal.schema.json",
  planDag: "plan-dag.schema.json",
  planBundle: "plan-bundle.schema.json",
  readinessResult: "readiness-result.schema.json",
};

const deliveryFiles: Record<DeliverySchemaName, string> = {
  deliveryProfileDecision: "delivery-profile-decision.schema.json",
  deliveryOutcome: "delivery-outcome.schema.json",
  deliveryReport: "delivery-report.schema.json",
  checkpointPolicy: "checkpoint-policy.schema.json",
  checkpointResult: "checkpoint-result.schema.json",
  evidenceSnapshot: "evidence-snapshot.schema.json",
  closureManifest: "closure-manifest.schema.json",
  writeLease: "write-lease.schema.json",
  failureFingerprint: "failure-fingerprint.schema.json",
  retryBudget: "retry-budget.schema.json",
};

type JsonSchema = Record<string, unknown>;

function readSchema(family: "planning" | "delivery" | "project-model", version: string, fileName: string): JsonSchema {
  return JSON.parse(readFileSync(new URL(`../../schemas/${family}/${version}/${fileName}`, import.meta.url), "utf8")) as JsonSchema;
}

export function createPlanningSchemaRegistry(): {
  planning: Record<PlanningSchemaName, ValidateFunction>;
  delivery: Record<DeliverySchemaName, ValidateFunction>;
} {
  const ajv = new Ajv2020({ allErrors: true, coerceTypes: false, removeAdditional: false, strict: true, useDefaults: false });
  const addFormats = (formatsPluginModule as unknown as { default: (validator: Ajv2020) => void }).default;
  addFormats(ajv);

  ajv.addSchema(readSchema("project-model", "0.2", "common.schema.json"));
  for (const fileName of ["acceptance-criterion.schema.json", "requirement.schema.json", "requirement-registry.schema.json", "milestone.schema.json", "task-contract.schema.json"]) {
    ajv.addSchema(readSchema("project-model", "0.2", fileName));
  }
  ajv.addSchema(readSchema("delivery", "0.1", "common.schema.json"));
  for (const fileName of Object.values(deliveryFiles)) ajv.addSchema(readSchema("delivery", "0.1", fileName));
  ajv.addSchema(readSchema("planning", "0.1", "common.schema.json"));
  for (const fileName of Object.values(planningFiles)) ajv.addSchema(readSchema("planning", "0.1", fileName));

  const resolve = <TName extends string>(family: "planning" | "delivery", version: string, files: Record<TName, string>, names: readonly TName[]): Record<TName, ValidateFunction> => Object.fromEntries(names.map((name) => {
    const validator = ajv.getSchema(`https://xdev.local/schemas/${family}/${version}/${files[name]}`);
    if (!validator) throw new Error(`Schema registry could not load ${family} ${version} ${name}.`);
    return [name, validator];
  })) as Record<TName, ValidateFunction>;

  return {
    planning: resolve("planning", "0.1", planningFiles, planningSchemaNames),
    delivery: resolve("delivery", "0.1", deliveryFiles, deliverySchemaNames),
  };
}
