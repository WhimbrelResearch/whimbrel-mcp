/**
 * Sign in with Whimbrel: MCP OAuth for app clients.
 *
 * The Claude app (web, desktop, mobile) cannot attach a bearer header to
 * a custom connector; its two modes are no auth and OAuth. The free tier
 * works keyless, so the paid tier's only route into the app is this:
 * OAuth 2.1 authorization-code with PKCE, public clients, dynamic
 * registration, exactly the shape MCP clients expect.
 *
 * The user story is the point: someone clicks Connect in the app, lands
 * on our page, continues with free access (or pays through Stripe, or
 * pastes a key), and the app silently receives a token. Free is first
 * and primary: that is the easiest install. No key is ever shown on
 * the subscribe path: /oauth/complete consumes the checkout claim that
 * /v1/key would otherwise display. Paste-Bearer is the tertiary door,
 * for clients that show a key rather than OAuth.
 *
 * Rules, each pinned by a test:
 *   - PKCE S256 is required; a wrong verifier gets nothing.
 *   - Codes are single-use, short-lived, and bound to client + redirect.
 *   - redirect_uri must exactly match one from the client's registration.
 *   - Tokens are opaque, stored only as SHA-256, and map to the tenant's
 *     key hash. A "continue free" token maps to nothing: it connects the
 *     app but confers exactly what anonymous confers.
 */

const CODE_TTL = 300;             // seconds an auth code lives
const REQUEST_TTL = 900;          // seconds a pending authorize request lives
const CLIENT_TTL = 180 * 86400;   // dynamic client registrations
export const TOKEN_TTL = 180 * 86400;  // access tokens; app re-auths after

function randomToken(prefix, bytes = 24) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  const b64 = btoa(String.fromCharCode(...raw))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${prefix}${b64}`;
}

async function sha256b64url(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256hex(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

export function authServerMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["whimbrel"],
  };
}

export function protectedResourceMetadata(origin) {
  return {
    resource: origin,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
  };
}

export async function registerClient(env, request) {
  let body;
  try { body = await request.json(); } catch (_) { body = null; }
  const uris = Array.isArray(body?.redirect_uris)
    ? body.redirect_uris.filter((u) => {
        try { return ["https:", "http:"].includes(new URL(u).protocol); }
        catch (_) { return false; }
      })
    : [];
  if (!uris.length) {
    return Response.json(
      { error: "invalid_client_metadata",
        error_description: "redirect_uris is required" },
      { status: 400, headers: JSON_HEADERS });
  }
  const clientId = randomToken("wbc_", 16);
  await env.USAGE.put(`oauth-client:${clientId}`,
    JSON.stringify({ redirect_uris: uris }),
    { expirationTtl: CLIENT_TTL });
  return Response.json({
    client_id: clientId,
    redirect_uris: uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
    client_id_issued_at: Math.floor(Date.now() / 1000),
  }, { status: 201, headers: JSON_HEADERS });
}

async function loadClient(env, clientId) {
  if (!clientId) return null;
  return await env.USAGE.get(`oauth-client:${clientId}`, "json");
}

export function page(title, body) {
  return new Response(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,
sans-serif;background:#fbfaf8;color:#142522;max-width:430px;margin:0 auto;
padding:2.5rem 1.25rem;line-height:1.6}
h1{font-size:1.3rem;letter-spacing:-0.01em}
.lockup{font-weight:700;color:#0f4942;margin-bottom:1.6rem}
.lockup span{background:#e7f0ec;color:#175e55;border-radius:6px;
padding:0.1em 0.45em;margin-left:0.5em;font-size:0.72rem;font-weight:600;
letter-spacing:0.06em;text-transform:uppercase}
.card{background:#fffefa;border:1px solid #d9ddd6;border-radius:14px;
padding:1.2rem 1.3rem;margin:1rem 0}
button{background:#175e55;color:#fffefa;border:0;border-radius:10px;
padding:0.8rem 1.4rem;font-size:1rem;font-weight:600;cursor:pointer;width:100%}
button.quiet{background:none;color:#175e55;border:1px solid #175e55}
button.plan{margin-bottom:0.5rem;text-align:left}
button.plan small{display:block;font-weight:400;opacity:0.85;margin-top:0.15rem}
input{width:100%;box-sizing:border-box;padding:0.7rem 0.8rem;
border:1px solid #d9ddd6;border-radius:8px;font-size:0.95rem;margin:0.5rem 0}
.note{font-size:0.85rem;color:#3f544f}
a{color:#175e55}
form{margin:0}
</style></head><body>
<div class="lockup">Whimbrel Research<span>Connect</span></div>
${body}
</body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const CONNECT_PAGE = "https://whimbrelresearch.com/connect/";

function connectHelp() {
  return `<p class="note">Install steps for every client:
<a href="${CONNECT_PAGE}">whimbrelresearch.com/connect/</a></p>`;
}

function deny(reason) {
  return page("Whimbrel Research: cannot connect",
    `<h1>This connection request is not valid</h1>
