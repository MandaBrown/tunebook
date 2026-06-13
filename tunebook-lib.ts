/**
 * Shared utilities for generate-tunebook.ts and generate-setbook.ts.
 *
 * Includes:
 *   - Page-layout constants (letter paper @ 96 dpi, margins matching page.pdf)
 *   - HTML helpers (esc, slugify, frontmatter coercion)
 *   - ABC processing (line stripping, %%newpage splitting)
 *   - Shared CSS / cover / TOC / footer markup
 *   - PDF outline writer (pdf-lib post-processing)
 *   - Puppeteer rendering pipeline (renderToPdf)
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";
import { PDFDocument, PDFDict, PDFName, PDFString, PDFNumber, PDFRef } from "pdf-lib";

// ── Vault / output locations ──────────────────────────────────────────────────
// Load a local .env (simple KEY=VALUE lines) sitting next to the scripts so the
// vault and output directories can be pinned without exporting shell variables.
// Real environment variables take precedence over the file.
(function loadDotEnv() {
  try {
    const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env");
    if (!fs.existsSync(envPath)) return;
    for (const raw of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let val = m[2].trim().replace(/^["']|["']$/g, "");
      if (val.startsWith("~/")) val = path.join(os.homedir(), val.slice(2));
      if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
  } catch { /* ignore a malformed .env */ }
})();

// VAULT_DIR is where the tune data lives (abc/, sets/); OUTPUT_DIR is where the
// generated PDFs are written (defaults to the vault so books land by the notes).
export const VAULT_DIR  = process.env.VAULT_DIR  ?? path.join(os.homedir(), "manda-general-knowledge-vault");
export const OUTPUT_DIR = process.env.OUTPUT_DIR ?? VAULT_DIR;

// ── Layout constants (letter paper at 96 dpi) ─────────────────────────────────
// These MUST match the margin values passed to page.pdf().
export const PDF_MARGIN_TOP_IN  = 0.4;   // inches
export const PDF_MARGIN_BOT_IN  = 0.55;  // inches — extra for footer
export const PDF_MARGIN_SIDE_IN = 0.4;
export const PX_PER_IN          = 96;
export const PAPER_W_PX         = 8.5 * PX_PER_IN;   // 816
export const PAPER_H_PX         = 11  * PX_PER_IN;   // 1056
export const PAGE_CONTENT_H     = Math.round(
  PAPER_H_PX - (PDF_MARGIN_TOP_IN + PDF_MARGIN_BOT_IN) * PX_PER_IN
); // 965
// Height reserved for the per-page label (filename or set title).
export const TUNE_HEADER_H = 22;
export const TUNE_MUSIC_H  = PAGE_CONTENT_H - TUNE_HEADER_H; // 943

// ── Generic helpers ──────────────────────────────────────────────────────────
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function toStringArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).filter((s) => s.trim());
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

// Trim a frontmatter value to a string, or "" if it isn't a usable string.
// Handy as `coerceString(a) || coerceString(b) || fallback`.
export function coerceString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function sortWithSentinel(keys: Iterable<string>, sentinel: string): string[] {
  return Array.from(keys).sort((a, b) => {
    if (a === sentinel) return 1;
    if (b === sentinel) return -1;
    return a.localeCompare(b);
  });
}

export function getOrCreate<K, V>(map: Map<K, V>, key: K, init: () => V): V {
  if (!map.has(key)) map.set(key, init());
  return map.get(key)!;
}

// ── Shared CLI option parsing ─────────────────────────────────────────────────
// Options common to both generators. `outputPath` is null when --output was not
// given, so the caller can derive its own default filename from the title.
// Unknown flags are ignored here, leaving each generator free to scan `args`
// for its own extra flags (e.g. tunebook's --no-type-index).
export interface CommonCliOptions {
  includeTags:  string[];
  excludeTags:  string[];
  title:        string;
  outputPath:   string | null;
  vaultDir:     string | null;   // --vault-dir override (null → use VAULT_DIR)
  titleFont:    string | null;   // --title-font (null → default look)
  textFont:     string | null;   // --text-font  (null → default look)
  chordFont:    string | null;   // --chord-font (null → abcjs default)
  includeCover: boolean;
  includeToc:   boolean;
  tocColumns:   number;
}

