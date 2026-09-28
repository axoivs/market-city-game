# Market City

A lightweight 2D multiplayer stock-market simulation game.

## MVP

- 2D financial city built with HTML5 Canvas
- Virtual starting balance of **$100,000**
- Simulated stock market with live-moving prices
- Stock buy/sell trading
- Simulated call and put options
- Portfolio and cash tracking
- Missions and XP
- Multiplayer player positions over WebSockets
- Persistent player state on the server
- No real-money trading

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000.

## Server

The production target is the $6/month DigitalOcean Ubuntu server at `204.48.27.32`.

The server is intentionally dependency-light so it can run comfortably on a 1 GB droplet.

## Market data

The MVP uses a server-side simulated market. A real market-data provider can be connected later through the market adapter without changing the game UI or portfolio engine.

## Project structure

- `server.js` — HTTP API, WebSocket multiplayer, market engine, portfolio engine
- `public/index.html` — game shell
- `public/game.js` — 2D client/gameplay
- `public/style.css` — UI
- `ecosystem.config.cjs` — PM2 configuration
- `nginx/market-city.conf` — production Nginx example

## Important

This is a game/simulation. Trades use virtual money and do not place real securities or options orders.


<!-- real market data integration in progress -->
