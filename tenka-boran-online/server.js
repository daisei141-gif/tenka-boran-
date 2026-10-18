'use strict';
// 戦国 天下謀乱 オンライン対戦サーバー
// ・public/ の画面を配る
// ・部屋ごとにゲーム本体(index.html の中のスクリプト)を独立した実行環境で動かす
// ・各プレイヤーには、その人に見えてよい情報だけを送る(他人の手札や身分は送らない)
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const PAGE = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const ENGINE = (PAGE.match(/<script>([\s\S]*)<\/script>/) || [])[1];
if (!ENGINE) throw new Error('index.html にゲーム本体のスクリプトが見つかりません');
const PAGE_SERVED = PAGE.replace('<head>', '<head><script>window.__SERVER__=true</script>');

// ── 画面とファイルの配信 ──
const TYPES = { '.html':'text/html; charset=utf-8', '.webp':'image/webp', '.png':'image/png', '.jpg':'image/jpeg', '.mp3':'audio/mpeg', '.woff2':'font/woff2', '.js':'text/javascript', '.css':'text/css', '.ico':'image/x-icon' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '/index.html') { res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' }); return res.end(PAGE_SERVED); }
  if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=604800' });
    fs.createReadStream(file).pipe(res);
  });
});

// ── 部屋 ──
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // I と O は紛らわしいので使わない
function newCode() { for (;;) { let c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]; if (!rooms.has(c)) return c; } }
const LEVELS = ['easy', 'normal', 'hard'];
const TIMEOUT = { action: 90000, general: 60000, discard: 45000, pick: 30000, zone: 30000, victim: 30000, harvest: 30000 };

class Room {
  constructor(code) {
    this.code = code; this.members = []; this.phase = 'lobby'; this.level = 'normal'; this.speed = 650;
    this.ctx = null; this.gameId = 0; this.pending = new Map(); this.rid = 0; this.flushT = null; this.emptySince = null;
  }
  get host() { const h = this.members.find(m => m.host); return h ? h.seat : null; }
  lobbyMsg() {
    return { t: 'lobby', room: this.code, phase: this.phase, level: this.level, speed: this.speed, host: this.host,
      members: this.members.map(m => ({ name: m.name, seat: m.seat, host: m.host, connected: m.connected })) };
  }
  broadcastLobby() { const msg = this.lobbyMsg(); for (const m of this.members) sendTo(m, msg); }
  G() { return this.ctx ? this.ctx.__state() : null; }

  // ── 対戦の開始 ──
  start() {
    if (this.phase === 'playing') return;
    if (this.ctx) { try { const g = this.G(); if (g) g.aborted = true; } catch (_) {} }
    for (const p of this.pending.values()) { clearTimeout(p.timer); }
    this.pending.clear();
    this.gameId++;
    const gid = this.gameId;
    const room = this;
    const net = {
      fx(name, args) { room.flushNow(); const msg = { t: 'fx', name, args }; for (const m of room.members) sendTo(m, msg); },
      render() { room.scheduleFlush(); },
      ask(who, spec) { return room.ask(who, spec); },
    };
    const sandbox = { console, setTimeout, clearTimeout, setInterval, clearInterval, performance: { now: () => Date.now() }, __NET__: net };
    vm.createContext(sandbox);
    vm.runInContext(ENGINE, sandbox, { filename: 'engine.js' });
    vm.runInContext(`UI.speed=${Number(this.speed) || 650};`, sandbox);
    this.ctx = sandbox;
    this.phase = 'playing';
    const seats = this.members.map(m => m.seat).sort((a, b) => a - b);
    this.broadcastLobby();
    sandbox.__run = vm.runInContext('runGame', sandbox);
    Promise.resolve(sandbox.__run(seats, this.level)).then(() => {
      if (this.gameId !== gid) return;
      this.phase = 'over'; this.flushNow(); this.broadcastLobby();
    }).catch(e => { console.error('game error', e); this.phase = 'over'; this.broadcastLobby(); });
    // 通信が切れている人は最初からCPUに任せる
    const g = this.G(); for (const m of this.members) if (!m.connected) { const p = g.players[m.seat]; if (p) p.isHuman = false; }
  }

