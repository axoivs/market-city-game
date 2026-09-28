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

module.exports = { fetchQuote };
