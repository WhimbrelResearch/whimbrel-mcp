/**
 * The worker under a blocked counter store. On September 13, 2026 the
 * account went over Cloudflare's KV daily operation ceiling at 07:26 UTC
 * and every USAGE read and write threw for the rest of the day. The cap
 * checks and the tenant-cache read were unguarded, so every tools/call
 * died as an uncaught exception - a bare 502 - while D1 and the archive
 * underneath were healthy. These tests pin the degraded behavior: metering
 * fails open and uncounted, the tenant cache falls through to D1, an OAuth
 * token that cannot be checked is reported as our outage rather than as an
 * invalid key, and nothing that handleMessage throws ever escapes as a
 * non-JSON-RPC response.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";

const FEED = JSON.stringify({ dataset: "t", window_days: 14,
                              events: [{ kind: "nih_award", company: "A" }] });

const THROWING_USAGE = {
  get: async () => { throw new Error("KV daily limit exceeded"); },
  put: async () => { throw new Error("KV daily limit exceeded"); },
  delete: async () => { throw new Error("KV daily limit exceeded"); },
};

const CORPUS = {
  get: async (key) =>
    (key === "site:signals-latest.json" ? FEED : null),
};

const ctx = { waitUntil() {} };

async function post(env, body, headers = {}) {
  return worker.fetch(new Request("https://api.test/", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), env, ctx);
}

async function callTool(env, name, headers = {}) {
  const response = await post(env, {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name, arguments: {} },
  }, headers);
  assert.equal(response.status, 200);
  return (await response.json()).result;
}

test("a blocked counter store never blocks a free tool", async () => {
  const env = { CORPUS, USAGE: THROWING_USAGE };
  const result = await callTool(env, "latest_signals");
  assert.ok(!result.isError, result.content[0].text);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.events[0].company, "A");
});

// The tenant cache read throws too, and must fall through to D1; no row
// there, so the bearer can only be an OAuth token, and the token store is
// unreadable.
const OAUTH_OUTAGE_ENV = {
  CORPUS,
  USAGE: THROWING_USAGE,
  DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
};

test("an uncheckable OAuth token still gets the free tier", async () => {
  // Anonymous confers exactly what a free grant confers, so a free tool
  // has no reason to fail when the token cannot be checked. This is the
  // shape most Claude app connections take, so failing here would look
  // like a full outage to nearly every real caller.
  const result = await callTool(OAUTH_OUTAGE_ENV, "latest_signals",
                                { Authorization: "Bearer wbo_sometoken" });
  assert.ok(!result.isError, result.content[0].text);
});

test("a tenant-gated tool reports the outage, not an invalid key", async () => {
  const result = await callTool(OAUTH_OUTAGE_ENV, "deep_record",
                                { Authorization: "Bearer wbo_sometoken" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /outage on our side/);
  assert.doesNotMatch(result.content[0].text, /billing_portal/);
});

test("a throw inside handleMessage becomes a JSON-RPC error, never a 502", async () => {
  // null destructures with a TypeError inside handleMessage; before the
  // net, that throw escaped the fetch handler entirely.
  const response = await post({ CORPUS }, [null]);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload[0].error.code, -32603);
});
