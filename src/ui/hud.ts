import { G_LIMITS } from '../physics/scoring';
import type { RideHud } from '../ride/ride';
import { $ } from './dom';
import { fixed } from './format';

/** 탑승 중 화면 표시: 속도, G, 시간, 높이, 진행률, 과도한 G 경고(붉은 가장자리) */
export class Hud {
  private readonly speed = $('hud-speed-value');
  private readonly g = $('hud-g-value');
  private readonly gLat = $('hud-glat');
  private readonly gBlock = $('hud-g');
  private readonly gFill = $('g-fill');
  private readonly time = $('hud-time');
  private readonly height = $('hud-height');
  private readonly chain = $('hud-chain');
  private readonly progress = $('progress-fill');
  private readonly vignette = $('vignette');
  private readonly camera = $('btn-camera');
  private last = { speed: '', g: '', lat: '', time: '', height: '' };

  update(h: RideHud): void {
    // 텍스트가 실제로 바뀔 때만 DOM 을 건드린다
    const speed = h.speed.toFixed(0);
    if (speed !== this.last.speed) this.speed.textContent = this.last.speed = speed;
    const g = fixed(h.gVert, 1);
    if (g !== this.last.g) this.g.textContent = this.last.g = g;
    const lat = fixed(Math.abs(h.gLat), 1);
    if (lat !== this.last.lat) this.gLat.textContent = this.last.lat = lat;
    const time = h.time.toFixed(1);
    if (time !== this.last.time) this.time.textContent = this.last.time = time;
    const height = Math.max(0, h.height).toFixed(0);
    if (height !== this.last.height) this.height.textContent = this.last.height = height;

    // G 막대: -2G ~ +6G 범위, 0G 가 25% 지점
    const pct = (v: number) => ((Math.min(6, Math.max(-2, v)) + 2) / 8) * 100;
    const a = pct(0);
    const b = pct(h.gVert);
    this.gFill.style.left = `${Math.min(a, b)}%`;
    this.gFill.style.width = `${Math.abs(b - a)}%`;
    const over = h.gVert > G_LIMITS.vertMax || h.gVert < G_LIMITS.vertMin || Math.abs(h.gLat) > G_LIMITS.lateral;
    const warn = !over && (h.gVert > G_LIMITS.vertMax - 1.5 || h.gVert < 0);
    this.gFill.style.background = over ? 'var(--bad)' : warn ? 'var(--accent-2)' : 'var(--ok)';
    this.gBlock.classList.toggle('over', over);
    this.gBlock.classList.toggle('warn', warn);

    this.chain.hidden = !h.onChain;
    this.progress.style.width = `${(h.progress * 100).toFixed(2)}%`;
    this.vignette.style.opacity = h.danger < 0.01 ? '0' : h.danger.toFixed(3);
    this.setCameraLabel(h.camera);
  }

  private cameraLabel = '';
  setCameraLabel(mode: RideHud['camera']): void {
    const label = mode === 'first' ? '시점: 1인칭' : '시점: 3인칭';
    if (label !== this.cameraLabel) this.camera.textContent = this.cameraLabel = label;
  }

  reset(): void {
    this.vignette.style.opacity = '0';
    this.progress.style.width = '0%';
  }
}
