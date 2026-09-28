const https = require("https");
const WebSocket = require("ws");
const { decode } = require("@msgpack/msgpack");

const DATA_HOST = "data.alpaca.markets";
const TRADING_HOST = process.env.ALPACA_TRADING_HOST || "paper-api.alpaca.markets";
const STOCK_FEED = process.env.ALPACA_STOCK_FEED || "iex";
const OPTION_FEED = process.env.ALPACA_OPTION_FEED || "indicative";
const KEY = process.env.ALPACA_API_KEY;
const SECRET = process.env.ALPACA_API_SECRET;
const STOCK_STREAM_HOST = "stream.data.alpaca.markets";
const OPTION_STREAM_HOST = "stream.data.alpaca.markets";
const stockSymbols = new Set();
const optionSymbols = new Set();
let stockStream = null;
let optionStream = null;
let streamMarket = null;
let streamRound = null;
let streamBroadcast = null;
let optionCache = new Map();
let stockReconnectTimer = null;
let optionReconnectTimer = null;

function requireCredentials() {
  if (!KEY || !SECRET) {
    throw new Error("Real market data is not configured: set ALPACA_API_KEY and ALPACA_API_SECRET on the server.");
  }
}

function request(hostname, path) {
  requireCredentials();
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname,
      path,
      headers: {
        "APCA-API-KEY-ID": KEY,
        "APCA-API-SECRET-KEY": SECRET,
        "Accept": "application/json"
      }
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error("Alpaca HTTP " + res.statusCode + " [" + hostname + path.split("?")[0] + "]: " + body.slice(0, 300)));
        }
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("Alpaca request timeout")));
  });
}


function streamAuth(ws) {
  ws.send(JSON.stringify({ action: "auth", key: KEY, secret: SECRET }));
}

function scheduleStockReconnect() {
  if (stockReconnectTimer) return;
  stockReconnectTimer = setTimeout(() => {
    stockReconnectTimer = null;
    connectStockStream();
  }, 3000);
}

function scheduleOptionReconnect() {
  if (optionReconnectTimer) return;
  optionReconnectTimer = setTimeout(() => {
    optionReconnectTimer = null;
    connectOptionStream();
  }, 3000);
}

function connectStockStream() {
  requireCredentials();
  if (stockStream && (stockStream.readyState === WebSocket.OPEN || stockStream.readyState === WebSocket.CONNECTING)) return;
  stockStream = new WebSocket("wss://" + STOCK_STREAM_HOST + "/v2/" + encodeURIComponent(STOCK_FEED));
  stockStream.on("open", () => {
    streamAuth(stockStream);
  });
  stockStream.on("message", raw => {
    try {
      const messages = JSON.parse(raw.toString());
      for (const msg of messages) {
        if (msg.T === "success" && msg.msg === "authenticated") {
          stockStream.send(JSON.stringify({ action: "subscribe", trades: [...stockSymbols], quotes: [...stockSymbols] }));
        } else if (msg.T === "subscription") {
          continue;
        } else if (msg.T === "q" || msg.T === "t") {
          applyStockStreamMessage(msg);
        }
      }
    } catch (err) {
      console.error("Alpaca stock stream message error:", err.message);
    }
  });
  stockStream.on("error", err => console.error("Alpaca stock stream error:", err.message));
  stockStream.on("close", () => {
    stockStream = null;
    scheduleStockReconnect();
  });
}

function applyStockStreamMessage(msg) {
  if (!streamMarket || !streamRound) return;
  const stock = streamMarket[msg.S];
  if (!stock) return;
  const price = msg.T === "q"
    ? (Number.isFinite(Number(msg.ap)) ? Number(msg.ap) : Number(msg.bp))
    : Number(msg.p);
  if (!Number.isFinite(price) || price <= 0) return;
  stock.price = streamRound(price);
  stock.lastTradeAt = msg.t ? new Date(msg.t).getTime() : Date.now();
  stock.realQuoteTime = stock.lastTradeAt;
  stock.stream = true;
  if (streamBroadcast) streamBroadcast();
}

function connectOptionStream() {
  requireCredentials();
  if (optionStream && (optionStream.readyState === WebSocket.OPEN || optionStream.readyState === WebSocket.CONNECTING)) return;
  optionStream = new WebSocket("wss://" + OPTION_STREAM_HOST + "/v1beta1/" + encodeURIComponent(OPTION_FEED));
  optionStream.on("open", () => {
    streamAuth(optionStream);
  });
  optionStream.on("message", raw => {
    try {
      const decoded = decode(Buffer.from(raw));
      const messages = Array.isArray(decoded) ? decoded : [decoded];
      for (const msg of messages) {
        if (!msg || typeof msg !== "object") continue;
        if (msg.T === "success" && msg.msg === "authenticated") {
          if (optionSymbols.size) optionStream.send(JSON.stringify({ action: "subscribe", trades: [...optionSymbols], quotes: [...optionSymbols] }));
        } else if (msg.T === "q" || msg.T === "t") {
          applyOptionStreamMessage(msg);
        }
      }
    } catch (err) {
      console.error("Alpaca option stream message error:", err.message);
    }
  });
  optionStream.on("error", err => console.error("Alpaca option stream error:", err.message));
  optionStream.on("close", () => {
    optionStream = null;
    scheduleOptionReconnect();
  });
}

