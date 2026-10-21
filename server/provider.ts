import type { ProviderEvent, ProviderInput, ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { realClock, type Clock, type NewId } from "../shared/core/clock";
import type { ResolvedConfig } from "../shared/core/config-types";
import { nullRecorder, type Recorder } from "../shared/core/recorder";
import type { Script } from "../shared/core/schema";
import { scenarioNames } from "../shared/core/script";
import { ScriptedSession, type Persisted } from "./session";

export interface ProviderDeps {
  getScript(): Script;
  getConfig(): ResolvedConfig;
  clock?: Clock;
  newId?: NewId;
  recorder?(file?: string): Recorder;
}

export function createScriptedProvider(deps: ProviderDeps): ProviderRegistration {
  const clock = deps.clock ?? realClock;
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  const mkRecorder = deps.recorder ?? (() => nullRecorder);

  return {
    id: "scripted",
    label: "Scripted",
    description: "Replies from a script instead of a model (testing and demos).",
    async connect() {
      const listeners = new Set<(e: ProviderEvent) => void>();
      const emit = (e: ProviderEvent) => {
        for (const l of listeners) l(e);
      };
      const sessions = new Map<string, ScriptedSession>();

      function handle(input: ProviderInput) {
        const cfg = deps.getConfig();
        const recorder = mkRecorder(cfg.recordFile);
        switch (input.type) {
          case "catalog": {
            const all = Array.from(new Set(["default", ...scenarioNames(deps.getScript())]));
            emit({
              type: "catalog",
              requestId: input.requestId,
              catalog: {
                models: all.map((id) => ({ id, label: id, isDefault: id === "default" })),
                modes: [],
                defaultModel: "default",
              },
            });
            return;
          }
          case "sessions":
            emit({ type: "sessions", requestId: input.requestId, sessions: [] });
            return;
          case "session.open": {
            const restored = (input.persistence?.data ?? null) as Persisted | null;
            const s = new ScriptedSession({
              sessionId: input.sessionId,
              script: deps.getScript,
              clock,
              newId,
              recorder,
              alignment: cfg.alignment,
              emit,
              persisted: restored ?? undefined,
              initialScenario: input.config.model ?? undefined,
            });
            sessions.set(input.sessionId, s);
            recorder.record("open", {
              sessionId: restored?.logicalId ?? input.sessionId,
              providerSessionId: input.sessionId,
              restored: !!restored,
              history: input.history,
              model: input.config.model ?? null,
            });
            emit({
              type: "session.opened",
              requestId: input.requestId,
              sessionId: input.sessionId,
              capabilities: ["prompt.message", "session.persistence"],
              restoration: "core",
              cwd: input.config.cwd,
              persistence: { version: 1, data: s.persistence() as unknown as never },
            });
            if (input.history === "replay") {
              for (const t of s.replay()) {
                emit({
                  type: "timeline.item",
                  sessionId: input.sessionId,
                  item: { id: t.id, type: t.type, text: t.text, messageId: t.id },
                });
              }
            }
            emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
            return;
          }
          case "session.prompt": {
            const s = sessions.get(input.sessionId);
            if (!s) {
              emit({
                type: "session.prompt_result",
                sessionId: input.sessionId,
                clientMessageId: input.prompt.clientMessageId,
                result: { type: "failed", error: { message: "unknown session" } },
              });
              return;
            }
            s.prompt(input.prompt);
            return;
          }
          case "session.interrupt": {
            const s = sessions.get(input.sessionId);
            if (s) s.interrupt(input.requestId);
            else emit({ type: "request.completed", requestId: input.requestId });
            return;
          }
          case "session.close":
            sessions.get(input.sessionId)?.dispose();
            sessions.delete(input.sessionId);
            emit({ type: "request.completed", requestId: input.requestId });
            emit({ type: "session.closed", sessionId: input.sessionId });
            return;
          default:
            if ("requestId" in input && input.requestId) emit({ type: "request.completed", requestId: input.requestId });
        }
      }

      return {
        version: 1,
        capabilities: ["prompt.message", "session.persistence"],
        async send(input) {
          try {
            handle(input);
          } catch (error) {
            console.error("[scripted-provider] handle failed", error);
            if (input.type === "session.prompt") {
              emit({
                type: "session.prompt_result",
                sessionId: input.sessionId,
                clientMessageId: input.prompt.clientMessageId,
                result: { type: "failed", error: { message: `Scripted provider error: ${String(error)}`, code: "E_SCRIPT_RUNTIME" } },
              });
            } else if ("requestId" in input && input.requestId) {
              emit({ type: "request.failed", requestId: input.requestId, error: { message: String(error) } });
            }
          }
        },
        onEvent(l) {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        async close() {
          for (const s of sessions.values()) s.dispose();
          listeners.clear();
          sessions.clear();
        },
      };
    },
  };
}
