const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const real = require("./real-market");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const PLAYERS_FILE = path.join(DATA_DIR, "players.json");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

const SYMBOLS = {
  AAPL:"Apple", MSFT:"Microsoft", NVDA:"NVIDIA", AMZN:"Amazon",
  TSLA:"Tesla", GOOGL:"Alphabet", META:"Meta Platforms", JPM:"JPMorgan"
};

const market = {};
for (const [symbol,name] of Object.entries(SYMBOLS)) {
  market[symbol] = { symbol, name, price:null, bid:null, ask:null, open:null, previousClose:null,
    change:null, changePct:null, history:[], updatedAt:null, stream:false };
}

const players = loadPlayers();
const accounts = loadAccounts();
const sockets = new Map();
const recentTrades = [];
let marketReady = false;

function loadPlayers() {
  try { return JSON.parse(fs.readFileSync(PLAYERS_FILE,"utf8")); } catch { return {}; }
}
function savePlayers() {
  const tmp=PLAYERS_FILE+".tmp";
  fs.writeFileSync(tmp,JSON.stringify(players,null,2));
  fs.renameSync(tmp,PLAYERS_FILE);
}
function loadAccounts(){try{return JSON.parse(fs.readFileSync(ACCOUNTS_FILE,"utf8"));}catch{return {};}}
function saveAccounts(){const tmp=ACCOUNTS_FILE+".tmp";fs.writeFileSync(tmp,JSON.stringify(accounts,null,2));fs.renameSync(tmp,ACCOUNTS_FILE);}
function normalizeWatchlist(list){return [...new Set((Array.isArray(list)?list:[]).map(x=>String(x||"").toUpperCase().replace(/[^A-Z0-9.-]/g,"")).filter(Boolean))].slice(0,50);}
function accountKey(v){return String(v||"").trim().toLowerCase();}
function validAccountName(v){return /^[a-z0-9][a-z0-9_-]{2,23}$/i.test(String(v||"").trim());}
function round(n,d=2){const p=10**d;return Math.round(Number(n)*p)/p;}
function finite(n){return n!==null&&n!==undefined&&n!==""&&Number.isFinite(Number(n));}
function safe(n,f=0){return finite(n)?Number(n):f;}
function idValid(v){return /^[a-f0-9-]{20,80}$/i.test(String(v||""));}
function newPlayer(id){return {
  id,name:"Trader-"+id.slice(-4).toUpperCase(),username:"",cash:100000,xp:0,level:1,
  positions:{},options:[],watchlist:Object.keys(SYMBOLS),missions:{firstTrade:false,profitGoal:false,cityTour:false},
  createdAt:Date.now(),updatedAt:Date.now()
};}
function player(id){if(!players[id]){players[id]=newPlayer(id);savePlayers();}else if(!Array.isArray(players[id].watchlist)){players[id].watchlist=Object.keys(SYMBOLS);savePlayers();}return players[id];}

function stockMark(symbol){
  const s=market[symbol];
  if(!s || !finite(s.price) || s.price<=0) return null;
  return Number(s.price);
}
function optionMark(o){return finite(o.marketPrice)?Number(o.marketPrice):0;}
function portfolioValue(p){
  let v=Number(p.cash)||0;
  for(const [s,q] of Object.entries(p.positions||{})){const px=stockMark(s);if(px!=null)v+=q*px;}
  for(const o of p.options||[])v+=optionMark(o)*(o.quantity||0)*(o.size||100);
  return round(v);
}
function publicPlayer(p){
  return {id:p.id,name:p.name,username:p.username||"",cash:round(p.cash),portfolioValue:portfolioValue(p),xp:p.xp,level:p.level,
    watchlist:normalizeWatchlist(p.watchlist||[]),positions:p.positions,options:(p.options||[]).map(o=>({...o,marketPrice:optionMark(o)})),missions:p.missions};
}
function marketPayload(){return Object.values(market).map(real.publicStock);}
function leaderboard(){return Object.values(players).map(p=>({name:p.name,value:portfolioValue(p),level:p.level}))
  .sort((a,b)=>b.value-a.value).slice(0,10);}
