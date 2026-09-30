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
const COMMUNITY_FILE = path.join(DATA_DIR, "community.json");
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
function randomTraderUsername(id){
  const base="Trader-"+String(id||"").replace(/[^a-z0-9]/gi,"").slice(-6).toUpperCase().padStart(6,"0");
  let username=base,n=2;
  while(accounts[accountKey(username)]) username=base+"-"+n++;
  return username;
}
function randomLoginCode(){return crypto.randomBytes(9).toString("base64url").slice(0,12);}

function loadCommunity(){
  try{
    const data=JSON.parse(fs.readFileSync(COMMUNITY_FILE,"utf8"));
    return {
      groups:Array.isArray(data.groups)?data.groups:[],
      topics:Array.isArray(data.topics)?data.topics:[],
      chat:Array.isArray(data.chat)?data.chat:[],
      friends:data.friends&&typeof data.friends==="object"?data.friends:{},
      messages:Array.isArray(data.messages)?data.messages:[],
      profiles:data.profiles&&typeof data.profiles==="object"?data.profiles:{}
    };
  }catch{return {groups:[],topics:[],chat:[],friends:{},messages:[],profiles:{}};}
}
const community=loadCommunity();
function saveCommunity(){
  const tmp=COMMUNITY_FILE+".tmp";
  fs.writeFileSync(tmp,JSON.stringify(community,null,2));
  fs.renameSync(tmp,COMMUNITY_FILE);
}
const DEFAULT_GROUPS=[
  ["Stock Market Basics","New to stocks? Start here.","📈"],
  ["Ask the Community","Have a question? Ask other members.","💬"],
  ["Stock Talk","Talk about companies and stocks.","📊"],
  ["Options for Beginners","Learn calls, puts, expiration dates and more.","⚡"],
  ["Stock Research","Share research and learn how people evaluate stocks.","🔎"],
  ["Investing & Saving","Long-term investing and money conversations.","💰"],
  ["Trading Challenges","Friendly virtual-money challenges inside Market City.","🏆"],
  ["Market News","Talk about what is happening in the market.","📰"],
  ["Market City","Game updates, ideas, achievements and questions.","🎮"],
  ["Off Topic","Talk about anything else.","🏠"]
];
if(!community.groups.length){
  community.groups=DEFAULT_GROUPS.map(([name,description,icon],i)=>({
    id:"group-"+crypto.randomUUID(),name,description,icon,members:[],createdBy:"system",createdAt:Date.now()-((DEFAULT_GROUPS.length-i)*86400000)
  }));
  saveCommunity();
}
function accountForPlayer(id){
  const p=players[id];
  if(!p||!p.username)return null;
  const ac=accounts[accountKey(p.username)];
  return ac&&ac.playerId===id?ac:null;
}
function authenticatedPlayer(id){
  const p=players[id],ac=accountForPlayer(id);
  if(!p||!ac||ac.auto)return null;
  return p;
}
function communityProfile(p){
  const saved=community.profiles[p.id]||{};
  return {
    id:p.id,username:p.username||p.name||"Guest",displayName:String(saved.displayName||p.name||p.username||"Guest").slice(0,32),
    bio:String(saved.bio||"").slice(0,240),avatar:String(saved.avatar||"").slice(0,500),
    joinedAt:accountForPlayer(p.id)?.createdAt||p.createdAt||Date.now()
  };
}
function communityMember(p){
  const profile=communityProfile(p);
  return {id:profile.id,username:profile.username,displayName:profile.displayName,avatar:profile.avatar};
}
function communityPublic(){
  const groupMap=new Map(community.groups.map(g=>[g.id,g]));
  const topicList=community.topics.slice().sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,100).map(t=>({
    ...t,groupName:groupMap.get(t.groupId)?.name||"Community",author:communityPublicUser(t.authorId)
  }));
  return {
    groups:community.groups.map(g=>({...g,memberCount:g.members.length,topicsCount:community.topics.filter(t=>t.groupId===g.id).length})),
    topics:topicList,
    chat:community.chat.slice(-100),
    online:sockets.size
  };
}
function communityPublicUser(id){
  const p=players[id];
  if(!p)return {id:"",displayName:"Guest",username:"Guest",avatar:""};
  return communityMember(p);
}
function requireCommunityAuth(id){
  const p=authenticatedPlayer(id);
  if(!p)throw new Error("Please log in with a Market City ID to do that.");
  return p;
}
function requireGroupMember(p,group){
  if(!group.members.includes(p.id))throw new Error("Join this group before posting or replying.");
}
function communityTrim(){
  if(community.chat.length>300)community.chat=community.chat.slice(-300);
  if(community.messages.length>1000)community.messages=community.messages.slice(-1000);
  if(community.topics.length>1000)community.topics=community.topics.slice(-1000);
}


