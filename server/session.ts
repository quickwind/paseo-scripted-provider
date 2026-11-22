import type { ProviderConfigChanges, ProviderConfigState, ProviderEvent, ProviderPrompt, ProviderSetting } from "@getpaseo/plugin/server/provider";
import type { Clock, NewId } from "../shared/core/clock";
import { buildRequest, permissionVars, selectBranch, substituteBranch, answersOf, type PermissionResponse } from "../shared/core/permission";
import { planReply, planSteps, type Action } from "../shared/core/planner";
import type { Recorder } from "../shared/core/recorder";
import type { Branch, PermissionSpec, Script, Step, ToolSpec } from "../shared/core/schema";
import { matchStep, resolveReply, scenarioNames } from "../shared/core/script";
import { buildSessionVars, hydrateValue } from "../shared/core/template";

export interface Persisted {
  logicalId: string;
  scenario: string | null;
  step: number;
  /** Full timeline item snapshots (v2); v1 stored only user_message/assistant_message objects. */
  transcript: Record<string, unknown>[];
  mode?: string | null;
  thinkingOption?: string | null;
  providerOptions?: Record<string, unknown>;
}

export type Alignment = "warn" | "strict" | "ignore";

export interface SessionDeps {
  sessionId: string;
  script: () => Script;
  clock: Clock;
  newId: NewId;
  recorder: Recorder | (() => Recorder);
  alignment: Alignment | (() => Alignment);
  emit: (e: ProviderEvent) => void;
  persisted?: Persisted;
  initialScenario?: string;
  cwd?: string;
  initialMode?: string | null;
  initialThinkingOption?: string | null;
  initialProviderOptions?: Record<string, unknown>;
  delayScale?: number | (() => number | undefined);
}

export function promptText(p: ProviderPrompt): string {
  if (p.input.type === "command") return `/${p.input.name} ${p.input.arguments}`;
  // Plain user text only: text *attachments* (which carry a mimeType) are not part of what the user typed.
  return p.input.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && !("mimeType" in c))
    .map((c) => c.text)
    .join("\n");
}

/** Compact, structured summary of non-plain-text prompt attachments for `received.jsonl`. */
export function summarizeAttachments(p: ProviderPrompt): Record<string, unknown>[] {
  if (p.input.type !== "message") return [];
  const out: Record<string, unknown>[] = [];
  for (const c of p.input.content) {
    if (c.type === "text" && !("mimeType" in c)) continue;
    if (c.type === "image") {
      out.push({ type: "image", mimeType: c.mimeType, dataBytes: c.data.length });
    } else if (c.type === "review") {
      out.push({
        type: "review",
        mimeType: c.mimeType,
        cwd: c.cwd,
        mode: c.mode,
        ...(c.baseRef !== undefined ? { baseRef: c.baseRef } : {}),
        commentCount: c.comments.length,
        comments: c.comments.map((cm) => ({ filePath: cm.filePath, side: cm.side, lineNumber: cm.lineNumber, body: cm.body })),
      });
    } else {
      out.push({ ...(c as Record<string, unknown>) });
    }
  }
  return out;
}

interface ActiveTurn {
  id: string;
  abort: () => void;
  aborted: Promise<void>;
  ctx: RunCtx;
  onSteer?: Branch;
}

/** Why a card was resolved without an answer. */
export type CancelReason = "interrupted" | "superseded" | "interrupt_deny" | "branch_outcome" | "failed";

interface PendingCard {
  turnId: string;
  spec: PermissionSpec;
  answer: (r: PermissionResponse) => void;
}

