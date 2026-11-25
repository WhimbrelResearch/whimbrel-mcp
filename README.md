# Whimbrel: Medtech Research

[![Whimbrel: Medtech Research](https://glama.ai/mcp/connectors/com.whimbrelresearch/whimbrel-research/badges/score.svg)](https://glama.ai/mcp/connectors/com.whimbrelresearch/whimbrel-research)

Find US medical device clients and Contacts at each company, in ChatGPT, Claude or the web app.

Whimbrel helps firms that sell to medical device companies find their next clients: contract manufacturers, test labs, sterilization providers, design and engineering firms, regulatory consultants and medtech software firms.

Ask who could hire your firm, and Whimbrel ranks US device companies for what you sell. Each one comes with why it fits, what just happened there, a source link for every fact, and Contacts at the company.

Add Whimbrel in ChatGPT, Claude or another AI app, or use the web app at [https://app.whimbrelresearch.com](https://app.whimbrelresearch.com).

## Connect

Add Whimbrel from the [ChatGPT plugin directory](https://chatgpt.com/plugins/plugin_asdk_app_6ad02b252b40819191e187d958456383), or install it in Claude, Cursor, VS Code or another MCP client from [https://whimbrelresearch.com/connect/](https://whimbrelresearch.com/connect/). You can also sign in to the web app at [https://app.whimbrelresearch.com](https://app.whimbrelresearch.com). Connecting uses OAuth 2.1 with PKCE. There is no API key to paste.

The MCP server is [https://data.whimbrelresearch.com](https://data.whimbrelresearch.com). The discovery file is [https://data.whimbrelresearch.com/.well-known/mcp.json](https://data.whimbrelresearch.com/.well-known/mcp.json). The transport is Streamable HTTP, and the same host handles OAuth.

## Tools

Whimbrel has 13 tools:

- `find`: search US device companies and rank them for what you sell. You can include Contacts already on file.
- `company`: a rundown on one named company, with coverage, what it makes, stage, location, FDA-registered facilities, and dated events with source links.
- `people`: Contacts at one named company, grouped by role, with titles, public sources, and any published work email or phone. A new people search starts only after you say yes.
- `rank_list`: paste companies or a trade show's exhibitors, and Whimbrel ranks them for your firm and says why each one fits.
- `account`: see or update your firm profile. On first setup, Whimbrel reads your website and drafts the profile.
- `remember`: save one fact you ask Whimbrel to keep about your firm.
- `pass_company`: hide a company from suggestions.
- `restore_company`: bring a passed company back, or show the ones you passed on.
- `add_target`: save companies to Targets, which stay in sync with the web app.
- `list_targets`: see your saved Targets.
- `remove_target`: remove companies from Targets.
- `crm_export`: turn an existing company record into HubSpot or Salesforce import CSV files.
- `forget`: delete what Whimbrel stored for you.

Other MCP clients also see `get_access`, which returns the sign-up link. ChatGPT does not.

## Price

$99 a month, or $79 a month billed yearly. First month free.

This repository is the Cloudflare Worker source for the Whimbrel MCP server.

Website: [https://whimbrelresearch.com/](https://whimbrelresearch.com/)