// Resolve a directory CLI argument: expand a leading ~/ and make it absolute.
function resolveDir(p: string): string {
  if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

export function parseCommonArgs(args: string[], defaultTitle: string): CommonCliOptions {
  const o: CommonCliOptions = {
    includeTags: [], excludeTags: [], title: defaultTitle, outputPath: null, vaultDir: null,
    titleFont: null, textFont: null, chordFont: null, includeCover: true, includeToc: true, tocColumns: 2,
  };
  for (let i = 0; i < args.length; i++) {
    if      (args[i] === "--include-tag" && args[i + 1]) o.includeTags.push(args[++i]);
    else if (args[i] === "--exclude-tag" && args[i + 1]) o.excludeTags.push(args[++i]);
    else if (args[i] === "--title"       && args[i + 1]) o.title = args[++i];
    else if (args[i] === "--output"      && args[i + 1]) o.outputPath = path.resolve(args[++i]);
    else if (args[i] === "--vault-dir"   && args[i + 1]) o.vaultDir = resolveDir(args[++i]);
    else if (args[i] === "--title-font"  && args[i + 1]) o.titleFont = args[++i];
    else if (args[i] === "--text-font"   && args[i + 1]) o.textFont = args[++i];
    else if (args[i] === "--chord-font"  && args[i + 1]) o.chordFont = args[++i];
    else if (args[i] === "--no-cover")                   o.includeCover = false;
    else if (args[i] === "--no-toc")                     o.includeToc = false;
    else if (args[i] === "--toc-columns" && args[i + 1]) o.tocColumns = parseInt(args[++i], 10);
  }
  return o;
}

// ── ABC processing ───────────────────────────────────────────────────────────
// Lines stripped or transformed before passing ABC to abcjs.
// Q: is never rendered per user requirement; *font directives are abcm2ps-specific.
const STRIP_LINE =
  /^(Q:|%%printTempo|%%titlefont|%%textfont|%%composerfont|%%infofont|%%setfont)/;

export function processAbcLine(line: string): string | null {
  if (STRIP_LINE.test(line)) return null;
  // abcm2ps uses $N to switch fonts in %%text (e.g. $1 = italic); abcjs doesn't.
  if (/^%%text\s+\$\d+/.test(line)) return line.replace(/^(%%text\s+)\$\d+\s*/, "$1");
  return line;
}

// Normalize Windows (CRLF) and classic-Mac (CR) line endings to plain LF so the
// rest of the line-based parsing (splits, ^/$ anchors, the fence regex) behaves.
export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

export function cleanAbc(abc: string): string {
  return normalizeNewlines(abc)
    .split("\n")
    .map(processAbcLine)
    .filter((l): l is string => l !== null)
    .join("\n")
    .trim();
}

// Pull the ```music-abc fenced block out of a tune note's markdown and return it
// cleaned, or null if the note has no ABC block.
const ABC_BLOCK_RE = /```music-abc\n([\s\S]*?)```/;
export function extractAbcBlock(markdown: string): string | null {
  const m = normalizeNewlines(markdown).match(ABC_BLOCK_RE);
  return m ? cleanAbc(m[1]) : null;
}

// Split an ABC tune at %%newpage directives. abcjs doesn't understand %%newpage,
// so we render each chunk as an independent ABC document. The original header
// lines (everything up to and including the first K:) are re-prepended to each
// chunk.
//
// On continuation chunks, the title block becomes [first T from original] +
// [any T: lines the user wrote right after %%newpage], so the main title
// always repeats and the user can add a per-page subtitle.
// Other text-rendering info fields (C/S/R/N/H/A/O/B/Z) are dropped from
// continuation headers so composer, source, etc. only print on page 1.
export function splitAbcByNewpage(abc: string): string[] {
  abc = normalizeNewlines(abc);
  const lines = abc.split("\n");
  if (!lines.some((l) => /^%%newpage\b/.test(l))) return [abc];

  let kIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^K:/.test(lines[i])) { kIdx = i; break; }
  }
  if (kIdx === -1) return [abc];

  const headerLines = lines.slice(0, kIdx + 1);
  const bodyLines   = lines.slice(kIdx + 1);
  const firstT      = headerLines.find((l) => /^T:/.test(l));

  const bodyChunks: string[][] = [[]];
  for (const line of bodyLines) {
    if (/^%%newpage\b/.test(line)) bodyChunks.push([]);
    else                            bodyChunks[bodyChunks.length - 1].push(line);
  }

  return bodyChunks
    .filter((c) => c.some((l) => l.trim().length > 0))
    .map((body, i) => {
      if (i === 0) return [...headerLines, ...body].join("\n");

      const currentTs: string[] = [];
      let bodyStart = 0;
      while (bodyStart < body.length) {
        const l = body[bodyStart];
        if (/^T:/.test(l))        { currentTs.push(l); bodyStart++; }
        else if (l.trim() === "") { bodyStart++; }
        else break;
      }

      const titleBlock: string[] = [];
      if (firstT) titleBlock.push(firstT);
      titleBlock.push(...currentTs);

      let inserted = false;
      const newHeader: string[] = [];
      for (const l of headerLines) {
        if (/^T:/.test(l)) {
          if (!inserted) { newHeader.push(...titleBlock); inserted = true; }
        } else if (/^[CSRNHABOZ]:/.test(l)) {
          // drop text-rendering info fields
        } else if (/^K:/.test(l) && !inserted) {
          newHeader.push(...titleBlock);
          newHeader.push(l);
          inserted = true;
        } else {
          newHeader.push(l);
        }
      }

      return [...newHeader, ...body.slice(bodyStart)].join("\n");
    });
}

