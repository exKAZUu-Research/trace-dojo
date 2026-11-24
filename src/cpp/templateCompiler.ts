import type { Compiler } from './compiler';
import { constrainedParameters } from './concepts';
import type { Expr } from './expr';
import {
  argumentsKey,
  type ClassTemplateInfo,
  Deduction,
  isSubstitutionFailure,
  type ProgramTemplate,
  type TemplateArgument,
  TemplateBindings,
  type TemplateParameter,
  templateParameters,
  templateValue,
} from './programTemplates';
import type { Scope } from './scopes';
import { fieldOf, type Syntax } from './syntax';
import { type Access, type ClassInfo, type FunctionInfo, type Type, VOID } from './types';

/** A function template the program declares, which a call instantiates from its arguments. */
interface FunctionTemplateInfo extends ProgramTemplate {
  readonly instances: Map<string, FunctionInfo | undefined>;
  /** The constraints as written, which tell overloads apart from redeclarations. */
  readonly constraintText: string;
  readonly access: Access;
  /** The explicit specializations (`template <> void f<int>(int)`), by their arguments' key once known. */
  readonly specializations: Syntax[];
}

/**
 * Declares what a template declaration declares (C++20 [temp]): a function template, a class template, an alias
 * template, a specialization, or the out-of-class definition of a class template's member.
 */
export function declareTemplate(compiler: Compiler, node: Syntax, owner?: ClassInfo, access: Access = 'public'): void {
  const parameters = constrainedParameters(compiler, templateParameters(fieldOf(node, 'parameters') as Syntax));
  const constraint = node.children.find((child) => child.type === 'requires_clause');
  let inner = node.children.find((child) => child.field !== 'parameters' && child.type !== 'requires_clause');
  if (!inner) return compiler.error(node.row, 'template の後に宣言を書いてください。');
  // `template <class T> template <class U> void Box<T>::put(U)` defines a member template of a class template.
  const outer: TemplateParameter[][] = [];
  while (inner.type === 'template_declaration') {
    outer.push(parameters.splice(0));
    parameters.push(...constrainedParameters(compiler, templateParameters(fieldOf(inner, 'parameters') as Syntax)));
    inner = inner.children.find((child) => child.field !== 'parameters' && child.type !== 'requires_clause') as Syntax;
  }
  switch (inner.type) {
    case 'function_definition':
    case 'declaration':
    case 'field_declaration': {
      if (isFunctionDeclaration(inner)) {
        declareFunctionTemplate(compiler, parameters, outer, inner, owner, access, constraint);
        return;
      }
      return compiler.unsupported(inner.row, '変数テンプレート');
    }
    case 'class_specifier':
    case 'struct_specifier':
    case 'union_specifier': {
      declareClassTemplate(compiler, parameters, inner, owner, constraint);
      return;
    }
    case 'alias_declaration': {
      const name = (fieldOf(inner, 'name') as Syntax).text;
      const info = classTemplate(compiler, name, 'alias', parameters, inner, owner);
      compiler.declareHere(name, compiler.templateEntity(info), inner.row);
      return;
    }
    case 'concept_definition': {
      compiler.declareConcept(parameters, inner);
      return;
    }
    case 'friend_declaration': {
      return compiler.unsupported(inner.row, 'テンプレートの friend 宣言');
    }
    default: {
      return compiler.error(inner.row, `${inner.text.split('\n')[0]} はテンプレートにできません。`);
    }
  }
}

/**
 * Declares an abbreviated function template (`void f(auto x)`), whose `auto` parameters are invented template
 * parameters (C++20 [dcl.fct]p18), when a function declaration has any; tells whether it did.
 */
export function declareAbbreviatedTemplate(
  compiler: Compiler,
  node: Syntax,
  owner?: ClassInfo,
  access: Access = 'public'
): boolean {
  const written = fieldOf(node, 'declarator');
  const declarator = written && functionDeclarator(written);
  const list = declarator && fieldOf(declarator, 'parameters');
  if (!list || !list.children.some(hasPlaceholder)) return false;
  const { node: rewritten, parameters } = inventParameters(node, list);
  declareFunctionTemplate(compiler, parameters, [], rewritten, owner, access, undefined);
  return true;
}

function hasPlaceholder(parameter: Syntax): boolean {
  const type = fieldOf(parameter, 'type');
  return type?.type === 'placeholder_type_specifier' && !type.children.some((child) => child.type === 'decltype');
}