  // ── プレイヤーへの問いかけ ──
  ask(who, spec) {
    return new Promise((resolve) => {
      const rid = ++this.rid; const seat = who.seat;
      const timer = setTimeout(() => this.resolveDefault(seat), TIMEOUT[spec.mode] || 60000);
      this.pending.set(seat, { rid, who, spec, resolve, timer });
      this.scheduleFlush();
    });
  }
  finish(seat, value) {
    const p = this.pending.get(seat); if (!p) return;
    clearTimeout(p.timer); this.pending.delete(seat); p.resolve(value); this.scheduleFlush();
  }
  resolveDefault(seat) {
    const p = this.pending.get(seat); if (!p) return;
    const { spec, who } = p; const c = this.ctx;
    let v = null;
    switch (spec.mode) {
      case 'action': v = { type: 'end' }; break;
      case 'pick': v = null; break;
      case 'discard': v = c.aiDiscard(who, spec.n); break;
      case 'general': v = spec.options[0]; break;
      case 'zone': { const t = spec.target; const slot = ['armor', 'weapon', 'horseP', 'horseM'].find(k => t.equip[k]); v = t.hand.length ? { zone: 'hand' } : { zone: 'equip', slot }; break; }
      case 'victim': v = spec.options[0]; break;
      case 'harvest': v = spec.pool[0]; break;
    }
    this.finish(seat, v);
  }
  // 届いた答えを確かめてからゲームに渡す(不正な答えは無視)
  answer(m, rid, val) {
    const p = this.pending.get(m.seat); if (!p || p.rid !== rid) return;
    const { spec, who } = p; const c = this.ctx; const G = this.G();
    const inHand = id => who.hand.find(x => x.id === id);
    try {
      switch (spec.mode) {
        case 'action': {
          if (!val || val.type === 'end') return this.finish(m.seat, { type: 'end' });
          const card = inHand(val.cardId); if (!card) return this.reject(m, 'その札は手札にありません。');
          const info = c.playInfo(who, card); if (!info.ok) return this.reject(m, info.why || 'その札は今は使えません。');
          let target = null;
          if (info.targets) { target = G.players[val.target]; if (!target || !info.targets.includes(target)) return this.reject(m, '相手を選び直してください。'); }
          return this.finish(m.seat, { type: 'play', card, target, asKey: info.asKey });
        }
        case 'pick': {
          if (val == null) return this.finish(m.seat, null);
          const card = inHand(val); if (!card || !spec.filter(card)) return this.reject(m, 'その札は出せません。');
          return this.finish(m.seat, card);
        }
        case 'discard': {
          if (!Array.isArray(val) || val.length !== spec.n || new Set(val).size !== val.length) return this.reject(m, `${spec.n}枚選んでください。`);
          const cards = val.map(inHand); if (cards.some(x => !x)) return this.reject(m, '手札にない札が含まれています。');
          return this.finish(m.seat, cards);
        }
        case 'general': { const g = spec.options.find(x => x.id === val); if (!g) return this.reject(m, '武将を選び直してください。'); return this.finish(m.seat, g); }
        case 'zone': {
          const t = spec.target;
          if (val && val.zone === 'hand' && t.hand.length) return this.finish(m.seat, { zone: 'hand' });
          if (val && val.zone === 'equip' && ['weapon', 'armor', 'horseM', 'horseP'].includes(val.slot) && t.equip[val.slot]) return this.finish(m.seat, { zone: 'equip', slot: val.slot });
          return this.reject(m, '選び直してください。');
        }
        case 'victim': { const t = spec.options.find(x => x.seat === val); if (!t) return this.reject(m, '選び直してください。'); return this.finish(m.seat, t); }
        case 'harvest': { const card = spec.pool.find(x => x.id === val); if (!card) return this.reject(m, '選び直してください。'); return this.finish(m.seat, card); }
      }
    } catch (e) { console.error('answer error', e); }
  }
  reject(m, msg) { sendTo(m, { t: 'error', msg }); this.flushFor(m); }