function payloadFor(p){return {type:"state",player:publicPlayer(p),market:marketPayload(),leaderboard:leaderboard(),online:sockets.size,marketReady};}
function send(ws,x){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(x));}
function broadcast(x){const m=JSON.stringify(x);for(const ws of sockets.values())if(ws.readyState===WebSocket.OPEN)ws.send(m);}
function mission(p,k){if(p.missions[k])return;p.missions[k]=true;p.xp+=k==="profitGoal"?500:100;p.level=1+Math.floor(p.xp/500);}

function stockOrder(p,symbol,side,qty){
  const px=stockMark(symbol); qty=Math.floor(safe(qty));
  if(!px)throw new Error("Alpaca has no current quote for "+symbol+".");
  if(qty<1||qty>100000)throw new Error("Invalid share quantity.");
  const gross=round(px*qty);
  if(side==="buy"){
    if(gross>p.cash)throw new Error("Not enough virtual cash.");
    p.cash-=gross;p.positions[symbol]=(p.positions[symbol]||0)+qty;
  }else if(side==="sell"){
    if((p.positions[symbol]||0)<qty)throw new Error("Not enough shares.");
    p.positions[symbol]-=qty;p.cash+=gross;if(!p.positions[symbol])delete p.positions[symbol];
  }else throw new Error("Invalid side.");
  mission(p,"firstTrade");if(portfolioValue(p)>=110000)mission(p,"profitGoal");
  p.updatedAt=Date.now();savePlayers();
  recentTrades.unshift({time:Date.now(),name:p.name,symbol,side,quantity:qty,price:px,type:"stock"});
  recentTrades.splice(20);
}

async function optionOrder(p,msg){
  const symbol=String(msg.symbol||"").toUpperCase();
  const chain=await real.getOptionChain(symbol,msg.expirationDate);
  const c=chain.chain.find(x=>x.contractSymbol===msg.contractSymbol);
  const qty=Math.floor(safe(msg.quantity,1));
  if(!c)throw new Error("That real Alpaca option contract is no longer available.");
  if(!["call","put"].includes(c.type)||qty<1||qty>100)throw new Error("Invalid option order.");
  const ask=Number(c.ask);
  if(!finite(ask)||ask<=0)throw new Error("No live/available ask for this option.");
  const size=c.size||100,cost=round(ask*qty*size);
  if(cost>p.cash)throw new Error("Not enough virtual cash.");
  p.cash-=cost;
  p.options.push({id:crypto.randomUUID(),contractSymbol:c.contractSymbol,symbol,type:c.type,
    strike:c.strike,expiration:c.expiration,expirationDate:c.expirationDate,quantity:qty,size,
    entryPrice:ask,marketPrice:ask,bid:c.bid,ask:c.ask,delta:c.delta,gamma:c.gamma,theta:c.theta,vega:c.vega,iv:c.iv});
  mission(p,"firstTrade");p.updatedAt=Date.now();savePlayers();
  recentTrades.unshift({time:Date.now(),name:p.name,symbol,side:"buy",quantity:qty,price:ask,type:"option",contractSymbol:c.contractSymbol});
  recentTrades.splice(20);
}

function updateOptionPositions(){
  for(const p of Object.values(players)){
    for(const o of p.options||[]){
      const live=real.getOptionLive ? real.getOptionLive(o.contractSymbol):null;
      if(live){
        const bid=Number(live.bid),ask=Number(live.ask),last=Number(live.last);
        const mark=finite(bid)&&finite(ask)?(bid+ask)/2:(finite(last)?last:null);
        if(finite(mark))o.marketPrice=round(mark);
        if(finite(bid))o.bid=round(bid);if(finite(ask))o.ask=round(ask);
      }
    }
  }
}

