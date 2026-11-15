import * as THREE from 'three';
import { HORIZON_COLOR, Sky } from './sky';
import { Terrain } from './terrain';

/**
 * 렌더러·씬·조명·하늘·지형을 묶은 무대.
 * 설계 모드와 탑승 모드가 카메라 하나를 번갈아 쓴다.
 */
export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly terrain = new Terrain();
  readonly sunDirection = new THREE.Vector3(0.55, 0.72, 0.42).normalize();

  private readonly sun: THREE.DirectionalLight;
  private readonly sky: Sky;
  private readonly container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.2, 6000);
    this.camera.position.set(-150, 90, 190);

    this.scene.fog = new THREE.Fog(HORIZON_COLOR, 160, 1500);

    this.scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x6b7a4a, 1.15));
    this.sun = new THREE.DirectionalLight(0xfff2dc, 2.6);
    this.sun.castShadow = true;
    const mapSize = window.matchMedia('(pointer: coarse)').matches ? 2048 : 4096;
    this.sun.shadow.mapSize.set(mapSize, mapSize);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.06;
    this.scene.add(this.sun, this.sun.target);
    this.setShadowFocus(new THREE.Vector3(), 220);

    this.sky = new Sky(this.sunDirection);
    this.scene.add(this.sky.group);
    this.scene.add(this.terrain.group);

    this.resize();
    window.addEventListener('resize', () => this.resize());
    // 모바일 주소창 변화 등 레이아웃이 바뀔 때도 따라간다
    new ResizeObserver(() => this.resize()).observe(container);
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /**
   * 그림자가 드리울 영역을 지정한다. 넓은 맵 전체에 그림자맵을 펴면 흐릿해지므로
   * 보고 있는 곳 주변만 덮는다.
   */
  setShadowFocus(center: THREE.Vector3, radius: number): void {
    const cam = this.sun.shadow.camera;
    // 그림자 가장자리가 흔들리지 않게 텍셀 단위로 맞춘다
    const texel = (radius * 2) / this.sun.shadow.mapSize.x;
    const snap = texel * 8;
    const cx = Math.round(center.x / snap) * snap;
    const cy = Math.round(center.y / snap) * snap;
    const cz = Math.round(center.z / snap) * snap;
    this.sun.target.position.set(cx, cy, cz);
    this.sun.position.set(cx, cy, cz).addScaledVector(this.sunDirection, 500);
    if (cam.right !== radius) {
      cam.left = -radius;
      cam.right = radius;
      cam.top = radius;
      cam.bottom = -radius;
      cam.near = 10;
      cam.far = 1100;
      cam.updateProjectionMatrix();
    }
  }

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(dt: number): void {
    this.sky.update(dt, this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }
}
