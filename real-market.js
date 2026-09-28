const https = require("https");
const WebSocket = require("ws");
const { decode } = require("@msgpack/msgpack");

const DATA_HOST = "data.alpaca.markets";
const TRADING_HOST = process.env.ALPACA_TRADING_HOST || "paper-api.alpaca.markets";
const STOCK_FEED = process.env.ALPACA_STOCK_FEED || "iex";
const OPTION_FEED = process.env.ALPACA_OPTION_FEED || "indicative";
const KEY = process.env.ALPACA_API_KEY;
const SECRET = process.env.ALPACA_API_SECRET;
const STOCK_STREAM = "wss://stream.data.alpaca.markets/v2/" + STOCK_FEED;
const OPTION_STREAM = "wss://stream.data.alpaca.markets/v1beta1/" + OPTION_FEED;

let stockWs = null;
let optionWs = null;
let stockSymbols = new Set();
let optionSymbols = new Set();
let marketRef = null;
let roundRef = null;
let broadcastRef = null;
let stockReconnect = null;
let optionReconnect = null;
const optionLive = new Map();
const chainCache = new Map();
const expirationCache = new Map();
const newsCache = { items: [], at: 0 };

function credentials() {
  if (!KEY || !SECRET) throw new Error("Alpaca credentials are missing on the server.");
}

function request(host, path) {
  credentials();
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: host,
      path,
      headers: {
        "APCA-API-KEY-ID": KEY,
        "APCA-API-SECRET-KEY": SECRET,
        Accept: "application/json"
      }
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", c => body += c);
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error("Alpaca HTTP " + res.statusCode + " [" + host + path.split("?")[0] + "]: " + body.slice(0, 400)));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("Alpaca request timeout")));
  });
}

function auth(ws) {
  ws.send(JSON.stringify({ action: "auth", key: KEY, secret: SECRET }));
}

function scheduleStockReconnect() {
  if (stockReconnect) return;
  stockReconnect = setTimeout(() => { stockReconnect = null; connectStock(); }, 3000);
}

function scheduleOptionReconnect() {
  if (optionReconnect) return;
  optionReconnect = setTimeout(() => { optionReconnect = null; connectOptions(); }, 3000);
}

function connectStock() {
  credentials();
  if (stockWs && (stockWs.readyState === WebSocket.OPEN || stockWs.readyState === WebSocket.CONNECTING)) return;
  stockWs = new WebSocket(STOCK_STREAM);
  stockWs.on("open", () => auth(stockWs));
  stockWs.on("message", raw => {
    try {
      const msgs = JSON.parse(raw.toString());
      for (const msg of msgs) {
        if (msg.T === "error") {
          console.error("Alpaca stock stream error:", msg.code, msg.msg);
        } else if (msg.T === "success" && msg.msg === "authenticated") {
          stockWs.send(JSON.stringify({ action: "subscribe", trades: [...stockSymbols], quotes: [...stockSymbols], bars: [...stockSymbols] }));
        } else if (msg.T === "t" || msg.T === "q" || msg.T === "b" || msg.T === "d" || msg.T === "u") {
          applyStock(msg);
        }
      }
    } catch (e) { console.error("Alpaca stock stream parse:", e.message); }
  });
  stockWs.on("error", e => console.error("Alpaca stock stream:", e.message));
  stockWs.on("close", () => { stockWs = null; scheduleStockReconnect(); });
}

function applyStock(msg) {
  const stock = marketRef?.[msg.S];
  if (!stock) return;
  const ts = msg.t ? Date.parse(msg.t) : Date.now();
  if (msg.T === "q") {
    const bid = Number(msg.bp), ask = Number(msg.ap);
    if (Number.isFinite(bid) && bid > 0) stock.bid = bid;
    if (Number.isFinite(ask) && ask > 0) stock.ask = ask;
    const px = Number.isFinite(ask) && ask > 0 ? ask : bid;
    if (Number.isFinite(px) && px > 0) stock.price = roundRef(px);
  } else if (msg.T === "t") {
    const px = Number(msg.p);
    if (Number.isFinite(px) && px > 0) stock.price = roundRef(px);
    stock.lastTradeAt = ts;
  } else if (msg.T === "b" || msg.T === "d" || msg.T === "u") {
    if (Number.isFinite(Number(msg.c))) stock.price = roundRef(Number(msg.c));
    if (msg.T === "d" && Number.isFinite(Number(msg.o))) stock.open = roundRef(Number(msg.o));
  }
  stock.updatedAt = ts;
  stock.stream = true;
  if (Number.isFinite(stock.previousClose) && stock.previousClose !== 0) {
    stock.change = roundRef(stock.price - stock.previousClose);
    stock.changePct = roundRef(((stock.price - stock.previousClose) / stock.previousClose) * 100, 2);
  }
  broadcastRef?.({ type: "marketTick", stock: publicStock(stock) });
}

