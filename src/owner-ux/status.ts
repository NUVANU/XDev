import { readFileSync } from "node:fs";
import { join } from "node:path";

type ProjectState = {
  name?: string;
  project_state?: string;
  current_milestone_id?: string;
  active_task_ids?: string[];
  owner_gate_ids?: string[];
};

export type OwnerStatus = {
  project: string;
  state: string;
  milestone: string;
  activeTasks: string[];
  ownerDecisionsNeeded: number;
};

export function readOwnerStatus(projectRoot: string): OwnerStatus {
  const path = join(projectRoot, ".xdev", "project-state.json");
  const state = JSON.parse(readFileSync(path, "utf8")) as ProjectState;
  return {
    project: state.name ?? "XDev project",
    state: state.project_state ?? "UNKNOWN",
    milestone: state.current_milestone_id ?? "UNKNOWN",
    activeTasks: state.active_task_ids ?? [],
    ownerDecisionsNeeded: state.owner_gate_ids?.length ?? 0,
  };
}

export function formatOwnerStatus(status: OwnerStatus): string {
  return [
    `项目：${status.project}`,
    `当前阶段：${status.state}`,
    `当前里程碑：${status.milestone}`,
    `进行中的任务：${status.activeTasks.length ? status.activeTasks.join("、") : "无"}`,
    `需要你决定：${status.ownerDecisionsNeeded} 项`,
  ].join("\n");
}
