/**
 * The free feed-backed tools read the published files from CORPUS KV, the
 * same bytes the site routes serve. They used to fetch FEED_BASE over HTTP,
 * and the day the branded domain moved onto this worker every one of them
 * died with a 522 - a Worker's subrequest to its own hostname bypasses the
 * worker and reaches an origin that does not exist - while the site itself
 * stayed up, so nothing looked broken from outside. Ten days passed before
 * anyone called one of these tools and saw the error. These tests pin the
 * KV path, pin that no network fetch is attempted, and pin that a storage
 * failure reports as our outage rather than as an empty feed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";

const FEED = JSON.stringify({
  dataset: "us-medtech-signals",
  window_days: 14,
  generated_at: "2026-09-13T00:00:00Z",
  events: [
    { kind: "nih_award", company: "Pranions", amount_usd: 1340000,
      new_award: true },
    { kind: "fda_510k", company: "Acme Devices" },
  ],
});

const FILES = {
  "site:signals-latest.json": FEED,
  "site:methodology.md": "# About this data",
  "site:llms.txt": "# Whimbrel Research data",
  "site:stats.json":
    '{"corpus":{"public_signals_archived":12906},"trailing_weeks":[]}',
};

const ctx = { waitUntil() {} };

function envWith(files = FILES) {
  return { CORPUS: { get: async (key) => (key in files ? files[key] : null) } };
}

async function callTool(env, name, args = {}) {
  const response = await worker.fetch(new Request("https://api.test/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
                           params: { name, arguments: args } }),
  }), env, ctx);
  const payload = await response.json();
  return payload.result;
}

test("the feed tools answer from the store with no network fetch", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected network fetch: ${url}`);
  };
  try {
    for (const name of ["latest_signals", "signal_of_the_day",
                        "weekly_pulse", "who_got_funded"]) {
      const result = await callTool(envWith(), name);
      assert.ok(!result.isError, `${name} failed: ${result.content[0].text}`);
    }
    const filtered = await callTool(envWith(), "latest_signals",
                                    { kind: "nih_award" });
    const body = JSON.parse(filtered.content[0].text);
    assert.equal(body.returned, 1);
    assert.equal(body.events[0].company, "Pranions");
  } finally {
    globalThis.fetch = real;
  }
});

test("about_the_data composes the published documents", async () => {
  const result = await callTool(envWith(), "about_the_data");
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.methodology, "# About this data");
  assert.equal(body.overview, "# Whimbrel Research data");
  // stats.json holds the scale under "corpus"; the tool must read that
  // key, not the "archive" it presents. Reading the wrong key rendered
  // this field null for as long as the tool existed.
  assert.equal(body.archive.public_signals_archived, 12906);
});

test("/v1/about reaches the same handler with env attached", async () => {
  // The HTTP route calls the MCP handler directly. When fetchFeed moved
  // onto the store, this call site was still passing no arguments, so env
  // never arrived and the route threw - caught by the external x402
  // check on September 15, 2026, two days after the handler change,
  // because no unit test exercised the GET path.
  const response = await worker.fetch(
    new Request("https://api.test/v1/about"), envWith(), { waitUntil() {} });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.methodology, "# About this data");
});

test("an unreadable store is our outage, never an empty answer", async () => {
  const env = { CORPUS: { get: async () => { throw new Error("429"); } } };
  const result = await callTool(env, "latest_signals");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /outage on our side/);
});

test("an unpublished feed says so instead of guessing", async () => {
  const result = await callTool(envWith({}), "latest_signals");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /has not been published/);
});

function mixedFeed(today) {
  return JSON.stringify({
    dataset: "us-medtech-signals",
    window_days: 14,
    generated_at: `${today}T00:00:00Z`,
    events: [
      { kind: "nih_award", company: "Funded Co", amount_usd: 500000,
        new_award: true, observed: today, date: today },
      { kind: "trial_registration", company: "Trial Sponsor Co",
        observed: today, date: today },
      { kind: "fda_breakthrough_auth", company: "Phast Corp",
        observed: today, date: today },
      { kind: "fda_hde", company: "Artivion, Inc.",
        observed: today, date: today },
      { kind: "sbir_award", company: "Coalesenz Inc.", amount_usd: 1649914,
        observed: today, date: today },
      { kind: "fda_listing", company: "Listed Co",
        observed: today, date: today },
      { kind: "funding_filing", company: "Form D Co",
        observed: today, date: today },
    ],
  });
}

test("who_got_funded stays money-shaped when trials ride the feed", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const env = envWith({ ...FILES, "site:signals-latest.json": mixedFeed(today) });
  const funded = JSON.parse(
    (await callTool(env, "who_got_funded")).content[0].text);
  assert.equal(funded.matches, 1);
  assert.equal(funded.events[0].company, "Funded Co");
  assert.equal(funded.events[0].kind, "nih_award");
  assert.match(funded.note, /weekly_pulse|latest_signals/);
  assert.match(funded.note, /get_access/);
  assert.match(funded.note, /Solo|Practice|Firm/);
  assert.match(funded.note, /2 \/ 8 \/ 25 company briefs per month/);
  assert.equal(funded.note.includes("not seats"), false);
  assert.equal(funded.note.includes("seats"), false);
  assert.match(funded.note, /Breakthrough manufacturer/);
  assert.match(funded.note, /full company brief/);
  assert.match(funded.note, /deep_record/);
  assert.equal(funded.note.includes("Pick one company"), false);
  const kinds = new Set(funded.events.map((e) => e.kind));
  assert.equal(kinds.has("trial_registration"), false);
  assert.equal(kinds.has("fda_breakthrough_auth"), false);
  assert.equal(kinds.has("fda_hde"), false);
  assert.equal(kinds.has("sbir_award"), false);
  assert.equal(kinds.has("fda_listing"), false);
  assert.equal(kinds.has("funding_filing"), false);
  assert.equal(kinds.has("fda_warning_letter"), false);
  assert.equal(kinds.has("fda_import_alert"), false);
  assert.equal(kinds.has("fda_recall"), false);

  const pulse = JSON.parse(
    (await callTool(env, "weekly_pulse")).content[0].text);
  assert.equal(pulse.events_by_kind.trial_registration, 1);
  assert.equal(pulse.events_by_kind.fda_breakthrough_auth, 1);
  assert.equal(pulse.events_by_kind.fda_hde, 1);
  assert.equal(pulse.events_by_kind.nih_award, 1);

  const latest = JSON.parse(
    (await callTool(env, "latest_signals", { kind: "trial_registration" }))
      .content[0].text);
  assert.equal(latest.returned, 1);
  assert.equal(latest.events[0].company, "Trial Sponsor Co");

  const breakthrough = JSON.parse(
    (await callTool(env, "latest_signals", { kind: "fda_breakthrough_auth" }))
      .content[0].text);
  assert.equal(breakthrough.returned, 1);
  assert.equal(breakthrough.events[0].company, "Phast Corp");

  const hde = JSON.parse(
    (await callTool(env, "latest_signals", { kind: "fda_hde" }))
      .content[0].text);
  assert.equal(hde.returned, 1);
  assert.equal(hde.events[0].company, "Artivion, Inc.");

  const sbir = JSON.parse(
    (await callTool(env, "latest_signals", { kind: "sbir_award" }))
      .content[0].text);
  assert.equal(sbir.returned, 1);
  assert.equal(sbir.events[0].company, "Coalesenz Inc.");
});

test("find_signals accepts trial_registration; who_got_funded has no kind", async () => {
  const response = await worker.fetch(new Request("https://api.test/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }), envWith(), ctx);
  const payload = await response.json();
  const tools = Object.fromEntries(
    payload.result.tools.map((t) => [t.name, t]));
  const findKinds = tools.find_signals.inputSchema.properties.kind.enum;
  assert.ok(findKinds.includes("trial_registration"));
  assert.ok(findKinds.includes("fda_breakthrough_auth"));
  assert.ok(findKinds.includes("fda_hde"));
  assert.ok(findKinds.includes("sbir_award"));
  assert.ok(findKinds.includes("fda_warning_letter"));
  assert.ok(findKinds.includes("fda_import_alert"));
  assert.ok(findKinds.includes("fda_recall"));
  assert.equal("kind" in tools.who_got_funded.inputSchema.properties, false);
  const latestKinds = tools.latest_signals.inputSchema.properties.kind.enum;
  assert.ok(latestKinds.includes("trial_registration"));
  assert.ok(latestKinds.includes("fda_breakthrough_auth"));
  assert.ok(latestKinds.includes("fda_hde"));
  assert.ok(latestKinds.includes("sbir_award"));
  assert.equal(latestKinds.includes("fda_recall"), false);
  assert.equal(latestKinds.includes("fda_listing"), false);
  assert.equal(latestKinds.includes("funding_filing"), false);
  assert.equal(latestKinds.includes("fda_warning_letter"), false);
  assert.equal(latestKinds.includes("fda_import_alert"), false);
  assert.match(tools.latest_signals.description,
               /ClinicalTrials\.gov device trial registrations/);
  assert.match(tools.weekly_pulse.description,
               /ClinicalTrials\.gov device trial registrations/);
  assert.match(tools.find_signals.description,
               /ClinicalTrials\.gov device trial registrations/);
  assert.match(tools.company_timeline.description,
               /ClinicalTrials\.gov device trial registration history/);
  assert.match(tools.who_got_funded.description, /NIH awards/);
  assert.equal(tools.who_got_funded.description.includes("trial_registration"),
               false);
  assert.match(tools.who_got_funded.description,
               /Breakthrough marketing authorizations/);
  assert.match(tools.who_got_funded.description,
               /weekly_pulse, latest_signals, and find_signals/);
  assert.match(tools.who_got_funded.description,
               /Then ask weekly_pulse or latest_signals/);
  assert.match(tools.who_got_funded.description,
               /Breakthrough manufacturer/);
  assert.equal(tools.who_got_funded.description.includes("Pick one company"),
               false);
  assert.match(tools.latest_signals.description,
               /Breakthrough marketing authorizations/);
  assert.match(tools.weekly_pulse.description,
               /Breakthrough marketing authorizations/);
  assert.match(tools.latest_signals.description,
               /Run deep_record on that manufacturer once/);
  assert.match(tools.latest_signals.description,
               /unlock deep research/);
  assert.equal(tools.latest_signals.description.includes("Breakthrough designation"),
               false);
});

test("weekly_pulse, latest_signals, and signal_of_the_day notes carry the Breakthrough handoff", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const env = envWith({ ...FILES, "site:signals-latest.json": mixedFeed(today) });
  const funded = JSON.parse(
    (await callTool(env, "who_got_funded")).content[0].text);
  const tail = funded.note.slice(funded.note.indexOf("If a Breakthrough"));
  assert.match(tail, /Breakthrough manufacturer/);

  function assertHandoff(note) {
    assert.match(note, /Breakthrough manufacturer/);
    assert.match(note, /FDA marketing authorization/);
    assert.match(note, /full company brief \(`deep_record`\)/);
    assert.match(note, /deep_record/);
    assert.match(note, /get_access/);
    assert.match(note, /Solo|Practice|Firm/);
    assert.match(note, /2 \/ 8 \/ 25 company briefs per month/);
    assert.equal(note.includes("not seats"), false);
    assert.equal(note.includes("seats"), false);
    assert.equal(note.includes("Pick one company"), false);
    assert.equal(note.endsWith(tail), true);
    assert.equal(/who_got_funded/.test(note), false);
    assert.equal(/sbir|other-agency|FUNDED_KINDS/i.test(note), false);
  }

  const pulse = JSON.parse(
    (await callTool(env, "weekly_pulse")).content[0].text);
  assert.equal(typeof pulse.events_total, "number");
  assert.ok(pulse.events_by_kind);
  assert.ok(pulse.attribution);
  assertHandoff(pulse.note);

  const latest = JSON.parse(
    (await callTool(env, "latest_signals")).content[0].text);
  assert.ok(Array.isArray(latest.events));
  assert.equal(typeof latest.returned, "number");
  assert.ok(latest.attribution);
  assertHandoff(latest.note);

  const day = JSON.parse(
    (await callTool(env, "signal_of_the_day")).content[0].text);
  assert.equal(day.signal.company, "Funded Co");
  assert.ok(day.generated_at);
  assert.ok(day.attribution);
  assert.match(day.note, /^Newest signal in the current window\. /);
  assertHandoff(day.note);

  const http = await worker.fetch(
    new Request("https://api.test/v1/signals/today"), env, ctx);
  assert.equal(http.status, 200);
  const todayBody = await http.json();
  assert.equal(todayBody.signal.company, "Funded Co");
  assert.match(todayBody.note, /^Newest signal in the current window\. /);
  assertHandoff(todayBody.note);

  const emptyFeed = JSON.stringify({
    dataset: "us-medtech-signals",
    window_days: 14,
    generated_at: `${today}T00:00:00Z`,
    events: [],
  });
  const empty = JSON.parse(
    (await callTool(
      envWith({ ...FILES, "site:signals-latest.json": emptyFeed }),
      "signal_of_the_day")).content[0].text);
  assert.equal(empty.signal, null);
  assert.equal(empty.note, "The feed window is empty right now.");
});

function isoShift(days) {
  return new Date(Date.now() + days * 86400e3).toISOString().slice(0, 10);
}

function futureDatedFeed(today) {
  const older = isoShift(-3);
  return JSON.stringify({
    dataset: "us-medtech-signals",
    window_days: 14,
    generated_at: `${today}T12:00:00Z`,
    events: [
      { id: "nsf:2604948", kind: "nsf_award", company: "UltraMend Inc",
        date: isoShift(7), observed: "2026-08-19" },
      { id: "piid:future", kind: "federal_contract",
        company: "Future Contract Co", date: isoShift(30),
        observed: "2026-09-01" },
      { id: "trialreg:NCT07840235", kind: "trial_registration",
        company: "Pregnolia AG", date: today, observed: today },
      { id: "nih:older", kind: "nih_award", company: "Older Award Co",
        date: older, observed: older },
    ],
  });
}

test("signal_of_the_day skips future NSF and contract start dates", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const env = envWith({
    ...FILES,
    "site:signals-latest.json": futureDatedFeed(today),
  });

  const day = JSON.parse(
    (await callTool(env, "signal_of_the_day")).content[0].text);
  assert.equal(day.signal.id, "trialreg:NCT07840235");
  assert.equal(day.signal.company, "Pregnolia AG");
  assert.ok(day.signal.date <= today);
  assert.match(day.note, /^Newest signal in the current window\. /);
  assert.match(day.note, /Breakthrough manufacturer/);

  const http = await worker.fetch(
    new Request("https://api.test/v1/signals/today"), env, ctx);
  assert.equal(http.status, 200);
  const todayBody = await http.json();
  assert.equal(todayBody.signal.id, "trialreg:NCT07840235");
  assert.ok(todayBody.signal.date <= today);

  const onlyFuture = JSON.stringify({
    dataset: "us-medtech-signals",
    window_days: 14,
    generated_at: `${today}T12:00:00Z`,
    events: [
      { id: "nsf:2604948", kind: "nsf_award", company: "UltraMend Inc",
        date: isoShift(7), observed: "2026-08-19" },
    ],
  });
  const skipped = JSON.parse(
    (await callTool(
      envWith({ ...FILES, "site:signals-latest.json": onlyFuture }),
      "signal_of_the_day")).content[0].text);
  assert.equal(skipped.signal, null);
  assert.equal(
    skipped.note,
    "No signal in the current window is dated on or before today.");
  assert.equal(skipped.note.includes("Newest signal"), false);
});

test("latest_signals leads with dates on or before today and keeps future rows", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const env = envWith({
    ...FILES,
    "site:signals-latest.json": futureDatedFeed(today),
  });
  const latest = JSON.parse(
    (await callTool(env, "latest_signals", { limit: 50 })).content[0].text);
  assert.equal(latest.total_in_window, 4);
  assert.equal(latest.returned, 4);
  assert.equal(latest.events[0].id, "trialreg:NCT07840235");
  assert.equal(latest.events[1].id, "nih:older");
  assert.ok(latest.events[0].date <= today);
  assert.ok(latest.events[1].date <= today);
  assert.ok(latest.events[0].date >= latest.events[1].date);
  const futureIds = latest.events.slice(2).map((event) => event.id);
  assert.deepEqual(futureIds, ["piid:future", "nsf:2604948"]);
  assert.ok(latest.events.slice(2).every((event) => event.date > today));
  assert.match(latest.note, /^Newest signals in the current window\. /);

  const capped = JSON.parse(
    (await callTool(env, "latest_signals", { limit: 1 })).content[0].text);
  assert.equal(capped.returned, 1);
  assert.equal(capped.total_in_window, 4);
  assert.equal(capped.events[0].id, "trialreg:NCT07840235");

  const nsf = JSON.parse(
    (await callTool(env, "latest_signals", { kind: "nsf_award" }))
      .content[0].text);
  assert.equal(nsf.total_in_window, 1);
  assert.equal(nsf.returned, 1);
  assert.equal(nsf.events[0].id, "nsf:2604948");

  const http = await worker.fetch(
    new Request("https://api.test/v1/signals/latest?limit=50"), env, ctx);
  assert.equal(http.status, 200);
  const httpBody = await http.json();
  assert.equal(httpBody.events[0].id, "trialreg:NCT07840235");
  assert.equal(httpBody.total_in_window, 4);
  assert.equal(httpBody.events[3].date > today, true);
});

test("find_signals note is pulse-bridge, not a fit claim", async () => {
  const env = {
    ...envWith(),
    DB: {
      prepare() {
        return {
          bind() { return this; },
          async all() { return { results: [] }; },
        };
      },
    },
  };
  const found = JSON.parse(
    (await callTool(env, "find_signals")).content[0].text);
  assert.equal(found.note.includes("best-fit"), false);
  assert.equal(found.note.includes("Pick one company"), false);
  assert.match(found.note, /Breakthrough manufacturer/);
  assert.match(found.note, /full company brief/);
  assert.match(found.note, /deep_record/);
  assert.match(found.note, /get_access/);
  assert.match(found.note, /Solo|Practice|Firm/);
  assert.match(found.note, /2 \/ 8 \/ 25 company briefs per month/);
  assert.equal(found.note.includes("not seats"), false);
  assert.equal(found.note.includes("seats"), false);
});
