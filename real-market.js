const https = require("https");

const HOST = "query1.finance.yahoo.com";

function fetchQuote(symbol) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: HOST,
      path: "/v8/finance/chart/" + encodeURIComponent(symbol) + "?interval=1m&range=1d",
      headers: { "User-Agent": "Market-City/1.0" }
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("timeout")));
  });
}

async function refreshMarket(market, symbols, round) {
  for (const symbol of Object.keys(symbols)) {
    try {
      const data = await fetchQuote(symbol);
      const result = data.chart?.result?.[0];
      const meta = result?.meta;
      if (!meta) continue;

      const stock = market[symbol];
      const price = Number(meta.regularMarketPrice);
      const previousClose = Number(meta.previousClose ?? meta.chartPreviousClose);
      const open = Number(meta.regularMarketOpen);

      if (!Number.isFinite(price) || price <= 0) continue;

      stock.price = round(price);
      if (Number.isFinite(previousClose)) stock.previousClose = round(previousClose);
      if (Number.isFinite(open)) stock.open = round(open);
      stock.change = stock.previousClose == null ? null : round(stock.price - stock.previousClose);
      stock.changePct = stock.previousClose ? round((stock.change / stock.previousClose) * 100, 2) : null;
      stock.lastTradeAt = Number(meta.regularMarketTime) * 1000 || Date.now();

      const closes = result.indicators?.quote?.[0]?.close || [];
      stock.history = closes
        .filter(v => Number.isFinite(Number(v)))
        .map(v => round(Number(v)))
        .slice(-120);

      if (!stock.history.length) stock.history = [stock.price];
    } catch (err) {
      console.error("Real market update failed for " + symbol + ":", err.message);
    }
  }
}

module.exports = { fetchQuote, refreshMarket };
