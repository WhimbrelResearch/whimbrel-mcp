/**
 * The x402 payment gate for the public HTTP data API.
 *
 * Design of record: docs/x402-http-api.md. x402 revives HTTP 402: an
 * unpaid request is answered with the payment terms as JSON, the caller's
 * agent pays and retries with an X-PAYMENT header, and a facilitator
 * service verifies and settles on chain so this worker never touches a
 * key, a chain RPC or gas.
 *
 * Two rules run through everything here:
 *
 *   Fail closed. A missing, malformed, unverifiable or unsettled payment
 *   returns 402, never the data. Every path that could serve on an
 *   unproven payment is an error path instead.
 *
 *   Fail open only when the gate cannot exist. With no X402_PAY_TO there
 *   is no wallet to pay, so the routes serve free rather than 402-ing
 *   callers into a wall they cannot climb. That is the state before Nate
 *   sets a receiving address, and it is deliberate: the same data is free
 *   over MCP anyway, so an open gate gives nothing away.
 */

export const X402_VERSION = 1;

// USDC on Base mainnet (Circle). Overridable with X402_ASSET; the
// base-sepolia test token is 0x036CbD53842c5426634e7929541eC2318f3dCF7e.
// Verify the address against Circle's own list before taking real money.
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// Coinbase's CDP facilitator: the one the production x402 sellers
// (Firecrawl, Zyte, Neynar) settle through. Base mainnet, fee-free USDC,
// and it feeds the x402 Bazaar so paying agents can find this service.
// The x402.org facilitator settles Base Sepolia testnet only, which is
// why it is no longer the default here. Verify/settle on CDP require a
// CDP API key (CDP_API_KEY_ID + CDP_API_KEY_SECRET secrets, below).
export const DEFAULT_FACILITATOR =
  "https://api.cdp.coinbase.com/platform/v2/x402";
export const TESTNET_FACILITATOR = "https://x402.org/facilitator";
const USDC_DECIMALS = 6;

/**
 * "0.01" -> "10000". String arithmetic, never floats: 0.1 + 0.2 problems
 * are funny in a tutorial and expensive in a price. A fraction finer than
 * the asset's decimals throws rather than silently truncating, because a
 * silently truncated price charges the wrong amount forever.
 */
export function atomicUnits(amount, decimals = USDC_DECIMALS) {
  const text = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`x402: price must be a plain decimal, got ${amount}`);
  }
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) {
    throw new Error(
      `x402: price ${amount} is finer than the asset's ${decimals} decimals`);
  }
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  return String(BigInt(whole + padded));
}

export function isEnabled(env) {
  return Boolean(env && env.X402_PAY_TO);
}

/** The price for one route tier, as configured. Prices live in
 * wrangler.toml vars, not in code: the number is Nate's to change without
 * a code review, and the protocol requires it be quoted somewhere. */
export function priceUsd(env, tier) {
  if (tier === "company") return env.X402_PRICE_COMPANY_USDC || "0.05";
  if (tier === "archive") return env.X402_PRICE_ARCHIVE_USDC || "1.00";
  return env.X402_PRICE_FEED_USDC || "0.01";
}

export function paymentRequirements(env, { resource, tier, description,
                                           mimeType = "application/json" }) {
  const usd = priceUsd(env, tier);
  return {
    scheme: "exact",
    network: env.X402_NETWORK || "base",
    maxAmountRequired: atomicUnits(usd),
    resource,
    description,
    mimeType,
    payTo: env.X402_PAY_TO || "",
    maxTimeoutSeconds: Number(env.X402_TIMEOUT_SECONDS || 60),
    asset: env.X402_ASSET || USDC_BASE,
    extra: { name: "USDC", version: "2" },
    // Bazaar discovery metadata: the CDP facilitator indexes endpoints it
    // settles for that advertise this, which is how paying agents find the
    // service without being told about it. Unknown keys are tolerated by
    // facilitators that do not index.
    extensions: { bazaar: { discoverable: true } },
  };
}