function applyOptionStreamMessage(msg) {
  const symbol = String(msg.S || "");
  if (!symbol) return;
  const existing = optionCache.get(symbol) || {};
  if (msg.T === "q") {
    existing.bid = Number.isFinite(Number(msg.bp)) ? Number(msg.bp) : existing.bid;
    existing.ask = Number.isFinite(Number(msg.ap)) ? Number(msg.ap) : existing.ask;
    existing.bidSize = Number.isFinite(Number(msg.bs)) ? Number(msg.bs) : existing.bidSize;
    existing.askSize = Number.isFinite(Number(msg.as)) ? Number(msg.as) : existing.askSize;
  } else if (msg.T === "t") {
    existing.last = Number.isFinite(Number(msg.p)) ? Number(msg.p) : existing.last;
    existing.tradeSize = Number.isFinite(Number(msg.s)) ? Number(msg.s) : existing.tradeSize;
  }
  existing.updatedAt = msg.t || existing.updatedAt;
  existing.feed = OPTION_FEED;
  optionCache.set(symbol, existing);
  if (streamBroadcast) streamBroadcast({ type: "optionTick", contractSymbol: symbol, bid: existing.bid ?? null, ask: existing.ask ?? null, last: existing.last ?? null, updatedAt: existing.updatedAt || null });
}

function startRealTimeStreams(market, symbols, round, broadcastFn) {
  streamMarket = market;
  streamRound = round;
  streamBroadcast = broadcastFn;
  Object.keys(symbols).forEach(symbol => stockSymbols.add(symbol));
  connectStockStream();
  connectOptionStream();
}

function subscribeOptionSymbols(contractSymbols) {
  contractSymbols.forEach(symbol => optionSymbols.add(symbol));
  if (optionStream && optionStream.readyState === WebSocket.OPEN) {
    optionStream.send(JSON.stringify({ action: "subscribe", trades: contractSymbols, quotes: contractSymbols }));
  }
}

function getOptionStreamData(symbol) {
  return optionCache.get(symbol) || null;
}

async function refreshMarket(market, symbols, round) {
  const names = Object.keys(symbols);
  const data = await request(
    DATA_HOST,
    "/v2/stocks/snapshots?symbols=" + encodeURIComponent(names.join(",")) + "&feed=" + encodeURIComponent(STOCK_FEED)
  );

  for (const symbol of names) {
    const snap = data.snapshots?.[symbol];
    if (!snap) continue;

    const trade = snap.latestTrade;
    const quote = snap.latestQuote;
    const daily = snap.dailyBar;
    const previous = snap.prevDailyBar;
    const price = Number(trade?.p ?? quote?.ap ?? quote?.bp);

    if (!Number.isFinite(price) || price <= 0) continue;

    const stock = market[symbol];
    stock.price = round(price);
    if (Number.isFinite(Number(previous?.c))) stock.previousClose = round(Number(previous.c));
    if (Number.isFinite(Number(daily?.o))) stock.open = round(Number(daily.o));
    stock.change = Number.isFinite(stock.previousClose) ? round(stock.price - stock.previousClose) : null;
    stock.changePct = Number.isFinite(stock.previousClose) && stock.previousClose
      ? round((stock.change / stock.previousClose) * 100, 2) : null;
    stock.lastTradeAt = trade?.t ? new Date(trade.t).getTime() : Date.now();
    stock.realQuoteTime = quote?.t ? new Date(quote.t).getTime() : stock.lastTradeAt;

    const minute = snap.minuteBar;
    if (minute && Number.isFinite(Number(minute.c))) {
      stock.history = [...(stock.history || []), round(Number(minute.c))].slice(-120);
    } else {
      stock.history = [stock.price];
    }
  }
}

async function fetchContracts(symbol) {
  const contracts = [];
  let pageToken = "";

  do {
    const query = new URLSearchParams({
      underlying_symbols: symbol,
      status: "active",
      expiration_date_gte: new Date().toISOString().slice(0, 10),
      limit: "10000"
    });
    if (pageToken) query.set("page_token", pageToken);

    const data = await request(
      TRADING_HOST,
      "/v2/options/contracts?" + query.toString()
    );

    contracts.push(...(data.option_contracts || []));
    pageToken = data.page_token || "";
  } while (pageToken);

  return contracts;
}

