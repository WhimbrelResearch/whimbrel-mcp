/**
 * Stripe billing for the self-serve MCP tier.
 *
 * The decision is old (docs/migration-architecture.md): Checkout for signup,
 * a webhook into this worker that flips `status` and `paid_through` in D1,
 * and Stripe's Customer Portal for upgrades, cancels and card changes, so
 * there is no billing UI to build. The split of hands is equally old: this
 * file and the route that calls it are built here; the account, the price and
 * the API keys are Nate's, set as worker secrets.
 *
 * Two rules, the same shape as the x402 gate beside it:
 *
 *   Fail closed on anything payment-shaped. A webhook whose signature does
 *   not verify, or whose timestamp is old enough to be a replay, is refused
 *   before it can grant anybody access.
 *
 *   Fail explicit when unconfigured. With no keys set, every entry point
 *   answers "billing is not configured" rather than half-working. Nothing
 *   here silently grants or silently denies.
 */

const API = "https://api.stripe.com/v1";

// Stripe signs `${timestamp}.${rawBody}` and sends `t=<ts>,v1=<hex>`. Older
// events than this are refused: a captured webhook replayed later must not
// re-grant a subscription that has since been cancelled.
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function isConfigured(env) {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
}

export const NOT_CONFIGURED =
  "Billing is not configured on this server yet: STRIPE_SECRET_KEY, " +
  "STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_ID are unset. Reach " +
  "nate@whimbrelresearch.com.";

function hex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(message)));
}

// Length-independent compare. Signature checks leak through timing when they
// short-circuit, and the cost of doing it right here is nothing.
function constantTimeEquals(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function parseSignatureHeader(header) {
  const parts = {};
  for (const piece of String(header || "").split(",")) {
    const [key, value] = piece.split("=");
    if (!key || value === undefined) continue;
    const name = key.trim();
    // v1 can appear more than once while a signing secret is being rotated;
    // any one of them matching is a valid signature.
    if (name === "v1") (parts.v1 ||= []).push(value.trim());
    else parts[name] = value.trim();
  }
  return { timestamp: parts.t || null, signatures: parts.v1 || [] };
}

/**
 * Verifies a webhook and returns { ok: true, event } or { ok: false, reason }.
 * Takes the raw body text: re-serialising JSON changes the bytes and the
 * signature is over the bytes.
 */
export async function verifyWebhook(env, rawBody, signatureHeader,
                                    now = Date.now()) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return { ok: false, reason: "no webhook secret configured" };
  }
  const { timestamp, signatures } = parseSignatureHeader(signatureHeader);
  if (!timestamp || signatures.length === 0) {
    return { ok: false, reason: "missing or malformed Stripe-Signature" };
  }
  const age = Math.floor(now / 1000) - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: "signature timestamp outside tolerance" };
  }
  const expected = await hmacSha256Hex(
    env.STRIPE_WEBHOOK_SECRET, `${timestamp}.${rawBody}`);
  if (!signatures.some((candidate) => constantTimeEquals(candidate, expected))) {
    return { ok: false, reason: "signature does not match" };
  }
  try {
    return { ok: true, event: JSON.parse(rawBody) };
  } catch (_) {
    return { ok: false, reason: "signed body is not JSON" };
  }
}

