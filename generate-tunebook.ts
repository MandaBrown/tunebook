#!/usr/bin/env tsx
/**
 * Generates a PDF tunebook from all ABC notation files in the vault.
 *
 * Usage:
 *   tsx generate-tunebook.ts [options]
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import matter from "gray-matter";

import {
  esc, slugify, toStringArray, coerceString, sortWithSentinel, getOrCreate,
  extractAbcBlock, splitAbcByNewpage, parseCommonArgs,
  VAULT_DIR, OUTPUT_DIR,
  PAGE_CONTENT_H, TUNE_MUSIC_H,
  abcjsParams,
  makeRenderTimestamp,
  commonStyles, coverPageHtml, tocSectionHtml,
  addOutlines, renderToPdf, resolveAbcjsPath,
  OutlineEntry,
} from "./tunebook-lib.js";
import { abcToChordChart, ChordChart } from "./chord-chart.js";
import { abcToSolfege } from "./solfege.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Usage: tsx generate-tunebook.ts [options]

Options:
  --title TITLE        Title for cover, footer, and output filename (default: "Vault Tunes")
  --include-tag TAG    Only include tunes with this tag (repeatable; multiple = AND)
  --exclude-tag TAG    Exclude tunes with this tag (repeatable)
  --output PATH        Output PDF path (default: <OUTPUT_DIR>/<title>.pdf)
  --vault-dir PATH     Tune source directory (overrides VAULT_DIR / .env)
  --title-font NAME    Local font for titles (e.g. "TC Wonderling Round")
  --title-weight W     Weight for the title font (e.g. bold, 600)
  --text-font NAME     Local font for body text / TOC / indexes / notes
  --text-weight W      Weight for the text font
  --chord-font NAME    Local font for chord symbols above the staff (default: abcjs')
  --chord-weight W     Weight for the chord font (e.g. bold)
  --no-cover           Omit the cover page
  --no-toc             Omit the table of contents
  --no-type-index      Omit the Index by Type
  --no-author-index    Omit the Index by Author
  --toc-columns N      Number of columns in the table of contents (default: 2)
  --chords             Print a chord chart below each tune that has chords
  --chords-only        Print only chord charts (title/composer/key, no staff);
                       tunes without chords are skipped
  --solfege            Print a movable-do solfège line under each staff
                       (do = the tonic, so D dorian reads do re me fa sol la te)
  --type TYPE          Only include tunes whose Type is TYPE (repeatable; "none" = untyped)
  --exclude-type TYPE  Exclude tunes whose Type is TYPE (repeatable; "none" = untyped)
  --genre GENRE        Only include tunes with this Genre (repeatable; multiple = OR;
                       "none" = tunes with no Genre)
  --exclude-genre GENRE  Exclude tunes with this Genre (repeatable; "none" = no Genre)
  --by-type            Emit one book per type family (Reels, Jigs, Marches &
                       Waltzes, Other, Untyped) instead of a single combined book
  -h, --help           Show this help message

Tip:
  A tune that needs more than one page can use %%newpage directives inside
  its ABC body. Each chunk between directives renders on its own page,
  auto-scaled to fit (just like a single-page tune).

Examples:
  tsx generate-tunebook.ts
  tsx generate-tunebook.ts --exclude-tag set
  tsx generate-tunebook.ts --include-tag Rufous --include-tag set --output ~/manda-general-knowledge-vault/Rufous\\ Sets.pdf
  tsx generate-tunebook.ts --chords --include-tag Rufous
  tsx generate-tunebook.ts --chords-only --title "Rufous Chord Charts"
  tsx generate-tunebook.ts --solfege --title "Vault Tunes (Solfège)"
  tsx generate-tunebook.ts --genre Irish --genre Scottish --title "Trad"
`.trim());
  process.exit(0);
}

const { includeTags, excludeTags, title, outputPath: optOutput, vaultDir: optVaultDir,
        titleFont, titleWeight, textFont, textWeight, chordFont, chordWeight,
        includeCover, includeToc, tocColumns } = parseCommonArgs(args, "Vault Tunes");
const fonts = { titleFont, titleWeight, textFont, textWeight, chordFont, chordWeight };

// --vault-dir overrides the .env / env VAULT_DIR for this run.
const ABC_DIR = path.join(optVaultDir ?? VAULT_DIR, "abc");
// Index and chord flags are unique to the tunebook; scan for them directly.
const includeTypeIndex   = !args.includes("--no-type-index");
const includeAuthorIndex = !args.includes("--no-author-index");
const chordsOnly         = args.includes("--chords-only");
const includeChords      = chordsOnly || args.includes("--chords");
const includeSolfege     = args.includes("--solfege");

// Type filters (the Type frontmatter field; "none" matches untyped tunes).
const byType       = args.includes("--by-type");
const typeFilters: string[] = [];
const excludeTypes: string[] = [];
const genreFilters: string[] = [];
const excludeGenres: string[] = [];
for (let i = 0; i < args.length; i++) {
  if      (args[i] === "--type"          && args[i + 1]) typeFilters.push(args[++i]);
  else if (args[i] === "--exclude-type"  && args[i + 1]) excludeTypes.push(args[++i]);
  else if (args[i] === "--genre"         && args[i + 1]) genreFilters.push(args[++i]);
  else if (args[i] === "--exclude-genre" && args[i + 1]) excludeGenres.push(args[++i]);
}

const outputPath = optOutput ?? path.join(OUTPUT_DIR, `${title}.pdf`);

// ── Split-by-type mode ────────────────────────────────────────────────────────
// Re-runs this script once per type family (a normal single-book run each),
// instead of emitting one giant book. Other options (--chords, etc.) pass
// through; --title becomes the volume title and --output is dropped.
if (byType) {
  const families: { name: string; filter: string[] }[] = [
    { name: "Reels",             filter: ["--type", "Reel", "--type", "Slow Reel", "--type", "Crooked Reel"] },
    { name: "Jigs",              filter: ["--type", "Jig", "--type", "Slip Jig"] },
    { name: "Marches & Waltzes", filter: ["--type", "March", "--type", "Waltz"] },
    { name: "Other",             filter: ["Reel", "Slow Reel", "Crooked Reel", "Jig", "Slip Jig", "March", "Waltz", "none"]
                                           .flatMap((t) => ["--exclude-type", t]) },
    { name: "Untyped",           filter: ["--type", "none"] },
  ];
  const passthrough = args.filter((a, i) =>
    a !== "--by-type" &&
    a !== "--title" && args[i - 1] !== "--title" &&
    a !== "--output" && args[i - 1] !== "--output");
  const tsxBin = path.join(__dirname, "node_modules", ".bin", "tsx");
  for (const fam of families) {
    const famTitle = `${title} - ${fam.name}`;
    console.log(`\n━━ ${famTitle} ━━`);
    const r = spawnSync(tsxBin, [__filename, ...passthrough, ...fam.filter, "--title", famTitle], { stdio: "inherit" });
    if (r.status) process.exit(r.status);
  }
  process.exit(0);
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Tune {
  id: string;
  filename: string;
  displayTitle: string;
  sortTitle: string;
  keys: string[];
  type: string;
  composer: string;
  tags: string[];
  genres: string[];
  abc: string;         // full cleaned ABC (used for chords-only charts)
  abcChunks: string[]; // one chunk per page, split at %%newpage
}

// DOM id used for each chunk's abcjs render target. The first chunk reuses the
// bare tune.id so existing TOC/index hrefs (#tune-foo) still anchor correctly.
function chunkRenderId(tuneId: string, chunkIdx: number): string {
  return chunkIdx === 0 ? tuneId : `${tuneId}-c${chunkIdx}`;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function parseTune(filepath: string): Tune | null {
  const raw = fs.readFileSync(filepath, "utf-8");
  const { data, content } = matter(raw);

  const abc = extractAbcBlock(content);
  if (abc === null) return null;

  const filename = path.basename(filepath, ".md");
  const sortTitle = coerceString(data["Sort Name"]) || filename;

  const tMatch = abc.match(/^T:\s*(.+)/m);
  const displayTitle = tMatch ? tMatch[1].trim() : filename;

  const keys = toStringArray(data["Key"]);
  const type = data["Type"] ? String(data["Type"]).trim() : "";
  const composerFm = data["Composer"] ? String(data["Composer"]).trim() : "";
  const composerAbcMatch = abc.match(/^C:\s*(.+)/m);
  const composer = composerFm || (composerAbcMatch ? composerAbcMatch[1].trim() : "");
  const tags = toStringArray(data["tags"]);
  const genres = toStringArray(data["Genre"]);
  const id = "tune-" + slugify(filename);
  const abcChunks = splitAbcByNewpage(abc);

  return { id, filename, displayTitle, sortTitle, keys, type, composer, tags, genres, abc, abcChunks };
}

// ── Load & filter tunes ───────────────────────────────────────────────────────

const allFiles = fs
  .readdirSync(ABC_DIR)
  .filter((f) => f.endsWith(".md"))
  .map((f) => path.join(ABC_DIR, f));

let tunes: Tune[] = allFiles.map(parseTune).filter((t): t is Tune => t !== null);

if (includeTags.length > 0)
  tunes = tunes.filter((t) => includeTags.every((tag) => t.tags.includes(tag)));
if (excludeTags.length > 0)
  tunes = tunes.filter((t) => !excludeTags.some((tag) => t.tags.includes(tag)));

// Type filters: "none" matches an untyped tune (no Type frontmatter).
const matchesType = (t: Tune, v: string) =>
  v.toLowerCase() === "none" ? !t.type : t.type.toLowerCase() === v.toLowerCase();
if (typeFilters.length > 0)
  tunes = tunes.filter((t) => typeFilters.some((v) => matchesType(t, v)));
if (excludeTypes.length > 0)
  tunes = tunes.filter((t) => !excludeTypes.some((v) => matchesType(t, v)));

// Genre filters: a tune may carry several Genre values; "none" matches a tune
// with no Genre. Multiple --genre flags are OR'd (keep a tune in any of them).
const matchesGenre = (t: Tune, v: string) =>
  v.toLowerCase() === "none"
    ? t.genres.length === 0
    : t.genres.some((g) => g.toLowerCase() === v.toLowerCase());
if (genreFilters.length > 0)
  tunes = tunes.filter((t) => genreFilters.some((v) => matchesGenre(t, v)));
if (excludeGenres.length > 0)
  tunes = tunes.filter((t) => !excludeGenres.some((v) => matchesGenre(t, v)));

if (tunes.length === 0) {
  console.log("No tunes matched the filters; nothing to generate.");
  process.exit(0);
}

// In chords-only mode, keep just the tunes that actually have a chord chart.
// The chart for each kept tune is cached here so it isn't recomputed at render.
const chartCache = new Map<string, ChordChart>();
if (chordsOnly) {
  tunes = tunes.filter((t) => {
    const chart = abcToChordChart(t.abc);
    if (chart) chartCache.set(t.id, chart);
    return chart !== null;
  });
}

tunes.sort((a, b) =>
  a.sortTitle.localeCompare(b.sortTitle, undefined, { sensitivity: "base" })
);

if (chordsOnly && tunes.length === 0) {
  console.error("No tunes with chords matched; nothing to generate.");
  process.exit(1);
}

const modeNotes = chordsOnly
  ? ["chords only"]
  : [includeChords ? "with chords" : "", includeSolfege ? "with solfège" : ""].filter(Boolean);
console.log(`Processing ${tunes.length} tunes${modeNotes.length ? ` (${modeNotes.join(", ")})` : ""}...`);

// ── Build indexes ─────────────────────────────────────────────────────────────

const TYPE_NONE     = "(No Type)";
const KEY_NONE      = "(No Key)";
const COMPOSER_NONE = "Traditional";

const indexMap    = new Map<string, Map<string, Tune[]>>();
const composerMap = new Map<string, Tune[]>();
for (const tune of tunes) {
  const keyMap = getOrCreate(indexMap, tune.type || TYPE_NONE, () => new Map());
  for (const k of (tune.keys.length > 0 ? tune.keys : [KEY_NONE]))
    getOrCreate(keyMap, k, () => []).push(tune);
  getOrCreate(composerMap, tune.composer || COMPOSER_NONE, () => []).push(tune);
}

const sortedTypes     = sortWithSentinel(indexMap.keys(), TYPE_NONE);
const sortedComposers = sortWithSentinel(composerMap.keys(), COMPOSER_NONE);

// ── HTML helpers ──────────────────────────────────────────────────────────────

function indexEntry(t: Tune): string {
  return `<li><a href="#${t.id}">${esc(t.sortTitle)}</a><span class="idx-pg"></span></li>`;
}

const renderTimestamp = makeRenderTimestamp();

// ── Build HTML ────────────────────────────────────────────────────────────────

function buildHtml(): string {
  // Each chunk gets its own page; the first chunk's render id == tune.id so the
  // existing TOC/index hrefs (#tune-id) still scroll to the tune. In chords-only
  // mode nothing is rendered with abcjs, so TUNE_DATA is empty.
  const prepChunk = (abc: string) => (includeSolfege ? abcToSolfege(abc) : abc);
  const tuneDataJson = JSON.stringify(
    chordsOnly
      ? {}
      : Object.fromEntries(
          tunes.flatMap((t) =>
            t.abcChunks.map((abc, i) => [chunkRenderId(t.id, i), prepChunk(abc)])
          )
        )
  );

  const indexHtml = sortedTypes
    .map((type) => {
      const keyMap = indexMap.get(type)!;
      const keySections = sortWithSentinel(keyMap.keys(), KEY_NONE)
        .map((key) => {
          const entries = keyMap.get(key)!.map(indexEntry).join("\n");
          return `<div class="key-section"><h3>${esc(key)}</h3><ul>${entries}</ul></div>`;
        })
        .join("\n");
      return `<div class="type-section"><h2>${esc(type)}</h2>${keySections}</div>`;
    })
    .join("\n");

  const authorIndexHtml = sortedComposers
    .map((composer) => {
      const entries = composerMap.get(composer)!.map(indexEntry).join("\n");
      return `<div class="type-section"><h2>${esc(composer)}</h2><ul>${entries}</ul></div>`;
    })
    .join("\n");

  const chartHtml = (chart: ChordChart) =>
    `<div class="chord-chart">${chart.lines.map((l) => `<div class="cc-line">${esc(l)}</div>`).join("")}</div>`;

  let tunePages: string;
  if (chordsOnly) {
    // One page per tune: title/composer/key metadata then the chord chart only.
    tunePages = tunes
      .map((t) => {
        const chart = chartCache.get(t.id)!;
        const meta = [t.type, t.keys.join(", "), chart.meter].filter(Boolean).join(" · ");
        return `<div class="tune-page chords-only" data-tid="${t.id}">
  <div class="tune-file">${esc(t.sortTitle)}</div>
  <div class="cc-head">
    <div class="cc-title">${esc(t.displayTitle)}</div>
    ${t.composer ? `<div class="cc-composer">${esc(t.composer)}</div>` : ""}
    ${meta ? `<div class="cc-sub">${esc(meta)}</div>` : ""}
  </div>
  ${chartHtml(chart)}
</div>`;
      })
      .join("\n");
  } else {
    // For tunes split by %%newpage, only the first chunk carries data-tid (used
    // for navigation and page-number mapping); continuation chunks add " (cont.)".
    // With --chords, each chunk also prints its own chord chart beneath the staff.
    tunePages = tunes
      .flatMap((t) =>
        t.abcChunks.map((chunk, i) => {
          const tid     = i === 0 ? ` data-tid="${t.id}"` : "";
          const label   = i === 0 ? esc(t.sortTitle) : esc(t.sortTitle) + " (cont.)";
          const innerId = chunkRenderId(t.id, i);
          const chart   = includeChords ? abcToChordChart(chunk) : null;
          return `<div class="tune-page"${tid}><div class="tune-file">${label}</div>` +
                 `<div class="tune-body"><div id="${innerId}" class="tune-inner"></div></div>` +
                 `${chart ? chartHtml(chart) : ""}</div>`;
        })
      )
      .join("\n");
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
${commonStyles({ tocColumns, ...fonts })}

  /* ── Tune pages ──
     The outer div has a FIXED height = page content area so the page-break
     engine always sees a full page regardless of inner-content scaling. It is a
     flex column: the header sits on top, the music (.tune-body) flexes to fill
     the remaining space, and an optional chord chart sits at the bottom. The
     browser script scales .tune-inner to fit whatever height .tune-body gets. */
  .tune-page {
    break-before: page;
    break-after: page;
    height: ${PAGE_CONTENT_H}px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .tune-file {
    flex-shrink: 0;
    font-size: 8pt;
    color: #aaa;
    margin-bottom: 4pt;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tune-body { flex: 1 1 auto; min-height: 0; overflow: hidden; }
  .tune-inner { width: 100%; }
  .tune-inner svg { width: 100% !important; height: auto !important; }

  /* ── Chord charts ── */
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

  /* ── Chords-only pages ── */
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

  /* ── Indexes (type and author share structure) ── */
  .index-section, .author-section { break-before: page; columns: 2; column-gap: 0.3in; }
  .index-section h1, .author-section h1 {
    font-size: 20pt; margin: 0 0 12pt; padding-bottom: 4pt;
    border-bottom: 1pt solid #333; column-span: all;
  }
  .type-section { margin-bottom: 14pt; break-inside: avoid-column; }
  .index-section h2, .author-section h2 { font-size: 13pt; margin: 8pt 0 3pt; break-after: avoid; }
  .index-section h3 { font-size: 11pt; margin: 5pt 0 2pt 10pt; font-style: italic; break-after: avoid; }
  .index-section ul, .author-section ul { list-style: none; padding-left: 20pt; margin: 0 0 4pt; }
  .index-section li, .author-section li { font-size: 9.5pt; margin-bottom: 2pt; break-inside: avoid;
                      display: flex; justify-content: space-between; }
  .index-section a, .author-section a   { text-decoration: none; color: inherit; flex: 1; }
  .idx-pg { min-width: 24pt; text-align: right; color: #777; font-size: 8.5pt;
            margin-left: 4pt; flex-shrink: 0; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>

${includeCover ? coverPageHtml(title, `Rendered on ${renderTimestamp}`) : ""}

${includeToc ? tocSectionHtml(tunes.map((t) => ({ id: t.id, label: t.sortTitle }))) : ""}

${tunePages}

${includeTypeIndex ? `
<div class="index-section">
  <h1>Index by Type</h1>
  ${indexHtml}
</div>` : ""}

${includeAuthorIndex ? `
<div class="author-section">
  <h1>Index by Author</h1>
  ${authorIndexHtml}
</div>` : ""}

<script>
window.TUNE_DATA           = ${tuneDataJson};
window.ABCJS_PARAMS        = ${abcjsParams(fonts)};
window.PAGE_CONTENT_H      = ${PAGE_CONTENT_H};
window.TUNE_MUSIC_H        = ${TUNE_MUSIC_H};
window.INCLUDE_COVER       = ${includeCover};
window.INCLUDE_TOC         = ${includeToc};
window.INCLUDE_TYPE_INDEX  = ${includeTypeIndex};
</script>
</body>
</html>`;
}

// ── Browser-side script ───────────────────────────────────────────────────────
// Written as a plain IIFE string so tsx/esbuild helpers (__name, etc.) are
// never injected — they would be undefined in the browser context.
//
// Page numbers are derived mathematically because emulateMediaType('print')
// does not apply CSS page breaks to DOM offsetTop — the DOM is a continuous
// scroll.  Cover = 1, TOC = ceil(tocH / pageH), tunes = 1 each.

const BROWSER_SCRIPT = `
(function () {
  try {
    var CONTENT_H   = window.PAGE_CONTENT_H;
    var MUSIC_H     = window.TUNE_MUSIC_H;
    var ZOOM_SAFETY = 0.97;

    var ABCJS  = window.ABCJS;
    var data   = window.TUNE_DATA;
    var params = window.ABCJS_PARAMS;

    // 1. Render each tune into its inner div.
    for (var id in data) {
      try { ABCJS.renderAbc(id, data[id], params); }
      catch (e) { console.warn('abcjs error for ' + id + ':', e.message); }
    }

    // 2 & 3. Scale each tune to fit the height flexbox gives its .tune-body
    //    (which already accounts for any chord chart printed below it). CSS
    //    transform is used, NOT zoom — zoom changes layout width and triggers an
    //    abcjs responsive re-render.
    for (var id in data) {
      var el = document.getElementById(id);
      if (!el) continue;
      var body  = el.parentNode;                       // .tune-body
      var avail = (body && body.clientHeight) ? body.clientHeight : MUSIC_H;
      var natural = el.scrollHeight;
      if (natural > avail && natural > 0) {
        var scale = (avail / natural) * ZOOM_SAFETY;
        el.style.transform = 'scale(' + scale + ')';
        el.style.transformOrigin = 'top center';
      }
    }

    // 3b. Shrink any chord chart that is wider than the page so it fits. The
    //     monospace grid scales uniformly, so column alignment is preserved.
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

    // 4. Compute page numbers mathematically (DOM offsets don't reflect page breaks).
    var tocEl       = document.querySelector('.toc-section');
    var tocH        = tocEl ? tocEl.scrollHeight : 0;
    var coverPages  = window.INCLUDE_COVER ? 1 : 0;
    var tocPages    = window.INCLUDE_TOC ? Math.max(1, Math.ceil(tocH / CONTENT_H)) : 0;
    var firstTunePg = coverPages + tocPages + 1;

    // 5. Build page-number map. Each .tune-page is exactly one printed page.
    var pageNums   = {};
    var allPageEls = document.querySelectorAll('.tune-page');
    var pageCursor = firstTunePg;
    for (var i = 0; i < allPageEls.length; i++) {
      var tid = allPageEls[i].getAttribute('data-tid');
      if (tid) pageNums[tid] = pageCursor;
      pageCursor += 1;
    }

    // 6. Inject page numbers into TOC.
    var tocLinks = document.querySelectorAll('.toc-list a[href]');
    for (var i = 0; i < tocLinks.length; i++) {
      var a  = tocLinks[i];
      var id = a.getAttribute('href').slice(1);
      var pg = pageNums[id];
      if (pg) {
        var span = a.querySelector('.toc-pg');
        if (span) span.textContent = String(pg);
      }
    }

    // 7. Inject page numbers into type and author indexes.
    var allIdxLinks = document.querySelectorAll('.index-section a[href], .author-section a[href]');
    for (var i = 0; i < allIdxLinks.length; i++) {
      var a    = allIdxLinks[i];
      var id   = a.getAttribute('href').slice(1);
      var pg   = pageNums[id];
      var span = a.nextElementSibling;
      if (pg && span && span.classList.contains('idx-pg'))
        span.textContent = String(pg);
    }

    // 8. Compute type/author index start pages.
    var typeIdxEl      = document.querySelector('.index-section');
    var typeIdxH       = typeIdxEl ? typeIdxEl.scrollHeight : 0;
    var typeIdxPages   = window.INCLUDE_TYPE_INDEX ? Math.max(1, Math.ceil(typeIdxH / CONTENT_H)) : 0;
    var firstTypeIdxPg = pageCursor;
    var firstAuthorPg  = firstTypeIdxPg + typeIdxPages;

    window.__done   = true;
    window.__result = {
      pages:          pageNums,
      firstTunePg:    firstTunePg,
      firstTypeIdxPg: firstTypeIdxPg,
      firstAuthorPg:  firstAuthorPg,
    };
  } catch (e) {
    window.__error = e.message;
    console.error('Render script error:', e);
  }
})();
`;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const abcjsPath = resolveAbcjsPath(__dirname);

  const result = await renderToPdf({
    html:            buildHtml(),
    browserScript:   BROWSER_SCRIPT,
    outputPath,
    title,
    renderTimestamp,
    abcjsPath,
    textFont,
  });

  const { pages, firstTunePg, firstTypeIdxPg, firstAuthorPg } = result;

  console.log("Adding PDF outlines...");
  const tocPage = includeCover ? 2 : 1;
  const outlineEntries: OutlineEntry[] = [
    ...(includeToc         ? [{ title: "Table of Contents", page: tocPage }]                          : []),
    ...tunes.map((t) => ({ title: t.sortTitle, page: pages[t.id] ?? firstTunePg })),
    ...(includeTypeIndex   ? [{ title: "Index by Type",     page: firstTypeIdxPg }]                   : []),
    ...(includeAuthorIndex ? [{ title: "Index by Author",   page: firstAuthorPg }]                    : []),
  ];
  await addOutlines(outputPath, outlineEntries);

  const sizeKb = Math.round(fs.statSync(outputPath).size / 1024);
  console.log(`Done! PDF written to: ${outputPath} (${sizeKb} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
