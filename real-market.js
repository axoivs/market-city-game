const https = require("https");
const WebSocket = require("ws");

const DATA_HOST = "data.alpaca.markets";
const TRADING_HOST = process.env.ALPACA_TRADING_HOST || "paper-api.alpaca.markets";
const STOCK_FEED = process.env.ALPACA_STOCK_FEED || "iex";
const OPTION_FEED = process.env.ALPACA_OPTION_FEED || "indicative";
const KEY = process.env.ALPACA_API_KEY;
const SECRET = process.env.ALPACA_API_SECRET;
const STOCK_STREAM = "wss://stream.data.alpaca.markets/v2/" + STOCK_FEED;

let stockWs = null;
let stockSymbols = new Set();
let optionSymbols = new Set();
let marketRef = null;
let roundRef = null;
let broadcastRef = null;
let stockReconnect = null;
const optionLive = new Map();
const chainCache = new Map();
const expirationCache = new Map();
const newsCache = { items: [], at: 0 };
const assetCache = { items: [], at: 0 };

async function getAssets(search = "") {
  const now = Date.now();
  if (!assetCache.items.length || now - assetCache.at > 300000) {
    const items = [];
    let token = "";
    do {
      const q = new URLSearchParams({ status: "active", asset_class: "us_equity" });
      if (token) q.set("page_token", token);
      const data = await request(TRADING_HOST, "/v2/assets?" + q.toString());
      for (const a of (Array.isArray(data) ? data : [])) {
        if (a.symbol && a.tradable !== false) items.push({ symbol: a.symbol, name: a.name || a.symbol, exchange: a.exchange || "", hasOptions: Array.isArray(a.attributes) ? a.attributes.includes("has_options") || a.attributes.includes("options_enabled") : !!a.has_options });
      }
      token = data.next_page_token || "";
    } while (token);
    items.sort((a,b) => a.symbol.localeCompare(b.symbol));
    assetCache.items = items;
    assetCache.at = now;
  }
  const q = String(search || "").trim().toLowerCase();
  return q ? assetCache.items.filter(a => a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)) : assetCache.items;
}

async function getStockQuote(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (!/^[A-Z0-9.\\-]{1,20}$/.test(s)) throw new Error("Invalid stock symbol.");
  const [quotes, trades, bars] = await Promise.all([
    request(DATA_HOST, "/v2/stocks/quotes/latest?symbols=" + encodeURIComponent(s) + "&feed=" + encodeURIComponent(STOCK_FEED)),
    request(DATA_HOST, "/v2/stocks/trades/latest?symbols=" + encodeURIComponent(s) + "&feed=" + encodeURIComponent(STOCK_FEED)),
    request(DATA_HOST, "/v2/stocks/bars?symbols=" + encodeURIComponent(s) + "&timeframe=1Min&limit=120&feed=" + encodeURIComponent(STOCK_FEED) + "&adjustment=raw")
  ]);
  const q = quotes?.quotes?.[s] || {}, t = trades?.trades?.[s] || {}, b = Array.isArray(bars?.bars?.[s]) ? bars.bars[s] : [];
  const bid = Number(q.bp), ask = Number(q.ap), last = Number(t.p);
  const price = finite(last) && last > 0 ? last : (finite(ask) && ask > 0 ? ask : (finite(bid) && bid > 0 ? bid : null));
  const history = b.map(x => Number(x.c)).filter(Number.isFinite).slice(-120);
  if (!finite(price) || price <= 0) throw new Error("Alpaca has no current quote for " + s + ".");
  const asset = assetCache.items.find(a => a.symbol === s);
  return { symbol:s, name:asset?.name || s, price:round(price), bid:finite(bid)&&bid>0?round(bid):null, ask:finite(ask)&&ask>0?round(ask):null, open:null, previousClose:null, change:null, changePct:null, history:history.length?history:[round(price)], updatedAt:t.t||q.t||Date.now(), stream:false, feed:STOCK_FEED, real:true };
}


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
  optionWs = new WebSocket(OPTION_STREAM, {
    headers: { "Content-Type": "application/msgpack" }
  });
  optionWs.on("open", () => auth(optionWs, true));
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
    optionWs.send(Buffer.from(encode({ action: "subscribe", trades: clean, quotes: clean })));
  }
}

