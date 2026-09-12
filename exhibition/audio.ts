import { BPM, CHORDS, LEAD_FRAMES, FPS, SONG_SECONDS, ROLE_IDS, ROLES, type Version, type RoleId } from './shared';
import { melodyKey } from './music';

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
  private sample(instrument: 'piano' | 'strings', key: number, at: number, length: number, pan: number, gain: number) {
    const refs = [48, 53, 60, 65, 72, 77]; const names = ['C3', 'F3', 'C4', 'F4', 'C5', 'F5'];
    const index = refs.reduce((best, n, i) => Math.abs(n - key) < Math.abs(refs[best] - key) ? i : best, 0);
    const buffer = this.buffers.get(`/samples/${instrument}-${names[index]}.mp3`)!;
    const source = this.context.createBufferSource(); source.buffer = buffer; source.playbackRate.value = 2 ** ((key - refs[index]) / 12);
    const bus = this.bus(pan, 0), g = bus.gain; g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(gain, at + (instrument === 'strings' ? .07 : .008)); g.gain.setValueAtTime(gain * .75, at + Math.max(.08, length - .08)); g.gain.linearRampToValueAtTime(0, at + length + .1);
    source.connect(g); source.start(at); source.stop(at + length + .15); source.onended = () => { source.disconnect(); bus.disconnect(); }; this.sources.push(source);
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
    await Promise.all([...voices.map(v => this.load(v.version.audioUrl)), ...['piano', 'strings'].flatMap(i => ['C3','F3','C4','F4','C5','F5'].map(n => this.load(`/samples/${i}-${n}.mp3`)))]);
    if (serial !== this.serial) return false;
    const beat = 60 / BPM, lead = LEAD_FRAMES / FPS;
    this.startedAt = this.context.currentTime + .12; this.duration = SONG_SECONDS * rounds; this.active = true; this.setVolume(volume);
    const roles: RoleId[] = fullBand ? [...ROLE_IDS] : voices.map(v => v.version.role);
    const pan = (role: RoleId) => voices.find(v => v.version.role === role)?.pan ?? ROLES[role].pan;
    for (let round = 0; round < rounds; round++) {
      const origin = this.startedAt + round * SONG_SECONDS;
      for (const { version, pan } of voices) {
        const source = this.context.createBufferSource(); const buffer = this.buffers.get(version.audioUrl)!;
        if (Math.abs(buffer.duration - SONG_SECONDS) > .15) { this.stop(); throw new Error('音声の長さが合奏と合いません。歌声を作り直してください'); }
        const bus = this.bus(pan, voices.length > 3 ? .55 : .68);
        source.buffer = buffer; source.connect(bus.gain); source.start(origin); source.stop(origin + SONG_SECONDS); source.onended = () => { source.disconnect(); bus.disconnect(); }; this.sources.push(source);
      }
      if (roles.includes('rhythm')) for (let b = 0; b < 32; b++) this.drum(origin + lead + b * beat, b % 2 === 1, pan('rhythm'), .19);
      for (let line = 0; line < 4; line++) {
        let unit = 0;
        for (const chord of CHORDS[line]) {
          (['root', 'third', 'fifth'] as RoleId[]).forEach((role, i) => { if (roles.includes(role)) this.sample('strings', chord.keys[i] + 12, origin + lead + (line * 8 + unit / 4) * beat, chord.units / 4 * beat - .1, pan(role), .085); });
          unit += chord.units;
        }
        for (const role of ['melody', 'octave'] as RoleId[]) if (roles.includes(role)) for (let cell = 0; cell < 4; cell++) this.sample('piano', melodyKey(line, cell, voices[0]?.version.arrangement.melodySeed ?? 7132026) + (role === 'octave' ? 12 : 0), origin + lead + (line * 8 + cell * 2) * beat, beat * 1.85, pan(role), role === 'octave' ? .06 : .16);
      }
    }
    return true;
  }
  stop() {
    this.serial++; this.active = false;
    const at = this.context.currentTime;
    this.master.gain.cancelScheduledValues(at); this.master.gain.setTargetAtTime(0, at, .008);
    for (const s of this.sources) { try { s.stop(at + .025); } catch { /* Already ended. */ } }
    this.sources = [];
    // Bound decoded buffers across a full exhibition day; keep instrument samples.
    if (this.buffers.size > 32) for (const key of this.buffers.keys()) if (!key.startsWith('/samples/')) this.buffers.delete(key);
  }
  dispose() { this.stop(); void this.context.close(); }
}
