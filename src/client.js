import { TypeSafeClient } from "@typesafe-ai/sdk";
import { loadEnv } from "./env.js";

let shared = null;

/** A process-wide TypeSafeClient, created on first use so importing needs no key. */
export function defaultClient() {
  if (shared) return shared;
  loadEnv();
  if (!process.env.TYPESAFE_API_KEY) {
    throw new Error("TYPESAFE_API_KEY is not set. Put it in .env or pass { client } to jevex().");
  }
  shared = new TypeSafeClient({ timeout: 30000 });
  return shared;
}

/** Run `task` over `items` with at most `limit` in flight, preserving order. */
export async function pool(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await task(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
