// Tokens are the unit the engine matches over, the way characters are the unit
// a regex matches over. Everything here is deterministic; offsets are absolute
// into the original text so a match can always be sliced back out of it.

const OPEN = new Set([..."([{\"'“‘«"]);
const CLOSE = new Set([...")]}\"'”’».,;:!?…"]);

/**
 * Split text into tokens with absolute offsets.
 *
 * A token is a whitespace-delimited word with its bracketing and trailing
 * punctuation peeled off into tokens of their own, so `(415)` is three tokens
 * while `dana.w@example.com` and `1,315.50` stay whole.
 */
export function tokenize(text) {
  const tokens = [];
  const word = /\S+/g;
  let found;
  while ((found = word.exec(text)) !== null) {
    let start = found.index;
    let end = start + found[0].length;
    while (start < end && OPEN.has(text[start])) {
      tokens.push({ text: text[start], start, end: start + 1 });
      start++;
    }
    const trailing = [];
    while (end > start && CLOSE.has(text[end - 1])) {
      trailing.unshift({ text: text[end - 1], start: end - 1, end });
      end--;
    }
    if (end > start) tokens.push({ text: text.slice(start, end), start, end });
    tokens.push(...trailing);
  }
  return tokens;
}

/** The exact source text covered by tokens `[lo, hi)`, including inner whitespace. */
export function sliceTokens(text, tokens, lo, hi) {
  if (hi <= lo) return "";
  return text.slice(tokens[lo].start, tokens[hi - 1].end);
}

const TERMINATORS = new Set([".", "!", "?"]);

/** Ranges of text with no content, trimmed; null when empty. */
function trimmed(text, from, to) {
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  return to > from ? { start: from, end: to } : null;
}

function splitSentences(text, from, to) {
  const out = [];
  let start = from;
  for (let i = from; i < to; i++) {
    if (!TERMINATORS.has(text[i])) continue;
    let stop = i;
    while (stop + 1 < to && TERMINATORS.has(text[stop + 1])) stop++;
    const next = stop + 1 < to ? text[stop + 1] : undefined;
    if (next === undefined || /\s/.test(next)) {
      const span = trimmed(text, start, stop + 1);
      if (span) out.push(span);
      start = stop + 1;
    }
    i = stop;
  }
  const tail = trimmed(text, start, to);
  if (tail) out.push(tail);
  return out;
}

/**
 * Cut the text into chunks and attach the token range each one covers.
 *
 * Chunks bound the search the way a regex's input string does: `^` and `$`
 * anchor to chunk edges, and a match cannot straddle two chunks.
 */
export function chunk(text, tokens, { mode = "auto", maxChars = 400 } = {}) {
  const ranges = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const span = trimmed(text, offset, offset + line.length);
    if (span) {
      if (mode === "sentence" || (mode === "auto" && span.end - span.start > maxChars)) {
        ranges.push(...splitSentences(text, span.start, span.end));
      } else {
        ranges.push(span);
      }
    }
    offset += line.length + 1;
  }

  const chunks = [];
  let cursor = 0;
  for (const range of ranges) {
    while (cursor < tokens.length && tokens[cursor].start < range.start) cursor++;
    const lo = cursor;
    let hi = lo;
    while (hi < tokens.length && tokens[hi].end <= range.end) hi++;
    if (hi > lo) {
      chunks.push({ id: `c${chunks.length}`, lo, hi, start: range.start, end: range.end, text: text.slice(range.start, range.end) });
      cursor = hi;
    }
  }
  return chunks;
}
