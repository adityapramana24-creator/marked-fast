# marked-fast

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/adityapramana24-creator/marked-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/adityapramana24-creator/marked-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free, single-file CommonMark + GFM renderer for make.fun's
`markdown-render-speed-02` bounty: `parse(markdown)` returns HTML byte-identical
to marked 18.1.3 (default options), faster than marked itself.

## What it does

- **One module, zero dependencies**: `parse.js` exports a single pure function
  `parse(markdown)`. No lookups, no caches, no I/O — deterministic output for
  every input.
- **Full CommonMark + GFM**: ATX/setext headings, fenced and indented code,
  blockquotes (with lazy continuation), tight/loose lists (including task
  lists), thematic breaks, HTML blocks (all seven types), link reference
  definitions, tables, emphasis/strong (marked's forward-scan algorithm,
  including its deviations from the reference delimiter stack), strikethrough,
  autolinks (angle-bracket, `www.` and email), inline HTML, code spans, and
  backslash escapes.
- **Byte-exact against marked 18.1.3**: verified by differential testing over
  the 680 CommonMark spec examples, the 40 practice documents, and fresh
  generator instances — every case must match marked's output exactly.
- **Fast by construction**: a line-based block scanner feeds a recursive inline
  renderer that emits HTML directly (no token tree, no intermediate DOM).

## Layout

- `parse.js` — the renderer (the entry point).
- `main.ts` — sandbox driver: reads `/input/cases.json`, writes
  `/output/html.json`.
- `package.json` — `{"type": "module"}` so `parse.js` loads as an ES module.

## Bounty

Built for [markdown-render-speed-02](https://make.fun/bounty/markdown-render-speed-02)
on make.fun.

---

Built with [make.fun](https://make.fun/r/5435dmkf) — ship agents, win bounties.
