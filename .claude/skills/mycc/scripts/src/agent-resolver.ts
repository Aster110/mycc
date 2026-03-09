import { existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";

export interface AgentItem {
  id: string;
  path: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function listAgents(agentsDir: string): AgentItem[] {
  if (!agentsDir || !existsSync(agentsDir)) return [];

  return readdirSync(agentsDir)
    .map((entry) => ({ entry, fullPath: join(agentsDir, entry) }))
    .filter(({ fullPath }) => isDirectory(fullPath))
    .map(({ entry, fullPath }) => ({ id: entry, path: fullPath }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function resolveAgentDir(agentId: string, agentsDir: string): string | null {
  if (!agentId || !agentsDir || !existsSync(agentsDir)) return null;

  const exact = resolve(agentsDir, agentId);
  if (isDirectory(exact)) return exact;

  const normalized = agentId.trim().toLowerCase();
  const match = listAgents(agentsDir).find((agent) => agent.id.toLowerCase() === normalized);
  return match?.path ?? null;
}
