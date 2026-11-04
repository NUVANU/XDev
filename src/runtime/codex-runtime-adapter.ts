export type CodexInvocation = {
  prompt: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
};

export type DryRunCommand = {
  command: "codex";
  args: string[];
  executes: false;
};

/**
 * Produces the public Codex CLI invocation XDev would delegate to. This adapter
 * intentionally never launches Codex or calls a model; lifecycle control stays
 * with native Codex subagents/CLI rather than an XDev runtime.
 */
export function describeCodexExec(invocation: CodexInvocation): DryRunCommand {
  if (!invocation.prompt.trim()) throw new Error("A non-empty task prompt is required.");

  const args = ["exec"];
  if (invocation.model) args.push("--model", invocation.model);
  if (invocation.reasoningEffort) {
    args.push("--config", `model_reasoning_effort=${invocation.reasoningEffort}`);
  }
  if (invocation.sandbox) args.push("--sandbox", invocation.sandbox);
  args.push(invocation.prompt);

  return { command: "codex", args, executes: false };
}