<p class="note">${reason} Start again from your app, or follow the install
steps at <a href="${CONNECT_PAGE}">whimbrelresearch.com/connect/</a>.</p>`);
}

/** The three doors, free first as the primary action. */
function doors(reqId, plans = []) {
  const planButtons = plans.map((plan) => {
    const price = plan.amount ? ` · ${plan.amount}/month` : "";
    return `<button type="submit" class="plan quiet" name="plan" ` +
      `value="${plan.key}">${plan.label}${price}` +
      `<small>${plan.runs} ${plan.runs === 1 ? "company" : "companies"} ` +
      `researched a month</small></button>`;
  }).join("\n");
  const subscribeCard = plans.length ? `<div class="card">
<p><strong>Subscribe</strong>: deep research on demand inside your app.
Name a company and it comes back researched, every line quoted from the
source it came from. The plans differ only in how many companies a month.</p>
<form method="POST" action="/oauth/checkout">
<input type="hidden" name="req" value="${reqId}">
${planButtons}
</form>
<p class="note">Everything in the free archive stays free on every plan.
Cancel anytime. Paying here hands the token straight to your app, so there
is nothing to copy and paste.</p>
</div>
` : "";
  return `<div class="card">
<p><strong>Continue with free access</strong>. The signal feed and
company lookups are free. No account and no key.</p>
<form method="POST" action="/oauth/grant">
<input type="hidden" name="req" value="${reqId}">
<input type="hidden" name="free" value="1">
<button type="submit">Continue with free access</button>
</form>
</div>
${subscribeCard}<div class="card">
<p><strong>Already subscribed?</strong> Paste your API key once. This is
the path for clients that show a key rather than handing a token to the
app through OAuth.</p>
<form method="POST" action="/oauth/grant">
<input type="hidden" name="req" value="${reqId}">
<input type="password" name="api_key" placeholder="wbr_..." autocomplete="off">
<button type="submit" class="quiet">Connect with my key</button>
</form>
</div>`;
}

function recover(title, heading, reason, reqId, plans) {
  return page(title, `
<h1>${heading}</h1>
<p class="note">${reason}</p>
${doors(reqId, plans)}
${connectHelp()}`);
}

/**
 * GET /oauth/authorize: validate, park the request, show the choice.
 *
 * `plans` is the purchasable ladder, resolved by the caller because the
 * plan table and the Stripe price ids live with the worker. Each entry is
 * { key, label, runs, amount }, and `amount` comes from Stripe rather than
 * from anything written here: until September 17, 2026 this page advertised
 * "$199/month" and "20 companies" in its own markup, months after the
 * product stopped having that plan. An empty list means nothing is for
 * sale, and the subscribe door is simply not drawn.
 */
export async function authorizePage(env, url, plans = []) {
  const q = url.searchParams;
  const client = await loadClient(env, q.get("client_id"));
  if (!client) return deny("The client is not registered.");
  const redirect = q.get("redirect_uri");
  if (!client.redirect_uris.includes(redirect)) {
    return deny("The return address does not match the registration.");
  }
  if (q.get("response_type") !== "code") {
    return deny("Only the code flow is supported.");
  }
  const challenge = q.get("code_challenge");
  if (!challenge || (q.get("code_challenge_method") || "S256") !== "S256") {
    return deny("A PKCE S256 code challenge is required.");
  }
  const reqId = randomToken("wbr-q_", 16);
  await env.USAGE.put(`oauth-req:${reqId}`, JSON.stringify({
    client_id: q.get("client_id"), redirect_uri: redirect,
    state: q.get("state") || "", code_challenge: challenge,
  }), { expirationTtl: REQUEST_TTL });
  // One submit button per plan inside one form: the clicked button's own
  // name and value are what gets posted, so the plan travels without a
  // radio group and without JavaScript.
  return page("Connect Whimbrel Research", `