function connectOptions() {
  credentials();
  if (optionWs && (optionWs.readyState === WebSocket.OPEN || optionWs.readyState === WebSocket.CONNECTING)) return;
  optionWs = new WebSocket(OPTION_STREAM);
  optionWs.on("open", () => auth(optionWs));
  optionWs.on("message", raw => {
    try {
      const decoded = decode(Buffer.from(raw));
      const msgs = Array.isArray(decoded) ? decoded : [decoded];
      for (const msg of msgs) {
        if (!msg || typeof msg !== "object") continue;
        if (msg.T === "error") {
          console.error("Alpaca option stream error:", msg.code, msg.msg);
        } else if (msg.T === "success" && msg.msg === "authenticated") {
          if (optionSymbols.size) subscribeOptions([...optionSymbols]);
        } else if (msg.T === "q" || msg.T === "t") {
          applyOption(msg);
        }
      }
    } catch (e) { console.error("Alpaca option stream parse:", e.message); }
  });
  optionWs.on("error", e => console.error("Alpaca option stream:", e.message));
  optionWs.on("close", () => { optionWs = null; scheduleOptionReconnect(); });
}

function applyOption(msg) {
  const symbol = String(msg.S || "");
  if (!symbol) return;
  const o = optionLive.get(symbol) || {};
  if (msg.T === "q") {
    if (Number.isFinite(Number(msg.bp))) o.bid = Number(msg.bp);
    if (Number.isFinite(Number(msg.ap))) o.ask = Number(msg.ap);
    o.bidSize = Number(msg.bs) || o.bidSize;
    o.askSize = Number(msg.as) || o.askSize;
  } else {
    if (Number.isFinite(Number(msg.p))) o.last = Number(msg.p);
    o.tradeSize = Number(msg.s) || o.tradeSize;
  }
  o.updatedAt = msg.t || o.updatedAt || new Date().toISOString();
  optionLive.set(symbol, o);
  broadcastRef?.({
    type: "optionTick",
    contractSymbol: symbol,
    bid: o.bid ?? null,
    ask: o.ask ?? null,
    last: o.last ?? null,
    updatedAt: o.updatedAt
  });
}

function subscribeOptions(symbols) {
  const clean = [...new Set(symbols.filter(Boolean))];
  clean.forEach(s => optionSymbols.add(s));
  if (optionWs?.readyState === WebSocket.OPEN && clean.length) {
    optionWs.send(JSON.stringify({ action: "subscribe", trades: clean, quotes: clean }));
  }
}

async function refreshMarket(market, symbols, round) {
  const names = Object.keys(symbols);
  const data = await request(DATA_HOST, "/v2/stocks/snapshots?symbols=" + encodeURIComponent(names.join(",")) + "&feed=" + encodeURIComponent(STOCK_FEED));
  for (const symbol of names) {
    const snap = data.snapshots?.[symbol];
    if (!snap) continue;
    const stock = market[symbol];
    const trade = snap.latestTrade || {};
    const quote = snap.latestQuote || {};
    const daily = snap.dailyBar || {};
    const prev = snap.prevDailyBar || {};
    const px = Number(trade.p ?? quote.ap ?? quote.bp);
    if (Number.isFinite(px) && px > 0) stock.price = round(px);
    if (Number.isFinite(Number(quote.bp))) stock.bid = round(Number(quote.bp));
    if (Number.isFinite(Number(quote.ap))) stock.ask = round(Number(quote.ap));
    if (Number.isFinite(Number(daily.o))) stock.open = round(Number(daily.o));
    if (Number.isFinite(Number(prev.c))) stock.previousClose = round(Number(prev.c));
    if (Number.isFinite(stock.price) && Number.isFinite(stock.previousClose)) {
      stock.change = round(stock.price - stock.previousClose);
      stock.changePct = round((stock.change / stock.previousClose) * 100, 2);
    }
    stock.lastTradeAt = trade.t ? Date.parse(trade.t) : null;
    stock.updatedAt = quote.t ? Date.parse(quote.t) : stock.lastTradeAt;
    stock.history = stock.history || [];
    if (Number.isFinite(stock.price)) stock.history.push(stock.price);
    stock.history = stock.history.slice(-120);
  }
}

async function fetchContracts(symbol, expirationDate) {
  const all = [];
  let token = "";
  do {
    const q = new URLSearchParams({
      underlying_symbols: symbol,
      status: "active",
      expiration_date_gte: new Date().toISOString().slice(0,10),
      limit: "10000"
    });
    if (expirationDate) {
      q.delete("expiration_date_gte");
      q.set("expiration_date", expirationDate);
    }
    if (token) q.set("page_token", token);
    const data = await request(TRADING_HOST, "/v2/options/contracts?" + q.toString());
    all.push(...(data.option_contracts || []));
    token = data.page_token || "";
  } while (token);
  return all;
}

function dateFromContract(c) { return c.expiration_date; }

async function getExpirations(symbol) {
  const key = symbol.toUpperCase();
  const cached = expirationCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.items;
  const contracts = await fetchContracts(key);
  const items = [...new Set(contracts.map(dateFromContract).filter(Boolean))].sort();
  expirationCache.set(key, { items, expires: Date.now() + 60000 });
  return items;
}

