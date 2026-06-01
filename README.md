# tunebook

Scripts that turn a vault of ABC tunes into printable PDF books:

- **`generate-tunebook.ts`** — a book of every tune (one per page), with optional
  chord charts (`--chords`) or a chords-only edition (`--chords-only`).
- **`generate-setbook.ts`** — a book built from `sets/` files, two tunes per page
  where they fit, with explicit grouping and per-tune notes.
- **`chord-chart.ts`** — a standalone ABC → chord-chart converter (importable, and
  runnable directly: `npx tsx chord-chart.ts <tune.md>`).
- **`tunebook-lib.ts`** — shared layout, PDF, and rendering helpers.

## Setup

```sh
npm install
```

## Configuration

Paths are read from a local `.env` (loaded by `tunebook-lib.ts`); real shell
environment variables override it. `~/` is expanded.

| Variable     | Meaning                                  | Default            |
|--------------|------------------------------------------|--------------------|
| `VAULT_DIR`  | Tune data (expects `abc/` and `sets/`)   | `~/manda-general-knowledge-vault` |
| `OUTPUT_DIR` | Where generated PDFs are written         | `VAULT_DIR`        |

## Usage

```sh
npx tsx generate-tunebook.ts --help
npx tsx generate-tunebook.ts --chords
npx tsx generate-tunebook.ts --chords-only --title "Vault Tunes Chords"
npx tsx generate-setbook.ts --include-tag Rufous --title "Rufous Sets"
```

Run with `OUTPUT_DIR=. npx tsx generate-tunebook.ts` to drop the PDF in the
current directory instead of the vault.
