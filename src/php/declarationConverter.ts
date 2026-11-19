// code-gauge-allow-file fileNcss 935 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import type { Node } from '@willbooster/web-tree-sitter';

import type {
  ClassDecl,
  ClassRef,
  Expr,
  FunctionDecl,
  MethodDeclAst,
  ParamDecl,
  PropertyDeclAst,
  Stmt,
  TraitRule,
} from './ast';
import { hasNullsafeReceiver } from './astAnalysis';
import { enc, lower } from './bytes';
import { parseTypeText } from './calls';
import { CompileClassConstants } from './compileClassConstants';
import {
  type Constant,
  constantTruth,
  constantTypeName,
  foldedConstant,
  foldedDefaultType,
  selectConstantBranch,
} from './constantDefaults';
import {
  BUILTIN_TYPES,
  ConverterBase,
  explicitlyQualifiedName,
  isReservedClassName,
  relativeClassName,
  semanticChildren,
  traitAdaptationModifierError,
} from './converterBase';
import { decodeLiteral, decodeSingleQuoted } from './literals';
import { compiledOperandRow } from './opcodeRows';
import { SCRIPT_PATH } from './runtime';
import { describeType, typeToString } from './types';
import { type TypeDecl, type Visibility, visibilityRank } from './values';
import { isSubtype } from './variance';

const MAGIC_METHODS: Record<
  string,
  { args?: number; isStatic?: boolean; isPublic?: boolean; returnType?: string; parameterTypes?: string[] }
> = {
  __construct: { isStatic: false, returnType: '' },
  __destruct: { args: 0, isStatic: false, returnType: '' },
  __clone: { args: 0, isStatic: false, returnType: 'void' },
  __get: { parameterTypes: ['string'], args: 1, isStatic: false, isPublic: true },
  __set: { parameterTypes: ['string'], args: 2, isStatic: false, isPublic: true, returnType: 'void' },
  __isset: { parameterTypes: ['string'], args: 1, isStatic: false, isPublic: true, returnType: 'bool' },
  __unset: { parameterTypes: ['string'], args: 1, isStatic: false, isPublic: true, returnType: 'void' },
  __call: { parameterTypes: ['string', 'array'], args: 2, isStatic: false, isPublic: true },
  __callstatic: { parameterTypes: ['string', 'array'], args: 2, isStatic: true, isPublic: true },
  __tostring: { args: 0, isStatic: false, isPublic: true, returnType: 'string' },
  __debuginfo: { args: 0, isStatic: false, isPublic: true, returnType: '?array' },
  __invoke: { isStatic: false, isPublic: true },
  __serialize: { args: 0, isStatic: false, isPublic: true, returnType: 'array' },
  __unserialize: { parameterTypes: ['array'], args: 1, isStatic: false, isPublic: true, returnType: 'void' },
  __set_state: { parameterTypes: ['array'], args: 1, isStatic: true, isPublic: true, returnType: 'object' },
};

/** Converts the declarations of functions, parameters, types, and classes. */
export abstract class DeclarationConverter extends ConverterBase {
  private readonly compileClasses = new CompileClassConstants(() => this.compileBudget);
  private runtimeDefinitionKeys = 0;
  private activeClass?: ClassDecl;
  protected initializerContext?: {
    kind: 'eager' | 'deferred' | 'static' | 'array';
    row: number;
    propertyName?: string;
  };

  protected get constantInitializer(): boolean {
    return this.initializerContext?.kind === 'eager' || this.initializerContext?.kind === 'deferred';
  }

  protected override classRef(
    node: Node,
    deferScope = false,
    use: 'name' | 'constant' | 'reference' = 'reference'
  ): ClassRef {
    const ref = super.classRef(node, deferScope, use);
    if (!this.preserveSyntax && use !== 'name' && ref.k === 'expr') {
      const value = this.compiledValue(ref.e, use === 'constant');
      if (value !== undefined && typeof value !== 'string') this.error(node, 'Illegal class name');
      if (node.type === 'parenthesized_expression') {
        if (value === undefined) {
          const expression = use === 'constant' ? selectConstantBranch(ref.e, { budget: this.compileBudget }) : ref.e;
          ref.fetchRow = compiledOperandRow(expression);
        } else if (node.parent?.type !== 'object_creation_expression')
          ref.fetchRow = semanticChildren(node.parent ?? node).at(-1)?.startPosition.row;
      }
    }
    return ref;
  }

  protected compiledType(expression: Expr): string | undefined {
    const value = this.compiledValue(expression);
    return value === undefined ? undefined : constantTypeName(value);
  }

  protected compiledValue(expression: Expr, classConstantName = false): Constant | undefined {
    return foldedConstant(expression, {
      compiler: !classConstantName,
      magic: classConstantName ? (token) => this.compiledMagic(token) : undefined,
      budget: this.compileBudget,
      classConstant: this.compileClasses.lookup(this.activeClass, this.fn.isClosure),
      className: (cls) => this.compileClasses.className(cls, this.activeClass, this.fn.isClosure),
    });
  }

  protected compiledMagic(token: Extract<Expr, { k: 'magic' }>['name']): string | undefined {
    switch (token) {
      case '__CLASS__': {
        if (this.currentClassKind === 'trait') return undefined;
        return this.activeClass?.fullName ?? this.currentClass ?? '';
      }
      case '__TRAIT__': {
        return this.currentClassKind === 'trait' ? this.currentClass : '';
      }
      case '__FUNCTION__': {
        return this.fn.name ?? '';
      }
      case '__METHOD__': {
        if (this.fn.isMethod) return this.fn.displayName?.slice(0, -2);
        if (this.activeClass && !this.fn.isClosure) return '';
        return this.fn.name ?? '';
      }
    }
  }

  protected functionDecl(node: Node, isClosure: boolean, className?: string): FunctionDecl {
    if (isClosure || className !== undefined || this.currentClass === undefined) {
      return this.convertFunction(node, isClosure, className);
    }
    return this.withClassContext(undefined, () => this.convertFunction(node, false));
  }

  // code-gauge-allow functionNcss 44 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
  // code-gauge-allow functionCognitiveComplexity 23 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
  private convertFunction(node: Node, isClosure: boolean, className?: string): FunctionDecl {
    const attributes = node.childForFieldName('attributes');
    if (attributes) this.unsupported(attributes, '属性（#[...]）');
    const nameNode = node.childForFieldName('name');
    const rawName = nameNode ? this.nameText(nameNode) : '';
    const name = isClosure
      ? `{closure:${this.fn.displayName ?? SCRIPT_PATH}:${node.startPosition.row + 1}}`
      : className === undefined
        ? this.qualify(rawName)
        : rawName;
    const returnTypeNode = node.childForFieldName('return_type');
    const body = node.childForFieldName('body');
    const byRefReturn =
      node.childForFieldName('reference_modifier') !== null ||
      node.children.some((child) => child.type === 'reference_modifier');
    const outerFn = this.fn;
    const lexicalClass = className ?? (isClosure ? outerFn.className : undefined);
    const displayClass = className ? (this.activeClass?.fullName ?? className) : undefined;
    const outerLoop = this.loop;
    const outerInitializer = this.initializerContext;
    if (outerInitializer?.kind !== 'deferred') this.initializerContext = undefined;
    this.fn = {
      isGenerator: false,
      byRefReturn,
      labels: new Set(),
      gotos: [],
      className: lexicalClass,
      isMethod: className !== undefined,
      isFunction: true,
      isClosure,
      name,
      displayName: isClosure ? name : `${displayClass === undefined ? '' : `${displayClass}::`}${name}()`,
    };
    this.loop = { depth: 0, switches: [] };
    try {
      const returnType = returnTypeNode ? this.typeDecl(returnTypeNode) : undefined;
      this.fn.returnType = returnType;
      if (returnTypeNode && returnType) this.checkTypeScope(returnTypeNode, returnType);
      if (byRefReturn && returnType?.k === 'named' && returnType.name === 'void')
        this.notices.push({
          level: 'Deprecated',
          message: `${this.fn.displayName}${isClosure ? '()' : ''}: Returning by reference from a void function is deprecated`,
          row: node.startPosition.row,
        });
      const params = this.params(node.childForFieldName('parameters') as Node, name, className);
      if (!body && className !== undefined && lower(name) === '__construct' && params.some((param) => param.promote))
        this.error(node, 'Cannot declare promoted property in an abstract constructor');
      const isAtomic = this.claimAtomic(node, body);
      let statements: Stmt[] = [];
      let arrowBody: Expr | undefined;
      if (node.type === 'arrow_function') {
        this.checkVoidReturn(body as Node);
        arrowBody = this.expr(body as Node);
        this.checkReferenceReturn(body as Node, arrowBody);
      } else if (body) {
        statements = this.block(body);
      }
      this.checkGotos(this.fn, statements);
      return {
        name,
        params,
        returnType,
        byRefReturn,
        body: statements,
        arrowBody,
        row: node.startPosition.row,
        endRow: node.endPosition.row,
        isAtomic,
        usesThis: this.fn.usesThis === true,
        hasGoto: this.fn.gotos.length > 0,
        namespace: this.namespace,
        className: lexicalClass,
        isClosure,
      };
    } finally {
      this.fn = outerFn;
      this.initializerContext = outerInitializer;
      this.loop = outerLoop;
    }
  }