async function getOptionChain(symbol, expirationDate) {
  symbol = symbol.toUpperCase();
  const key = symbol + "|" + (expirationDate || "nearest");
  const cached = chainCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.data;

  const expirations = await getExpirations(symbol);
  const expiration = expirationDate || expirations[0];
  if (!expiration) return { expiration: null, chain: [] };

  const contracts = await fetchContracts(symbol, expiration);
  if (!contracts.length) return { expiration, chain: [] };

  let token = "";
  const snapshots = new Map();
  do {
    const q = new URLSearchParams({ feed: OPTION_FEED, expiration_date: expiration, limit: "1000" });
    if (token) q.set("page_token", token);
    const data = await request(DATA_HOST, "/v1beta1/options/snapshots/" + encodeURIComponent(symbol) + "?" + q.toString());
    for (const [s, snap] of Object.entries(data.snapshots || {})) snapshots.set(s, snap);
    token = data.next_page_token || "";
  } while (token);

  const now = Date.now();
  const chain = contracts.map(c => {
    const snap = snapshots.get(c.symbol) || {};
    const live = optionLive.get(c.symbol) || {};
    const quote = snap.latestQuote || {};
    const trade = snap.latestTrade || {};
    const g = snap.greeks || {};
    const bid = Number(live.bid ?? quote.bp);
    const ask = Number(live.ask ?? quote.ap);
    const last = Number(live.last ?? trade.p);
    const exp = Date.parse(c.expiration_date + "T23:59:59-04:00");
    return {
      id: c.id || c.symbol,
      contractSymbol: c.symbol,
      symbol,
      type: c.type,
      strike: Number(c.strike_price),
      expiration: exp,
      expirationDate: c.expiration_date,
      days: Math.max(0, Math.ceil((exp - now) / 86400000)),
      bid: finite(bid) ? round(bid) : null,
      ask: finite(ask) ? round(ask) : null,
      last: finite(last) ? round(last) : null,
      mid: finite(bid) && finite(ask) ? round((bid + ask) / 2) : null,
      delta: finite(g.delta) ? Number(g.delta) : null,
      gamma: finite(g.gamma) ? Number(g.gamma) : null,
      theta: finite(g.theta) ? Number(g.theta) : null,
      vega: finite(g.vega) ? Number(g.vega) : null,
      iv: finite(g.iv) ? Number(g.iv) * 100 : null,
      volume: finite(snap.dailyBar?.v) ? Number(snap.dailyBar.v) : null,
      openInterest: finite(c.open_interest) ? Number(c.open_interest) : null,
      size: Number(c.size) || 100,
      updatedAt: live.updatedAt || quote.t || trade.t || null,
      feed: OPTION_FEED
    };
  }).filter(x => finite(x.strike));

  subscribeOptions(chain.map(x => x.contractSymbol).slice(0, 200));
  const result = { expiration, chain };
  chainCache.set(key, { data: result, expires: Date.now() + 5000 });
  return result;
}

async function getNews(symbols = []) {
  if (!symbols.length && newsCache.items.length && newsCache.at > Date.now() - 15000) return newsCache.items;
  const q = new URLSearchParams({ limit: "20", sort: "desc" });
  if (symbols.length) q.set("symbols", symbols.join(","));
  const data = await request(DATA_HOST, "/v1beta1/news?" + q.toString());
  const items = (data.news || []).map(n => ({
    id: n.id,
    headline: n.headline,
    summary: n.summary,
    author: n.author,
    createdAt: n.created_at,
    url: n.url,
    symbols: n.symbols || [],
    source: n.source || "Alpaca"
  }));
  newsCache.items = items;
  newsCache.at = Date.now();
  return items;
}

function getOptionLive(symbol) { return optionLive.get(symbol) || null; }
function finite(v) { return v!==null && v!==undefined && v!=="" && Number.isFinite(Number(v)); }
function round(n, digits = 2) {
  const p = 10 ** digits;
  return Math.round(Number(n) * p) / p;
}
function publicStock(s) {
  return {
    symbol: s.symbol, name: s.name, price: finite(s.price) ? round(s.price) : null,
    bid: finite(s.bid) ? round(s.bid) : null, ask: finite(s.ask) ? round(s.ask) : null,
    open: finite(s.open) ? round(s.open) : null,
    previousClose: finite(s.previousClose) ? round(s.previousClose) : null,
    change: finite(s.change) ? round(s.change) : null,
    changePct: finite(s.changePct) ? round(s.changePct,2) : null,
    history: s.history || [], updatedAt: s.updatedAt || null, stream: !!s.stream, feed: STOCK_FEED, real: true
  };
}
function start(market, symbols, round, broadcast) {
  marketRef = market; roundRef = round; broadcastRef = broadcast;
  stockSymbols = new Set(Object.keys(symbols));
  connectStock();
  connectOptions();
}
module.exports = { refreshMarket, start, getOptionChain, getExpirations, getNews, publicStock, getOptionLive };
