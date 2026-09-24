/**
 * Whimbrel Signals MCP: the free tier of the Whimbrel Research data layer.
 *
 * A stateless Streamable-HTTP MCP server on Cloudflare Workers. Every tool
 * is served from the public feed at data.whimbrelresearch.com, which the
 * daily Standing Watch refreshes; this server holds no data of its own and
 * can never expose more than the public files do, by construction.
 *
 * Telemetry: one KV counter increment per tool call (day + tool, and the
 * requested signal kind for latest_signals). No caller identity is stored.
 */

import {
  isConfigured as stripeConfigured, NOT_CONFIGURED as STRIPE_NOT_CONFIGURED,
  verifyWebhook, createCheckoutSession, createPortalSession,
  fetchSubscription, applyEvent, isoDate, subscriptionPeriodEnd,
  fetchPrice, formatAmount,
} from "./stripe.js";
import {
  X402_VERSION, USDC_BASE, isEnabled, priceUsd, openGate, settlePayment,
  paymentRequiredResponse,
} from "./x402.js";
import {
  authServerMetadata, protectedResourceMetadata, registerClient,
  authorizePage, grantFromForm, checkoutFromForm, completeCheckout,
  tokenExchange, resolveOauthToken, page as brandedPage,
} from "./oauth.js";
import { crmExport } from "./crm.js";

const FEED_BASE = "https://data.whimbrelresearch.com";

const SERVER_INFO = {
  name: "whimbrel-signals",
  title: "Whimbrel Research: US medtech signals",
  version: "1.0.0",
};

const INSTRUCTIONS =
  "Free access to Whimbrel Research's full US medtech signal archive: NIH " +
  "and NSF SBIR/STTR awards, federal medical R&D contracts (DoD, DARPA, " +
  "BARDA), FDA 510(k) clearances, PMA approvals, De Novo grants, " +
  "Breakthrough marketing authorizations, Humanitarian Device Exemption " +
  "(HDE) approvals, and " +
  "ClinicalTrials.gov device trial registrations, refreshed daily, every " +
  "event linked to its public source, searchable across years with " +
  "find_signals. " +
  "Company records also carry patent grants, published patent " +
  "applications, SEC funding filings, device listings, device recalls, " +
  "CDRH warning letters, and device import-alert listings, with " +
  "the people each registry itself names (award PIs, filing officers, " +
  "trial officials). The paid layer is deep research on " +
  "demand: point deep_record at any company and the research pipeline runs " +
  "on our infrastructure - current leadership, contact routes, funding and " +
  "milestones read from the company's own site and press, every line " +
  "quoted from its source. Tiered by how many companies you research a " +
  "month; the archive above is free either way. " +
  "For firms that want the research and the targeting done for them, " +
  "Whimbrel also runs it as a managed service, first month free: " +
  "https://whimbrelresearch.com · nate@whimbrelresearch.com";

/**
 * The tools, with a title and behaviour annotations on every one.
 *
 * The annotations are not decoration. Anthropic's Connectors Directory
 * refuses a submission whose tools lack a title and the applicable
 * readOnlyHint or destructiveHint, and client UIs use them to decide what
 * needs a confirmation prompt: a caller should not be asked to approve a
 * read of a public award record, and should be asked before something
 * spends a research run.
 *
 * readOnlyHint is true for everything that only reads the archive or a
 * stored record. It is false for the three that act: deep_record queues a
 * research run (real money, one slot against the month), get_access opens
 * a Stripe checkout, billing_portal opens the customer portal. None of the
 * three destroys anything, so each says destructiveHint: false explicitly
 * rather than leaving a client to assume the default, which is true.
 */
const TOOLS = [
  {
    name: "latest_signals",
    title: "Latest medtech signals",
    annotations: { readOnlyHint: true, destructiveHint: false,
                   idempotentHint: true, openWorldHint: false },
    description:
      "US medtech buying signals observed in the last 14 days: NIH and NSF " +
      "SBIR/STTR awards, federal medical R&D contracts, FDA 510(k) " +
      "clearances, PMA approvals, De Novo grants, Breakthrough marketing " +
      "authorizations, Humanitarian Device Exemption (HDE) approvals, and " +
      "ClinicalTrials.gov " +
      "device trial registrations. Each " +
      "event carries a stable id, company name, event and observed dates, " +
      "a parsed amount_usd where the source states a figure, a one-line " +
      "summary, and the public source URL. Optionally filter by kind. " +
      "who_got_funded returns NIH awards from this window. Several " +
      "Breakthrough marketing authorizations or HDE approvals can name " +
      "the same manufacturer. Run deep_record on that manufacturer once " +
      "to unlock deep research.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["nih_award", "nsf_award", "federal_contract",
                 "sbir_award",
                 "fda_clearance", "fda_pma", "fda_denovo",
                 "fda_breakthrough_auth", "fda_hde",
                 "trial_registration"],
          description: "Only return this signal kind.",
        },
        limit: {
          type: "number",
          description: "Maximum events to return (default 25, max 50).",
        },
      },
    },
  },
  {
    name: "signal_of_the_day",
    title: "Signal of the day",
    annotations: { readOnlyHint: true, destructiveHint: false,
                   idempotentHint: true, openWorldHint: false },
    description:
      "The single newest medtech signal in the feed, with its figures, " +
      "a plain-words summary, and the public record behind it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "weekly_pulse",
    title: "Weekly pulse",
    annotations: { readOnlyHint: true, destructiveHint: false,
                   idempotentHint: true, openWorldHint: false },
    description:
      "Aggregate view of the last 7 days of US medtech signals: event " +
      "counts by kind (including ClinicalTrials.gov device trial " +
      "registrations, Breakthrough marketing authorizations, and " +
      "Humanitarian Device Exemption (HDE) approvals " +
      "in the recent window), total stated NIH award " +
      "dollars, and the largest single event. Computed from the feed, " +
      "never estimated.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "about_the_data",
    title: "About this data",
    annotations: { readOnlyHint: true, destructiveHint: false,
                   idempotentHint: true, openWorldHint: false },
    description:
      "How the data is collected, dated, and windowed; what the feed " +
      "excludes; archive size; licensing and attribution terms.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "micro_brief",
    title: "Micro brief on a company",
    annotations: { readOnlyHint: true, destructiveHint: false,
                   idempotentHint: true, openWorldHint: false },
    description:
      "A composed mini-dossier on any US medtech company in the archive: " +
      "every registry event on record across years (NIH " +
      "awards with decoded phase and freshness, FDA clearances, " +
      "approvals, De Novos, Breakthrough marketing authorizations, " +
      "and Humanitarian Device Exemption (HDE) approvals, " +
      "federal R&D contracts, ClinicalTrials.gov " +
      "device trial registrations, patent grants and " +
      "published applications, SEC funding " +
      "filings, recalls), stated funding, and a public " +
      "source link on every line. Registry records only; researched " +
      "leadership and contact routes come from the deep-research layer.",
    inputSchema: {
      type: "object",
      properties: {
        company: {
          type: "string",
          description: "Company name (fuzzy matched against the archive).",
        },
      },
      required: ["company"],
    },
  },
  {
    name: "company_timeline",
    title: "Company registry timeline",
    annotations: { readOnlyHint: true, destructiveHint: false,
                   idempotentHint: true, openWorldHint: false },
    description:
      "The raw structured version of micro_brief: every public registry " +
      "event the archive holds for one company, newest first, including " +
      "the full ClinicalTrials.gov device trial registration history, " +
      "Breakthrough marketing authorizations, and Humanitarian Device " +
      "Exemption (HDE) approvals, " +
      "with stable ids, decoded award metadata, and source links.",
    inputSchema: {
      type: "object",
      properties: {
        company: {
          type: "string",
          description: "Company name (fuzzy matched against the archive).",
        },
      },
      required: ["company"],
    },
  },
  {
    name: "find_signals",
    title: "Find matching signals",
    annotations: { readOnlyHint: true, destructiveHint: false,
                   idempotentHint: true, openWorldHint: false },
    description:
      "Search the full monitored corpus of US medtech buying signals across " +
      "years: NIH and NSF SBIR/STTR awards, federal medical R&D contracts, " +
      "FDA 510(k) clearances, PMA approvals, De Novo grants, Breakthrough " +
      "marketing authorizations, Humanitarian Device Exemption (HDE) " +
      "approvals, and " +
      "ClinicalTrials.gov device trial registrations, plus device listings, " +
      "device recalls, CDRH warning letters, device import-alert listings, " +
      "and SEC funding filings. Filter by kind, date, award " +
      "freshness and phase, a minimum stated amount, and free-text terms " +
      "matched against each signal's summary and abstract. Returns sourced " +
      "signals newest first; rank them against your firm's capabilities to " +
      "surface best-fit accounts.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["nih_award", "nsf_award", "federal_contract",
                 "sbir_award",
                 "fda_clearance", "fda_pma", "fda_denovo",
                 "fda_breakthrough_auth", "fda_hde", "fda_listing",
                 "fda_recall", "fda_warning_letter", "fda_import_alert",
                 "trial_registration", "funding_filing"],
          description: "Only return this signal kind.",
        },
        since: {
          type: "string",
          description: "ISO date (YYYY-MM-DD); only signals on or after it. " +
                       "Defaults to the last 90 days.",
        },
        new_award: {
          type: "boolean",
          description: "NIH only: first-year awards (fresh money, partners " +
                       "not yet settled).",
        },
        phase: {
          type: "string",
          enum: ["SBIR Phase I", "SBIR Phase II", "STTR Phase I",
                 "STTR Phase II"],
          description: "NIH only: restrict to this program phase.",
        },
        min_amount_usd: {
          type: "number",
          description: "Only signals with a stated amount at or above this.",
        },
        matching: {
          type: "string",
          description: "Space-separated terms; each must appear in the " +
                       "signal's summary or abstract (e.g. 'spine implant " +
                       "instrument'). Frame these from the firm's capabilities.",
        },
        limit: {
          type: "number",
          description: "Maximum signals to return (default 25, max 50).",
        },
      },
    },
  },
  {
    name: "deep_record",
    title: "Deep research on any company (paid)",
    annotations: { readOnlyHint: false, destructiveHint: false,
                   idempotentHint: false, openWorldHint: true },
    description:
      "The verified deep-research dossier on a company: current leadership " +
      "and buying committee, company facts, contact routes, named partners, " +
      "the evidence behind each, and known gaps. If the company has no " +
      "record yet, or the newest record is more than a week old, calling " +
      "this QUEUES a fresh research run on Whimbrel's " +
      "infrastructure automatically - the pipeline reads the company's " +
      "site and press " +
      "coverage and verifies every claim against its source - and the " +
      "record is served on your next call, minutes later. A record " +
      "researched within the week is served instantly and costs no run. " +
      "Runs count " +
      "against a monthly allowance. Requires an active Whimbrel key.",
    requiresTenant: true,
    inputSchema: {
      type: "object",
      properties: {
        company: {
          type: "string",
          description: "Company name.",
        },
        domain: {
          type: "string",
          description: "The company's website domain (recommended when " +
                       "requesting new research; otherwise it is resolved, " +
                       "and the run fails honestly if it cannot be).",
        },
        refresh: {
          type: "boolean",
          description: "Force a fresh research run even when a recent " +
                       "record exists (counts against the allowance). " +
                       "A record older than a week refreshes " +
                       "automatically without this.",
        },
      },
      required: ["company"],
    },
  },
  {
    name: "crm_export",
    title: "Export research as CRM import files (paid)",
    annotations: { readOnlyHint: true, destructiveHint: false,
                   idempotentHint: true, openWorldHint: false },
    description:
      "A company's deep-research record shaped into ready-to-import CRM " +
      "files: a companies/accounts CSV, a contacts CSV with the researched " +
      "people and titles, a sourced research-notes document to paste onto " +
      "the record, and the exact import steps for the chosen CRM. Formats: " +
      "hubspot, salesforce. Save the CSV fields as files for the user to " +
      "download and import. Requires an existing deep-research record " +
      "(run deep_record first) and an active Whimbrel key.",
    requiresTenant: true,
    inputSchema: {
      type: "object",
      properties: {
        company: {
          type: "string",
          description: "Company name (must already have a deep-research " +
                       "record).",
        },
        format: {
          type: "string",
          enum: ["hubspot", "salesforce"],
          description: "Which CRM the files should import into.",
        },
      },
      required: ["company", "format"],
    },
  },
  {
    name: "research_status",
    title: "Your research requests (paid)",
    annotations: { readOnlyHint: true, destructiveHint: false,
                   idempotentHint: true, openWorldHint: false },
    description:
      "Status of your queued, running, and finished research and " +
      "onboarding requests, plus your monthly run allowance. Requires an " +
      "active Whimbrel key.",
    requiresTenant: true,
    inputSchema: {
      type: "object",
      properties: {
        request_id: {
          type: "string",
          description: "One request to check; omit for your recent ten.",
        },
      },
    },
  },
  {
    name: "who_got_funded",
    title: "Who got funded",
    annotations: { readOnlyHint: true, destructiveHint: false,
                   idempotentHint: true, openWorldHint: false },
    description:
      "The current signal window filtered for NIH awards: " +
      "new_award=true for brand-new money (programs still choosing " +
      "partners), award phase (SBIR/STTR Phase I or II), and a minimum " +
      "stated amount. ClinicalTrials.gov device trial registrations, " +
      "Breakthrough marketing authorizations, and Humanitarian Device " +
      "Exemption (HDE) approvals " +
      "appear in weekly_pulse, latest_signals, and find_signals. " +
      "Then ask weekly_pulse or latest_signals. If a Breakthrough " +
      "manufacturer shows up, run deep_record on that manufacturer " +
      "once to unlock deep research.",
    inputSchema: {
      type: "object",
      properties: {
        new_award: {
          type: "boolean",
          description: "Only first-year awards (fresh money).",
        },
        phase: {
          type: "string",
          enum: ["SBIR Phase I", "SBIR Phase II", "STTR Phase I",
                 "STTR Phase II"],
          description: "Only this program phase.",
        },
        min_amount_usd: {
          type: "number",
          description: "Only events with a stated amount at or above this.",
        },
      },
    },
  },
  {
    name: "get_access",
    title: "Get a key for the paid tools",
    annotations: { readOnlyHint: false, destructiveHint: false,
                   idempotentHint: false, openWorldHint: true },
    description:
      "Returns Stripe Checkout links for the research plans, with the " +
      "monthly company allowance on each. No key is needed to call this " +
      "tool. OAuth Subscribe on the sign-in page hands the token to the " +
      "app with nothing to paste. These links are the display-key path " +
      "for clients that do not use OAuth: open one, pay, and the page " +
      "shows an API key once to send as an Authorization Bearer header. " +
      "Unlocks deep_record, crm_export and research_status.",
    inputSchema: {
      type: "object",
      properties: {
        run_pack: {
          type: "boolean",
          description:
            "Set true, with an active key, to buy extra research runs for " +
            "the current month instead of starting a new plan.",
        },
      },
    },
  },
  {
    name: "billing_portal",
    title: "Manage your subscription",
    annotations: { readOnlyHint: false, destructiveHint: false,
                   idempotentHint: false, openWorldHint: true },
    description:
      "Returns a link to Stripe's customer portal for this account: change " +
      "the card, upgrade, or cancel. Requires an active Whimbrel key.",
    requiresTenant: true,
    inputSchema: { type: "object", properties: {} },
  },
];

// ---- prompts: slash commands for every connected client ----

