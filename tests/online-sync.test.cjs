const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/);
assert.ok(inline, 'inline game JavaScript exists');
const program = new vm.Script(inline[1], {filename: 'index.html'});
let nextPeerId = 1;

class Emitter {
  constructor() { this.listeners = new Map(); }
  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(callback);
    return this;
  }
  emit(event, ...args) {
    for (const callback of this.listeners.get(event) || []) callback(...args);
  }
}
class Connection extends Emitter {
  constructor() { super(); this.open = false; this.remote = null; }
  send(message) {
    if (!this.open || !this.remote?.open) return;
    const payload = structuredClone(message);
    setImmediate(() => { if (this.remote?.open) this.remote.emit('data', payload); });
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
    if (this.remote?.open) {
      this.remote.open = false;
      this.remote.emit('close');
    }
  }
}
class Peer extends Emitter {
  constructor(hub, id) {
    super();
    this.hub = hub;
    this.id = id || 'anonymous-peer-' + nextPeerId++;
    this.destroyed = false;
    this.disconnected = false;
    this.connections = [];
    if (hub.has(this.id)) throw new Error('Mock Peer ID conflict: ' + this.id);
    hub.set(this.id, this);
    setImmediate(() => { if (!this.destroyed) this.emit('open', this.id); });
  }
  connect(otherId) {
    const target = this.hub.get(otherId);
    const outgoing = new Connection();
    this.connections.push(outgoing);
    if (!target) {
      setImmediate(() => { this.emit('error', {type:'peer-unavailable'}); outgoing.emit('error', {type:'peer-unavailable'}); });
      return outgoing;
    }
    const incoming = new Connection();
    outgoing.remote = incoming;
    incoming.remote = outgoing;
    target.connections.push(incoming);
    setImmediate(() => {
      if (this.destroyed || target.destroyed) return;
      target.emit('connection', incoming);
      incoming.open = true;
      outgoing.open = true;
      outgoing.emit('open');
      incoming.emit('open');
    });
    return outgoing;
  }
  reconnect() {}
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.hub.delete(this.id);
    for (const conn of this.connections) conn.close();
  }
}
function newClient(name, hub, href = 'https://zhuravskayyar.github.io/monopolia/') {
  const elements = new Map();
  const local = new Map();
  const qrs = [];
  const copiedLinks = [];
  const shares = [];
  class QRMock {
    constructor(element, options) { qrs.push(options); element.textContent = 'QR GENERATED'; }
  }
  QRMock.CorrectLevel = {M:0};
  const pageUrl = new URL(href);
  class Element {
    constructor() {
      this.value = '';
      this.innerHTML = '';
      this.textContent = '';
      this.style = {setProperty() {}};
      this.classList = {add() {}, remove() {}, toggle() {}};
    }
    focus() {}
  }
  const document = {
    body: new Element(),
    visibilityState: 'visible',
    addEventListener() {},
    querySelectorAll(selector) { return selector === '.tab-button' ? Array.from({length:5}, () => new Element()) : []; },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
  };
  const context = {
    document,
    window: {innerWidth: 425, addEventListener() {}, location: pageUrl, QRCode: QRMock},
    URL,
    URLSearchParams,
    Peer: class extends Peer { constructor(id) { super(hub, id); } },
    navigator: {onLine:true, vibrate() {}, clipboard:{async writeText(url) { copiedLinks.push(url); }}, async share(data) {shares.push(data);} },
    localStorage: {
      getItem(key) { return local.get(key) ?? null; },
      setItem(key, value) { local.set(key, String(value)); },
      removeItem(key) { local.delete(key); },
    },
    crypto: {randomUUID() { return name.padEnd(12, 'x') + '-mock-random-id'; }},
    setTimeout(callback, ms) { const timer = setTimeout(callback, ms); timer.unref(); return timer; },
    clearTimeout,
    console,
    alert(message) { throw new Error(name + ': unexpected alert: ' + message); },
    confirm() { return true; },
    prompt() { return null; },
    location: {reload() {}},
  };
  context.window.Peer = context.Peer; // PeerJS publishes the constructor on window.
  vm.createContext(context);
  program.runInContext(context);
  return {
    name,
    eval(code) { return vm.runInContext(code, context); },
    element(id) { return document.getElementById(id); },
    read(code) { return JSON.parse(JSON.stringify(vm.runInContext(code, context))); },
    context,
    qrs,
    copiedLinks,
    shares,
  };
}
async function flush() {
  for (let i=0; i<8; i++) await new Promise(resolve => setImmediate(resolve));
}
(async () => {
  const hub = new Map();
  const banker = newClient('Banker', hub);
  banker.element('lobbyName').value = 'Banker';
  banker.eval('createOnlineRoom()');
  await flush();
  const code = banker.read('roomCode');
  assert.match(code, /^\d{4}$/);
  assert.equal(banker.read('players.length'), 1);
  const inviteLink = banker.read('inviteRoomUrl()');
  assert.equal(inviteLink, 'https://zhuravskayyar.github.io/monopolia/?room=' + code);
  banker.eval('openRoomInvite()');
  assert.equal(banker.qrs.length, 1, 'QR is generated for the banker room');
  assert.equal(banker.qrs[0].text, inviteLink, 'QR encodes deep link, not only homepage');
  assert.equal(banker.qrs[0].width, 224);
  assert.ok(banker.element('cardContent').innerHTML.includes('Копіювати посилання'));
  await banker.eval('copyRoomInvite()');
  assert.deepEqual(banker.copiedLinks, [inviteLink], 'clipboard receives exact room invite link');
  await banker.eval('shareRoomInvite()');
  assert.equal(banker.shares.length, 1);
  assert.equal(banker.shares[0].url, inviteLink, 'native share uses same QR URL');
  const clients = ['Alice', 'Bob', 'Carol', 'Dan'].map(name => newClient(name, hub, inviteLink));
  for (const client of clients) {
    assert.equal(client.read('incomingRoomCode()'), code, 'opening QR code imports room number');
    assert.equal(client.eval('showIncomingInviteIfNeeded()'), true);
    assert.equal(client.element('joinCode').value, code, 'join code is prefilled');
    assert.ok(client.element('lobbyMessage').textContent.includes(code), 'invite message shows room');
    client.element('lobbyName').value = client.name;
    client.eval('joinOnlineRoom()');
    await flush();
  }
  assert.equal(banker.read('players.length'), 5, 'banker included among five participants');
  assert.deepEqual(banker.read('players.map(p => p.name)'), ['Banker','Alice','Bob','Carol','Dan']);
  assert.ok(banker.element('roomStatus').innerHTML.includes('Онлайн: 5/5'), 'banker sees 5/5 clients online');
  assert.ok(banker.element('roomStatus').innerHTML.includes('QR-код · запросити'), 'QR invitation available during game');
  for (const client of clients) {
    assert.equal(client.read('remoteState.players.length'), 5, client.name + ' sees all 5 players');
    assert.equal(client.read('remoteState.roomCode'), code);
    assert.equal(client.read('remoteState.players.find(p => p.name === "Banker").money'), 1500);
  }
  const aliceId = banker.read('players.find(p => p.name === "Alice").id');
  const bobId = banker.read('players.find(p => p.name === "Bob").id');
  clients[0].eval('hostConnection.send({type:"transfer", targetId:"' + bobId + '", amount:90})');
  await flush();
  assert.equal(banker.read('players.find(p=>p.name==="Alice").money'), 1410);
  assert.equal(banker.read('players.find(p=>p.name==="Bob").money'), 1590);
  for (const client of clients) {
    assert.equal(client.read('remoteState.players.find(p=>p.name==="Alice").money'), 1410, 'balance sync to ' + client.name);
    assert.equal(client.read('remoteState.players.find(p=>p.name==="Bob").money'), 1590);
  }
  // Banker's changes to deeds, monetary balances and houses are broadcast to all players.
  assert.equal(banker.read('assignProperty(0, "Alice", "street")'), true);
  assert.equal(banker.read('assignProperty(1, "Alice", "street")'), true);
  assert.equal(banker.read('addHouse(0)'), true);
  await flush();
  assert.equal(banker.read('players.find(p=>p.name==="Alice").money'), 1240);
  assert.equal(banker.read('properties[0].houses'), 1);
  for (const client of clients) {
    assert.equal(client.read('remoteState.properties[0].houses'), 1, 'houses sync to ' + client.name);
    assert.equal(client.read('remoteState.players.find(p=>p.name==="Alice").money'), 1240);
    assert.ok(client.element('playerDashboard').innerHTML.includes('Alice'), 'player dashboard rendered');
  }

  // Closing a stale connection after a successful rejoin must not drop the new connection.
  const oldConnection = banker.eval('roomConnections.get("' + aliceId + '")');
  clients[0].eval('connectAsPlayer("Alice")');
  await flush();
  const newConnection = banker.eval('roomConnections.get("' + aliceId + '")');
  assert.ok(newConnection && newConnection !== oldConnection, 'Alice replaced her WebRTC connection');
  oldConnection.emit('close');
  assert.strictEqual(banker.eval('roomConnections.get("' + aliceId + '")'), newConnection, 'stale close did not delete current connection');
  clients[0].eval('hostConnection.send({type:"transfer", targetId:"' + bobId + '", amount:40})');
  await flush();
  assert.equal(banker.read('players.length'), 5, 'rejoining does not create duplicate players');
  assert.equal(banker.read('players.find(p=>p.name==="Alice").money'), 1200);
  for (const client of clients) {
    assert.equal(client.read('remoteState.players.find(p=>p.name==="Alice").money'), 1200);
  }
  const invalidInvite = newClient('Invalid', new Map(), 'https://zhuravskayyar.github.io/monopolia/?room=bad');
  assert.equal(invalidInvite.eval('showIncomingInviteIfNeeded()'), false, 'invalid room code ignored');
  assert.equal(invalidInvite.element('joinCode').value, '', 'invalid code not auto-populated');
  banker.context.window.QRCode = undefined;
  banker.eval('openRoomInvite()');
  assert.ok(banker.element('roomQrCode').textContent.includes('Скористайтеся посиланням'), 'fallback if QR library missing');
  console.log('PASS: QR invite, clipboard/share, deep links, 1 banker + 4 players, state/transfer/building sync and reconnect');
})().catch(error => { console.error(error); process.exitCode = 1; });
