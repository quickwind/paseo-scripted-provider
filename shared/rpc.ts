import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

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
