#!/usr/bin/env node
// Live end-to-end run. Needs TYPESAFE_API_KEY in .env.
import { jevex } from "../src/index.js";

const TEXT = `Priya Raghunathan opened the release meeting and said we are not shipping this week.
Marcus argued for one more day, but the build had been red for eleven days.
The team agreed to cut the export feature and revisit it in the autumn.`;

async function show(label, pattern, run) {
  const matcher = jevex(pattern);
  const value = await run(matcher);
  const { requests, inputTokens, outputTokens } = matcher.lastStats;
  console.log(`\n${label}`);
  console.log(`  pattern  ${pattern}`);
  console.log(`  cost     ${requests} req, ${inputTokens} in / ${outputTokens} out`);
  console.log(`  result   ${value}`);
}

// A bare atom, greedy across tokens: "Priya Raghunathan", not "Priya".
await show("one atom", "{a person's full name}", async (m) => JSON.stringify((await m.exec(TEXT))[0]));

// Sequence of an atom and a literal, exactly as `\w+ argued` would read. The
// atom and the literal must be adjacent, so "Priya ... said" does not match.
await show("atom then literal", "{a person's name} argued", async (m) => JSON.stringify(await m.match(TEXT)));

// Named captures, the same syntax regex uses.
await show("named captures", "(?<who>{a person's name}) (?<did>{a past-tense verb})", async (m) => {
  const found = await m.exec(TEXT);
  return found ? `${found[0]}  ->  ${JSON.stringify(found.groups)}` : "no match";
});

// Alternation and a quantifier.
await show("alternation", "{a duration of time}|{a season of the year}", async (m) =>
  JSON.stringify(await m.match(TEXT)),
);

// An optional atom, and backtracking: the `?` is given back if the rest cannot match.
await show("optional atom", "the {an adjective}? {a noun}", async (m) => JSON.stringify(await m.match(TEXT)));

// Negative lookahead: a name not followed by "said".
await show("negative lookahead", "{a person's name}(?! said)", async (m) =>
  JSON.stringify(await m.match(TEXT)),
);

// replace() runs on real offsets, so it is ordinary string surgery.
await show("replace", "{a person's full name}", async (m) => `\n${await m.replace(TEXT, "[NAME]")}`);

// plan() prices a pattern without spending anything.
const planned = jevex("{a person's name} {a past-tense verb}").plan(TEXT);
console.log(`\nplan (free)`);
for (const chunk of planned.chunks) {
  console.log(`  ${chunk.id}  ${chunk.hi - chunk.lo} tokens  ${chunk.questions} questions`);
}
