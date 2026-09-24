/**
 * The research plans. Run: node --test whimbrel-mcp/test/*.test.mjs
 *
 * Retiered September 17, 2026: matching and monitoring left the product, so
 * a deep research run is the only thing the paid tier sells and the plans
 * differ by nothing but how many a month. Every case below is a way to
 * either give research away or withhold it from someone who paid.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";

const ctx = { waitUntil() {} };
const KEY = "wbr_plan_key";
const KEY_HASH = await (async () => {
  const digest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(KEY));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
})();

// D1 stub: one tenant on a named plan, a settable count of runs used this
// month, and a settable sum of pack runs bought this month.
function db({ tier = "practice", used = 0, packRuns = 0 } = {}) {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      const binding = { sql, args: [] };
      return {
        bind(...args) { binding.args = args; return this; },
        async first() {
          statements.push(binding);
          if (/FROM tenants WHERE api_key_hash/.test(sql)) {
            return { tenant_id: "t_1", name: "Acme", tier,
                     status: "active", paid_through: "2099-01-01" };
          }
          if (/COUNT\(\*\) AS used FROM research_requests/.test(sql)) {
            return { used };
          }
          if (/FROM run_packs/.test(sql)) return { runs: packRuns };
          if (/COUNT\(\*\) AS n FROM research_requests/.test(sql)) {
            return { n: 0 };
          }
          return null;
        },
        async all() { statements.push(binding); return { results: [] }; },
        async run() { statements.push(binding); return { success: true }; },
      };
    },
  };
}

async function callTool(env, name, args = {}, key = KEY) {
  const response = await worker.fetch(new Request("https://api.test/", {
    method: "POST",
    headers: { "Content-Type": "application/json",
               ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
                           params: { name, arguments: args } }),
  }), env, ctx);
  return JSON.parse((await response.json()).result.content[0].text);
}

test("the plan sets the allowance, and a pack adds to it", async () => {
  const practice = await callTool({ DB: db({ tier: "practice" }) },
                                  "research_status");
  assert.equal(practice.runs_allowance, 8);
  assert.match(practice.plan, /^Practice, 8 research runs a month$/);

  const solo = await callTool({ DB: db({ tier: "solo" }) }, "research_status");
  assert.equal(solo.runs_allowance, 2);

  const firm = await callTool({ DB: db({ tier: "firm" }) }, "research_status");
  assert.equal(firm.runs_allowance, 25);

  // A pack bought this month raises the ceiling without changing the plan.
  const topped = await callTool({ DB: db({ tier: "solo", packRuns: 5 }) },
                                "research_status");
  assert.equal(topped.runs_allowance, 7);
  assert.match(topped.plan, /^Solo, 2 research runs a month$/);
});

test("a tenant minted before the plans keeps what they were sold", async () => {
  // 'standard' predates Solo/Practice/Firm. Reading it as an unknown plan
  // with no allowance would strand a paying customer.
  const legacy = await callTool({ DB: db({ tier: "standard" }) },
                                "research_status");
  assert.equal(legacy.runs_allowance, 20);
  assert.match(legacy.plan, /^20 research runs a month$/,
    "a legacy tenant has an allowance but no plan name to print");
});

test("a used-up month refuses the run and names both ways out", async () => {
  const env = { DB: db({ tier: "solo", used: 2 }),
                STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "wh",
                STRIPE_PRICE_ID: "price_legacy" };
  const out = await callTool(env, "deep_record", { company: "Acme Devices" });
  assert.match(out.note, /allowance is used up \(2 of 2\)/);
  assert.match(out.note, /5-run pack/);
  assert.match(out.note, /billing_portal/);
  // Refused before anything was written: a blocked run costs nothing.
  assert.ok(!env.DB.statements.some((s) => /INSERT INTO research_requests/.test(s.sql)));
});

test("a pack lifts the same tenant over the line", async () => {
  const env = { DB: db({ tier: "solo", used: 2, packRuns: 5 }) };
  const out = await callTool(env, "deep_record", { company: "Acme Devices" });
  assert.ok(!out.note || !/allowance is used up/.test(out.note),
    "2 plan runs plus a 5-run pack is 7, so the third run is allowed");
});

test("get_access offers only the plans that have a price", async () => {
  const fetches = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetches.push(String(init?.body || ""));
    return new Response(JSON.stringify({
      url: "https://checkout.test/" + fetches.length, id: "cs_x" }),
      { status: 200 });
  };
  try {
    const env = { DB: db(), STRIPE_SECRET_KEY: "sk",
                  STRIPE_WEBHOOK_SECRET: "wh",
                  STRIPE_PRICE_SOLO: "price_solo",
                  STRIPE_PRICE_FIRM: "price_firm" };
    // Practice has no price configured, so it is simply not offered rather
    // than offered with a link that 503s.
    const out = await callTool(env, "get_access", {}, null);
    assert.deepEqual(out.plans.map((p) => p.plan), ["Solo", "Firm"]);
    assert.deepEqual(out.plans.map((p) => p.research_runs_per_month), [2, 25]);
    // Each checkout names its own price and tags the plan, which is how the
    // webhook knows what was bought without a second API call.
    assert.ok(fetches[0].includes("price_solo"));
    assert.ok(fetches[0].includes("metadata%5Btier%5D=solo"));
    assert.ok(fetches[1].includes("metadata%5Btier%5D=firm"));
    // The removed tools must not be advertised as unlockable.
    assert.deepEqual(out.unlocks.sort(),
      ["billing_portal", "crm_export", "deep_record", "research_status"]);
    assert.match(out.note, /hands the token to your app/);
    assert.match(out.note, /Authorization Bearer/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("no plan has a price: get_access says so instead of half-working", async () => {
  const env = { DB: db(), STRIPE_SECRET_KEY: "sk",
                STRIPE_WEBHOOK_SECRET: "wh" };
  const out = await callTool(env, "get_access", {}, null);
  assert.match(out.error, /No research plan is purchasable|not configured/);
  assert.ok(!out.plans);
});

test("a run pack is a one-time charge on the existing customer", async () => {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    bodies.push(String(init?.body || ""));
    return new Response(JSON.stringify({ url: "https://checkout.test/pack",
                                         id: "cs_pack" }), { status: 200 });
  };
  try {
    const env = { DB: db(), STRIPE_SECRET_KEY: "sk",
                  STRIPE_WEBHOOK_SECRET: "wh",
                  STRIPE_PRICE_RUN_PACK: "price_pack" };
    const out = await callTool(env, "get_access", { run_pack: true });
    assert.equal(out.adds_runs, 5);
    assert.match(out.note, /do not roll over/);
    assert.ok(bodies[0].includes("mode=payment"),
      "a pack is a one-time charge, not a second subscription");
    assert.ok(bodies[0].includes("price_pack"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an anonymous caller asking for a pack gets the plans instead", async () => {
  // run_pack is only meaningful with an active key; without one the honest
  // answer is the plan list, not an error about a key they do not have.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ url: "https://checkout.test/x", id: "cs_x" }),
    { status: 200 });
  try {
    const env = { DB: db(), STRIPE_SECRET_KEY: "sk",
                  STRIPE_WEBHOOK_SECRET: "wh",
                  STRIPE_PRICE_SOLO: "price_solo" };
    const out = await callTool(env, "get_access", { run_pack: true }, null);
    assert.ok(out.plans, "a stranger is shown the plans");
    assert.equal(out.adds_runs, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the removed tools are gone from the surface entirely", async () => {
  const response = await worker.fetch(new Request("https://api.test/", {
    method: "POST",
    headers: { "Content-Type": "application/json",
               Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }), { DB: db() }, ctx);
  const names = (await response.json()).result.tools.map((t) => t.name);
  for (const gone of ["matches_for_us", "build_profile", "set_preferences"]) {
    assert.ok(!names.includes(gone), `${gone} must not be served`);
  }
  assert.ok(names.includes("deep_record"));
  assert.equal(names.length, 13);
});

test("with no plan prices yet, the legacy plan is still purchasable", async () => {
  // The retiering landed before Nate created the three Stripe prices. A
  // stranger with a card in that window must not be told nothing is for
  // sale while the old price still works.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ url: "https://checkout.test/legacy", id: "cs_l" }),
    { status: 200 });
  try {
    const env = { DB: db(), STRIPE_SECRET_KEY: "sk",
                  STRIPE_WEBHOOK_SECRET: "wh",
                  STRIPE_PRICE_ID: "price_legacy" };
    const out = await callTool(env, "get_access", {}, null);
    assert.deepEqual(out.plans.map((p) => p.plan), ["Research"]);
    assert.equal(out.plans[0].research_runs_per_month, 20);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("/v1/subscribe no longer sells the retired plan", async () => {
  // Until September 17 this route defaulted to STRIPE_PRICE_ID, so the
  // website sold the pre-retiering $199/20-run plan while get_access sold
  // Solo, Practice and Firm: two ladders live at once, and the website's
  // was the retired one. With no plan named it now sends people to the
  // connect page, where subscribing from inside a connected client never
  // shows a key to copy.
  const env = { DB: db(), STRIPE_SECRET_KEY: "sk",
                STRIPE_WEBHOOK_SECRET: "wh",
                STRIPE_PRICE_ID: "price_legacy",
                STRIPE_PRICE_SOLO: "price_solo" };
  const bare = await worker.fetch(
    new Request("https://api.test/v1/subscribe", { redirect: "manual" }),
    env, ctx);
  assert.equal(bare.status, 303);
  assert.match(bare.headers.get("Location"), /whimbrelresearch\.com\/connect/);

  // A named plan still goes straight to that plan's checkout.
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (u, init) => {
    bodies.push(String(init?.body || ""));
    return new Response(JSON.stringify({ url: "https://checkout.test/solo",
                                         id: "cs_s" }), { status: 200 });
  };
  try {
    const named = await worker.fetch(
      new Request("https://api.test/v1/subscribe?plan=solo",
                  { redirect: "manual" }), env, ctx);
    assert.equal(named.status, 303);
    assert.match(named.headers.get("Location"), /checkout\.test\/solo/);
    assert.ok(bodies[0].includes("price_solo"));
    assert.ok(!bodies[0].includes("price_legacy"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

/**
 * Directory readiness, added September 17, 2026.
 *
 * Anthropic's Connectors Directory requires every tool to carry a title and
 * the applicable readOnlyHint or destructiveHint, and its submission portal
 * flags the ones that do not. Getting listed is the only path to a real
 * one-click install in Claude, so a tool added without annotations is a
 * tool that quietly blocks the listing. This fails instead.
 */
