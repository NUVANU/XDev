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
const systemMessage = event === "SubagentStart"
  ? "XDev guardrail: read the bounded Task Contract, approved design, repository instructions, and relevant .xdev state before acting. Stay within allowed scope. An implementation worker may report only IMPLEMENTED and must never review or verify its own changes."
  : "XDev evidence gate reminder: do not claim verified completion from a narrative. Preserve real commands, exit statuses, Git/file facts, and required evidence; implementation must be handed to independent review, QA, evidence, and specification gates.";

process.stdout.write(JSON.stringify({ systemMessage }) + "\n");
