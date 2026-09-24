/**
 * The x402 gate's rules, pinned. Run: node --test whimbrel-mcp/test/
 *
 * Payment code earns tests that the rest of a small worker does not: every
 * bug here either gives the data away or takes money without delivering.
 * The cases below are the ones that would do that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  atomicUnits, isEnabled, openGate, settlePayment, decodePayment,
  b64encode, paymentRequirements,
} from "../src/x402.js";

const PAID_ENV = {
  X402_PAY_TO: "0x00000000000000000000000000000000000000a1",
  X402_NETWORK: "base",
  // A bare host, so the stub below sees "/verify" and "/settle" exactly;
  // the real default (x402.org/facilitator) carries a path prefix.
  X402_FACILITATOR: "https://facilitator.test",
  X402_PRICE_FEED_USDC: "0.01",
  X402_PRICE_COMPANY_USDC: "0.05",
};
const ROUTE = {
  resource: "https://example.test/v1/signals/latest",
  tier: "feed",
  description: "latest signals",
};

function requestWith(header) {
  return new Request(ROUTE.resource, {
    headers: header ? { "X-PAYMENT": header } : {},
  });
}

// A facilitator stub: hands back whatever the test says it should, and
// records what it was asked.
function facilitator(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: JSON.parse(options.body) });
      const reply = responses[path];
      if (typeof reply === "function") return reply();
      return new Response(JSON.stringify(reply), { status: 200 });
    },
  };
}

const VALID_PAYLOAD = b64encode({ scheme: "exact", network: "base" });

test("prices convert to atomic units without float arithmetic", () => {
  assert.equal(atomicUnits("0.01"), "10000");
  assert.equal(atomicUnits("0.05"), "50000");
  assert.equal(atomicUnits("1"), "1000000");
  assert.equal(atomicUnits("12.345678"), "12345678");
  // Finer than the asset's decimals would silently charge the wrong
  // amount forever, so it is refused rather than truncated.
  assert.throws(() => atomicUnits("0.0000001"));
  assert.throws(() => atomicUnits("free"));
});

test("a route with no receiving address serves free rather than walling", async () => {
  assert.equal(isEnabled({}), false);
  const gate = await openGate(requestWith(null), {}, ROUTE);
  assert.equal(gate.free, true);
  assert.equal(gate.challenge, undefined);
});

test("an unpaid request is answered with the terms, not the data", async () => {
  const gate = await openGate(requestWith(null), PAID_ENV, ROUTE);
  assert.equal(gate.verified, undefined);
  assert.equal(gate.challenge.status, 402);
  const body = await gate.challenge.json();
  assert.equal(body.x402Version, 1);
  assert.equal(body.accepts.length, 1);
  assert.equal(body.accepts[0].maxAmountRequired, "10000");
  assert.equal(body.accepts[0].payTo, PAID_ENV.X402_PAY_TO);
  assert.equal(body.accepts[0].resource, ROUTE.resource);
  assert.match(body.error, /required/);
});

test("company routes quote the company price", () => {
  const requirements = paymentRequirements(PAID_ENV, {
    resource: "https://example.test/v1/company/acme",
    tier: "company", description: "timeline",
  });
  assert.equal(requirements.maxAmountRequired, "50000");
});

test("a garbled payment header is refused, not guessed at", async () => {
  assert.equal(decodePayment("not-base64-at-all!!"), null);
  assert.equal(decodePayment(b64encode(["array"])), null);
  const gate = await openGate(requestWith("%%%"), PAID_ENV, ROUTE);
  assert.equal(gate.challenge.status, 402);
  const body = await gate.challenge.json();
  assert.match(body.error, /base64/);
});

test("a payment the facilitator rejects never opens the gate", async () => {
  const stub = facilitator({
    "/verify": { isValid: false, invalidReason: "insufficient_funds" },
  });
  const gate = await openGate(requestWith(VALID_PAYLOAD), PAID_ENV, ROUTE,
                              { fetchImpl: stub.fetchImpl });
  assert.equal(gate.verified, undefined);
  assert.equal(gate.challenge.status, 402);
  assert.match((await gate.challenge.json()).error, /insufficient_funds/);
});

test("an unreachable facilitator fails closed", async () => {
  const stub = facilitator({
    "/verify": () => { throw new Error("connection refused"); },
  });
  const gate = await openGate(requestWith(VALID_PAYLOAD), PAID_ENV, ROUTE,
                              { fetchImpl: stub.fetchImpl });
  assert.equal(gate.verified, undefined);
  assert.equal(gate.challenge.status, 402);
});

test("a verified payment opens the gate and carries the terms to settlement", async () => {
  const stub = facilitator({
    "/verify": { isValid: true, payer: "0xpayer" },
    "/settle": { success: true, transaction: "0xdeadbeef", network: "base" },
  });
  const gate = await openGate(requestWith(VALID_PAYLOAD), PAID_ENV, ROUTE,
                              { fetchImpl: stub.fetchImpl });
  assert.equal(gate.verified, true);
  assert.equal(gate.payer, "0xpayer");
  // The same terms the caller was quoted are the terms settled against.
  assert.equal(stub.calls[0].body.paymentRequirements.maxAmountRequired,
               "10000");

  const settled = await settlePayment(PAID_ENV, gate,
                                      { fetchImpl: stub.fetchImpl });
  assert.equal(settled.ok, true);
  assert.equal(stub.calls[1].path, "/settle");
  const receipt = JSON.parse(
    Buffer.from(settled.header, "base64").toString("utf8"));
  assert.equal(receipt.transaction, "0xdeadbeef");
});

test("a refused settlement is not a served response", async () => {
  const stub = facilitator({
    "/settle": { success: false, errorReason: "already_used" },
  });
  const settled = await settlePayment(
    PAID_ENV, { verified: true, payload: {}, requirements: {} },
    { fetchImpl: stub.fetchImpl });
  assert.equal(settled.ok, false);
  assert.match(settled.reason, /already_used/);
});

test("a free gate settles trivially and adds no receipt", async () => {
  const settled = await settlePayment({}, { free: true });
  assert.equal(settled.ok, true);
  assert.equal(settled.header, null);
});

// ---- CDP facilitator alignment (August 29, 2026) ----
//
// Production x402 sellers settle through Coinbase's CDP facilitator, which
// is mainnet, fee-free, and feeds the Bazaar discovery index. Its API takes
// a short-lived EdDSA JWT per request, not a static key. These cases pin
// the JWT's shape and that it actually verifies against the key's public
// half, so a regression cannot silently break every mainnet settlement.

import { cdpJwt } from "../src/x402.js";
import { generateKeyPairSync, webcrypto } from "node:crypto";

function testCdpKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const d = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  return {
    secret: Buffer.concat([d, x]).toString("base64"),
    publicJwk: publicKey.export({ format: "jwk" }),
  };
}

const fromB64url = (s) =>
  JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

test("the CDP JWT is EdDSA-signed, request-bound, and short-lived", async () => {
  const { secret, publicJwk } = testCdpKey();
  const env = { CDP_API_KEY_ID: "test-key-id", CDP_API_KEY_SECRET: secret };
  const jwt = await cdpJwt(
    env, "POST", "https://api.cdp.coinbase.com/platform/v2/x402/verify");
  const [h, c, s] = jwt.split(".");
  const header = fromB64url(h);
  assert.equal(header.alg, "EdDSA");
  assert.equal(header.kid, "test-key-id");
  assert.ok(header.nonce, "each JWT carries a fresh nonce");
  const claims = fromB64url(c);
  assert.equal(claims.iss, "cdp");
  assert.deepEqual(claims.uris,
    ["POST api.cdp.coinbase.com/platform/v2/x402/verify"]);
  assert.ok(claims.exp - claims.nbf === 120, "two-minute lifetime");
  const key = await webcrypto.subtle.importKey(
    "jwk", publicJwk, { name: "Ed25519" }, false, ["verify"]);
  const valid = await webcrypto.subtle.verify(
    { name: "Ed25519" }, key,
    Buffer.from(s, "base64url"),
    new TextEncoder().encode(`${h}.${c}`));
  assert.ok(valid, "the signature verifies against the public half");
});

test("CDP keys put a JWT on facilitator calls; without them none is sent", async () => {
  const { secret } = testCdpKey();
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(options.headers.Authorization || null);
    return new Response(JSON.stringify({ isValid: true }), { status: 200 });
  };
  const env = { ...PAID_ENV,
                CDP_API_KEY_ID: "k", CDP_API_KEY_SECRET: secret };
  await openGate(requestWith(VALID_PAYLOAD), env, ROUTE, { fetchImpl });
  assert.match(seen[0], /^Bearer e[yJ]/);
  await openGate(requestWith(VALID_PAYLOAD), PAID_ENV, ROUTE, { fetchImpl });
  assert.equal(seen[1], null);
});

test("payment terms advertise Bazaar discoverability", () => {
  const terms = paymentRequirements(PAID_ENV, ROUTE);
  assert.equal(terms.extensions.bazaar.discoverable, true);
});
