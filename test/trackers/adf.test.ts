import { expect, test } from "bun:test";
import { toMarkdown } from "../../src/trackers/adf";

const text = (t: string, marks?: object[]) => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
const para = (...content: object[]) => ({ type: "paragraph", content });

test("ADF becomes Markdown: headings, marks, links, lists, code, quotes and tables", () => {
  const doc = {
    type: "doc",
    version: 1,
    content: [
      { type: "heading", attrs: { level: 2 }, content: [text("Steps")] },
      para(text("Run "), text("make", [{ type: "code" }]), text(" then see "), text("the docs", [{ type: "link", attrs: { href: "https://x.test" } }]), { type: "hardBreak" }, text("bold", [{ type: "strong" }])),
      { type: "orderedList", attrs: { order: 1 }, content: [
        { type: "listItem", content: [para(text("one"))] },
        { type: "listItem", content: [para(text("two")), { type: "bulletList", content: [{ type: "listItem", content: [para(text("nested"))] }] }] },
      ] },
      { type: "codeBlock", attrs: { language: "go" }, content: [text("x := 1")] },
      { type: "blockquote", content: [para(text("quoted"))] },
      { type: "table", content: [
        { type: "tableRow", content: [{ type: "tableHeader", content: [para(text("a"))] }, { type: "tableHeader", content: [para(text("b|c"))] }] },
        { type: "tableRow", content: [{ type: "tableCell", content: [para(text("1"))] }, { type: "tableCell", content: [para(text("2"))] }] },
      ] },
      para({ type: "mention", attrs: { text: "@Ana" } }, text(" "), { type: "inlineCard", attrs: { url: "https://y.test" } }),
      { type: "mediaSingle", content: [{ type: "media", attrs: { alt: "screenshot.png" } }] },
      { type: "someFutureNode", content: [para(text("kept anyway"))] },
    ],
  };
  expect(toMarkdown(doc)).toBe(
    [
      "## Steps",
      "Run `make` then see [the docs](https://x.test)\n**bold**",
      "1. one\n2. two\n\n   - nested",
      "```go\nx := 1\n```",
      "> quoted",
      "| a | b\\|c |\n| --- | --- |\n| 1 | 2 |",
      "@Ana <https://y.test>",
      "[attachment: screenshot.png]",
      "kept anyway",
    ].join("\n\n"),
  );
});

test("strings pass through; empty documents and junk become null", () => {
  expect(toMarkdown("  already markdown ")).toBe("already markdown");
  expect(toMarkdown({ type: "doc", version: 1, content: [] })).toBeNull();
  expect(toMarkdown(null)).toBeNull();
  expect(toMarkdown(42)).toBeNull();
});
