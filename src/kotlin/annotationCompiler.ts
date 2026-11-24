import type { AnnotationSite } from './annotationSites';
import type { Annotation, Argument, Expression, Modifiers } from './ast';
import { BodyCompiler } from './bodyCompiler';
import { type Compiled, Flow, FunctionContext, Scope, typeMismatchMessage } from './compilerBase';
import { isKnownLibraryAnnotation, knownLibraryDeclaration } from './libraryApi';
import type { ClassSymbol, ParameterSymbol } from './symbols';
import { isSubtype } from './typeRelations';
import { type KType, resolved } from './types';

/** The targets an annotation class without `@Target` applies to, as Kotlin defines them. */
const DEFAULT_TARGETS = new Set([
  'CLASS',
  'PROPERTY',
  'FIELD',
  'LOCAL_VARIABLE',
  'VALUE_PARAMETER',
  'CONSTRUCTOR',
  'FUNCTION',
  'PROPERTY_GETTER',
  'PROPERTY_SETTER',
]);

/** The target each use-site target selects. */
const USE_SITE_TARGETS: Record<string, string> = {
  file: 'FILE',
  property: 'PROPERTY',
  field: 'FIELD',
  get: 'PROPERTY_GETTER',
  set: 'PROPERTY_SETTER',
  receiver: 'VALUE_PARAMETER',
  param: 'VALUE_PARAMETER',
  setparam: 'VALUE_PARAMETER',
  delegate: 'FIELD',
};

export type DeprecationLevel = 'WARNING' | 'ERROR' | 'HIDDEN';

/**
 * Checks annotations as kotlinc does: each names an annotation class, which accepts the arguments and the element it
 * is written on, and appears once unless it is `@Repeatable`.
 */
export abstract class AnnotationCompiler extends BodyCompiler {
  private readonly targetsOfClass = new Map<ClassSymbol, ReadonlySet<string>>();

