import process from "node:process";

async function readInput() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const input = await readInput();
const event = input.hook_event_name;
const evidenceReminder = "XDev evidence gate reminder: do not claim verified completion from a narrative. Preserve real commands, exit statuses, Git/file facts, and required evidence; implementation must be handed to independent review, QA, evidence, and specification gates.";
const systemMessage = event === "SubagentStart"
  ? "XDev guardrail: read the bounded Task Contract, approved design, repository instructions, and relevant .xdev state before acting. Stay within allowed scope. An implementation worker may report only IMPLEMENTED and must never review or verify its own changes."
  : event === "SubagentStop"
    ? evidenceReminder + " Finish your assigned role with its own natural final and original receipts; the coordinator then checks the overall goal and continues authorized work. This reminder must not keep a completed subagent running."
    : evidenceReminder + " Coordinator: before ending, check the confirmed overall goal, remaining acceptance criteria, current authority and blockers. Continue an authorized, unblocked next step; a stage report or current Job COMPLETE is not overall completion. automatic_execution:false only describes XDev runtime dispatch. Preserve independent Review/QA, original finals, finite limits and UNKNOWN reconciliation; check action-specific permissions. Record blocker evidence, dependencies, release condition and spent attempts; continue authorized independent work after explicit disposition. No repeated attempts without new evidence. Non-blocking reminder; not a permission grant or idle/session scheduler.";

process.stdout.write(JSON.stringify({ systemMessage }) + "\n");