async function refreshMarket(market, symbols, round) {
  const names = Object.keys(symbols);

  const [quotes, trades, bars] = await Promise.all([
    request(DATA_HOST, "/v2/stocks/quotes/latest?symbols=" + encodeURIComponent(names.join(",")) + "&feed=" + encodeURIComponent(STOCK_FEED)),
    request(DATA_HOST, "/v2/stocks/trades/latest?symbols=" + encodeURIComponent(names.join(",")) + "&feed=" + encodeURIComponent(STOCK_FEED)),
    request(DATA_HOST, "/v2/stocks/bars?symbols=" + encodeURIComponent(names.join(",")) + "&timeframe=1Min&limit=120&feed=" + encodeURIComponent(STOCK_FEED) + "&adjustment=raw")
  ]);

  const qmap = quotes?.quotes || {};
  const tmap = trades?.trades || {};
  const bmap = bars?.bars || {};
  let loaded = 0;

  for (const symbol of names) {
    const stock = market[symbol];
    const quote = qmap[symbol] || {};
    const trade = tmap[symbol] || {};

    const bidPx = Number(quote.bp);
    const askPx = Number(quote.ap);
    const tradePx = Number(trade.p);

    let price = Number.isFinite(tradePx) && tradePx > 0 ? tradePx :
      (Number.isFinite(askPx) && askPx > 0 ? askPx :
      (Number.isFinite(bidPx) && bidPx > 0 ? bidPx : NaN));

    if (Number.isFinite(price) && price > 0) {
      stock.price = round(price);
      loaded++;
    }
    if (Number.isFinite(bidPx) && bidPx > 0) stock.bid = round(bidPx);
    if (Number.isFinite(askPx) && askPx > 0) stock.ask = round(askPx);

    stock.updatedAt = trade.t ? Date.parse(trade.t) : (quote.t ? Date.parse(quote.t) : Date.now());
    stock.lastTradeAt = trade.t ? Date.parse(trade.t) : null;
    const realBars = Array.isArray(bmap[symbol]) ? bmap[symbol] : [];
    const barHistory = realBars.map(b => Number(b.c)).filter(Number.isFinite).slice(-120);
    if (barHistory.length) stock.history = barHistory;
    else {
      stock.history = stock.history || [];
      if (Number.isFinite(stock.price)) stock.history.push(stock.price);
      stock.history = stock.history.slice(-120);
    }
  }

  console.log("Alpaca latest stock seed:", loaded + "/" + names.length,
    names.map(symbol => symbol + "=" + (finite(market[symbol].price) ? market[symbol].price : "MISSING")).join(" "));

  if (!loaded) throw new Error("Alpaca returned no usable latest stock trades or quotes from the " + STOCK_FEED + " feed.");
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
      openInterest: finite(c.open_interest ?? c.openInterest ?? snap.open_interest ?? snap.openInterest) ? Number(c.open_interest ?? c.openInterest ?? snap.open_interest ?? snap.openInterest) : null,
      size: Number(c.size) || 100,
      updatedAt: live.updatedAt || quote.t || trade.t || null,
      feed: OPTION_FEED
    };
  }).filter(x => finite(x.strike));

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


const radarCache = { data: null, at: 0 };

const RADAR_BATCH_SIZE = 100;
const RADAR_OPTION_TARGETS = 12;
const RADAR_CONCURRENCY = 3;

function clamp(n,min,max){return Math.max(min,Math.min(max,n));}

