import * as THREE from 'three';

/** 열차가 멈춘 위치를 가리키는 표식: 붉은 구 + 멀리서도 보이는 빛기둥 + 맥동하는 고리 */
export class StallMarker {
  readonly group = new THREE.Group();
  private readonly ring: THREE.Mesh;
  private readonly beam: THREE.Mesh;
  private time = 0;

  constructor() {
    const red = 0xff2d3d;
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.75, 20, 14),
      new THREE.MeshBasicMaterial({ color: red, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    core.renderOrder = 20;
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.6, 0.12, 8, 40),
      new THREE.MeshBasicMaterial({ color: red, depthTest: false, transparent: true, opacity: 0.8 }),
    );
    this.ring.rotation.x = Math.PI / 2;
    this.ring.renderOrder = 20;
    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.18, 60, 8, 1, true).translate(0, 30, 0),
      new THREE.MeshBasicMaterial({ color: red, transparent: true, opacity: 0.35, depthWrite: false, fog: false }),
    );
    this.group.add(core, this.ring, this.beam);
    this.group.visible = false;
  }

  show(position: THREE.Vector3): void {
    this.group.position.copy(position);
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }

  update(dt: number): void {
    if (!this.group.visible) return;
    this.time += dt;
    const pulse = (this.time * 0.9) % 1;
    const s = 1 + pulse * 1.8;
    this.ring.scale.set(s, s, s);
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - pulse);
    (this.beam.material as THREE.MeshBasicMaterial).opacity = 0.28 + 0.12 * Math.sin(this.time * 4);
  }
}
