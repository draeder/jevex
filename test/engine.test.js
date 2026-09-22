import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, requiredDescriptions } from "../src/parse.js";
import { makeContext, search, searchAll } from "../src/matcher.js";
import { sliceTokens, tokenize } from "../src/tokens.js";

const TEXT = "Priya Raghunathan opened the release meeting at 9:15 and said we ship on Friday";

// Stands in for Jev. The engine cannot tell the difference: it asks for a
// probability and gets one, so every case below is deterministic.
const ORACLE = {
  "a person's full name": (s) => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(s),
  "a person's name": (s) => /^[A-Z][a-z]+( [A-Z][a-z]+)?$/.test(s),
  "a time of day": (s) => /^\d{1,2}:\d{2}$/.test(s),
  "a weekday": (s) => ["Friday", "Monday"].includes(s),
  "a verb": (s) => ["opened", "said", "ship"].includes(s),
  "a noun": (s) => ["release", "meeting"].includes(s),
};

function contextFor(text, overrides = {}) {
  const tokens = tokenize(text);
  const judge = (description, lo, hi) => {
    const oracle = ORACLE[description];
    if (!oracle) throw new Error(`no oracle for ${description}`);
    return oracle(sliceTokens(text, tokens, lo, hi)) ? 0.95 : 0.05;
  };
  return makeContext({ text, tokens, judge, ...overrides });
}

const spanOf = (ctx, hit) => sliceTokens(ctx.text, ctx.tokens, hit.lo, hit.hi);

function matchOne(pattern, text = TEXT, overrides) {
  const ctx = contextFor(text, overrides);
  const hit = search(parse(pattern), ctx);
  return hit ? { text: spanOf(ctx, hit), score: hit.score, hit, ctx } : null;
}

function matchMany(pattern, text = TEXT, overrides) {
  const ctx = contextFor(text, overrides);
  return searchAll(parse(pattern), ctx).map((hit) => spanOf(ctx, hit));
}

test("a semantic atom is greedy across tokens", () => {
  assert.equal(matchOne("{a person's name}").text, "Priya Raghunathan");
});

test("a sequence of an atom and a bare literal", () => {
  assert.equal(matchOne("{a person's name} opened").text, "Priya Raghunathan opened");
});

test("a quoted literal matches several tokens", () => {
  assert.equal(matchOne('"we ship on" {a weekday}').text, "we ship on Friday");
});

test("literals are case-insensitive unless asked otherwise", () => {
  assert.equal(matchOne("OPENED").text, "opened");
  assert.equal(matchOne("OPENED", TEXT, { caseSensitive: true }), null);
});

test("alternation takes the leftmost match, not the first branch listed", () => {
  assert.equal(matchOne("{a weekday}|{a time of day}").text, "9:15");
});

test("? makes an atom optional and still prefers to match it", () => {
  assert.equal(matchOne("the {a noun}? {a noun}").text, "the release meeting");
});

test("* backtracks so the rest of the pattern can match", () => {
  assert.equal(matchOne(".* {a weekday}").text, TEXT);
});

test("a lazy quantifier gives back as much as it can", () => {
  assert.equal(matchOne("{a person's name} .*? {a time of day}").text, "Priya Raghunathan opened the release meeting at 9:15");
});

test("{n,m} counts repetitions, and a repetition is one token", () => {
  assert.equal(matchOne("^.{2}").text, "Priya Raghunathan");
  assert.equal(matchOne("^.{3}").text, "Priya Raghunathan opened");
  assert.equal(matchOne("^.{2,}").text, TEXT);
});

test("^ and $ anchor to the chunk", () => {
  assert.equal(matchOne("^{a person's name}").text, "Priya Raghunathan");
  assert.equal(matchOne("^{a weekday}"), null);
  assert.equal(matchOne("{a weekday}$").text, "Friday");
});

test("named groups capture token ranges", () => {
  const found = matchOne("(?<who>{a person's name}) (?<did>{a verb})");
  assert.equal(found.text, "Priya Raghunathan opened");
  const captured = (name) =>
    sliceTokens(found.ctx.text, found.ctx.tokens, found.hit.captures[name].lo, found.hit.captures[name].hi);
  assert.equal(captured("who"), "Priya Raghunathan");
  assert.equal(captured("did"), "opened");
});

test("a non-capturing group groups without capturing", () => {
  const found = matchOne("(?:{a person's name}) {a verb}");
  assert.deepEqual(Object.keys(found.hit.captures), []);
});

test("positive lookahead is zero-width", () => {
  assert.equal(matchOne("{a person's name}(?= opened)").text, "Priya Raghunathan");
  assert.equal(matchOne("{a person's name}(?= said)"), null);
});

test("negative lookahead excludes what follows", () => {
  assert.equal(matchOne("{a verb}(?! we)").text, "opened");
});

test("!{...} matches one token the description does not cover", () => {
  assert.equal(matchOne("{a verb} !{a person's name}").text, "opened the");
});

test("an embedded /regex/ matches one token span", () => {
  assert.equal(matchOne("/\\d{1,2}:\\d{2}/").text, "9:15");
});

test(". matches exactly one token", () => {
  assert.equal(matchOne(".").text, "Priya");
});

test("searchAll returns non-overlapping matches left to right", () => {
  assert.deepEqual(matchMany("{a verb}"), ["opened", "said", "ship"]);
});

test("the score is the weakest atom along the match", () => {
  const found = matchOne("{a person's name} {a verb}");
  assert.equal(found.score, 0.95);
});

test("threshold gates which spans an atom accepts", () => {
  assert.equal(matchOne("{a verb}", TEXT, { threshold: 0.99 }), null);
});

test("maxSpan caps how many tokens one atom can cover", () => {
  assert.equal(matchOne("{a person's name}", TEXT, { maxSpan: 1 }).text, "Priya");
});

test("tokenize peels brackets and trailing punctuation", () => {
  assert.deepEqual(
    tokenize("Call (415) 555-0177, ok?").map((t) => t.text),
    ["Call", "(", "415", ")", "555-0177", ",", "ok", "?"],
  );
});

test("tokens carry offsets that slice back out of the text", () => {
  const text = "Priya said “ship it” on Friday.";
  for (const token of tokenize(text)) assert.equal(text.slice(token.start, token.end), token.text);
});

test("requiredDescriptions skips optional and alternative-only atoms", () => {
  assert.deepEqual(requiredDescriptions(parse("{a verb} {a noun}?")), ["a verb"]);
  assert.deepEqual(requiredDescriptions(parse("{a verb}|{a noun}")), []);
  assert.deepEqual(requiredDescriptions(parse("({a verb}|{a verb}) {a noun}")), ["a verb", "a noun"]);
});

test("the parser rejects malformed patterns", () => {
  assert.throws(() => parse("{unclosed"), SyntaxError);
  assert.throws(() => parse("(?<>{a verb})"), SyntaxError);
  assert.throws(() => parse("{a verb}{3,1}"), SyntaxError);
  assert.throws(() => parse(""), SyntaxError);
});
