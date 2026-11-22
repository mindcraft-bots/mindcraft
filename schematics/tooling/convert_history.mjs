#!/usr/bin/env node
/** Validate authored history and convert a source palette against real registries. */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseState } from "./validate_registry.mjs";

const minecraftData = createRequire(import.meta.url)("minecraft-data");
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const check = (condition, message) => { if (!condition) throw new Error(message); };
const identifier = /^minecraft:[a-z0-9_./-]+$/;
const property = /^[a-z0-9_]+$/;
const own = (o, k) => Object.hasOwn(o, k);

export function release(version) {
  check(typeof version === "string" && /^\d+(?:\.\d+)+$/.test(version), `invalid release ${version}`);
  const meta = minecraftData.versions.pc.find((v) => v.minecraftVersion === version);
  check(meta && Number.isInteger(meta.dataVersion) && meta.dataVersion > 0, `minecraft-data release metadata ${version} unavailable`);
  const registry = minecraftData(version);
  check(registry?.blocksByName && registry?.itemsByName && registry.version?.dataVersion === meta.dataVersion,
    `minecraft-data registry ${version} unavailable or DataVersion mismatch`);
  return { meta, registry };
}

function boundary(value) {
  check(object(value) && Object.keys(value).sort().join(",") === "dataVersion,release", "invalid history release boundary");
  const { meta } = release(value.release);
  check(value.dataVersion === meta.dataVersion, `history release ${value.release} DataVersion mismatch`);
  return value.dataVersion;
}

export function validateHistory(history) {
  check(object(history) && Object.keys(history).sort().join(",") === "alternatives,blocks,schemaVersion" && history.schemaVersion === 1 && object(history.blocks) && Array.isArray(history.alternatives), "invalid history schema");
  for (const [name, entry] of Object.entries(history.blocks)) {
    check(identifier.test(name) && object(entry) && Object.keys(entry).join(",") === "introduced", `invalid history block ${name}`);
    boundary(entry.introduced);
    const { registry } = release(entry.introduced.release);
    check(own(registry.blocksByName, name.slice(10)), `history introduction ${name} absent from ${entry.introduced.release}`);
  }
  const bounds = new Set([1]);
  for (const edge of history.alternatives) {
    check(object(edge) && Object.keys(edge).sort().join(",") === "from,properties,target,to" && own(history.blocks, edge.from) && own(history.blocks, edge.to) && edge.from !== edge.to, "invalid history alternative");
    check(object(edge.target) && own(edge.target, "min") && Object.keys(edge.target).every((k) => k === "min" || k === "max"), "invalid history target range");
    const min = boundary(edge.target.min), max = edge.target.max ? boundary(edge.target.max) : Infinity;
    check(min <= max && min >= history.blocks[edge.to].introduced.dataVersion, "invalid history target bounds");
    for (const bound of [edge.target.min, edge.target.max].filter(Boolean)) {
      check(own(release(bound.release).registry.blocksByName, edge.to.slice(10)), `history alternative ${edge.to} absent from ${bound.release}`);
    }
    bounds.add(min); if (Number.isFinite(max)) bounds.add(max + 1);
    const p = edge.properties;
    check(object(p) && Object.keys(p).sort().join(",") === "rename,values" && object(p.rename) && object(p.values), "invalid history property rules");
    for (const [key, value] of Object.entries(p.rename)) check(property.test(key) && typeof value === "string" && property.test(value), "invalid property rename");
    for (const [key, values] of Object.entries(p.values)) {
      check(property.test(key) && object(values) && Object.keys(values).length > 0, "invalid property values rule");
      for (const [from, to] of Object.entries(values)) check(property.test(from) && typeof to === "string" && property.test(to), "invalid property value mapping");
    }
  }
  // Reciprocal alternatives are safe only when their target intervals cannot cycle.
  for (const dv of bounds) {
    const visiting = new Set(), done = new Set();
    const visit = (name) => {
      check(!visiting.has(name), `history cycle for target DataVersion ${dv}: ${name}`);
      if (done.has(name)) return;
      visiting.add(name);
      for (const edge of history.alternatives.filter((e) => e.from === name && applies(e, dv))) visit(edge.to);
      visiting.delete(name); done.add(name);
    };
    for (const name of Object.keys(history.blocks)) visit(name);
  }
  return history;
}

