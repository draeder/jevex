import { buildJudgeTable, newStats, prefilterChunks, tableSize } from "./judge.js";
import { makeContext, searchAll } from "./matcher.js";
import { descriptions, parse, requiredDescriptions } from "./parse.js";
import { chunk as chunkText, sliceTokens, tokenize } from "./tokens.js";

const DEFAULTS = {
  threshold: 0.5,
  prefilterThreshold: 0.35,
  maxSpan: 4,
  segment: "auto",
  maxChars: 400,
  caseSensitive: false,
  questionBatch: 120,
  scanBatch: 60,
  concurrency: 6,
  prefilter: true,
  client: null,
  model: null,
};

/** Expand `$$`, `$&` and `$<name>` in a replacement string, as String.replace does. */
function expand(template, match) {
  return template.replace(/\$(\$|&|<([^>]*)>)/g, (whole, token, name) => {
    if (token === "$") return "$";
    if (token === "&") return match[0];
    const value = match.groups?.[name];
    return value == null ? "" : value;
  });
}

/**
 * A compiled pattern, used the way a RegExp is. The methods are async because
 * filling the judgment table is a network call; the matching itself is not.
 */
export class Jevex {
  constructor(pattern, options = {}) {
    this.source = pattern;
    this.ast = parse(pattern);
    this.descriptions = descriptions(this.ast);
    this.required = [...new Set(requiredDescriptions(this.ast))];
    this.options = { ...DEFAULTS, ...options };
    this.lastStats = null;
  }

  /**
   * Tokens, chunks, and how many questions each chunk's judgment table will
   * cost. Costs nothing, so it is the way to check a pattern's price before
   * running it, and it is what the matching methods use to set themselves up.
   */
  plan(text) {
    const tokens = tokenize(text);
    const chunks = chunkText(text, tokens, {
      mode: this.options.segment,
      maxChars: this.options.maxChars,
    });
    return {
      tokens,
      chunks: chunks.map((chunk) => ({
        ...chunk,
        questions: tableSize(this.descriptions, text, tokens, chunk, this.options.maxSpan),
      })),
    };
  }

  /** Run the engine over `text`, stopping once `limit` matches are found. */
  async #run(text, limit) {
    const stats = newStats();
    const { tokens, chunks } = this.plan(text);

    const live = this.options.prefilter
      ? await prefilterChunks(this.required, text, chunks, this.options, stats)
      : chunks;

    const found = [];
    for (const chunk of live) {
      const judge = await buildJudgeTable(this.descriptions, text, tokens, chunk, this.options, stats);
      const ctx = makeContext({
        text,
        tokens,
        judge,
        lo: chunk.lo,
        hi: chunk.hi,
        threshold: this.options.threshold,
        maxSpan: this.options.maxSpan,
        caseSensitive: this.options.caseSensitive,
      });
      for (const hit of searchAll(this.ast, ctx, limit - found.length)) {
        found.push(this.#toMatch(text, tokens, chunk, hit));
        if (found.length >= limit) {
          this.lastStats = stats;
          return found;
        }
      }
    }
    this.lastStats = stats;
    return found;
  }

  #toMatch(text, tokens, chunk, hit) {
    const groups = {};
    const groupSpans = {};
    for (const [name, range] of Object.entries(hit.captures)) {
      groups[name] = sliceTokens(text, tokens, range.lo, range.hi);
      groupSpans[name] = { index: tokens[range.lo].start, end: tokens[range.hi - 1].end };
    }
    const start = tokens[hit.lo].start;
    const end = tokens[hit.hi - 1].end;
    const named = Object.keys(groups).length > 0;
    return {
      0: text.slice(start, end),
      length: 1,
      index: start,
      end,
      input: text,
      chunk: chunk.text,
      score: hit.score,
      groups: named ? groups : undefined,
      groupSpans: named ? groupSpans : undefined,
    };
  }

  /** The first match, or null. Mirrors `RegExp.prototype.exec`. */
  async exec(text) {
    const found = await this.#run(text, 1);
    return found[0] ?? null;
  }

  /** Whether the pattern matches anywhere. Mirrors `RegExp.prototype.test`. */
  async test(text) {
    return (await this.exec(text)) !== null;
  }

  /** Every non-overlapping match, left to right. Mirrors `String.prototype.matchAll`. */
  async matchAll(text) {
    return this.#run(text, Infinity);
  }

  /** Just the matched strings, as `String.prototype.match` with the `g` flag gives. */
  async match(text) {
    return (await this.matchAll(text)).map((found) => found[0]);
  }

  /** `replacement` is a string with `$&` and `$<name>`, or a function of the match. */
  async replace(text, replacement) {
    const matches = await this.matchAll(text);
    let out = "";
    let cursor = 0;
    for (const found of matches) {
      if (found.index < cursor) continue;
      out += text.slice(cursor, found.index);
      out += typeof replacement === "function" ? replacement(found) : expand(String(replacement), found);
      cursor = found.end;
    }
    return out + text.slice(cursor);
  }

  /** The text between the matches. Mirrors `String.prototype.split`. */
  async split(text) {
    const matches = await this.matchAll(text);
    const parts = [];
    let cursor = 0;
    for (const found of matches) {
      if (found.index < cursor) continue;
      parts.push(text.slice(cursor, found.index));
      cursor = found.end;
    }
    parts.push(text.slice(cursor));
    return parts;
  }
}

/** Compile a pattern. The `new RegExp(...)` of this library. */
export function jevex(pattern, options) {
  return new Jevex(pattern, options);
}

/** Tagged-template form, so a pattern can be spread over lines: jx`{a name} said`. */
export function jx(strings, ...values) {
  return new Jevex(String.raw({ raw: strings }, ...values));
}

export { descriptions, parse, requiredDescriptions } from "./parse.js";
export { makeContext, search, searchAll } from "./matcher.js";
export { chunk, sliceTokens, tokenize } from "./tokens.js";
export default jevex;
