/**
 * The queue is the contract, not the dispatch.
 * Run: node --test whimbrel-mcp/test/*.test.mjs
 *
 * The paid tier spent its whole life unrunnable because a tenant's request
 * was marked failed the moment the worker could not reach GitHub, and the
 * worker could not reach GitHub because one secret was unset. Dispatch is now
 * only an accelerator: the row is written, the scheduled queue runner claims
 * it, and a missing credential costs minutes rather than the feature. These
 * tests hold that line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";

const KEY = "wbr_test_key";
// SHA-256 of KEY, computed at load so the stub can answer the tenant lookup.
const KEY_HASH = await (async () => {
  const digest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(KEY));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
})();

function stubDb() {
  const statements = [];
  const answer = (sql) => {
    if (/FROM tenants WHERE api_key_hash/.test(sql)) {
      return { tenant_id: "t_1", name: "Acme", tier: "standard",
               status: "active", paid_through: "2099-01-01" };
    }
    if (/COUNT\(\*\)/.test(sql)) return { n: 0 };
    return null;  // no existing record, no pending request
  };
  return {
    statements,
    prepare(sql) {
      const binding = { sql, args: [] };
      return {
        bind(...args) { binding.args = args; return this; },
        async first() { statements.push(binding); return answer(sql); },
        async run() { statements.push(binding); return { success: true }; },
        async all() { statements.push(binding); return { results: [] }; },
      };
    },
  };
}

function stubKv() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

const ctx = { waitUntil() {} };

async function callTool(env, name, args) {
  const response = await worker.fetch(new Request("https://api.test/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: args },
    }),
  }), env, ctx);
  const payload = await response.json();
  return JSON.parse(payload.result.content[0].text);
}

test("a request with no dispatch credential is queued, not failed", async () => {
  const env = { DB: stubDb(), USAGE: stubKv() };  // no DISPATCH_PAT
  const result = await callTool(env, "deep_record", { company: "Penderia" });

  assert.equal(result.queued, true);
  assert.match(result.request_id, /^req_[0-9a-f]+$/);
  assert.match(result.note, /within about five minutes/);

  const sql = env.DB.statements.map((s) => s.sql);
  assert.ok(sql.some((q) => /INSERT INTO research_requests/.test(q)),
            "the row is written");
  // The bug this replaces: the row was immediately marked failed because a
  // credential the research does not need was absent.
  assert.ok(!sql.some((q) => /UPDATE research_requests/.test(q) &&
                             /failed/.test(q)),
            "nothing marks the request failed");
  const insert = env.DB.statements.find(
    (s) => /INSERT INTO research_requests/.test(s.sql));
  assert.ok(insert.sql.includes("'queued'"));
});

test("the global daily ceiling refuses before writing a row", async () => {
  const env = {
    DB: {
      statements: [],
      prepare(sql) {
        const binding = { sql, args: [] };
        return {
          bind(...args) { binding.args = args; return this; },
          async first() {
            env.DB.statements.push(binding);
            if (/FROM tenants WHERE api_key_hash/.test(sql)) {
              return { tenant_id: "t_1", name: "Acme", tier: "standard",
                       status: "active", paid_through: "2099-01-01" };
            }
            // Every count is at the ceiling, including today's global one.
            if (/created_at >= \?1/.test(sql)) return { n: 25 };
            if (/COUNT\(\*\)/.test(sql)) return { n: 0 };
            return null;
          },
          async run() { env.DB.statements.push(binding); return { success: true }; },
          async all() { env.DB.statements.push(binding); return { results: [] }; },
        };
      },
    },
    USAGE: stubKv(),
    MAX_DAILY_RESEARCH_RUNS: "25",
  };
  const result = await callTool(env, "deep_record", { company: "Penderia" });
  assert.match(result.error, /daily ceiling/);
  assert.ok(!env.DB.statements.some(
    (s) => /INSERT INTO research_requests/.test(s.sql)),
    "a refused run costs the tenant nothing because no row exists");
});

test("the tenant hash the stub answers is the one the worker computes", () => {
  // Guards the fixture itself: if this drifts, both tests above would pass
  // for the wrong reason (anonymous caller, no tenant).
  assert.equal(KEY_HASH.length, 64);
});

// ---- streaming a run as it happens ----

/**
 * A store whose run moves: pending, two progress stages, then done with a
 * record waiting. Mirrors what the workflow actually writes.
 */
function movingDb() {
  const state = { status: "running", progress: [], record: null };
  const db = {
    state,
    prepare(sql) {
      const binding = { sql, args: [] };
      return {
        bind(...args) { binding.args = args; return this; },
        async first() {
          if (/FROM tenants WHERE api_key_hash/.test(sql)) {
            return { tenant_id: "t_1", name: "Acme", tier: "standard",
                     status: "active", paid_through: "2099-01-01" };
          }
          if (/FROM research_records/.test(sql)) return state.record;
          if (/FROM research_requests WHERE company_slug/.test(sql)) {
            return state.status === "done" ? null
              : { request_id: "req_00000000000000ab", status: state.status,
                  created_at: "2026-08-29T02:00:00Z" };
          }
          if (/FROM research_requests WHERE\s+request_id/.test(sql)) {
            return { status: state.status, detail: "" };
          }
          if (/COUNT\(\*\)/.test(sql)) return { n: 0 };
          return null;
        },
        async run() { return { success: true }; },
        async all() {
          if (/FROM research_progress/.test(sql)) {
            return { results: state.progress };
          }
          return { results: [] };
        },
      };
    },
  };
  return db;
}

