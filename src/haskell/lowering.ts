import type { Extensions } from './extensions';
import type { FeatureGates } from './features';
import { lowerImplicitParams } from './implicitBindings';
import { lowerOverloadedLiterals } from './overloadedLiterals';
import { bangStrictPatterns, lowerStrictBindings } from './strictLowering';
import type { ConDecl, Decl } from './syntax';

interface Lowering {
  applies(features: FeatureGates<'convert'>): boolean;
  lower(decls: Decl[], features: FeatureGates<'convert'>): Decl[];
}

/**
 * The passes that lower what extensions add to the syntax conversion gives, in order: the strict patterns come from
 * the source's patterns before the implicit-parameter lowering adds patterns of its own, and the literals are
 * overloaded before it adds lists of its own.
 */
const LOWERINGS: readonly Lowering[] = [
  { applies: (features) => features.allows('strict'), lower: bangStrictPatterns },
  {
    applies: (features) => features.allows('overloadedStrings') || features.allows('overloadedLists'),
    lower: (decls, features) => lowerOverloadedLiterals(features, decls),
  },
  { applies: (features) => features.allows('implicitParams'), lower: lowerImplicitParams },
  { applies: () => true, lower: (decls, features) => decls.map((decl) => withStrictFields(features, decl)) },
  { applies: () => true, lower: (decls, features) => lowerStrictBindings(features, decls) },
];

/**
 * Lowers declarations a module's source or its splices give, once each, with the module's extensions. Quotes keep the
 * syntax they quote, which their trees hold.
 */
export function lowerDeclarations(extensions: Extensions, decls: Decl[]): Decl[] {
  const features = extensions.gates('convert');
  let lowered = decls;
  for (const lowering of LOWERINGS) if (lowering.applies(features)) lowered = lowering.lower(lowered, features);
  return lowered;
}

/** A data declaration whose constructors evaluate the fields marked `!`, and under StrictData those not marked `~`. */
function withStrictFields(features: FeatureGates<'convert'>, decl: Decl): Decl {
  if (decl.kind === 'class' || decl.kind === 'instance') {
    return { ...decl, decls: decl.decls.map((inner) => withStrictFields(features, inner)) };
  }
  if (decl.kind !== 'data' || decl.newtype) return decl;
  const strictData = features.allows('strictData');
  return { ...decl, cons: decl.cons.map((con) => conWithStrictFields(con, strictData)) };
}

function conWithStrictFields(con: ConDecl, strictData: boolean): ConDecl {
  const strictFields = con.fields.flatMap((_, index) => {
    const bang = con.bangs?.[index];
    return bang === 'strict' || (strictData && bang !== 'lazy') ? [index] : [];
  });
  return strictFields.length > 0 ? { ...con, strictFields } : con;
}
