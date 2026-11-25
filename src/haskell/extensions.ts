import { compileError, unsupportedError } from './errors';

/**
 * The language extensions GHC 9.14 knows, which `{-# LANGUAGE #-}` may name. A name outside this list is an error, as
 * GHC reports `Unsupported extension`.
 */
const KNOWN_EXTENSIONS = new Set(
  `Unsafe Trustworthy Safe CPP OverlappingInstances UndecidableInstances IncoherentInstances UndecidableSuperClasses
  MonomorphismRestriction MonoLocalBinds DeepSubsumption RelaxedPolyRec ExtendedDefaultRules NamedDefaults
  ForeignFunctionInterface UnliftedFFITypes InterruptibleFFI CApiFFI GHCForeignImportPrim ParallelArrays Arrows
  TemplateHaskell TemplateHaskellQuotes QualifiedDo QuasiQuotes ImplicitParams ImplicitPrelude ScopedTypeVariables
  PatternSignatures AllowAmbiguousTypes UnboxedTuples UnboxedSums UnliftedNewtypes UnliftedDatatypes BangPatterns
  TypeFamilies TypeFamilyDependencies TypeInType OverloadedStrings OverloadedLists NumDecimals
  DisambiguateRecordFields RecordWildCards NamedFieldPuns RecordPuns ViewPatterns OrPatterns GADTs GADTSyntax
  NPlusKPatterns DoAndIfThenElse BlockArguments RebindableSyntax ConstraintKinds PolyKinds DataKinds TypeData
  InstanceSigs ApplicativeDo LinearTypes RequiredTypeArguments StandaloneDeriving DeriveDataTypeable
  AutoDeriveTypeable DeriveFunctor DeriveTraversable DeriveFoldable DeriveGeneric DefaultSignatures DeriveAnyClass
  DeriveLift DerivingStrategies DerivingVia TypeSynonymInstances FlexibleContexts FlexibleInstances
  ConstrainedClassMethods MultiParamTypeClasses NullaryTypeClasses FunctionalDependencies UnicodeSyntax
  ExistentialQuantification MagicHash EmptyDataDecls KindSignatures RoleAnnotations ParallelListComp
  TransformListComp MonadComprehensions GeneralizedNewtypeDeriving GeneralisedNewtypeDeriving RecursiveDo DoRec
  PostfixOperators TupleSections PatternGuards LiberalTypeSynonyms RankNTypes Rank2Types PolymorphicComponents
  ImpredicativeTypes TypeOperators ExplicitNamespaces PackageImports ExplicitForAll AlternativeLayoutRule
  AlternativeLayoutRuleTransitional DatatypeContexts RelaxedLayout TraditionalRecordSyntax LambdaCase MultiWayIf
  BinaryLiterals NegativeLiterals HexFloatLiterals DuplicateRecordFields OverloadedLabels EmptyCase PatternSynonyms
  PartialTypeSignatures NamedWildCards StaticPointers TypeApplications Strict StrictData EmptyDataDeriving
  NumericUnderscores QuantifiedConstraints StarIsType ImportQualifiedPost CUSKs StandaloneKindSignatures
  LexicalNegation FieldSelectors OverloadedRecordDot OverloadedRecordUpdate TypeAbstractions ExtendedLiterals
  ListTuplePuns MultilineStrings ExplicitLevelImports ImplicitStagePersistence NondecreasingIndentation`.split(/\s+/)
);

/** Old names GHC still accepts for an extension. */
const SYNONYMS: Record<string, string> = {
  GeneralizedNewtypeDeriving: 'GeneralisedNewtypeDeriving',
  RecordPuns: 'NamedFieldPuns',
  DoRec: 'RecursiveDo',
  PatternSignatures: 'ScopedTypeVariables',
  Rank2Types: 'RankNTypes',
  PolymorphicComponents: 'RankNTypes',
  NullaryTypeClasses: 'MultiParamTypeClasses',
  AutoDeriveTypeable: 'DeriveDataTypeable',
};

// The extensions of each language edition, as GHC 9.14's user guide lists them. ListTuplePuns is on in every edition.
const HASKELL_2010 = `CUSKs DatatypeContexts DeepSubsumption DoAndIfThenElse EmptyDataDecls FieldSelectors
  ForeignFunctionInterface ImplicitPrelude MonomorphismRestriction PatternGuards RelaxedPolyRec StarIsType
  TraditionalRecordSyntax ImplicitStagePersistence ListTuplePuns`;

const HASKELL_98 = `CUSKs DatatypeContexts DeepSubsumption FieldSelectors ImplicitPrelude MonomorphismRestriction
  NPlusKPatterns NondecreasingIndentation StarIsType TraditionalRecordSyntax ImplicitStagePersistence ListTuplePuns`;

