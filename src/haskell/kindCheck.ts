import { stronglyConnected } from './dependencies';
import type { ClassEntity, TypeEntity } from './entities';
import { compileError } from './errors';
import type { Checker } from './infer';
import { checkSchemeAmbiguity, typeVarNames } from './infer';
import { rememberKind } from './kindTemplates';
import type { RType } from './rast';
import type { RClassDecl, RDataDecl, RModule, RSynonymDecl } from './rename';
import { defaultKind, freshKindVar, type Kind, kindArrow, type Pred, type Scheme, STAR, type Type } from './types';
import { chargeTypeWork } from './typeWorkBudget';

type KindDeclaration =
  | { kind: 'data'; decl: RDataDecl; kinds: Kind[] }
  | { kind: 'synonym'; decl: RSynonymDecl; kinds: Kind[] }
  | { kind: 'class'; decl: RClassDecl };

export function inferKinds(checker: Checker, module: RModule): void {
  const declarations = prepareDeclarations(module);
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

function prepareDeclarations(module: RModule): KindDeclaration[] {
  const declarations: KindDeclaration[] = [];
  for (const decl of module.dataDecls) {
    const kinds = decl.params.map((): Kind => freshKindVar());
    decl.entity.kind = arrowKind(kinds, STAR);
    declarations.push({ kind: 'data', decl, kinds });
  }
  for (const decl of module.synonyms) {
    const kinds = decl.params.map((): Kind => freshKindVar());
    decl.entity.kind = arrowKind(kinds, freshKindVar());
    declarations.push({ kind: 'synonym', decl, kinds });
  }
  for (const decl of module.classes) {
    decl.entity.tyvarKind = freshKindVar();
    declarations.push({ kind: 'class', decl });
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
  for (const entry of group)
    rememberKind(entry.decl.entity, entry.kind === 'class' ? entry.decl.entity.tyvarKind : entry.decl.entity.kind);
}

function defaultDeclarations(group: KindDeclaration[]): void {
  for (const entry of group) {
    if (entry.kind === 'class') {
      entry.decl.entity.tyvarKind = defaultKind(entry.decl.entity.tyvarKind);
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

function inferClass(checker: Checker, decl: RClassDecl): void {
  checker.checkSuperclassTypes(decl.supers, decl.param, decl.entity.tyvarKind);
  for (const method of decl.methods) method.entity.scheme = methodScheme(checker, decl, method.sig);
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
  const names = [decl.param, ...typeVarNames([sig.type, ...sig.context]).filter((name) => name !== decl.param)];
  const kinds: Kind[] = names.map((_, index) => (index === 0 ? decl.entity.tyvarKind : freshKindVar()));
  const vars = new Map<string, Type>(names.map((name, index) => [name, { tag: 'tgen', index }]));
  const varKinds = new Map<string, Kind>(names.map((name, index) => [name, kinds[index]]));
  const type = checker.convertType(sig.type, vars, varKinds, STAR);
  const preds: Pred[] = [{ cls: decl.entity, type: { tag: 'tgen', index: 0 } }];
  for (const pred of checker.convertConstraints(sig.context, vars, varKinds)) preds.push(pred);
  const scheme = { kinds, names, preds, type };
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
    else if (type.k === 'tuple') for (const elem of type.elems) work.push(elem);
  }
}
