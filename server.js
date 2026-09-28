const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const https = require("https");
const realMarket = require("./real-market");
// Real market-data integration placeholder.

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const PLAYERS_FILE = path.join(DATA_DIR, "players.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

const SYMBOLS = {
  AAPL: { name: "Apple", price: 227.40, volatility: 0.010 },
  MSFT: { name: "Microsoft", price: 509.20, volatility: 0.009 },
  NVDA: { name: "NVIDIA", price: 178.35, volatility: 0.016 },
  AMZN: { name: "Amazon", price: 231.80, volatility: 0.013 },
  TSLA: { name: "Tesla", price: 438.25, volatility: 0.022 },
  GOOGL: { name: "Alphabet", price: 251.10, volatility: 0.012 },
  META: { name: "Meta", price: 754.80, volatility: 0.014 },
  JPM: { name: "JPMorgan", price: 316.70, volatility: 0.009 }
};

const market = {};
for (const [symbol, info] of Object.entries(SYMBOLS)) {
  market[symbol] = {
    symbol,
    name: info.name,
    price: info.price,
    open: info.price,
    previousClose: info.price,
    change: 0,
    changePct: 0,
    history: [info.price]
  };
}

const players = loadPlayers();
const MARKET_DATA_HOST = "query1.finance.yahoo.com";

function fetchRealQuote(symbol) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: MARKET_DATA_HOST,
      path: "/v8/finance/chart/" + encodeURIComponent(symbol) + "?interval=1m&range=1d",
      headers: { "User-Agent": "Market-City/1.0" }
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error("Market data HTTP " + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("Market data timeout")));
  });
}

let marketRefreshInProgress = false;

async function updateRealMarket() {
  if (marketRefreshInProgress) return;
  marketRefreshInProgress = true;
  try {
    await realMarket.refreshMarket(market, SYMBOLS, round);

    for (const player of Object.values(players)) {
    for (const option of player.options) {
      const spot = market[option.symbol]?.price;
      if (Number.isFinite(spot)) option.marketPrice = round(optionValue(option, spot), 2);
    }
  }

    broadcast({
      type: "market",
      market: marketPayload(),
      leaderboard: leaderboard(),
      online: sockets.size
    });
  } finally {
    marketRefreshInProgress = false;
  }
}

const sockets = new Map();
const worldPlayers = new Map();

