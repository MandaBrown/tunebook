/**
 * abc → chord chart converter.  Standalone and dependency-free: the core
 * `abcToChordChart(abc)` takes an ABC tune as a string and returns a
 * Nashville-style bar chart, e.g.
 *
 *     | D  /  | /  /  | G  /  | D  /  :|
 *     | D  /  /  /  | /  /  /  /  | C  D  G  D  |
 *
 * Rules:
 *   • Each measure is divided into N equal slots, where N is the largest number
 *     of chord *changes* found in any single measure of the tune. (A measure
 *     whose chord never changes from the previous one shows all "/".)
 *   • A chord symbol is printed only at the slot where it changes; held beats
 *     show "/".
 *   • The chord currently sounding is always restated at the start of each line.
 *   • A chord's slot is its metric position: the elapsed note-duration before it,
 *     as a fraction of the measure, rounded down to the nearest of the N slots.
 *
 * Can also be run directly:  `tsx chord-chart.ts <tune.md|tune.abc>`
 */

import * as fs from "fs";

export interface ChordChart {
  subdivisions: number;  // N — slots per measure
  meter:        string;  // meter as written in the tune (e.g. "6/8", "C|")
  lines:        string[];// one rendered text line per music line of the tune
}

// ── Chord recognition ─────────────────────────────────────────────────────────
// An ABC "...": quoted string is a chord symbol unless it starts with one of
// ^_<>@ (those are positioned annotations). We further require it to look like a
// real chord so text like "Fine" or "D.C." is ignored.
const CHORD_RE =
  /^[A-G][#b]?(?:m|min|maj|M|dim|aug|sus|add|ø|°|\+|-|#|b|[0-9])*(?:\/[A-G][#b]?)?$/;

function isChord(raw: string): boolean {
  const t = raw.trim();
  if (!t || /^[\^_<>@]/.test(t)) return false;
  return CHORD_RE.test(t);
}

// ── Meter / unit-length parsing ───────────────────────────────────────────────
function parseMeter(v: string): number {
  const t = v.trim();
  if (t === "C")  return 1;     // common time = 4/4
  if (t === "C|") return 1;     // cut time = 2/2
  const m = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (m) return parseInt(m[1], 10) / parseInt(m[2], 10);
  const n = parseFloat(t);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function parseUnit(v: string): number {
  const m = v.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
  if (m) return parseInt(m[1], 10) / parseInt(m[2], 10);
  return 1 / 8;
}

// Beats per measure. Simple meters count the numerator; compound meters (an /8
// meter whose numerator is a multiple of 3 and > 3, e.g. 6/8, 9/8, 12/8) group
// into dotted beats. This is the tick-count a measure is subdivided into.
function meterBeats(v: string): number {
  const t = v.trim();
  if (t === "C")  return 4;   // 4/4
  if (t === "C|") return 2;   // 2/2
  const m = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return 4;
  const num = parseInt(m[1], 10);
  const den = parseInt(m[2], 10);
  if (den === 8 && num % 3 === 0 && num > 3) return num / 3;  // 6/8→2, 9/8→3, 12/8→4
  return num || 4;
}

// Slots (tick marks) per measure: enough to show the densest chord change in the
// tune, snapped to the meter. Even meters (2/4, 4/4, cut time, 6/8) use base-2
// levels with a floor of 2 — so two chords/measure stays at a tidy 2. Triple
// meters (3/4, 9/8) use 1 when chords are sparse, or 3 when any measure subdivides.
function slotsForMeter(beats: number, maxChords: number): number {
  if (beats % 2 === 0) {
    let n = 2;
    while (n < maxChords) n *= 2;     // 2, 4, 8, …
    return n;
  }
  if (maxChords <= 1) return 1;
  let n = 3;
  while (n < maxChords) n *= 3;       // 3, 9, …
  return n;
}

// ── Length parsing inside a measure ───────────────────────────────────────────
// Reads an ABC length suffix at s[i], e.g. "2", "/", "//", "/2", "3/2".
// Returns the multiple of the unit note length, the next index, and whether any
// explicit length was present.
function parseLen(s: string, i: number): { value: number; next: number; hadDigits: boolean } {
  let j = i;
  let numStr = "";
  while (j < s.length && s[j] >= "0" && s[j] <= "9") numStr += s[j++];
  let slashes = 0;
  while (j < s.length && s[j] === "/") { slashes++; j++; }
  let denStr = "";
  while (j < s.length && s[j] >= "0" && s[j] <= "9") denStr += s[j++];

  const num = numStr ? parseInt(numStr, 10) : 1;
  const den = slashes === 0 ? 1 : denStr ? parseInt(denStr, 10) : Math.pow(2, slashes);
  return { value: num / den, next: j, hadDigits: numStr !== "" || slashes > 0 };
}

// Default "in the time of q" for an ABC (p tuplet when q isn't given.
function defaultTupletQ(p: number): number {
  return ({ 2: 3, 3: 2, 4: 3, 6: 2, 8: 3 } as Record<number, number>)[p] ?? 2;
}

interface ChordEvent { chord: string; pos: number; }  // pos in unit-note lengths

// Tokenise one measure's worth of ABC and return the chord symbols with their
// metric position (elapsed note duration before each), measured in unit lengths.
function parseMeasure(s: string): { chords: ChordEvent[]; duration: number } {
  const chords: ChordEvent[] = [];
  let i = 0;
  let elapsed = 0;
  let lastDur = 0;
  let tupletLeft = 0;
  let tupletMul = 1;
  let brokenNext = 1;

  const advance = (dur: number) => {
    const d = dur * (tupletLeft > 0 ? tupletMul : 1) * brokenNext;
    brokenNext = 1;
    if (tupletLeft > 0) tupletLeft--;
    elapsed += d;
    lastDur = d;
  };

  while (i < s.length) {
    const c = s[i];

    if (c === " " || c === "\t") { i++; continue; }

    if (c === '"') {                                   // chord symbol / annotation
      let j = s.indexOf('"', i + 1);
      if (j < 0) j = s.length;
      const inner = s.slice(i + 1, j);
      if (isChord(inner)) chords.push({ chord: inner.trim(), pos: elapsed });
      i = j + 1;
      continue;
    }
    if (c === "!") {                                   // !decoration!
      let j = s.indexOf("!", i + 1);
      i = (j < 0 ? s.length : j + 1);
      continue;
    }
    if (c === "{") {                                   // {grace notes} — no duration
      let j = s.indexOf("}", i + 1);
      i = (j < 0 ? s.length : j + 1);
      continue;
    }
    if (c === "(") {                                   // tuplet "(p" or slur "("
      const m = /^\((\d+)(?::(\d+))?(?::(\d+))?/.exec(s.slice(i));
      if (m) {
        const p = parseInt(m[1], 10);
        const q = m[2] ? parseInt(m[2], 10) : defaultTupletQ(p);
        const r = m[3] ? parseInt(m[3], 10) : p;
        tupletLeft = r; tupletMul = q / p;
        i += m[0].length;
      } else {
        i++;                                           // slur open
      }
      continue;
    }
    if (c === ")" || c === "-" || c === "." || c === "~") { i++; continue; } // slur/tie/decoration
    if ("HIJKLMNOPQRSTUVWuvw".includes(c)) { i++; continue; }                // letter decorations (not A–G notes)
    if (c === "^" || c === "_" || c === "=") { i++; continue; }              // accidental before a note

    if ((c >= "A" && c <= "G") || (c >= "a" && c <= "g")) {                  // a note
      i++;
      while (i < s.length && (s[i] === "," || s[i] === "'")) i++;            // octave marks
      const len = parseLen(s, i); i = len.next;
      advance(len.value);
      continue;
    }
    if (c === "z" || c === "x") {                                            // rest
      i++;
      const len = parseLen(s, i); i = len.next;
      advance(len.value);
      continue;
    }
    if (c === "y") {                                                         // y spacer — no duration
      i++;
      const len = parseLen(s, i); i = len.next;
      continue;
    }
    if (c === "[") {
      if (/^[A-Za-z]:/.test(s.slice(i + 1))) {                              // inline field [K:...]
        let j = s.indexOf("]", i + 1);
        i = (j < 0 ? s.length : j + 1);
        continue;
      }
      let j = s.indexOf("]", i + 1);                                         // [CEG] stacked chord
      if (j < 0) j = s.length;
      const inner = s.slice(i + 1, j);
      i = j + 1;
      const after = parseLen(s, i); i = after.next;
      let unit: number;
      if (after.hadDigits) {
        unit = after.value;
      } else {
        const im = inner.match(/[A-Ga-g][,']*(\d+)?(\/+\d*)?/);             // length of first stacked note
        unit = im ? parseLen(im[0], im[0].search(/[0-9/]/) < 0 ? im[0].length : im[0].search(/[0-9/]/)).value : 1;
      }
      advance(unit);
      continue;
    }
    if (c === ">") { i++; elapsed += 0.5 * lastDur; brokenNext *= 0.5; continue; } // broken rhythm
    if (c === "<") { i++; elapsed -= 0.5 * lastDur; brokenNext *= 1.5; continue; }

    i++;                                                                     // anything else: skip
  }

  return { chords, duration: elapsed };
}

// ── Bar / line splitting ──────────────────────────────────────────────────────
const BAR_RE = /(:\|\|:|\|\|:|:\|\||::|:\||\|:|\|\]|\[\||\|\||\|)/;

interface Measure {
  chords: ChordEvent[];
  duration: number;
  volta: string | null;
  meterUnits: number;       // measure length in unit-note lengths (for chord positions)
  beats: number;            // beats per measure (tick count when subdivided)
  meterStr: string;         // meter as written (e.g. "6/8")
  meterLabel: string | null;// set when the meter changed at this measure
  n: number;                // slots actually used (1 or beats)
  slots?: string[];
}
interface Bar { text: string; }
type Token = { kind: "measure"; m: Measure } | { kind: "bar"; b: Bar };

// A barline split into the parts that render left of, at, and right of its main
// pipe. Repeat dots / volta brackets / a second pipe live in the padding beside
// the pipe so the pipe itself always stays on the grid.
interface BarParts { pre: string; pipe: string; post: string; }
function decomposeBar(b: string): BarParts {
  if (b === "::" || b === ":||:") return { pre: ":", pipe: "|", post: ":" };
  const i = b.indexOf("|");
  if (i < 0) return { pre: "", pipe: "|", post: b };
  return { pre: b.slice(0, i), pipe: "|", post: b.slice(i + 1) };
}

// Split a music line into an ordered run of bar + measure tokens. Volta numbers
// (e.g. the "1" in "|1") are pulled off the measure and attached to the bar
// before it so they print as "|1", ":|2", etc.
function parseMusicLine(line: string, unitLen: number, startMeter: string): { tokens: Token[]; endMeter: string } {
  const pieces = line.split(BAR_RE);  // [content, bar, content, bar, ..., content]
  const tokens: Token[] = [];
  let meterStr = startMeter;
  let meterFraction = parseMeter(meterStr);

  pieces.forEach((piece, idx) => {
    if (idx % 2 === 1) {                                 // a bar delimiter
      tokens.push({ kind: "bar", b: { text: piece } });
      return;
    }
    let content = piece.trim();
    if (!content) return;                                // empty span around bars

    // An inline [M:n/d] at the measure start changes the meter from here on.
    const mm = content.match(/^\[M:\s*([^\]]+)\]\s*/);
    if (mm) { meterStr = mm[1].trim(); meterFraction = parseMeter(meterStr); content = content.slice(mm[0].length); }

    // A leading volta number (the "1" in "|1") is kept on the measure so it can
    // be tucked in just after the barline without shifting the grid.
    let volta: string | null = null;
    const vm = content.match(/^\[?\s*(\d[\d,\-]*)\s+/);
    if (vm) { volta = vm[1]; content = content.slice(vm[0].length); }

    const parsed = parseMeasure(content);
    tokens.push({ kind: "measure", m: {
      chords: parsed.chords, duration: parsed.duration, volta,
      meterUnits: meterFraction / unitLen, beats: meterBeats(meterStr), meterStr, meterLabel: null, n: 1,
    } });
  });

  return { tokens, endMeter: meterStr };
}

// ── Main conversion ───────────────────────────────────────────────────────────
export function abcToChordChart(abc: string): ChordChart | null {
  // Normalize CRLF/CR to LF, then join ABC line continuations (a trailing "\"
  // means "no line break here").
  const rawLines = abc.replace(/\r\n?/g, "\n").replace(/\\\s*\n/g, " ").split("\n");

  let meterStr = "4/4";
  let unitLen: number | null = null;
  let seenK = false;
  let firstVoice: string | null = null;   // only the first voice is charted
  let currentVoice: string | null = null;

  const lineTokens: Token[][] = [];

  for (const raw of rawLines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.startsWith("%")) continue;

    const field = line.match(/^([A-Za-z+]):\s?(.*)$/);
    if (field) {
      const key = field[1];
      if (key === "M") { meterStr = field[2].trim(); }
      else if (key === "L") { unitLen = parseUnit(field[2]); }
      else if (key === "K") { seenK = true; }
      else if (key === "V") {
        const id = field[2].trim().split(/\s+/)[0];
        if (id) { if (firstVoice === null) firstVoice = id; currentVoice = id; }
      }
      continue;                    // field lines are never music
    }
    if (!seenK) continue;          // tune body starts after the first K:

    // Multi-voice: chart only the first voice. A V: field or an inline [V:n]
    // prefix switches the current voice; an unmarked line stays in whatever
    // voice was last selected. Skip any line that isn't the first voice.
    const ivm = line.match(/^\[V:\s*([^\]\s]+)/);
    if (ivm) { if (firstVoice === null) firstVoice = ivm[1]; currentVoice = ivm[1]; }
    if (firstVoice !== null && currentVoice !== firstVoice) continue;

    if (unitLen === null) unitLen = parseMeter(meterStr) < 0.75 ? 1 / 16 : 1 / 8;
    const { tokens, endMeter } = parseMusicLine(line, unitLen, meterStr);
    lineTokens.push(tokens);
    meterStr = endMeter;                 // carry a mid-line meter change forward
  }

  // Drop pickup (anacrusis) measures — chordless lead-ins, not harmonic bars. A
  // pickup sits either at the start of a line or mid-line right after an
  // end-repeat (:|). The very first measure of the tune is always a pickup when
  // chordless; elsewhere we also require an incomplete measure so a held
  // (carried-chord) downbeat measure isn't dropped. An end-repeat barline is
  // preserved when its trailing pickup is removed.
  let firstLineSeen = false;
  for (let li = 0; li < lineTokens.length; li++) {
    const toks = lineTokens[li];
    if (!toks.some((t) => t.kind === "measure")) continue;
    const isFirstLine = !firstLineSeen;
    firstLineSeen = true;

    const remove = new Set<number>();
    let afterEndRepeat = false;   // previous barline was an end-repeat (:|)?
    let seenMeasure = false;
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (t.kind === "bar") { afterEndRepeat = decomposeBar(t.b.text).pre.includes(":"); continue; }

      const lineLeading = !seenMeasure;
      seenMeasure = true;
      const incomplete = t.m.duration < t.m.meterUnits * 0.95;
      const pickup = t.m.chords.length === 0 &&
        ((lineLeading && (isFirstLine || incomplete)) || (afterEndRepeat && incomplete));
      if (!pickup) continue;

      remove.add(k);
      if (afterEndRepeat) {
        if (k + 1 < toks.length && toks[k + 1].kind === "bar") remove.add(k + 1);  // drop trailing bar, keep :|
      } else if (k > 0 && toks[k - 1].kind === "bar") {
        remove.add(k - 1);                                                          // drop leading bar with the pickup
      }
      // else line-leading with no leading bar: drop only the measure; the next bar becomes the leader
    }
    if (remove.size) lineTokens[li] = toks.filter((_, idx) => !remove.has(idx));
  }

  // Collapse identical 1st/2nd endings: if a single-measure first ending and the
  // single-measure second ending after the :| carry the same chords, drop the
  // redundant second ending and its volta markers (just show one ending).
  const chordSig = (m: Measure) => m.chords.map((c) => c.chord).join(",");
  for (const toks of lineTokens) {
    const i1 = toks.findIndex((t) => t.kind === "measure" && t.m.volta === "1");
    if (i1 < 0) continue;
    const i2 = toks.findIndex((t, idx) => idx > i1 && t.kind === "measure" && t.m.volta === "2");
    if (i2 !== i1 + 2) continue;                       // expect M1, bar(:|), M2
    const m1 = (toks[i1] as { kind: "measure"; m: Measure }).m;
    const m2 = (toks[i2] as { kind: "measure"; m: Measure }).m;
    if (chordSig(m1) !== chordSig(m2)) continue;        // endings really differ → keep both
    m1.volta = null;
    toks.splice(i2, i2 + 1 < toks.length && toks[i2 + 1].kind === "bar" ? 2 : 1);  // drop M2 (+ its end bar)
  }

  // Mark any measure whose meter differs from the previous one so a time-
  // signature change is shown in the chart (works mid-line too).
  {
    let lastMeter: string | null = null;
    for (const toks of lineTokens)
      for (const t of toks)
        if (t.kind === "measure") {
          if (lastMeter !== null && t.m.meterStr !== lastMeter) t.m.meterLabel = t.m.meterStr;
          lastMeter = t.m.meterStr;
        }
  }

  // Gather all measures in order; bail if the tune has no chords at all.
  const measures: Measure[] = [];
  for (const toks of lineTokens)
    for (const t of toks) if (t.kind === "measure") measures.push(t.m);
  if (!measures.some((m) => m.chords.length > 0)) return null;

  // Tick marks are beats. Each measure gets slotsForMeter() slots based on the
  // densest chord change in the tune, snapped to its own meter — so even meters
  // sit at a tidy 2 (4 only when a measure has 3+ chords), waltzes get 1 or 3,
  // and measures keep their true length even when the meter changes mid-tune.
  let chordLen = 1;
  let maxChords = 1;
  {
    let sounding = "";
    for (const m of measures) {
      let changes = 0;
      for (const ev of m.chords) {
        chordLen = Math.max(chordLen, ev.chord.length);
        if (ev.chord !== sounding) { changes++; sounding = ev.chord; }
      }
      maxChords = Math.max(maxChords, changes);
    }
  }
  for (const m of measures) m.n = slotsForMeter(m.beats, maxChords);
  const maxN = measures.reduce((mx, m) => Math.max(mx, m.n), 1);

  // ── Pass 2: assign the displayed slots to every measure, in reading order.
  // A new chord prints only where it changes; the current chord is restated at
  // the start of each line and again after any repeat barline (you can't carry a
  // chord across a :| — on the repeat the next bar starts a fresh context).
  let sounding = "";
  for (const toks of lineTokens) {
    let restate = true;                                // line start always restates
    for (const t of toks) {
      if (t.kind === "bar") {
        if (t.b.text.includes(":")) restate = true;    // repeat barline → restate next measure
        continue;
      }
      const m = t.m;
      const soundingBefore = sounding;
      const slots: string[] = new Array(m.n).fill("/");
      for (const ev of m.chords) {
        if (ev.chord === sounding) continue;           // held — leave "/"
        const frac = m.meterUnits > 0 ? ev.pos / m.meterUnits : 0;
        const idx = Math.min(m.n - 1, Math.max(0, Math.floor(frac * m.n + 1e-9)));
        slots[idx] = ev.chord;
        sounding = ev.chord;
      }
      if (restate && slots[0] === "/" && soundingBefore) slots[0] = soundingBefore;
      restate = false;
      m.slots = slots;
    }
  }

  // ── Pass 3: format as an even token grid. The subdivisions are even beats, so
  // every slot and barline is spaced by the same gap and barlines line up
  // vertically down the whole tune. Repeat dots, second pipes and volta numbers
  // are tucked into the gap beside a pipe so they never shift the grid.
  const slotW = chordLen;
  const padSlot = (s: string) => s.padEnd(slotW);

  interface Cell { slots: string[]; volta: string; meterLabel: string; }
  interface Row { bars: BarParts[]; cells: Cell[]; }
  const rows: Row[] = [];
  let maxDeco = 0;

  for (const toks of lineTokens) {
    if (!toks.length) continue;
    const bars: BarParts[] = [];
    const cells: Cell[] = [];
    let expectBar = true;
    const pushBar  = (text: string) => { bars.push(decomposeBar(text)); expectBar = false; };
    const pushCell = (slots: string[], volta: string, meterLabel: string) => { cells.push({ slots, volta, meterLabel }); expectBar = true; };

    if (toks[0].kind === "measure") pushBar("|");                 // synth leading bar
    for (const t of toks) {
      if (t.kind === "bar") {
        if (!expectBar) pushCell(["/"], "", "");                  // bar-bar: empty cell
        pushBar(t.b.text);
      } else {
        if (expectBar) pushBar("|");                              // measure-measure: synth bar
        pushCell(t.m.slots ?? ["/"], t.m.volta ?? "", t.m.meterLabel ?? "");
      }
    }
    if (bars.length === cells.length) pushBar("|");               // synth trailing bar

    for (let j = 0; j < cells.length; j++)
      maxDeco = Math.max(maxDeco, (bars[j].post + cells[j].volta).length, bars[j + 1].pre.length);
    rows.push({ bars, cells });
  }

  const gap = Math.max(2, maxDeco + 1);
  const sep = " ".repeat(gap);
  const lead  = (deco: string) => deco + " ".repeat(gap - deco.length);   // deco hugs the left pipe
  const trail = (deco: string) => " ".repeat(gap - deco.length) + deco;   // deco hugs the right pipe

  const lines = rows.map(({ bars, cells }) => {
    let out = bars[0].pre + bars[0].pipe;
    for (let j = 0; j < cells.length; j++) {
      out += lead(bars[j].post + cells[j].volta);                // gap after this pipe
      if (cells[j].meterLabel) out += "[" + cells[j].meterLabel + "] ";  // time-signature change
      out += cells[j].slots.map(padSlot).join(sep);              // even slot spacing
      out += trail(bars[j + 1].pre) + bars[j + 1].pipe;          // gap before next pipe
    }
    out += bars[bars.length - 1].post;
    return out.replace(/\s+$/, "");
  });

  return { subdivisions: maxN, meter: measures[0]?.meterStr || meterStr || "4/4", lines };
}

// ── Standalone CLI ────────────────────────────────────────────────────────────
// `tsx chord-chart.ts <tune.md|tune.abc>` — prints the chart for one tune.
const invokedDirectly = !!process.argv[1] && /chord-chart\.[tj]s$/.test(process.argv[1]);
if (invokedDirectly) {
  const file = process.argv[2];
  if (!file) { console.error("usage: tsx chord-chart.ts <tune.md|tune.abc>"); process.exit(1); }
  const raw = fs.readFileSync(file, "utf-8").replace(/\r\n?/g, "\n");
  const fence = raw.match(/```music-abc\n([\s\S]*?)```/);
  const abc = fence ? fence[1] : raw;
  const chart = abcToChordChart(abc);
  if (!chart) { console.log("(no chords)"); process.exit(0); }
  console.log(`meter ${chart.meter} · ${chart.subdivisions} slots/measure`);
  for (const l of chart.lines) console.log(l);
}
