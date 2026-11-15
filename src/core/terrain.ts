import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Track } from '../track/spline';
import { terrainHeight } from './terrainHeight';

export { terrainHeight };

/** 제어점을 놓을 수 있는 범위(±m) */
export const BUILD_RADIUS = 200;

const TERRAIN_SIZE = 2400;
const TERRAIN_SEGMENTS = 200;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** 재현 가능한 난수 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGroundTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#e9e9e9';
  ctx.fillRect(0, 0, size, size);
  const rand = mulberry32(7);
  // 잔디 얼룩
  for (let i = 0; i < 2600; i++) {
    const v = 200 + Math.floor(rand() * 55);
    ctx.fillStyle = `rgba(${v},${v},${v},${0.25 + rand() * 0.4})`;
    const r = 1 + rand() * 3.5;
    ctx.fillRect(rand() * size, rand() * size, r, r);
  }
  // 10m 격자: 거리감과 속도감을 준다
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function makeTreeGeometry(): THREE.BufferGeometry {
  const paint = (geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const color = new THREE.Color(hex);
    const count = g.getAttribute('position').count;
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) color.toArray(arr, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    g.deleteAttribute('uv');
    return g;
  };
  const trunk = paint(new THREE.CylinderGeometry(0.22, 0.34, 2.4, 6).translate(0, 1.2, 0), 0x6b4a2f);
  const low = paint(new THREE.ConeGeometry(2.3, 4.6, 7).translate(0, 4.2, 0), 0x2f7d3b);
  const mid = paint(new THREE.ConeGeometry(1.8, 3.8, 7).translate(0, 6.2, 0), 0x378a43);
  const top = paint(new THREE.ConeGeometry(1.2, 3.0, 7).translate(0, 8.0, 0), 0x45994d);
  return mergeGeometries([trunk, low, mid, top])!;
}

interface TreeSlot {
  x: number;
  z: number;
  matrix: THREE.Matrix4;
  hidden: boolean;
}

