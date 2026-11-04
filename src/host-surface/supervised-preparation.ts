import { isAbsolute, resolve } from 'node:path';
import { canonical } from '../job-runtime/store.ts';
import { parseD1UniqueJson } from '../job-runtime/contracts.ts';
import { inspectPublicFactsDeclaration, projectCurrentMemoryFacts } from '../../mcp/current-memory-facts.ts';

export type PreparationRef = { path: string; sha256: string };
type Subject = { projectRoot: string; projectId: string };
type Status = 'READY'|'NEEDS_CLARIFICATION'|'CONFLICT'|'UNSUPPORTED';
export const supervisedPreparationGuidance = { optional: true, url: 'https://github.com/NUVANU/XMi', status: 'GUIDANCE_ONLY_NOT_CALLED',
  version: '0.1.0-alpha.1', commit: 'd775e77573844a4328decb0e372804a511914f0c', xspec_version: '0.3.0', automatic_import_supported: false };
function need(value: unknown, reason: string): asserts value { if (!value) throw Error(reason); }
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length < 8192;
function exact(v: any, keys: string[]) {
  need(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|'), 'SUPERVISED_PREPARATION_SCHEMA_INVALID');
}

// The caller supplies the existing bounded, no-link, hash-checking readRef.
// These are explicit coordinator declarations, never semantic or identity proof.
export function inspectSupervisedPreparation(s: Subject, source: PreparationRef, read: (ref: PreparationRef)=>string, expectedSpec?: PreparationRef) {
  const p = parseD1UniqueJson(read(source)) as any;
  exact(p, ['format','project_id','project_root','original_intent','confirmed_spec','confirmation_source','minimal_design','assessment',...(p.current_memory_facts===undefined?[]:['current_memory_facts'])]);
  need(p.format === 'xdev-supervised-preparation-1', 'SUPERVISED_PREPARATION_VERSION_UNSUPPORTED');
  need(text(s.projectId) && isAbsolute(s.projectRoot) && resolve(s.projectRoot) === s.projectRoot &&
    p.project_id === s.projectId && p.project_root === s.projectRoot, 'SUPERVISED_PREPARATION_PROJECT_MISMATCH');
  const a = p.assessment;
  exact(a, ['source_claim','decision','reason','questions','original_intent_read','requirements_confirmed','conflicts_resolved']);
  need(a.source_claim === 'COORDINATOR_RECORDED_PUBLIC_DISCUSSION' &&
    ['READY','NEEDS_CLARIFICATION','CONFLICT','UNSUPPORTED'].includes(a.decision) && text(a.reason) &&
    Array.isArray(a.questions) && a.questions.length <= 64 && a.questions.every(text) &&
    new Set(a.questions).size === a.questions.length &&
    [a.original_intent_read,a.requirements_confirmed,a.conflicts_resolved].every(v=>v === null || typeof v === 'boolean'),
    'SUPERVISED_PREPARATION_ASSESSMENT_INVALID');
  need(read(p.original_intent).trim().length > 0, 'SUPERVISED_PREPARATION_INTENT_EMPTY');
  for (const ref of [p.confirmed_spec,p.confirmation_source,p.minimal_design]) {
    if (ref !== null) need(read(ref).trim().length > 0, 'SUPERVISED_PREPARATION_SOURCE_EMPTY');
  }
  if (expectedSpec) need(canonical(p.confirmed_spec) === canonical(expectedSpec), 'SUPERVISED_PREPARATION_SPEC_MISMATCH');
  const declaration=p.current_memory_facts===undefined?null:inspectPublicFactsDeclaration(p.current_memory_facts,s,p.confirmed_spec,read);
  const currentFacts=declaration===null?null:{...projectCurrentMemoryFacts(declaration.scope,declaration.source,read),bound_spec:declaration.spec};
  if (a.decision === 'READY') {
    need(a.questions.length === 0 && a.original_intent_read === true && a.requirements_confirmed === true &&
      a.conflicts_resolved === true && p.confirmed_spec !== null && p.confirmation_source !== null && p.minimal_design !== null,
      'SUPERVISED_PREPARATION_READY_UNCONFIRMED');
  } else need(a.questions.length > 0, 'SUPERVISED_PREPARATION_QUESTIONS_REQUIRED');
  return { format: 'xdev-supervised-preparation-result-1', status: a.decision as Status, reason: a.reason as string,
    questions: a.questions as string[], project_id: s.projectId, project_root: s.projectRoot, source,
    original_intent: p.original_intent, confirmed_spec: p.confirmed_spec, confirmation_source: p.confirmation_source,
    minimal_design: p.minimal_design, preparation_verified: a.decision === 'READY',
    semantics: 'COORDINATOR_DECLARATIONS_AND_CURRENT_BYTE_BINDINGS_ONLY', native_identity_authenticated: false, xmi: supervisedPreparationGuidance,
    ...(currentFacts===null?{}:{current_public_facts:currentFacts}) };
}

export function requireSupervisedPreparation(s: Subject, source: PreparationRef, read: (ref: PreparationRef)=>string, spec: PreparationRef) {
  const result = inspectSupervisedPreparation(s, source, read, spec);
  need(result.status === 'READY', 'SUPERVISED_PREPARATION_NOT_READY:' + result.status + ':' + result.questions.join('; '));
  return result;
}
