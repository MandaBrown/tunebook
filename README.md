# tunebook

Scripts that turn a vault of [ABC notation](https://abcnotation.com/) tunes into
printable PDF books — full tunebooks, chord-chart editions, and setlists.

| Script | What it makes |
|--------|---------------|
| `generate-tunebook.ts` | A book of every tune (one per page), sorted, with a table of contents and indexes. Optional chord charts and/or a movable-do solfège line under each tune, or a chords-only edition. |
| `generate-tune.ts`     | A one-tune PDF from a single ABC/markdown file. Same text/chord/solfège options as the tunebook, no cover or indexes. |
| `generate-setbook.ts`  | A book built from `sets/` files — up to two tunes per page where they fit, with explicit grouping and per-tune performance notes. |
| `chord-chart.ts`       | Standalone ABC → chord-chart converter. Importable, and runnable on its own. |
| `solfege.ts`           | Standalone ABC → solfège annotator: adds a movable-do `w:` lyric line (do = the tonic) under each staff. Importable, and runnable on its own. |
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

Titles, body text, and chord symbols can each use any locally installed font.
Each has an optional weight; everything defaults to the Palatino/serif look.

```sh
npx tsx generate-tunebook.ts --chords \
  --title-font "TC Wonderling Round" \
  --text-font  "TC Jimmy Serif Pro" \
  --chord-font "TC Elderwick" --chord-weight bold   # omit chord opts for abcjs' default
```

- `--title-font` / `--title-weight` — tune / cover / section titles.
- `--text-font` / `--text-weight` — everything else written: body text, TOC,
  indexes, composer, subtitle, source, `%%text` notes, repeat endings, lyrics.
  (Chord-chart grids stay monospace.)
- `--chord-font` / `--chord-weight` — chord symbols above the staff only; if no
  chord font is given, abcjs' own default is used.

A weight is a CSS weight (`bold`, `light`, `600`, …) and selects which face of
the family to use. A font name may also include the weight directly, e.g.
`--chord-font "TC Elderwick Bold"`.

Each chosen face is located on disk and embedded in the PDF via `@font-face`, so
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

# …with a movable-do solfège line under each staff (do = the tonic)
npx tsx generate-tunebook.ts --solfege --title "Vault Tunes (Solfège)"

# Only certain genres (repeatable; multiple genres are OR'd)
npx tsx generate-tunebook.ts --genre Irish --genre Scottish --title "Trad"

# A single tune to its own PDF (same options)
npx tsx generate-tune.ts "$VAULT_DIR/abc/Abe's Retreat.md" --solfege

# Setbook for one tag
npx tsx generate-setbook.ts --include-tag Rufous --exclude-tag NeedsABC --title "Rufous Sets"

# Just print one tune's chord chart, or its solfège, to the terminal
npx tsx chord-chart.ts "$VAULT_DIR/abc/Kelly Peck's.md"
npx tsx solfege.ts "$VAULT_DIR/abc/Abe's Retreat.md"
```

Shared options (both generators): `--title`, `--include-tag` / `--exclude-tag`
(repeatable), `--output PATH`, `--no-cover`, `--no-toc`, `--toc-columns N`.
`generate-tunebook.ts` adds `--chords`, `--chords-only`, `--solfege`,
`--genre` / `--exclude-genre`, `--type` / `--exclude-type`, `--by-type`,
`--no-type-index`, `--no-author-index`; `generate-tune.ts` takes one tune file
plus the font/`--chords`/`--solfege` options; `generate-setbook.ts` reads its
layout from the set files.

### Solfège

`--solfege` (and the standalone `solfege.ts`) writes a movable-do solfège
syllable under every note, with **do = the tonic**, so the syllables read as
scale degrees in any key or mode (D dorian → `do re me fa sol la te`). Chromatic
notes use the usual raised/lowered spellings (`di ri fi si li` / `ra me se le
te`). Because solfège syllables need room under each note, a dense line is
re-broken at its barlines onto shorter staff lines so the lyrics fit and every
line still justifies to the full width — a fix that lives in the ABC itself, so
it renders evenly in other ABC apps too.

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

### Controlling page breaks in a set

Two adjacent standalone tunes are paired onto one page automatically when both
fit. To override that:

- **Group onto one page** — a plain-text parent bullet (as above) forces all the
  links indented beneath it onto a single page.
- **Pin a tune to its own page** — add `(solo)` to a top-level link; it never
  pairs with a neighbour.
- **Force a break** — a horizontal rule (`---`) on its own line breaks the page
  there; tunes won't pair across it.

```md
- [[abc/Reel A]]
- [[abc/Reel B]] (solo)     ← always alone on its page
---                         ← hard page break
- [[abc/Reel C]]
- [[abc/Reel D]]            ← C and D may still pair
```

## Output

PDFs are written to `OUTPUT_DIR` as `<title>.pdf` (e.g. `Vault Tunes.pdf`), or to
the exact path given with `--output`.

`generate-setbook.ts --per-set` instead writes one PDF per set, each named after
the set and containing just that set (no cover or table of contents). They go to
`OUTPUT_DIR`, or to the directory given with `--output`:

```sh
npx tsx generate-setbook.ts --include-tag Rufous --per-set --output ~/set-sheets
```
