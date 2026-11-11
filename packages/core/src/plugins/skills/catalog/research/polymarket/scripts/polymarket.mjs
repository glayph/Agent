#!/usr/bin/env node
/**
 * Polymarket CLI helper — query prediction market data.
 *
 * Usage:
 *   node polymarket.mjs search "bitcoin"
 *   node polymarket.mjs trending [--limit 10]
 *   node polymarket.mjs market <slug>
 *   node polymarket.mjs event <slug>
 *   node polymarket.mjs price <token_id>
 *   node polymarket.mjs book <token_id>
 *   node polymarket.mjs history <condition_id> [--interval all] [--fidelity 50]
 *   node polymarket.mjs trades [--limit 10] [--market CONDITION_ID]
 *
 * No dependencies — uses only Node.js built-ins.
 */

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const DATA = "https://data-api.polymarket.com";

const HELP = `Polymarket CLI helper — query prediction market data.

Usage:
  node polymarket.mjs search "bitcoin"
  node polymarket.mjs trending [--limit 10]
  node polymarket.mjs market <slug>
  node polymarket.mjs event <slug>
  node polymarket.mjs price <token_id>
  node polymarket.mjs book <token_id>
  node polymarket.mjs history <condition_id> [--interval all] [--fidelity 50]
  node polymarket.mjs trades [--limit 10] [--market CONDITION_ID]
`;

/** GET request, return parsed JSON. */
async function get(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "Miki/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.error(`Connection error: ${err.message}`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${res.statusText}`);
    process.exit(1);
  }
  return res.json();
}

/** Parse double-encoded JSON fields (outcomePrices, outcomes, clobTokenIds). */
function parseJsonField(val) {
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
}

function fmtPct(priceStr) {
  const n = parseFloat(priceStr);
  if (Number.isNaN(n)) return String(priceStr);
  return `${(n * 100).toFixed(1)}%`;
}

