export type Phase = 'parse' | 'convert' | 'rename' | 'typecheck';

/**
 * A feature that language extensions switch: it is on when the module has one of `any`, or all of `all`, and only
 * `phase` decides it.
 */
interface FeatureGate {
  phase: Phase;
  any?: readonly string[];
  all?: readonly string[];
}

/** A phase asks only through {@link FeatureGates.allows}, which accepts only the features of its phase. */
export const FEATURES = {
  extendedGrammar: {
    phase: 'parse',
    any: [
      'TemplateHaskell',
      'TemplateHaskellQuotes',
      'QuasiQuotes',
      'OverloadedRecordDot',
      'OverloadedRecordUpdate',
      'RecursiveDo',
      'PatternSynonyms',
      'UnboxedTuples',
      'UnboxedSums',
      'MagicHash',
      'OverloadedLabels',
    ],
  },
  cpp: { phase: 'parse', any: ['CPP'] },
  splices: { phase: 'parse', any: ['TemplateHaskell', 'QuasiQuotes'] },
  declarationQuotes: { phase: 'parse', any: ['TemplateHaskell', 'TemplateHaskellQuotes'] },
  blockArguments: { phase: 'parse', any: ['BlockArguments'] },
  recursiveDoKeywords: { phase: 'parse', any: ['RecursiveDo'] },
  unicodeSyntax: { phase: 'convert', any: ['UnicodeSyntax'] },
  namedDefaults: { phase: 'convert', any: ['NamedDefaults'] },
  levelImports: { phase: 'convert', any: ['ExplicitLevelImports'] },
  packageImports: { phase: 'convert', any: ['PackageImports'] },
  safeImports: { phase: 'convert', any: ['Safe', 'Trustworthy', 'Unsafe'] },
  namespaceKeyword: { phase: 'convert', any: ['ExplicitNamespaces', 'TypeOperators'] },
  standaloneKindSignatures: { phase: 'convert', any: ['StandaloneKindSignatures'] },
  patternGuards: { phase: 'convert', any: ['PatternGuards'] },
  strict: { phase: 'convert', any: ['Strict'] },
  strictData: { phase: 'convert', any: ['StrictData'] },
  datatypeContexts: { phase: 'convert', any: ['DatatypeContexts'] },
  gadtSyntax: { phase: 'convert', any: ['GADTSyntax'] },
  emptyDataDecls: { phase: 'convert', any: ['EmptyDataDecls'] },
  derivingVia: { phase: 'convert', any: ['DerivingVia'] },
  derivingStrategies: { phase: 'convert', any: ['DerivingStrategies'] },
  anyclassStrategy: { phase: 'convert', any: ['DeriveAnyClass'] },
  newtypeStrategy: { phase: 'convert', any: ['GeneralisedNewtypeDeriving'] },
  roleAnnotations: { phase: 'convert', any: ['RoleAnnotations'] },
  standaloneDeriving: { phase: 'convert', any: ['StandaloneDeriving'] },
  patternSynonyms: { phase: 'convert', any: ['PatternSynonyms'] },
  typeFamilyDependencies: { phase: 'convert', any: ['TypeFamilyDependencies'] },
  typeFamilies: { phase: 'convert', any: ['TypeFamilies'] },
  implicitParams: { phase: 'convert', any: ['ImplicitParams'] },
  promotedSyntax: { phase: 'convert', any: ['DataKinds'] },
  typeOperators: { phase: 'convert', any: ['TypeOperators'] },
  typeAbstractions: { phase: 'convert', any: ['TypeAbstractions'] },
  kindSignatures: { phase: 'convert', any: ['KindSignatures', 'PolyKinds'] },
  existentials: { phase: 'convert', any: ['ExistentialQuantification', 'GADTs'] },
  multiParamClasses: { phase: 'convert', any: ['MultiParamTypeClasses'] },
  functionalDependencies: { phase: 'convert', any: ['FunctionalDependencies'] },
  defaultSignatures: { phase: 'convert', any: ['DefaultSignatures'] },
  requiredTypeArguments: { phase: 'convert', any: ['RequiredTypeArguments'] },
  requiredTypeTerms: { phase: 'rename', any: ['RequiredTypeArguments'] },
  typeArgumentKeyword: { phase: 'convert', all: ['RequiredTypeArguments', 'ExplicitNamespaces'] },
  explicitForAll: { phase: 'convert', any: ['ExplicitForAll'] },
  rankNTypes: { phase: 'convert', any: ['RankNTypes'] },
  linearTypes: { phase: 'convert', any: ['LinearTypes'] },
  overloadedStrings: { phase: 'convert', any: ['OverloadedStrings'] },
  overloadedLabels: { phase: 'convert', any: ['OverloadedLabels'] },
  typeApplications: { phase: 'convert', any: ['TypeApplications'] },
  overloadedLists: { phase: 'convert', any: ['OverloadedLists'] },
  parallelListComp: { phase: 'convert', any: ['ParallelListComp'] },
  tupleSections: { phase: 'convert', any: ['TupleSections'] },
  lambdaCase: { phase: 'convert', any: ['LambdaCase'] },
  emptyCase: { phase: 'convert', any: ['EmptyCase'] },
  multiWayIf: { phase: 'convert', any: ['MultiWayIf'] },
  unboxedTuples: { phase: 'convert', any: ['UnboxedTuples'] },
  unboxedSums: { phase: 'convert', any: ['UnboxedSums'] },
  templateHaskell: { phase: 'convert', any: ['TemplateHaskell'] },
  templateHaskellQuotes: { phase: 'convert', any: ['TemplateHaskell', 'TemplateHaskellQuotes'] },
  overloadedRecordDot: { phase: 'convert', any: ['OverloadedRecordDot'] },
  recursiveDo: { phase: 'convert', any: ['RecursiveDo'] },
  qualifiedDo: { phase: 'convert', any: ['QualifiedDo'] },
  namedFieldPuns: { phase: 'convert', any: ['NamedFieldPuns'] },
  recordWildCards: { phase: 'convert', any: ['RecordWildCards'] },
  transformListComp: { phase: 'convert', any: ['TransformListComp'] },
  lexicalNegation: { phase: 'convert', any: ['LexicalNegation'] },
  negativeLiterals: { phase: 'convert', any: ['NegativeLiterals'] },
  multilineStrings: { phase: 'convert', any: ['MultilineStrings'] },
  bangPatterns: { phase: 'convert', any: ['BangPatterns'] },
  viewPatterns: { phase: 'convert', any: ['ViewPatterns'] },
  orPatterns: { phase: 'convert', any: ['OrPatterns'] },
  patternSignatures: { phase: 'convert', any: ['ScopedTypeVariables'] },
  numericUnderscores: { phase: 'convert', any: ['NumericUnderscores'] },
  binaryLiterals: { phase: 'convert', any: ['BinaryLiterals'] },
  hexFloatLiterals: { phase: 'convert', any: ['HexFloatLiterals'] },
  numDecimals: { phase: 'convert', any: ['NumDecimals'] },
  implicitPrelude: { phase: 'rename', any: ['ImplicitPrelude'] },
  duplicateRecordFields: { phase: 'rename', any: ['DuplicateRecordFields'] },
  ambiguousClassMethods: { phase: 'rename', any: ['AllowAmbiguousTypes'] },
  instanceSigs: { phase: 'rename', any: ['InstanceSigs'] },
  monadComprehensions: { phase: 'rename', any: ['MonadComprehensions'] },
  starIsType: { phase: 'rename', any: ['StarIsType'] },
  starOperator: { phase: 'rename', any: ['TypeOperators'] },
  promotion: { phase: 'rename', any: ['DataKinds'] },
  ambiguousTypes: { phase: 'typecheck', any: ['AllowAmbiguousTypes'] },
  monomorphismRestriction: { phase: 'typecheck', any: ['MonomorphismRestriction'] },
  polyKinds: { phase: 'typecheck', any: ['PolyKinds'] },
  undecidableSuperClasses: { phase: 'typecheck', any: ['UndecidableSuperClasses'] },
  undecidableInstances: { phase: 'typecheck', any: ['UndecidableInstances'] },
  overlappingInstances: { phase: 'typecheck', any: ['OverlappingInstances'] },
  incoherentInstances: { phase: 'typecheck', any: ['IncoherentInstances'] },
  extendedDefaultRules: { phase: 'typecheck', any: ['ExtendedDefaultRules'] },
  anyclassByDefault: { phase: 'typecheck', any: ['DeriveAnyClass'] },
  newtypeByDefault: { phase: 'typecheck', any: ['GeneralisedNewtypeDeriving'] },
  deriveFunctor: { phase: 'typecheck', any: ['DeriveFunctor'] },
  deriveFoldable: { phase: 'typecheck', any: ['DeriveFoldable'] },
  deriveTraversable: { phase: 'typecheck', any: ['DeriveTraversable'] },
  deriveLift: { phase: 'typecheck', any: ['DeriveLift'] },
} as const satisfies Record<string, FeatureGate>;

export type Feature = keyof typeof FEATURES;

export type FeatureOf<P extends Phase> = {
  [F in Feature]: (typeof FEATURES)[F]['phase'] extends P ? F : never;
}[Feature];

export interface FeatureGates<P extends Phase> {
  allows(feature: FeatureOf<P>): boolean;
}

export function featureAllowed(feature: Feature, enabled: ReadonlySet<string>): boolean {
  const gate: FeatureGate = FEATURES[feature];
  if (gate.all) return gate.all.every((name) => enabled.has(name));
  return (gate.any ?? []).some((name) => enabled.has(name));
}
