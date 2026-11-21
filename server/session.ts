import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import type { Clock, NewId } from "../shared/core/clock";
import { buildRequest, permissionVars, selectBranch, substituteBranch, answersOf, type PermissionResponse } from "../shared/core/permission";
import { planReply, planSteps, type Action } from "../shared/core/planner";
import type { Recorder } from "../shared/core/recorder";
import type { PermissionSpec, Script, Step, ToolSpec } from "../shared/core/schema";
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

/** Why a card was resolved without an answer. */
export type CancelReason = "interrupted" | "superseded" | "interrupt_deny" | "branch_outcome" | "failed";

interface PendingCard {
  turnId: string;
  spec: PermissionSpec;
  answer: (r: PermissionResponse) => void;
}

type ToolItem = { id: string; type: "tool_call"; callId: string; name: string; detail: unknown };

/** Per-run state shared by a reply and the branches it runs. */
interface RunCtx {
  idFor: (key: string) => string;
  texts: Map<string, string>;
}

type Flow = "continue" | "ended";

export class ScriptedSession {
  private scenario: string | null;
  private step: number;
  private logicalId: string;
  private transcript: Persisted["transcript"];
  private turn: ActiveTurn | null = null;
  /** Cards waiting for an answer, by permission id. */
  private pending = new Map<string, PendingCard>();
  /** Tool calls shown as running, by item id (canceled if their turn ends early). */
  private openTools = new Map<string, { turnId: string; item: ToolItem }>();

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
    if (this.turn) this.endTurn(this.turn.id, "canceled", "superseded by new prompt", undefined, "superseded");

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
        this.endTurn(id, "failed", `scripted turn failed: ${e instanceof Error ? e.message : String(e)}`, "E_SCRIPT_RUNTIME", "failed");
      } catch (again) {
        console.error("[scripted-provider] could not report the failure", again);
      }
    });
  }

  /** The session was closed: release any waiting turn without emitting anything further. */
  dispose(): void {
    const t = this.turn;
    this.turn = null;
    this.pending.clear();
    this.openTools.clear();
    t?.abort();
  }

  /**
   * The answer to a card. Synchronous: the card is resolved before anything else can arrive for it,
   * so a duplicate or stale answer finds nothing pending and is only recorded.
   */
  respond(permissionId: string, response: PermissionResponse): void {
    const card = this.pending.get(permissionId);
    if (!card) {
      this.d.recorder.record("permission_unknown", { sessionId: this.logicalId, permissionId });
      return;
    }
    this.pending.delete(permissionId);
    this.d.emit({ type: "session.permission_resolved", sessionId: this.d.sessionId, permissionId });
    this.d.recorder.record("permission_response", {
      sessionId: this.logicalId,
      permissionId,
      behavior: response.behavior,
      selectedActionId: response.selectedActionId,
      message: response.behavior === "deny" ? response.message : undefined,
      interrupt: response.behavior === "deny" ? response.interrupt : undefined,
      answers: answersOf(response),
      branch: selectBranch(card.spec, response)?.key ?? null,
    });
    card.answer(response);
  }

  interrupt(requestId: string): void {
    this.d.recorder.record("interrupt", { sessionId: this.logicalId, activeTurn: this.activeTurn });
    if (this.turn) this.endTurn(this.turn.id, "canceled", "interrupted", undefined, "interrupted");
    this.d.emit({ type: "request.completed", requestId });
  }

  /**
   * Emits exactly one terminal event per turn; later calls for the same turn are no-ops.
   * Cards and tool calls the turn left open are closed first.
   */
  private endTurn(
    turnId: string,
    state: "completed" | "failed" | "canceled",
    message?: string,
    code?: string,
    reason: CancelReason = "interrupted",
  ): void {
    if (this.turn?.id !== turnId) return;
    const t = this.turn;
    this.turn = null;
    this.closeOpen(turnId, reason);
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

  private closeOpen(turnId: string, reason: CancelReason): void {
    for (const [permissionId, card] of [...this.pending]) {
      if (card.turnId !== turnId) continue;
      this.pending.delete(permissionId);
      this.d.emit({ type: "session.permission_resolved", sessionId: this.d.sessionId, permissionId });
      this.d.recorder.record("permission_canceled", { sessionId: this.logicalId, permissionId, reason });
    }
    for (const [id, open] of [...this.openTools]) {
      if (open.turnId !== turnId) continue;
      this.openTools.delete(id);
      this.emitItem({ ...open.item, status: "canceled", error: null });
    }
  }

  private emitItem(item: Record<string, unknown>): void {
    this.d.emit({
      type: "timeline.item",
      sessionId: this.d.sessionId,
      item: item as never,
      timestamp: new Date(this.d.clock.now()).toISOString(),
    });
  }

  private live(turnId: string): boolean {
    return this.turn?.id === turnId;
  }

  /** Resolves after `ms`, or as soon as the turn ends. */
  private wait(turnId: string, ms: number): Promise<void> {
    return this.turn?.id === turnId ? Promise.race([this.d.clock.sleep(ms), this.turn.aborted]) : Promise.resolve();
  }

  private async run(turnId: string, actions: Action[]): Promise<void> {
    const ids = new Map<string, string>();
    const idFor = (k: string) => {
      let v = ids.get(k);
      if (!v) ids.set(k, (v = this.d.newId()));
      return v;
    };
    await this.runActions(turnId, actions, { idFor, texts: new Map() });
  }

  private async runActions(turnId: string, actions: Action[], ctx: RunCtx): Promise<Flow> {
    for (const a of actions) {
      if (!this.live(turnId)) return "ended";
      switch (a.t) {
        case "sleep":
          await this.wait(turnId, a.ms);
          break;
        case "reasoning":
          this.emitItem({ id: ctx.idFor(a.key), type: "reasoning", text: a.text });
          break;
        case "assistant": {
          const id = ctx.idFor(a.key);
          this.emitItem({ id, type: "assistant_message", text: a.text, messageId: id });
          ctx.texts.set(a.key, a.text);
          break;
        }
        case "tool":
          this.emitTool(this.toolItem(a.key, a.spec, ctx), a.spec, a.status);
          break;
        case "permission":
          if ((await this.runPermission(turnId, a, ctx)) === "ended") return "ended";
          break;
        case "parallel":
          if ((await this.runParallel(turnId, a.children, ctx)) === "ended") return "ended";
          break;
        case "end":
          return this.finish(turnId, a.outcome, a.error, ctx);
      }
    }
    return this.live(turnId) ? "continue" : "ended";
  }

  /** Ends the turn the way a reply's `end` does: commit the text, then the terminal event (or hang). */
  private async finish(
    turnId: string,
    outcome: "completed" | "failed" | "canceled" | "hang",
    error: string | undefined,
    ctx: RunCtx,
    reason?: CancelReason,
  ): Promise<Flow> {
    if (!this.live(turnId)) return "ended";
    if (outcome === "hang") {
      await this.turn!.aborted;
      return "ended"; // endTurn already emitted the terminal event
    }
    if (ctx.texts.size > 0) {
      this.transcript.push({ id: this.d.newId(), type: "assistant_message", text: [...ctx.texts.values()].join("") });
      ctx.texts.clear();
    }
    const msg = outcome === "failed" ? (error ?? "scripted failure") : outcome === "canceled" ? (error ?? "scripted cancel") : undefined;
    this.endTurn(turnId, outcome, msg, outcome === "failed" ? "E_SCRIPTED" : undefined, reason);
    return "ended";
  }

  private toolItem(key: string, spec: ToolSpec, ctx: RunCtx): ToolItem {
    const id = ctx.idFor(key);
    return { id, type: "tool_call", callId: id, name: spec.name, detail: spec.detail };
  }

  private emitTool(item: ToolItem, spec: ToolSpec, status: "running" | "completed" | "failed" | "canceled", error?: string): void {
    this.emitItem(
      status === "failed" ? { ...item, status, error: error ?? spec.error ?? "scripted failure" } : { ...item, status, error: null },
    );
  }

  /** Shows a tool call as running and remembers it, so an early end can cancel it. */
  private openTool(turnId: string, item: ToolItem, spec: ToolSpec): void {
    this.emitTool(item, spec, "running");
    this.openTools.set(item.id, { turnId, item });
  }

  private closeTool(item: ToolItem, spec: ToolSpec, status: "running" | "completed" | "failed" | "canceled", error?: string): void {
    this.openTools.delete(item.id);
    this.emitTool(item, spec, status, error);
  }

  /** Raises a card; resolves with the answer, or null if the turn ended first. */
  private raise(turnId: string, spec: PermissionSpec, tool?: ToolSpec): Promise<PermissionResponse | null> {
    const id = spec.id ?? this.d.newId();
    if (this.pending.has(id)) throw new Error(`permission id "${id}" is already pending`);
    const answered = new Promise<PermissionResponse>((answer) => this.pending.set(id, { turnId, spec, answer }));
    const request = buildRequest(spec, id, tool);
    this.d.recorder.record("permission_requested", { sessionId: this.logicalId, permissionId: id, cardKind: request.kind, name: request.name, step: this.step - 1 });
    this.d.emit({ type: "session.permission", sessionId: this.d.sessionId, request: request as never });
    return Promise.race([answered, this.turn!.aborted.then(() => null)]);
  }

  /** The tool's own result once its card is answered: allow → runningMs, then its status; deny → failed. */
  private async settle(turnId: string, item: ToolItem, spec: ToolSpec, r: PermissionResponse): Promise<void> {
    if (r.behavior === "deny") {
      this.closeTool(item, spec, "failed", r.message ?? "denied");
      return;
    }
    if (spec.runningMs && spec.runningMs > 0) await this.wait(turnId, spec.runningMs);
    if (this.live(turnId)) this.closeTool(item, spec, spec.status ?? "completed");
  }

  private async runPermission(turnId: string, a: Extract<Action, { t: "permission" }>, ctx: RunCtx): Promise<Flow> {
    const item = a.tool ? this.toolItem(a.key, a.tool, ctx) : undefined;
    if (item && a.tool) this.openTool(turnId, item, a.tool);
    const r = await this.raise(turnId, a.spec, a.tool);
    if (!r || !this.live(turnId)) return "ended";
    if (r.behavior === "deny" && r.interrupt) {
      if (item && a.tool) this.closeTool(item, a.tool, "failed", r.message ?? "denied");
      this.endTurn(turnId, "canceled", r.message ?? "denied", undefined, "interrupt_deny");
      return "ended";
    }
    if (item && a.tool) await this.settle(turnId, item, a.tool, r);
    if (!this.live(turnId)) return "ended";
    return this.runBranch(turnId, a.spec, r, ctx);
  }

  private async runBranch(turnId: string, spec: PermissionSpec, r: PermissionResponse, ctx: RunCtx): Promise<Flow> {
    const picked = selectBranch(spec, r);
    if (!picked) return "continue";
    const b = substituteBranch(picked.branch, permissionVars(spec, r));
    const steps: Step[] = [...(b.text !== undefined ? [{ kind: "message" as const, text: b.text }] : []), ...(b.steps ?? [])];
    if ((await this.runActions(turnId, planSteps(steps, this.d.newId), ctx)) === "ended") return "ended";
    return b.outcome ? this.finish(turnId, b.outcome, b.error, ctx, "branch_outcome") : "continue";
  }

  /**
   * Several cards at once: every tool and card is shown first, each answer settles its own tool as it
   * arrives, and once everything has settled the branches run in declaration order.
   */
  private async runParallel(turnId: string, children: Extract<Action, { t: "parallel" }>["children"], ctx: RunCtx): Promise<Flow> {
    const aborted = this.turn!.aborted;
    const tools = children.map((c) => (c.tool ? { item: this.toolItem(c.key, c.tool, ctx), spec: c.tool } : undefined));
    const takesTime = (spec: ToolSpec) => !!spec.runningMs && spec.runningMs > 0;
    children.forEach((c, i) => {
      const t = tools[i];
      if (!t) return;
      if (c.permission || takesTime(t.spec)) this.openTool(turnId, t.item, t.spec);
      else this.closeTool(t.item, t.spec, t.spec.status ?? "completed");
    });
    const asks = children.map((c) => (c.permission ? this.raise(turnId, c.permission, c.tool) : undefined));
    const answers: (PermissionResponse | undefined)[] = [];

    const settleChild = async (i: number): Promise<void> => {
      const t = tools[i];
      const ask = asks[i];
      if (!ask) {
        if (!t || !takesTime(t.spec)) return;
        await this.wait(turnId, t.spec.runningMs!);
        if (this.live(turnId)) this.closeTool(t.item, t.spec, t.spec.status ?? "completed");
        return;
      }
      const r = await ask;
      if (!r || !this.live(turnId)) return;
      answers[i] = r;
      if (r.behavior === "deny" && r.interrupt) {
        if (t) this.closeTool(t.item, t.spec, "failed", r.message ?? "denied");
        this.endTurn(turnId, "canceled", r.message ?? "denied", undefined, "interrupt_deny");
        return;
      }
      if (t) await this.settle(turnId, t.item, t.spec, r);
    };

    await Promise.race([Promise.all(children.map((_, i) => settleChild(i))), aborted]);
    if (!this.live(turnId)) return "ended";
    for (let i = 0; i < children.length; i++) {
      const spec = children[i].permission;
      const r = answers[i];
      if (!spec || !r) continue;
      if ((await this.runBranch(turnId, spec, r, ctx)) === "ended") return "ended";
    }
    return "continue";
  }
}