async function stripeRequest(env, method, path, form, fetchImpl) {
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (form) options.body = new URLSearchParams(form).toString();
  const response = await (fetchImpl || fetch)(`${API}${path}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, reason: body?.error?.message || `HTTP ${response.status}` };
  }
  return { ok: true, body };
}

/** A Checkout session for a new subscriber. Returns { ok, url } or an error. */
export async function createCheckoutSession(env, { successUrl, cancelUrl },
                                            options = {}, fetchImpl) {
  // The caller names the price, so one function serves every plan and the
  // one-time run pack. STRIPE_PRICE_ID remains the default for callers that
  // predate the plans.
  const priceId = options.priceId || env.STRIPE_PRICE_ID;
  const mode = options.mode === "payment" ? "payment" : "subscription";
  if (!isConfigured(env) || !priceId) {
    return { ok: false, reason: NOT_CONFIGURED };
  }
  const body = {
    mode,
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: "true",
  };
  // Metadata is how the webhook learns what was bought. Stripe echoes it on
  // the session, so no second API call is needed to find out, and reading a
  // plan name back beats inferring one from a price id.
  for (const [key, value] of Object.entries(options.metadata || {})) {
    body[`metadata[${key}]`] = String(value);
  }
  // A run pack is a one-time purchase for an existing customer, so it is
  // attached to their Stripe customer rather than creating a second one.
  if (options.customerId) body.customer = options.customerId;
  const result = await stripeRequest(env, "POST", "/checkout/sessions", body,
                                     fetchImpl);
  return result.ok ? { ok: true, url: result.body.url, id: result.body.id }
                   : result;
}

/** The Customer Portal: upgrades, cancels and card changes, all Stripe's. */
export async function createPortalSession(env, customerId, returnUrl,
                                          fetchImpl) {
  if (!isConfigured(env)) return { ok: false, reason: NOT_CONFIGURED };
  const result = await stripeRequest(env, "POST", "/billing_portal/sessions", {
    customer: customerId, return_url: returnUrl,
  }, fetchImpl);
  return result.ok ? { ok: true, url: result.body.url } : result;
}

/**
 * One price, read back from Stripe so a plan's amount can be shown without
 * any surface hardcoding it. The dollar figures live in Stripe alone; a
 * number copied into code or into published copy is a number that drifts,
 * which is exactly how the site came to advertise a retired plan.
 */
export async function fetchPrice(env, priceId, fetchImpl) {
  if (!isConfigured(env) || !priceId) {
    return { ok: false, reason: NOT_CONFIGURED };
  }
  return stripeRequest(env, "GET", `/prices/${priceId}`, null, fetchImpl);
}

/** Stripe's unit_amount as something a buyer reads, or null if unreadable. */
export function formatAmount(price) {
  const cents = Number(price?.unit_amount);
  if (!Number.isFinite(cents)) return null;
  const currency = String(price?.currency || "usd").toUpperCase();
  const whole = cents / 100;
  const figure = Number.isInteger(whole) ? String(whole) : whole.toFixed(2);
  return currency === "USD" ? `$${figure}` : `${figure} ${currency}`;
}

export async function fetchSubscription(env, subscriptionId, fetchImpl) {
  if (!subscriptionId) return { ok: false, reason: "no subscription id" };
  return stripeRequest(env, "GET", `/subscriptions/${subscriptionId}`, null,
                       fetchImpl);
}

const DAY = 24 * 60 * 60 * 1000;

/** Stripe's epoch seconds to the ISO date the tenants row stores. */
export function isoDate(epochSeconds) {
  if (epochSeconds == null || !Number.isFinite(Number(epochSeconds))) {
    return null;
  }
  return new Date(Number(epochSeconds) * 1000).toISOString().slice(0, 10);
}

/**
 * The subscription's period end, wherever the account's API version put
 * it. Stripe's 2025 API versions removed current_period_end from the
 * Subscription object and moved it onto each subscription item, so a new
 * account reads undefined at the top level while the real date sits in
 * items.data. Found live on September 15, 2026: every checkout was left
 * on its one-day bootstrap entitlement and died the next day. Reads both
 * shapes; with several items the latest end wins.
 */
export function subscriptionPeriodEnd(subscription) {
  if (!subscription) return null;
  if (subscription.current_period_end != null) {
    return subscription.current_period_end;
  }
  const ends = (subscription.items?.data || [])
    .map((item) => Number(item?.current_period_end))
    .filter((end) => Number.isFinite(end) && end > 0);
  return ends.length ? Math.max(...ends) : null;
}

/**
 * What an event means for the tenants row: { customerId, status, paidThrough }
 * or null when the event is not one we act on.
 *
 * `paid_through` always comes from Stripe's own current_period_end rather
 * than from arithmetic here, except for the bootstrap case where a brand new
 * checkout has not told us the period yet; that one grants a single day and
 * the subscription events that follow within seconds correct it. Erring short
 * is the safe direction: a customer briefly under-entitled writes in, a
 * customer over-entitled never does.
 */
/**
 * The price a subscription is on, read from the item where the 2025 API
 * versions keep it, falling back to the legacy top-level plan.
 */
export function subscriptionPriceId(subscription) {
  const item = subscription?.items?.data?.[0];
  return item?.price?.id || item?.plan?.id
    || subscription?.plan?.id || null;
}

export function applyEvent(event, now = Date.now()) {
  const object = event?.data?.object || {};
  switch (event?.type) {
    case "checkout.session.completed":
      // A one-time payment is a run pack, not a subscription: an existing
      // customer topping up this month. It grants runs, never access, so it
      // must never mint a tenant or move paid_through.
      if (object.mode === "payment") {
        return {
          kind: "pack",
          customerId: object.customer || null,
          sessionId: object.id || null,
          packRuns: Number(object.metadata?.pack_runs) || 0,
        };
      }
      if (object.mode && object.mode !== "subscription") return null;
      return {
        kind: "new",
        customerId: object.customer || null,
        subscriptionId: object.subscription || null,
        email: object.customer_details?.email || object.customer_email || null,
        name: object.customer_details?.name || null,
        sessionId: object.id || null,
        // The plan the checkout was started for. Metadata rather than the
        // price id, because the caller that opened the session knows which
        // plan it offered and Stripe echoes it back here unchanged.
        tier: object.metadata?.tier || null,
        status: "active",
        paidThrough: new Date(now + DAY).toISOString().slice(0, 10),
      };
    case "customer.subscription.created":
    case "customer.subscription.updated":
      return {
        kind: "update",
        customerId: object.customer || null,
        status: ["active", "trialing"].includes(object.status)
          ? "active" : object.status === "past_due" ? "past_due" : "canceled",
        paidThrough: isoDate(subscriptionPeriodEnd(object)),
        // A plan change made in the Customer Portal arrives here carrying
        // the new price and none of our metadata, so the caller maps the
        // price back to a plan. Null means "leave the tier alone".
        priceId: subscriptionPriceId(object),
      };
    case "customer.subscription.deleted":
      return { kind: "update", customerId: object.customer || null,
               status: "canceled", paidThrough: isoDate(now / 1000) };
    case "invoice.payment_succeeded":
      return { kind: "update", customerId: object.customer || null,
               status: "active",
               paidThrough: isoDate(object.lines?.data?.[0]?.period?.end) };
    case "invoice.payment_failed":
      return { kind: "update", customerId: object.customer || null,
               status: "past_due", paidThrough: null };
    default:
      return null;
  }
}