/**
 * A declaration whose parameter list names an invented template parameter for each `auto` parameter type, with the
 * invented parameters: `auto... xs` invents a pack.
 */
export function inventParameters(
  node: Syntax,
  list: Syntax,
  parameters: TemplateParameter[] = []
): { node: Syntax; parameters: TemplateParameter[] } {
  const invented = [...parameters];
  const replace = (current: Syntax): Syntax => {
    if (current === list) {
      const all = current.all.map((parameter) => {
        if (!parameter.isNamed || !hasPlaceholder(parameter)) return parameter;
        const name = `\0auto${invented.length}`;
        const type = fieldOf(parameter, 'type') as Syntax;
        invented.push({
          name,
          kind: 'type',
          isPack: parameter.type === 'variadic_parameter_declaration',
          constraint: fieldOf(type, 'constraint'),
        });
        const named: Syntax = { ...type, type: 'type_identifier', text: name, all: [], children: [] };
        const parts = parameter.all.map((child) => (child === type ? named : child));
        return { ...parameter, all: parts, children: parts.filter((child) => child.isNamed) };
      });
      return { ...current, all, children: all.filter((child) => child.isNamed) };
    }
    if (!containsNode(current, list)) return current;
    const all = current.all.map(replace);
    return { ...current, all, children: all.filter((child) => child.isNamed) };
  };
  return { node: replace(node), parameters: invented };
}

function containsNode(node: Syntax, target: Syntax): boolean {
  return node === target || node.children.some((child) => containsNode(child, target));
}

function isFunctionDeclaration(node: Syntax): boolean {
  if (node.type === 'function_definition') return true;
  const declarator = fieldOf(node, 'declarator');
  return declarator !== undefined && functionDeclarator(declarator) !== undefined;
}

/** The function declarator a declarator ends in, through the pointers and references of the return type. */
export function functionDeclarator(declarator: Syntax): Syntax | undefined {
  let current: Syntax | undefined = declarator;
  while (current && current.type !== 'function_declarator' && current.type !== 'operator_cast') {
    if (current.type === 'parenthesized_declarator' || current.type === 'init_declarator') return undefined;
    current = fieldOf(current, 'declarator') ?? current.children.find((child) => child.type.endsWith('declarator'));
  }
  return current;
}

function classTemplate(
  compiler: Compiler,
  name: string,
  kind: 'class' | 'alias',
  parameters: TemplateParameter[],
  node: Syntax | undefined,
  owner: ClassInfo | undefined
): ClassTemplateInfo {
  return {
    kind,
    name,
    parameters,
    node,
    namespace: compiler.namespace,
    owner,
    enclosing: [...compiler.templateScopes],
    instances: new Map(),
    specializations: [],
    outOfClassMembers: [],
  };
}

function declareClassTemplate(
  compiler: Compiler,
  parameters: TemplateParameter[],
  node: Syntax,
  owner: ClassInfo | undefined,
  constraint: Syntax | undefined
): void {
  const nameNode = fieldOf(node, 'name');
  const body = fieldOf(node, 'body');
  if (!nameNode) return compiler.error(node.row, 'クラステンプレートには名前を書いてください。');
  if (nameNode.type === 'template_type') {
    // `template <class T> class Box<T*>` or `template <> class Box<int>` specializes a declared template.
    const info = compiler.classTemplateNamed(fieldOf(nameNode, 'name') as Syntax);
    if (!body) return;
    info.specializations.push({ parameters, node, enclosing: [...compiler.templateScopes] });
    return;
  }
  const name = nameNode.text;
  const existing = compiler.findDeclaredHere(name);
  if (existing?.kind === 'template' && existing.template.program) {
    const info = existing.template.program;
    if (body && info.node && fieldOf(info.node, 'body'))
      return compiler.error(node.row, `クラステンプレート ${name} はすでに定義されています。`);
    if (body) info.node = node;
    return;
  }
  const info = {
    ...classTemplate(compiler, name, 'class', parameters, body ? node : undefined, owner),
    constraints: constraint ? [constraint] : [],
  };
  compiler.declareHere(name, compiler.templateEntity(info), node.row);
}