export function b64encode(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The X-PAYMENT header, base64 JSON, or null when it is anything else. */
export function decodePayment(header) {
  if (!header) return null;
  try {
    const binary = atob(String(header).trim());
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    return data && typeof data === "object" && !Array.isArray(data)
      ? data : null;
  } catch (_) {
    return null;
  }
}

export function paymentRequiredResponse(requirements, error, headers = {}) {
  return Response.json(
    { x402Version: X402_VERSION, accepts: [requirements], error },
    { status: 402, headers },
  );
}

function b64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * A CDP bearer JWT for one facilitator request. CDP's API takes no static
 * key: each request carries a short-lived EdDSA JWT signed with the CDP
 * secret API key (the base64 Ed25519 key CDP issues by default), bound to
 * the exact method+host+path in a `uris` claim and expiring in two
 * minutes. Shape matches Coinbase's cdp-sdk; confirm once against a real
 * key before relying on it, then delete this sentence.
 */
export async function cdpJwt(env, method, url, { cryptoImpl } = {}) {
  const subtle = (cryptoImpl || crypto).subtle;
  const raw = Uint8Array.from(atob(env.CDP_API_KEY_SECRET.trim()),
                              (c) => c.charCodeAt(0));
  if (raw.length !== 64) {
    throw new Error("CDP_API_KEY_SECRET is not a base64 Ed25519 key");
  }
  const key = await subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519",
      d: b64url(raw.slice(0, 32)), x: b64url(raw.slice(32)) },
    { name: "Ed25519" }, false, ["sign"]);
  const { host, pathname } = new URL(url);
  const now = Math.floor(Date.now() / 1000);
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const header = { typ: "JWT", alg: "EdDSA",
                   kid: env.CDP_API_KEY_ID, nonce };
  const claims = { iss: "cdp", sub: env.CDP_API_KEY_ID,
                   aud: ["cdp_service"],
                   uris: [`${method} ${host}${pathname}`],
                   nbf: now, exp: now + 120 };
  const encode = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = await subtle.sign(
    { name: "Ed25519" }, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

async function facilitatorPost(env, path, body, fetchImpl) {
  const base = (env.X402_FACILITATOR || DEFAULT_FACILITATOR)
    .replace(/\/+$/, "");
  const target = `${base}${path}`;
  const headers = { "Content-Type": "application/json" };
  // Mainnet facilitators authenticate; the public testnet one does not.
  // CDP keys win when present; a static bearer stays as the fallback for
  // facilitators that use one.
  if (env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET) {
    headers.Authorization = `Bearer ${await cdpJwt(env, "POST", target)}`;
  } else if (env.X402_FACILITATOR_KEY) {
    headers.Authorization = `Bearer ${env.X402_FACILITATOR_KEY}`;
  }
  const response = await (fetchImpl || fetch)(target, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { /* handled below */ }
  if (!response.ok || !data) {
    throw new Error(
      `facilitator ${path} HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return data;
}

/**
 * Phase one: decide whether this request may proceed.
 *
 * Returns one of
 *   { free: true }                     gate disabled, serve without charge
 *   { challenge: Response }            402, hand it straight back
 *   { verified: true, payload, requirements }
 */
export async function openGate(request, env, route, { fetchImpl } = {}) {
  const requirements = paymentRequirements(env, {
    resource: route.resource,
    tier: route.tier,
    description: route.description,
    mimeType: route.mimeType,
  });
  if (!isEnabled(env)) return { free: true, requirements };

  const payload = decodePayment(request.headers.get("X-PAYMENT"));
  if (!payload) {
    return {
      challenge: paymentRequiredResponse(
        requirements,
        request.headers.get("X-PAYMENT")
          ? "X-PAYMENT header is not valid base64 JSON"
          : "X-PAYMENT header is required"),
    };
  }
  let verdict;
  try {
    verdict = await facilitatorPost(env, "/verify", {
      x402Version: X402_VERSION,
      paymentPayload: payload,
      paymentRequirements: requirements,
    }, fetchImpl);
  } catch (error) {
    // A facilitator we cannot reach is not a payment we can trust.
    return {
      challenge: paymentRequiredResponse(
        requirements, `payment could not be verified: ${error.message}`),
    };
  }
  if (!verdict || verdict.isValid !== true) {
    return {
      challenge: paymentRequiredResponse(
        requirements,
        verdict?.invalidReason || "payment was not valid"),
    };
  }
  return { verified: true, payload, requirements, payer: verdict.payer || null };
}

/**
 * Phase two: settle, after the data has been produced but before it is
 * returned. Ordering is the reference middleware's and it is the fair one:
 * nobody is charged for a response we failed to build, and nobody receives
 * a response we failed to charge for.
 */
export async function settlePayment(env, gate, { fetchImpl } = {}) {
  if (!gate?.verified) return { ok: true, header: null };
  let receipt;
  try {
    receipt = await facilitatorPost(env, "/settle", {
      x402Version: X402_VERSION,
      paymentPayload: gate.payload,
      paymentRequirements: gate.requirements,
    }, fetchImpl);
  } catch (error) {
    return { ok: false, reason: `settlement failed: ${error.message}` };
  }
  if (!receipt || receipt.success !== true) {
    return {
      ok: false,
      reason: receipt?.errorReason || "settlement was refused",
    };
  }
  return { ok: true, header: b64encode(receipt), receipt };
}
