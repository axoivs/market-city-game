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
  const usableBars = b.filter(x => Number.isFinite(Number(x.c))).slice(-120);
  const history = usableBars.map(x => Number(x.c));
  const historyDates = usableBars.map(x => x.t);
  if (!finite(price) || price <= 0) throw new Error("Alpaca has no current quote for " + s + ".");
  const asset = assetCache.items.find(a => a.symbol === s);
  return { symbol:s, name:asset?.name || s, price:round(price), bid:finite(bid)&&bid>0?round(bid):null, ask:finite(ask)&&ask>0?round(ask):null, open:null, previousClose:null, change:null, changePct:null, history:history.length?history:[round(price)], historyDates, historyTimeframe:"1Min", updatedAt:t.t||q.t||Date.now(), stream:false, feed:STOCK_FEED, real:true };
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
    const usableBars = realBars.filter(b => Number.isFinite(Number(b.c))).slice(-120);
    const barHistory = usableBars.map(b => Number(b.c));
    if (barHistory.length) {
      stock.history = barHistory;
      stock.historyDates = usableBars.map(b => b.t);
      stock.historyTimeframe = "1Min";
    }
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

// Random cross-industry sampling. Alpaca's asset master does not provide
// a dedicated industry field, so buckets are derived from the real company
// name/ticker and randomized before sampling. This changes scan order only;
// all prices/options/volume remain real Alpaca observations.
const INDUSTRY_RULES = [
  ["Technology", /software|semiconductor|chip|computer|cloud|cyber|data|tech|digital|internet|micro|systems|network/i],
  ["Financial", /bank|banc|capital|financial|finance|insurance|reit|mortgage|credit|asset management|investment/i],
  ["Healthcare", /health|medical|pharma|therapeut|biotech|hospital|diagnostic|clinical|drug/i],
  ["Energy", /energy|oil|gas|petroleum|solar|renewable|power|utility|uranium/i],
  ["Consumer", /retail|restaurant|food|beverage|apparel|fashion|consumer|grocery|home|beauty|travel|hotel/i],
  ["Industrial", /industrial|manufactur|machin|aerospace|defense|airline|transport|logistics|construction|engineering/i],
  ["Communication", /media|broadcast|telecom|wireless|communications|entertainment|streaming/i],
  ["Materials", /chemical|steel|metal|mining|gold|silver|copper|material|lumber|paper|packaging/i]
];

function shuffleArray(arr){
  const out=[...arr];
  for(let i=out.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [out[i],out[j]]=[out[j],out[i]];
  }
  return out;
}

function randomIndustrySample(assets,count){
  const buckets=new Map(INDUSTRY_RULES.map(([name])=>[name,[]]));
  buckets.set("Other",[]);
  for(const asset of assets){
    const text=(asset.name||"")+" "+(asset.symbol||"");
    const match=INDUSTRY_RULES.find(([,re])=>re.test(text));
    buckets.get(match?match[0]:"Other").push(asset);
  }
  const order=shuffleArray([...buckets.keys()]);
  const pools=new Map(order.map(k=>[k,shuffleArray(buckets.get(k))]));
  const result=[];
  while(result.length<Math.min(count,assets.length)){
    let added=false;
    for(const industry of order){
      const pool=pools.get(industry);
      if(pool.length){
        result.push(pool.pop());
        added=true;
        if(result.length>=count) break;
      }
    }
    if(!added) break;
  }
  return result;
}

const RADAR_BATCH_SIZE = 100;
const RADAR_OPTION_TARGETS = 12;
const RADAR_OPTION_CONCURRENCY = 3;
const RADAR_CONCURRENCY = 2;
const OPTION_UNIVERSE_BATCH = 100;
const UNUSUAL_VOLUME_CONCURRENCY = 6;

function clamp(n,min,max){return Math.max(min,Math.min(max,n));}