  // ── 盤面を各プレイヤーへ送る ──
  scheduleFlush() { if (this.flushT) return; this.flushT = setTimeout(() => { this.flushT = null; this.flushAll(); }, 30); }
  flushNow() { if (this.flushT) { clearTimeout(this.flushT); this.flushT = null; this.flushAll(); } }
  flushAll() { for (const m of this.members) this.flushFor(m); }
  flushFor(m) {
    const G = this.G(); if (!G || !m.ws || m.ws.readyState !== 1) return;
    sendTo(m, { t: 'state', s: this.snapshot(G, m.seat), req: this.reqFor(m.seat) });
  }
  reqFor(seat) {
    const p = this.pending.get(seat); if (!p) return null;
    const { spec, who, rid } = p; const o = { rid, mode: spec.mode };
    if (spec.mode === 'pick') Object.assign(o, { prompt: spec.prompt, sub: spec.sub || '', pass: spec.pass, urgent: !!spec.urgent, allow: who.hand.filter(spec.filter).map(c => c.id) });
    if (spec.mode === 'discard') o.n = spec.n;
    if (spec.mode === 'general') o.options = spec.options.map(g => g.id);
    if (spec.mode === 'zone') { o.target = spec.target.seat; o.verb = spec.verb; }
    if (spec.mode === 'victim') { o.a = spec.a.seat; o.options = spec.options.map(p => p.seat); }
    if (spec.mode === 'harvest') o.pool = spec.pool.map(cardOut);
    return o;
  }
  snapshot(G, v) {
    const names = {}; for (const m of this.members) names[m.seat] = m.name;
    const show = p => p.role === 'lord' || !p.alive || p.seat === v || G.over;
    return {
      gameId: this.gameId,
      players: G.players.map(p => ({
        seat: p.seat, role: show(p) ? p.role : null, isHuman: p.seat === v, gen: p.gen ? p.gen.id : null,
        hp: p.hp, maxHp: p.maxHp, alive: p.alive, slashUsed: p.slashUsed, flash: p.flash || 0,
        equip: { weapon: cardOut(p.equip.weapon), armor: cardOut(p.equip.armor), horseM: cardOut(p.equip.horseM), horseP: cardOut(p.equip.horseP) },
        judge: p.judge.map(cardOut),
        hand: p.seat === v ? p.hand.map(cardOut) : p.hand.map((_, i) => ({ id: -1 - i, key: 'back', name: '', suit: '', num: 0 })),
        pname: names[p.seat] || null,
      })),
      deckN: G.deck.length, discardN: G.discard.length, cur: G.cur, turnCount: G.turnCount, over: G.over, winner: G.winner,
      started: G.started, level: G.level,
      field: G.field ? { card: cardOut(G.field.card), from: G.field.from ? G.field.from.seat : null, to: G.field.to ? G.field.to.seat : null, note: G.field.note || null } : null,
      harvest: G.harvest ? G.harvest.map(cardOut) : null,
      log: G.log.filter(l => (!l.only || l.only.includes(v)) && (!l.hide || !l.hide.includes(v))).slice(-120).map(l => ({ text: l.text, cls: l.cls })),
    };
  }