type ToolItem = {
  id: string;
  type: "tool_call";
  callId: string;
  name: string;
  detail: unknown;
  metadata?: Record<string, unknown>;
  revertToken?: unknown;
};

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
  private mode: string | null;
  private thinkingOption: string | null;
  private providerOptions: Record<string, unknown>;
  private lastPromptText = "";
  private lastSteerText: string | undefined;
  private turn: ActiveTurn | null = null;
  /** Cards waiting for an answer, by permission id. */
  private pending = new Map<string, PendingCard>();
  /** Tool calls shown as running, by item id (canceled if their turn ends early). */
  private openTools = new Map<string, { turnId: string; item: ToolItem }>();

  constructor(private d: SessionDeps) {
    const script = d.script();
    this.scenario = d.persisted?.scenario ?? d.initialScenario ?? null;
    this.step = d.persisted?.step ?? 0;
    this.logicalId = d.persisted?.logicalId ?? d.sessionId;
    this.transcript = [...(d.persisted?.transcript ?? [])];
    this.mode = d.persisted?.mode ?? d.initialMode ?? script.defaultMode ?? null;
    this.thinkingOption = d.persisted?.thinkingOption ?? d.initialThinkingOption ?? script.defaultThinkingOption ?? null;
    this.providerOptions = { ...(d.persisted?.providerOptions ?? d.initialProviderOptions ?? {}) };
  }

  get id(): string {
    return this.logicalId;
  }

  get activeTurn(): string | null {
    return this.turn?.id ?? null;
  }

  persistence(): Persisted {
    return {
      logicalId: this.logicalId,
      scenario: this.scenario,
      step: this.step,
      transcript: [...this.transcript],
      ...(this.mode !== null ? { mode: this.mode } : {}),
      ...(this.thinkingOption !== null ? { thinkingOption: this.thinkingOption } : {}),
      ...(Object.keys(this.providerOptions).length > 0 ? { providerOptions: { ...this.providerOptions } } : {}),
    };
  }

  replay(): Persisted["transcript"] {
    return this.transcript;
  }

  /** Builds a `session.config` payload dual-written for 0.16 (`controls`/`providerOptions`) and 0.12 (`settings`). */
  configState(): ProviderConfigState {
    const script = this.d.script();
    const all = Array.from(new Set(["default", ...scenarioNames(script)]));
    const controls = script.controls ?? [];
    const settings: ProviderSetting[] = controls.map((c) => {
      const current = this.providerOptions[c.key];
      if (c.type === "toggle") {
        return {
          type: "toggle",
          id: c.key,
          label: c.label,
          ...(c.description ? { description: c.description } : {}),
          value: typeof current === "boolean" ? current : (c.defaultValue ?? false),
        };
      }
      return {
        type: "select",
        id: c.key,
        label: c.label,
        ...(c.description ? { description: c.description } : {}),
        value: typeof current === "string" ? current : (c.defaultValue ?? null),
        options: c.choices.map((ch) => ({ label: ch.label, value: ch.value })),
      };
    });
    return {
      model: this.scenario ?? "default",
      ...(this.mode !== null ? { mode: this.mode } : {}),
      ...(this.thinkingOption !== null ? { thinkingOption: this.thinkingOption } : {}),
      models: all.map((id) => ({ id, label: id, isDefault: id === "default" })),
      modes: script.modes ?? [],
      thinkingOptions: script.thinkingOptions ?? [],
      ...(controls.length > 0 ? { controls } : {}),
      ...(Object.keys(this.providerOptions).length > 0 ? { providerOptions: { ...this.providerOptions } as never } : {}),
      settings,
    };
  }

  emitConfig(): void {
    this.d.emit({
      type: "session.config",
      sessionId: this.d.sessionId,
      config: this.configState(),
    });
  }

  emitCommands(): void {
    const commands = this.d.script().commands;
    if (commands && commands.length > 0) {
      this.d.emit({
        type: "session.commands",
        sessionId: this.d.sessionId,
        commands,
      });
    }
  }

  configure(changes: ProviderConfigChanges): void {
    if (changes.model !== undefined) {
      this.scenario = changes.model === null ? null : changes.model;
    }
    if (changes.mode !== undefined) {
      this.mode = changes.mode;
    }
    if (changes.thinkingOption !== undefined) {
      this.thinkingOption = changes.thinkingOption;
    }
    const merged = { ...(changes.settings ?? {}), ...(changes.providerOptions ?? {}) };
    for (const [k, v] of Object.entries(merged)) {
      if (v === null) delete this.providerOptions[k];
      else this.providerOptions[k] = v;
    }
    this.d.emit({
      type: "session.persistence",
      sessionId: this.d.sessionId,
      persistence: { version: 2, data: this.persistence() as unknown as never },
    });
    this.emitConfig();
  }

  private setMode(mode: string): void {
    this.mode = mode;
    this.emitConfig();
  }

  private templateVars(): Record<string, string> {
    return buildSessionVars({
      cwd: this.d.cwd,
      model: this.scenario ?? "default",
      mode: this.mode,
      thinkingOption: this.thinkingOption,
      promptText: this.lastPromptText,
      steerText: this.lastSteerText,
    });
  }

  private upsertTranscript(item: Record<string, unknown>): void {
    const id = typeof item.id === "string" ? item.id : undefined;
    if (id) {
      const idx = this.transcript.findIndex((t) => t.id === id);
      if (idx >= 0) {
        this.transcript[idx] = item;
        return;
      }
    }
    this.transcript.push(item);
  }

  private getRecorder(): Recorder {
    return typeof this.d.recorder === "function" ? this.d.recorder() : this.d.recorder;
  }

  private getAlignment(): Alignment {
    return typeof this.d.alignment === "function" ? this.d.alignment() : this.d.alignment;
  }

  prompt(p: ProviderPrompt): void {
    const { emit } = this.d;
    const recorder = this.getRecorder();
    const alignment = this.getAlignment();
    const sid = this.d.sessionId;
    const text = promptText(p);
    // Mid-turn steer: absorb into the active turn without canceling it.
    if (this.turn && p.delivery === "steer") {
      const active = this.turn;
      const attachments = summarizeAttachments(p);
      recorder.record("prompt", {
        sessionId: this.logicalId,
        providerSessionId: sid,
        scenario: this.scenario,
        step: this.step,
        delivery: p.delivery,
        steeredTurnId: active.id,
        clientMessageId: p.clientMessageId,
        activeTurnAtArrival: active.id,
        text,
        contentTypes: p.input.type === "message" ? p.input.content.map((c) => c.type) : ["command"],
        ...(attachments.length ? { attachments } : {}),
        ...(p.input.type === "command" ? { command: { name: p.input.name, arguments: p.input.arguments } } : {}),
        ...(p.outputSchema !== undefined ? { outputSchema: p.outputSchema } : {}),
        ...(p.clearPendingPermissions !== undefined ? { clearPendingPermissions: p.clearPendingPermissions } : {}),
      });
      this.lastSteerText = text;
      this.upsertTranscript({ id: p.clientMessageId, type: "user_message", text, messageId: p.clientMessageId });
      if (p.clearPendingPermissions) {
        this.clearPendingCards(active.id, "superseded");
      }
      emit({ type: "session.prompt_result", sessionId: sid, clientMessageId: p.clientMessageId, result: { type: "steer", turnId: active.id } });
      if (active.onSteer) {
        const b = active.onSteer;
        void this.runBranchBody(active.id, b, active.ctx).catch((e) => {
          console.error("[scripted-provider] steer branch failed", e);
          this.endTurn(active.id, "failed", `scripted steer failed: ${e instanceof Error ? e.message : String(e)}`, "E_SCRIPT_RUNTIME", "failed");
        });
      }
      return;
    }

    const m = /^SCENARIO:([\w-]+)/.exec(text.trim());
    if (m) {
      this.scenario = m[1];
      this.step = 0;
    }
    const script = this.d.script();
    const scenario = this.scenario ?? "default";
    // warn (default): answer by content when the script has recorded `expect`s; strict/ignore: by order.
    const step = alignment === "warn" && !m ? matchStep(script, scenario, this.step, text) : this.step;
    const { reply, exhausted } = resolveReply(script, scenario, step);
    const attachments = summarizeAttachments(p);
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
      ...(attachments.length ? { attachments } : {}),
      ...(p.input.type === "command" ? { command: { name: p.input.name, arguments: p.input.arguments } } : {}),
      ...(p.outputSchema !== undefined ? { outputSchema: p.outputSchema } : {}),
      ...(p.clearPendingPermissions !== undefined ? { clearPendingPermissions: p.clearPendingPermissions } : {}),
    });
    if (exhausted) {
      recorder.record("exhausted", { sessionId: this.logicalId, scenario, step });
      emit({
        type: "session.prompt_result",
        sessionId: sid,
        clientMessageId: p.clientMessageId,
        result: {
          type: "failed",
          error: { message: `Scenario "${scenario}" exhausted at step ${step}`, code: "E_SCRIPT_EXHAUSTED" },
        },
      });
      return;
    }
    if (reply.expect !== undefined && reply.expect.trim() !== text.trim()) {
      recorder.record("mismatch", { sessionId: this.logicalId, step, expected: reply.expect, actual: text, mode: alignment });
      if (alignment === "strict") {
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
    this.lastPromptText = text;
    this.step = step + 1;
    this.upsertTranscript({ id: p.clientMessageId, type: "user_message", text, messageId: p.clientMessageId });
    if (this.turn) this.endTurn(this.turn.id, "canceled", "superseded by new prompt", undefined, "superseded");

    const id = this.d.newId();
    let abort!: () => void;
    const aborted = new Promise<void>((r) => (abort = r));
    const ids = new Map<string, string>();
    const idFor = (k: string) => {
      let v = ids.get(k);
      if (!v) ids.set(k, (v = this.d.newId()));
      return v;
    };
    const ctx: RunCtx = { idFor, texts: new Map() };
    this.turn = { id, abort, aborted, ctx, onSteer: reply.onSteer };
    emit({ type: "session.prompt_result", sessionId: sid, clientMessageId: p.clientMessageId, result: { type: "turn", turnId: id } });
    emit({ type: "session.turn", sessionId: sid, turnId: id, state: "started" });
    void this.runActions(id, planReply(reply, this.d.newId), ctx).catch((e) => {
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
      this.getRecorder().record("permission_unknown", { sessionId: this.logicalId, permissionId });
      return;
    }
    this.pending.delete(permissionId);
    this.d.emit({ type: "session.permission_resolved", sessionId: this.d.sessionId, permissionId });
    this.getRecorder().record("permission_response", {
      sessionId: this.logicalId,
      permissionId,
      behavior: response.behavior,
      selectedActionId: response.selectedActionId,
      message: response.behavior === "deny" ? response.message : undefined,
      interrupt: response.behavior === "deny" ? response.interrupt : undefined,
      answers: answersOf(response),
      ...(response.behavior === "allow" && response.updatedInput !== undefined ? { updatedInput: response.updatedInput } : {}),
      ...(response.behavior === "allow" && response.updatedPermissions !== undefined ? { updatedPermissions: response.updatedPermissions } : {}),
      branch: selectBranch(card.spec, response)?.key ?? null,
    });
    card.answer(response);
  }

  interrupt(requestId: string): void {
    this.getRecorder().record("interrupt", { sessionId: this.logicalId, activeTurn: this.activeTurn });
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
    diagnostic?: string,
    runtimeFailed?: boolean,
  ): void {
    if (this.turn?.id !== turnId) return;
    const t = this.turn;
    this.turn = null;
    this.closeOpen(turnId, reason);
    t.abort();
    this.d.emit({
      type: "session.persistence",
      sessionId: this.d.sessionId,
      persistence: { version: 2, data: this.persistence() as unknown as never },
    });
    const errorObj = message ? { message, ...(code ? { code } : {}), ...(diagnostic ? { diagnostic } : {}) } : undefined;
    if (runtimeFailed) {
      this.d.emit({
        type: "session.runtime_failed",
        sessionId: this.d.sessionId,
        error: errorObj ?? { message: "scripted runtime failure", ...(code ? { code } : {}), ...(diagnostic ? { diagnostic } : {}) },
      });
    }
    this.d.emit({
      type: "session.turn",
      sessionId: this.d.sessionId,
      turnId,
      state,
      ...(errorObj ? { error: errorObj } : {}),
    });
  }

  private clearPendingCards(turnId: string, reason: CancelReason): void {
    for (const [permissionId, card] of [...this.pending]) {
      if (card.turnId !== turnId) continue;
      this.pending.delete(permissionId);
      this.d.emit({ type: "session.permission_resolved", sessionId: this.d.sessionId, permissionId });
      this.getRecorder().record("permission_canceled", { sessionId: this.logicalId, permissionId, reason });
    }
  }

  private closeOpen(turnId: string, reason: CancelReason): void {
    this.clearPendingCards(turnId, reason);
    for (const [id, open] of [...this.openTools]) {
      if (open.turnId !== turnId) continue;
      this.openTools.delete(id);
      this.emitItem({ ...open.item, status: "canceled", error: null });
    }
  }

  private emitItem(item: Record<string, unknown>): void {
    const hydrated = hydrateValue(item, this.templateVars());
    this.d.emit({
      type: "timeline.item",
      sessionId: this.d.sessionId,
      item: hydrated as never,
      timestamp: new Date(this.d.clock.now()).toISOString(),
    });
    this.upsertTranscript(hydrated);
  }

  private live(turnId: string): boolean {
    return this.turn?.id === turnId;
  }

  private getDelayScale(): number {
    const raw = typeof this.d.delayScale === "function" ? this.d.delayScale() : this.d.delayScale;
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 1;
  }

  /** Resolves after `ms` (scaled by `delayScale`), or as soon as the turn ends. */
  private wait(turnId: string, ms: number): Promise<void> {
    if (this.turn?.id !== turnId) return Promise.resolve();
    const scaled = Math.round(ms * this.getDelayScale());
    if (scaled <= 0) return Promise.resolve();
    return Promise.race([this.d.clock.sleep(scaled), this.turn.aborted]);
  }

  private async runActions(turnId: string, actions: Action[], ctx: RunCtx): Promise<Flow> {
    for (const a of actions) {
      if (!this.live(turnId)) return "ended";
      switch (a.t) {
        case "sleep":
          await this.wait(turnId, a.ms);
          break;
        case "reasoning":
          this.emitItem({
            id: ctx.idFor(a.key),
            type: "reasoning",
            text: a.text,
            ...(a.revertToken !== undefined ? { revertToken: a.revertToken } : {}),
          });
          break;
        case "assistant": {
          const id = ctx.idFor(a.key);
          this.emitItem({
            id,
            type: "assistant_message",
            text: a.text,
            messageId: id,
            ...(a.revertToken !== undefined ? { revertToken: a.revertToken } : {}),
          });
          ctx.texts.set(a.key, a.text);
          break;
        }
        case "tool":
          this.emitTool(this.toolItem(a.key, a.spec, ctx), a.spec, a.status);
          break;
        case "todo":
          this.emitItem({
            id: ctx.idFor(a.key),
            type: "todo",
            items: a.items,
            ...(a.revertToken !== undefined ? { revertToken: a.revertToken } : {}),
          });
          break;
        case "compaction":
          this.emitItem({
            id: ctx.idFor(a.key),
            type: "compaction",
            status: a.status,
            ...(a.trigger ? { trigger: a.trigger } : {}),
            ...(a.preTokens !== undefined ? { preTokens: a.preTokens } : {}),
            ...(a.revertToken !== undefined ? { revertToken: a.revertToken } : {}),
          });
          break;
        case "notification":
          this.emitItem({
            id: ctx.idFor(a.key),
            type: "notification",
            level: a.level,
            message: a.message,
            ...(a.revertToken !== undefined ? { revertToken: a.revertToken } : {}),
          });
          break;
        case "error":
          this.emitItem({
            id: ctx.idFor(a.key),
            type: "error",
            message: a.message,
            ...(a.revertToken !== undefined ? { revertToken: a.revertToken } : {}),
          });
          break;
        case "plugin":
          this.emitItem({
            id: ctx.idFor(a.key),
            type: "plugin",
            pluginId: a.pluginId,
            kind: a.kind,
            version: a.version,
            data: a.data,
            ...(a.revertToken !== undefined ? { revertToken: a.revertToken } : {}),
          });
          break;
        case "usage":
          this.d.emit({
            type: "session.usage",
            sessionId: this.d.sessionId,
            turnId,
            usage: a.usage,
          });
          break;
        case "notice":
          this.d.emit({
            type: "session.notice",
            sessionId: this.d.sessionId,
            notice: {
              id: a.notice.id ?? this.d.newId(),
              severity: a.notice.severity,
              title: a.notice.title,
              ...(a.notice.description !== undefined ? { description: a.notice.description } : {}),
              ...(a.notice.dismissed !== undefined ? { dismissed: a.notice.dismissed } : {}),
            },
          });
          break;
        case "permission":
          if ((await this.runPermission(turnId, a, ctx)) === "ended") return "ended";
          break;
        case "parallel":
          if ((await this.runParallel(turnId, a.children, ctx)) === "ended") return "ended";
          break;
        case "end":
          return this.finish(turnId, a.outcome, a.error, ctx, undefined, a.errorCode, a.diagnostic, a.runtimeFailed);
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
    errorCode?: string,
    diagnostic?: string,
    runtimeFailed?: boolean,
  ): Promise<Flow> {
    if (!this.live(turnId)) return "ended";
    if (outcome === "hang") {
      await this.turn!.aborted;
      return "ended"; // endTurn already emitted the terminal event
    }
    ctx.texts.clear();
    const msg = outcome === "failed" ? (error ?? "scripted failure") : outcome === "canceled" ? (error ?? "scripted cancel") : undefined;
    const code = errorCode ?? (outcome === "failed" ? "E_SCRIPTED" : undefined);
    this.endTurn(turnId, outcome, msg, code, reason, diagnostic, runtimeFailed);
    return "ended";
  }

  private toolItem(key: string, spec: ToolSpec, ctx: RunCtx): ToolItem {
    const id = ctx.idFor(key);
    return {
      id,
      type: "tool_call",
      callId: id,
      name: spec.name,
      detail: spec.detail,
      ...(spec.metadata ? { metadata: spec.metadata } : {}),
      ...(spec.revertToken !== undefined ? { revertToken: spec.revertToken } : {}),
    };
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
    let answer!: (r: PermissionResponse) => void;
    const answered = new Promise<PermissionResponse>((r) => (answer = r));
    const request = hydrateValue(buildRequest(spec, id, tool), this.templateVars());
    // Emit first: a card the daemon rejects throws here and is never registered, so ending the
    // turn has no card to resolve (and nothing invalid to emit again).
    this.d.emit({ type: "session.permission", sessionId: this.d.sessionId, request: request as never });
    this.pending.set(id, { turnId, spec, answer });
    this.getRecorder().record("permission_requested", { sessionId: this.logicalId, permissionId: id, cardKind: request.kind, name: request.name, step: this.step - 1 });
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
      return this.finish(turnId, "canceled", r.message ?? "denied", ctx, "interrupt_deny");
    }
    if (item && a.tool) await this.settle(turnId, item, a.tool, r);
    if (!this.live(turnId)) return "ended";
    return this.runBranch(turnId, a.spec, r, ctx);
  }

  private async runBranch(turnId: string, spec: PermissionSpec, r: PermissionResponse, ctx: RunCtx): Promise<Flow> {
    const picked = selectBranch(spec, r);
    if (!picked) return "continue";
    const b = substituteBranch(picked.branch, permissionVars(spec, r));
    return this.runBranchBody(turnId, b, ctx);
  }

  private async runBranchBody(turnId: string, b: Branch, ctx: RunCtx): Promise<Flow> {
    if (b.setMode) this.setMode(b.setMode);
    const steps: Step[] = [
      ...(b.notices ?? []).map((notice): Step => ({ kind: "notice", notice })),
      ...(b.text !== undefined ? [{ kind: "message" as const, text: b.text }] : []),
      ...(b.steps ?? []),
      ...(b.usage ? [{ kind: "usage" as const, usage: b.usage }] : []),
    ];
    if ((await this.runActions(turnId, planSteps(steps, this.d.newId), ctx)) === "ended") return "ended";
    return b.outcome
      ? this.finish(turnId, b.outcome, b.error, ctx, "branch_outcome", b.errorCode, b.diagnostic, b.runtimeFailed)
      : "continue";
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
        this.finish(turnId, "canceled", r.message ?? "denied", ctx, "interrupt_deny");
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