async function getRadar(options = {}) {
  if (!options.refresh && radarCache.data && Date.now() - radarCache.at < 60000) return radarCache.data;

  // Each fresh Radar scan selects a new 100-stock cross-industry sample.
  const allAssets = await getAssets();
  const assets = randomIndustrySample(
    allAssets.filter(x => x.assetClass === "us_equity" || !x.assetClass),
    100
  );
  const assetMap = new Map(assets.map(a => [a.symbol, a]));
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
        // One snapshot request gives us latest trade/quote plus daily and
        // previous-daily bars. This avoids the old three-request radar scan.
        let snapshots = {};
        try {
          const snap = await request(
            DATA_HOST,
            "/v2/stocks/snapshots?symbols=" + encoded +
            "&feed=" + encodeURIComponent(STOCK_FEED)
          );
          snapshots = snap?.snapshots || {};
        } catch (e) {
          console.error("Radar snapshot batch", index, e.message);
        }

        // Keep a real quote/trade fallback for feeds/assets where snapshots
        // are empty. No prices are fabricated.
        if (!Object.keys(snapshots).length) {
          const [quotes, trades] = await Promise.all([
            request(DATA_HOST, "/v2/stocks/quotes/latest?symbols=" + encoded + "&feed=" + encodeURIComponent(STOCK_FEED)),
            request(DATA_HOST, "/v2/stocks/trades/latest?symbols=" + encoded + "&feed=" + encodeURIComponent(STOCK_FEED))
          ]);
          const qmap = quotes?.quotes || {};
          const tmap = trades?.trades || {};
          for (const symbol of batch) {
            const q = qmap[symbol] || {};
            const t = tmap[symbol] || {};
            snapshots[symbol] = {
              latestTrade: t,
              latestQuote: q
            };
          }
        }

        for (const symbol of batch) {
          const s = snapshots[symbol] || {};
          const q = s.latestQuote || {};
          const t = s.latestTrade || {};
          const daily = s.dailyBar || {};
          const previous = s.prevDailyBar || s.previousDailyBar || {};

          const last = Number(t.p);
          const ask = Number(q.ap);
          const bid = Number(q.bp);
          // Outside regular trading hours an IEX latest quote/trade can be
          // empty. The Alpaca snapshot still contains the real daily close,
          // so use that close rather than showing an empty radar.
          const dailyClose = Number(daily.c);
          const price = finite(last) && last > 0 ? last :
            (finite(ask) && ask > 0 ? ask :
            (finite(bid) && bid > 0 ? bid :
            (finite(dailyClose) && dailyClose > 0 ? dailyClose : null)));
          if (!finite(price) || price <= 0) continue;

          const asset = assetMap.get(symbol);
          const open = Number(daily.o);
          const previousClose = Number(previous.c);
          const volume = Number(daily.v);

          const intradayPct = finite(open) && open > 0
            ? round(((price - open) / open) * 100, 2) : null;
          const changePct = finite(previousClose) && previousClose > 0
            ? round(((price - previousClose) / previousClose) * 100, 2) : null;

          // Alpaca can omit the previous daily bar for some symbols/feeds.
          // When that happens, use the real intraday move as the trend signal
          // instead of turning every stock into an unclassified MIXED row.
          const signalPct = finite(changePct) ? changePct : intradayPct;
          const trendScore = finite(signalPct)
            ? round(clamp(
                50 + signalPct * 8 + (finite(intradayPct) ? intradayPct * 4 : 0),
                0, 100
              ), 1)
            : 50;

          rows.push({
            symbol,
            name: asset?.name || symbol,
            exchange: asset?.exchange || "",
            hasOptions: !!asset?.hasOptions,
            price: round(price),
            bid: finite(bid) && bid > 0 ? round(bid) : null,
            ask: finite(ask) && ask > 0 ? round(ask) : null,
            changePct: finite(changePct) ? changePct : signalPct,
            intradayPct,
            volume: finite(volume) && volume >= 0 ? volume : null,
            trend: trendScore >= 58 ? "UP" : trendScore <= 42 ? "DOWN" : "MIXED",
            trendScore,
            real: true,
            updatedAt: t.t || q.t || daily.t || Date.now()
          });
        }
      } catch (e) {
        console.error("Radar stock batch", index, e.message);
      }
    }
  }

  await Promise.all(
    Array.from({length: Math.min(RADAR_CONCURRENCY, chunks.length)}, worker)
  );

  // Snapshot fields can omit the prior daily bar depending on the
  // symbol/feed. Fetch real 1Day bars in batches so the trend calculation
  // has an independent historical source.
  const dailyBars = new Map();
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
          "&timeframe=1Day&limit=1000&feed=" + encodeURIComponent(STOCK_FEED) +
          "&adjustment=raw"
        );
        const bmap = data?.bars || {};
        for (const symbol of batch) {
          const bars = Array.isArray(bmap[symbol]) ? bmap[symbol] : [];
          if (bars.length) dailyBars.set(symbol, bars);
        }
      } catch (e) {
        console.error("Radar daily-bar batch", index, e.message);
      }
    }
  }

  await Promise.all(
    Array.from({length: Math.min(RADAR_CONCURRENCY, barChunks.length)}, barWorker)
  );

  for (const row of rows) {
    const bars = dailyBars.get(row.symbol) || [];
    const latest = bars.length ? bars[bars.length - 1] : null;
    const previous = bars.length > 1 ? bars[bars.length - 2] : null;

    const latestClose = Number(latest?.c);
    const latestOpen = Number(latest?.o);
    const previousClose = Number(previous?.c);

    // Prefer close-to-previous-close. If only one daily bar exists, use the
    // real current price versus today's real open. No synthetic prices.
    const previousMove = finite(previousClose) && previousClose > 0 &&
      finite(row.price) && row.price > 0
      ? ((row.price - previousClose) / previousClose) * 100
      : null;

    const intradayMove = finite(latestOpen) && latestOpen > 0 &&
      finite(row.price) && row.price > 0
      ? ((row.price - latestOpen) / latestOpen) * 100
      : null;

    const snapshotMove = finite(row.changePct) ? Number(row.changePct) : null;
    const signalPct = finite(previousMove) ? previousMove :
      (finite(snapshotMove) ? snapshotMove :
      (finite(intradayMove) ? intradayMove : null));

    row.changePct = finite(signalPct) ? round(signalPct, 2) : null;
    row.intradayPct = finite(intradayMove) ? round(intradayMove, 2) : row.intradayPct;
    row.volume = finite(latest?.v) ? Number(latest.v) : row.volume;

    row.trendScore = finite(signalPct)
      ? round(clamp(
          50 + signalPct * 8 + (finite(intradayMove) ? intradayMove * 4 : 0),
          0, 100
        ), 1)
      : 50;

    row.trend = row.trendScore >= 58 ? "UP" :
      row.trendScore <= 42 ? "DOWN" : "MIXED";

    row.updatedAt = row.updatedAt || latest?.t || Date.now();
  }

  // Sort by actual observed movement, not by a fabricated score.
  rows.sort((a,b) => {
    const score = Math.abs((b.changePct ?? 0)) - Math.abs((a.changePct ?? 0));
    return score || b.trendScore - a.trendScore || a.symbol.localeCompare(b.symbol);
  });

  const optionTargets = rows
    .filter(x => x.hasOptions && finite(x.changePct))
    .sort((a,b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, RADAR_OPTION_TARGETS);

  const setups = [];
  const bigActivity = [];
  let optionCursor = 0;

  async function optionWorker() {
    while (true) {
      const row = optionTargets[optionCursor++];
      if (!row) return;
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
        if (o.type !== direction) return false;
        // Prefer the real current ask. Outside regular hours Alpaca may have
        // no live ask, so allow the latest real trade as an observed fallback.
        const observedPrice = finite(o.ask) && o.ask > 0 ? o.ask :
          (finite(o.last) && o.last > 0 ? o.last : null);
        if (!finite(observedPrice) || observedPrice <= 0) return false;
        if (!finite(o.strike) || !finite(row.price) || row.price <= 0) return false;
        const moneyness = Math.abs(o.strike - row.price) / row.price;
        const delta = Math.abs(Number(o.delta));
        return moneyness <= 0.10 &&
          (!finite(o.delta) || (delta >= 0.30 && delta <= 0.70));
      });

      const scored = candidates.map(o => {
        const observedPrice = finite(o.ask) && o.ask > 0 ? o.ask :
          (finite(o.last) && o.last > 0 ? o.last : null);
        const spread = finite(o.bid) && o.bid > 0 && finite(o.ask)
          ? (o.ask - o.bid) / o.ask : 1;
        const liquidity = Math.min(
          100,
          Math.log10(1 + (o.volume || 0)) * 25 +
          Math.log10(1 + (o.openInterest || 0)) * 10
        );
        const deltaFit = finite(o.delta)
          ? 100 - Math.abs(Math.abs(o.delta) - 0.50) * 180 : 50;
        const dte = o.days || 0;
        const dteFit = dte >= 14 && dte <= 45
          ? 100 : Math.max(0, 100 - Math.abs(dte - 30) * 3);
        const score = clamp(
          liquidity * 0.35 +
          deltaFit * 0.30 +
          dteFit * 0.20 +
          (1 - Math.min(1, spread)) * 100 * 0.15,
          0, 100
        );
        const notional = finite(observedPrice)
          ? observedPrice * (o.size || 100) * (o.volume || 0) : 0;

        if (notional >= 100000) bigActivity.push({
          symbol: row.symbol,
          contractSymbol: o.contractSymbol,
          type: o.type,
          strike: o.strike,
          expirationDate: o.expirationDate,
          volume: o.volume,
          openInterest: o.openInterest,
          notional: round(notional)
        });

        return {
          ...o,
          setupScore: round(score, 1),
          spreadPct: round(spread * 100, 2),
          observedPrice: round(observedPrice, 2),
          direction: direction.toUpperCase()
        };
      }).sort((a,b) => b.setupScore - a.setupScore);

      if (scored[0]) {
        const o = scored[0];
        setups.push({
          symbol: row.symbol,
          trend: row.trend,
          trendScore: row.trendScore,
          stockPrice: row.price,
          changePct: row.changePct,
          contractSymbol: o.contractSymbol,
          type: o.type,
          strike: o.strike,
          expirationDate: o.expirationDate,
          days: o.days,
          ask: o.ask,
          last: o.last,
          bid: o.bid,
          observedPrice: o.observedPrice,
          iv: o.iv,
          delta: o.delta,
          volume: o.volume,
          openInterest: o.openInterest,
          spreadPct: o.spreadPct,
          setupScore: o.setupScore,
          reason: row.trend === "UP"
            ? "Uptrend + liquid near-ATM call setup"
            : row.trend === "DOWN"
              ? "Downtrend + liquid near-ATM put setup"
              : "Mixed trend + liquid near-ATM option setup"
        });
      }
      } catch (e) {
        console.error("Radar option scan", row.symbol, e.message);
      }
    }
  }

  await Promise.all(
    Array.from({length: Math.min(RADAR_OPTION_CONCURRENCY, optionTargets.length)}, optionWorker)
  );

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
    // Always show the top 10 real movers in each direction. This keeps
    // the Radar useful even when fewer than 10 stocks cross the UP/DOWN
    // signal-score thresholds.
    up: rows
      .filter(x => finite(x.changePct) && x.changePct > 0)
      .sort((a,b) => b.changePct - a.changePct)
      .slice(0, 10)
      .map(x => ({...x, trend: "UP"})),
    down: rows
      .filter(x => finite(x.changePct) && x.changePct < 0)
      .sort((a,b) => a.changePct - b.changePct)
      .slice(0, 10)
      .map(x => ({...x, trend: "DOWN"})),
    setups: setups.sort((a,b) => b.setupScore - a.setupScore),
    bigActivity: bigActivity.sort((a,b) => b.notional - a.notional).slice(0, 12),
    methodology: {
      trend: "Current Alpaca quotes/trades and daily snapshot data across the complete active tradable US-equity universe.",
      setup: "Option analysis is applied to current movers with Alpaca-listed options; the stock radar itself scans the complete stock universe.",
      bigActivity: "Option volume × ask × contract size; this flags large activity, not proven buy-side flow.",
      disclaimer: "Signals are game analytics, not guaranteed returns or financial advice."
    }
  };

  radarCache.data = result;
  radarCache.at = Date.now();
  return result;
}

