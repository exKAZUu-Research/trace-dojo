import { stronglyConnected } from './dependencies';
import { type ClassEntity, nextId, type TypeEntity, type ValueEntity } from './entities';
import { compileError } from './errors';
import type { Checker } from './infer';
import { checkSchemeAmbiguity, typeVarNames } from './infer';
import { rememberKind } from './kindTemplates';
import type { RType } from './rast';
import type { RClassDecl, RDataDecl, RModule, RSynonymDecl } from './rename';
import {
  CONSTRAINT,
  defaultKind,
  freshKindVar,
  type Kind,
  kindArrow,
  parameterKinds,
  type Pred,
  type Scheme,
  showKind,
  STAR,
  tap,
  tcon,
  type Type,
  unifyKinds,
} from './types';
import { chargeTypeWork } from './typeWorkBudget';

type KindDeclaration =
  | { kind: 'data'; decl: RDataDecl; kinds: Kind[] }
  | { kind: 'synonym'; decl: RSynonymDecl; kinds: Kind[] }
  | { kind: 'class'; decl: RClassDecl };

export function inferKinds(checker: Checker, module: RModule): void {
  const declarations = prepareDeclarations(checker, module);
  const owner = new Map<object, number>(declarations.map((entry, index) => [entry.decl.entity, index]));
  const edges = declarations.map((entry) =>
    [...kindDependencies(entry)].flatMap((entity) => {
      const index = owner.get(entity);
      return index === undefined ? [] : [index];
    })
  );
  for (const indices of stronglyConnected(edges))
    inferGroup(
      checker,
      indices.map((index) => declarations[index])
    );
  defaultDeclarations(declarations);
  for (const decl of module.dataDecls)
    for (const derivation of decl.deriving) derivation.cls = checker.derivingClass(derivation.type);
  checker.checkKinds();
}

function prepareDeclarations(checker: Checker, module: RModule): KindDeclaration[] {
  const declarations: KindDeclaration[] = [];
  const annotated = (kinds: (RType | undefined)[] | undefined, count: number): Kind[] => {
    const kindVars = new Map<string, Kind>();
    return Array.from({ length: count }, (_, index) => {
      const kind = kinds?.[index];
      return kind ? checker.kindOf(kind, kindVars) : freshKindVar();
    });
  };
  for (const decl of module.dataDecls) {
    const kinds = annotated(decl.paramKinds, decl.params.length);
    decl.entity.kind = arrowKind(kinds, STAR);
    declarations.push({ kind: 'data', decl, kinds });
  }
  for (const decl of module.synonyms) {
    const kinds = annotated(decl.paramKinds, decl.params.length);
    decl.entity.kind = arrowKind(kinds, freshKindVar());
    declarations.push({ kind: 'synonym', decl, kinds });
  }
  for (const decl of module.classes) {
    const kinds = annotated(decl.paramKinds, decl.params.length);
    const { packed } = decl.entity;
    if (packed) {
      packed.kind = arrowKind(kinds, STAR);
      decl.entity.tyvarKind = STAR;
    } else decl.entity.tyvarKind = kinds[0];
    declarations.push({ kind: 'class', decl });
  }
  for (const { entity, kind, span } of module.kindSigs) {
    const given = checker.kindOf(kind, new Map());
    const actual = 'tyvarKind' in entity ? arrowKind(classParamKinds(entity), CONSTRAINT) : (entity as TypeEntity).kind;
    if (!unifyKinds(actual, given)) {
      throw compileError(span, `${entity.name} の種類が、種類のシグネチャ ${showKind(given)} と合いません。`);
    }
  }
  return declarations;
}

function kindDependencies(entry: KindDeclaration): Set<object> {
  const found = new Set<object>();
  const work: RType[] = [];
  if (entry.kind === 'data') {
    for (const con of entry.decl.cons) work.push(...con.fields);
  } else if (entry.kind === 'synonym') work.push(entry.decl.rhs);
  else {
    work.push(...entry.decl.supers);
    for (const method of entry.decl.methods) work.push(method.sig.type, ...method.sig.context);
  }
  for (const entity of typeEntities(work)) found.add(entity);
  return found;
}

function inferGroup(checker: Checker, group: KindDeclaration[]): void {
  const synonyms = new Map(group.flatMap((entry) => (entry.kind === 'synonym' ? [[entry.decl, entry] as const] : [])));
  for (const decl of orderSynonyms([...synonyms.keys()])) inferTypeDeclaration(checker, synonyms.get(decl)!);
  for (const entry of group) {
    if (entry.kind === 'data') inferTypeDeclaration(checker, entry);
    else if (entry.kind === 'class') inferClass(checker, entry.decl);
  }
  checker.checkKinds(true);
  for (const entry of group) {
    if (entry.kind !== 'class') rememberKind(entry.decl.entity, entry.decl.entity.kind);
    else {
      rememberKind(entry.decl.entity, entry.decl.entity.tyvarKind);
      const { packed } = entry.decl.entity;
      if (packed) rememberKind(packed, packed.kind);
    }
  }
}

function defaultDeclarations(group: KindDeclaration[]): void {
  for (const entry of group) {
    if (entry.kind === 'class') {
      entry.decl.entity.tyvarKind = defaultKind(entry.decl.entity.tyvarKind);
      const { packed } = entry.decl.entity;
      if (packed) packed.kind = defaultKind(packed.kind);
      for (const method of entry.decl.methods) {
        const scheme = method.entity.scheme as Scheme;
        scheme.kinds = scheme.kinds.map(defaultKind);
      }
    } else entry.decl.entity.kind = defaultKind(entry.decl.entity.kind);
  }
}

