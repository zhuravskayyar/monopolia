const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
const match = html.match(/<script>\s*([\s\S]*?)<\/script>/);
assert.ok(match, 'inline game script found');
const program = new vm.Script(match[1], {filename:'index.html'});
const alerts = [];
const storage = new Map();
const context = {
  console,
  alert(message) { alerts.push(String(message)); },
  confirm() { return true; },
  prompt() { return null; },
  document: { addEventListener() {} },
  window: { addEventListener() {} },
  localStorage: {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); }
  },
  setTimeout() {},
  clearTimeout() {},
  crypto: {randomUUID() { return 'test-id'; }},
  navigator: {},
  location: {},
};
vm.createContext(context);
program.runInContext(context);
function run(js) { return vm.runInContext(js, context); }
function reset() {
  run("players = [{id:'p1',name:'A',money:1500},{id:'p2',name:'B',money:1500}];");
  run("properties = JSON.parse(JSON.stringify(propertyTemplates)).map(p => ({...p, owner:null, mortgaged:false}));");
  run("railroads = JSON.parse(JSON.stringify(railroadTemplates)).map(p => ({...p, owner:null, mortgaged:false}));");
  run("utilities = JSON.parse(JSON.stringify(utilityTemplates)).map(p => ({...p, owner:null, mortgaged:false}));");
}
run("updateGameAndSave = function() {}; showSaveNotification = function() {};");
reset();
assert.equal(run('buildingStock().houses'), 32);
assert.equal(run('buildingStock().hotels'), 12);

// Property purchases are charged automatically; monopoly doubles undeveloped rent.
assert.equal(run("assignProperty(0,'A','street')"), true);
assert.equal(run("assignProperty(1,'A','street')"), true);
assert.equal(run("players[0].money"), 1380);
assert.equal(run("calculateCurrentRent(properties[0])"), 4);
assert.equal(run("calculateCurrentRent(properties[1])"), 8);

// Even building distribution and stock counts.
assert.equal(run('addHouse(0)'), true);
assert.equal(run('players[0].money'), 1330);
assert.equal(run('buildingStock().houses'), 31);
assert.equal(run('addHouse(0)'), false, 'cannot build 2 on first street before 1 on second');
assert.equal(run('players[0].money'), 1330);
for (let level = 1; level <= 4; level++) {
  for (const index of [0,1]) {
    if (level === 1 && index === 0) continue;
    assert.equal(run('addHouse(' + index + ')'), true);
  }
}
assert.equal(run('properties[0].houses'), 4);
assert.equal(run('properties[1].houses'), 4);
assert.equal(run('buildingStock().houses'), 24);
assert.equal(run('players[0].money'), 980);

// Hotel returns four houses to bank and costs another house price.
assert.equal(run('addHotel(0)'), true);
assert.equal(run('properties[0].houses'), 5);
assert.equal(run('buildingStock().houses'), 28);
assert.equal(run('buildingStock().hotels'), 11);
assert.equal(run('players[0].money'), 930);
assert.equal(run('removeHouse(0)'), true);
assert.equal(run('properties[0].houses'), 4);
assert.equal(run('buildingStock().houses'), 24);
assert.equal(run('buildingStock().hotels'), 12);
assert.equal(run('players[0].money'), 955);

// Cannot mortgage or sell a member of an improved color group.
assert.equal(run("toggleMortgage(0,'street')"), false);
context.prompt = () => '100';
assert.equal(run("assignProperty(0,'B','street')"), false);
assert.equal(run('properties[0].owner'), 'A');
assert.equal(run('removeHouse(0)'), true);
assert.equal(run("sellBuildingsGroup('brown')"), undefined);
assert.equal(run('properties[0].houses + properties[1].houses'), 0);
assert.equal(run('buildingStock().houses'), 32);
assert.equal(run("toggleMortgage(0,'street')"), true);
assert.equal(run('properties[0].mortgaged'), true);
const beforeRedeem = run('players[0].money');
assert.equal(run("toggleMortgage(0,'street')"), true);
assert.equal(run('players[0].money'), beforeRedeem - 33);

// Private trade and mortgage handling.
context.prompt = () => '80';
assert.equal(run("assignProperty(0,'B','street')"), true);
assert.equal(run('properties[0].owner'), 'B');
const buyerBefore = run('players[1].money');
assert.equal(run("toggleMortgage(1,'street')"), true);
context.prompt = () => '70';
context.confirm = () => false; // keep mortgage, pay 10% now
assert.equal(run("assignProperty(1,'B','street')"), true);
assert.equal(run('properties[1].mortgaged'), true);
assert.equal(run('players[1].money'), buyerBefore - 73);
assert.equal(run("toggleMortgage(1,'street')"), true);
assert.equal(run('properties[1].mortgaged'), false);
assert.equal(run('players[1].money'), buyerBefore - 73 - 33);

// Mortgage redeemed immediately on purchase: principal + one interest payment.
reset();
assert.equal(run("assignProperty(0,'A','street')"), true);
assert.equal(run("toggleMortgage(0,'street')"), true);
context.prompt = () => '80';
context.confirm = () => true;
assert.equal(run("assignProperty(0,'B','street')"), true);
assert.equal(run('properties[0].mortgaged'), false);
assert.equal(run('players[1].money'), 1500 - 80 - 33);

// Banker enters final auction amount (no automatic fake bidding).
reset();
const bids = ['B', '125'];
context.prompt = () => bids.shift();
assert.equal(run("auctionProperty(2,'street')"), undefined);
assert.equal(run('properties[2].owner'), 'B');
assert.equal(run('players[1].money'), 1375);

// Stock exhaustion blocks buying; hotels cannot exceed twelve.
reset();
run("properties.slice(2,10).forEach(p => {p.owner='A';p.houses=4});");
run("properties[0].owner='A';properties[1].owner='A';");
assert.equal(run('buildingStock().houses'), 0);
assert.equal(run('addHouse(0)'), false);
reset();
run("properties.slice(2,14).forEach(p => {p.owner='B';p.houses=5});");
run("properties[0].owner='A';properties[1].owner='A';properties[0].houses=4;properties[1].houses=4;");
assert.equal(run('buildingStock().hotels'), 0);
assert.equal(run('addHotel(0)'), false);

console.log('PASS: source parses and 35+ purchase, building, inventory, rent, mortgage, trade and auction assertions');