export function declareFunctionTemplate(
  compiler: Compiler,
  parameters: TemplateParameter[],
  outer: TemplateParameter[][],
  node: Syntax,
  owner: ClassInfo | undefined,
  access: Access,
  constraint: Syntax | undefined
): void {
  const declarator = functionDeclarator(fieldOf(node, 'declarator') as Syntax) as Syntax;
  const nameNode = fieldOf(declarator, 'declarator') ?? declarator;
  if (nameNode.type === 'qualified_identifier') {
    defineTemplateMember(
      compiler,
      [...outer.flat(), ...parameters],
      outer.length > 0 ? parameters : [],
      node,
      nameNode
    );
    return;
  }
  const name = compiler.plainName(nameNode);
  if (parameters.length === 0 || nameNode.type === 'template_function') {
    const pattern = compiler.functionTemplateNamed(name, owner, nameNode.row);
    pattern.specializations.push(node);
    return;
  }
  const constraintText = [
    constraint,
    declarator.children.find((child) => child.type === 'requires_clause'),
    ...parameters.map((parameter) => parameter.constraint),
  ]
    .map((clause) => clause?.text ?? '')
    .join('|');
  const existing = compiler.functionTemplateIfAny(name, owner, parameters.length, node, constraintText);
  if (existing) {
    if (node.type === 'function_definition') existing.node = node;
    return;
  }
  // A trailing requires clause (`void f(T) requires C<T>`) constrains the template as the leading one does.
  const trailing = declarator.children.find((child) => child.type === 'requires_clause');
  const info: FunctionTemplateInfo = {
    name,
    parameters,
    node,
    constraintText,
    namespace: compiler.namespace,
    owner,
    enclosing: [...compiler.templateScopes],
    constraints: [constraint, trailing].filter((clause): clause is Syntax => clause !== undefined),
    instances: new Map(),
    access,
    specializations: [],
  };
  const pattern: FunctionInfo = {
    name,
    displayName: owner ? `${owner.name}::${name}` : name,
    params: [],
    ret: VOID,
    owner,
    namespace: owner ? undefined : compiler.namespace,
    isStatic: compiler.hasSpecifier(node, 'static'),
    isVirtual: false,
    isConst: false,
    isPure: false,
    isConstructor: owner !== undefined && name === owner.name,
    isDestructor: false,
    isOverride: false,
    isFinal: false,
    access,
    row: node.row,
    isAtomic: false,
    isDefined: false,
    isTemplate: true,
    templatePattern: info,
    instantiate: (args, explicit) => instantiateFunction(compiler, info, args, explicit),
  };
  compiler.declareFunctionTemplate(pattern);
}

/**
 * The instance of a function template a call's arguments deduce, or undefined when deduction or substitution fails,
 * which leaves the template out of overload resolution (SFINAE).
 */
function instantiateFunction(
  compiler: Compiler,
  info: FunctionTemplateInfo,
  args: Expr[],
  explicit: Type[] | undefined
): FunctionInfo | undefined {
  const node = info.node as Syntax;
  const deduction = new Deduction(compiler, info.parameters);
  if (explicit && !bindExplicit(deduction, info.parameters, explicit)) return undefined;
  const declarator = functionDeclarator(fieldOf(node, 'declarator') as Syntax) as Syntax;
  const declarations = fieldOf(declarator, 'parameters')?.children ?? [];
  let index = 0;
  for (const declaration of declarations) {
    const pattern = deduction.pattern(declaration, fieldOf(declaration, 'declarator'));
    if (declaration.type === 'variadic_parameter_declaration') {
      for (; index < args.length; index++) if (!deduction.matchArgument(pattern, args[index])) return undefined;
      break;
    }
    const arg = args[index];
    if (!arg) {
      if (declaration.type === 'optional_parameter_declaration') continue;
      return undefined;
    }
    index++;
    if (!deduction.matchArgument(pattern, arg)) return undefined;
  }
  if (index < args.length) return undefined;
  const bindings = completeBindings(compiler, info, deduction);
  if (!bindings) return undefined;
  const key = argumentsKey(bindings.args);
  if (info.instances.has(key)) return info.instances.get(key);
  let instance: FunctionInfo | undefined;
  try {
    if (!compiler.satisfies(info, bindings)) return undefined;
    const specialization = info.specializations.find((spec) => specializationKey(compiler, info, spec) === key);
    instance = specialization
      ? compiler.declareTemplateFunction(info, new TemplateBindings(), specialization)
      : compiler.declareTemplateFunction(info, bindings, node);
  } catch (error) {
    if (!isSubstitutionFailure(error)) throw error;
    instance = undefined;
  }
  info.instances.set(key, instance);
  return instance;
}

