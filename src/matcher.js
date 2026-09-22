// A backtracking matcher, structured the way a textbook regex engine is. The
// only difference is what an atom test consults: a regex compares characters,
// this looks a probability up in a table that was filled in before the search
// started. By the time the engine runs there is no model in the loop, so
// matching is deterministic, synchronous and replayable.

import { sliceTokens } from "./tokens.js";

/**
 * A match context. `judge(description, lo, hi)` returns the probability that
 * tokens `[lo, hi)` are that description, or undefined when it was never asked.
 */
export function makeContext({
  text,
  tokens,
  judge,
  lo = 0,
  hi = tokens.length,
  threshold = 0.5,
  maxSpan = 4,
  caseSensitive = false,
}) {
  return { text, tokens, judge, lo, hi, threshold, maxSpan, caseSensitive };
}

const withCapture = (captures, name, value) =>
  name === null ? captures : { ...captures, [name]: value };

/**
 * Yield every way `node` can match starting at token `pos`, best first.
 *
 * Each result is `{ pos, captures, score }` where `score` is the weakest atom
 * probability along the way: one bad atom cannot hide behind several good ones.
 */
export function* matchNode(node, pos, ctx, state) {
  switch (node.t) {
    case "seq":
      yield* matchSequence(node.items, 0, pos, ctx, state);
      return;

    case "alt":
      for (const option of node.options) yield* matchNode(option, pos, ctx, state);
      return;

    case "group":
      for (const result of matchNode(node.node, pos, ctx, state)) {
        const name = node.capture ? (node.name ?? null) : null;
        yield {
          ...result,
          captures: withCapture(result.captures, name, { lo: pos, hi: result.pos }),
        };
      }
      return;

    case "rep":
      yield* matchRepeat(node, pos, ctx, state, 0);
      return;

    case "look": {
      const first = matchNode(node.node, pos, ctx, state).next();
      const matched = !first.done;
      if (matched === node.negative) return;
      yield { pos, captures: matched && !node.negative ? first.value.captures : state.captures, score: state.score };
      return;
    }

    case "start":
      if (pos === ctx.lo) yield { pos, captures: state.captures, score: state.score };
      return;

    case "end":
      if (pos === ctx.hi) yield { pos, captures: state.captures, score: state.score };
      return;

    case "any":
      if (pos < ctx.hi) yield { pos: pos + 1, captures: state.captures, score: state.score };
      return;

    case "lit":
      yield* matchLiteral(node, pos, ctx, state);
      return;

    case "re":
      yield* matchRegex(node, pos, ctx, state);
      return;

    case "sem":
      yield* matchSemantic(node, pos, ctx, state);
      return;

    default:
      throw new Error(`jevex: unknown node ${node.t}`);
  }
}

function* matchSequence(items, index, pos, ctx, state) {
  if (index === items.length) {
    yield { pos, captures: state.captures, score: state.score };
    return;
  }
  for (const result of matchNode(items[index], pos, ctx, state)) {
    yield* matchSequence(items, index + 1, result.pos, ctx, {
      captures: result.captures,
      score: result.score,
    });
  }
}

/**
 * Greedy by default: take as many repetitions as possible, then give them back
 * one at a time. `lazy` flips the order. A repetition that consumed nothing is
 * not repeated again, which is what stops `({a name})*` spinning forever.
 */
function* matchRepeat(node, pos, ctx, state, taken) {
  const canStop = taken >= node.min;
  const canTake = taken < node.max;

  if (canStop && node.lazy) yield { pos, captures: state.captures, score: state.score };

  if (canTake) {
    for (const result of matchNode(node.node, pos, ctx, state)) {
      if (result.pos === pos) break;
      yield* matchRepeat(node, result.pos, ctx, { captures: result.captures, score: result.score }, taken + 1);
    }
  }

  if (canStop && !node.lazy) yield { pos, captures: state.captures, score: state.score };
}

function* matchLiteral(node, pos, ctx, state) {
  const wanted = node.tokens;
  if (pos + wanted.length > ctx.hi) return;
  for (let k = 0; k < wanted.length; k++) {
    const actual = ctx.tokens[pos + k].text;
    const same = ctx.caseSensitive ? actual === wanted[k] : actual.toLowerCase() === wanted[k].toLowerCase();
    if (!same) return;
  }
  yield { pos: pos + wanted.length, captures: state.captures, score: state.score };
}

function* matchRegex(node, pos, ctx, state) {
  const widest = Math.min(ctx.maxSpan, ctx.hi - pos);
  for (let width = widest; width >= 1; width--) {
    const span = sliceTokens(ctx.text, ctx.tokens, pos, pos + width);
    if (node.regex.test(span)) {
      yield { pos: pos + width, captures: state.captures, score: state.score };
    }
  }
}

/**
 * A semantic atom spans one to `maxSpan` tokens. Widest first, so it is greedy
 * the way `\w+` is: `{a person's full name}` prefers "Priya Raghunathan" over
 * "Priya", and backtracks to the shorter span only if the rest cannot match.
 */
function* matchSemantic(node, pos, ctx, state) {
  if (node.negated) {
    if (pos >= ctx.hi) return;
    const probability = ctx.judge(node.description, pos, pos + 1) ?? 0;
    if (probability >= ctx.threshold) return;
    yield { pos: pos + 1, captures: state.captures, score: Math.min(state.score, 1 - probability) };
    return;
  }

  const widest = Math.min(ctx.maxSpan, ctx.hi - pos);
  for (let width = widest; width >= 1; width--) {
    const probability = ctx.judge(node.description, pos, pos + width);
    if (probability === undefined || probability < ctx.threshold) continue;
    yield { pos: pos + width, captures: state.captures, score: Math.min(state.score, probability) };
  }
}

/**
 * Leftmost match at or after `from`, taking the engine's first result at each
 * start position. This is regex's rule: leftmost wins, and within a position
 * the pattern's own preference order decides.
 */
export function search(ast, ctx, from = ctx.lo) {
  for (let start = from; start <= ctx.hi; start++) {
    const first = matchNode(ast, start, ctx, { captures: {}, score: 1 }).next();
    if (first.done) continue;
    if (first.value.pos === start) continue; // ignore empty matches
    return { lo: start, hi: first.value.pos, captures: first.value.captures, score: first.value.score };
  }
  return null;
}

/** Every non-overlapping match, scanning left to right as `String.matchAll` does. */
export function searchAll(ast, ctx, limit = Infinity) {
  const found = [];
  let from = ctx.lo;
  while (found.length < limit) {
    const hit = search(ast, ctx, from);
    if (!hit) break;
    found.push(hit);
    from = hit.hi;
  }
  return found;
}
