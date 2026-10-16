import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createAgentRegistry } from "./agent-registry";

/**
 * A "record as script" button next to the message box of every conversation. Header buttons only know the
 * workspace, not the conversation, so this uses composer pills, which are registered per agent. The pill opens
 * a full screen (a popover or modal is too narrow for a side-by-side review).
 */
export function contributeRecordButtons(client: PluginClientContext) {
  const lifetime = new AbortController();
  const registry = createAgentRegistry((agent) =>
    client.addComposerPill({
      id: "scripted-record",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        title: "Record this conversation as a replayable script (secrets are redacted before export)",
        icon: "Clapperboard",
        label: "Record as script",
        behavior: {
          kind: "action",
          onPress: () => client.openScreen({ screenId: "scripted-record", params: { agentId: agent.id } }),
        },
      },
    }),
  );

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          registry.reset();
          for (const { agent } of entries) registry.track(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") registry.forget(update.agentId);
          else registry.track(update.agent);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("Agent observation failed", error);
    });

  return () => {
    lifetime.abort();
    registry.reset();
  };
}
