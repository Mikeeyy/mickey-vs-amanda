/* =====================================================================
   Mickey vs Amanda — Air Hockey
   Static, serverless multiplayer over WebRTC (PeerJS public broker).

   Roles
   -----
   HOST  : authoritative. Runs the puck physics loop, owns the score,
           and broadcasts a full state snapshot every frame.
   GUEST : sends only its paddle position; renders the snapshots it
           receives. Its view is rotated 180° so that each player always
           controls the paddle at the BOTTOM of their own screen.

   Coordinate system
   -----------------
   All game state lives in one canonical frame: W x H virtual pixels,
   origin top-left. The HOST paddle defends the BOTTOM goal (y ≈ H);
   the GUEST paddle defends the TOP goal (y ≈ 0). The guest transforms
   every point (x, y) -> (W - x, H - y) for input and rendering, which
   is a 180° rotation and its own inverse.
   ===================================================================== */

// ---- virtual board size (physics resolution) ----
const W = 500;
const H = 800;

// ---- tunables ----
const PUCK_R    = 16;
const PADDLE_R  = 34;
const GOAL_W    = 190;          // width of the goal opening
const FRICTION  = 0.995;
const MAX_SPEED = 22;
const WIN_SCORE = 7;
const NET_RATE  = 1000 / 60;    // guest -> host paddle send interval (ms)

// ===================================================================
//  DOM
// ===================================================================
const $ = (id) => document.getElementById(id);
const screens = { menu: $('menu'), lobby: $('lobby'), game: $('game') };
function show(name) {
  for (const k in screens) screens[k].classList.toggle('hidden', k !== name);
}

const canvas = $('board');
const ctx = canvas.getContext('2d');

// ===================================================================
//  Character avatars
// ===================================================================
// Display order of the roster. Add a new avatar by dropping <key>.png into
// assets/ and adding a line here — the picker builds itself from this list.
const ROSTER = ['maju', 'miki', 'amanda', 'capibara', 'goliat', 'olaf'];
const CHARS = {
  maju:     { name: 'Maju',     color: '#ff6b9d', src: 'assets/maju.png' },
  miki:     { name: 'Miki',     color: '#4ea1ff', src: 'assets/miki.png' },
  amanda:   { name: 'Amanda',   color: '#e0556b', src: 'assets/amanda.png' },
  capibara: { name: 'Capibara', color: '#c98a5e', src: 'assets/capibara.png' },
  goliat:   { name: 'Goliat',   color: '#8a7bd8', src: 'assets/goliat.png' },
  olaf:     { name: 'Olaf',     color: '#5ec8e0', src: 'assets/olaf.png' },
};

// Preload avatar images; keep a "loaded" flag so we can fall back to a
// coloured disc with an initial until the real PNGs are dropped in.
const avatarImg = {};
for (const key in CHARS) {
  const img = new Image();
  img.loaded = false;
  img.onload = () => { img.loaded = true; };
  img.onerror = () => { img.loaded = false; };
  img.src = CHARS[key].src;
  avatarImg[key] = img;
}

// ===================================================================
//  Menu state / wiring
// ===================================================================
let myChar = null;

// Build one picker button per roster entry.
const charList = $('char-list');
ROSTER.forEach((key) => {
  const c = CHARS[key];
  const btn = document.createElement('button');
  btn.className = 'char';
  btn.dataset.char = key;
  btn.innerHTML =
    '<img src="' + c.src + '" alt="' + c.name + '" ' +
    'onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),' +
    '{className:\'char-fallback\',textContent:\'' + c.name[0] + '\',' +
    'style:\'background:' + c.color + '\'}))" />' +
    '<span>' + c.name + '</span>';
  btn.addEventListener('click', () => {
    charList.querySelectorAll('.char').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    myChar = key;
    $('btn-create').disabled = false;
    refreshJoinBtn();
  });
  charList.appendChild(btn);
});

const joinInput = $('join-code');
joinInput.addEventListener('input', () => {
  joinInput.value = joinInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  refreshJoinBtn();
});
function refreshJoinBtn() {
  $('btn-join').disabled = !(myChar && joinInput.value.length === 4);
}

$('btn-create').addEventListener('click', createGame);
$('btn-join').addEventListener('click', joinGame);

