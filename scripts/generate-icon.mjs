#!/usr/bin/env node
// 从 media/iflow.svg 生成 media/icon.png（128x128 透明背景）。
// VSCode 扩展图标只接受 PNG（SVG 仅可用于 command/menu icon），改 logo 后重跑 `npm run icon` 即可。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

const ICON_SIZE = 128;
// 字形在 viewBox 内几乎顶满边缘，缩到 116/128 留出约 6px 透明边距，视觉上不局促。
const PADDING_RATIO = 116 / 128;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const svgPath = path.join(root, "media", "iflow.svg");
const outPath = path.join(root, "media", "icon.png");

const svg = readFileSync(svgPath, "utf8")
  // 去掉根元素固定尺寸，让 resvg 按 viewBox 用 fitTo 缩放输出。
  .replace(/width="\d+" height="\d+"/, "")
  // 在 viewBox 内居中缩放：translate = 160 * (1 - scale) / 2。
  .replace(
    "<path",
    `<g transform="translate(${(160 * (1 - PADDING_RATIO)) / 2} ${(160 * (1 - PADDING_RATIO)) / 2}) scale(${PADDING_RATIO})"><path`,
  )
  .replace("</svg>", "</g></svg>");

const png = new Resvg(svg, { fitTo: { mode: "width", value: ICON_SIZE } })
  .render()
  .asPng();

writeFileSync(outPath, png);
console.log(`icon: ${outPath} (${png.length} bytes)`);
