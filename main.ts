// main.ts — driver for the markdown-render-speed-02 sandbox.
// Reads /input/cases.json, renders each case with parse(), and writes
// /output/html.json. Erasable-syntax TypeScript only (Node 22 type
// stripping): no enums, namespaces, or parameter properties.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parse } from "./parse.js";

const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";

const raw = readFileSync(inputDir + "/cases.json", "utf8");
const cases = JSON.parse(raw);

const html = [];
for (let i = 0; i < cases.length; i++) {
  html.push(parse(cases[i].markdown));
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(outputDir + "/html.json", JSON.stringify(html));
