export interface Removable {
  remove(): void;
}

/** Keeps one registration per agent. Known agents are not re-registered on every update. */
export function createAgentRegistry(add: (agent: { id: string; workspaceId: string }) => Removable) {
  const regs = new Map<string, { workspaceId: string; reg: Removable }>();
  return {
    track(agent: { id: string; workspaceId?: string | null }): void {
      if (!agent.workspaceId) return;
      const cur = regs.get(agent.id);
      if (cur && cur.workspaceId === agent.workspaceId) return;
      cur?.reg.remove();
      regs.set(agent.id, { workspaceId: agent.workspaceId, reg: add({ id: agent.id, workspaceId: agent.workspaceId }) });
    },
    forget(agentId: string): void {
      regs.get(agentId)?.reg.remove();
      regs.delete(agentId);
    },
    reset(): void {
      for (const { reg } of regs.values()) reg.remove();
      regs.clear();
    },
    size: () => regs.size,
  };
}