function fmtVolume(vol) {
  const v = parseFloat(vol);
  if (Number.isNaN(v)) return String(vol);
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function printMarket(m, indent = "") {
  const question = m.question ?? "?";
  const prices = parseJsonField(m.outcomePrices ?? "[]");
  const outcomes = parseJsonField(m.outcomes ?? "[]");
  const vol = fmtVolume(m.volume ?? 0);
  const status = m.closed ? " [CLOSED]" : "";

  if (Array.isArray(prices) && prices.length >= 2) {
    const labels = Array.isArray(outcomes) ? outcomes : ["Yes", "No"];
    const priceStr = prices
      .slice(0, Math.min(prices.length, labels.length))
      .map((p, i) => `${labels[i]}: ${fmtPct(p)}`)
      .join(" / ");
    console.log(`${indent}${question}${status}`);
    console.log(`${indent}  ${priceStr}  |  Volume: ${vol}`);
  } else {
    console.log(`${indent}${question}${status}  |  Volume: ${vol}`);
  }

  if (m.slug) console.log(`${indent}  slug: ${m.slug}`);
}

async function cmdSearch(query) {
  const data = await get(`${GAMMA}/public-search?q=${encodeURIComponent(query)}`);
  const events = data.events ?? [];
  const total = data.pagination?.totalResults ?? events.length;
  console.log(`Found ${total} results for "${query}":\n`);
  for (const evt of events.slice(0, 10)) {
    console.log(`=== ${evt.title} ===`);
    console.log(`  Volume: ${fmtVolume(evt.volume ?? 0)}  |  slug: ${evt.slug ?? ""}`);
    const markets = evt.markets ?? [];
    for (const m of markets.slice(0, 5)) printMarket(m, "  ");
    if (markets.length > 5) console.log(`  ... and ${markets.length - 5} more markets`);
    console.log();
  }
}

async function cmdTrending(limit = 10) {
  const events = await get(
    `${GAMMA}/events?limit=${limit}&active=true&closed=false&order=volume&ascending=false`
  );
  console.log(`Top ${events.length} trending events:\n`);
  events.forEach((evt, i) => {
    console.log(`${i + 1}. ${evt.title}`);
    console.log(`   Volume: ${fmtVolume(evt.volume ?? 0)}  |  Markets: ${(evt.markets ?? []).length}`);
    console.log(`   slug: ${evt.slug ?? ""}`);
    const markets = evt.markets ?? [];
    for (const m of markets.slice(0, 3)) printMarket(m, "   ");
    if (markets.length > 3) console.log(`   ... and ${markets.length - 3} more markets`);
    console.log();
  });
}

async function cmdMarket(slug) {
  const markets = await get(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
  if (!markets || markets.length === 0) {
    console.log(`No market found with slug: ${slug}`);
    return;
  }
  const m = markets[0];
  console.log(`Market: ${m.question ?? "?"}`);
  console.log(`Status: ${m.closed ? "CLOSED" : "ACTIVE"}`);
  printMarket(m);
  console.log(`\n  conditionId: ${m.conditionId ?? "N/A"}`);
  const tokens = parseJsonField(m.clobTokenIds ?? "[]");
  if (Array.isArray(tokens)) {
    const outcomes = parseJsonField(m.outcomes ?? "[]");
    tokens.forEach((t, i) => {
      const label = Array.isArray(outcomes) && i < outcomes.length ? outcomes[i] : `Outcome ${i}`;
      console.log(`  token (${label}): ${t}`);
    });
  }
  if (m.description) console.log(`\n  Description: ${String(m.description).slice(0, 500)}`);
}

async function cmdEvent(slug) {
  const events = await get(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
  if (!events || events.length === 0) {
    console.log(`No event found with slug: ${slug}`);
    return;
  }
  const evt = events[0];
  console.log(`Event: ${evt.title}`);
  console.log(`Volume: ${fmtVolume(evt.volume ?? 0)}`);
  console.log(`Status: ${evt.closed ? "CLOSED" : "ACTIVE"}`);
  console.log(`Markets: ${(evt.markets ?? []).length}\n`);
  for (const m of evt.markets ?? []) {
    printMarket(m, "  ");
    console.log();
  }
}

async function cmdPrice(tokenId) {
  const [buy, mid, spread] = await Promise.all([
    get(`${CLOB}/price?token_id=${tokenId}&side=buy`),
    get(`${CLOB}/midpoint?token_id=${tokenId}`),
    get(`${CLOB}/spread?token_id=${tokenId}`),
  ]);
  console.log(`Token: ${tokenId.slice(0, 30)}...`);
  console.log(`  Buy price: ${fmtPct(buy.price ?? "?")}`);
  console.log(`  Midpoint:  ${fmtPct(mid.mid ?? "?")}`);
  console.log(`  Spread:    ${spread.spread ?? "?"}`);
}

async function cmdBook(tokenId) {
  const book = await get(`${CLOB}/book?token_id=${tokenId}`);
  const bids = book.bids ?? [];
  const asks = book.asks ?? [];
  console.log(`Orderbook for ${tokenId.slice(0, 30)}...`);
  console.log(`Last trade: ${fmtPct(book.last_trade_price ?? "?")}  |  Tick size: ${book.tick_size ?? "?"}`);

  console.log(`\n  Top bids (${bids.length} total):`);
  const sortedBids = [...bids].sort((a, b) => parseFloat(b.price ?? 0) - parseFloat(a.price ?? 0));
  for (const b of sortedBids.slice(0, 10)) {
    console.log(`    ${fmtPct(b.price).padStart(7)}  |  Size: ${parseFloat(b.size).toFixed(2).padStart(10)}`);
  }

  console.log(`\n  Top asks (${asks.length} total):`);
  const sortedAsks = [...asks].sort((a, b) => parseFloat(a.price ?? 0) - parseFloat(b.price ?? 0));
  for (const a of sortedAsks.slice(0, 10)) {
    console.log(`    ${fmtPct(a.price).padStart(7)}  |  Size: ${parseFloat(a.size).toFixed(2).padStart(10)}`);
  }
}

async function cmdHistory(conditionId, interval = "all", fidelity = 50) {
  const data = await get(`${CLOB}/prices-history?market=${conditionId}&interval=${interval}&fidelity=${fidelity}`);
  const history = data.history ?? [];
  if (history.length === 0) {
    console.log("No price history available for this market.");
    return;
  }
  console.log(`Price history (${history.length} points, interval=${interval}):\n`);
  for (const pt of history) {
    const ts = new Date(pt.t * 1000).toISOString().slice(0, 16).replace("T", " ");
    const price = fmtPct(pt.p);
    const bar = "█".repeat(Math.floor(parseFloat(pt.p) * 40));
    console.log(`  ${ts}  ${price.padStart(7)}  ${bar}`);
  }
}

async function cmdTrades(limit = 10, market = null) {
  let url = `${DATA}/trades?limit=${limit}`;
  if (market) url += `&market=${market}`;
  const trades = await get(url);
  if (!Array.isArray(trades)) {
    console.log(`Unexpected response: ${JSON.stringify(trades)}`);
    return;
  }
  console.log(`Recent trades (${trades.length}):\n`);
  for (const t of trades) {
    const side = (t.side ?? "?").toString().padEnd(4);
    const price = fmtPct(t.price ?? "?").padStart(7);
    const size = parseFloat(t.size).toFixed(2).padStart(8);
    const outcome = t.outcome ?? "?";
    const title = (t.title ?? "?").toString().slice(0, 50);
    console.log(`  ${side}  ${price}  x${size}  [${outcome}]  ${title}`);
  }
}

function getFlag(args, name) {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || ["-h", "--help", "help"].includes(args[0])) {
    console.log(HELP);
    return;
  }

  const cmd = args[0];

  switch (cmd) {
    case "search":
      if (args.length < 2) return console.log(HELP);
      await cmdSearch(args.slice(1).join(" "));
      break;
    case "trending":
      await cmdTrending(parseInt(getFlag(args, "--limit") ?? "10", 10));
      break;
    case "market":
      if (args.length < 2) return console.log(HELP);
      await cmdMarket(args[1]);
      break;
    case "event":
      if (args.length < 2) return console.log(HELP);
      await cmdEvent(args[1]);
      break;
    case "price":
      if (args.length < 2) return console.log(HELP);
      await cmdPrice(args[1]);
      break;
    case "book":
      if (args.length < 2) return console.log(HELP);
      await cmdBook(args[1]);
      break;
    case "history": {
      if (args.length < 2) return console.log(HELP);
      const interval = getFlag(args, "--interval") ?? "all";
      const fidelity = parseInt(getFlag(args, "--fidelity") ?? "50", 10);
      await cmdHistory(args[1], interval, fidelity);
      break;
    }
    case "trades":
      await cmdTrades(parseInt(getFlag(args, "--limit") ?? "10", 10), getFlag(args, "--market") ?? null);
      break;
    default:
      console.log(`Unknown command: ${cmd}`);
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
