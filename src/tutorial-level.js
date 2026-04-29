import * as THREE from 'three';
import { Player } from './player.js';
import { Drone }  from './drone.js';
import { Bullet, updatePlayerArrowVFX } from './bullet.js';
import { spawnHackSwarm, updateHackSwarm } from './hack-swarm.js';
import { spawnConfetti, updateConfetti }   from './confetti.js';
import { HackMinigame } from './hack.js';
// runDebugLevel was the previous handoff; the tutorial now reloads
// to the corp-logo splash on completion (see endTutorial).

// Tutorial level — a calm, white "construct"-style sandbox where a
// floating mentor walks the player through movement, aim, shooting,
// and the hack minigame. Aesthetic is deliberately stark: bright
// floor, soft fog, no walls or props. A dialogue card slides up from
// the bottom and steps through scripted lines triggered by player
// input or by completing certain in-world actions.
//
// Entry point:
//   runTutorialLevel()  — same shape as runDebugLevel(), called from
//                          corplogo.js when the player presses T.

const ARENA_X = 50, ARENA_Z = 50;       // tutorial origin (mid-grid)
const DRONE_OFFSET_Z = 8;               // metres in front of player
const CAM_YAW    = Math.PI * 75 / 180;
const CAM_RADIUS = 14.3;
const CAM_HEIGHT = 11.7;
const HACK_RANGE = 5.0;
const HACK_PREP_MS = 850;
const SHOT_COOLDOWN = 5.0;

// Each line in the script carries a "mood" tag — for now they all
// resolve to the same friendly portrait. The mapping is kept around
// so future moods can be wired up by adding entries here without
// touching the script.
//
// Available art under Assets/TreviExpressions/:
//   Trevi_angry, Trevi_assertive, Trevi_encouragement, Trevi_friendly,
//   Trevi_sad, Trevi_smiling, Trevi_surprised, Trevi_wondering.
const TREVI_ART_DIR = 'Assets/TreviExpressions/';
const MOOD_TO_PORTRAIT = {
  // Moods the script actively uses (the message author can pick any
  // of these per line; the mapping below resolves to the actual
  // sprite file at runtime).
  assertive:     'Trevi_assertive.png',
  wondering:     'Trevi_wondering.png',
  encouragement: 'Trevi_encouragement.png',
  friendly:      'Trevi_friendly.png',
  angry:         'Trevi_angry.png',
  surprised:     'Trevi_surprised.png',
  sad:           'Trevi_sad.png',
  smiling:       'Trevi_smiling.png',
  // Legacy mood names from the original script — kept so older
  // entries don't suddenly fall back to a generic image. Each one
  // points at the closest available expression for now.
  normal:        'Trevi_friendly.png',
  fun:           'Trevi_smiling.png',
  worried:       'Trevi_surprised.png',
};
function portraitForMood(mood) {
  return TREVI_ART_DIR + (MOOD_TO_PORTRAIT[mood] || 'Trevi_friendly.png');
}

