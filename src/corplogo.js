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
  const shapes = [
    () => new THREE.IcosahedronGeometry(1, 1),
    () => new THREE.OctahedronGeometry(1, 0),
    () => new THREE.DodecahedronGeometry(0.95, 0),
    () => new THREE.TetrahedronGeometry(1.2, 0),
    () => new THREE.CylinderGeometry(0.8, 0.8, 1.2, 6, 1),   // hexagonal prism
    () => new THREE.CylinderGeometry(0.0, 0.9, 1.4, 5, 1),   // pentagonal spike
  ];
  const geo = shapes[Math.floor(Math.random() * shapes.length)]();
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
  });
  return new THREE.Mesh(geo, mat);
}

// Show the corp splash, then call `onComplete` after it fades out. The caller
// is responsible for kicking off the game's animation loop at that point.
export function showCorpLogo({ durationMs = 3500, fadeMs = 700 } = {}, onComplete) {
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

  // Canvas for the overlapping 3D shapes
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 320;
  canvas.style.cssText = 'width:320px; height:320px; display:block; margin-bottom:22px;';
  overlay.appendChild(canvas);

  const nameDiv = document.createElement('div');
  nameDiv.textContent = randomCorpName();
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
    // Very gentle rotation — a few degrees over the full splash, just enough
    // to feel alive without ever completing a full turn.
    t += 0.003;
    logoGroup.rotation.y = t;
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  loop();

  // Fade out, dispose, and hand control back to the caller.
  setTimeout(() => {
    overlay.style.opacity = '0';
    setTimeout(() => {
      alive = false;
      renderer.dispose();
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (typeof onComplete === 'function') onComplete();
    }, fadeMs);
  }, durationMs);
}