// ── Fonts ─────────────────────────────────────────────────────────────────────
// Title vs text (body) font family names — any locally installed font Chromium
// can resolve. null means "keep the default look" (serif / the Palatino stack).
export interface FontOptions { titleFont: string | null; textFont: string | null; chordFont: string | null; }

// abcjs params. No `wrap` — source line breaks are honoured exactly. The main
// title uses titleFont; every other text slot abcjs draws (subtitle, composer,
// source/info, %%text notes, chord symbols, lyrics, part labels, …) uses
// textFont, so all written text in the music matches the chosen body font.
export function abcjsParams(fonts: FontOptions): string {
  const title = fonts.titleFont ?? "serif";
  const text  = fonts.textFont  ?? "serif";
  const format: Record<string, string> = {
    titlefont:      `${title} 22`,
    subtitlefont:   `${text} 15`,
    composerfont:   `${text} 12`,
    infofont:       `${text} 11`,
    historyfont:    `${text} 13`,
    textfont:       `${text} 13`,
    annotationfont: `${text} 11`,
    partsfont:      `${text} 15`,
    wordsfont:      `${text} 13`,
    vocalfont:      `${text} 12`,
  };
  // Chord symbols (gchord) are separately configurable; if no chord font is
  // given we leave gchordfont unset so abcjs uses its own default.
  if (fonts.chordFont) format.gchordfont = `${fonts.chordFont} 11`;
  return JSON.stringify({ responsive: "resize", scale: 1.0, format });
}

// ── Font embedding ────────────────────────────────────────────────────────────
// Chromium renders a system font on screen but refuses to embed it in a PDF
// unless its fsType permits installable embedding — restricted fonts (e.g.
// fsType "Preview & Print") silently fall back to serif. To honour any locally
// installed font we locate its file and inline it with @font-face, which is
// treated as an author web font and always embeds.

