const $=id=>document.getElementById(id);
const state={player:null,market:[],assets:[],selected:"AAPL",options:[],expirations:[],expiration:"",selectedContract:null,leaderboard:[],online:0,marketReady:false,watchlist:null};
let ws=null,reconnectTimer=null,chainSeq=0;
const DEFAULT_WATCHLIST=["AAPL","MSFT","NVDA","AMZN","TSLA","GOOGL","META","JPM"];
function watchlist(){if(state.watchlist===null){try{const x=JSON.parse(localStorage.getItem("marketCityWatchlist")||"null");state.watchlist=Array.isArray(x)&&x.length?x.map(String):[...DEFAULT_WATCHLIST]}catch{state.watchlist=[...DEFAULT_WATCHLIST]}}return state.watchlist}
function watchHas(symbol){return watchlist().includes(String(symbol||"").toUpperCase())}
function saveWatchlistLocal(){localStorage.setItem("marketCityWatchlist",JSON.stringify(watchlist()))}
function saveWatchlistRemote(){if(state.player?.username&&ws?.readyState===WebSocket.OPEN)send({type:"saveWatchlist",watchlist:watchlist()})}
const money=n=>Number.isFinite(Number(n))?"$"+Number(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}):"—";
const px=n=>Number.isFinite(Number(n))?"$"+Number(n).toFixed(2):"—";
const num=n=>n!==null&&n!==undefined&&n!==""&&Number.isFinite(Number(n))?Number(n).toFixed(3):"—";
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const dateLabel=d=>new Date(d+"T12:00:00").toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"});
function toast(m){const e=$("toast");e.textContent=m;e.classList.add("show");clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.remove("show"),2300)}
function api(url,opt){return fetch(url,opt).then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error||"Request failed");return d})}
function getId(){let x=localStorage.getItem("marketCityPlayerId");if(x)return x;if(crypto?.randomUUID)x=crypto.randomUUID();else x="player-"+Date.now()+"-"+Math.random().toString(36).slice(2);localStorage.setItem("marketCityPlayerId",x);return x}
let playerId=getId();
function send(m){if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(m));else toast("Live Alpaca connection is reconnecting.")}
function connect(){clearTimeout(reconnectTimer);ws=new WebSocket("wss://"+location.host+"?playerId="+encodeURIComponent(playerId));ws.onopen=()=>{ $("marketState").textContent="ALPACA STREAM";$("marketState").className="market-state live"};ws.onmessage=e=>handle(JSON.parse(e.data));ws.onerror=()=>{$("marketState").textContent="STREAM ERROR";$("marketState").className="market-state off"};ws.onclose=()=>{ $("marketState").textContent="RECONNECTING";$("marketState").className="market-state off";reconnectTimer=setTimeout(connect,3000)}}
function handle(m){
 if(m.type==="state"||m.type==="market"){if(m.player){state.player=m.player;if(m.player.username&&Array.isArray(m.player.watchlist))state.watchlist=m.player.watchlist}if(m.market)state.market=m.market.filter(x=>watchHas(x.symbol));if(m.leaderboard)state.leaderboard=m.leaderboard;if(Number.isFinite(m.online))state.online=m.online;if(typeof m.marketReady==="boolean")state.marketReady=m.marketReady;renderAll();if(m.type==="state")loadExpirations();return}
 if(m.type==="marketTick"){if(!watchHas(m.stock.symbol))return;const i=state.market.findIndex(x=>x.symbol===m.stock.symbol);if(i<0)state.market.push(m.stock);else state.market[i]=m.stock;renderWatchlist();renderQuote();renderChart();renderTicket();return}
 if(m.type==="optionTick"){const o=state.options.find(x=>x.contractSymbol===m.contractSymbol);if(o){if(m.bid!=null)o.bid=Number(m.bid);if(m.ask!=null)o.ask=Number(m.ask);if(m.last!=null)o.last=Number(m.last);o.mid=Number.isFinite(o.bid)&&Number.isFinite(o.ask)?(o.bid+o.ask)/2:null;o.updatedAt=m.updatedAt;renderChain();renderOptionTicket()}return}
 if(m.type==="error")toast(m.message||"Request failed");
}
function apply(m){if(m.player){state.player=m.player;if(m.player.username&&Array.isArray(m.player.watchlist))state.watchlist=m.player.watchlist}if(m.market)state.market=m.market.filter(x=>watchHas(x.symbol));if(m.leaderboard)state.leaderboard=m.leaderboard;if(Number.isFinite(m.online))state.online=m.online;if(typeof m.marketReady==="boolean")state.marketReady=m.marketReady;renderAll()}
async function bootstrap(){try{apply(await api("/api/bootstrap?playerId="+encodeURIComponent(playerId)+"&_="+Date.now()));try{const a=await api("/api/assets");state.assets=a.assets||[]}catch(e){console.error("Alpaca asset universe:",e.message)}populate();renderWatchlist();renderQuote();renderChart();renderTicket();connect();await loadExpirations()}catch(e){toast(e.message);setTimeout(bootstrap,4000)}}
function stock(){return state.market.find(x=>x.symbol===state.selected)}
function populate(){const s=$("symbol");const q=String($("tickerSearch")?.value||"").trim().toLowerCase();const list=(state.assets.length?state.assets:state.market).filter(x=>!q||x.symbol.toLowerCase().includes(q)||String(x.name||"").toLowerCase().includes(q));s.innerHTML=list.map(x=>'<option value="'+esc(x.symbol)+'">'+esc(x.symbol)+" — "+esc(x.name)+"</option>").join("");s.value=state.selected}
function renderHeader(){const p=state.player;if(!p)return;$("cash").textContent=money(p.cash);$("portfolio").textContent=money(p.portfolioValue);$("level").textContent=p.level;$("nameBtn").textContent=p.name||"GUEST"}
function renderWatchlist(){
  $("watchlist").innerHTML=state.market.map(s=>{
    const c=s.changePct>0?"up":s.changePct<0?"down":"flat";
    return '<div class="watch-row '+(s.symbol===state.selected?"active":"")+'">'+
      '<button class="watch-main" data-symbol="'+esc(s.symbol)+'"><span><span class="sym">'+esc(s.symbol)+'</span><span class="name">'+esc(s.name)+'</span></span>'+
      '<span class="px"><span class="price">'+px(s.price)+'</span><span class="'+c+'">'+(s.changePct==null?"—":(s.changePct>=0?"+":"")+Number(s.changePct).toFixed(2)+"%")+'</span></span></button>'+
      '<button class="watch-remove" data-remove="'+esc(s.symbol)+'" title="Remove '+esc(s.symbol)+'" aria-label="Remove '+esc(s.symbol)+'">×</button>'+
      '</div>';
  }).join("");
  document.querySelectorAll(".watch-main").forEach(b=>b.onclick=()=>selectSymbol(b.dataset.symbol));
  document.querySelectorAll(".watch-remove").forEach(b=>b.onclick=e=>{
    e.stopPropagation();
    const symbol=b.dataset.remove;
    state.market=state.market.filter(x=>x.symbol!==symbol);
    state.watchlist=watchlist().filter(x=>x!==symbol);saveWatchlistLocal();saveWatchlistRemote();
    if(state.selected===symbol){
      state.selected=state.market[0]?.symbol||"";
      if(state.selected) selectSymbol(state.selected);
    }
    renderWatchlist();
    if(!state.market.length) toast("Market Watch is empty. Search for a stock to add it.");
  });
}
function renderQuote(){const s=stock();if(!s)return;$("selectedSymbol").textContent=s.symbol;$("selectedName").textContent=s.name;$("selectedPrice").textContent=px(s.price);$("bid").textContent=px(s.bid);$("ask").textContent=px(s.ask);$("change").textContent=s.change==null?"—":px(s.change)+" "+(s.changePct>=0?"+":"")+Number(s.changePct||0).toFixed(2)+"%";$("change").className=s.change>0?"up":s.change<0?"down":"";$("prevClose").textContent=px(s.previousClose);$("feed").textContent=s.stream?"IEX STREAM":"IEX SNAPSHOT";$("optionSource").textContent="Alpaca "+(s.stream?"live stream":"latest snapshot")+" · real data"}
function renderChart(){const c=$("priceChart"),ctx=c.getContext("2d"),d=devicePixelRatio||1,r=c.getBoundingClientRect(),w=Math.max(300,r.width),h=Math.max(100,r.height);c.width=w*d;c.height=h*d;ctx.setTransform(d,0,0,d,0,0);ctx.clearRect(0,0,w,h);const v=(stock()?.history||[]).filter(Number.isFinite);if(v.length<2){ctx.fillStyle="#62758a";ctx.font="11px sans-serif";ctx.fillText("Waiting for Alpaca price history…",14,28);return}const lo=Math.min(...v),hi=Math.max(...v),range=hi-lo||1,p=18;ctx.strokeStyle="#182737";for(let i=1;i<4;i++){const y=p+i*(h-p*2)/4;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke()}ctx.strokeStyle="#27b5ff";ctx.lineWidth=2;ctx.beginPath();v.forEach((x,i)=>{const xx=p+i*(w-2*p)/Math.max(1,v.length-1),yy=h-p-(x-lo)/range*(h-2*p);i?ctx.lineTo(xx,yy):ctx.moveTo(xx,yy)});ctx.stroke()}
function renderTicket(){const s=stock();$("ticketPrice").textContent=px(s?.price);$("stockPosition").textContent=(state.player?.positions?.[state.selected]||0)+" shares held"}
async function selectSymbol(s){state.selected=s.toUpperCase();state.selectedContract=null;if(!watchHas(state.selected)){watchlist().push(state.selected);saveWatchlistLocal();saveWatchlistRemote()}state.expiration="";let existing=state.market.find(x=>x.symbol===state.selected);if(!existing||!Number.isFinite(Number(existing.price))){try{const m=await api("/api/stock?symbol="+encodeURIComponent(state.selected));const i=state.market.findIndex(x=>x.symbol===state.selected);if(i<0)state.market.push(m.stock);else state.market[i]=m.stock}catch(e){toast(e.message);return}}populate();renderWatchlist();renderQuote();renderChart();renderTicket();await loadExpirations()}
async function loadExpirations(){try{const m=await api("/api/options/expirations?symbol="+encodeURIComponent(state.selected));state.expirations=m.expirations||[];const e=$("expirationDates");e.innerHTML=state.expirations.map(x=>'<option value="'+esc(x)+'">'+dateLabel(x)+'</option>').join("");if(!state.expirations.length){state.options=[];renderChain();return}const today=new Date().toISOString().slice(0,10);const preferred=state.expirations.find(x=>x>today)||state.expirations[0];state.expiration=state.expirations.includes(state.expiration)&&state.expiration>today?state.expiration:preferred;e.value=state.expiration;await loadChain()}catch(e){$("chainStatus").textContent="Alpaca expirations unavailable: "+e.message}}
async function loadChain(){const seq=++chainSeq;$("chainStatus").textContent="Loading real Alpaca quotes, trades and Greeks…";try{const m=await api("/api/options?symbol="+encodeURIComponent(state.selected)+"&expirationDate="+encodeURIComponent(state.expiration));if(seq!==chainSeq)return;state.options=m.chain||[];$("chainStatus").textContent=state.options.length+" real contracts · "+(m.source||"Alpaca")+" · live updates enabled";renderChain();renderOptionTicket()}catch(e){state.options=[];renderChain();$("chainStatus").textContent="Alpaca option chain unavailable: "+e.message}}
function renderChain(){const calls=new Map(state.options.filter(x=>x.type==="call").map(x=>[x.strike,x])),puts=new Map(state.options.filter(x=>x.type==="put").map(x=>[x.strike,x])),strikes=[...new Set(state.options.map(x=>x.strike))].sort((a,b)=>a-b),spot=stock()?.price;let atm=strikes[0];if(Number.isFinite(spot))for(const s of strikes)if(Math.abs(s-spot)<Math.abs(atm-spot))atm=s;if(!strikes.length){$("optionChain").innerHTML='<div style="padding:28px;color:#687c91">No real contracts returned by Alpaca.</div>';return}
 const dash='<td>—</td>'.repeat(10);
 const cell=(o,side)=>{if(!o)return dash;const z=state.selectedContract===o.contractSymbol?" selected":"";const cls="click "+side+z,attr=' data-contract="'+esc(o.contractSymbol)+'"';return '<td class="'+cls+'"'+attr+'>'+px(o.last)+'</td><td class="'+cls+'"'+attr+'>'+px(o.bid)+'</td><td class="'+cls+'"'+attr+'>'+px(o.ask)+'</td><td class="'+cls+'"'+attr+'>'+num(o.delta)+'</td><td class="'+cls+'"'+attr+'>'+num(o.gamma)+'</td><td class="'+cls+'"'+attr+'>'+num(o.theta)+'</td><td class="'+cls+'"'+attr+'>'+num(o.vega)+'</td><td class="'+cls+'"'+attr+'">'+(o.iv==null?"—":Number(o.iv).toFixed(2)+"%")+'</td><td class="'+cls+'"'+attr+'">'+(o.volume==null?"—":Number(o.volume).toLocaleString())+'</td><td class="'+cls+'"'+attr+'">'+(o.openInterest==null?"—":Number(o.openInterest).toLocaleString())+'</td>'};
 const labels=["LAST","BID","ASK","DELTA","GAMMA","THETA","VEGA","IV","VOL","OI"];
 const heads=labels.map(x=>'<th>'+x+'</th>').join("");
 $("optionChain").innerHTML='<table class="chain-table"><thead><tr><th colspan="10" class="call">CALLS</th><th rowspan="2">STRIKE</th><th colspan="10" class="put">PUTS</th></tr><tr>'+heads+'<th class="strike-head"></th>'+heads+'</tr></thead><tbody>'+strikes.map(s=>'<tr class="'+(s===atm?"atm":"")+'">'+cell(calls.get(s),"call")+'<td class="strike">'+px(s)+'</td>'+cell(puts.get(s),"put")+'</tr>').join("")+'</tbody></table>';document.querySelectorAll("[data-contract]").forEach(e=>e.onclick=()=>selectContract(e.dataset.contract))}
