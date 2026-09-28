const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
let playerId = localStorage.getItem("marketCityPlayerId");
if (!playerId) {
  playerId = crypto.randomUUID();
  localStorage.setItem("marketCityPlayerId", playerId);
}
const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "?playerId=" + encodeURIComponent(playerId));
const state = { player: null, market: [], others: [], leaderboard: [], online: 0, selected: "AAPL", options: [] };
const keys = new Set();
const buildings = [
  {x:90,y:100,w:250,h:170,name:"STOCK EXCHANGE",kind:"exchange"},
  {x:405,y:90,w:230,h:180,name:"NEWS CENTER",kind:"news"},
  {x:700,y:95,w:240,h:165,name:"OPTIONS EXCHANGE",kind:"options"},
  {x:1000,y:105,w:270,h:150,name:"BANK",kind:"bank"},
  {x:105,y:390,w:280,h:180,name:"TRADING FLOOR",kind:"trading"},
  {x:455,y:400,w:230,h:170,name:"PLAYER APARTMENTS",kind:"home"},
  {x:760,y:390,w:250,h:180,name:"COMPANY HQ",kind:"hq"},
  {x:1070,y:390,w:190,h:180,name:"RISK DISTRICT",kind:"risk"}
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
  $("greeks").innerHTML=`IV ${o.iv}% · Δ ${o.delta} · Γ ${o.gamma}<br>Θ ${o.theta} · Vega ${o.vega}<br>30-day simulated contract · 100 shares/contract`;
}
function selectSymbol(sym){
  state.selected=sym;
  $("symbol").value=sym;
  const s=selectedStock();
  const cls=s.change>0?"up":s.change<0?"down":"flat";
  $("quote").innerHTML=`<div class="quote-price">${money(s.price)}</div><div class="quote-change ${cls}">${s.change>=0?"+":""}${money(s.change)} (${s.changePct>=0?"+":""}${s.changePct}%)</div>`;
  loadOptions();
}

function drawCity(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle="#0d1620";ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.strokeStyle="#152333";ctx.lineWidth=1;
  for(let x=0;x<canvas.width;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,canvas.height);ctx.stroke()}
  for(let y=0;y<canvas.height;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);ctx.stroke()}
  ctx.fillStyle="#172332";ctx.fillRect(0,300,canvas.width,55);ctx.fillRect(0,615,canvas.width,55);
  ctx.fillStyle="#26384a";ctx.fillRect(0,323,canvas.width,9);ctx.fillRect(0,638,canvas.width,9);
  buildings.forEach((b,i)=>{
    ctx.fillStyle=i%2?"#172330":"#182737";ctx.fillRect(b.x,b.y,b.w,b.h);
    ctx.strokeStyle="#365067";ctx.strokeRect(b.x,b.y,b.w,b.h);
    ctx.fillStyle="#27b3ff";ctx.fillRect(b.x+14,b.y+14,b.w-28,5);
    ctx.fillStyle="#e2e9f2";ctx.font="bold 14px system-ui";ctx.fillText(b.name,b.x+16,b.y+45);
    ctx.fillStyle="#536a80";ctx.font="11px system-ui";ctx.fillText("ENTER",b.x+16,b.y+b.h-18);
    for(let wx=b.x+18;wx<b.x+b.w-20;wx+=30){for(let wy=b.y+62;wy<b.y+b.h-32;wy+=28){ctx.fillStyle="#213c4f";ctx.fillRect(wx,wy,14,11)}}
  });
  ctx.fillStyle="#0b1119";ctx.font="bold 12px system-ui";ctx.fillText("MARKET CITY",24,26);
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
    openDrawer("News Center",`<div class="news-item"><b>Market City Wire</b><span>Markets are simulated in the MVP. Future releases can connect this feed to a licensed real-time market-data provider.</span></div><div class="news-item"><b>Trading Desk</b><span>Watch price movement, compare companies, and practice position sizing without risking real money.</span></div><div class="news-item"><b>Options Brief</b><span>Calls benefit from rising underlying prices; puts benefit from falling prices. Premiums are simulated from volatility and time to expiration.</span></div>`);
  } else if(s==="missions"){
    const m=state.player?.missions||{};
    openDrawer("Missions",`<div class="mission"><span>Complete your first trade</span><b class="${m.firstTrade?"done":""}">${m.firstTrade?"DONE":"+100 XP"}</b></div><div class="mission"><span>Tour Market City</span><b class="${m.cityTour?"done":""}">${m.cityTour?"DONE":"+100 XP"}</b></div><div class="mission"><span>Grow portfolio to $110,000</span><b class="${m.profitGoal?"done":""}">${m.profitGoal?"DONE":"+500 XP"}</b></div>`);
  } else if(s==="leaderboard"){
    openDrawer("Leaderboard",`<table class="table"><thead><tr><th>#</th><th>TRADER</th><th>PORTFOLIO</th><th>LEVEL</th></tr></thead><tbody>${(state.leaderboard||[]).map((p,i)=>`<tr><td>${i+1}</td><td>${p.name}</td><td>${money(p.value)}</td><td>${p.level}</td></tr>`).join("")}</tbody></table>`);
  }
});

setInterval(()=>{ if(state.player) send({type:"move",x:state.player.x,y:state.player.y}); },1000);
loadOptions();
requestAnimationFrame(loop);