async function fetchOptionSnapshots(symbol, contractSymbols) {
  const snapshots = new Map();

  for (let i = 0; i < contractSymbols.length; i += 100) {
    const batch = contractSymbols.slice(i, i + 100);
    const query = new URLSearchParams({
      symbols: batch.join(","),
      feed: OPTION_FEED,
      limit: String(batch.length)
    });

    let pageToken = "";
    do {
      if (pageToken) query.set("page_token", pageToken);
      const data = await request(
        DATA_HOST,
        "/v1beta1/options/snapshots?" + query.toString()
      );
      for (const [contractSymbol, snapshot] of Object.entries(data.snapshots || {})) {
        snapshots.set(contractSymbol, snapshot);
      }
      pageToken = data.next_page_token || "";
    } while (pageToken);
  }

  return snapshots;
}

async function fetchOptionChain(symbol, round) {
  const contracts = await fetchContracts(symbol);
  if (!contracts.length) return [];

  subscribeOptionSymbols(contracts.map(c => c.symbol));
  const now = Date.now();

  return contracts.map(contract => {
    const live = getOptionStreamData(contract.symbol) || {};
    const bid = Number(live.bid);
    const ask = Number(live.ask);
    const last = Number(live.last);
    const greeks = {};

    const expiration = new Date(contract.expiration_date + "T16:00:00-04:00").getTime();
    const days = Math.max(0, Math.ceil((expiration - now) / 86400000));

    return {
      id: contract.id || contract.symbol,
      symbol,
      contractSymbol: contract.symbol,
      type: contract.type,
      strike: Number(contract.strike_price),
      expiration,
      expirationType: null,
      days,
      iv: Number.isFinite(Number(greeks.iv)) ? Number(greeks.iv) * 100 : null,
      delta: Number.isFinite(Number(greeks.delta)) ? Number(greeks.delta) : null,
      gamma: Number.isFinite(Number(greeks.gamma)) ? Number(greeks.gamma) : null,
      theta: Number.isFinite(Number(greeks.theta)) ? Number(greeks.theta) : null,
      vega: Number.isFinite(Number(greeks.vega)) ? Number(greeks.vega) : null,
      last: Number.isFinite(last) ? round(last) : null,
      bid: Number.isFinite(bid) ? round(bid) : null,
      ask: Number.isFinite(ask) ? round(ask) : null,
      mid: Number.isFinite(bid) && Number.isFinite(ask) ? round((bid + ask) / 2) : null,
      volume: null,
      openInterest: Number.isFinite(Number(contract.open_interest)) ? Number(contract.open_interest) : null,
      size: Number(contract.size) || 100,
      updatedAt: live.updatedAt || null,
      feed: OPTION_FEED
    };
  }).filter(o => Number.isFinite(o.strike) && Number.isFinite(o.expiration));
}

async function refreshOptionPositions(players, round) {
  const positions = [];
  for (const player of Object.values(players)) {
    for (const option of player.options || []) {
      if (option.contractSymbol) positions.push({ player, option });
    }
  }
  if (!positions.length) return;

  const unique = [...new Set(positions.map(x => x.option.contractSymbol))];
  const snapshots = await fetchOptionSnapshots("", unique);

  for (const { option } of positions) {
    const snap = snapshots.get(option.contractSymbol);
    if (!snap) continue;

    const bid = Number(snap.latestQuote?.bp);
    const ask = Number(snap.latestQuote?.ap);
    const last = Number(snap.latestTrade?.p);
    const mark = Number.isFinite(bid) && Number.isFinite(ask)
      ? (bid + ask) / 2
      : Number.isFinite(last) ? last : null;

    if (Number.isFinite(mark)) option.marketPrice = round(mark);
    if (Number.isFinite(option.marketPrice)) {
      option.bid = Number.isFinite(bid) ? round(bid) : option.bid;
      option.ask = Number.isFinite(ask) ? round(ask) : option.ask;
    }

    const greeks = snap.greeks || {};
    if (Number.isFinite(Number(greeks.iv))) option.iv = Number(greeks.iv) * 100;
    if (Number.isFinite(Number(greeks.delta))) option.delta = Number(greeks.delta);
    if (Number.isFinite(Number(greeks.gamma))) option.gamma = Number(greeks.gamma);
    if (Number.isFinite(Number(greeks.theta))) option.theta = Number(greeks.theta);
    if (Number.isFinite(Number(greeks.vega))) option.vega = Number(greeks.vega);
    option.marketDataFeed = OPTION_FEED;
  }
}

module.exports = {
  refreshMarket,
  startRealTimeStreams,
  subscribeOptionSymbols,
  getOptionStreamData,
  fetchOptionChain,
  refreshOptionPositions
};
