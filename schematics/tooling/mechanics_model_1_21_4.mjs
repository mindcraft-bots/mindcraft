// Vanilla 1.21.4 snapshot model, independent of pack discovery.
import minecraftData from 'minecraft-data';

const registry = minecraftData('1.21.4');
const directions = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
const order = ['north', 'east', 'south', 'west'];
const opposite = d => order[(order.indexOf(d) + 2) % 4];
const left = d => order[(order.indexOf(d) + 3) % 4];
const woolCarpets = new Set('white orange magenta light_blue yellow lime pink gray light_gray cyan purple blue brown green red black'.split(' ').map(c => `${c}_carpet`));
const air = new Set(['air', 'cave_air', 'void_air']);

// Require a complete, registered vanilla state; unknown data must not become air or a non-stair.
function parseState(text) {
  if (typeof text !== 'string') return null;
  const m = /^minecraft:([a-z0-9_]+)(?:\[([^\]]+)\])?$/.exec(text);
  if (!m) return null;
  const block = registry.blocksByName[m[1]];
  if (!block || block.name !== m[1]) return null;
  const props = Object.create(null);
  if (m[2]) for (const part of m[2].split(',')) {
    const p = /^([a-z0-9_]+)=([a-z0-9_]+)$/.exec(part);
    if (!p || Object.hasOwn(props, p[1])) return null;
    props[p[1]] = p[2];
  }
  if (Object.keys(props).length !== block.states.length) return null;
  for (const def of block.states) {
    const value = props[def.name];
    const valid = def.type === 'bool' ? ['true', 'false'] : (def.type === 'enum' || def.type === 'int') ? (def.values ?? []) : [];
    if (!valid.includes(value)) return null;
  }
  return { name: m[1], props, stair: m[1].endsWith('_stairs'), carpet: woolCarpets.has(m[1]) };
}

function schemaError(d) {
  if (!d || (d.schema !== undefined && !['explicit-layer-matrix-v1', 'explicit_layers_v1'].includes(d.schema))) return 'unsupported schema';
  if (d.minecraft_version !== '1.21.4' || d.data_version !== 4189) return 'unsupported Minecraft version or data version';
  const {width_x: w, height_y: h, length_z: l, layers, legend} = d;
  if (![w,h,l].every(n => Number.isSafeInteger(n) && n > 0) || !legend || typeof legend !== 'object' || Array.isArray(legend) || !Array.isArray(layers) || layers.length !== h) return 'incomplete dimensions, legend or layers';
  for (const layer of layers) {
    if (!Array.isArray(layer) || layer.length !== l) return 'incomplete layer';
    for (const row of layer) {
      if (typeof row !== 'string' || [...row].length !== w || [...row].some(c => !Object.hasOwn(legend, c) || typeof legend[c] !== 'string')) return 'incomplete row or legend';
    }
  }
  return null;
}

export function diagnoseBlueprint(d) {
  const error = schemaError(d);
  if (error) return {status: 'skipped', reason: error};
  const parsed = new Map(Object.entries(d.legend).map(([key, state]) => [key, parseState(state)]));
  const cell = (x,y,z,role) => {
    const position = [x,y,z];
    if (x < 0 || x >= d.width_x || y < 0 || y >= d.height_y || z < 0 || z >= d.length_z) return {role, position, state: null, classification: 'outside_volume_unknown'};
    const symbol = [...d.layers[y][z]][x], state = d.legend[symbol], block = parsed.get(symbol);
    return {role, position, state, classification: block ? 'known' : 'unrecognized_or_incomplete_state', block};
  };
  const neighbor = (x,y,z,dir,role) => { const [dx,dz] = directions[dir]; return cell(x+dx,y,z+dz,role); };
  const evidence = c => ({role:c.role, position:c.position, state:c.state, classification:c.classification});
  const stairs = {examined:0, matching:0, mismatches:[], unknown:[]};
  const carpets = {examined:0, below_air:0, below_non_air:0, unknown:0, cells:[]};
  const unmodeled = [];
  for (let y=0; y<d.height_y; y++) for (let z=0; z<d.length_z; z++) for (let x=0; x<d.width_x; x++) {
    const current = cell(x,y,z,'declared'), block = current.block;
    if (!block) {
      unmodeled.push({position:current.position, state:current.state, reason:current.classification});
      continue;
    }
    if (block.stair) {
      stairs.examined++;
      const f = block.props.facing, half = block.props.half, inspected = [];
      let derived = 'straight', uncertain = false;
      // Vanilla checks the front first; only a qualifying, unblocked front wins.
      for (const [role, dir, kind] of [['front',f,'outer'], ['back',opposite(f),'inner']]) {
        const n = neighbor(x,y,z,dir,role); inspected.push(evidence(n));
        if (!n.block) { uncertain = true; break; }
        if (!n.block.stair || n.block.props.half !== half || (['north','south'].includes(f) === ['north','south'].includes(n.block.props.facing))) continue;
        const nf = n.block.props.facing;
        const side = neighbor(x,y,z,kind === 'outer' ? opposite(nf) : nf, `${role}_side_blocker`); inspected.push(evidence(side));
        if (!side.block) { uncertain = true; break; }
        if (side.block.stair && side.block.props.facing === f && side.block.props.half === half) continue;
        derived = `${kind}_${nf === left(f) ? 'left' : 'right'}`;
        break;
      }
      const record = {position:current.position, declared:current.state, declared_shape:block.props.shape, derived:uncertain ? null : current.state.replace(/(?<=\bshape=)[a-z_]+/, derived), derived_shape:uncertain ? null : derived, evidence:inspected};
      if (uncertain) stairs.unknown.push(record);
      else if (derived !== block.props.shape) stairs.mismatches.push(record);
      else stairs.matching++;
    }
    if (block.carpet) {
      carpets.examined++;
      const below = cell(x,y-1,z,'below'), result = !below.block ? 'unknown' : air.has(below.block.name) ? 'below_air' : 'below_non_air';
      carpets[result]++;
      carpets.cells.push({position:current.position, declared:current.state, derived_survival:result === 'unknown' ? null : result === 'below_non_air', result, evidence:[evidence(below)]});
    }
  }
  return {status:'modeled', stairs, carpets, unmodeled};
}

