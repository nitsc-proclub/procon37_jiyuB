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
  private bus(pan: number, gain: number, context: BaseAudioContext = this.context, output: AudioNode = this.master) {
    const g = context.createGain(), p = context.createStereoPanner(); g.gain.value = gain; p.pan.value = pan; g.connect(p).connect(output);
    return { gain: g, disconnect: () => { g.disconnect(); p.disconnect(); } };
  }
  private drum(at: number, snare: boolean, pan: number, gain: number, context: BaseAudioContext = this.context, output: AudioNode = this.master, track = true) {
    const bus = this.bus(pan, gain, context, output), g = bus.gain; g.gain.setValueAtTime(gain, at); g.gain.exponentialRampToValueAtTime(.0001, at + .17);
    if (snare) {
      const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * .2), context.sampleRate);
      const channel = buffer.getChannelData(0); for (let i = 0; i < channel.length; i++) channel[i] = Math.random() * 2 - 1;
      const s = context.createBufferSource(), filter = context.createBiquadFilter(); s.buffer = buffer; filter.type = 'highpass'; filter.frequency.value = 1300; s.connect(filter).connect(g); s.start(at); s.onended = () => { s.disconnect(); filter.disconnect(); bus.disconnect(); }; if (track) this.sources.push(s);
    } else {
      const s = context.createOscillator(); s.frequency.setValueAtTime(135, at); s.frequency.exponentialRampToValueAtTime(45, at + .13); s.connect(g); s.start(at); s.stop(at + .19); s.onended = () => { s.disconnect(); bus.disconnect(); }; if (track) this.sources.push(s);
    }
  }
  async prepare(voices: Voice[]) {
    await this.enable();
    if (voices.some(v => !playableVersion(v.version))) throw new Error('この歌声は作り直してください');
    const buffers = await Promise.all(voices.map(v => this.load(v.version.audioUrl)));
    if (buffers.some(b => Math.abs(b.duration - SONG_SECONDS) > .15)) throw new Error('音声の長さが合奏と合いません。歌声を作り直してください');
  }
  async previewSource(version: Version): Promise<string> {
    if (version.role !== 'rhythm') return version.audioUrl;
    // A mixed WAV keeps native audio pause/seek and the original karaoke component in sync.
    const buffer = await this.load(version.audioUrl);
    const context = new OfflineAudioContext(2, Math.ceil(buffer.duration * buffer.sampleRate), buffer.sampleRate);
    const voice = context.createBufferSource(), gain = context.createGain(); voice.buffer = buffer; gain.gain.value = .68;
    voice.connect(gain).connect(context.destination); voice.start();
    for (let beat = 0; beat < 32; beat++) this.drum(LEAD_FRAMES / FPS + beat * 60 / BPM, beat % 2 === 1, 0, .19, context, context.destination, false);
    const mixed = await context.startRendering(), bytes = new ArrayBuffer(44 + mixed.length * 4), view = new DataView(bytes);
    const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true); view.setUint32(24, mixed.sampleRate, true); view.setUint32(28, mixed.sampleRate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, mixed.length * 4, true);
    const left = mixed.getChannelData(0), right = mixed.getChannelData(1);
    for (let i = 0; i < mixed.length; i++) for (let channel = 0; channel < 2; channel++) { const sample = Math.max(-1, Math.min(1, channel ? right[i] : left[i])); view.setInt16(44 + (i * 2 + channel) * 2, sample * (sample < 0 ? 32768 : 32767), true); }
    return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  }
  async play(voices: Voice[], rounds: number, volume: number, fullBand = true): Promise<boolean> {
    this.stop(); const serial = this.serial;
    await this.prepare(voices);
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
