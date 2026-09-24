/**
 * The CRM export. Run: node --test whimbrel-mcp/test/*.test.mjs
 *
 * A deep-research record shaped into HubSpot and Salesforce import
 * files. The cases that matter: fields come only from the record and a
 * missing fact is a blank column; CSV escaping survives the commas and
 * quotes real records carry; names split the way Salesforce requires;
 * and the sourced notes carry their source URLs, because a summary
 * without sources is not this product.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { crmExport } from "../src/crm.js";
import worker from "../src/index.js";

// Shaped like the live Penderia record, quotes and commas included.
const CORE = {
  schema_version: "1.0",
  researched_on: "2026-08-29",
  company: {
    name: "Penderia Technologies",
    domain: "penderia.com",
    locations: [],
    description:
      'A medical device startup developing small-profile, battery-less ' +
      'implantable sensors, "inside orthopedic implants".',
    description_source_url: "https://www.penderia.com",
  },
  people: [
    { name: "Stephen Laffoon", title: "Chief Executive Officer",
      source: "https://news.uoregon.edu/x",
      linkedin_url: "https://www.linkedin.com/in/stephen-laffoon-1a2" },
    { name: "Keat Ghee Ong", title: "Chief Technology Officer",
      source: "https://knightcampus.uoregon.edu/y" },
    { name: "Cher", title: "Advisor", source: "https://example.com/z" },
  ],
  evidence: [
    { category: "funding", title: "SBIR Phase II", statement: "Award.",
      amount: 1740000, date: "2025-02-01",
      source_url: "https://reporter.nih.gov/1" },
    { category: "regulatory", title: "Breakthrough",
      statement: "FDA Breakthrough Device Designation.",
      source_url: "https://example.com/fda" },
    // A labeled aggregator guess: present in the record, never a money row.
    { category: "company", title: "Revenue and Valuation",
      statement: "Generates an estimated annual revenue of $684,440.",
      amount: 684440, amount_kind: "third_party_estimate",
      source_url: "https://prospeo.io/c/penderia" },
  ],
  not_found: ["headcount"],
};

test("hubspot files come only from the record, blanks stay blank", () => {
  const out = crmExport(CORE, { format: "hubspot", asOf: "2026-08-29" });
  const [header, row] = out.companies_csv.split("\n");
  assert.equal(header,
    "Company name,Company domain name,Description,City,State/Region");
  // The description carries commas and quotes; escaping must survive a
  // round trip, and the empty locations render as trailing blanks.
  assert.ok(row.startsWith("Penderia Technologies,penderia.com,"));
  assert.ok(row.includes('""inside orthopedic implants""'));
  assert.ok(row.endsWith(",,"));

  const contactRows = out.contacts_csv.split("\n");
  assert.equal(contactRows[0],
    "First name,Last name,Job title,Company name,Company domain name," +
    "Email,LinkedIn URL");
  assert.equal(contactRows[1],
    "Stephen,Laffoon,Chief Executive Officer,Penderia Technologies," +
    "penderia.com,,https://www.linkedin.com/in/stephen-laffoon-1a2");
  // A multi-token name keeps everything before the last token as the
  // first name; a single token becomes the last name.
  assert.ok(contactRows[2].startsWith("Keat Ghee,Ong,"));
  assert.ok(contactRows[3].startsWith(",Cher,Advisor,"));
  assert.equal(out.contacts, 3);
});

test("salesforce uses its own headers and account column", () => {
  const out = crmExport(CORE, { format: "salesforce", asOf: "2026-08-29" });
  assert.equal(out.companies_csv.split("\n")[0],
    "Name,Website,Description,BillingCity,BillingState");
  assert.equal(out.contacts_csv.split("\n")[0],
    "FirstName,LastName,Title,Account Name,Email,LinkedIn URL");
  assert.ok(out.contacts_csv.includes("Penderia Technologies"));
  assert.match(out.import_instructions, /Data Import Wizard/);
});

test("the notes carry the money, the designation, and their sources", () => {
  const out = crmExport(CORE, { format: "hubspot", asOf: "2026-08-29" });
  assert.match(out.notes, /\$1,740,000/);
  // The aggregator's revenue guess is labeled third_party_estimate and
  // stays out of the funding section: a guess pasted into a CRM as a
  // funding line is the misuse the label exists to prevent.
  assert.ok(!out.notes.includes("684,440"),
    "an estimate must never appear as a money row");
  assert.match(out.notes, /reporter\.nih\.gov/);
  assert.match(out.notes, /Breakthrough Device Designation/);
  assert.match(out.notes, /Known gaps/);
  assert.match(out.notes, /headcount/);
  // A person with a verified profile URL shows it; everyone else gets a
  // prefilled people-search link into the reader's own LinkedIn seat.
  assert.match(out.notes,
    /LinkedIn: https:\/\/www\.linkedin\.com\/in\/stephen-laffoon-1a2/);
  assert.match(out.notes,
    /Find on LinkedIn: .*keywords=Keat%20Ghee%20Ong%20Penderia/);
});

test("an unknown format is refused with the real choices", () => {
  const out = crmExport(CORE, { format: "pipedrive", asOf: "2026-08-29" });
  assert.match(out.error, /hubspot, salesforce/);
});

// The tool path: record required, never queued, never invented.
const KEY = "wbr_test_key";
const KEY_HASH = await (async () => {
  const digest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(KEY));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
})();

function db(record) {
  return {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (/FROM tenants WHERE api_key_hash/.test(sql)) {
            return { tenant_id: "t_1", name: "Acme", tier: "standard",
                     status: "active", paid_through: "2099-01-01" };
          }
          if (/FROM research_records/.test(sql)) return record;
          return null;
        },
        async run() { return { success: true }; },
        async all() { return { results: [] }; },
      };
    },
  };
}

async function callTool(env, args) {
  const response = await worker.fetch(new Request("https://api.test/", {
    method: "POST",
    headers: { "Content-Type": "application/json",
               Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
                           params: { name: "crm_export", arguments: args } }),
  }), env, { waitUntil() {} });
  return JSON.parse((await response.json()).result.content[0].text);
}

test("the tool serves files from a stored record", async () => {
  const env = {
    DB: db({ company_name: "Penderia Technologies",
             version: "20260829T020500Z", researched_on: "2026-08-29",
             core_json: JSON.stringify(CORE) }),
  };
  const result = await callTool(env, { company: "Penderia",
                                       format: "hubspot" });
  assert.equal(result.as_of, "2026-08-29");
  assert.ok(result.companies_csv.includes("penderia.com"));
  assert.equal(result.contacts, 3);
});

test("no record means run deep_record first, never a queued run", async () => {
  const env = { DB: db(null) };
  const result = await callTool(env, { company: "Nobody Co",
                                       format: "hubspot" });
  assert.match(result.error, /Run\s+deep_record first/);
  assert.ok(!result.queued);
});