function applies(edge, dv) {
  return dv >= edge.target.min.dataVersion && (!edge.target.max || dv <= edge.target.max.dataVersion);
}

function transform(state, edge) {
  const match = /^([^\[]+)(?:\[(.*)\])?$/.exec(state);
  const props = new Map();
  for (const entry of match[2] ? match[2].split(",") : []) {
    let [key, value] = entry.split("=");
    if (own(edge.properties.values, key)) {
      check(own(edge.properties.values[key], value), `missing explicit value mapping for ${key}=${value}`);
      value = edge.properties.values[key][value];
    }
    key = edge.properties.rename[key] ?? key;
    check(!props.has(key), `property transformation collision: ${key}`);
    props.set(key, value);
  }
  return edge.to + (props.size ? `[${[...props].map(([k, v]) => `${k}=${v}`).join(",")}]` : "");
}

export function convertBlueprint(blueprint, targetVersion, history) {
  validateHistory(history);
  const source = release(blueprint.minecraft_version), target = release(targetVersion);
  check(Number.isInteger(blueprint.data_version) && blueprint.data_version === source.meta.dataVersion,
    `blueprint data_version ${blueprint.data_version} does not match minecraft-data ${blueprint.minecraft_version} DataVersion ${source.meta.dataVersion}`);
  check(object(blueprint.legend), "blueprint legend must be an object");
  const legend = {}, changes = [];
  for (const [character, state] of Object.entries(blueprint.legend)) {
    check([...character].length === 1 && typeof state === "string", "invalid legend entry");
    parseState(state, blueprint.minecraft_version, source.registry);
    const originalName = state.split("[")[0], sourceName = originalName.slice(10);
    if (own(history.blocks, originalName)) check(source.meta.dataVersion >= history.blocks[originalName].introduced.dataVersion, `source predates introduction of ${originalName}`);
    let queue = [{ state, path: [] }], result;
    while (queue.length) {
      const candidate = queue.shift(), name = candidate.state.split("[")[0];
      if (own(target.registry.blocksByName, name.slice(10))) {
        if (own(history.blocks, name)) check(target.meta.dataVersion >= history.blocks[name].introduced.dataVersion, `target predates introduction of ${name}`);
        // Existing names are not grounds to silently alter invalid properties.
        parseState(candidate.state, targetVersion, target.registry);
        if (candidate.path.length || own(source.registry.itemsByName, sourceName)) {
          check(own(target.registry.itemsByName, name.slice(10)), `target item missing for ${candidate.state}`);
        }
        result = candidate; break;
      }
      for (const edge of history.alternatives.filter((e) => e.from === name && applies(e, target.meta.dataVersion))) {
        queue.push({ state: transform(candidate.state, edge), path: [...candidate.path, edge.to] });
      }
    }
    check(result, `no authored fallback for ${state} in Minecraft ${targetVersion}`);
    legend[character] = result.state;
    if (result.path.length) changes.push({ from: state, to: result.state, via: result.path });
  }
  return { legend, sourceVersion: blueprint.minecraft_version, sourceDataVersion: source.meta.dataVersion,
    targetVersion, targetDataVersion: target.meta.dataVersion, changes };
}

async function main() {
  const [blueprintPath, targetVersion] = process.argv.slice(2);
  check(blueprintPath && targetVersion && process.argv.length === 4, "usage: convert_history.mjs <blueprint.json> <target-version>");
  const blueprint = JSON.parse(await readFile(blueprintPath, "utf8"));
  const history = JSON.parse(await readFile(new URL("./block_history.v1.json", import.meta.url), "utf8"));
  console.log(JSON.stringify(convertBlueprint(blueprint, targetVersion, history)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`HISTORY CONVERSION FAILED: ${error.message}`); process.exitCode = 1; });
}