// Read the (typographic) family and subfamily from an sfnt 'name' table.
function readFontNames(file: string): { family: string; subfamily: string } | null {
  let buf: Buffer;
  try { buf = fs.readFileSync(file); } catch { return null; }
  if (buf.length < 12) return null;
  const numTables = buf.readUInt16BE(4);
  let nameOff = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString("latin1", rec, rec + 4) === "name") { nameOff = buf.readUInt32BE(rec + 8); break; }
  }
  if (nameOff < 0 || nameOff + 6 > buf.length) return null;
  const count  = buf.readUInt16BE(nameOff + 2);
  const strOff = nameOff + buf.readUInt16BE(nameOff + 4);
  let family = "", typoFamily = "", subfamily = "";
  for (let i = 0; i < count; i++) {
    const r = nameOff + 6 + i * 12;
    if (r + 12 > buf.length) break;
    const platformID = buf.readUInt16BE(r);
    const nameID     = buf.readUInt16BE(r + 6);
    const len        = buf.readUInt16BE(r + 8);
    const off        = strOff + buf.readUInt16BE(r + 10);
    if (off + len > buf.length) continue;
    // UTF-16BE (Windows/Unicode platforms) is ASCII-with-nulls for font names.
    const raw = buf.toString("latin1", off, off + len);
    const s = (platformID === 3 || platformID === 0) ? raw.replace(/ /g, "") : raw;
    if      (nameID === 1  && !family)     family = s;
    else if (nameID === 16)                typoFamily = s;
    else if (nameID === 2  && !subfamily)  subfamily = s;
  }
  return { family: (typoFamily || family).trim(), subfamily: subfamily.trim() };
}

const FONT_DIRS = [
  path.join(os.homedir(), "Library", "Fonts"),
  "/Library/Fonts",
  "/System/Library/Fonts",
  "/System/Library/Fonts/Supplemental",
];

// Resolve each requested family name to a font file (preferring the Regular
// face) in a single pass over the font directories. Case/space-insensitive.
function resolveFontFiles(families: string[]): Map<string, string> {
  const want = new Map(families.map((f) => [f.trim().toLowerCase(), f]));
  const file = new Map<string, string>();      // key → path
  const haveRegular = new Set<string>();
  for (const dir of FONT_DIRS) {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      if (!/\.(otf|ttf)$/i.test(e)) continue;
      const p = path.join(dir, e);
      const names = readFontNames(p);
      if (!names) continue;
      const key = names.family.toLowerCase();
      if (!want.has(key) || haveRegular.has(key)) continue;
      const isRegular = names.subfamily === "" || /^regular$/i.test(names.subfamily);
      if (!file.has(key) || isRegular) file.set(key, p);
      if (isRegular) haveRegular.add(key);
    }
  }
  const out = new Map<string, string>();
  for (const [key, orig] of want) { const p = file.get(key); if (p) out.set(orig, p); }
  return out;
}

// @font-face blocks (data-URL embedded) for the requested fonts, so HTML text
// and abcjs SVG text both resolve them. Missing fonts are skipped (the name is
// still used, which works for unrestricted / generic families).
export function fontFaceBlocks(fonts: FontOptions): string {
  const families = [fonts.titleFont, fonts.textFont, fonts.chordFont].filter((f): f is string => !!f);
  if (families.length === 0) return "";
  const files = resolveFontFiles([...new Set(families)]);
  const blocks: string[] = [];
  for (const [family, p] of files) {
    const ttf = path.extname(p).toLowerCase() === ".ttf";
    const b64 = fs.readFileSync(p).toString("base64");
    blocks.push(`@font-face { font-family: "${family}"; src: url(data:${ttf ? "font/ttf" : "font/otf"};base64,${b64}) format("${ttf ? "truetype" : "opentype"}"); }`);
  }
  return blocks.join("\n");
}

