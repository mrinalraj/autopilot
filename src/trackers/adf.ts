/**
 * Atlassian Document Format (Jira's rich text JSON) to Markdown, for briefs and triage prompts.
 * Unknown nodes keep their text, so nothing the ticket says is silently dropped.
 */

interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: { type: string; attrs?: Record<string, any> }[];
  content?: AdfNode[];
}

/** Plain strings pass through; ADF documents become Markdown; anything else becomes null. */
export function toMarkdown(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value !== "object" || !("type" in (value as object))) return null;
  const md = blocks((value as AdfNode).content ?? [], "").replace(/\n{3,}/g, "\n\n").trim();
  return md || null;
}

function blocks(nodes: AdfNode[], indent: string): string {
  return nodes.map((n) => block(n, indent)).filter((b) => b !== "").join("\n\n");
}

function block(n: AdfNode, indent: string): string {
  const kids = n.content ?? [];
  switch (n.type) {
    case "paragraph":
      return indent + inline(kids);
    case "heading":
      return `${indent}${"#".repeat(Math.min(Math.max(Number(n.attrs?.level) || 1, 1), 6))} ${inline(kids)}`;
    case "bulletList":
    case "orderedList": {
      const start = Number(n.attrs?.order) || 1;
      return kids
        .map((item, i) => {
          const marker = n.type === "orderedList" ? `${start + i}. ` : "- ";
          const body = blocks(item.content ?? [], indent + " ".repeat(marker.length)).trimStart();
          return `${indent}${marker}${body}`;
        })
        .join("\n");
    }
    case "taskList":
      return kids.map((item) => `${indent}- [${item.attrs?.state === "DONE" ? "x" : " "}] ${inline(item.content ?? [])}`).join("\n");
    case "codeBlock":
      return `${indent}\`\`\`${n.attrs?.language ?? ""}\n${kids.map((k) => k.text ?? "").join("")}\n${indent}\`\`\``;
    case "blockquote":
    case "panel":
      return blocks(kids, "")
        .split("\n")
        .map((l) => `${indent}> ${l}`)
        .join("\n");
    case "rule":
      return `${indent}---`;
    case "table":
      return table(n, indent);
    case "mediaSingle":
    case "mediaGroup":
      return kids.map((m) => `${indent}[attachment${m.attrs?.alt ? `: ${m.attrs.alt}` : ""}]`).join("\n");
    case "expand":
    case "nestedExpand":
      return [n.attrs?.title ? `${indent}**${n.attrs.title}**` : "", blocks(kids, indent)].filter(Boolean).join("\n\n");
    default:
      return kids.length ? (kids.some((k) => k.content || isBlock(k)) ? blocks(kids, indent) : indent + inline(kids)) : indent + (n.text ?? "");
  }
}

const isBlock = (n: AdfNode) => ["paragraph", "heading", "bulletList", "orderedList", "codeBlock", "blockquote", "table", "panel"].includes(n.type);

function table(n: AdfNode, indent: string): string {
  const rows = (n.content ?? []).map((row) => (row.content ?? []).map((cell) => blocks(cell.content ?? [], "").replace(/\n+/g, " ").replace(/\|/g, "\\|")));
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `${indent}| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [line(rows[0]), `${indent}|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}

function inline(nodes: AdfNode[]): string {
  return nodes.map(inlineNode).join("");
}

function inlineNode(n: AdfNode): string {
  switch (n.type) {
    case "text":
      return marked(n.text ?? "", n.marks ?? []);
    case "hardBreak":
      return "\n";
    case "mention":
      return `@${String(n.attrs?.text ?? "someone").replace(/^@/, "")}`;
    case "emoji":
      return n.attrs?.text ?? n.attrs?.shortName ?? "";
    case "inlineCard":
    case "blockCard":
    case "embedCard":
      return n.attrs?.url ? `<${n.attrs.url}>` : "";
    case "date":
      return n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : "";
    case "status":
      return n.attrs?.text ? `[${n.attrs.text}]` : "";
    default:
      return n.text ?? inline(n.content ?? []);
  }
}

function marked(text: string, marks: NonNullable<AdfNode["marks"]>): string {
  let out = text;
  for (const m of marks) {
    if (m.type === "code") out = `\`${out}\``;
    else if (m.type === "strong") out = `**${out}**`;
    else if (m.type === "em") out = `*${out}*`;
    else if (m.type === "strike") out = `~~${out}~~`;
  }
  const link = marks.find((m) => m.type === "link")?.attrs?.href;
  return link ? `[${out}](${link})` : out;
}