function menuStatus(msg, isError) {
  const el = $('menu-status');
  el.textContent = msg || '';
  el.classList.toggle('error', !!isError);
}

// ===================================================================
//  Networking (PeerJS)
// ===================================================================
const CODE_PREFIX = 'mvsa-';     // namespace on the shared public broker

// ICE servers for WebRTC. STUN alone works when both players are on the
// same LAN / permissive networks, but two devices on different networks
// (mobile data vs. home Wi-Fi, corporate firewalls, symmetric NATs) usually
// need a TURN relay to connect at all — that's why localhost worked but
// cross-device on Pages hung at "waiting". These public TURN servers relay
// the traffic when a direct P2P link can't be punched through.
// ---------------------------------------------------------------------------
// ICE servers.  STUN alone connects two players on the same network; two
// devices on DIFFERENT networks (phone on mobile data ↔ laptop on Wi‑Fi, or a
// Wi‑Fi with client isolation) need a TURN relay. There is no reliable free
// *no-signup* public TURN server anymore, so we fetch fresh credentials at
// page load from Metered's free TURN service. This auto-refreshes every visit,
// so the credentials never expire and nothing needs rotating.
const METERED_TURN_URL =
  'https://mikeeyy.metered.live/api/v1/turn/credentials?apiKey=fe86cec8b746a24d88fda95f77718f00a2b1';

// Google STUN as a baseline fallback if the Metered fetch ever fails.
let iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// Kick off the credential fetch immediately; connect handlers await it.
const iceReady = fetch(METERED_TURN_URL)
  .then((r) => r.json())
  .then((list) => {
    if (Array.isArray(list) && list.length) {
      iceServers = list;
      console.log('[mvsa] TURN credentials loaded (' + list.length + ' ICE servers)');
    }
    return iceServers;
  })
  .catch((err) => {
    console.warn('[mvsa] TURN fetch failed — falling back to STUN only:', err);
    return iceServers;
  });

function peerConfig() { return { config: { iceServers } }; }

let peer = null;
let conn = null;
let isHost = false;
let opponentChar = null;
let connectTimer = null;    // guest-side "couldn't connect" watchdog

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous I/O/0/1
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

async function createGame() {
  isHost = true;
  const code = randomCode();
  $('btn-create').disabled = true;
  menuStatus('Connecting to game network…');

  await iceReady;                 // ensure TURN credentials are loaded first
  peer = new Peer(CODE_PREFIX + code, peerConfig());

  peer.on('open', (id) => {
    console.log('[mvsa] host peer registered as', id);
    $('room-code').textContent = code;
    show('lobby');
  });

  peer.on('connection', (c) => {
    console.log('[mvsa] guest is connecting…');
    conn = c;
    setupConn();
  });

  peer.on('error', (err) => {
    console.error('[mvsa] host peer error:', err.type, err);
    if (err.type === 'unavailable-id') {
      // Rare code collision on the public broker — just try again.
      peer.destroy();
      createGame();
    } else {
      menuStatus('Network error: ' + err.type, true);
      $('btn-create').disabled = false;
    }
  });
}

async function joinGame() {
  isHost = false;
  const code = joinInput.value;
  $('btn-join').disabled = true;
  menuStatus('Connecting…');

  await iceReady;                 // ensure TURN credentials are loaded first

  // Watchdog: if we can't establish the link (bad code, or a network even
  // TURN can't traverse), tell the user instead of spinning forever.
  connectTimer = setTimeout(() => {
    menuStatus('Could not reach the other player. Check the code, make sure they created the game, then try again.', true);
    $('btn-join').disabled = false;
    if (peer) peer.destroy();
  }, 20000);

  peer = new Peer(peerConfig());
  peer.on('open', (id) => {
    console.log('[mvsa] guest peer registered as', id, '— dialing', CODE_PREFIX + code);
    conn = peer.connect(CODE_PREFIX + code, { reliable: false });
    setupConn();
  });
  peer.on('error', (err) => {
    console.error('[mvsa] guest peer error:', err.type, err);
    clearTimeout(connectTimer);
    const msg = err.type === 'peer-unavailable'
      ? 'No game found with that code. Make sure the other player created it and the code is exact.'
      : 'Could not connect (' + err.type + ').';
    menuStatus(msg, true);
    $('btn-join').disabled = false;
  });
}

