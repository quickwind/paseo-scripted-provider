import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import type { Clock, NewId } from "../shared/core/clock";
import { planReply, type Action } from "../shared/core/planner";
import type { Recorder } from "../shared/core/recorder";
import type { Script } from "../shared/core/schema";
import { matchStep, resolveReply } from "../shared/core/script";

export interface Persisted {
  logicalId: string;
  scenario: string | null;
  step: number;
  transcript: { id: string; type: "user_message" | "assistant_message"; text: string }[];
}

export interface SessionDeps {
  sessionId: string;
  script: () => Script;
  clock: Clock;
  newId: NewId;
  recorder: Recorder;
  alignment: "warn" | "strict" | "ignore";
  emit: (e: ProviderEvent) => void;
  persisted?: Persisted;
  initialScenario?: string;
}

export function promptText(p: ProviderPrompt): string {
  if (p.input.type === "command") return `/${p.input.name} ${p.input.arguments}`;
  // Plain user text only: text *attachments* (which carry a mimeType) are not part of what the user typed.
  return p.input.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && !("mimeType" in c))
    .map((c) => c.text)
    .join("\n");
}

interface ActiveTurn {
  id: string;
  abort: () => void;
  aborted: Promise<void>;
}

export class ScriptedSession {
  private scenario: string | null;
  private step: number;
  private logicalId: string;
  private transcript: Persisted["transcript"];
  private turn: ActiveTurn | null = null;

  constructor(private d: SessionDeps) {
    this.scenario = d.persisted?.scenario ?? d.initialScenario ?? null;
    this.step = d.persisted?.step ?? 0;
    this.logicalId = d.persisted?.logicalId ?? d.sessionId;
    this.transcript = [...(d.persisted?.transcript ?? [])];
  }

  get activeTurn(): string | null {
    return this.turn?.id ?? null;
  }

  persistence(): Persisted {
    return { logicalId: this.logicalId, scenario: this.scenario, step: this.step, transcript: [...this.transcript] };
  }

  replay(): Persisted["transcript"] {
    return this.transcript;
  }

  prompt(p: ProviderPrompt): void {
    const { emit, recorder } = this.d;
    const sid = this.d.sessionId;
    const text = promptText(p);
    const m = /^SCENARIO:([\w-]+)/.exec(text.trim());
    if (m) {
      this.scenario = m[1];
      this.step = 0;
    }
    const script = this.d.script();
    const scenario = this.scenario ?? "default";
    // warn (default): answer by content when the script has recorded `expect`s; strict/ignore: by order.
    const step = this.d.alignment === "warn" && !m ? matchStep(script, scenario, this.step, text) : this.step;
    const { reply } = resolveReply(script, scenario, step);
    recorder.record("prompt", {
      sessionId: this.logicalId,
      providerSessionId: sid,
      scenario: this.scenario,
      step,
      jumpedFrom: step !== this.step ? this.step : undefined,
      delivery: p.delivery,
      clientMessageId: p.clientMessageId,
      activeTurnAtArrival: this.activeTurn,
      text,
      contentTypes: p.input.type === "message" ? p.input.content.map((c) => c.type) : ["command"],
    });
    if (reply.expect !== undefined && reply.expect.trim() !== text.trim()) {
      recorder.record("mismatch", { sessionId: this.logicalId, step, expected: reply.expect, actual: text, mode: this.d.alignment });
      if (this.d.alignment === "strict") {
        emit({
          type: "session.prompt_result",
          sessionId: sid,
          clientMessageId: p.clientMessageId,
          result: {
            type: "failed",
            error: { message: `Script mismatch at step ${step}: expected ${JSON.stringify(reply.expect)}`, code: "E_SCRIPT_MISMATCH" },
          },
        });
        return;
      }
    }
    this.step = step + 1;
    this.transcript.push({ id: p.clientMessageId, type: "user_message", text });
    if (this.turn) this.endTurn(this.turn.id, "canceled", "superseded by new prompt");

    const id = this.d.newId();
    let abort!: () => void;
    const aborted = new Promise<void>((r) => (abort = r));
    this.turn = { id, abort, aborted };
    emit({ type: "session.prompt_result", sessionId: sid, clientMessageId: p.clientMessageId, result: { type: "turn", turnId: id } });
    emit({ type: "session.turn", sessionId: sid, turnId: id, state: "started" });
    void this.run(id, planReply(reply, this.d.newId)).catch((e) => {
      // e.g. the daemon rejected an emitted item: end the turn instead of leaving it running forever.
      console.error("[scripted-provider] turn failed", e);
      try {
        this.endTurn(id, "failed", `scripted turn failed: ${e instanceof Error ? e.message : String(e)}`, "E_SCRIPT_RUNTIME");
      } catch (again) {
        console.error("[scripted-provider] could not report the failure", again);
      }
    });
  }

