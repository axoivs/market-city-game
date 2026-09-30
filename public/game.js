const $=id=>document.getElementById(id);
const state={player:null,market:[],assets:[],selected:"",options:[],expirations:[],expiration:"",selectedContract:null,leaderboard:[],online:0,marketReady:false,watchlist:null,optionWatchlist:null};
let ws=null,reconnectTimer=null,chainSeq=0;
const DEFAULT_WATCHLIST=["AAPL","MSFT","NVDA","AMZN","TSLA","GOOGL","META","JPM"];
function watchlist(){if(state.watchlist===null){try{const x=JSON.parse(localStorage.getItem("marketCityWatchlist")||"null");state.watchlist=Array.isArray(x)&&x.length?x.map(String):[...DEFAULT_WATCHLIST]}catch{state.watchlist=[...DEFAULT_WATCHLIST]}}return state.watchlist}
function optionWatchlist(){if(state.optionWatchlist===null){try{const x=JSON.parse(localStorage.getItem("marketCityOptionWatchlist")||"[]");state.optionWatchlist=Array.isArray(x)?x:[]}catch{state.optionWatchlist=[]}}return state.optionWatchlist}
function saveOptionWatchlist(){localStorage.setItem("marketCityOptionWatchlist",JSON.stringify(optionWatchlist()))}
function optionWatchHas(symbol){return optionWatchlist().some(x=>x.contractSymbol===symbol)}
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
function connect(){clearTimeout(reconnectTimer);ws=new WebSocket("wss://"+location.host+"?playerId="+encodeURIComponent(playerId));ws.onopen=()=>{ $("marketState").textContent="ALPACA STREAM";$("marketState").className="market-state live";if(!watchHas("SPY")){watchlist().push("SPY");saveWatchlistLocal()}saveWatchlistRemote()};ws.onmessage=e=>handle(JSON.parse(e.data));ws.onerror=()=>{$("marketState").textContent="STREAM ERROR";$("marketState").className="market-state off"};ws.onclose=()=>{ $("marketState").textContent="RECONNECTING";$("marketState").className="market-state off";reconnectTimer=setTimeout(connect,3000)}}
function handle(m){
 if(m.type==="state"||m.type==="market"){if(m.player){state.player=m.player;if(m.player.username&&Array.isArray(m.player.watchlist))state.watchlist=[...new Set([...m.player.watchlist,"SPY"])]}if(m.market)state.market=m.market.filter(x=>watchHas(x.symbol));if(m.leaderboard)state.leaderboard=m.leaderboard;if(Number.isFinite(m.online))state.online=m.online;if(typeof m.marketReady==="boolean")state.marketReady=m.marketReady;renderAll();if(m.type==="state")loadExpirations();return}
 if(m.type==="marketTick"){if(!watchHas(m.stock.symbol))return;const i=state.market.findIndex(x=>x.symbol===m.stock.symbol);if(i<0)state.market.push(m.stock);else state.market[i]=m.stock;renderWatchlist();renderQuote();renderChart();renderTicket();return}
 if(m.type==="optionTick"){const o=state.options.find(x=>x.contractSymbol===m.contractSymbol);if(o){if(m.bid!=null)o.bid=Number(m.bid);if(m.ask!=null)o.ask=Number(m.ask);if(m.last!=null)o.last=Number(m.last);o.mid=Number.isFinite(o.bid)&&Number.isFinite(o.ask)?(o.bid+o.ask)/2:null;o.updatedAt=m.updatedAt;renderChain();renderOptionTicket()}return}
 if(m.type==="error")toast(m.message||"Request failed");
}
function apply(m){if(m.player){state.player=m.player;if(m.player.username&&Array.isArray(m.player.watchlist))state.watchlist=[...new Set([...m.player.watchlist,"SPY"])]}if(m.market)state.market=m.market.filter(x=>watchHas(x.symbol));if(m.leaderboard)state.leaderboard=m.leaderboard;if(Number.isFinite(m.online))state.online=m.online;if(typeof m.marketReady==="boolean")state.marketReady=m.marketReady;renderAll()}
async function bootstrap(){try{apply(await api("/api/bootstrap?playerId="+encodeURIComponent(playerId)+"&_="+Date.now()));if(!watchHas("SPY")){watchlist().push("SPY");saveWatchlistLocal()}try{const a=await api("/api/assets");state.assets=a.assets||[]}catch(e){console.error("Alpaca asset universe:",e.message)}await selectSymbol("SPY",true);connect();renderAll()}catch(e){toast(e.message);setTimeout(bootstrap,4000)}}
function stock(){return state.market.find(x=>x.symbol===state.selected)}
function populate(){const s=$("symbol");const q=String($("tickerSearch")?.value||"").trim().toLowerCase();const list=(state.assets.length?state.assets:state.market).filter(x=>!q||x.symbol.toLowerCase().includes(q)||String(x.name||"").toLowerCase().includes(q));s.innerHTML='<option value="">SELECT SECURITY</option>'+list.map(x=>'<option value="'+esc(x.symbol)+'">'+esc(x.symbol)+" — "+esc(x.name)+"</option>").join("");s.value=state.selected}
function renderHeader(){const p=state.player;if(!p)return;$("cash").textContent=money(p.cash);$("portfolio").textContent=money(p.portfolioValue);$("level").textContent=p.level;$("nameBtn").textContent=p.name||"GUEST"}
function renderWatchlist(){
  // Keep Market Watch in the user's saved order. Live Alpaca updates must never reorder rows.
  const order=new Map(watchlist().map((symbol,index)=>[String(symbol).toUpperCase(),index]));
  const stableMarket=[...state.market].sort((a,b)=>(order.get(String(a.symbol).toUpperCase())??999999)-(order.get(String(b.symbol).toUpperCase())??999999));
  const stocks=stableMarket.map(s=>{
    const c=s.changePct>0?"up":s.changePct<0?"down":"flat";
    return '<div class="watch-row '+(s.symbol===state.selected?"active":"")+'">'+
      '<button class="watch-main" data-symbol="'+esc(s.symbol)+'"><span><span class="sym">'+esc(s.symbol)+'</span><span class="name">'+esc(s.name)+'</span></span>'+
      '<span class="px"><span class="price">'+px(s.price)+'</span><span class="'+c+'">'+(s.changePct==null?"—":(s.changePct>=0?"+":"")+Number(s.changePct).toFixed(2)+"%")+'</span></span></button>'+
      '<button class="watch-remove" data-remove="'+esc(s.symbol)+'" title="Remove '+esc(s.symbol)+'" aria-label="Remove '+esc(s.symbol)+'">×</button></div>';
  }).join("");
  const options=optionWatchlist().map(o=>{
    const c=o.type==="call"?"up":"down";
    const observed=o.ask!=null?o.ask:(o.last!=null?o.last:o.bid);
    return '<div class="watch-row option-watch-row '+(state.selectedContract?.contractSymbol===o.contractSymbol?"active":"")+'">'+
      '<button class="watch-main option-watch-main" data-option="'+esc(o.contractSymbol)+'"><span><span class="sym">'+esc(o.symbol)+' '+esc((o.type||"").toUpperCase())+'</span><span class="name">'+esc(o.contractSymbol)+'</span></span>'+
      '<span class="px"><span class="price">'+px(observed)+'</span><span class="'+c+'">'+esc(o.expirationDate||"")+'</span></span></button>'+
      '<button class="watch-remove option-watch-remove" data-option-remove="'+esc(o.contractSymbol)+'" title="Remove option" aria-label="Remove option">×</button></div>';
  }).join("");
  $("watchlist").innerHTML=stocks+options;
  document.querySelectorAll(".watch-main[data-symbol]").forEach(b=>{
  b.onclick=async()=>{
    const s=b.dataset.symbol;
    await selectSymbol(s,true);
    if(!state.options.length && state.selected) await loadExpirations();
    renderChain();
    renderOptionTicket();
  };
  b.ondblclick=async e=>{
    e.preventDefault();
    const s=b.dataset.symbol;
    if(!watchHas(s)){
      watchlist().push(s);
      saveWatchlistLocal();
      saveWatchlistRemote();
    }
    await selectSymbol(s,true);
    if(!state.options.length && state.selected) await loadExpirations();
    renderChain();
    renderOptionTicket();
    toast(s+" added to Market Watch and opened Options");
  };
});
  document.querySelectorAll(".option-watch-main").forEach(b=>b.onclick=async()=>{
    const o=optionWatchlist().find(x=>x.contractSymbol===b.dataset.option);
    if(!o)return;
    try{
      // Load the underlying stock and the exact expiration before selecting
      // the saved Market Watch contract.
      await selectSymbol(o.symbol);
      state.expiration=o.expirationDate||state.expiration;
      const e=$("expirationDates");
      if(e&&state.expiration)e.value=state.expiration;
      if(state.expiration)await loadChain();
      // Select the exact contract in the freshly loaded Alpaca chain.
      state.selectedContract=state.options.find(x=>x.contractSymbol===o.contractSymbol)||null;
      if(!state.selectedContract){
        toast(o.contractSymbol+" is not available in the current Alpaca chain.");
        return;
      }
      document.querySelectorAll(".ticket-tabs button").forEach(x=>x.classList.toggle("active",x.dataset.tab==="option"));
      $("stockTicket").hidden=true;
      $("optionTicket").hidden=false;
      renderChain();
      renderOptionTicket();
      toast(o.contractSymbol+" selected. Review the live quote and BUY OPTION.");
    }catch(e){toast(e.message)}
  });
  document.querySelectorAll(".watch-remove[data-remove]").forEach(b=>b.onclick=e=>{
    e.stopPropagation();
    const symbol=b.dataset.remove;
    state.market=state.market.filter(x=>x.symbol!==symbol);
    state.watchlist=watchlist().filter(x=>x!==symbol);saveWatchlistLocal();saveWatchlistRemote();
    if(state.selected===symbol){state.selected="";state.options=[];state.expirations=[];state.expiration="";state.selectedContract=null;populate();renderQuote();renderChart();renderTicket()}
    renderWatchlist();
    if(!state.market.length&&!optionWatchlist().length)toast("Market Watch is empty. Search for a stock or add an option.");
  });
  document.querySelectorAll(".option-watch-remove").forEach(b=>b.onclick=e=>{
    e.stopPropagation();
    state.optionWatchlist=optionWatchlist().filter(x=>x.contractSymbol!==b.dataset.optionRemove);
    saveOptionWatchlist();renderWatchlist();
  });
}
function renderQuote(){const s=stock();if(!s){$("selectedSymbol").textContent="SELECT SECURITY";$("selectedName").textContent="No security selected";$("selectedPrice").textContent="—";$("bid").textContent="—";$("ask").textContent="—";$("change").textContent="—";$("change").className="";$("prevClose").textContent="—";$("feed").textContent="";$("optionSource").textContent="";return;}$("selectedSymbol").textContent=s.symbol;$("selectedName").textContent=s.name;$("selectedPrice").textContent=px(s.price);$("bid").textContent=px(s.bid);$("ask").textContent=px(s.ask);$("change").textContent=s.change==null?"—":px(s.change)+" "+(s.changePct>=0?"+":"")+Number(s.changePct||0).toFixed(2)+"%";$("change").className=s.change>0?"up":s.change<0?"down":"";$("prevClose").textContent=px(s.previousClose);$("feed").textContent=s.stream?"IEX STREAM":"IEX SNAPSHOT";$("optionSource").textContent="Alpaca "+(s.stream?"live stream":"latest snapshot")+" · real data"}
function renderChart(){const c=$("priceChart"),ctx=c.getContext("2d"),labelsEl=$("chartTimeLabels"),d=devicePixelRatio||1,r=c.getBoundingClientRect(),w=Math.max(300,r.width),h=Math.max(100,r.height);c.width=w*d;c.height=h*d;ctx.setTransform(d,0,0,d,0,0);ctx.clearRect(0,0,w,h);const s=stock(),v=(s?.history||[]).filter(Number.isFinite),dates=s?.historyDates||[];if(labelsEl)labelsEl.innerHTML="";if(v.length<2){ctx.fillStyle="#62758a";ctx.font="11px sans-serif";ctx.fillText("Waiting for Alpaca price history…",14,28);return}const firstDate=dates[0]?new Date(dates[0]):null,lastDate=dates[dates.length-1]?new Date(dates[dates.length-1]):null;if(labelsEl)labelsEl.innerHTML="";const mins=firstDate&&lastDate?Math.max(1,Math.round((lastDate-firstDate)/60000)):Math.max(1,v.length-1);const period=mins>=1440?Math.floor(mins/1440)+"D "+Math.floor((mins%1440)/60)+"H":mins>=60?Math.floor(mins/60)+"H "+(mins%60)+"M":mins+"M";ctx.fillStyle="#9fb2c6";ctx.font="10px sans-serif";ctx.textAlign="left";ctx.fillText("ALPACA PRICE HISTORY • TIME PERIOD: "+period+" • "+String(s?.historyTimeframe||"1Day").toUpperCase()+" BARS",p=14,13);const lo=Math.min(...v),hi=Math.max(...v),range=hi-lo||1,padTop=22,pad=26;ctx.strokeStyle="#182737";ctx.lineWidth=1;for(let i=1;i<4;i++){const y=padTop+i*(h-padTop-pad)/4;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke()}ctx.strokeStyle="#27b5ff";ctx.lineWidth=2;ctx.beginPath();v.forEach((x,i)=>{const xx=pad+i*(w-2*pad)/Math.max(1,v.length-1),yy=h-pad-(x-lo)/range*(h-pad-padTop);i?ctx.lineTo(xx,yy):ctx.moveTo(xx,yy)});ctx.stroke();ctx.fillStyle="#9fb2c6";ctx.font="9px sans-serif";ctx.textAlign="right";for(let i=0;i<=4;i++){const y=padTop+i*(h-padTop-pad)/4;const value=hi-(hi-lo)*(i/4);ctx.fillText("$"+value.toFixed(2),w-4,y-3)}ctx.textAlign="center";const labelCount=Math.min(6,v.length);for(let i=0;i<labelCount;i++){const idx=labelCount===1?0:Math.round(i*(v.length-1)/(labelCount-1));const x=v[idx];const xx=pad+idx*(w-2*pad)/Math.max(1,v.length-1);const date=dates[idx]?new Date(dates[idx]):null;const timeLabel=date?(firstDate&&lastDate&&firstDate.toDateString()===lastDate.toDateString()?date.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"}):date.toLocaleDateString(undefined,{month:"short",day:"numeric"})):"";const y=h-pad-(x-lo)/range*(h-pad-padTop);ctx.fillText("$"+x.toFixed(2),xx,Math.max(26,y-8));if(labelsEl){const label=document.createElement("span");label.textContent=timeLabel;labelsEl.appendChild(label)}}ctx.textAlign="center"}
function renderTicket(){const s=stock();$("ticketPrice").textContent=px(s?.price);$("stockPosition").textContent=s?(state.player?.positions?.[state.selected]||0)+" shares held":"Select a security"}
async function selectSymbol(s,openOptions=false){state.selected=s.toUpperCase();state.selectedContract=null;if(!watchHas(state.selected)){watchlist().push(state.selected);saveWatchlistLocal();saveWatchlistRemote()}state.expiration="";let existing=state.market.find(x=>x.symbol===state.selected);if(!existing||!Number.isFinite(Number(existing.price))||!Array.isArray(existing.history)||existing.history.length<2){try{const m=await api("/api/stock?symbol="+encodeURIComponent(state.selected));const i=state.market.findIndex(x=>x.symbol===state.selected);if(i<0)state.market.push(m.stock);else state.market[i]=m.stock}catch(e){toast(e.message);return}}populate();renderWatchlist();renderQuote();renderChart();renderTicket();await loadExpirations();if(openOptions){document.querySelectorAll(".ticket-tabs button").forEach(x=>x.classList.toggle("active",x.dataset.tab==="option"));$("stockTicket").hidden=true;$("optionTicket").hidden=false;renderOptionTicket();if(window.matchMedia("(max-width:800px)").matches)document.querySelector(".options")?.scrollIntoView({behavior:"smooth",block:"start"})}}
async function loadExpirations(){if(!state.selected){state.expirations=[];state.expiration="";state.options=[];state.selectedContract=null;const e=$("expirationDates");if(e)e.innerHTML="";$("chainStatus").textContent="Select a stock to load the real Alpaca option chain.";renderChain();renderOptionTicket();return}try{const m=await api("/api/options/expirations?symbol="+encodeURIComponent(state.selected));state.expirations=m.expirations||[];const e=$("expirationDates");e.innerHTML=state.expirations.map(x=>'<option value="'+esc(x)+'">'+dateLabel(x)+'</option>').join("");if(!state.expirations.length){state.options=[];renderChain();return}const today=new Date().toISOString().slice(0,10);const preferred=state.expirations.find(x=>x>today)||state.expirations[0];state.expiration=state.expirations.includes(state.expiration)&&state.expiration>today?state.expiration:preferred;e.value=state.expiration;await loadChain()}catch(e){$("chainStatus").textContent="Alpaca expirations unavailable: "+e.message}}
async function loadChain(){const seq=++chainSeq;$("chainStatus").textContent="Loading real Alpaca quotes, trades and Greeks…";try{const m=await api("/api/options?symbol="+encodeURIComponent(state.selected)+"&expirationDate="+encodeURIComponent(state.expiration));if(seq!==chainSeq)return;state.options=m.chain||[];$("chainStatus").textContent=state.options.length+" real contracts · "+(m.source||"Alpaca")+" · live updates enabled";renderChain();renderOptionTicket()}catch(e){state.options=[];renderChain();$("chainStatus").textContent="Alpaca option chain unavailable: "+e.message}}
function optionRecommendationScore(o,side,ctx){
  const ask=Number(o.ask),bid=Number(o.bid),last=Number(o.last);
  const price=Number.isFinite(ask)&&ask>0?ask:(Number.isFinite(last)&&last>0?last:null);
  if(!Number.isFinite(price)||price<=0)return null;
  const mid=Number.isFinite(bid)&&bid>0&&Number.isFinite(ask)&&ask>0?(bid+ask)/2:price;
  const spread=Number.isFinite(bid)&&bid>0&&Number.isFinite(ask)&&ask>0?Math.max(0,(ask-bid)/Math.max(mid,0.01)):0.20;
  const absDelta=Math.abs(Number(o.delta)||0);
  const deltaFit=Math.max(0,1-Math.abs(absDelta-0.50)/0.50);
  const spreadScore=Math.max(0,1-Math.min(spread,0.20)/0.20);
  const liqRaw=Math.log1p(Math.max(0,Number(o.volume)||0)+Math.max(0,Number(o.openInterest)||0));
  const liqScore=Math.min(1,liqRaw/Math.log1p(5000));
  const dte=Math.max(0,Math.round((new Date(String(o.expirationDate||"")+ "T23:59:59Z")-new Date())/86400000));
  const dteScore=Math.max(0,1-Math.abs(dte-30)/45);
  const theta=Math.abs(Number(o.theta)||0);
  const thetaScore=Math.max(0,1-Math.min(theta/2,1));
  const chainIV=Number(ctx.medianIV);
  const iv=Number(o.iv);
  const ivScore=Number.isFinite(iv)&&Number.isFinite(chainIV)&&chainIV>0?Math.max(0,1-Math.max(0,iv/chainIV-1)/1.5):0.5;
  const prices=ctx.prices;
  const p25=prices[Math.floor(Math.max(0,prices.length-1)*0.25)]||price;
  const p75=prices[Math.floor(Math.max(0,prices.length-1)*0.75)]||price;
  const affordability=p75>p25?Math.max(0,Math.min(1,(p75-price)/(p75-p25))):0.5;
  const score=100*(0.25*deltaFit+0.20*spreadScore+0.20*liqScore+0.15*dteScore+0.10*thetaScore+0.05*ivScore+0.05*affordability);
  const strike=Number(o.strike)||0;
  const breakeven=side==="call"?strike+price:strike-price;
  return {o,side,score,dte,price,spread,breakeven,maxLoss:price*(Number(o.size)||100),deltaFit,liqScore};
}
function renderOptionRecommendations(targetId="optionRecommendations"){
  const target=targetId;
  const box=$(target);
  if(!box)return;
  if(!state.selected||!state.options.length){box.innerHTML="";return}
  const valid=state.options.filter(o=>Number(o.ask)>0||Number(o.last)>0);
  if(!valid.length){box.innerHTML='<div class="recommend-empty">No priced contracts available for scoring.</div>';return}
  const ivs=valid.map(o=>Number(o.iv)).filter(Number.isFinite).sort((a,b)=>a-b);
  const prices=valid.map(o=>Number(o.ask)>0?Number(o.ask):Number(o.last)).filter(x=>x>0).sort((a,b)=>a-b);
  const medianIV=ivs.length?ivs[Math.floor(ivs.length/2)]:null;
  const ctx={medianIV,prices};
  const ranked=valid.flatMap(o=>{const a=optionRecommendationScore(o,o.type,ctx);return a?[a]:[]}).sort((a,b)=>b.score-a.score);
  const calls=ranked.filter(x=>x.side==="call").slice(0,3);
  const puts=ranked.filter(x=>x.side==="put").slice(0,3);
  const card=x=>{
    const o=x.o;
    const selected=state.selectedContract?.contractSymbol===o.contractSymbol?" selected-recommendation":"";
    return '<button type="button" class="option-rec'+selected+'" data-recommend-contract="'+esc(o.contractSymbol)+'"><span class="rec-main"><b>'+esc(o.type.toUpperCase())+' '+px(o.strike)+'</b><small>'+esc(o.contractSymbol)+' · '+x.dte+'d</small></span><span class="rec-metrics"><b>Score '+x.score.toFixed(0)+'</b><small>Ask '+px(x.price)+' · BE '+px(x.breakeven)+' · Δ '+num(o.delta)+'</small></span></button>';
  };
  const callHTML=calls.map(card).join("")||'<div class="recommend-empty">No call meets the scoring requirements.</div>';
  const putHTML=puts.map(card).join("")||'<div class="recommend-empty">No put meets the scoring requirements.</div>';
  box.innerHTML='<div class="recommend-head"><div><b>OPTION FORMULA</b><span>Objective chain score — not a guaranteed-return prediction.</span></div><span class="recommend-rule">Delta 25% · Spread 20% · Liquidity 20% · DTE 15% · Theta 10% · IV 5% · Cost 5%</span></div><div class="recommend-grid"><div><h3>TOP CALLS</h3>'+callHTML+'</div><div><h3>TOP PUTS</h3>'+putHTML+'</div></div><div class="recommend-foot">Max loss shown is premium × contract size. Breakeven uses the current ask/last used by the score. Tap a result to load that exact contract into BUY OPTION.</div>';
  box.querySelectorAll("[data-recommend-contract]").forEach(b=>b.onclick=()=>selectContract(b.dataset.recommendContract));
}
function renderChain(){
 if(!state.selected||!state.options.length){$("optionChain").innerHTML='<table class="chain-table"><thead><tr><th colspan="4" class="call">CALLS</th><th rowspan="2">STRIKE</th><th colspan="4" class="put">PUTS</th></tr><tr><th>LAST</th><th>BID</th><th>ASK</th><th>INFO</th><th class="strike-head"></th><th>LAST</th><th>BID</th><th>ASK</th><th>INFO</th></tr></thead><tbody>'+strikes.map(s=>'<tr class="'+(s===atm?"atm":"")+'">'+cell(calls.get(s),"call")+'<td class="strike">'+px(s)+'</td>'+cell(puts.get(s),"put")+'</tr>').join("")+'</tbody></table>';
 document.querySelectorAll("[data-contract]").forEach(e=>e.onclick=()=>selectContract(e.dataset.contract));
 document.querySelectorAll("[data-option-info]").forEach(e=>e.onclick=ev=>{ev.stopPropagation();showOptionDetails(e.dataset.optionInfo)});
 renderOptionRecommendations()
}
function showOptionDetails(contractSymbol){
 const o=state.options.find(x=>x.contractSymbol===contractSymbol);
 if(!o)return;
 const body='<div class="option-detail-modal"><div class="option-detail-card"><div class="option-detail-head"><div><div class="eyebrow">OPTION DETAILS</div><h3>'+esc(o.contractSymbol)+'</h3></div><button type="button" class="option-detail-close" aria-label="Close">×</button></div><div class="option-detail-grid"><div><span>LAST</span><b>'+px(o.last)+'</b></div><div><span>BID</span><b>'+px(o.bid)+'</b></div><div><span>ASK</span><b>'+px(o.ask)+'</b></div><div><span>VOLUME</span><b>'+((o.volume==null)?"—":Number(o.volume).toLocaleString())+'</b></div><div><span>OPEN INTEREST</span><b>'+((o.openInterest==null)?"—":Number(o.openInterest).toLocaleString())+'</b></div><div><span>DELTA</span><b>'+num(o.delta)+'</b></div><div><span>GAMMA</span><b>'+num(o.gamma)+'</b></div><div><span>THETA</span><b>'+num(o.theta)+'</b></div><div><span>VEGA</span><b>'+num(o.vega)+'</b></div><div><span>IV</span><b>'+(o.iv==null?"—":Number(o.iv).toFixed(2)+"%")+'</b></div></div></div></div>';
 $("toast").insertAdjacentHTML("afterend",body);
 const modal=document.querySelector(".option-detail-modal");
 const close=()=>modal?.remove();
 modal.querySelector(".option-detail-close")?.addEventListener("click",close);
 modal.addEventListener("click",e=>{if(e.target===modal)close()});
}
function selectContract(s){
  state.selectedContract=state.options.find(x=>x.contractSymbol===s)||null;
  if(state.selectedContract&&!optionWatchHas(state.selectedContract.contractSymbol)){
    const o=state.selectedContract;
    optionWatchlist().push({
      contractSymbol:o.contractSymbol,symbol:o.symbol,type:o.type,strike:o.strike,
      expirationDate:o.expirationDate,ask:o.ask,bid:o.bid,last:o.last
    });
    saveOptionWatchlist();
    toast("Option added to Market Watch");
  }
  document.querySelectorAll(".ticket-tabs button").forEach(x=>x.classList.toggle("active",x.dataset.tab==="option"));
  $("stockTicket").hidden=true;$("optionTicket").hidden=false;renderChain();renderOptionTicket();renderWatchlist();
}
function renderOptionTicket(){const o=state.selectedContract;if(!o){$("selectedContract").textContent="Select a call or put in the chain.";$("optionDetails").innerHTML="";return}$("selectedContract").innerHTML="<b>"+esc(o.contractSymbol)+"</b><br>Bid "+px(o.bid)+" · Ask "+px(o.ask)+" · Last "+px(o.last);$("optionDetails").innerHTML="Delta "+num(o.delta)+" · Gamma "+num(o.gamma)+" · Theta "+num(o.theta)+" · Vega "+num(o.vega)+"<br>IV "+(o.iv==null?"—":Number(o.iv).toFixed(2)+"%")+" · Volume "+(o.volume==null?"—":Number(o.volume).toLocaleString())+" · OI "+(o.openInterest==null?"—":Number(o.openInterest).toLocaleString())}
function renderAll(){populate();renderHeader();renderWatchlist();renderQuote();renderChart();renderTicket();renderChain();renderOptionTicket()}
function orderStock(side){send({type:"stockOrder",symbol:state.selected,side,quantity:Math.floor(Number($("shares").value))})}
function orderOption(){const o=state.selectedContract;if(!o)return toast("Select an option contract first.");send({type:"optionOrder",symbol:o.symbol,contractSymbol:o.contractSymbol,quantity:Math.floor(Number($("contracts").value)),expirationDate:o.expirationDate})}
function radarStockRow(x){
  const cls=x.trend==="UP"?"up":x.trend==="DOWN"?"down":"flat";
  const pct=Number.isFinite(Number(x.changePct))?Number(x.changePct):null;
  const pctLabel=pct===null?"—":(pct>=0?"+":"")+pct.toFixed(2)+"%";
  return '<button class="radar-row radar-click" data-symbol="'+esc(x.symbol)+'"><span><b>'+esc(x.symbol)+'</b><small>'+money(x.price)+'</small></span><span class="radar-right"><b class="'+cls+'">'+pctLabel+'</b><small>'+x.trend+' · '+x.trendScore+'</small></span></button>';
}
function radarSetupRow(x){
  const observed=x.ask!=null?x.ask:x.observedPrice!=null?x.observedPrice:x.last;
  const label=x.ask!=null?"ASK":"LAST";
  return '<button class="radar-row radar-click" data-symbol="'+esc(x.symbol)+'" data-contract="'+esc(x.contractSymbol)+'"><span><b>'+esc(x.symbol)+'</b><small>'+esc(x.contractSymbol)+'</small></span><span class="radar-right"><b>'+money(observed)+'</b><small>'+label+' · '+esc(x.type)+' · '+(x.days??"—")+'d · score '+(x.setupScore??"—")+'</small></span></button>';
}
async function openRadar(force=false){
  const d=$("drawer"),b=$("drawerContent");
  d.classList.remove("hidden");$("drawerTitle").textContent="MARKET RADAR";
  b.innerHTML='<div class="drawer-body"><div class="radar-note">REAL-DATA SIGNAL ENGINE. Scores rank current conditions; they do not predict guaranteed returns.</div><div id="radarBody">Loading real market radar…</div></div>';
  try{
    const r=await api("/api/radar"+(force?"?refresh=1":""));
    const allStocks=Array.isArray(r.stocks)?r.stocks:[];
    const up=(r.up||[]).map(radarStockRow).join("")||(allStocks.slice(0,8).map(radarStockRow).join("")||'<div class="empty">No Alpaca stock data returned.</div>');
    const down=(r.down||[]).map(radarStockRow).join("")||(allStocks.slice(8,16).map(radarStockRow).join("")||'<div class="empty">No additional Alpaca stock data returned.</div>');
    const setups=(r.setups||[]).map(radarSetupRow).join("")||'<div class="empty">No option setup passed the filters.</div>';
    const big=(r.bigActivity||[]).map(x=>'<button class="radar-row radar-click" data-symbol="'+esc(x.symbol)+'" data-contract="'+esc(x.contractSymbol)+'"><span><b>'+esc(x.symbol)+'</b><small>'+esc(x.contractSymbol)+'</small></span><span class="radar-right"><b>'+money(x.notional)+'</b><small>'+Number(x.volume||0).toLocaleString()+' volume</small></span></button>').join("")||'<div class="empty">No large-activity flag right now.</div>';
    $("radarBody").innerHTML='<div class="radar-toolbar"><button id="refreshRadar" class="ghost">↻ REFRESH RADAR</button></div><div class="radar-section"><h3>TRENDING UP</h3>'+up+'</div><div class="radar-section"><h3>TRENDING DOWN</h3>'+down+'</div><div class="radar-section"><h3>OPTION SETUP TRACKER</h3><p class="radar-help">Favors liquidity, tighter spreads, near-0.50 delta and 14–45 days to expiration.</p>'+setups+'</div><div class="radar-section"><h3>LARGE OPTION ACTIVITY</h3><p class="radar-help">Flags large notional activity. A trade print does not prove whether it was bought or sold.</p>'+big+'</div><div class="radar-foot">Updated '+new Date(r.updatedAt).toLocaleTimeString()+' · '+esc(r.feed||"Alpaca")+'</div>'; $("refreshRadar").onclick=()=>openRadar(true);
    document.querySelectorAll(".radar-click").forEach(e=>{
  e.ondblclick=async ev=>{
    ev.preventDefault();
    if(e.dataset.contract){
      const x=[...(r.setups||[]),...(r.bigActivity||[])].find(o=>o.contractSymbol===e.dataset.contract);
      if(x) await openScannerOption(x);
    }else if(e.dataset.symbol){
      await selectSymbol(e.dataset.symbol);
      toast(e.dataset.symbol+" added to Market Watch");
    }
  };
  e.onclick=()=>{
  if(e.dataset.contract){
    const x=[...(r.setups||[]),...(r.bigActivity||[])].find(o=>o.contractSymbol===e.dataset.contract);
    if(x)openScannerOption(x);
  }else{
    selectSymbol(e.dataset.symbol);
    d.classList.add("hidden");
  }
}; });
  }catch(e){$("radarBody").innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
}
function outlookRow(x,period){
  const ret=x.returnPeriod;
  const cls=ret>0?"up":ret<0?"down":"flat";
  const price=x.ask!=null?x.ask:null;
  return '<button class="radar-row" data-symbol="'+esc(x.symbol)+'" data-contract="'+esc(x.contractSymbol)+'"><span><b>'+esc(x.symbol)+'</b><small>'+esc(x.name||"")+' · '+period+'D '+(ret>=0?"+":"")+Number(ret||0).toFixed(2)+'%</small></span><span class="radar-right"><b class="'+cls+'">'+(x.contractSymbol?esc(x.contractSymbol):"No option")+'</b><small>'+ (price!=null?money(price)+" · ":"") +'score '+(x.setupScore??"—")+'</small></span></button>';
}
async function loadOutlook(days,force=false){
  const body=$("outlookBody");
  if(!body)return;
  body.innerHTML='<div class="empty">Loading '+days+'-day real Alpaca outlook…</div>';
  try{
    const r=await api("/api/outlook?days="+encodeURIComponent(days)+(force?"&refresh=1":""));
    const rows=(r.stocks||[]).map(x=>outlookRow(x,r.periodDays)).join("")||'<div class="empty">No qualifying real Alpaca option setups were returned.</div>';
    body.innerHTML='<div class="radar-toolbar"><button id="refreshOutlook" class="ghost">↻ REFRESH OUTLOOK</button></div><div class="radar-section"><h3>'+r.periodDays+'-DAY OPTION OUTLOOK</h3><p class="radar-help">Uses real Alpaca historical price data plus current option pricing, liquidity, spread, delta and premium fit. Scores are analytics, not guaranteed returns.</p>'+rows+'</div><div class="radar-foot">Updated '+new Date(r.updatedAt).toLocaleTimeString()+' · '+esc(r.source||"Alpaca")+'</div>';
    document.querySelectorAll("#outlookBody .radar-row").forEach(e=>{
  e.ondblclick=async ev=>{
    ev.preventDefault();
    const x=(r.stocks||[]).find(o=>o.contractSymbol===e.dataset.contract);
    if(x) await openScannerOption(x);
    else if(e.dataset.symbol){await selectSymbol(e.dataset.symbol);toast(e.dataset.symbol+" added to Market Watch");}
  };
  e.onclick=()=>{
  const x=(r.stocks||[]).find(o=>o.contractSymbol===e.dataset.contract);
  if(x)openScannerOption(x); else selectSymbol(e.dataset.symbol);
}; }); $("refreshOutlook").onclick=()=>loadOutlook(days,true);
  }catch(e){
    body.innerHTML='<div class="empty">'+esc(e.message)+'</div>';
  }
}
async function openPredictionOption(x){
  if(!x?.symbol||!x?.contractSymbol)return;
  try{
    const existing=optionWatchlist().find(o=>o.contractSymbol===x.contractSymbol);
    if(!existing){
      optionWatchlist().push({
        contractSymbol:x.contractSymbol,symbol:x.symbol,type:x.type,strike:x.strike,
        expirationDate:x.expirationDate,ask:x.ask,bid:x.bid,last:x.last
      });
      saveOptionWatchlist();
    }
    state.selectedContract=null;
    await selectSymbol(x.symbol);
    state.expiration=x.expirationDate||"";
    if(state.expiration){
      const e=$("expirationDates");
      if(e)e.value=state.expiration;
      await loadChain();
    }
    state.selectedContract=state.options.find(o=>o.contractSymbol===x.contractSymbol)||{
      contractSymbol:x.contractSymbol,symbol:x.symbol,type:x.type,strike:x.strike,
      expirationDate:x.expirationDate,ask:x.ask,bid:x.bid,last:x.last
    };
    document.querySelectorAll(".ticket-tabs button").forEach(b=>b.classList.toggle("active",b.dataset.tab==="option"));
    $("stockTicket").hidden=true;
    $("optionTicket").hidden=false;
    renderWatchlist();
    renderChain();
    renderOptionTicket();
    document.querySelectorAll(".watch-row").forEach(r=>r.classList.toggle("active",r.querySelector("[data-option]")?.dataset.option===x.contractSymbol));
    $("drawer").classList.add("hidden");
    toast(x.contractSymbol+" added to Options Market Watch. Review the live ASK and choose BUY OPTION.");
  }catch(e){toast(e.message)}
}
async function openScannerOption(x){
  if(!x?.symbol||!x?.contractSymbol)return;
  try{
    // Add the exact contract, not merely the underlying stock.
    const existing=optionWatchlist().find(o=>o.contractSymbol===x.contractSymbol);
    if(!existing){
      optionWatchlist().push({
        contractSymbol:x.contractSymbol,symbol:x.symbol,type:x.type,strike:x.strike,
        expirationDate:x.expirationDate,ask:x.ask,bid:x.bid,last:x.last
      });
      saveOptionWatchlist();
    }
    state.selectedContract=null;
    await selectSymbol(x.symbol);
    state.expiration=x.expirationDate||"";
    if(state.expiration){
      const e=$("expirationDates");
      if(e)e.value=state.expiration;
      await loadChain();
    }
    state.selectedContract=state.options.find(o=>o.contractSymbol===x.contractSymbol)||{
      contractSymbol:x.contractSymbol,symbol:x.symbol,type:x.type,strike:x.strike,
      expirationDate:x.expirationDate,ask:x.ask,bid:x.bid,last:x.last
    };
    document.querySelectorAll(".ticket-tabs button").forEach(b=>b.classList.toggle("active",b.dataset.tab==="option"));
    $("stockTicket").hidden=true;
    $("optionTicket").hidden=false;
    renderWatchlist();
    renderChain();
    renderOptionTicket();
    document.querySelectorAll(".watch-row").forEach(r=>r.classList.toggle("active",r.querySelector("[data-option]")?.dataset.option===x.contractSymbol));
    $("drawer").classList.add("hidden");
  }catch(e){toast(e.message)}
}
function unusualRow(x){
  const cls=x.type==="call"?"up":"down";
  return '<button class="radar-row" data-symbol="'+esc(x.symbol)+'" data-contract="'+esc(x.contractSymbol)+'" data-option-type="'+esc(x.type)+'"><span><b>'+esc(x.symbol)+' · '+esc(x.type.toUpperCase())+'</b><small>'+esc(x.contractSymbol)+' · '+(x.days??"—")+'d</small></span><span class="radar-right"><b class="'+cls+'">'+Number(x.volume||0).toLocaleString()+' vol</b><small>'+ (x.volumeOiRatio!=null?esc(x.volumeOiRatio)+"× OI":"OI —") +' · score '+esc(x.unusualScore)+'</small></span></button>';
}
async function drawer(screen,force=false){
  const d=$("drawer"),b=$("drawerContent");
  d.classList.remove("hidden");
  $("drawerTitle").textContent=screen==="radar"?"MARKET RADAR":screen.toUpperCase();
  if(screen==="option-formula"){
    b.innerHTML='<div class="drawer-body option-formula-drawer"><div class="formula-intro"><div class="eyebrow">OPTIONS</div><h3>OPTION FORMULA</h3><p>Objective chain score — not a guaranteed-return prediction.</p></div><div id="optionFormulaBody"></div></div>';
    renderOptionRecommendations("optionFormulaBody");
  }else if(screen==="profile"){
    const p=state.player||{},s=p.stats||{};
    const pl=v=>'<span class="'+(Number(v)>0?"up":Number(v)<0?"down":"flat")+'">'+(Number(v)>0?"+":"")+money(v)+'</span>';
    const pct=v=>'<span class="'+(Number(v)>0?"up":Number(v)<0?"down":"flat")+'">'+(Number(v)>0?"+":"")+Number(v||0).toFixed(2)+'%</span>';
    const holdings=Object.entries(p.positions||{}).map(([sym,q])=>{const m=state.market.find(x=>x.symbol===sym),price=m?.price||0,value=Number(q)*Number(price),cost=Number(s.stockCostBasis?.[sym]||0),gain=value-cost;return '<div class="holding profile-holding"><span><b>'+esc(sym)+'</b><small>'+(q||0)+' shares · Cost '+money(cost)+' · Current '+money(price)+'</small></span><span class="holding-actions"><b>'+money(value)+' <small class="'+(gain>0?"up":gain<0?"down":"flat")+'">'+(gain>=0?"+":"")+money(gain)+'</small></b><button class="sell-holding" data-sell-symbol="'+esc(sym)+'">SELL</button></span></div>'}).join("");
    const options=(p.options||[]).map(o=>{
      const qty=Number(o.quantity)||0,size=Number(o.size)||100;
      const value=(Number(o.marketPrice)||0)*qty*size;
      const cost=(Number(o.entryPrice)||0)*qty*size;
      const gain=value-cost;
      const bid=Number(o.bid),ask=Number(o.ask),last=Number(o.last);
      const sellable=Number.isFinite(bid)&&bid>0;
      return '<div class="holding profile-holding">'+
        '<span><b>'+esc(o.contractSymbol)+'</b><small>'+qty+' contracts · Entry '+money(o.entryPrice)+' · Bid '+money(bid)+' · Ask '+money(ask)+' · Last '+money(last)+' · Current '+money(o.marketPrice)+'</small></span>'+
        '<span class="holding-actions"><b>'+money(value)+' <small class="'+(gain>0?"up":gain<0?"down":"flat")+'">'+(gain>=0?"+":"")+money(gain)+'</small></b>'+
        '<button class="sell-holding" data-sell-option="'+esc(o.id||"")+'" '+(sellable?"":"disabled")+'>SELL</button></span>'+
        '</div>';
    }).join("");
    const openRows=holdings+options;
    b.innerHTML='<div class="drawer-body profile-grid"><div class="profile-hero"><div class="profile-avatar">'+esc((p.name||"T").slice(0,1).toUpperCase())+'</div><div><h3>'+esc(p.name||"Trader")+'</h3><small>Trading performance · live Alpaca marks</small></div></div><div class="metric-grid profile-metrics"><div><small>TOTAL PORTFOLIO</small><b>'+money(p.portfolioValue)+'</b></div><div><small>CASH AVAILABLE</small><b>'+money(p.cash)+'</b></div><div><small>CURRENT HOLDINGS</small><b>'+money(s.currentHoldings)+'</b></div><div><small>NET P/L</small><b>'+pl(s.netPL)+'</b></div><div><small>TOTAL RETURN</small><b>'+pct(s.totalReturnPct)+'</b></div><div><small>COST BASIS</small><b>'+money(s.costBasis)+'</b></div><div><small>UNREALIZED P/L</small><b>'+pl(s.unrealizedPL)+'</b></div><div><small>REALIZED P/L</small><b>'+pl(s.realizedPL)+'</b></div><div><small>OPEN RETURN</small><b>'+pct(s.returnPct)+'</b></div><div><small>STOCK VALUE</small><b>'+money(s.stockCurrent)+'</b></div><div><small>OPTION VALUE</small><b>'+money(s.optionCurrent)+'</b></div><div><small>TRADES</small><b>'+Number(s.totalTrades||0).toLocaleString()+'</b></div></div><div class="profile-summary"><div><span>STOCKS BOUGHT</span><b>'+money(s.stockBought)+'</b></div><div><span>STOCKS SOLD</span><b>'+money(s.stockSold)+'</b></div><div><span>OPTIONS BOUGHT</span><b>'+money(s.optionBought)+'</b></div><div><span>OPTIONS SOLD</span><b>'+money(s.optionSold)+'</b></div><div><span>SHARES HELD</span><b>'+Number(s.stockQty||0).toLocaleString()+'</b></div><div><span>OPTIONS HELD</span><b>'+Number(s.optionQty||0).toLocaleString()+'</b></div></div><h3>Current Holdings</h3>'+(openRows||'<div class="empty">No open positions yet.</div>')+'</div>';
    document.querySelectorAll(".sell-holding").forEach(btn=>btn.onclick=()=>{
      if(btn.dataset.sellOption){
        const o=(p.options||[]).find(x=>String(x.id)===String(btn.dataset.sellOption));
        if(!o)return toast("Option holding not found.");
        const qty=Number(o.quantity)||0;
        if(qty<1)return toast("No option contracts available to sell.");
        const bid=Number(o.bid);
        if(!Number.isFinite(bid)||bid<=0)return toast("No current Alpaca bid is available for this option.");
        const amount=prompt("Sell how many "+o.contractSymbol+" contracts? (1–"+qty+")",String(qty));
        if(amount===null)return;
        const n=Math.floor(Number(amount));
        if(!Number.isFinite(n)||n<1||n>qty)return toast("Enter a valid contract quantity.");
        send({type:"optionSell",positionId:o.id,contractSymbol:o.contractSymbol,quantity:n});
        toast("Sell order sent for "+n+" "+o.contractSymbol+" at the current Alpaca bid.");
        return;
      }
      const symbol=btn.dataset.sellSymbol,qty=Number(p.positions?.[symbol]||0);
      if(!symbol||qty<1)return toast("No shares available to sell.");
      const amount=prompt("Sell how many "+symbol+" shares? (1–"+qty+")",String(qty));
      if(amount===null)return;
      const n=Math.floor(Number(amount));
      if(!Number.isFinite(n)||n<1||n>qty)return toast("Enter a valid share quantity.");
      send({type:"stockOrder",symbol,side:"sell",quantity:n});
      toast("Sell order sent for "+n+" "+symbol+" shares.");
    });
  }else if(screen==="news"){
    b.innerHTML='<div class="drawer-body">Loading Alpaca news…</div>';
    try{const m=await api("/api/news?symbol="+encodeURIComponent(state.selected));b.innerHTML='<div class="drawer-body">'+(m.news||[]).map(n=>'<div class="news-item"><b>'+esc(n.headline)+'</b><small>'+esc(n.source||"Alpaca")+" · "+new Date(n.createdAt).toLocaleString()+'</small><p>'+esc(n.summary||"")+'</p></div>').join("")+'</div>'}catch(e){b.innerHTML='<div class="drawer-body">'+esc(e.message)+'</div>'}
  }else if(screen==="radar"){await openRadar();return;
  }else if(screen==="outlook"){
    b.innerHTML='<div class="drawer-body"><div class="radar-note">OUTLOOK. Choose a historical horizon from 30 days through 1 year. Uses real Alpaca price history and current option data. Scores are analytics, not guaranteed returns.</div><div class="outlook-controls"><label>OUTLOOK PERIOD<select id="outlookPeriod"><option value="30">30 DAYS</option><option value="60">60 DAYS</option><option value="90">90 DAYS</option><option value="180">180 DAYS</option><option value="365">1 YEAR</option></select></label></div><div id="outlookBody">Loading outlook…</div></div>';
    $("outlookPeriod").onchange=e=>loadOutlook(Number(e.target.value));
    await loadOutlook(30);
  }else if(screen==="volume"){
    b.innerHTML='<div class="drawer-body"><div class="radar-note">UNUSUAL OPTION VOLUME. Real Alpaca option volume ranked against open interest when available. Volume alone does not reveal whether trades were buys or sells.</div><div id="volumeBody">Loading unusual call/put volume…</div></div>';
    try{
      const r=await api("/api/unusual-volume"+(force?"?refresh=1":""));
      const calls=(r.calls||[]).map(unusualRow).join("")||'<div class="empty">No unusual call volume returned.</div>';
      const puts=(r.puts||[]).map(unusualRow).join("")||'<div class="empty">No unusual put volume returned.</div>';
      $("volumeBody").innerHTML='<div class="radar-toolbar"><button id="refreshVolume" class="ghost">↻ REFRESH VOLUME</button></div><div class="radar-section"><h3>UNUSUAL HIGH-VOLUME CALLS</h3>'+calls+'</div><div class="radar-section"><h3>UNUSUAL HIGH-VOLUME PUTS</h3>'+puts+'</div><div class="radar-foot">Updated '+new Date(r.updatedAt).toLocaleTimeString()+' · '+esc(r.source||"Alpaca")+'</div>'; $("refreshVolume").onclick=()=>drawer("volume",true);
      document.querySelectorAll("#volumeBody .radar-row").forEach(e=>e.onclick=()=>{
        const x=(r.calls||[]).concat(r.puts||[]).find(o=>o.contractSymbol===e.dataset.contract);
        openScannerOption(x);
      });
    }catch(e){$("volumeBody").innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
  }else if(screen==="predictions"){
    b.innerHTML='<div class="drawer-body"><div class="radar-note">PREDICTIONS. Fresh 100-stock cross-industry scan using real Alpaca 90-day price history and current option-chain data. These are analytical setups, not guaranteed outcomes.</div><div id="predictionBody">Loading reversal setups…</div></div>';
    try{
      const r=await api("/api/predictions"+(force?"?refresh=1":""));
      const card=(title,x,kind)=>{
        if(!x)return '<div class="radar-section"><h3>'+title+'</h3><div class="empty">No qualifying real Alpaca setup found in this scan.</div></div>';
        const cls=x.return30<0?"down":"up";
        return '<div class="radar-section"><h3>'+title+'</h3><button class="radar-row" data-symbol="'+esc(x.symbol)+'" data-contract="'+esc(x.contractSymbol)+'"><span><b>'+esc(x.symbol)+'</b><small>'+esc(x.name||"")+' · 90D '+(x.return90>=0?"+":"")+Number(x.return90).toFixed(2)+'%</small></span><span class="radar-right"><b class="'+cls+'">'+esc(x.contractSymbol)+'</b><small>'+esc(kind)+" · strike "+px(x.strike)+" · "+esc(x.expirationDate||"")+' · ASK '+money(x.ask)+'</small></span></button><p class="radar-help">'+esc(x.thesis||"")+'</p></div>';
      };
      $("predictionBody").innerHTML='<div class="radar-toolbar"><button id="refreshPredictions" class="ghost">↻ REFRESH PREDICTIONS</button></div>'+card("REBOUND CALL — AFTER LARGE DECLINE",r.rebound,"CALL")+card("PULLBACK PUT — AFTER LARGE ADVANCE",r.downside,"PUT")+'<div class="radar-foot">Updated '+new Date(r.updatedAt).toLocaleTimeString()+' · '+esc(r.source||"Alpaca")+'</div>';
      $("refreshPredictions").onclick=()=>drawer("predictions",true);
      document.querySelectorAll("#predictionBody .radar-row").forEach(e=>e.onclick=()=>{
        const x=[r.rebound,r.downside].find(o=>o&&o.contractSymbol===e.dataset.contract);
        if(x)openPredictionOption(x);
      });
    }catch(e){$("predictionBody").innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
  }else{
    b.innerHTML='<div class="drawer-body">'+(state.leaderboard||[]).map((x,i)=>'<div class="holding"><span>#'+(i+1)+" "+esc(x.name)+" · Level "+x.level+'</span><b>'+money(x.value)+'</b></div>').join("")+'</div>';
  }
}
$("symbol").onchange=e=>selectSymbol(e.target.value);$("tickerSearch").oninput=()=>populate();$("tickerSearch").onkeydown=async e=>{if(e.key!=="Enter")return;e.preventDefault();const q=String($("tickerSearch").value||"").trim().toUpperCase();const opts=[...$("symbol").options].filter(o=>o.value);const exact=opts.find(o=>o.value.toUpperCase()===q);const first=exact||opts[0];if(first){$("symbol").value=first.value;await selectSymbol(first.value,true)}};$("expirationDates").onchange=e=>{state.expiration=e.target.value;loadChain()};$("refreshOptions").onclick=loadChain;$("buyStock").onclick=()=>orderStock("buy");$("sellStock").onclick=()=>orderStock("sell");$("buyOption").onclick=orderOption;$("closeDrawer").onclick=()=>$("drawer").classList.add("hidden");
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
