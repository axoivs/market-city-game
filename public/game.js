const chainEl = document.getElementById("optionChain");
const expirationEl = document.getElementById("expirationDates");
const chainSymbolEl = document.getElementById("chainSymbol");
let playerId = localStorage.getItem("marketCityPlayerId");
if (!playerId) {
  if (globalThis.crypto?.randomUUID) {
    playerId = crypto.randomUUID();
  } else if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    playerId = [...bytes].map((b,i) => ([4,6,8,10].includes(i) ? "-" : "") + b.toString(16).padStart(2,"0")).join("");
  } else {
    playerId = "player-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }
  localStorage.setItem("marketCityPlayerId", playerId);
}
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let reconnectGeneration = 0;

const state = {
  player: null,
  market: [],
  others: [],
  leaderboard: [],
  online: 0,
  selected: "AAPL",
  options: []
};

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const generation = ++reconnectGeneration;
  const protocol = location.protocol === "https:" ? "wss://" : "ws://";
  const url = protocol + location.host + "?playerId=" + encodeURIComponent(playerId);

  try {
    ws = new WebSocket(url);
  } catch (err) {
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    if (generation !== reconnectGeneration || ws?.readyState !== WebSocket.OPEN) return;
    reconnectDelay = 1000;
    try {
      ws.send(JSON.stringify({
        type: "hello",
        name: localStorage.getItem("marketCityName") || ""
      }));
    } catch {}
  });

  ws.addEventListener("message", handleSocketMessage);

  ws.addEventListener("error", () => {
    // The close event performs the reconnect. Avoid duplicate error toasts.
  });

  ws.addEventListener("close", () => {
    if (generation !== reconnectGeneration) return;
    ws = null;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  }, reconnectDelay);
}

function handleSocketMessage(event) {
  try {
    const msg = JSON.parse(event.data);

    if (msg.type === "state") {
      state.player = msg.player;
      state.market = msg.market;
      state.leaderboard = msg.leaderboard;
      state.online = msg.online;
      renderAll();
    } else if (msg.type === "market") {
      state.market = msg.market;
      state.leaderboard = msg.leaderboard;
      state.online = msg.online;
      renderWatchlist();
      renderHeader();
      selectSymbol(state.selected);
    } else if (msg.type === "players") {
      state.others = msg.players || [];
    } else if (msg.type === "error") {
      toast(msg.message);
    }
  } catch (err) {
    console.error("Invalid server message:", err);
  }
}

function send(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectWebSocket();
    toast("Connecting to server...");
    return;
  }
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    try { ws.close(); } catch {}
  }
}

connectWebSocket();

$("symbol").onchange=e=>selectSymbol(e.target.value);
$("chainRefresh").onclick=()=>loadOptions().then(()=>toast("Options chain refreshed")).catch(()=>toast("Unable to refresh options chain"));
$("contract").onchange=renderOptionInfo;
$("buyStock").onclick=()=>send({type:"stockOrder",symbol:state.selected,side:"buy",quantity:Number($("shares").value)});
$("sellStock").onclick=()=>send({type:"stockOrder",symbol:state.selected,side:"sell",quantity:Number($("shares").value)});
$("buyOption").onclick=()=>{
  const o=state.options[Number($("contract").value)||0];
  if(o)send({type:"optionOrder",symbol:o.symbol,type:o.type,strike:o.strike,quantity:Number($("contracts").value)});
};
$("nameBtn").onclick=()=>{
  const name=prompt("Choose your trader name:",state.player?.name||"Trader");
  if(name&&name.trim()){localStorage.setItem("marketCityName",name.trim());send({type:"hello",name:name.trim()})}
};

document.querySelectorAll(".tab").forEach(btn=>btn.onclick=()=>{
  document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));btn.classList.add("active");
  $("stockTab").hidden=btn.dataset.tab!=="stock";$("optionsTab").hidden=btn.dataset.tab!=="options";
  if(btn.dataset.tab==="options")loadOptions();
});
const drawer=$("drawer");
function openDrawer(title,html){$("drawerTitle").textContent=title;$("drawerContent").innerHTML=html;drawer.classList.remove("hidden")}
$("closeDrawer").onclick=()=>drawer.classList.add("hidden");
document.querySelectorAll(".menu-btn").forEach(btn=>btn.onclick=()=>{
  document.querySelectorAll(".menu-btn").forEach(x=>x.classList.remove("active"));btn.classList.add("active");
  const s=btn.dataset.screen;
  if(s==="city"){drawer.classList.add("hidden");return}
  if(s==="portfolio"){
    const pos=Object.entries(state.player?.positions||{}).map(([sym,q])=>{const st=state.market.find(x=>x.symbol===sym);return `<tr><td>${sym}</td><td>${q}</td><td>${money(st?.price)}</td><td>${money((st?.price||0)*q)}</td></tr>`}).join("");
    const opts=(state.player?.options||[]).map(o=>`<tr><td>${o.symbol}</td><td>${o.type.toUpperCase()}</td><td>${o.strike}</td><td>${o.quantity}</td><td>${money(o.marketPrice*100*o.quantity)}</td></tr>`).join("");
    openDrawer("Portfolio",`<table class="table"><thead><tr><th>STOCK</th><th>SHARES</th><th>PRICE</th><th>VALUE</th></tr></thead><tbody>${pos||"<tr><td colspan=4>No stock positions yet.</td></tr>"}</tbody></table><h3 style="padding:12px">Options</h3><table class="table"><thead><tr><th>SYMBOL</th><th>TYPE</th><th>STRIKE</th><th>QTY</th><th>VALUE</th></tr></thead><tbody>${opts||"<tr><td colspan=5>No option positions yet.</td></tr>"}</tbody></table>`);
  } else if(s==="news"){
    openDrawer("News Center",`<div class="news-item"><b>Market City Wire</b><span>Stock quotes and recent price movement are pulled from live market data. Quotes may be delayed depending on the upstream data feed.</span></div><div class="news-item"><b>Trading Desk</b><span>Watch price movement, compare companies, and practice position sizing without risking real money.</span></div><div class="news-item"><b>Options Brief</b><span>Calls benefit from rising underlying prices; puts benefit from falling prices. Premiums are simulated from volatility and time to expiration.</span></div>`);
  } else if(s==="missions"){
    const m=state.player?.missions||{};
    openDrawer("Missions",`<div class="mission"><span>Complete your first trade</span><b class="${m.firstTrade?"done":""}">${m.firstTrade?"DONE":"+100 XP"}</b></div><div class="mission"><span>Tour Market City</span><b class="${m.cityTour?"done":""}">${m.cityTour?"DONE":"+100 XP"}</b></div><div class="mission"><span>Grow portfolio to $110,000</span><b class="${m.profitGoal?"done":""}">${m.profitGoal?"DONE":"+500 XP"}</b></div>`);
  } else if(s==="leaderboard"){
    openDrawer("Leaderboard",`<table class="table"><thead><tr><th>#</th><th>TRADER</th><th>PORTFOLIO</th><th>LEVEL</th></tr></thead><tbody>${(state.leaderboard||[]).map((p,i)=>`<tr><td>${i+1}</td><td>${p.name}</td><td>${money(p.value)}</td><td>${p.level}</td></tr>`).join("")}</tbody></table>`);
  }
});

drawCity();

loadOptions().catch(err => {
  console.error("Market City option chain failed:", err);
  $("greeks").textContent = "Options unavailable until the server connection is ready.";
});