<h1>Connect your AI to Whimbrel Research</h1>
${doors(reqId, plans)}
<p class="note">Connecting shares nothing about you with Whimbrel beyond
what you choose here.</p>`);
}

async function mintCode(env, pending, keyHash) {
  const code = randomToken("wbcode_", 24);
  await env.USAGE.put(`oauth-code:${code}`, JSON.stringify({
    client_id: pending.client_id, redirect_uri: pending.redirect_uri,
    code_challenge: pending.code_challenge, key_hash: keyHash,
  }), { expirationTtl: CODE_TTL });
  const target = new URL(pending.redirect_uri);
  target.searchParams.set("code", code);
  if (pending.state) target.searchParams.set("state", pending.state);
  return Response.redirect(target.toString(), 302);
}

async function pendingRequest(env, reqId) {
  if (!reqId) return null;
  return await env.USAGE.get(`oauth-req:${reqId}`, "json");
}

/** POST /oauth/grant: the key path and the free path. */
export async function grantFromForm(env, request, resolveKeyHash, plans = []) {
  const form = await request.formData();
  const reqId = String(form.get("req") || "");
  const pending = await pendingRequest(env, reqId);
  if (!pending) return deny("This request has expired.");
  if (form.get("free")) return mintCode(env, pending, "");
  const key = String(form.get("api_key") || "").trim();
  const keyHash = key ? await resolveKeyHash(key) : null;
  if (!keyHash) {
    return recover("Whimbrel Research: key not recognized",
      "That key was not recognized",
      "Check it below, continue with free access, or reach " +
      "nate@whimbrelresearch.com to have a key rotated.",
      reqId, plans);
  }
  return mintCode(env, pending, keyHash);
}

/** POST /oauth/checkout: park the request id in the checkout's return URL. */
export async function checkoutFromForm(env, request, url, createSession,
                                      plans = []) {
  const form = await request.formData();
  const reqId = String(form.get("req") || "");
  const pending = await pendingRequest(env, reqId);
  if (!pending) return deny("This request has expired.");
  // Which button was pressed. The caller turns it into a price; this side
  // does not know what the plans cost or which Stripe ids they carry.
  const plan = String(form.get("plan") || "");
  const session = await createSession({
    successUrl:
      `${url.origin}/oauth/complete?req=${reqId}&session={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${url.origin}/oauth/authorize?` + new URLSearchParams({
      client_id: pending.client_id, redirect_uri: pending.redirect_uri,
      state: pending.state, response_type: "code",
      code_challenge: pending.code_challenge, code_challenge_method: "S256",
    }).toString(),
  }, plan);
  if (!session.ok) {
    return recover("Whimbrel Research: billing unavailable",
      "Billing is not available right now",
      `${session.reason} Reach nate@whimbrelresearch.com, or continue ` +
      "with free access below.",
      reqId, plans);
  }
  return Response.redirect(session.url, 303);
}

/**
 * GET /oauth/complete: back from Stripe. The webhook stored the new key
 * under claim:{session}; consume it here so it is never displayed, and
 * hand the app a code instead. If the webhook has not landed yet, wait on
 * a self-refreshing page bounded by the request's own TTL.
 */
export async function completeCheckout(env, url) {
  const reqId = url.searchParams.get("req");
  const sessionId = url.searchParams.get("session") || "";
  const pending = await pendingRequest(env, reqId);
  if (!pending) return deny("This request has expired.");
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return deny("Bad checkout session.");
  const key = await env.USAGE.get(`claim:${sessionId}`);
  if (!key) {
    return new Response(page("Connecting your subscription",
      `<h1>Finishing up</h1>
<p class="note">Your payment is confirmed and the subscription is being
wired up. This page refreshes itself.</p>`).body, {
      headers: { "Content-Type": "text/html; charset=utf-8", Refresh: "2" },
    });
  }
  await env.USAGE.delete(`claim:${sessionId}`);
  return mintCode(env, pending, await sha256hex(key));
}

/** POST /oauth/token: PKCE-checked, single-use exchange. */
export async function tokenExchange(env, request) {
  const form = await request.formData();
  const fail = (error, status = 400) =>
    Response.json({ error }, { status, headers: JSON_HEADERS });
  if (form.get("grant_type") !== "authorization_code") {
    return fail("unsupported_grant_type");
  }
  const code = String(form.get("code") || "");
  const stored = code
    ? await env.USAGE.get(`oauth-code:${code}`, "json") : null;
  if (!stored) return fail("invalid_grant");
  // Single-use before any other check: a replayed code must find nothing,
  // even a replay that would have failed PKCE.
  await env.USAGE.delete(`oauth-code:${code}`);
  if (form.get("client_id") && form.get("client_id") !== stored.client_id) {
    return fail("invalid_grant");
  }
  if (form.get("redirect_uri") &&
      form.get("redirect_uri") !== stored.redirect_uri) {
    return fail("invalid_grant");
  }
  const verifier = String(form.get("code_verifier") || "");
  if (!verifier ||
      (await sha256b64url(verifier)) !== stored.code_challenge) {
    return fail("invalid_grant");
  }
  const token = randomToken("wbo_", 32);
  await env.USAGE.put(`oauth-token:${await sha256hex(token)}`,
    JSON.stringify({ key_hash: stored.key_hash || "" }),
    { expirationTtl: TOKEN_TTL });
  return Response.json({
    access_token: token, token_type: "bearer", expires_in: TOKEN_TTL,
    scope: "whimbrel",
  }, { headers: JSON_HEADERS });
}

/**
 * A bearer that is no tenant key may be an OAuth token. Returns
 * { key_hash } (empty string = the free grant) or null.
 */
export async function resolveOauthToken(env, bearer) {
  if (!bearer || !bearer.startsWith("wbo_") || !env.USAGE) return null;
  return await env.USAGE.get(`oauth-token:${await sha256hex(bearer)}`, "json");
}
