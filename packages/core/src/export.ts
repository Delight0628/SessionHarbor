/** 导出：Markdown / JSON / HTML */

import type { HarborIR, HarborItem } from "./ir.js";
import { extractText } from "./ir.js";

export function toMarkdown(ir: HarborIR): string {
  const s = ir.header.session;
  const lines: string[] = [];
  lines.push(`# ${s.title || s.id}`);
  lines.push("");
  lines.push(`- **Source**: ${s.sourceClient} · \`${s.sourceSessionId}\``);
  if (s.cwd) lines.push(`- **CWD**: \`${s.cwd}\``);
  if (s.model) lines.push(`- **Model**: ${s.model}`);
  if (s.createdAt) lines.push(`- **Created**: ${s.createdAt}`);
  if (s.updatedAt) lines.push(`- **Updated**: ${s.updatedAt}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  for (const item of ir.items) {
    lines.push(...itemToMarkdown(item));
  }
  return lines.join("\n") + "\n";
}

function itemToMarkdown(item: HarborItem): string[] {
  switch (item.type) {
    case "message": {
      const role = item.role === "user" ? "User" : item.role === "assistant" ? "Assistant" : "System";
      const text = extractText(item.content);
      return [`## ${role}`, "", text, ""];
    }
    case "thinking":
      return ["### Thinking", "", item.text, ""];
    case "tool_call":
      return [
        "### Tool Call",
        "",
        `- **Tool**: \`${item.toolName}\``,
        `- **CallId**: \`${item.callId}\``,
        "",
        "```json",
        JSON.stringify(item.input ?? {}, null, 2),
        "```",
        "",
      ];
    case "tool_output":
      return [
        "### Tool Output",
        "",
        item.isError ? "> **ERROR**" : "",
        "```",
        item.output,
        "```",
        "",
      ];
    case "file_ref":
      return [`- [file] ${item.uri}`, ""];
    case "checkpoint":
      return [`- [checkpoint] ${item.label}`, ""];
    default:
      return [];
  }
}

export function toJson(ir: HarborIR): string {
  return JSON.stringify(ir, null, 2);
}

export function toHtml(ir: HarborIR): string {
  const s = ir.header.session;
  const esc = (t: string) =>
    t
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const body: string[] = [];
  body.push(`<h1>${esc(s.title || s.id)}</h1>`);
  body.push(
    `<p class="meta">${esc(s.sourceClient)} · <code>${esc(s.sourceSessionId)}</code>` +
      (s.cwd ? ` · <code>${esc(s.cwd)}</code>` : "") +
      `</p>`,
  );
  for (const item of ir.items) {
    if (item.type === "message") {
      const role = item.role;
      const text = esc(extractText(item.content));
      body.push(
        `<section class="msg ${role}"><header>${role}</header><pre>${text}</pre></section>`,
      );
    } else if (item.type === "thinking") {
      body.push(`<section class="thinking"><header>thinking</header><pre>${esc(item.text)}</pre></section>`);
    } else if (item.type === "tool_call") {
      body.push(
        `<section class="tool"><header>tool_call · ${esc(item.toolName)}</header><pre>${esc(JSON.stringify(item.input ?? {}, null, 2))}</pre></section>`,
      );
    } else if (item.type === "tool_output") {
      body.push(
        `<section class="tool ${item.isError ? "error" : ""}"><header>tool_output</header><pre>${esc(item.output)}</pre></section>`,
      );
    }
  }
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>${esc(s.title || s.id)} — SessionHarbor</title>
<style>
  body{font:15px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fafafa}
  h1{font-size:1.4rem;margin-bottom:.25rem}
  .meta{color:#666;font-size:.9rem}
  section{background:#fff;border:1px solid #e5e5e5;border-radius:8px;margin:.75rem 0;overflow:hidden}
  section header{padding:.35rem .75rem;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;background:#f0f0f0;color:#555}
  section pre{margin:0;padding:.75rem;white-space:pre-wrap;word-break:break-word;font-size:.9rem}
  section.user header{background:#e8f0fe}
  section.assistant header{background:#e6f4ea}
  section.thinking header{background:#fef7e0}
  section.tool header{background:#f3e8fd}
  section.tool.error header{background:#fce8e6}
</style>
</head>
<body>
${body.join("\n")}
</body>
</html>
`;
}
