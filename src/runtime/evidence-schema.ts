export type EvidenceRecord = {
  evidence_id: string;
  task_id: string;
  run_id: string;
  type: "command" | "plugin_validation" | "installation" | "smoke_test" | "git";
  command: string;
  cwd: string;
  exit_code: number | null;
  repo_head_before: string | null;
  repo_head_after: string | null;
  related_files: string[];
  output_summary: string;
  captured_at: string;
  source: string;
  freshness: "current" | "stale" | "superseded";
};

/**
 * Validates portable evidence supplied by an observing Director. It neither
 * executes commands nor writes evidence, so it cannot manufacture observations.
 */
export function validateEvidenceRecord(record: EvidenceRecord): string[] {
  const requiredText: Array<[string, string]> = [
    ["evidence_id", record.evidence_id],
    ["task_id", record.task_id],
    ["run_id", record.run_id],
    ["command", record.command],
    ["cwd", record.cwd],
    ["output_summary", record.output_summary],
    ["captured_at", record.captured_at],
    ["source", record.source],
  ];
  const errors = requiredText
    .filter(([, value]) => !value.trim())
    .map(([field]) => `${field} is required.`);

  if (!Array.isArray(record.related_files)) errors.push("related_files must be an array.");
  if (record.exit_code !== null && !Number.isInteger(record.exit_code)) errors.push("exit_code must be an integer or null.");
  if (Number.isNaN(Date.parse(record.captured_at))) errors.push("captured_at must be an ISO-compatible timestamp.");
  return errors;
}
