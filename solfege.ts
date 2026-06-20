/**
 * abc → solfège annotator.  Standalone and dependency-free: the core
 * `abcToSolfege(abc)` takes an ABC tune as a string and returns the *same* ABC
 * with a `w:` lyric line inserted under every music line, spelling each note as
 * a movable-do solfège syllable.
 *
 * Movable do with **do = the tonic** (a "do-based" system), so the syllables
 * describe scale degrees regardless of major/minor:
 *
 *   • D dorian  → D=do E=re F=me G=fa A=sol B=la C=te
 *   • A mixolyd. → A=do B=re C#=mi D=fa E=sol F#=la G=te
 *
 * Chromatic notes use the usual raised/lowered substitutions (di ri fi si li /
 * ra me se le te), chosen by how the note is spelled against the key, so a
 * minor third reads "me", a flat seventh "te", a raised fourth "fi", etc.
 *
 * Can also be run directly:  `tsx solfege.ts <tune.md|tune.abc>` — prints the
 * annotated ABC.
 */

import * as fs from "fs";

// ── Pitch & solfège tables ────────────────────────────────────────────────────
// Letter → pitch class (semitones above C) and a 0-based diatonic index.
const LETTER_PC:  Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const LETTER_IDX: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

// Semitones of each major-scale degree (0..6) above the tonic.
const MAJOR_SEMI = [0, 2, 4, 5, 7, 9, 11];

// Syllables by diatonic degree (0..6) for the unaltered, raised and lowered
// forms. Raising mi/ti or lowering do/fa lands on a neighbour's pitch and has no
// standard spelling here (null) — those fall back to CHROM by absolute pitch.
const MAJOR_SYL   = ["do", "re", "mi", "fa", "sol", "la", "ti"];
const RAISED_SYL  = ["di", "ri", null, "fi", "si",  "li", null];
const LOWERED_SYL = [null, "ra", "me", null, "se",  "le", "te"];

// Default syllable per absolute semitone above the tonic (fallback spelling).
const CHROM = ["do", "ra", "re", "me", "mi", "fa", "fi", "sol", "le", "la", "te", "ti"];

// ── Key parsing ───────────────────────────────────────────────────────────────
// How far a mode sits from the major (Ionian) scale on the same tonic, measured
// in steps around the circle of fifths (negative = flatward).
const MODE_OFFSET: Record<string, number> = {
  ion: 0, maj: 0, dor: -2, phr: -4, lyd: 1, mix: -1, aeo: -3, min: -3, loc: -5,
};
// Sharps in a major key built on each natural letter (circle-of-fifths value).
const BASE_MAJOR_SHARPS: Record<string, number> = { C: 0, D: 2, E: 4, F: -1, G: 1, A: 3, B: 5 };
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER  = ["B", "E", "A", "D", "G", "C", "F"];

interface Key {
  tonicPC:   number;                 // pitch class of the tonic (0..11)
  tonicLet:  string;                 // tonic letter (C..B), used for degree numbering
  sig:       Record<string, number>; // key-signature alteration per letter (−2..+2 semitones)
}

function normalizeMode(word: string): string {
  const w = word.toLowerCase();
  if (w === "")            return "ion";
  if (w.startsWith("mix")) return "mix";
  if (w.startsWith("maj") || w.startsWith("ion")) return "ion";
  if (w.startsWith("dor")) return "dor";
  if (w.startsWith("phr")) return "phr";
  if (w.startsWith("lyd")) return "lyd";
  if (w.startsWith("loc")) return "loc";
  if (w.startsWith("aeo") || w.startsWith("min") || w[0] === "m") return "aeo";
  return "ion";
}

