#!/usr/bin/env tsx
/**
 * Generates a one-tune PDF from a single ABC/markdown file.
 *
 * Same look and the same text/chord/solfège options as generate-tunebook.ts,
 * but for a single tune (no cover, table of contents, or indexes). A tune that
 * spans several pages via %%newpage renders one page per chunk, just like the
 * full book.
 *
 * Usage:
 *   tsx generate-tune.ts <tune.md|tune.abc> [options]
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import {
  esc,
  extractAbcBlock, cleanAbc, splitAbcByNewpage, parseCommonArgs,
  OUTPUT_DIR,
  PAGE_CONTENT_H, TUNE_MUSIC_H,
  abcjsParams,
  makeRenderTimestamp,
  commonStyles,
  renderToPdf, resolveAbcjsPath,
} from "./tunebook-lib.js";
import { abcToChordChart, ChordChart } from "./chord-chart.js";
import { abcToSolfege } from "./solfege.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h") || args.length === 0) {
  console.log(`
Usage: tsx generate-tune.ts <tune.md|tune.abc> [options]

Renders a single tune to its own PDF. The input may be a vault markdown note
(with a \`\`\`music-abc fenced block) or a raw .abc file.

Options:
  --output PATH        Output PDF path (default: <OUTPUT_DIR>/<tune title>.pdf)
  --title TITLE        Footer title (default: the tune's T: title or filename)
  --title-font NAME    Local font for the tune title (e.g. "TC Wonderling Round")
  --title-weight W     Weight for the title font (e.g. bold, 600)
  --text-font NAME     Local font for body text / lyrics / notes
  --text-weight W      Weight for the text font
  --chord-font NAME    Local font for chord symbols above the staff (default: abcjs')
  --chord-weight W     Weight for the chord font (e.g. bold)
  --chords             Print a chord chart below the staff (if the tune has chords)
  --chords-only        Print only the chord chart (title/composer/key, no staff)
  --solfege            Print a movable-do solfège line under each staff
                       (do = the tonic, so D dorian reads do re me fa sol la te)
  -h, --help           Show this help message

Examples:
  tsx generate-tune.ts "$VAULT_DIR/abc/Abe's Retreat.md"
  tsx generate-tune.ts tune.abc --solfege --output ~/Desktop/tune.pdf
  tsx generate-tune.ts "Kelly Peck's.md" --chords --chord-font "TC Elderwick Bold"
`.trim());
  process.exit(0);
}

// The input file is the first bare (non-flag) argument. Flags that take a value
// (--output, --title, fonts) consume the token after them, so skip those.
const VALUE_FLAGS = new Set([
  "--output", "--title", "--title-font", "--title-weight",
  "--text-font", "--text-weight", "--chord-font", "--chord-weight", "--vault-dir",
]);
const inputFile = args.find((a, i) => !a.startsWith("-") && !(i > 0 && VALUE_FLAGS.has(args[i - 1])));
if (!inputFile) {
  console.error("No input file given. See --help.");
  process.exit(1);
}
if (!fs.existsSync(inputFile)) {
  console.error(`File not found: ${inputFile}`);
  process.exit(1);
}

const { title: optTitle, outputPath: optOutput,
        titleFont, titleWeight, textFont, textWeight, chordFont, chordWeight } =
  parseCommonArgs(args, "");
const fonts = { titleFont, titleWeight, textFont, textWeight, chordFont, chordWeight };

const chordsOnly     = args.includes("--chords-only");
const includeChords  = chordsOnly || args.includes("--chords");
const includeSolfege = args.includes("--solfege");

// ── Read & parse the tune ───────────────────────────────────────────────────────

const raw = fs.readFileSync(inputFile, "utf-8");
// A markdown note carries the ABC in a ```music-abc fence; a raw .abc file is the
// ABC itself (still run through cleanAbc to strip the abcm2ps-only directives).
const abc = extractAbcBlock(raw) ?? cleanAbc(raw);
if (!abc.trim()) {
  console.error("No ABC notation found in the input file.");
  process.exit(1);
}

const baseName     = path.basename(inputFile).replace(/\.(md|abc|txt)$/i, "");
const tMatch       = abc.match(/^T:\s*(.+)/m);
const displayTitle = tMatch ? tMatch[1].trim() : baseName;
const cMatch       = abc.match(/^C:\s*(.+)/m);
const composer     = cMatch ? cMatch[1].trim() : "";
const kMatch       = abc.match(/^K:\s*(.+)/m);

const title      = optTitle || displayTitle;
const outputPath = optOutput ?? path.join(OUTPUT_DIR, `${baseName}.pdf`);

const tuneId    = "tune-single";
const abcChunks = splitAbcByNewpage(abc);

// In chords-only mode the chart is computed up front so we can bail if empty.
let chart: ChordChart | null = null;
if (chordsOnly || includeChords) chart = abcToChordChart(abc);
if (chordsOnly && !chart) {
  console.error("This tune has no chords; nothing to chart in --chords-only mode.");
  process.exit(1);
}

const renderTimestamp = makeRenderTimestamp();

// ── Build HTML ────────────────────────────────────────────────────────────────

function chunkRenderId(idx: number): string {
  return idx === 0 ? tuneId : `${tuneId}-c${idx}`;
}

function chartHtml(c: ChordChart): string {
  return `<div class="chord-chart">${c.lines.map((l) => `<div class="cc-line">${esc(l)}</div>`).join("")}</div>`;
}

function buildHtml(): string {
  const prepChunk = (a: string) => (includeSolfege ? abcToSolfege(a) : a);
  const tuneDataJson = JSON.stringify(
    chordsOnly
      ? {}
      : Object.fromEntries(abcChunks.map((a, i) => [chunkRenderId(i), prepChunk(a)]))
  );

  let tunePages: string;
  if (chordsOnly) {
    const meta = [chart!.meter, kMatch ? kMatch[1].trim() : ""].filter(Boolean).join(" · ");
    tunePages = `<div class="tune-page chords-only">
  <div class="cc-head">
    <div class="cc-title">${esc(displayTitle)}</div>
    ${composer ? `<div class="cc-composer">${esc(composer)}</div>` : ""}
    ${meta ? `<div class="cc-sub">${esc(meta)}</div>` : ""}
  </div>
  ${chartHtml(chart!)}
</div>`;
  } else {
    tunePages = abcChunks
      .map((_, i) => {
        const innerId = chunkRenderId(i);
        const ch = includeChords && i === 0 ? chart : null;   // chart once, under the first page
        return `<div class="tune-page">` +
               `<div class="tune-body"><div id="${innerId}" class="tune-inner"></div></div>` +
               `${ch ? chartHtml(ch) : ""}</div>`;
      })
      .join("\n");
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
${commonStyles({ tocColumns: 2, ...fonts })}

  .tune-page {
    break-before: page;
    break-after: page;
    height: ${PAGE_CONTENT_H}px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .tune-body { flex: 1 1 auto; min-height: 0; overflow: hidden; }
  .tune-inner { width: 100%; }
  .tune-inner svg { width: 100% !important; height: auto !important; }

  .chord-chart {
    flex-shrink: 0;
    margin-top: 8pt;
    padding-top: 6pt;
    border-top: 0.5pt solid #ccc;
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: 9.5pt;
    line-height: 1.5;
    color: #222;
  }
  .cc-line { white-space: pre; }

  .tune-page.chords-only { display: block; }
  .cc-head { margin-bottom: 12pt; }
  .cc-title { font-family: var(--title-font); font-weight: var(--title-weight); font-style: var(--title-style); font-size: 20pt; margin: 0; }
  .cc-composer { font-size: 11pt; font-style: italic; color: #555; margin-top: 2pt; }
  .cc-sub { font-size: 10pt; color: #777; margin-top: 2pt; }
  .chords-only .chord-chart {
    border-top: none;
    margin-top: 0;
    padding-top: 0;
    font-size: 12pt;
    line-height: 1.9;
  }
</style>
</head>
<body>

${tunePages}

<script>
window.TUNE_DATA      = ${tuneDataJson};
window.ABCJS_PARAMS   = ${abcjsParams(fonts)};
window.PAGE_CONTENT_H = ${PAGE_CONTENT_H};
window.TUNE_MUSIC_H   = ${TUNE_MUSIC_H};
</script>
</body>
</html>`;
}

// ── Browser-side script ───────────────────────────────────────────────────────
// Renders each chunk with abcjs and scales it (and any chord chart) to fit the
// page, mirroring generate-tunebook's layout pass. No page-number math is needed
// for a single tune.

const BROWSER_SCRIPT = `
(function () {
  try {
    var MUSIC_H     = window.TUNE_MUSIC_H;
    var ZOOM_SAFETY = 0.97;

    var ABCJS  = window.ABCJS;
    var data   = window.TUNE_DATA;
    var params = window.ABCJS_PARAMS;

    for (var id in data) {
      try { ABCJS.renderAbc(id, data[id], params); }
      catch (e) { console.warn('abcjs error for ' + id + ':', e.message); }
    }

    for (var id in data) {
      var el = document.getElementById(id);
      if (!el) continue;
      var body  = el.parentNode;
      var avail = (body && body.clientHeight) ? body.clientHeight : MUSIC_H;
      var natural = el.scrollHeight;
      if (natural > avail && natural > 0) {
        var scale = (avail / natural) * ZOOM_SAFETY;
        el.style.transform = 'scale(' + scale + ')';
        el.style.transformOrigin = 'top center';
      }
    }

    var charts = document.querySelectorAll('.chord-chart');
    for (var c = 0; c < charts.length; c++) {
      var ch = charts[c];
      var availW = ch.clientWidth;
      var naturalW = ch.scrollWidth;
      if (naturalW > availW && availW > 0) {
        ch.style.transformOrigin = 'top left';
        ch.style.transform = 'scale(' + (availW / naturalW) * ZOOM_SAFETY + ')';
      }
    }

    window.__done   = true;
    window.__result = {};
  } catch (e) {
    window.__error = e.message;
    console.error('Render script error:', e);
  }
})();
`;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const abcjsPath = resolveAbcjsPath(__dirname);

  await renderToPdf({
    html:            buildHtml(),
    browserScript:   BROWSER_SCRIPT,
    outputPath,
    title,
    renderTimestamp,
    abcjsPath,
    textFont,
  });

  const sizeKb = Math.round(fs.statSync(outputPath).size / 1024);
  console.log(`Done! PDF written to: ${outputPath} (${sizeKb} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