async function readBody(req){
  return new Promise((resolve,reject)=>{let b="";req.on("data",c=>{b+=c;if(b.length>1e6){req.destroy();reject(new Error("Body too large"));}});
    req.on("end",()=>{try{resolve(b?JSON.parse(b):{});}catch{reject(new Error("Invalid JSON"));}});req.on("error",reject);});
}
function respond(res,status,data){res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store","Access-Control-Allow-Origin":"*"});res.end(JSON.stringify(data));}

const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,"http://localhost");
  try{
    if(u.pathname==="/api/health")return respond(res,200,{ok:true,game:"market-city",alpaca:true,feed:{stock:process.env.ALPACA_STOCK_FEED||"iex",options:process.env.ALPACA_OPTION_FEED||"indicative"},time:Date.now()});
    if(u.pathname==="/api/bootstrap"){
      const id=idValid(u.searchParams.get("playerId"))?u.searchParams.get("playerId"):crypto.randomUUID();
      const p=player(id);return respond(res,200,{playerId:id,player:publicPlayer(p),market:marketPayload(),leaderboard:leaderboard(),online:sockets.size,marketReady});
    }
    if(u.pathname==="/api/market")return respond(res,200,{market:marketPayload(),online:sockets.size,marketReady});
    if(u.pathname==="/api/assets"){
      const search=u.searchParams.get("search")||"";
      const assets=await real.getAssets(search);
      return respond(res,200,{assets,source:"Alpaca"});
    }
    if(u.pathname==="/api/stock"){
      const symbol=(u.searchParams.get("symbol")||"").toUpperCase();
      const quote=await real.getStockQuote(symbol);
      market[symbol]=quote;
      marketReady=true;
      return respond(res,200,{stock:real.publicStock(quote),source:"Alpaca/"+(process.env.ALPACA_STOCK_FEED||"iex")});
    }
    if(u.pathname==="/api/options/expirations"){
      const symbol=(u.searchParams.get("symbol")||"AAPL").toUpperCase();
      const expirations=await real.getExpirations(symbol);return respond(res,200,{symbol,expirations,source:"Alpaca"});
    }
    if(u.pathname==="/api/options"){
      const symbol=(u.searchParams.get("symbol")||"AAPL").toUpperCase();
      const expirationDate=u.searchParams.get("expirationDate")||"";
      const result=await real.getOptionChain(symbol,expirationDate);
      return respond(res,200,{symbol,...result,source:"Alpaca/"+(process.env.ALPACA_OPTION_FEED||"indicative")});
    }
    if(u.pathname==="/api/radar") { if(u.searchParams.get("refresh")==="1" && real.clearRadarCache) real.clearRadarCache(); const radar=await real.getRadar(); return respond(res,200,{...radar,source:"Alpaca"}); }
    if(u.pathname==="/api/outlook") {
      const requested=Number(u.searchParams.get("days")||30);
      if(u.searchParams.get("refresh")==="1" && real.clearOutlookCache) real.clearOutlookCache(requested);
      return respond(res,200,await real.getOutlook(requested));
    }
    if(u.pathname==="/api/unusual-volume") { if(u.searchParams.get("refresh")==="1" && real.clearUnusualVolumeCache) real.clearUnusualVolumeCache(); return respond(res,200,await real.getUnusualOptionVolume()); }
    if(u.pathname==="/api/news"){
      const symbol=(u.searchParams.get("symbol")||"").toUpperCase();
      const news=await real.getNews(symbol?[symbol]:[]);return respond(res,200,{news,source:"Alpaca"});
    }
    if(u.pathname==="/api/action"&&req.method==="POST"){
      const b=await readBody(req);
      if(b.type==="createAccount"||b.type==="login"){
        const username=String(b.username||"").trim(),key=accountKey(username),code=String(b.code||"");
        if(!validAccountName(username))throw new Error("Username must be 3-24 letters, numbers, _ or -.");
        if(code.length<6)throw new Error("Login code must be at least 6 characters.");
        if(b.type==="createAccount"){
          if(accounts[key])throw new Error("That username is already taken.");
          const id=idValid(b.playerId)?b.playerId:crypto.randomUUID(),p=player(id);
          p.username=username;p.name=username;p.watchlist=normalizeWatchlist(b.watchlist?.length?b.watchlist:p.watchlist);
          accounts[key]={username,playerId:id,code,createdAt:Date.now()};
          saveAccounts();savePlayers();
          return respond(res,200,{playerId:id,player:publicPlayer(p),leaderboard:leaderboard(),online:sockets.size,marketReady});
        }
        const ac=accounts[key];if(!ac||ac.code!==code)throw new Error("Invalid username or login code.");
        const p=player(ac.playerId);p.username=ac.username;p.watchlist=normalizeWatchlist(p.watchlist);p.updatedAt=Date.now();savePlayers();
        return respond(res,200,{playerId:ac.playerId,player:publicPlayer(p),leaderboard:leaderboard(),online:sockets.size,marketReady});
      }
      const id=idValid(b.playerId)?b.playerId:crypto.randomUUID();const p=player(id);
      if(b.type==="hello"){const n=String(b.name||"").trim().slice(0,24);if(n)p.name=n.replace(/[^a-zA-Z0-9 _-]/g,"");savePlayers();}
      else if(b.type==="saveWatchlist"){p.watchlist=normalizeWatchlist(b.watchlist);p.updatedAt=Date.now();savePlayers();}
      else if(b.type==="stockOrder")stockOrder(p,String(b.symbol||"").toUpperCase(),b.side,b.quantity);
      else if(b.type==="optionOrder")await optionOrder(p,b);
      else if(b.type==="tourComplete")mission(p,"cityTour");
      else throw new Error("Unknown action");
      return respond(res,200,{playerId:id,player:publicPlayer(p),market:marketPayload(),leaderboard:leaderboard(),online:sockets.size,marketReady});
    }
    let file=u.pathname==="/"?"index.html":u.pathname.replace(/^\/+/,"");
    const fp=path.normalize(path.join(PUBLIC,file));
    if(!fp.startsWith(PUBLIC))return res.writeHead(403).end("Forbidden");
    fs.readFile(fp,(err,data)=>{if(err){res.writeHead(404).end("Not found");return;}
      const ext=path.extname(fp);const types={".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json"};
      res.writeHead(200,{"Content-Type":types[ext]||"application/octet-stream","Cache-Control":"no-cache"});res.end(data);
    });
  }catch(e){console.error("API:",e.message);respond(res,503,{error:e.message,source:"Alpaca"});}
});

