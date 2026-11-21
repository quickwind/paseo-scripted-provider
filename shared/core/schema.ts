import { z } from "zod";

const ms = z.number().int().min(0).max(3_600_000);

const loose = z.looseObject;
const optNum = z.number().optional();

/** Mirrors the SDK's ProviderToolCallDetail: the daemon rejects any other shape, which would stall a turn. */
export const ToolDetailSchema = z.discriminatedUnion("type", [
  loose({ type: z.literal("shell"), command: z.string(), cwd: z.string().optional(), output: z.string().optional(), exitCode: z.number().nullable().optional() }),
  loose({ type: z.literal("read"), filePath: z.string(), content: z.string().optional(), offset: optNum, limit: optNum }),
  loose({ type: z.literal("edit"), filePath: z.string(), oldString: z.string().optional(), newString: z.string().optional(), unifiedDiff: z.string().optional() }),
  loose({ type: z.literal("write"), filePath: z.string(), content: z.string().optional() }),
  loose({
    type: z.literal("search"),
    query: z.string(),
    toolName: z.enum(["search", "grep", "glob", "web_search"]).optional(),
    content: z.string().optional(),
    filePaths: z.array(z.string()).optional(),
    webResults: z.array(z.object({ title: z.string(), url: z.string() })).optional(),
    annotations: z.array(z.string()).optional(),
    numFiles: optNum,
    numMatches: optNum,
    durationMs: optNum,
    durationSeconds: optNum,
    truncated: z.boolean().optional(),
    mode: z.enum(["content", "files_with_matches", "count"]).optional(),
  }),
  loose({ type: z.literal("fetch"), url: z.string(), prompt: z.string().optional(), result: z.string().optional(), code: optNum, codeText: z.string().optional(), bytes: optNum, durationMs: optNum }),
  loose({
    type: z.literal("worktree_setup"),
    worktreePath: z.string(),
    branchName: z.string(),
    log: z.string(),
    commands: z.array(z.object({ index: z.number(), command: z.string(), cwd: z.string(), log: z.string(), status: z.enum(["running", "completed", "failed"]), exitCode: z.number().nullable(), durationMs: optNum })),
    truncated: z.boolean().optional(),
  }),
  loose({
    type: z.literal("sub_agent"),
    subAgentType: z.string().optional(),
    description: z.string().optional(),
    childSessionId: z.string().optional(),
    log: z.string(),
    actions: z.array(z.object({ index: z.number(), toolName: z.string(), summary: z.string().optional() })).optional(),
  }),
  loose({
    type: z.literal("plain_text"),
    label: z.string().optional(),
    text: z.string().optional(),
    icon: z.enum(["wrench", "square_terminal", "eye", "pencil", "search", "bot", "sparkles", "brain", "mic_vocal"]).optional(),
  }),
  loose({ type: z.literal("plan"), text: z.string() }),
  loose({ type: z.literal("unknown"), input: z.json(), output: z.json() }),
]);
export type ToolDetail = z.infer<typeof ToolDetailSchema>;

export const PermissionActionSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  behavior: z.enum(["allow", "deny"]),
  variant: z.enum(["primary", "secondary", "danger"]).optional(),
  intent: z.enum(["implement", "implement_resume", "dismiss"]).optional(),
});

/** One AskUserQuestion question; extra fields the app understands (preview, placeholder…) pass through. */
export const QuestionSchema = loose({
  header: z.string(),
  question: z.string(),
  options: z.array(loose({ label: z.string() })),
});

const jsonRecord = z.record(z.string(), z.json());
const outcome = z.enum(["completed", "failed", "canceled", "hang"]);

export type PermissionAction = z.infer<typeof PermissionActionSchema>;
export type Question = z.infer<typeof QuestionSchema>;

export interface ToolSpec {
  name: string;
  detail: ToolDetail;
  status?: "running" | "completed" | "failed" | "canceled";
  runningMs?: number;
  error?: string;
  permission?: PermissionSpec;
}

export interface PermissionSpec {
  id?: string;
  kind?: "tool" | "plan" | "question" | "mode" | "other";
  name?: string;
  title?: string;
  description?: string;
  input?: Record<string, z.core.util.JSONType>;
  detail?: ToolDetail;
  suggestions?: Record<string, z.core.util.JSONType>[];
  metadata?: Record<string, z.core.util.JSONType>;
  plan?: string;
  questions?: Question[];
  actions?: PermissionAction[];
  on?: Record<string, Branch>;
}

export interface Branch {
  text?: string;
  steps?: Step[];
  outcome?: "completed" | "failed" | "canceled" | "hang";
  error?: string;
}

