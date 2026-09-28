const https = require("https");

const DATA_HOST = "data.alpaca.markets";
const TRADING_HOST = process.env.ALPACA_TRADING_HOST || "paper-api.alpaca.markets";
const STOCK_FEED = process.env.ALPACA_STOCK_FEED || "iex";
const OPTION_FEED = process.env.ALPACA_OPTION_FEED || "indicative";
const KEY = process.env.ALPACA_API_KEY;
const SECRET = process.env.ALPACA_API_SECRET;

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

  const snapshots = await fetchOptionSnapshots(symbol, contracts.map(c => c.symbol));
  const now = Date.now();

  return contracts.map(contract => {
    const snap = snapshots.get(contract.symbol);
    const quote = snap?.latestQuote;
    const trade = snap?.latestTrade;
    const greeks = snap?.greeks || {};

    const expiration = new Date(contract.expiration_date + "T16:00:00-04:00").getTime();
    const days = Math.max(0, Math.ceil((expiration - now) / 86400000));
    const bid = Number(quote?.bp);
    const ask = Number(quote?.ap);
    const last = Number(trade?.p);

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
      updatedAt: quote?.t || trade?.t || null,
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
  fetchOptionChain,
  refreshOptionPositions
};
