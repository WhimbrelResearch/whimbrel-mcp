/**
 * Billing. Run: node --test whimbrel-mcp/test/*.test.mjs
 *
 * Same reason the x402 gate has tests and the rest of a small worker does
 * not: a bug here either hands the paid tier to someone who did not pay, or
 * takes a subscription and never delivers the key. The cases below are the
 * ones that would do that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { verifyWebhook, applyEvent, parseSignatureHeader } from "../src/stripe.js";

const SECRET = "whsec_test";

async function sign(body, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  const hex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${timestamp},v1=${hex}`;
}

// ---- signature ----

test("a correctly signed body verifies, a tampered one does not", async () => {
  const body = JSON.stringify({ id: "evt_1", type: "ping" });
  const env = { STRIPE_WEBHOOK_SECRET: SECRET };
  const good = await verifyWebhook(env, body, await sign(body));
  assert.equal(good.ok, true);
  assert.equal(good.event.id, "evt_1");

  const tampered = await verifyWebhook(
    env, JSON.stringify({ id: "evt_1", type: "hacked" }), await sign(body));
  assert.equal(tampered.ok, false);
});

test("a stale signature is refused, because a replay is a free grant", async () => {
  const body = JSON.stringify({ id: "evt_1" });
  const old = Math.floor(Date.now() / 1000) - 3600;
  const result = await verifyWebhook(
    { STRIPE_WEBHOOK_SECRET: SECRET }, body, await sign(body, SECRET, old));
  assert.equal(result.ok, false);
  assert.match(result.reason, /tolerance/);
});

test("no secret configured refuses rather than accepting anything", async () => {
  const body = JSON.stringify({ id: "evt_1" });
  const result = await verifyWebhook({}, body, await sign(body));
  assert.equal(result.ok, false);
});

test("either signature verifies while a signing secret is rotating", () => {
  const parsed = parseSignatureHeader("t=123,v1=aaa,v1=bbb");
  assert.equal(parsed.timestamp, "123");
  assert.deepEqual(parsed.signatures, ["aaa", "bbb"]);
});

// ---- what each event means ----

test("subscription states map to entitlement, lapses included", () => {
  const at = (type, object) => applyEvent({ type, data: { object } });

  assert.equal(at("customer.subscription.updated",
                  { customer: "cus_1", status: "active",
                    current_period_end: 1790467200 }).paidThrough,
               "2026-09-27");

  // Stripe's 2025 API versions moved current_period_end off the
  // subscription and onto its items. Shaped like the live September 15
  // subscription that exposed this: without the item-level read, every
  // checkout died on its one-day bootstrap entitlement.
  assert.equal(at("customer.subscription.updated",
                  { customer: "cus_1", status: "active",
                    items: { data: [
                      { current_period_end: 1792082786 }] } }).paidThrough,
               "2026-10-15");
  // No period anywhere stays null (keep-the-date branch downstream),
  // and a null top level must not read as epoch 1970.
  assert.equal(at("customer.subscription.updated",
                  { customer: "cus_1", status: "active",
                    current_period_end: null }).paidThrough, null);
  assert.equal(at("customer.subscription.updated",
                  { customer: "cus_1", status: "past_due" }).status, "past_due");
  assert.equal(at("customer.subscription.deleted",
                  { customer: "cus_1" }).status, "canceled");

  // A failed payment marks the account without moving the date, so a
  // recovered card restores the customer instead of re-dating them.
  const failed = at("invoice.payment_failed", { customer: "cus_1" });
  assert.equal(failed.status, "past_due");
  assert.equal(failed.paidThrough, null);

  assert.equal(at("customer.created", { id: "cus_1" }), null);
});

test("a one-off checkout is a run pack: runs, never access", () => {
  // Payment mode used to be ignored outright. Since the plans landed it
  // means a run pack, and the distinction is the money: a pack grants runs
  // for the month and must never mint a tenant or move paid_through, or a
  // lapsed customer could buy one and get research back.
  const pack = applyEvent({
    type: "checkout.session.completed",
    data: { object: { mode: "payment", customer: "cus_1", id: "cs_pack_1",
                      metadata: { pack_runs: "5" } } },
  });
  assert.equal(pack.kind, "pack");
  assert.equal(pack.packRuns, 5);
  assert.equal(pack.status, undefined);
  assert.equal(pack.paidThrough, undefined);
});

test("a subscription checkout carries the plan it was bought on", () => {
  const bought = applyEvent({
    type: "checkout.session.completed",
    data: { object: { mode: "subscription", customer: "cus_1",
                      id: "cs_1", subscription: "sub_1",
                      metadata: { tier: "practice" } } },
  });
  assert.equal(bought.kind, "new");
  assert.equal(bought.tier, "practice");
});

test("a portal plan change reports the new price to map back to a plan", () => {
  const changed = applyEvent({
    type: "customer.subscription.updated",
    data: { object: { customer: "cus_1", status: "active",
                      items: { data: [{ price: { id: "price_firm" },
                                        current_period_end: 1792082786 }] } } },
  });
  assert.equal(changed.priceId, "price_firm");
});

// ---- the worker end to end ----

function stubDb(rows = []) {
  const statements = [];
  return {
    statements,
    rows,
    prepare(sql) {
      const binding = { sql, args: [] };
      return {
        bind(...args) { binding.args = args; return this; },
        async first() {
          statements.push(binding);
          if (/stripe_customer_id = \?1/.test(sql)) {
            return rows.find((r) => r.stripe_customer_id === binding.args[0]) || null;
          }
          return rows.find((r) => r.tenant_id === binding.args[0]) || null;
        },
        async run() { statements.push(binding); return { success: true }; },
        async all() { statements.push(binding); return { results: [] }; },
      };
    },
  };
}

function stubKv(store = new Map()) {
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

const ctx = { waitUntil() {} };

async function postWebhook(env, event, signature) {
  const body = JSON.stringify(event);
  return worker.fetch(new Request("https://api.test/stripe/webhook", {
    method: "POST",
    headers: { "Stripe-Signature": signature ?? await sign(body) },
    body,
  }), env, ctx);
}

const CHECKOUT = {
  id: "evt_checkout_1",
  type: "checkout.session.completed",
  data: { object: {
    id: "cs_test_123", mode: "subscription", customer: "cus_abc",
    subscription: "sub_1",
    customer_details: { email: "buyer@example.test", name: "Buyer Ltd" },
  } },
};

function billingEnv(extra = {}) {
  return {
    STRIPE_SECRET_KEY: "sk_test", STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_PRICE_ID: "price_1",
    DB: stubDb(), USAGE: stubKv(),
    ...extra,
  };
}

test("checkout mints a tenant and the key is claimable exactly once", async () => {
  const env = billingEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ current_period_end: 1790467200 }), { status: 200 });
  try {
    const response = await postWebhook(env, CHECKOUT);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).minted, true);

    const insert = env.DB.statements.find((s) => /INSERT INTO tenants/.test(s.sql));
    assert.ok(insert, "a tenants row is written");
    // Only the hash is stored; the plaintext key exists solely in the claim.
    const claimed = env.USAGE.store.get("claim:cs_test_123");
    assert.match(claimed, /^wbr_/);
    assert.ok(!insert.args.includes(claimed));
    assert.ok(insert.args.includes("2026-09-27"),
              "paid_through comes from Stripe's period end, not arithmetic");

    const first = await worker.fetch(
      new Request("https://api.test/v1/key/cs_test_123"), env, ctx);
    assert.equal((await first.json()).api_key, claimed);
    const second = await worker.fetch(
      new Request("https://api.test/v1/key/cs_test_123"), env, ctx);
    assert.equal(second.status, 404);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("checkout reads the period end from the items on new API versions", async () => {
  // The 2025 Stripe API shape: no top-level current_period_end, the real
  // date on the subscription item. Without the item-level read the row
  // kept its one-day bootstrap and the customer died the next day.
  const env = billingEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "sub_1", status: "active",
    items: { data: [{ current_period_end: 1792082786 }] },
  }), { status: 200 });
  try {
    await postWebhook(env, CHECKOUT);
    const insert = env.DB.statements.find((s) => /INSERT INTO tenants/.test(s.sql));
    assert.ok(insert.args.includes("2026-10-15"),
              "paid_through comes from the item-level period end");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a retried event does not mint a second identity", async () => {
  const env = billingEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  try {
    await postWebhook(env, CHECKOUT);
    const inserts = () =>
      env.DB.statements.filter((s) => /INSERT INTO tenants/.test(s.sql)).length;
    const after = inserts();
    const again = await postWebhook(env, CHECKOUT);
    assert.equal((await again.json()).duplicate, true);
    assert.equal(inserts(), after, "Stripe retries must not mint twice");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a cancellation drops the entitlement cache, not just the row", async () => {
  const env = billingEnv({
    DB: stubDb([{ tenant_id: "t_abc", api_key_hash: "hash1",
                  stripe_customer_id: "cus_abc" }]),
  });
  env.USAGE.store.set("tenant:hash1", JSON.stringify({ status: "active" }));
  const response = await postWebhook(env, {
    id: "evt_cancel_1", type: "customer.subscription.deleted",
    data: { object: { customer: "cus_abc" } },
  });
  assert.equal((await response.json()).updated, true);
  const update = env.DB.statements.find((s) => /UPDATE tenants/.test(s.sql));
  assert.ok(update.args.includes("canceled"));
  // Left in place, a cancelled key keeps working for the cache's lifetime.
  assert.equal(env.USAGE.store.has("tenant:hash1"), false);
});

test("an unsigned webhook grants nothing", async () => {
  const env = billingEnv();
  const response = await postWebhook(env, CHECKOUT, "t=1,v1=deadbeef");
  assert.equal(response.status, 400);
  assert.equal(env.DB.statements.length, 0);
});

test("unconfigured billing says so instead of half-working", async () => {
  const env = { DB: stubDb(), USAGE: stubKv() };
  const response = await postWebhook(env, CHECKOUT, "t=1,v1=x");
  assert.equal(response.status, 503);

  // /v1/subscribe with no plan named stopped being a billing call on
  // September 17, 2026: it navigates to the connect page, because a
  // purchase made before the connector exists ends on a page showing an
  // API key to copy. So it redirects whatever the billing state.
  const bare = await worker.fetch(
    new Request("https://api.test/v1/subscribe", { redirect: "manual" }),
    env, ctx);
  assert.equal(bare.status, 303);

  // The path that is still a billing call keeps the rule: a named plan
  // with a price but no keys refuses rather than handing back a checkout
  // link that fails at Stripe.
  const named = await worker.fetch(
    new Request("https://api.test/v1/subscribe?plan=solo",
                { redirect: "manual" }),
    { ...env, STRIPE_PRICE_SOLO: "price_solo" }, ctx);
  assert.equal(named.status, 503);
});

test("a browser gets the key as a page, an agent gets JSON, once either way", async () => {
  const kvGetPut = () => {
    const store = new Map();
    return { store,
      async get(k, t) { const v = store.has(k) ? store.get(k) : null;
        return v === null ? null : (t === "json" ? JSON.parse(v) : v); },
      async put(k, v) { store.set(k, String(v)); },
      async delete(k) { store.delete(k); } };
  };
  const browser = { USAGE: kvGetPut() };
  await browser.USAGE.put("claim:cs_html", "wbr_test_key_html");
  const page = await worker.fetch(new Request(
    "https://mcp.test/v1/key/cs_html", { headers: { Accept: "text/html" } }),
    browser, { waitUntil() {} });
  assert.match(page.headers.get("Content-Type"), /text\/html/);
  const html = await page.text();
  assert.match(html, /wbr_test_key_html/);
  assert.match(html, /Claude app/);
  assert.match(html, /Shown once/);
  // Consumed: a second visit finds nothing, as a page too.
  const again = await worker.fetch(new Request(
    "https://mcp.test/v1/key/cs_html", { headers: { Accept: "text/html" } }),
    browser, { waitUntil() {} });
  assert.equal(again.status, 404);
  assert.match(again.headers.get("Content-Type"), /text\/html/);

  const agent = { USAGE: kvGetPut() };
  await agent.USAGE.put("claim:cs_json", "wbr_test_key_json");
  const json = await worker.fetch(new Request(
    "https://mcp.test/v1/key/cs_json"), agent, { waitUntil() {} });
  assert.match(json.headers.get("Content-Type"), /application\/json/);
  assert.equal((await json.json()).api_key, "wbr_test_key_json");
});
