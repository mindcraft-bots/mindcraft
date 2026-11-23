// Validate the Sponge v2 voxel stream before handing it to a permissive reader.
export function validateSpongeStructure(parsed, { compilerShape = false } = {}) {
  const tags = parsed?.value;
  const fail = message => { throw new Error(`Invalid Sponge v2 schematic: ${message}`); };
  const required = { Version: 'int', DataVersion: 'int', Width: 'short', Height: 'short', Length: 'short', PaletteMax: 'int', Palette: 'compound', BlockData: 'byteArray' };
  for (const [key, type] of Object.entries(required)) if (tags?.[key]?.type !== type) fail(`missing or incorrect ${key} tag`);
  if (tags.Version.value !== 2 || !Number.isInteger(tags.DataVersion.value) || tags.DataVersion.value <= 0) fail('invalid version');
  const dims = ['Width', 'Height', 'Length'].map(k => tags[k].value);
  if (dims.some(v => !Number.isInteger(v) || v <= 0)) fail('invalid dimensions');
  const volume = dims.reduce((a, b) => a * b, 1);
  if (!Number.isSafeInteger(volume)) fail('invalid volume');
  const entries = Object.entries(tags.Palette.value ?? {});
  if (!entries.length || tags.PaletteMax.value !== entries.length) fail('invalid palette size');
  const states = new Array(entries.length);
  for (const [state, tag] of entries) {
    const id = tag.value;
    if (tag.type !== 'int' || !Number.isInteger(id) || id < 0 || id >= entries.length || states[id] !== undefined) fail('invalid palette index');
    states[id] = state;
  }
  if (compilerShape) {
    if (tags.Offset?.type !== 'intArray' || JSON.stringify(Array.from(tags.Offset.value)) !== '[0,0,0]') fail('invalid compiler offset');
    for (const key of ['BlockEntities', 'Entities']) {
      const tag = tags[key];
      if (tag?.type !== 'list' || tag.value.type !== 'compound' || tag.value.value.length !== 0) fail(`invalid compiler ${key}`);
    }
  }
  const bytes = tags.BlockData.value;
  const indices = [];
  for (let cursor = 0; cursor < bytes.length;) {
    let value = 0, shift = 0, byte, count = 0;
    do {
      if (cursor >= bytes.length || count === 5) fail('truncated or oversized VarInt');
      byte = bytes[cursor++] & 255; count++;
      value += (byte & 127) * 2 ** shift; shift += 7;
    } while (byte & 128);
    if (value > 0x7fffffff || (count > 1 && (byte & 127) === 0) || value >= states.length) fail('noncanonical or out-of-range palette index');
    indices.push(value);
    if (indices.length > volume) fail('too many voxels');
  }
  if (indices.length !== volume) fail('voxel count does not match dimensions');
  return { dims, states, indices };
}
