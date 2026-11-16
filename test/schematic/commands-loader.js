const modules = {
  "../../utils/mcdata.js": `export const getBlockId = () => 1; export const getItemId = () => 1;`,
  "./queries.js": `export const queryList = [];`,
  "../library/skills.js": `export async function buildSchematic(...args) { globalThis.__buildSchematicArgs = args; return globalThis.__schematicBuild?.(...args); }`,
  "../settings.js": `export default {};`,
  "../conversation.js": `export default {};`,
};

export function resolve(specifier, context, nextResolve) {
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
        "../../utils/schematic/paths.js": `export async function listSchematicEntries() { return globalThis.__schematicListSchematicEntries?.() ?? (await globalThis.__schematicListSchematics()).map(filename => ({ pack: 'legacy', id: null, group: null, fileId: null, filename })); }`,
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
