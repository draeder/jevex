// Fills in the atom judgments the matcher will read. Every question a chunk
// could need goes out in one request, because questions in a request run in
// parallel and cost only their own tokens. The engine then runs offline.

import { noul } from "@typesafe-ai/sdk";
import { defaultClient, pool } from "./client.js";
import { sliceTokens } from "./tokens.js";

/** Table keys. JSON keeps them unambiguous and, unlike a separator byte, printable. */
const cellKey = (description, lo, hi) => JSON.stringify([description, lo, hi]);
const spanKey = (description, span) => JSON.stringify([description, span]);

export function newStats() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, model: null };
}

async function ask(spec, state, questions, stats) {
  const client = spec.client ?? defaultClient();
  const request = { state, questions };
  if (spec.model) request.model = spec.model;
  const result = await client.systemOne(request);
  stats.requests += 1;
  stats.inputTokens += result.usage.input_tokens;
  stats.outputTokens += result.usage.output_tokens;
  stats.model = result.model;
  return result.answers;
}

function batched(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const isStatement = (description) =>
  description.startsWith("is ") || description.startsWith("has ") || description.startsWith("does ");

/** "a person's name" becomes "`spans.s3` is a person's name."; "is a fax line" is left alone. */
function statementFor(reference, description) {
  return isStatement(description) ? `${reference} ${description}.` : `${reference} is ${description}.`;
}

/**
 * Which chunks could possibly contain a match.
 *
 * Only descriptions every match must contain are asked about, so a chunk is
 * skipped only when something mandatory is missing from it. This is the same
 * optimisation as a regex engine prefiltering on a required literal, and it is
 * what keeps a long document from costing a judgment table per line.
 */
export async function prefilterChunks(required, text, chunks, spec, stats) {
  if (!required.length || !chunks.length) return chunks;

  const passing = new Set(chunks.map((chunk) => chunk.id));
  const batches = batched(chunks, spec.scanBatch);

  await pool(batches, spec.concurrency, async (batch) => {
    const state = { chunks: Object.fromEntries(batch.map((chunk) => [chunk.id, chunk.text])) };
    const questions = {};
    const asked = [];
    for (const chunk of batch) {
      for (const [i, description] of required.entries()) {
        const key = `${chunk.id}_${i}`;
        asked.push({ key, chunkId: chunk.id });
        questions[key] = noul(
          `Some span of text inside \`chunks.${chunk.id}\` ${isStatement(description) ? description : `is ${description}`}.`,
          {
            true: `\`chunks.${chunk.id}\` contains ${description}.`,
            false: `Nothing in \`chunks.${chunk.id}\` is ${description}.`,
          },
        );
      }
    }
    const answers = await ask(spec, state, questions, stats);
    for (const { key, chunkId } of asked) {
      if (answers[key].noul < spec.prefilterThreshold) passing.delete(chunkId);
    }
  });

  return chunks.filter((chunk) => passing.has(chunk.id));
}

/**
 * Judge every (description, span) pair inside one chunk.
 *
 * Spans are deduplicated by their text, so a word repeated in a chunk is asked
 * about once. Returns the lookup the matcher calls; a pair that was never asked
 * comes back undefined and the matcher treats it as no match.
 */
export async function buildJudgeTable(descriptions, text, tokens, chunk, spec, stats) {
  const table = new Map();
  if (!descriptions.length) return () => undefined;

  const byQuestion = new Map(); // one entry per distinct (description, span text)
  const pairs = [];
  for (const description of descriptions) {
    for (let lo = chunk.lo; lo < chunk.hi; lo++) {
      const widest = Math.min(spec.maxSpan, chunk.hi - lo);
      for (let width = 1; width <= widest; width++) {
        const span = sliceTokens(text, tokens, lo, lo + width);
        const cell = cellKey(description, lo, lo + width);
        const existing = byQuestion.get(spanKey(description, span));
        if (existing) {
          existing.cells.push(cell);
        } else {
          const entry = { description, span, cells: [cell] };
          byQuestion.set(spanKey(description, span), entry);
          pairs.push(entry);
        }
      }
    }
  }

  const batches = batched(pairs, spec.questionBatch);
  await pool(batches, spec.concurrency, async (batch) => {
    const spans = {};
    const questions = {};
    batch.forEach((entry, i) => {
      spans[`s${i}`] = entry.span;
      questions[`q${i}`] = noul(statementFor(`\`spans.s${i}\``, entry.description), {
        true: `\`spans.s${i}\`, exactly as written, is ${entry.description}.`,
        false: `\`spans.s${i}\` is not ${entry.description}, or covers more or less than it.`,
      });
    });
    const state = { sentence: chunk.text, spans };
    const answers = await ask(spec, state, questions, stats);
    batch.forEach((entry, i) => {
      for (const cell of entry.cells) table.set(cell, answers[`q${i}`].noul);
    });
  });

  return (description, lo, hi) => table.get(cellKey(description, lo, hi));
}

/** How many questions a chunk's table will cost, before spending anything. */
export function tableSize(descriptions, text, tokens, chunk, maxSpan) {
  const seen = new Set();
  for (const description of descriptions) {
    for (let lo = chunk.lo; lo < chunk.hi; lo++) {
      const widest = Math.min(maxSpan, chunk.hi - lo);
      for (let width = 1; width <= widest; width++) {
        seen.add(spanKey(description, sliceTokens(text, tokens, lo, lo + width)));
      }
    }
  }
  return seen.size;
}
