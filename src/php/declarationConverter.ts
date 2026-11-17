// code-gauge-allow-file fileNcss 456 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import type { Node } from '@willbooster/web-tree-sitter';

import type { ClassDecl, Expr, FunctionDecl, MethodDeclAst, ParamDecl, PropertyDeclAst, Stmt, TraitRule } from './ast';
import { lower } from './bytes';
import { BUILTIN_TYPES, ConverterBase } from './converterBase';
import { SCRIPT_PATH } from './runtime';
import { typeToString } from './types';
import type { TypeDecl, Visibility } from './values';
import { isSubtype } from './variance';

/**
 * What PHP requires of each magic method: the number of parameters, whether it is static, whether it must be public,
 * and the return type it may declare ('' for none). An undefined field is not checked.
 */
const MAGIC_METHODS: Record<string, { args?: number; isStatic?: boolean; isPublic?: boolean; returnType?: string }> = {
  __construct: { isStatic: false, returnType: '' },
  __destruct: { args: 0, isStatic: false, returnType: '' },
  __clone: { args: 0, isStatic: false, returnType: 'void' },
  __get: { args: 1, isStatic: false, isPublic: true },
  __set: { args: 2, isStatic: false, isPublic: true, returnType: 'void' },
  __isset: { args: 1, isStatic: false, isPublic: true, returnType: 'bool' },
  __unset: { args: 1, isStatic: false, isPublic: true, returnType: 'void' },
  __call: { args: 2, isStatic: false, isPublic: true },
  __callstatic: { args: 2, isStatic: true, isPublic: true },
  __tostring: { args: 0, isStatic: false, isPublic: true, returnType: 'string' },
  __debuginfo: { args: 0, isStatic: false, isPublic: true, returnType: '?array' },
  __invoke: { isStatic: false, isPublic: true },
  __serialize: { args: 0, isStatic: false, isPublic: true, returnType: 'array' },
  __unserialize: { args: 1, isStatic: false, isPublic: true, returnType: 'void' },
  __set_state: { args: 1, isStatic: true, isPublic: true, returnType: 'object' },
};

/** Converts the declarations of functions, parameters, types, and classes. */
export abstract class DeclarationConverter extends ConverterBase {
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

