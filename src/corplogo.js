import * as THREE from 'three';
import { NAME_PREFIXES, NAME_SUFFIXES, LEMAS } from './corpdata.js';

function randomCorpName() {
  const a = NAME_PREFIXES[Math.floor(Math.random() * NAME_PREFIXES.length)];
  const b = NAME_SUFFIXES[Math.floor(Math.random() * NAME_SUFFIXES.length)];
  return `${a} ${b}`;
}

function randomLema() {
  return LEMAS[Math.floor(Math.random() * LEMAS.length)];
}

// Take a base polyhedron and jiggle each vertex by a random offset so every
// logo shape looks hand-crafted rather than a perfect primitive.
function makeJaggedShape(color) {
  // Pool grew with: a few extra polyhedra-like primitives, a torus
  // family (regular + knotted), some prisms and a 2D flat ring. Each
  // entry returns a fresh BufferGeometry; the vertex-jiggle loop then
  // perturbs every vertex slightly so even repeated picks read as
  // hand-crafted variants.
  const shapes = [
    // Polyhedra
    () => new THREE.IcosahedronGeometry(1, 1),
    () => new THREE.OctahedronGeometry(1, 0),
    () => new THREE.DodecahedronGeometry(0.95, 0),
    () => new THREE.TetrahedronGeometry(1.2, 0),
    // Prisms / spikes
    () => new THREE.CylinderGeometry(0.8, 0.8, 1.2, 6, 1),   // hexagonal prism
    () => new THREE.CylinderGeometry(0.0, 0.9, 1.4, 5, 1),   // pentagonal spike
    () => new THREE.CylinderGeometry(0.85, 0.85, 1.0, 8, 1), // octagonal puck
    () => new THREE.ConeGeometry(0.95, 1.6, 4, 1),           // square pyramid
    // Curved
    () => new THREE.SphereGeometry(0.9, 12, 8),
    () => new THREE.CapsuleGeometry(0.55, 0.7, 4, 10),
    () => new THREE.BoxGeometry(1.3, 1.3, 1.3),
    // Tori — a donut and a knot for fancier shapes.
    () => new THREE.TorusGeometry(0.8, 0.28, 10, 18),
    () => new THREE.TorusKnotGeometry(0.7, 0.22, 64, 10, 2, 3),
    // 2D — flat ring. Two-sided + flat-shaded so it reads from any
    // angle; the vertex jiggle pushes its outline slightly off-circle.
    () => new THREE.RingGeometry(0.55, 1.05, 18, 1),
  ];
  const idx = Math.floor(Math.random() * shapes.length);
  const geo = shapes[idx]();
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) + (Math.random() - 0.5) * 0.25,
      pos.getY(i) + (Math.random() - 0.5) * 0.25,
      pos.getZ(i) + (Math.random() - 0.5) * 0.25,
    );
  }
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: new THREE.Color(color).multiplyScalar(0.18),
    roughness: 0.45,
    metalness: 0.55,
    flatShading: true,
    transparent: true,
    opacity: 0.85,
    // Render both sides — required for the flat ring and harmless for
    // the solid shapes (their backfaces aren't visible anyway).
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geo, mat);
}

