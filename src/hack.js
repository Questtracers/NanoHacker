// Hacking minigame — math-based corridor navigation.
// - Path nodes hold a signed integer value in [-9, 9] \ {0}; arithmetic wraps mod 10.
// - Conn cells look like gray IP-fragment decoration (value always 0, passable).
// - Commands: 3 directional ops with random ±1..6 deltas + occasional routines.
// - Routines: `sudo del N` zeros every node where value=N; `exec ±N` shifts all
//   CONNECTED non-zero cells by ±N. Disconnected 0-cells are preserved.
// - Reaching a 0-cell cascades the cursor through connected 0-chains (combo).
// - Win by reaching any cell of the 3-cell target band (displays hex address).

const ROWS      = 5;
const COLS      = 15;
const CELL_W    = 2;
const PREFIX_W  = 14;
const HACK_TIME = 120;

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
  constructor() {
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
        font-size:14px; line-height:1.55;
        color:#22aa55; box-sizing:border-box;
      }
      #hack-main {
        flex:1; display:flex; flex-direction:column;
        padding:16px 20px; min-width:0; overflow:hidden;
      }
      #hack-header {
        display:flex; justify-content:space-between; align-items:baseline;
        border-bottom:1px solid #1a4a2a; padding-bottom:6px; margin-bottom:8px;
        font-size:11px; color:#44ff88; letter-spacing:.06em; flex-shrink:0;
      }
      #hack-output {
        flex:1; overflow-y:auto; white-space:pre; padding-bottom:4px;
      }
      #hack-input-row {
        border-top:1px solid #1a4a2a; padding-top:6px; flex-shrink:0;
        display:flex; align-items:center; color:#44ff88;
      }
      #hack-input {
        flex:1; background:transparent; border:none;
        color:#44ff88; font-family:inherit; font-size:inherit;
        outline:none; caret-color:#44ff88;
      }
      #hack-hint { font-size:10px; color:#1a5a2a; margin-left:12px; white-space:nowrap; }
      #hack-clock-panel {
        width:152px; flex-shrink:0;
        border-left:1px solid #1a4a2a;
        display:flex; flex-direction:column; align-items:center;
        padding:22px 8px 16px; box-sizing:border-box;
      }
      #hack-clock-label {
        color:#2a7a3a; margin-bottom:14px; font-size:10px; letter-spacing:.1em;
      }
      #hack-clock-face  { white-space:pre; line-height:1.35; color:#44ff88; }
      #hack-clock-time  { margin-top:10px; font-size:12px; color:#44ff88; letter-spacing:.12em; }
      .hk-wall    { color:#1e6b2e; }
      .hk-num     { color:#44ff88; font-weight:bold; }
      .hk-neg     { color:#ff9944; font-weight:bold; }
      .hk-zero    { color:#77ddff; font-weight:bold; }
      .hk-trail   { color:#1e5a4a; }
      .hk-conn    { color:#777777; }
      .hk-target  { color:#ffcc00; font-weight:bold; }
      .hk-cursor  { background:#44ff88; color:#010a05; font-weight:bold; }
      .hk-err     { color:#ff4444; }
      .hk-ok      { color:#00ffff; }
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
    hint.textContent = '[ESC] abort  ·  type "cls" to regen all funcs';

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

  open() {
    if (this.active) return;
    this.active = true;
    this.overlay.style.display = 'flex';
    this._reset();
    setTimeout(() => this.inputEl.focus(), 30);
  }

  close() {
    this.active = false;
    this.overlay.style.display = 'none';
    if (this.outputTimer) { clearInterval(this.outputTimer); this.outputTimer = null; }
    if (this.clockTimer)  { clearInterval(this.clockTimer);  this.clockTimer  = null; }
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
    if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = null; }
    this._appendDump([`<span class="hk-err">-- TIME EXCEEDED // trace locked // session terminated --</span>`]);
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
    this.depth    = 0;
    this.gameOver = false;
    this.won      = false;
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
      `<span class="hk-ok">-- NanoHacker v1.0 | breach initiated | target: ${this.targetAddr} --</span>`,
    ]);
  }

  _generateBoard() {
    // Fill with walls
    this.board = Array.from({ length: ROWS }, () =>
      Array.from({ length: COLS }, () => ({
        type:  'wall',
        token: WALL_TOKENS[Math.floor(Math.random() * WALL_TOKENS.length)],
      }))
    );

    const pathNodes = [];

    // Gather the values of path/target neighbors (4-adjacent)
    const adjPathValues = (r, c) => {
      const vals = new Set();
      for (const d of DIRS) {
        const nr = r + d.dr, nc = c + d.dc;
        if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
        const cell = this.board[nr][nc];
        if (cell.type === 'path' && cell.value !== 0) vals.add(cell.value);
      }
      return vals;
    };

    // Pick a value in [-9, 9] \ {0} not already used by an adjacent path node.
    const pickValue = (forbidden) => {
      const pool = [];
      for (let v = -9; v <= 9; v++) {
        if (v === 0) continue;
        if (forbidden.has(v)) continue;
        pool.push(v);
      }
      if (!pool.length) return (Math.random() < 0.5 ? -1 : 1);
      return pool[Math.floor(Math.random() * pool.length)];
    };

    const placePath = (r, c, forceValue = null) => {
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return;
      const existing = this.board[r][c];
      if (existing.type === 'path' || existing.type === 'target') return;
      const value = forceValue !== null
        ? forceValue
        : pickValue(adjPathValues(r, c));
      this.board[r][c] = { type: 'path', value };
      pathNodes.push({ row: r, col: c });
    };

    // IP-fragment style: 2-digit number 10..99
    const placeConn = (r, c) => {
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return;
      if (this.board[r][c].type !== 'wall') return;
      const ip = String(10 + Math.floor(Math.random() * 90));
      this.board[r][c] = { type: 'conn', value: 0, ip };
    };

    // Horizontal corridor between (r, c1) and (r, c2), exclusive of endpoints
    const carveH = (r, c1, c2) => {
      const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
      for (let c = minC + 1; c < maxC; c++) placeConn(r, c);
    };

    // Cursor starts at left edge, centre row; its cell begins at value 0
    const startRow = Math.floor(ROWS / 2);
    const startCol = 1;
    placePath(startRow, startCol, 0);
    this.cursor = { row: startRow, col: startCol };

    // ── Main route: horizontal progression with occasional vertical hops
    let cr = startRow, cc = startCol;
    while (cc < COLS - 5) {
      const dist = 2 + Math.floor(Math.random() * 4); // 2-5 cols
      const nc   = Math.min(COLS - 4, cc + dist);
      if (nc === cc) break;
      carveH(cr, cc, nc);
      placePath(cr, nc);
      cc = nc;

      // Occasionally hop to adjacent row (numbered node, no vertical conn)
      if (Math.random() < 0.45) {
        const dr = Math.random() < 0.5 ? -1 : 1;
        const nr = Math.max(0, Math.min(ROWS - 1, cr + dr));
        if (nr !== cr) { placePath(nr, cc); cr = nr; }
      }
    }

    // ── Horizontal spurs
    const spurCount = 6 + Math.floor(Math.random() * 4);
    for (let s = 0; s < spurCount; s++) {
      if (pathNodes.length < 2) break;
      const anchor = pathNodes[1 + Math.floor(Math.random() * (pathNodes.length - 1))];
      const dir  = Math.random() < 0.5 ? -1 : 1;
      const len  = 2 + Math.floor(Math.random() * 5);
      const endC = Math.max(1, Math.min(COLS - 2, anchor.col + dir * len));
      if (endC === anchor.col) continue;
      const minC = Math.min(anchor.col, endC), maxC = Math.max(anchor.col, endC);
      let clear = true;
      for (let c = minC + 1; c <= maxC; c++) {
        const t = this.board[anchor.row][c].type;
        if (t === 'path' || t === 'target') { clear = false; break; }
      }
      if (!clear) continue;
      carveH(anchor.row, anchor.col, endC);
      placePath(anchor.row, endC);
    }

    // ── Vertical stubs (single stacked numbered node — no vertical conn)
    const stubCount = 3 + Math.floor(Math.random() * 3);
    for (let s = 0; s < stubCount; s++) {
      const anchor = pathNodes[Math.floor(Math.random() * pathNodes.length)];
      const dr = Math.random() < 0.5 ? -1 : 1;
      const nr = anchor.row + dr;
      if (nr < 0 || nr >= ROWS) continue;
      if (this.board[nr][anchor.col].type === 'wall') placePath(nr, anchor.col);
    }

    // ── Target: 3-cell horizontal band near right edge showing hex address
    const addrNum   = Math.floor(Math.random() * 0x1000);
    this.targetAddr = `0x${addrNum.toString(16).padStart(3, '0')}`;

    const rightSide = pathNodes.filter(p =>
      p.col >= COLS - 8 && !(p.row === startRow && p.col === startCol));
    const baseT = rightSide[Math.floor(Math.random() * rightSide.length)]
      ?? pathNodes[pathNodes.length - 1];

    let tRow = baseT.row, tStart = baseT.col;
    if (tStart + 2 > COLS - 1) tStart = Math.max(1, baseT.col - 2);

    // Target cells carry value 1 (not 0) so shoot-through scans stop at the
    // band — the player lands a win by zeroing any of the 3 chunks.
    for (let k = 0; k < 3; k++) {
      const c = tStart + k;
      if (c < 0 || c >= COLS) continue;
      this.board[tRow][c] = { type: 'target', value: 1, chunk: k };
    }
    this.targetCell  = { row: tRow, col: tStart };
    this.targetWidth = 3;

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
    // Pick among: sudo del N | exec ±N
    if (Math.random() < 0.5) {
      // sudo del N — zero every cell where value === N
      const present = new Set();
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const cell = this.board[r][c];
          if (cell.type === 'path' && cell.value !== 0) present.add(cell.value);
        }
      }
      const arr = [...present];
      if (!arr.length) return null;
      const n = arr[Math.floor(Math.random() * arr.length)];
      return {
        kind:    'routine',
        type:    'del',
        n,
        cmdFull: `sudo del ${n}`,
        desc:    `priv esc :: drop nodes where v=${n}`,
      };
    }
    const mag   = 1 + Math.floor(Math.random() * 3); // 1..3
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
    if (this.gameOver) {
      this._appendLines([`<span class="hk-err">session closed :: type <b>reset</b> to reboot</span>`]);
      return;
    }
    const input = raw.trim().toLowerCase();
    if (!input) { this._appendLines(['empty packet ignored']); return; }

    if (input === 'reset' || input === 'reboot') {
      this.run++; this._reset(); return;
    }

    // Regenerate every function slot with fresh options. Costs one turn.
    if (input === 'cls') {
      this.depth++;
      this._refreshCommands();
      this._updateStatus();
      this._appendDump([
        `<span class="hk-ok">-- func registry flushed // fresh opcodes queued --</span>`,
      ]);
      return;
    }

    // Pure numeric shortcut "1", "2", "3", "4"
    if (/^[1-9]$/.test(input)) {
      const idx = parseInt(input, 10) - 1;
      if (idx >= 0 && idx < this.availableCommands.length) {
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

    if (cmd.kind === 'patch') {
      // Apply delta only to the cursor's DIRECT graph neighbours — path or
      // target nodes reachable in a single hop (adjacency or one filler
      // corridor). B-through-A-through-C chains are NOT touched.
      const nodes = this._directlyConnectedNodes();
      let hitSomething = false;
      for (const { r, c } of nodes) {
        const cell = this.board[r][c];
        if (cell.value === 0) continue; // preserve 0-combos
        cell.value = wrap10(cell.value + cmd.delta);
        hitSomething = true;
      }
      if (!hitSomething) {
        this._appendLines([`<span class="hk-err">fault :: no live nodes in segment</span>`]);
      } else {
        this._cascadeCursor();
      }
    } else if (cmd.kind === 'routine') {
      if (cmd.type === 'del')   this._routineDelete(cmd.n);
      if (cmd.type === 'shift') this._routineShift(cmd.delta);
      this._cascadeCursor();
    }

    // Win check before reassignment (winning ends the turn)
    const t = this.targetCell;
    if (this.cursor.row === t.row &&
        this.cursor.col >= t.col && this.cursor.col < t.col + this.targetWidth) {
      this.gameOver = true; this.won = true;
      if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = null; }
      this._appendDump([
        `<span class="hk-ok">-- ACCESS GRANTED // ${this.targetAddr} compromised // returning --</span>`,
      ]);
      setTimeout(() => this.close(), 2800);
      return;
    }

    // Between node hops: reassign every 0-value path cell (except the cursor's
    // current cell) to a fresh random non-zero number. Numbers the player
    // hasn't touched keep their values.
    this._reassignZeroPaths();

    // Replace only the slot that was just used — the other functions persist.
    if (usedIdx >= 0) {
      this.availableCommands[usedIdx] = this._generateReplacement(usedIdx);
    }

    this._updateStatus();
    this._appendDump();
  }

  // Pick a non-zero value in [-9, 9] that isn't shared with 4-adjacent nodes.
  _pickRandomPathValue(r, c) {
    const forbidden = new Set();
    for (const d of DIRS) {
      const nr = r + d.dr, nc = c + d.dc;
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
      const n = this.board[nr][nc];
      if ((n.type === 'path' || n.type === 'target') && n.value !== 0) {
        forbidden.add(n.value);
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
    // Only reassign the 0-cells that are DIRECTLY connected to the cursor
    // (graph neighbours). Everything further is preserved as latent combos.
    const directSet = new Set();
    for (const n of this._directlyConnectedNodes()) {
      directSet.add(`${n.r},${n.c}`);
    }
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (r === this.cursor.row && c === this.cursor.col) continue;
        const cell = this.board[r][c];
        if (cell.type !== 'path') continue;
        if (cell.value !== 0) continue;
        if (!directSet.has(`${r},${c}`)) continue;
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

  // A step is valid only when it follows the user's connection rules:
  //   · path ↔ path     any direction (horizontal or vertical)
  //   · path ↔ conn     horizontal only
  //   · conn ↔ conn     horizontal only (a filler row is a horizontal corridor)
  //   · path ↔ target   any direction
  // Walls always block. Anything vertical involving a conn cell is forbidden.
  _isValidStep(curCell, d, nCell) {
    if (nCell.type === 'wall') return false;
    if (d.dr !== 0) {
      if (curCell.type === 'conn' || nCell.type === 'conn') return false;
    }
    return true;
  }

  // Direct graph neighbours of the cursor: path/target cells reached by
  //   (a) direct 4-adjacency, or
  //   (b) a single corridor of filler conn cells (no intermediate nodes).
  // A BFS expands through conn cells (transit), but STOPS at any path/target
  // cell — so connectivity is exactly one graph-hop from the cursor.
  _directlyConnectedNodes() {
    const nodes = [];
    const seen = new Set();
    const key = (r, c) => `${r},${c}`;
    const start = { r: this.cursor.row, c: this.cursor.col };
    seen.add(key(start.r, start.c));
    const q = [start];
    while (q.length) {
      const { r, c } = q.shift();
      const cur = this.board[r][c];
      for (const d of DIRS) {
        const nr = r + d.dr, nc = c + d.dc;
        if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
        const k = key(nr, nc);
        if (seen.has(k)) continue;
        const nCell = this.board[nr][nc];
        if (!this._isValidStep(cur, d, nCell)) continue;
        seen.add(k);
        if (nCell.type === 'conn') {
          q.push({ r: nr, c: nc }); // filler corridor — keep walking
        } else if (nCell.type === 'path' || nCell.type === 'target') {
          nodes.push({ r: nr, c: nc }); // graph neighbour, do NOT recurse
        }
      }
    }
    return nodes;
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
      this.cursor = { row: best.r, col: best.c };
      visited.add(key(best.r, best.c));
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  _renderCell(cell, row, col) {
    const isCursor = this.cursor.row === row && this.cursor.col === col;
    if (isCursor) return `<span class="hk-cursor">${'0'.padEnd(CELL_W)}</span>`;

    if (cell.type === 'target') {
      const chunk = cell.chunk ?? 0;
      const start = chunk * CELL_W;
      const text  = this.targetAddr.slice(start, start + CELL_W).padEnd(CELL_W);
      return `<span class="hk-target">${this._esc(text)}</span>`;
    }

    if (cell.type === 'path') {
      const v = cell.value;
      if (v === 0) return `<span class="hk-zero">${' 0'}</span>`;
      // Right-align: positive "3" → " 3", negative "-3" → "-3"; digits align
      const text = String(v).padStart(CELL_W);
      return `<span class="${v < 0 ? 'hk-neg' : 'hk-num'}">${text}</span>`;
    }

    if (cell.type === 'conn') {
      return `<span class="hk-conn">${this._esc(cell.ip.slice(0, CELL_W).padEnd(CELL_W))}</span>`;
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