// Server command: reset the admin account with `npm run reset-admin`.
function resetAdminAccount(){
  const entry=Object.entries(players).find(([id,p])=>accountKey(p?.username)==="admin");
  if(!entry) throw new Error("Admin account not found.");
  const [id,p]=entry;
  Object.assign(p,{cash:100000,startingCapital:100000,positions:{},stockCostBasis:{},stockBought:0,stockSold:0,realizedPL:0,optionBought:0,optionSold:0,optionRealizedPL:0,totalTrades:0,options:[],xp:0,level:1,missions:{firstTrade:false,profitGoal:false,cityTour:false},updatedAt:Date.now()});
  savePlayers();
  console.log("Admin account reset: "+p.username+" ("+id+")");
}
if(process.argv.includes("--reset-admin")) resetAdminAccount();
function round(n,d=2){const p=10**d;return Math.round(Number(n)*p)/p;}
function finite(n){return n!==null&&n!==undefined&&n!==""&&Number.isFinite(Number(n));}
function safe(n,f=0){return finite(n)?Number(n):f;}
function idValid(v){return /^[a-f0-9-]{20,80}$/i.test(String(v||""));}
function newPlayer(id){const username=randomTraderUsername(id);return {
  id,name:username,username,cash:100000,startingCapital:100000,xp:0,level:1,
  positions:{},stockCostBasis:{},stockBought:0,stockSold:0,realizedPL:0,optionBought:0,optionSold:0,optionRealizedPL:0,totalTrades:0,options:[],watchlist:Object.keys(SYMBOLS),missions:{firstTrade:false,profitGoal:false,cityTour:false},
  createdAt:Date.now(),updatedAt:Date.now()
};}
function player(id){
  if(!players[id]){
    players[id]=newPlayer(id);
    const p=players[id];
    accounts[accountKey(p.username)]={username:p.username,playerId:id,code:randomLoginCode(),createdAt:Date.now(),auto:true};
    saveAccounts();
    savePlayers();
  }else{
    let changed=false;
    const p=players[id];
    if(!p.username){
      p.username=randomTraderUsername(id);
      if(!p.name||String(p.name).startsWith("Trader-"))p.name=p.username;
      accounts[accountKey(p.username)]={username:p.username,playerId:id,code:randomLoginCode(),createdAt:Date.now(),auto:true};
      saveAccounts();
      changed=true;
    }
    if(!Array.isArray(p.watchlist)){p.watchlist=Object.keys(SYMBOLS);changed=true;}
    if(!finite(p.startingCapital)||Number(p.startingCapital)<=0){p.startingCapital=100000;changed=true;}
    // One-time reset for the Market City admin trading account.
    if(String(p.username||"").trim().toLowerCase()==="admin" && p.adminAccountResetVersion!==1){
      p.cash=100000;
      p.startingCapital=100000;
      p.positions={};
      p.stockCostBasis={};
      p.stockBought=0;
      p.stockSold=0;
      p.realizedPL=0;
      p.optionBought=0;
      p.optionSold=0;
      p.optionRealizedPL=0;
      p.totalTrades=0;
      p.options=[];
      p.xp=0;
      p.level=1;
      p.missions={firstTrade:false,profitGoal:false,cityTour:false};
      p.adminAccountResetVersion=1;
      changed=true;
    }
    if(!p.stockCostBasis||typeof p.stockCostBasis!=="object"){p.stockCostBasis={};changed=true;}
    for(const k of ["stockBought","stockSold","realizedPL","optionBought","optionSold","optionRealizedPL","totalTrades"])if(!finite(p[k])){p[k]=0;changed=true;}
    const hasPositions=Object.values(p.positions||{}).some(q=>Number(q)>0)||(p.options||[]).some(o=>Number(o.quantity)>0);
    if(Number(p.totalTrades)===0&&!hasPositions){
      for(const k of ["stockBought","stockSold","realizedPL","optionBought","optionSold","optionRealizedPL"]){
        if(Number(p[k])!==0){p[k]=0;changed=true;}
      }
    }
    if(changed)savePlayers();
  }
  return players[id];
}

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
function portfolioLevel(p){
  const gain=Math.max(0,portfolioValue(p)-100000);
  return 1+Math.floor(gain/10000);
}
function portfolioStats(p){
  let stockCurrent=0,stockCost=0,stockQty=0;
  for(const [s,q0] of Object.entries(p.positions||{})){
    const q=Number(q0)||0;stockQty+=q;
    const px=stockMark(s);if(px!=null)stockCurrent+=q*px;
    stockCost+=Number(p.stockCostBasis?.[s]||0);
  }
  let optionCurrent=0,optionCost=0,optionQty=0;
  for(const o of p.options||[]){
    const q=Number(o.quantity)||0,size=Number(o.size)||100;
    optionQty+=q;
    optionCost+=(Number(o.entryPrice)||0)*q*size;
    optionCurrent+=optionMark(o)*q*size;
  }
  // Open P/L is the mark-to-market gain/loss on positions still held.
  // This includes both stocks and options using each position's actual cost basis.
  const currentHoldings=stockCurrent+optionCurrent;
  const totalCost=stockCost+optionCost;
  const hasOpenPositions=stockQty>0||optionQty>0;
  const unrealizedPL=hasOpenPositions?currentHoldings-totalCost:0;
  // Realized P/L is only the gain/loss from positions that have actually been sold.
  // Stock realized P/L comes from average cost basis in stockOrder(); option realized
  // P/L comes from entry price vs. sale proceeds in optionSell().
  const realizedPL=Number(p.realizedPL||0)+Number(p.optionRealizedPL||0);
  const startingCapital=finite(p.startingCapital)&&Number(p.startingCapital)>0?Number(p.startingCapital):100000;
  const netPL=realizedPL+unrealizedPL;
  const openReturnPct=hasOpenPositions&&totalCost>0?(unrealizedPL/totalCost)*100:0;
  const totalReturnPct=startingCapital>0?(netPL/startingCapital)*100:0;
  return {
    stockBought:round(p.stockBought),
    stockSold:round(p.stockSold),
    optionBought:round(p.optionBought),
    optionSold:round(p.optionSold),
    currentHoldings:round(currentHoldings),
    stockCurrent:round(stockCurrent),
    optionCurrent:round(optionCurrent),
    costBasis:round(totalCost),
    stockCostBasis:round(stockCost),
    optionCostBasis:round(optionCost),
    unrealizedPL:round(unrealizedPL),
    realizedPL:round(realizedPL),
    stockRealizedPL:round(p.realizedPL),
    optionRealizedPL:round(p.optionRealizedPL),
    startingCapital:round(startingCapital),
    netPL:round(netPL),
    openReturnPct:round(openReturnPct),
    returnPct:round(openReturnPct),
    totalReturnPct:round(totalReturnPct),
    stockQty,optionQty,totalTrades:Number(p.totalTrades)||0
  };
}
function publicPlayer(p){
  return {id:p.id,name:p.name,username:p.username||"",cash:round(p.cash),startingCapital:round(finite(p.startingCapital)&&Number(p.startingCapital)>0?p.startingCapital:100000),portfolioValue:portfolioValue(p),xp:p.xp,level:portfolioLevel(p),
    stats:portfolioStats(p),watchlist:normalizeWatchlist(p.watchlist||[]),positions:p.positions,options:(p.options||[]).map(o=>({...o,marketPrice:optionMark(o)})),missions:p.missions};
}
function marketPayload(){return Object.values(market).map(real.publicStock);}
function leaderboard(){return Object.values(players).map(p=>({name:p.name,value:portfolioValue(p),level:portfolioLevel(p)}))
  .sort((a,b)=>b.value-a.value).slice(0,10);}
