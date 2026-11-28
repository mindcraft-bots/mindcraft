import process from "node:process";

const modules = {
  "../../utils/mcdata.js": `export const getBlockId = () => 1; export const getItemId = () => 1; export const initBot = () => ({});`,
  "./queries.js": `export const queryList = [];`,
  "../library/skills.js": `export function setSchematicResumeSession(bot, session) { globalThis.__setSchematicSession?.(session); } export async function buildSchematic(...args) { globalThis.__buildSchematicArgs = args; return globalThis.__schematicBuild?.(...args); }`,
  "../settings.js": `const settings = globalThis.__testSettings ?? {}; export default settings;`,
  "../conversation.js": `export default {};`,
};

export function resolve(specifier, context, nextResolve) {
  if (process.env.MINDCRAFT_DESTRUCTIVE_INGRESS_FIXTURE === '1'
      && context.parentURL?.endsWith('/src/agent/coder.js')) {
    const stubs = { './library/skills.js': 'export const log = () => {};',
      './library/world.js': '', './library/lockdown.js': 'export const lockdown = () => {}; export const makeCompartment = () => ({});' };
    if (Object.hasOwn(stubs, specifier)) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  }
  if (process.env.MINDCRAFT_DESTRUCTIVE_INGRESS_FIXTURE === '1'
      && context.parentURL?.endsWith('/src/agent/agent.js')
      && specifier === '../utils/schematic/build_schematic.js') {
    const actual = new URL('../utils/schematic/build_schematic.js', context.parentURL).href;
    const module = `import { buildTrustedDestructiveSchematic as real, continueSchematic as realContinue } from ${JSON.stringify(actual)};
      export function buildTrustedDestructiveSchematic(bot, name, x, y, z, options) {
        globalThis.__ingressCalls.push({ name, x, y, z, options });
        return real(bot, name, x, y, z, { ...globalThis.__destructiveDependencies, ...options });
      }
      export async function continueSchematic(bot, name, x, y, z, options) {
        globalThis.__ingressCalls.push({ name, x, y, z, options, continuation: true });
        await globalThis.__beforeContinuation?.(realContinue, bot, name, x, y, z, options);
        return realContinue(bot, name, x, y, z, { ...globalThis.__destructiveDependencies, ...options });
      }`;
    return { url: `data:text/javascript,${encodeURIComponent(module)}`, shortCircuit: true };
  }
  if (specifier === '../../../settings.js' && context.parentURL?.endsWith('/src/agent/library/skills.js')) {
    return { url: 'data:text/javascript,export default %7B%7D', shortCircuit: true };
  }
  if (process.env.MINDCRAFT_SCHEMATIC_FIXTURE_ROOT && context.parentURL?.endsWith('/src/agent/schematic_request.js')
      && specifier === '../utils/schematic/paths.js') {
    const actual = new URL('../utils/schematic/paths.js', context.parentURL).href;
    const module = `import { resolveSchematicPath as real, conservativeBotVersion } from ${JSON.stringify(actual)};
      export { conservativeBotVersion };
      export const resolveSchematicPath = (name, directory, options) => real(name, directory ?? process.env.MINDCRAFT_SCHEMATIC_FIXTURE_ROOT, options);`;
    return { url: `data:text/javascript,${encodeURIComponent(module)}`, shortCircuit: true };
  }
  if (process.env.MINDCRAFT_DESTRUCTIVE_INGRESS_FIXTURE === '1'
      && context.parentURL?.endsWith('/src/utils/schematic/build_schematic.js') && specifier === './paths.js') {
    const actual = new URL('./paths.js', context.parentURL).href;
    const module = `import { resolveSchematicPath as real, conservativeBotVersion } from ${JSON.stringify(actual)};
      export { conservativeBotVersion };
      export const resolveSchematicPath = (name, directory, options) => real(name, directory ?? process.env.MINDCRAFT_SCHEMATIC_FIXTURE_ROOT, options);`;
    return { url: `data:text/javascript,${encodeURIComponent(module)}`, shortCircuit: true };
  }
  if (context.parentURL?.endsWith("/src/agent/agent.js")) {
    const agentModules = {
      "./history.js": `export class History {}`,
      "./coder.js": `export class Coder {}`,
      "./vision/vision_interpreter.js": `export class VisionInterpreter {}`,
      "../models/prompter.js": `export class Prompter {}`,
      "./modes.js": `export const initModes = () => {};`,
      "./action_manager.js": `export class ActionManager {}`,
      "./npc/controller.js": `export class NPCContoller {}`,
      "./memory_bank.js": `export class MemoryBank {}`,
      "./self_prompter.js": `export class SelfPrompter {}`,
      "../utils/translator.js": `export const handleTranslation = async value => value; export const handleEnglishTranslation = async value => value;`,
      "./vision/browser_viewer.js": `export const addBrowserViewer = () => {};`,
      "./mindserver_proxy.js": `export const serverProxy = { getNumOtherAgents: () => globalThis.__numOtherAgents ?? 0 }; export const sendOutputToServer = () => {};`,
      "./tasks/tasks.js": `export class Task {}`,
      "./speak.js": `export const speak = () => {};`,
      "./connection_handler.js": `export const log = () => {}; export const validateNameFormat = () => ({ success: true }); export const handleDisconnection = () => ({});`,
    };
    if (Object.hasOwn(agentModules, specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(agentModules[specifier])}`, shortCircuit: true };
    }
  }

  if (specifier === "./queries.js" && context.parentURL?.endsWith("/src/agent/commands/index.js")) {
    return nextResolve(specifier, context);
  }

  if (context.parentURL?.endsWith("/src/agent/commands/queries.js")) {
    if (specifier === "../../utils/schematic/paths.js" && process.env.MINDCRAFT_REAL_SCHEMATIC_PATHS === "1") {
      return nextResolve(specifier, context);
    }
    const queryModules = {
      "../library/world.js": ``,
      "../tasks/construction_tasks.js": `export const checkLevelBlueprint = () => ''; export const checkBlueprint = () => '';`,
        "../../utils/schematic/paths.js": `export const conservativeBotVersion = bot => bot?.version; export async function listSchematicEntries() { return globalThis.__schematicListSchematicEntries?.() ?? (await globalThis.__schematicListSchematics()).map(filename => ({ pack: 'legacy', group: null, id: null, filename })); }`,
      "cheerio": `export const load = () => {};`,
    };
    if (Object.hasOwn(queryModules, specifier)) {
      return {
        url: `data:text/javascript,${encodeURIComponent(queryModules[specifier])}`,
        shortCircuit: true,
      };
    }
  }

  if (modules[specifier]) {
    return {
      url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
