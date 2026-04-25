import * as THREE from 'three';

// Build a flat triangular arrow that lies on the floor and rotates around
// the world Y axis to indicate which way an entity is facing. Returns the
// mesh; the caller is responsible for parenting it to the scene and updating
// position + rotation.y each frame.
export function makeFacingArrow(color = 0xff5555, opacity = 0.85) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
     0,    0,  0.55,
    -0.28, 0, -0.18,
     0.28, 0, -0.18,
  ]), 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(geo, mat);
  m.position.y = 0.04;
  return m;
}