  /** The session was closed: release any waiting turn without emitting anything further. */
  dispose(): void {
    const t = this.turn;
    this.turn = null;
    t?.abort();
  }

  interrupt(requestId: string): void {
    this.d.recorder.record("interrupt", { sessionId: this.logicalId, activeTurn: this.activeTurn });
    if (this.turn) this.endTurn(this.turn.id, "canceled", "interrupted");
    this.d.emit({ type: "request.completed", requestId });
  }

  /** Emits exactly one terminal event per turn; later calls for the same turn are no-ops. */
  private endTurn(turnId: string, state: "completed" | "failed" | "canceled", message?: string, code?: string): void {
    if (this.turn?.id !== turnId) return;
    const t = this.turn;
    this.turn = null;
    t.abort();
    this.d.emit({
      type: "session.persistence",
      sessionId: this.d.sessionId,
      persistence: { version: 1, data: this.persistence() as unknown as never },
    });
    this.d.emit({
      type: "session.turn",
      sessionId: this.d.sessionId,
      turnId,
      state,
      ...(message ? { error: { message, ...(code ? { code } : {}) } } : {}),
    });
  }

  private async run(turnId: string, actions: Action[]): Promise<void> {
    const ids = new Map<string, string>();
    const idFor = (k: string) => {
      let v = ids.get(k);
      if (!v) ids.set(k, (v = this.d.newId()));
      return v;
    };
    const texts = new Map<string, string>();
    const live = () => this.turn?.id === turnId;
    const emitItem = (item: Record<string, unknown>) =>
      this.d.emit({
        type: "timeline.item",
        sessionId: this.d.sessionId,
        item: item as never,
        timestamp: new Date(this.d.clock.now()).toISOString(),
      });

    for (const a of actions) {
      if (!live()) return;
      switch (a.t) {
        case "sleep":
          await Promise.race([this.d.clock.sleep(a.ms), this.turn!.aborted]);
          break;
        case "reasoning":
          emitItem({ id: idFor(a.key), type: "reasoning", text: a.text });
          break;
        case "assistant": {
          const id = idFor(a.key);
          emitItem({ id, type: "assistant_message", text: a.text, messageId: id });
          texts.set(a.key, a.text);
          break;
        }
        case "tool": {
          const id = idFor(a.key);
          const base = { id, type: "tool_call", callId: id, name: a.spec.name, detail: a.spec.detail };
          emitItem(
            a.status === "failed"
              ? { ...base, status: "failed", error: a.spec.error ?? "scripted failure" }
              : { ...base, status: a.status, error: null },
          );
          break;
        }
        case "end": {
          if (a.outcome === "hang") {
            await this.turn!.aborted;
            return; // endTurn already emitted the terminal event
          }
          if (texts.size > 0) {
            this.transcript.push({ id: this.d.newId(), type: "assistant_message", text: [...texts.values()].join("") });
          }
          const msg =
            a.outcome === "failed" ? (a.error ?? "scripted failure") : a.outcome === "canceled" ? (a.error ?? "scripted cancel") : undefined;
          this.endTurn(turnId, a.outcome, msg, a.outcome === "failed" ? "E_SCRIPTED" : undefined);
          return;
        }
      }
    }
  }
}