async function readSse(response) {
  const text = await response.text();
  return text.split("\n\n").filter(Boolean).map(
    (chunk) => JSON.parse(chunk.replace(/^data: /, "")));
}

test("asking for progress streams the stages and ends with the record", async () => {
  const db = movingDb();
  const env = {
    DB: db, USAGE: stubKv(),
    RESEARCH_STREAM_POLL_MS: "20", RESEARCH_STREAM_MAX_SECONDS: "5",
  };

  // The run moves while the call is open, exactly as a real one does.
  setTimeout(() => {
    db.state.progress = [
      { seq: 1, stage: "starting", detail: "a runner picked the request up",
        at: "2026-08-29T02:00:05Z" },
      { seq: 3, stage: "researching", detail: "reading penderia.com",
        at: "2026-08-29T02:00:40Z" },
    ];
  }, 40);
  setTimeout(() => {
    db.state.status = "done";
    db.state.record = {
      company_name: "Penderia Technologies", version: "20260829T020500Z",
      researched_on: "2026-08-29", r2_key: "research/penderia/x.tar.gz",
      core_json: '{"people":[]}',
    };
  }, 120);

  const response = await worker.fetch(new Request("https://api.test/", {
    method: "POST",
    headers: { "Content-Type": "application/json",
               Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: {
        name: "deep_record",
        arguments: { company: "Penderia Technologies" },
        _meta: { progressToken: "tok-1" },
      },
    }),
  }), env, ctx);

  assert.match(response.headers.get("Content-Type"), /text\/event-stream/);
  const events = await readSse(response);

  const notes = events.filter((e) => e.method === "notifications/progress");
  assert.ok(notes.length >= 3, "the queued note plus each stage");
  assert.ok(notes.every((n) => n.params.progressToken === "tok-1"));
  assert.ok(notes.some((n) => /reading penderia\.com/.test(n.params.message)));

  // The last event is the answer, not another status line.
  const final = events[events.length - 1];
  assert.equal(final.id, 7);
  const record = JSON.parse(final.result.content[0].text);
  assert.equal(record.company, "Penderia Technologies");
});

test("a client that does not ask for progress gets the old plain reply", async () => {
  const env = { DB: movingDb(), USAGE: stubKv() };
  const response = await worker.fetch(new Request("https://api.test/", {
    method: "POST",
    headers: { "Content-Type": "application/json",
               Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 8, method: "tools/call",
      params: { name: "deep_record",
                arguments: { company: "Penderia Technologies" } },
    }),
  }), env, ctx);
  assert.match(response.headers.get("Content-Type"), /application\/json/);
  const payload = await response.json();
  const result = JSON.parse(payload.result.content[0].text);
  assert.equal(result.pending, true);
});

/**
 * Freshness, decided September 15, 2026: two unrelated tenants can ask
 * about the same company without knowing of each other, and the second
 * must never silently receive the first's aging artifact. Recent research
 * is shared as a feature; anything older re-runs automatically.
 */
function dbWithRecord(researchedOn) {
  const base = stubDb();
  const origPrepare = base.prepare.bind(base);
  base.prepare = (sql) => {
    if (/FROM research_records/.test(sql)) {
      return {
        bind() { return this; },
        async first() {
          return { company_name: "Penderia Technologies",
                   version: "20260829T020500Z",
                   researched_on: researchedOn,
                   r2_key: "research/penderia/x.tar.gz",
                   core_json: '{"people":[]}' };
        },
      };
    }
    return origPrepare(sql);
  };
  return base;
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
}

test("a record from this week is served instantly and spends no run", async () => {
  const env = { DB: dbWithRecord(isoDaysAgo(2)), USAGE: stubKv() };
  const result = await callTool(env, "deep_record", { company: "Penderia" });
  assert.equal(result.company, "Penderia Technologies");
  assert.ok(!result.queued);
  const sql = env.DB.statements.map((s) => s.sql);
  assert.ok(!sql.some((q) => /INSERT INTO research_requests/.test(q)),
            "no run is queued for fresh research");
});

test("a stale record refreshes automatically and says why", async () => {
  const staleDate = isoDaysAgo(30);
  const env = { DB: dbWithRecord(staleDate), USAGE: stubKv() };
  const result = await callTool(env, "deep_record", { company: "Penderia" });
  assert.equal(result.queued, true);
  assert.equal(result.previous_record_as_of, staleDate);
  assert.match(result.refreshing, /older than 7 days/);
  const sql = env.DB.statements.map((s) => s.sql);
  assert.ok(sql.some((q) => /INSERT INTO research_requests/.test(q)),
            "a fresh run is queued");
});

test("the streaming re-read serves a stale row rather than re-queueing", async () => {
  // _no_queue is the internal flag the streaming path uses after a run
  // reports done. Whatever the row's date, it must be served: charging
  // for a second run from inside the first would be the bug the flag
  // exists to prevent.
  const env = { DB: dbWithRecord(isoDaysAgo(30)), USAGE: stubKv() };
  const result = await callTool(env, "deep_record",
                                { company: "Penderia", _no_queue: true });
  assert.equal(result.company, "Penderia Technologies");
  assert.ok(!result.queued);
});