// Parse a K: field value (e.g. "Amix", "F#m", "D dorian", "Bb") into a Key, or
// null for keyless / clef-only lines (K:none, K:clef=bass, …).
function parseKey(value: string): Key | null {
  const m = value.trim().match(/^([A-Ga-g])([#b♯♭]?)\s*([A-Za-z]*)/);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const accCh  = m[2].replace("♯", "#").replace("♭", "b");
  const accSemi = accCh === "#" ? 1 : accCh === "b" ? -1 : 0;
  const mode = normalizeMode(m[3]);

  const count = BASE_MAJOR_SHARPS[letter] + 7 * accSemi + MODE_OFFSET[mode];
  const sig: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0 };
  if (count > 0)
    for (let i = 0; i < count; i++) sig[SHARP_ORDER[i % 7]] += 1;
  else
    for (let i = 0; i < -count; i++) sig[FLAT_ORDER[i % 7]] -= 1;

  return { tonicPC: (LETTER_PC[letter] + accSemi + 12) % 12, tonicLet: letter, sig };
}

// ── Note → syllable ───────────────────────────────────────────────────────────
function syllableFor(letter: string, alterSemi: number, key: Key): string {
  const notePC  = (LETTER_PC[letter] + alterSemi + 144) % 12;
  const degree  = (LETTER_IDX[letter] - LETTER_IDX[key.tonicLet] + 7) % 7;
  const offset  = (notePC - key.tonicPC + 12) % 12;
  let alter = offset - MAJOR_SEMI[degree];     // chromatic alteration vs major scale
  if (alter >  6) alter -= 12;
  if (alter < -6) alter += 12;

  if (alter === 0)  return MAJOR_SYL[degree];
  if (alter === 1  && RAISED_SYL[degree])  return RAISED_SYL[degree]!;
  if (alter === -1 && LOWERED_SYL[degree]) return LOWERED_SYL[degree]!;
  return CHROM[offset];                        // enharmonic / double-accidental fallback
}

// ── Music-line tokenizer ──────────────────────────────────────────────────────
// Walk one logical music line and emit, in order, the things a w: line aligns
// to: a "note" per sounding note/chord (its solfège syllable) and a "bar" per
// barline. Rests, grace notes, decorations, ties and inline fields are skipped —
// matching how abcjs assigns lyrics (one syllable per non-rest note).
type Tok = { kind: "note"; syl: string } | { kind: "bar" };

function tokenizeLine(line: string, key: Key): Tok[] {
  const toks: Tok[] = [];
  // Accidentals set by an inline ^/_/= persist to the bar's end, per pitch
  // (letter + octave). Reset at every barline.
  let measureAcc: Record<string, number> = {};
  let i = 0;

  const pushNote = (letter: string, octave: number, inlineAcc: number | null) => {
    const aKey = letter + octave;
    let alter: number;
    if (inlineAcc !== null) { alter = inlineAcc; measureAcc[aKey] = inlineAcc; }
    else if (aKey in measureAcc) alter = measureAcc[aKey];
    else alter = key.sig[letter];
    toks.push({ kind: "note", syl: syllableFor(letter, alter, key) });
  };

  // Read an accidental run (^ ^^ _ __ =) at s[i]; returns semitone + next index.
  const readAcc = (s: string, j: number): { acc: number | null; next: number } => {
    let acc: number | null = null;
    while (j < s.length && (s[j] === "^" || s[j] === "_" || s[j] === "=")) {
      if (s[j] === "=") acc = 0;
      else acc = (acc ?? 0) + (s[j] === "^" ? 1 : -1);
      j++;
    }
    return { acc, next: j };
  };

  while (i < line.length) {
    const c = line[i];

    if (c === " " || c === "\t") { i++; continue; }
    if (c === "%") break;                                   // trailing comment

    if (c === '"') {                                        // "chord"/annotation
      let j = line.indexOf('"', i + 1);
      i = j < 0 ? line.length : j + 1;
      continue;
    }
    if (c === "!") {                                        // !decoration!
      let j = line.indexOf("!", i + 1);
      i = j < 0 ? line.length : j + 1;
      continue;
    }
    if (c === "{") {                                        // {grace notes} — no lyric
      let j = line.indexOf("}", i + 1);
      i = j < 0 ? line.length : j + 1;
      continue;
    }
    if (c === "+") {                                        // +decoration+
      let j = line.indexOf("+", i + 1);
      i = j < 0 ? line.length : j + 1;
      continue;
    }

    // Barlines (incl. repeats / volta) — emit one bar token, reset accidentals.
    if (c === "|" || c === "[" || c === ":") {
      // Inline field [K:…], [M:…], etc. — handle key change, otherwise skip.
      if (c === "[" && /^\[[A-Za-z]:/.test(line.slice(i))) {
        const j = line.indexOf("]", i + 1);
        const inner = line.slice(i + 1, j < 0 ? line.length : j);
        const fm = inner.match(/^([A-Za-z]):\s?(.*)$/);
        if (fm && fm[1] === "K") { const k = parseKey(fm[2]); if (k) key = k; }
        i = j < 0 ? line.length : j + 1;
        continue;
      }
      // [CEG] stacked chord → one note (use the first written pitch).
      if (c === "[") {
        const j = line.indexOf("]", i + 1);
        const inner = line.slice(i + 1, j < 0 ? line.length : j);
        const nm = inner.match(/(\^\^|__|\^|_|=)?([A-Ga-g])([,']*)/);
        if (nm) {
          const accSemi = nm[1] ? (nm[1] === "=" ? 0 : (nm[1].length) * (nm[1][0] === "^" ? 1 : -1)) : null;
          const letter = nm[2].toUpperCase();
          let octave = nm[2] === nm[2].toLowerCase() ? 1 : 0;
          for (const ch of nm[3]) octave += ch === "'" ? 1 : -1;
          pushNote(letter, octave, accSemi);
        }
        i = j < 0 ? line.length : j + 1;
        // A trailing duration on the chord is irrelevant to alignment; skip it.
        while (i < line.length && /[0-9/<>]/.test(line[i])) i++;
        continue;
      }
      // A real barline. Consume the whole barline glyph, emit one bar token.
      let j = i;
      while (j < line.length && (line[j] === "|" || line[j] === ":" || line[j] === "]" || line[j] === "[")) {
        // stop if we run into an inline field/chord opener
        if (line[j] === "[" && /^\[[A-Za-z]:|^\[[\^_=A-Ga-g]/.test(line.slice(j))) break;
        j++;
      }
      toks.push({ kind: "bar" });
      measureAcc = {};
      i = j;
      // Skip a volta number after the barline (|1, |2, [1, …).
      while (i < line.length && /[0-9,\-.]/.test(line[i])) i++;
      continue;
    }

    // Accidental + note.
    if (c === "^" || c === "_" || c === "=") {
      const { acc, next } = readAcc(line, i);
      i = next;
      if (i < line.length && /[A-Ga-g]/.test(line[i])) {
        const letter = line[i].toUpperCase();
        let octave = line[i] === line[i].toLowerCase() ? 1 : 0;
        i++;
        while (i < line.length && (line[i] === "," || line[i] === "'")) { octave += line[i] === "'" ? 1 : -1; i++; }
        pushNote(letter, octave, acc);
      }
      continue;
    }

    // A bare note.
    if (/[A-Ga-g]/.test(c)) {
      const letter = c.toUpperCase();
      let octave = c === c.toLowerCase() ? 1 : 0;
      i++;
      while (i < line.length && (line[i] === "," || line[i] === "'")) { octave += line[i] === "'" ? 1 : -1; i++; }
      pushNote(letter, octave, null);
      continue;
    }

    i++;                                                   // rests (z/x/Z), durations, slurs, ties, etc.
  }

  return toks;
}

// ── Line reflow ───────────────────────────────────────────────────────────────
// A solfège syllable needs horizontal room under its note, so a dense line (e.g.
// four bars of eighth-notes) gets pushed wider than the staff once lyrics are
// added. ABC renderers only ever *add* space to justify a line — they never
// compress — so lines that overflow the staff stop justifying and each settles at
// its own lyric-driven width, leaving the page ragged (in every renderer).
//
// The cure that works everywhere, because it lives in the ABC itself, is to keep
// each line narrow enough to fit: we break an over-long source line at its
// barlines into shorter staff lines. Sparse lines stay whole; only lines whose
// estimated lyric width exceeds the budget are split.
const BAR_RE = /(:\|\|:|\|\|:|:\|\||::|:\||\|:|\|\]|\[\||\|\||\|)/;

// Roughly how much horizontal room one syllable claims, in "character units"
// (the syllable's own width plus a gap; a 1-char syllable still needs the
// notehead's width, hence the floor of 2). A line is split when a measure would
// push the running total past LINE_BUDGET — tuned so four bars of eighth-notes
// land on two staff lines while a bar of half-notes stays put.
const SYL_COST = (s: string) => Math.max(2, s.length) + 1;
const LINE_BUDGET = 48;

interface Measure { src: string; syls: string[]; endBar: string; }

// Split one music line into measures, pairing each measure's source text with the
// solfège syllables of its notes (threaded through the line so a mid-line [K:]
// change is respected). Returns null if the source/token bar counts disagree, so
// the caller can fall back to not reflowing rather than risk a misaligned w:.
function splitMeasures(line: string, key: Key): Measure[] | null {
  const toks = tokenizeLine(line, key);

  const tokMeasures: string[][] = [[]];
  for (const t of toks) {
    if (t.kind === "bar") tokMeasures.push([]);
    else tokMeasures[tokMeasures.length - 1].push(t.syl);
  }

  const pieces = line.split(BAR_RE);          // [content, bar, content, bar, …, content]
  const contents: string[] = [];
  const bars: string[] = [];
  pieces.forEach((p, i) => (i % 2 === 0 ? contents.push(p) : bars.push(p)));

  if (tokMeasures.length !== contents.length) return null;   // counts disagree → bail

  const measures: Measure[] = [];
  for (let i = 0; i < contents.length; i++) {
    const endBar = i < bars.length ? bars[i] : "";
    const src = contents[i] + endBar;
    if (!src.trim() && (tokMeasures[i] ?? []).length === 0) continue;   // empty tail
    measures.push({ src, syls: tokMeasures[i] ?? [], endBar });
  }
  return measures;
}

// Produce the reflowed { music, w } line pairs for one source music line.
function reflowSolfege(line: string, key: Key): { music: string; w: string }[] {
  const measures = splitMeasures(line, key);

  // Fallback: emit the whole line plus a single w: (no reflow) if splitting the
  // measures isn't safe.
  if (!measures) {
    const parts = tokenizeLine(line, key).map((t) => (t.kind === "bar" ? "|" : t.syl));
    return [{ music: line, w: "w: " + parts.join(" ").replace(/\s+/g, " ").trim() }];
  }

  // Greedily pack measures into lines up to the budget (always ≥ 1 measure). A
  // measure that opens with a volta number (the "2" in ":|2 …") must not start a
  // new line — it would be orphaned from the barline that introduces it — so it
  // is always kept with the measure before it.
  const isVolta = (m: Measure) => /^\s*\[?\s*\d/.test(m.src);
  const groups: Measure[][] = [];
  let group: Measure[] = [];
  let cost = 0;
  for (const m of measures) {
    const c = m.syls.reduce((a, s) => a + SYL_COST(s), 0);
    if (group.length > 0 && !isVolta(m) && cost + c > LINE_BUDGET) { groups.push(group); group = []; cost = 0; }
    group.push(m);
    cost += c;
  }
  if (group.length) groups.push(group);

  return groups.map((grp) => {
    const music = grp.map((m) => m.src).join("").replace(/\s+/g, " ").trim();
    const wParts: string[] = [];
    for (const m of grp) {
      wParts.push(...m.syls);
      if (m.endBar) wParts.push("|");
    }
    return { music, w: "w: " + wParts.join(" ").replace(/\s+/g, " ").trim() };
  });
}

// ── Main conversion ───────────────────────────────────────────────────────────
// Returns the ABC unchanged except for a `w:` solfège line inserted after each
// music line (of the first voice), with over-long lines reflowed onto shorter
// staff lines so the lyrics fit. Header lines, comments and field lines pass
// through verbatim.
export function abcToSolfege(abc: string): string {
  // Normalize line endings and join ABC continuation lines (a trailing "\" means
  // "no score break", so the two source lines are one staff line, sharing one w:).
  const text = abc.replace(/\r\n?/g, "\n").replace(/\\[ \t]*\n/g, " ");
  const rawLines = text.split("\n");

  let key: Key | null = null;
  let seenK = false;
  let firstVoice: string | null = null;
  let currentVoice: string | null = null;

  const out: string[] = [];

  for (const line of rawLines) {
    const trimmed = line.trim();

    // Blank lines and full-line comments pass through.
    if (!trimmed || trimmed.startsWith("%")) { out.push(line); continue; }

    // Header / inline field line "X:...". (A '[' would be an inline field in body
    // music, handled by the tokenizer, so only treat a leading "letter:" here.)
    const field = line.match(/^([A-Za-z+]):\s?(.*)$/);
    if (field) {
      const fkey = field[1];
      if (fkey === "K") { const k = parseKey(field[2]); if (k) key = k; seenK = true; }
      else if (fkey === "V") {
        const id = field[2].trim().split(/\s+/)[0];
        if (id) { if (firstVoice === null) firstVoice = id; currentVoice = id; }
      }
      out.push(line);
      continue;
    }

    if (!seenK || !key) { out.push(line); continue; }      // not in the tune body yet

    // Track an inline [V:n] voice switch at the line start.
    const ivm = line.match(/^\[V:\s*([^\]\s]+)/);
    if (ivm) { if (firstVoice === null) firstVoice = ivm[1]; currentVoice = ivm[1]; }

    // Only annotate the first voice (others are harmony/accompaniment lines).
    const otherVoice = firstVoice !== null && currentVoice !== firstVoice;
    if (otherVoice || !tokenizeLine(line, key).some((t) => t.kind === "note")) {
      out.push(line);                                      // nothing to label
      continue;
    }

    // Emit the reflowed music line(s), each followed by its solfège w: line.
    for (const { music, w } of reflowSolfege(line, key)) { out.push(music); out.push(w); }
  }

  return out.join("\n");
}

// ── Standalone CLI ────────────────────────────────────────────────────────────
// `tsx solfege.ts <tune.md|tune.abc>` — prints the ABC with solfège added.
const invokedDirectly = !!process.argv[1] && /solfege\.[tj]s$/.test(process.argv[1]);
if (invokedDirectly) {
  const file = process.argv[2];
  if (!file) { console.error("usage: tsx solfege.ts <tune.md|tune.abc>"); process.exit(1); }
  const raw = fs.readFileSync(file, "utf-8").replace(/\r\n?/g, "\n");
  const fence = raw.match(/```music-abc\n([\s\S]*?)```/);
  const abc = fence ? fence[1] : raw;
  console.log(abcToSolfege(abc));
}
