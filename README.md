# Market City

Market City is a 2 stock-market game built around **real Alpaca market data**.

## Data architecture

The game no longer generates simulated stock or option prices.

- **Stocks:** Alpaca real-time WebSocket feed. The default server configuration uses the IEX feed available to Basic market-data accounts.
- **Options:** Alpaca option-chain snapshots provide the real contract list, quotes/trades and Greeks; the Alpaca option WebSocket continuously overlays live option quote/trade updates.
- **News:** Alpaca Market Data news endpoint.
- **Contracts and expirations:** Alpaca Options Contracts API.
- **Trading:** game orders use virtual cash only. The game does not submit orders to Alpaca.
- **Persistence:** player cash, holdings, options and missions are stored locally in `data/players.json`.

Alpaca documents the stock WebSocket as the preferred way to receive current stock pricing, and the option WebSocket as the real-time option pricing stream. urlAlpaca real-time stock datahttps://docs.alpaca.markets/us/docs/real-time-stock-pricing-data urlAlpaca real-time option datahttps://docs.alpaca.markets/us/docs/real-time-option-data

## Environment

Set these on the server; never commit them:

```bash
export ALPACA_API_KEY='YOUR_KEY'
export ALPACA_API_SECRET='YOUR_SECRET'
export ALPACA_TRADING_HOST='paper-api.alpaca.markets'
export ALPACA_STOCK_FEED='iex'
export ALPACA_OPTION_FEED='indicative'
```

Paper Trading credentials use `paper-api.alpaca.markets` for trading API calls while market data uses `data.alpaca.markets`. urlAlpaca authenticationhttps://docs.alpaca.markets/us/docs/authentication

## Run

```bash
npm install
npm run check
npm start
```

Production uses PM2 and Nginx. The browser connects to the application WebSocket over WSS.

## Important

This is a game. It uses **virtual money**. Clicking BUY or SELL does not place a real order with Alpaca.

Real market-data availability depends on the Alpaca feed entitlement and market conditions. For example, Alpaca's free stock market-data offering provides live IEX data, while SIP data requires the corresponding subscription. urlAlpaca market-data FAQhttps://docs.alpaca.markets/us/docs/market-data-faq