const wss=new WebSocket.Server({server});
wss.on("connection",(ws,req)=>{
  const u=new URL(req.url||"/","http://localhost");
  const id=idValid(u.searchParams.get("playerId"))?u.searchParams.get("playerId"):crypto.randomUUID();
  const old=sockets.get(id);if(old&&old!==ws)try{old.close();}catch{}
  const p=player(id);sockets.set(id,ws);send(ws,payloadFor(p));
  ws.on("message",async raw=>{
    try{
      const m=JSON.parse(raw.toString());
      if(m.type==="hello"){const n=String(m.name||"").trim().slice(0,24);if(n)p.name=n.replace(/[^a-zA-Z0-9 _-]/g,"");savePlayers();send(ws,payloadFor(p));}
      else if(m.type==="saveWatchlist"){p.watchlist=normalizeWatchlist(m.watchlist);p.updatedAt=Date.now();savePlayers();send(ws,payloadFor(p));}
      else if(m.type==="stockOrder"){stockOrder(p,String(m.symbol||"").toUpperCase(),m.side,m.quantity);send(ws,payloadFor(p));}
      else if(m.type==="optionOrder"){await optionOrder(p,m);send(ws,payloadFor(p));}
      else if(m.type==="tourComplete"){mission(p,"cityTour");savePlayers();send(ws,payloadFor(p));}
      else if(m.type==="ping")send(ws,{type:"pong",time:Date.now()});
    }catch(e){send(ws,{type:"error",message:e.message||"Request failed"});}
  });
  ws.on("close",()=>{sockets.delete(id);savePlayers();});
});

async function boot(){
  try{
    await real.refreshMarket(market,SYMBOLS,round);
    marketReady=Object.values(market).some(s=>finite(s.price));
    broadcast({type:"market",market:marketPayload(),leaderboard:leaderboard(),online:sockets.size,marketReady});
  }catch(e){console.error("Initial Alpaca market load:",e.message);}
  real.start(market,SYMBOLS,round,p=>broadcast(p||{type:"market",market:marketPayload(),online:sockets.size,marketReady:true}));
}
boot();
setInterval(()=>{for(const p of Object.values(players))for(const o of p.options||[]){/* live marks arrive from Alpaca stream */}savePlayers();},15000);
server.listen(PORT,HOST,()=>console.log("Market City Alpaca engine listening on "+HOST+":"+PORT));