const outlookCache = { data: null, at: 0 };
const volumeCache = { data: null, at: 0 };

async function getOutlook(days = 30, options = {}) {
  const horizon = [30,60,90,180,365].includes(Number(days)) ? Number(days) : 30;
  if (!getOutlook.cache) getOutlook.cache = new Map();
  const cached = getOutlook.cache.get(horizon);
  if (!options.refresh && cached && Date.now() - cached.at < 120000) return cached.data;

  // Do not depend on Radar's 100-stock sample for long horizons. Long
  // horizons need a fresh universe and enough historical bars for every
  // candidate, otherwise 180/365-day scans can return an empty list.
  const allAssets = await getAssets();
  const optionable = allAssets.filter(x => x.hasOptions);
  const candidates = randomIndustrySample(optionable, Math.min(100, optionable.length));

  // Request the historical window in small multi-symbol batches. This avoids
  // large 180/365-day responses timing out or exhausting the per-response
  // Alpaca bar limit.
  const calendarDays = Math.ceil(horizon * 1.7) + 30;
  const startDate = new Date(Date.now() - calendarDays * 86400000).toISOString();
  const bars = new Map();
  const BAR_BATCH = 20;
  const barChunks = [];
  for (let i=0;i<candidates.length;i+=BAR_BATCH) barChunks.push(candidates.slice(i,i+BAR_BATCH));

  let barCursor=0;
  async function barWorker(){
    while(true){
      const batch=barChunks[barCursor++];
      if(!batch)return;
      const symbols=batch.map(x=>x.symbol);
      try{
        let token="";
        do{
          const q=new URLSearchParams({
            symbols:symbols.join(","),
            timeframe:"1Day",
            start:startDate,
            limit:"10000",
            feed:STOCK_FEED,
            adjustment:"raw",
            sort:"asc"
          });
          if(token)q.set("page_token",token);
          const data=await request(DATA_HOST,"/v2/stocks/bars?"+q.toString());
          const map=data?.bars||{};
          for(const s of symbols){
            const incoming=Array.isArray(map[s])?map[s]:[];
            if(incoming.length)bars.set(s,[...(bars.get(s)||[]),...incoming]);
          }
          token=data?.next_page_token||"";
        }while(token);
      }catch(e){
        console.error("Outlook bars",horizon,batch.map(x=>x.symbol).join(","),e.message);
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(4,barChunks.length)},barWorker));

  // Keep only symbols with enough real daily observations for the requested
  // horizon. For 180/365 days, this is what prevents incomplete histories
  // from silently producing misleading calculations.
  const qualified=candidates.map(stock=>{
    const history=(bars.get(stock.symbol)||[])
      .filter(x=>finite(x.c)&&Number(x.c)>0)
      .sort((a,b)=>String(a.t||"").localeCompare(String(b.t||"")));
    return {stock,history};
  }).filter(x=>x.history.length>=Math.max(20,Math.min(horizon+1, Math.floor(horizon*0.60))));

  const rows=[];
  let optionCursor=0;
  async function optionWorker(){
    while(true){
      const item=qualified[optionCursor++];
      if(!item)return;
      const {stock,history}=item;
      const closes=history.map(x=>Number(x.c));
      const latest=closes.at(-1);
      const targetIndex=Math.max(0,closes.length-(horizon+1));
      const oldHorizon=closes[targetIndex];
      const old30=closes[Math.max(0,closes.length-31)];
      if(!finite(latest)||latest<=0||!finite(oldHorizon)||oldHorizon<=0)continue;

      const returnHorizon=((latest-oldHorizon)/oldHorizon)*100;
      const return30=finite(old30)&&old30>0?((latest-old30)/old30)*100:null;
      const direction=returnHorizon>=0?"call":"put";

      let option=null;
      try{
        const exps=await getExpirations(stock.symbol);
        // Keep the option expiration appropriate to the analysis horizon.
        // For 180/365-day outlooks, prefer longer-dated contracts instead of
        // always falling back to a short 90-day option.
        const targetDays=Math.max(30,Math.min(270,Math.round(horizon*0.25)));
        const exp=exps.find(d=>{
          const dte=(Date.parse(d+"T23:59:59-04:00")-Date.now())/86400000;
          return dte>=targetDays&&dte<=targetDays+60;
        })||exps.find(d=>(Date.parse(d+"T23:59:59-04:00")-Date.now())/86400000>=21)||exps[0];

        if(exp){
          const chain=await getOptionChain(stock.symbol,exp);
          const opts=chain.chain.filter(o=>{
            if(o.type!==direction||!finite(o.strike))return false;
            const observed=finite(o.ask)&&o.ask>0?o.ask:o.last;
            if(!finite(observed)||observed<=0)return false;
            const m=Math.abs(o.strike-latest)/latest;
            const d=finite(o.delta)?Math.abs(o.delta):null;
            return m<=0.10&&(d===null||(d>=0.25&&d<=0.75));
          });
          opts.sort((a,b)=>{
            const ad=finite(a.delta)?Math.abs(a.delta):0,bd=finite(b.delta)?Math.abs(b.delta):0;
            const av=(a.volume||0)+(a.openInterest||0),bv=(b.volume||0)+(b.openInterest||0);
            return ((Math.abs(ad-.50)-Math.abs(bd-.50)))||(bv-av);
          });
          option=opts[0]||null;
        }
      }catch(e){
        console.error("Outlook option lookup",stock.symbol,e.message);
      }

      const momentum=clamp(50+returnHorizon*1.5+Number(return30||0)*.75,0,100);
      const liquidity=option?Math.min(100,Math.log10(1+(option.volume||0))*25+Math.log10(1+(option.openInterest||0))*10):0;
      const spread=option&&finite(option.bid)&&option.bid>0&&finite(option.ask)?(option.ask-option.bid)/option.ask:1;
      const observed=option?(finite(option.ask)&&option.ask>0?option.ask:option.last):null;
      const priceFit=finite(observed)&&observed>0?Math.max(0,100-(observed/latest)*100*8):0;
      const setupScore=round(clamp(momentum*.45+liquidity*.25+(1-Math.min(1,spread))*100*.15+priceFit*.15,0,100),1);

      rows.push({
        symbol:stock.symbol,name:stock.name,price:latest,
        returnPeriod:round(returnHorizon,2),return30:finite(return30)?round(return30,2):null,
        direction:direction.toUpperCase(),trend:returnHorizon>=0?"UP":"DOWN",
        contractSymbol:option?.contractSymbol||null,type:option?.type||direction,
        strike:option?.strike??null,expirationDate:option?.expirationDate||null,
        days:option?.days??null,ask:option?.ask??null,bid:option?.bid??null,
        last:option?.last??null,delta:option?.delta??null,volume:option?.volume??null,
        openInterest:option?.openInterest??null,
        premiumPct:finite(observed)?round((observed/latest)*100,2):null,
        setupScore,historyDays:history.length,real:true
      });
    }
  }

  await Promise.all(Array.from({length:Math.min(4,qualified.length)},optionWorker));
  rows.sort((a,b)=>b.setupScore-a.setupScore);

  const result={
    updatedAt:Date.now(),periodDays:horizon,source:"Alpaca",
    stocks:rows.slice(0,20),
    scannedStocks:candidates.length,
    qualifiedStocks:qualified.length,
    methodology:horizon+"-day real Alpaca daily price history plus current real option pricing, liquidity, spread, delta and premium fit. Long horizons use larger historical windows and longer-dated option expirations. This is a game analytics score, not a guaranteed return prediction."
  };
  getOutlook.cache.set(horizon,{data:result,at:Date.now()});
  return result;
}

