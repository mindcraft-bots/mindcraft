import { gzipSync } from 'node:zlib';
import nbt from 'prismarine-nbt';
import minecraftData from 'minecraft-data';

export function syntheticSponge(version = '1.21.4', states = ['minecraft:stone']) {
  const tag = (type, value) => ({ type, value });
  const release = minecraftData.versions.pc.find(entry => entry.minecraftVersion === version);
  if (!release) throw new Error(`Unknown fixture version ${version}`);
  return gzipSync(nbt.writeUncompressed({ type: 'compound', name: 'Schematic', value: {
    Version: tag('int', 2), DataVersion: tag('int', release.dataVersion),
    Width: tag('short', states.length), Height: tag('short', 1), Length: tag('short', 1),
    PaletteMax: tag('int', states.length),
    Palette: tag('compound', Object.fromEntries(states.map((state, index) => [state, tag('int', index)]))),
    BlockData: tag('byteArray', states.map((_, index) => index)),
    Offset: tag('intArray', [0, 0, 0]),
    BlockEntities: tag('list', { type: 'compound', value: [] }),
    Entities: tag('list', { type: 'compound', value: [] }),
  } }));
}