function inferTypeDeclaration(checker: Checker, entry: Exclude<KindDeclaration, { kind: 'class' }>): void {
  const { decl, kinds } = entry;
  const vars = new Map<string, Type>(decl.params.map((name, index) => [name, { tag: 'tgen', index }]));
  const varKinds = new Map<string, Kind>(decl.params.map((name, index) => [name, kinds[index]]));
  if (entry.kind === 'data') {
    for (const { con, fields } of entry.decl.cons)
      con.fieldTypes = fields.map((field) => checker.convertType(field, vars, varKinds, STAR));
  } else {
    let resultKind = entry.decl.entity.kind;
    for (let index = 0; index < decl.params.length; index++) resultKind = (resultKind as { tag: 'arrow'; to: Kind }).to;
    entry.decl.entity.synonym = checker.convertType(entry.decl.rhs, vars, varKinds, resultKind);
  }
}

/** The kinds of a class's parameters, in order. */
export function classParamKinds(cls: ClassEntity): Kind[] {
  return cls.packed ? parameterKinds(cls.packed.kind) : [cls.tyvarKind];
}

function inferClass(checker: Checker, decl: RClassDecl): void {
  const supers = checker.superclassTypes(decl.supers, decl.params, classParamKinds(decl.entity));
  decl.entity.supers = supers.map((sup) => sup.cls);
  decl.entity.superTypes = supers.map((sup) => sup.type);
  for (const method of decl.methods) method.entity.scheme = methodScheme(checker, decl, method.sig);
  for (const item of decl.defaultSigs) {
    const index = item.entity.method?.index as number;
    const implementation: ValueEntity = {
      id: nextId(),
      name: item.entity.name,
      module: decl.entity.module,
      sort: 'var',
      span: item.sig.span,
      scheme: methodScheme(checker, decl, item.sig),
    };
    (decl.entity.genericDefaults ??= new Map()).set(index, implementation);
  }
}

function arrowKind(params: readonly Kind[], result: Kind): Kind {
  let kind = result;
  for (const param of params.toReversed()) kind = kindArrow(param, kind);
  return kind;
}

function orderSynonyms(decls: RSynonymDecl[]): RSynonymDecl[] {
  const byEntity = new Map(decls.map((decl) => [decl.entity, decl]));
  const ordered: RSynonymDecl[] = [];
  const state = new Map<RSynonymDecl, 'visiting' | 'done'>();
  const frames: { decl: RSynonymDecl; dependencies: Generator<RSynonymDecl> }[] = [];
  const enter = (decl: RSynonymDecl): void => {
    state.set(decl, 'visiting');
    frames.push({ decl, dependencies: synonymDependencies(decl.rhs, byEntity) });
  };
  for (const root of decls) {
    if (state.has(root)) continue;
    enter(root);
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      const next = frame.dependencies.next();
      if (next.done) {
        state.set(frame.decl, 'done');
        ordered.push(frame.decl);
        frames.pop();
        continue;
      }
      const dependency = next.value;
      const current = state.get(dependency);
      if (current === 'visiting')
        throw compileError(dependency.span, `型シノニム ${dependency.entity.name} が循環しています。`);
      if (current !== 'done') enter(dependency);
    }
  }
  return ordered;
}

function* synonymDependencies(type: RType, byEntity: ReadonlyMap<TypeEntity, RSynonymDecl>): Generator<RSynonymDecl> {
  for (const entity of typeEntities([type])) {
    const dependency = 'sort' in entity ? byEntity.get(entity) : undefined;
    if (dependency) yield dependency;
  }
}

function methodScheme(checker: Checker, decl: RClassDecl, sig: RClassDecl['methods'][number]['sig']): Scheme {
  const { params } = decl;
  const names = [...params, ...typeVarNames([sig.type, ...sig.context]).filter((name) => !params.includes(name))];
  const paramKinds = classParamKinds(decl.entity);
  const kinds: Kind[] = names.map((_, index) => paramKinds[index] ?? freshKindVar());
  const vars = new Map<string, Type>(names.map((name, index) => [name, { tag: 'tgen', index }]));
  const varKinds = new Map<string, Kind>(names.map((name, index) => [name, kinds[index]]));
  const type = checker.convertType(sig.type, vars, varKinds, STAR);
  const classArgs = params.map((_, index): Type => ({ tag: 'tgen', index }));
  const { packed } = decl.entity;
  const preds: Pred[] = [{ cls: decl.entity, type: packed ? tap(tcon(packed), ...classArgs) : classArgs[0] }];
  for (const pred of checker.convertConstraints(sig.context, vars, varKinds)) preds.push(pred);
  const order = sig.forall ? sig.forall.map((binder) => binder.name) : typeVarNames([...sig.context, sig.type]);
  const specified = [
    ...params.keys(),
    ...order.flatMap((name) => (params.includes(name) ? [] : [names.indexOf(name)])),
  ].filter((index) => index >= 0);
  const scheme = { kinds, names, preds, type, specified };
  checkSchemeAmbiguity(scheme, sig.span);
  return scheme;
}

function* typeEntities(types: readonly RType[]): Generator<TypeEntity | ClassEntity> {
  const work = [...types];
  while (work.length > 0) {
    chargeTypeWork();
    const type = work.pop()!;
    if (type.k === 'con' || type.k === 'class') yield type.entity;
    else if (type.k === 'app') work.push(type.fn, type.arg);
    else if (type.k === 'fun') work.push(type.from, type.to);
    else if (type.k === 'kinded') work.push(type.type);
    else if (type.k === 'tuple') for (const elem of type.elems) work.push(elem);
  }
}
