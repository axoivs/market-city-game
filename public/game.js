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

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const url = (location.protocol === "https:" ? "wss://" : "ws://")
    + location.host + "?playerId=" + encodeURIComponent(playerId);

  ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    reconnectDelay = 1000;
    toast("Connected");
    send({type:"hello"});
  });

  ws.addEventListener("message", handleSocketMessage);

  ws.addEventListener("error", () => {
    // close will schedule the reconnect; don't spam the UI with duplicate errors.
  });

  ws.addEventListener("close", () => {
    toast("Server connection lost — reconnecting...");
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
  const msg = JSON.parse(event.data);
  if(msg.type==="state"){
    state.player=msg.player;state.market=msg.market;state.leaderboard=msg.leaderboard;state.online=msg.online;
    renderAll();
  } else if(msg.type==="market"){
    state.market=msg.market;state.leaderboard=msg.leaderboard;state.online=msg.online;
    renderWatchlist();renderHeader();selectSymbol(state.selected);
  } else if(msg.type==="players"){
    state.others=msg.players;
  } else if(msg.type==="error"){
    toast(msg.message);
  }
}

connectWebSocket();

const state = { player: null, market: [], others: [], leaderboard: [], online: 0, selected: "AAPL", options: [] };
const keys = new Set();
let moveTarget = null;
const buildings = [
  {x:155,y:72,w:255,h:160,name:"STOCK EXCHANGE",kind:"exchange"},
  {x:455,y:72,w:235,h:160,name:"NEWS CENTER",kind:"news"},
  {x:735,y:72,w:250,h:160,name:"OPTIONS EXCHANGE",kind:"options"},
  {x:1030,y:72,w:225,h:160,name:"BANK",kind:"bank"},
  {x:150,y:385,w:270,h:165,name:"TRADING FLOOR",kind:"trading"},
  {x:470,y:395,w:230,h:175,name:"PLAYER APARTMENTS",kind:"home"},
  {x:750,y:385,w:255,h:175,name:"COMPANY HQ",kind:"hq"},
  {x:1050,y:395,w:205,h:175,name:"RISK DISTRICT",kind:"risk"}
];

const $ = id => document.getElementById(id);
const money = n => "$" + Number(n || 0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
function toast(msg) {
  const el=$("toast"); el.textContent=msg; el.classList.add("show");
  clearTimeout(toast.t); toast.t=setTimeout(()=>el.classList.remove("show"),2200);
}
function send(obj){ if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

function renderWatchlist(){
  $("watchlist").innerHTML = state.market.map(s=>{
    const cls=s.change>0?"up":s.change<0?"down":"flat";
    return `<button class="watch-row" data-symbol="${s.symbol}" style="width:100%;background:none;border:0;color:inherit;text-align:left">
      <span><span class="sym">${s.symbol}</span><span class="name">${s.name}</span></span>
      <span class="px"><span>${money(s.price)}</span><span class="${cls}">${s.changePct>=0?"+":""}${s.changePct}%</span></span>
    </button>`;
  }).join("");
  document.querySelectorAll(".watch-row").forEach(b=>b.onclick=()=>selectSymbol(b.dataset.symbol));
}

function renderHeader(){
  if(!state.player)return;
  $("cash").textContent=money(state.player.cash);
  $("portfolio").textContent=money(state.player.portfolioValue);
  $("level").textContent=state.player.level;
  $("nameBtn").textContent=state.player.name;
  $("online").textContent=state.online+" online";
}

function populateSymbols(){
  $("symbol").innerHTML=state.market.map(s=>`<option value="${s.symbol}">${s.symbol} — ${s.name}</option>`).join("");
  $("symbol").value=state.selected;
}
function selectedStock(){ return state.market.find(s=>s.symbol===state.selected); }
function formatExpiration(ts){return new Date(ts).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"});}
function daysToExpiration(ts){return Math.max(0,Math.ceil((ts-Date.now())/86400000));}
function renderExpirationDates(){
  const ex=[...new Map(state.options.map(o=>[o.expiration,o])).values()].sort((a,b)=>a.expiration-b.expiration);
  expirationEl.innerHTML=ex.map((o,i)=>{
    const type=o.expirationType==="W"?"WEEKLY":o.expirationType==="Q"?"QUARTERLY":o.expirationType==="L"?"LEAPS":"MONTHLY";
    return `<button class="expiration-btn ${i===0?"active":""}" data-exp="${o.expiration}">
      <b>${formatExpiration(o.expiration)}</b><small>${type} · ${daysToExpiration(o.expiration)} days</small>
    </button>`;
  }).join("");
  expirationEl.querySelectorAll(".expiration-btn").forEach(b=>b.onclick=()=>{
    expirationEl.querySelectorAll(".expiration-btn").forEach(x=>x.classList.remove("active"));
    b.classList.add("active");
    renderOptionChain(Number(b.dataset.exp));
  });
}


function renderOptionChain(expiration){
  const rows=state.options.filter(o=>!expiration||o.expiration===expiration).sort((a,b)=>a.strike-b.strike);
  if(!rows.length){chainEl.innerHTML='<div class="chain-loading">No option contracts available.</div>';return;}
  const strikes=[...new Set(rows.map(o=>o.strike))], spot=Number(selectedStock()?.price);
  const fmt=n=>Number.isFinite(Number(n))?Number(n).toFixed(2):"—";
  const cls=n=>Number(n)>0?"positive":Number(n)<0?"negative":"muted";
  const selectedExp=expiration||rows[0].expiration, expLabel=formatExpiration(selectedExp);
  const htmlRows=strikes.map(k=>{
    const c=rows.find(o=>o.strike===k&&o.type==="call"), p=rows.find(o=>o.strike===k&&o.type==="put");
    const atm=Math.abs(spot-k)<Math.max(1,spot*.0125);
    const call=c?[
      `<td class="call-cell" data-contract="${c.id}">${fmt(c.last ?? c.mid)}</td>`,
      `<td class="call-cell" data-contract="${c.id}">${fmt(c.bid)}</td>`,
      `<td class="call-cell" data-contract="${c.id}">${fmt(c.ask)}</td>`,
      `<td class="call-cell" data-contract="${c.id}">${c.iv}%</td>`,
      `<td class="call-cell ${cls(c.delta)}" data-contract="${c.id}">${c.delta}</td>`,
      `<td class="call-cell muted" data-contract="${c.id}">${c.volume??0}</td>`,
      `<td class="call-cell muted" data-contract="${c.id}">${c.openInterest??0}</td>`
    ].join(""):'<td colspan="7" class="muted">—</td>';
    const put=p?[
      `<td class="put-cell ${cls(p.delta)}" data-contract="${p.id}">${p.delta}</td>`,
      `<td class="put-cell" data-contract="${p.id}">${p.iv}%</td>`,
      `<td class="put-cell muted" data-contract="${p.id}">${p.volume??0}</td>`,
      `<td class="put-cell muted" data-contract="${p.id}">${p.openInterest??0}</td>`,
      `<td class="put-cell" data-contract="${p.id}">${fmt(p.bid)}</td>`,
      `<td class="put-cell" data-contract="${p.id}">${fmt(p.ask)}</td>`,
      `<td class="put-cell" data-contract="${p.id}">${fmt(p.last ?? p.mid)}</td>`
    ].join(""):'<td colspan="7" class="muted">—</td>';
    return `<tr class="${atm?"atm":""}" data-strike="${k}">${call}<td class="strike">${k}</td>${put}</tr>`;
  }).join("");
  chainEl.innerHTML=`
    <div class="chain-table-wrap"><table class="chain-table">
      <thead><tr><th colspan="7" class="call-group">CALLS · ${expLabel}</th><th class="strike-head">STRIKE</th><th colspan="7" class="put-group">PUTS · ${expLabel}</th></tr>
      <tr><th>LAST</th><th>BID</th><th>ASK</th><th>DELTA</th><th>VOL</th><th>OPEN INT</th><th class="strike-head">STRIKE</th><th>DELTA</th><th>VOL</th><th>OPEN INT</th><th>BID</th><th>ASK</th><th>LAST</th></tr></thead>
      <tbody>${htmlRows}</tbody></table></div>
    <div class="chain-note"><span>Calls left · puts right · click any contract to load it into the Trading Desk.</span><span>${strikes.length} strikes · ${rows.length} contracts · virtual pricing</span></div>`;
  $("chainSpot").textContent=`${state.selected} ${spot?money(spot):"—"}`;
  chainEl.querySelectorAll("[data-contract]").forEach(cell=>cell.addEventListener("click",()=>selectOptionContract(cell.dataset.contract)));
}
function selectOptionContract(id){
  const index=state.options.findIndex(o=>o.id===id); if(index<0)return;
  $("contract").value=String(index); const o=state.options[index]; renderOptionInfo();
  chainEl.querySelectorAll(".chain-selected").forEach(x=>x.classList.remove("chain-selected"));
  chainEl.querySelectorAll("[data-contract='"+id+"']").forEach(x=>x.classList.add("chain-selected"));
  $("optionsTab").hidden=false; $("stockTab").hidden=true;
  document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x.dataset.tab==="options"));
  toast(`${o.symbol} ${o.strike} ${o.type.toUpperCase()} selected · ask ${money(o.ask)}`);
}

async function loadOptions(){
  const r=await fetch("/api/options?symbol="+encodeURIComponent(state.selected)+"&_="+Date.now(),{cache:"no-store"});
  const data=await r.json(); state.options=data.chain||[];
  renderExpirationDates(); renderOptionChain();
  $("contract").innerHTML=state.options.map((o,i)=>`<option value="${i}">${o.type.toUpperCase()} ${o.strike} · ${formatExpiration(o.expiration)} · ${o.expirationType||"MONTHLY"} · ask ${money(o.ask)}</option>`).join("");
  renderOptionInfo();
}

function renderOptionInfo(){const o=state.options[Number($("contract").value)||0];if(!o){$("greeks").textContent="No option chain";return;}$("greeks").innerHTML=`EXP ${formatExpiration(o.expiration)} · ${daysToExpiration(o.expiration)} days<br>IV ${o.iv}% · Δ ${o.delta} · Γ ${o.gamma}<br>Θ ${o.theta} · Vega ${o.vega}<br>100 shares/contract · virtual pricing`;}
function selectSymbol(sym){
  state.selected=sym;
  if(chainSymbolEl) chainSymbolEl.textContent=sym;
  $("symbol").value=sym;
  const s=selectedStock();
  if(!s){
    $("quote").innerHTML="<div class=\"quote-price\">Waiting for market data…</div>";
    return;
  }
  const cls=s.change>0?"up":s.change<0?"down":"flat";
  const history=Array.isArray(s.history)?s.history.filter(Number.isFinite):[];
  let chart="";
  if(history.length>1){
    const min=Math.min(...history), max=Math.max(...history), span=Math.max(0.0001,max-min);
    const points=history.map((v,i)=>{
      const x=(i/(history.length-1))*180;
      const y=42-((v-min)/span)*36;
      return x.toFixed(1)+","+y.toFixed(1);
    }).join(" ");
    chart=`<svg class="sparkline" viewBox="0 0 180 48" preserveAspectRatio="none" aria-label="Recent real price movement"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
  }
  const updated=s.lastTradeAt?new Date(s.lastTradeAt).toLocaleTimeString():"waiting";
  const changeText=s.change==null?"—":`${s.change>=0?"+":""}${money(s.change)} (${s.changePct>=0?"+":""}${s.changePct}%)`;
  $("quote").innerHTML=`<div class="quote-price">${s.price==null?"Waiting…":money(s.price)}</div><div class="quote-change ${cls}">${changeText}</div>${chart}<div class="quote-meta">REAL MARKET DATA · updated ${updated}</div>`;
  loadOptions();
}

function pxRect(x,y,w,h,fill,stroke){
  ctx.fillStyle=fill;ctx.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h));
  if(stroke){ctx.strokeStyle=stroke;ctx.strokeRect(Math.round(x)+.5,Math.round(y)+.5,Math.round(w)-1,Math.round(h)-1);}
}
function sidewalk(x,y,w,h){
  pxRect(x,y,w,h,"#aebbd0","#8191aa");
  ctx.fillStyle="#c5d0df";
  for(let yy=y+8;yy<y+h;yy+=18) ctx.fillRect(x+4,yy,w-8,2);
}
function road(x,y,w,h){
  pxRect(x,y,w,h,"#344c63","#253b51");
  ctx.fillStyle="#7890a5";
  if(w>h){
    for(let xx=x+12;xx<x+w;xx+=46) ctx.fillRect(xx,y+h/2-2,24,4);
  }else{
    for(let yy=y+12;yy<y+h;yy+=46) ctx.fillRect(x+w/2-2,yy,4,24);
  }
}
function windowTile(x,y,w=22,h=18){
  pxRect(x,y,w,h,"#78b9dd","#405e80");
  pxRect(x+3,y+3,w-6,5,"#a9def0");
  pxRect(x+3,y+h-7,w-6,3,"#4c83aa");
}
function tree(x,y,scale=1){
  ctx.save();ctx.translate(x,y);ctx.scale(scale,scale);
  ctx.fillStyle="#775d45";ctx.fillRect(-3,7,6,14);
  ctx.fillStyle="#3f7f55";ctx.beginPath();ctx.arc(0,2,15,0,Math.PI*2);ctx.fill();
  ctx.fillStyle="#67a866";ctx.beginPath();ctx.arc(-7,-4,9,0,Math.PI*2);ctx.fill();
  ctx.fillStyle="#83ba70";ctx.fillRect(-8,-11,7,5);
  ctx.restore();
}
function car(x,y,body,vertical=false){
  ctx.save();ctx.translate(x,y);
  if(vertical) ctx.rotate(Math.PI/2);
  pxRect(-10,-18,20,36,body,"#31465c");
  pxRect(-7,-11,14,9,"#b5d8e7");
  pxRect(-7,3,14,8,"#8fb9cf");
  ctx.fillStyle="#dbe7ec";ctx.fillRect(-12,-12,3,7);ctx.fillRect(9,-12,3,7);
  ctx.restore();
}
function flowerBed(x,y,w,h){
  pxRect(x,y,w,h,"#4d8a59","#6b7c72");
  for(let xx=x+10;xx<x+w-4;xx+=14){
    ctx.fillStyle=(xx%2?"#f0b6b2":"#e8d17a");ctx.fillRect(xx,y+8,5,5);
    ctx.fillStyle="#9fd06d";ctx.fillRect(xx+2,y+13,3,7);
  }
}
function fountain(x,y){
  ctx.fillStyle="#7088a3";ctx.fillRect(x-32,y-25,64,50);
  ctx.fillStyle="#d6e1e9";ctx.fillRect(x-24,y-17,48,34);
  ctx.fillStyle="#67b6dc";ctx.beginPath();ctx.arc(x,y,17,0,Math.PI*2);ctx.fill();
  ctx.fillStyle="#b5e7f4";ctx.fillRect(x-3,y-24,6,12);ctx.fillRect(x-2,y-12,4,9);
}
function drawBuilding(b,i){
  const palettes=[
    ["#b8c4d6","#6e7e9b","#3e70b7"],
    ["#d5dbe3","#74839d","#4d86c7"],
    ["#c5d0dc","#71829c","#4778b8"],
    ["#d6dce4","#7d8da5","#4c83bf"]
  ][i%4];
  const [wall,roof,accent]=palettes;
  pxRect(b.x,b.y,b.w,b.h,wall,"#566a86");
  pxRect(b.x-5,b.y-5,b.w+10,13,roof,"#445773");
  pxRect(b.x+8,b.y+18,b.w-16,22,accent,"#355779");
  ctx.fillStyle="#eef2f5";ctx.font="bold 12px monospace";ctx.textAlign="center";
  ctx.fillText(b.name,b.x+b.w/2,b.y+33);
  ctx.textAlign="left";
  const cols=Math.max(3,Math.floor((b.w-30)/34));
  for(let row=0;row<3;row++){
    for(let col=0;col<cols;col++){
      const wx=b.x+16+col*34, wy=b.y+54+row*30;
      windowTile(wx,wy,23,19);
    }
  }
  pxRect(b.x+b.w/2-19,b.y+b.h-44,38,44,"#7d5948","#4d4650");
  pxRect(b.x+b.w/2-13,b.y+b.h-38,26,6,"#8dbddd");
  ctx.fillStyle="#cfd8e2";ctx.fillRect(b.x+10,b.y+b.h-8,b.w-20,4);
}
function drawCity(){}
function drawPlayer(p,me){
  ctx.save();ctx.translate(p.x,p.y);
  ctx.fillStyle="#0008";ctx.beginPath();ctx.ellipse(0,13,12,5,0,0,Math.PI*2);ctx.fill();
  ctx.fillStyle=me?"#27b3ff":"#d16cff";ctx.beginPath();ctx.arc(0,-4,9,0,Math.PI*2);ctx.fill();
  ctx.fillStyle="#f1f6ff";ctx.font="10px system-ui";ctx.textAlign="center";ctx.fillText(p.name,0,-18);
  ctx.restore();
}

function loop(){requestAnimationFrame(loop);}
window.addEventListener("keydown",e=>{
  if(["INPUT","SELECT","TEXTAREA"].includes(document.activeElement?.tagName))return;
  keys.add(e.key);
  if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"," "].includes(e.key))e.preventDefault();
  if(keys.size)moveTarget=null;
});
window.addEventListener("keyup",e=>keys.delete(e.key));

ws.addEventListener("open",()=>{
  let saved=localStorage.getItem("marketCityName");
  if(!saved) saved="Trader";
  send({type:"hello",name:saved,playerId});
});
ws.addEventListener("message",e=>{
  const msg=JSON.parse(e.data);
  if(msg.type==="state"){
    state.player=msg.player;state.market=msg.market;state.leaderboard=msg.leaderboard;state.online=msg.online;
    populateSymbols();renderWatchlist();renderHeader();selectSymbol(state.selected);drawCity();
  } else if(msg.type==="market"){
    state.market=msg.market;state.leaderboard=msg.leaderboard;state.online=msg.online;
    renderWatchlist();renderHeader();selectSymbol(state.selected);
  } else if(msg.type==="players"){
    state.others=msg.players;
  } else if(msg.type==="error"){
    toast(msg.message);
  }
});
ws.addEventListener("close",()=>toast("Server connection lost — refreshing connection..."));
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

