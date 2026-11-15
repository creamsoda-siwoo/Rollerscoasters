import * as THREE from 'three';

/** 지평선 색. 안개 색과 같아야 지형 끝이 하늘에 자연스럽게 녹는다. */
export const HORIZON_COLOR = 0xcfe3f3;
const ZENITH_COLOR = 0x3f86d8;

/** 그라데이션 하늘 돔 + 태양 + 구름 */
export class Sky {
  readonly group = new THREE.Group();
  private readonly dome: THREE.Mesh;
  private readonly clouds = new THREE.Group();

  constructor(sunDirection: THREE.Vector3) {
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      uniforms: {
        zenith: { value: new THREE.Color(ZENITH_COLOR) },
        horizon: { value: new THREE.Color(HORIZON_COLOR) },
        sunDir: { value: sunDirection.clone().normalize() },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 zenith;
        uniform vec3 horizon;
        uniform vec3 sunDir;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = max(d.y, 0.0);
          vec3 col = mix(horizon, zenith, pow(h, 0.5));
          float s = max(dot(d, sunDir), 0.0);
          col += vec3(1.0, 0.92, 0.75) * (pow(s, 600.0) * 1.2 + pow(s, 24.0) * 0.16);
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }
      `,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(3500, 32, 16), material);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    this.group.add(this.dome);

    // 구름: 납작한 덩어리 몇 개를 뭉친 것
    const blob = new THREE.IcosahedronGeometry(1, 1);
    const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x9aa7b5, fog: false });
    let seed = 99;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 34; i++) {
      const cloud = new THREE.Group();
      const parts = 4 + Math.floor(rand() * 4);
      for (let j = 0; j < parts; j++) {
        const m = new THREE.Mesh(blob, cloudMat);
        const s = 22 + rand() * 30;
        m.scale.set(s * (1.2 + rand() * 0.8), s * 0.45, s);
        m.position.set((j - parts / 2) * 26 + rand() * 12, rand() * 8, rand() * 26 - 13);
        cloud.add(m);
      }
      const ang = rand() * Math.PI * 2;
      const r = 500 + rand() * 1900;
      cloud.position.set(Math.cos(ang) * r, 300 + rand() * 260, Math.sin(ang) * r);
      cloud.rotation.y = rand() * Math.PI;
      this.clouds.add(cloud);
    }
    this.group.add(this.clouds);
  }

  update(dt: number, cameraPosition: THREE.Vector3): void {
    this.dome.position.copy(cameraPosition);
    for (const c of this.clouds.children) {
      c.position.x += dt * 4;
      if (c.position.x > 2500) c.position.x = -2500;
    }
  }
}
