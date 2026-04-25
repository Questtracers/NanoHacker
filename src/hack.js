// Hacking minigame — math-based corridor navigation.
// - Path nodes hold a signed integer value in [-9, 9] \ {0}; arithmetic wraps mod 10.
// - Conn cells look like gray IP-fragment decoration (value always 0, passable).
// - Commands: 3 directional ops with random ±1..6 deltas + occasional routines.
// - Routines: `sudo del N` zeros every node where value=N; `exec ±N` shifts all
//   CONNECTED non-zero cells by ±N. Disconnected 0-cells are preserved.
// - Reaching a 0-cell cascades the cursor through connected 0-chains (combo).
// - Win by reaching any cell of the 3-cell target band (displays hex address).

// ROWS / COLS are recomputed per run from the requested difficulty so the
// generator can always fit a path with exactly N nodes. They stay let-scoped
// inside the module — the class can resize freely without leaking outside.
let   ROWS      = 5;
let   COLS      = 15;
const CELL_W    = 2;
const PREFIX_W  = 14;
const HACK_TIME = 120;
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 9;

const WALL_TOKENS = [
  'ls','fn','rx','&&','>>','//','cd','px','0x','>>',
  '| ','> ','if','rm','do','fi','AC','DB','FF',';;',
  'ec','pt','ln','mv','cp','wc','tr','gp','sk','tx',
  'kx','vn','xr','bz','yt','ok','nk','dk','wr','qt',
];

const PFX_RAW = [
  (r2, rh) => `ls fn[${r2}]>>`,
  (r2, rh) => `seg[${r2}]:ec`,
  (r2, rh) => `ptr[0x${rh}]|`,
  (r2, rh) => `grep[${r2}]>`,
  (r2, rh) => `cat:${rh}>`,
];

const SFX_POOL = [
  '// 0xff', '&& echo $?', '| grep 0', '> /dev/null',
  '; fi', '|| exit 1', '# ok', '2>&1', '>> /tmp/x',
  '| wc -l', '; done', '&& ls', '::', '0x1f2a',
  '| tail -1', '&& return 0', '//ok', '> nul', '| more',
];

// 4-neighbours used for BFS/cascade geometry (no longer used for command names).
const DIRS = [
  { dr: -1, dc:  0 }, { dr:  1, dc:  0 },
  { dr:  0, dc: -1 }, { dr:  0, dc:  1 },
];

// Flavour verbs — commands all do the same thing (broadcast to connected
// non-zero nodes); different names just break visual monotony.
const PATCH_VERBS = ['patch', 'sync', 'poke', 'nudge', 'bind', 'trace'];

function randomPort() {
  return '0x' + Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
}