  protected checkVoidReturn(node: Node): void {
    const type = this.fn.returnType;
    if (type?.k !== 'named' || type.name !== 'void') return;
    const isNull = lower(node.text.trim()) === 'null';
    const message = isNull
      ? 'A void function must not return a value (did you mean "return;" instead of "return null;"?)'
      : 'A void function must not return a value';
    this.error(node, message);
  }

  protected checkReferenceReturn(node: Node, expression: Expr): void {
    if (this.fn.byRefReturn && ['prop', 'idx', 'sprop'].includes(expression.k) && hasNullsafeReceiver(expression))
      this.error(node, 'Cannot take reference of a nullsafe chain');
  }

  // code-gauge-allow functionNcss 58 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  protected params(node: Node, functionName: string, className?: string): ParamDecl[] {
    const params: ParamDecl[] = [];
    const seen = new Set<string>();
    for (const child of node.namedChildren) {
      if (child.type === 'comment') continue;
      const attributes = child.childForFieldName('attributes');
      if (attributes) this.unsupported(attributes, '属性（#[...]）');
      const nameNode = child.childForFieldName('name') as Node;
      const promotedReference = nameNode.type === 'by_ref';
      const name = this.variableName(promotedReference ? semanticChildren(nameNode)[0] : nameNode);
      if (name === 'this') this.error(child, '$this は引数の名前に使えません（Cannot use $this as parameter）。');
      if (name === 'GLOBALS') this.error(child, 'Cannot re-assign auto-global variable GLOBALS');
      if (seen.has(name))
        this.error(child, `引数の名前 $${name} が重なっています（Redefinition of parameter $${name}）。`);
      seen.add(name);
      const typeNode = child.childForFieldName('type');
      if (typeNode && lower(typeNode.text) === 'abstract')
        this.error(typeNode, 'Cannot use the abstract modifier on a parameter');
      const type = typeNode ? this.typeDecl(typeNode, true) : undefined;
      if (type?.k === 'named' && ['void', 'never'].includes(type.name))
        this.error(child, 'void and never cannot be parameter types');
      if (typeNode && type) this.checkTypeScope(typeNode, type);
      const defaultNode = child.childForFieldName('default_value');
      const expression = defaultNode ? this.constantExpr(defaultNode, true, 'deferred') : undefined;
      const defaultExpr: Expr | undefined =
        expression?.k === 'const' && lower(expression.name.name) === 'null'
          ? { k: 'lit', v: null, row: expression.row }
          : expression;
      const byRef = promotedReference || child.childForFieldName('reference_modifier') !== null;
      const variadic = child.type === 'variadic_parameter';
      if (params.at(-1)?.variadic) {
        this.error(child, '可変長の引数は最後にしか書けません（Only the last parameter can be variadic）。');
      }
      if (type && defaultExpr) this.checkDefaultType(child, name, type, defaultExpr);
      const param: ParamDecl = {
        name,
        type,
        byRef,
        variadic,
        optional: defaultExpr !== undefined || variadic,
        defaultExpr,
        defaultReportRow: defaultExpr ? this.constantCompileRow(defaultExpr, child.startPosition.row, true) : undefined,
        row: child.startPosition.row,
      };
      if (child.type === 'property_promotion_parameter')
        param.promote = this.parameterPromotion(child, functionName, className);
      else if (defaultExpr?.k === 'lit' && defaultExpr.v === null && type && !typeAllowsNull(type))
        param.implicitNullable = true;
      params.push(param);
    }
    this.parameterDeprecations(params, className === undefined ? functionName : `${className}::${functionName}`);
    return params;
  }

  private parameterDeprecations(params: ParamDecl[], displayName: string): void {
    const lastRequired = params.findLastIndex((param) => !param.optional);
    for (const [index, param] of params.entries()) {
      if (param.implicitNullable) {
        this.notices.push({
          level: 'Deprecated',
          message: `${displayName}(): Implicitly marking parameter $${param.name} as nullable is deprecated, the explicit nullable type must be used instead`,
          row: param.row,
        });
      }
      if (index >= lastRequired || !param.optional || param.variadic) continue;
      if (!param.implicitNullable) {
        this.notices.push({
          level: 'Deprecated',
          message: `${displayName}(): Optional parameter $${param.name} declared before required parameter $${params[lastRequired].name} is implicitly treated as a required parameter`,
          row: param.row,
        });
      }
      param.optional = false;
      param.defaultExpr = undefined;
    }
  }

  private parameterPromotion(node: Node, functionName: string, className?: string): NonNullable<ParamDecl['promote']> {
    if (lower(functionName) !== '__construct' || className === undefined)
      this.error(
        node,
        'プロパティの昇格は、コンストラクタの引数にしか書けません（Cannot declare promoted property outside a constructor）。'
      );
    const modifiers = this.memberModifiers(node);
    if (modifiers.isStatic || modifiers.isAbstract)
      this.error(node, `Cannot use the ${modifiers.isStatic ? 'static' : 'abstract'} modifier on a parameter`);
    return {
      visibility: modifiers.visibility ?? 'public',
      isReadonly: modifiers.isReadonly,
      setVisibility: modifiers.setVisibility,
      isFinal: modifiers.isFinal,
    };
  }

  protected setVisibilityOf(node: Node): Visibility | undefined {
    const operation = node.namedChildren.find((child) => child.type === 'operation');
    if (!operation) return undefined;
    return lower(node.text.split('(')[0].trim()) as Visibility;
  }

  protected typeDecl(node: Node, parameter = false): TypeDecl {
    const type = this.parseTypeDecl(node, parameter);
    if (type.k === 'named') {
      if (parameter && type.name === 'static') this.error(node, 'Cannot use the static modifier on a parameter');
      if (type.nullable && ['mixed', 'void', 'never', 'null'].includes(type.name))
        this.error(node, `Type ${type.name} cannot be nullable`);
    } else if (type.k === 'inter') this.checkIntersection(node, type.types);
    else this.checkUnion(node, type);
    return type;
  }

  private checkIntersection(node: Node, members: TypeDecl[]): void {
    const seen = new Set<string>();
    for (const member of members) {
      if (member.k === 'named' && member.nullable)
        this.error(node, 'syntax error, unexpected token "&", expecting variable');
      const name = this.typeMemberName(member, node);
      const key = lower(name);
      if (member.k !== 'named' || BUILTIN_TYPES.has(lower(member.name)) || ['self', 'parent', 'static'].includes(key))
        this.error(node, `Type ${name} cannot be part of an intersection type`);
      if (seen.has(key)) this.error(node, `Duplicate type ${name} is redundant`);
      seen.add(key);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 26 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  private checkUnion(node: Node, type: Extract<TypeDecl, { k: 'union' }>): void {
    const seen = new Set<string>();
    for (const member of type.types) {
      if (member.k === 'named' && member.nullable) this.error(node, 'Invalid or redundant union type');
      const name = member.k === 'named' ? lower(member.name) : lower(typeToString(member));
      if (name === 'mixed') this.error(node, 'Type mixed can only be used as a standalone type');
      const components = this.unionTypeComponents(member, name, node);
      const duplicates = components.filter((part) => seen.has(lower(part)));
      if (duplicates.length > 0)
        this.error(
          node,
          `Duplicate type ${duplicates.length > 1 && name === 'bool' ? 'bool' : duplicates[0]} is redundant`
        );
      if ((name === 'true' && seen.has('false')) || (name === 'false' && seen.has('true')))
        this.error(node, 'Type contains both true and false, bool must be used instead');
      for (const part of components) seen.add(lower(part));
    }
    if (seen.has('void')) this.error(node, 'Void can only be used as a standalone type');
    if (seen.has('never')) this.error(node, 'never can only be used as a standalone type');
    if (seen.has('object') && type.types.some((part) => part.k !== 'named' || !BUILTIN_TYPES.has(lower(part.name))))
      this.error(
        node,
        `Type ${typeToString(this.resolveRelativeTypes(type, node))} contains both object and a class type, which is redundant`
      );
    this.checkRedundantIntersections(node, type.types);
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  private checkRedundantIntersections(node: Node, members: TypeDecl[]): void {
    if (!members.some((member) => member.k === 'inter')) return;
    const types = members.map((member) => {
      const name = this.typeMemberName(member, node);
      const parts = lower(name).split('&');
      return { name, parts };
    });
    for (const [index, type] of types.entries()) {
      if (type.parts.length === 1) continue;
      for (const [otherIndex, other] of types.entries()) {
        if (index === otherIndex || !other.parts.every((part) => type.parts.includes(part))) continue;
        if (type.parts.length > other.parts.length)
          this.error(node, `Type ${type.name} is redundant as it is more restrictive than type ${other.name}`);
        if (index > otherIndex) this.error(node, `Type ${type.name} is redundant with type ${other.name}`);
      }
    }
  }

  private unionTypeComponents(member: TypeDecl, name: string, node: Node): string[] {
    switch (name) {
      case 'iterable': {
        return ['array', 'Traversable'];
      }
      case 'bool': {
        return ['false', 'true'];
      }
      default: {
        return [this.typeMemberName(member, node)];
      }
    }
  }

  private typeMemberName(member: TypeDecl, node: Node): string {
    return typeToString(this.resolveRelativeTypes(member, node));
  }

  private resolveRelativeTypes(member: TypeDecl, node: Node): TypeDecl {
    if (member.k !== 'named')
      return { ...member, types: member.types.map((part) => this.resolveRelativeTypes(part, node)) };
    if (
      (member.name === 'self' || member.name === 'parent') &&
      !this.fn.isClosure &&
      this.activeClass?.kind !== 'trait'
    ) {
      this.checkClassScope(node, member.name);
      const scope = this.activeClass;
      const resolved = member.name === 'self' ? scope?.name : scope?.parent;
      if (resolved) return { ...member, name: resolved };
    }
    return member;
  }

  private parseTypeDecl(node: Node, parameter: boolean): TypeDecl {
    switch (node.type) {
      case 'primitive_type':
      case 'bottom_type': {
        return this.builtinType(node.text);
      }
      case 'named_type': {
        const inner = semanticChildren(node)[0];
        return this.typeName(inner, parameter);
      }
      case 'name':
      case 'qualified_name':
      case 'relative_name': {
        return this.typeName(node, parameter);
      }
      case 'optional_type': {
        const inner = this.typeDecl(semanticChildren(node)[0], parameter);
        return inner.k === 'named' ? { ...inner, nullable: true } : inner;
      }
      case 'union_type':
      case 'disjunctive_normal_form_type': {
        return {
          k: 'union',
          types: semanticChildren(node).map((child) => this.typeDecl(child, parameter)),
        };
      }
      case 'intersection_type': {
        return {
          k: 'inter',
          types: semanticChildren(node).map((child) => this.typeDecl(child, parameter)),
        };
      }
      case 'type_list': {
        return { k: 'union', types: semanticChildren(node).map((child) => this.typeDecl(child, parameter)) };
      }
      default: {
        const children = semanticChildren(node);
        if (children.length === 1) return this.typeDecl(children[0], parameter);
        return { k: 'union', types: children.map((child) => this.typeDecl(child, parameter)) };
      }
    }
  }

  protected constantExpr(
    node: Node,
    allowNew = false,
    context: 'eager' | 'deferred' = 'eager',
    propertyName?: string
  ): Expr {
    const expression = this.initializerExpr(node, context, propertyName);
    this.checkConstantExpr(expression, allowNew);
    return expression;
  }

  // code-gauge-allow functionCognitiveComplexity 29 -- Follows the constant-expression AST order with a shared row.
  // code-gauge-allow functionNcss 40 -- Follows the constant-expression AST order with a shared row.
  protected constantCompileRow(expression: Expr, row: number, preserveNames = false): number {
    const fold = (value: Expr): Constant | undefined =>
      foldedConstant(value, { compiler: true, preserveNamedConstants: preserveNames, budget: this.compileBudget });
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      const node = value as Expr;
      switch (node.k) {
        case 'const': {
          if (preserveNames || fold(node) === undefined) row = node.row;
          return;
        }
        case 'arrow':
        case 'closure': {
          return;
        }
        case 'array': {
          for (const item of node.items) {
            visit(item.value);
            visit(item.key);
          }
          return;
        }
        case 'cond': {
          const test = fold(node.test);
          if (test === undefined) break;
          visit(constantTruth(test) ? (node.consequent ?? node.test) : node.alternate);
          return;
        }
        case 'bin': {
          if (['??', '&&', 'and', '||', 'or'].includes(node.op) && fold(node) !== undefined) return;
          break;
        }
        case 'newAnon': {
          visit(node.args);
          return;
        }
      }
      for (const child of Object.values(value)) visit(child);
    };
    visit(expression);
    return row;
  }

  protected initializerExpr(node: Node, kind: 'eager' | 'deferred' | 'static', propertyName?: string): Expr {
    const outer = this.initializerContext;
    this.initializerContext = { kind, row: node.startPosition.row, propertyName };
    try {
      return this.expr(node);
    } finally {
      this.initializerContext = outer;
    }
  }

  private checkConstantExpr(expression: Expr, allowNew: boolean): void {
    const check = (value: Expr): void => this.checkConstantExpr(value, allowNew);
    const invalid = (): never => this.error(expression.row, 'Constant expression contains invalid operations');
    const className = (cls: ClassRef, suffix = ''): void => {
      if (cls.k === 'static') {
        const message =
          suffix === 'class'
            ? 'static::class cannot be used for compile-time class name resolution'
            : suffix
              ? '"static::" is not allowed in compile-time constants'
              : '"static" is not allowed in compile-time constants';
        this.error(expression.row, message);
      }
      if (cls.k === 'expr') invalid();
    };
    switch (expression.k) {
      case 'lit':
      case 'const':
      case 'magic': {
        return;
      }
      case 'interp': {
        for (const part of expression.parts) if (typeof part !== 'string') check(part);
        return;
      }
      case 'array': {
        for (const item of expression.items) {
          if (item.byRef) invalid();
          if (item.key) check(item.key);
          check(item.value);
        }
        return;
      }
      case 'idx': {
        check(expression.base);
        if (!expression.index) return invalid();
        check(expression.index);
        return;
      }
      case 'bin': {
        check(expression.l);
        check(expression.r);
        return;
      }
      case 'unary': {
        if (!['+', '-', '~', '!'].includes(expression.op)) invalid();
        check(expression.e);
        return;
      }
      case 'cast': {
        if (expression.type === 'object') invalid();
        check(expression.e);
        return;
      }
      case 'cond': {
        check(expression.test);
        if (expression.consequent) check(expression.consequent);
        check(expression.alternate);
        return;
      }
      case 'cconst': {
        className(expression.cls, expression.className ? 'class' : 'constant');
        if (typeof expression.name !== 'string') check(expression.name);
        return;
      }
      case 'call': {
        if (!expression.fcc || 'k' in expression.fn) invalid();
        return;
      }
      case 'scall': {
        if (!expression.fcc || typeof expression.name !== 'string') return invalid();
        className(expression.cls, expression.name);
        return;
      }
      case 'new': {
        if (!allowNew) invalid();
        className(expression.cls);
        for (const arg of expression.args) {
          if (arg.spread) this.error(expression.row, 'Argument unpacking in constant expressions is not supported');
          check(arg.e);
        }
        return;
      }
      case 'newAnon': {
        this.error(expression.row, 'Cannot use anonymous class in constant expression');
      }
      case 'closure': {
        if (!expression.isStatic) this.error(expression.row, 'Closures in constant expressions must be static');
        if (expression.uses.length > 0) this.error(expression.row, 'Cannot use(...) variables in constant expression');
        return;
      }
      default: {
        invalid();
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity 18 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  private checkDefaultType(node: Node, name: string, type: TypeDecl, value: Expr, property?: ClassDecl): void {
    const literalType = foldedDefaultType(value, {
      budget: this.compileBudget,
      preserveNamedConstants: !property,
      magic: (token) => this.compiledMagic(token),
      classConstant: property ? this.compileClasses.lookup(property) : undefined,
      className: property ? (cls) => this.compileClasses.className(cls, property) : undefined,
    });
    if (literalType === 'null' && !property && node.type !== 'property_promotion_parameter') return;
    if (literalType === undefined || defaultFits(type, literalType)) return;
    const display = describeType(
      type,
      property && property.kind !== 'trait' && !property.isAnonymous
        ? {
            name: property.name,
            parent: property.parent ? { name: property.parent } : undefined,
          }
        : undefined
    );
    if (property && literalType === 'null' && type.k !== 'inter') {
      const text = display;
      this.error(
        node,
        `Default value for property of type ${text} may not be null. Use the nullable type ${type.k === 'named' && type.name !== 'iterable' ? '?' + text : text + '|null'} to allow null default value`
      );
    }
    this.error(
      node,
      `型に合わない既定値です（Cannot use ${literalType === 'true' || literalType === 'false' ? 'bool' : literalType} as default value for ${property ? `property ${property.name}::$${name}` : `parameter $${name}`} of type ${display}）。`
    );
  }

  /** Checks the `self`, `static`, and `parent` a declared type names, as {@link checkClassScope} does. */
  protected checkTypeScope(node: Node, type: TypeDecl): void {
    if (this.preserveSyntax) return;
    if (type.k !== 'named') {
      for (const part of type.types) this.checkTypeScope(node, part);
      return;
    }
    if (type.name === 'self' || type.name === 'static' || type.name === 'parent') this.checkClassScope(node, type.name);
  }

  protected typeName(node: Node, parameter: boolean): TypeDecl {
    const raw = this.nameText(node);
    const word = lower(raw);
    if (BUILTIN_TYPES.has(word)) return this.builtinType(raw);
    const explicit = explicitlyQualifiedName(word);
    if (
      explicit &&
      ((BUILTIN_TYPES.has(explicit) && explicit !== 'array' && explicit !== 'callable') || explicit === 'static')
    )
      this.error(node, `Type declaration '${explicit}' must be unqualified`);
    const relative = relativeClassName(raw);
    if (relative) return this.builtinType(raw, relative);
    const typeNode = node.parent?.type === 'named_type' ? node.parent : node;
    const parent = typeNode.parent;
    const root = parent?.type === 'property_declaration' || parent?.type.endsWith('_parameter');
    const expected = root && (parameter || parent?.type === 'property_declaration') ? 'variable' : '';
    const name = this.namedClass(node, expected);
    const last = name.slice(name.lastIndexOf('\\') + 1);
    if (isReservedClassName(last)) this.error(node, `Cannot use "${name}" as a type name as it is reserved`);
    return { k: 'named', name };
  }

  private builtinType(raw: string, name = lower(raw)): TypeDecl {
    const keyword = name === 'array' || name === 'callable' || name === 'static';
    return { k: 'named', name, syntaxName: this.preserveSyntax && !keyword ? raw : undefined };
  }

  // Classes -----------------------------------------------------------------------------------------------------------

  // code-gauge-allow functionNcss 48 -- Builds one declaration and validates its scoped members in source order.
  // code-gauge-allow functionCognitiveComplexity 30 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
  classDecl(node: Node, anonymous = false, topLevel = true): ClassDecl {
    this.checkUnscopedModifiers(node);
    if (!this.preserveSyntax && !anonymous && this.currentClass !== undefined)
      this.error(node, 'Class declarations may not be nested');
    const attributes = node.childForFieldName('attributes');
    if (attributes) this.unsupported(attributes, '属性（#[...]）');
    const kind: ClassDecl['kind'] =
      node.type === 'interface_declaration' ? 'interface' : node.type === 'trait_declaration' ? 'trait' : 'class';
    const nameNode = node.childForFieldName('name');
    let name = '';
    if (!anonymous) {
      const raw = this.declaredIdentifier(nameNode as Node);
      if (isReservedClassName(raw)) {
        this.error(
          node,
          `「${raw}」はクラスの名前に使えません（Cannot use '${raw}' as class name as it is reserved）。`
        );
      }
      name = this.qualify(raw);
    }
    const modifiers = node.children;
    const base = node.namedChildren.find((child) => child.type === 'base_clause');
    const baseNames = base
      ? base.namedChildren.filter((child) => child.type !== 'comment').map((child) => this.namedClass(child, '', kind))
      : [];
    const implementsClause = node.namedChildren.find((child) => child.type === 'class_interface_clause');
    let interfaces = implementsClause
      ? implementsClause.namedChildren
          .filter((child) => child.type !== 'comment')
          .map((child) => this.namedClass(child, '', 'interface'))
      : [];
    let parent: string | undefined;
    if (kind === 'interface') interfaces = baseNames;
    else {
      if (baseNames.length > 1) this.error(base ?? node, 'syntax error, unexpected token ",", expecting "{"');
      parent = baseNames[0];
    }
    let fullName: string | undefined;
    if (anonymous) {
      name = `${parent ?? interfaces[0] ?? 'class'}@anonymous`;
      const runtimeIndex = this.runtimeDefinitionKeys++;
      fullName = `${name}\0${SCRIPT_PATH}:${node.startPosition.row + 1}$${runtimeIndex.toString(16)}`;
    }
    const decl: ClassDecl = {
      name,
      fullName,
      kind,
      parent,
      interfaces,
      isAbstract: modifiers.some((child) => child.type === 'abstract_modifier'),
      isFinal: modifiers.some((child) => child.type === 'final_modifier'),
      isReadonly: modifiers.some((child) => child.type === 'readonly_modifier'),
      consts: [],
      props: [],
      methods: [],
      traits: [],
      syntaxMembers: this.preserveSyntax ? [] : undefined,
      row: node.startPosition.row,
      endRow: node.endPosition.row,
      isAnonymous: anonymous,
    };
    if (!this.preserveSyntax) this.validateClassModifiers(node, decl);
    this.withClassContext(decl, () => {
      const body = node.childForFieldName('body') as Node;
      const memberNames = new Set<string>();
      for (const member of body.namedChildren) this.classMember(member, decl, memberNames);
    });
    if (!this.preserveSyntax) {
      const abstractMethod = anonymous ? decl.methods.find((method) => method.isAbstract) : undefined;
      if (abstractMethod)
        this.error(abstractMethod.fn.row, `Anonymous class method ${abstractMethod.fn.name}() must not be abstract`);
      this.addPromotedProperties(decl);
      if (!anonymous && (!topLevel || !this.compileClasses.bind(decl))) this.runtimeDefinitionKeys++;
    }
    return decl;
  }

  private addPromotedProperties(decl: ClassDecl): void {
    const constructor = decl.methods.find((method) => lower(method.fn.name) === '__construct');
    if (constructor) {
      for (const param of constructor.fn.params) {
        if (!param.promote) continue;
        if (decl.props.some((prop) => prop.name === param.name)) {
          this.error(
            param.row,
            `プロパティ ${decl.name}::$${param.name} は、すでに宣言されています（Cannot redeclare ${decl.name}::$${param.name}）。`
          );
        }
        if (param.variadic)
          this.error(
            param.row,
            '可変長引数はプロパティに昇格できません（Cannot declare variadic promoted property）。'
          );
        this.checkPropertyType(param.row, decl.name, {
          ...param.promote,
          name: param.name,
          type: param.type,
          isReadonly: param.promote.isReadonly || decl.isReadonly,
          isStatic: false,
        });
        decl.props.push({
          name: param.name,
          visibility: param.promote.visibility,
          setVisibility: param.promote.setVisibility,
          isStatic: false,
          isReadonly: param.promote.isReadonly || decl.isReadonly,
          type: param.type,
          defaultExpr: undefined,
          row: param.row,
          isAbstract: false,
          isFinal: param.promote.isFinal,
          promoted: true,
        });
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity 22 -- Chooses the PHP parser expectation from the prefix already read.
  protected checkUnscopedModifiers(node: Node): void {
    const classModifiers = new Set(['abstract_modifier', 'final_modifier', 'readonly_modifier']);
    const namedClass = node.type === 'class_declaration';
    const anonymous = node.type === 'anonymous_class';
    let expectingClass = false;
    for (const child of node.children) {
      if (child.type === 'comment' || child.type === 'attribute_list') continue;
      if (!child.type.endsWith('_modifier')) break;
      if (classModifiers.has(child.type) && node.type !== 'const_declaration') {
        expectingClass = true;
        continue;
      }
      const following = child.nextSibling;
      if (expectingClass)
        this.error(
          child,
          `syntax error, unexpected token "${lower(child.text)}", expecting "abstract" or "final" or "readonly" or "class"`
        );
      if (anonymous) this.error(child, `syntax error, unexpected token "${lower(child.text)}", expecting "class"`);
      if (child.type === 'static_modifier' && following)
        this.error(following, `syntax error, unexpected token "${lower(following.text)}", expecting "::"`);
      const end = node.parent?.type === 'program' ? ', expecting end of file' : '';
      this.error(child, `syntax error, unexpected token "${lower(child.text)}"${end}`);
    }
    if (expectingClass && !namedClass && !anonymous) {
      const keyword = node.children.find((child) => ['interface', 'trait', 'enum'].includes(child.type));
      if (keyword)
        this.error(
          keyword,
          `syntax error, unexpected token "${keyword.type}", expecting "abstract" or "final" or "readonly" or "class"`
        );
    }
  }

  private validateClassModifiers(node: Node, decl: ClassDecl): void {
    const seen = new Set<string>();
    for (const child of node.children) {
      if (!['abstract_modifier', 'final_modifier', 'readonly_modifier'].includes(child.type)) continue;
      const modifier = child.type.replace('_modifier', '');
      if (seen.has(modifier)) this.error(child, `Multiple ${modifier} modifiers are not allowed`);
      seen.add(modifier);
      if (decl.isAnonymous && modifier !== 'readonly')
        this.error(child, `Cannot use the ${modifier} modifier on an anonymous class`);
    }
    if (decl.isAbstract && decl.isFinal) this.error(node, 'Cannot use the final modifier on an abstract class');
  }

  // code-gauge-allow functionNcss 35 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
  private classMember(member: Node, decl: ClassDecl, methodNames: Set<string>): void {
    switch (member.type) {
      case 'const_declaration': {
        const start = decl.consts.length;
        this.classConsts(member, decl, decl.kind);
        decl.syntaxMembers?.push({ k: 'const', items: decl.consts.slice(start) });
        return;
      }
      case 'property_declaration': {
        const start = decl.props.length;
        this.properties(member, decl, decl.kind);
        decl.syntaxMembers?.push({
          k: 'property',
          items: decl.props.slice(start),
          explicitReadonly: member.children.some((child) => child.type === 'readonly_modifier'),
        });
        return;
      }
      case 'method_declaration': {
        const method = this.methodDecl(member, decl);
        const key = lower(method.fn.name);
        if (!this.preserveSyntax && methodNames.has(key))
          this.error(
            member,
            `メソッド ${decl.name}::${method.fn.name}() は、すでに宣言されています（Cannot redeclare ${decl.name}::${method.fn.name}()）。`
          );
        methodNames.add(key);
        decl.methods.push(method);
        decl.syntaxMembers?.push({ k: 'method', method });
        return;
      }
      case 'use_declaration': {
        if (decl.kind === 'interface') this.error(member, 'インターフェースではトレイトを使えません。');
        const trait = this.traitUse(member);
        decl.traits.push(trait);
        decl.syntaxMembers?.push({
          k: 'use',
          trait,
          hasBlock: member.namedChildren.some((child) => child.type === 'use_list'),
        });
        return;
      }
      case 'comment': {
        return;
      }
      case 'enum_case': {
        this.unsupported(member, '列挙型（enum）');
        return;
      }
      default: {
        this.error(member, '書き方に誤りがあります。');
      }
    }
  }

  private withClassContext<T>(decl: ClassDecl | undefined, convert: () => T): T {
    const outer = this.activeClass;
    this.setClassContext(decl);
    try {
      return convert();
    } finally {
      this.setClassContext(outer);
    }
  }

  private setClassContext(decl: ClassDecl | undefined): void {
    this.activeClass = decl;
    this.currentClass = decl?.name;
    this.currentClassKind = decl?.kind;
    this.currentClassHasParent = decl?.parent !== undefined;
  }

  protected memberModifiers(member: Node): {
    visibility?: Visibility;
    setVisibility?: Visibility;
    isStatic: boolean;
    isAbstract: boolean;
    isFinal: boolean;
    isReadonly: boolean;
    isVar: boolean;
  } {
    const children = member.children;
    if (!this.preserveSyntax)
      this.checkMemberModifiers(
        member,
        children.filter((child) => child.type.endsWith('_modifier'))
      );
    const visibilityNodes = children.filter((child) => child.type === 'visibility_modifier');
    // `public private(set)` names the read visibility and the write visibility separately.
    const setNode = visibilityNodes.find((child) => this.setVisibilityOf(child) !== undefined);
    const getNode = visibilityNodes.find((child) => child !== setNode);
    return {
      visibility: getNode ? (lower(getNode.text.trim()) as Visibility) : setNode ? 'public' : undefined,
      setVisibility: setNode ? this.setVisibilityOf(setNode) : undefined,
      isStatic: children.some((child) => child.type === 'static_modifier'),
      isAbstract: children.some((child) => child.type === 'abstract_modifier'),
      isFinal: children.some((child) => child.type === 'final_modifier'),
      isReadonly: children.some((child) => child.type === 'readonly_modifier'),
      isVar: children.some((child) => child.type === 'var_modifier'),
    };
  }

  // code-gauge-allow functionCognitiveComplexity 18 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
  private checkMemberModifiers(member: Node, modifiers: Node[]): void {
    const varModifier = modifiers.find((node) => node.type === 'var_modifier');
    if (varModifier) {
      const following =
        modifiers[1] ?? member.children.find((node) => node.type === 'function' || node.type === 'const');
      if (following)
        this.error(following, `syntax error, unexpected token "${lower(following.text)}", expecting variable`);
    }
    const kinds = new Set<string>();
    for (const modifier of modifiers) {
      const visibility = modifier.type === 'visibility_modifier';
      const kind = visibility && this.setVisibilityOf(modifier) ? 'set_visibility' : modifier.type;
      if (member.type === 'const_declaration' && kind !== 'visibility_modifier' && kind !== 'final_modifier') {
        this.error(
          member,
          `Cannot use the ${lower(modifier.text).replaceAll(/\s+/g, '')} modifier on a class constant`
        );
      }
      if (kinds.has(kind)) {
        const label = visibility ? 'access type' : modifier.type.replace(/_modifier$/, '');
        this.error(member, `Multiple ${label} modifiers are not allowed`);
      }
      kinds.add(kind);
    }
    if (kinds.has('abstract_modifier') && kinds.has('final_modifier'))
      this.error(member, 'Cannot use the final modifier on an abstract class member');
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  protected classConsts(member: Node, decl: ClassDecl, kind: ClassDecl['kind']): void {
    const attributes = member.childForFieldName('attributes');
    if (attributes) this.unsupported(attributes, '属性（#[...]）');
    const modifiers = this.memberModifiers(member);
    const typeNode = member.childForFieldName('type');
    for (const element of member.namedChildren.filter((child) => child.type === 'const_element')) {
      const [nameNode, valueNode] = element.namedChildren.filter((part) => part.type !== 'comment');
      const name = this.nameText(nameNode);
      if (!this.preserveSyntax && modifiers.isFinal && modifiers.visibility === 'private')
        this.error(
          element,
          `Private constant ${decl.name}::${name} cannot be final as it is not visible to other classes`
        );
      if (!this.preserveSyntax && lower(name) === 'class')
        this.error(
          element,
          "class という名前の定数は宣言できません（A class constant must not be called 'class'; it is reserved for class name fetching）。"
        );
      if (!this.preserveSyntax && decl.consts.some((constant) => constant.name === name)) {
        this.error(
          element,
          `定数 ${decl.name}::${name} は、すでに宣言されています（Cannot redefine class constant ${decl.name}::${name}）。`
        );
      }
      if (!this.preserveSyntax && kind === 'interface' && modifiers.visibility && modifiers.visibility !== 'public') {
        this.error(element, 'インターフェースの定数は public にしてください。');
      }
      const constantType = typeNode ? this.typeDecl(typeNode) : undefined;
      const constantValue = this.constantExpr(valueNode);
      decl.consts.push({
        name,
        value: constantValue,
        visibility: modifiers.visibility ?? 'public',
        isFinal: modifiers.isFinal,
        row: element.startPosition.row,
        type: constantType,
      });
      if (this.preserveSyntax) continue;
      const folded = this.compileClasses.add(decl, name, constantValue, constantType, (token) =>
        this.compiledMagic(token)
      );
      if (folded !== undefined && constantType && !defaultFits(constantType, folded)) {
        const actual = folded === 'true' || folded === 'false' ? 'bool' : folded;
        this.error(
          element,
          `Cannot use ${actual} as value for class constant ${decl.name}::${name} of type ${typeToString(constantType)}`
        );
      }
    }
  }

  private checkPropertyType(
    node: Node | number,
    className: string,
    property: Pick<PropertyDeclAst, 'name' | 'type' | 'isReadonly' | 'isStatic' | 'visibility' | 'setVisibility'>
  ): void {
    const { name, type, isReadonly, isStatic, visibility, setVisibility } = property;
    if (setVisibility && visibilityRank(visibility) < visibilityRank(setVisibility))
      this.error(node, `Visibility of property ${className}::$${name} must not be weaker than set visibility`);
    if (
      type &&
      (type.k === 'named'
        ? ['void', 'never', 'callable'].includes(type.name)
        : type.types.some((part) => part.k === 'named' && ['void', 'never', 'callable'].includes(part.name)))
    )
      this.error(node, 'Property cannot have type void, never or callable');
    if (isReadonly && !type && !isStatic)
      this.error(
        node,
        `readonly のプロパティには型が必要です（Readonly property ${className}::$${name} must have type）。`
      );
    if (setVisibility && !type)
      this.error(node, `Property with asymmetric visibility ${className}::$${name} must have type`);
    if (isReadonly && isStatic)
      this.error(node, 'static のプロパティは readonly にできません（Static property cannot be readonly）。');
  }

  // code-gauge-allow functionNcss 39 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  protected properties(member: Node, decl: ClassDecl, kind: ClassDecl['kind']): void {
    const attributes = member.childForFieldName('attributes');
    if (attributes) this.unsupported(attributes, '属性（#[...]）');
    if (kind === 'interface' && !member.namedChildren.some((child) => child.type === 'property_hook_list')) {
      this.error(
        member,
        'インターフェースにはプロパティを宣言できません（Interfaces may only include hooked properties）。'
      );
    }
    const modifiers = this.memberModifiers(member);
    if (kind === 'interface' && modifiers.visibility !== undefined && modifiers.visibility !== 'public')
      this.error(member, 'Property in interface cannot be protected or private');
    const typeNode = member.childForFieldName('type');
    const type = typeNode ? this.typeDecl(typeNode) : undefined;
    if (typeNode && type) this.checkTypeScope(typeNode, type);
    const isReadonly = modifiers.isReadonly || decl.isReadonly;
    const hookList = member.namedChildren.find((child) => child.type === 'property_hook_list');
    if (hookList && isReadonly) this.error(hookList, 'Hooked properties cannot be readonly');
    for (const element of member.namedChildren.filter((child) => child.type === 'property_element')) {
      const name = this.variableName(element.childForFieldName('name') as Node);
      if (!this.preserveSyntax && decl.props.some((prop) => prop.name === name)) {
        this.error(
          element,
          `プロパティ ${decl.name}::$${name} は、すでに宣言されています（Cannot redeclare ${decl.name}::$${name}）。`
        );
      }
      this.checkPropertyType(element, decl.name, {
        ...modifiers,
        visibility: modifiers.visibility ?? 'public',
        name,
        type,
        isReadonly,
      });
      const defaultNode = element.childForFieldName('default_value');
      if (defaultNode && isReadonly) {
        this.error(
          element,
          `readonly のプロパティには初期値を書けません（Readonly property ${decl.name}::$${name} cannot have default value）。`
        );
      }
      const defaultExpr = defaultNode ? this.constantExpr(defaultNode, false, 'eager', name) : undefined;
      if (type && defaultExpr) this.checkDefaultType(element, name, type, defaultExpr, decl);
      const prop: PropertyDeclAst = {
        name,
        visibility: modifiers.visibility ?? 'public',
        setVisibility: modifiers.setVisibility,
        isStatic: modifiers.isStatic,
        isReadonly,
        type,
        defaultExpr,
        row: element.startPosition.row,
        isAbstract: modifiers.isAbstract,
        isFinal: modifiers.isFinal,
      };
      if (hookList && modifiers.isStatic) this.error(hookList, 'Cannot declare hooks for static property');
      if (modifiers.isAbstract && !hookList) this.error(member, 'Only hooked properties may be declared abstract');
      if (modifiers.isAbstract && hookList && !hookList.namedChildren.some((hook) => !hook.childForFieldName('body')))
        this.error(member, `Abstract property ${decl.name}::$${name} must specify at least one abstract hook`);
      if (hookList) this.hooks(hookList, prop, decl.name);
      decl.props.push(prop);
    }
  }

  protected hooks(list: Node, prop: PropertyDeclAst, className: string): void {
    const declarations = list.namedChildren.filter((child) => child.type === 'property_hook');
    const kinds = new Set<string>();
    for (const hook of declarations) {
      const kind = lower(hook.namedChildren.find((child) => child.type === 'name')?.text ?? '');
      if (kinds.has(kind)) this.error(hook, `Cannot redeclare property hook "${kind}"`);
      kinds.add(kind);
      const parameters = hook.childForFieldName('parameters');
      if (kind === 'get' && parameters)
        this.error(hook, `get hook of property ${className}::$${prop.name} must not have a parameter list`);
      if (
        kind === 'set' &&
        parameters &&
        parameters.namedChildren.filter((child) => child.type !== 'comment').length !== 1
      )
        this.error(hook, `set hook of property ${className}::$${prop.name} must accept exactly one parameters`);
    }
    const hooks: NonNullable<PropertyDeclAst['hooks']> = { syntax: this.preserveSyntax ? [] : undefined };
    for (const hook of declarations) {
      const attributes = hook.childForFieldName('attributes');
      if (attributes) this.unsupported(attributes, '属性（#[...]）');
      const kind = lower(hook.namedChildren.find((child) => child.type === 'name')?.text ?? '');
      const body = hook.childForFieldName('body');
      const paramsNode = hook.childForFieldName('parameters');
      const outerFn = this.fn;
      const outerLoop = this.loop;
      const byRefReturn = hook.childForFieldName('reference_modifier') !== null;
      if (kind === 'set' && byRefReturn)
        this.notices.push({
          level: 'Deprecated',
          message: `${className}::$${prop.name}::set(): Returning by reference from a void function is deprecated`,
          row: hook.startPosition.row,
        });
      this.fn = {
        isGenerator: false,
        byRefReturn,
        labels: new Set(),
        gotos: [],
        className,
        name: `$${prop.name}::${kind}`,
        displayName: `${this.activeClass?.fullName ?? className}::$${prop.name}::${kind}()`,
        propertyName: prop.name,
        isMethod: true,
        returnType: kind === 'set' ? { k: 'named', name: 'void' } : prop.type,
      };
      this.loop = { depth: 0, switches: [] };
      try {
        let params: ParamDecl[] = [];
        if (paramsNode) params = this.params(paramsNode, `$${prop.name}::${kind}`, className);
        if (kind === 'set' && params[0]) {
          const param = params[0];
          const prohibited = param.byRef
            ? 'be pass-by-reference'
            : param.variadic
              ? 'be variadic'
              : param.defaultExpr !== undefined
                ? 'have a default value'
                : undefined;
          if (prohibited)
            this.error(hook, `Parameter $${param.name} of set hook ${className}::$${prop.name} must not ${prohibited}`);
        }
        if (
          kind === 'set' &&
          paramsNode &&
          (prop.type
            ? !params[0]?.type ||
              (builtinType(prop.type) &&
                builtinType(params[0].type) &&
                !isSubtype(prop.type, undefined, params[0].type, undefined))
            : params[0]?.type !== undefined)
        )
          this.error(
            hook,
            `Type of parameter $${params[0]?.name ?? 'value'} of hook ${className}::$${prop.name}::set must be compatible with property type`
          );
        if (kind === 'set' && params.length === 0) {
          params = [
            {
              name: 'value',
              type: prop.type,
              byRef: false,
              variadic: false,
              optional: false,
              row: hook.startPosition.row,
            },
          ];
        }
        let statements: Stmt[] = [];
        let arrowBody: Expr | undefined;
        let syntaxExpression: Expr | undefined;
        if (body?.type === 'compound_statement') statements = this.block(body);
        else if (body) {
          arrowBody = this.expr(body);
          if (this.preserveSyntax) syntaxExpression = arrowBody;
          if (kind === 'get') this.checkReferenceReturn(body, arrowBody);
          if (kind === 'set') {
            // A short set hook assigns its expression to the property.
            statements = [
              {
                k: 'expr',
                e: {
                  k: 'assign',
                  target: {
                    k: 'prop',
                    obj: { k: 'var', name: 'this', row: body.startPosition.row },
                    name: prop.name,
                    nullsafe: false,
                    row: body.startPosition.row,
                  },
                  value: arrowBody,
                  row: body.startPosition.row,
                },
                onlyCalls: false,
                row: body.startPosition.row,
              },
            ];
            arrowBody = undefined;
          }
        }
        const usesBacking =
          body !== null &&
          ((kind === 'set' && body.type !== 'compound_statement') || referencesProperty(body, prop.name));
        const final = hook.children.some((child) => child.type === 'final_modifier');
        this.checkGotos(this.fn, statements);
        const fn: FunctionDecl = {
          name: `$${prop.name}::${kind}`,
          isPropertyHook: true,
          returnType: this.fn.returnType,
          params,
          body: statements,
          arrowBody,
          byRefReturn,
          row: hook.startPosition.row,
          endRow: hook.endPosition.row,
          isAtomic: false,
          usesThis: true,
          hasGoto: this.fn.gotos.length > 0,
          namespace: this.namespace,
          className,
          isClosure: false,
        };
        if (kind === 'get') {
          hooks.get = fn;
          hooks.abstractGet = !body;
          hooks.getBacking = usesBacking;
          hooks.finalGet = final;
        } else if (kind === 'set') {
          hooks.set = fn;
          hooks.abstractSet = !body;
          hooks.setBacking = usesBacking;
          hooks.finalSet = final;
        } else
          this.error(
            hook,
            `プロパティフック「${kind}」はありません（Unknown hook "${kind}" for property ${className}::$${prop.name}）。`
          );
        hooks.syntax?.push({
          name: kind,
          body: body?.type === 'compound_statement' ? statements : undefined,
          expression: syntaxExpression,
          isFinal: final,
          byRefReturn,
        });
      } finally {
        this.fn = outerFn;
        this.loop = outerLoop;
      }
    }
    prop.hooks = hooks;
    prop.isVirtual = !hooks.getBacking && !hooks.setBacking;
    if (prop.isVirtual && prop.defaultExpr && !this.currentClassHasParent)
      this.error(list, `Cannot specify default value for virtual hooked property ${className}::$${prop.name}`);
  }

  // code-gauge-allow functionCognitiveComplexity 24 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  protected methodDecl(member: Node, decl: ClassDecl): MethodDeclAst {
    const modifiers = this.memberModifiers(member);
    if (!this.preserveSyntax && modifiers.isReadonly)
      this.error(member, 'Cannot use the readonly modifier on a method');
    const fn = this.functionDecl(member, false, decl.name);
    const body = member.childForFieldName('body');
    if (this.preserveSyntax)
      return {
        fn,
        visibility: modifiers.visibility ?? 'public',
        isStatic: modifiers.isStatic,
        isAbstract: modifiers.isAbstract,
        isFinal: modifiers.isFinal,
        syntaxHasBody: Boolean(body),
      };
    if (decl.kind === 'interface' && (modifiers.isFinal || modifiers.isAbstract))
      this.error(member, 'Interface methods cannot have final or abstract modifiers');
    if (decl.kind === 'interface' && modifiers.visibility && modifiers.visibility !== 'public')
      this.error(member, `Access type for interface method ${decl.name}::${fn.name}() must be public`);
    const isAbstract = modifiers.isAbstract || (decl.kind === 'interface' && !body);
    if (decl.kind === 'interface' && body) {
      this.error(
        member,
        `インターフェースのメソッド ${decl.name}::${fn.name}() には本体を書けません（Interface function ${decl.name}::${fn.name}() cannot contain body）。`
      );
    }
    if (modifiers.isAbstract && body) {
      this.error(
        member,
        `abstract のメソッド ${decl.name}::${fn.name}() には本体を書けません（Abstract function ${decl.name}::${fn.name}() cannot contain body）。`
      );
    }
    if (!isAbstract && !body) {
      this.error(
        member,
        `メソッド ${decl.name}::${fn.name}() に本体がありません（Non-abstract method ${decl.name}::${fn.name}() must contain body）。`
      );
    }
    if (modifiers.isAbstract && !decl.isAbstract && decl.kind === 'class' && !decl.isAnonymous) {
      this.error(
        member,
        `abstract のメソッドを持つクラス ${decl.name} は abstract にしてください（Class ${decl.name} declares abstract method ${fn.name}() and must therefore be declared abstract）。`
      );
    }
    if (modifiers.isAbstract && modifiers.visibility === 'private' && decl.kind !== 'trait') {
      this.error(
        member,
        `abstract のメソッドは private にできません（Abstract function ${decl.name}::${fn.name}() cannot be declared private）。`
      );
    }
    this.checkMagicMethod(member, decl.name, fn, modifiers);
    if (lower(fn.name) === '__tostring' && !fn.returnType) fn.returnType = { k: 'named', name: 'string' };
    if (modifiers.isFinal && modifiers.visibility === 'private' && lower(fn.name) !== '__construct')
      this.notices.push({
        level: 'Warning',
        message: 'Private methods cannot be final as they are never overridden by other classes',
        row: member.startPosition.row,
      });
    fn.isStatic = modifiers.isStatic;
    return {
      fn,
      visibility: modifiers.visibility ?? 'public',
      isStatic: modifiers.isStatic,
      isAbstract,
      isFinal: modifiers.isFinal,
    };
  }

  /** Checks the declaration of a magic method as PHP's zend_check_magic_method_implementation does, in its order. */
  // code-gauge-allow functionCognitiveComplexity 23 -- Checks PHP's rules for each magic method in PHP's order, which decides the error shown.
  private checkMagicMethod(
    member: Node,
    className: string,
    fn: FunctionDecl,
    modifiers: { visibility?: Visibility; isStatic: boolean }
  ): void {
    const rule = MAGIC_METHODS[lower(fn.name)];
    if (!rule) return;
    const where = `${className}::${fn.name}()`;
    const fail = (english: string): void =>
      this.error(member, `マジックメソッド ${where} の宣言が PHP の決まりに合いません（${english}）。`);
    if (rule.args === 0 && fn.params.length > 0) fail(`Method ${where} cannot take arguments`);
    else if (rule.args !== undefined && fn.params.length !== rule.args) {
      fail(`Method ${where} must take exactly ${rule.args} argument${rule.args === 1 ? '' : 's'}`);
    }
    if (rule.args !== undefined && fn.params.some((param) => param.byRef))
      fail(`Method ${where} cannot take arguments by reference`);
    if (rule.isStatic === false && modifiers.isStatic) fail(`Method ${where} cannot be static`);
    if (rule.isStatic === true && !modifiers.isStatic) fail(`Method ${where} must be static`);
    if (rule.isPublic && modifiers.visibility !== undefined && modifiers.visibility !== 'public') {
      this.notices.push({
        level: 'Warning',
        message: `The magic method ${where} must have public visibility`,
        row: member.startPosition.row,
      });
    }
    for (const [index, expected] of (rule.parameterTypes ?? []).entries()) {
      const param = fn.params[index];
      if (param?.type && !isSubtype(parseTypeText(expected), undefined, param.type, undefined))
        fail(`${where}: Parameter #${index + 1} ($${param.name}) must be of type ${expected} when declared`);
    }
    if (fn.returnType === undefined || rule.returnType === undefined) return;
    if (rule.returnType === '') fail(`Method ${where} cannot declare a return type`);
    else if (!isSubtype(fn.returnType, undefined, parseTypeText(rule.returnType), undefined)) {
      fail(`${className}::${fn.name}(): Return type must be ${rule.returnType} when declared`);
    }
  }

  protected traitUse(member: Node): ClassDecl['traits'][number] {
    const names = member.namedChildren
      .filter((child) => child.type === 'name' || child.type === 'qualified_name' || child.type === 'relative_name')
      .map((child) => this.namedClass(child, '', 'trait'));
    const rules: TraitRule[] = [];
    const list = member.namedChildren.find((child) => child.type === 'use_list');
    for (const clause of list?.namedChildren ?? []) {
      if (clause.type === 'use_instead_of_clause') {
        const [target, ...instead] = clause.namedChildren.filter((child) => child.type !== 'comment');
        const [traitNode, methodNode] = target.namedChildren;
        rules.push({
          k: 'insteadof',
          trait: this.namedClass(traitNode, '', 'trait'),
          method: this.nameText(methodNode),
          instead: instead.map((child) => this.namedClass(child, '', 'trait')),
        });
      } else if (clause.type === 'use_as_clause') {
        rules.push(this.traitAlias(clause));
      }
    }
    return { names, rules, row: member.startPosition.row };
  }

  private traitAlias(clause: Node): Extract<TraitRule, { k: 'as' }> {
    const [target, ...rest] = semanticChildren(clause);
    const qualified = target.type === 'class_constant_access_expression';
    const [trait, method] = qualified ? semanticChildren(target) : [undefined, target];
    const modifier = clause.childForFieldName('modifier') ?? rest.find((child) => child.type === 'visibility_modifier');
    const aliasField = clause.childForFieldName('alias');
    const alias = aliasField ?? rest.find((child) => child.type === 'name');
    const legacyModifier = !modifier && !aliasField ? lower(alias?.text ?? '') : '';
    const error = traitAdaptationModifierError(modifier?.text ?? legacyModifier);
    if (error) this.error(clause.parent?.parent ?? clause, error);
    const legacyFinal = legacyModifier === 'final';
    return {
      k: 'as',
      trait: trait ? this.namedClass(trait, '', 'trait') : undefined,
      method: this.nameText(method),
      alias: alias && !legacyFinal ? this.nameText(alias) : undefined,
      visibility: modifier?.type === 'visibility_modifier' ? (lower(modifier.text) as Visibility) : undefined,
      isFinal: legacyFinal || modifier?.type === 'final_modifier',
    };
  }

  // Expressions -------------------------------------------------------------------------------------------------------

  protected abstract block(node: Node | null | undefined): Stmt[];
}

function typeAllowsNull(type: TypeDecl): boolean {
  if (type.k === 'named') return type.nullable === true || type.name === 'null' || type.name === 'mixed';
  if (type.k === 'union') return type.types.some(typeAllowsNull);
  return false;
}

const PROPERTY_REFERENCE_BOUNDARIES = new Set([
  'anonymous_class',
  'anonymous_function',
  'arrow_function',
  'class_declaration',
  'enum_declaration',
  'function_definition',
  'interface_declaration',
  'method_declaration',
  'trait_declaration',
]);

function referencesProperty(node: Node, name: string): boolean {
  if (PROPERTY_REFERENCE_BOUNDARIES.has(node.type)) return false;
  if (node.type === 'member_access_expression' || node.type === 'nullsafe_member_access_expression') {
    const object = withoutParentheses(node.childForFieldName('object'));
    const member = withoutParentheses(node.childForFieldName('name'));
    if (object?.type === 'variable_name' && object.text === '$this' && memberNameLiteral(member) === name) return true;
  }
  return node.namedChildren.some((child) => referencesProperty(child, name));
}

function withoutParentheses(node: Node | null | undefined): Node | undefined {
  while (node?.type === 'parenthesized_expression') node = node.namedChildren.find((child) => child.type !== 'comment');
  return node ?? undefined;
}

function memberNameLiteral(node: Node | undefined): string | undefined {
  if (node?.type === 'name') return enc(node.text);
  if (node?.type === 'string') return decodeSingleQuoted(node.text.slice(node.text.indexOf("'") + 1, -1));
  if (
    node?.type === 'encapsed_string' &&
    node.namedChildren.every((child) => child.type === 'string_content' || child.type === 'escape_sequence')
  )
    return decodeLiteral(node.text.slice(node.text.indexOf('"') + 1, -1), true);
  return undefined;
}

/** Whether a literal of a scalar type may be the default value of a parameter of `type`; an int may stand for a float. */
function defaultFits(type: TypeDecl, literalType: string): boolean {
  if (literalType === 'null' && typeAllowsNull(type)) return true;
  if (type.k === 'inter') return false;
  if (type.k === 'union') return type.types.some((part) => defaultFits(part, literalType));
  const name = type.name;
  if (name === 'mixed' || name === literalType) return true;
  if (literalType === 'int' && name === 'float') return true;
  if (literalType === 'true' || literalType === 'false') return name === 'bool';
  if (literalType === 'array') return name === 'iterable';
  return false;
}

function builtinType(type: TypeDecl): boolean {
  return type.k === 'named' ? BUILTIN_TYPES.has(type.name) : type.types.every(builtinType);
}
