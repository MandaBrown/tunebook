#!/usr/bin/env tsx
/**
 * Generates a PDF setbook from the files in the vault's sets/ folder.
 *
 * A set file is a markdown file containing Obsidian-style links to ABC tune
 * files, e.g.:
 *
 *   - [[abc/Amy in the Bog|Amy in the Bog]]
 *   - The Judge                       <- plain-text bullet = a group header
 *       - [[abc/The Judge|The Judge]]   tunes indented under it share one page
 *           - Sax solo first time       <- deeper indent = a note on that tune
 *       - [[The Judge (harmony)]]
 *
 * The setbook prints each set with its title as a page header. A top-level link
 * is a standalone tune; by default up to two adjacent standalone tunes share a
 * page when both fit at MIN_PAIR_SCALE or larger, otherwise each gets its own
 * page. Tunes grouped under a plain-text parent bullet are forced onto a single
 * page (scaled to fit) so the grouping is under the author's control. Indented
 * lines with no link are performance notes printed beneath the preceding tune.
 *
 * Usage:
 *   tsx generate-setbook.ts [options]
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import matter from "gray-matter";

import {
  esc, slugify, toStringArray, coerceString, extractAbcBlock,
  parseCommonArgs,
  VAULT_DIR, OUTPUT_DIR,
  PAGE_CONTENT_H, TUNE_HEADER_H,
  ABCJS_PARAMS,
  makeRenderTimestamp,
  commonStyles, coverPageHtml, tocSectionHtml,
  addOutlines, renderToPdf, resolveAbcjsPath,
  OutlineEntry,
} from "./tunebook-lib.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Pairing threshold: two tunes share a page only if the required scale ratio
// stays at or above this fraction (0.65 = at most 35% shrink). Below that,
// each tune gets its own page where it can use the full music area.
const MIN_PAIR_SCALE = 0.65;

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Usage: tsx generate-setbook.ts [options]

Options:
  --title TITLE        Title for cover, footer, and output filename (default: "Vault Sets")
  --include-tag TAG    Only include sets with this tag (repeatable; multiple = AND)
  --exclude-tag TAG    Exclude sets with this tag (repeatable)
  --output PATH        Output PDF path (default: <OUTPUT_DIR>/<title>.pdf)
  --vault-dir PATH     Tune source directory (overrides VAULT_DIR / .env)
  --no-cover           Omit the cover page
  --no-toc             Omit the table of contents
  --toc-columns N      Number of columns in the table of contents (default: 2)
  -h, --help           Show this help message

Set file format:
  Set files live in <vault>/sets/ and reference ABC files via Obsidian links
  (either ![[X]] transclusions or plain [[X]] links work):
    ![[abc/Tune Name|Display Name]]   (explicit path)
    [[Tune Name]]                     (resolved against abc/)
  The set title is the SortName / Sort Name frontmatter field, falling back
  to the filename.

  Layout is controlled by bullet structure:
    - [[Tune]]            top-level link  = standalone tune (auto two-per-page)
    - Group label         top-level text  = group header; the links indented
        - [[Tune A]]                        beneath it are forced onto one page
        - [[Tune B]]
            - a note text  indented text  = performance note on the tune above

  Two standalone tunes share a page when both fit after shrinking by at most
  ${Math.round((1 - MIN_PAIR_SCALE) * 100)}%; otherwise each gets its own page. Grouped tunes always share a page.

Examples:
  tsx generate-setbook.ts
  tsx generate-setbook.ts --include-tag Rufous --title "Rufous Sets"
  tsx generate-setbook.ts --no-cover --no-toc
`.trim());
  process.exit(0);
}

const { includeTags, excludeTags, title, outputPath: optOutput, vaultDir: optVaultDir, includeCover, includeToc, tocColumns } =
  parseCommonArgs(args, "Vault Sets");

// --vault-dir overrides the .env / env VAULT_DIR for this run.
const VAULT = optVaultDir ?? VAULT_DIR;
const SETS_DIR = path.join(VAULT, "sets");
const ABC_DIR  = path.join(VAULT, "abc");

const outputPath = optOutput ?? path.join(OUTPUT_DIR, `${title}.pdf`);

// ── Types ─────────────────────────────────────────────────────────────────────

interface TuneRef {
  renderId: string;    // DOM id for abcjs render target (unique across the document)
  abc:      string;    // cleaned ABC body
  notes:    string[];  // performance notes from indented sub-bullets in the set file
}

// A page group is the unit of page layout. A group with `locked: true` came from
// an explicit parent bullet in the set file and ALL its tunes are forced onto a
// single page (scaled to fit). A `locked: false` group always holds exactly one
// standalone tune and is eligible for the automatic two-per-page merge.
interface PageGroup {
  tunes:  TuneRef[];
  locked: boolean;
}

interface SetRecord {
  id:        string;     // DOM id (used by TOC/outline)
  filename:  string;
  sortTitle: string;     // SortName / Sort Name / filename
  tags:      string[];
  groups:    PageGroup[];
}

// ── Wikilink resolution ──────────────────────────────────────────────────────
// Matches: ![[link]] or ![[link|alias]]. The link may be a bare filename or a
// path like "abc/Foo". Returns the resolved .md path (or null if missing).
function resolveWikilink(link: string): string | null {
  const target = link.split("|")[0].trim();
  const candidates = target.includes("/")
    ? [path.join(VAULT, target + ".md")]
    : [path.join(ABC_DIR, target + ".md")];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function extractAbcFromTuneFile(filepath: string): string | null {
  const { content } = matter(fs.readFileSync(filepath, "utf-8"));
  return extractAbcBlock(content);
}

// ── Set parsing ──────────────────────────────────────────────────────────────

function parseSet(filepath: string): SetRecord | null {
  const raw = fs.readFileSync(filepath, "utf-8");
  const { data, content } = matter(raw);

  const filename = path.basename(filepath, ".md");

  // Accept both "SortName" (no space, used in sets) and "Sort Name" (used in tunes).
  const sortTitle =
    coerceString(data["SortName"]) || coerceString(data["Sort Name"]) || filename;

  const tags = toStringArray(data["tags"]);
  const setId = "set-" + slugify(filename);

  // Parse the body line by line into page groups. The shape of each line decides
  // how it lays out:
  //   • top-level LINK  ("- [[Tune]]")        → a standalone tune; its own
  //                                              unlocked group (auto two-per-page).
  //   • top-level TEXT  ("- Paddy on a Bun")   → a group header; the indented
  //                                              links beneath it form one locked
  //                                              group that shares a single page.
  //   • indented LINK   ("\t- [[Tune]]")       → a tune inside the current group.
  //   • indented TEXT   ("\t- Sax solo")       → a performance note on the last tune.
  const lineLinkRe = /!?\[\[([^\]]+)\]\]/;
  const groups: PageGroup[] = [];
  let tuneIdx = 0;
  let currentGroup: PageGroup | null = null;  // active locked group, if any
  let currentTune:  TuneRef   | null = null;  // last tune added (notes attach here)

  const makeTune = (link: string): TuneRef | null => {
    const resolved = resolveWikilink(link);
    if (!resolved) { console.warn(`  ${filename}: link not found: ${link}`); return null; }
    const abc = extractAbcFromTuneFile(resolved);
    if (!abc) { console.warn(`  ${filename}: no ABC block in ${path.basename(resolved)}`); return null; }
    return { renderId: `${setId}-t${tuneIdx++}`, abc, notes: [] };
  };

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const isIndented = /^\s/.test(line);
    const linkMatch  = line.match(lineLinkRe);

    if (!isIndented) {
      if (linkMatch) {
        // Standalone top-level tune → its own auto-mergeable group.
        currentGroup = null;
        currentTune  = null;
        const t = makeTune(linkMatch[1]);
        if (t) { groups.push({ tunes: [t], locked: false }); currentTune = t; }
      } else {
        // Plain-text parent bullet → start a locked group that shares a page.
        currentGroup = { tunes: [], locked: true };
        currentTune  = null;
        groups.push(currentGroup);
      }
    } else if (linkMatch) {
      // Indented link → a tune. Belongs to the active locked group if there is
      // one; otherwise it falls back to a standalone (auto-mergeable) group.
      const t = makeTune(linkMatch[1]);
      if (t) {
        if (currentGroup) currentGroup.tunes.push(t);
        else              groups.push({ tunes: [t], locked: false });
        currentTune = t;
      }
    } else if (currentTune) {
      // Indented text → a performance note on the most recent tune.
      const note = line.replace(/^\s*(?:[-*+]\s+)?/, "").trim();
      if (note) currentTune.notes.push(note);
    }
  }

  // Drop empty groups (e.g. a stray plain-text line that had no tunes under it).
  const nonEmpty = groups.filter((g) => g.tunes.length > 0);

  if (nonEmpty.length === 0) {
    console.warn(`  ${filename}: no tunes resolved; skipping`);
    return null;
  }

  return { id: setId, filename, sortTitle, tags, groups: nonEmpty };
}

// ── Load & filter sets ───────────────────────────────────────────────────────

if (!fs.existsSync(SETS_DIR)) {
  console.error(`Sets directory not found: ${SETS_DIR}`);
  process.exit(1);
}

const setFiles = fs
  .readdirSync(SETS_DIR)
  .filter((f) => f.endsWith(".md"))
  .map((f) => path.join(SETS_DIR, f));

let sets: SetRecord[] = setFiles.map(parseSet).filter((s): s is SetRecord => s !== null);

if (includeTags.length > 0)
  sets = sets.filter((s) => includeTags.every((tag) => s.tags.includes(tag)));
if (excludeTags.length > 0)
  sets = sets.filter((s) => !excludeTags.some((tag) => s.tags.includes(tag)));

sets.sort((a, b) =>
  a.sortTitle.localeCompare(b.sortTitle, undefined, { sensitivity: "base" })
);

const totalTunes = sets.reduce(
  (n, s) => n + s.groups.reduce((m, g) => m + g.tunes.length, 0),
  0,
);
console.log(`Processing ${sets.length} sets (${totalTunes} tunes)...`);

// ── Build HTML ────────────────────────────────────────────────────────────────

const renderTimestamp = makeRenderTimestamp();

// Each tune appears once in TUNE_DATA (keyed by renderId). The HTML structure is
// one .set-page per page group. Locked groups (explicit parent bullets) start
// with all their tunes already on one page and are skipped by the merge pass;
// unlocked groups hold one tune and JS merges adjacent same-set ones where both
// fit at MIN_PAIR_SCALE+.
function buildHtml(): string {
  const tuneDataJson = JSON.stringify(
    Object.fromEntries(
      sets.flatMap((s) => s.groups.flatMap((g) => g.tunes.map((t) => [t.renderId, t.abc])))
    )
  );

  const tuneBlockHtml = (t: TuneRef): string => {
    const notesHtml = t.notes.length
      ? `<ul class="tune-notes">${t.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
      : "";
    return `    <div class="tune-block"><div id="${t.renderId}" class="tune-inner"></div>${notesHtml}</div>`;
  };

  // Initial layout: one .set-page per group. A locked group puts all its tunes on
  // that page (and carries data-locked so the merge pass leaves it intact); an
  // unlocked group is a single tune the merge pass may pair with a neighbour.
  // data-sid carries the set id (only on the first page of each set, used for
  // TOC and outline navigation); data-set marks every page in the set so JS can
  // identify merge candidates.
  const setBlocks = sets
    .map((s) =>
      s.groups
        .map((g, i) => {
          const sid         = i === 0 ? ` data-sid="${s.id}"` : "";
          const locked      = g.locked ? ` data-locked="1"` : "";
          const labelSuffix = i === 0 ? "" : " (cont.)";
          const blocks      = g.tunes.map(tuneBlockHtml).join("\n");
          return `<div class="set-page" data-set="${s.id}"${sid}${locked}>
  <div class="set-title">${esc(s.sortTitle)}${labelSuffix}</div>
  <div class="set-content">
${blocks}
  </div>
</div>`;
        })
        .join("\n")
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
${commonStyles({ tocColumns })}

  /* ── Set pages ──
     Each .set-page is a full page (height = PAGE_CONTENT_H). The .set-title
     stays at the top; .set-content holds 1 or 2 .tune-block children and gets
     CSS-transform-scaled if its natural height exceeds the music area. */
  .set-page {
    break-before: page;
    break-after: page;
    height: ${PAGE_CONTENT_H}px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .set-title {
    font-size: 13pt;
    font-weight: bold;
    color: #333;
    margin: 0 0 6pt;
    padding-bottom: 3pt;
    border-bottom: 0.5pt solid #ccc;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex-shrink: 0;
  }
  .set-content {
    flex: 1;
    transform-origin: top center;
  }
  .tune-block { margin-bottom: 12pt; }
  .tune-block:last-child { margin-bottom: 0; }
  .tune-inner { width: 100%; }
  .tune-inner svg { width: 100% !important; height: auto !important; display: block; }
  /* Performance notes from indented sub-bullets, printed beneath the tune. */
  .tune-notes {
    margin: 4pt 0 0;
    padding-left: 18pt;
    font-size: 9.5pt;
    line-height: 1.3;
    color: #444;
    font-style: italic;
  }
  .tune-notes li { margin: 1pt 0; }
</style>
</head>
<body>

${includeCover ? coverPageHtml(title, `Rendered on ${renderTimestamp}`) : ""}

${includeToc ? tocSectionHtml(sets.map((s) => ({ id: s.id, label: s.sortTitle }))) : ""}

${setBlocks}

<script>
window.TUNE_DATA      = ${tuneDataJson};
window.ABCJS_PARAMS   = ${ABCJS_PARAMS};
window.PAGE_CONTENT_H = ${PAGE_CONTENT_H};
window.SET_HEADER_H   = ${TUNE_HEADER_H + 8}; /* set-title + bottom margin */
window.MIN_PAIR_SCALE = ${MIN_PAIR_SCALE};
window.INCLUDE_COVER  = ${includeCover};
window.INCLUDE_TOC    = ${includeToc};
</script>
</body>
</html>`;
}

// ── Browser-side script ───────────────────────────────────────────────────────
// 1. Render each tune into its own .tune-inner div.
// 2. Measure each tune's natural height.
// 3. For each set, greedily merge adjacent solo pages into 2-tune pages when
//    both tunes fit after scaling by at least MIN_PAIR_SCALE. The merged page
//    keeps the first .set-page in the DOM; the second is removed.
// 4. Scale each .set-content if its natural height exceeds the music area.
// 5. Renumber continuation labels ("(cont.)") so they reflect the post-merge
//    page positions for each set.
// 6. Compute page numbers; only the set's first page (data-sid) is recorded.

const BROWSER_SCRIPT = `
(function () {
  try {
    var CONTENT_H      = window.PAGE_CONTENT_H;
    var SET_HEADER_H   = window.SET_HEADER_H;
    var MUSIC_H        = CONTENT_H - SET_HEADER_H;
    var MIN_PAIR_SCALE = window.MIN_PAIR_SCALE;
    var ZOOM_SAFETY    = 0.97;
    var TUNE_GAP_PX    = 16;     // matches .tune-block margin-bottom 12pt ≈ 16px

    var ABCJS  = window.ABCJS;
    var data   = window.TUNE_DATA;
    var params = window.ABCJS_PARAMS;

    // 1. Render each tune.
    for (var id in data) {
      try { ABCJS.renderAbc(id, data[id], params); }
      catch (e) { console.warn('abcjs error for ' + id + ':', e.message); }
    }

    // 2. Measure each tune's natural height, including any notes printed below
    //    it, by measuring the enclosing .tune-block. This way the pairing
    //    decision in step 3 accounts for the music *and* its notes.
    var tuneH = {};
    for (var id in data) {
      var el    = document.getElementById(id);
      var block = el ? el.closest('.tune-block') : null;
      tuneH[id] = block ? block.scrollHeight : (el ? el.scrollHeight : 0);
    }

    function tuneRenderIdOnPage(pageEl) {
      var inner = pageEl.querySelector('.tune-inner');
      return inner ? inner.id : null;
    }

    // 3. Greedy merge of adjacent same-set solo pages.
    //    Walk pages in order; for each page that holds one tune, check if the
    //    next page (same set, also one tune) can be merged in.
    var allPages = Array.prototype.slice.call(document.querySelectorAll('.set-page'));
    var i = 0;
    while (i < allPages.length - 1) {
      var cur  = allPages[i];
      var nxt  = allPages[i + 1];
      var setId = cur.getAttribute('data-set');
      if (nxt.getAttribute('data-set') !== setId) { i++; continue; }
      // Never merge across an explicit (locked) group; it owns its page.
      if (cur.getAttribute('data-locked') || nxt.getAttribute('data-locked')) { i++; continue; }
      // Only merge if both currently hold exactly one tune-block.
      var curBlocks = cur.querySelectorAll('.tune-block');
      var nxtBlocks = nxt.querySelectorAll('.tune-block');
      if (curBlocks.length !== 1 || nxtBlocks.length !== 1) { i++; continue; }

      var tid1 = tuneRenderIdOnPage(cur);
      var tid2 = tuneRenderIdOnPage(nxt);
      var combinedH = tuneH[tid1] + tuneH[tid2] + TUNE_GAP_PX;
      var scaleNeeded = Math.min(1, MUSIC_H / combinedH);

      if (scaleNeeded >= MIN_PAIR_SCALE) {
        // Move the second tune into the first page's content area, then drop nxt.
        var content1 = cur.querySelector('.set-content');
        content1.appendChild(nxtBlocks[0]);
        nxt.parentNode.removeChild(nxt);
        allPages.splice(i + 1, 1);
        // Don't advance i: another adjacent page might now also be mergeable
        // ...but we cap at 2 tunes per page, so just advance.
        i++;
      } else {
        i++;
      }
    }

    // 4. Scale each set-content to fit MUSIC_H.
    var setContents = document.querySelectorAll('.set-content');
    for (var k = 0; k < setContents.length; k++) {
      var sc = setContents[k];
      var h  = sc.scrollHeight;
      if (h > MUSIC_H) {
        var scale = (MUSIC_H / h) * ZOOM_SAFETY;
        sc.style.transform = 'scale(' + scale + ')';
      }
    }

    // 5. Renumber continuation labels per set after merging.
    //    The first .set-page of each set keeps its original title; subsequent
    //    pages get " (cont.)" appended. We rewrite labels from the data-set
    //    attribute so merging stays correct.
    var seenSet = {};
    var remainingPages = document.querySelectorAll('.set-page');
    for (var k = 0; k < remainingPages.length; k++) {
      var pg    = remainingPages[k];
      var sid   = pg.getAttribute('data-set');
      var label = pg.querySelector('.set-title');
      if (!label) continue;
      // Strip any existing (cont.) suffix.
      var base = label.textContent.replace(/\\s*\\(cont\\.\\)\\s*$/, '');
      if (seenSet[sid]) label.textContent = base + ' (cont.)';
      else              label.textContent = base;
      seenSet[sid] = true;
    }

    // 6. Compute page numbers.
    var tocEl       = document.querySelector('.toc-section');
    var tocH        = tocEl ? tocEl.scrollHeight : 0;
    var coverPages  = window.INCLUDE_COVER ? 1 : 0;
    var tocPages    = window.INCLUDE_TOC ? Math.max(1, Math.ceil(tocH / CONTENT_H)) : 0;
    var firstSetPg  = coverPages + tocPages + 1;

    var pageNums  = {};
    var finalPages = document.querySelectorAll('.set-page');
    var pageCursor = firstSetPg;
    for (var k = 0; k < finalPages.length; k++) {
      var sid = finalPages[k].getAttribute('data-sid');
      if (sid) pageNums[sid] = pageCursor;
      pageCursor += 1;
    }

    // 7. Inject TOC page numbers.
    var tocLinks = document.querySelectorAll('.toc-list a[href]');
    for (var k = 0; k < tocLinks.length; k++) {
      var a   = tocLinks[k];
      var sid = a.getAttribute('href').slice(1);
      var pg  = pageNums[sid];
      if (pg) {
        var span = a.querySelector('.toc-pg');
        if (span) span.textContent = String(pg);
      }
    }

    window.__done   = true;
    window.__result = { pages: pageNums, firstSetPg: firstSetPg };
  } catch (e) {
    window.__error = e.message;
    console.error('Setbook render script error:', e);
  }
})();
`;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (sets.length === 0) {
    console.error("No sets matched the filters; nothing to generate.");
    process.exit(1);
  }

  const abcjsPath = resolveAbcjsPath(__dirname);

  const result = await renderToPdf({
    html:            buildHtml(),
    browserScript:   BROWSER_SCRIPT,
    outputPath,
    title,
    renderTimestamp,
    abcjsPath,
  });

  const { pages, firstSetPg } = result;

  console.log("Adding PDF outlines...");
  const tocPage = includeCover ? 2 : 1;
  const outlineEntries: OutlineEntry[] = [
    ...(includeToc ? [{ title: "Table of Contents", page: tocPage }] : []),
    ...sets.map((s) => ({ title: s.sortTitle, page: pages[s.id] ?? firstSetPg })),
  ];
  await addOutlines(outputPath, outlineEntries);

  const sizeKb = Math.round(fs.statSync(outputPath).size / 1024);
  console.log(`Done! PDF written to: ${outputPath} (${sizeKb} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