const PROMPTS = [
  {
    name: "whimbrel_micro_brief",
    title: "Micro brief on a company",
    description:
      "A composed, sourced mini-dossier on any US medtech company in the " +
      "Whimbrel archive.",
    arguments: [
      { name: "company", description: "Company name", required: true },
    ],
  },
  {
    name: "whimbrel_signal_of_the_day",
    title: "Signal of the day",
    description: "The newest US medtech signal on the public record.",
    arguments: [],
  },
  {
    name: "whimbrel_who_got_funded",
    title: "Who got funded",
    description:
      "This week's NIH medtech awards, filterable by freshness, phase, " +
      "and amount.",
    arguments: [
      { name: "filters",
        description: "e.g. 'new phase 2' or 'over 500k'", required: false },
    ],
  },
  {
    name: "whimbrel_weekly_pulse",
    title: "Weekly medtech pulse",
    description:
      "The week's signal aggregates: counts by kind (including " +
      "ClinicalTrials.gov device trial registrations, Breakthrough " +
      "marketing authorizations, and HDE approvals), dollars, largest event.",
    arguments: [],
  },
  {
    name: "whimbrel_latest_signals",
    title: "Latest medtech signals",
    description:
      "The full 14-day feed of US medtech buying signals, optionally " +
      "filtered by kind, including ClinicalTrials.gov device trial " +
      "registrations, Breakthrough marketing authorizations, and HDE " +
      "approvals.",
    arguments: [
      { name: "filters",
        description: "e.g. 'clearances only' or 'awards'", required: false },
    ],
  },
  {
    name: "whimbrel_company_timeline",
    title: "Company registry timeline",
    description:
      "Every public registry event the Whimbrel archive holds for one " +
      "company, newest first, including the full ClinicalTrials.gov " +
      "device trial registration history, Breakthrough marketing " +
      "authorizations, and HDE approvals.",
    arguments: [
      { name: "company", description: "Company name", required: true },
    ],
  },
  {
    name: "whimbrel_about_the_data",
    title: "About the data",
    description:
      "How the Whimbrel archive is collected, dated, windowed, and " +
      "licensed, with current archive size.",
    arguments: [],
  },
];

function promptMessages(name, args) {
  const presentRules =
    "Present the result plainly and completely, keep every source link, " +
    "and add nothing the data does not state.";
  const texts = {
    whimbrel_micro_brief:
      `Call the micro_brief tool with company: ${JSON.stringify(args?.company || "")}. ` +
      "Render the returned markdown brief verbatim. If the response has " +
      "suggestions, list them and ask which company was meant. If it has " +
      "limited: true, say the free-tier daily cap was reached and resets " +
      "tomorrow.",
    whimbrel_signal_of_the_day:
      "Call the signal_of_the_day tool. Present the signal in two or " +
      "three plain lines: company, what the event is with figures and " +
      "decoded phase/freshness when present, and the source link. " +
      presentRules,
    whimbrel_who_got_funded:
      `Interpret these filters: ${JSON.stringify(args?.filters || "none")}. ` +
      "Map 'new' to new_award: true, 'phase 1'/'phase 2' (with SBIR/STTR " +
      "if given) to phase, and 'over $X' to min_amount_usd. Call the " +
      "who_got_funded tool with them. List matches one line each with " +
      "phase, year (flag NEW awards), amount, date, and source link, and " +
      "state the match count and window. " + presentRules,
    whimbrel_weekly_pulse:
      "Call the weekly_pulse tool. Present total events, the split by " +
      "kind, total stated NIH dollars, and the largest stated event with " +
      "its source link, in three or four plain lines. " + presentRules,
    whimbrel_latest_signals:
      `Interpret these filters: ${JSON.stringify(args?.filters || "none")}. ` +
      "Map 'clearances' to kind: fda_clearance, 'awards'/'grants' to " +
      "nih_award, 'approvals'/'PMA' to fda_pma, 'trials' to " +
      "trial_registration; omit kind if none given. " +
      "Call the latest_signals tool with them. List events one line each, " +
      "newest first: company, event, date, stated amount when present, " +
      "source link. State the event count and window. " + presentRules,
    whimbrel_company_timeline:
      `Call the company_timeline tool with company: ${JSON.stringify(args?.company || "")}. ` +
      "List every event one line each, newest first, with date, decoded " +
      "award metadata when present, and source link. If the response has " +
      "suggestions, list them and ask which company was meant. If it has " +
      "limited: true, say the free-tier daily cap was reached and resets " +
      "tomorrow.",
    whimbrel_about_the_data:
      "Call the about_the_data tool. Summarize how the data is collected, " +
      "dated, and windowed, what the feed excludes, the archive size, and " +
      "the licensing terms, in a short plain paragraph plus the key " +
      "numbers. " + presentRules,
  };
  return [{
    role: "user",
    content: { type: "text", text: texts[name] },
  }];
}

// ---- archive store (private KV; served one company at a time) ----

let archiveCache = null;
let archiveCacheAt = 0;

async function loadArchive(env) {
  const now = Date.now();
  if (archiveCache && now - archiveCacheAt < 30 * 60 * 1000) return archiveCache;
  const data = await env.CORPUS?.get("corpus-public", "json");
  if (data) {
    archiveCache = data;
    archiveCacheAt = now;
  }
  return archiveCache;
}

