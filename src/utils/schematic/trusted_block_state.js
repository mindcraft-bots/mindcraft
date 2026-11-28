import { createRequire } from "node:module";
import { types } from "node:util";

const require = createRequire(import.meta.url);
const minecraftData = require("minecraft-data");
const prismarineBlock = require("prismarine-block");

export function copyStateProperties(value) {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) throw new Error("Invalid block properties");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Invalid block properties");
  return Object.fromEntries(Reflect.ownKeys(value).map(key => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !field?.enumerable || !Object.hasOwn(field, "value")
        || !(typeof field.value === "string" || typeof field.value === "boolean"
          || (typeof field.value === "number" && Number.isSafeInteger(field.value)))) throw new Error("Invalid block properties");
    return [key, field.value];
  }));
}

export function sameStateProperties(left, right) {
  const keys = Object.keys(left).sort(), other = Object.keys(right).sort();
  return keys.length === other.length && keys.every((key, index) => key === other[index] && left[key] === right[key]);
}

function ownData(object, key, required = true) {
  const field = Object.getOwnPropertyDescriptor(object, key);
  if (!field) {
    if (required) throw new Error(`Missing block ${key}`);
    return undefined;
  }
  if (!Object.hasOwn(field, "value")) throw new Error(`Accessor block ${key}`);
  return field.value;
}

// Only data-only records and the known Prismarine getter shape are supported.
// The getter is never called; its source is an adapter-shape check, not a brand
// or an authorization. Every accepted value is checked against the registry.
export function createTrustedStateReader(bot) {
  const { version, registry } = bot ?? {};
  if (typeof version !== "string" || !/^\d+(?:\.\d+)+$/.test(version)) throw new Error("Unavailable state registry");
  const canonical = minecraftData(version);
  if (!canonical || canonical.version?.type !== "pc" || canonical.version.minecraftVersion !== version
      || !Number.isSafeInteger(canonical.version.dataVersion) || !canonical.supportFeature("blockStateId")
      || registry?.version?.type !== "pc" || registry.version.minecraftVersion !== version
      || registry.version.dataVersion !== canonical.version.dataVersion
      || registry.blocksByName !== canonical.blocksByName || registry.blocksByStateId !== canonical.blocksByStateId) {
    throw new Error("Unverifiable state registry");
  }
  const byName = canonical.blocksByName, byId = canonical.blocksByStateId, dataVersion = canonical.version.dataVersion;
  const decodingRegistry = Object.create(canonical);
  decodingRegistry.blockCollisionShapes = null;
  const Block = prismarineBlock(decodingRegistry);
  const getterSource = Function.prototype.toString.call(Block.prototype.getProperties);
  const decodedStates = new Map();

  function validate(name, stateId, properties) {
    if (bot.version !== version || bot.registry !== registry || registry.blocksByName !== byName || registry.blocksByStateId !== byId
        || canonical.blocksByName !== byName || canonical.blocksByStateId !== byId
        || registry.version?.type !== "pc" || registry.version.minecraftVersion !== version || registry.version.dataVersion !== dataVersion
        || canonical.version?.type !== "pc" || canonical.version.minecraftVersion !== version || canonical.version.dataVersion !== dataVersion)
      throw new Error("State registry changed");
    if (typeof name !== "string" || !/^[a-z0-9_]+$/.test(name) || !Number.isSafeInteger(stateId) || stateId < 0) throw new Error("Invalid state");
    const definition = byId[stateId];
    if (!definition || definition.name !== name || byName[name] !== definition || !Array.isArray(definition.states)
        || !Number.isSafeInteger(definition.minStateId) || !Number.isSafeInteger(definition.maxStateId)
        || stateId < definition.minStateId || stateId > definition.maxStateId) throw new Error("Unknown state");
    // Do not retain cached results across mutations of shared registry definitions.
    const signature = JSON.stringify([definition.id, definition.minStateId, definition.maxStateId, definition.states]);
    let cached = decodedStates.get(stateId);
    if (!cached || cached.definition !== definition || cached.signature !== signature) {
      const decoded = Block.fromStateId(stateId, 0);
      if (decoded.name !== name || decoded.stateId !== stateId) throw new Error("Unreadable registry state");
      const decodedProperties = copyStateProperties(decoded.getProperties());
      const fields = definition.states.map(state => state.name).sort();
      if (new Set(fields).size !== fields.length || JSON.stringify(fields) !== JSON.stringify(Object.keys(decodedProperties).sort())) throw new Error("Invalid registry state properties");
      cached = { definition, signature, properties: decodedProperties };
      decodedStates.set(stateId, cached);
    }
    const copied = copyStateProperties(properties);
    if (!sameStateProperties(copied, cached.properties)) throw new Error("Inconsistent state properties");
    return copied;
  }

  function read(block, snapshot = false) {
    if (!block || typeof block !== "object" || types.isProxy(block)) throw new Error("Unavailable block state");
    const name = ownData(block, "name"), stateId = ownData(block, "stateId");
    let properties;
    if (snapshot) properties = ownData(block, "properties");
    else {
      const prototype = Object.getPrototypeOf(block);
      if (prototype === Object.prototype || prototype === null) {
        if (Object.hasOwn(block, "getProperties")) throw new Error("Unsupported block adapter");
        properties = ownData(block, "properties");
      } else {
        if (types.isProxy(prototype) || Object.getPrototypeOf(prototype) !== Object.prototype || Object.hasOwn(block, "getProperties")) throw new Error("Unsupported block adapter");
        const getter = Object.getOwnPropertyDescriptor(prototype, "getProperties");
        if (!getter || typeof getter.value !== "function" || types.isProxy(getter.value)
            || Function.prototype.toString.call(getter.value) !== getterSource) throw new Error("Unsupported block adapter");
        const base = copyStateProperties(ownData(block, "_properties"));
        const computed = copyStateProperties(ownData(block, "computedStates"));
        properties = { ...base, ...computed };
      }
    }
    return { name, stateId, properties: validate(name, stateId, properties) };
  }
  return { read, validate };
}

export function hasObservedBlockEntity(block) {
  if (!block || typeof block !== "object" || types.isProxy(block)) throw new Error("Unavailable block entity data");
  const keys = ["entity", "blockEntity", "_blockEntity", "nbt"];
  let object = block, attached = false, depth = 0;
  while (object !== null) {
    if (types.isProxy(object) || ++depth > 32) throw new Error("Unverifiable block entity prototype");
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(object, key);
      if (!field) continue;
      if (object === block && Object.hasOwn(field, "value")) {
        if (field.value != null) attached = true;
        continue;
      }
      // The reviewed Prismarine accessor is a pure alias of `entity` when that
      // field is absent or null. Never invoke it: inspect every entity descriptor
      // throughout the chain instead. Source equality is not an instance brand.
      if (object !== block && key === "blockEntity" && !field.set
          && typeof field.get === "function" && !types.isProxy(field.get)
          && /^get\s+blockEntity\s*\(\s*\)\s*\{\s*return\s+this\.entity\s*\?\s*nbt\.simplify\(this\.entity\)\s*:\s*undefined\s*;?\s*\}$/.test(Function.prototype.toString.call(field.get))) continue;
      throw new Error("Unverifiable block entity descriptor");
    }
    object = Object.getPrototypeOf(object);
  }
  return attached;
}