/** The key of the template arguments an explicit specialization specializes, deduced from its parameters' types. */
function specializationKey(compiler: Compiler, info: FunctionTemplateInfo, spec: Syntax): string | undefined {
  const declared = compiler.declaredParameterTypes(spec);
  if (!declared) return undefined;
  const declarator = functionDeclarator(fieldOf(info.node as Syntax, 'declarator') as Syntax) as Syntax;
  const deduction = new Deduction(compiler, info.parameters);
  const nameNode = fieldOf(functionDeclarator(fieldOf(spec, 'declarator') as Syntax) as Syntax, 'declarator');
  if (nameNode?.type === 'template_function')
    bindExplicit(deduction, info.parameters, compiler.templateArgumentsOf(fieldOf(nameNode, 'arguments') as Syntax));
  const declarations = fieldOf(declarator, 'parameters')?.children ?? [];
  for (const [index, declaration] of declarations.entries()) {
    const type = declared[index];
    if (!type) break;
    const arg: Expr = {
      type: type.kind === 'reference' ? type.to : type,
      isLvalue: true,
      row: spec.row,
      run: () => {},
    };
    if (!deduction.matchArgument(deduction.pattern(declaration, fieldOf(declaration, 'declarator')), arg))
      return undefined;
  }
  const bindings = completeBindings(compiler, info, deduction);
  return bindings && argumentsKey(bindings.args);
}

function bindExplicit(deduction: Deduction, parameters: readonly TemplateParameter[], explicit: Type[]): boolean {
  for (const [index, argument] of explicit.entries()) {
    const parameter = parameters[Math.min(index, parameters.length - 1)];
    if (!parameter?.name) return false;
    const value = templateValue(argument);
    if (parameter.kind === 'value') {
      if (value === undefined || !deduction.bindValue(parameter.name, value)) return false;
    } else if (value !== undefined || !deduction.bind(parameter.name, argument)) return false;
    // An explicit argument is no deduced one: the call's arguments convert to it.
    if (!parameter.isPack) deduction.fixed.add(parameter.name);
    if (!parameter.isPack && index >= parameters.length) return false;
  }
  return true;
}

/** Binds every parameter to its deduced argument or its default, or undefined when one has neither. */
function completeBindings(
  compiler: Compiler,
  info: ProgramTemplate,
  deduction: Deduction
): TemplateBindings | undefined {
  const bindings = new TemplateBindings();
  for (const parameter of info.parameters) {
    const name = parameter.name ?? '';
    if (parameter.isPack) {
      bindings.bind(parameter, deduction.packs.get(name) ?? []);
      continue;
    }
    let argument: TemplateArgument | undefined;
    if (parameter.kind === 'value') {
      const value = deduction.values.get(name);
      argument = value === undefined ? undefined : compiler.valueTemplateArgument(info, bindings, parameter, value);
    } else argument = deduction.types.get(name);
    if (!argument && parameter.defaultValue) {
      try {
        argument = compiler.defaultTemplateArgument(info, bindings, parameter);
      } catch (error) {
        if (!isSubstitutionFailure(error)) throw error;
        return undefined;
      }
    }
    if (!argument) return undefined;
    bindings.bind(parameter, argument);
  }
  return bindings;
}

/**
 * Defines a member of a class template outside the class (`template <class T> T Box<T>::get() const`): for every
 * instance of the class, now and later.
 */
function defineTemplateMember(
  compiler: Compiler,
  parameters: TemplateParameter[],
  memberParameters: TemplateParameter[],
  node: Syntax,
  qualified: Syntax
): void {
  const scope = fieldOf(qualified, 'scope') as Syntax;
  if (scope.type !== 'template_type') {
    // A member template of an ordinary class, defined outside it.
    const cls = compiler.resolveScope(scope);
    if (cls.kind !== 'class') return compiler.error(node.row, `${scope.text} はクラスではありません。`);
    const name = compiler.plainName(fieldOf(qualified, 'name') as Syntax);
    const pattern = compiler.functionTemplateIfAny(name, cls.cls, parameters.length, node);
    if (!pattern)
      return compiler.error(node.row, `${cls.cls.name} にメンバ関数テンプレート ${name} は宣言されていません。`);
    pattern.node = node;
    return;
  }
  const info = compiler.classTemplateNamed(fieldOf(scope, 'name') as Syntax);
  const member = { parameters, node, qualified, memberParameters };
  info.outOfClassMembers.push(member);
  for (const instance of info.instances.values()) {
    if (instance.kind === 'class' && instance.cls.isComplete) compiler.defineTemplateMember(instance.cls, member);
  }
}

export type { FunctionTemplateInfo, Scope };