const GHC_2021_COMMON = `BangPatterns BinaryLiterals ConstrainedClassMethods ConstraintKinds DeriveDataTypeable
  DeriveFoldable DeriveFunctor DeriveGeneric DeriveLift DeriveTraversable DoAndIfThenElse EmptyCase EmptyDataDecls
  EmptyDataDeriving ExistentialQuantification ExplicitForAll FieldSelectors FlexibleContexts FlexibleInstances
  ForeignFunctionInterface GADTSyntax GeneralisedNewtypeDeriving HexFloatLiterals ImplicitPrelude
  ImportQualifiedPost InstanceSigs KindSignatures MonomorphismRestriction MultiParamTypeClasses NamedFieldPuns
  NamedWildCards NumericUnderscores PatternGuards PolyKinds PostfixOperators RankNTypes RelaxedPolyRec
  ScopedTypeVariables StandaloneDeriving StandaloneKindSignatures StarIsType TraditionalRecordSyntax TupleSections
  TypeApplications TypeOperators TypeSynonymInstances ImplicitStagePersistence ListTuplePuns`;

// GHC2021 leaves out ExplicitNamespaces, which TypeOperators would otherwise imply.
const GHC_2021 = GHC_2021_COMMON;

const GHC_2024 = `${GHC_2021_COMMON} DataKinds DerivingStrategies DisambiguateRecordFields ExplicitNamespaces GADTs
  LambdaCase MonoLocalBinds RoleAnnotations`;

const LANGUAGES: Record<string, string> = {
  Haskell98: HASKELL_98,
  Haskell2010: HASKELL_2010,
  GHC2021: GHC_2021,
  GHC2024: GHC_2024,
};

/** The extensions that enabling one also enables (`+`) or disables (`-`), as GHC's implications do. */
const IMPLICATIONS: Record<string, string> = {
  RankNTypes: '+ExplicitForAll',
  QuantifiedConstraints: '+ExplicitForAll',
  ScopedTypeVariables: '+ExplicitForAll',
  LiberalTypeSynonyms: '+ExplicitForAll',
  ExistentialQuantification: '+ExplicitForAll',
  FlexibleInstances: '+TypeSynonymInstances',
  FunctionalDependencies: '+MultiParamTypeClasses',
  MultiParamTypeClasses: '+ConstrainedClassMethods',
  TypeFamilyDependencies: '+TypeFamilies',
  TypeFamilies: '+MonoLocalBinds +KindSignatures +ExplicitNamespaces',
  TypeOperators: '+ExplicitNamespaces',
  PolyKinds: '+KindSignatures',
  TypeInType: '+PolyKinds +DataKinds +KindSignatures',
  ImpredicativeTypes: '+RankNTypes',
  GADTs: '+GADTSyntax +MonoLocalBinds',
  RecordWildCards: '+DisambiguateRecordFields',
  DuplicateRecordFields: '+DisambiguateRecordFields',
  DerivingVia: '+DerivingStrategies',
  DeriveTraversable: '+DeriveFunctor +DeriveFoldable',
  TemplateHaskell: '+TemplateHaskellQuotes',
  RebindableSyntax: '-ImplicitPrelude',
  Strict: '+StrictData',
  StandaloneKindSignatures: '-CUSKs',
  UnliftedDatatypes: '+DataKinds +StandaloneKindSignatures',
  LinearTypes: '+ExplicitNamespaces',
  IncoherentInstances: '+OverlappingInstances',
};

/** The extensions a program turned on, starting from GHC's default language, GHC2021. */
export class Extensions {
  private readonly enabled: Set<string>;

  /**
   * @param items The `LANGUAGE` items in order, such as `LambdaCase`, `NoImplicitPrelude`, or `GHC2024`. A language
   * replaces the default one wherever it appears, and the other items apply on top of it in order, as in GHC.
   */
  constructor(items: readonly string[] = []) {
    const language = items.findLast((item) => Object.hasOwn(LANGUAGES, item)) ?? 'GHC2021';
    this.enabled = new Set(words(LANGUAGES[language]));
    for (const item of items) if (!Object.hasOwn(LANGUAGES, item)) this.apply(item, true);
  }

  has(name: string): boolean {
    return this.enabled.has(canonical(name));
  }

  /**
   * Turns an extension on or off. One a pragma names turns on what it implies even when the language already has it,
   * as GHC does; one only implied stops there.
   */
  private apply(item: string, written = false): void {
    const negated = item.startsWith('No') && isKnown(item.slice(2));
    const name = canonical(negated ? item.slice(2) : item);
    if (negated) {
      this.enabled.delete(name);
      return;
    }
    if (this.enabled.has(name) && !written) return;
    this.enabled.add(name);
    for (const implied of words(IMPLICATIONS[name] ?? '')) {
      if (implied.startsWith('+')) this.apply(implied.slice(1));
      else this.enabled.delete(implied.slice(1));
    }
  }
}

function words(list: string): string[] {
  return list.split(/\s+/).filter(Boolean);
}

function canonical(name: string): string {
  return SYNONYMS[name] ?? name;
}

function isKnown(name: string): boolean {
  return KNOWN_EXTENSIONS.has(name) || Object.hasOwn(LANGUAGES, name);
}

