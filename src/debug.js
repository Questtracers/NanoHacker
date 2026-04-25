import * as THREE from 'three';

const ROUTE_COLORS = [0x00ffff, 0xff88ff, 0xffff44, 0x88ff88, 0xff8844, 0x88aaff, 0xffaacc, 0xaaffdd];

export class DebugSystem {
  constructor(scene) {
    this.scene   = scene;
    this.enabled = false;
    this.objects = []; // route lines + markers
    this.overlay = this._makeOverlay();

    window.addEventListener('keydown', e => {
      if (window.__nanoDebugLevel) return;
      if (e.key === 'Tab') { e.preventDefault(); this.toggle(); }
    });
  }

  _makeOverlay() {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'top:8px', 'right:8px', 'z-index:15',
      'padding:10px 14px', 'background:rgba(0,5,15,0.88)',
      'border:1px solid #0ff9', 'border-radius:4px',
      'font-family:monospace', 'font-size:11px', 'color:#aef',
      'line-height:1.75', 'display:none', 'max-width:320px',
      'pointer-events:none', 'white-space:pre',
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  toggle() {
    this.enabled = !this.enabled;
    this.overlay.style.display = this.enabled ? 'block' : 'none';
    for (const o of this.objects) o.visible = this.enabled;
  }

  buildRoutes(enemies) {
    for (const o of this.objects) {
      this.scene.remove(o);
      o.geometry?.dispose();
      o.material?.dispose();
    }
    this.objects = [];

    enemies.forEach((e, i) => {
      if (!e.routePath?.length) return;
      const col = ROUTE_COLORS[i % ROUTE_COLORS.length];
      e._debugColor = col;

      // Dashed line along route
      const pts = e.routePath.map(p => new THREE.Vector3(p.x, 0.12, p.z));
      const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(lineGeo,
        new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.65 })
      );
      line.visible = this.enabled;
      this.scene.add(line);
      this.objects.push(line);

      // Endpoint markers: flat cylinders with label A / B
      e.routePath.forEach((pt, idx) => {
        const disc = new THREE.Mesh(
          new THREE.CylinderGeometry(0.38, 0.38, 0.06, 20),
          new THREE.MeshBasicMaterial({ color: col })
        );
        disc.position.set(pt.x, 0.12, pt.z);
        disc.visible = this.enabled;
        this.scene.add(disc);
        this.objects.push(disc);

        // Small vertical pin so it's visible from a distance
        const pin = new THREE.Mesh(
          new THREE.CylinderGeometry(0.06, 0.06, 1.2, 8),
          new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55 })
        );
        pin.position.set(pt.x, 0.7, pt.z);
        pin.visible = this.enabled;
        this.scene.add(pin);
        this.objects.push(pin);
      });
    });
  }

  update(player, enemies, battleMode) {
    if (!this.enabled) return;

    const p = player.position;
    const modeCol = battleMode ? '#f66' : '#6ef';

    let lines = [
      `\u25a0 DEBUG  [TAB to hide]`,
      `Player  ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`,
      `Mode    \x1b[${battleMode ? '31' : '36'}m${battleMode ? 'BATTLE' : 'STEALTH'}`,
      ``,
    ];

    enemies.forEach((e, i) => {
      if (!e.alive) { lines.push(`E${i}  dead`); return; }
      const icon  = e.alerted ? '● ALT' : e.returningToRoute ? '◑ RET' : '○ PAT';
      const ep    = e.position;
      const fDeg  = ((e.facing * 180 / Math.PI) % 360 + 360) % 360;
      let row = `E${i}  ${icon}  (${ep.x.toFixed(1)},${ep.z.toFixed(1)})  ${fDeg.toFixed(0)}°`;
      if (e.alerted)        row += `  ls:${(e.losingSightTimer ?? 0).toFixed(1)}`;
      if (e.waitTimer > 0)  row += `  wait:${e.waitTimer.toFixed(1)}s`;
      if (e.routePath)      row += `  wp:${e.pathPos}/${e.routePath.length - 1}`;
      lines.push(row);
    });

    // Build HTML (no actual ANSI in browser)
    this.overlay.innerHTML =
      `<span style="color:#0ff;font-weight:bold">\u25a0 DEBUG</span>  <span style="opacity:.5;font-size:10px">[TAB to hide]</span>\n` +
      `Player  <b>${p.x.toFixed(1)}, ${p.z.toFixed(1)}</b>\n` +
      `Mode    <b style="color:${modeCol}">${battleMode ? 'BATTLE' : 'STEALTH'}</b>\n\n` +
      enemies.map((e, i) => {
        if (!e.alive) return `<span style="opacity:.4">E${i}  dead</span>`;
        const col   = e._debugColor ? '#' + e._debugColor.toString(16).padStart(6, '0') : '#fff';
        const icon  = e.alerted ? '<span style="color:#f66">● ALT</span>' :
                      e.returningToRoute ? '<span style="color:#ff8">◑ RET</span>' :
                      '<span style="color:#6f6">○ PAT</span>';
        const ep    = e.position;
        const fDeg  = ((e.facing * 180 / Math.PI) % 360 + 360) % 360;
        let row = `<span style="color:${col}">E${i}</span>  ${icon}  (${ep.x.toFixed(1)},${ep.z.toFixed(1)})  ${fDeg.toFixed(0)}°`;
        if (e.alerted)       row += `  <span style="opacity:.7">ls:${(e.losingSightTimer ?? 0).toFixed(1)}</span>`;
        if (e.waitTimer > 0) row += `  <span style="opacity:.7">wait:${e.waitTimer.toFixed(1)}s</span>`;
        if (e.routePath)         row += `  wp<b>${e.pathPos}</b>/${e.routePath.length - 1}`;
        return row;
      }).join('\n');
  }
}
