import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Track } from './spline';

/**
 * 트랙의 3D 모델: 레일 2줄, 중앙 척추(스파인), 침목, 체인, 지지대 기둥, 승강장.
 * 트랙이 바뀔 때마다 update() 로 통째로 다시 만든다(드래그 중에도 매 프레임 호출 가능한 비용).
 */

/** 레일 간격(m) */
export const GAUGE = 1.1;
const RAIL_RADIUS = 0.075;
const SPINE_RADIUS = 0.2;
/** 레일 중심선에서 스파인 중심까지 내려가는 거리 */
const SPINE_DROP = 0.5;
const TIE_SPACING = 1.25;
const SUPPORT_SPACING = 9;
const MAX_TIES = 6000;
const MAX_CHAIN = 6000;
const MAX_SUPPORTS = 900;

type HeightFn = (x: number, z: number) => number;

/** 트랙을 따라 원형 단면을 쓸어 튜브를 만든다. 여러 튜브를 한 지오메트리에 이어 붙일 수 있다. */
class TubeBuilder {
  private positions: Float32Array;
  private normals: Float32Array;
  private indices: Uint32Array;
  private v = 0;
  private i = 0;

  constructor(rings: number, tubes: { radial: number }[]) {
    let verts = 0;
    let tris = 0;
    for (const t of tubes) {
      verts += rings * t.radial;
      tris += rings * t.radial * 2;
    }
    this.positions = new Float32Array(verts * 3);
    this.normals = new Float32Array(verts * 3);
    this.indices = new Uint32Array(tris * 3);
  }

  add(track: Track, offRight: number, offUp: number, radius: number, radial: number): void {
    const n = track.count;
    const base = this.v;
    const { pos, up, right } = track;
    for (let k = 0; k < n; k++) {
      const o = k * 3;
      const cx = pos[o] + right[o] * offRight + up[o] * offUp;
      const cy = pos[o + 1] + right[o + 1] * offRight + up[o + 1] * offUp;
      const cz = pos[o + 2] + right[o + 2] * offRight + up[o + 2] * offUp;
      for (let m = 0; m < radial; m++) {
        const a = (m / radial) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const nx = right[o] * ca + up[o] * sa;
        const ny = right[o + 1] * ca + up[o + 1] * sa;
        const nz = right[o + 2] * ca + up[o + 2] * sa;
        const p = this.v * 3;
        this.positions[p] = cx + nx * radius;
        this.positions[p + 1] = cy + ny * radius;
        this.positions[p + 2] = cz + nz * radius;
        this.normals[p] = nx;
        this.normals[p + 1] = ny;
        this.normals[p + 2] = nz;
        this.v++;
      }
    }
    for (let k = 0; k < n; k++) {
      const r0 = base + k * radial;
      const r1 = base + ((k + 1) % n) * radial;
      for (let m = 0; m < radial; m++) {
        const m1 = (m + 1) % radial;
        const a = r0 + m;
        const b = r0 + m1;
        const c = r1 + m;
        const d = r1 + m1;
        // 바깥쪽이 앞면이 되도록 감는다
        this.indices[this.i++] = a;
        this.indices[this.i++] = c;
        this.indices[this.i++] = b;
        this.indices[this.i++] = b;
        this.indices[this.i++] = c;
        this.indices[this.i++] = d;
      }
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3));
    g.setIndex(new THREE.BufferAttribute(this.indices, 1));
    g.computeBoundingSphere();
    return g;
  }
}

export class TrackView {
  readonly group = new THREE.Group();

  private readonly rails: THREE.Mesh;
  private readonly spine: THREE.Mesh;
  private readonly ties: THREE.InstancedMesh;
  private readonly chainLinks: THREE.InstancedMesh;
  private readonly columns: THREE.InstancedMesh;
  private readonly footings: THREE.InstancedMesh;
  private readonly station = new THREE.Group();
  private readonly platformL: THREE.Mesh;
  private readonly platformR: THREE.Mesh;
  private readonly roof: THREE.Mesh;
  private readonly posts: THREE.Mesh[] = [];
  private readonly arrow: THREE.Mesh;

  private readonly m = new THREE.Matrix4();
  private readonly vx = new THREE.Vector3();
  private readonly vy = new THREE.Vector3();
  private readonly vz = new THREE.Vector3();
  private readonly vp = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly sc = new THREE.Vector3();

