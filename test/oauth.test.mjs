/**
 * Sign in with Whimbrel. Run: node --test whimbrel-mcp/test/
 *
 * OAuth code earns tests the way payment code does: every bug here either
 * hands the paid tier to a stranger or locks a paying customer out. The
 * cases below walk the whole flow the Claude app walks, against a stubbed
 * KV and D1, ending with the token actually opening the tenant gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import worker from "../src/index.js";

const ctx = { waitUntil() {} };

// In-memory KV with the get/put/delete surface the worker uses.
function kv() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const value = store.has(key) ? store.get(key) : null;
      if (value === null) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
  };
}

// A D1 stub holding one entitled tenant, addressable by api_key_hash.
function db(tenantHash) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes("FROM tenants") && args[0] === tenantHash) {
                return { tenant_id: "ten_test", name: "Test Firm",
                         tier: "standard", status: "active",
                         paid_through: "2099-01-01" };
              }
              return null;
            },
            async all() { return { results: [] }; },
            async run() { return {}; },
          };
        },
      };
    },
  };
}

async function sha256hex(text) {
  const digest = await webcrypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

const ORIGIN = "https://mcp.test";
const call = (path, env, init = {}) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init }),
               env, ctx);

async function registerAndAuthorize(env) {
  const registered = await (await call("/oauth/register", env, {
    method: "POST",
    body: JSON.stringify({ redirect_uris: ["https://app.test/callback"] }),
  })).json();
  const verifier = b64url(webcrypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await webcrypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(verifier))));
  const page = await call("/oauth/authorize?" + new URLSearchParams({
    client_id: registered.client_id,
    redirect_uri: "https://app.test/callback",
    response_type: "code", state: "st4te",
    code_challenge: challenge, code_challenge_method: "S256",
  }), env);
  const html = await page.text();
  const reqId = html.match(/name="req" value="([^"]+)"/)[1];
  return { registered, verifier, challenge, reqId, html };
}

function assertFreeFirst(html, { expectSubscribe = false } = {}) {
  const free = html.indexOf("Continue with free access");
  const paste = html.indexOf("Connect with my key");
  assert.ok(free !== -1, "free door is present");
  assert.ok(paste !== -1, "paste-key door is present");
  assert.ok(free < paste, "Continue with free access comes before paste-key");
  assert.match(html, /<button type="submit">Continue with free access<\/button>/,
    "the free door is the primary (filled) button");
  const subscribe = html.indexOf("<strong>Subscribe</strong>");
  if (expectSubscribe) {
    assert.ok(subscribe !== -1, "Subscribe door is present");
    assert.ok(free < subscribe, "free door comes before Subscribe");
    assert.ok(subscribe < paste, "Subscribe comes before paste-key");
  }
}

async function exchange(env, code, verifier, extra = {}) {
  return await call("/oauth/token", env, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code", code, code_verifier: verifier,
      ...extra,
    }),
  });
}

const mcpCall = (env, token, name) =>
  call("/", env, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
                           params: { name, arguments: {} } }),
  });

test("discovery metadata names the three endpoints and S256", async () => {
  const env = { USAGE: kv() };
  const meta = await (await call(
    "/.well-known/oauth-authorization-server", env)).json();
  assert.equal(meta.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
  assert.equal(meta.token_endpoint, `${ORIGIN}/oauth/token`);
  assert.equal(meta.registration_endpoint, `${ORIGIN}/oauth/register`);
  assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
  const resource = await (await call(
    "/.well-known/oauth-protected-resource", env)).json();
  assert.deepEqual(resource.authorization_servers, [ORIGIN]);
});

test("the key path: register, authorize, exchange, and the token opens the gate", async () => {
  const apiKey = "wbr_real_tenant_key";
  const env = { USAGE: kv(), DB: db(await sha256hex(apiKey)) };
  const { verifier, reqId, html } = await registerAndAuthorize(env);
  // This env has no Stripe configuration, so there is nothing to sell and
  // the subscribe door is not drawn. The other two are always available,
  // free first.
  assert.doesNotMatch(html, /Subscribe/);
  assertFreeFirst(html);

  const granted = await call("/oauth/grant", env, {
    method: "POST",
    body: new URLSearchParams({ req: reqId, api_key: apiKey }),
  });
  assert.equal(granted.status, 302);
  const location = new URL(granted.headers.get("Location"));
  assert.equal(location.origin + location.pathname,
               "https://app.test/callback");
  assert.equal(location.searchParams.get("state"), "st4te");
  const code = location.searchParams.get("code");

  const token = (await (await exchange(env, code, verifier)).json())
    .access_token;
  assert.match(token, /^wbo_/);

  // The token is a working bearer: a tenant-gated tool gets past the auth
  // refusal (it fails later, on the missing company argument, as it should).
  const reply = await (await mcpCall(env, token, "deep_record")).json();
  assert.ok(!JSON.stringify(reply).includes("needs a Whimbrel key"),
    "the OAuth token must satisfy the tenant gate");
});

test("a wrong verifier gets nothing, and a code is single-use", async () => {
  const apiKey = "wbr_real_tenant_key";
  const env = { USAGE: kv(), DB: db(await sha256hex(apiKey)) };
  const { verifier, reqId } = await registerAndAuthorize(env);
  const granted = await call("/oauth/grant", env, {
    method: "POST",
    body: new URLSearchParams({ req: reqId, api_key: apiKey }),
  });
  const code = new URL(granted.headers.get("Location"))
    .searchParams.get("code");

  const wrong = await exchange(env, code, "not-the-verifier");
  assert.equal(wrong.status, 400);
  // The failed attempt burned the code: the right verifier is too late.
  const replay = await exchange(env, code, verifier);
  assert.equal(replay.status, 400);
});

test("the free grant connects but confers only what anonymous has", async () => {
  const env = { USAGE: kv(), DB: db("no-such-hash") };
  const { verifier, reqId } = await registerAndAuthorize(env);
  const granted = await call("/oauth/grant", env, {
    method: "POST", body: new URLSearchParams({ req: reqId, free: "1" }),
  });
  const code = new URL(granted.headers.get("Location"))
    .searchParams.get("code");
  const token = (await (await exchange(env, code, verifier)).json())
    .access_token;

  const paid = await (await mcpCall(env, token, "deep_record")).json();
  assert.ok(JSON.stringify(paid).includes("needs a Whimbrel key"),
    "a free grant must not unlock the paid tier");
});

test("a mismatched redirect_uri or unknown key never reaches a code", async () => {
  const env = { USAGE: kv(), DB: db("no-such-hash") };
  const { registered } = await registerAndAuthorize(env);
  const evil = await call("/oauth/authorize?" + new URLSearchParams({
    client_id: registered.client_id,
    redirect_uri: "https://evil.test/steal",
    response_type: "code", code_challenge: "x",
    code_challenge_method: "S256",
  }), env);
  const evilHtml = await evil.text();
  assert.match(evilHtml, /not valid/);
  assert.match(evilHtml, /whimbrelresearch\.com\/connect/);
  assert.doesNotMatch(evilHtml, /Close this window/);

  const { reqId } = await registerAndAuthorize(env);
  const denied = await call("/oauth/grant", env, {
    method: "POST",
    body: new URLSearchParams({ req: reqId, api_key: "wbr_wrong" }),
  });
  assert.equal(denied.status, 200);
  const deniedHtml = await denied.text();
  assert.match(deniedHtml, /not recognized/);
  // The OAuth request is still valid, so the doors come back rather than
  // a dead end, with the same pending request id.
  assertFreeFirst(deniedHtml);
  assert.match(deniedHtml, new RegExp(`name="req" value="${reqId}"`));
  assert.match(deniedHtml, /whimbrelresearch\.com\/connect/);
});

test("checkout completion consumes the claim so the key is never shown", async () => {
  const apiKey = "wbr_fresh_from_webhook";
  const env = { USAGE: kv(), DB: db(await sha256hex(apiKey)) };
  const { verifier, reqId } = await registerAndAuthorize(env);
  // The Stripe webhook parked the new key under the checkout session id.
  await env.USAGE.put("claim:cs_test_123", apiKey);

  const done = await call(
    `/oauth/complete?req=${reqId}&session=cs_test_123`, env);
  assert.equal(done.status, 302);
  assert.equal(env.USAGE.store.has("claim:cs_test_123"), false,
    "the claim must be consumed, never displayed");
  const code = new URL(done.headers.get("Location"))
    .searchParams.get("code");
  const token = (await (await exchange(env, code, verifier)).json())
    .access_token;
  const reply = await (await mcpCall(env, token, "deep_record")).json();
  assert.ok(!JSON.stringify(reply).includes("needs a Whimbrel key"));
});

test("registration without redirect_uris is refused", async () => {
  const env = { USAGE: kv() };
  const response = await call("/oauth/register", env, {
    method: "POST", body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
});

// The sign-in challenge (MCP_REQUIRE_AUTH). Claude's Add-connector dialog
// probes the endpoint unauthenticated; what it gets back decides whether
// a new user is offered sign-in at all. Each case below is one caller
// class: the probing app, a token holder, a key holder, the operator
// lane, and the flipped-off config.

test("an unauthenticated MCP POST is challenged toward sign-in", async () => {
  const env = { USAGE: kv(), MCP_REQUIRE_AUTH: "1" };
  const response = await mcpCall(env, null, "latest_signals");
  assert.equal(response.status, 401);
  assert.match(response.headers.get("WWW-Authenticate"),
    /resource_metadata="https:\/\/mcp\.test\/\.well-known\/oauth-protected-resource"/);
  const body = await response.json();
  // The refusal must name the free path, or it reads as a paywall.
  assert.match(body.error_description, /free access/);
  assert.match(body.error_description, /GET \/v1\/\*/);
  assert.match(body.error_description, /whimbrelresearch\.com\/connect/);
});

