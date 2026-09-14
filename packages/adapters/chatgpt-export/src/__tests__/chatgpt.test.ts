import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = join(__dirname, "../../../../fixtures/chatgpt-export/conversations.json");

type Node = {
  message?: {
    author?: { role?: string };
    content?: { content_type?: string; parts?: unknown[] };
    create_time?: number;
  } | null;
  parent?: string | null;
  children?: string[];
};

function flatten(mapping: Record<string, Node>) {
  const ids = Object.keys(mapping);
  const out: Array<{ role: string; text: string; createTime?: number }> = [];
  const roots = ids.filter((id) => {
    const p = mapping[id]?.parent;
    return typeof p !== "string" || !mapping[p];
  });
  const seen = new Set<string>();
  function walk(id: string) {
    if (seen.has(id) || !mapping[id]) return;
    seen.add(id);
    const msg = mapping[id]!.message;
    if (msg) {
      const role = msg.author?.role ?? "user";
      const parts = msg.content?.parts ?? [];
      const text = parts
        .map((p) => (typeof p === "string" ? p : ""))
        .filter(Boolean)
        .join("\n");
      if (role !== "system" && text.trim()) {
        out.push({
          role: role === "assistant" ? "assistant" : "user",
          text,
          createTime: msg.create_time,
        });
      }
    }
    for (const c of mapping[id]!.children ?? []) walk(c);
  }
  for (const r of roots) walk(r);
  out.sort((a, b) => (a.createTime ?? 0) - (b.createTime ?? 0));
  return out;
}

describe("chatgpt export fixture", () => {
  it("parses official tree format", () => {
    const data = JSON.parse(readFileSync(fixture, "utf-8")) as Array<{
      conversation_id: string;
      mapping: Record<string, Node>;
    }>;
    expect(data.length).toBeGreaterThanOrEqual(2);
    expect(data[0]!.mapping.root).toBeTruthy();
    const flat = flatten(data[0]!.mapping);
    expect(flat.length).toBeGreaterThanOrEqual(4);
    expect(flat[0]!.role).toBe("user");
    expect(flat.every((m) => m.role !== "system")).toBe(true);
    expect(flat[0]!.text).toContain("跨客户端会话迁移");
  });
});