  constructor(private readonly heightAt: HeightFn) {
    const railMat = new THREE.MeshStandardMaterial({ color: 0xe9edf2, metalness: 0.55, roughness: 0.32 });
    const spineMat = new THREE.MeshStandardMaterial({ color: 0xe5412d, metalness: 0.2, roughness: 0.5 });
    this.rails = new THREE.Mesh(new THREE.BufferGeometry(), railMat);
    this.spine = new THREE.Mesh(new THREE.BufferGeometry(), spineMat);
    for (const mesh of [this.rails, this.spine]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }

    // 침목: 레일을 잇는 가로대 + 스파인으로 내려가는 V 자 받침
    const bar = new THREE.BoxGeometry(GAUGE + 0.12, 0.07, 0.13).translate(0, -0.05, 0);
    const strut = (sign: number) =>
      new THREE.BoxGeometry(0.09, 0.62, 0.11)
        .rotateZ(-sign * 0.83)
        .translate(sign * 0.275, -SPINE_DROP * 0.5, 0);
    const tieGeo = mergeGeometries([bar, strut(1), strut(-1)])!;
    this.ties = new THREE.InstancedMesh(
      tieGeo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.2, roughness: 0.55 }),
      MAX_TIES,
    );

    this.chainLinks = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.2, 0.06, 0.34).translate(0, -0.11, 0),
      new THREE.MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.7, roughness: 0.4 }),
      MAX_CHAIN,
    );

    this.columns = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1, 1, 1, 12).translate(0, 0.5, 0),
      new THREE.MeshStandardMaterial({ color: 0xf3f4f6, metalness: 0.15, roughness: 0.6 }),
      MAX_SUPPORTS,
    );
    this.footings = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1, 1.15, 1, 10).translate(0, 0.5, 0),
      new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.9 }),
      MAX_SUPPORTS,
    );
    for (const mesh of [this.ties, this.chainLinks, this.columns, this.footings]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.group.add(mesh);
    }

    // 승강장
    const concrete = new THREE.MeshStandardMaterial({ color: 0xcfd3d8, roughness: 0.85 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x2f6fd0, roughness: 0.6 });
    const unit = new THREE.BoxGeometry(1, 1, 1);
    this.platformL = new THREE.Mesh(unit, concrete);
    this.platformR = new THREE.Mesh(unit, concrete);
    this.roof = new THREE.Mesh(unit, roofMat);
    for (let i = 0; i < 4; i++) this.posts.push(new THREE.Mesh(unit, concrete));
    // 진행 방향 화살표
    this.arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.55, 1.5, 4).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x35d07f, emissive: 0x0d4d2c, roughness: 0.5 }),
    );
    for (const mesh of [this.platformL, this.platformR, this.roof, ...this.posts, this.arrow]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.station.add(mesh);
    }
    this.group.add(this.station);
  }

  update(track: Track): void {
    this.buildRails(track);
    this.buildTies(track);
    this.buildSupports(track);
    this.buildStation(track);
  }

  private buildRails(track: Track): void {
    const half = GAUGE / 2;
    const rails = new TubeBuilder(track.count, [{ radial: 6 }, { radial: 6 }]);
    rails.add(track, -half, 0, RAIL_RADIUS, 6);
    rails.add(track, half, 0, RAIL_RADIUS, 6);
    this.rails.geometry.dispose();
    this.rails.geometry = rails.build();

    const spine = new TubeBuilder(track.count, [{ radial: 8 }]);
    spine.add(track, 0, -SPINE_DROP, SPINE_RADIUS, 8);
    this.spine.geometry.dispose();
    this.spine.geometry = spine.build();
  }

  /** 샘플 k 의 프레임으로 인스턴스 행렬을 만든다 (x=오른쪽, y=위, z=진행 반대) */
  private frameMatrix(track: Track, k: number): THREE.Matrix4 {
    const o = k * 3;
    this.vx.set(track.right[o], track.right[o + 1], track.right[o + 2]);
    this.vy.set(track.up[o], track.up[o + 1], track.up[o + 2]);
    this.vz.set(-track.tan[o], -track.tan[o + 1], -track.tan[o + 2]);
    this.m.makeBasis(this.vx, this.vy, this.vz);
    this.m.setPosition(track.pos[o], track.pos[o + 1], track.pos[o + 2]);
    return this.m;
  }

  private buildTies(track: Track): void {
    const every = Math.max(1, Math.round(TIE_SPACING / track.step));
    const normal = new THREE.Color(0xe5412d);
    const lift = new THREE.Color(0xf2b632);
    let ties = 0;
    let links = 0;
    for (let k = 0; k < track.count; k++) {
      const onChain = track.chain[k] === 1;
      if (k % every === 0 && ties < MAX_TIES) {
        this.ties.setMatrixAt(ties, this.frameMatrix(track, k));
        this.ties.setColorAt(ties, onChain ? lift : normal);
        ties++;
      }
      if (onChain && links < MAX_CHAIN) {
        this.chainLinks.setMatrixAt(links++, this.frameMatrix(track, k));
      }
    }
    this.ties.count = ties;
    this.ties.instanceMatrix.needsUpdate = true;
    if (this.ties.instanceColor) this.ties.instanceColor.needsUpdate = true;
    this.chainLinks.count = links;
    this.chainLinks.instanceMatrix.needsUpdate = true;
  }

  private buildSupports(track: Track): void {
    const { pos, up, count, step } = track;
    const every = Math.max(1, Math.round(SUPPORT_SPACING / step));
    const checkStride = Math.max(1, Math.round(1 / step));
    const skipNear = Math.round(7 / step);
    let n = 0;

    for (let k0 = 0; k0 < count && n < MAX_SUPPORTS; k0 += every) {
      // 막히면 앞뒤로 조금 옮겨 본다
      for (const shift of [0, 2, -2, 4, -4]) {
        const k = (k0 + Math.round(shift / step) + count) % count;
        const o = k * 3;
        // 뒤집힌 구간은 기둥이 열차 공간을 지나가므로 세우지 않는다
        if (up[o + 1] < -0.15) continue;
        const tx = pos[o] - up[o] * SPINE_DROP;
        const ty = pos[o + 1] - up[o + 1] * SPINE_DROP;
        const tz = pos[o + 2] - up[o + 2] * SPINE_DROP;
        const ground = this.heightAt(tx, tz);
        const height = ty - ground;
        if (height < 0.9) break;

        // 기둥이 다른 레일을 뚫고 지나가는지 검사
        let blocked = false;
        for (let j = 0; j < count; j += checkStride) {
          let d = Math.abs(j - k);
          if (d > count / 2) d = count - d;
          if (d < skipNear) continue;
          const p = j * 3;
          const dx = pos[p] - tx;
          const dz = pos[p + 2] - tz;
          if (dx * dx + dz * dz < 1.5 * 1.5 && pos[p + 1] < ty - 0.4 && pos[p + 1] > ground - 1) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;

        const radius = Math.min(0.42, 0.15 + height * 0.007);
        this.vp.set(tx, ground - 0.3, tz);
        this.m.compose(this.vp, this.q.identity(), this.sc.set(radius, height + 0.3, radius));
        this.columns.setMatrixAt(n, this.m);
        this.m.compose(this.vp, this.q, this.sc.set(radius * 2.2, 0.65, radius * 2.2));
        this.footings.setMatrixAt(n, this.m);
        n++;
        break;
      }
    }
    this.columns.count = n;
    this.footings.count = n;
    this.columns.instanceMatrix.needsUpdate = true;
    this.footings.instanceMatrix.needsUpdate = true;
  }

  private buildStation(track: Track): void {
    // 출발점의 수평 방향에 맞춰 승강장을 놓는다
    const LENGTH = 13;
    const WIDTH = 2.6;
    const tx = track.tan[0];
    const tz = track.tan[2];
    const hl = Math.hypot(tx, tz);
    const visible = hl > 0.5 && track.up[1] > 0.7;
    this.station.visible = visible;
    if (!visible) return;
    const fx = tx / hl;
    const fz = tz / hl;
    const px = track.pos[0];
    const py = track.pos[1];
    const pz = track.pos[2];
    const cx = px + fx * 1.5;
    const cz = pz + fz * 1.5;
    this.station.position.set(cx, 0, cz);
    this.station.rotation.set(0, Math.atan2(-fx, -fz), 0); // 로컬 -Z 가 진행 방향
    const ground = Math.min(
      this.heightAt(cx, cz),
      this.heightAt(cx + fx * LENGTH * 0.5, cz + fz * LENGTH * 0.5),
      this.heightAt(cx - fx * LENGTH * 0.5, cz - fz * LENGTH * 0.5),
    );
    const top = py - 0.25;
    const body = Math.max(0.4, top - ground + 0.5);
    const side = GAUGE / 2 + 0.55 + WIDTH / 2;
    this.platformL.scale.set(WIDTH, body, LENGTH);
    this.platformL.position.set(-side, top - body / 2, 0);
    this.platformR.scale.set(WIDTH, body, LENGTH);
    this.platformR.position.set(side, top - body / 2, 0);
    const roofY = top + 3.7;
    this.roof.scale.set(side * 2 + WIDTH + 0.8, 0.28, LENGTH + 1.2);
    this.roof.position.set(0, roofY, 0);
    let i = 0;
    for (const sx of [-1, 1]) {
      for (const szn of [-1, 1]) {
        const post = this.posts[i++];
        post.scale.set(0.22, roofY - top, 0.22);
        post.position.set(sx * (side + WIDTH / 2 - 0.3), top + (roofY - top) / 2, szn * (LENGTH / 2 - 0.5));
      }
    }
    this.arrow.position.set(-side, top + 0.35, -LENGTH / 2 + 1.6);
  }

  dispose(): void {
    this.rails.geometry.dispose();
    this.spine.geometry.dispose();
  }
}
