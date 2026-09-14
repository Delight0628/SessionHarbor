/** SessionHarbor IR v1 — 版本化 JSONL 中间格式 */

export const IR_SPEC = "session-harbor" as const;
export const IR_SPEC_VERSION = "1" as const;

export type ItemRole = "user" | "assistant" | "system";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; callId: string; toolName: string; input: unknown }
  | { type: "tool_output"; callId: string; output: string; isError?: boolean }
  | { type: "file_ref"; uri: string; hash?: string; kind?: string };

export interface SessionMeta {
  id: string;
  sourceClient: string;
  sourceSessionId: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  summary?: string;
}

export type HarborItem =
  | {
      type: "message";
      itemId: string;
      role: ItemRole;
      speaker?: string;
      content: ContentBlock[];
      parentItemId?: string;
      timestamp?: string;
      model?: string;
    }
  | {
      type: "tool_call";
      itemId: string;
      callId: string;
      toolName: string;
      input: unknown;
      parentItemId?: string;
      timestamp?: string;
    }
  | {
      type: "tool_output";
      itemId: string;
      callId: string;
      output: string;
      isError?: boolean;
      timestamp?: string;
    }
  | {
      type: "thinking";
      itemId: string;
      text: string;
      parentItemId?: string;
      timestamp?: string;
    }
  | {
      type: "file_ref";
      itemId: string;
      uri: string;
      hash?: string;
      kind?: string;
    }
  | {
      type: "checkpoint";
      itemId: string;
      label: string;
      files: string[];
    };

export interface HarborHeader {
  spec: typeof IR_SPEC;
  specVersion: typeof IR_SPEC_VERSION;
  session: SessionMeta;
  extensions: Record<string, unknown>;
}

export interface HarborIR {
  header: HarborHeader;
  items: HarborItem[];
}

export function createHeader(
  session: SessionMeta,
  extensions: Record<string, unknown> = {},
): HarborHeader {
  return {
    spec: IR_SPEC,
    specVersion: IR_SPEC_VERSION,
    session,
    extensions,
  };
}

export function parseHarborJsonl(text: string): HarborIR {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error("empty harbor jsonl");
  const header = JSON.parse(lines[0]) as HarborHeader;
  if (header.spec !== IR_SPEC) {
    throw new Error(`unknown spec: ${(header as { spec?: string }).spec}`);
  }
  const items: HarborItem[] = [];
  for (let i = 1; i < lines.length; i++) {
    items.push(JSON.parse(lines[i]) as HarborItem);
  }
  return { header, items };
}

export function serializeHarbor(ir: HarborIR): string {
  const lines = [JSON.stringify(ir.header)];
  for (const item of ir.items) lines.push(JSON.stringify(item));
  return lines.join("\n") + "\n";
}

/** 从消息内容中抽取纯文本 */
export function extractText(content: ContentBlock[] | string | null | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === "text" || b.type === "thinking") {
      if (b.text) parts.push(b.text);
    } else if (b.type === "tool_output") {
      if (b.output) parts.push(b.output);
    }
  }
  return parts.join("\n");
}

/** 从 OpenAI/Claude 风格 content 提取纯文本 */
export function extractTextFromContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (item && typeof item === "object") {
        const t = (item as Record<string, unknown>).type;
        if (t === "text" || t === "input_text" || t === "output_text") {
          const text =
            (item as Record<string, unknown>).text ??
            (item as Record<string, unknown>).content;
          if (typeof text === "string" && text) parts.push(text);
        } else if (t === "thinking") {
          // thinking 不并入正文
        } else if (t === "tool_result") {
          const c = (item as Record<string, unknown>).content;
          parts.push(extractTextFromContent(c));
        }
      }
    }
    return parts.filter(Boolean).join("\n");
  }
  if (typeof content === "object") {
    const o = content as Record<string, unknown>;
    return extractTextFromContent(o.content ?? o.text);
  }
  return String(content);
}