test("a free-grant OAuth token passes the challenge", async () => {
  const env = { USAGE: kv(), DB: db("no-such-hash"), MCP_REQUIRE_AUTH: "1" };
  const token = "wbo_free_grant_token";
  await env.USAGE.put(`oauth-token:${await sha256hex(token)}`,
    JSON.stringify({ key_hash: "" }));
  const response = await mcpCall(env, token, "get_access");
  assert.equal(response.status, 200);
});

test("a tenant key passes the challenge", async () => {
  const apiKey = "wbr_challenge_key";
  const env = { USAGE: kv(), DB: db(await sha256hex(apiKey)),
                MCP_REQUIRE_AUTH: "1" };
  const response = await mcpCall(env, apiKey, "get_access");
  assert.equal(response.status, 200);
});

test("the operator lane needs no header even with the challenge on", async () => {
  const env = { USAGE: kv(), MCP_REQUIRE_AUTH: "1",
                OPERATOR_TOKEN: "optok" };
  const response = await call("/op/optok", env, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(response.status, 200);
});

test("without the var, keyless MCP POSTs still answer", async () => {
  const env = { USAGE: kv() };
  const response = await call("/", env, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(response.status, 200);
  const reply = await response.json();
  assert.ok(reply.result.tools.length >= 10);
});

test("the challenge never blocks the OAuth flow itself", async () => {
  // /oauth/register and /oauth/token are unauthenticated by design; a
  // challenge there would deadlock sign-in against itself.
  const env = { USAGE: kv(), MCP_REQUIRE_AUTH: "1" };
  const registered = await call("/oauth/register", env, {
    method: "POST",
    body: JSON.stringify({ redirect_uris: ["https://app.test/callback"] }),
  });
  assert.equal(registered.status, 201);
});

/**
 * The sign-in page's subscribe door, added September 17, 2026.
 *
 * It used to be one hardcoded button reading "Subscribe · $199/month" and
 * "research on 20 companies every month", posting to a checkout that took
 * no plan and so fell through to STRIPE_PRICE_ID. Months after the product
 * was retiered, the page a brand new connector user lands on was still
 * selling the retired plan, and it is the page most likely to take money.
 * These cases pin the two halves of the fix: the page draws the real
 * ladder, and the button a buyer presses decides the price.
 */
const BILLED = {
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
  STRIPE_PRICE_SOLO: "price_solo",
  STRIPE_PRICE_PRACTICE: "price_practice",
  STRIPE_PRICE_FIRM: "price_firm",
  STRIPE_PRICE_ID: "price_retired",
};

// Stripe stub: price reads answer with an amount, checkout creation records
// what was asked for so a test can assert on the price that would be paid.
function stripeStub(created) {
  return async (url, options = {}) => {
    const target = String(url);
    const amounts = { price_solo: 3900, price_practice: 9900,
                      price_firm: 24900, price_retired: 19900 };
    const priceMatch = target.match(/\/prices\/([^/?]+)$/);
    if (priceMatch) {
      return new Response(JSON.stringify({
        id: priceMatch[1], currency: "usd",
        unit_amount: amounts[priceMatch[1]] ?? null,
      }), { status: 200 });
    }
    if (target.endsWith("/checkout/sessions")) {
      const form = new URLSearchParams(String(options.body || ""));
      created.push(Object.fromEntries(form));
      return new Response(JSON.stringify({
        id: "cs_test_1", url: "https://checkout.test/pay",
      }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
}

test("the sign-in page draws the real plan ladder, priced from Stripe",
     async () => {
  const created = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = stripeStub(created);
  try {
    const env = { USAGE: kv(), DB: db("no-such-hash"), ...BILLED };
    const { html } = await registerAndAuthorize(env);
    // Every plan, by name, with its run count and Stripe's own figure.
    assert.match(html, /Solo · \$39\/month/);
    assert.match(html, /2 companies researched a month/);
    assert.match(html, /Practice · \$99\/month/);
    assert.match(html, /8 companies researched a month/);
    assert.match(html, /Firm · \$249\/month/);
    assert.match(html, /25 companies researched a month/);
    // And nothing left of the retired plan.
    assert.doesNotMatch(html, /199/);
    assert.doesNotMatch(html, /20 companies/);
    assertFreeFirst(html, { expectSubscribe: true });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the plan button pressed is the price charged", async () => {
  const created = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = stripeStub(created);
  try {
    const env = { USAGE: kv(), DB: db("no-such-hash"), ...BILLED };
    const { reqId } = await registerAndAuthorize(env);
    const away = await call("/oauth/checkout", env, {
      method: "POST",
      body: new URLSearchParams({ req: reqId, plan: "practice" }),
    });
    assert.equal(away.status, 303);
    assert.equal(away.headers.get("Location"), "https://checkout.test/pay");
    const session = created.at(-1);
    assert.equal(session["line_items[0][price]"], "price_practice");
    // The tier rides along so the webhook writes the right allowance.
    assert.equal(session["metadata[tier]"], "practice");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a plan that does not exist buys nothing", async () => {
  const created = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = stripeStub(created);
  try {
    const env = { USAGE: kv(), DB: db("no-such-hash"), ...BILLED };
    const { reqId } = await registerAndAuthorize(env);
    const away = await call("/oauth/checkout", env, {
      method: "POST",
      body: new URLSearchParams({ req: reqId, plan: "enterprise" }),
    });
    // A forged or stale form is not a reason to fall back to a price the
    // buyer did not choose, which is what the retired plan default did.
    assert.equal(away.status, 200);
    const html = await away.text();
    assert.match(html, /not available/);
    // The request is still valid, so the doors come back rather than a
    // close-this-window dead end.
    assertFreeFirst(html, { expectSubscribe: true });
    assert.match(html, /whimbrelresearch\.com\/connect/);
    assert.equal(created.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an expired grant points at the connect page, not a dead end", async () => {
  const env = { USAGE: kv() };
  const expired = await call("/oauth/grant", env, {
    method: "POST",
    body: new URLSearchParams({ req: "wbr-q_gone", free: "1" }),
  });
  assert.equal(expired.status, 200);
  const html = await expired.text();
  assert.match(html, /expired/);
  assert.match(html, /whimbrelresearch\.com\/connect/);
  assert.doesNotMatch(html, /Close this window/);
});
