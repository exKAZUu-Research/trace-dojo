// code-gauge-allow-file fileNcss 658 -- Holds the cases of one concern of the interpreter, which share their helpers.
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
import { lower } from './bytes';
import { parseTypeText } from './calls';
import { CompileClassConstants } from './compileClassConstants';
import { type Constant, constantTypeName, foldedConstant, foldedDefaultType } from './constantDefaults';
import { BUILTIN_TYPES, ConverterBase } from './converterBase';
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
  private readonly compileClasses = new CompileClassConstants();
  private activeClass?: ClassDecl;
  protected inConstantExpression = false;

  protected compiledType(expression: Expr): string | undefined {
    const value = this.compiledValue(expression);
    return value === undefined ? undefined : constantTypeName(value);
  }

  protected compiledValue(expression: Expr): Constant | undefined {
    return foldedConstant(expression, {
      compiler: true,
      classConstant: this.compileClasses.lookup(this.activeClass, this.fn.isClosure),
    });
  }

  // code-gauge-allow functionNcss 31 -- Converts every part of a function declaration and checks it as PHP does at compile time.
  protected functionDecl(node: Node, isClosure: boolean, className?: string): FunctionDecl {
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
    const returnType = returnTypeNode ? this.typeDecl(returnTypeNode) : undefined;
    const body = node.childForFieldName('body');
    const byRefReturn =
      node.childForFieldName('reference_modifier') !== null ||
      node.children.some((child) => child.type === 'reference_modifier');
    const outerFn = this.fn;
    const outerLoop = this.loop;
    this.fn = {
      returnType,
      isGenerator: false,
      labels: new Set(),
      gotos: [],
      className: className ?? outerFn.className,
      isMethod: className !== undefined,
      isFunction: true,
      isClosure,
      displayName: isClosure ? name : `${className === undefined ? '' : `${className}::`}${name}()`,
    };
    this.loop = { depth: 0, switches: [] };
    try {
      if (returnTypeNode && returnType) this.checkTypeScope(returnTypeNode, returnType);
      const params = this.params(node.childForFieldName('parameters') as Node, name, className);
      const isAtomic = this.claimAtomic(node, body);
      let statements: Stmt[] = [];
      let arrowBody: Expr | undefined;
      if (node.type === 'arrow_function') {
        arrowBody = this.expr(body as Node);
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
        usesThis: false,
        hasGoto: this.fn.gotos.length > 0,
        namespace: this.namespace,
        className: className ?? outerFn.className,
        isClosure,
      };
    } finally {
      this.fn = outerFn;
      this.loop = outerLoop;
    }
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
      const name = this.variableName(nameNode);
      if (name === 'this') this.error(child, '$this は引数の名前に使えません（Cannot use $this as parameter）。');
      if (name === 'GLOBALS') this.error(child, 'Cannot re-assign auto-global variable GLOBALS');
      if (seen.has(name))
        this.error(child, `引数の名前 $${name} が重なっています（Redefinition of parameter $${name}）。`);
      seen.add(name);
      const typeNode = child.childForFieldName('type');
      const type = typeNode ? this.typeDecl(typeNode) : undefined;
      if (type?.k === 'named' && ['void', 'never'].includes(type.name))
        this.error(child, 'void and never cannot be parameter types');
      if (typeNode && type) this.checkTypeScope(typeNode, type, true);
      const defaultNode = child.childForFieldName('default_value');
      const defaultExpr = defaultNode ? this.constantExpr(defaultNode, true) : undefined;
      const byRef = child.childForFieldName('reference_modifier') !== null;
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
        row: child.startPosition.row,
      };
      if (defaultExpr?.k === 'lit' && defaultExpr.v === null && type && !typeAllowsNull(type)) {
        param.implicitNullable = true;
        const displayName = className === undefined ? functionName : `${className}::${functionName}`;
        this.notices.push({
          level: 'Deprecated',
          message: `${displayName}(): Implicitly marking parameter $${name} as nullable is deprecated, the explicit nullable type must be used instead`,
          row: child.startPosition.row,
        });
      }
      if (child.type === 'property_promotion_parameter') {
        if (lower(functionName) !== '__construct' || className === undefined) {
          this.error(
            child,
            'プロパティの昇格は、コンストラクタの引数にしか書けません（Cannot declare promoted property outside a constructor）。'
          );
        }
        const modifiers = this.memberModifiers(child);
        const visibility = modifiers.visibility ?? 'public';
        const setVisibility = modifiers.setVisibility;
        param.promote = {
          visibility,
          isReadonly: modifiers.isReadonly,
          setVisibility,
        };
      }
      params.push(param);
    }
    // A required parameter after optional ones makes them required.
    let lastRequired = -1;
    for (const [index, param] of params.entries()) if (!param.optional) lastRequired = index;
    for (const [index, param] of params.entries()) {
      if (index < lastRequired && param.optional && !param.variadic) {
        const isNullDefault = param.defaultExpr?.k === 'lit' && param.defaultExpr.v === null;
        if (!(isNullDefault && param.type)) {
          const required = params.slice(index + 1).find((later) => !later.optional) as ParamDecl;
          this.notices.push({
            level: 'Deprecated',
            message: `${className === undefined ? functionName : `${className}::${functionName}`}(): Optional parameter $${param.name} declared before required parameter $${required.name} is implicitly treated as a required parameter`,
            row: param.row,
          });
        }
        param.optional = false;
        param.defaultExpr = undefined;
      }
    }
    return params;
  }

  protected setVisibilityOf(node: Node): Visibility | undefined {
    const operation = node.namedChildren.find((child) => child.type === 'operation');
    if (!operation) return undefined;
    return lower(node.text.split('(')[0].trim()) as Visibility;
  }

  protected typeDecl(node: Node): TypeDecl {
    const type = this.parseTypeDecl(node);
    if (type.k === 'named') {
      if (type.nullable && ['mixed', 'void', 'never', 'null'].includes(type.name))
        this.error(node, `Type ${type.name} cannot be nullable`);
    } else if (type.k === 'inter') this.checkIntersection(node, type.types);
    else this.checkUnion(node, type);
    return type;
  }

  private checkIntersection(node: Node, members: TypeDecl[]): void {
    const seen = new Set<string>();
    for (const member of members) {
      const name = typeToString(member);
      const key = lower(name);
      if (member.k !== 'named' || BUILTIN_TYPES.has(lower(member.name)) || ['self', 'parent', 'static'].includes(key))
        this.error(node, `Type ${name} cannot be part of an intersection type`);
      if (seen.has(key)) this.error(node, `Duplicate type ${name} is redundant`);
      seen.add(key);
    }
  }

  private checkUnion(node: Node, type: Extract<TypeDecl, { k: 'union' }>): void {
    const seen = new Set<string>();
    for (const member of type.types) {
      if (member.k === 'named' && member.nullable) this.error(node, 'Invalid or redundant union type');
      const name = member.k === 'named' ? lower(member.name) : lower(typeToString(member));
      if (name === 'mixed') this.error(node, 'Type mixed can only be used as a standalone type');
      const components =
        name === 'iterable' ? ['array', 'Traversable'] : name === 'bool' ? ['false', 'true'] : [typeToString(member)];
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
      this.error(node, `Type ${typeToString(type)} contains both object and a class type, which is redundant`);
  }

  private parseTypeDecl(node: Node): TypeDecl {
    switch (node.type) {
      case 'primitive_type':
      case 'bottom_type': {
        return { k: 'named', name: lower(node.text) };
      }
      case 'named_type': {
        const inner = node.namedChildren[0];
        return this.typeName(inner);
      }
      case 'name':
      case 'qualified_name':
      case 'relative_name': {
        return this.typeName(node);
      }
      case 'optional_type': {
        const inner = this.typeDecl(node.namedChildren[0]);
        return inner.k === 'named' ? { ...inner, nullable: true } : inner;
      }
      case 'union_type':
      case 'disjunctive_normal_form_type': {
        return {
          k: 'union',
          types: node.namedChildren.filter((child) => child.type !== 'comment').map((child) => this.typeDecl(child)),
        };
      }
      case 'intersection_type': {
        return {
          k: 'inter',
          types: node.namedChildren.filter((child) => child.type !== 'comment').map((child) => this.typeDecl(child)),
        };
      }
      case 'type_list': {
        return { k: 'union', types: node.namedChildren.map((child) => this.typeDecl(child)) };
      }
      default: {
        if (node.namedChildren.length === 1) return this.typeDecl(node.namedChildren[0]);
        return { k: 'union', types: node.namedChildren.map((child) => this.typeDecl(child)) };
      }
    }
  }

  protected constantExpr(node: Node, allowNew = false): Expr {
    const outer = this.inConstantExpression;
    this.inConstantExpression = true;
    try {
      const expression = this.expr(node);
      this.checkConstantExpr(expression, allowNew);
      return expression;
    } finally {
      this.inConstantExpression = outer;
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
        className(expression.cls, expression.name);
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

  // code-gauge-allow functionCognitiveComplexity 16 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  private checkDefaultType(node: Node, name: string, type: TypeDecl, value: Expr, property?: ClassDecl): void {
    const literalType = foldedDefaultType(value);
    if (literalType === 'null' && !property) return;
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
  protected checkTypeScope(node: Node, type: TypeDecl, parameter = false): void {
    if (type.k !== 'named') {
      for (const part of type.types) this.checkTypeScope(node, part, parameter);
      return;
    }
    if (parameter && type.name === 'static') this.error(node, 'Cannot use the static modifier on a parameter');
    if (type.name === 'self' || type.name === 'static' || type.name === 'parent') this.checkClassScope(node, type.name);
  }

  protected typeName(node: Node): TypeDecl {
    const raw = this.nameText(node);
    const word = lower(raw);
    if (BUILTIN_TYPES.has(word)) return { k: 'named', name: word };
    if (word === 'self' || word === 'static' || word === 'parent') return { k: 'named', name: word };
    return { k: 'named', name: this.resolveClassName(raw) };
  }

  // Classes -----------------------------------------------------------------------------------------------------------

  classDecl(node: Node, anonymous = false, topLevel = true): ClassDecl {
    const attributes = node.childForFieldName('attributes');
    if (attributes) this.unsupported(attributes, '属性（#[...]）');
    const kind: ClassDecl['kind'] =
      node.type === 'interface_declaration' ? 'interface' : node.type === 'trait_declaration' ? 'trait' : 'class';
    const nameNode = node.childForFieldName('name');
    let name = '';
    const runtimeIndex = anonymous || !topLevel ? this.runtimeClasses++ : 0;
    if (!anonymous) {
      const raw = this.nameText(nameNode as Node);
      const word = lower(raw);
      if (BUILTIN_TYPES.has(word) || ['self', 'parent', 'static'].includes(word)) {
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
      ? base.namedChildren
          .filter((child) => child.type !== 'comment')
          .map((child) => this.resolveClassName(this.nameText(child)))
      : [];
    const implementsClause = node.namedChildren.find((child) => child.type === 'class_interface_clause');
    let interfaces = implementsClause
      ? implementsClause.namedChildren
          .filter((child) => child.type !== 'comment')
          .map((child) => this.resolveClassName(this.nameText(child)))
      : [];
    let parent: string | undefined;
    if (kind === 'interface') interfaces = baseNames;
    else if (baseNames.length > 0) parent = baseNames[0];
    let fullName: string | undefined;
    if (anonymous) {
      name = `${parent ?? interfaces[0] ?? 'class'}@anonymous`;
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
      row: node.startPosition.row,
      endRow: node.endPosition.row,
      isAnonymous: anonymous,
    };
    if (decl.isAbstract && decl.isFinal) this.error(node, 'Cannot use the final modifier on an abstract class');
    const outerClass = this.currentClass;
    const outerKind = this.currentClassKind;
    const outerHasParent = this.currentClassHasParent;
    const outerDecl = this.activeClass;
    this.activeClass = decl;
    this.currentClass = name;
    this.currentClassKind = kind;
    this.currentClassHasParent = parent !== undefined;
    try {
      const body = node.childForFieldName('body') as Node;
      const memberNames = new Set<string>();
      for (const member of body.namedChildren) {
        switch (member.type) {
          case 'const_declaration': {
            this.classConsts(member, decl, kind);
            break;
          }
          case 'property_declaration': {
            this.properties(member, decl, kind);
            break;
          }
          case 'method_declaration': {
            const method = this.methodDecl(member, decl);
            const key = lower(method.fn.name);
            if (memberNames.has(key)) {
              this.error(
                member,
                `メソッド ${name}::${method.fn.name}() は、すでに宣言されています（Cannot redeclare ${name}::${method.fn.name}()）。`
              );
            }
            memberNames.add(key);
            decl.methods.push(method);
            break;
          }
          case 'use_declaration': {
            if (kind === 'interface') this.error(member, 'インターフェースではトレイトを使えません。');
            decl.traits.push(this.traitUse(member));
            break;
          }
          case 'comment': {
            break;
          }
          case 'enum_case': {
            this.unsupported(member, '列挙型（enum）');
            break;
          }
          default: {
            this.error(member, '書き方に誤りがあります。');
          }
        }
      }
    } finally {
      this.activeClass = outerDecl;
      this.currentClass = outerClass;
      this.currentClassKind = outerKind;
      this.currentClassHasParent = outerHasParent;
    }
    // Promoted constructor parameters declare properties.
    const constructor = decl.methods.find((method) => lower(method.fn.name) === '__construct');
    if (constructor) {
      for (const param of constructor.fn.params) {
        if (!param.promote) continue;
        if (decl.props.some((prop) => prop.name === param.name)) {
          this.error(
            param.row,
            `プロパティ ${name}::$${param.name} は、すでに宣言されています（Cannot redeclare ${name}::$${param.name}）。`
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
          isFinal: false,
        });
      }
    }
    if (topLevel && !anonymous) this.compileClasses.bind(decl);
    return decl;
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
    const modifierKinds = children
      .filter((child) => child.type.endsWith('_modifier'))
      .map((child) =>
        child.type === 'visibility_modifier'
          ? this.setVisibilityOf(child)
            ? 'set_visibility'
            : 'visibility'
          : child.type
      );
    if (new Set(modifierKinds).size !== modifierKinds.length)
      this.error(member, 'Multiple access or duplicate modifiers are not allowed');
    if (modifierKinds.includes('abstract_modifier') && modifierKinds.includes('final_modifier'))
      this.error(member, 'Cannot use the final modifier on an abstract class member');
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

  // code-gauge-allow functionCognitiveComplexity 21 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  protected classConsts(member: Node, decl: ClassDecl, kind: ClassDecl['kind']): void {
    const attributes = member.childForFieldName('attributes');
    if (attributes) this.unsupported(attributes, '属性（#[...]）');
    const modifiers = this.memberModifiers(member);
    if (
      modifiers.isAbstract ||
      modifiers.isStatic ||
      modifiers.isReadonly ||
      (modifiers.isFinal && modifiers.visibility === 'private')
    )
      this.error(member, 'Invalid modifier on a class constant');
    const typeNode = member.childForFieldName('type');
    for (const element of member.namedChildren.filter((child) => child.type === 'const_element')) {
      const [nameNode, valueNode] = element.namedChildren.filter((part) => part.type !== 'comment');
      const name = this.nameText(nameNode);
      if (lower(name) === 'class')
        this.error(
          element,
          "class という名前の定数は宣言できません（A class constant must not be called 'class'; it is reserved for class name fetching）。"
        );
      if (decl.consts.some((constant) => constant.name === name)) {
        this.error(
          element,
          `定数 ${decl.name}::${name} は、すでに宣言されています（Cannot redefine class constant ${decl.name}::${name}）。`
        );
      }
      if (kind === 'interface' && modifiers.visibility && modifiers.visibility !== 'public') {
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
      const folded = this.compileClasses.add(decl, name, constantValue, constantType);
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
      if (decl.props.some((prop) => prop.name === name)) {
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
      const defaultExpr = defaultNode ? this.constantExpr(defaultNode, false) : undefined;
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
    const hooks: NonNullable<PropertyDeclAst['hooks']> = {};
    let referencesBacking = false;
    for (const hook of declarations) {
      const attributes = hook.childForFieldName('attributes');
      if (attributes) this.unsupported(attributes, '属性（#[...]）');
      const kind = lower(hook.namedChildren.find((child) => child.type === 'name')?.text ?? '');
      const body = hook.childForFieldName('body');
      const paramsNode = hook.childForFieldName('parameters');
      const outerFn = this.fn;
      const byRefReturn = hook.childForFieldName('reference_modifier') !== null;
      if (kind === 'set' && byRefReturn)
        this.notices.push({
          level: 'Deprecated',
          message: `${className}::$${prop.name}::set(): Returning by reference from a void function is deprecated`,
          row: hook.startPosition.row,
        });
      this.fn = {
        isGenerator: false,
        labels: new Set(),
        gotos: [],
        className,
        isMethod: true,
        returnType: kind === 'set' ? { k: 'named', name: 'void' } : prop.type,
      };
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
        if (body?.type === 'compound_statement') statements = this.block(body);
        else if (body) {
          arrowBody = this.expr(body);
          if (kind === 'set') {
            // A short set hook assigns its expression to the property.
            referencesBacking = true;
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
        if (body && referencesProperty(body, prop.name)) referencesBacking = true;
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
          hasGoto: false,
          namespace: this.namespace,
          className,
          isClosure: false,
        };
        if (kind === 'get') {
          hooks.get = fn;
          hooks.abstractGet = !body;
        } else if (kind === 'set') {
          hooks.set = fn;
          hooks.abstractSet = !body;
          hooks.setParam = params[0]?.name;
        } else
          this.error(
            hook,
            `プロパティフック「${kind}」はありません（Unknown hook "${kind}" for property ${className}::$${prop.name}）。`
          );
      } finally {
        this.fn = outerFn;
      }
    }
    prop.hooks = hooks;
    prop.isVirtual = !referencesBacking;
    if (prop.isVirtual && prop.defaultExpr)
      this.error(list, `Cannot specify default value for virtual hooked property ${className}::$${prop.name}`);
  }

  // code-gauge-allow functionCognitiveComplexity 21 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  protected methodDecl(member: Node, decl: ClassDecl): MethodDeclAst {
    const modifiers = this.memberModifiers(member);
    const fn = this.functionDecl(member, false, decl.name);
    const body = member.childForFieldName('body');
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
  // code-gauge-allow functionCognitiveComplexity 21 -- Checks PHP's rules for each magic method in PHP's order, which decides the error shown.
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
      .map((child) => this.resolveClassName(this.nameText(child)));
    const rules: TraitRule[] = [];
    const list = member.namedChildren.find((child) => child.type === 'use_list');
    for (const clause of list?.namedChildren ?? []) {
      if (clause.type === 'use_instead_of_clause') {
        const [target, ...instead] = clause.namedChildren.filter((child) => child.type !== 'comment');
        const [traitNode, methodNode] = target.namedChildren;
        rules.push({
          k: 'insteadof',
          trait: this.resolveClassName(this.nameText(traitNode)),
          method: this.nameText(methodNode),
          instead: instead.map((child) => this.resolveClassName(this.nameText(child))),
        });
      } else if (clause.type === 'use_as_clause') {
        const parts = clause.namedChildren.filter((child) => child.type !== 'comment');
        const [target, ...rest] = parts;
        let trait: string | undefined;
        let method: string;
        if (target.type === 'class_constant_access_expression') {
          trait = this.resolveClassName(this.nameText(target.namedChildren[0]));
          method = this.nameText(target.namedChildren[1]);
        } else method = this.nameText(target);
        const visibilityNode = rest.find((child) => child.type === 'visibility_modifier');
        const aliasNode = rest.find((child) => child.type === 'name');
        rules.push({
          k: 'as',
          trait,
          method,
          alias: aliasNode ? this.nameText(aliasNode) : undefined,
          visibility: visibilityNode ? (lower(visibilityNode.text) as Visibility) : undefined,
        });
      }
    }
    return { names, rules, row: member.startPosition.row };
  }

  // Expressions -------------------------------------------------------------------------------------------------------

  protected abstract block(node: Node | null | undefined): Stmt[];
}

function typeAllowsNull(type: TypeDecl): boolean {
  if (type.k === 'named') return type.nullable === true || type.name === 'null' || type.name === 'mixed';
  if (type.k === 'union') return type.types.some(typeAllowsNull);
  return false;
}

/** Whether a hook body refers to the property it belongs to through `$this->name`. */
function referencesProperty(node: Node, name: string): boolean {
  if (node.type === 'member_access_expression' || node.type === 'nullsafe_member_access_expression') {
    const object = node.childForFieldName('object');
    const member = node.childForFieldName('name');
    if (
      object?.type === 'variable_name' &&
      object.text === '$this' &&
      member?.type === 'name' &&
      member.text === name
    ) {
      return true;
    }
  }
  return node.namedChildren.some((child) => referencesProperty(child, name));
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