function payloadFor(p){return {type:"state",player:publicPlayer(p),market:marketPayload(),leaderboard:leaderboard(),online:sockets.size,marketReady};}
function send(ws,x){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(x));}
function broadcast(x){const m=JSON.stringify(x);for(const ws of sockets.values())if(ws.readyState===WebSocket.OPEN)ws.send(m);}
function mission(p,k){if(p.missions[k])return;p.missions[k]=true;p.xp+=k==="profitGoal"?500:100;}

function stockOrder(p,symbol,side,qty){
  const px=stockMark(symbol); qty=Math.floor(safe(qty));
  if(!px)throw new Error("Alpaca has no current quote for "+symbol+".");
  if(qty<1||qty>100000)throw new Error("Invalid share quantity.");
  const gross=round(px*qty);
  if(side==="buy"){
    if(gross>p.cash)throw new Error("Not enough virtual cash.");
    p.cash-=gross;p.positions[symbol]=(p.positions[symbol]||0)+qty;
    p.stockCostBasis[symbol]=round((p.stockCostBasis[symbol]||0)+gross);p.stockBought=round((p.stockBought||0)+gross);
  }else if(side==="sell"){
    if((p.positions[symbol]||0)<qty)throw new Error("Not enough shares.");
    const oldQty=p.positions[symbol]||0,oldCost=Number(p.stockCostBasis[symbol]||0),avgCost=oldQty?oldCost/oldQty:0;
    p.positions[symbol]-=qty;p.cash+=gross;p.stockSold=round((p.stockSold||0)+gross);p.realizedPL=round((p.realizedPL||0)+(gross-avgCost*qty));
    p.stockCostBasis[symbol]=round(Math.max(0,oldCost-avgCost*qty));if(!p.positions[symbol]){delete p.positions[symbol];delete p.stockCostBasis[symbol];}
  }else throw new Error("Invalid side.");
  p.totalTrades=(p.totalTrades||0)+1;mission(p,"firstTrade");if(portfolioValue(p)>=110000)mission(p,"profitGoal");
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
  p.optionBought=round((p.optionBought||0)+cost);
  p.totalTrades=(p.totalTrades||0)+1;
  p.options.push({id:crypto.randomUUID(),contractSymbol:c.contractSymbol,symbol,type:c.type,
    strike:c.strike,expiration:c.expiration,expirationDate:c.expirationDate,quantity:qty,size,
    entryPrice:ask,marketPrice:ask,bid:c.bid,ask:c.ask,last:c.last,delta:c.delta,gamma:c.gamma,theta:c.theta,vega:c.vega,iv:c.iv});
  mission(p,"firstTrade");p.updatedAt=Date.now();savePlayers();
  recentTrades.unshift({time:Date.now(),name:p.name,symbol,side:"buy",quantity:qty,price:ask,type:"option",contractSymbol:c.contractSymbol});
  recentTrades.splice(20);
}

