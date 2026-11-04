import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { canonical } from './storage-identity.ts';
import { jobId, UUID } from './state.ts';
import { validateD1ProfileDecision, type D1ProfileDecision } from '../host-surface/d1-profile-entry.ts';

/** B1 is an assessment-only core. No value returned here is a verification receipt. */
export const qualityHash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const qualityBytesHash = (value: string) => createHash('sha256').update(value).digest('hex');
export type QualitySubject = {
  project_id: string; physical_root_identity: string; control_root: string; job_id: string; task_id: string;
  create_sha256: string; contract_sha256: string; profile_sha256: string; criteria_sha256: string;
  attempt_id: string; attempt: 1 | 2; attempt_anchor_sha256: string; worker_run_id: string;
  authors: { agent_id: string; run_id: string }[]; workspace_id: string; cwd: string; head: string;
  candidate_sha256: string; environment_sha256: string; integration_target_sha256: string;
};
export type QualityEvidence = {
  format: 'xdev-d1-quality-observation-test-1'; kind: 'history' | 'integration-facts' | 'worker' | 'review' | 'qa' | 'integration';
  source_kind: 'TEST_ONLY_HOST_LOG'; evidence_id: string; session_id: string; call_id: string;
  agent_id: string; run_id: string; role: 'observer' | 'worker' | 'reviewer' | 'qa';
  actual_model: string | null; actual_effort: string | null; subject_sha256: string;
  started_at: string; ended_at: string; observed_at: string; expires_at: string;
  coverage: string[]; raw_text: string; raw_sha256: string; metadata_sha256: string;
};
export type QualityTestInput = {
  format: 'xdev-d1-quality-test-input-1'; claim: 'ASSESSMENT_ONLY'; now: string;
  subject: QualitySubject; profile: D1ProfileDecision; criteria: string[]; evidence: QualityEvidence[];
};
export type QualityGate = { requirement: string; status: 'NOT_RUN' | 'REJECTED' | 'SATISFIED_TEST_ONLY'; reasons: string[] };
export type QualityAssessment = {
  scope: 'TEST_ONLY'; decision: 'TEST_ONLY_REQUIREMENTS_SATISFIED' | 'TEST_ONLY_REJECTED' | 'TEST_ONLY_INCOMPLETE' | 'PROTOTYPE_UNVERIFIED';
  evidence_status: 'SATISFIED_TEST_ONLY' | 'REJECTED' | 'INCOMPLETE';
  production_verification: false; delivery_claim_allowed: false; reasons: string[]; gates: QualityGate[];
};
const common = ['acceptance-criteria', 'risk-check', 'workspace-and-environment', 'actual-test-results',
  'applicable-integration-rerun', 'specification-check'];
