import fs from "node:fs";

const file = "webview/src/styles.css";
let css = fs.readFileSync(file, "utf8");

if (css.includes("--space-2xs")) throw new Error("spacing tokens already present");
const anchor = "  --ui-font-micro: calc(11px * var(--ui-font-scale));\n";
if (!css.includes(anchor)) throw new Error("font token anchor not found");
css = css.replace(
  anchor,
  `${anchor}\n  /* Layout spacing scale (4px grid). Tailwind's --spacing already scales\n     utilities; these variables cover plain-CSS paddings/gaps that used to be\n     fixed px and therefore ignored the density preset. Compact control\n     internals may still use 2/6/10px as optical exceptions. */\n  --space-2xs: calc(2px * var(--ui-density));\n  --space-xs: calc(4px * var(--ui-density));\n  --space-sm: calc(8px * var(--ui-density));\n  --space-md: calc(12px * var(--ui-density));\n  --space-lg: calc(16px * var(--ui-density));\n  --space-xl: calc(24px * var(--ui-density));\n`,
);

const replacements = [
  ["padding: 8px 10px 0;", "padding: var(--space-sm) var(--space-md) 0;"],
  ["margin-bottom: 5px;", "margin-bottom: var(--space-xs);"],
  ["gap: 3px;", "gap: var(--space-xs);"],
  ["gap: 8px;", "gap: var(--space-sm);"],
  ["padding: 4px 6px;", "padding: var(--space-xs) var(--space-sm);"],
  ["gap: 5px;", "gap: var(--space-xs);"],
  ["margin-top: 6px;", "margin-top: var(--space-sm);"],
  ["padding: 6px 12px 7px;", "padding: var(--space-sm) var(--space-md);"],
  ["gap: 10px;", "gap: var(--space-md);"],
  ["padding: 40px 24px;", "padding: 40px var(--space-xl);"],
  ["padding: 8px 10px;", "padding: var(--space-sm) var(--space-md);"],
  ["padding: 2px 8px;", "padding: var(--space-2xs) var(--space-sm);"],
  ["padding: 3px 8px;", "padding: var(--space-xs) var(--space-sm);"],
  ["padding: 2px 10px;", "padding: var(--space-2xs) var(--space-md);"],
  ["gap: 14px;", "gap: var(--space-lg);"],
  ["margin-top: 10px;", "margin-top: var(--space-md);"],
  ["padding: 4px 0;", "padding: var(--space-xs) 0;"],
  ["margin: -4px -8px;", "margin: calc(var(--space-xs) * -1) calc(var(--space-sm) * -1);"],
  ["padding: 4px 8px;", "padding: var(--space-xs) var(--space-sm);"],
];

for (const [from, to] of replacements) {
  const count = css.split(from).length - 1;
  if (count === 0) throw new Error(`spacing declaration not found: ${from}`);
  css = css.split(from).join(to);
  console.log(`${count} × ${from} -> ${to}`);
}

fs.writeFileSync(file, css, "utf8");
console.log("styles.css spacing updated");