async function updateOptionPositions(){
  const groups=new Map();
  for(const p of Object.values(players)){
    for(const o of p.options||[]){
      const key=String(o.symbol||"").toUpperCase()+"|"+String(o.expirationDate||"");
      if(!groups.has(key))groups.set(key,{symbol:String(o.symbol||"").toUpperCase(),expirationDate:o.expirationDate});
    }
  }
  if(!groups.size)return;
  for(const g of groups.values()){
    try{
      const chain=await real.getOptionChain(g.symbol,g.expirationDate);
      const bySymbol=new Map(chain.chain.map(x=>[x.contractSymbol,x]));
      for(const p of Object.values(players)){
        for(const o of p.options||[]){
          if(String(o.symbol||"").toUpperCase()!==g.symbol||String(o.expirationDate||"")!==g.expirationDate)continue;
          const c=bySymbol.get(o.contractSymbol);
          if(!c)continue;
          o.bid=finite(c.bid)?round(c.bid):null;
          o.ask=finite(c.ask)?round(c.ask):null;
          o.last=finite(c.last)?round(c.last):null;
          o.delta=c.delta;o.gamma=c.gamma;o.theta=c.theta;o.vega=c.vega;o.iv=c.iv;
          const mark=finite(c.bid)&&finite(c.ask)&&c.bid>0&&c.ask>0
            ?(Number(c.bid)+Number(c.ask))/2
            :(finite(c.bid)&&c.bid>0?Number(c.bid):(finite(c.last)&&c.last>0?Number(c.last):null));
          if(finite(mark))o.marketPrice=round(mark);
          o.updatedAt=c.updatedAt||Date.now();
        }
      }
    }catch(e){console.error("Option holding refresh",g.symbol,g.expirationDate,e.message);}
  }
  savePlayers();
}