function padPfx(ri) {
  const r2  = String(ri).padStart(2, '0');
  const rh  = ri.toString(16).padStart(2, '0');
  const raw = PFX_RAW[ri % PFX_RAW.length](r2, rh);
  return raw.length >= PREFIX_W ? raw.slice(0, PREFIX_W) : raw.padEnd(PREFIX_W);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Wrap an integer to the [-9, 9] range using mod-10 cycles.
function wrap10(v) {
  while (v > 9) v -= 10;
  while (v < -9) v += 10;
  return v;
}

// Command-form delta: bare number for addition (3), `drop N` for subtraction.
// Keeps the input free of "-" — the dash is awkward to type on most keyboards.
function fmtOp(d)     { return d < 0 ? `drop ${-d}` : `${d}`; }
function fmtOpPhrase(d) { return d < 0 ? `drop ${-d}` : `add ${d}`; }

export class HackMinigame {
  constructor(hp = {}) {
    // Host-provided callbacks for the shared hack-points pool
    this._getHP   = hp.getHP   || (() => 0);
    this._spendHP = hp.spendHP || (() => {});

    this.active          = false;
    this.run             = 1;
    this.depth           = 0;
    this.board           = [];
    this.rowPfx          = [];
    this.cursor          = { row: 0, col: 0 };
    this.targetCell      = null;
    this.targetAddr      = '';
    this.targetWidth     = 3;
    this.gameOver        = false;
    this.won             = false;
    this.hasRealMoves    = false;
    this.availableCommands = [];
    this.outputQueue     = [];
    this.outputTimer     = null;
    this.timeLeft        = HACK_TIME;
    this.clockTimer      = null;
    this.awaitingDismiss = false;
    this.difficulty      = 3; // 1..9 ; equals the minimum path-node count.

    this._injectCSS();
    this._buildDOM();
  }

  // ── Styles ────────────────────────────────────────────────────────────────

  _injectCSS() {
    const s = document.createElement('style');
    s.textContent = `
      #hack-overlay {
        position:fixed; inset:0; z-index:50;
        background:#010a05; display:none; flex-direction:row;
        font-family:'Courier New',Courier,monospace;
        font-size:18px; line-height:1.55;
        color:#22aa55; box-sizing:border-box;
      }
      #hack-main {
        flex:1; display:flex; flex-direction:column;
        padding:18px 24px; min-width:0; overflow:hidden;
      }
      #hack-header {
        display:flex; justify-content:space-between; align-items:baseline;
        border-bottom:1px solid #1a4a2a; padding-bottom:8px; margin-bottom:10px;
        font-size:14px; color:#44ff88; letter-spacing:.06em; flex-shrink:0;
      }
      #hack-output {
        flex:1; overflow-y:auto; overflow-x:auto; white-space:pre; padding-bottom:4px;
      }
      #hack-input-row {
        border-top:1px solid #1a4a2a; padding-top:8px; flex-shrink:0;
        display:flex; align-items:center; color:#44ff88;
        transition: border-color .2s, color .2s;
      }
      #hack-input-row.danger { border-top-color:#ff3333; color:#ff3333; }
      #hack-input-row.danger #hack-input { color:#ff3333; caret-color:#ff3333; }
      #hack-input {
        flex:1; background:transparent; border:none;
        color:#44ff88; font-family:inherit; font-size:inherit;
        outline:none; caret-color:#44ff88;
      }
      #hack-hint { font-size:13px; color:#1a5a2a; margin-left:14px; white-space:nowrap; }
      #hack-clock-panel {
        width:200px; flex-shrink:0;
        border-left:1px solid #1a4a2a;
        display:flex; flex-direction:column; align-items:center;
        padding:24px 10px 18px; box-sizing:border-box;
      }
      #hack-clock-label {
        color:#2a7a3a; margin-bottom:14px; font-size:13px; letter-spacing:.1em;
      }
      #hack-clock-face  { white-space:pre; line-height:1.35; color:#44ff88; font-size:18px; }
      #hack-clock-time  { margin-top:12px; font-size:15px; color:#44ff88; letter-spacing:.12em; }
      #hack-hp-section { margin-top:22px; text-align:center; }
      #hack-hp-label   { color:#2a7a3a; font-size:13px; letter-spacing:.1em; }
      #hack-hp-value   { color:#cc88ff; font-size:26px; font-weight:bold; margin-top:4px; }
      #hack-legend {
        margin-top:20px; font-size:12px; line-height:1.7;
        color:#2a7a3a; width:100%;
      }
      #hack-legend .hk-legend-row { display:flex; justify-content:space-between; padding:0 2px; }
      #hack-legend b   { color:#44ff88; font-weight:bold; }
      #hack-legend .hp { color:#cc88ff; font-weight:bold; }
      .hk-wall    { color:#1e6b2e; }
      .hk-num     { color:#44ff88; font-weight:bold; }
      .hk-neg     { color:#ff9944; font-weight:bold; }
      .hk-zero    { color:#77ddff; font-weight:bold; }
      .hk-trail   { color:#1e5a4a; }
      .hk-locked  { color:#666666; }
      .hk-conn    { color:#777777; }
      .hk-target  { color:#ffcc00; font-weight:bold; }
      .hk-cursor  { background:#44ff88; color:#010a05; font-weight:bold; }
      .hk-err     { color:#ff4444; }
      .hk-ok      { color:#00ffff; }
      .hk-winroute{ color:#00ffff; font-weight:bold; }
      .hk-routine { color:#cc88ff; font-weight:bold; }
      .hk-comment { color:#2a7a3a; }
      .hk-dim     { color:#1e5a2e; }
      .hk-sep     { color:#153a25; }
    `;
    document.head.appendChild(s);
  }

  // ── DOM ───────────────────────────────────────────────────────────────────

  _buildDOM() {
    const overlay = document.createElement('div');
    overlay.id = 'hack-overlay';

    const main = document.createElement('div');
    main.id = 'hack-main';

    const header = document.createElement('div');
    header.id = 'hack-header';
    header.innerHTML =
      `<span>NanoHacker :: TERMINAL EMULATION v1.0</span>` +
      `<span id="hack-status">RUN 01 | DEPTH 000</span>`;

    const output = document.createElement('pre');
    output.id = 'hack-output';

    const inputRow = document.createElement('div');
    inputRow.id = 'hack-input-row';

    const form = document.createElement('form');
    form.style.cssText = 'flex:1;display:flex;align-items:center';

    const prompt = document.createElement('span');
    prompt.textContent = 'C:\\NULL_ROUTE> ';

    const input = document.createElement('input');
    input.id = 'hack-input';
    input.autocomplete = 'off';
    input.spellcheck   = false;

    const hint = document.createElement('span');
    hint.id = 'hack-hint';
    hint.textContent = '[ESC] abort';

    form.appendChild(prompt);
    form.appendChild(input);
    inputRow.appendChild(form);
    inputRow.appendChild(hint);

    main.appendChild(header);
    main.appendChild(output);
    main.appendChild(inputRow);

    const clockPanel = document.createElement('div');
    clockPanel.id = 'hack-clock-panel';

    const clockLabel = document.createElement('div');
    clockLabel.id = 'hack-clock-label';
    clockLabel.textContent = '─ BREACH TIMER ─';

    const clockFace = document.createElement('pre');
    clockFace.id = 'hack-clock-face';

    const clockTime = document.createElement('div');
    clockTime.id = 'hack-clock-time';

    clockPanel.appendChild(clockLabel);
    clockPanel.appendChild(clockFace);
    clockPanel.appendChild(clockTime);

    // ── Hack-points counter
    const hpSection = document.createElement('div');
    hpSection.id = 'hack-hp-section';
    const hpLabel = document.createElement('div');
    hpLabel.id = 'hack-hp-label';
    hpLabel.textContent = '─ HACK POINTS ─';
    const hpValue = document.createElement('div');
    hpValue.id = 'hack-hp-value';
    hpValue.textContent = '0';
    hpSection.appendChild(hpLabel);
    hpSection.appendChild(hpValue);
    clockPanel.appendChild(hpSection);

    // ── Premium-action legend (HP-gated commands)
    const legend = document.createElement('div');
    legend.id = 'hack-legend';
    legend.innerHTML =
      `<div class="hk-legend-row"><span><b>cls</b> regen funcs</span><span class="hp">1 HP</span></div>` +
      `<div class="hk-legend-row"><span><b>1..4</b> quick fn</span><span class="hp">1 HP</span></div>` +
      `<div class="hk-legend-row"><span><b>overclock</b> +60s</span><span class="hp">2 HP</span></div>`;
    clockPanel.appendChild(legend);

    overlay.appendChild(main);
    overlay.appendChild(clockPanel);
    document.body.appendChild(overlay);

    this.overlay      = overlay;
    this.outputEl     = output;
    this.inputEl      = input;
    this.statusEl     = document.getElementById('hack-status');
    this.clockFaceEl  = clockFace;
    this.clockTimeEl  = clockTime;
    this.clockLabelEl = clockLabel;
    this.inputRowEl   = inputRow;
    this.hpValueEl    = hpValue;

    form.addEventListener('submit', e => {
      e.preventDefault();
      const raw = input.value;
      input.value = '';
      this._appendLines([`C:\\NULL_ROUTE> <span class="hk-num">${this._esc(raw || ' ')}</span>`]);
      this._runCommand(raw);
    });

    document.addEventListener('keydown', e => {
      if (!this.active) return;
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    });

    overlay.addEventListener('pointerdown', () => this.inputEl.focus());
  }

  // ── Public ────────────────────────────────────────────────────────────────

  open(difficulty, opts = {}) {
    if (this.active) return;
    if (typeof difficulty === 'number') {
      this.difficulty = Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, difficulty | 0));
    }
    // Outcome callbacks — the host uses these to apply the hack-link effect
    // only when the player actually breaches the target.
    this._onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
    this.active = true;
    this.awaitingDismiss = false;
    this.overlay.style.display = 'flex';
    this._reset();
    this._updateHPDisplay();
    setTimeout(() => this.inputEl.focus(), 30);
  }

  _updateHPDisplay() {
    // Re-query each call so a stale reference (e.g. if the host ever rebuilds
    // the panel) never gets in the way of an HP update.
    const el = this.hpValueEl || document.getElementById('hack-hp-value');
    if (el) el.textContent = String(this._getHP());
  }

  // Charge `cost` hack points for a premium action. Returns true on success,
  // false (and prints an error) if the player doesn't have enough HP.
  _chargeHP(cost, label) {
    const cur = this._getHP();
    if (cur < cost) {
      this._appendLines([
        `<span class="hk-err">fault :: insufficient hack points — [${label}] needs ${cost}, have ${cur}</span>`,
      ]);
      return false;
    }
    this._spendHP(cost);
    this._updateHPDisplay();
    return true;
  }

  close() {
    this.active = false;
    this.overlay.style.display = 'none';
    if (this.outputTimer) { clearInterval(this.outputTimer); this.outputTimer = null; }
    if (this.clockTimer)  { clearInterval(this.clockTimer);  this.clockTimer  = null; }
    // Fire the host callback once with the final outcome, then clear it so
    // it can't re-trigger on a subsequent abort.
    const cb = this._onClose;
    const won = !!this.won;
    this._onClose = null;
    if (cb) cb(won);
  }

  // ── Clock ─────────────────────────────────────────────────────────────────

  _startClock() {
    this.timeLeft = HACK_TIME;
    this._updateClock();
    this.clockTimer = setInterval(() => {
      if (!this.active || this.gameOver) return;
      this.timeLeft = Math.max(0, this.timeLeft - 1);
      this._updateClock();
      if (this.timeLeft <= 0) this._timeUp();
    }, 1000);
  }

  _timeUp() {
    this.gameOver = true;
    this.awaitingDismiss = true;
    if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = null; }
    this._appendLines([
      `<span class="hk-err">-- TIME EXCEEDED // trace locked // session terminated --</span>`,
      `<span class="hk-dim">close terminal? (y/n)</span>`,
    ]);
  }

  _updateClock() {
    const isRed = this.timeLeft < 15;
    const col   = isRed ? '#ff3333' : '#44ff88';
    const secs  = Math.ceil(this.timeLeft);
    this.clockFaceEl.textContent = this._renderClockFace();
    this.clockFaceEl.style.color = col;
    this.clockTimeEl.textContent = `0x${secs.toString(16).padStart(2, '0')}`;
    this.clockTimeEl.style.color = col;
    this.clockLabelEl.style.color = isRed ? '#ff3333' : '#2a7a3a';
    if (this.inputRowEl) this.inputRowEl.classList.toggle('danger', isRed);
  }

  _renderClockFace() {
    const W = 11, H = 7, cx = 5, cy = 3, Rx = 4, Ry = 2.4;
    const grid = Array.from({ length: H }, () => Array(W).fill(' '));
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const x = Math.round(cx + Math.cos(a) * Rx);
      const y = Math.round(cy + Math.sin(a) * Ry);
      if (x >= 0 && x < W && y >= 0 && y < H) grid[y][x] = '·';
    }
    const elapsed = HACK_TIME - this.timeLeft;
    const angle   = -Math.PI / 2 + (elapsed / HACK_TIME) * Math.PI * 2;
    for (let t = 0.18; t <= 1.0; t += 0.12) {
      const x = Math.round(cx + Math.cos(angle) * Rx * t);
      const y = Math.round(cy + Math.sin(angle) * Ry * t);
      if (x >= 0 && x < W && y >= 0 && y < H && grid[y][x] !== '·')
        grid[y][x] = t >= 0.85 ? '▪' : '╌';
    }
    const tx = Math.round(cx + Math.cos(angle) * Rx);
    const ty = Math.round(cy + Math.sin(angle) * Ry);
    if (tx >= 0 && tx < W && ty >= 0 && ty < H) grid[ty][tx] = '▪';
    grid[cy][cx] = '◈';
    return grid.map(r => r.join('')).join('\n');
  }

  // ── Board generation ──────────────────────────────────────────────────────

  _reset() {
    this.depth           = 0;
    this.gameOver        = false;
    this.won             = false;
    this.awaitingDismiss = false;
    this.winRoute        = null;
    this.outputEl.innerHTML = '';
    this.outputQueue = [];
    if (this.outputTimer) { clearInterval(this.outputTimer); this.outputTimer = null; }
    if (this.clockTimer)  { clearInterval(this.clockTimer);  this.clockTimer  = null; }

    this._generateBoard();
    // Cursor starts at the origin path cell. Directional commands shoot
    // through conn cells to the first non-zero node — no auto-cascade.
    this._refreshCommands();
    this._updateStatus();
    this._startClock();
    this._appendDump([
      `<span class="hk-ok">-- NanoHacker v1.0 | lvl ${this.difficulty} | breach initiated | target: ${this.targetAddr} --</span>`,
    ]);
  }

  _generateBoard() {
    // Difficulty = minimum number of path nodes on the shortest route. The
    // board is sized to comfortably host that many nodes. 5 rows is enough
    // for all difficulties (up to 9) because we can snake via vertical hops.
    const diff = Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, this.difficulty | 0 || 3));
    ROWS = 5;
    COLS = Math.max(15, diff * 4 + 8); // room for ~diff nodes + target band

    // Fill with walls
    this.board = Array.from({ length: ROWS }, () =>
      Array.from({ length: COLS }, () => ({
        type:  'wall',
        token: WALL_TOKENS[Math.floor(Math.random() * WALL_TOKENS.length)],
      }))
    );

    const pathNodes = [];

    const placePath = (r, c, forceValue = null) => {
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return false;
      const existing = this.board[r][c];
      if (existing.type === 'path' || existing.type === 'target') return false;
      const value = forceValue !== null ? forceValue : this._pickRandomPathValue(r, c);
      this.board[r][c] = { type: 'path', value };
      pathNodes.push({ row: r, col: c });
      return true;
    };

    const placeConn = (r, c) => {
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return;
      if (this.board[r][c].type !== 'wall') return;
      const ip = String(10 + Math.floor(Math.random() * 90));
      this.board[r][c] = { type: 'conn', value: 0, ip };
    };

    const carveH = (r, c1, c2) => {
      const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
      for (let c = minC + 1; c < maxC; c++) placeConn(r, c);
    };

    // Cursor start — always leftmost, centre row.
    const startRow = Math.floor(ROWS / 2);
    const startCol = 1;
    placePath(startRow, startCol, 0);
    this.cursor = { row: startRow, col: startCol };

    // ── Difficulty-driven main route: advance east, placing exactly `diff`
    // path nodes (the start counts as the first). A vertical hop is just a
    // column-preserving detour via a filler + node — uses no horizontal space.
    let cr = startRow, cc = startCol;
    let placed = 1;

    const tryVerticalHop = () => {
      const dirChoices = [-1, 1].filter(dr => {
        const midR = cr + dr, endR = cr + 2 * dr;
        return midR >= 0 && midR < ROWS && endR >= 0 && endR < ROWS &&
               this.board[midR][cc].type === 'wall' &&
               this.board[endR][cc].type === 'wall';
      });
      if (!dirChoices.length) return false;
      const dr   = dirChoices[Math.floor(Math.random() * dirChoices.length)];
      const midR = cr + dr, endR = cr + 2 * dr;
      placeConn(midR, cc);
      placePath(endR, cc);
      cr = endR;
      return true;
    };

    while (placed < diff) {
      // Decide: vertical hop (same column, cheap on space) or east stride.
      // Remaining horizontal room decides — save 6 cols for the target band.
      const eastRoom = COLS - 5 - cc;
      const goVertical = eastRoom < 4 || Math.random() < 0.35;
      if (goVertical && tryVerticalHop()) { placed++; continue; }

      // East stride of 3-4 cols
      const hop = 3 + Math.floor(Math.random() * 2);
      const nc  = cc + hop;
      if (nc > COLS - 5) break;
      carveH(cr, cc, nc);
      if (placePath(cr, nc)) { cc = nc; placed++; }
      else break;
    }

    // Last placed node is the "door" to the target.
    const lastNode = pathNodes[pathNodes.length - 1];
    const tRow     = lastNode.row;
    let tStart = Math.min(lastNode.col + 2, COLS - 3);
    if (tStart <= lastNode.col) tStart = lastNode.col + 2;
    carveH(tRow, lastNode.col, tStart);

    for (let k = 0; k < 3; k++) {
      const c = tStart + k;
      if (c < 0 || c >= COLS) continue;
      this.board[tRow][c] = { type: 'target', value: 1, chunk: k };
    }
    this.targetCell  = { row: tRow, col: tStart };
    this.targetWidth = 3;

    // ── Spurs & stubs for variety. Only the cells actually overwritten need
    //    to be walls; a spur may occasionally brush against the main route
    //    and create a shortcut, which is fine — the player gets the odd
    //    lucky break and the maze feels more organic.
    const allWallsAt = (r, c) =>
      r >= 0 && r < ROWS && c >= 0 && c < COLS &&
      this.board[r][c].type === 'wall';

    const tryHorizontalSpur = () => {
      if (pathNodes.length < 2) return false;
      const anchor = pathNodes[1 + Math.floor(Math.random() * (pathNodes.length - 1))];
      const dir    = Math.random() < 0.5 ? -1 : 1;
      const len    = 2 + Math.floor(Math.random() * 4);
      const endC   = anchor.col + dir * len;
      if (endC < 1 || endC >= COLS - 1) return false;
      const minC = Math.min(anchor.col, endC) + 1;
      const maxC = Math.max(anchor.col, endC);
      // Only require the spur's own cells are walls — don't care what's above
      // or below.
      for (let c = minC; c <= maxC; c++) {
        if (!allWallsAt(anchor.row, c)) return false;
      }
      carveH(anchor.row, anchor.col, endC);
      placePath(anchor.row, endC);
      return true;
    };

    const tryVerticalStub = () => {
      const anchor = pathNodes[Math.floor(Math.random() * pathNodes.length)];
      const dr   = Math.random() < 0.5 ? -1 : 1;
      const midR = anchor.row + dr;
      const endR = anchor.row + 2 * dr;
      if (!allWallsAt(midR, anchor.col) || !allWallsAt(endR, anchor.col)) return false;
      placeConn(midR, anchor.col);
      placePath(endR, anchor.col);
      return true;
    };

    const wantSpurs = 3 + Math.floor(Math.random() * 3);
    const wantStubs = 2 + Math.floor(Math.random() * 2);
    for (let s = 0, tries = 0; s < wantSpurs && tries < 20; tries++) {
      if (tryHorizontalSpur()) s++;
    }
    for (let s = 0, tries = 0; s < wantStubs && tries < 20; tries++) {
      if (tryVerticalStub()) s++;
    }

    const addrNum   = Math.floor(Math.random() * 0x1000);
    this.targetAddr = `0x${addrNum.toString(16).padStart(3, '0')}`;

    this.rowPfx = Array.from({ length: ROWS }, (_, ri) => padPfx(ri));
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  // Any directly-connected graph neighbour with a non-zero value?
  _hasConnectedNonZero() {
    for (const n of this._directlyConnectedNodes()) {
      if (this.board[n.r][n.c].value !== 0) return true;
    }
    return false;
  }

  // Build a patch command with a delta not shared by existing slots.
  _makePatchCommand(usedDeltas) {
    const pool = [];
    for (let v = -6; v <= 6; v++) {
      if (v === 0) continue;
      if (usedDeltas.has(v)) continue;
      pool.push(v);
    }
    if (!pool.length) return null;
    const delta = pool[Math.floor(Math.random() * pool.length)];
    const verb  = PATCH_VERBS[Math.floor(Math.random() * PATCH_VERBS.length)];
    return {
      kind:    'patch',
      delta,
      cmdFull: `${verb} ${fmtOp(delta)}`,
      desc:    `${fmtOpPhrase(delta)} across link map [port ${randomPort()}]`,
    };
  }

  // Build ONE replacement command given the currently-held slots.
  // Hard 20% routine cap; otherwise a patch with an unused delta.
  _generateReplacement(excludeIdx) {
    const usedDeltas = new Set();
    for (let i = 0; i < this.availableCommands.length; i++) {
      if (i === excludeIdx) continue;
      const c = this.availableCommands[i];
      if (c && c.kind === 'patch') usedDeltas.add(c.delta);
    }

    const canPatch = this._hasConnectedNonZero();

    if (Math.random() < 0.20) {
      const r = this._makeRoutine();
      if (r) return r;
    }

    if (canPatch) {
      const p = this._makePatchCommand(usedDeltas);
      if (p) return p;
    }

    // No patch possible (or delta pool exhausted) — fall back to a routine.
    const r = this._makeRoutine();
    if (r) return r;
    return {
      kind: 'routine', type: 'shift', delta: 1,
      cmdFull: 'exec 1',
      desc:    'add 1 across live segment',
    };
  }

  _refreshCommands() {
    this.availableCommands = [];
    for (let i = 0; i < 4; i++) {
      this.availableCommands.push(this._generateReplacement(-1));
    }
    this.availableCommands = shuffle(this.availableCommands);
    this.hasRealMoves = true;
  }

  _makeRoutine() {
    // Reseed is niche — only for breaking out when locked 0-cells exist
    // between hops. 10 % chance and never duplicated in the slot pool.
    const hasReseed = this.availableCommands.some(c => c && c.type === 'reseed');
    if (!hasReseed && Math.random() < 0.10) {
      return {
        kind:    'routine',
        type:    'reseed',
        cmdFull: 'reseed 0',
        desc:    'reseed every locked 0-cell with fresh values',
      };
    }

    // Half of the remaining routines are sudo del N, the rest are exec ±N.
    if (Math.random() < 0.5) {
      const present = new Set();
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const cell = this.board[r][c];
          if (cell.type === 'path' && cell.value !== 0) present.add(cell.value);
        }
      }
      const arr = [...present];
      if (arr.length) {
        const n = arr[Math.floor(Math.random() * arr.length)];
        return {
          kind:    'routine',
          type:    'del',
          n,
          cmdFull: `sudo del ${n}`,
          desc:    `priv esc :: drop nodes where v=${n}`,
        };
      }
    }
    const mag   = 1 + Math.floor(Math.random() * 3);
    const sign  = Math.random() < 0.5 ? -1 : 1;
    const delta = sign * mag;
    return {
      kind:    'routine',
      type:    'shift',
      delta,
      cmdFull: `exec ${fmtOp(delta)}`,
      desc:    `broadcast ${fmtOpPhrase(delta)} across live segment`,
    };
  }

  _runCommand(raw) {
    const input = raw.trim().toLowerCase();

    // After a win or timeout we wait for the player to confirm the dismissal.
    // Only "y" / "yes" closes; anything else gets a hacker brush-off and the
    // prompt comes back.
    if (this.awaitingDismiss) {
      if (input === 'y' || input === 'yes') {
        this.close();
        return;
      }
      this._appendLines([
        `<span class="hk-err">connection lost :: this terminal is not wired to anything any more</span>`,
        `<span class="hk-dim">close terminal? (y/n)</span>`,
      ]);
      return;
    }

    if (this.gameOver) {
      this._appendLines([`<span class="hk-err">session closed :: type <b>reset</b> to reboot</span>`]);
      return;
    }
    if (!input) { this._appendLines(['empty packet ignored']); return; }

    if (input === 'reset' || input === 'reboot') {
      this.run++; this._reset(); return;
    }

    // Regenerate every function slot with fresh options. Costs 1 hack point.
    if (input === 'cls') {
      if (!this._chargeHP(1, 'cls')) return;
      this.depth++;
      this._refreshCommands();
      this._updateStatus();
      this._appendDump([
        `<span class="hk-ok">-- func registry flushed // fresh opcodes queued --</span>`,
      ]);
      return;
    }

    // Overclock the breach timer: +60 seconds, costs 2 hack points.
    if (input === 'overclock') {
      if (!this._chargeHP(2, 'overclock')) return;
      this.depth++;
      this.timeLeft += 60;
      this._updateClock();
      this._updateStatus();
      this._appendDump([
        `<span class="hk-ok">-- chrono overclock // +60s injected into breach loop --</span>`,
      ]);
      return;
    }

    // Pure numeric shortcut "1".."9" — quick-access a slot, costs 1 hack point.
    if (/^[1-9]$/.test(input)) {
      const idx = parseInt(input, 10) - 1;
      if (idx >= 0 && idx < this.availableCommands.length) {
        if (!this._chargeHP(1, `fn[${idx + 1}]`)) return;
        this._applyCommand(this.availableCommands[idx]);
        return;
      }
    }

    const match = this.availableCommands.find(c => c.cmdFull.toLowerCase() === input);
    if (match) { this._applyCommand(match); return; }

    const valid = this.availableCommands.map((c, i) => `${i + 1}/${c.cmdFull}`).join(' | ');
    this._appendLines([`<span class="hk-err">packet rejected :: valid: ${valid}</span>`]);
  }

  _applyCommand(cmd) {
    this.depth++;
    const usedIdx = this.availableCommands.indexOf(cmd);
    const prevCursor = { row: this.cursor.row, col: this.cursor.col };

    let applied = false; // true if the command actually mutated cell values

    if (cmd.kind === 'patch') {
      const nodes = this._directlyConnectedNodes();
      for (const { r, c } of nodes) {
        const cell = this.board[r][c];
        if (cell.value === 0) continue;
        cell.value = wrap10(cell.value + cmd.delta);
        applied = true;
      }
      if (!applied) {
        this._appendLines([`<span class="hk-err">fault :: no live nodes in segment</span>`]);
      }
    } else if (cmd.kind === 'routine') {
      if (cmd.type === 'del')    this._routineDelete(cmd.n);
      if (cmd.type === 'shift')  this._routineShift(cmd.delta);
      if (cmd.type === 'reseed') this._routineReseed();
      applied = true;
    }

    // EARLY win check — did this command alone open a clean corridor (conns,
    // already-locked trail, and now-zeroed cells) all the way to the goal?
    // If yes, declare victory at the cursor's CURRENT position so the player
    // visually stays where they were when they hacked the final node.
    if (applied && this._goalCorridorOpen()) return this._handleWin();

    // Otherwise let the cursor cascade through any chain of live 0-cells the
    // command produced, then check connectivity again as a safety net.
    if (applied) this._cascadeCursor();
    if (this._goalCorridorOpen()) return this._handleWin();

    const cursorMoved = this.cursor.row !== prevCursor.row ||
                        this.cursor.col !== prevCursor.col;
    if (cursorMoved) this._reassignZeroPaths();

    if (usedIdx >= 0) {
      this.availableCommands[usedIdx] = this._generateReplacement(usedIdx);
    }

    this._updateStatus();
    this._appendDump();
  }

  // Goal-reachable BFS used for the "did this op win the run?" check. Walks
  // through any cell a successful run would naturally cross: conns, locked
  // trail, freshly-zeroed path nodes, and target cells. Live (non-zero) path
  // nodes block, since those are the gates the player still has to crack.
  _goalCorridorOpen() {
    const t = this.targetCell;
    if (!t) return false;
    const inBand = (r, c) =>
      r === t.row && c >= t.col && c < t.col + this.targetWidth;
    const seen = new Set([`${this.cursor.row},${this.cursor.col}`]);
    const q = [{ r: this.cursor.row, c: this.cursor.col }];
    while (q.length) {
      const { r, c } = q.shift();
      if (inBand(r, c)) return true;
      for (const d of DIRS) {
        const nr = r + d.dr, nc = c + d.dc;
        if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
        const k = `${nr},${nc}`;
        if (seen.has(k)) continue;
        const cell = this.board[nr][nc];
        if (cell.type === 'wall') continue;
        const passable =
          cell.type === 'conn' ||
          cell.type === 'target' ||
          (cell.type === 'path' && (cell.locked || cell.value === 0));
        if (!passable) continue;
        seen.add(k);
        q.push({ r: nr, c: nc });
      }
    }
    return false;
  }

  _handleWin() {
    this.gameOver = true; this.won = true;
    this.awaitingDismiss = true;
    if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = null; }
    if (this.inputRowEl)   this.inputRowEl.classList.remove('danger');
    if (this.clockFaceEl)  this.clockFaceEl.style.color = '#44ff88';
    if (this.clockTimeEl)  this.clockTimeEl.style.color = '#44ff88';
    if (this.clockLabelEl) this.clockLabelEl.style.color = '#2a7a3a';
    this.winRoute = this._findWinRoute();
    const sepLen = PREFIX_W + COLS * CELL_W;
    const sep    = '\u2500'.repeat(sepLen);
    this._appendLines([
      `<span class="hk-dim">:: trace ${String(this.run).padStart(2, '0')}.${String(this.depth).padStart(3, '0')} :: final state ::</span>`,
      ...this._makeBoardLines(),
      `<span class="hk-sep">${this._esc(sep)}</span>`,
      `<span class="hk-ok">-- ACCESS GRANTED // ${this.targetAddr} compromised // returning --</span>`,
      `<span class="hk-dim">close terminal? (y/n)</span>`,
    ]);
  }

  // Pick a non-zero value in [-9, 9] enforcing the sibling rule: for every
  // node Y that would be a graph-neighbour of (r, c), none of Y's OTHER
  // neighbours may share the chosen value. Otherwise, patching Y with the
  // common delta would zero multiple siblings at once and make the player's
  // intent ambiguous. Target cells are exempt (their value is structural).
  _pickRandomPathValue(r, c) {
    const forbidden = new Set();
    for (const y of this._nodeNeighbors(r, c)) {
      for (const z of this._nodeNeighbors(y.r, y.c)) {
        if (z.r === r && z.c === c) continue; // skip self
        const zCell = this.board[z.r][z.c];
        if (zCell.type === 'path' && zCell.value !== 0) forbidden.add(zCell.value);
      }
    }
    const pool = [];
    for (let v = -9; v <= 9; v++) {
      if (v === 0) continue;
      if (forbidden.has(v)) continue;
      pool.push(v);
    }
    if (!pool.length) return (Math.random() < 0.5 ? -1 : 1);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  _reassignZeroPaths() {
    // Every unlocked 0-path cell in the maze gets a fresh random value.
    // LOCKED cells stay at 0 — they represent the player's trail behind them
    // and render as grey 0 (impassable unless the cursor is stuck).
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (r === this.cursor.row && c === this.cursor.col) continue;
        const cell = this.board[r][c];
        if (cell.type !== 'path' || cell.value !== 0) continue;
        if (cell.locked) continue;
        cell.value = this._pickRandomPathValue(r, c);
      }
    }
  }

  _routineReseed() {
    // Reseed honours the same exception: locked trail cells stay at 0.
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (r === this.cursor.row && c === this.cursor.col) continue;
        const cell = this.board[r][c];
        if (cell.type !== 'path' || cell.value !== 0) continue;
        if (cell.locked) continue;
        cell.value = this._pickRandomPathValue(r, c);
      }
    }
  }


  // ── Routines ──────────────────────────────────────────────────────────────

  // Purple routines: GLOBAL to the whole maze. Every path/target node is a
  // candidate; only 0-cells (connected or disconnected) are preserved so
  // combos stay intact.
  _routineDelete(n) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = this.board[r][c];
        if ((cell.type === 'path' || cell.type === 'target') && cell.value === n) {
          cell.value = 0;
        }
      }
    }
  }

  _routineShift(delta) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = this.board[r][c];
        if (cell.type !== 'path' && cell.type !== 'target') continue;
        if (cell.value === 0) continue; // preserve every 0-cell
        cell.value = wrap10(cell.value + delta);
      }
    }
  }

  // Any non-wall cell is reachable from any other non-wall cell, horizontally
  // or vertically — filler corridors can now run in either axis.
  _isValidStep(curCell, d, nCell) {
    return nCell.type !== 'wall';
  }

  // Direct graph neighbours of an arbitrary cell (r, c). A BFS expands through
  // conn cells (transit) but STOPS at every path/target cell, so connectivity
  // is exactly one graph-hop from (r, c). The starting cell itself isn't
  // required to be a path — a to-be-placed wall slot works too, because the
  // step filter ignores start's type and always gates on `_isValidStep`.
  _nodeNeighbors(r, c) {
    // Locked cells (the cursor's old positions) now behave as filler
    // corridors — they're a transit channel that keeps connectivity alive,
    // but the cursor can never land on them (no longer "live" nodes). So
    // BFS keeps walking through locked cells just like through conns; only
    // live path/target cells are returned as graph neighbours.
    const nodes = [];
    const seen = new Set();
    const key = (r, c) => `${r},${c}`;
    seen.add(key(r, c));
    const q = [{ r, c }];
    while (q.length) {
      const { r: rr, c: cc } = q.shift();
      const cur = this.board[rr][cc];
      for (const d of DIRS) {
        const nr = rr + d.dr, nc = cc + d.dc;
        if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
        const k = key(nr, nc);
        if (seen.has(k)) continue;
        const nCell = this.board[nr][nc];
        if (!this._isValidStep(cur, d, nCell)) continue;
        seen.add(k);
        if (nCell.locked) {
          q.push({ r: nr, c: nc }); // transit only, never a destination
        } else if (nCell.type === 'conn') {
          q.push({ r: nr, c: nc });
        } else if (nCell.type === 'path' || nCell.type === 'target') {
          nodes.push({ r: nr, c: nc });
        }
      }
    }
    return nodes;
  }

  _directlyConnectedNodes() {
    return this._nodeNeighbors(this.cursor.row, this.cursor.col);
  }



  // Single shortest-path BFS from the cursor's WIN position to the goal,
  // walking only through cells that genuinely belong to the hack route:
  // conns, locked trail, freshly-zeroed path nodes, and target cells. Spurs
  // the player visited but that aren't on the way to the goal are pruned by
  // construction — they're not on any shortest path. Reconstructs the path
  // by parent pointers so only the cells actually traversed get coloured.
  _findWinRoute() {
    const set = new Set();
    const key = (r, c) => `${r},${c}`;
    const target = this.targetCell;
    if (!target) {
      set.add(key(this.cursor.row, this.cursor.col));
      return set;
    }
    const inBand = (r, c) =>
      r === target.row && c >= target.col && c < target.col + this.targetWidth;
    const startKey = key(this.cursor.row, this.cursor.col);
    const visited  = new Set([startKey]);
    const parent   = new Map();
    const q        = [{ r: this.cursor.row, c: this.cursor.col }];
    let reached    = false;
    while (q.length) {
      const cur = q.shift();
      if (inBand(cur.r, cur.c)) {
        let k = key(cur.r, cur.c);
        while (k !== undefined) {
          set.add(k);
          k = parent.get(k);
        }
        reached = true;
        break;
      }
      for (const d of DIRS) {
        const nr = cur.r + d.dr, nc = cur.c + d.dc;
        if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
        const k = key(nr, nc);
        if (visited.has(k)) continue;
        const cell = this.board[nr][nc];
        if (cell.type === 'wall') continue;
        const onRoute =
          cell.type === 'conn' ||
          cell.type === 'target' ||
          (cell.type === 'path' && (cell.locked || cell.value === 0));
        if (!onRoute) continue;
        visited.add(k);
        parent.set(k, key(cur.r, cur.c));
        q.push({ r: nr, c: nc });
      }
    }
    if (!reached) {
      for (let k = 0; k < this.targetWidth; k++) set.add(key(target.row, target.col + k));
      set.add(startKey);
    }
    return set;
  }

  // Cascade through every 4-adjacent 0-value non-wall cell — path, conn, AND
  // target. With broadcast commands multiple cells may zero in a single turn,
  // so the cursor has to be able to walk the whole 0-chain (including conn
  // corridors) to land on the newly-zeroed node closest to the target.
  // Combo cascade: repeatedly hop to a 0-valued DIRECT graph neighbour. Each
  // iteration recomputes neighbours from the cursor's new position, so we
  // honour the "connection is one hop" rule: B becomes reachable only after
  // the cursor has actually moved onto A.
  _cascadeCursor() {
    const visited = new Set();
    const key = (r, c) => `${r},${c}`;
    visited.add(key(this.cursor.row, this.cursor.col));
    const distToT = (r, c) =>
      Math.abs(r - this.targetCell.row) + Math.abs(c - this.targetCell.col);
    while (true) {
      const nodes = this._directlyConnectedNodes();
      let best = null, bestDist = Infinity;
      for (const n of nodes) {
        const k = key(n.r, n.c);
        if (visited.has(k)) continue;
        const cell = this.board[n.r][n.c];
        if (cell.value !== 0) continue;
        const inTarget = n.r === this.targetCell.row &&
                         n.c >= this.targetCell.col &&
                         n.c <  this.targetCell.col + this.targetWidth;
        const d = distToT(n.r, n.c);
        if (inTarget || d < bestDist) {
          bestDist = d;
          best = n;
          if (inTarget) break;
        }
      }
      if (!best) break;
      // Lock the cell we're leaving so the player can't walk it again.
      // Target cells are the goal and never get locked.
      const leaving = this.board[this.cursor.row][this.cursor.col];
      if (leaving.type === 'path') leaving.locked = true;
      this.cursor = { row: best.r, col: best.c };
      visited.add(key(best.r, best.c));
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  _renderCell(cell, row, col) {
    const isCursor = this.cursor.row === row && this.cursor.col === col;
    if (isCursor) return `<span class="hk-cursor">${'0'.padEnd(CELL_W)}</span>`;

    // Highlight the winning cursor→target route in success cyan.
    const onWinRoute = this.winRoute && this.winRoute.has(`${row},${col}`);

    if (cell.type === 'target') {
      const chunk = cell.chunk ?? 0;
      const start = chunk * CELL_W;
      const text  = this.targetAddr.slice(start, start + CELL_W).padEnd(CELL_W);
      // Goal address always renders in its own yellow — even when the rest
      // of the trail is blue post-win, "0x05c" stays the marker colour.
      return `<span class="hk-target">${this._esc(text)}</span>`;
    }

    if (cell.type === 'path') {
      const v = cell.value;
      if (v === 0) {
        const cls = onWinRoute ? 'hk-winroute' : (cell.locked ? 'hk-locked' : 'hk-zero');
        return `<span class="${cls}">${' 0'}</span>`;
      }
      const text = String(v).padStart(CELL_W);
      const cls  = onWinRoute ? 'hk-winroute' : (v < 0 ? 'hk-neg' : 'hk-num');
      return `<span class="${cls}">${text}</span>`;
    }

    if (cell.type === 'conn') {
      const cls = onWinRoute ? 'hk-winroute' : 'hk-conn';
      return `<span class="${cls}">${this._esc(cell.ip.slice(0, CELL_W).padEnd(CELL_W))}</span>`;
    }

    return `<span class="hk-wall">${this._esc(cell.token.slice(0, CELL_W).padEnd(CELL_W))}</span>`;
  }

  _makeBoardLines() {
    return this.board.map((row, ri) => {
      const pfx   = `<span class="hk-comment">${this._esc(this.rowPfx[ri])}</span>`;
      const cells = row.map((cell, ci) => this._renderCell(cell, ri, ci)).join('');
      const sfx   = Math.random() < 0.5
        ? ` <span class="hk-dim">${this._esc(SFX_POOL[Math.floor(Math.random() * SFX_POOL.length)])}</span>`
        : '';
      return `${pfx}${cells}${sfx}`;
    });
  }

  _makeOptionLines() {
    return this.availableCommands.map((opt, i) => {
      const cls = opt.kind === 'routine' ? 'hk-routine' : 'hk-num';
      return `<span class="hk-dim">fn[${i + 1}]</span> ` +
        `<span class="${cls}">${this._esc(opt.cmdFull)}</span> ` +
        `<span class="hk-comment">// ${this._esc(opt.desc)}</span>`;
    });
  }

  _appendDump(prefixLines = []) {
    const sepLen = PREFIX_W + COLS * CELL_W;
    const sep    = '\u2500'.repeat(sepLen);
    this._appendLines([
      ...prefixLines,
      `<span class="hk-dim">:: trace ${String(this.run).padStart(2, '0')}.${String(this.depth).padStart(3, '0')} :: map refresh ::</span>`,
      ...this._makeBoardLines(),
      `<span class="hk-sep">${this._esc(sep)}</span>`,
      ...this._makeOptionLines(),
      '',
    ]);
  }

  _appendLines(lines) {
    this.outputQueue.push(...lines);
    if (!this.outputTimer) this._drain();
  }

  _drain() {
    this.outputTimer = setInterval(() => {
      const line = this.outputQueue.shift();
      if (line === undefined) { clearInterval(this.outputTimer); this.outputTimer = null; return; }
      this.outputEl.innerHTML += line + '\n';
      this.outputEl.scrollTop  = this.outputEl.scrollHeight;
    }, 10);
  }

  _updateStatus() {
    if (this.statusEl)
      this.statusEl.textContent =
        `RUN ${String(this.run).padStart(2, '0')} | DEPTH ${String(this.depth).padStart(3, '0')} | TARGET: ${this.targetAddr}`;
  }

  _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