async function getRadar() {
  if (radarCache.data && Date.now() - radarCache.at < 60000) return radarCache.data;

  // Build the radar from the complete active US-equity universe returned by Alpaca.
  // This is intentionally not a hard-coded watchlist.
  const assets = await getAssets();
  const symbols = assets
    .map(a => a.symbol)
    .filter(s => /^[A-Z0-9.\-]{1,20}$/.test(s));

  const chunks = [];
  for (let i = 0; i < symbols.length; i += RADAR_BATCH_SIZE) {
    chunks.push(symbols.slice(i, i + RADAR_BATCH_SIZE));
  }

  const rows = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= chunks.length) return;
      const batch = chunks[index];
      const encoded = encodeURIComponent(batch.join(","));
      try {
        const [quotes, trades] = await Promise.all([
          request(DATA_HOST, "/v2/stocks/quotes/latest?symbols=" + encoded + "&feed=" + encodeURIComponent(STOCK_FEED)),
          request(DATA_HOST, "/v2/stocks/trades/latest?symbols=" + encoded + "&feed=" + encodeURIComponent(STOCK_FEED))
        ]);
        const qmap = quotes?.quotes || {};
        const tmap = trades?.trades || {};

        for (const symbol of batch) {
          const q = qmap[symbol] || {};
          const t = tmap[symbol] || {};
          const last = Number(t.p);
          const ask = Number(q.ap);
          const bid = Number(q.bp);
          const price = finite(last) && last > 0 ? last :
            (finite(ask) && ask > 0 ? ask : (finite(bid) && bid > 0 ? bid : null));
          if (!finite(price) || price <= 0) continue;

          const asset = assets.find(a => a.symbol === symbol);
          rows.push({
            symbol,
            name: asset?.name || symbol,
            exchange: asset?.exchange || "",
            hasOptions: !!asset?.hasOptions,
            price: round(price),
            bid: finite(bid) && bid > 0 ? round(bid) : null,
            ask: finite(ask) && ask > 0 ? round(ask) : null,
            changePct: null,
            intradayPct: null,
            volume: null,
            trend: "MIXED",
            trendScore: 50,
            real: true
          });
        }
      } catch (e) {
        console.error("Radar stock batch", index, e.message);
      }
    }
  }

  await Promise.all(Array.from({length: Math.min(RADAR_CONCURRENCY, chunks.length)}, worker));

  // Get real daily bars only for the stocks that have a usable current quote.
  // Batching keeps the complete-universe scan practical on Alpaca's API limits.
  const barRows = new Map();
  const barChunks = [];
  const pricedSymbols = rows.map(x => x.symbol);
  for (let i = 0; i < pricedSymbols.length; i += RADAR_BATCH_SIZE) {
    barChunks.push(pricedSymbols.slice(i, i + RADAR_BATCH_SIZE));
  }

  cursor = 0;
  async function barWorker() {
    while (true) {
      const index = cursor++;
      if (index >= barChunks.length) return;
      const batch = barChunks[index];
      try {
        const data = await request(
          DATA_HOST,
          "/v2/stocks/bars?symbols=" + encodeURIComponent(batch.join(",")) +
          "&timeframe=1Day&limit=2&feed=" + encodeURIComponent(STOCK_FEED) +
          "&adjustment=raw"
        );
        const bmap = data?.bars || {};
        for (const symbol of batch) {
          const bars = Array.isArray(bmap[symbol]) ? bmap[symbol] : [];
          if (bars.length) barRows.set(symbol, bars);
        }
      } catch (e) {
        console.error("Radar daily-bar batch", index, e.message);
      }
    }
  }

  await Promise.all(Array.from({length: Math.min(RADAR_CONCURRENCY, barChunks.length)}, barWorker));

  for (const row of rows) {
    const bars = barRows.get(row.symbol) || [];
    const latest = bars.length ? bars[bars.length - 1] : null;
    const previous = bars.length > 1 ? bars[bars.length - 2] : null;
    const open = Number(latest?.o);
    const previousClose = Number(previous?.c);
    row.volume = finite(latest?.v) ? Number(latest.v) : null;
    row.intradayPct = finite(row.price) && finite(open) && open > 0
      ? round(((row.price - open) / open) * 100, 2) : null;
    row.changePct = finite(row.price) && finite(previousClose) && previousClose > 0
      ? round(((row.price - previousClose) / previousClose) * 100, 2) : null;
    row.trendScore = finite(row.changePct)
      ? round(clamp(50 + row.changePct * 8 + (finite(row.intradayPct) ? row.intradayPct * 4 : 0), 0, 100), 1)
      : 50;
    row.trend = row.trendScore >= 58 ? "UP" : row.trendScore <= 42 ? "DOWN" : "MIXED";
  }

  rows.sort((a,b) => b.trendScore - a.trendScore);

  // Option analysis is still limited to the most active/current movers so the
  // complete stock universe can be scanned without requesting thousands of chains.
  const optionTargets = rows
    .filter(x => x.hasOptions && finite(x.changePct))
    .sort((a,b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, RADAR_OPTION_TARGETS);

  const setups = [];
  const bigActivity = [];

  for (const row of optionTargets) {
    try {
      const expirations = await getExpirations(row.symbol);
      const expiration = expirations.find(d => {
        const days = (Date.parse(d + "T23:59:59-04:00") - Date.now()) / 86400000;
        return days >= 14 && days <= 45;
      }) || expirations[0];
      if (!expiration) continue;

      const chain = await getOptionChain(row.symbol, expiration);
      const direction = row.trend === "DOWN" ? "put" : "call";
      const candidates = chain.chain.filter(o => {
        if (o.type !== direction || !finite(o.ask) || o.ask <= 0) return false;
        if (!finite(o.strike) || !finite(row.price) || row.price <= 0) return false;
        const moneyness = Math.abs(o.strike - row.price) / row.price;
        const delta = Math.abs(Number(o.delta));
        return moneyness <= 0.10 && (!finite(o.delta) || (delta >= 0.30 && delta <= 0.70));
      });

      const scored = candidates.map(o => {
        const spread = finite(o.bid) && o.bid > 0 && finite(o.ask) ? (o.ask - o.bid) / o.ask : 1;
        const liquidity = Math.min(100, Math.log10(1 + (o.volume || 0)) * 25 + Math.log10(1 + (o.openInterest || 0)) * 10);
        const deltaFit = finite(o.delta) ? 100 - Math.abs(Math.abs(o.delta) - 0.50) * 180 : 50;
        const dte = o.days || 0;
        const dteFit = dte >= 14 && dte <= 45 ? 100 : Math.max(0, 100 - Math.abs(dte - 30) * 3);
        const score = clamp(liquidity * 0.35 + deltaFit * 0.30 + dteFit * 0.20 + (1 - Math.min(1, spread)) * 100 * 0.15, 0, 100);
        const notional = finite(o.ask) ? o.ask * (o.size || 100) * (o.volume || 0) : 0;
        if (notional >= 100000) bigActivity.push({
          symbol: row.symbol, contractSymbol: o.contractSymbol, type: o.type,
          strike: o.strike, expirationDate: o.expirationDate, volume: o.volume,
          openInterest: o.openInterest, notional: round(notional)
        });
        return {...o, setupScore: round(score, 1), spreadPct: round(spread * 100, 2), direction: direction.toUpperCase()};
      }).sort((a,b) => b.setupScore - a.setupScore);

      if (scored[0]) {
        const o = scored[0];
        setups.push({
          symbol: row.symbol, trend: row.trend, trendScore: row.trendScore,
          stockPrice: row.price, changePct: row.changePct,
          contractSymbol: o.contractSymbol, type: o.type, strike: o.strike,
          expirationDate: o.expirationDate, days: o.days, ask: o.ask, bid: o.bid,
          iv: o.iv, delta: o.delta, volume: o.volume, openInterest: o.openInterest,
          spreadPct: o.spreadPct, setupScore: o.setupScore,
          reason: row.trend === "UP" ? "Uptrend + liquid near-ATM call setup"
            : row.trend === "DOWN" ? "Downtrend + liquid near-ATM put setup"
            : "Mixed trend + liquid near-ATM option setup"
        });
      }
    } catch (e) {
      console.error("Radar option scan", row.symbol, e.message);
    }
  }

  const result = {
    updatedAt: Date.now(),
    feed: STOCK_FEED,
    universe: {
      provider: "Alpaca",
      assetClass: "us_equity",
      activeTradableAssets: assets.length,
      quotedStocks: rows.length
    },
    stocks: rows,
    up: rows.filter(x => x.trend === "UP").slice(0, 8),
    down: rows.filter(x => x.trend === "DOWN").sort((a,b) => a.trendScore - b.trendScore).slice(0, 8),
    setups: setups.sort((a,b) => b.setupScore - a.setupScore),
    bigActivity: bigActivity.sort((a,b) => b.notional - a.notional).slice(0, 12),
    methodology: {
      trend: "Current Alpaca quotes/trades plus real daily bars across the complete active tradable US-equity universe.",
      setup: "Option analysis is applied to the most active movers with Alpaca-listed options; the stock radar itself covers the full universe.",
      bigActivity: "Option volume × ask × contract size; this flags large activity, not proven buy-side flow.",
      disclaimer: "Signals are game analytics, not guaranteed returns or financial advice."
    }
  };

  radarCache.data = result;
  radarCache.at = Date.now();
  return result;
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
}
module.exports = { refreshMarket, start, getOptionChain, getExpirations, getNews, publicStock, getOptionLive, getAssets, getStockQuote, getRadar };
