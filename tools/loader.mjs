const THREE_STUB = new URL('./three-stub.js', import.meta.url).href;
const MIDI_STUB = new URL('./tonejs-midi-stub.js', import.meta.url).href;

const MAP = { three: THREE_STUB, '@tonejs/midi': MIDI_STUB };

export async function resolve(specifier, context, next) {
  if (MAP[specifier]) {
    return { url: MAP[specifier], shortCircuit: true, format: 'module' };
  }
  return next(specifier, context);
}