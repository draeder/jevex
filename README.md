# jevex

A regex engine whose atoms are meanings instead of characters.

Regex gives you `[a-z]`, `\d`, `.` — classes over characters. jevex keeps every
operator regex has and swaps the atom class for `{a description}`, judged by
[Jev](https://docs.typesafe.ai). Sequencing, alternation, quantifiers,
anchors, groups, backtracking and lookahead all work the way you already expect.

```js
import { jevex } from "./src/index.js";

const quote = jevex("(?<who>{a person's name}) (?<verb>{a past-tense verb})");

await quote.exec("Priya Raghunathan opened the release meeting.");
// { 0: 'Priya Raghunathan opened', index: 0, end: 24, score: 0.96,
//   groups: { who: 'Priya Raghunathan', verb: 'opened' } }
```

`jevex` is both the default and a named export. There is also a tagged-template
form, `` jx`...` ``, for patterns worth spreading over several lines.

## The pattern language

| Syntax | Means | Regex counterpart |
| --- | --- | --- |
| `{a person's name}` | a span Jev judges to be that | `[A-Z][a-z]+` |
| `!{a proper noun}` | one token Jev judges it is not | `[^A-Z]` |
| `"thank you"` | a literal token sequence | `thank you` |
| `argued` | an unquoted literal token | `argued` |
| `/\d{4}/` | a real regex, matched against a span of 1–`maxSpan` tokens | — |
| `.` | any one token | `.` |
| `^` `$` | start and end of the chunk | `^` `$` |
| `?` `*` `+` `{n}` `{n,m}` | quantifiers, greedy | same |
| `??` `*?` `+?` | lazy quantifiers | same |
| `\|` | alternation | same |
| `(?<n> )` | named capture | same |
| `( )` `(?: )` | grouping only — see below, neither captures | `(?: )` |
| `(?= )` `(?! )` | lookahead | same |
| `\` | escape a metacharacter | same |

Whitespace between atoms is insignificant, so a long pattern can be spread over
lines. The unit of matching is a **token**, not a character: `.` is one token,
`{n,m}` counts tokens, and a `{description}` atom spans one to `maxSpan` tokens,
greedily, longest first.

```
^{a person's name} (?:said|argued) "that" .*? {a deadline}$
```

## Why this is an engine and not a prompt

The match runs in two separated stages.

1. **Judge.** Code enumerates every (description, token span) pair the pattern
   could possibly ask about inside a chunk, and sends them as one request of
   parallel `noul` questions. Identical spans are asked once.
2. **Match.** A backtracking matcher runs over that table. No model is in the
   loop: matching is synchronous, deterministic, and replayable. Swap the table
   for a fake and the whole engine runs offline — which is exactly how its 25
   tests run, with no API key.

So the model never sees the pattern, never decides what matched, and cannot
return a string that isn't in the input. It answers one question over and over:
*is this exact span this exact thing?* Everything regex-shaped — greediness,
backtracking, leftmost-match, capture bookkeeping — is ordinary code.

Before any of that, a **prefilter** pass asks one `noul` per chunk for each
description the pattern *requires* (atoms not behind `?`, `*`, or one branch of
an alternation) and skips chunks that are missing one. This is the same trick a
regex engine uses when it prefilters on a required literal.

## API

`jevex(pattern, options)` compiles a pattern the way `new RegExp` does. Methods
are async because filling the table is a network call.

| Method | RegExp counterpart |
| --- | --- |
| `exec(text)` | `re.exec` — first match or `null` |
| `test(text)` | `re.test` |
| `matchAll(text)` | `text.matchAll(re)` |
| `match(text)` | `text.match(re)` with `g` — just the strings |
| `replace(text, r)` | `text.replace(re, r)`, with `$&` and `$<name>` |
| `split(text)` | `text.split(re)` |
| `plan(text)` | — costs nothing, reports what a run would ask |

A match is RegExp-shaped: `found[0]` is the matched text, `index` and `end` are
real offsets into `input`, `groups` holds named captures. `score` is the weakest
atom probability along the match, so one bad atom cannot hide behind good ones.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `threshold` | `0.5` | probability at which an atom counts as matching |
| `maxSpan` | `4` | most tokens one `{atom}` may cover |
| `prefilter` | `true` | skip chunks missing a required atom |
| `prefilterThreshold` | `0.35` | deliberately low: this pass should only skip the clear misses |
| `caseSensitive` | `false` | for literals |
| `segment` / `maxChars` | `"auto"` / `400` | how the text is cut into chunks |
| `questionBatch` | `120` | table questions per request |
| `scanBatch` | `60` | chunks per prefilter request |
| `concurrency` | `6` | requests in flight |
| `client` / `model` | SDK defaults | bring your own `TypeSafeClient` |

## What it costs

The judgment table is the bill, and it is knowable up front:

```js
jevex("{a person's name} {a past-tense verb}").plan(text);
// c0  15 tokens  108 questions
// c1  17 tokens  122 questions
```

Roughly `descriptions × tokens × maxSpan` questions per chunk, deduplicated by
span text, batched into requests of `questionBatch`. Dropping `maxSpan` from 4
to 2 halves it. The prefilter is what keeps this from applying to every line of
a long document. Run `plan()` before a big job.

## Limits worth knowing

- **A match cannot straddle a chunk.** Chunks are lines, or sentences when a
  line is long. Raise `maxChars` or use `segment: "line"` for longer reach.
- **`maxSpan` is a hard ceiling on one atom.** A six-word `{a job title}` needs
  `maxSpan: 6`, and the table grows with it.
- **Tokens are the floor.** `1,315.50` and `dana@example.com` are single tokens;
  brackets and trailing punctuation are peeled into tokens of their own. Nothing
  can match half a token — use `/regex/` for sub-token work.
- **Greedy means longest span, not best score.** `{a person's name}` takes the
  longest span over `threshold`, then backtracks, exactly as `\w+` does. It does
  not pick the highest-probability span.
- **Empty matches are skipped.** A pattern that can match nothing (`{a noun}*`)
  advances rather than looping.
- **Only named captures exist.** `( )` groups for precedence but captures
  nothing, so there is no `m[1]`, `m[2]`. Name the groups you want back:
  `(?<who>...)`. This is a gap, not a design decision.
- **It is not a drop-in RegExp.** The methods are async, so `str.replace(re, …)`
  and friends cannot take a jevex pattern — the String methods dispatch through
  synchronous `Symbol.replace`/`Symbol.split` protocols. Call
  `await pattern.replace(str, …)` instead. Regex syntax does not carry over
  either: there is no `\d`, `\w`, `\b` or `[a-z]`. Where a regex already works,
  keep the regex; it is exact, free and instant.

## Running it

```bash
npm install
```

```bash
npm test
```

```bash
npm run demo
```

`npm test` runs the parser, tokenizer and matcher against a fake judge and makes
no API calls. `npm run demo` needs `TYPESAFE_API_KEY` in `.env` and does.

## License

MIT.
