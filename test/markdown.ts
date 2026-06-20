// Unit tests for the pure Markdown parser shared with the browser UI.
// MARKDOWN_SRC is DOM-free, so we eval it here and exercise parseMessage
// directly — no jsdom, no browser, no extra dependencies.
import assert from "node:assert/strict";
import { MARKDOWN_SRC } from "../src/broker/ui.js";

type Node = Record<string, any>;
const factory = new Function(MARKDOWN_SRC + "\n;return { parseMessage };");
const { parseMessage } = factory() as { parseMessage: (t: string) => Node[] };

// Flatten the whole AST (blocks + inline children + list items) for "is there
// any node of type X anywhere" assertions.
function walk(nodes: Node[], out: Node[] = []): Node[] {
  for (const n of nodes) {
    out.push(n);
    if (Array.isArray(n.children)) walk(n.children, out);
    if (Array.isArray(n.items)) for (const it of n.items) walk(it, out);
  }
  return out;
}
function types(nodes: Node[]): string[] {
  return walk(nodes).map((n) => n.type);
}

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log("  ✓ " + name);
}

check("bold (**)", () => {
  const p = parseMessage("**hi**")[0];
  assert.equal(p.type, "paragraph");
  assert.equal(p.children[0].type, "strong");
  assert.equal(p.children[0].children[0].value, "hi");
});

check("bold (__)", () => {
  const s = parseMessage("__hi__")[0].children[0];
  assert.equal(s.type, "strong");
});

check("italic (* and _)", () => {
  assert.equal(parseMessage("*hi*")[0].children[0].type, "em");
  assert.equal(parseMessage("_hi_")[0].children[0].type, "em");
});

check("inline code is literal", () => {
  const c = parseMessage("`a*b*c`")[0].children[0];
  assert.equal(c.type, "code");
  assert.equal(c.value, "a*b*c");
});

check("strikethrough", () => {
  assert.equal(parseMessage("~~gone~~")[0].children[0].type, "del");
});

check("valid link keeps href", () => {
  const link = parseMessage("[site](https://example.com)")[0].children[0];
  assert.equal(link.type, "link");
  assert.equal(link.href, "https://example.com");
  assert.equal(link.children[0].value, "site");
});

check("javascript: link is rejected (no link node)", () => {
  const blocks = parseMessage("[x](javascript:alert(1))");
  assert.ok(!types(blocks).includes("link"));
});

check("mention highlighted", () => {
  const kids = parseMessage("hi @bob there")[0].children;
  assert.ok(kids.some((n: Node) => n.type === "mention" && n.value === "@bob"));
});

check("mention suppressed inside code", () => {
  const blocks = parseMessage("`@bob`");
  assert.ok(!types(blocks).includes("mention"));
});

check("heading levels (capped at 3)", () => {
  assert.equal(parseMessage("# Title")[0].level, 1);
  assert.equal(parseMessage("#### Deep")[0].level, 3);
});

check("fenced code block keeps lang + literal body", () => {
  const b = parseMessage("```js\nconst a = 1;\n```")[0];
  assert.equal(b.type, "code_block");
  assert.equal(b.lang, "js");
  assert.equal(b.value, "const a = 1;");
});

check("bullet list", () => {
  const b = parseMessage("- a\n- b")[0];
  assert.equal(b.type, "list");
  assert.equal(b.ordered, false);
  assert.equal(b.items.length, 2);
});

check("ordered list", () => {
  const b = parseMessage("1. a\n2. b")[0];
  assert.equal(b.type, "list");
  assert.equal(b.ordered, true);
  assert.equal(b.items.length, 2);
});

check("blockquote", () => {
  const b = parseMessage("> quoted")[0];
  assert.equal(b.type, "blockquote");
  assert.equal(b.children[0].type, "paragraph");
});

check("soft break inside paragraph", () => {
  const kids = parseMessage("line one\nline two")[0].children;
  assert.deepEqual(kids.map((n: Node) => n.type), ["text", "break", "text"]);
});

check("unmatched ** stays literal", () => {
  const blocks = parseMessage("a ** b");
  assert.ok(!types(blocks).includes("strong"));
});

check("raw HTML is kept as literal text", () => {
  const kids = parseMessage("<img src=x onerror=hack()>")[0].children;
  assert.equal(kids.length, 1);
  assert.equal(kids[0].type, "text");
  assert.equal(kids[0].value, "<img src=x onerror=hack()>");
});

check("snake_case is not italicised", () => {
  const blocks = parseMessage("call foo_bar_baz now");
  assert.ok(!types(blocks).includes("em"));
});

console.log("\n✓ markdown parser: " + passed + " checks passed");
