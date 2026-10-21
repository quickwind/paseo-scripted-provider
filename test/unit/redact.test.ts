import { describe, expect, it } from "vitest";
import { Redactor } from "../../shared/core/capture/redact";

const GH = "ghp_" + "a".repeat(36);
const SK = "sk-" + "b".repeat(40);
const AWS = "AKIAIOSFODNN7EXAMPLE";
const SLACK = "xoxb-1234567890-abcdefghij";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----";
const RAND = "k3J9xQ2mZp7LwR4vB8nT1yH6cD0sFgUa";

describe("default rules", () => {
  const corpus: Record<string, string> = {
    github: `token ${GH} end`,
    openai: `key=${SK}`,
    aws: `aws ${AWS}`,
    slack: `slack ${SLACK}`,
    jwt: `jwt ${JWT}`,
    pem: `key:\n${PEM}\nafter`,
    bearer: "Authorization: Bearer abcdef1234567890ABCDEF",
    urlpw: "git clone https://bob:hunter2pass@example.com/repo.git",
    email: "mail alice@example.org now",
  };
  const secrets: Record<string, string> = {
    github: GH, openai: SK, aws: AWS, slack: SLACK, jwt: JWT, pem: "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu",
    bearer: "abcdef1234567890ABCDEF", urlpw: "hunter2pass", email: "alice@example.org",
  };
  for (const [name, text] of Object.entries(corpus)) {
    it(`redacts ${name} and no secret survives`, () => {
      const out = new Redactor().apply(text);
      expect(out).not.toContain(secrets[name]);
      expect(out).toMatch(/\{\{[a-z_]+\d*\}\}/);
    });
  }
  it("replaces only the username segment of home paths", () => {
    const r = new Redactor();
    expect(r.apply("/Users/alice/proj and /home/bob/x and C:\\Users\\carol\\y")).toBe("/Users/{{user_1}}/proj and /home/{{user_2}}/x and C:\\Users\\{{user_3}}\\y");
  });
  it("replaces the session cwd with {{cwd}}", () => {
    expect(new Redactor(undefined, { cwd: "/Users/alice/proj" }).apply("cd /Users/alice/proj/src && ls")).toBe("cd {{cwd}}/src && ls");
  });
});

describe("placeholders", () => {
  it("same value gets the same placeholder; different values differ", () => {
    const r = new Redactor();
    const out = r.apply(`${GH} ${SK} ${GH}`);
    expect(out).toBe("{{secret_1}} {{secret_2}} {{secret_1}}");
  });
  it("overlapping email-with-token: the higher-priority token rule wins, deterministically", () => {
    const text = `contact ${GH}@example.com please`;
    const out = new Redactor().apply(text);
    expect(out).not.toContain(GH);
    expect(out).toBe("contact {{secret_1}}@example.com please");
  });
  it("URL with password and email query keeps structure", () => {
    const out = new Redactor().apply("https://bob:pw123456@host.io/p?e=zed@host.io");
    expect(out).toBe("https://bob:{{secret_1}}@host.io/p?e={{email_1}}");
  });
});

describe("restore and literals", () => {
  it("restoring a finding returns the original and round-trips", () => {
    const r = new Redactor();
    const text = `a ${GH} b`;
    expect(r.apply(text)).toBe("a {{secret_1}} b");
    r.setRestored(GH, true);
    expect(r.apply(text)).toBe(text);
    r.setRestored(GH, false);
    expect(r.apply(text)).toBe("a {{secret_1}} b");
  });
  it("addLiteral redacts a user value everywhere, longest first", () => {
    const r = new Redactor();
    r.addLiteral("acme-corp");
    r.addLiteral("acme");
    expect(r.apply("acme-corp and acme")).toBe("{{redacted_1}} and {{redacted_2}}");
  });
  it("a literal inside a longer secret does not corrupt it", () => {
    const r = new Redactor();
    r.addLiteral("aaaa");
    expect(r.apply(`x ${GH} y`)).toBe("x {{secret_1}} y");
  });
});