// Common connection setup for both roles.
function setupConn() {
  attachDiag(conn);
  conn.on('open', () => {
    clearTimeout(connectTimer);
    console.log('[mvsa] data channel OPEN');
    // Announce which character we are.
    conn.send({ t: 'hello', char: myChar });
  });
  conn.on('data', onData);
  conn.on('close', onDisconnect);
  conn.on('error', (e) => { console.error('[mvsa] conn error', e); onDisconnect(); });
}

// Watch the underlying RTCPeerConnection so failures are visible instead of
// a silent timeout. Open the browser console (F12) to see the ICE trace.
function attachDiag(c) {
  const tryAttach = () => {
    const pc = c.peerConnection;
    if (!pc) { setTimeout(tryAttach, 300); return; }
    pc.addEventListener('iceconnectionstatechange', () => {
      const s = pc.iceConnectionState;
      console.log('[mvsa] ICE state:', s);
      if (!isHost && !running) {
        if (s === 'checking')  menuStatus('Player found — establishing connection…');
        if (s === 'connected' || s === 'completed') menuStatus('Connected!');
        if (s === 'failed') {
          menuStatus('Connection failed: your networks block direct P2P and the relay could not help. Try both devices on the same Wi‑Fi.', true);
          $('btn-join').disabled = false;
        }
      }
    });
    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) console.log('[mvsa] local candidate:', e.candidate.type, e.candidate.protocol, e.candidate.address || '');
    });
    pc.addEventListener('icecandidateerror', (e) => {
      console.warn('[mvsa] ICE candidate error:', e.errorCode, e.errorText, e.url);
    });
  };
  tryAttach();
}

function onData(msg) {
  switch (msg.t) {
    case 'hello':
      opponentChar = msg.char;
      startGame();
      break;
    case 'paddle':               // host receives guest paddle position
      if (isHost) { guestPaddle.tx = msg.x; guestPaddle.ty = msg.y; }
      break;
    case 'state':                // guest receives authoritative snapshot
      if (!isHost) applyState(msg);
      break;
    case 'over':
      if (!isHost) endGame(msg.iWon);
      break;
  }
}

function onDisconnect() {
  if (gameOver) return;
  showOverlay('Opponent left 👋<br><small>Reload to play again</small>');
  running = false;
}

// ===================================================================
//  Game state
// ===================================================================
// Paddles carry a target (tx,ty) that input/network drives toward, plus
// the current (x,y) and last position so we can derive paddle velocity.
const hostPaddle  = { x: W / 2, y: H - 90, px: W / 2, py: H - 90, tx: W / 2, ty: H - 90 };
const guestPaddle = { x: W / 2, y: 90,     px: W / 2, py: 90,     tx: W / 2, ty: 90 };
const puck = { x: W / 2, y: H / 2, vx: 0, vy: 0 };

let score = { host: 0, guest: 0 };
let running = false;
let gameOver = false;
let lastSend = 0;
let countdown = 0;     // frames of "get ready" freeze after a goal / start

// Character mapping to screen sides. Each player always sees themselves
// at the BOTTOM. So "me" = bottom, "opponent" = top, regardless of role.
function myCharKey()  { return myChar; }
function oppCharKey() { return opponentChar; }

function startGame() {
  menuStatus('');
  show('game');
  resizeCanvas();

  // HUD avatars/names.
  setHudSide('bottom', myCharKey());
  setHudSide('top', oppCharKey());
  $('name-bottom').textContent = 'You';
  $('name-top').textContent = CHARS[oppCharKey()]?.name || 'Opponent';

  resetPuck(Math.random() < 0.5 ? 1 : -1);
  score = { host: 0, guest: 0 };
  updateScoreHud();
  gameOver = false;
  running = true;
  countdown = 90;               // ~1.5s ready pause
  hideOverlay();
  requestAnimationFrame(loop);
}

function setHudSide(side, charKey) {
  const img = $('avatar-' + side);
  const c = CHARS[charKey];
  if (c && avatarImg[charKey]?.loaded) {
    img.src = c.src;
    img.style.display = '';
  } else {
    img.style.display = 'none';
  }
}

