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

export const ToolSpecSchema = z.object({
  name: z.string().min(1),
  detail: ToolDetailSchema,
  status: z.enum(["running", "completed", "failed", "canceled"]).optional(),
  runningMs: ms.optional(),
  error: z.string().optional(),
});

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
});

export const ScriptSchema = z.object({
  macros: z.record(z.string(), z.string()).optional(),
  scenarios: z.record(z.string(), z.array(ReplySchema)),
});

export type ToolSpec = z.infer<typeof ToolSpecSchema>;
export type Reply = z.infer<typeof ReplySchema>;
export type Script = z.infer<typeof ScriptSchema>;