const independent = ['independent-review', 'independent-qa', 'separate-author-reviewer-qa'];
const complexityChecks = ['cross-module-integration', 'interface-contract-and-consumer', 'previously-untested-path'];
const profiles = ['prototype', 'quick_verified', 'full_governance'];
function need(ok: unknown, reason: string): asserts ok { if (!ok) throw Error(reason); }
function exact(value: unknown, keys: string[], reason = 'QUALITY_SCHEMA_INVALID'): asserts value is Record<string, any> {
  need(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join('|') === [...keys].sort().join('|'), reason);
}
const word = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 8192;
const hex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
function words(v: unknown, limit = 64): asserts v is string[] {
  need(Array.isArray(v) && v.length <= limit && v.every(word) && new Set(v).size === v.length, 'QUALITY_LIST_INVALID');
}
function date(v: unknown): number {
  need(typeof v === 'string' && v.length === 24 && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v,
    'QUALITY_TIME_INVALID');
  return Date.parse(v);
}
function validateQualityProfile(profile: unknown, criteria: string[]): asserts profile is D1ProfileDecision {
  exact(profile, ['format', 'request_sha256', 'purpose', 'goal', 'impact', 'selected_profile',
    'minimum_profile', 'reason', 'test_depth', 'gates', 'gates_sha256', 'execution_protocol']);
  need(profile.format === 'xdev-d1-profile-decision-1' && profile.execution_protocol === 'PROFILE_ONLY_NOT_EXECUTABLE' &&
    hex(profile.request_sha256) && hex(profile.gates_sha256), 'QUALITY_PROFILE_INVALID');
  need(['explore', 'formal_change', 'formal_release'].includes(profile.purpose) &&
    ['isolated_fake_data', 'ordinary', 'real_high_impact'].includes(profile.impact) &&
    word(profile.goal) && word(profile.reason) && profiles.includes(profile.selected_profile) &&
    profiles.includes(profile.minimum_profile), 'QUALITY_PROFILE_INVALID');
  const minimum = profile.purpose === 'formal_release' || profile.impact === 'real_high_impact' ? 'full_governance'
    : profile.purpose === 'explore' && profile.impact === 'isolated_fake_data' ? 'prototype' : 'quick_verified';
  need(profile.minimum_profile === minimum && profiles.indexOf(profile.selected_profile) >= profiles.indexOf(minimum),
    'QUALITY_PROFILE_POLICY_CONFLICT');
  words(profile.test_depth);
  need(common.every(c => profile.test_depth.includes(c)) &&
    profile.test_depth.every(c => [...common, ...complexityChecks].includes(c)), 'QUALITY_PROFILE_DEPTH_CONFLICT');
  need(Array.isArray(profile.gates) && profile.gates.length > 0 && profile.gates.length <= 64, 'QUALITY_REQUIREMENTS_LIMIT');
  for (const gate of profile.gates) {
    exact(gate, ['requirement', 'status']);
    need(word(gate.requirement) && gate.status === 'NOT_RUN', 'QUALITY_PROFILE_GATE_INVALID');
  }
  const declared = profile.gates.map(g => g.requirement);
  const applicable = profile.selected_profile === 'prototype' ? []
    : profile.selected_profile === 'quick_verified' ? independent.slice(0, 2) : independent;
  const expected = [...profile.test_depth, ...criteria.map(c => `criterion:${c}`), ...applicable];
  need(new Set(declared).size === declared.length && declared.length === expected.length &&
    expected.every(c => declared.includes(c)), 'QUALITY_PROFILE_GATE_CONFLICT');
  // Every field and child is bounded/validated before the legacy validator hashes gates.
  validateD1ProfileDecision(profile);
}
export function qualityRequirements(profile: D1ProfileDecision, criteria: string[]): string[] {
  words(criteria); need(criteria.length > 0, 'QUALITY_CRITERIA_MISSING');
  validateQualityProfile(profile, criteria);
  const result = profile.gates.map(g => g.requirement);
  need(result.length <= 64, 'QUALITY_REQUIREMENTS_LIMIT');
  return result;
}
export function notRunQualityGates(requirements: string[], reason: string): QualityGate[] {
  return requirements.map(requirement => ({ requirement, status: 'NOT_RUN', reasons: [reason] }));
}
function validateSubject(s: unknown): asserts s is QualitySubject {
  exact(s, ['project_id', 'physical_root_identity', 'control_root', 'job_id', 'task_id', 'create_sha256',
    'contract_sha256', 'profile_sha256', 'criteria_sha256', 'attempt_id', 'attempt', 'attempt_anchor_sha256',
    'worker_run_id', 'authors', 'workspace_id', 'cwd', 'head', 'candidate_sha256', 'environment_sha256', 'integration_target_sha256']);
  for (const k of ['project_id', 'physical_root_identity', 'job_id', 'task_id', 'attempt_id', 'worker_run_id', 'workspace_id', 'head'])
    need(word(s[k]), 'QUALITY_SUBJECT_INVALID');
  jobId(s.job_id);
  need(new RegExp(`^task:${s.job_id.slice(4)}:${UUID}$`).test(s.task_id), 'QUALITY_JOB_TASK_MISMATCH');
  for (const k of ['create_sha256', 'contract_sha256', 'profile_sha256', 'criteria_sha256', 'attempt_anchor_sha256',
    'candidate_sha256', 'environment_sha256', 'integration_target_sha256']) need(hex(s[k]), 'QUALITY_BINDING_INVALID');
  for (const k of ['control_root', 'cwd']) need(word(s[k]) && isAbsolute(s[k]) && resolve(s[k]) === s[k], 'QUALITY_WORKSPACE_INVALID');
  need(s.attempt === 1 || s.attempt === 2, 'QUALITY_ATTEMPT_LIMIT');
  need(Array.isArray(s.authors) && s.authors.length > 0 && s.authors.length <= 16, 'QUALITY_AUTHORS_MISSING');
  for (const a of s.authors) { exact(a, ['agent_id', 'run_id']); need(word(a.agent_id) && word(a.run_id), 'QUALITY_AUTHOR_INVALID'); }
  need(s.authors.some(a => a.run_id === s.worker_run_id) && new Set(s.authors.map(a => a.run_id)).size === s.authors.length,
    'QUALITY_AUTHOR_BINDING');
}
type Parsed = { observation: QualityEvidence; body: Record<string, any> };
function parseEvidence(e: unknown, input: QualityTestInput, requirements: string[]): Parsed {
  exact(e, ['format', 'kind', 'source_kind', 'evidence_id', 'session_id', 'call_id', 'agent_id', 'run_id', 'role',
    'actual_model', 'actual_effort', 'subject_sha256', 'started_at', 'ended_at', 'observed_at', 'expires_at', 'coverage', 'raw_text', 'raw_sha256', 'metadata_sha256']);
  need(e.format === 'xdev-d1-quality-observation-test-1' && e.source_kind === 'TEST_ONLY_HOST_LOG', 'QUALITY_SOURCE_UNSUPPORTED');
  need(['history', 'integration-facts', 'worker', 'review', 'qa', 'integration'].includes(e.kind), 'QUALITY_KIND_INVALID');
  const role = e.kind === 'worker' ? 'worker' : e.kind === 'review' ? 'reviewer' : ['qa', 'integration'].includes(e.kind) ? 'qa' : 'observer';
  const authorSelfCheck = input.profile.selected_profile === 'prototype' && ['qa', 'integration'].includes(e.kind) &&
    input.subject.authors.some(a => a.agent_id === e.agent_id && a.run_id === e.run_id);
  need(e.role === role || authorSelfCheck && e.role === 'worker', 'QUALITY_ROLE_MISMATCH');
  for (const k of ['evidence_id', 'session_id', 'call_id', 'agent_id', 'run_id']) need(word(e[k]), 'QUALITY_IDENTITY_MISSING');
  need((e.actual_model === null || word(e.actual_model)) && (e.actual_effort === null || word(e.actual_effort)), 'QUALITY_MODEL_INVALID');
  need(hex(e.subject_sha256) && e.subject_sha256 === qualityHash(input.subject), 'QUALITY_SUBJECT_DRIFT');
  const started = date(e.started_at), ended = date(e.ended_at), observed = date(e.observed_at), expiry = date(e.expires_at), now = date(input.now);
  need(started <= ended && ended <= observed && observed <= now && now < expiry, 'QUALITY_STALE_OR_FUTURE');
  words(e.coverage); need(e.coverage.every(c => requirements.includes(c)), 'QUALITY_UNKNOWN_COVERAGE');
  need(typeof e.raw_text === 'string' && Buffer.byteLength(e.raw_text) <= 160 * 1024 && hex(e.raw_sha256) &&
    qualityBytesHash(e.raw_text) === e.raw_sha256, 'QUALITY_RAW_OUTPUT_MISSING_OR_DRIFT');
  const { metadata_sha256, raw_text, ...metadata } = e;
  need(hex(metadata_sha256) && metadata_sha256 === qualityHash(metadata), 'QUALITY_METADATA_DRIFT');
  let body: unknown; try { body = JSON.parse(e.raw_text); } catch { throw Error('QUALITY_RAW_SCHEMA_INVALID'); }
  need(body && typeof body === 'object' && !Array.isArray(body) && canonical(body) === e.raw_text, 'QUALITY_RAW_NOT_CANONICAL');
  return { observation: e as QualityEvidence, body: body as Record<string, any> };
}
function checkExecution(p: Parsed, s: QualitySubject) {
  const b = p.body;
  exact(b, ['argv', 'cwd', 'exit_code', 'stdout', 'stderr', 'stdout_sha256', 'stderr_sha256',
    'candidate_before_sha256', 'candidate_after_sha256', 'environment_sha256', 'untested_items']);
  need(Array.isArray(b.argv) && b.argv.length > 0 && b.argv.length <= 64 && b.argv.every(word), 'QUALITY_COMMAND_MISSING');
  need(b.cwd === s.cwd, 'QUALITY_CWD_DRIFT');
  need(Number.isInteger(b.exit_code) && b.exit_code === 0, 'QUALITY_EXECUTION_FAILED');
  for (const k of ['stdout', 'stderr']) need(typeof b[k] === 'string' && Buffer.byteLength(b[k]) <= 64 * 1024 &&
    hex(b[`${k}_sha256`]) && qualityBytesHash(b[k]) === b[`${k}_sha256`], 'QUALITY_RAW_OUTPUT_MISSING_OR_DRIFT');
  need(b.candidate_before_sha256 === s.candidate_sha256 && b.candidate_after_sha256 === s.candidate_sha256 &&
    b.environment_sha256 === s.environment_sha256, 'QUALITY_CODE_OR_ENVIRONMENT_DRIFT');
  words(b.untested_items);
}
function checkHistory(b: Record<string, any>, s: QualitySubject) {
  exact(b, ['coverage', 'previous_attempts', 'repair_authorization_sha256', 'unresolved_holds']);
  need(b.coverage === 'COMPLETE', 'QUALITY_HISTORY_UNKNOWN'); words(b.unresolved_holds);
  need(b.unresolved_holds.length === 0, 'QUALITY_HOLD_UNRESOLVED');
  need(Array.isArray(b.previous_attempts) && b.previous_attempts.length === s.attempt - 1, 'QUALITY_ATTEMPT_HISTORY_GAP');
  if (s.attempt === 1) { need(b.repair_authorization_sha256 === null, 'QUALITY_UNEXPECTED_REPAIR'); return; }
  need(hex(b.repair_authorization_sha256), 'QUALITY_REPAIR_NOT_AUTHORIZED');
  const previous = b.previous_attempts[0];
  exact(previous, ['ordinal', 'attempt_id', 'job_id', 'task_id', 'state', 'writers_stopped',
    'failure_sha256', 'consumption_sha256', 'hold_resolution_sha256']);
  need(previous.ordinal === 1 && word(previous.attempt_id) && previous.attempt_id !== s.attempt_id &&
    previous.job_id === s.job_id && previous.task_id === s.task_id, 'QUALITY_ATTEMPT_HISTORY_GAP');
  need(['FAILED', 'REJECTED'].includes(previous.state) && previous.writers_stopped === true,
    'QUALITY_PREVIOUS_ATTEMPT_UNSETTLED');
  need([previous.failure_sha256, previous.consumption_sha256, previous.hold_resolution_sha256].every(hex), 'QUALITY_HISTORY_REFERENCES_MISSING');
}