// ===================================================================
//  Input
// ===================================================================
// Convert a pointer event to canonical board coordinates. The guest
// applies the 180° rotation so its own paddle lives in the TOP half of
// the canonical frame while feeling like it's at the bottom of the screen.
function pointerToBoard(e) {
  const r = canvas.getBoundingClientRect();
  const cx = (e.clientX - r.left) / r.width;   // 0..1
  const cy = (e.clientY - r.top)  / r.height;  // 0..1
  let x = cx * W;
  let y = cy * H;
  if (!isHost) { x = W - x; y = H - y; }        // rotate for guest
  return { x, y };
}

function onPointer(e) {
  if (e.cancelable) e.preventDefault();   // stop scroll/zoom stealing the drag on mobile
  if (!running) return;
  const p = pointerToBoard(e);
  const pad = isHost ? hostPaddle : guestPaddle;
  // Clamp to own half + inside the walls.
  pad.tx = clamp(p.x, PADDLE_R, W - PADDLE_R);
  if (isHost) pad.ty = clamp(p.y, H / 2 + PADDLE_R, H - PADDLE_R);
  else        pad.ty = clamp(p.y, PADDLE_R, H / 2 - PADDLE_R);
}

canvas.addEventListener('pointermove', onPointer, { passive: false });
canvas.addEventListener('pointerdown', onPointer, { passive: false });

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// ===================================================================
//  Main loop
// ===================================================================
function loop(now) {
  if (!running) return;
  if (isHost) hostStep(now);
  else        guestStep(now);
  render();
  requestAnimationFrame(loop);
}

// -------- HOST: authoritative simulation --------
function hostStep(now) {
  movePaddle(hostPaddle, 1);      // my paddle — track input directly (no lag)
  movePaddle(guestPaddle, 0.5);   // opponent — smooth the networked target

  if (countdown > 0) {
    countdown--;
    puck.x = W / 2; puck.y = H / 2;
  } else {
    stepPuck();
    collidePaddle(hostPaddle);
    collidePaddle(guestPaddle);
    checkGoals();
  }

  // Broadcast snapshot (rate-limited a touch to be kind to the channel).
  if (conn && conn.open && now - lastSend > NET_RATE) {
    lastSend = now;
    conn.send({
      t: 'state',
      px: puck.x, py: puck.y,
      hx: hostPaddle.x, hy: hostPaddle.y,
      gx: guestPaddle.x, gy: guestPaddle.y,
      sh: score.host, sg: score.guest,
      cd: countdown,
    });
  }
}

// -------- GUEST: send paddle, wait for snapshots --------
function guestStep(now) {
  movePaddle(guestPaddle, 1);   // my paddle — track input directly (no lag)
  if (conn && conn.open && now - lastSend > NET_RATE) {
    lastSend = now;
    conn.send({ t: 'paddle', x: guestPaddle.tx, y: guestPaddle.ty });
  }
}

// Move a paddle toward its target and remember previous pos for velocity.
// smooth = 1 tracks the target exactly (use for YOUR OWN paddle so it sticks
// to your finger/cursor with zero lag); smooth < 1 eases (use for the
// opponent's networked paddle to hide packet jitter).
function movePaddle(pad, smooth) {
  pad.px = pad.x;
  pad.py = pad.y;
  pad.x += (pad.tx - pad.x) * smooth;
  pad.y += (pad.ty - pad.y) * smooth;
}

function stepPuck() {
  puck.x += puck.vx;
  puck.y += puck.vy;
  puck.vx *= FRICTION;
  puck.vy *= FRICTION;

  // Side walls.
  if (puck.x < PUCK_R)      { puck.x = PUCK_R;      puck.vx = Math.abs(puck.vx); }
  if (puck.x > W - PUCK_R)  { puck.x = W - PUCK_R;  puck.vx = -Math.abs(puck.vx); }

  // Top / bottom walls — but not across the goal opening.
  const inGoalX = puck.x > (W - GOAL_W) / 2 && puck.x < (W + GOAL_W) / 2;
  if (puck.y < PUCK_R && !inGoalX)     { puck.y = PUCK_R;     puck.vy = Math.abs(puck.vy); }
  if (puck.y > H - PUCK_R && !inGoalX) { puck.y = H - PUCK_R; puck.vy = -Math.abs(puck.vy); }
}

