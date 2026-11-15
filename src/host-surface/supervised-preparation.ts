import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { canonical } from '../job-runtime/store.ts';
import { parseD1UniqueJson } from '../job-runtime/contracts.ts';
import { inspectPublicFactsDeclaration, projectCurrentMemoryFacts } from '../../mcp/current-memory-facts.ts';

export type PreparationRef = { path: string; sha256: string };
export const supervisedPreparationFormat = 'xdev-supervised-preparation-1';
type Subject = { projectRoot: string; projectId: string };
type Status = 'READY'|'NEEDS_CLARIFICATION'|'CONFLICT'|'UNSUPPORTED';
const desktopConfirmationFormat = 'xdev-desktop-confirmation-1';
export const supervisedPreparationGuidance = { optional: true, url: 'https://github.com/NUVANU/XMi', status: 'GUIDANCE_ONLY_NOT_CALLED',
  version: '0.1.0-alpha.1', commit: 'd775e77573844a4328decb0e372804a511914f0c', xspec_version: '0.3.0', automatic_import_supported: false };
function need(value: unknown, reason: string): asserts value { if (!value) throw Error(reason); }
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length < 8192;
function exact(v: any, keys: string[]) {
  need(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|'), 'SUPERVISED_PREPARATION_SCHEMA_INVALID');
}

export function parsePreparationJson(body: string): unknown {
  return parseD1UniqueJson(body.replace(/^\uFEFF/, ''));
}

function declaredRef(value: any, error: string): asserts value is PreparationRef {
  need(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('|') === 'path|sha256' && text(value.path) &&
    isAbsolute(value.path) && resolve(value.path) === value.path &&
    typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256), error);
}

function jsonString(token: string): string | undefined {
  if (!token.startsWith('"')) return undefined;
  try { return JSON.parse(token); } catch { return undefined; }
}

function hasDeclaredBinding(raw: string, binding: string): boolean {
  const fields = [binding, 'project_id', 'project_root'];
  let depth = 0;
  let previous = '';
  let key: string | undefined;
  let formatValue = false;
  // Inspect top-level markers before full parsing so a truncated record or a
  // duplicate format key cannot erase the declaration and become legacy text.
  for (const [token] of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s"{}\[\],:]+/g)) {
    if (depth === 1) {
      if (formatValue && jsonString(token) === desktopConfirmationFormat) return true;
      formatValue = token === ':' && key === 'format';
      if (token === ':' && key !== undefined && fields.includes(key)) return true;
      key = previous === '{' || previous === ',' ? jsonString(token) : undefined;
    }
    if (token === '{' || token === '[') depth++;
    if (token === '}' || token === ']') depth--;
    previous = token;
  }
  return false;
}

function parseSourceDeclaration(ref: PreparationRef, body: string, binding: 'implementation' | 'confirmed_spec') {
  const raw = body.trimStart();
  if (!raw.startsWith('{') && !raw.startsWith('[')) return null;
  if (extname(ref.path).toLowerCase() !== '.json' && (!raw.startsWith('{') || !hasDeclaredBinding(raw, binding))) return null;
  let value: any;
  try { value = parsePreparationJson(body); } catch (error) {
    if (error instanceof SyntaxError) throw Error('SUPERVISED_PREPARATION_SOURCE_JSON_INVALID');
    throw error;
  }
  need(value && typeof value === 'object' && !Array.isArray(value), 'SUPERVISED_PREPARATION_SOURCE_STRUCTURE_INVALID');
  return value;
}

function checkDeclaredProject(value: Record<string, unknown>, subject: Subject, error: string) {
  need((!Object.hasOwn(value, 'project_id') || value.project_id === subject.projectId) &&
    (!Object.hasOwn(value, 'project_root') || value.project_root === subject.projectRoot), error);
}