function normalizeName(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function findCompany(archive, query) {
  const wanted = normalizeName(query);
  if (!wanted) return { error: "Give me a company name to look up." };
  const entries = Object.entries(archive.companies || {});
  const scored = [];
  for (const [stem, entry] of entries) {
    const name = normalizeName(entry.name);
    if (name === wanted || stem.replace(/-/g, " ") === wanted) {
      return { stem, entry };
    }
    if (name.startsWith(wanted) || wanted.startsWith(name)) {
      scored.push({ stem, entry, score: 2 });
    } else if (name.includes(wanted) || wanted.includes(name)) {
      scored.push({ stem, entry, score: 1 });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 1 || (scored.length && scored[0].score === 2 &&
      (scored.length < 2 || scored[1].score < 2))) {
    return { stem: scored[0].stem, entry: scored[0].entry };
  }
  if (scored.length) {
    return { suggestions: scored.slice(0, 6).map((s) => s.entry.name) };
  }
  return {
    error:
      `No company matching "${query}" in the archive. The archive covers US ` +
      "medtech companies with NIH award, FDA 510(k), or FDA PMA activity.",
  };
}

// ---- company lookup: D1 first, KV blob as fallback ----

// D1 holds one enriched row per company (company_index), built from the same
// corpus_export that fills the KV blob. Reading it is an indexed fetch instead
// of loading the whole blob into worker memory, and it is the substrate the
// paid matching tools will query. The KV path below stays as a fallback for
// any request where the D1 binding is absent or errors, so a D1 hiccup never
// takes the company tools down.

function d1Entry(row) {
  let events = [];
  try { events = JSON.parse(row.events_json) || []; } catch (_) { /* keep [] */ }
  return {
    stem: row.company_slug,
    entry: { name: row.name, first_tracked: row.first_tracked, events },
  };
}

async function findCompanyD1(env, query) {
  const wanted = normalizeName(query);
  if (!wanted) return { error: "Give me a company name to look up." };
  const db = env.DB;
  // Exact match on the normalized name or the slug is the common case.
  const exact = await db
    .prepare(
      "SELECT company_slug, name, first_tracked, events_json FROM " +
      "company_index WHERE name_norm = ?1 OR company_slug = ?2 LIMIT 1")
    .bind(wanted, wanted.replace(/ /g, "-"))
    .first();
  if (exact) return d1Entry(exact);
  // Fuzzy: net on the first token, then score in JS exactly as the KV path
  // does, so "medtronic inc" and "medtronic" resolve the same either way.
  const token = wanted.split(" ")[0];
  const { results } = await db
    .prepare(
      "SELECT company_slug, name, first_tracked, events_json, name_norm FROM " +
      "company_index WHERE name_norm LIKE ?1 LIMIT 25")
    .bind(`%${token}%`)
    .all();
  const scored = [];
  for (const row of results || []) {
    const name = row.name_norm;
    if (name === wanted) return d1Entry(row);
    if (name.startsWith(wanted) || wanted.startsWith(name)) {
      scored.push({ row, score: 2 });
    } else if (name.includes(wanted) || wanted.includes(name)) {
      scored.push({ row, score: 1 });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 1 || (scored.length && scored[0].score === 2 &&
      (scored.length < 2 || scored[1].score < 2))) {
    return d1Entry(scored[0].row);
  }
  if (scored.length) {
    return { suggestions: scored.slice(0, 6).map((s) => s.row.name) };
  }
  return {
    error:
      `No company matching "${query}" in the archive. The archive covers US ` +
      "medtech companies with NIH award, FDA 510(k), or FDA PMA activity.",
  };
}

async function lookupCompany(env, query) {
  // D1 company_index and the KV blob hold the same companies (same source), so
  // a D1 "no match" is authoritative; only a missing binding or a thrown query
  // falls through to KV.
  if (env.DB) {
    try {
      return await findCompanyD1(env, query);
    } catch (_) { /* fall back to KV */ }
  }
  const archive = await loadArchive(env);
  if (!archive) return { error: "Archive store unavailable; try the feed tools." };
  return findCompany(archive, query);
}

// ---- the paid gate: tenant identity, entitlement, metering ----

// A client presents a bearer key. We store only its SHA-256, never the key.
// The tenants row carries tier, status, and paid_through; Stripe webhooks
// (not built yet) flip status/paid_through. The gate lives here in the worker,
// the single chokepoint, not in the database. Anonymous callers keep the free
// tier under its per-IP caps; an entitled tenant lifts those caps and is the
// only caller allowed to reach a tool marked requiresTenant.

async function sha256hex(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bearerKey(request) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// The tenant behind one api_key_hash, or null. A 60s KV cache keeps this
// off the D1 hot path while still letting a billing change propagate
// within the minute.
async function tenantByHash(env, hash) {
  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = `tenant:${hash}`;
  // The cache is an optimization over D1, which stays the authority, so a
  // failing cache read falls through to D1 rather than failing the caller.
  if (env.USAGE) {
    let cached = null;
    try {
      cached = await env.USAGE.get(cacheKey, "json");
    } catch (_) { /* fall through to D1 */ }
    if (cached) {
      const entitled = cached.status === "active" &&
        (!cached.paid_through || cached.paid_through >= today);
      return { tenant: cached, entitled };
    }
  }
  const row = await env.DB
    .prepare("SELECT tenant_id, name, tier, status, paid_through FROM " +
             "tenants WHERE api_key_hash = ?1")
    .bind(hash).first();
  if (!row) return null;
  if (env.USAGE) {
    try {
      await env.USAGE.put(cacheKey, JSON.stringify(row),
                          { expirationTtl: 60 });
    } catch (_) { /* the answer is already in hand */ }
  }
  const entitled = row.status === "active" &&
    (!row.paid_through || row.paid_through >= today);
  return { tenant: row, entitled };
}

// Resolves the caller to a tenant. Returns null for anonymous (no key, or
// an OAuth "continue free" grant, which confers exactly what anonymous
// confers), { invalid: true } for a bearer that matches nothing, or
// { tenant, entitled } otherwise. The bearer may be a tenant API key or
// an OAuth access token minted by /oauth/token; the token resolves to the
// same tenants row through its stored key hash.
async function resolveTenant(env, request) {
  const key = bearerKey(request);
  if (!key) return null;
  if (!env.DB) return { invalid: true };
  const direct = await tenantByHash(env, await sha256hex(key));
  if (direct) return direct;
  // An OAuth token lives only in KV. If that store is unreadable we cannot
  // tell a good token from a bad one, and "invalid key" would be a lie
  // that sends a paying customer to billing_portal for our outage, so the
  // failure is reported as what it is.
  let grant;
  try {
    grant = await resolveOauthToken(env, key);
  } catch (_) {
    return { outage: true };
  }
  if (grant) {
    if (!grant.key_hash) return null;
    const viaToken = await tenantByHash(env, grant.key_hash);
    if (viaToken) return viaToken;
  }
  return { invalid: true };
}

function recordTenantUsage(env, ctx, tenantId, tool) {
  if (!env.USAGE || !tenantId) return;
  const day = new Date().toISOString().slice(0, 10);
  const keys = [`tcalls:${day}:${tenantId}`, `tcalls:${day}:${tenantId}:${tool}`];
  ctx.waitUntil((async () => {
    try {
      for (const key of keys) {
        const current = Number(await env.USAGE.get(key)) || 0;
        await env.USAGE.put(key, String(current + 1),
                            { expirationTtl: 60 * 60 * 24 * 400 });
      }
    } catch (_) { /* metering must never break a response */ }
  })());
}

// The two strings a would-be customer actually meets, and the moment their
// intent is highest, so they hand back a way to buy rather than an inbox.
// They fall back to the address only while billing is unconfigured, because
// promising a checkout that 503s is worse than asking someone to write.
function authRequiredMessage(env) {
  return stripeConfigured(env)
    ? "This tool needs a Whimbrel key. Call get_access for a checkout link, " +
      "or reach nate@whimbrelresearch.com."
    : "This tool needs a Whimbrel key: nate@whimbrelresearch.com";
}

function invalidKeyMessage(env) {
  return stripeConfigured(env)
    ? "That API key is not recognized, or its subscription has lapsed. " +
      "Remove it to use the free tier, call billing_portal if it is yours, " +
      "or get_access for a new one."
    : "That API key is not recognized. Remove it to use the free tier, or " +
      "reach nate@whimbrelresearch.com.";
}

// ---- per-caller daily cap for archive-depth tools ----

// Raised 25 -> 100 on August 29, 2026 (Nate): a lookup is served from the
// in-memory corpus and costs effectively nothing, so the ceiling's only job
// is making bulk reconstruction of the unpublished archive slow, not
// rationing real readers. 100 is above any genuine day's use; the global
// pool below stays as the scrape backstop.
const DAILY_COMPANY_LOOKUPS = 100;
const DAILY_GLOBAL_LOOKUPS = 2000;
// Every tool call, cheap ones included, counts against a generous per-IP
// daily ceiling. Without it the cheap feed tools were unthrottled, so one
// IP could drive unbounded KV read/write ops (denial-of-wallet). The number
// is far above any real reader's day.
const DAILY_REQUESTS_PER_CALLER = 600;

async function hashCaller(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(ip));
  return [...new Uint8Array(digest)].slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Both cap checks fail OPEN, uncounted, when the counter store itself is
// unreadable. The caps exist to bound KV spend per caller; with KV blocked
// there is no spend to bound, and the alternative observed live on
// September 13, 2026 (the account over its KV daily ceiling) was an
// uncaught throw that turned a metering outage into a full outage while
// D1 and the archive underneath were healthy.
async function takeLookup(env, request, entitled) {
  if (entitled) return { allowed: true };  // paying tenants are uncapped
  if (!env.USAGE) return { allowed: true };
  try {
    const day = new Date().toISOString().slice(0, 10);
    const caller = await hashCaller(request);
    const callerKey = `deep:${day}:${caller}`;
    const globalKey = `deep:${day}:all`;
    const [callerCount, globalCount] = await Promise.all([
      env.USAGE.get(callerKey), env.USAGE.get(globalKey)]);
    if (Number(callerCount) >= DAILY_COMPANY_LOOKUPS ||
        Number(globalCount) >= DAILY_GLOBAL_LOOKUPS) {
      return { allowed: false };
    }
    await Promise.all([
      env.USAGE.put(callerKey, String((Number(callerCount) || 0) + 1),
                    { expirationTtl: 60 * 60 * 48 }),
      env.USAGE.put(globalKey, String((Number(globalCount) || 0) + 1),
                    { expirationTtl: 60 * 60 * 48 }),
    ]);
    return { allowed: true };
  } catch (_) {
    return { allowed: true };
  }
}

async function takeRequest(env, request, entitled) {
  // Best-effort per-IP call cap across all tools. KV is eventually
  // consistent, so this throttles sustained abuse rather than enforcing an
  // exact count; the goal is bounding daily KV ops per caller, not precision.
  if (entitled) return { allowed: true };  // paying tenants are uncapped
  if (!env.USAGE) return { allowed: true };
  try {
    const day = new Date().toISOString().slice(0, 10);
    const caller = await hashCaller(request);
    const key = `req:${day}:${caller}`;
    const count = Number(await env.USAGE.get(key)) || 0;
    if (count >= DAILY_REQUESTS_PER_CALLER) return { allowed: false };
    await env.USAGE.put(key, String(count + 1),
                        { expirationTtl: 60 * 60 * 48 });
    return { allowed: true };
  } catch (_) {
    return { allowed: true };  // see takeLookup: never crash on metering
  }
}

// ---- the paid tier's trigger seam (docs/paid-mcp-tier.md) ----
// A tenant's tool call becomes a research or onboarding run on Whimbrel's
// infrastructure. Asynchronous by construction: a run takes minutes and an
// MCP call must return in seconds, so the reply is always "queued, ask
// again".
//
// The queue itself is the contract, not the dispatch. The worker writes a
// research_requests row; .github/workflows/run-queue.yml polls D1 every few
// minutes and claims it using the Cloudflare token GitHub already holds. If
// DISPATCH_PAT is also set, the worker additionally pokes the workflow so the
// run starts at once instead of on the next tick. Nothing depends on that
// poke succeeding.

// Where a would-be subscriber is sent: the human-facing setup page, which
// carries the per-client steps and the plan ladder. Subscribing from inside
// a connected client never shows an API key, so this is the path worth
// pushing people down.
const CONNECT_PAGE = "https://whimbrelresearch.com/connect/";

// Owner moved September 24, 2026. Dispatch and the ingest backstop call
// this path; the Official Registry name is unchanged.
const GITHUB_REPO = "WhimbrelResearch/whimbrel-research";
const RESEARCH_WORKFLOW = "research-on-demand.yml";
const INGEST_WORKFLOW = "daily-ingest.yml";

// The plans. Retiered September 17, 2026 (business-context) from one
// $199 plan with 20 runs: matching and monitoring left the product, so a
// deep research run is the only thing the paid tier sells, and the plans
// differ by nothing else. Named for buyer scale rather than for features,
// because there are no feature differences to name.
//
// Dollar figures live only in Stripe. What lives here is the allowance and
// the wrangler var holding each plan's price id, so adding a plan is one
// entry plus one var. Usage is counted from research_requests rows with
// failed excluded, so a failed run is never charged and the count cannot
// drift from reality.
const TIERS = {
  solo:     { label: "Solo",     runs: 2,  priceVar: "STRIPE_PRICE_SOLO" },
  practice: { label: "Practice", runs: 8,  priceVar: "STRIPE_PRICE_PRACTICE" },
  firm:     { label: "Firm",     runs: 25, priceVar: "STRIPE_PRICE_FIRM" },
};

// Overage, so nobody meets a wall mid-thought. Monthly-scoped by design:
// see migrations/0010_run_packs.sql for why it is not a banked balance.
const RUN_PACK = { runs: 5, priceVar: "STRIPE_PRICE_RUN_PACK" };

// Tenants minted before the retiering carry tier 'standard', and the pilot
// carries 'pilot'. Both keep the allowance they were sold.
const LEGACY_MONTHLY_RUNS = 20;

const TIER_MONTHLY_RUNS = Object.fromEntries(
  Object.entries(TIERS).map(([key, tier]) => [key, tier.runs]));

function tierPriceId(env, key) {
  const tier = TIERS[key];
  return tier ? (env?.[tier.priceVar] || "") : "";
}

// Which plan a Stripe price belongs to, for a plan change made through the
// Customer Portal: the subscription event carries the new price, not our
// metadata, so the map has to run both ways.
function tierForPriceId(env, priceId) {
  if (!priceId) return null;
  for (const key of Object.keys(TIERS)) {
    if (tierPriceId(env, key) === priceId) return key;
  }
  return null;
}

function companySlug(name) {
  // Mirrors the slug the research workflow computes from the same name, so
  // requests, R2 keys, and research_records all agree on identity.
  return String(name || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function mintRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return "req_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function githubDispatch(env, workflowFile, inputs) {
  if (!env.DISPATCH_PAT) return { ok: false, error: "no dispatch credential" };
  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/` +
    `${workflowFile}/dispatches`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.DISPATCH_PAT}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "whimbrel-signals-mcp",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs }),
    });
  if (response.status === 204) return { ok: true };
  const detail = (await response.text()).slice(0, 200);
  return { ok: false, error: `GitHub dispatch HTTP ${response.status}: ${detail}` };
}

async function monthlyRunsUsed(env, tenantId) {
  const monthStart = new Date().toISOString().slice(0, 7) + "-01";
  const row = await env.DB
    .prepare(
      "SELECT COUNT(*) AS used FROM research_requests WHERE tenant_id = ?1 " +
      "AND kind = 'research' AND status != 'failed' AND created_at >= ?2")
    .bind(tenantId, monthStart).first();
  return Number(row?.used) || 0;
}

function planRuns(tenant) {
  const tier = String(tenant?.tenant?.tier || "").toLowerCase();
  return TIER_MONTHLY_RUNS[tier] ?? LEGACY_MONTHLY_RUNS;
}

// Runs bought on top of the plan this calendar month. Summed rather than
// decremented, so a failed run stays uncharged without anyone crediting a
// balance back.
// How long a price's amount is trusted from cache. Prices change about
// never, and a stale figure on the sign-in page for up to an hour is a
// better trade than a Stripe round trip on every render.
const PLAN_PRICE_CACHE_SECONDS = 3600;

/** A price's display amount, read from Stripe and cached. Null if unknown. */
async function priceAmount(env, priceId) {
  const cacheKey = `price-amount:${priceId}`;
  try {
    const cached = await env.USAGE.get(cacheKey);
    // "-" records a lookup that failed, so a broken price id does not mean
    // a Stripe call per page view.
    if (cached) return cached === "-" ? null : cached;
  } catch { /* the cache is an optimisation, never a dependency */ }
  const result = await fetchPrice(env, priceId);
  const amount = result.ok ? formatAmount(result.body) : null;
  try {
    await env.USAGE.put(cacheKey, amount ?? "-",
                        { expirationTtl: PLAN_PRICE_CACHE_SECONDS });
  } catch { /* as above */ }
  return amount;
}

/**
 * The purchasable ladder for a page that has to draw it: one entry per
 * plan with a configured Stripe price, in TIERS order, each carrying the
 * amount Stripe itself charges. A plan with no price id is not offered, so
 * plans can be filled in one at a time. A plan whose amount cannot be read
 * is still offered, without a figure, because Checkout shows the price
 * anyway and refusing to sell over a failed lookup is the worse outcome.
 */
async function planCatalogue(env) {
  const plans = [];
  for (const [key, tier] of Object.entries(TIERS)) {
    const priceId = tierPriceId(env, key);
    if (!priceId) continue;
    plans.push({
      key, label: tier.label, runs: tier.runs,
      amount: await priceAmount(env, priceId),
    });
  }
  // The pre-retiering single plan, offered only while no new plan has a
  // price, for the same reason get_access still falls back to it: better to
  // sell the old thing than nothing. Its key is empty, which is what the
  // checkout handler reads as "use STRIPE_PRICE_ID".
  if (!plans.length && env.STRIPE_PRICE_ID) {
    plans.push({
      key: "", label: "Research", runs: LEGACY_MONTHLY_RUNS,
      amount: await priceAmount(env, env.STRIPE_PRICE_ID),
    });
  }
  return plans;
}

async function packRunsThisMonth(env, tenantId) {
  if (!env.DB || !tenantId) return 0;
  const monthStart = new Date().toISOString().slice(0, 7) + "-01";
  try {
    const row = await env.DB
      .prepare("SELECT COALESCE(SUM(runs), 0) AS runs FROM run_packs " +
               "WHERE tenant_id = ?1 AND created_at >= ?2")
      .bind(tenantId, monthStart).first();
    return Number(row?.runs) || 0;
  } catch (_) {
    // The table is missing until migration 0010 is applied. A tenant who
    // bought no packs is unaffected either way, so read it as none rather
    // than failing their call.
    return 0;
  }
}

// What to call the tenant's plan in a reply. A legacy tenant has no plan
// name to print, only the allowance they were sold.
function planLabel(tenant) {
  const key = String(tenant?.tenant?.tier || "").toLowerCase();
  const runs = `${planRuns(tenant)} research runs a month`;
  return TIERS[key] ? `${TIERS[key].label}, ${runs}` : runs;
}

async function monthlyAllowance(env, tenant) {
  const tenantId = tenant?.tenant?.tenant_id;
  return planRuns(tenant) + await packRunsThisMonth(env, tenantId);
}

async function markRequest(env, requestId, status, detail) {
  await env.DB
    .prepare("UPDATE research_requests SET status = ?2, detail = ?3, " +
             "updated_at = ?4 WHERE request_id = ?1")
    .bind(requestId, status, String(detail || ""),
          new Date().toISOString()).run();
}

// Queue one research run and dispatch its workflow.
// Dedup first: an already queued or running request for the same work is
// returned rather than duplicated (and only the original requester was
// charged). A dispatch failure marks the row failed immediately, which also
// un-charges it.
// A ceiling above every tenant's own allowance. Each run spends Firecrawl
// credits and model tokens from one shared balance, so without this a single
// busy month, or one tenant working through a long list, can drain the
// balance that Standing Watch and every other client depend on. Configurable
// as a wrangler var so the number moves without a code change; the default is
// deliberately low, because the failure it prevents is expensive and the one
// it causes is a message saying "try tomorrow".
const DEFAULT_MAX_DAILY_RUNS = 25;

function maxDailyRuns(env) {
  const configured = Number(env.MAX_DAILY_RESEARCH_RUNS);
  return Number.isFinite(configured) && configured > 0
    ? configured : DEFAULT_MAX_DAILY_RUNS;
}

async function runsQueuedToday(env) {
  const today = new Date().toISOString().slice(0, 10);
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM research_requests WHERE " +
             "created_at >= ?1 AND status != 'failed'")
    .bind(today).first();
  return Number(row?.n) || 0;
}

// ---- live progress for a run in flight ----
//
// A run takes minutes and the pipeline itself prints nothing until it is
// finished, so without this a tenant's AI has nothing to say between "queued"
// and the record arriving. research_progress is appended to by the workflow
// as it enters each stage (.github/scripts/progress.sh); this reads it back.

async function readProgress(env, requestId) {
  if (!env.DB || !requestId) return [];
  try {
    const rows = await env.DB
      .prepare("SELECT seq, stage, detail, at FROM research_progress " +
               "WHERE request_id = ?1 ORDER BY seq")
      .bind(requestId).all();
    return (rows?.results || []).map((row) => ({
      stage: row.stage, detail: row.detail || null, at: row.at,
    }));
  } catch (_) {
    // The table is added by migration 0009; a worker deployed ahead of it
    // should report no progress rather than fail the call.
    return [];
  }
}

async function requestState(env, requestId) {
  if (!env.DB || !requestId) return null;
  return env.DB
    .prepare("SELECT status, detail FROM research_requests WHERE " +
             "request_id = ?1")
    .bind(requestId).first();
}

const GLOBAL_CEILING_MESSAGE =
  "Whimbrel is at its daily ceiling for research runs across all callers. " +
  "Nothing was charged against your allowance. Runs reset at 00:00 UTC; " +
  "try again then, or reach nate@whimbrelresearch.com if you need a batch " +
  "run sooner.";

async function queueRun(env, tenant, kind, fields, workflowFile, inputs) {
  const tenantId = tenant?.tenant?.tenant_id;
  if (await runsQueuedToday(env) >= maxDailyRuns(env)) {
    // Refused before the row is written, so a refused run never counts
    // against the tenant's month either.
    return { ok: false, ceiling: true, error: GLOBAL_CEILING_MESSAGE };
  }
  const now = new Date().toISOString();
  const requestId = mintRequestId();
  await env.DB
    .prepare(
      "INSERT INTO research_requests (request_id, tenant_id, kind, " +
      "company_name, company_slug, domain, status, detail, created_at, " +
      "updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', '', ?7, ?7)")
    .bind(requestId, tenantId, kind, fields.company_name || "",
          fields.company_slug || "", fields.domain || "", now).run();
  // Dispatch is an accelerator, not a requirement. The row is queued, and
  // .github/workflows/run-queue.yml polls D1 on a schedule and claims it
  // whether or not this worker can talk to GitHub. So a missing or broken
  // dispatch credential delays a run by minutes; it never fails one, and the
  // row is never marked failed for a reason that has nothing to do with the
  // research. Getting this backwards is what made the whole paid tier
  // unrunnable while one secret was unset.
  const dispatched = await githubDispatch(
    env, workflowFile, { ...inputs, request_id: requestId });
  return { requestId, ok: true, startedNow: dispatched.ok };
}

const CAP_MESSAGE =
  "Daily company-lookup ceiling reached for this caller; it resets at " +
  "00:00 UTC. For deep research on any company, with leadership and " +
  "contact routes: https://whimbrelresearch.com · nate@whimbrelresearch.com";

function formatMoney(amount) {
  return amount == null ? null : "$" + amount.toLocaleString("en-US");
}

const SIGNAL_KIND_LABELS = {
  nih_award: "NIH SBIR/STTR award",
  sbir_award: "SBIR/STTR award",
  fda_clearance: "FDA 510(k) clearance",
  fda_pma: "FDA PMA approval",
  fda_denovo: "FDA De Novo grant",
  fda_breakthrough_auth: "FDA Breakthrough marketing authorization",
  fda_hde: "FDA HDE approval",
  fda_listing: "FDA device listing",
  fda_recall: "FDA device recall",
  fda_warning_letter: "FDA CDRH warning letter",
  fda_import_alert: "FDA device import-alert listing",
  federal_contract: "Federal medical R&D contract",
  nsf_award: "NSF award",
  trial_registration: "ClinicalTrials.gov device trial registration",
  funding_filing: "SEC funding filing",
};

// The columns the corpus-query tools SELECT, shaped for output.
const SIGNAL_COLUMNS =
  "signal_key, company_name, domain, signal_kind, signal_summary, " +
  "signal_date, source_url, amount_usd, award_phase, new_award, people";

// Registry-published people ([{name, role}]) stored as JSON on the row;
// [] when the column is empty or unparseable, never a crash.
function parsePeople(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const data = JSON.parse(String(raw));
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

function mapSignalRow(r) {
  const row = {
    id: r.signal_key,
    company: r.company_name,
    kind: r.signal_kind,
    kind_label: SIGNAL_KIND_LABELS[r.signal_kind] || r.signal_kind,
    date: (r.signal_date || "").slice(0, 10),
    amount_usd: r.amount_usd,
    award_phase: r.award_phase,
    new_award: r.new_award === 1 ? true : (r.new_award === 0 ? false : null),
    summary: r.signal_summary,
    source_url: r.source_url,
    domain: r.domain,
  };
  const people = parsePeople(r.people);
  if (people.length) row.people = people;
  return row;
}

// Default lookback for the corpus-query tools when no `since` is given.
function defaultSince() {
  return new Date(Date.now() - 90 * 86400e3).toISOString().slice(0, 10);
}

function composeMicroBrief(entry) {
  const lines = [];
  const events = entry.events || [];
  const newest = events[0] || {};
  lines.push(`# Micro brief: ${entry.name}`);
  lines.push("");
  lines.push(
    `Newest registry ` +
    `event ${newest.date || "n/a"} · ${events.length} registry event` +
    `${events.length === 1 ? "" : "s"} on record · tracked since ` +
    `${entry.first_tracked || "n/a"}`);
  const funding = events.filter(
    (e) => e.kind === "nih_award" || e.kind === "nsf_award" ||
           e.kind === "federal_contract" || e.kind === "sbir_award");
  const regulatory = events.filter(
    (e) => e.kind === "fda_clearance" || e.kind === "fda_pma" ||
           e.kind === "fda_denovo" || e.kind === "fda_breakthrough_auth" ||
           e.kind === "fda_hde");
  const recalls = events.filter((e) => e.kind === "fda_recall");
  const risk = events.filter(
    (e) => e.kind === "fda_warning_letter" || e.kind === "fda_import_alert");
  const trials = events.filter((e) => e.kind === "trial_registration");
  const patents = events.filter(
    (e) => e.kind === "patent_grant" || e.kind === "patent_application");
  const filings = events.filter((e) => e.kind === "funding_filing");
  if (funding.length) {
    lines.push("");
    lines.push("## Funding (federal awards and contracts, stated figures only)");
    for (const e of funding.slice(0, 15)) {
      const bits = [e.date, e.award_phase,
                    e.new_award ? "NEW award" : (e.award_year ? `year ${e.award_year}` : null),
                    formatMoney(e.amount_usd)];
      lines.push(`- ${bits.filter(Boolean).join(" · ")}`);
      lines.push(`  ${e.summary}`);
      lines.push(`  source: ${e.source_url}`);
    }
    if (funding.length > 15) lines.push(`- …and ${funding.length - 15} more`);
  }
  if (regulatory.length) {
    lines.push("");
    lines.push("## Regulatory (FDA)");
    for (const e of regulatory.slice(0, 15)) {
      lines.push(`- ${e.date} · ${e.kind_label}`);
      lines.push(`  ${e.summary}`);
      lines.push(`  source: ${e.source_url}`);
    }
    if (regulatory.length > 15) {
      lines.push(`- …and ${regulatory.length - 15} more`);
    }
  }
  if (recalls.length) {
    lines.push("");
    lines.push("## Recalls (remediation context, not an outreach hook)");
    for (const e of recalls.slice(0, 10)) {
      lines.push(`- ${e.date} · ${e.kind_label}`);
      lines.push(`  ${e.summary}`);
      lines.push(`  source: ${e.source_url}`);
    }
    if (recalls.length > 10) lines.push(`- …and ${recalls.length - 10} more`);
  }
  if (risk.length) {
    lines.push("");
    lines.push(
      "## Risk / compliance (warning letters and import-alert listings)");
    for (const e of risk.slice(0, 10)) {
      lines.push(`- ${e.date} · ${e.kind_label}`);
      lines.push(`  ${e.summary}`);
      lines.push(`  source: ${e.source_url}`);
    }
    if (risk.length > 10) lines.push(`- …and ${risk.length - 10} more`);
  }
  if (trials.length) {
    lines.push("");
    lines.push("## Clinical trial registrations");
    for (const e of trials.slice(0, 15)) {
      lines.push(`- ${e.date} · ${e.kind_label}`);
      lines.push(`  ${e.summary}`);
      lines.push(`  source: ${e.source_url}`);
    }
    if (trials.length > 15) lines.push(`- …and ${trials.length - 15} more`);
  }
  if (filings.length) {
    lines.push("");
    lines.push("## SEC funding filings (targets, not money raised)");
    for (const e of filings.slice(0, 15)) {
      lines.push(`- ${e.date} · ${e.kind_label}`);
      lines.push(`  ${e.summary}`);
      lines.push(`  source: ${e.source_url}`);
    }
    if (filings.length > 15) lines.push(`- …and ${filings.length - 15} more`);
  }
  if (patents.length) {
    lines.push("");
    lines.push("## Patents (USPTO; a publication precedes any grant)");
    for (const e of patents.slice(0, 15)) {
      lines.push(`- ${e.date} · ${e.kind_label}`);
      lines.push(`  ${e.summary}`);
      lines.push(`  source: ${e.source_url}`);
    }
    if (patents.length > 15) lines.push(`- …and ${patents.length - 15} more`);
  }
  // People exactly as the registries name them, deduped, newest sighting
  // first. Registry facts: the PI on the award, the officer on the filing.
  // Who runs the company NOW is the deep-research layer's question.
  const named = new Map();
  for (const e of events) {
    for (const p of parsePeople(e.people)) {
      if (!p || !p.name) continue;
      const key = String(p.name).toLowerCase();
      if (named.has(key)) continue;
      named.set(key, { ...p, _context: `${e.kind_label}, ${e.date || "n/a"}` });
    }
  }
  if (named.size) {
    lines.push("");
    lines.push("## People the registries name");
    for (const p of [...named.values()].slice(0, 10)) {
      lines.push(
        `- ${p.name}${p.role ? ` — ${p.role}` : ""} (${p._context})`);
    }
  }
  lines.push("");
  lines.push(
    "Machine-composed from the Whimbrel Research archive; registry records " +
    "only, every line checkable at its source. Current leadership, contact " +
    "routes, and deep research on any company are the paid layer: " +
    "https://whimbrelresearch.com");
  return lines.join("\n");
}

// The published files live in CORPUS KV under `site:` keys, uploaded by the
// daily ingest, and the site routes serve those same bytes, so reading them
// here keeps the tools and the site from drifting. They used to be fetched
// over HTTP from FEED_BASE, which broke the day the domain moved onto this
// worker: a Worker's subrequest to its own hostname bypasses the worker and
// dies as a 522, so every feed-backed tool failed while the site stayed up.
async function fetchFeed(env, path) {
  const body = await readSiteFile(env, path);
  if (body === READ_FAILED) {
    throw new Error(
      `${path} could not be read from storage. This is an outage on our ` +
      "side, not missing data; the published files are intact. Retry shortly.");
  }
  if (body === null) {
    throw new Error(
      `${path} has not been published to the worker yet. The daily ingest ` +
      "uploads it.");
  }
  return path.endsWith(".json") ? JSON.parse(body) : body;
}

function attribution() {
  return {
    publisher: "Whimbrel Research",
    website: "https://whimbrelresearch.com",
    data_home: FEED_BASE,
    license: "CC BY 4.0, free to cite with attribution",
    done_for_you:
      "For a handful of medical device engineering firms, Whimbrel does " +
      "all the research: tell us what you want and we research it, and a " +
      "continuous watch on these registries flags new companies that fit " +
      "the firm, all reviewed by a person before it goes out. The first " +
      "month is free: " +
      "https://whimbrelresearch.com · nate@whimbrelresearch.com",
  };
}

// Connect #81 / PR #83 pulse-bridge. who_got_funded is NIH awards only,
// so Breakthrough never appears there. After that smoke, weekly_pulse,
// latest_signals, find_signals, and signal_of_the_day close on the same
// next step: one deep_record on a Breakthrough manufacturer, then
// get_access if there is no key. Do not tell the model to pick a company
// from the NIH list, and do not claim Breakthrough shows up on
// who_got_funded.
const BREAKTHROUGH_HANDOFF =
  "If a Breakthrough manufacturer shows up (FDA marketing authorization), " +
  "run a full company brief (`deep_record`) once on that company for sourced leadership, contact " +
  "routes, and milestones. If you do not have a key yet, call get_access " +
  "for Solo, Practice, or Firm (2 / 8 / 25 company briefs per month).";

// NSF awards and federal contracts often carry a future start date while
// `observed` is already in the past. The published feed sorts by `date`
// descending, so those rows used to lead signal_of_the_day and
// latest_signals. Display order keeps them in the window and puts every
// date on or before UTC today first. Both handlers share these helpers
// so the MCP tools and the /v1 routes cannot drift.
function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

function isoDay(value) {
  const raw = typeof value === "string" ? value.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

function isNotAfterToday(event, today = utcToday()) {
  const date = isoDay(event?.date);
  return date !== "" && date <= today;
}

function orderNewestForDisplay(events, today = utcToday()) {
  const current = [];
  const future = [];
  for (const event of events) {
    const date = isoDay(event?.date);
    if (date && date > today) future.push(event);
    else current.push(event);
  }
  const byDateDesc = (a, b) => {
    const ad = isoDay(a?.date);
    const bd = isoDay(b?.date);
    if (ad === bd) return 0;
    return ad < bd ? 1 : -1;
  };
  const byObservedThenDate = (a, b) => {
    const ao = isoDay(a?.observed);
    const bo = isoDay(b?.observed);
    if (ao !== bo) return ao < bo ? 1 : -1;
    return byDateDesc(a, b);
  };
  current.sort(byDateDesc);
  future.sort(byObservedThenDate);
  return current.concat(future);
}

const toolHandlers = {
  async latest_signals(args, env) {
    const feed = await fetchFeed(env, "signals-latest.json");
    let events = feed.events || [];
    if (args?.kind) events = events.filter((e) => e.kind === args.kind);
    const limit = Math.min(Math.max(Number(args?.limit) || 25, 1), 50);
    const ordered = orderNewestForDisplay(events);
    return {
      dataset: feed.dataset,
      window_days: feed.window_days,
      generated_at: feed.generated_at,
      next_update_utc: feed.next_update_utc,
      returned: Math.min(ordered.length, limit),
      total_in_window: events.length,
      events: ordered.slice(0, limit),
      note: "Newest signals in the current window. " + BREAKTHROUGH_HANDOFF,
      attribution: attribution(),
    };
  },

  async signal_of_the_day(_args, env) {
    const feed = await fetchFeed(env, "signals-latest.json");
    const events = feed.events || [];
    const newest = events.find((event) => isNotAfterToday(event)) || null;
    if (newest) {
      return {
        signal: newest,
        generated_at: feed.generated_at,
        note: "Newest signal in the current window. " + BREAKTHROUGH_HANDOFF,
        attribution: attribution(),
      };
    }
    if (!events.length) {
      return {
        signal: null,
        note: "The feed window is empty right now.",
        attribution: attribution(),
      };
    }
    return {
      signal: null,
      note: "No signal in the current window is dated on or before today.",
      attribution: attribution(),
    };
  },

  async weekly_pulse(_args, env) {
    const feed = await fetchFeed(env, "signals-latest.json");
    // The feed window is 14 days; the pulse stays a 7-day read. PULSE_DAYS
    // is also what window_days reports: the reply used to echo the feed's
    // 14 while counting 7, so the one field naming the window was the one
    // field that was wrong (caught on the September 15 fresh-user walk).
    const PULSE_DAYS = 7;
    const cutoff = Date.now() - PULSE_DAYS * 86400e3;
    const events = (feed.events || []).filter((e) =>
      new Date(e.observed || e.date || 0).getTime() >= cutoff);
    const byKind = {};
    let nihTotal = 0;
    let largest = null;
    for (const event of events) {
      byKind[event.kind] = (byKind[event.kind] || 0) + 1;
      if (event.kind === "nih_award" && typeof event.amount_usd === "number") {
        nihTotal += event.amount_usd;
      }
      if (
        typeof event.amount_usd === "number" &&
        (!largest || event.amount_usd > largest.amount_usd)
      ) {
        largest = event;
      }
    }
    return {
      window_days: PULSE_DAYS,
      generated_at: feed.generated_at,
      events_total: events.length,
      events_by_kind: byKind,
      nih_award_dollars_stated: nihTotal,
      largest_stated_event: largest,
      note: "This week's pulse. " + BREAKTHROUGH_HANDOFF,
      attribution: attribution(),
    };
  },

  async about_the_data(_args, env) {
    const [methodology, llms, stats] = await Promise.all([
      fetchFeed(env, "methodology.md"),
      fetchFeed(env, "llms.txt"),
      fetchFeed(env, "stats.json").catch(() => null),
    ]);
    return {
      methodology,
      overview: llms,
      // stats.json names its scale block "corpus"; this tool presents it
      // as the archive's scale.
      archive: stats?.corpus ?? null,
      trailing_weeks: stats?.trailing_weeks ?? null,
      attribution: attribution(),
    };
  },

  async micro_brief(args, env, request, tenant, operator) {
    const gate = await takeLookup(env, request, tenant?.entitled || operator);
    if (!gate.allowed) return { limited: true, note: CAP_MESSAGE };
    const found = await lookupCompany(env, args?.company);
    if (!found.entry) return { ...found, attribution: attribution() };
    return {
      _text: composeMicroBrief(found.entry),
      _company_stem: found.stem,
    };
  },

  async company_timeline(args, env, request, tenant, operator) {
    const gate = await takeLookup(env, request, tenant?.entitled || operator);
    if (!gate.allowed) return { limited: true, note: CAP_MESSAGE };
    const found = await lookupCompany(env, args?.company);
    if (!found.entry) return { ...found, attribution: attribution() };
    return {
      company: found.entry.name,
      first_tracked: found.entry.first_tracked,
      events: found.entry.events,
      attribution: attribution(),
      _company_stem: found.stem,
    };
  },

  async find_signals(args, env) {
    if (!env.DB) return { error: "Signal store unavailable." };
    const clauses = [];
    const binds = [];
    const KINDS = new Set(["nih_award", "fda_clearance", "fda_pma",
                           "fda_denovo", "fda_breakthrough_auth", "fda_hde",
                           "nsf_award", "federal_contract", "sbir_award",
                           "fda_listing", "fda_recall",
                           "fda_warning_letter", "fda_import_alert",
                           "trial_registration", "funding_filing"]);
    // trial_registration, fda_breakthrough_auth, and fda_hde are
    // searchable across the whole archive here. who_got_funded never
    // accepts them: that tool is money-shaped, and a Breakthrough
    // marketing authorization or HDE approval is not stated money.
    if (args?.kind && KINDS.has(args.kind)) {
      clauses.push("signal_kind = ?"); binds.push(args.kind);
    }
    // signal_date is stored ISO with a time suffix; a date-prefix string
    // compare orders it correctly and drops undated rows (no timing value).
    const since = typeof args?.since === "string" &&
      /^\d{4}-\d{2}-\d{2}/.test(args.since)
        ? args.since.slice(0, 10)
        : defaultSince();
    clauses.push("signal_date >= ?"); binds.push(since);
    if (args?.new_award === true) clauses.push("new_award = 1");
    const PHASES = new Set(["SBIR Phase I", "SBIR Phase II",
                            "STTR Phase I", "STTR Phase II"]);
    if (args?.phase && PHASES.has(args.phase)) {
      clauses.push("award_phase = ?"); binds.push(args.phase);
    }
    if (typeof args?.min_amount_usd === "number") {
      clauses.push("amount_usd >= ?"); binds.push(Math.floor(args.min_amount_usd));
    }
    // Every term ANDed as a bound LIKE against summary+abstract. Values are
    // always bound, never interpolated, so a term cannot alter the query.
    const terms = String(args?.matching || "").trim().toLowerCase()
      .split(/\s+/).filter(Boolean).slice(0, 6);
    for (const term of terms) {
      clauses.push("lower(signal_summary || ' ' || statement) LIKE ?");
      binds.push(`%${term}%`);
    }
    const limit = Math.min(Math.max(Number(args?.limit) || 25, 1), 50);
    const sql = "SELECT " + SIGNAL_COLUMNS + " FROM signal_archive WHERE " +
      clauses.join(" AND ") + " ORDER BY signal_date DESC LIMIT ?";
    binds.push(limit);
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return {
      filters: {
        kind: args?.kind || null, since,
        new_award: args?.new_award === true || null,
        phase: args?.phase || null,
        min_amount_usd: typeof args?.min_amount_usd === "number"
          ? args.min_amount_usd : null,
        matching: terms.join(" ") || null,
      },
      matches: (results || []).length,
      signals: (results || []).map(mapSignalRow),
      note:
        "Signals matching your filters, newest first, from the full archive. " +
        "Every line is checkable at its source. " + BREAKTHROUGH_HANDOFF,
      attribution: attribution(),
    };
  },

  async deep_record(args, env, request, tenant) {
    if (!env.DB) return { error: "Store unavailable." };
    const wanted = normalizeName(args?.company);
    if (!wanted) return { error: "Give me a company name to look up." };
    // Latest version wins; records are keyed by slug but matched on the stored
    // company name. Deep records are few, so a LIKE scan is fine.
    const row = await env.DB
      .prepare(
        "SELECT company_name, version, researched_on, r2_key, core_json FROM " +
        "research_records WHERE lower(company_name) LIKE ?1 " +
        "ORDER BY version DESC LIMIT 1")
      .bind(`%${wanted}%`)
      .first();
    // A stored record is served only while it is fresh. Decided
    // September 15, 2026, by Nate: two unrelated tenants can ask about
    // the same company without knowing of each other, and the second
    // must never silently receive the first's aging artifact. Research
    // from the last few days is shared as a feature - served instantly,
    // no run spent - and anything older re-runs automatically. The
    // `refresh` argument still forces a run at any age.
    const freshDays = Number(env.RESEARCH_FRESH_DAYS) > 0
      ? Number(env.RESEARCH_FRESH_DAYS) : 7;
    const freshFloor = new Date(Date.now() - freshDays * 86400e3)
      .toISOString().slice(0, 10);
    const recordDate = String(
      row?.researched_on || row?.version || "").slice(0, 10);
    const stale = Boolean(row) && (!recordDate || recordDate < freshFloor);
    // Internal only, and absent from the tool schema: the streaming path
    // re-reads the record when a run reports done, and must never be able
    // to start a second run (and charge for it) if the read comes up
    // empty. A row it finds is served whatever its date: the caller just
    // watched a run finish, so the newest version is this one.
    if (!row && args?._no_queue === true) {
      return { not_ready: true,
               note: "No record for that company yet.",
               attribution: attribution() };
    }
    if ((!row || stale || args?.refresh === true)
        && args?._no_queue !== true) {
      // No record, a stale one, or an explicit refresh: this is where the
      // paid tier sells the machine. Queue a research run on the company
      // and tell the caller to ask again shortly.
      const slug = companySlug(args.company);
      const pending = await env.DB
        .prepare(
          "SELECT request_id, status, created_at FROM research_requests " +
          "WHERE company_slug = ?1 AND kind = 'research' AND status IN " +
          "('queued', 'running') ORDER BY created_at DESC LIMIT 1")
        .bind(slug).first();
      if (pending) {
        return {
          queued: true,
          status: pending.status,
          note:
            `Research on "${args.company}" is already ${pending.status} ` +
            `(request ${pending.request_id}, since ${pending.created_at}). ` +
            "A run takes minutes; call deep_record again shortly, or check " +
            "research_status.",
          pending: true,
          request_id: pending.request_id,
          progress: await readProgress(env, pending.request_id),
          attribution: attribution(),
        };
      }
      const used = await monthlyRunsUsed(env, tenant?.tenant?.tenant_id);
      const allowance = await monthlyAllowance(env, tenant);
      if (used >= allowance) {
        return {
          note:
            `This month's research allowance is used up (${used} of ` +
            `${allowance}). It resets on the 1st. ` +
            (stripeConfigured(env)
              ? `To keep going now, call get_access for a ${RUN_PACK.runs}-run ` +
                "pack that adds to this month, or billing_portal to move up " +
                "a plan."
              : "To keep going now, reach nate@whimbrelresearch.com."),
          attribution: attribution(),
        };
      }
      const domain = String(args?.domain || "").trim();
      const run = await queueRun(
        env, tenant, "research",
        { company_name: String(args.company), company_slug: slug, domain },
        RESEARCH_WORKFLOW,
        { client: "corpus", name: String(args.company), domain });
      if (!run.ok) {
        return { error: run.error, attribution: attribution() };
      }
      return {
        queued: true,
        request_id: run.requestId,
        runs_used_this_month: used + 1,
        runs_allowance: allowance,
        ...(stale && !args?.refresh
          ? { previous_record_as_of: recordDate,
              refreshing: `An earlier record from ${recordDate} exists; ` +
                `it is being replaced because it is older than ` +
                `${freshDays} days.` }
          : {}),
        note:
          `Deep research on "${args.company}" is queued on Whimbrel's ` +
          "infrastructure (request " + run.requestId + "). " +
          (run.startedNow
            ? "It started immediately. "
            : "A runner claims it within about five minutes. ") +
          "The run itself takes minutes: the pipeline reads the company's " +
          "site and coverage, verifies every claim against its source, and " +
          "lands the record in the corpus. Call deep_record again shortly, " +
          "or check research_status." +
          (domain ? "" : " No domain was given; the run will resolve it " +
                          "and fails honestly if it cannot."),
        attribution: attribution(),
      };
    }
    let core = {};
    try { core = JSON.parse(row.core_json) || {}; } catch (_) { /* {} */ }
    return {
      company: row.company_name,
      as_of: row.researched_on,
      version: row.version,
      facts: core.company || null,
      people: core.people || [],
      organizations: core.organizations || [],
      partners: core.partners || core.named_collaborators || [],
      evidence: core.evidence || [],
      gaps: core.not_found || [],
      note:
        "Deep research record, current as of the date shown. Verified " +
        "public facts, no opinion on fit; judge that against what the firm " +
        "you are working for actually builds. Every claim is checkable at " +
        "its source.",
      attribution: attribution(),
    };
  },

  async crm_export(args, env) {
    if (!env.DB) return { error: "Store unavailable." };
    const wanted = normalizeName(args?.company);
    if (!wanted) return { error: "Give me a company name to export." };
    const row = await env.DB
      .prepare(
        "SELECT company_name, version, researched_on, core_json FROM " +
        "research_records WHERE lower(company_name) LIKE ?1 " +
        "ORDER BY version DESC LIMIT 1")
      .bind(`%${wanted}%`)
      .first();
    if (!row) {
      return {
        error:
          `No deep-research record exists for "${args.company}" yet. Run ` +
          "deep_record first; the export shapes what the research found " +
          "and never invents a field.",
        attribution: attribution(),
      };
    }
    let core = {};
    try { core = JSON.parse(row.core_json) || {}; } catch (_) { /* {} */ }
    const asOf = row.researched_on || String(row.version).slice(0, 8);
    const out = crmExport(core, { format: String(args?.format || ""), asOf });
    if (out.error) return { ...out, attribution: attribution() };
    return {
      company: row.company_name,
      as_of: asOf,
      ...out,
      note:
        "Save companies_csv and contacts_csv as .csv files for the user, " +
        "hand them the notes document, and follow import_instructions. " +
        "A blank column means the research found nothing to put there; " +
        "nothing is ever invented.",
      attribution: attribution(),
    };
  },

  async research_status(args, env, request, tenant) {
    if (!env.DB) return { error: "Store unavailable." };
    const tid = tenant?.tenant?.tenant_id;
    const wanted = String(args?.request_id || "").trim();
    const rows = wanted
      ? (await env.DB
          .prepare("SELECT * FROM research_requests WHERE request_id = ?1 " +
                   "AND tenant_id = ?2")
          .bind(wanted, tid).all()).results
      : (await env.DB
          .prepare("SELECT * FROM research_requests WHERE tenant_id = ?1 " +
                   "ORDER BY created_at DESC LIMIT 10")
          .bind(tid).all()).results;
    const used = await monthlyRunsUsed(env, tid);
    // Progress is read for every row rather than only the asked-for one: the
    // list is short (ten at most) and "which of my runs is where" is the
    // question this tool exists to answer.
    const withProgress = await Promise.all((rows || []).map(async (r) => ({
      request_id: r.request_id,
      kind: r.kind,
      company: r.company_name || null,
      status: r.status,
      detail: r.detail || null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      progress: await readProgress(env, r.request_id),
    })));
    return {
      requests: withProgress.map((r) => ({
        ...r,
        stage: r.progress.length ? r.progress[r.progress.length - 1].stage
                                 : null,
      })),
      runs_used_this_month: used,
      runs_allowance: await monthlyAllowance(env, tenant),
      plan: planLabel(tenant),
      note: "A done request means deep_record now serves that company's " +
            "record. Failed runs are never charged.",
      attribution: attribution(),
    };
  },

  async get_access(args, env, request, tenant) {
    // Free on purpose: the tool a stranger calls to stop being a stranger
    // cannot itself need a key.
    const url = new URL(request.url);

    // An existing tenant asking for access is topping up, not subscribing:
    // one more plan would be a second subscription on the same key.
    if (args?.run_pack && tenant?.tenant && tenant.entitled) {
      const priceId = env[RUN_PACK.priceVar];
      if (!priceId) {
        return {
          error: "Run packs are not configured on this server yet. Reach " +
            "nate@whimbrelresearch.com.",
          attribution: attribution(),
        };
      }
      const row = await env.DB
        .prepare("SELECT stripe_customer_id FROM tenants WHERE tenant_id = ?1")
        .bind(tenant.tenant.tenant_id).first();
      const pack = await createCheckoutSession(env, checkoutUrls(url), {
        priceId, mode: "payment",
        customerId: row?.stripe_customer_id || undefined,
        metadata: { pack_runs: RUN_PACK.runs },
      });
      if (!pack.ok) return { error: pack.reason, attribution: attribution() };
      return {
        checkout_url: pack.url,
        adds_runs: RUN_PACK.runs,
        note:
          `Pays for ${RUN_PACK.runs} more research runs this calendar ` +
          "month, on top of your plan. Your existing key keeps working; " +
          "nothing to paste. Packs apply to the month you buy them in and " +
          "do not roll over.",
        attribution: attribution(),
      };
    }

    // A stranger gets the plans. One checkout link each, so the choice is
    // made before any card details and the reply says what each one buys.
    const plans = [];
    const failures = [];
    for (const [key, tier] of Object.entries(TIERS)) {
      const priceId = tierPriceId(env, key);
      if (!priceId) { failures.push(key); continue; }
      const session = await createCheckoutSession(
        env, checkoutUrls(url), { priceId, metadata: { tier: key } });
      if (!session.ok) { failures.push(key); continue; }
      plans.push({
        plan: tier.label,
        research_runs_per_month: tier.runs,
        checkout_url: session.url,
      });
    }
    // Until the plan prices exist in Stripe, the pre-retiering single plan
    // is still purchasable and still works, so it is offered rather than
    // telling a stranger with a card that nothing is for sale. Drops out of
    // its own accord once any plan above has a price.
    if (!plans.length && env.STRIPE_PRICE_ID) {
      const legacy = await createCheckoutSession(env, checkoutUrls(url));
      if (legacy.ok) {
        plans.push({
          plan: "Research",
          research_runs_per_month: LEGACY_MONTHLY_RUNS,
          checkout_url: legacy.url,
        });
      }
    }
    if (!plans.length) {
      return {
        error: failures.length
          ? "No research plan is purchasable on this server yet: its Stripe " +
            "prices are unset. Reach nate@whimbrelresearch.com."
          : STRIPE_NOT_CONFIGURED,
        attribution: attribution(),
      };
    }
    return {
      plans,
      note:
        "OAuth Subscribe on the sign-in page hands the token to your app; " +
        "there is nothing to paste. These checkout links are for clients " +
        "that show a key: open a plan's link, pay, and the page shows your " +
        "API key once. Save it and send it as an Authorization Bearer " +
        "header. The plans differ only in how many companies you can " +
        "research a month; everything in the free archive stays free. Run " +
        `out mid-month and a ${RUN_PACK.runs}-run pack is available from ` +
        "this tool with your key.",
      unlocks: TOOLS.filter((tool) => tool.requiresTenant).map((t) => t.name),
      attribution: attribution(),
    };
  },

  async billing_portal(args, env, request, tenant) {
    if (!env.DB) return { error: "Store unavailable." };
    const tenantId = tenant?.tenant?.tenant_id;
    const row = await env.DB
      .prepare("SELECT stripe_customer_id FROM tenants WHERE tenant_id = ?1")
      .bind(tenantId).first();
    if (!row?.stripe_customer_id) {
      return {
        error: "This key was issued directly rather than through Stripe, so " +
          "there is no self-serve portal for it. Reach " +
          "nate@whimbrelresearch.com.",
        attribution: attribution(),
      };
    }
    const url = new URL(request.url);
    const portal = await createPortalSession(
      env, row.stripe_customer_id, `${url.origin}/v1/about`);
    if (!portal.ok) return { error: portal.reason, attribution: attribution() };
    return {
      portal_url: portal.url,
      note: "Card changes, upgrades and cancellation all live here. A " +
        "cancellation takes effect on this server within a minute.",
      attribution: attribution(),
    };
  },

  async who_got_funded(args, env) {
    const feed = await fetchFeed(env, "signals-latest.json");
    // Money-shaped on purpose: stated awards only. trial_registration,
    // fda_breakthrough_auth, and fda_hde ride the same windowed feed so
    // weekly_pulse can count them, and full history is on
    // find_signals / company_timeline, but none of them is a funded-event
    // and must never appear here.
    let events = (feed.events || []).filter((e) => FUNDED_KINDS.has(e.kind));
    if (args?.new_award === true) events = events.filter((e) => e.new_award);
    if (args?.phase) events = events.filter((e) => e.award_phase === args.phase);
    if (typeof args?.min_amount_usd === "number") {
      events = events.filter(
        (e) => typeof e.amount_usd === "number" &&
               e.amount_usd >= args.min_amount_usd);
    }
    return {
      window_days: feed.window_days,
      generated_at: feed.generated_at,
      filters: args || {},
      matches: events.length,
      events,
      note:
        "NIH awards in the current window. Next, ask for this week's " +
        "pulse or newest signals (weekly_pulse or latest_signals). " +
        BREAKTHROUGH_HANDOFF,
      attribution: attribution(),
    };
  },
};

// who_got_funded stays money-shaped. Awards and contracts with stated
// figures belong here; trial_registration, listings, recalls,
// warning letters, import-alert listings, funding_filing,
// fda_breakthrough_auth, and fda_hde do not. A Breakthrough marketing
// authorization or HDE approval is a regulatory event, not stated money.
// Creativity pulse rule: funded / Breakthrough / clearances / HDE
// stay the default weekly habit; risk kinds never join this set. NIH
// phase / new_award flags are NIH-only, so this set is NIH awards today.
// sbir_award is amount-gated at ingest and is eligible to join this
// set after live weekly volume. Public who_got_funded copy stays
// NIH-only until then; do not advertise other-agency funding here.
const FUNDED_KINDS = new Set(["nih_award"]);

// Only these kinds ever become part of a telemetry key. args.kind is
// caller-supplied; interpolating it raw let one IP mint unbounded permanent
// KV keys (denial-of-wallet). An unknown value buckets to a single key.
const TELEMETRY_KINDS = new Set(["nih_award", "fda_clearance", "fda_pma",
                                "trial_registration"]);

function recordUsage(env, ctx, tool, args, operator) {
  if (!env.USAGE) return;
  const day = new Date().toISOString().slice(0, 10);
  // Operator traffic counts under self: so the unprefixed counters stay
  // strangers-only; the daily snapshot dumps both families.
  const prefix = operator ? "self:" : "";
  const keys = [`${prefix}calls:${day}:${tool}`];
  if (tool === "latest_signals" && args?.kind) {
    const kind = TELEMETRY_KINDS.has(args.kind) ? args.kind : "other";
    keys.push(`${prefix}calls:${day}:${tool}:${kind}`);
  }
  ctx.waitUntil(
    (async () => {
      try {
        for (const key of keys) {
          const current = Number(await env.USAGE.get(key)) || 0;
          await env.USAGE.put(key, String(current + 1), {
            expirationTtl: 60 * 60 * 24 * 400,
          });
        }
      } catch (_) {
        /* telemetry must never break a response */
      }
    })()
  );
}

function recordConnect(env, ctx, request, params, operator) {
  ctx.waitUntil(
    (async () => {
      try {
        const day = new Date().toISOString().slice(0, 10);
        const caller = await hashCaller(request);
        const client = String(params?.clientInfo?.name || "unknown")
          .toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 40);
        console.log(JSON.stringify({ event: "connect", caller, client, operator: Boolean(operator) }));
        if (!env.USAGE) return;
        // Operator handshakes get one self: counter and stay out of the
        // anonymous all/caller/client keys, so those count only strangers.
        const keys = operator ? [
          `self:connect:${day}`,
        ] : [
          `connect:${day}:all`,
          `connect:${day}:caller:${caller}`,
          `connect:${day}:client:${client}`,
        ];
        for (const key of keys) {
          const current = Number(await env.USAGE.get(key)) || 0;
          await env.USAGE.put(key, String(current + 1), {
            expirationTtl: 60 * 60 * 24 * 400,
          });
        }
      } catch (_) {
        /* telemetry must never break a response */
      }
    })()
  );
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleMessage(message, env, ctx, request, operator) {
  const { id, method, params } = message;

  if (method === "initialize") {
    recordConnect(env, ctx, request, params, operator);
    const requested = params?.protocolVersion;
    const supported = ["2025-06-18", "2025-03-26", "2024-11-05"];
    return rpcResult(id, {
      protocolVersion: supported.includes(requested) ? requested : "2025-06-18",
      capabilities: {
        tools: { listChanged: false },
        prompts: { listChanged: false },
      },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") {
    // requiresTenant is ours, not the protocol's: it decides the paid gate
    // in tools/call. Stripping it keeps the wire to what a client can use.
    const tools = TOOLS.map(({ requiresTenant, ...tool }) => tool);
    return rpcResult(id, { tools });
  }
  if (method === "prompts/list") return rpcResult(id, { prompts: PROMPTS });
  if (method === "prompts/get") {
    const prompt = PROMPTS.find((p) => p.name === params?.name);
    if (!prompt) return rpcError(id, -32602, `Unknown prompt: ${params?.name}`);
    return rpcResult(id, {
      description: prompt.description,
      messages: promptMessages(prompt.name, params?.arguments || {}),
    });
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    const handler = toolHandlers[name];
    if (!handler) return rpcError(id, -32602, `Unknown tool: ${name}`);
    const tool = TOOLS.find((t) => t.name === name);
    // The paid gate. A presented key must resolve to a tenant; an unknown key
    // is refused rather than silently downgraded, so a client with a typo'd or
    // expired key learns why instead of quietly getting free-tier behavior.
    let tenant = await resolveTenant(env, request);
    if (tenant?.outage) {
      // The token store is unreadable, so the bearer cannot be checked.
      // A free tool needs no checking - anonymous confers the same thing -
      // so it runs rather than failing for our outage; only the tools
      // where the token would actually change the answer report it.
      if (tool?.requiresTenant) {
        return rpcResult(id, {
          content: [{ type: "text", text:
            "Our storage layer is briefly unavailable, so your access " +
            "token could not be checked. This is an outage on our side, " +
            "not a problem with your token. Retry shortly." }],
          isError: true,
        });
      }
      tenant = null;
    }
    if (tenant?.invalid) {
      return rpcResult(id, {
        content: [{ type: "text", text: invalidKeyMessage(env) }],
        isError: true,
      });
    }
    if (tool?.requiresTenant && !tenant?.entitled) {
      return rpcResult(id, {
        content: [{ type: "text", text: authRequiredMessage(env) }],
        isError: true,
      });
    }
    // The operator lane is Nate himself, so his demos never hit free-tier
    // caps; it does NOT entitle tenant-gated tools (that stays key-based).
    const within = await takeRequest(env, request, tenant?.entitled || operator);
    if (!within.allowed) {
      return rpcResult(id, {
        content: [{ type: "text", text:
          "Daily request limit reached for this caller. The free feed resets " +
          "at 00:00 UTC. " + CAP_MESSAGE }],
        isError: true,
      });
    }
    recordUsage(env, ctx, name, args, operator);
    if (tenant?.entitled) recordTenantUsage(env, ctx, tenant.tenant.tenant_id, name);
    try {
      const result = await handler(args, env, request, tenant, operator);
      if (result && result._company_stem && env.USAGE) {
        const day = new Date().toISOString().slice(0, 10);
        const key = `${operator ? "self:" : ""}company:${day}:${result._company_stem}`;
        ctx.waitUntil((async () => {
          try {
            const current = Number(await env.USAGE.get(key)) || 0;
            await env.USAGE.put(key, String(current + 1),
                                { expirationTtl: 60 * 60 * 24 * 400 });
          } catch (_) { /* telemetry never breaks a response */ }
        })());
        delete result._company_stem;
      }
      const text = result && typeof result._text === "string"
        ? result._text
        : JSON.stringify(result, null, 1);
      return rpcResult(id, {
        content: [{ type: "text", text }],
      });
    } catch (error) {
      return rpcResult(id, {
        content: [{ type: "text", text: `Tool failed: ${error.message}` }],
        isError: true,
      });
    }
  }
  if (typeof method === "string" && method.startsWith("notifications/")) {
    return null; // notifications get no response body
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, X-PAYMENT",
  "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE",
};

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

// ---- the public HTTP data API, paid per call over x402 ----
//
// Design of record: docs/x402-http-api.md. Same data as the MCP free tier,
// same handlers, different door: MCP is for people who connect a client and
// stay, this is for agents that arrive at a URL once and pay by the call.
// Every route below reuses its MCP tool handler, so the two surfaces can
// never drift apart.
//
// `tier` picks the configured price. `tool` names the handler. Company
// routes carry the archive depth and cost more than a feed read.

const API_ROUTES = [
  { path: "/v1/signals/latest", tool: "latest_signals", tier: "feed",
    name: "signals-latest",
    description: "US medtech buying signals observed in the last 14 days: " +
      "NIH and NSF awards, federal medical R&D contracts, FDA 510(k) " +
      "clearances, PMA approvals, De Novo grants, Breakthrough marketing " +
      "authorizations, HDE approvals, and ClinicalTrials.gov " +
      "device trial registrations, with the people each registry names. " +
      "Query: kind, limit.",
    params: ["kind", "limit"] },
  { path: "/v1/signals/search", tool: "find_signals", tier: "feed",
    name: "signals-search",
    description: "Search the full multi-year signal archive, including " +
      "ClinicalTrials.gov device trial registrations, Breakthrough " +
      "marketing authorizations, and HDE approvals. Query: kind, " +
      "since, matching, min_amount_usd, phase, new_award, limit.",
    params: ["kind", "since", "matching", "min_amount_usd", "phase",
             "new_award", "limit"] },
  { path: "/v1/signals/funded", tool: "who_got_funded", tier: "feed",
    name: "signals-funded",
    description: "The current window filtered for NIH awards. Query: " +
      "new_award, phase, min_amount_usd.",
    params: ["new_award", "phase", "min_amount_usd"] },
  { path: "/v1/signals/today", tool: "signal_of_the_day", tier: "feed",
    name: "signal-of-the-day",
    description: "The single newest signal on the public record.",
    params: [] },
  { path: "/v1/pulse", tool: "weekly_pulse", tier: "feed",
    name: "weekly-pulse",
    description: "Seven-day aggregates: counts by kind including " +
      "ClinicalTrials.gov device trial registrations, Breakthrough " +
      "marketing authorizations, and HDE approvals, stated NIH dollars, " +
      "largest single event.",
    params: [] },
];

const COMPANY_TIMELINE_ROUTE = {
  path: "/v1/company/{company}", tool: "company_timeline", tier: "company",
  name: "company-timeline",
  description: "Every registry event the archive holds for one company, " +
    "newest first, including the full ClinicalTrials.gov device trial " +
    "registration history, Breakthrough marketing authorizations, and " +
    "HDE approvals, " +
    "with source links and the people each record names.",
  params: [] };

const COMPANY_BRIEF_ROUTE = {
  path: "/v1/company/{company}/brief", tool: "micro_brief", tier: "company",
  name: "company-brief", mimeType: "text/markdown",
  description: "A composed, sourced mini-dossier on one company: funding, " +
    "regulatory, ClinicalTrials.gov device trial registrations, patents, " +
    "filings, and the people the registries name.",
  params: [] };

const NUMERIC_PARAMS = new Set(["limit", "min_amount_usd"]);
const BOOLEAN_PARAMS = new Set(["new_award"]);

function matchApiRoute(pathname) {
  const clean = pathname.replace(/\/+$/, "") || "/";
  const fixed = API_ROUTES.find((route) => route.path === clean);
  if (fixed) return { route: fixed, args: {} };
  const brief = clean.match(/^\/v1\/company\/([^/]+)\/brief$/);
  if (brief) {
    return { route: COMPANY_BRIEF_ROUTE,
             args: { company: decodeURIComponent(brief[1]) } };
  }
  const timeline = clean.match(/^\/v1\/company\/([^/]+)$/);
  if (timeline) {
    return { route: COMPANY_TIMELINE_ROUTE,
             args: { company: decodeURIComponent(timeline[1]) } };
  }
  return null;
}

function argsFromQuery(url, base) {
  const args = { ...base };
  for (const [key, value] of url.searchParams) {
    if (NUMERIC_PARAMS.has(key)) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) args[key] = parsed;
    } else if (BOOLEAN_PARAMS.has(key)) {
      args[key] = value === "true" || value === "1";
    } else {
      args[key] = value;
    }
  }
  return args;
}

// x402 traffic counts under its own key family so the daily usage snapshot
// separates paid HTTP calls from free MCP tool calls without any new
// plumbing: the snapshot dumps every counter it finds.
function recordApiUsage(env, ctx, route, outcome) {
  if (!env.USAGE) return;
  const day = new Date().toISOString().slice(0, 10);
  const keys = [`x402:${day}:${route}`, `x402:${day}:${outcome}`];
  ctx.waitUntil((async () => {
    try {
      for (const key of keys) {
        const current = Number(await env.USAGE.get(key)) || 0;
        await env.USAGE.put(key, String(current + 1),
                            { expirationTtl: 60 * 60 * 24 * 400 });
      }
    } catch (_) { /* telemetry must never break a response */ }
  })());
}

function wellKnownX402(env, url) {
  const describe = (route) => ({
    path: route.path,
    method: "GET",
    price_usdc: priceUsd(env, route.tier),
    description: route.description,
    query: route.params,
    mime_type: route.mimeType || "application/json",
  });
  return {
    x402Version: X402_VERSION,
    publisher: "Whimbrel Research",
    website: "https://whimbrelresearch.com",
    contact: "nate@whimbrelresearch.com",
    dataset: "US medtech buying signals: NIH and NSF SBIR/STTR awards, " +
      "federal medical R&D contracts, FDA 510(k) clearances, PMA approvals, " +
      "De Novo grants, Breakthrough marketing authorizations, HDE " +
      "approvals, and " +
      "ClinicalTrials.gov device trial registrations, " +
      "with the people each registry itself names. Refreshed daily; every " +
      "event carries the public source it came from.",
    payment: {
      enabled: isEnabled(env),
      network: env.X402_NETWORK || "base",
      asset: env.X402_ASSET || USDC_BASE,
      pay_to: env.X402_PAY_TO || null,
      note: isEnabled(env) ? undefined
        : "No receiving address is configured yet, so these endpoints " +
          "currently serve without charge.",
    },
    endpoints: [...API_ROUTES, COMPANY_TIMELINE_ROUTE, COMPANY_BRIEF_ROUTE,
                ...SITE_PAID_ROUTES].map(describe),
    free_endpoints: [
      { path: "/v1/about", description: "How the data is collected, dated " +
        "and licensed, and what it excludes. Free: you should be able to " +
        "read the terms before buying the data." },
      { path: "/.well-known/x402", description: "This document." },
      { path: "/health", description: "Liveness." },
      ...Object.keys(SITE_FREE_FILES)
        .filter((path) => path !== "/index.html")
        .map((path) => ({
          path,
          description: "Published data-site file: documentation, manifest " +
            "or aggregates. Free, and stays free.",
        })),
    ],
    license: "CC BY 4.0, free to cite with attribution",
    deep_research: "Verified leadership, contact routes and full research " +
      "records on any company are the paid research tier, over MCP: " +
      "nate@whimbrelresearch.com",
    self: url.origin + "/.well-known/x402",
  };
}

// ---- billing: Stripe Checkout in, webhook out ----
//
// The decision is docs/migration-architecture.md: Checkout for signup, this
// webhook flips status and paid_through in D1, and Stripe's Customer Portal
// owns upgrades, cancels and card changes so there is no billing UI here.
//
// The key is minted here, on checkout.session.completed, and the plaintext
// lives in KV under the checkout session id for one claim only. That is the
// whole delivery mechanism: the Checkout success URL points at /v1/key/<id>,
// the customer's browser lands on it once, and the key is handed over and
// deleted. Only its SHA-256 was ever written to the tenants row, so a second
// visit cannot re-show it and neither can we.

const KEY_CLAIM_TTL = 60 * 60 * 24;      // a day to land on the success page
const EVENT_SEEN_TTL = 60 * 60 * 24 * 7; // Stripe retries for up to 3 days

function mintApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return "wbr_" + btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function tenantIdFor(customerId) {
  // Stable, derived from Stripe's own id, so a customer who buys twice
  // updates one row instead of growing a second identity.
  return "t_" + String(customerId || "").replace(/[^a-zA-Z0-9]/g, "").slice(-16);
}

// A billing change that took a minute to bite would be fine; one that takes a
// minute to bite AFTER a cancellation is a minute of free paid-tier access, so
// the 60s entitlement cache is dropped explicitly on every write.
async function dropTenantCache(env, apiKeyHash) {
  if (!env.USAGE || !apiKeyHash) return;
  try { await env.USAGE.delete(`tenant:${apiKeyHash}`); } catch (_) { /* best effort */ }
}

async function tenantByCustomer(env, customerId) {
  if (!customerId) return null;
  return env.DB
    .prepare("SELECT tenant_id, api_key_hash, tier FROM tenants WHERE " +
             "stripe_customer_id = ?1")
    .bind(customerId).first();
}

async function createTenantFromCheckout(env, change) {
  const existing = await tenantByCustomer(env, change.customerId);
  const now = new Date().toISOString();

  // Stripe tells us the real period end on the subscription; the bootstrap
  // date in the change is one day, deliberately short. Reading it now means a
  // new customer is correctly entitled immediately rather than for a day.
  let paidThrough = change.paidThrough;
  const subscription = await fetchSubscription(env, change.subscriptionId);
  if (subscription.ok) {
    paidThrough = isoDate(subscriptionPeriodEnd(subscription.body))
      || paidThrough;
  }

  if (existing) {
    // A returning customer resubscribing: their key still works, so do not
    // mint a second one and do not hand them a claim they did not ask for.
    const returningTier = TIERS[String(change.tier || "").toLowerCase()]
      ? String(change.tier).toLowerCase() : existing.tier;
    await env.DB
      .prepare("UPDATE tenants SET status = 'active', tier = ?1, " +
               "paid_through = ?2, updated_at = ?3 WHERE tenant_id = ?4")
      .bind(returningTier, paidThrough, now, existing.tenant_id).run();
    await dropTenantCache(env, existing.api_key_hash);
    return { tenantId: existing.tenant_id, minted: false };
  }

  const key = mintApiKey();
  const keyHash = await sha256hex(key);
  const tenantId = tenantIdFor(change.customerId);
  // The plan the checkout was opened for decides the allowance. An unknown
  // or absent tier falls back to the configured default rather than to no
  // allowance at all: somebody who has paid must never be left unable to
  // research because a price id moved.
  const tier = TIERS[String(change.tier || "").toLowerCase()]
    ? String(change.tier).toLowerCase()
    : (env.STRIPE_TIER || "standard");
  await env.DB
    .prepare("INSERT INTO tenants (tenant_id, name, domain, api_key_hash, " +
             "tier, status, paid_through, stripe_customer_id, created_at, " +
             "updated_at) VALUES (?1, ?2, '', ?3, ?4, 'active', ?5, ?6, ?7, ?7) " +
             "ON CONFLICT(tenant_id) DO UPDATE SET status = 'active', " +
             "tier = excluded.tier, " +
             "paid_through = excluded.paid_through, updated_at = excluded.updated_at")
    .bind(tenantId, change.name || change.email || tenantId, keyHash,
          tier, paidThrough, change.customerId, now)
    .run();

  if (env.USAGE && change.sessionId) {
    await env.USAGE.put(`claim:${change.sessionId}`, key,
                        { expirationTtl: KEY_CLAIM_TTL });
  }
  return { tenantId, minted: true };
}

// A run-pack purchase. Grants runs for the month it was bought in and
// touches nothing about entitlement: a pack is not access, and a customer
// whose subscription lapses does not get one month of free research out of
// a pack they bought.
async function recordRunPack(env, change, eventId) {
  const existing = await tenantByCustomer(env, change.customerId);
  if (!existing) return { pack: false, reason: "no tenant for that customer" };
  const runs = Number(change.packRuns) > 0
    ? Math.floor(Number(change.packRuns)) : RUN_PACK.runs;
  const packId = `pack_${(change.sessionId || eventId || "").slice(-24)}`;
  await env.DB
    .prepare("INSERT INTO run_packs (pack_id, tenant_id, runs, " +
             "stripe_event, created_at) VALUES (?1, ?2, ?3, ?4, ?5) " +
             "ON CONFLICT(pack_id) DO NOTHING")
    .bind(packId, existing.tenant_id, runs, String(eventId || ""),
          new Date().toISOString()).run();
  await dropTenantCache(env, existing.api_key_hash);
  return { pack: true, tenantId: existing.tenant_id, runs };
}

async function updateTenantFromEvent(env, change) {
  const existing = await tenantByCustomer(env, change.customerId);
  if (!existing) return { updated: false, reason: "no tenant for that customer" };
  const now = new Date().toISOString();
  // An upgrade or downgrade made in the Customer Portal reaches us as a
  // subscription event carrying the new price and none of our metadata, so
  // the plan is resolved from the price. A price we do not recognize leaves
  // the plan alone rather than guessing at it.
  const tier = tierForPriceId(env, change.priceId) || existing.tier;
  if (tier !== existing.tier) {
    await env.DB
      .prepare("UPDATE tenants SET tier = ?1, updated_at = ?2 " +
               "WHERE tenant_id = ?3")
      .bind(tier, now, existing.tenant_id).run();
  }
  if (change.paidThrough) {
    await env.DB
      .prepare("UPDATE tenants SET status = ?1, paid_through = ?2, " +
               "updated_at = ?3 WHERE tenant_id = ?4")
      .bind(change.status, change.paidThrough, now, existing.tenant_id).run();
  } else {
    // payment_failed carries no new period: mark it, keep the date it had, so
    // a recovered payment restores the customer rather than re-dating them.
    await env.DB
      .prepare("UPDATE tenants SET status = ?1, updated_at = ?2 " +
               "WHERE tenant_id = ?3")
      .bind(change.status, now, existing.tenant_id).run();
  }
  await dropTenantCache(env, existing.api_key_hash);
  return { updated: true, tenantId: existing.tenant_id };
}

// ---- streaming a run as it happens ----
//
// "Queued, ask again in a few minutes" is a bad answer for the one thing a
// tenant is paying for. MCP's Streamable HTTP transport lets a POST answer
// with an event stream instead of a single JSON body, so when a client asks
// for progress (by sending a progressToken, which is how the protocol says
// "tell me as you go") deep_record holds the call open, forwards each stage
// the workflow reports, and finishes by returning the record itself. One
// call, movement the whole way, the answer at the end.
//
// Clients that do not ask for progress are unaffected: they get the same
// single JSON reply as before, and research_status still carries the stages
// for anyone who prefers to poll.

const DEFAULT_STREAM_POLL_MS = 2000;
const DEFAULT_STREAM_MAX_SECONDS = 540;  // nine minutes; a run is minutes

function streamPollMs(env) {
  const configured = Number(env.RESEARCH_STREAM_POLL_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured : DEFAULT_STREAM_POLL_MS;
}

function streamMaxMs(env) {
  const configured = Number(env.RESEARCH_STREAM_MAX_SECONDS);
  return (Number.isFinite(configured) && configured > 0
    ? configured : DEFAULT_STREAM_MAX_SECONDS) * 1000;
}

function sseEvent(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function progressNote(token, step, message) {
  return {
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken: token, progress: step, message },
  };
}

function toolResult(id, value) {
  return {
    jsonrpc: "2.0", id,
    result: { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] },
  };
}

/**
 * Returns a streaming Response when the caller asked for progress on a run
 * that is actually in flight, and null otherwise so the normal JSON path
 * takes over. Never throws into the request path: a streaming failure
 * degrades to the reply the caller would have received anyway.
 */
async function streamRunProgress(message, env, ctx, request, first) {
  const token = message?.params?._meta?.progressToken;
  if (token === undefined || token === null) return null;
  if (message?.params?.name !== "deep_record") return null;

  let payload;
  try {
    payload = JSON.parse(first?.result?.content?.[0]?.text || "");
  } catch (_) {
    return null;
  }
  const requestId = payload?.request_id;
  if (!requestId || !(payload.queued || payload.pending)) return null;

  const tenant = await resolveTenant(env, request);
  const company = message.params?.arguments?.company;
  const deadline = Date.now() + streamMaxMs(env);
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (payloadObject) =>
    writer.write(encoder.encode(sseEvent(payloadObject)));

  const pump = async () => {
    let step = 0;
    let seen = 0;
    // A run's stages are sparse: minutes can pass inside "researching"
    // with nothing new to forward, and a silent stream looks dead to a
    // client with a per-call timeout (Claude Code gave up at 60s on the
    // September 15 walk while the run was fine). MCP clients reset their
    // timeout on progress, so a heartbeat goes out whenever the quiet
    // stretch reaches this long.
    const HEARTBEAT_MS = 15000;
    const started = Date.now();
    let lastSent = Date.now();
    const beat = async (note) => {
      await send(progressNote(token, ++step, note));
      lastSent = Date.now();
    };
    try {
      await beat(payload.note);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, streamPollMs(env)));
        const stages = await readProgress(env, requestId);
        for (const stage of stages.slice(seen)) {
          await beat(
            stage.detail ? `${stage.stage}: ${stage.detail}` : stage.stage);
        }
        seen = stages.length;
        if (Date.now() - lastSent >= HEARTBEAT_MS) {
          const elapsed = Math.round((Date.now() - started) / 1000);
          await beat(`still running (${elapsed}s elapsed)`);
        }

        const state = await requestState(env, requestId);
        if (state?.status === "done") {
          const record = await toolHandlers.deep_record(
            { company, _no_queue: true }, env, request, tenant);
          await send(toolResult(message.id, record));
          return;
        }
        if (state?.status === "failed") {
          await send(toolResult(message.id, {
            error: `The research run did not complete: ${
              state.detail || "no reason recorded"}. A failed run is never ` +
              "charged against your allowance.",
            request_id: requestId,
            attribution: attribution(),
          }));
          return;
        }
      }
      // Out of time rather than out of run: hand back what is true, with the
      // request id, so the caller can keep watching through research_status
      // instead of being told nothing happened.
      await send(toolResult(message.id, {
        ...payload,
        note: `Still running after ${Math.round(streamMaxMs(env) / 1000)}s. ` +
          "The run continues; check research_status with request " +
          `${requestId}, or call deep_record again shortly.`,
      }));
    } catch (error) {
      try {
        await send(toolResult(message.id, {
          error: `Progress streaming stopped: ${error.message}. The run is ` +
            "unaffected; check research_status with request " + requestId + ".",
          request_id: requestId,
        }));
      } catch (_) { /* the client is gone; nothing left to tell it */ }
    } finally {
      try { await writer.close(); } catch (_) { /* already closed */ }
    }
  };

  ctx.waitUntil(pump());
  return new Response(readable, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

async function handleStripeWebhook(request, env) {
  if (!stripeConfigured(env)) {
    return Response.json({ error: STRIPE_NOT_CONFIGURED }, { status: 503 });
  }
  if (!env.DB) return Response.json({ error: "Store unavailable." }, { status: 503 });

  // The signature is over the exact bytes, so the body is read as text and
  // never round-tripped through JSON before verifying.
  const raw = await request.text();
  const verified = await verifyWebhook(
    env, raw, request.headers.get("Stripe-Signature"));
  if (!verified.ok) {
    return Response.json({ error: `Webhook rejected: ${verified.reason}` },
                         { status: 400 });
  }

  const event = verified.event;
  // Stripe retries until it gets a 2xx, so the same event arrives more than
  // once as a matter of course. Minting a second key for a retry would be a
  // second identity for one customer.
  const seenKey = `stripe:event:${event.id}`;
  if (env.USAGE && event.id) {
    if (await env.USAGE.get(seenKey)) return Response.json({ received: true, duplicate: true });
  }

  const change = applyEvent(event);
  let outcome = { ignored: event.type };
  if (change?.kind === "new") outcome = await createTenantFromCheckout(env, change);
  else if (change?.kind === "pack") outcome = await recordRunPack(env, change, event.id);
  else if (change?.kind === "update") outcome = await updateTenantFromEvent(env, change);

  if (env.USAGE && event.id) {
    await env.USAGE.put(seenKey, "1", { expirationTtl: EVENT_SEEN_TTL });
  }
  return Response.json({ received: true, ...outcome });
}

// The landing page after a website checkout. Humans get a branded page
// with the key, a copy button, and per-client connect steps; anything not
// asking for HTML gets the JSON it always got. Either way the claim is
// consumed on first read: the key is shown once and only its hash is
// stored anywhere.
async function claimKey(env, request, url, sessionId) {
  const wantsHtml =
    (request.headers.get("Accept") || "").includes("text/html");
  if (!env.USAGE) return Response.json({ error: "Store unavailable." }, { status: 503 });
  const key = await env.USAGE.get(`claim:${sessionId}`);
  if (!key) {
    const gone = "No key waiting for that checkout session. A key can be " +
      "claimed once; if this page was already opened, the key is gone " +
      "from here and only its hash was ever stored. Reach " +
      "nate@whimbrelresearch.com to have it rotated.";
    if (wantsHtml) {
      return new Response(
        (await brandedPage("Whimbrel Research: key already claimed",
          `<h1>This key was already collected</h1>
<p class="note">${gone}</p>
<p class="note">Install steps:
<a href="${CONNECT_PAGE}">whimbrelresearch.com/connect/</a></p>`).text()),
        { status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return Response.json({ error: gone }, { status: 404 });
  }
  await env.USAGE.delete(`claim:${sessionId}`);
  if (!wantsHtml) {
    return Response.json({
      api_key: key,
      use_it: "Clients that do not use OAuth: send it as an Authorization: " +
        "Bearer header. OAuth Subscribe hands the token to the app with " +
        "nothing to paste.",
      warning: "Shown once. It is not stored in plaintext anywhere, " +
        "including here, so save it now.",
    });
  }
  return brandedPage("Your Whimbrel key", `
<h1>You're in. Here is your key.</h1>
<div class="card">
<p style="font-family:ui-monospace,Menlo,monospace;font-size:0.95rem;
word-break:break-all;background:#e7f0ec;border-radius:8px;
padding:0.7rem 0.8rem" id="key">${key}</p>
<button type="button"
 onclick="navigator.clipboard.writeText(document.getElementById('key').textContent.trim());this.textContent='Copied'">
Copy key</button>
<p class="note">Shown once. It is not stored anywhere, including here,
so keep it somewhere safe now. This is the display-key path: paste it
as an Authorization Bearer header in clients that ask for one. If you
subscribed from the OAuth sign-in page inside your app, the token was
already handed over and you do not need to paste anything.</p>
</div>
<h1 style="font-size:1.1rem">Connect your AI</h1>
<div class="card">
<p><strong>Claude app</strong> (web, desktop, mobile): Settings →
Connectors → Add custom connector → paste
<code style="word-break:break-all">${url.origin}</code> → click
<strong>Connect</strong> → choose "Connect with my key" and paste the
key. After that the app remembers; the key stays in your drawer.
OAuth Subscribe on that same page hands the token to the app with
nothing to paste.</p>
</div>
<div class="card">
<p><strong>Claude Code</strong>:</p>
<p style="font-family:ui-monospace,Menlo,monospace;font-size:0.82rem;
word-break:break-all;background:#0f4942;color:#e9f4f1;border-radius:8px;
padding:0.7rem 0.8rem">claude mcp add --transport http whimbrel
${url.origin} --header "Authorization: Bearer &lt;your key&gt;"</p>
</div>
<div class="card">
<p><strong>Cursor, VS Code, and other MCP clients</strong>: add the URL
above as an HTTP server with an <code>Authorization: Bearer</code>
header carrying the key.</p>
</div>
<p class="note">Then ask your AI for a full company brief on any company.
Card changes and cancellation: ask it for billing_portal. Install steps:
<a href="${CONNECT_PAGE}">whimbrelresearch.com/connect/</a></p>`);
}

function checkoutUrls(url) {
  return {
    successUrl: `${url.origin}/v1/key/{CHECKOUT_SESSION_ID}`,
    cancelUrl: `${url.origin}/v1/about`,
  };
}

// ---- the published data site, served from the worker ----
//
// data.whimbrelresearch.com is static files on GitHub Pages, which can never
// be x402-gated. Setting a receiving address would start charging on /v1
// while the same events stayed free one link away, in the same JSON, from a
// host advertised in llms.txt. Two surfaces for one dataset and only one
// switch is not a paywall.
//
// So the daily publish now also uploads each generated file to CORPUS KV
// under site:<name>, and the worker serves them at the paths the data site
// uses. Nothing is regenerated here: the bytes are the ones publish_data.py
// wrote, so the two surfaces cannot drift by construction. After the DNS
// cutover the worker IS the data site and one switch gates every copy.
//
// Discovery and documentation stay free forever, exactly as on /v1: a reader
// has to be able to find the catalogue and read the licence before deciding
// to buy, and crawlers that only read those stay welcome. stats.json is free
// too because it publishes aggregates rather than events, and it is what a
// visitor checks the homepage's numbers against. /.well-known/mcp.json is
// free because it is the machine-discovery card. Daily ingest uploads
// publish_data.py's mcp.json to CORPUS KV as site:mcp.json; SITE_FREE_FILES
// maps the well-known paths onto those bytes, the same way llms.txt and
// index.html are served. The worker does not generate a different body.
// /.well-known/glama.json is the Glama ownership claim. The bytes are
// whimbrel-mcp/site-static/glama.json; publish copies them and daily
// ingest uploads CORPUS KV site:glama.json. The worker does not rewrite
// that body either.

const SITE_FREE_FILES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.json": { file: "index.json", type: "application/json" },
  "/llms.txt": { file: "llms.txt", type: "text/plain; charset=utf-8" },
  "/methodology.md": { file: "methodology.md", type: "text/markdown; charset=utf-8" },
  "/robots.txt": { file: "robots.txt", type: "text/plain; charset=utf-8" },
  "/sitemap.xml": { file: "sitemap.xml", type: "application/xml" },
  "/stats.json": { file: "stats.json", type: "application/json" },
  "/.well-known/mcp.json": { file: "mcp.json", type: "application/json" },
  "/.well-known/mcp/server-card.json": { file: "mcp.json", type: "application/json" },
  "/.well-known/glama.json": { file: "glama.json", type: "application/json" },
};

// The one published file that is the data itself rather than a description of
// it, so it is priced like the /v1 feed routes it duplicates.
const SITE_PAID_ROUTES = [
  { path: "/signals-latest.json", file: "signals-latest.json", tier: "feed",
    name: "site-signals-latest", mimeType: "application/json",
    description: "The published rolling feed file: the last 14 days of " +
      "signals as one JSON document, byte-identical to the file the data " +
      "site serves. Same events as /v1/signals/latest, whole-file rather " +
      "than queried.",
    params: [] },
  { path: "/signals-archive.json", file: "signals-archive.json",
    tier: "archive",
    name: "site-signals-archive", mimeType: "application/json",
    description: "The complete archive as one JSON document: every " +
      "publicly visible signal back to the seed, same event schema as " +
      "signals-latest.json. The bulk edition of what /v1/signals/search " +
      "serves a query at a time. Refreshed daily.",
    params: [] },
];

function matchSiteFile(path) {
  const free = SITE_FREE_FILES[path];
  if (free) return { free: true, ...free };
  const paid = SITE_PAID_ROUTES.find((route) => route.path === path);
  return paid ? { free: false, route: paid, ...paid } : null;
}

// Site images (the sample-brief pages, the homepage illustration) ride in
// KV beside the site files, uploaded by the same daily publish. Free and
// long-cached: they are referenced from the homepage and the sample pages,
// and an image behind a paywall would just be a broken layout. Before the
// DNS cutover GitHub Pages serves them; after it, this does.
const ASSET_TYPES = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  svg: "image/svg+xml", webp: "image/webp", gif: "image/gif",
  ico: "image/x-icon", html: "text/html; charset=utf-8",
};

async function serveSiteAsset(env, path) {
  const match = path.match(/^\/assets\/([A-Za-z0-9][A-Za-z0-9._-]*)$/);
  if (!match) return null;
  const type = ASSET_TYPES[match[1].split(".").pop().toLowerCase()];
  if (!type || !env.CORPUS) return null;
  let body = null;
  try {
    body = await env.CORPUS.get(
      `site-asset:${match[1]}`,
      { type: "arrayBuffer", cacheTtl: 86400 });
  } catch (_) {
    return storageUnavailable();
  }
  if (body === null) {
    return Response.json({ error: SITE_NOT_PUBLISHED },
                         { status: 404, headers: CORS_HEADERS });
  }
  return new Response(body, {
    headers: { ...CORS_HEADERS, "Content-Type": type,
               "Cache-Control": "public, max-age=86400" },
  });
}

// The published files change once a day, when daily-ingest uploads them, so
// a read may be served from the edge for minutes. This cuts reads to the
// central store, which is what the free plan's daily ceiling counts, and it
// is the reason a crawler walking the site no longer costs one store read
// per request. Deliberately NOT applied to the counters, the entitlement
// cache, the Stripe idempotency key or a one-time key claim: those must read
// through, because a stale answer there loses money or double-grants access.
const SITE_CACHE_TTL = 300;

// Absent and unreadable are different answers and used to be the same one.
// On September 5 and 6, 2026 the account was over its daily KV read ceiling,
// every site read threw, this returned null, and the site told the world its
// data "has not been published yet" while the files sat there intact. A
// storage failure is now its own signal so it can be reported as one.
const READ_FAILED = Symbol("site-read-failed");

async function readSiteFile(env, file) {
  if (!env.CORPUS) return READ_FAILED;
  try {
    return await env.CORPUS.get(
      `site:${file}`, { type: "text", cacheTtl: SITE_CACHE_TTL });
  } catch (_) {
    return READ_FAILED;
  }
}

const SITE_UNREADABLE =
  "The published files could not be read from storage. This is an outage " +
  "on our side, not a missing file; the data is intact. Retry shortly.";

function storageUnavailable() {
  return Response.json({ error: SITE_UNREADABLE },
                       { status: 503, headers: { ...CORS_HEADERS,
                                                 "Retry-After": "300" } });
}

const SITE_NOT_PUBLISHED =
  "This file has not been published to the worker yet. The daily ingest " +
  "uploads it; until then the data site at " + FEED_BASE + " is the source.";

async function serveSiteFile(request, env, ctx, url, matched) {
  if (matched.free) {
    const body = await readSiteFile(env, matched.file);
    if (body === READ_FAILED) return storageUnavailable();
    if (body === null) {
      return Response.json({ error: SITE_NOT_PUBLISHED },
                           { status: 404, headers: CORS_HEADERS });
    }
    // These files are public and regenerated daily, so the edge may hold
    // them. A repeat request answered by the CDN never runs this worker and
    // never touches KV at all, which is the half of the fix that does not
    // depend on how Cloudflare bills a cached read.
    return new Response(body, {
      headers: { ...CORS_HEADERS, "Content-Type": matched.type,
                 "Cache-Control": `public, max-age=${SITE_CACHE_TTL}` },
    });
  }

  const gate = await openGate(request, env, {
    resource: url.origin + url.pathname,
    tier: matched.route.tier,
    description: matched.route.description,
    mimeType: matched.route.mimeType,
  });
  if (gate.challenge) {
    recordApiUsage(env, ctx, matched.route.name, "unpaid");
    return withCors(gate.challenge);
  }

  const body = await readSiteFile(env, matched.file);
  if (body === READ_FAILED) return storageUnavailable();
  if (body === null) {
    // Nothing to sell, so nothing is settled: the payment is left unclaimed
    // rather than taken for a file we could not produce.
    return Response.json({ error: SITE_NOT_PUBLISHED },
                         { status: 404, headers: CORS_HEADERS });
  }

  const settled = await settlePayment(env, gate);
  if (!settled.ok) {
    recordApiUsage(env, ctx, matched.route.name, "unsettled");
    return withCors(
      paymentRequiredResponse(gate.requirements, settled.reason));
  }
  recordApiUsage(env, ctx, matched.route.name, gate.free ? "free" : "paid");

  const headers = { ...CORS_HEADERS, "Content-Type": matched.route.mimeType };
  if (settled.header) headers["X-PAYMENT-RESPONSE"] = settled.header;
  return new Response(body, { headers });
}

async function serveApiRoute(request, env, ctx, url, matched) {
  const { route, args: pathArgs } = matched;
  const gate = await openGate(request, env, {
    resource: url.origin + url.pathname,
    tier: route.tier,
    description: route.description,
    mimeType: route.mimeType,
  });
  if (gate.challenge) {
    recordApiUsage(env, ctx, route.name, "unpaid");
    return withCors(gate.challenge);
  }

  let result;
  try {
    // The fifth argument is the cap bypass the operator lane uses. Only a
    // caller who actually paid skips the free tier's per-IP company-lookup
    // ceiling. While the gate is open (no X402_PAY_TO) these routes ARE the
    // free tier, so they answer to its caps; bypassing unconditionally made
    // /v1/company an uncapped mirror of a capped MCP tool, which is both a
    // denial-of-wallet hole and a promise the published docs do not make.
    result = await toolHandlers[route.tool](
      argsFromQuery(url, pathArgs), env, request, null, !gate.free);
  } catch (error) {
    return Response.json(
      { error: `Request failed: ${error.message}` },
      { status: 500, headers: CORS_HEADERS });
  }

  // Settle only now: nobody is charged for a response we could not build.
  const settled = await settlePayment(env, gate);
  if (!settled.ok) {
    recordApiUsage(env, ctx, route.name, "unsettled");
    return withCors(
      paymentRequiredResponse(gate.requirements, settled.reason));
  }
  recordApiUsage(env, ctx, route.name, gate.free ? "free" : "paid");

  if (result && result._company_stem && env.USAGE) {
    const day = new Date().toISOString().slice(0, 10);
    const key = `company:${day}:${result._company_stem}`;
    ctx.waitUntil((async () => {
      try {
        const current = Number(await env.USAGE.get(key)) || 0;
        await env.USAGE.put(key, String(current + 1),
                            { expirationTtl: 60 * 60 * 24 * 400 });
      } catch (_) { /* telemetry never breaks a response */ }
    })());
    delete result._company_stem;
  }

  const headers = { ...CORS_HEADERS };
  if (settled.header) headers["X-PAYMENT-RESPONSE"] = settled.header;
  if (result && typeof result._text === "string") {
    return new Response(result._text, {
      headers: { ...headers, "Content-Type": "text/markdown; charset=utf-8" },
    });
  }
  return Response.json(result, { headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Operator lane: the same server on /op/<OPERATOR_TOKEN>. Nate's own
    // connectors point here so his traffic lands under self:-prefixed
    // telemetry keys and skips the free-tier caps; everything on the public
    // path is then someone else by definition. claude.ai's connector UI has
    // no custom-header field, which is why this is a path and not a header.
    const operator = Boolean(env.OPERATOR_TOKEN) &&
      url.pathname.replace(/\/+$/, "") === `/op/${env.OPERATOR_TOKEN}`;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // GET is the HTTP data API (docs/x402-http-api.md) plus the discovery
    // documents; POST is MCP. Discovery and terms are free, data is paid:
    // an agent must be able to find the catalogue and read the licence
    // before it decides to buy, and crawlers that only read those stay
    // welcome.
    if (request.method === "GET") {
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (path === "/health") {
        return new Response("ok", { headers: CORS_HEADERS });
      }
      if (path === "/.well-known/x402") {
        return Response.json(wellKnownX402(env, url), { headers: CORS_HEADERS });
      }
      // Sign in with Whimbrel (src/oauth.js): discovery and the browser
      // half of the flow. What lets an app user subscribe and connect
      // without ever seeing an API key.
      if (path === "/.well-known/oauth-authorization-server" ||
          path.startsWith("/.well-known/oauth-authorization-server/")) {
        return Response.json(authServerMetadata(url.origin),
                             { headers: CORS_HEADERS });
      }
      if (path === "/.well-known/oauth-protected-resource" ||
          path.startsWith("/.well-known/oauth-protected-resource/")) {
        return Response.json(protectedResourceMetadata(url.origin),
                             { headers: CORS_HEADERS });
      }
      if (path === "/oauth/authorize") {
        return await authorizePage(env, url, await planCatalogue(env));
      }
      if (path === "/oauth/complete") {
        return await completeCheckout(env, url);
      }
      if (path === "/v1/about") {
        try {
          return Response.json(await toolHandlers.about_the_data(null, env),
                               { headers: CORS_HEADERS });
        } catch (error) {
          return Response.json(
            { error: `Request failed: ${error.message}` },
            { status: 500, headers: CORS_HEADERS });
        }
      }
      // Buying is a browser errand, so this is a redirect rather than JSON:
      // an agent hands its human this URL and the human finishes in a
      // browser. Two things decide where it sends them.
      //
      // With no plan named it sends people to the connect page rather than
      // to a checkout, because a purchase made before the connector exists
      // has nowhere to put the key and ends on a page that shows one to
      // copy. The same purchase made from inside the connector hands the
      // token straight to the app and never displays a key at all. So the
      // order is connect first, subscribe from inside, and this route
      // stops short-circuiting it. It also stops this route selling the
      // pre-retiering $199 plan, which is what it did until September 17,
      // 2026: it defaulted to STRIPE_PRICE_ID, so the website sold a plan
      // the product no longer has while get_access sold the three real
      // ones.
      //
      // A named plan still goes straight to that plan's checkout, for a
      // link sent to someone who has asked for one specific plan.
      if (path === "/v1/subscribe") {
        const wanted = String(url.searchParams.get("plan") || "").toLowerCase();
        const priceId = tierPriceId(env, wanted);
        if (!priceId) {
          return Response.redirect(CONNECT_PAGE, 303);
        }
        const session = await createCheckoutSession(
          env, checkoutUrls(url), { priceId, metadata: { tier: wanted } });
        if (!session.ok) {
          return Response.json({ error: session.reason },
                               { status: 503, headers: CORS_HEADERS });
        }
        return Response.redirect(session.url, 303);
      }
      const claim = path.match(/^\/v1\/key\/([A-Za-z0-9_-]+)$/);
      if (claim) return withCors(await claimKey(env, request, url, claim[1]));
      const matched = matchApiRoute(path);
      if (matched) return serveApiRoute(request, env, ctx, url, matched);
      const asset = await serveSiteAsset(env, path);
      if (asset) return asset;
      const site = matchSiteFile(path);
      if (site) {
        const served = await serveSiteFile(request, env, ctx, url, site);
        // "/" falls through to the text landing while the site files have
        // not been uploaded yet; every other path reports the 404 honestly.
        if (!(path === "/" && served.status === 404)) return served;
      }
      if (path === "/") {
        return new Response(
          "Whimbrel Research: US medtech buying signals.\n\n" +
            "MCP clients: connect to this URL via Streamable HTTP.\n" +
            "Agents and scripts: the same data over plain HTTP, paid per " +
            "call with x402. The catalogue and prices are at " +
            "/.well-known/x402 and the terms at /v1/about, both free.\n\n" +
            "Data home: " + FEED_BASE + "\n" +
            "Publisher: https://whimbrelresearch.com\n",
          { headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" } }
        );
      }
      return Response.json(
        { error: `No such endpoint: ${path}`,
          catalogue: url.origin + "/.well-known/x402" },
        { status: 404, headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
    }

    // Stripe posts here too. It is checked before the body is read as MCP,
    // because the signature covers the raw bytes and a JSON round trip would
    // invalidate it.
    if (url.pathname.replace(/\/+$/, "") === "/stripe/webhook") {
      return withCors(await handleStripeWebhook(request, env));
    }

    // Sign in with Whimbrel (src/oauth.js): the POST half of the flow.
    // Routed before the MCP body read, since none of these are JSON-RPC.
    const postPath = url.pathname.replace(/\/+$/, "");
    if (postPath === "/oauth/register") {
      return await registerClient(env, request);
    }
    if (postPath === "/oauth/token") {
      return await tokenExchange(env, request);
    }
    if (postPath === "/oauth/grant") {
      return await grantFromForm(env, request, async (key) => {
        const hash = await sha256hex(key);
        const found = await tenantByHash(env, hash);
        return found?.entitled ? hash : null;
      }, await planCatalogue(env));
    }
    if (postPath === "/oauth/checkout") {
      return await checkoutFromForm(env, request, url, (urls, plan) => {
        // An empty plan is the legacy single-plan door, which
        // createCheckoutSession serves from STRIPE_PRICE_ID. Anything else
        // must name a plan that exists: a value that does not is a forged
        // or stale form, not a reason to fall back to a retired price.
        if (!plan) return createCheckoutSession(env, urls);
        const priceId = tierPriceId(env, plan);
        if (!priceId) {
          return { ok: false, reason: "That plan is not available." };
        }
        return createCheckoutSession(env, urls,
                                     { priceId, metadata: { tier: plan } });
      }, await planCatalogue(env));
    }

    // Claude's Add-connector dialog probes this endpoint to decide whether
    // the server has sign-in. While unauthenticated POSTs answered, the
    // dialog detected "No sign-in" and defaulted every new user straight
    // past /oauth/authorize, so nobody ever saw the subscribe, key, or
    // free-grant doors (found on the September 15 fresh-user walk). The
    // MCP-spec answer is to challenge: 401 with WWW-Authenticate naming
    // the protected-resource metadata, which makes clients detect OAuth
    // and route users through the sign-in page, where "Continue with free
    // access" keeps the free tier one click away with no account and no
    // key. Keyless scripts keep the GET /v1/* HTTP API. A wrangler var so
    // the old behavior is one config flip away; the operator lane stays
    // open because Nate's connectors authenticate by path, not header.
    if (env.MCP_REQUIRE_AUTH && !operator && !bearerKey(request)) {
      return Response.json({
        error: "unauthorized",
        error_description:
          "This MCP endpoint uses sign-in. Connect via OAuth (Continue " +
          "with free access is first and needs no account or key), or " +
          "send an Authorization: Bearer key. Install steps: " +
          CONNECT_PAGE + " Keyless data lives on GET /v1/*.",
      }, {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          "WWW-Authenticate": `Bearer resource_metadata="${url.origin}` +
            `/.well-known/oauth-protected-resource"`,
        },
      });
    }

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return Response.json(rpcError(null, -32700, "Parse error"), {
        status: 400,
        headers: CORS_HEADERS,
      });
    }

    // Support both single messages and (older-spec) batches.
    const messages = Array.isArray(body) ? body : [body];
    const responses = [];
    for (const message of messages) {
      let response;
      try {
        response = await handleMessage(message, env, ctx, request, operator);
      } catch (error) {
        // The last net. An uncaught throw here used to kill the whole
        // request as a bare 502 with no body; a JSON-RPC error at least
        // tells the caller the server is alive and what broke.
        response = rpcError(message?.id, -32603,
                            `Internal error: ${error.message}`);
      }
      if (response !== null) responses.push(response);
    }

    if (responses.length === 0) {
      return new Response(null, { status: 202, headers: CORS_HEADERS });
    }
    if (!Array.isArray(body) && responses.length === 1) {
      const streamed = await streamRunProgress(
        body, env, ctx, request, responses[0]);
      if (streamed) return streamed;
    }
    const payload = Array.isArray(body) ? responses : responses[0];
    return Response.json(payload, { headers: CORS_HEADERS });
  },

  // Scheduler backstop (docs/paid-mcp-tier.md): GitHub's cron is
  // best-effort and skipped a day outright on August 28. Cloudflare crons
  // fire on time, so at 13:00 UTC this checks whether today's daily ingest
  // ran and dispatches it if not. A backstop, not a replacement: the GitHub
  // schedule stays, the whimbrel-state concurrency group serializes any
  // overlap, and without DISPATCH_PAT this no-ops.
  async scheduled(event, env, ctx) {
    if (!env.DISPATCH_PAT) return;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const response = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/` +
        `${INGEST_WORKFLOW}/runs?created=%3E%3D${today}&per_page=1`,
        { headers: {
            "Authorization": `Bearer ${env.DISPATCH_PAT}`,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "whimbrel-signals-mcp",
        } });
      const runs = await response.json();
      if (Number(runs?.total_count) > 0) {
        console.log(JSON.stringify({ event: "ingest-backstop", ran: false,
                                     reason: "already ran today" }));
        return;
      }
      const dispatched = await githubDispatch(env, INGEST_WORKFLOW, {});
      console.log(JSON.stringify({ event: "ingest-backstop", ran: true,
                                   ok: dispatched.ok,
                                   error: dispatched.error || null }));
    } catch (error) {
      console.log(JSON.stringify({ event: "ingest-backstop",
                                   error: String(error).slice(0, 200) }));
    }
  },
};
