import * as THREE from 'three';
import { createFrame } from '../track/spline';
import type { Track } from '../track/spline';
import { GAUGE } from '../track/trackMesh';

/** 차량 간격(m) */
export const CAR_SPACING = 2.7;
export const CAR_COUNT = 3;
/** 맨 앞 차량 앞줄 좌석의 눈 위치 (차량 로컬: x=오른쪽, y=위, z=뒤) */
export const EYE_LOCAL = new THREE.Vector3(0, 1.44, -0.12);

function box(
  parent: THREE.Object3D,
  mat: THREE.Material,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/** 차량 한 대. 로컬 -Z 가 진행 방향, 원점은 레일 높이의 차량 중심. */
function buildCar(lead: boolean): THREE.Group {
  const car = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0xd9282f, metalness: 0.35, roughness: 0.4 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xf5c33b, metalness: 0.3, roughness: 0.45 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1f25, roughness: 0.8 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.8, roughness: 0.3 });

  // 바닥과 옆판. 1인칭 시야를 가리지 않도록 앞쪽은 낮게 만든다.
  box(car, body, 1.36, 0.22, 2.4, 0, 0.42, 0);
  box(car, body, 0.09, 0.4, 2.3, -0.64, 0.7, 0);
  box(car, body, 0.09, 0.4, 2.3, 0.64, 0.7, 0);
  box(car, trim, 0.1, 0.05, 2.3, -0.64, 0.92, 0);
  box(car, trim, 0.1, 0.05, 2.3, 0.64, 0.92, 0);
  box(car, body, 1.36, 0.5, 0.1, 0, 0.74, 1.15);
  // 앞판
  box(car, body, 1.36, 0.36, 0.1, 0, 0.68, -1.15);
  box(car, trim, 1.36, 0.05, 0.12, 0, 0.88, -1.15);
  if (lead) {
    // 맨 앞 차량의 코
    const nose = box(car, body, 1.16, 0.3, 0.9, 0, 0.5, -1.58);
    nose.rotation.x = 0.3;
  }
  // 좌석 두 줄
  for (const z of [0.25, 1.0]) {
    box(car, dark, 1.1, 0.14, 0.52, 0, 0.6, z - 0.28);
    box(car, dark, 1.1, 0.8, 0.12, 0, 0.98, z);
    // 안전바
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.14, 8), steel);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, 0.86, z - 0.66);
    bar.castShadow = true;
    car.add(bar);
  }
  // 바퀴 뭉치
  for (const x of [-GAUGE / 2, GAUGE / 2]) {
    for (const z of [-0.8, 0.8]) {
      box(car, dark, 0.2, 0.3, 0.55, x, 0.18, z);
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.1, 12), steel);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, 0.2, z);
      car.add(wheel);
    }
  }
  return car;
}

export class Train {
  readonly group = new THREE.Group();
  private readonly cars: THREE.Group[] = [];
  private readonly frame = createFrame();
  private readonly basis = new THREE.Matrix4();
  private readonly back = new THREE.Vector3();

  constructor() {
    for (let i = 0; i < CAR_COUNT; i++) {
      const car = buildCar(i === 0);
      car.matrixAutoUpdate = false;
      this.cars.push(car);
      this.group.add(car);
    }
  }

  /** 맨 앞 차량이 s 에 오도록 열차를 놓는다 */
  place(track: Track, s: number): void {
    for (let i = 0; i < this.cars.length; i++) {
      const f = track.frameAt(s - i * CAR_SPACING, this.frame);
      this.back.copy(f.tan).negate();
      this.basis.makeBasis(f.right, f.up, this.back);
      this.basis.setPosition(f.pos);
      this.cars[i].matrix.copy(this.basis);
      this.cars[i].matrixWorldNeedsUpdate = true;
    }
  }
}
