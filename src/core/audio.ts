/**
 * 절차적 사운드(외부 파일 없음).
 * - 바람: 백색 소음 → 밴드패스. 속도가 오를수록 크고 높아진다.
 * - 바퀴 굉음: 저역 소음. 속도에 비례.
 * - 체인 리프트: 일정 거리마다 "딸깍".
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private rumbleGain: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private muted = false;

  /** 사용자 입력(클릭/탭) 핸들러 안에서 호출해야 브라우저가 재생을 허용한다 */
  start(): void {
    if (!this.ctx) {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor();
      } catch {
        return;
      }
      const ctx = this.ctx;
      const length = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;

      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(ctx.destination);

      const source = ctx.createBufferSource();
      source.buffer = this.noise;
      source.loop = true;

      this.windFilter = ctx.createBiquadFilter();
      this.windFilter.type = 'bandpass';
      this.windFilter.frequency.value = 400;
      this.windFilter.Q.value = 0.6;
      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0;
      source.connect(this.windFilter).connect(this.windGain).connect(this.master);

      const low = ctx.createBiquadFilter();
      low.type = 'lowpass';
      low.frequency.value = 110;
      this.rumbleGain = ctx.createGain();
      this.rumbleGain.gain.value = 0;
      source.connect(low).connect(this.rumbleGain).connect(this.master);

      source.start();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** 속도(m/s)에 맞춰 바람·굉음을 조절한다 */
  setSpeed(speed: number): void {
    if (!this.ctx || !this.windGain || !this.windFilter || !this.rumbleGain) return;
    const now = this.ctx.currentTime;
    const k = Math.min(1, speed / 38);
    this.windGain.gain.setTargetAtTime(Math.pow(k, 1.6) * 0.55, now, 0.08);
    this.windFilter.frequency.setTargetAtTime(280 + k * 1500, now, 0.08);
    this.rumbleGain.gain.setTargetAtTime(Math.min(1, speed / 22) * 0.5, now, 0.08);
  }

  /** 체인 리프트의 딸깍 소리 */
  click(): void {
    if (!this.ctx || !this.master || !this.noise) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1700 + Math.random() * 500;
    filter.Q.value = 4;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.32, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(now, Math.random());
    src.stop(now + 0.08);
  }

  /** 탑승이 끝나면 지속음을 끈다 */
  silence(): void {
    if (!this.ctx || !this.windGain || !this.rumbleGain) return;
    const now = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(0, now, 0.15);
    this.rumbleGain.gain.setTargetAtTime(0, now, 0.15);
  }

  /** 탭이 가려졌을 때 오디오를 통째로 멈췄다가 되살린다 */
  setSuspended(suspended: boolean): void {
    if (!this.ctx) return;
    if (suspended && this.ctx.state === 'running') void this.ctx.suspend();
    else if (!suspended && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** 현재 상태(테스트·디버그용) */
  get debug(): { state: string; wind: number; rumble: number } | null {
    if (!this.ctx || !this.windGain || !this.rumbleGain) return null;
    return { state: this.ctx.state, wind: this.windGain.gain.value, rumble: this.rumbleGain.gain.value };
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.03);
  }

  get isMuted(): boolean {
    return this.muted;
  }
}
