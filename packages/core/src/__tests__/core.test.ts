import { describe, it, expect } from "vitest";
import { parseHarborJsonl, serializeHarbor, createHeader, extractTextFromContent } from "../ir.js";
import { isoToMs, msToAlinkStr } from "../time.js";
import { scanText, redactText } from "../secrets.js";
import { contentHashOf, entryFromIR, identityKeyOf, analyzeDedup } from "../dedup.js";
import { pairingStats } from "../migrate.js";
import { planForkSessions } from "../fork.js";
import { stripReminders } from "../text.js";
import { claudeCwdEncode, wbCwdEncode } from "../paths.js";

describe("IR", () => {
  it("roundtrip header+items", () => {
    const header = createHeader({
      id: "s1",
      sourceClient: "test",
      sourceSessionId: "s1",
      title: "标题",
      cwd: "D:\\x",
    });
    const ir = {
      header,
      items: [
        {
          type: "message" as const,
          itemId: "i1",
          role: "user" as const,
          content: [{ type: "text" as const, text: "你好" }],
        },
      ],
    };
    const text = serializeHarbor(ir);
    const back = parseHarborJsonl(text);
    expect(back.header.spec).toBe("session-harbor");
    expect(back.items).toHaveLength(1);
    expect(back.items[0]!.type).toBe("message");
  });

  it("extractTextFromContent handles claude blocks", () => {
    expect(extractTextFromContent("plain")).toBe("plain");
    expect(
      extractTextFromContent([
        { type: "text", text: "a" },
        { type: "thinking", thinking: "b" },
        { type: "text", text: "c" },
      ]),
    ).toBe("a\nc");
  });
});

describe("time", () => {
  it("parses local datetime string", () => {
    const ms = isoToMs("2026-07-03 17:25:05");
    expect(ms).toBeGreaterThan(0);
    expect(msToAlinkStr(ms)).toBe("2026-07-03 17:25:05");
  });

  it("parses epoch ms", () => {
    expect(isoToMs(1785374731440)).toBe(1785374731440);
  });
});

describe("paths encode", () => {
  it("wb encode", () => {
    expect(wbCwdEncode("D:\\alink")).toBe("d-alink");
  });
  it("claude encode", () => {
    expect(claudeCwdEncode("D:\\Risk-control")).toBe("D--Risk-control");
  });
});

describe("text stripReminders", () => {
  it("removes system-reminder blocks", () => {
    const t = "before\n<system-reminder>\nsecret\n</system-reminder>\nafter";
    const out = stripReminders(t);
    expect(out).not.toContain("secret");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });
});

describe("secrets", () => {
  it("detects github token and internal ip", () => {
    const text = "use ghp_abcdefghijklmnopqrstuvwxyz1234567890 and 192.168.1.10";
    const r = scanText(text);
    expect(r.byKind.github_token).toBe(1);
    expect(r.byKind.internal_ip).toBe(1);
    expect(r.shouldBlockCloud).toBe(true);
  });

  it("redacts hits", () => {
    const text = "key=sk-ant-abcdefghijklmnopqrstuvwxyz123456";
    const r = scanText(text);
    const out = redactText(text, r.hits);
    expect(out).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz");
    expect(out).toContain("REDACTED");
  });
});

describe("dedup", () => {
  const irA = {
    header: createHeader({
      id: "a",
      sourceClient: "cc",
      sourceSessionId: "a",
      title: "A",
    }),
    items: [
      {
        type: "message" as const,
        itemId: "1",
        role: "user" as const,
        content: [{ type: "text" as const, text: "hello" }],
      },
    ],
  };
  it("same content same identity", () => {
    const h1 = contentHashOf(irA);
    const h2 = contentHashOf(irA);
    expect(h1).toBe(h2);
    expect(identityKeyOf("cc", "a", h1)).toBe(identityKeyOf("cc", "a", h2));
  });
  it("analyzeDedup finds duplicates", () => {
    const e1 = entryFromIR(irA);
    const e2 = { ...e1, createdAtMs: 1 };
    const r = analyzeDedup([e1, e2]);
    expect(r.unique).toHaveLength(1);
    expect(r.duplicates.size).toBe(1);
  });
});

describe("pairingStats", () => {
  it("counts paired and orphans", () => {
    const ir = {
      header: createHeader({
        id: "p",
        sourceClient: "t",
        sourceSessionId: "p",
        title: "p",
      }),
      items: [
        {
          type: "tool_call" as const,
          itemId: "1",
          callId: "c1",
          toolName: "shell",
          input: {},
        },
        {
          type: "tool_output" as const,
          itemId: "2",
          callId: "c1",
          output: "ok",
        },
        {
          type: "tool_call" as const,
          itemId: "3",
          callId: "c2",
          toolName: "web",
          input: {},
        },
        {
          type: "tool_output" as const,
          itemId: "4",
          callId: "c9",
          output: "orphan",
        },
      ],
    };
    const ps = pairingStats(ir);
    expect(ps.toolCalls).toBe(2);
    expect(ps.toolOutputs).toBe(2);
    expect(ps.paired).toBe(1);
    expect(ps.orphanCalls).toHaveLength(1);
    expect(ps.orphanOutputs).toHaveLength(1);
  });
});

describe("fork planner", () => {
  it("splits sibling branches into fork sessions", () => {
    const msg = (id: string, text: string, parent?: string) => ({
      type: "message" as const,
      itemId: id,
      role: "user" as const,
      content: [{ type: "text" as const, text }],
      parentItemId: parent,
    });
    const ir = {
      header: createHeader({
        id: "f",
        sourceClient: "wb",
        sourceSessionId: "f",
        title: "ForkTest",
      }),
      items: [
        msg("a", "hello"),
        msg("b", "answer", "a"),
        msg("c1", "branch one", "b"),
        msg("c2", "branch two", "b"),
        msg("d1", "continue one", "c1"),
      ],
    };
    const { main, forks } = planForkSessions(ir);
    const mainTexts = main.items
      .filter((i) => i.type === "message")
      .map((i) => (i.type === "message" ? i.content.map((c) => (c.type === "text" ? c.text : "")).join("") : ""));
    expect(mainTexts).toContain("continue one");
    expect(mainTexts).not.toContain("branch two");
    expect(forks.length).toBeGreaterThanOrEqual(1);
    const forkText = forks[0]!.ir.items
      .filter((i) => i.type === "message")
      .map((i) => (i.type === "message" ? i.content.map((c) => (c.type === "text" ? c.text : "")).join("") : ""))
      .join("|");
    expect(forkText).toContain("hello");
    expect(forkText).toContain("branch two");
  });
});
