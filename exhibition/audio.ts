import { BPM, LEAD_FRAMES, FPS, SONG_SECONDS, ROLES, playableVersion, type Version, type RoleId } from './shared';

type Voice = { version: Version; pan: number };
export class EnsembleAudio {
  readonly context = new AudioContext();
  private master = this.context.createGain();
  private buffers = new Map<string, AudioBuffer>();
  private sources: AudioScheduledSourceNode[] = [];
  private serial = 0;
  startedAt = 0;
  duration = 0;
  active = false;
  constructor() {
    const limiter = this.context.createDynamicsCompressor();
    limiter.threshold.value = -10; limiter.knee.value = 12; limiter.ratio.value = 6; limiter.attack.value = .004; limiter.release.value = .15;
    this.master.connect(limiter).connect(this.context.destination);
  }
  async enable() { await this.context.resume(); if (this.context.state !== 'running') throw new Error('もう一度「音を有効にする」を押してください'); }
  get elapsed() { return this.active ? Math.max(0, this.context.currentTime - this.startedAt) : 0; }
  setVolume(value: number) { this.master.gain.setTargetAtTime(value, this.context.currentTime, .03); }
  private async load(url: string) {
    const hit = this.buffers.get(url); if (hit) return hit;
    const response = await fetch(url); if (!response.ok) throw new Error('音声の読み込みに失敗しました');
    const buffer = await this.context.decodeAudioData(await response.arrayBuffer()); this.buffers.set(url, buffer); return buffer;
  }
  private bus(pan: number, gain: number) {
    const g = this.context.createGain(), p = this.context.createStereoPanner(); g.gain.value = gain; p.pan.value = pan; g.connect(p).connect(this.master);
    return { gain: g, disconnect: () => { g.disconnect(); p.disconnect(); } };
  }
  private drum(at: number, snare: boolean, pan: number, gain: number) {
    const bus = this.bus(pan, gain), g = bus.gain; g.gain.setValueAtTime(gain, at); g.gain.exponentialRampToValueAtTime(.0001, at + .17);
    if (snare) {
      const buffer = this.context.createBuffer(1, Math.ceil(this.context.sampleRate * .2), this.context.sampleRate);
      const channel = buffer.getChannelData(0); for (let i = 0; i < channel.length; i++) channel[i] = Math.random() * 2 - 1;
      const s = this.context.createBufferSource(), filter = this.context.createBiquadFilter(); s.buffer = buffer; filter.type = 'highpass'; filter.frequency.value = 1300; s.connect(filter).connect(g); s.start(at); s.onended = () => { s.disconnect(); filter.disconnect(); bus.disconnect(); }; this.sources.push(s);
    } else {
      const s = this.context.createOscillator(); s.frequency.setValueAtTime(135, at); s.frequency.exponentialRampToValueAtTime(45, at + .13); s.connect(g); s.start(at); s.stop(at + .19); s.onended = () => { s.disconnect(); bus.disconnect(); }; this.sources.push(s);
    }
  }
  async play(voices: Voice[], rounds: number, volume: number, fullBand = true): Promise<boolean> {
    this.stop(); const serial = this.serial;
    await this.enable();
    if (voices.some(v => !playableVersion(v.version))) throw new Error('この歌声は作り直してください');
    await Promise.all(voices.map(v => this.load(v.version.audioUrl)));
    if (serial !== this.serial) return false;
    const beat = 60 / BPM, lead = LEAD_FRAMES / FPS;
    this.startedAt = this.context.currentTime + .12; this.duration = SONG_SECONDS * rounds; this.active = true; this.setVolume(volume);
    const rhythm = fullBand || voices.some(v => v.version.role === 'rhythm');
    const pan = (role: RoleId) => voices.find(v => v.version.role === role)?.pan ?? ROLES[role].pan;
    for (let round = 0; round < rounds; round++) {
      const origin = this.startedAt + round * SONG_SECONDS;
      for (const { version, pan } of voices) {
        const source = this.context.createBufferSource(); const buffer = this.buffers.get(version.audioUrl)!;
        if (Math.abs(buffer.duration - SONG_SECONDS) > .15) { this.stop(); throw new Error('音声の長さが合奏と合いません。歌声を作り直してください'); }
        const bus = this.bus(pan, voices.length > 3 ? .55 : .68);
        source.buffer = buffer; source.connect(bus.gain); source.start(origin); source.stop(origin + SONG_SECONDS); source.onended = () => { source.disconnect(); bus.disconnect(); }; this.sources.push(source);
      }
      if (rhythm) for (let b = 0; b < 32; b++) this.drum(origin + lead + b * beat, b % 2 === 1, pan('rhythm'), .19);
    }
    return true;
  }
  stop() {
    this.serial++; this.active = false;
    const at = this.context.currentTime;
    this.master.gain.cancelScheduledValues(at); this.master.gain.setTargetAtTime(0, at, .008);
    for (const s of this.sources) { try { s.stop(at + .025); } catch { /* Already ended. */ } }
    this.sources = [];
    // Bound decoded voice buffers across a full exhibition day.
    if (this.buffers.size > 32) this.buffers.clear();
  }
  dispose() { this.stop(); void this.context.close(); }
}