  protected checkAnnotations(scope: Scope, annotations: Annotation[], site: AnnotationSite): void {
    const seen = new Map<string, number>();
    for (const annotation of annotations) {
      const cls = this.annotationClass(scope, annotation);
      if (annotation.useSiteTarget && !site.useSites.has(annotation.useSiteTarget))
        this.error(annotation.row, `@${annotation.useSiteTarget}: は、ここでは使えません。`);
      if (!cls) continue;
      this.checkAnnotationTarget(cls, annotation, site);
      this.checkAnnotationArguments(scope, cls, annotation.args ?? [], annotation.row);
      const key = `${cls.qualifiedName}:${annotation.useSiteTarget ?? ''}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if ((seen.get(key) as number) > 1 && !this.isRepeatable(cls))
        this.error(annotation.row, `@${annotation.name} は、同じ場所に2回書けません。`);
    }
  }

  /**
   * The annotation class an annotation names, or `undefined` for an annotation of Kotlin's library that the prelude
   * does not declare, which changes nothing that runs here.
   */
  private annotationClass(scope: Scope, annotation: Annotation): ClassSymbol | undefined {
    const { path, name, row } = annotation;
    const cls = path.length > 1 ? this.findQualifiedClass(path) : this.findClass(scope, name);
    if (cls) {
      if (!cls.isAnnotation) this.error(row, `${path.join('.')} はアノテーションクラスではありません。`);
      return cls;
    }
    const libraryName =
      path.length > 1
        ? path.join('.')
        : (this.file.importedAnnotations.get(name) ?? knownLibraryDeclaration(name, this.visiblePackageLevels()));
    if (libraryName && isKnownLibraryAnnotation(libraryName)) return undefined;
    return this.error(row, `${path.join('.')} 型が見つかりません。`);
  }

  private checkAnnotationTarget(cls: ClassSymbol, annotation: Annotation, site: AnnotationSite): void {
    const allowed = this.annotationTargets(cls);
    const { useSiteTarget } = annotation;
    const targets = useSiteTarget && useSiteTarget !== 'all' ? [USE_SITE_TARGETS[useSiteTarget]] : site.targets;
    if (!targets.some((target) => allowed.has(target)))
      this.error(annotation.row, `@${annotation.name} は、ここには付けられません。`);
  }

  /** The targets of an annotation class: those its `@Target` names, or Kotlin's defaults. */
  private annotationTargets(cls: ClassSymbol): ReadonlySet<string> {
    const known = this.targetsOfClass.get(cls);
    if (known) return known;
    const target = this.ownAnnotations(cls).find((annotation) => annotation.name === 'Target');
    const targets = target
      ? new Set((target.args ?? []).flatMap((argument) => enumEntryNames(argument.value)))
      : DEFAULT_TARGETS;
    this.targetsOfClass.set(cls, targets);
    return targets;
  }

  private isRepeatable(cls: ClassSymbol): boolean {
    return this.ownAnnotations(cls).some((annotation) => annotation.name === 'Repeatable');
  }

  private ownAnnotations(cls: ClassSymbol): Annotation[] {
    return cls.ownAnnotations as Annotation[];
  }

  /** Checks an annotation's arguments against its class's constructor, each of which must be a constant. */
  private checkAnnotationArguments(scope: Scope, cls: ClassSymbol, args: Argument[], row: number): void {
    const constructor = cls.constructors[0];
    const params = constructor?.params ?? [];
    const given = new Map<ParameterSymbol, Argument[]>();
    let position = 0;
    for (const argument of args) {
      const param =
        argument.name === undefined
          ? params[Math.min(position, params.length - 1)]
          : params.find((each) => each.name === argument.name);
      if (!param || (argument.name === undefined && position >= params.length && !params.at(-1)?.isVararg)) {
        this.error(
          argument.row,
          argument.name === undefined
            ? `@${cls.name} の引数が多すぎます。`
            : `@${cls.name} に引数 ${argument.name} はありません。`
        );
      }
      if (argument.name === undefined && !param.isVararg) position++;
      if (argument.name !== undefined) position = params.length;
      given.set(param, [...(given.get(param) ?? []), argument]);
    }
    for (const param of params) {
      const values = given.get(param) ?? [];
      if (values.length === 0 && !param.hasDefault && !param.isVararg)
        this.error(row, `@${cls.name} に引数 ${param.name} を書いてください。`);
      for (const value of values) {
        const named = value.name !== undefined;
        const type =
          param.isVararg && !value.isSpread && !named
            ? param.type
            : param.isVararg
              ? this.varargType(param.type)
              : param.type;
        if (param.isVararg && named && value.value.kind !== 'collectionLiteral' && !isArrayCall(value.value))
          this.error(value.row, `名前を付けた可変長の引数 ${param.name} には、[...] で配列を書いてください。`);
        this.checkAnnotationValue(scope, value.value, type, value.row);
      }
    }
  }

  /** Checks one value of an annotation's argument, which must be a constant of the parameter's type. */
  private checkAnnotationValue(scope: Scope, value: Expression, type: KType, row: number): void {
    const expected = resolved(type);
    if (value.kind === 'collectionLiteral') {
      const element = this.arrayElementType(expected);
      if (!element) this.error(row, typeMismatchMessage(expected, this.anyType));
      for (const item of value.elements) this.checkAnnotationValue(scope, item, element, item.row);
      return;
    }
    if (value.kind === 'call' && value.callee.kind !== 'member') {
      const callee = value.callee.kind === 'name' ? this.findClass(scope, value.callee.name) : undefined;
      if (callee?.isAnnotation) {
        if (!isSubtype(callee.type, expected)) this.error(row, typeMismatchMessage(expected, callee.type));
        this.checkAnnotationArguments(scope, callee, value.args, value.row);
        return;
      }
    }
    if (value.kind === 'reference' && value.name === 'class' && this.isLibraryMarkerReference(scope, value)) return;
    const compiled = this.compileAnnotationExpression(scope, value, expected);
    if (!isSubtype(compiled.type, expected) && !compiled.integerLiteral)
      this.error(row, typeMismatchMessage(expected, compiled.type));
    if (!isConstantValue(compiled, value)) this.error(row, 'アノテーションの引数には、定数を書いてください。');
  }

  /** Whether `X::class` names an opt-in marker of Kotlin's library that the prelude does not declare. */
  private isLibraryMarkerReference(scope: Scope, value: Extract<Expression, { kind: 'reference' }>): boolean {
    const receiver = value.receiver;
    if (receiver?.kind !== 'expression') return false;
    const path = qualifiedPath(receiver.expression);
    if (!path) return false;
    if (path.length === 1 ? this.findClass(scope, path[0]) : this.findQualifiedClass(path)) return false;
    const name = path.join('.');
    const libraryName =
      path.length > 1
        ? name
        : (this.file.importedAnnotations.get(name) ?? knownLibraryDeclaration(name, this.visiblePackageLevels()));
    return libraryName !== undefined && isKnownLibraryAnnotation(libraryName);
  }

  private compileAnnotationExpression(scope: Scope, value: Expression, expected: KType): Compiled {
    const savedFlow = this.flow;
    this.flow = new Flow();
    try {
      const context = new FunctionContext(undefined, false, '<annotation>', this.file.isLibrary, undefined);
      context.forbidsReturn = true;
      return this.compileExpression(new Scope(scope, context), context, value, expected);
    } finally {
      this.flow = savedFlow;
    }
  }

  private arrayElementType(type: KType): KType | undefined {
    if (type.kind !== 'class') return undefined;
    if (type.cls === this.core.array) {
      const [argument] = type.args;
      return argument && argument.variance !== 'star' ? argument.type : this.anyType;
    }
    const kind = [...this.core.primitives.entries()].find(
      ([cls]) => cls.name === type.cls.name.replace(/Array$/, '')
    )?.[1];
    return kind && type.cls.name.endsWith('Array') ? this.primitiveType(kind) : undefined;
  }

  private get anyType(): KType {
    return { ...this.core.any.type, nullable: true };
  }

  /**
   * The level of `@Deprecated` among a declaration's annotations: an `ERROR` makes kotlinc reject uses of it, and a
   * `HIDDEN` hides it from them.
   */
  protected deprecationLevel(scope: Scope, modifiers: Modifiers): DeprecationLevel | undefined {
    if (this.file.isLibrary) return undefined;
    for (const annotation of modifiers.annotations) {
      const { path, name } = annotation;
      const cls = path.length > 1 ? this.findQualifiedClass(path) : this.findClass(scope, name);
      if (cls?.kotlinName !== 'kotlin.Deprecated') continue;
      const args = annotation.args ?? [];
      const level =
        args.find((argument) => argument.name === 'level') ?? (args[2]?.name === undefined ? args[2] : undefined);
      const [entry] = level ? enumEntryNames(level.value) : [];
      return (entry as DeprecationLevel | undefined) ?? 'WARNING';
    }
    return undefined;
  }
}

/** The names of the enum entries an argument names, as `FUNCTION` of `AnnotationTarget.FUNCTION`. */
function enumEntryNames(value: Expression): string[] {
  if (value.kind === 'member') return [value.name];
  if (value.kind === 'name') return [value.name];
  if (value.kind === 'collectionLiteral') return value.elements.flatMap(enumEntryNames);
  if (value.kind === 'call' && isArrayCall(value))
    return value.args.flatMap((argument) => enumEntryNames(argument.value));
  return [];
}

function isArrayCall(value: Expression): value is Extract<Expression, { kind: 'call' }> {
  return (
    value.kind === 'call' &&
    value.callee.kind === 'name' &&
    /^(?:arrayOf|[a-z]+ArrayOf|emptyArray)$/.test(value.callee.name)
  );
}

/** The names of `a.b.C`, which may name a class. */
function qualifiedPath(expression: Expression): string[] | undefined {
  if (expression.kind === 'name') return [expression.name];
  if (expression.kind !== 'member' || expression.isSafe) return undefined;
  const receiver = qualifiedPath(expression.receiver);
  return receiver && [...receiver, expression.name];
}

/** Whether a compiled argument is a constant: a literal, a `const val`, an enum entry, a class literal, or an array of them. */
function isConstantValue(compiled: Compiled, value: Expression): boolean {
  if (compiled.constant !== undefined || compiled.integerLiteral) return true;
  switch (value.kind) {
    case 'null':
    case 'string': {
      return value.kind === 'null' || value.parts.every((part) => typeof part === 'string');
    }
    case 'reference': {
      return value.name === 'class';
    }
    case 'member':
    case 'name': {
      const type = resolved(compiled.type);
      return type.kind === 'class' && type.cls.kind === 'enum';
    }
    case 'call': {
      return isArrayCall(value);
    }
    default: {
      return false;
    }
  }
}