  // code-gauge-allow functionNcss 57 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
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
      if (seen.has(name))
        this.error(child, `引数の名前 $${name} が重なっています（Redefinition of parameter $${name}）。`);
      seen.add(name);
      const typeNode = child.childForFieldName('type');
      const type = typeNode ? this.typeDecl(typeNode) : undefined;
      if (type?.k === 'named' && ['void', 'never'].includes(type.name))
        this.error(child, 'void and never cannot be parameter types');
      if (typeNode && type) this.checkTypeScope(typeNode, type);
      const defaultNode = child.childForFieldName('default_value');
      const defaultExpr = defaultNode ? this.expr(defaultNode) : undefined;
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
        const modifiers = child.namedChildren;
        const visibilityNode = modifiers.find((part) => part.type === 'visibility_modifier');
        const visibility = visibilityNode ? (lower(visibilityNode.text.replace(/\(.*$/, '')) as Visibility) : 'public';
        const setVisibility = visibilityNode ? this.setVisibilityOf(visibilityNode) : undefined;
        param.promote = {
          visibility,
          isReadonly: modifiers.some((part) => part.type === 'readonly_modifier'),
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

  // code-gauge-allow functionCognitiveComplexity 17 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  protected typeDecl(node: Node): TypeDecl {
    const type = this.parseTypeDecl(node);
    if (type.k === 'named' && type.nullable && ['mixed', 'void', 'never', 'null'].includes(type.name))
      this.error(node, `Type ${type.name} cannot be nullable`);
    if (type.k !== 'named') {
      const names = type.types.map((part) => (part.k === 'named' ? lower(part.name) : typeToString(part)));
      if (new Set(names).size !== names.length) this.error(node, 'Duplicate type is redundant');
      if (
        type.k === 'union' &&
        (names.some((name) => ['mixed', 'void', 'never'].includes(name)) ||
          (names.includes('iterable') && (names.includes('array') || names.includes('traversable'))))
      )
        this.error(node, 'Invalid or redundant union type');
      if (
        type.k === 'inter' &&
        names.some((name) =>
          [
            'int',
            'float',
            'string',
            'bool',
            'array',
            'object',
            'callable',
            'iterable',
            'mixed',
            'void',
            'never',
            'null',
            'false',
            'true',
          ].includes(name)
        )
      )
        this.error(node, 'Intersection types must be class types');
    }
    return type;
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

  protected constantExpr(node: Node): Expr {
    const invalid = (child: Node): boolean =>
      [
        'variable_name',
        'dynamic_variable_name',
        'function_call_expression',
        'object_creation_expression',
        'anonymous_function',
        'arrow_function',
      ].includes(child.type) || child.namedChildren.some(invalid);
    if (invalid(node)) this.error(node, 'Constant expression contains invalid operations');
    return this.expr(node);
  }

  /** Rejects a literal default value the parameter's type can never hold, as PHP does at compile time. */
  private checkDefaultType(node: Node, name: string, type: TypeDecl, value: Expr): void {
    if (value.k !== 'lit' || value.v === null) return;
    const literalType =
      typeof value.v === 'bigint'
        ? 'int'
        : typeof value.v === 'number'
          ? 'float'
          : typeof value.v === 'boolean'
            ? 'bool'
            : typeof value.v === 'string'
              ? 'string'
              : undefined;
    if (literalType === undefined || defaultFits(type, literalType)) return;
    this.error(
      node,
      `引数 $${name} の型に合わない既定値です（Cannot use ${literalType} as default value for parameter $${name} of type ${typeToString(type)}）。`
    );
  }

  /** Checks the `self`, `static`, and `parent` a declared type names, as {@link checkClassScope} does. */
  protected checkTypeScope(node: Node, type: TypeDecl): void {
    if (type.k !== 'named') {
      for (const part of type.types) this.checkTypeScope(node, part);
      return;
    }
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

  // code-gauge-allow functionCognitiveComplexity 18 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  protected classConsts(member: Node, decl: ClassDecl, kind: ClassDecl['kind']): void {
    const attributes = member.childForFieldName('attributes');
    if (attributes) this.unsupported(attributes, '属性（#[...]）');
    const modifiers = this.memberModifiers(member);
    if (modifiers.isAbstract || modifiers.isStatic || modifiers.isReadonly)
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
      if (constantType && constantValue.k === 'lit') this.checkDefaultType(element, name, constantType, constantValue);
      decl.consts.push({
        name,
        value: constantValue,
        visibility: modifiers.visibility ?? 'public',
        isFinal: modifiers.isFinal,
        row: element.startPosition.row,
        type: typeNode ? this.typeDecl(typeNode) : undefined,
      });
    }
  }

  // code-gauge-allow functionCognitiveComplexity 27 -- Checks PHP's rules on the modifiers and parts of each declaration.
  // code-gauge-allow functionNcss 32 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
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
    const typeNode = member.childForFieldName('type');
    const type = typeNode ? this.typeDecl(typeNode) : undefined;
    if (typeNode && type) this.checkTypeScope(typeNode, type);
    const isReadonly = modifiers.isReadonly || decl.isReadonly;
    if (isReadonly && !type && !modifiers.isStatic) {
      this.error(
        member,
        `readonly のプロパティには型が必要です（Readonly property ${decl.name}::$... must have type）。`
      );
    }
    if (isReadonly && modifiers.isStatic)
      this.error(member, 'static のプロパティは readonly にできません（Static property cannot be readonly）。');
    const hookList = member.namedChildren.find((child) => child.type === 'property_hook_list');
    for (const element of member.namedChildren.filter((child) => child.type === 'property_element')) {
      const name = this.variableName(element.childForFieldName('name') as Node);
      if (decl.props.some((prop) => prop.name === name)) {
        this.error(
          element,
          `プロパティ ${decl.name}::$${name} は、すでに宣言されています（Cannot redeclare ${decl.name}::$${name}）。`
        );
      }
      const defaultNode = element.childForFieldName('default_value');
      if (defaultNode && isReadonly) {
        this.error(
          element,
          `readonly のプロパティには初期値を書けません（Readonly property ${decl.name}::$${name} cannot have default value）。`
        );
      }
      const prop: PropertyDeclAst = {
        name,
        visibility: modifiers.visibility ?? 'public',
        setVisibility: modifiers.setVisibility,
        isStatic: modifiers.isStatic,
        isReadonly,
        type,
        defaultExpr: defaultNode ? this.expr(defaultNode) : undefined,
        row: element.startPosition.row,
        isAbstract: modifiers.isAbstract,
        isFinal: modifiers.isFinal,
      };
      if (modifiers.isAbstract && !hookList) this.error(member, 'Only hooked properties may be declared abstract');
      if (modifiers.isAbstract && hookList && !hookList.namedChildren.some((hook) => !hook.childForFieldName('body')))
        this.error(member, `Abstract property ${decl.name}::$${name} must specify at least one abstract hook`);
      if (hookList) this.hooks(hookList, prop, decl.name);
      decl.props.push(prop);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 28 -- Checks PHP's rules on the modifiers and parts of each declaration.
  // code-gauge-allow functionNcss 47 -- Checks PHP's rules on the modifiers and parts of each declaration.
  protected hooks(list: Node, prop: PropertyDeclAst, className: string): void {
    const hooks: NonNullable<PropertyDeclAst['hooks']> = {};
    let referencesBacking = false;
    for (const hook of list.namedChildren.filter((child) => child.type === 'property_hook')) {
      const attributes = hook.childForFieldName('attributes');
      if (attributes) this.unsupported(attributes, '属性（#[...]）');
      const kind = lower(hook.namedChildren.find((child) => child.type === 'name')?.text ?? '');
      const body = hook.childForFieldName('body');
      const paramsNode = hook.childForFieldName('parameters');
      const outerFn = this.fn;
      this.fn = { isGenerator: false, labels: new Set(), gotos: [], className, isMethod: true };
      try {
        let params: ParamDecl[] = [];
        if (paramsNode) params = this.params(paramsNode, `$${prop.name}::${kind}`, className);
        if (
          kind === 'set' &&
          paramsNode &&
          prop.type &&
          (!params[0]?.type ||
            (builtinType(prop.type) &&
              builtinType(params[0].type) &&
              !isSubtype(prop.type, undefined, params[0].type, undefined)))
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
          params,
          body: statements,
          arrowBody,
          byRefReturn: false,
          row: hook.startPosition.row,
          endRow: hook.endPosition.row,
          isAtomic: false,
          usesThis: true,
          hasGoto: false,
          namespace: this.namespace,
          className,
          isClosure: false,
        };
        if (kind === 'get') hooks.get = fn;
        else if (kind === 'set') {
          hooks.set = fn;
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

  protected methodDecl(member: Node, decl: ClassDecl): MethodDeclAst {
    const modifiers = this.memberModifiers(member);
    const fn = this.functionDecl(member, false, decl.name);
    const body = member.childForFieldName('body');
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
  // code-gauge-allow functionCognitiveComplexity 17 -- Checks PHP's rules for each magic method in PHP's order, which decides the error shown.
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
    if (fn.returnType === undefined || rule.returnType === undefined) return;
    if (rule.returnType === '') fail(`Method ${where} cannot declare a return type`);
    else if (typeToString(fn.returnType) !== rule.returnType) {
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
  if (type.k === 'inter') return false;
  if (type.k === 'union') return type.types.some((part) => defaultFits(part, literalType));
  const name = type.name;
  if (name === 'mixed' || name === literalType) return true;
  if (literalType === 'int' && name === 'float') return true;
  if (literalType === 'bool') return name === 'true' || name === 'false';
  return false;
}

function builtinType(type: TypeDecl): boolean {
  return type.k === 'named' ? BUILTIN_TYPES.has(type.name) : type.types.every(builtinType);
}