export function runTutorialLevel() {
  window.__nanoDebugLevel = true;     // same kill-switch the main game uses

  document.querySelectorAll('canvas').forEach((c) => { c.style.display = 'none'; });
  // Off-screen overlay + the live game's objective-arrow markers — they
  // belong to the maze HUD and don't apply here. The main HUD (HP /
  // Hacks / Shot / Mode) STAYS visible so the player sees the same
  // readouts they'll meet in the live game.
  ['overlay', 'arrow-spot', 'arrow-exit'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  // Tweak the static HUD's objective row so it doesn't say "find Spot A".
  const hudObjEl = document.getElementById('obj');
  if (hudObjEl) hudObjEl.innerHTML = 'Tutorial — follow the mentor';

  // ── Renderer + scene (white "construct" aesthetic) ───────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.setClearColor(0xeef3f8);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // Bright fog blends the floor edges into the white sky, mimicking
  // the Matrix construct's infinite void.
  scene.fog = new THREE.Fog(0xeef3f8, 18, 70);

  // Off-white floor — slightly cool grey so the player + drone read
  // against it without harsh contrast.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(160, 160),
    new THREE.MeshStandardMaterial({ color: 0xe4ecf2, roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(ARENA_X, 0, ARENA_Z);
  floor.receiveShadow = true;
  scene.add(floor);
  // Faint blue grid — barely there, just enough to give the floor scale.
  const grid = new THREE.GridHelper(160, 80, 0x88aacc, 0xc8d4e0);
  grid.position.set(ARENA_X, 0.001, ARENA_Z);
  grid.material.transparent = true;
  grid.material.opacity = 0.4;
  scene.add(grid);

  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const sun = new THREE.DirectionalLight(0xffffff, 0.6);
  sun.position.set(ARENA_X + 20, 40, ARENA_Z + 10);
  sun.target.position.set(ARENA_X, 0, ARENA_Z);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  scene.add(sun);
  scene.add(sun.target);

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 220);
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Stub map — large enough for everything to be in-bounds; isWall
  // never trips since every cell is 0.
  const MAP_SIZE = 200;
  const map = {
    width: MAP_SIZE, height: MAP_SIZE,
    grid: Array.from({ length: MAP_SIZE }, () => new Array(MAP_SIZE).fill(0)),
    rooms: [],
  };

  // ── Entities ────────────────────────────────────────────────────────
  const player = new Player(scene, ARENA_X, ARENA_Z);
  // Drone is spawned later in the script (when the player reaches the
  // hack-tutorial step) so it doesn't distract earlier lines.
  let drone = null;
  const drones = [];
  const bullets = [];

  // ── Game stub for Bullet collision callbacks ────────────────────────
  const game = {
    spawnBullet(x, z, dx, dz, owner = 'enemy', shooter = null, y = 0.6) {
      bullets.push(new Bullet(scene, x, z, dx, dz, owner, shooter, y));
    },
    spawnRocket() {},
    onEnemySeesPlayer() {},
    cellBlockedByDoor() { return false; },
    damageObstacleAt() {},
    obstacleAt() { return null; },
    destroyObstacleAt() {},
  };

  // ── Hack minigame (real, no stubs) ──────────────────────────────────
  // The tutorial wants the actual minigame at difficulty 3 — wired
  // with a generous fixed pool of hack points so any premium command
  // (cls / overclock) the player tries doesn't error out.
  let tutorialHackPoints = 5;
  const hacker = new HackMinigame({
    getHP:   () => tutorialHackPoints,
    spendHP: (n) => { tutorialHackPoints = Math.max(0, tutorialHackPoints - n); },
  });

  // Pre-hack lock-on ring (the same yellow → cyan pulse the live game
  // shows on R-press).
  const pickRing = (() => {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.05, 32),
      new THREE.MeshBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    scene.add(m);
    return m;
  })();
  let pendingHack = null;

  // Hack-range floor ring centred on the player. Mimics the live game:
  // the ring flashes for a short window each time the player presses
  // R to hack-link, and isn't visible otherwise. Lets the player see
  // exactly how close they need to be without bombarding them with a
  // permanent overlay.
  const hackRangeRing = (() => {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(HACK_RANGE - 0.06, HACK_RANGE, 64),
      new THREE.MeshBasicMaterial({
        color: 0x44ff88, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
      }),
    );
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    scene.add(m);
    return m;
  })();
  let hackRangeFlashTimer = 0;     // seconds remaining for the visible flash
  function flashHackRange() {
    hackRangeRing.position.set(player.position.x, 0.01, player.position.z);
    hackRangeRing.visible = true;
    hackRangeFlashTimer = 0.45;     // seconds, matches live-game pulse
  }

  // ── Dialogue UI ─────────────────────────────────────────────────────
  // Bottom-right docked card. The text column lives on the LEFT side
  // of the card; a half-body portrait of Trevi (the mentor) sits on
  // the RIGHT and overlays the box from outside — head pokes up
  // above the card, body slot extends below — so the silhouette
  // reads as "talking head" hovering at the corner of the screen
  // without covering the message lines.
  const TREVI_PORTRAIT_HEIGHT = 360;  // px — taller than the card so the
                                       //       upper body extends above
  const TREVI_PORTRAIT_WIDTH  = 220;  // px — reserved gutter inside the card
                                       //       so the text doesn't run under
                                       //       the image

  const dlg = document.createElement('div');
  dlg.style.cssText = [
    'position:fixed',
    'right:36px', 'bottom:36px',
    // 60 sits above the hack-minigame overlay (z-index 50) so the
    // mentor's dialogue keeps reading on top of the hack screen.
    'z-index:60',
    'width:680px', 'max-width:80vw',
    `padding:18px 22px 18px 22px`,
    `padding-right:${TREVI_PORTRAIT_WIDTH + 12}px`,
    'background:rgba(245,250,255,0.94)',
    'border:1px solid rgba(120,160,200,0.6)',
    'border-radius:12px',
    'box-shadow:0 6px 36px rgba(70,110,160,0.18)',
    'font-family:"Trebuchet MS", "Lucida Grande", sans-serif',
    'color:#22344c',
    'transition:opacity 220ms ease, transform 220ms ease',
    'opacity:0', 'transform:translateY(18px)',
  ].join(';');

  // Text column — full-width inside the available card area (the
  // character portrait is absolutely positioned and reserved for via
  // padding-right above, so this column can flow normally).
  const txtCol = document.createElement('div');
  txtCol.style.cssText = 'display:flex; flex-direction:column; gap:6px;';
  const txt = document.createElement('div');
  txt.style.cssText = 'font-size:18px; line-height:1.45;';
  const sub = document.createElement('div');
  sub.style.cssText = 'font-size:14px; opacity:0.7;';
  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:12px; opacity:0.55; margin-top:4px;';
  txtCol.appendChild(txt);
  txtCol.appendChild(sub);
  txtCol.appendChild(hint);
  dlg.appendChild(txtCol);

  // Trevi portrait — half-body sprite on the right edge of the card.
  // Anchored to the card's bottom-right; overflow is allowed so the
  // image extends UP above the card's top edge (it's much taller
  // than the card, so head + shoulders read as poking out).
  // pointer-events:none so the image doesn't intercept clicks.
  const portrait = document.createElement('img');
  portrait.alt = 'Trevi';
  portrait.src = 'Assets/TreviExpressions/Trevi_friendly.png';
  portrait.style.cssText = [
    'position:absolute',
    'right:0',
    `bottom:-12px`,                      // hug the card's bottom edge
    `width:${TREVI_PORTRAIT_WIDTH}px`,
    `height:${TREVI_PORTRAIT_HEIGHT}px`,
    'object-fit:contain',
    'object-position:bottom right',
    'pointer-events:none',
    'user-select:none',
    'filter:drop-shadow(-4px 4px 14px rgba(70,110,160,0.35))',
  ].join(';');
  dlg.appendChild(portrait);
  document.body.appendChild(dlg);

  // Tutorial highlight CSS — injected once, applied to the hack
  // overlay via tutorial-set classes during specific narration lines.
  // Each highlight pulses a green / white background glow across the
  // relevant cells (`hk-cursor`, `hk-target`, `hk-num`, etc.) so the
  // mentor's words have a visual anchor on the maze.
  if (!document.getElementById('tutorial-highlight-css')) {
    const style = document.createElement('style');
    style.id = 'tutorial-highlight-css';
    // Each highlight pulses a translucent background tint over the
    // matched cells (strikethrough was tried first, but a background
    // glow reads better against the dense terminal grid). Box-shadow
    // is added too so the cell looks "lit up" rather than just
    // colour-shifted.
    style.textContent = `
      @keyframes tutHlGreen {
        0%, 100% { background: transparent; box-shadow: none; }
        50%      { background: rgba(68,255,136,0.45);
                   box-shadow: 0 0 6px rgba(68,255,136,0.85); }
      }
      @keyframes tutHlWhite {
        0%, 100% { background: transparent; box-shadow: none; }
        50%      { background: rgba(255,255,255,0.55);
                   box-shadow: 0 0 6px rgba(255,255,255,0.85); }
      }
      @keyframes tutHlAmber {
        0%, 100% { background: transparent; box-shadow: none; }
        50%      { background: rgba(255,204,102,0.40);
                   box-shadow: 0 0 6px rgba(255,204,102,0.85); }
      }
      /* Cursor cell already paints its own green background — adding
         a pulsing outline keeps that visible while still drawing the
         eye to it. Background isnt overridden here. */
      @keyframes tutHlCursor {
        0%, 100% { box-shadow: none; }
        50%      { box-shadow: 0 0 0 3px rgba(68,255,136,0.85),
                               0 0 12px rgba(68,255,136,0.85); }
      }
      .tut-hl-cursor .hk-cursor { animation: tutHlCursor 1s infinite; }
      /* Goal highlight: the script flag .highlight = goal adds the
         tut-hl-goal class to hacker.overlay. */
      .tut-hl-goal .hk-target   { animation: tutHlWhite  1s infinite; }
      /* Numbers: only the maze board cells (.hk-num inside
         .hk-board-row), not the function listing. */
      .tut-hl-numbers .hk-board-row .hk-num,
      .tut-hl-numbers .hk-board-row .hk-neg {
        animation: tutHlGreen 1s infinite;
      }
      /* Connections: blink the grey conn cells in green so they
         read as "those are the open links" — same animation pattern
         as the cursor / numbers highlights. */
      .tut-hl-conn-light .hk-board-row .hk-conn { animation: tutHlGreen 1s infinite; }
      /* Functions: ONLY the in-board option list (the maze-affecting
         commands). The side-panel premium powers stay quiet. */
      .tut-hl-functions .hk-option-line { animation: tutHlAmber 1s infinite; border-radius: 3px; }
      /* Powers: the side-panel legend (cls / 1..4 / overclock) — only
         flagged on the dedicated "those are your hack points" line. */
      .tut-hl-powers #hack-legend .hk-legend-row { animation: tutHlAmber 1s infinite; border-radius: 3px; }
      /* Goal-neighbours / cursor-neighbours target a single set of
         cells tagged via JS (.tut-target). The blink is white so
         they read distinctly from the green numbers / amber funcs. */
      .tut-hl-goal-neighbours .tut-target,
      .tut-hl-cursor-neighbours .tut-target {
        animation: tutHlWhite 1s infinite;
        font-weight: 800;
      }
    `;
    document.head.appendChild(style);
  }
  function setTutorialHighlight(name) {
    const ov = hacker?.overlay;
    if (!ov) return;
    // Drop any previously-set highlight class. Snapshot classList
    // into an array first — modifying it while iterating with
    // .forEach skips entries on some engines.
    const stale = Array.from(ov.classList).filter(c => c.startsWith('tut-hl-'));
    for (const c of stale) ov.classList.remove(c);
    if (name) ov.classList.add(`tut-hl-${name}`);
  }
  // Tag specific board cells (by row/col) with `tut-target` so the
  // CSS for goal-neighbours / cursor-neighbours can blink only those
  // exact positions instead of every .hk-num on the board.
  // We only tag the MOST RECENT board's cells (the one currently
  // visible at the bottom of the output) — older boards scrolled out
  // of view get to keep their stale state.
  function clearCellTags() {
    if (!hacker?.outputEl) return;
    hacker.outputEl.querySelectorAll('.tut-target').forEach((el) => {
      el.classList.remove('tut-target');
    });
  }
  // Find a patch command from the player's current 4 slots whose
  // delta would wrap one of the cursor's directly-connected nodes
  // down to 0. The mentor uses this to suggest a concrete call —
  // "Type 'inc 7' and press Enter" — instead of leaving the player
  // to figure out the math themselves.
  function findZeroingCommand(h) {
    h = h || hacker;
    if (!h?.availableCommands) return null;
    let nodes = [];
    try { nodes = h._directlyConnectedNodes ? h._directlyConnectedNodes() : []; }
    catch (_) { nodes = []; }
    for (const cmd of h.availableCommands) {
      if (!cmd || cmd.kind !== 'patch') continue;
      for (const { r, c } of nodes) {
        const cell = h.board?.[r]?.[c];
        if (!cell || cell.value === 0) continue;
        const next = ((cell.value + cmd.delta) % 10 + 10) % 10;
        if (next === 0) return cmd.cmdFull;
      }
    }
    return null;
  }

  function tagCellsByPos(positions) {
    clearCellTags();
    if (!hacker?.outputEl || !positions?.length) return;
    const wanted = new Set(positions.map(p => `${p.row},${p.col}`));
    const allCells = hacker.outputEl.querySelectorAll('span[data-r]');
    const tagged = new Set();
    // Walk backwards so we hit the latest board first.
    for (let i = allCells.length - 1; i >= 0; i--) {
      const el = allCells[i];
      const k  = `${el.dataset.r},${el.dataset.c}`;
      if (wanted.has(k) && !tagged.has(k)) {
        el.classList.add('tut-target');
        tagged.add(k);
      }
      if (tagged.size === wanted.size) break;
    }
  }

  // Step-debug readout — small overlay in the top-right showing
  // which script index the tutorial is currently on, plus the type/
  // mood of the active step. Lets us point at "step 7" when filing
  // bugs without counting lines manually.
  const stepDbg = document.createElement('div');
  stepDbg.style.cssText = [
    'position:fixed', 'top:10px', 'right:10px', 'z-index:65',
    'padding:6px 10px',
    'background:rgba(0,8,20,0.78)',
    'color:#cfe', 'font-family:monospace', 'font-size:12px',
    'border:1px solid rgba(120,180,255,0.4)', 'border-radius:6px',
    'pointer-events:none', 'line-height:1.4',
  ].join(';');
  document.body.appendChild(stepDbg);
  function updateStepDbg() {
    const step = script[stepIdx] ?? null;
    const desc = step
      ? `${step.type}${step.mood ? ' / ' + step.mood : ''}`
      : '—';
    const total = script.length;
    stepDbg.textContent = `step ${stepIdx} / ${total - 1}\n${desc}\nwaiting: ${
      typeof waiting === 'string' ? waiting :
      (waiting && waiting.kind) ? waiting.kind : 'none'
    }`;
  }

  function setExpression(mood) {
    // Swap the portrait sprite. All moods currently resolve to the
    // friendly image; per-mood art can be wired up by editing the
    // MOOD_TO_PORTRAIT map at the top of the file.
    const next = portraitForMood(mood);
    if (portrait.src.endsWith(next.split('/').pop())) return;
    portrait.src = next;
  }
  function showDialogue() {
    dlg.style.opacity   = '1';
    dlg.style.transform = 'translateY(0)';
  }
  function hideDialogue() {
    dlg.style.opacity   = '0';
    dlg.style.transform = 'translateY(18px)';
  }

  // ── Tutorial script ─────────────────────────────────────────────────
  // Each step is either:
  //   { type: 'line',   mood, text, sub?, hint? }   — single dialogue line
  //   { type: 'choice', mood, text, options: [{key,label,branch}] }
  //   { type: 'spawnDrone' }                        — spawn the practice drone
  //   { type: 'awaitHack' }                         — wait for the player to
  //                                                    R-link the drone, then
  //                                                    open hack minigame at
  //                                                    difficulty 3
  //   { type: 'end' }                               — fade dialogue + idle
  //
  // Lines after the choice are gated behind the "yes" branch; on "no"
  // we jump to the end step.
  //
  // Spanish-original lines translated here per request — the tone is
  // playful-mentor; minor liberties to keep the rhythm in English.
  const script = [
    {
      type: 'line', mood: 'assertive',
      text: "Hey, I know you've got a reputation and you're no rookie, but a little practice never hurts.",
      hint: 'SPACE to continue',
    },
    {
      type: 'choice', mood: 'wondering',
      text: 'Want me to walk you through the basics?',
      options: [
        { key: 'a', label: 'A — Yes, run the tutorial', branch: 'tutorial' },
        { key: 'd', label: 'D — No thanks, drop me into the run', branch: 'skip'    },
      ],
    },
    {
      type: 'line', mood: 'encouragement',
      text: 'Movement is the easy part — good ol\' WASD, just like always.',
      hint: 'Try walking around · SPACE to continue',
    },
    {
      type: 'line', mood: 'assertive',
      text: 'The direction you\'re facing matters here — that\'s the way you\'ll shoot.',
      sub: 'Press Q and E to turn.',
      hint: 'SPACE to continue',
    },
    {
      type: 'line', mood: 'wondering',
      text: "Shooting? You're a hacker. You don't usually do that — much better to hack things!",
      hint: 'SPACE to continue',
    },
    {
      type: 'line', mood: 'angry',
      text: 'Still — if you really want to fire your weapon, press J.',
      hint: 'SPACE to continue',
    },
    {
      type: 'line', mood: 'encouragement',
      text: 'The important thing here is hacking. Let me bring in a friend so you can learn it.',
      hint: 'SPACE to continue',
    },
    { type: 'spawnDrone' },
    {
      type: 'line', mood: 'friendly',
      text: "Say hi to Dronny — you'll meet plenty of these on missions.",
      hint: 'SPACE to continue',
    },
    // This line IS the hack-link gate — `acceptHackR` lets R
    // (when near the drone) advance the dialogue + open the hack
    // in one go, instead of forcing the player to press SPACE
    // first to dismiss the line.
    {
      type: 'line', mood: 'encouragement', acceptHackR: true,
      text: 'Walk up to Dronny and press R to hack him.',
      hint: 'Approach the drone and press R',
    },
    // Lines from this point on play DURING the hack minigame. They
    // still require a SPACE press to advance — a capture-phase
    // listener intercepts SPACE before the hack terminal sees it,
    // so the keystroke advances the mentor without ending up
    // typed into the player's command line.
    {
      type: 'line', mood: 'surprised',
      text: "This is the hacking screen.",
      hint: 'SPACE to continue',
    },
    {
      type: 'line', mood: 'friendly',
      text: "It looks tricky, but it's simple once you understand it.",
      hint: 'SPACE to continue',
    },
    {
      type: 'line', mood: 'wondering',
      text: "Picture a maze — you're standing where it says 0.",
      hint: 'SPACE to continue',
      highlight: 'cursor',
    },
    {
      type: 'line', mood: 'assertive',
      text: 'The grey patches are the open connections between cells.',
      hint: 'SPACE to continue',
      highlight: 'conn-light',
    },
    {
      type: 'line', mood: 'encouragement',
      text: 'The numbers are the positions of the maze you will be able to jump.',
      hint: 'SPACE to continue',
      highlight: 'numbers',
    },
    {
      type: 'line', mood: 'surprised',
      // The goal address is generated per-run; substitute the live
      // hacker.targetAddr in for the example string so the mentor
      // points at the actual bank the player is breaching.
      textFn: (h) => `Your goal is to reach the memory bank ${h?.targetAddr || ''}.`,
      text: "Your goal is to reach the memory bank shown in the prompt.",
      hint: 'SPACE to continue',
      highlight: 'goal',
    },
    {
      type: 'line', mood: 'assertive',
      text: 'To get in, you have to land on a node that has a direct connection to that bank.',
      hint: 'SPACE to continue',
      highlight: 'goal-neighbours',
    },
    {
      type: 'line', mood: 'wondering',
      text: "Watch the functions — they change the values of your possible next steps.",
      hint: 'SPACE to continue',
      highlight: 'functions',
    },
    {
      type: 'line', mood: 'encouragement',
      text: 'Functions will affect your neighbour nodes (except some exceptions); turn them into 0 to jump on the next node.',
      hint: 'SPACE to continue',
      highlight: 'cursor-neighbours',
    },
    // Action-gated: the player has to type the EXACT function call
    // we forced into a slot at step entry — anything else is rejected
    // by the input validator and the mentor calls them out for it.
    // The hack input is auto-focused + unlocked so they can type
    // immediately.
    {
      type: 'line', mood: 'assertive',
      text: 'Plain functions add; "drop" functions subtract. Type the call and press Enter to hack!',
      hintFn: () => tutorialExpectedCmd
        ? `Type "${tutorialExpectedCmd}" in the terminal and press Enter`
        : 'Type a function in the terminal and press Enter',
      forceZeroingCmd: true,
      focusHackInput: true,
      awaitHackCommand: 'zero-neighbour',
    },
    // Reaction beat — fires immediately after the player ran the
    // forced function. Highlights the cursor (their new position)
    // so they can see they automatically jumped onto the freshly-
    // zeroed node.
    {
      type: 'line', mood: 'smiling',
      text: 'See — the next node turned to 0 and you automatically jumped onto it!',
      hint: 'SPACE to continue',
      highlight: 'cursor',
    },
    // New hack-points beat — explained BEFORE the timer is revealed
    // so the player has the full picture of the side panel before
    // the pressure clock kicks in. `reveal: 'hp'` un-hides the panel,
    // `highlight: 'powers'` blinks the premium-action legend.
    {
      type: 'line', mood: 'friendly',
      text: 'Those are your hack points — they let you spend on special abilities like overclock or quick-fns.',
      hint: 'SPACE to continue',
      reveal: 'hp',
      highlight: 'powers',
    },
    // Reveal + start the breach timer right as the mentor says it.
    // After the player advances past this line we hide the dialogue
    // entirely (`hideAfter: true`) — no more narration. They finish
    // the hack on their own. When the hack closes (success or fail)
    // the run wraps up and hands off to the corp logo + main game.
    {
      type: 'line', mood: 'sad',
      text: "Hack before the timer runs out — otherwise you'll lose a hit point and walk away with nothing!",
      hint: 'SPACE to continue',
      reveal: 'clock',
      hideAfter: true,
      // Once the player advances past this line we (a) refocus the
      // hack input so they can type without clicking, and (b) flip
      // on auto-force-zeroing so every replacement command keeps
      // pointing at a zeroable main-path neighbour.
      focusInputAfter: true,
      enableAutoZeroing: true,
    },
    // Wait silently for the hack to close. Dialogue stays hidden
    // (set by hideAfter on the previous line). Once close fires
    // we surface ONE last mentor line — the player has to read +
    // SPACE-advance through it before the run hands off to the
    // corp logo + main game.
    { type: 'awaitHackClose' },
    {
      type: 'line', mood: 'smiling',
      text: "Nice work — you breached Dronny like a pro. Now you're ready for real targets.",
      hint: 'SPACE to start the game',
    },
    { type: 'end' },
  ];

  let stepIdx = 0;
  let waiting = null;        // 'space' | 'choice' | 'hack' | 'hackClose' | null
  let runEnded = false;
  // Filled in when the "Plain functions add" step fires — holds the
  // exact `cmdFull` string the player must type to satisfy the gate.
  // Used by the input validator + the hint text.
  let tutorialExpectedCmd = null;
  // Set true the first time onClose fires for the drone hack — used by
  // the `awaitHackClose` step to know when to advance to the post-
  // hack celebratory line.
  let hackResolved = false;
  // Active auto-advance timer id (returned by setTimeout). Cleared
  // every time we move to a new step so a manual SPACE press never
  // races against a stale auto-fire.
  let autoTimer = null;
  function clearAutoTimer() {
    if (autoTimer !== null) { clearTimeout(autoTimer); autoTimer = null; }
  }

  // Find the script index of a labelled branch target. We use
  // hard-coded jumps for the only choice today (yes → continue,
  // no → end), so simple index math is fine.
  function jumpTo(branch) {
    // Choice resolved — re-enable player input so the player can
    // walk around again as soon as the dialogue continues.
    player.setInputDisabled?.(false);
    if (branch === 'skip') {
      stepIdx = script.findIndex(s => s.type === 'end');
    } else {
      // tutorial = continue with the next line after the choice
      stepIdx++;
    }
    advance();
  }

  function applyLine(step) {
    clearAutoTimer();
    setExpression(step.mood);
    // Some flags need to run BEFORE the hint text is computed —
    // forceZeroingCmd populates tutorialExpectedCmd, which the
    // step's hintFn reads to print the exact call the player has
    // to type. Doing this first guarantees the hint is correct on
    // first render.
    if (step.forceZeroingCmd && hacker?.forceZeroingCommand) {
      tutorialExpectedCmd = hacker.forceZeroingCommand();
      // Install the validator that gates the input on that call.
      hacker.setInputValidator?.((raw) => {
        // Forgive sloppy whitespace the same way _runCommand does:
        // trim outer space and collapse inner runs. Saves the
        // player from a "wrong, try again" scolding when they
        // typed the right call with stray spaces.
        const typed = (raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
        const want  = (tutorialExpectedCmd || '').toLowerCase();
        if (typed === want) return true;
        // Wrong call — flip mentor to scolding mode and remind the
        // player of the exact call they need.
        setExpression('angry');
        txt.textContent = "No, that's not it! Write the function I'm telling you!";
        hint.textContent = `Type "${tutorialExpectedCmd}" exactly`;
        return false;
      });
    } else if (hacker?.setInputValidator) {
      // Make sure no stale validator from a previous step lingers.
      hacker.setInputValidator(null);
    }
    // Lines may carry a `textFn(hacker) -> string` instead of (or
    // alongside) a static `text`, so beats like "your goal is 0x05c"
    // can be filled in with the real run-time goal address. The
    // function is only invoked at line-show time so it sees the
    // current board state.
    const live = (typeof step.textFn === 'function') ? step.textFn(hacker) : null;
    txt.textContent = live || step.text;
    sub.textContent = step.sub || '';
    hint.textContent = (typeof step.hintFn === 'function')
      ? step.hintFn(hacker)
      : (step.hint || '');
    showDialogue();
    // Action-gated lines park the dialogue on `action` instead of
    // `space`. The keydown handler matches the registered action
    // against pressed keys and auto-advances on a hit. SPACE / Enter
    // do NOT advance these — the player has to actually do the
    // thing the mentor is asking for.
    if (step.awaitAction) {
      waiting = { kind: 'action', action: step.awaitAction };
    } else if (step.awaitHackCommand) {
      // Wait until the player runs a hack command that successfully
      // mutates the board (cursor cascading is a strong signal that
      // a connected node became 0).
      waiting = { kind: 'hackCommand', condition: step.awaitHackCommand };
    } else if (step.acceptHackR) {
      // Hard gate: ONLY pressing R near Dronny moves on. SPACE is
      // suppressed for this line so the player can't skip past the
      // first hack-link by tapping through the dialogue.
      waiting = 'hack';
    } else {
      waiting = 'space';
    }
    // Tutorial-only reveal flags. The hack screen opens with both
    // the clock and the HP-points panels hidden; specific narration
    // lines flip them on as the mentor introduces each concept.
    if (step.reveal === 'clock') hacker.revealAndStartClock?.();
    if (step.reveal === 'hp' && hacker.hpSectionEl) {
      hacker.hpSectionEl.style.visibility = 'visible';
    }
    // Per-line maze highlight. `null` clears any previous highlight
    // so untagged lines don't keep the last animation running.
    setTutorialHighlight(step.highlight ?? null);
    // For the neighbour highlights we need to tag the actual cell
    // DOM nodes (CSS alone can't pick "1-hop from cursor"). Other
    // highlights operate purely via CSS class on the overlay.
    // Tagging is also retried briefly in case the board is still
    // draining into the output element (lines drip in at ~10 ms
    // each via the queue).
    if (step.highlight === 'cursor-neighbours' && hacker?.getCursorNeighbours) {
      const positions = hacker.getCursorNeighbours();
      tagCellsByPos(positions);
      setTimeout(() => tagCellsByPos(positions), 350);
    } else if (step.highlight === 'goal-neighbours' && hacker?.getGoalNeighbours) {
      const positions = hacker.getGoalNeighbours();
      tagCellsByPos(positions);
      setTimeout(() => tagCellsByPos(positions), 350);
    } else {
      clearCellTags();
    }
    // Auto-focus the hack input so the player can type immediately
    // when a line asks them to write a function. This also un-locks
    // the input — until this step the terminal is disabled so the
    // player can't accidentally hack before the mentor finishes the
    // explanation.
    if (step.focusHackInput && hacker?.inputEl) {
      hacker.setInputEnabled?.(true);
      // Defer to next tick so the click-to-focus listener on the
      // overlay doesn't immediately blur us.
      setTimeout(() => hacker.inputEl.focus(), 0);
    }
    // Auto-advance lines schedule a timer to step forward without
    // requiring SPACE. Used for the lines played DURING the hack
    // minigame, where SPACE collides with terminal typing.
    if (typeof step.autoMs === 'number' && step.autoMs > 0) {
      autoTimer = setTimeout(() => {
        autoTimer = null;
        if (waiting !== 'space') return;
        stepIdx++;
        advance();
      }, step.autoMs);
    }
  }
  function applyChoice(step) {
    clearAutoTimer();
    setExpression(step.mood);
    txt.textContent = step.text;
    sub.innerHTML = step.options
      .map(o => `<b style="color:#1c4f8f">${o.label}</b>`)
      .join(' &nbsp;·&nbsp; ');
    hint.textContent = 'Press one of the keys above';
    showDialogue();
    waiting = { kind: 'choice', options: step.options };
    // While the choice is up we lock the player's WASD so an "A/D"
    // press to choose doesn't also strafe the body across the floor.
    // Re-enabled inside jumpTo() once a branch is taken.
    player.setInputDisabled?.(true);
  }
  function spawnDroneOnce() {
    if (drone) return;
    // Spawn to the LEFT of the player, relative to whatever way they
    // happen to be facing. Left vector = facing rotated 90° CCW:
    // forward (fx,fz) → left (-fz, fx). This keeps Dronny in frame
    // (left side of the camera) regardless of how the player walked
    // or turned during the earlier tutorial steps.
    const px = player.position.x, pz = player.position.z;
    const fx = player.facingDir.x, fz = player.facingDir.z;
    const len = Math.hypot(fx, fz) || 1;
    const lx = -fz / len, lz = fx / len;
    drone = new Drone(scene,
      px + lx * DRONE_OFFSET_Z,
      pz + lz * DRONE_OFFSET_Z);
    drone.faction = 'hostile';
    drones.push(drone);
  }
  function advance() {
    if (stepIdx >= script.length) { endTutorial(); return; }
    const step = script[stepIdx];
    // Default-clear the maze highlight every time we change step;
    // applyLine() re-applies the line's own `highlight` flag right
    // after this if it was set.
    setTutorialHighlight(null);
    switch (step.type) {
      case 'line':
        applyLine(step);
        return;
      case 'choice':
        applyChoice(step);
        return;
      case 'spawnDrone':
        spawnDroneOnce();
        stepIdx++;
        advance();
        return;
      case 'awaitHack':
        hint.textContent = 'Walk up to Dronny and press R';
        waiting = 'hack';
        return;
      case 'awaitHackClose':
        // If the hack already finished while the player was working
        // through earlier lines, fall straight through to the next
        // step. Otherwise leave the dialogue card on the most recent
        // line and wait for onClose to flip the flag.
        if (hackResolved) { stepIdx++; advance(); return; }
        waiting = 'hackClose';
        hint.textContent = 'Finish the hack to continue…';
        return;
      case 'end':
        endTutorial();
        return;
    }
  }
  // Advance script by one, honouring `hideAfter` on the line we're
  // leaving so the dialogue can be dismissed and the player left
  // alone for the rest of the hack. Also runs any "leaving this
  // line" side-effects (focus + auto-zeroing) so the player can
  // type without clicking and the maze stays solvable.
  function advanceFromSpace() {
    const cur = script[stepIdx];
    clearAutoTimer();
    stepIdx++;
    if (cur) {
      if (cur.hideAfter)         hideDialogue();
      if (cur.focusInputAfter && hacker?.inputEl) {
        hacker.setInputEnabled?.(true);
        // Defer slightly so the click-to-focus listener on the
        // overlay doesn't immediately steal focus back.
        setTimeout(() => hacker.inputEl.focus(), 0);
      }
      if (cur.enableAutoZeroing) {
        hacker.setAutoForceZeroing?.(true);
        // Drop any tutorial-only input validator so non-forced
        // commands run normally for the rest of the hack.
        hacker.setInputValidator?.(null);
      }
    }
    advance();
  }

  function endTutorial() {
    if (runEnded) return;
    clearAutoTimer();
    hideDialogue();
    waiting = null;
    runEnded = true;
    // Hand off into the actual game: reload the page so the corp
    // logo splash plays first and then the main run starts cleanly.
    // A reload is the simplest way to fully reset every module-level
    // bit of state (drone wiring, scene, listeners) without trying
    // to surgically tear down the tutorial scene.
    setTimeout(() => {
      window.__nanoDebugLevel = false;
      // Strip the `?tutorial` hint if any URL params drove us here,
      // then reload to the bare page → corp logo → game.
      const url = new URL(window.location.href);
      url.hash = '';
      window.location.replace(url.toString());
    }, 320);
  }

  // ── Input ───────────────────────────────────────────────────────────
  // Capture-phase intercept: while the hack minigame is open, SPACE
  // would normally be typed into the terminal input (the focused
  // <input>). We listen in capture phase so we see the keydown
  // BEFORE it reaches the input, advance the dialogue, then
  // preventDefault + stopImmediatePropagation so the SPACE never
  // becomes a typed character. This is the only way to keep the
  // mentor on a manual-advance flow without colliding with the
  // player's command typing.
  document.addEventListener('keydown', (e) => {
    if (runEnded) return;
    if (!hacker.active && !pendingHack) return;
    if (waiting !== 'space') return;
    if (e.key !== ' ' && e.key !== 'Enter') return;
    // Enter inside the hack form submits the command — only intercept
    // SPACE for advance, leave Enter to the form so the hack still
    // works as expected.
    if (e.key !== ' ') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    advanceFromSpace();
  }, true);   // <-- capture phase

  // Action-gated steps watch these keys and advance once the player
  // performs the matching action. The same key may also do its
  // normal in-game function (movement, J-shoot, R-hack) below.
  const ACTION_KEYS = {
    movement: ['w', 'a', 's', 'd'],
    turn:     ['q', 'e'],
    shoot:    ['j'],
  };

  // We deliberately DON'T early-return on `hacker.active` — the
  // mentor needs to keep narrating the hack screen while it's open,
  // so SPACE-advance has to keep working through the minigame.
  window.addEventListener('keydown', (e) => {
    if (runEnded) return;
    const k = e.key.toLowerCase();

    // If we're parked on an action gate and the player just
    // performed it, advance the script. We let normal in-game
    // handlers below ALSO process the same key (so e.g. pressing W
    // both satisfies the gate AND moves the player).
    if (waiting && waiting.kind === 'action') {
      const expected = ACTION_KEYS[waiting.action] || [];
      if (expected.includes(k)) {
        stepIdx++;
        advance();
        // Fall through — don't `return` — so the same keydown still
        // reaches the J-shoot / SPACE-shoot / etc. handlers below.
      }
    }

    // Manual dialogue advance via SPACE / Enter while NOT in a hack.
    // The hack-time SPACE handling lives in the capture-phase
    // listener below so the keystroke doesn't reach the terminal
    // input.
    if (waiting === 'space' && !hacker.active && !pendingHack
        && (e.key === ' ' || k === 'enter')) {
      e.preventDefault();
      advanceFromSpace();
      return;
    }
    // Choice keys — also unaffected by hack state.
    if (waiting && waiting.kind === 'choice') {
      const opt = waiting.options.find(o => o.key === k);
      if (opt) { jumpTo(opt.branch); return; }
    }
    // Hack-link gate. R near the drone kicks off the lock-on +
    // minigame and ALSO advances the script immediately, so the
    // first hack-screen narration line pops up alongside the lock-on
    // pulse. We accept R either when:
    //   • we're explicitly waiting on a hack ('hack' state), OR
    //   • the current line is flagged `acceptHackR` (the "press R
    //     to hack" line itself, so the player isn't forced to
    //     press SPACE first to dismiss it).
    const currentStep = script[stepIdx];
    const onHackPromptLine = waiting === 'space' && currentStep && currentStep.acceptHackR;
    if (k === 'r' && (waiting === 'hack' || onHackPromptLine)
        && !pendingHack && !hacker.active) {
      if (!drone || !drone.alive) return;
      // Flash the hack-range ring whether the drone is in range or
      // not — same UX cue the live game gives so the player can see
      // how far their hack reach is.
      flashHackRange();
      const d = Math.hypot(player.position.x - drone.mesh.position.x,
                           player.position.z - drone.mesh.position.z);
      if (d >= HACK_RANGE) return;
      pickRing.position.set(drone.mesh.position.x, 0.03, drone.mesh.position.z);
      pickRing.visible = true;
      pendingHack = {
        target:    drone,
        startTime: performance.now(),
        onClose: (won) => {
          pickRing.visible = false;
          if (won) {
            drone.hackLink?.();
            spawnConfetti(scene, drone.mesh.position.x, 0.6, drone.mesh.position.z, {
              particles: 30, size: 0.18,
            });
            spawnHackSwarm(
              scene,
              (out) => out.set(player.position.x, player.position.y + 1.0, player.position.z),
              (out) => drone.getHackTargetWorldPos
                ? drone.getHackTargetWorldPos(out)
                : out.copy(drone.mesh.position),
            );
          }
          // Re-show the dialogue card (it stays mounted but the user
          // requested the latest message be visible after the hack
          // closes — `showDialogue` is idempotent so calling it
          // unconditionally is safe).
          showDialogue();
          hackResolved = true;
          // If the script is parked at `awaitHackClose`, advance now
          // so the celebratory line takes the screen. Otherwise the
          // user is mid-line; the awaitHackClose step will see
          // hackResolved=true when it eventually runs and skip
          // straight through.
          if (waiting === 'hackClose') {
            stepIdx++;
            advance();
          }
        },
      };
      // Advance immediately so the "This is the hacking screen…"
      // line pops up alongside the lock-on pulse.
      waiting = null;
      stepIdx++;
      advance();
      return;
    }

    // Free-play J-shoot — works at any point in the tutorial (the
    // dialogue never blocks weapon use), suppressed only while the
    // hack screen has focus so we don't fire the bow while the
    // player is typing a command.
    if (k === 'j' && !hacker.active && !pendingHack) {
      if (shotCooldown > 0) return;
      const d = player.facingDir;
      const len = Math.hypot(d.x, d.z) || 1;
      const muzzle = player.getBowMuzzleWorldPos?.(new THREE.Vector3());
      const sx = muzzle ? muzzle.x : player.position.x + (d.x / len) * 0.6;
      const sy = muzzle ? muzzle.y : 0.6;
      const sz = muzzle ? muzzle.z : player.position.z + (d.z / len) * 0.6;
      game.spawnBullet(sx, sz, d.x / len, d.z / len, 'player', null, sy);
      player.notifyShot?.();
      shotCooldown = SHOT_COOLDOWN;
    }
  });

  let shotCooldown = 0;

  function tickPendingHack() {
    if (!pendingHack) return false;
    const elapsed  = performance.now() - pendingHack.startTime;
    const progress = Math.min(elapsed / HACK_PREP_MS, 1);
    const scale    = 1 + Math.sin(progress * Math.PI) * 0.9;
    pickRing.scale.setScalar(scale);
    pickRing.material.opacity = 0.6 + 0.4 * Math.sin(progress * Math.PI * 4);
    if (progress >= 1) {
      const p = pendingHack;
      pendingHack = null;
      pickRing.scale.setScalar(1);
      pickRing.material.opacity = 0.9;
      // Difficulty 3 per spec; tutorial mode hides clock + HP panel
      // and disables fail-on-timeout. The mentor's narration lines
      // un-hide those panels in sequence (see `reveal` flags in the
      // script above).
      hacker.open(3, { onClose: p.onClose, tutorialMode: true });
      // Listen for command applications so we can:
      //   • advance the dialogue past the awaitHackCommand step.
      //   • refresh neighbour-cell tags on the freshly rendered
      //     board so the highlight follows the moved cursor.
      hacker.setOnCommandApplied?.((info) => {
        // Re-tag after the new board has finished draining into
        // outputEl (lines drip in at ~10 ms each via the output
        // queue; a small delay gets us past the bulk of them).
        const step = script[stepIdx];
        const refreshTags = () => {
          if (step?.highlight === 'cursor-neighbours' && hacker.getCursorNeighbours) {
            tagCellsByPos(hacker.getCursorNeighbours());
          } else if (step?.highlight === 'goal-neighbours' && hacker.getGoalNeighbours) {
            tagCellsByPos(hacker.getGoalNeighbours());
          }
        };
        setTimeout(refreshTags, 250);
        if (waiting && waiting.kind === 'hackCommand') {
          const cond = waiting.condition;
          const ok = cond === 'zero-neighbour' ? info.cursorMoved : true;
          if (ok) {
            stepIdx++;
            advance();
          }
        }
      });
    }
    return true;
  }

  // ── Animate loop ────────────────────────────────────────────────────
  const clock = new THREE.Clock();
  function tick() {
    // Tutorial may hand off to runDebugLevel mid-session; once
    // that's happened we stop scheduling frames so we don't fight
    // for the renderer + render-loop time with the debug level.
    if (runEnded) return;
    requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);

    if (tickPendingHack()) { renderer.render(scene, camera); return; }
    if (hacker.active)     { renderer.render(scene, camera); return; }

    // Player free-play (no battleMode in the tutorial).
    player.update(dt, map, null, false, shotCooldown <= 0);
    if (shotCooldown > 0) shotCooldown -= dt;

    // Drone, if spawned. Vision/aggression is irrelevant here; drone
    // wanders normally — the player just walks up and hacks it.
    const worldView = {
      player, enemies: [], drones, mechas: [], map,
      destroyObstacleAt: () => {}, realDt: dt, battleMode: false,
      debugOpen: false, cameraYaw: CAM_YAW,
    };
    for (const d of drones) d.update(dt, map, worldView, game, performance.now() / 1000);

    // Bullets.
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.update(dt, map, null, drones, game);
      if (!b.alive) bullets.splice(i, 1);
    }

    // Hack-range ring fades out after each R-press flash. While the
    // timer is positive we keep updating its position to follow the
    // player (in case they walk during the flash window).
    if (hackRangeFlashTimer > 0) {
      hackRangeFlashTimer -= dt;
      if (hackRangeFlashTimer <= 0) hackRangeRing.visible = false;
      else hackRangeRing.position.set(player.position.x, 0.01, player.position.z);
    }

    // Camera follow.
    const followPos = player.position;
    camera.position.set(
      followPos.x + Math.sin(CAM_YAW) * CAM_RADIUS,
      CAM_HEIGHT,
      followPos.z + Math.cos(CAM_YAW) * CAM_RADIUS,
    );
    camera.lookAt(followPos.x, 0.5, followPos.z);

    updatePlayerArrowVFX(dt);
    updateHackSwarm(dt);
    updateConfetti(dt);

    // Update the live HUD's shot cooldown so it reflects the
    // tutorial's local cooldown variable — same readout the player
    // will see in the live game ("Shot: 4.2s" / "Shot: READY").
    const hudShotEl = document.getElementById('shot');
    if (hudShotEl) {
      hudShotEl.innerHTML = shotCooldown <= 0
        ? 'Shot: <b style="color:#7ff">READY</b>'
        : `Shot: <b>${shotCooldown.toFixed(1)}s</b>`;
    }

    renderer.render(scene, camera);
  }
  tick();

  // Step debug runs on its own interval so it keeps refreshing even
  // while the animate loop early-returns (during the hack-prep pulse
  // or once the hack minigame is open).
  const stepDbgInterval = setInterval(() => {
    if (runEnded) { clearInterval(stepDbgInterval); return; }
    updateStepDbg();
  }, 200);

  // Kick off step 0 once the dialogue card is in the DOM.
  setTimeout(() => advance(), 60);
}