export class Terrain {
  readonly group = new THREE.Group();
  readonly ground: THREE.Mesh;
  private readonly trees: THREE.InstancedMesh;
  /** 건설 구역 안쪽 나무. 레일과 겹치면 숨긴다. */
  private readonly innerTrees: (TreeSlot & { index: number })[] = [];
  private readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor() {
    // ── 지면 ──
    const geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const lush = new THREE.Color(0x7dbb55);
    const dry = new THREE.Color(0xa8b860);
    const high = new THREE.Color(0x6f9a5a);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = terrainHeight(x, z);
      pos.setY(i, h);
      uv.setXY(i, x / 10, z / 10);
      const patch = 0.5 + 0.5 * Math.sin(x * 0.021 + 1.7) * Math.cos(z * 0.017 - 0.4);
      c.copy(lush).lerp(dry, patch * 0.55).lerp(high, smoothstep(8, 45, h));
      c.toArray(colors, i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    this.ground = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ map: makeGroundTexture(), vertexColors: true, roughness: 0.95, metalness: 0 }),
    );
    this.ground.receiveShadow = true;
    this.group.add(this.ground);

    // ── 건설 구역 경계 ──
    const b = BUILD_RADIUS;
    const border: number[] = [];
    const corners = [
      [-b, -b],
      [b, -b],
      [b, b],
      [-b, b],
      [-b, -b],
    ];
    for (let e = 0; e < 4; e++) {
      for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        const x = corners[e][0] + (corners[e + 1][0] - corners[e][0]) * t;
        const z = corners[e][1] + (corners[e + 1][1] - corners[e][1]) * t;
        border.push(x, terrainHeight(x, z) + 0.25, z);
      }
    }
    const borderGeo = new THREE.BufferGeometry();
    borderGeo.setAttribute('position', new THREE.Float32BufferAttribute(border, 3));
    const borderLine = new THREE.Line(
      borderGeo,
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }),
    );
    this.group.add(borderLine);

    // ── 나무 ──
    const rand = mulberry32(20241);
    const slots: TreeSlot[] = [];
    const addTree = (x: number, z: number): TreeSlot => {
      const s = 0.8 + rand() * 0.9;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, terrainHeight(x, z) - 0.15, z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI * 2),
        new THREE.Vector3(s, s * (0.85 + rand() * 0.4), s),
      );
      const slot = { x, z, matrix: m, hidden: false };
      slots.push(slot);
      return slot;
    };
    // 안쪽: 드문드문
    for (let i = 0; i < 70; i++) {
      const x = (rand() * 2 - 1) * (BUILD_RADIUS - 6);
      const z = (rand() * 2 - 1) * (BUILD_RADIUS - 6);
      const slot = addTree(x, z);
      this.innerTrees.push({ ...slot, index: slots.length - 1 });
    }
    // 바깥: 숲
    for (let i = 0; i < 900; i++) {
      const ang = rand() * Math.PI * 2;
      const r = BUILD_RADIUS * 1.08 + Math.pow(rand(), 1.4) * 720;
      const x = Math.cos(ang) * r * 1.15;
      const z = Math.sin(ang) * r * 1.15;
      if (Math.abs(x) < BUILD_RADIUS + 8 && Math.abs(z) < BUILD_RADIUS + 8) continue;
      addTree(x, z);
    }
    this.trees = new THREE.InstancedMesh(
      makeTreeGeometry(),
      new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 }),
      slots.length,
    );
    const tint = new THREE.Color();
    slots.forEach((s, i) => {
      this.trees.setMatrixAt(i, s.matrix);
      const v = 0.82 + rand() * 0.3;
      this.trees.setColorAt(i, tint.setRGB(v, v * (0.95 + rand() * 0.1), v * 0.9));
    });
    this.trees.castShadow = true;
    this.trees.receiveShadow = true;
    this.trees.frustumCulled = false;
    this.group.add(this.trees);
  }

  heightAt(x: number, z: number): number {
    return terrainHeight(x, z);
  }

  /** 광선과 지면의 교점. 없으면 null. */
  raycast(ray: THREE.Ray, maxDistance = 2500, out = new THREE.Vector3()): THREE.Vector3 | null {
    const o = ray.origin;
    const d = ray.direction;
    let prevT = 0;
    let prevAbove = o.y - terrainHeight(o.x, o.z);
    if (prevAbove < 0) return null;
    for (let t = 2; t <= maxDistance; t += Math.max(2, t * 0.02)) {
      const x = o.x + d.x * t;
      const y = o.y + d.y * t;
      const z = o.z + d.z * t;
      const above = y - terrainHeight(x, z);
      if (above < 0) {
        // 이분법으로 좁힌다
        let a = prevT;
        let b = t;
        for (let i = 0; i < 24; i++) {
          const m = (a + b) / 2;
          const my = o.y + d.y * m - terrainHeight(o.x + d.x * m, o.z + d.z * m);
          if (my < 0) b = m;
          else a = m;
        }
        const m = (a + b) / 2;
        return out.set(o.x + d.x * m, o.y + d.y * m, o.z + d.z * m);
      }
      prevT = t;
      prevAbove = above;
    }
    return null;
  }

  /** 레일 가까이에 있는 안쪽 나무를 숨긴다 */
  clearTreesAlong(track: Track): void {
    const CLEAR = 12;
    const stride = Math.max(1, Math.round(3 / track.step));
    let changed = false;
    for (const tree of this.innerTrees) {
      let hide = false;
      for (let k = 0; k < track.count; k += stride) {
        const dx = track.pos[k * 3] - tree.x;
        const dz = track.pos[k * 3 + 2] - tree.z;
        if (dx * dx + dz * dz < CLEAR * CLEAR) {
          hide = true;
          break;
        }
      }
      if (hide !== tree.hidden) {
        tree.hidden = hide;
        this.trees.setMatrixAt(tree.index, hide ? this.zero : tree.matrix);
        changed = true;
      }
    }
    if (changed) this.trees.instanceMatrix.needsUpdate = true;
  }
}