function loadPlayers() {
  try {
    return JSON.parse(fs.readFileSync(PLAYERS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function savePlayers() {
  const temp = PLAYERS_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(players, null, 2));
  fs.renameSync(temp, PLAYERS_FILE);
}

function newPlayer(id) {
  return {
    id,
    name: "Trader-" + id.slice(-4).toUpperCase(),
    cash: 100000,
    xp: 0,
    level: 1,
    positions: {},
    options: [],
    missions: {
      firstTrade: false,
      cityTour: false,
      profitGoal: false
    },
    x: 680,
    y: 410,
    updatedAt: Date.now()
  };
}

function getPlayer(id) {
  if (!players[id]) {
    players[id] = newPlayer(id);
    savePlayers();
  }
  return players[id];
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(n, digits = 2) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function randomNormal() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function tickMarket() {
  for (const [symbol, stock] of Object.entries(market)) {
    const info = SYMBOLS[symbol];
    const shock = randomNormal() * info.volatility;
    const drift = 0.00005;
    const old = stock.price;
    stock.price = Math.max(1, old * Math.exp(drift + shock));
    stock.change = round(stock.price - stock.previousClose);
    stock.changePct = round((stock.change / stock.previousClose) * 100, 2);
    stock.history.push(round(stock.price, 2));
    if (stock.history.length > 90) stock.history.shift();
  }

  // Options are marked-to-market from the current underlying.
  for (const player of Object.values(players)) {
    for (const option of player.options) {
      option.marketPrice = round(optionValue(option, market[option.symbol].price), 2);
    }
    player.updatedAt = Date.now();
  }
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function optionValue(option, spot) {
  const T = Math.max(0.02, (option.expiration - Date.now()) / 86400000 / 365);
  const sigma = Math.max(0.08, option.iv || 0.30);
  const r = 0.04;
  const K = option.strike;
  const d1 = (Math.log(spot / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const call = spot * normalCdf(d1) - K * Math.exp(-r * T) * normalCdf(d2);
  const put = K * Math.exp(-r * T) * normalCdf(-d2) - spot * normalCdf(-d1);
  return Math.max(0.01, option.type === "call" ? call : put);
}

function normalCdf(x) {
  // Abramowitz-Stegun approximation; works in Node.js without Math.erf.
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * ax);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = sign * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax));
  return 0.5 * (1 + erf);
}

function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function optionGreeks(type, spot, strike, ivPercent, days) {
  const S = Math.max(0.0001, Number(spot));
  const K = Math.max(0.0001, Number(strike));
  const sigma = Math.max(0.01, Number(ivPercent));
  const T = Math.max(1 / 365, Number(days) / 365);
  const r = 0.04;

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const pdf = normalPdf(d1);

  const callDelta = normalCdf(d1);
  const putDelta = callDelta - 1;
  const delta = type === "put" ? putDelta : callDelta;

  const gamma = pdf / (S * sigma * sqrtT);
  const vega = S * pdf * sqrtT / 100;

  const thetaCall =
    (-(S * pdf * sigma) / (2 * sqrtT)
      - r * K * Math.exp(-r * T) * normalCdf(d2)) / 365;

  const thetaPut =
    (-(S * pdf * sigma) / (2 * sqrtT)
      + r * K * Math.exp(-r * T) * normalCdf(-d2)) / 365;

  return {
    delta,
    gamma,
    theta: type === "put" ? thetaPut : thetaCall,
    vega
  };
}

function makeStrikeLadder(spot) {
  // Keep strikes evenly spaced using standard $2.50 / $5 increments.
  // No irregular strike values such as $3.40, $5.90, or $8.40.
  const step = spot <= 250 ? 2.5 : 5;
  const out = new Set();

  const low = Math.max(step, Math.floor((spot * 0.20) / step) * step);
  const high = Math.ceil((spot * 1.80) / step) * step;

  for (let strike = low; strike <= high + step / 2; strike += step) {
    out.add(Number(strike.toFixed(2)));
  }

  return [...out].sort((x, y) => x - y);
}

function makeOptionChain(symbol) {
  const stock = market[symbol];
  if (!stock || !Number.isFinite(stock.price) || stock.price <= 0) return [];

  const strikes = makeStrikeLadder(stock.price);
  const expirations = makeExpirations();
  const contracts = [];

  for (const exp of expirations) {
    const expiration = exp.timestamp;
    const days = exp.days;
    for (const strike of strikes) {
      for (const type of ["call", "put"]) {
        const iv = 0.30;
        const temp = { type, symbol, strike, expiration, iv };
        const mid = optionValue(temp, stock.price);
        const spread = Math.max(0.03, mid * 0.08);
        const greeks = optionGreeks(type, stock.price, strike, iv, days);
        contracts.push({
          id: crypto.createHash("sha1").update(symbol + type + strike + expiration).digest("hex").slice(0, 12),
          symbol, type, strike, expiration, days, expirationType: exp.expirationType,
          iv: round(iv * 100, 1),
          last: round(mid, 2),
          volume: Math.max(0, Math.round(2500 * Math.exp(-Math.abs(strike - stock.price) / Math.max(1, stock.price * 0.08)) + Math.random() * 250)),
          openInterest: Math.max(50, Math.round(12000 * Math.exp(-Math.abs(strike - stock.price) / Math.max(1, stock.price * 0.12)) + Math.random() * 1500)),
          bid: round(Math.max(0.01, mid - spread / 2), 2),
          ask: round(mid + spread / 2, 2),
          mid: round(mid, 2),
          ...Object.fromEntries(Object.entries(greeks).map(([k, v]) => [k, round(v, 4)]))
        });
      }
    }
  }
  return contracts;
}

function portfolioValue(player) {
  let value = player.cash;
  for (const [symbol, shares] of Object.entries(player.positions)) {
    if (market[symbol]) value += shares * market[symbol].price;
  }
  for (const option of player.options) {
    value += option.marketPrice * option.quantity * 100;
  }
  return round(value, 2);
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    cash: round(player.cash),
    portfolioValue: portfolioValue(player),
    xp: player.xp,
    level: player.level,
    positions: player.positions,
    options: player.options.map(o => ({
      id: o.id, symbol: o.symbol, type: o.type, strike: o.strike,
      quantity: o.quantity, marketPrice: o.marketPrice,
      expiration: o.expiration
    })),
    missions: player.missions,
    x: player.x,
    y: player.y
  };
}

function completeMission(player, mission) {
  if (player.missions[mission]) return;
  player.missions[mission] = true;
  player.xp += mission === "profitGoal" ? 500 : 100;
  player.level = 1 + Math.floor(player.xp / 500);
}

function tradeStock(player, symbol, side, quantity) {
  const stock = market[symbol];
  if (!stock) throw new Error("Unknown symbol");
  quantity = Math.floor(quantity);
  if (quantity < 1 || quantity > 100000) throw new Error("Invalid quantity");
  const gross = round(stock.price * quantity);
  if (side === "buy") {
    if (gross > player.cash) throw new Error("Not enough virtual cash");
    player.cash -= gross;
    player.positions[symbol] = (player.positions[symbol] || 0) + quantity;
  } else if (side === "sell") {
    if ((player.positions[symbol] || 0) < quantity) throw new Error("Not enough shares");
    player.positions[symbol] -= quantity;
    player.cash += gross;
    if (player.positions[symbol] === 0) delete player.positions[symbol];
  } else {
    throw new Error("Invalid side");
  }
  completeMission(player, "firstTrade");
  if (portfolioValue(player) >= 110000) completeMission(player, "profitGoal");
  player.updatedAt = Date.now();
  savePlayers();
}

function tradeOption(player, payload) {
  const symbol = String(payload.symbol || "").toUpperCase();
  const type = String(payload.type || "").toLowerCase();
  const strike = safeNumber(payload.strike);
  const quantity = Math.floor(safeNumber(payload.quantity, 1));
  const stock = market[symbol];

  if (!stock || !["call", "put"].includes(type) || !Number.isFinite(strike) || strike <= 0 ||
      quantity < 1 || quantity > 100) {
    throw new Error("Invalid option order");
  }

  if (!Number.isFinite(stock.price) || stock.price <= 0) {
    throw new Error("The live stock price is still loading. Please try again in a few seconds.");
  }

  // Keep option pricing stable and independent of the old simulated-volatility fields.
  const iv = 0.30;
  const expiration = Date.now() + 30 * 86400000;
  const temp = { type, symbol, strike, expiration, iv };
  const mid = optionValue(temp, stock.price);

  if (!Number.isFinite(mid) || mid <= 0) {
    throw new Error("Unable to price this option from the current market quote.");
  }

  const ask = round(mid * 1.04 + 0.02, 2);
  const cost = round(ask * quantity * 100);

  if (!Number.isFinite(cost) || cost <= 0) {
    throw new Error("Unable to calculate the option premium.");
  }
  if (cost > player.cash) {
    throw new Error("Not enough virtual cash for this option order.");
  }

  player.cash -= cost;
  player.options.push({
    id: crypto.randomUUID(),
    symbol,
    type,
    strike,
    quantity,
    expiration,
    iv,
    entryPrice: ask,
    marketPrice: ask
  });

  completeMission(player, "firstTrade");
  player.updatedAt = Date.now();
  savePlayers();
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const ws of sockets.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(message);
  }
}

function marketPayload() {
  return Object.values(market).map(stock => ({
    symbol: stock.symbol,
    name: stock.name,
    price: stock.price == null ? null : round(stock.price),
    open: stock.open == null ? null : round(stock.open),
    previousClose: stock.previousClose == null ? null : round(stock.previousClose),
    change: stock.change == null ? null : round(stock.change),
    changePct: stock.changePct == null ? null : round(stock.changePct, 2),
    history: stock.history,
    lastTradeAt: stock.lastTradeAt,
    real: true
  }));
}

function leaderboard() {
  return Object.values(players)
    .map(p => ({ name: p.name, value: portfolioValue(p), level: p.level }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
}

function sendState(ws, player) {
  send(ws, {
    type: "state",
    player: publicPlayer(player),
    market: marketPayload(),
    leaderboard: leaderboard(),
    online: sockets.size
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://" + req.headers.host);
  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, game: "market-city", time: Date.now() }));
  }

  if (url.pathname === "/api/market") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ market: marketPayload(), leaderboard: leaderboard(), online: sockets.size }));
  }

  if (url.pathname === "/api/options") {
    const symbol = (url.searchParams.get("symbol") || "AAPL").toUpperCase();
    const chain = makeOptionChain(symbol);
    if (!chain) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Unknown symbol" }));
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ symbol, chain }));
  }

  let filePath = url.pathname === "/" ? path.join(PUBLIC, "index.html") : path.join(PUBLIC, url.pathname);
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    const ext = path.extname(filePath);
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
wss.on("connection", (ws, req) => {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  const candidate = requestUrl.searchParams.get("playerId") || "";
  const id = /^[a-f0-9-]{20,64}$/i.test(candidate) ? candidate : crypto.randomUUID();

  // If the same trader reconnects, replace the old socket without creating
  // a second player identity or losing the saved portfolio.
  const previous = sockets.get(id);
  if (previous && previous !== ws) {
    try { previous.close(); } catch {}
  }

  const player = getPlayer(id);
  sockets.set(id, ws);
  worldPlayers.set(id, { id, name: player.name, x: player.x, y: player.y });

  sendState(ws, player);
  broadcast({ type: "players", players: [...worldPlayers.values()] });

  ws.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "hello") {
        const requested = String(msg.name || "").trim().slice(0, 20);
        if (requested) player.name = requested.replace(/[^a-zA-Z0-9 _-]/g, "");
        savePlayers();
        sendState(ws, player);
        return;
      }

      if (msg.type === "move") {
        player.x = Math.max(20, Math.min(1340, safeNumber(msg.x, player.x)));
        player.y = Math.max(20, Math.min(760, safeNumber(msg.y, player.y)));
        const wp = worldPlayers.get(id);
        if (wp) {
          wp.name = player.name;
          wp.x = player.x;
          wp.y = player.y;
        }
        return;
      }

      if (msg.type === "stockOrder") {
        tradeStock(player, String(msg.symbol).toUpperCase(), msg.side, msg.quantity);
        sendState(ws, player);
        return;
      }

      if (msg.type === "optionOrder") {
        tradeOption(player, msg);
        sendState(ws, player);
        return;
      }

      if (msg.type === "tourComplete") {
        completeMission(player, "cityTour");
        savePlayers();
        sendState(ws, player);
        return;
      }
    } catch (err) {
      send(ws, { type: "error", message: err.message || "Request failed" });
    }
  });

  ws.on("close", () => {
    sockets.delete(id);
    worldPlayers.delete(id);
    savePlayers();
    broadcast({ type: "players", players: [...worldPlayers.values()] });
  });
});

updateRealMarket();
setInterval(updateRealMarket, 2000);

setInterval(savePlayers, 15000);

server.listen(PORT, HOST, () => {
  console.log(`Market City running on http://${HOST}:${PORT}`);
});
