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
  AAPL: { name: "Apple" },
  MSFT: { name: "Microsoft" },
  NVDA: { name: "NVIDIA" },
  AMZN: { name: "Amazon" },
  TSLA: { name: "Tesla" },
  GOOGL: { name: "Alphabet" },
  META: { name: "Meta" },
  JPM: { name: "JPMorgan" }
};

const market = {};
for (const [symbol, info] of Object.entries(SYMBOLS)) {
  market[symbol] = {
    symbol,
    name: info.name,
    price: null,
    open: null,
    previousClose: null,
    change: null,
    changePct: null,
    history: []
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

    if (Object.values(players).some(p => (p.options || []).length)) {
      await realMarket.refreshOptionPositions(players, round);
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

async function getRealOptionChain(symbol) {
  return realMarket.fetchOptionChain(symbol, round);
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
  if (!Number.isFinite(stock.price) || stock.price <= 0) throw new Error("No real-time stock quote is currently available.");
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

async function tradeOption(player, payload) {
  const symbol = String(payload.symbol || "").toUpperCase();
  const type = String(payload.type || "").toLowerCase();
  const contractSymbol = String(payload.contractSymbol || "");
  const quantity = Math.floor(safeNumber(payload.quantity, 1));

  if (!["call", "put"].includes(type) || quantity < 1 || quantity > 100) {
    throw new Error("Invalid option order");
  }

  const chain = await realMarket.fetchOptionChain(symbol, round);
  const contract = chain.find(o =>
    o.contractSymbol === contractSymbol &&
    o.type === type
  );

  if (!contract) {
    throw new Error("The selected real option contract is no longer available.");
  }

  const ask = Number(contract.ask);
  if (!Number.isFinite(ask) || ask <= 0) {
    throw new Error("No real-time ask is currently available for this option.");
  }

  const cost = round(ask * quantity * (contract.size || 100));
  if (!Number.isFinite(cost) || cost <= 0) {
    throw new Error("Unable to calculate the real option premium.");
  }

  if (cost > player.cash) {
    throw new Error("Not enough virtual cash for this option order.");
  }

  player.cash -= cost;
  player.options.push({
    id: crypto.randomUUID(),
    symbol,
    contractSymbol: contract.contractSymbol,
    type: contract.type,
    strike: contract.strike,
    quantity,
    expiration: contract.expiration,
    entryPrice: ask,
    marketPrice: ask,
    size: contract.size || 100,
    iv: contract.iv,
    delta: contract.delta,
    gamma: contract.gamma,
    theta: contract.theta,
    vega: contract.vega
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function playerIdFromRequest(value) {
  const id = String(value || "");
  return /^[a-f0-9-]{20,64}$/i.test(id) ? id : crypto.randomUUID();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + req.headers.host);
  if (url.pathname === "/api/bootstrap") {
    const id = playerIdFromRequest(url.searchParams.get("playerId"));
    const player = getPlayer(id);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({
      playerId: id,
      player: publicPlayer(player),
      market: marketPayload(),
      leaderboard: leaderboard(),
      online: sockets.size
    }));
  }

  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, game: "market-city", time: Date.now() }));
  }

  if (url.pathname === "/api/market") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ market: marketPayload(), leaderboard: leaderboard(), online: sockets.size }));
  }

  if (url.pathname === "/api/action" && req.method === "POST") {
    readJsonBody(req).then(body => {
      const id = playerIdFromRequest(body.playerId);
      const player = getPlayer(id);
      const type = String(body.type || "");

      if (type === "hello") {
        const name = String(body.name || "").trim().slice(0, 20);
        if (name) player.name = name.replace(/[^a-zA-Z0-9 _-]/g, "");
      } else if (type === "stockOrder") {
        tradeStock(player, String(body.symbol || "").toUpperCase(), body.side, body.quantity);
      } else if (type === "optionOrder") {
        tradeOption(player, body);
      } else if (type === "tourComplete") {
        completeMission(player, "cityTour");
      } else {
        throw new Error("Unknown action");
      }

      savePlayers();
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        playerId: id,
        player: publicPlayer(player),
        market: marketPayload(),
        leaderboard: leaderboard(),
        online: sockets.size
      }));
    }).catch(err => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message || "Request failed" }));
    });
    return;
  }

  if (url.pathname === "/api/options") {
    const symbol = (url.searchParams.get("symbol") || "AAPL").toUpperCase();
    try {
      const chain = await getRealOptionChain(symbol);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ symbol, chain, source: "Alpaca/OPRA" }));
    } catch (err) {
      console.error("Real option chain failed:", err.message);
      res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: err.message, source: "Alpaca/OPRA" }));
    }
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

  ws.on("message", async raw => {
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
        await tradeOption(player, msg);
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