function selectContract(s){state.selectedContract=state.options.find(x=>x.contractSymbol===s)||null;document.querySelectorAll(".ticket-tabs button").forEach(x=>x.classList.toggle("active",x.dataset.tab==="option"));$("stockTicket").hidden=true;$("optionTicket").hidden=false;renderChain();renderOptionTicket()}
function renderOptionTicket(){const o=state.selectedContract;if(!o){$("selectedContract").textContent="Select a call or put in the chain.";$("optionDetails").innerHTML="";return}$("selectedContract").innerHTML="<b>"+esc(o.contractSymbol)+"</b><br>Bid "+px(o.bid)+" · Ask "+px(o.ask)+" · Last "+px(o.last);$("optionDetails").innerHTML="Delta "+num(o.delta)+" · Gamma "+num(o.gamma)+" · Theta "+num(o.theta)+" · Vega "+num(o.vega)+"<br>IV "+(o.iv==null?"—":Number(o.iv).toFixed(2)+"%")+" · Volume "+(o.volume==null?"—":Number(o.volume).toLocaleString())+" · OI "+(o.openInterest==null?"—":Number(o.openInterest).toLocaleString())}
function renderAll(){populate();renderHeader();renderWatchlist();renderQuote();renderChart();renderTicket();renderChain();renderOptionTicket()}
function orderStock(side){send({type:"stockOrder",symbol:state.selected,side,quantity:Math.floor(Number($("shares").value))})}
function orderOption(){const o=state.selectedContract;if(!o)return toast("Select an option contract first.");send({type:"optionOrder",symbol:o.symbol,contractSymbol:o.contractSymbol,quantity:Math.floor(Number($("contracts").value)),expirationDate:o.expirationDate})}
function radarStockRow(x){
  const cls=x.trend==="UP"?"up":x.trend==="DOWN"?"down":"flat";
  return '<button class="radar-row radar-click" data-symbol="'+esc(x.symbol)+'"><span><b>'+esc(x.symbol)+'</b><small>'+money(x.price)+'</small></span><span class="radar-right"><b class="'+cls+'">'+(x.changePct>=0?"+":"")+Number(x.changePct||0).toFixed(2)+'%</b><small>'+x.trend+' · '+x.trendScore+'</small></span></button>';
}
function radarSetupRow(x){
  const observed=x.ask!=null?x.ask:x.observedPrice!=null?x.observedPrice:x.last;
  const label=x.ask!=null?"ASK":"LAST";
  return '<button class="radar-row radar-click" data-symbol="'+esc(x.symbol)+'"><span><b>'+esc(x.symbol)+'</b><small>'+esc(x.contractSymbol)+'</small></span><span class="radar-right"><b>'+money(observed)+'</b><small>'+label+' · '+esc(x.type)+' · '+(x.days??"—")+'d · score '+(x.setupScore??"—")+'</small></span></button>';
}
async function openRadar(){
  const d=$("drawer"),b=$("drawerContent");
  d.classList.remove("hidden");$("drawerTitle").textContent="MARKET RADAR";
  b.innerHTML='<div class="drawer-body"><div class="radar-note">REAL-DATA SIGNAL ENGINE. Scores rank current conditions; they do not predict guaranteed returns.</div><div id="radarBody">Loading real market radar…</div></div>';
  try{
    const r=await api("/api/radar");
    const allStocks=Array.isArray(r.stocks)?r.stocks:[];
    const up=(r.up||[]).map(radarStockRow).join("")||(allStocks.slice(0,8).map(radarStockRow).join("")||'<div class="empty">No Alpaca stock data returned.</div>');
    const down=(r.down||[]).map(radarStockRow).join("")||(allStocks.slice(8,16).map(radarStockRow).join("")||'<div class="empty">No additional Alpaca stock data returned.</div>');
    const setups=(r.setups||[]).map(radarSetupRow).join("")||'<div class="empty">No option setup passed the filters.</div>';
    const big=(r.bigActivity||[]).map(x=>'<button class="radar-row radar-click" data-symbol="'+esc(x.symbol)+'"><span><b>'+esc(x.symbol)+'</b><small>'+esc(x.contractSymbol)+'</small></span><span class="radar-right"><b>'+money(x.notional)+'</b><small>'+Number(x.volume||0).toLocaleString()+' volume</small></span></button>').join("")||'<div class="empty">No large-activity flag right now.</div>';
    $("radarBody").innerHTML='<div class="radar-section"><h3>TRENDING UP</h3>'+up+'</div><div class="radar-section"><h3>TRENDING DOWN</h3>'+down+'</div><div class="radar-section"><h3>OPTION SETUP TRACKER</h3><p class="radar-help">Favors liquidity, tighter spreads, near-0.50 delta and 14–45 days to expiration.</p>'+setups+'</div><div class="radar-section"><h3>LARGE OPTION ACTIVITY</h3><p class="radar-help">Flags large notional activity. A trade print does not prove whether it was bought or sold.</p>'+big+'</div><div class="radar-foot">Updated '+new Date(r.updatedAt).toLocaleTimeString()+' · '+esc(r.feed||"Alpaca")+'</div>';
    document.querySelectorAll(".radar-click").forEach(e=>e.onclick=()=>{selectSymbol(e.dataset.symbol);d.classList.add("hidden")});
  }catch(e){$("radarBody").innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
}
async function drawer(screen){
  const d=$("drawer"),b=$("drawerContent");
  d.classList.remove("hidden");
  $("drawerTitle").textContent=screen==="radar"?"MARKET RADAR":screen.toUpperCase();
  if(screen==="profile"){
    const p=state.player||{};
    b.innerHTML='<div class="drawer-body profile-grid"><h3>'+esc(p.name||"Trader")+'</h3><div class="metric-grid"><div><small>CASH</small><b>'+money(p.cash)+'</b></div><div><small>PORTFOLIO</small><b>'+money(p.portfolioValue)+'</b></div><div><small>LEVEL</small><b>'+(p.level||1)+'</b></div><div><small>XP</small><b>'+(p.xp||0)+'</b></div></div><h3>Holdings</h3>'+
      Object.entries(p.positions||{}).map(([s,q])=>'<div class="holding"><span>'+esc(s)+'</span><b>'+q+' shares</b></div>').join("")+
      (p.options||[]).map(o=>'<div class="holding"><span>'+esc(o.contractSymbol)+'</span><b>'+o.quantity+' contracts</b></div>').join("")+
      '</div>';
  }else if(screen==="news"){
    b.innerHTML='<div class="drawer-body">Loading Alpaca news…</div>';
    try{const m=await api("/api/news?symbol="+encodeURIComponent(state.selected));b.innerHTML='<div class="drawer-body">'+(m.news||[]).map(n=>'<div class="news-item"><b>'+esc(n.headline)+'</b><small>'+esc(n.source||"Alpaca")+" · "+new Date(n.createdAt).toLocaleString()+'</small><p>'+esc(n.summary||"")+'</p></div>').join("")+'</div>'}catch(e){b.innerHTML='<div class="drawer-body">'+esc(e.message)+'</div>'}
  }else if(screen==="radar"){await openRadar();return;}else if(screen==="missions"){
    const m=state.player?.missions||{};
    b.innerHTML='<div class="drawer-body">'+[["firstTrade","Complete your first trade"],["cityTour","Explore Market City"],["profitGoal","Reach $110,000 portfolio value"]].map(x=>'<div class="mission"><span>'+x[1]+'</span><b>'+(m[x[0]]?"DONE":"OPEN")+'</b></div>').join("")+'</div>';
  }else{
    b.innerHTML='<div class="drawer-body">'+(state.leaderboard||[]).map((x,i)=>'<div class="holding"><span>#'+(i+1)+" "+esc(x.name)+" · Level "+x.level+'</span><b>'+money(x.value)+'</b></div>').join("")+'</div>';
  }
}
$("symbol").onchange=e=>selectSymbol(e.target.value);$("tickerSearch").oninput=()=>populate();$("tickerSearch").onkeydown=e=>{if(e.key==="Enter"){const first=$("symbol").options[0];if(first)selectSymbol(first.value)}};$("expirationDates").onchange=e=>{state.expiration=e.target.value;loadChain()};$("refreshOptions").onclick=loadChain;$("buyStock").onclick=()=>orderStock("buy");$("sellStock").onclick=()=>orderStock("sell");$("buyOption").onclick=orderOption;$("closeDrawer").onclick=()=>$("drawer").classList.add("hidden");
document.querySelectorAll(".ticket-tabs button").forEach(b=>b.onclick=()=>{document.querySelectorAll(".ticket-tabs button").forEach(x=>x.classList.toggle("active",x===b));$("stockTicket").hidden=b.dataset.tab!=="stock";$("optionTicket").hidden=b.dataset.tab!=="option"});
document.querySelectorAll(".bottom-nav button").forEach(b=>b.onclick=()=>{document.querySelectorAll(".bottom-nav button").forEach(x=>x.classList.toggle("active",x===b));drawer(b.dataset.screen)});
async function accountAction(kind){
  const username=$("accountUsername").value.trim(),code=$("accountCode").value.trim();
  if(!username||code.length<6){$("accountStatus").textContent="Enter a username and a login code (6+ characters).";return}
  $("accountStatus").textContent=kind==="createAccount"?"Creating login…":"Logging in…";
  try{
    const d=await api("/api/action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:kind,playerId,username,code,watchlist:watchlist()})});
    playerId=d.playerId;localStorage.setItem("marketCityPlayerId",playerId);
    if(d.player){state.player=d.player;state.watchlist=Array.isArray(d.player.watchlist)?d.player.watchlist:watchlist();state.market=state.market.filter(x=>watchHas(x.symbol));}
    $("accountModal").classList.add("hidden");$("accountStatus").textContent="";
    if(ws)try{ws.close()}catch{}
    connect();renderAll();loadExpirations();
  }catch(e){$("accountStatus").textContent=e.message}
}
function openAccount(){
  $("accountModal").classList.remove("hidden");
  $("accountUsername").value=state.player?.username||state.player?.name||"";
  $("accountCode").value="";
  $("accountStatus").textContent=state.player?.username?"Market Watch is saved to this login.":"Create a login to save Market Watch.";
  $("logoutBtn").hidden=!state.player?.username;
}
function logout(){localStorage.removeItem("marketCityPlayerId");location.reload()}
$("nameBtn").onclick=openAccount;
$("closeAccount").onclick=()=>$("accountModal").classList.add("hidden");
$("createAccount").onclick=()=>accountAction("createAccount");
$("loginAccount").onclick=()=>accountAction("login");
$("logoutBtn").onclick=logout;
$("accountCode").onkeydown=e=>{if(e.key==="Enter")accountAction("login")};window.addEventListener("resize",renderChart);bootstrap();
