import type { Job } from '../job-runtime/contracts.ts';
import { notRunQualityGates, qualityRequirements } from '../job-runtime/d1-quality.ts';

/** B1 has no production Host-observation adapter. No file/flag/callback upgrades this port. */
export function observeD1QualityUnavailable(job: Job, source: { revision: number; head_sha256: string; create_sha256: string }) {
  const profile = job.d1_intake?.profile;
  const criteria = profile?.gates.filter(g => g.requirement.startsWith('criterion:')).map(g => g.requirement.slice(10)) ?? [];
  const requirements = profile ? qualityRequirements(profile, criteria) : [];
  const reasons = ['HOST_OBSERVER_UNAVAILABLE', ...(profile ? ['D1_PROFILE_ONLY_NOT_EXECUTABLE'] : ['D1_LEGACY_QUALITY_UNBOUND'])];
  return {
    scope: 'PRODUCTION_QUERY' as const, capability: 'HOST_OBSERVER_UNAVAILABLE' as const,
    decision: profile?.selected_profile === 'prototype' ? 'PROTOTYPE_UNVERIFIED' as const : 'NOT_ASSESSED' as const,
    evidence_status: 'NOT_ASSESSED' as const, profile: profile?.selected_profile ?? null,
    policy: { independent_review_required: !!profile && profile.selected_profile !== 'prototype',
      independent_qa_required: !!profile && profile.selected_profile !== 'prototype',
      separate_reviewer_qa_required: profile?.selected_profile === 'full_governance',
      actual_checks_required: !!profile },
    job_id: job.job_id, source_revision: source.revision, source_head_sha256: source.head_sha256,
    create_sha256: source.create_sha256, reasons, gates: notRunQualityGates(requirements, 'HOST_OBSERVER_UNAVAILABLE'),
    tasks: job.tasks.map(t => ({ task_id: t.task_id, generation: t.generation, current_run_id: t.current_run_id,
      attempt_id: job.runs.find(r => r.run_id === t.current_run_id)?.d1_worker?.attempt_id ?? null })),
    production_verification: false as const, delivery_claim_allowed: false as const, execution_permitted: false as const,
  };
}
