# tunebook

Scripts that turn a vault of [ABC notation](https://abcnotation.com/) tunes into
printable PDF books — full tunebooks, chord-chart editions, and setlists.

| Script | What it makes |
|--------|---------------|
| `generate-tunebook.ts` | A book of every tune (one per page), sorted, with a table of contents and indexes. Optional chord charts under each tune, or a chords-only edition. |
| `generate-setbook.ts`  | A book built from `sets/` files — up to two tunes per page where they fit, with explicit grouping and per-tune performance notes. |
| `chord-chart.ts`       | Standalone ABC → chord-chart converter. Importable, and runnable on its own. |
| `tunebook-lib.ts`      | Shared layout, PDF, and rendering helpers. |

## Requirements

- [Node.js](https://nodejs.org/) 20+ (uses [`tsx`](https://tsx.is) to run the
  TypeScript directly — no build step).
- Tunes stored as Markdown files with a ```` ```music-abc ```` fenced block.

## Setup

`node_modules/` is not committed, so install dependencies first:

```sh
npm install
```

This pulls in `tsx`, `puppeteer` (which downloads a headless Chromium for PDF
rendering), `abcjs`, `gray-matter`, and `pdf-lib`.

## Configuration

Paths come from a local `.env` (loaded automatically by `tunebook-lib.ts`). Real
shell environment variables override the file, and a leading `~/` is expanded.

| Variable     | Meaning                                       | Default                           |
|--------------|-----------------------------------------------|-----------------------------------|
| `VAULT_DIR`  | Tune data — expects `abc/` and `sets/` inside | `~/manda-general-knowledge-vault` |
| `OUTPUT_DIR` | Where generated PDFs are written              | same as `VAULT_DIR`               |

The committed `.env` doubles as an example; edit it to point at your own vault,
or override per-run. The source directory can also be overridden with the
`--vault-dir` flag (highest precedence):

```sh
OUTPUT_DIR=. npx tsx generate-tunebook.ts            # drop the PDF here instead of the vault
VAULT_DIR=~/tunes npx tsx generate-tunebook.ts       # read tunes from elsewhere
npx tsx generate-tunebook.ts --vault-dir ~/tunes     # same, as a flag (beats env / .env)
```

### Fonts

Titles and body text can use any font installed locally (Chromium resolves it).
Both default to the original Palatino/serif look.

```sh
npx tsx generate-tunebook.ts --chords \
  --title-font "TC Wonderling Round" \
  --text-font  "TC Jimmy Sans Pro"
```

`--title-font` styles tune/cover/section titles; `--text-font` styles body text,
the TOC, indexes, composer/chord-symbol text, and notes. (Chord-chart grids stay
monospace for alignment.)

Each chosen font is located on disk and embedded in the PDF via `@font-face`, so
it renders even if its license flags would otherwise stop Chromium embedding it
(e.g. "Preview & Print" fonts) — and the PDF stays self-contained. Font lookup
checks the standard macOS font folders.

## Usage

Every script supports `--help`. Common runs:

```sh
# Full tunebook of all tunes
npx tsx generate-tunebook.ts

# …with a chord chart under each tune that has chords
npx tsx generate-tunebook.ts --chords

# Chords-only edition (title/composer/key + chart, no staff)
npx tsx generate-tunebook.ts --chords-only --title "Vault Tunes Chords"

# Setbook for one tag
npx tsx generate-setbook.ts --include-tag Rufous --exclude-tag NeedsABC --title "Rufous Sets"

# Just print one tune's chord chart to the terminal
npx tsx chord-chart.ts "$VAULT_DIR/abc/Kelly Peck's.md"
```

Shared options (both generators): `--title`, `--include-tag` / `--exclude-tag`
(repeatable), `--output PATH`, `--no-cover`, `--no-toc`, `--toc-columns N`.
`generate-tunebook.ts` adds `--chords`, `--chords-only`, `--no-type-index`,
`--no-author-index`; `generate-setbook.ts` reads its layout from the set files.

## Data format

**Tunes** live in `<vault>/abc/*.md`, each with a fenced ABC block:

````md
```music-abc
X:1
T:Kelly Peck's
M:6/8
K:G
"G" D(GF) G(Bc) | "Bm" -B,(CD) E(DE) | ...
```
````

Frontmatter fields like `Sort Name`, `Key`, `Type`, `Composer`, and `tags` feed
the sorting, indexes, and tag filters.

**Sets** live in `<vault>/sets/*.md` and reference tunes with Obsidian links.
Top-level links are standalone tunes; a plain-text parent bullet groups the
links beneath it onto one shared page; an indented note becomes a performance
note printed under that tune:

```md
- [[abc/Amy in the Bog|Amy in the Bog]]
- The Judge                       (group header — these share a page)
    - [[abc/The Judge|The Judge]]
        - Sax solo first time     (note printed under The Judge)
    - [[The Judge (harmony)]]
```

## Output

PDFs are written to `OUTPUT_DIR` as `<title>.pdf` (e.g. `Vault Tunes.pdf`), or to
the exact path given with `--output`.
