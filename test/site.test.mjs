/**
 * The data site, served from the worker. Run: node --test whimbrel-mcp/test/
 *
 * data.whimbrelresearch.com is static files on GitHub Pages, which cannot
 * answer 402. Serving the same bytes from here is what makes one switch gate
 * every copy of the data, so the cases that matter are: which files are
 * priced, which stay free forever, and that a file the publisher has not
 * uploaded yet fails as a 404 rather than as a charge or a crash.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import worker from "../src/index.js";

const GLAMA_JSON = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../site-static/glama.json"),
  "utf8");

const FILES = {
  "site:index.html": "<!doctype html><title>Whimbrel</title>",
  "site:index.json": '{"dataset":"manifest"}',
  "site:llms.txt": "# Whimbrel Research data",
  "site:methodology.md": "# About this data",
  "site:robots.txt": "User-agent: *\nAllow: /\n",
  "site:sitemap.xml": "<urlset></urlset>",
  "site:stats.json": '{"corpus":{}}',
  "site:signals-latest.json": '{"events":[]}',
  "site:signals-archive.json": '{"events":[],"total_events":0}',
  "site:mcp.json": '{"name":"whimbrel-research","version":"1.0.0","remotes":[{"type":"streamable-http","url":"https://data.whimbrelresearch.com"}]}',
  "site:glama.json": GLAMA_JSON,
};

function envWith(extra = {}, files = FILES) {
  return {
    CORPUS: { get: async (key) => (key in files ? files[key] : null) },
    ...extra,
  };
}

const ctx = { waitUntil() {} };

const get = (path, env, headers = {}) =>
  worker.fetch(new Request(`https://data.test${path}`, { headers }), env, ctx);

const PAID_ENV = {
  X402_PAY_TO: "0x00000000000000000000000000000000000000a1",
  X402_NETWORK: "base",
  X402_FACILITATOR: "https://facilitator.test",
  X402_PRICE_FEED_USDC: "0.01",
};

test("documents serve from the store with their own content type", async () => {
  const response = await get("/methodology.md", envWith());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /text\/markdown/);
  assert.equal(await response.text(), "# About this data");
});

test("the feed file serves free while no address is configured", async () => {
  const response = await get("/signals-latest.json", envWith());
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"events":[]}');
});

test("switching payment on gates the data files and nothing else", async () => {
  const env = envWith(PAID_ENV);
  const feed = await get("/signals-latest.json", env);
  assert.equal(feed.status, 402);
  const archive = await get("/signals-archive.json", env);
  assert.equal(archive.status, 402);

  // Everything a reader needs to decide whether to buy stays readable.
  for (const path of ["/methodology.md", "/llms.txt", "/index.json",
                      "/stats.json", "/robots.txt", "/sitemap.xml",
                      "/.well-known/mcp.json",
                      "/.well-known/mcp/server-card.json",
                      "/.well-known/glama.json"]) {
    const response = await get(path, env);
    assert.equal(response.status, 200, `${path} must stay free`);
  }
});

test("a file the publisher has not uploaded is a 404, not a crash", async () => {
  const response = await get("/methodology.md", envWith({}, {}));
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /has not been published/);
});

test("a paid caller is never settled for a file we cannot deliver", async () => {
  // The one ordering that matters: verify, build the response, and only
  // settle once there is something to hand over. Reversing it takes money
  // for nothing.
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push(path);
    return new Response(
      JSON.stringify(path === "/verify"
        ? { isValid: true }
        : { success: true, transaction: "0xabc" }),
      { status: 200 });
  };
  try {
    const response = await get("/signals-latest.json", envWith(PAID_ENV, {}), {
      "X-PAYMENT": Buffer.from(
        JSON.stringify({ scheme: "exact", network: "base" })).toString("base64"),
    });
    assert.equal(response.status, 404);
    assert.ok(calls.includes("/verify"), "payment should still be verified");
    assert.ok(!calls.includes("/settle"), "nothing to deliver, nothing taken");
  } finally {
    globalThis.fetch = real;
  }
});

test("/ serves the published page, and falls back before it exists", async () => {
  const published = await get("/", envWith());
  assert.equal(published.status, 200);
  assert.match(await published.text(), /<!doctype html>/);

  const bare = await get("/", envWith({}, {}));
  assert.equal(bare.status, 200);
  assert.match(await bare.text(), /Streamable HTTP/);
});

test("the catalogue prices the feed file and lists the free documents", async () => {
  const response = await get("/.well-known/x402", envWith(PAID_ENV));
  const catalogue = await response.json();
  const priced = catalogue.endpoints.find(
    (e) => e.path === "/signals-latest.json");
  assert.equal(priced.price_usdc, "0.01");
  const free = catalogue.free_endpoints.map((e) => e.path);
  for (const path of ["/methodology.md", "/llms.txt", "/stats.json",
                      "/.well-known/mcp.json",
                      "/.well-known/glama.json"]) {
    assert.ok(free.includes(path), `${path} must be advertised as free`);
  }
  assert.ok(!free.includes("/signals-latest.json"));
});

test("the complete archive has its own price tier in the catalogue", async () => {
  const response = await get("/.well-known/x402", envWith(PAID_ENV));
  const catalogue = await response.json();
  const archive = catalogue.endpoints.find(
    (e) => e.path === "/signals-archive.json");
  assert.ok(archive, "the archive file must be a catalogued endpoint");
  assert.equal(archive.price_usdc, "1.00");
  const custom = await get("/.well-known/x402",
    envWith({ ...PAID_ENV, X402_PRICE_ARCHIVE_USDC: "2.50" }));
  const repriced = (await custom.json()).endpoints.find(
    (e) => e.path === "/signals-archive.json");
  assert.equal(repriced.price_usdc, "2.50");
});

test("the archive serves free while no address is configured", async () => {
  const response = await get("/signals-archive.json", envWith());
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"events":[],"total_events":0}');
});

test("site assets serve free with their type, and 404 before upload", async () => {
  const png = new Uint8Array([137, 80, 78, 71]).buffer;
  const env = {
    ...PAID_ENV,
    // KV takes either get(key, "arrayBuffer") or get(key, {type, cacheTtl}).
    // Accept both so the test pins the behaviour, not the call shape.
    CORPUS: { get: async (key, opts) => {
      const type = typeof opts === "string" ? opts : opts?.type;
      return key === "site-asset:brief-illustration.png" &&
             type === "arrayBuffer" ? png : null;
    } },
  };
  const served = await get("/assets/brief-illustration.png", env);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("Content-Type"), "image/png");
  // Free even with payment switched on: an image behind a paywall is just
  // a broken layout.
  const missing = await get("/assets/nope.png", env);
  assert.equal(missing.status, 404);
  // Traversal and junk shapes fall through to the ordinary 404, never KV.
  const evil = await get("/assets/..%2Fsecrets", envWith());
  assert.equal(evil.status, 404);
});

// September 5 and 6, 2026: the account went over its daily KV read ceiling,
// every site read threw, and the worker reported the files as never
// published. The site told visitors its data did not exist while the data
// sat intact in storage, and the root quietly served its pre-launch stub
// instead, so nothing looked broken from a browser. An unreadable store must
// never again be indistinguishable from an empty one.

const THROWS = { CORPUS: { get: async () => { throw new Error("KV 429"); } } };

test("a store that cannot be read is a 503, not a 404 claiming no data", async () => {
  const response = await get("/llms.txt", THROWS);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /outage on our side/);
  assert.equal(response.headers.get("Retry-After"), "300");
});

test("/ reports a failed read instead of falling back to the stub", async () => {
  // The fallback landing exists for the window before the first upload. A
  // storage failure is not that, and dressing it up as that is what hid two
  // days of downtime.
  const response = await get("/", THROWS);
  assert.equal(response.status, 503);
});

test("/ still falls back to the landing when nothing is published yet", async () => {
  const empty = { CORPUS: { get: async () => null } };
  const response = await get("/", empty);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /US medtech buying signals/);
});

test("an unreadable store never settles a payment for the feed", async () => {
  const response = await get("/signals-latest.json", { ...PAID_ENV, ...THROWS });
  assert.notEqual(response.status, 200);
});

test("assets report a failed read rather than 404ing as unpublished", async () => {
  const response = await get("/assets/brief-illustration.png", THROWS);
  assert.equal(response.status, 503);
});

test("free site files are cacheable so repeat reads skip the store", async () => {
  const response = await get("/llms.txt", envWith());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control"), /public, max-age=\d+/);
});

test("GET /.well-known/mcp.json serves CORPUS site:mcp.json as JSON", async () => {
  // Daily ingest uploads site:mcp.json; SITE_FREE_FILES maps both
  // discovery URLs onto those bytes, same as llms.txt. The worker does
  // not generate a different body. Missing KV is a 404, as with any
  // unpublished site file.
  const card = await get("/.well-known/mcp.json", envWith());
  assert.equal(card.status, 200);
  assert.match(card.headers.get("Content-Type"), /application\/json/);
  assert.equal(await card.text(), FILES["site:mcp.json"]);

  const alias = await get("/.well-known/mcp/server-card.json", envWith());
  assert.equal(alias.status, 200);
  assert.match(alias.headers.get("Content-Type"), /application\/json/);
  assert.equal(await alias.text(), FILES["site:mcp.json"]);

  const missing = await get("/.well-known/mcp.json", envWith({}, {}));
  assert.equal(missing.status, 404);
});

test("GET /.well-known/glama.json serves CORPUS site:glama.json as JSON", async () => {
  // Daily ingest uploads site:glama.json from the static claim file.
  // SITE_FREE_FILES maps the well-known path onto those bytes. Missing
  // KV is a 404, as with any unpublished site file.
  const claim = await get("/.well-known/glama.json", envWith());
  assert.equal(claim.status, 200);
  assert.match(claim.headers.get("Content-Type"), /application\/json/);
  assert.equal(await claim.text(), GLAMA_JSON);
  assert.deepEqual(JSON.parse(GLAMA_JSON), {
    $schema: "https://glama.ai/mcp/schemas/connector.json",
    claim: "glama_claim_heYtsZ6EDMv3MZa08ifPKQMiw2zrldsK",
  });

  const missing = await get("/.well-known/glama.json", envWith({}, {}));
  assert.equal(missing.status, 404);
});
