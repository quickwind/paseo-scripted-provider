import type { ProviderConnectRequest, ProviderEvent, ProviderInput, ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { realClock, type Clock, type NewId } from "../shared/core/clock";
import type { ResolvedConfig } from "../shared/core/config-types";
import { nullRecorder, type Recorder } from "../shared/core/recorder";
import type { Script } from "../shared/core/schema";
import { scenarioNames } from "../shared/core/script";
import { ScriptedSession, type Persisted } from "./session";

export const SUPPORTED_CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.steer",
  "session.persistence",
  "session.configure",
  "session.can_stop_runtime",
  "permission",
  "timeline.plugin",
] as const;

/** Intersects our capabilities with what the host daemon offers so older daemons never see unknown strings. */
export function negotiateCapabilities(
  offered: readonly string[] | undefined,
  supported: readonly string[] = SUPPORTED_CAPABILITIES,
): string[] {
  if (!Array.isArray(offered)) return [...supported];
  return supported.filter((c) => offered.includes(c));
}

export interface ProviderDeps {
  getScript(): Script;
  getConfig(): ResolvedConfig;
  ready?: () => Promise<void>;
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
    async connect(request?: ProviderConnectRequest) {
      const negotiated = negotiateCapabilities(request?.capabilities);
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
            const script = deps.getScript();
            const all = Array.from(new Set(["default", ...scenarioNames(script)]));
            emit({
              type: "catalog",
              requestId: input.requestId,
              catalog: {
                models: all.map((id) => ({ id, label: id, isDefault: id === "default" })),
                modes: script.modes ?? [],
                ...(script.thinkingOptions ? { thinkingOptions: script.thinkingOptions } : {}),
                defaultModel: "default",
                ...(script.defaultMode ? { defaultMode: script.defaultMode } : {}),
                ...(script.defaultThinkingOption ? { defaultThinkingOption: script.defaultThinkingOption } : {}),
              },
            });
            return;
          }
          case "sessions":
            emit({ type: "sessions", requestId: input.requestId, sessions: [] });
            return;
          case "session.open": {
            sessions.get(input.sessionId)?.dispose();
            const restored = (input.persistence?.data ?? null) as Persisted | null;
            const s = new ScriptedSession({
              sessionId: input.sessionId,
              script: deps.getScript,
              clock,
              newId,
              recorder: () => mkRecorder(deps.getConfig().recordFile),
              alignment: () => deps.getConfig().alignment,
              emit,
              persisted: restored ?? undefined,
              initialScenario: input.config.model ?? undefined,
              cwd: input.config.cwd,
              initialMode: input.config.mode ?? null,
              initialThinkingOption: input.config.thinkingOption ?? null,
              initialProviderOptions: { ...(input.config.settings ?? {}), ...(input.config.providerOptions ?? {}) },
              delayScale: () => deps.getConfig().delayScale,
            });
            sessions.set(input.sessionId, s);
            const nonEmpty = (obj: Record<string, unknown> | undefined) => (obj && Object.keys(obj).length > 0 ? obj : undefined);
            recorder.record("open", {
              sessionId: restored?.logicalId ?? input.sessionId,
              providerSessionId: input.sessionId,
              restored: !!restored,
              history: input.history,
              model: input.config.model ?? null,
              cwd: input.config.cwd,
              mode: input.config.mode ?? null,
              thinkingOption: input.config.thinkingOption ?? null,
              title: input.config.title ?? null,
              persist: input.config.persist,
              ...(input.config.systemPrompt !== undefined ? { systemPrompt: input.config.systemPrompt } : {}),
              ...(nonEmpty(input.config.env as Record<string, unknown> | undefined) ? { env: input.config.env } : {}),
              ...(nonEmpty(input.config.mcpServers as Record<string, unknown> | undefined) ? { mcpServers: input.config.mcpServers } : {}),
              ...(input.config.toolPolicy !== undefined ? { toolPolicy: input.config.toolPolicy } : {}),
              ...(nonEmpty(input.config.providerOptions as Record<string, unknown> | undefined) ? { providerOptions: input.config.providerOptions } : {}),
              ...(nonEmpty(input.config.settings as Record<string, unknown> | undefined) ? { settings: input.config.settings } : {}),
            });
            emit({
              type: "session.opened",
              requestId: input.requestId,
              sessionId: input.sessionId,
              capabilities: negotiated,
              restoration: "core",
              cwd: input.config.cwd,
              persistence: { version: 2, data: s.persistence() as unknown as never },
            });
            if (input.history === "replay") {
              for (const t of s.replay()) {
                const item =
                  (t.type === "user_message" || t.type === "assistant_message") && !("messageId" in t)
                    ? { ...t, messageId: t.id }
                    : t;
                emit({
                  type: "timeline.item",
                  sessionId: input.sessionId,
                  item: item as never,
                });
              }
            }
            const script = deps.getScript();
            if (
              (script.modes && script.modes.length > 0) ||
              (script.thinkingOptions && script.thinkingOptions.length > 0) ||
              (script.controls && script.controls.length > 0) ||
              input.config.mode ||
              input.config.thinkingOption
            ) {
              s.emitConfig();
            }
            s.emitCommands();
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
          case "session.permission":
            // An unknown or closed session has no card to answer.
            sessions.get(input.sessionId)?.respond(input.permissionId, input.response as never);
            return;
          case "session.configure": {
            const s = sessions.get(input.sessionId);
            recorder.record("configure", {
              sessionId: s?.id ?? input.sessionId,
              providerSessionId: input.sessionId,
              changes: input.changes,
            });
            s?.configure(input.changes);
            emit({ type: "request.completed", requestId: input.requestId });
            return;
          }
          case "session.can_stop_runtime": {
            const s = sessions.get(input.sessionId);
            emit({
              type: "session.can_stop_runtime",
              requestId: input.requestId,
              sessionId: input.sessionId,
              canStop: !s?.activeTurn,
            });
            return;
          }
          case "session.close": {
            const s = sessions.get(input.sessionId);
            recorder.record("close", {
              sessionId: s?.id ?? input.sessionId,
              providerSessionId: input.sessionId,
            });
            s?.dispose();
            sessions.delete(input.sessionId);
            emit({ type: "request.completed", requestId: input.requestId });
            emit({ type: "session.closed", sessionId: input.sessionId });
            return;
          }
          default:
            if ("requestId" in input && input.requestId) emit({ type: "request.completed", requestId: input.requestId });
        }
      }

      return {
        version: 1,
        capabilities: negotiated,
        async send(input) {
          try {
            await deps.ready?.();
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