function collidePaddle(pad) {
  const dx = puck.x - pad.x;
  const dy = puck.y - pad.y;
  const dist = Math.hypot(dx, dy);
  const minDist = PUCK_R + PADDLE_R;
  if (dist === 0 || dist >= minDist) return;

  // Push the puck out along the collision normal.
  const nx = dx / dist;
  const ny = dy / dist;
  puck.x = pad.x + nx * minDist;
  puck.y = pad.y + ny * minDist;

  // Reflect the puck's velocity about the normal, then add the paddle's
  // own velocity so a moving paddle "hits" the puck.
  const dot = puck.vx * nx + puck.vy * ny;
  puck.vx -= 2 * dot * nx;
  puck.vy -= 2 * dot * ny;

  const padVx = pad.x - pad.px;
  const padVy = pad.y - pad.py;
  puck.vx += padVx * 0.6 + nx * 3;
  puck.vy += padVy * 0.6 + ny * 3;

  // Cap speed.
  const sp = Math.hypot(puck.vx, puck.vy);
  if (sp > MAX_SPEED) { puck.vx *= MAX_SPEED / sp; puck.vy *= MAX_SPEED / sp; }
}

function checkGoals() {
  const inGoalX = puck.x > (W - GOAL_W) / 2 && puck.x < (W + GOAL_W) / 2;
  if (!inGoalX) return;
  if (puck.y < -PUCK_R)      { score.host  += 1; afterGoal(-1); }  // top goal -> host scores
  else if (puck.y > H + PUCK_R) { score.guest += 1; afterGoal(1); } // bottom goal -> guest scores
}

function afterGoal(dir) {
  updateScoreHud();
  if (score.host >= WIN_SCORE || score.guest >= WIN_SCORE) {
    // Announce winner. iWon is from the GUEST's perspective for the message.
    const hostWon = score.host >= WIN_SCORE;
    if (conn && conn.open) conn.send({ t: 'over', iWon: !hostWon });
    endGame(hostWon);      // host perspective
    return;
  }
  resetPuck(dir);
  countdown = 75;
}

function resetPuck(dir) {
  puck.x = W / 2;
  puck.y = H / 2;
  puck.vx = 0;
  puck.vy = 0;   // stays put during the countdown; served on release below
  // Give it a gentle serve toward `dir` once countdown ends via a nudge.
  puck._serve = dir;
}

// When countdown hits zero on the host, serve the puck.
function maybeServe() {
  if (countdown === 0 && puck.vx === 0 && puck.vy === 0 && puck._serve) {
    puck.vy = 6 * puck._serve;
    puck.vx = (Math.random() - 0.5) * 6;
    puck._serve = 0;
  }
}

// -------- GUEST: apply a snapshot --------
function applyState(m) {
  puck.x = m.px; puck.y = m.py;
  hostPaddle.x = m.hx; hostPaddle.y = m.hy;   // opponent paddle: trust host
  // Our own paddle (guestPaddle) is driven locally in guestStep() for zero
  // input lag; we deliberately do NOT overwrite it from the snapshot.
  score.host = m.sh; score.guest = m.sg;
  countdown = m.cd;
  updateScoreHud();
}

// ===================================================================
//  Score / win
// ===================================================================
// From each player's own perspective: "my" score is shown at the bottom.
function myScore()  { return isHost ? score.host  : score.guest; }
function oppScore() { return isHost ? score.guest : score.host; }

function updateScoreHud() {
  $('score-bottom').textContent = myScore();
  $('score-top').textContent = oppScore();
}

function endGame(hostWon) {
  gameOver = true;
  running = false;
  const iWon = isHost ? hostWon : !hostWon;
  showOverlay((iWon ? '🏆 You win!' : '😢 You lose') +
    '<br><small>' + myScore() + ' – ' + oppScore() + '</small>' +
    '<br><button class="big-btn" style="margin-top:16px;max-width:200px" onclick="location.reload()">Play again</button>');
}

// ===================================================================
//  Rendering
// ===================================================================
function resizeCanvas() {
  // Fixed internal resolution; CSS scales it. Keep it crisp on retina.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function render() {
  if (isHost) maybeServe();

  ctx.clearRect(0, 0, W, H);

  // Guest sees the board rotated 180°.
  ctx.save();
  if (!isHost) { ctx.translate(W, H); ctx.rotate(Math.PI); }

  drawTable();

  // Which canonical paddle belongs to which character?
  // HOST paddle = host player's char; GUEST paddle = guest player's char.
  const hostCharKey  = isHost ? myChar : opponentChar;
  const guestCharKey = isHost ? opponentChar : myChar;

  drawPaddle(hostPaddle, hostCharKey);
  drawPaddle(guestPaddle, guestCharKey);
  drawPuck();

  ctx.restore();

  if (countdown > 0 && !gameOver) drawCountdown();
}

