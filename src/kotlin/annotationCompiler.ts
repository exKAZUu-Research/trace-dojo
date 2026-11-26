import type { AnnotationSite } from './annotationSites';
import type { Annotation, Argument, Expression, Modifiers } from './ast';
import { BodyCompiler } from './bodyCompiler';
import { type Compiled, Flow, FunctionContext, Scope, typeMismatchMessage } from './compilerBase';
import { isKnownLibraryAnnotation, knownLibraryDeclaration } from './libraryApi';
import type { ClassSymbol, ParameterSymbol, PropertySymbol } from './symbols';
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

  protected optInMarkersOf(scope: Scope, annotations: Annotation[]): ClassSymbol[] {
    if (this.file.isLibrary) return [];
    return annotations.map((annotation) => this.resolvedAnnotationClass(scope, annotation)).filter(isOptInMarker);
  }

  protected optInsOf(scope: Scope, annotations: Annotation[]): ClassSymbol[] {
    if (this.file.isLibrary) return [];
    const optIns: ClassSymbol[] = [];
    for (const annotation of annotations) {
      const cls = this.resolvedAnnotationClass(scope, annotation);
      if (isOptInMarker(cls)) optIns.push(cls);
      if (cls?.kotlinName === 'kotlin.OptIn') optIns.push(...this.optInArguments(scope, annotation));
    }
    return optIns;
  }

  /** The classes `@OptIn(A::class, B::class)` names, as `X::class` values or arrays of them. */
  private optInArguments(scope: Scope, annotation: Annotation): ClassSymbol[] {
    const values = (annotation.args ?? []).flatMap((argument) =>
      argument.value.kind === 'collectionLiteral' ? argument.value.elements : [argument.value]
    );
    return values.flatMap((value) => {
      const receiver = value.kind === 'reference' && value.name === 'class' ? value.receiver : undefined;
      const path = receiver?.kind === 'expression' ? qualifiedPath(receiver.expression) : undefined;
      const marker = path && (path.length > 1 ? this.findQualifiedClass(path) : this.findClass(scope, path[0]));
      return marker ? [marker] : [];
    });
  }

  /** The class an annotation names, without reporting one that is missing, which `checkAnnotations` reports. */
  private resolvedAnnotationClass(scope: Scope, annotation: Annotation): ClassSymbol | undefined {
    const { path, name } = annotation;
    return path.length > 1 ? this.findQualifiedClass(path) : this.findClass(scope, name);
  }

  /** Checks one value of an annotation's argument, which must be a constant of the parameter's type. */
  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
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
    // An integer literal fits only the integer types it can be, as an argument of a call does.
    if (!this.acceptsArgument(compiled, expected)) this.error(row, typeMismatchMessage(expected, compiled.type));
    if (!this.isConstantExpression(scope, value) && !isAnnotationConstant(compiled, value))
      this.error(row, 'アノテーションの引数には、定数を書いてください。');
  }

  protected isConstantExpression(scope: Scope, expression: Expression): boolean {
    switch (expression.kind) {
      case 'integer':
      case 'real':
      case 'char':
      case 'boolean': {
        return true;
      }
      case 'string': {
        return expression.parts.every((part) => typeof part === 'string' || this.isConstantExpression(scope, part));
      }
      case 'parenthesized': {
        return this.isConstantExpression(scope, expression.expression);
      }
      case 'prefix': {
        return ['-', '+', '!'].includes(expression.operator) && this.isConstantExpression(scope, expression.operand);
      }
      case 'binary': {
        return (
          !['?:', '..', '..<', '===', '!=='].includes(expression.operator) &&
          this.isConstantExpression(scope, expression.left) &&
          this.isConstantExpression(scope, expression.right)
        );
      }
      case 'infix': {
        return (
          CONSTANT_INFIX_OPERATORS.has(expression.name) &&
          this.isConstantExpression(scope, expression.left) &&
          this.isConstantExpression(scope, expression.right)
        );
      }
      case 'member': {
        if (CONSTANT_PROPERTIES.has(expression.name) && this.isConstantExpression(scope, expression.receiver))
          return true;
        return this.constantProperty(scope, expression)?.isConst === true;
      }
      case 'name': {
        return this.constantProperty(scope, expression)?.isConst === true;
      }
      case 'call': {
        // kotlinc folds a constant's conversions, as `1e18.toLong()`.
        const { callee } = expression;
        return (
          callee.kind === 'member' &&
          !callee.isSafe &&
          CONSTANT_CONVERSIONS.has(callee.name) &&
          expression.args.length === 0 &&
          expression.typeArgs.length === 0 &&
          !expression.trailingLambda &&
          this.isConstantExpression(scope, callee.receiver)
        );
      }
      default: {
        return false;
      }
    }
  }

  /** The property a name or `Holder.NAME` reads, when it is a top-level or an object's property. */
  private constantProperty(scope: Scope, expression: Expression): PropertySymbol | undefined {
    if (expression.kind === 'name') {
      if (this.findVariable(scope, expression.name)) return undefined;
      return (
        this.findCompanionProperty(scope, expression.name, expression.row)?.property.symbol ??
        this.topLevelPlainProperty(expression.name)
      );
    }
    if (expression.kind !== 'member' || expression.isSafe) return undefined;
    const qualifier = this.compileQualifier(scope, expression.receiver);
    if (qualifier?.kind !== 'class') return undefined;
    const holder = qualifier.cls.isObject ? qualifier.cls : qualifier.cls.companion;
    return holder && this.membersOf<PropertySymbol>(holder.type, expression.name, 'property')[0]?.symbol;
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

/** Whether a class is an opt-in marker whose uses kotlinc rejects without an opt-in: `@RequiresOptIn` at its error level. */
function isOptInMarker(cls: ClassSymbol | undefined): cls is ClassSymbol {
  const requires = cls?.isAnnotation ? cls.ownAnnotations.find(({ name }) => name === 'RequiresOptIn') : undefined;
  if (!requires) return false;
  const level =
    (requires.args ?? []).find((argument) => (argument as { name?: string }).name === 'level') ?? requires.args?.[1];
  const value = level?.value as Expression | undefined;
  return !(value && (value.kind === 'member' || value.kind === 'name') && value.name === 'WARNING');
}

/** The conversions of constants that kotlinc folds into constants. */
const CONSTANT_CONVERSIONS = new Set([
  'toByte',
  'toShort',
  'toInt',
  'toLong',
  'toFloat',
  'toDouble',
  'toChar',
  'toString',
]);

/** The properties of constants that kotlinc folds into constants: a Char's code and a String's length. */
const CONSTANT_PROPERTIES = new Set(['code', 'length']);

const CONSTANT_INFIX_OPERATORS = new Set(['shl', 'shr', 'ushr', 'and', 'or', 'xor']);

/** Whether a compiled argument is a constant only an annotation may take: an enum entry, a class literal, or an array. */
function isAnnotationConstant(compiled: Compiled, value: Expression): boolean {
  switch (value.kind) {
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