/** A pragma at the head of a file, before any code: `LANGUAGE`, `OPTIONS_GHC`, and the like. */
export interface HeaderPragma {
  keyword: string;
  body: string;
  /** The offset of the body in the source. */
  bodyStart: number;
  row: number;
}

/**
 * Reads the extensions a program's file-header pragmas turn on. GHC reads `LANGUAGE` and `OPTIONS_GHC` pragmas only
 * before the first token of code; later ones are ignored.
 */
export function readExtensions(source: string): Extensions {
  const items: string[] = [];
  for (const pragma of headerPragmas(source)) {
    switch (pragma.keyword) {
      case 'LANGUAGE': {
        for (const item of languageItems(pragma, source)) {
          if (!isKnown(item.name) && !(item.name.startsWith('No') && isKnown(item.name.slice(2)))) {
            throw compileError(item.row, `Unsupported extension: ${item.name}`);
          }
          rejectUnsupportedExtension(item.name, item.row);
          items.push(item.name);
        }
        break;
      }
      case 'OPTIONS_GHC':
      case 'OPTIONS': {
        for (const flag of pragma.body.split(/\s+/).filter(Boolean)) {
          if (!flag.startsWith('-X')) continue;
          const name = flag.slice(2);
          if (!isKnown(name) && !(name.startsWith('No') && isKnown(name.slice(2)))) {
            throw compileError(pragma.row, `Unsupported extension: ${name}`);
          }
          rejectUnsupportedExtension(name, pragma.row);
          items.push(name);
        }
        break;
      }
      default: {
        break;
      }
    }
  }
  return new Extensions(items);
}

/**
 * What each extension that this environment does not support changes, for its message. These change what programs
 * mean without syntax of their own to reject, so enabling them is rejected.
 */
const UNSUPPORTED_EXTENSIONS: Record<string, string> = {
  RebindableSyntax: '構文の読み替え（RebindableSyntax）',
  NPlusKPatterns: 'n+k パターン（NPlusKPatterns。Haskell 2010 で言語から外された書き方）',
  ParallelArrays: '並列配列（ParallelArrays）',
  Arrows: 'アロー記法（Arrows）',
  StaticPointers: '静的ポインタ（StaticPointers）',
  AlternativeLayoutRule: '別の字下げの規則（AlternativeLayoutRule）',
  AlternativeLayoutRuleTransitional: '別の字下げの規則（AlternativeLayoutRule）',
  GHCForeignImportPrim: '外部の関数の宣言（foreign import prim）',
  UnliftedFFITypes: '外部の関数の宣言（UnliftedFFITypes）',
  InterruptibleFFI: '外部の関数の宣言（InterruptibleFFI）',
  CApiFFI: '外部の関数の宣言（CApiFFI）',
};

function rejectUnsupportedExtension(item: string, row: number): void {
  const name = canonical(item.startsWith('No') && isKnown(item.slice(2)) ? item.slice(2) : item);
  if (item.startsWith('No') && isKnown(item.slice(2))) return;
  const what = UNSUPPORTED_EXTENSIONS[name];
  if (what) throw unsupportedError(row, what);
}

function languageItems(pragma: HeaderPragma, source: string): { name: string; row: number }[] {
  const items: { name: string; row: number }[] = [];
  for (const match of pragma.body.matchAll(/[^\s,]+/g)) {
    const offset = pragma.bodyStart + match.index;
    items.push({ name: match[0], row: rowAt(source, offset) });
  }
  return items;
}

function rowAt(source: string, offset: number): number {
  let row = 0;
  for (let index = source.indexOf('\n'); index !== -1 && index < offset; index = source.indexOf('\n', index + 1)) row++;
  return row;
}

/** The pragmas before the first token of code, skipping whitespace and comments. */
export function headerPragmas(source: string): HeaderPragma[] {
  const pragmas: HeaderPragma[] = [];
  let index = 0;
  for (;;) {
    while (index < source.length && /\s/.test(source[index]!)) index++;
    if (source.startsWith('{-#', index)) {
      const end = source.indexOf('#-}', index + 3);
      if (end === -1) return pragmas;
      const text = source.slice(index + 3, end);
      const keyword = /^\s*([A-Za-z_]+)/.exec(text);
      if (keyword) {
        const bodyStart = index + 3 + keyword[0].length;
        pragmas.push({
          keyword: keyword[1].toUpperCase(),
          body: source.slice(bodyStart, end),
          bodyStart,
          row: rowAt(source, index),
        });
      }
      index = end + 3;
    } else if (source.startsWith('{-', index)) {
      index = skipBlockComment(source, index);
    } else if (/^--+(?![!#$%&*+./<=>?@\\^|~:])/.test(source.slice(index, index + 64))) {
      const end = source.indexOf('\n', index);
      if (end === -1) return pragmas;
      index = end + 1;
    } else {
      return pragmas;
    }
  }
}

function skipBlockComment(source: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    if (source.startsWith('{-', index)) {
      depth++;
      index += 2;
    } else if (source.startsWith('-}', index)) {
      depth--;
      index += 2;
      if (depth === 0) return index;
    } else index++;
  }
  return index;
}
