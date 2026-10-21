import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { ScriptSchema } from "./core/schema";

const formatSchema = z.enum(["json", "yaml"]);

export const scriptedSettings = defineSettings({
  id: "scripted-provider",
  scope: "host",
  version: 1,
  schema: z.object({
    scripts: z.string().default(""),
    scriptFile: z.string().default(""),
    recordFile: z.string().default(""),
    alignment: z.enum(["warn", "strict", "ignore"]).default("warn"),
  }),
});

export const getStatusRpc = defineRpc({
  name: "scripted.status",
  input: z.object({}),
  output: z.object({
    scenarios: z.array(z.string()),
    error: z.string().nullable(),
    recordFile: z.string().nullable(),
  }),
});

export const readRecordRpc = defineRpc({
  name: "scripted.read-record",
  input: z.object({ limit: z.number().int().min(1).max(1000).optional() }),
  output: z.object({ lines: z.array(z.string()) }),
});

export const captureRpc = defineRpc({
  name: "scripted.capture",
  input: z.object({ agentId: z.string() }),
  output: z.object({
    entries: z.array(z.unknown()),
    agent: z
      .object({
        id: z.string(),
        cwd: z.string().nullable(),
        title: z.string().nullable(),
        provider: z.string().nullable(),
        model: z.string().nullable(),
      })
      .nullable(),
  }),
});

/**
 * Serializes a script to text. The daemon owns the YAML parser: the client bundle stays free of it,
 * so the mobile app never has to evaluate the parser (and the plugin client bundle halves in size).
 */
export const exportScriptRpc = defineRpc({
  name: "scripted.export",
  input: z.object({ script: ScriptSchema, format: formatSchema }),
  output: z.object({ text: z.string() }),
});

/** Adds a recorded scenario to the user's existing script text, keeping the user's format and comments. */
export const mergeScenarioRpc = defineRpc({
  name: "scripted.merge-scenario",
  input: z.object({
    script: ScriptSchema,
    name: z.string(),
    existingText: z.string(),
    format: formatSchema.optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    text: z.string().optional(),
    name: z.string().optional(),
    error: z.string().optional(),
  }),
});