// The caller supplies the existing bounded, no-link, hash-checking readRef.
// These are explicit coordinator declarations, never semantic or identity proof.
export function inspectSupervisedPreparation(s: Subject, source: PreparationRef, read: (ref: PreparationRef)=>string, expectedSpec?: PreparationRef, phase: 'admission' | 'reopen' = 'admission') {
  const p = parsePreparationJson(read(source)) as any;
  exact(p, ['format','project_id','project_root','original_intent','confirmed_spec','confirmation_source','minimal_design','assessment',...(p.current_memory_facts===undefined?[]:['current_memory_facts'])]);
  need(p.format === supervisedPreparationFormat, 'SUPERVISED_PREPARATION_VERSION_UNSUPPORTED');
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
  const readSource = (ref: PreparationRef) => {
    const body = read(ref);
    need(body.trim().length > 0, 'SUPERVISED_PREPARATION_SOURCE_EMPTY');
    return body;
  };
  if (p.confirmed_spec !== null) readSource(p.confirmed_spec);
  const ready = a.decision === 'READY';
  if (ready && expectedSpec) need(canonical(p.confirmed_spec) === canonical(expectedSpec), 'SUPERVISED_PREPARATION_SPEC_MISMATCH');

  const designBody = p.minimal_design === null ? null : readSource(p.minimal_design);
  const confirmationBody = p.confirmation_source === null ? null : readSource(p.confirmation_source);
  const design = designBody === null || phase === 'reopen' ? null : parseSourceDeclaration(p.minimal_design, designBody, 'implementation');
  if (design) {
    checkDeclaredProject(design, s, 'SUPERVISED_PREPARATION_IMPLEMENTATION_PROJECT_MISMATCH');
    if (Object.hasOwn(design, 'implementation')) {
      declaredRef(design.implementation, 'SUPERVISED_PREPARATION_IMPLEMENTATION_REF_INVALID');
      const member = relative(s.projectRoot, design.implementation.path);
      need(member && !isAbsolute(member) && member !== '..' && !member.startsWith('..' + sep),
        'SUPERVISED_PREPARATION_IMPLEMENTATION_PROJECT_MISMATCH');
      read(design.implementation);
    }
  }
  const confirmation = confirmationBody === null || phase === 'reopen' ? null : parseSourceDeclaration(p.confirmation_source, confirmationBody, 'confirmed_spec');
  if (confirmation) {
    checkDeclaredProject(confirmation, s, 'SUPERVISED_PREPARATION_CONFIRMATION_PROJECT_MISMATCH');
    if (Object.hasOwn(confirmation, 'confirmed_spec')) {
      declaredRef(confirmation.confirmed_spec, 'SUPERVISED_PREPARATION_CONFIRMATION_SPEC_REF_INVALID');
      // A pending or conflicting declaration can cite an older confirmation.
      // The caller can only use the binding to start when the assessment is READY.
      if (ready) need(canonical(confirmation.confirmed_spec) === canonical(p.confirmed_spec),
        'SUPERVISED_PREPARATION_CONFIRMATION_SPEC_MISMATCH');
    } else need(confirmation.format !== desktopConfirmationFormat, 'SUPERVISED_PREPARATION_CONFIRMATION_SPEC_REQUIRED');
  }
  const declaration=p.current_memory_facts===undefined?null:inspectPublicFactsDeclaration(p.current_memory_facts,s,p.confirmed_spec,read);
  const currentFacts=declaration===null?null:{...projectCurrentMemoryFacts(declaration.scope,declaration.source,read),bound_spec:declaration.spec};
  if (ready) {
    need(a.questions.length === 0 && a.original_intent_read === true && a.requirements_confirmed === true &&
      a.conflicts_resolved === true && p.confirmed_spec !== null && p.confirmation_source !== null && p.minimal_design !== null,
      'SUPERVISED_PREPARATION_READY_UNCONFIRMED');
  } else need(a.questions.length > 0, 'SUPERVISED_PREPARATION_QUESTIONS_REQUIRED');
  return { format: 'xdev-supervised-preparation-result-1', status: a.decision as Status, reason: a.reason as string,
    questions: a.questions as string[], project_id: s.projectId, project_root: s.projectRoot, source,
    original_intent: p.original_intent, confirmed_spec: p.confirmed_spec, confirmation_source: p.confirmation_source,
    minimal_design: p.minimal_design, preparation_verified: ready,
    semantics: 'COORDINATOR_DECLARATIONS_AND_CURRENT_BYTE_BINDINGS_ONLY', native_identity_authenticated: false, xmi: supervisedPreparationGuidance,
    ...(currentFacts===null?{}:{current_public_facts:currentFacts}) };
}

export function requireSupervisedPreparation(s: Subject, source: PreparationRef, read: (ref: PreparationRef)=>string, spec: PreparationRef, phase: 'admission' | 'reopen' = 'admission') {
  const result = inspectSupervisedPreparation(s, source, read, spec, phase);
  need(result.status === 'READY', 'SUPERVISED_PREPARATION_NOT_READY:' + result.status + ':' + result.questions.join('; '));
  return result;
}