async function getUnusualOptionVolume(options = {}) {
  if(!options.refresh && volumeCache.data&&Date.now()-volumeCache.at<120000)return volumeCache.data;

  // Scan a real Alpaca universe of stocks with options. Do not depend only
  // on the Radar's current top movers, because that can hide high-volume
  // option activity in otherwise ordinary stock moves.
  const assets = await getAssets();
  const optionable = assets.filter(x => x.hasOptions);

  // Alpaca's asset master list does not expose an industry/sector field.
  // Build broad industry buckets from the real company names/tickers, then
  // randomize the bucket order and take a balanced sample. This prevents
  // alphabetical ticker ordering from dominating the scan.
  const industryRules = [
    ["Technology", /software|semiconductor|chip|computer|cloud|cyber|data|tech|digital|internet|micro|systems|network/i],
    ["Financial", /bank|banc|capital|financial|finance|insurance|reit|mortgage|credit|asset management|investment/i],
    ["Healthcare", /health|medical|pharma|therapeut|biotech|hospital|diagnostic|clinical|drug/i],
    ["Energy", /energy|oil|gas|petroleum|solar|renewable|power|utility|uranium/i],
    ["Consumer", /retail|restaurant|food|beverage|apparel|fashion|consumer|grocery|home|beauty|travel|hotel/i],
    ["Industrial", /industrial|manufactur|machin|aerospace|defense|airline|transport|logistics|construction|engineering/i],
    ["Communication", /media|broadcast|telecom|wireless|communications|entertainment|streaming/i],
    ["Materials", /chemical|steel|metal|mining|gold|silver|copper|material|lumber|paper|packaging/i]
  ];
  const buckets = new Map(industryRules.map(([name]) => [name, []]));
  buckets.set("Other", []);
  for (const asset of optionable) {
    const text = (asset.name || "") + " " + (asset.symbol || "");
    const match = industryRules.find(([,re]) => re.test(text));
    buckets.get(match ? match[0] : "Other").push(asset);
  }

  const shuffle = arr => {
    const out=[...arr];
    for(let i=out.length-1;i>0;i--){
      const j=Math.floor(Math.random()*(i+1));
      [out[i],out[j]]=[out[j],out[i]];
    }
    return out;
  };

  // Randomize industries first, then rotate through them so one industry
  // cannot consume the entire 100-stock sample.
  const industryOrder = shuffle([...buckets.keys()]);
  const pools = new Map(industryOrder.map(k => [k,shuffle(buckets.get(k))]));
  const symbols = [];
  while (symbols.length < Math.min(100, optionable.length)) {
    let added = false;
    for (const industry of industryOrder) {
      const pool = pools.get(industry);
      if (pool.length) {
        symbols.push(pool.pop().symbol);
        added = true;
        if (symbols.length >= 100) break;
      }
    }
    if (!added) break;
  }

  const rows=[];
  let cursor=0;
  async function worker(){
    while(true){
      const symbol=symbols[cursor++];
      if(!symbol)return;
      try{
        const exps=await getExpirations(symbol);
        const exp=exps.find(d=>{
          const days=(Date.parse(d+"T23:59:59-04:00")-Date.now())/86400000;
          return days>=7&&days<=60;
        })||exps[0];
        if(!exp)continue;
        const chain=await getOptionChain(symbol,exp);
        for(const o of chain.chain){
          if(!finite(o.volume)||o.volume<=0)continue;
          const oi=finite(o.openInterest)&&o.openInterest>0?o.openInterest:null;
          const ratio=oi?o.volume/oi:o.volume;
          const observed=finite(o.ask)&&o.ask>0?o.ask:o.last;
          const notional=finite(observed)&&observed>0?observed*(o.size||100)*o.volume:0;
          rows.push({
            symbol,contractSymbol:o.contractSymbol,type:o.type,strike:o.strike,
            expirationDate:o.expirationDate,days:o.days,volume:o.volume,
            openInterest:o.openInterest,volumeOiRatio:oi?round(ratio,2):null,
            ask:o.ask,bid:o.bid,last:o.last,delta:o.delta,notional:round(notional),
            unusualScore:round(Math.min(100,
              Math.log10(1+o.volume)*20+(oi?Math.min(50,ratio*20):10)
            ),1),
            real:true
          });
        }
      }catch(e){console.error("Unusual option volume",symbol,e.message);}
    }
  }
  await Promise.all(Array.from({length:Math.min(UNUSUAL_VOLUME_CONCURRENCY,symbols.length)},worker));

  const calls=rows.filter(x=>x.type==="call")
    .sort((a,b)=>b.unusualScore-a.unusualScore||b.volume-a.volume).slice(0,20);
  const puts=rows.filter(x=>x.type==="put")
    .sort((a,b)=>b.unusualScore-a.unusualScore||b.volume-a.volume).slice(0,20);
  const result={
    updatedAt:Date.now(),source:"Alpaca",calls,puts,
    methodology:"Ranks real Alpaca option volume using volume, volume/open-interest when available, and observed notional. It does not infer whether trades were buys or sells."
  };
  volumeCache.data=result;volumeCache.at=Date.now();return result;
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
function clearRadarCache(){ radarCache.data=null; radarCache.at=0; }
function clearOutlookCache(days){ if(getOutlook.cache) { if(days) getOutlook.cache.delete(Number(days)); else getOutlook.cache.clear(); } }
function clearUnusualVolumeCache(){ volumeCache.data=null; volumeCache.at=0; }

async function getPredictions(options = {}) {
  if (!options.refresh && getPredictions.cache && Date.now()-getPredictions.cache.at < 120000) return getPredictions.cache.data;

  // Fresh 100-stock cross-industry sample for every prediction refresh.
  const radar = await getRadar({refresh:true});
  const stocks = (radar.stocks||[]).filter(x=>x.hasOptions && finite(x.price) && x.price>0);
  const symbols = stocks.map(x=>x.symbol);

  // Use 90 calendar days so the signal is based on approximately 60+ trading
  // sessions, depending on holidays/weekends.
  const startDate = new Date(Date.now()-100*86400000).toISOString();
  const bars = new Map();

  if(symbols.length){
    let token="";
    do{
      const q=new URLSearchParams({
        symbols:symbols.join(","),
        timeframe:"1Day",
        start:startDate,
        limit:"10000",
        feed:STOCK_FEED,
        adjustment:"raw",
        sort:"asc"
      });
      if(token)q.set("page_token",token);
      try{
        const data=await request(DATA_HOST,"/v2/stocks/bars?"+q.toString());
        for(const s of symbols){
          const incoming=Array.isArray(data?.bars?.[s])?data.bars[s]:[];
          if(incoming.length)bars.set(s,[...(bars.get(s)||[]),...incoming]);
        }
        token=data?.next_page_token||"";
      }catch(e){
        console.error("Prediction history",e.message);
        token="";
      }
    }while(token);
  }

  function regressionSlope(values){
    if(values.length<5)return 0;
    const n=values.length;
    let sx=0,sy=0,sxy=0,sxx=0;
    for(let i=0;i<n;i++){sx+=i;sy+=values[i];sxy+=i*values[i];sxx+=i*i}
    const den=n*sxx-sx*sx;
    return den?(n*sxy-sx*sy)/den:0;
  }

  function stats(stock){
    const history=(bars.get(stock.symbol)||[])
      .filter(x=>finite(x.c)&&Number(x.c)>0)
      .sort((a,b)=>String(a.t||"").localeCompare(String(b.t||"")));
    if(history.length<30)return null;

    const closes=history.map(x=>Number(x.c));
    const latest=closes.at(-1);
    const first=closes[0];
    const return90=((latest-first)/first)*100;
    const recent30Base=closes[Math.max(0,closes.length-31)];
    const return30=((latest-recent30Base)/recent30Base)*100;

    const returns=[];
    for(let i=1;i<closes.length;i++)returns.push((closes[i]/closes[i-1]-1)*100);
    const mean=returns.reduce((a,b)=>a+b,0)/returns.length;
    const variance=returns.reduce((a,b)=>a+(b-mean)**2,0)/Math.max(1,returns.length-1);
    const volatility=Math.sqrt(variance);

    const recentReturns=returns.slice(-20);
    const recentMean=recentReturns.reduce((a,b)=>a+b,0)/Math.max(1,recentReturns.length);
    const upDays=returns.filter(x=>x>0).length/Math.max(1,returns.length);

    let peak=closes[0],maxDrawdown=0;
    for(const price of closes){
      peak=Math.max(peak,price);
      maxDrawdown=Math.min(maxDrawdown,(price/peak-1)*100);
    }

    const slopePct=first>0?(regressionSlope(closes)/first*100*closes.length):0;
    const last10SlopePct=closes.length>=10
      ? regressionSlope(closes.slice(-10))/closes[closes.length-10]*100*10 : 0;

    // Reversal setup: large 90D decline + recent stabilization/rebound + lower
    // short-term slope relative to the longer trend. Momentum setup is the
    // inverse: large advance + weakening recent trend.
    const reboundScore=Math.max(0,Math.min(100,
      (-return90)*1.15 +
      Math.max(0,last10SlopePct)*2 +
      Math.max(0,recentMean)*3 +
      Math.max(0,0.5-upDays)*35 +
      Math.min(20,Math.max(0,-maxDrawdown)*0.35)
    ));
    const pullbackScore=Math.max(0,Math.min(100,
      return90*1.15 +
      Math.max(0,-last10SlopePct)*2 +
      Math.max(0,-recentMean)*3 +
      Math.max(0,upDays-0.5)*35 +
      Math.min(20,Math.max(0,-maxDrawdown)*0.15)
    ));

    return {
      ...stock,price:latest,return90,return30,volatility,
      recentMean,upDays,slopePct,last10SlopePct,maxDrawdown,
      reboundScore,pullbackScore,historyDays:history.length
    };
  }

  const scored=stocks.map(stats).filter(Boolean);
  const reboundCandidates=scored
    .filter(x=>x.return90<0 && x.reboundScore>0)
    .sort((a,b)=>b.reboundScore-a.reboundScore)
    .slice(0,12);
  const pullbackCandidates=scored
    .filter(x=>x.return90>0 && x.pullbackScore>0)
    .sort((a,b)=>b.pullbackScore-a.pullbackScore)
    .slice(0,12);

  async function choose(stock,type,score){
    try{
      const exps=await getExpirations(stock.symbol);
      const exp=exps.find(d=>{
        const days=(Date.parse(d+"T23:59:59-04:00")-Date.now())/86400000;
        return days>=21&&days<=75;
      })||exps[0];
      if(!exp)return null;

      const chain=await getOptionChain(stock.symbol,exp);
      const opts=chain.chain.filter(o=>{
        if(o.type!==type||!finite(o.strike))return false;
        const observed=finite(o.ask)&&o.ask>0?o.ask:o.last;
        if(!finite(observed)||observed<=0)return false;
        const m=Math.abs(o.strike-stock.price)/stock.price;
        const delta=finite(o.delta)?Math.abs(o.delta):null;
        return m<=0.10 && (delta===null || (delta>=0.30&&delta<=0.70));
      });

      opts.sort((a,b)=>{
        const ad=finite(a.delta)?Math.abs(a.delta):0;
        const bd=finite(b.delta)?Math.abs(b.delta):0;
        const av=(a.volume||0)+(a.openInterest||0);
        const bv=(b.volume||0)+(b.openInterest||0);
        const aDelta=(ad>=.30&&ad<=.70)?1:0;
        const bDelta=(bd>=.30&&bd<=.70)?1:0;
        return (bDelta-aDelta)||(bv-av);
      });

      const o=opts[0];
      if(!o)return null;

      return {
        symbol:stock.symbol,name:stock.name,stockPrice:stock.price,
        return90:round(stock.return90,2),return30:round(stock.return30,2),
        volatility:round(stock.volatility,2),upDays:round(stock.upDays*100,1),
        trendSlope:round(stock.slopePct,2),recentSlope:round(stock.last10SlopePct,2),
        signalScore:round(score,1),direction:type,contractSymbol:o.contractSymbol,
        strike:o.strike,expirationDate:o.expirationDate,ask:o.ask,bid:o.bid,
        last:o.last,volume:o.volume,openInterest:o.openInterest,delta:o.delta,
        thesis:type==="call"
          ? "90-day decline with statistical reversal characteristics: recent slope/recent returns are improving relative to the longer trend."
          : "90-day advance with statistical pullback characteristics: recent slope/recent returns are weakening relative to the longer trend.",
        real:true
      };
    }catch(e){
      console.error("Prediction option",stock.symbol,e.message);
      return null;
    }
  }

  let rebound=null,downside=null;
  for(const stock of reboundCandidates){
    rebound=await choose(stock,"call",stock.reboundScore);
    if(rebound)break;
  }
  for(const stock of pullbackCandidates){
    downside=await choose(stock,"put",stock.pullbackScore);
    if(downside)break;
  }

  const result={
    updatedAt:Date.now(),source:"Alpaca",rebound,downside,
    methodology:"Fresh 100-stock cross-industry Alpaca scan using 90-day daily price history. Signals combine 90-day return, recent slope, recent daily returns, up-day ratio, volatility and drawdown, then match the signal to a real current option chain. This is a statistical screening signal, not a guaranteed outcome."
  };
  getPredictions.cache={at:Date.now(),data:result};
  return result;
}

function clearPredictionsCache(){ getPredictions.cache=null; }

module.exports = { refreshMarket, start, getOptionChain, getExpirations, getNews, publicStock, getOptionLive, getAssets, getStockQuote, getRadar, clearRadarCache, getOutlook, clearOutlookCache, getUnusualOptionVolume, clearUnusualVolumeCache, getPredictions, clearPredictionsCache };