// Show the corp splash, then call `onComplete` after it fades out. The caller
// is responsible for kicking off the game's animation loop at that point.
// `onSkipToDebug`, if supplied, is called instead of `onComplete` when the
// player presses TAB during the splash — used as the entry point into the
// character/animation debug level.
export function showCorpLogo(
  { durationMs = 3500, fadeMs = 700 } = {},
  onComplete,
  onSkipToDebug,
  onSkipToTutorial,
) {
  const overlay = document.createElement('div');
  overlay.id = 'corplogo-overlay';
  overlay.style.cssText = `
    position:fixed; inset:0; z-index:100;
    background: radial-gradient(ellipse at center, #0a1525 0%, #000 75%);
    color:#cfe; font-family:'Courier New', Courier, monospace;
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    transition: opacity ${fadeMs}ms ease-out;
  `;

  // Intro tag
  const tag = document.createElement('div');
  tag.textContent = '// INCOMING CONTRACT //';
  tag.style.cssText = 'color:#6aa; letter-spacing:.4em; font-size:14px; margin-bottom:28px;';
  overlay.appendChild(tag);

  // Canvas for the overlapping 3D shapes — wrapped in a relative
  // positioned container so the (optional) initials overlay can be
  // absolutely positioned over the canvas without disturbing the
  // outer flex layout.
  const logoBox = document.createElement('div');
  logoBox.style.cssText = 'position:relative; width:320px; height:320px; margin-bottom:22px;';
  overlay.appendChild(logoBox);

  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 320;
  canvas.style.cssText = 'width:320px; height:320px; display:block;';
  logoBox.appendChild(canvas);

  // Resolve the corp name once so we can derive an initials overlay
  // from the SAME name shown below the logo (consistent branding).
  const corpName = randomCorpName();

  // Pool of web-safe + modern fonts that ship with most browsers /
  // OS bundles. No external font loading — we pick at runtime and
  // fall back to monospace if a face isn't installed.
  const FONT_POOL = [
    '"Courier New", Courier, monospace',
    '"Consolas", "Lucida Console", monospace',
    '"Georgia", "Times New Roman", serif',
    '"Trebuchet MS", "Lucida Grande", sans-serif',
    '"Impact", "Arial Black", sans-serif',
    '"Verdana", Geneva, sans-serif',
    '"Palatino Linotype", "Book Antiqua", serif',
    '"Arial Black", Arial, sans-serif',
    '"Garamond", "Baskerville", serif',
    '"Tahoma", Geneva, sans-serif',
  ];
  function pickFont() {
    return FONT_POOL[Math.floor(Math.random() * FONT_POOL.length)];
  }
  function randomLetterColor() {
    const hue   = Math.floor(Math.random() * 360);
    const sat   = 65 + Math.floor(Math.random() * 25);
    const light = 60 + Math.floor(Math.random() * 20);
    return {
      color: `hsl(${hue}, ${sat}%, ${light}%)`,
      glow:  `hsla(${hue}, ${sat}%, ${light}%, 0.55)`,
    };
  }
  // Place a letter as an absolutely-positioned div inside logoBox at
  // a random offset. `radius` controls the max distance from centre.
  function placeLetter(letter, opts = {}) {
    const radius = opts.radius ?? 80;
    const r   = Math.sqrt(Math.random()) * radius;
    const ang = Math.random() * Math.PI * 2;
    const dx  = Math.cos(ang) * r;
    const dy  = Math.sin(ang) * r;
    const { color, glow } = randomLetterColor();
    const el = document.createElement('div');
    el.textContent = letter;
    el.style.cssText = [
      'position:absolute', 'left:50%', 'top:50%',
      `transform:translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px))`,
      'pointer-events:none',
      `color:${color}`,
      `font-size:${opts.size ?? 110}px`,
      'font-weight:900', 'letter-spacing:.06em',
      `font-family:${pickFont()}`,
      `text-shadow:0 0 18px ${glow}, 0 0 4px rgba(0,0,0,0.6)`,
      'mix-blend-mode:screen',
    ].join(';');
    logoBox.appendChild(el);
  }

  // Pull the first letter of each word so we can drop them in
  // independently. The first one is the primary monogram; the
  // second only appears 10 % of the time as a smaller offset
  // companion glyph (different size + position + colour).
  const words = corpName.split(/\s+/).filter(Boolean);
  const firstInitial  = (words[0]?.[0] ?? '').toUpperCase();
  const secondInitial = (words[1]?.[0] ?? '').toUpperCase();
  if (firstInitial) placeLetter(firstInitial, { size: 110, radius: 80 });
  if (secondInitial && Math.random() < 0.10) {
    // Smaller, fresh offset, fresh colour, fresh font — reads as a
    // sub-monogram tucked into the composition.
    placeLetter(secondInitial, { size: 64, radius: 110 });
  }

  // 10 % chance: scatter a few translucent flat shapes (circles,
  // triangles, squares) over the logo as a different "wordmark"
  // direction. Drawn as SVG inside logoBox so they layer with the
  // 3D canvas underneath without changing its aesthetic.
  if (Math.random() < 0.10) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 320 320');
    svg.style.cssText = [
      'position:absolute', 'inset:0',
      'pointer-events:none',
      'mix-blend-mode:screen',
    ].join(';');
    const SHAPES = ['circle', 'triangle', 'square', 'ring'];
    const count = 3 + Math.floor(Math.random() * 4);  // 3..6
    for (let i = 0; i < count; i++) {
      const kind = SHAPES[Math.floor(Math.random() * SHAPES.length)];
      const cx   = 80 + Math.random() * 160;
      const cy   = 80 + Math.random() * 160;
      const r    = 28 + Math.random() * 50;
      const { color } = randomLetterColor();
      const opacity = 0.25 + Math.random() * 0.35;
      let el;
      if (kind === 'circle') {
        el = document.createElementNS(NS, 'circle');
        el.setAttribute('cx', cx); el.setAttribute('cy', cy);
        el.setAttribute('r', r);
      } else if (kind === 'square') {
        el = document.createElementNS(NS, 'rect');
        el.setAttribute('x', cx - r); el.setAttribute('y', cy - r);
        el.setAttribute('width', r * 2); el.setAttribute('height', r * 2);
      } else if (kind === 'triangle') {
        const p1 = `${cx},${cy - r}`;
        const p2 = `${cx - r * 0.866},${cy + r * 0.5}`;
        const p3 = `${cx + r * 0.866},${cy + r * 0.5}`;
        el = document.createElementNS(NS, 'polygon');
        el.setAttribute('points', `${p1} ${p2} ${p3}`);
      } else {
        // ring
        el = document.createElementNS(NS, 'circle');
        el.setAttribute('cx', cx); el.setAttribute('cy', cy);
        el.setAttribute('r', r);
        el.setAttribute('fill', 'none');
        el.setAttribute('stroke', color);
        el.setAttribute('stroke-width', 6);
        el.setAttribute('opacity', opacity);
        svg.appendChild(el);
        continue;
      }
      el.setAttribute('fill', color);
      el.setAttribute('opacity', opacity);
      svg.appendChild(el);
    }
    logoBox.appendChild(svg);
  }

  const nameDiv = document.createElement('div');
  nameDiv.textContent = corpName;
  nameDiv.style.cssText =
    'font-size:38px; font-weight:bold; letter-spacing:.14em; color:#ddf2ff; ' +
    'text-shadow: 0 0 18px rgba(90,170,255,0.55); margin-bottom:10px;';
  overlay.appendChild(nameDiv);

  const lemaDiv = document.createElement('div');
  lemaDiv.textContent = `"${randomLema()}"`;
  lemaDiv.style.cssText = 'font-size:16px; font-style:italic; color:#8fa; opacity:.85;';
  overlay.appendChild(lemaDiv);

  document.body.appendChild(overlay);

  // ── Mini three.js scene for the corp logo ───────────────────────────────
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setSize(320, 320, false);
  const scene  = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20);
  camera.position.set(0, 0, 5.2);

  const colorA = new THREE.Color().setHSL(Math.random(),             0.65, 0.55);
  const colorB = new THREE.Color().setHSL((Math.random() + 0.5) % 1, 0.70, 0.55);
  const a = makeJaggedShape(colorA.getHex());
  const b = makeJaggedShape(colorB.getHex());
  a.scale.setScalar(1.15);
  b.scale.setScalar(0.85);
  // Both shapes share a parent group — they rotate as one around the common
  // centroid, so the player sees a single composite logo breathing slightly.
  const logoGroup = new THREE.Group();
  logoGroup.add(a);
  logoGroup.add(b);
  scene.add(logoGroup);

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(2.5, 3, 2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xa0c0ff, 0.45);
  rim.position.set(-2, -1, -3);
  scene.add(rim);

  let t = 0;
  let alive = true;
  function loop() {
    if (!alive) return;
    // No rotation — just a very subtle "breathing" scale on the whole logo.
    // Amplitude ≈ 1.5 % so it's barely noticeable, just enough to feel alive.
    t += 0.022;
    const s = 1 + Math.sin(t) * 0.015;
    logoGroup.scale.set(s, s, s);
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  loop();

  // Single dismiss path — fades out, tears down the renderer + overlay, then
  // invokes whichever exit callback the caller registered.
  let dismissed = false;
  function dismiss(onDone, fastFade = false) {
    if (dismissed) return;
    dismissed = true;
    window.removeEventListener('keydown', onKey);
    overlay.style.opacity = '0';
    overlay.style.transition = `opacity ${fastFade ? 200 : fadeMs}ms ease-out`;
    setTimeout(() => {
      alive = false;
      renderer.dispose();
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (typeof onDone === 'function') onDone();
    }, fastFade ? 200 : fadeMs);
  }

  // TAB during the splash → debug level. T → tutorial level. Both
  // skip the rest of the splash with a fast fade and route to a
  // different entry point.
  function onKey(e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      dismiss(onSkipToDebug ?? onComplete, true);
      return;
    }
    if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      dismiss(onSkipToTutorial ?? onComplete, true);
      return;
    }
  }
  window.addEventListener('keydown', onKey);

  // Default path: dismiss after the configured duration.
  setTimeout(() => dismiss(onComplete, false), durationMs);
}
