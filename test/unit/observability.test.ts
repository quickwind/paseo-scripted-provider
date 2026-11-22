import { describe, expect, it } from "vitest";
import { createScriptedProvider, negotiateCapabilities } from "../../server/provider";
import { summarizeAttachments } from "../../server/session";
import { ManualClock } from "../helpers/manual-clock";

describe("negotiateCapabilities", () => {
  it("intersects offered daemon capabilities with supported capabilities", () => {
    expect(negotiateCapabilities(["prompt.message", "permission", "future.cap"], ["prompt.message", "session.persistence", "permission"])).toEqual([
      "prompt.message",
      "permission",
    ]);
  });

  it("returns all supported capabilities when host offers none", () => {
    expect(negotiateCapabilities(undefined, ["prompt.message", "permission"])).toEqual(["prompt.message", "permission"]);
  });
});

describe("summarizeAttachments", () => {
  it("summarizes images, reviews, text attachments, PRs and uploaded files without plain user text", () => {
    const summary = summarizeAttachments({
      clientMessageId: "c1",
      delivery: "auto",
      input: {
        type: "message",
        content: [
          { type: "text", text: "plain user text" },
          { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
          { type: "text", mimeType: "text/plain", title: "Note", contextKind: "file", text: "attached" },
          {
            type: "review",
            mimeType: "application/paseo-review",
            cwd: "/repo",
            mode: "uncommitted",
            baseRef: "main",
            comments: [
              {
                filePath: "a.ts",
                side: "new",
                lineNumber: 10,
                body: "fix this",
                context: { hunkHeader: "@@ -1 +1 @@", targetLine: { oldLineNumber: null, newLineNumber: 10, type: "add", content: "x" }, lines: [] },
              },
            ],
          },
          { type: "uploaded_file", id: "u1", fileName: "spec.md", mimeType: "text/markdown", size: 120, path: "/tmp/spec.md" },
        ],
      },
    });

    expect(summary).toEqual([
      { type: "image", mimeType: "image/png", dataBytes: 8 },
      { type: "text", mimeType: "text/plain", title: "Note", contextKind: "file", text: "attached" },
      {
        type: "review",
        mimeType: "application/paseo-review",
        cwd: "/repo",
        mode: "uncommitted",
        baseRef: "main",
        commentCount: 1,
        comments: [{ filePath: "a.ts", side: "new", lineNumber: 10, body: "fix this" }],
      },
      { type: "uploaded_file", id: "u1", fileName: "spec.md", mimeType: "text/markdown", size: 120, path: "/tmp/spec.md" },
    ]);
  });
});

describe("provider inbound observability (received.jsonl)", () => {
  it("negotiates capabilities and records full open config, prompt metadata, updatedInput, configure, and close", async () => {
    const records: { kind: string; data: Record<string, unknown> }[] = [];
    const clock = new ManualClock();
    let seq = 0;
    const provider = createScriptedProvider({
      getScript: () => ({
        scenarios: {
          obs: [
            {
              tools: [
                {
                  name: "Bash",
                  detail: { type: "shell", command: "ls" },
                  permission: { id: "perm-1" },
                },
              ],
              text: "done",
            },
          ],
        },
      }),
      getConfig: () => ({ alignment: "warn", recordFile: "/tmp/fake.jsonl" }),
      clock,
      newId: () => `id-${++seq}`,
      recorder: () => ({ record: (kind, data) => records.push({ kind, data }) }),
    });

    const conn = await provider.connect({ versions: [1], capabilities: ["prompt.message", "permission"] });
    expect(conn.capabilities).toEqual(["prompt.message", "permission"]);

    const events: unknown[] = [];
    conn.onEvent((e) => events.push(e));

    await conn.send({
      type: "session.open",
      requestId: "r-open",
      sessionId: "s1",
      history: "skip",
      config: {
        cwd: "/work/repo",
        env: { CUSTOM_FLAG: "1" },
        systemPrompt: "Be concise",
        mcpServers: { docs: { type: "stdio", command: "node", args: ["mcp.js"] } },
        toolPolicy: { preapproved: [{ kind: "mcp", server: "docs", tool: "search" }] },
        model: "obs",
        mode: "plan",
        thinkingOption: "high",
        providerOptions: { fast_mode: true },
        settings: { legacy: "v" },
        title: "Obs Test",
        persist: true,
      },
    });

    const opened = events.find((e) => (e as { type: string }).type === "session.opened") as { capabilities: string[] };
    expect(opened.capabilities).toEqual(["prompt.message", "permission"]);

    const openRec = records.find((r) => r.kind === "open");
    expect(openRec?.data).toMatchObject({
      sessionId: "s1",
      cwd: "/work/repo",
      env: { CUSTOM_FLAG: "1" },
      systemPrompt: "Be concise",
      mcpServers: { docs: { type: "stdio", command: "node", args: ["mcp.js"] } },
      toolPolicy: { preapproved: [{ kind: "mcp", server: "docs", tool: "search" }] },
      model: "obs",
      mode: "plan",
      thinkingOption: "high",
      providerOptions: { fast_mode: true },
      settings: { legacy: "v" },
      title: "Obs Test",
      persist: true,
    });

    await conn.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        outputSchema: { type: "object" },
        clearPendingPermissions: true,
        input: {
          type: "message",
          content: [
            { type: "text", text: "run it" },
            { type: "github_pr", mimeType: "application/github-pr", number: 42, title: "Fix", url: "https://github.com/a/b/pull/42" },
          ],
        },
      },
    });

    const promptRec = records.find((r) => r.kind === "prompt");
    expect(promptRec?.data).toMatchObject({
      text: "run it",
      outputSchema: { type: "object" },
      clearPendingPermissions: true,
      attachments: [{ type: "github_pr", number: 42, title: "Fix" }],
    });

    await conn.send({
      type: "session.permission",
      sessionId: "s1",
      permissionId: "perm-1",
      response: {
        behavior: "allow",
        selectedActionId: "accept",
        updatedInput: { command: "ls -la" },
        updatedPermissions: [{ tool: "Bash", rule: "allow" }],
      },
    });

    const permRec = records.find((r) => r.kind === "permission_response");
    expect(permRec?.data).toMatchObject({
      permissionId: "perm-1",
      behavior: "allow",
      updatedInput: { command: "ls -la" },
      updatedPermissions: [{ tool: "Bash", rule: "allow" }],
    });

    await conn.send({
      type: "session.configure",
      requestId: "r-cfg",
      sessionId: "s1",
      changes: { mode: "auto", thinkingOption: "low" },
    });
    expect(records.find((r) => r.kind === "configure")?.data).toMatchObject({
      sessionId: "s1",
      changes: { mode: "auto", thinkingOption: "low" },
    });

    await conn.send({ type: "session.close", requestId: "r-close", sessionId: "s1" });
    expect(records.find((r) => r.kind === "close")?.data).toMatchObject({
      sessionId: "s1",
      providerSessionId: "s1",
    });

    await conn.close();
  });
});
