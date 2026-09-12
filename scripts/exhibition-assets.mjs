import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('exhibition/assets', { recursive: true });
for (const [name, file] of [['acoustic_grand_piano', 'piano'], ['string_ensemble_1', 'strings']]) {
  const response = await fetch(`https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/${name}-mp3.js`);
  if (!response.ok) throw new Error(`Cannot download ${name}: ${response.status}`);
  const script = await response.text();
  const begin = script.indexOf('= {', script.indexOf(`MIDI.Soundfont.${name}`));
  const data = JSON.parse(script.slice(begin + 2, script.lastIndexOf('}') + 1).replace(/,\s*}$/, '}'));
  for (const note of ['C3', 'F3', 'C4', 'F4', 'C5', 'F5']) {
    const uri = data[note];
    if (!uri?.startsWith('data:audio/mp3;base64,')) throw new Error(`Missing ${note}`);
    await writeFile(`exhibition/assets/${file}-${note}.mp3`, Buffer.from(uri.split(',')[1], 'base64'));
  }
  console.log(`Saved ${file} samples`);
}