describe("segments, findings, deep", () => {
  it("segments concatenate to apply() and to the original when all restored", () => {
    const r = new Redactor();
    const text = `u ${GH} v alice@example.org w`;
    expect(r.segments(text).map((s) => s.text).join("")).toBe(r.apply(text));
    expect(r.segments(text).filter((s) => s.finding)).toHaveLength(2);
    r.setRestored(GH, true);
    r.setRestored("alice@example.org", true);
    expect(r.segments(text).map((s) => s.text).join("")).toBe(text);
  });
  it("findings are listed in first-appearance order", () => {
    const r = new Redactor();
    r.apply(`${SK} then ${GH}`);
    expect(r.findings().map((f) => f.original)).toEqual([SK, GH]);
  });
  it("applyDeep maps strings in nested structures and leaves other values", () => {
    const r = new Redactor();
    const v = { a: [GH, 1, true, null], b: { c: `x ${SK}` }, n: 5 };
    expect(r.applyDeep(v)).toEqual({ a: ["{{secret_1}}", 1, true, null], b: { c: "x {{secret_2}}" }, n: 5 });
    expect(v.a[0]).toBe(GH);
  });
});

describe("suspicious", () => {
  it("flags a random token but not a UUID, a sha1 or plain words", () => {
    const r = new Redactor();
    expect(r.suspicious(`val ${RAND} end`)).toEqual([RAND]);
    expect(r.suspicious("id 123e4567-e89b-12d3-a456-426614174000")).toEqual([]);
    expect(r.suspicious("sha da39a3ee5e6b4b0d3255bfef95601890afd80709")).toEqual([]);
    expect(r.suspicious("just some ordinary sentence of words here")).toEqual([]);
  });
  it("does not flag text already matched by a rule", () => {
    expect(new Redactor().suspicious(GH)).toEqual([]);
  });
});

describe("leak fixes (final review)", () => {
  it("cwd followed by sentence punctuation is still redacted (regression found by the real-provider run)", () => {
    const r = new Redactor(undefined, { cwd: "/work/opencode" });
    expect(r.apply("The current directory is /work/opencode.")).toBe("The current directory is {{cwd}}.");
    expect(r.apply("(/work/opencode), '/work/opencode'; /work/opencode:")).toBe("({{cwd}}), '{{cwd}}'; {{cwd}}:");
    expect(r.apply("/work/opencode.bak and /work/opencode-2")).toBe("/work/opencode.bak and /work/opencode-2");
  });
  it("a shorter high-priority match does not leave the tail of an overlapping secret", () => {
    const secret = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r+SECRETTAIL/xyz=";
    const out = new Redactor().apply(`Authorization: Bearer ${secret}`);
    expect(out).not.toContain("SECRETTAIL");
    expect(out).not.toContain("dBjftJeZ");
  });
  it("cwd only matches at a path boundary", () => {
    expect(new Redactor(undefined, { cwd: "/home/al" }).apply("/home/alice/proj and /home/al/x")).toBe("/home/{{user_1}}/proj and {{cwd}}/x");
  });
});

describe("fewer false alarms (user report: 44 suspicious items)", () => {
  it("does not flag file names, dates, tool ids or hyphenated words", () => {
    const r = new Redactor();
    for (const text of [
      "see 2026-10-16-paseo-scripted-provider-design.md for details",
      "docs/specs/2026-10-16-scripted-provider.md",
      "toolu_01RJBzgi9ujTiqR629ZYKSNz was the call",
      "run test-driven-development-with-mocks-v2 now",
      "created at 2026-10-16T09:37:12.345Z by someone",
      "scripted_provider_testkit_daemon_helper_v1",
    ]) {
      expect(r.suspicious(text)).toEqual([]);
    }
  });
  it("still flags random-looking secrets with separators", () => {
    expect(new Redactor().suspicious("pw=aB3dE9fG2hJ6kL1mN5pQ8rS4tU7vW0xY")).toEqual(["aB3dE9fG2hJ6kL1mN5pQ8rS4tU7vW0xY"]);
    expect(new Redactor().suspicious("k=Zq8XrT2mKp7-LwR4vB8nT1yH6cD0sFgUa")).toHaveLength(1);
  });
});

describe("email placeholder", () => {
  it("emails get {{email_N}} like every other kind; same address, same number; restore brings the original back", () => {
    const r = new Redactor();
    const text = "from alice@example.org to bob@corp.io, cc alice@example.org";
    expect(r.apply(text)).toBe("from {{email_1}} to {{email_2}}, cc {{email_1}}");
    r.setRestored("alice@example.org", true);
    expect(r.apply(text)).toBe("from alice@example.org to {{email_2}}, cc alice@example.org");
  });
});