function drawTable() {
  // Centre line + circle.
  ctx.strokeStyle = 'rgba(255,255,255,.12)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 70, 0, Math.PI * 2);
  ctx.stroke();

  // Goals.
  const gx0 = (W - GOAL_W) / 2;
  ctx.fillStyle = 'rgba(78,161,255,.18)';
  ctx.fillRect(gx0, 0, GOAL_W, 8);
  ctx.fillStyle = 'rgba(255,107,157,.18)';
  ctx.fillRect(gx0, H - 8, GOAL_W, 8);
  ctx.strokeStyle = 'rgba(255,255,255,.35)';
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(gx0, 2); ctx.lineTo(gx0 + GOAL_W, 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(gx0, H - 2); ctx.lineTo(gx0 + GOAL_W, H - 2); ctx.stroke();
}

function drawPaddle(pad, charKey) {
  const c = CHARS[charKey] || { color: '#888', name: '?' };
  ctx.save();
  // Work in a local frame centred on the paddle. For the guest the whole
  // board is rotated 180°, so counter-rotate here to keep faces/letters
  // upright.
  ctx.translate(pad.x, pad.y);
  if (!isHost) ctx.rotate(Math.PI);

  ctx.beginPath();
  ctx.arc(0, 0, PADDLE_R, 0, Math.PI * 2);

  const img = avatarImg[charKey];
  if (img && img.loaded) {
    ctx.save();
    ctx.clip();
    ctx.drawImage(img, -PADDLE_R, -PADDLE_R, PADDLE_R * 2, PADDLE_R * 2);
    ctx.restore();
    ctx.lineWidth = 4;
    ctx.strokeStyle = c.color;
    ctx.stroke();
  } else {
    // Fallback disc with the character's initial.
    ctx.fillStyle = c.color;
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(c.name[0], 0, 1);
  }
  ctx.restore();
}

function drawPuck() {
  ctx.beginPath();
  ctx.arc(puck.x, puck.y, PUCK_R, 0, Math.PI * 2);
  ctx.fillStyle = '#f4f7fb';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#9fb0c8';
  ctx.stroke();
}

function drawCountdown() {
  const n = Math.ceil(countdown / 30);
  const cx = W / 2;
  const afterGoal = (score.host + score.guest) > 0;   // 0-0 == opening serve

  ctx.save();
  ctx.textAlign = 'center';

  if (afterGoal) {
    // "GOAL!" banner + the current score in each player's colour.
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffd94e';
    ctx.font = 'bold 46px sans-serif';
    ctx.fillText('GOAL!', cx, H / 2 - 150);

    const myC  = CHARS[myChar]       || { color: '#fff', name: 'You' };
    const oppC = CHARS[opponentChar] || { color: '#fff', name: 'Them' };
    ctx.font = 'bold 78px sans-serif';
    ctx.fillStyle = myC.color;
    ctx.fillText(String(myScore()), cx - 82, H / 2 - 60);
    ctx.fillStyle = oppC.color;
    ctx.fillText(String(oppScore()), cx + 82, H / 2 - 60);
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.font = 'bold 44px sans-serif';
    ctx.fillText('–', cx, H / 2 - 60);

    ctx.fillStyle = 'rgba(255,255,255,.7)';
    ctx.font = '600 20px sans-serif';
    ctx.fillText('You', cx - 82, H / 2 - 10);
    ctx.fillText(oppC.name, cx + 82, H / 2 - 10);
  }

  // Ready countdown number.
  ctx.fillStyle = 'rgba(255,255,255,.95)';
  ctx.font = 'bold 90px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(n > 0 ? String(n) : 'GO', cx, afterGoal ? H / 2 + 90 : H / 2);
  ctx.restore();
}

// ===================================================================
//  Overlay helpers
// ===================================================================
function showOverlay(html) {
  $('overlay-text').innerHTML = html;
  $('overlay').classList.remove('hidden');
}
function hideOverlay() { $('overlay').classList.add('hidden'); }

window.addEventListener('resize', () => { if (running) resizeCanvas(); });
