import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeRecordButtons } from "./client/record-button";
import { RecordScreen } from "./client/record-screen";
import { ScriptedSettingsScreen } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addSettingsScreen({ id: "scripted-provider", title: "Scripted provider", icon: "Clapperboard", Component: ScriptedSettingsScreen }),
    client.addScreen({ id: "scripted-record", title: "Record as script", Component: RecordScreen }),
    // Conveniences over the normal prompt path: the engine advances one step per user message.
    client.addSlashCommand({
      name: "scripted-next",
      description: "Advance the Scripted agent by one step",
      argumentHint: "",
      context: "agent",
      onSubmit: ({ agent, paseo }) => paseo.agents.ref(agent.id).send("(next)"),
    }),
    client.addSlashCommand({
      name: "scripted-reset",
      description: "Restart the Scripted agent's scenario (optionally switch to another)",
      argumentHint: "[scenario]",
      context: "agent",
      onSubmit: ({ agent, args, paseo }) => paseo.agents.ref(agent.id).send(`SCENARIO:${args.trim() || agent.model || "default"}`),
    }),
    contributeRecordButtons(client),
  ];
  return () => {
    for (const c of cleanups) c();
  };
}