async function optionSell(p,msg){
  const id=String(msg.positionId||"");
  const contract=String(msg.contractSymbol||"");
  const index=(id?p.options.findIndex(o=>o.id===id):p.options.findIndex(o=>o.contractSymbol===contract));
  if(index<0)throw new Error("Option holding not found.");
  const o=p.options[index];
  const qty=Math.floor(safe(msg.quantity,1));
  const heldQty=Number(o.quantity)||0;
  if(qty<1||qty>heldQty)throw new Error("Invalid option quantity.");
  const today=new Date().toISOString().slice(0,10);
  if(o.expirationDate&&o.expirationDate<today)throw new Error("This option has expired and cannot be sold.");
  const chain=await real.getOptionChain(o.symbol,o.expirationDate);
  const c=chain.chain.find(x=>x.contractSymbol===o.contractSymbol);
  if(!c)throw new Error("That real Alpaca option contract is no longer available.");
  const bid=Number(c.bid);
  if(!finite(bid)||bid<=0)throw new Error("No current Alpaca bid is available for this option.");
  const size=Number(o.size||c.size)||100;
  const proceeds=round(bid*qty*size);
  const entry=Number(o.entryPrice)||0;
  const cost=entry*qty*size;
  p.cash+=proceeds;
  p.optionSold=round((p.optionSold||0)+proceeds);
  p.optionRealizedPL=round((p.optionRealizedPL||0)+(proceeds-cost));
  o.quantity=heldQty-qty;
  if(o.quantity<=0)p.options.splice(index,1);
  else o.marketPrice=round(bid);
  p.totalTrades=(p.totalTrades||0)+1;
  if(portfolioValue(p)>=110000)mission(p,"profitGoal");
  p.updatedAt=Date.now();savePlayers();
  recentTrades.unshift({time:Date.now(),name:p.name,symbol:o.symbol,side:"sell",quantity:qty,price:bid,type:"option",contractSymbol:o.contractSymbol});
  recentTrades.splice(20);
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
    if(u.pathname==="/api/radar") { if(u.searchParams.get("refresh")==="1" && real.clearRadarCache) real.clearRadarCache(); const radar=await real.getRadar({refresh:u.searchParams.get("refresh")==="1"}); return respond(res,200,{...radar,source:"Alpaca"}); }
    if(u.pathname==="/api/outlook") {
      const requested=Number(u.searchParams.get("days")||30);
      if(u.searchParams.get("refresh")==="1" && real.clearOutlookCache) real.clearOutlookCache(requested);
      return respond(res,200,await real.getOutlook(requested,{refresh:u.searchParams.get("refresh")==="1"}));
    }
    if(u.pathname==="/api/predictions") {
  if(u.searchParams.get("refresh")==="1" && real.clearPredictionsCache) real.clearPredictionsCache();
  return respond(res,200,await real.getPredictions({refresh:u.searchParams.get("refresh")==="1"}));
}
if(u.pathname==="/api/unusual-volume") { if(u.searchParams.get("refresh")==="1" && real.clearUnusualVolumeCache) real.clearUnusualVolumeCache(); return respond(res,200,await real.getUnusualOptionVolume({refresh:u.searchParams.get("refresh")==="1"})); }
    if(u.pathname==="/api/news"){
      const symbol=(u.searchParams.get("symbol")||"").toUpperCase();
      const news=await real.getNews(symbol?[symbol]:[]);return respond(res,200,{news,source:"Alpaca"});
    }

    if(u.pathname==="/api/community"&&req.method==="GET"){
      const id=u.searchParams.get("playerId")||"";
      const me=idValid(id)?players[id]:null;
      return respond(res,200,{...communityPublic(),me:me?communityMember(me):null,authenticated:!!authenticatedPlayer(id)});
    }
    if(u.pathname==="/api/community/profile"&&req.method==="GET"){
      const id=u.searchParams.get("playerId")||"";
      const target=u.searchParams.get("userId")||id;
      const p=players[target];
      if(!p)return respond(res,404,{error:"Member not found."});
      return respond(res,200,{profile:communityProfile(p),friends:community.friends[target]||[]});
    }
    if(u.pathname==="/api/community/action"&&req.method==="POST"){
      const b=await readBody(req);
      const id=idValid(b.playerId)?b.playerId:"";
      if(b.action==="chat"){
        const p=players[id];
        const text=String(b.text||"").trim().slice(0,500);
        if(!text)throw new Error("Write a message first.");
        const user=p?communityMember(p):{id:"guest",username:"Guest",displayName:"Guest",avatar:""};
        community.chat.push({id:crypto.randomUUID(),text,createdAt:Date.now(),user});
        communityTrim();saveCommunity();
        return respond(res,200,{...communityPublic(),sent:true});
      }
      const p=requireCommunityAuth(id);
      if(b.action==="profile"){
        const displayName=String(b.displayName||p.name||p.username).trim().replace(/[<>]/g,"").slice(0,32);
        const bio=String(b.bio||"").trim().replace(/[<>]/g,"").slice(0,240);
        const avatar=String(b.avatar||"").trim().slice(0,500);
        if(!displayName)throw new Error("Display name cannot be empty.");
        community.profiles[p.id]={displayName,bio,avatar};
        p.name=displayName; p.updatedAt=Date.now(); savePlayers(); saveCommunity();
      }else if(b.action==="createGroup"){
        const name=String(b.name||"").trim().replace(/[<>]/g,"").slice(0,50);
        const description=String(b.description||"").trim().replace(/[<>]/g,"").slice(0,180);
        const icon=String(b.icon||"💬").slice(0,4);
        if(name.length<3)throw new Error("Group name must be at least 3 characters.");
        if(community.groups.some(g=>g.name.toLowerCase()===name.toLowerCase()))throw new Error("A group with that name already exists.");
        const g={id:"group-"+crypto.randomUUID(),name,description:description||"A new Market City community group.",icon,members:[p.id],createdBy:p.id,createdAt:Date.now()};
        community.groups.push(g);saveCommunity();
      }else if(b.action==="joinGroup"){
        const g=community.groups.find(x=>x.id===String(b.groupId||""));if(!g)throw new Error("Group not found.");
        if(!g.members.includes(p.id))g.members.push(p.id);saveCommunity();
      }else if(b.action==="createTopic"){
        const g=community.groups.find(x=>x.id===String(b.groupId||""));if(!g)throw new Error("Group not found.");
        requireGroupMember(p,g);
        const title=String(b.title||"").trim().replace(/[<>]/g,"").slice(0,100);
        const body=String(b.body||"").trim().replace(/[<>]/g,"").slice(0,3000);
        if(title.length<3||body.length<1)throw new Error("Add a topic title and message.");
        const t={id:"topic-"+crypto.randomUUID(),groupId:g.id,title,body,authorId:p.id,replies:[],createdAt:Date.now(),updatedAt:Date.now()};
        community.topics.push(t);saveCommunity();
      }else if(b.action==="replyTopic"){
        const t=community.topics.find(x=>x.id===String(b.topicId||""));if(!t)throw new Error("Topic not found.");
        const g=community.groups.find(x=>x.id===t.groupId);if(g)requireGroupMember(p,g);
        const body=String(b.body||"").trim().replace(/[<>]/g,"").slice(0,2000);
        if(!body)throw new Error("Write a reply first.");
        t.replies=Array.isArray(t.replies)?t.replies:[];
        t.replies.push({id:crypto.randomUUID(),authorId:p.id,body,createdAt:Date.now()});
        t.updatedAt=Date.now();if(t.replies.length>200)t.replies=t.replies.slice(-200);saveCommunity();
      }else if(b.action==="friendRequest"){
        const target=String(b.targetId||"");
        if(!players[target]||target===p.id)throw new Error("That member is not available.");
        const f=community.friends[p.id]||{friends:[],incoming:[],outgoing:[]};
        const tf=community.friends[target]||{friends:[],incoming:[],outgoing:[]};
        for(const k of ["friends","incoming","outgoing"]){f[k]=Array.isArray(f[k])?f[k]:[];tf[k]=Array.isArray(tf[k])?tf[k]:[];}
        if(f.friends.includes(target))throw new Error("You are already friends.");
        if(!f.outgoing.includes(target))f.outgoing.push(target);
        if(!tf.incoming.includes(p.id))tf.incoming.push(p.id);
        community.friends[p.id]=f;community.friends[target]=tf;saveCommunity();
      }else if(b.action==="friendRespond"){
        const target=String(b.targetId||""),accept=!!b.accept;
        const f=community.friends[p.id]||{friends:[],incoming:[],outgoing:[]};
        const tf=community.friends[target]||{friends:[],incoming:[],outgoing:[]};
        for(const k of ["friends","incoming","outgoing"]){f[k]=Array.isArray(f[k])?f[k]:[];tf[k]=Array.isArray(tf[k])?tf[k]:[];}
        f.incoming=f.incoming.filter(x=>x!==target);tf.outgoing=tf.outgoing.filter(x=>x!==p.id);
        if(accept){if(!f.friends.includes(target))f.friends.push(target);if(!tf.friends.includes(p.id))tf.friends.push(p.id);}
        community.friends[p.id]=f;community.friends[target]=tf;saveCommunity();
      }else if(b.action==="message"){
        const target=String(b.targetId||"");
        if(!players[target]||target===p.id)throw new Error("Member not found.");
        const f=community.friends[p.id]||{friends:[],incoming:[],outgoing:[]};
        if(!f.friends.includes(target))throw new Error("Add this person as a friend before messaging.");
        const body=String(b.body||"").trim().replace(/[<>]/g,"").slice(0,2000);
        if(!body)throw new Error("Write a message first.");
        community.messages.push({id:crypto.randomUUID(),from:p.id,to:target,body,createdAt:Date.now()});
        communityTrim();saveCommunity();
      }else if(b.action==="removeFriend"){
        const target=String(b.targetId||"");
        const f=community.friends[p.id]||{friends:[],incoming:[],outgoing:[]};
        const tf=community.friends[target]||{friends:[],incoming:[],outgoing:[]};
        f.friends=(f.friends||[]).filter(x=>x!==target);tf.friends=(tf.friends||[]).filter(x=>x!==p.id);
        community.friends[p.id]=f;community.friends[target]=tf;saveCommunity();
      }else throw new Error("Unknown community action.");
      return respond(res,200,{...communityPublic(),me:communityMember(p),profile:communityProfile(p),friends:community.friends[p.id]||{friends:[],incoming:[],outgoing:[]}});
    }
    if(u.pathname==="/api/community/messages"&&req.method==="GET"){
      const p=requireCommunityAuth(u.searchParams.get("playerId")||"");
      const target=String(u.searchParams.get("userId")||"");
      const f=community.friends[p.id]||{friends:[]};
      if(!f.friends?.includes(target))throw new Error("You must be friends to view messages.");
      const messages=community.messages.filter(m=>(m.from===p.id&&m.to===target)||(m.from===target&&m.to===p.id)).slice(-100);
      return respond(res,200,{messages});
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
      else if(b.type==="optionOrder"){await optionOrder(p,b);await updateOptionPositions();}
      else if(b.type==="optionSell"){await optionSell(p,b);await updateOptionPositions();}
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
      else if(m.type==="optionOrder"){await optionOrder(p,m);await updateOptionPositions();send(ws,payloadFor(p));}
      else if(m.type==="optionSell"){await optionSell(p,m);await updateOptionPositions();send(ws,payloadFor(p));}
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
  await updateOptionPositions();
}
boot();
setInterval(async()=>{try{await updateOptionPositions();for(const [id,ws] of sockets){const p=players[id];if(p)send(ws,payloadFor(p));}}catch(e){console.error("Option holding refresh:",e.message);}},15000);
server.listen(PORT,HOST,()=>console.log("Market City Alpaca engine listening on "+HOST+":"+PORT));