// ── Render timestamp ─────────────────────────────────────────────────────────
export function makeRenderTimestamp(): string {
  return new Date().toLocaleString("en-US", {
    month: "long", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

// ── Shared HTML/CSS pieces ───────────────────────────────────────────────────
// Body padding mirrors the page.pdf() side margins so abcjs SVGs render at the
// same width they'll occupy in the printed output.
export function commonStyles(opts: { tocColumns: number } & FontOptions): string {
  // The text font drives the body; the title font is exposed as --title-font for
  // cover/section titles. Either falls back to the original Palatino/serif look.
  const textStack = opts.textFont
    ? `"${opts.textFont}", "Palatino Linotype", Palatino, serif`
    : `"Palatino Linotype", Palatino, "Book Antiqua", serif`;
  const titleStack = opts.titleFont ? `"${opts.titleFont}", serif` : "var(--text-font)";
  return `
  ${fontFaceBlocks(opts)}

  * { box-sizing: border-box; }

  body {
    --text-font: ${textStack};
    --title-font: ${titleStack};
    font-family: var(--text-font);
    margin: 0;
    padding: 0 ${PDF_MARGIN_SIDE_IN}in;
    font-size: 11pt;
    color: #111;
  }

  @page { size: letter; }

  /* ── Cover ── */
  .cover-page {
    break-after: page;
    height: 9.5in;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
  }
  .cover-title { font-family: var(--title-font); font-size: 42pt; font-weight: bold; margin: 0 0 18pt; letter-spacing: 0.02em; }
  .cover-sub   { font-size: 12pt; color: #666; font-style: italic; }

  /* ── TOC ── */
  .toc-section { break-before: page; }
  .toc-section h1 {
    font-size: 20pt;
    margin: 0 0 12pt;
    padding-bottom: 4pt;
    border-bottom: 1pt solid #333;
  }
  .toc-list {
    list-style: none;
    padding: 0;
    margin: 0;
    columns: ${opts.tocColumns};
    column-gap: 0.3in;
  }
  .toc-list li  { break-inside: avoid; margin-bottom: 3pt; font-size: 9.5pt; }
  .toc-list a   { display: flex; justify-content: space-between; text-decoration: none; color: inherit; }
  .toc-title    { flex: 1; padding-right: 4pt; overflow: hidden; }
  /* Pre-reserved width prevents reflow when numbers are injected client-side */
  .toc-pg       { min-width: 28pt; text-align: right; color: #555; flex-shrink: 0; font-variant-numeric: tabular-nums; }
  `;
}

export function coverPageHtml(title: string, subtitle: string): string {
  return `<div class="cover-page">
  <div class="cover-title">${esc(title)}</div>
  <div class="cover-sub">${esc(subtitle)}</div>
</div>`;
}

export interface TocEntry { id: string; label: string; }

export function tocSectionHtml(entries: TocEntry[]): string {
  const lis = entries
    .map((e) => `<li><a href="#${e.id}"><span class="toc-title">${esc(e.label)}</span><span class="toc-pg"></span></a></li>`)
    .join("\n");
  return `<div class="toc-section">
  <h1>Table of Contents</h1>
  <ol class="toc-list">
${lis}
  </ol>
</div>`;
}

export function footerTemplate(title: string, renderTimestamp: string, textFont: string | null): string {
  return `<div style="
      width: 100%;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-family: ${textFont ? `'${textFont}', serif` : "serif"};
      font-size: 9px;
      color: #666;
      padding: 0 ${PDF_MARGIN_SIDE_IN}in;
      box-sizing: border-box;
    ">
      <span>${esc(title)} &nbsp;&middot;&nbsp; ${esc(renderTimestamp)}</span>
      <span class="pageNumber"></span>
    </div>`;
}

// ── PDF outline (bookmarks) ──────────────────────────────────────────────────
// Puppeteer's outline:true only works from HTML headings; our tune/set titles
// come from SVGs and divs.  We post-process with pdf-lib instead, using page
// numbers already computed by the browser script.
export interface OutlineEntry { title: string; page: number; }

export async function addOutlines(pdfPath: string, entries: OutlineEntry[]): Promise<void> {
  if (entries.length === 0) return;

  const rawBytes = fs.readFileSync(pdfPath);
  const pdfDoc   = await PDFDocument.load(rawBytes);
  const ctx      = pdfDoc.context;
  const pageCount = pdfDoc.getPageCount();

  function makeDest(pageNum: number) {
    const clamped = Math.max(1, Math.min(pageNum, pageCount));
    const pageRef = pdfDoc.getPage(clamped - 1).ref;
    return ctx.obj([pageRef, PDFName.of("XYZ"), null, null, null]);
  }

  const refs:  PDFRef[]  = [];
  const dicts: PDFDict[] = [];
  for (const e of entries) {
    const d = ctx.obj({ Title: PDFString.of(e.title), Dest: makeDest(e.page) }) as PDFDict;
    refs.push(ctx.register(d));
    dicts.push(d);
  }

  const rootDict = ctx.obj({
    Type:  PDFName.of("Outlines"),
    Count: PDFNumber.of(entries.length),
    First: refs[0],
    Last:  refs[refs.length - 1],
  }) as PDFDict;
  const rootRef = ctx.register(rootDict);

  for (let i = 0; i < refs.length; i++) {
    dicts[i].set(PDFName.of("Parent"), rootRef);
    if (i > 0)                dicts[i].set(PDFName.of("Prev"), refs[i - 1]);
    if (i < refs.length - 1)  dicts[i].set(PDFName.of("Next"), refs[i + 1]);
  }

  pdfDoc.catalog.set(PDFName.of("Outlines"), rootRef);
  pdfDoc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));

  const saved = await pdfDoc.save();
  fs.writeFileSync(pdfPath, Buffer.from(saved));
  console.log(`  ${entries.length} outline entries written.`);
}

// ── PDF generation pipeline ──────────────────────────────────────────────────
// Each caller's browser script should set window.__done = true and
// window.__result = {...whatever the caller needs back...}.
export interface RenderToPdfOptions {
  html:             string;
  browserScript:    string;
  outputPath:       string;
  title:            string;
  renderTimestamp:  string;
  abcjsPath:        string;
  textFont:         string | null;
}

export async function renderToPdf(opts: RenderToPdfOptions): Promise<any> {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // Viewport width = letter paper width @ 96dpi so responsive SVGs size to the
    // same width they'll have after page.pdf() side margins are applied.
    await page.setViewport({ width: PAPER_W_PX, height: PAPER_H_PX });
    await page.setContent(opts.html, { waitUntil: "domcontentloaded" });
    await page.emulateMediaType("print");

    console.log("Rendering ABC notation...");
    await page.addScriptTag({ path: opts.abcjsPath });
    await page.evaluate(opts.browserScript);

    const statusJson = await page.evaluate(
      `JSON.stringify({ done: window.__done, error: window.__error, result: window.__result })`
    );
    const { done, error, result } = JSON.parse(statusJson as string);
    if (error) console.warn("Browser script warning:", error);
    if (!done) throw new Error("Browser render script did not complete.");

    // Let SVG layout settle before PDF capture
    await new Promise((r) => setTimeout(r, 800));

    console.log("Generating PDF...");
    await page.pdf({
      path: opts.outputPath,
      format: "Letter",
      printBackground: false,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: footerTemplate(opts.title, opts.renderTimestamp, opts.textFont),
      margin: {
        top:    `${PDF_MARGIN_TOP_IN}in`,
        bottom: `${PDF_MARGIN_BOT_IN}in`,
        left:   "0",
        right:  "0",
      },
    });

    await page.close();
    return result;
  } finally {
    await browser.close();
  }
}

// ── abcjs path resolution ────────────────────────────────────────────────────
export function resolveAbcjsPath(scriptDir: string): string {
  const p = path.join(scriptDir, "node_modules", "abcjs", "dist", "abcjs-basic-min.js");
  if (!fs.existsSync(p)) {
    console.error("abcjs not found. Run: cd scripts && npm install");
    process.exit(1);
  }
  return p;
}
