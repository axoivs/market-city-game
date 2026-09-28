const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
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
const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "?playerId=" + encodeURIComponent(playerId));
const state = { player: null, market: [], others: [], leaderboard: [], online: 0, selected: "AAPL", options: [] };
const keys = new Set();
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

async function loadOptions(){
  const r=await fetch("/api/options?symbol="+encodeURIComponent(state.selected));
  const data=await r.json();
  state.options=data.chain||[];
  $("contract").innerHTML=state.options.map((o,i)=>`<option value="${i}">${o.type.toUpperCase()} ${o.strike} · bid ${money(o.bid)} / ask ${money(o.ask)}</option>`).join("");
  renderOptionInfo();
}
function renderOptionInfo(){
  const o=state.options[Number($("contract").value)||0];
  if(!o){$("greeks").textContent="No option chain";return}
  $("greeks").innerHTML=`IV ${o.iv}% · Δ ${o.delta} · Γ ${o.gamma}<br>Θ ${o.theta} · Vega ${o.vega}<br>30-day virtual contract · 100 shares/contract`;
}
function selectSymbol(sym){
  state.selected=sym;
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
function drawCity(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.imageSmoothingEnabled=false;

  // Warm pastel grass-and-stone city base.
  pxRect(0,0,canvas.width,canvas.height,"#7189ad");
  // Main streets and intersections.
  road(0,270,canvas.width,74);
  road(0,650,canvas.width,110);
  road(35,0,88,760);
  road(1270,0,90,760);

  // Sidewalk ribbons around the neighborhoods.
  sidewalk(0,246,canvas.width,24);
  sidewalk(0,344,canvas.width,24);
  sidewalk(0,620,canvas.width,30);
  sidewalk(0,0,34,760);
  sidewalk(123,0,18,760);
  sidewalk(1252,0,18,760);

  // Crosswalks.
  for(let x=245;x<360;x+=22) pxRect(x,337,13,7,"#e8edf1");
  for(let x=880;x<995;x+=22) pxRect(x,337,13,7,"#e8edf1");
  for(let y=548;y<620;y+=18) pxRect(125, y, 8, 12,"#e8edf1");
  for(let y=548;y<620;y+=18) pxRect(1258, y, 8, 12,"#e8edf1");

  // Green parks and planted strips.
  pxRect(0,35,140,190,"#83aa6c","#638b62");
  pxRect(1000,245,250,105,"#83aa6c","#638b62");
  pxRect(0,350,140,255,"#7fa66b","#638b62");
  pxRect(1010,585,245,36,"#80a56b","#638b62");
  flowerBed(145,585,110,25);
  flowerBed(705,585,120,25);
  flowerBed(1015,350,90,22);

  // Paved pedestrian lanes.
  for(let x=420;x<470;x+=12) pxRect(x,350,8,260,"#8295b1");
  for(let x=700;x<745;x+=12) pxRect(x,350,8,260,"#8295b1");
  for(let y=360;y<620;y+=20) pxRect(430,y,30,12,"#91a4bd");

  // City landmarks and street furniture.
  fountain(1120,510);
  for(const t of [[62,55],[95,205],[18,415],[112,535],[1030,300],[1205,305],[1280,585],[965,600],[690,610]]) tree(t[0],t[1],1);
  for(const c of [[205,705,"#ef6f73"],[285,705,"#78a9dc"],[375,705,"#7fca70"],[1145,705,"#ef7d80"],[1215,705,"#7eb5df"]]) car(c[0],c[1],c[2]);
  car(74,390,"#e96f70",true);car(74,455,"#78a9dc",true);car(74,520,"#7fca70",true);
  pxRect(315,600,78,12,"#8a634d","#594c48");
  pxRect(320,604,68,4,"#bd8a63");
  pxRect(1160,255,68,10,"#8a634d","#594c48");

  // Buildings with the chunky, colorful top-down look from the reference.
  buildings.forEach(drawBuilding);

  // Foreground plaza accents.
  flowerBed(425,205,85,24);
  flowerBed(990,205,100,24);
  for(const [x,y] of [[430,225],[705,225],[1020,225],[430,580],[705,580],[1020,580]]) {
    ctx.fillStyle="#c8d5df";ctx.fillRect(x,y,5,5);
    ctx.fillStyle="#6f8ba0";ctx.fillRect(x+1,y-9,3,9);
  }

  // Pixel-art title plaque.
  pxRect(16,14,142,30,"#d4dbe3","#4e6480");
  pxRect(21,19,132,20,"#5d7698","#3c4d67");
  ctx.fillStyle="#f2f4f5";ctx.font="bold 12px monospace";ctx.fillText("MARKET CITY",31,33);

  if(state.player) drawPlayer(state.player,true);
  state.others.forEach(p=>{if(!state.player||p.id!==state.player.id)drawPlayer(p,false)});
}
function drawPlayer(p,me){
  ctx.save();ctx.translate(p.x,p.y);
  ctx.fillStyle="#0008";ctx.beginPath();ctx.ellipse(0,13,12,5,0,0,Math.PI*2);ctx.fill();
  ctx.fillStyle=me?"#27b3ff":"#d16cff";ctx.beginPath();ctx.arc(0,-4,9,0,Math.PI*2);ctx.fill();
  ctx.fillStyle="#f1f6ff";ctx.font="10px system-ui";ctx.textAlign="center";ctx.fillText(p.name,0,-18);
  ctx.restore();
}
function loop(){
  if(state.player){
    let dx=0,dy=0;
    if(keys.has("ArrowLeft")||keys.has("a"))dx-=1;
    if(keys.has("ArrowRight")||keys.has("d"))dx+=1;
    if(keys.has("ArrowUp")||keys.has("w"))dy-=1;
    if(keys.has("ArrowDown")||keys.has("s"))dy+=1;
    if(dx||dy){
      const len=Math.hypot(dx,dy)||1;
      state.player.x=Math.max(25,Math.min(1335,state.player.x+dx/len*3.5));
      state.player.y=Math.max(40,Math.min(755,state.player.y+dy/len*3.5));
      send({type:"move",x:state.player.x,y:state.player.y});
    }
  }
  drawCity(); requestAnimationFrame(loop);
}
window.addEventListener("keydown",e=>{keys.add(e.key);if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"," "].includes(e.key))e.preventDefault()});
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

setInterval(()=>{ if(state.player) send({type:"move",x:state.player.x,y:state.player.y}); },1000);
drawCity();

loadOptions().catch(err => {
  console.error("Market City option chain failed:", err);
  $("greeks").textContent = "Options unavailable until the server connection is ready.";
});

requestAnimationFrame(loop);