export interface Step {
  kind: "reasoning" | "message" | "tool" | "permission" | "parallel";
  delayMs?: number;
  text?: string;
  tool?: ToolSpec;
  permission?: PermissionSpec;
  steps?: Step[];
}

export const BranchSchema: z.ZodType<Branch> = z.lazy(() =>
  z.object({
    text: z.string().optional(),
    steps: z.array(StepSchema).optional(),
    outcome: outcome.optional(),
    error: z.string().optional(),
  }),
);

export const PermissionSpecSchema: z.ZodType<PermissionSpec> = z.lazy(() =>
  z.object({
    id: z.string().min(1).optional(),
    kind: z.enum(["tool", "plan", "question", "mode", "other"]).optional(),
    name: z.string().min(1).optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    input: jsonRecord.optional(),
    detail: ToolDetailSchema.optional(),
    suggestions: z.array(jsonRecord).optional(),
    metadata: jsonRecord.optional(),
    plan: z.string().optional(),
    questions: z.array(QuestionSchema).min(1).optional(),
    actions: z.array(PermissionActionSchema).optional(),
    on: z.record(z.string(), BranchSchema).optional(),
  }),
);

export const ToolSpecSchema: z.ZodType<ToolSpec> = z.lazy(() =>
  z.object({
    name: z.string().min(1),
    detail: ToolDetailSchema,
    status: z.enum(["running", "completed", "failed", "canceled"]).optional(),
    runningMs: ms.optional(),
    error: z.string().optional(),
    permission: PermissionSpecSchema.optional(),
  }),
);

/** The explicit card id of a parallel child, if it has one. */
function childId(s: Step): string | undefined {
  return s.permission?.id ?? s.tool?.permission?.id;
}

/**
 * One timed step of a reply, in the order the original agent produced it.
 *
 * A recorded conversation keeps its real pacing here: `delayMs` is the gap to the previous event,
 * so thinking time, every tool call and every message keep their own duration and a replay takes
 * as long as the original turn did. Hand-written scripts normally use `text`/`messages`/`tools`
 * instead and ignore this.
 *
 * `permission` raises a permission card and waits for the answer; `parallel` raises several at once.
 */
export const StepSchema: z.ZodType<Step> = z.lazy(() =>
  z
    .object({
      kind: z.enum(["reasoning", "message", "tool", "permission", "parallel"]),
      /** Wait before this step is emitted: the gap to the previous event. */
      delayMs: z.number().int().min(0).optional(),
      /** The text of a reasoning or message step. */
      text: z.string().optional(),
      /** The tool a tool step calls. */
      tool: ToolSpecSchema.optional(),
      /** The card a permission step raises. */
      permission: PermissionSpecSchema.optional(),
      /** The children of a parallel step: tool and permission steps only. */
      steps: z.array(StepSchema).optional(),
    })
    .superRefine(function (s, ctx) {
      if (s.kind === "permission" && !s.permission) {
        ctx.addIssue({ code: "custom", path: ["permission"], message: "a permission step needs `permission`" });
      }
      if (s.kind !== "parallel") return;
      if (!s.steps || s.steps.length === 0) {
        ctx.addIssue({ code: "custom", path: ["steps"], message: "a parallel step needs `steps`" });
        return;
      }
      const seen = new Set<string>();
      s.steps.forEach(function (child, i) {
        if (child.kind !== "tool" && child.kind !== "permission") {
          ctx.addIssue({ code: "custom", path: ["steps", i, "kind"], message: "parallel children must be tool or permission steps" });
        }
        const id = childId(child);
        if (id === undefined) return;
        if (seen.has(id)) ctx.addIssue({ code: "custom", path: ["steps", i], message: `duplicate permission id "${id}" in a parallel group` });
        seen.add(id);
      });
    }),
);

export const ReplySchema = z.object({
  text: z.string().optional(),
  reasoning: z.string().optional(),
  chunks: z.array(z.string()).optional(),
  chunkDelayMs: ms.optional(),
  messages: z.array(z.string()).optional(),
  toolBetween: z.boolean().optional(),
  tools: z.array(ToolSpecSchema).optional(),
  startDelayMs: ms.optional(),
  delayMs: ms.optional(),
  outcome: z.enum(["completed", "failed", "canceled", "hang"]).optional(),
  error: z.string().optional(),
  expect: z.string().optional(),
  steps: z.array(StepSchema).optional(),
});

export const ScriptSchema = z.object({
  macros: z.record(z.string(), z.string()).optional(),
  scenarios: z.record(z.string(), z.array(ReplySchema)),
});

export type Reply = z.infer<typeof ReplySchema>;
export type Script = z.infer<typeof ScriptSchema>;
