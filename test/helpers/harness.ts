import { ProviderEventSchema } from "@getpaseo/plugin/server/provider";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import { createScriptedProvider, type ProviderDeps } from "../../server/provider";
import { ManualClock } from "./manual-clock";

export async function connect(deps: Partial<ProviderDeps> & Pick<ProviderDeps, "getScript">) {
  const clock = new ManualClock();
  let id = 0;
  const reg = createScriptedProvider({
    getConfig: () => ({ alignment: "warn" }),
    clock,
    newId: () => `id-${++id}`,
    ...deps,
  });
  const conn = await reg.connect({ versions: [1], capabilities: ["prompt.message", "session.persistence"] });
  const events: ProviderEvent[] = [];
  conn.onEvent((e) => {
    expectValid(e);
    events.push(e);
  });
  const send = async (i: ProviderInput) => {
    await conn.send(i);
    await clock.advance(0);
  };
  return { conn, clock, events, send, reg };
}

function expectValid(e: ProviderEvent) {
  const r = ProviderEventSchema.safeParse(e);
  if (!r.success) throw new Error("Invalid ProviderEvent: " + JSON.stringify(r.error.issues) + " " + JSON.stringify(e));
}

export const open = (sessionId = "s1", model?: string): ProviderInput => ({
  type: "session.open",
  requestId: "r-open",
  sessionId,
  history: "skip",
  config: { cwd: "/tmp", env: {}, mcpServers: {}, settings: {}, persist: true, model },
});
export const prompt = (sessionId: string, text: string, cmid = "c" + Math.random()): ProviderInput => ({
  type: "session.prompt",
  sessionId,
  prompt: { clientMessageId: cmid, delivery: "auto", input: { type: "message", content: [{ type: "text", text }] } },
});
export const turnStates = (events: ProviderEvent[]) =>
  events
    .filter((e): e is Extract<ProviderEvent, { type: "session.turn" }> => e.type === "session.turn")
    .map((e) => e.state);
