import 'ses';

// This sets up the secure environment
// We disable some of the taming to allow for more flexibility

// For configuration, see https://github.com/endojs/endo/blob/master/packages/ses/docs/lockdown.md

let lockeddown = false;
export function lockdown() {
  if (lockeddown) return;
  globalThis.lockdown({
    // basic devex and quality of life improvements
    localeTaming: 'unsafe',
    consoleTaming: 'unsafe',
    errorTaming: 'unsafe',
    stackFiltering: 'verbose',
    // allow eval outside of created compartments
    // (mineflayer dep "protodef" uses eval)
    evalTaming: 'unsafeEval',
  });
  lockeddown = true;
}

export const makeCompartment = (endowments = {}) => {
  return new Compartment({
    // provide untamed Math, Date, etc
    Math,
    Date,
    // standard endowments
    ...endowments
  });
}