test("every tool carries a title and behaviour annotations", async () => {
  const response = await worker.fetch(new Request("https://api.test/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }), { DB: db() }, ctx);
  const tools = (await response.json()).result.tools;
  assert.equal(tools.length, 13);
  for (const tool of tools) {
    assert.ok(tool.title, `${tool.name} has no title`);
    const hints = tool.annotations || {};
    assert.equal(typeof hints.readOnlyHint, "boolean",
      `${tool.name} does not say whether it is read-only`);
    // A tool that acts must say so explicitly: the protocol's default for
    // destructiveHint is true, so silence reads as "this destroys things".
    if (!hints.readOnlyHint) {
      assert.equal(typeof hints.destructiveHint, "boolean",
        `${tool.name} acts but does not declare destructiveHint`);
    }
    // Our own gate flag is not part of the protocol and must not ship.
    assert.equal(tool.requiresTenant, undefined,
      `${tool.name} leaks requiresTenant to clients`);
  }
  // The three that act, named so a change has to be deliberate.
  const acting = tools.filter((t) => !t.annotations.readOnlyHint)
    .map((t) => t.name).sort();
  assert.deepEqual(acting, ["billing_portal", "deep_record", "get_access"]);
  const access = tools.find((t) => t.name === "get_access");
  assert.match(access.description, /hands the token to the app/);
  assert.match(access.description, /display-key path/);
});
