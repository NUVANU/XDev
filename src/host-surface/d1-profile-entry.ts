import { createHash } from "node:crypto";
import { canonical } from "../job-runtime/storage-identity.ts";

export type D1Profile = "prototype" | "quick_verified" | "full_governance";
export type D1ProfileRequest = {
  format: "xdev-d1-profile-request-1";
  request_id: string;
  project_id: string;
  receipt_sha256: string;
  purpose: "explore" | "formal_change" | "formal_release";
  goal: string;
  purpose_source: { kind: "COORDINATOR_RECORDED"; source_ref: string; source_sha256: string };
  requested_profile: D1Profile;
  impact: "isolated_fake_data" | "ordinary" | "real_high_impact" | "unknown";
  facts: { fake_data_only: boolean; production_permissions: boolean; external_effects: boolean; reversible: boolean;
    evidence_refs: Array<{ path: string; sha256: string }> };
  risk_categories: string[];
  risk_reason: string;
  complexity: { cross_module: boolean; interface_change: boolean; untested_path: boolean; reason: string };
  legacy_flow_difference_reason: string | null;
};
export type D1Gate = { requirement: string; status: "NOT_RUN" };
export type D1ProfileDecision = {
  format: "xdev-d1-profile-decision-1";
  request_sha256: string;
  purpose: D1ProfileRequest["purpose"];
  goal: string;
  impact: D1ProfileRequest["impact"];
  selected_profile: D1Profile;
  minimum_profile: D1Profile;
  reason: string;
  test_depth: string[];
  gates: D1Gate[];
  gates_sha256: string;
  execution_protocol: "PROFILE_ONLY_NOT_EXECUTABLE";
};
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function need(ok: unknown, code: string): asserts ok { if (!ok) throw Error(code); }
function exact(v: unknown, names: string[], code: string): asserts v is Record<string, unknown> {
  need(!!v && typeof v === "object" && !Array.isArray(v) &&
    Object.keys(v).sort().join("|") === [...names].sort().join("|"), code);
}
const word = (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.length <= 8192;
const hex = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const rank: Record<D1Profile, number> = { prototype: 0, quick_verified: 1, full_governance: 2 };

/** Pure D1 entry policy. Complexity changes test depth, never the profile floor. */
export function decideD1Profile(raw: unknown, requestSha: string, receiptSha: string,
  projectId: string, legacyFlow: string, criteria: string[]): D1ProfileDecision {
  exact(raw, ["format", "request_id", "project_id", "receipt_sha256", "purpose", "goal",
    "purpose_source", "requested_profile", "impact", "facts", "risk_categories", "risk_reason",
    "complexity", "legacy_flow_difference_reason"], "D1_PROFILE_SCHEMA_INVALID");
  const r = raw as D1ProfileRequest;
  need(r.format === "xdev-d1-profile-request-1" && /^[0-9a-f-]{36}$/.test(r.request_id)
    && r.project_id === projectId && r.receipt_sha256 === receiptSha && word(r.goal)
    && ["explore", "formal_change", "formal_release"].includes(r.purpose)
    && ["prototype", "quick_verified", "full_governance"].includes(r.requested_profile)
    && ["isolated_fake_data", "ordinary", "real_high_impact", "unknown"].includes(r.impact)
    && word(r.risk_reason), "D1_PROFILE_INVALID");
  exact(r.purpose_source, ["kind", "source_ref", "source_sha256"], "D1_PROFILE_SOURCE_INVALID");
  need(r.purpose_source.kind === "COORDINATOR_RECORDED" && word(r.purpose_source.source_ref)
    && hex(r.purpose_source.source_sha256), "D1_PROFILE_SOURCE_INVALID");
  exact(r.facts, ["fake_data_only", "production_permissions", "external_effects", "reversible", "evidence_refs"], "D1_PROFILE_FACTS_INVALID");
  need([r.facts.fake_data_only, r.facts.production_permissions, r.facts.external_effects, r.facts.reversible]
    .every(v => typeof v === "boolean") && Array.isArray(r.facts.evidence_refs)
    && r.facts.evidence_refs.length > 0 && r.facts.evidence_refs.length <= 8,
    "D1_PROFILE_FACTS_UNKNOWN");
  for (const ref of r.facts.evidence_refs) {
    exact(ref, ["path", "sha256"], "D1_PROFILE_EVIDENCE_INVALID");
    need(word(ref.path) && hex(ref.sha256), "D1_PROFILE_EVIDENCE_INVALID");
  }
  need(new Set(r.facts.evidence_refs.map(v => v.path)).size === r.facts.evidence_refs.length,
    "D1_PROFILE_EVIDENCE_DUPLICATE");
  exact(r.complexity, ["cross_module", "interface_change", "untested_path", "reason"], "D1_PROFILE_COMPLEXITY_INVALID");
  need([r.complexity.cross_module, r.complexity.interface_change, r.complexity.untested_path]
    .every(v => typeof v === "boolean") && word(r.complexity.reason)
    && Array.isArray(r.risk_categories) && r.risk_categories.length > 0
    && r.risk_categories.every(word) && new Set(r.risk_categories).size === r.risk_categories.length,
    "D1_PROFILE_RISK_UNKNOWN");
  need(r.impact !== "unknown", "D1_PROFILE_RISK_UNKNOWN");
  need(!(r.facts.production_permissions || r.facts.external_effects) || r.impact === "real_high_impact",
    "D1_PROFILE_IMPACT_UNDERSTATED");
  need(r.impact !== "isolated_fake_data" || r.facts.fake_data_only && !r.facts.production_permissions
    && !r.facts.external_effects && r.facts.reversible, "D1_PROFILE_ISOLATION_UNPROVEN");
  need(r.impact !== "ordinary" || !r.facts.fake_data_only && !r.facts.production_permissions
    && !r.facts.external_effects, "D1_PROFILE_IMPACT_INCONSISTENT");
  const minimum: D1Profile = r.purpose === "formal_release" || r.impact === "real_high_impact"
    ? "full_governance" : r.purpose === "explore" && r.impact === "isolated_fake_data"
      ? "prototype" : "quick_verified";
  need(rank[r.requested_profile] >= rank[minimum], "D1_PROFILE_BELOW_RISK_FLOOR");
  need(r.requested_profile !== "prototype" || minimum === "prototype", "D1_PROFILE_PROTOTYPE_SCOPE_INVALID");
  need(r.legacy_flow_difference_reason === null || word(r.legacy_flow_difference_reason), "D1_PROFILE_LEGACY_REASON_INVALID");
  if (legacyFlow === "full_governance" && r.requested_profile !== "full_governance")
    need(word(r.legacy_flow_difference_reason), "D1_PROFILE_LEGACY_DIFFERENCE_UNEXPLAINED");
  const testDepth = ["acceptance-criteria", "risk-check", "workspace-and-environment",
    "actual-test-results", "applicable-integration-rerun", "specification-check"];
  if (r.complexity.cross_module) testDepth.push("cross-module-integration");
  if (r.complexity.interface_change) testDepth.push("interface-contract-and-consumer");
  if (r.complexity.untested_path) testDepth.push("previously-untested-path");
  const required = [...testDepth, ...criteria.map(id => `criterion:${id}`)];
  if (r.requested_profile !== "prototype") required.push("independent-review", "independent-qa");
  if (r.requested_profile === "full_governance") required.push("separate-author-reviewer-qa");
  const gates = [...new Set(required)].map(requirement => ({ requirement, status: "NOT_RUN" as const }));
  return { format: "xdev-d1-profile-decision-1", request_sha256: requestSha,
    purpose: r.purpose, goal: r.goal, impact: r.impact, selected_profile: r.requested_profile,
    minimum_profile: minimum, reason: r.risk_reason, test_depth: testDepth,
    gates, gates_sha256: hash(gates), execution_protocol: "PROFILE_ONLY_NOT_EXECUTABLE" };
}

export function validateD1ProfileDecision(value: unknown): asserts value is D1ProfileDecision {
  exact(value, ["format", "request_sha256", "purpose", "goal", "impact", "selected_profile",
    "minimum_profile", "reason", "test_depth", "gates", "gates_sha256", "execution_protocol"], "D1_PROFILE_DECISION_INVALID");
  const v = value as D1ProfileDecision;
  need(v.format === "xdev-d1-profile-decision-1" && hex(v.request_sha256) && hex(v.gates_sha256)
    && v.gates_sha256 === hash(v.gates) && v.execution_protocol === "PROFILE_ONLY_NOT_EXECUTABLE"
    && Array.isArray(v.gates) && v.gates.length > 0 && v.gates.every(g => {
      exact(g, ["requirement", "status"], "D1_PROFILE_GATE_INVALID");
      return word(g.requirement) && g.status === "NOT_RUN";
    }) && new Set(v.gates.map(g => g.requirement)).size === v.gates.length,
    "D1_PROFILE_DECISION_INVALID");
}
