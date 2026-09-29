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
function randomTraderUsername(id){
  const base="Trader-"+String(id||"").replace(/[^a-z0-9]/gi,"").slice(-6).toUpperCase().padStart(6,"0");
  let username=base,n=2;
  while(accounts[accountKey(username)]) username=base+"-"+n++;
  return username;
}
function randomLoginCode(){return crypto.randomBytes(9).toString("base64url").slice(0,12);}
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
    if(!finite(p.startingCapital)||Number(p.startingCapital)<=0){p.startingCapital=100000;changed=true;}\n    if(!p.stockCostBasis||typeof p.stockCostBasis!=="object"){p.stockCostBasis={};changed=true;}
    for(const k of ["stockBought","stockSold","realizedPL","optionBought","optionSold","optionRealizedPL","totalTrades"])if(!finite(p[k])){p[k]=0;changed=true;}
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