  // ── 出入り ──
  setConnected(m, on) {
    m.connected = on;
    const G = this.G();
    if (G && this.phase === 'playing') {
      const p = G.players[m.seat];
      if (p) {
        p.isHuman = on; // 通信が切れている間はCPUが代わりに打つ
        if (!on && this.pending.has(m.seat)) this.resolveDefault(m.seat);
      }
    }
    this.broadcastLobby();
  }
  remove(m) {
    this.members = this.members.filter(x => x !== m);
    if (m.host && this.members.length) this.members[0].host = true;
    const G = this.G();
    if (G && this.phase === 'playing') { const p = G.players[m.seat]; if (p) p.isHuman = false; if (this.pending.has(m.seat)) this.resolveDefault(m.seat); }
    this.broadcastLobby();
  }
}
function cardOut(c) { return c ? { id: c.id, key: c.key, name: c.name, suit: c.suit, num: c.num } : null; }
function sendTo(m, o) { if (m.ws && m.ws.readyState === 1) { try { m.ws.send(JSON.stringify(o)); } catch (_) {} } }
function cleanName(n) { return String(n || '').replace(/[\u0000-\u001f<>&"']/g, '').trim().slice(0, 10) || '名無しの武将'; }

// ── 通信 ──
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', (ws) => {
  let room = null, me = null;
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === 'create') {
      if (room) return;
      const code = newCode(); room = new Room(code); rooms.set(code, room);
      me = { token: crypto.randomUUID(), name: cleanName(msg.name), seat: 0, ws, connected: true, host: true };
      room.members.push(me);
      sendTo(me, { t: 'joined', room: code, seat: 0, token: me.token });
      room.broadcastLobby(); return;
    }
    if (msg.t === 'join') {
      if (room) return;
      const code = String(msg.room || '').toUpperCase(); const r = rooms.get(code);
      if (!r) return ws.send(JSON.stringify({ t: 'error', msg: 'その合言葉の部屋が見つかりません。', fatal: true }));
      const back = msg.token && r.members.find(x => x.token === msg.token);
      if (back) {
        if (back.ws && back.ws !== ws) { try { back.ws.close(); } catch (_) {} }
        room = r; me = back; me.ws = ws; if (msg.name) me.name = cleanName(msg.name);
        sendTo(me, { t: 'joined', room: code, seat: me.seat, token: me.token });
        r.setConnected(me, true); r.flushFor(me); return;
      }
      if (r.phase === 'playing') return ws.send(JSON.stringify({ t: 'error', msg: '対戦中なので、今は参加できません。終わるまで待ってから参加してください。', fatal: true }));
      const used = new Set(r.members.map(x => x.seat)); const seat = [0, 1, 2, 3, 4].find(s => !used.has(s));
      if (seat == null) return ws.send(JSON.stringify({ t: 'error', msg: 'この部屋は満員です(5人まで)。', fatal: true }));
      room = r; me = { token: crypto.randomUUID(), name: cleanName(msg.name), seat, ws, connected: true, host: !r.members.length };
      r.members.push(me); r.emptySince = null;
      sendTo(me, { t: 'joined', room: code, seat, token: me.token });
      r.broadcastLobby(); return;
    }
    if (!room || !me) return;
    if (msg.t === 'config' && me.host && room.phase !== 'playing') { if (LEVELS.includes(msg.level)) room.level = msg.level; room.broadcastLobby(); return; }
    if (msg.t === 'start' && me.host) { room.start(); return; }
    if (msg.t === 'answer') { room.answer(me, msg.rid, msg.val); return; }
    if (msg.t === 'leave') { room.remove(me); room = null; me = null; return; }
  });
  ws.on('close', () => { if (room && me && me.ws === ws) { me.ws = null; room.setConnected(me, false); if (!room.members.some(m => m.connected)) room.emptySince = Date.now(); } });
});

// 反応のない接続を切り、誰もいなくなった部屋を片付ける
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (_) {} }
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (!r.members.length || (r.emptySince && now - r.emptySince > 10 * 60 * 1000)) {
      try { const g = r.G(); if (g) g.aborted = true; } catch (_) {}
      for (const p of r.pending.values()) clearTimeout(p.timer);
      rooms.delete(code);
    }
  }
}, 25000);

server.listen(PORT, () => console.log(`天下謀乱サーバー起動: http://localhost:${PORT}`));