/** Inputs describe synthetic Host observations only. Labels/digests do not authenticate a Host. */
export function assessD1QualityTestOnly(raw: unknown): QualityAssessment {
  let requirements: string[] = [], prototype = false;
  const result = (status: QualityAssessment['evidence_status'], reasons: string[], gates: QualityGate[]): QualityAssessment => ({
    scope: 'TEST_ONLY', decision: prototype ? 'PROTOTYPE_UNVERIFIED' : status === 'SATISFIED_TEST_ONLY'
      ? 'TEST_ONLY_REQUIREMENTS_SATISFIED' : status === 'REJECTED' ? 'TEST_ONLY_REJECTED' : 'TEST_ONLY_INCOMPLETE',
    evidence_status: status, production_verification: false, delivery_claim_allowed: false, reasons, gates,
  });
  try {
    exact(raw, ['format', 'claim', 'now', 'subject', 'profile', 'criteria', 'evidence']);
    need(raw.format === 'xdev-d1-quality-test-input-1' && raw.claim === 'ASSESSMENT_ONLY', 'QUALITY_PRODUCTION_CLAIM_FORBIDDEN');
    date(raw.now); validateSubject(raw.subject);
    requirements = qualityRequirements(raw.profile, raw.criteria);
    prototype = raw.profile.selected_profile === 'prototype';
    const input = raw as QualityTestInput, s = input.subject;
    need(s.profile_sha256 === qualityHash(input.profile) && s.criteria_sha256 === qualityHash(input.criteria), 'QUALITY_PROFILE_OR_AC_DRIFT');
    need(Array.isArray(input.evidence) && input.evidence.length <= 64, 'QUALITY_EVIDENCE_LIMIT');
    const records = input.evidence.map(e => parseEvidence(e, input, requirements));
    need(new Set(records.map(p => p.observation.evidence_id)).size === records.length &&
      new Set(records.map(p => canonical([p.observation.session_id, p.observation.call_id]))).size === records.length, 'QUALITY_DUPLICATE_EVIDENCE');
    const isAuthor = (e: QualityEvidence) => s.authors.some(a => a.agent_id === e.agent_id || a.run_id === e.run_id);
    // Validate every present record before considering coverage; a PASS cannot hide a FAIL.
    for (const p of records) {
      const e = p.observation, b = p.body;
      if (e.kind === 'history') checkHistory(b, s);
      if (e.kind === 'worker') {
        exact(b, ['state', 'active_writers', 'unknown_writers']); words(b.active_writers); words(b.unknown_writers);
        need(e.run_id === s.worker_run_id && s.authors.some(a => a.run_id === e.run_id && a.agent_id === e.agent_id), 'QUALITY_WORKER_IDENTITY');
        need(b.state === 'SUCCEEDED' && b.active_writers.length === 0 && b.unknown_writers.length === 0, 'QUALITY_WORKER_UNSETTLED');
      }
      if (e.kind === 'review') {
        exact(b, ['outcome', 'unresolved_findings', 'output']); words(b.unresolved_findings);
        need(b.outcome === 'PASS' && b.unresolved_findings.length === 0 && word(b.output), 'QUALITY_REVIEW_FAILED');
        if (!prototype) need(!isAuthor(e), 'QUALITY_AUTHOR_SELF_REVIEW');
      }
      if (e.kind === 'qa' || e.kind === 'integration') {
        checkExecution(p, s);
        if (!prototype) need(!isAuthor(e), 'QUALITY_AUTHOR_SELF_QA');
      }
      if (e.kind === 'integration-facts') {
        exact(b, ['integration_occurred', 'before_candidate_sha256', 'after_candidate_sha256', 'target_sha256']);
        need(typeof b.integration_occurred === 'boolean' && hex(b.before_candidate_sha256) &&
          b.after_candidate_sha256 === s.candidate_sha256 && b.target_sha256 === s.integration_target_sha256,
          'QUALITY_INTEGRATION_SOURCE_DRIFT');
        if (!b.integration_occurred) need(b.before_candidate_sha256 === s.candidate_sha256 &&
          b.target_sha256 === s.candidate_sha256, 'QUALITY_INTEGRATION_NA_UNPROVEN');
      }
    }
    const byKind = (kind: QualityEvidence['kind']) => records.filter(p => p.observation.kind === kind);
    for (const kind of ['history', 'integration-facts', 'worker'] as const)
      need(byKind(kind).length <= 1, 'QUALITY_CONFLICTING_SOURCE_OBSERVATIONS');
    const reviews = byKind('review'), tests = byKind('qa'), integration = byKind('integration');
    const facts = byKind('integration-facts')[0];
    if (input.profile.selected_profile === 'full_governance')
      need(reviews.every(r => [...tests, ...integration].every(q => r.observation.agent_id !== q.observation.agent_id &&
        r.observation.run_id !== q.observation.run_id)), 'QUALITY_FULL_ROLES_NOT_SEPARATE');
    const sourceReasons = [byKind('history').length ? null : 'QUALITY_HISTORY_MISSING',
      byKind('worker').length ? null : 'QUALITY_WORKER_MISSING', facts ? null : 'QUALITY_INTEGRATION_FACTS_MISSING',
      tests.length ? null : 'QUALITY_ACTUAL_CHECKS_MISSING', !prototype && !reviews.length ? 'QUALITY_REVIEW_MISSING' : null,
      facts?.body.integration_occurred && !integration.length ? 'QUALITY_INTEGRATION_RUN_MISSING' : null].filter((v): v is string => v !== null);
    const covered = (ps: Parsed[], name: string) => ps.some(p => p.observation.coverage.includes(name));
    const gates: QualityGate[] = requirements.map(requirement => {
      let ok: boolean;
      if (requirement === 'independent-review') ok = reviews.length > 0;
      else if (requirement === 'independent-qa') ok = tests.length > 0;
      else if (requirement === 'separate-author-reviewer-qa') ok = reviews.length > 0 && tests.length > 0;
      else if (requirement === 'applicable-integration-rerun') ok = !!facts && (!facts.body.integration_occurred || covered(integration, requirement));
      else ok = covered(tests, requirement);
      const reasons = [...sourceReasons, ...(ok ? [] : ['QUALITY_REQUIRED_COVERAGE_MISSING'])];
      return { requirement, status: reasons.length ? 'NOT_RUN' : 'SATISFIED_TEST_ONLY', reasons };
    });
    const reasons = [...new Set(gates.flatMap(g => g.reasons))];
    return result(reasons.length ? 'INCOMPLETE' : 'SATISFIED_TEST_ONLY', reasons, gates);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'QUALITY_SCHEMA_INVALID';
    return result('REJECTED', [reason], requirements.map(requirement => ({ requirement, status: 'REJECTED', reasons: [reason] })));
  }
}
