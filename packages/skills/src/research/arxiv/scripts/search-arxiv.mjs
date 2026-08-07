#!/usr/bin/env node
/**
 * Search arXiv and display results in a clean format.
 *
 * Usage:
 *   node search-arxiv.mjs "GRPO reinforcement learning"
 *   node search-arxiv.mjs "GRPO reinforcement learning" --max 10
 *   node search-arxiv.mjs "GRPO reinforcement learning" --sort date
 *   node search-arxiv.mjs --author "Yann LeCun" --max 5
 *   node search-arxiv.mjs --category cs.AI --sort date --max 10
 *   node search-arxiv.mjs --id 2402.03300
 *   node search-arxiv.mjs --id 2402.03300,2401.12345
 *   node search-arxiv.mjs --bibtex 1706.03762
 *
 * No dependencies — uses only Node.js built-ins (fetch + DOMParser-free regex-safe XML walk).
 */

const HELP = `Search arXiv and display results in a clean format.

Usage:
  node search-arxiv.mjs "GRPO reinforcement learning"
  node search-arxiv.mjs "GRPO reinforcement learning" --max 10
  node search-arxiv.mjs "GRPO reinforcement learning" --sort date
  node search-arxiv.mjs --author "Yann LeCun" --max 5
  node search-arxiv.mjs --category cs.AI --sort date --max 10
  node search-arxiv.mjs --id 2402.03300
  node search-arxiv.mjs --id 2402.03300,2401.12345
`;

const SORT_MAP = { relevance: "relevance", date: "submittedDate", updated: "lastUpdatedDate" };

/** Minimal Atom/XML entry extractor (no external XML parser dependency). */
function extractEntries(xml) {
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRe.exec(xml)) !== null) {
    entries.push(match[1]);
  }
  return entries;
}

function tag(block, name) {
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`);
  const m = re.exec(block);
  return m ? m[1].trim() : "";
}

function attrList(block, tagName, attr) {
  const re = new RegExp(`<${tagName}[^>]*${attr}="([^"]*)"[^>]*/?>`, "g");
  const results = [];
  let m;
  while ((m = re.exec(block)) !== null) results.push(m[1]);
  return results;
}

function authors(block) {
  const authorRe = /<author>([\s\S]*?)<\/author>/g;
  const names = [];
  let m;
  while ((m = authorRe.exec(block)) !== null) {
    names.push(tag(m[1], "name"));
  }
  return names.join(", ");
}

function totalResults(xml) {
  const m = /<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/.exec(xml);
  return m ? m[1] : null;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function primaryCategory(entry) {
  const m = /<arxiv:primary_category[^>]*term="([^"]*)"[^>]*\/?>/.exec(entry);
  return m ? m[1] : "cs.LG";
}

/** Fetch a single paper by ID and print a BibTeX entry. */
async function bibtex(arxivId) {
  const res = await fetch(`https://export.arxiv.org/api/query?id_list=${arxivId}`, {
    headers: { "User-Agent": "Miki/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  const xml = await res.text();
  const [entry] = extractEntries(xml);
  if (!entry) {
    console.error("Paper not found");
    process.exit(1);
  }

  const title = decodeEntities(tag(entry, "title")).replace(/\s+/g, " ");
  const authorList = authors(entry);
  const year = tag(entry, "published").slice(0, 4);
  const rawId = tag(entry, "id").split("/abs/").pop();
  const primary = primaryCategory(entry);
  const lastName = authorList.split(",")[0].trim().split(" ").pop();
  const key = `${lastName}${year}_${rawId.replace(/\./g, "")}`;

  console.log(`@article{${key},`);
  console.log(`  title     = {${title}},`);
  console.log(`  author    = {${authorList.replace(/, /g, " and ")}},`);
  console.log(`  year      = {${year}},`);
  console.log(`  eprint    = {${rawId}},`);
  console.log(`  archivePrefix = {arXiv},`);
  console.log(`  primaryClass  = {${primary}},`);
  console.log(`  url       = {https://arxiv.org/abs/${rawId}}`);
  console.log(`}`);
}

async function search({ query, author, category, ids, maxResults = 5, sort = "relevance" }) {
  const params = new URLSearchParams();

  if (ids) {
    params.set("id_list", ids);
  } else {
    const parts = [];
    if (query) parts.push(`all:${encodeURIComponent(query)}`);
    if (author) parts.push(`au:${encodeURIComponent(author)}`);
    if (category) parts.push(`cat:${category}`);
    if (parts.length === 0) {
      console.error("Error: provide a query, --author, --category, or --id");
      process.exit(1);
    }
    params.set("search_query", parts.join("+AND+"));
  }

  params.set("max_results", String(maxResults));
  params.set("sortBy", SORT_MAP[sort] ?? sort);
  params.set("sortOrder", "descending");

  const url = `https://export.arxiv.org/api/query?${params.toString()}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Miki/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  const xml = await res.text();

  const entries = extractEntries(xml);
  if (entries.length === 0) {
    console.log("No results found.");
    return;
  }

  const total = totalResults(xml);
  if (total) console.log(`Found ${total} results (showing ${entries.length})\n`);

  entries.forEach((entry, i) => {
    const title = decodeEntities(tag(entry, "title")).replace(/\s+/g, " ");
    const rawId = tag(entry, "id");
    const fullId = rawId.includes("/abs/") ? rawId.split("/abs/").pop() : rawId;
    const arxivId = fullId.split("v")[0];
    const version = fullId !== arxivId ? fullId.slice(arxivId.length) : "";
    const published = tag(entry, "published").slice(0, 10);
    const updated = tag(entry, "updated").slice(0, 10);
    const authorNames = decodeEntities(authors(entry));
    const summary = decodeEntities(tag(entry, "summary")).replace(/\s+/g, " ");
    const cats = attrList(entry, "category", "term").join(", ");

    console.log(`${i + 1}. ${title}`);
    console.log(`   ID: ${arxivId}${version} | Published: ${published} | Updated: ${updated}`);
    console.log(`   Authors: ${authorNames}`);
    console.log(`   Categories: ${cats}`);
    console.log(`   Abstract: ${summary.slice(0, 300)}${summary.length > 300 ? "..." : ""}`);
    console.log(`   Links: https://arxiv.org/abs/${arxivId} | https://arxiv.org/pdf/${arxivId}`);
    console.log();
  });
}

function parseArgs(argv) {
  let query, author, category, ids;
  let maxResults = 5;
  let sort = "relevance";
  const positional = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--max" && i + 1 < argv.length) {
      maxResults = parseInt(argv[i + 1], 10);
      i += 2;
    } else if (arg === "--sort" && i + 1 < argv.length) {
      sort = argv[i + 1];
      i += 2;
    } else if (arg === "--author" && i + 1 < argv.length) {
      author = argv[i + 1];
      i += 2;
    } else if (arg === "--category" && i + 1 < argv.length) {
      category = argv[i + 1];
      i += 2;
    } else if (arg === "--id" && i + 1 < argv.length) {
      ids = argv[i + 1];
      i += 2;
    } else {
      positional.push(arg);
      i += 1;
    }
  }

  if (positional.length) query = positional.join(" ");
  return { query, author, category, ids, maxResults, sort };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    console.log(HELP);
    return;
  }
  if (args[0] === "--bibtex" && args[1]) {
    await bibtex(args[1]);
    return;
  }
  const opts = parseArgs(args);
  await search(opts);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
