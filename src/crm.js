/**
 * CRM export: a deep-research record shaped into the CSV files HubSpot
 * and Salesforce import natively.
 *
 * Deterministic by design. The record already holds verified,
 * source-quoted facts; formatting them is arithmetic, not judgment, so
 * no model touches this path and a field the record does not hold is a
 * blank column, never a guess. The research summary and its sources
 * travel as a notes document, because neither CRM imports notes cleanly
 * from CSV and a sourced summary pasted onto the record beats a
 * truncated description field.
 */

function csvField(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

function csvRow(values) {
  return values.map(csvField).join(",");
}

// "Stephen Laffoon" -> first "Stephen", last "Laffoon"; a single token
// becomes the last name because Salesforce requires LastName.
function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: "", last: parts[0] };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

// locations may hold objects or plain strings; read what is there.
function firstLocation(company) {
  const entry = (company?.locations || [])[0];
  if (!entry) return { city: "", state: "" };
  if (typeof entry === "string") return { city: entry, state: "" };
  return {
    city: entry.city || entry.location || "",
    state: entry.state || entry.region || "",
  };
}

function searchLink(personName, companyName) {
  const keywords = [personName, companyName].filter(Boolean).join(" ");
  return "https://www.linkedin.com/search/results/people/?keywords=" +
         encodeURIComponent(keywords);
}

function moneyLine(item) {
  const bits = [item.date, item.title,
                item.amount != null ? `$${Number(item.amount).toLocaleString("en-US")}` : null]
    .filter(Boolean);
  return `- ${bits.join(" · ")}\n  ${item.statement || ""}\n  source: ${item.source_url || ""}`;
}

function researchNotes(core, companyName, asOf) {
  const lines = [`# ${companyName} - Whimbrel Research summary (as of ${asOf})`];
  const company = core.company || {};
  if (company.description) {
    lines.push("", company.description,
               company.description_source_url
                 ? `source: ${company.description_source_url}` : "");
  }
  const evidence = core.evidence || [];
  // A third-party estimate (a guessed revenue or valuation) is labeled by
  // the pipeline and stays out of the money section: pasting a guess into
  // a CRM as a funding line is exactly the misuse the label prevents.
  const funded = evidence.filter((e) =>
    e.amount != null && e.amount_kind !== "third_party_estimate");
  if (funded.length) {
    lines.push("", "## Funding and awards (stated figures only)");
    for (const item of funded) lines.push(moneyLine(item));
  }
  const regulatory = evidence.filter((e) => e.category === "regulatory");
  if (regulatory.length) {
    lines.push("", "## Regulatory");
    for (const item of regulatory) {
      lines.push(`- ${item.statement || item.title}\n  source: ${item.source_url || ""}`);
    }
  }
  const partners = core.partners || core.named_collaborators || [];
  if (partners.length) {
    lines.push("", "## Named partners");
    for (const partner of partners) {
      lines.push(`- ${typeof partner === "string" ? partner : partner.name || ""}`);
    }
  }
  const people = core.people || [];
  if (people.length) {
    lines.push("", "## People");
    for (const person of people) {
      // A verified profile URL when one was attached from a source; a
      // prefilled people-search link otherwise, so every person is one
      // click from LinkedIn inside the reader's own logged-in seat.
      const linked = person.linkedin_url
        ? `LinkedIn: ${person.linkedin_url}`
        : `Find on LinkedIn: ${searchLink(person.name, companyName)}`;
      lines.push(`- ${person.name} - ${person.title || ""}\n  ` +
                 `${linked}\n  source: ${person.source || ""}`);
    }
  }
  const gaps = core.not_found || [];
  if (gaps.length) {
    lines.push("", "## Known gaps (looked for, not found)");
    for (const gap of gaps) {
      lines.push(`- ${typeof gap === "string" ? gap : gap.field || gap.name || ""}`);
    }
  }
  lines.push("", "Every line above is checkable at its source. " +
             "Researched by Whimbrel Research (whimbrelresearch.com).");
  return lines.filter((line) => line !== null).join("\n");
}

const FORMATS = {
  hubspot: {
    company_header: ["Company name", "Company domain name", "Description",
                     "City", "State/Region"],
    companyRow: (company, location) => [
      company.name || "", company.domain || "", company.description || "",
      location.city, location.state],
    contact_header: ["First name", "Last name", "Job title",
                     "Company name", "Company domain name", "Email",
                     "LinkedIn URL"],
    contactRow: (person, company) => {
      const { first, last } = splitName(person.name);
      return [first, last, person.title || "", company.name || "",
              company.domain || "", person.email || "",
              person.linkedin_url || ""];
    },
    instructions:
      "HubSpot: Settings -> Import -> Start an import -> CSV. Import the " +
      "companies file first (object type Companies; HubSpot matches on " +
      "Company domain name), then the contacts file (object type " +
      "Contacts; the company columns associate each contact " +
      "automatically). Paste the research notes into a note on the " +
      "company record.",
  },
  salesforce: {
    company_header: ["Name", "Website", "Description",
                     "BillingCity", "BillingState"],
    companyRow: (company, location) => [
      company.name || "", company.domain || "", company.description || "",
      location.city, location.state],
    contact_header: ["FirstName", "LastName", "Title", "Account Name",
                     "Email", "LinkedIn URL"],
    contactRow: (person, company) => {
      const { first, last } = splitName(person.name);
      return [first, last, person.title || "", company.name || "",
              person.email || "", person.linkedin_url || ""];
    },
    instructions:
      "Salesforce: Setup -> Data Import Wizard. Import the accounts file " +
      "first (Standard objects -> Accounts and Contacts -> Add new " +
      "records), then the contacts file, mapping Account Name so each " +
      "contact lands on the account. Paste the research notes into a " +
      "note on the account record.",
  },
};

export const CRM_FORMATS = Object.keys(FORMATS);

export function crmExport(core, { format, asOf }) {
  const shape = FORMATS[format];
  if (!shape) {
    return { error: `Unknown format "${format}". ` +
                    `Choose one of: ${CRM_FORMATS.join(", ")}.` };
  }
  const company = core.company || {};
  const location = firstLocation(company);
  const companiesCsv = [
    csvRow(shape.company_header),
    csvRow(shape.companyRow(company, location)),
  ].join("\n");
  const people = (core.people || []).filter((p) => p && p.name);
  const contactsCsv = [
    csvRow(shape.contact_header),
    ...people.map((person) => csvRow(shape.contactRow(person, company))),
  ].join("\n");
  return {
    format,
    companies_csv: companiesCsv,
    contacts_csv: contactsCsv,
    contacts: people.length,
    notes: researchNotes(core, company.name || "Company", asOf),
    import_instructions: shape.instructions,
  };
}
