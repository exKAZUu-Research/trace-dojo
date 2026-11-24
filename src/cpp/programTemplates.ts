import { CompileError } from '../interpreter/diagnostics';
import type { Compiler } from './compiler';
import { constantExpr, type Expr } from './expr';
import { typeKey } from './library/templates';
import { type Entity, type NamespaceInfo, Scope } from './scopes';
import { fieldOf, hasToken, type Syntax } from './syntax';
import {
  type ClassInfo,
  type FunctionInfo,
  type IntType,
  pointerTo,
  referenceTo,
  type Type,
  typeName,
  unqualified,
  withConst,
} from './types';

/** A parameter of a template the program declares. */
export interface TemplateParameter {
  name: string | undefined;
  kind: 'type' | 'value' | 'template';
  isPack: boolean;
  /** The syntax of a value parameter's type, which may name the parameters before it. */
  valueType?: Syntax;
  valueDeclaration?: Syntax;
  defaultValue?: Syntax;
}

/**
 * A template argument, as `Compiler.templateArguments` gives it: a type, or a value that the template argument list
 * names (`Array<int, 3>`), carried by an integer type with its value.
 */
export type TemplateArgument = Type;

/** The value a template argument carries, when it is a constant rather than a type. */
export function templateValue(argument: TemplateArgument): number | bigint | undefined {
  return argument.kind === 'int' ? argument.templateValue : undefined;
}

export function valueArgument(type: IntType, value: number | bigint): TemplateArgument {
  return { ...unqualified(type), templateValue: value };
}

/** A key that tells template argument lists apart, for reusing an instance. */
export function argumentsKey(args: readonly TemplateArgument[]): string {
  return args
    .map((arg) => {
      const value = templateValue(arg);
      return value === undefined ? typeKey(arg) : `=${value}`;
    })
    .join(',');
}

/** The template argument list as C++ writes it, such as `<int, 3>`. */
export function argumentsText(args: readonly TemplateArgument[]): string {
  const text = args.map((arg) => {
    const value = templateValue(arg);
    return value === undefined ? typeName(arg) : String(value);
  });
  return `<${text.join(', ')}>`;
}

/** Reads a template parameter list (C++20 [temp.param]). */
export function templateParameters(list: Syntax): TemplateParameter[] {
  return list.children.map((node) => {
    switch (node.type) {
      case 'type_parameter_declaration':
      case 'variadic_type_parameter_declaration': {
        return {
          name: node.children.find((child) => child.type === 'type_identifier')?.text,
          kind: 'type',
          isPack: node.type === 'variadic_type_parameter_declaration',
        };
      }
      case 'optional_type_parameter_declaration': {
        return {
          name: fieldOf(node, 'name')?.text,
          kind: 'type',
          isPack: false,
          defaultValue: fieldOf(node, 'default_type'),
        };
      }
      case 'template_template_parameter_declaration': {
        const inner = node.children.find((child) => child.field !== 'parameters');
        const name = inner?.children.find((child) => child.type === 'type_identifier')?.text;
        return {
          name,
          kind: 'template',
          isPack: inner?.type === 'variadic_type_parameter_declaration',
          defaultValue: inner ? fieldOf(inner, 'default_type') : undefined,
        };
      }
      default: {
        const declarator = fieldOf(node, 'declarator');
        const isPack = node.type === 'variadic_parameter_declaration';
        const nameNode = declarator?.type === 'variadic_declarator' ? declarator.children[0] : declarator;
        return {
          name: nameNode?.text,
          kind: 'value',
          isPack,
          valueType: fieldOf(node, 'type'),
          valueDeclaration: node,
          defaultValue: fieldOf(node, 'default_value'),
        };
      }
    }
  });
}

/** What a template's parameters are bound to while one of its instances is compiled. */
export class TemplateBindings {
  readonly scope = new Scope();
  readonly args: TemplateArgument[] = [];

  bind(parameter: TemplateParameter, argument: TemplateArgument | TemplateArgument[]): void {
    if (Array.isArray(argument)) {
      this.args.push(...argument);
      if (parameter.name) this.scope.names.set(parameter.name, { kind: 'pack', items: argument.map(argumentEntity) });
      return;
    }
    this.args.push(argument);
    if (parameter.name) this.scope.names.set(parameter.name, argumentEntity(argument));
  }
}

function argumentEntity(argument: TemplateArgument): Entity {
  const value = templateValue(argument);
  if (value === undefined) return { kind: 'type', type: argument };
  const { templateValue: _, ...plain } = unqualified(argument as IntType);
  return { kind: 'value', make: (row) => constantExpr(plain, value, row) };
}

/** A shape a function template's parameter type has, which deduction matches an argument's type against. */
type Pattern =
  | { kind: 'parameter'; name: string; isConst: boolean }
  | { kind: 'fixed'; node: Syntax; declarator: Syntax | undefined; isConst: boolean }
  | { kind: 'pointer'; to: Pattern; isConst: boolean }
  | { kind: 'reference'; to: Pattern; isRvalue: boolean }
  | { kind: 'array'; of: Pattern; size: string | number | undefined }
  | { kind: 'instance'; name: Syntax; args: (Pattern | { kind: 'valueName'; name: string })[]; isConst: boolean }
  | { kind: 'function'; ret: Pattern; params: Pattern[] }
  | { kind: 'nondeduced' };

/**
 * Deduces template arguments from a call's arguments (C++20 [temp.deduct.call]), matching the shapes of the parameter
 * types against the arguments' types.
 */
export class Deduction {
  readonly types = new Map<string, Type>();
  readonly values = new Map<string, number | bigint>();
  readonly packs = new Map<string, Type[]>();
  /** The parameters explicit template arguments bind, which deduction leaves as they are. */
  readonly fixed = new Set<string>();

  constructor(
    private readonly compiler: Compiler,
    private readonly parameters: readonly TemplateParameter[]
  ) {}

  private parameterNamed(name: string): TemplateParameter | undefined {
    return this.parameters.find((parameter) => parameter.name === name);
  }

  /** The pattern of a declaration's type: its specifiers and its declarator. */
  pattern(declaration: Syntax, declarator: Syntax | undefined): Pattern {
    const specifier = fieldOf(declaration, 'type');
    const isConst = declaration.children.some((child) => child.type === 'type_qualifier' && child.text === 'const');
    if (!specifier) return { kind: 'nondeduced' };
    return this.applyDeclarator(this.specifierPattern(specifier, isConst), declarator);
  }

  private specifierPattern(node: Syntax, isConst: boolean): Pattern {
    if (
      (node.type === 'type_identifier' || node.type === 'identifier') &&
      this.parameterNamed(node.text)?.kind === 'type'
    )
      return { kind: 'parameter', name: node.text, isConst };
    if (!this.mentionsParameter(node)) return { kind: 'fixed', node, declarator: undefined, isConst };
    const templateType = node.type === 'qualified_identifier' ? fieldOf(node, 'name') : node;
    if (templateType?.type === 'template_type' && !this.mentionsParameter(fieldOf(templateType, 'name') as Syntax)) {
      const name =
        node.type === 'qualified_identifier'
          ? {
              ...node,
              all: node.all.map((child) =>
                child === templateType ? (fieldOf(templateType, 'name') as Syntax) : child
              ),
            }
          : (fieldOf(templateType, 'name') as Syntax);
      const list = fieldOf(templateType, 'arguments') as Syntax;
      const args = list.children.map((argument): Pattern | { kind: 'valueName'; name: string } => {
        if (argument.type === 'type_descriptor') {
          const inner = fieldOf(argument, 'type') as Syntax;
          const parameter = this.parameterNamed(inner.text);
          if (parameter?.kind === 'value') return { kind: 'valueName', name: inner.text };
          return this.pattern(argument, fieldOf(argument, 'declarator'));
        }
        if (argument.type === 'identifier' && this.parameterNamed(argument.text)?.kind === 'value')
          return { kind: 'valueName', name: argument.text };
        return { kind: 'nondeduced' };
      });
      return { kind: 'instance', name, args, isConst };
    }
    return { kind: 'nondeduced' };
  }

  private applyDeclarator(base: Pattern, declarator: Syntax | undefined): Pattern {
    if (!declarator) return base;
    switch (declarator.type) {
      case 'pointer_declarator':
      case 'abstract_pointer_declarator': {
        const isConst = declarator.children.some((child) => child.type === 'type_qualifier' && child.text === 'const');
        return this.applyDeclarator({ kind: 'pointer', to: base, isConst }, innerDeclarator(declarator));
      }
      case 'reference_declarator':
      case 'abstract_reference_declarator': {
        const reference: Pattern = { kind: 'reference', to: base, isRvalue: hasToken(declarator, '&&') };
        return this.applyDeclarator(reference, innerDeclarator(declarator));
      }
      case 'array_declarator':
      case 'abstract_array_declarator': {
        const size = fieldOf(declarator, 'size');
        const bound = size?.type === 'identifier' && this.parameterNamed(size.text) ? size.text : undefined;
        return this.applyDeclarator(
          { kind: 'array', of: base, size: bound ?? (size ? Number(size.text) : undefined) },
          innerDeclarator(declarator)
        );
      }
      case 'parenthesized_declarator':
      case 'abstract_parenthesized_declarator': {
        return this.applyDeclarator(base, declarator.children[0]);
      }
      case 'function_declarator':
      case 'abstract_function_declarator': {
        const parameters = fieldOf(declarator, 'parameters')?.children ?? [];
        const params = parameters.map((parameter) => this.pattern(parameter, fieldOf(parameter, 'declarator')));
        return this.applyDeclarator({ kind: 'function', ret: base, params }, fieldOf(declarator, 'declarator'));
      }
      case 'variadic_declarator': {
        return this.applyDeclarator(base, declarator.children[0]);
      }
      default: {
        return base;
      }
    }
  }

  private mentionsParameter(node: Syntax): boolean {
    if ((node.type === 'type_identifier' || node.type === 'identifier') && this.parameterNamed(node.text)) return true;
    return node.children.some((child) => this.mentionsParameter(child));
  }

  /** Matches a call argument against a parameter's pattern, after the adjustments a call makes (C++20 [temp.deduct.call]). */
  matchArgument(pattern: Pattern, arg: Expr): boolean {
    if (arg.braced) return true;
    let type = arg.type;
    if (arg.functions) {
      const [fn, ...others] = arg.functions.candidates;
      if (others.length > 0 || (fn.owner && !fn.isStatic)) return pattern.kind === 'nondeduced';
      type = { kind: 'function', ret: fn.ret, params: fn.params.map((param) => unqualified(param.type)) };
    }
    if (pattern.kind === 'reference') {
      // A forwarding reference (`T&&`) deduces `T&` from an lvalue.
      if (pattern.isRvalue && pattern.to.kind === 'parameter' && !pattern.to.isConst)
        return this.bind(pattern.to.name, arg.isLvalue && !arg.isXvalue ? referenceTo(type) : unqualified(type));
      return this.match(pattern.to, type);
    }
    if (type.kind === 'array') type = pointerTo(type.of);
    else if (type.kind === 'function') type = pointerTo(type);
    return this.match(pattern, unqualified(type));
  }

  match(pattern: Pattern, type: Type): boolean {
    switch (pattern.kind) {
      case 'parameter': {
        let bound = type;
        if (pattern.isConst) bound = unqualified(bound);
        return this.bind(pattern.name, bound);
      }
      case 'pointer': {
        if (type.kind !== 'pointer') return false;
        return this.match(pattern.to, type.to);
      }
      case 'reference': {
        return this.match(pattern.to, type.kind === 'reference' ? type.to : type);
      }
      case 'array': {
        if (type.kind !== 'array') return false;
        if (typeof pattern.size === 'string' && type.length !== undefined && !this.bindValue(pattern.size, type.length))
          return false;
        return this.match(pattern.of, type.of);
      }
      case 'instance': {
        return this.matchInstance(pattern, type);
      }
      case 'function': {
        if (type.kind !== 'function' || type.params.length !== pattern.params.length) return false;
        if (!this.match(pattern.ret, type.ret)) return false;
        return pattern.params.every((param, index) => this.match(param, unqualified(type.params[index])));
      }
      default: {
        return true;
      }
    }
  }

  private matchInstance(pattern: Extract<Pattern, { kind: 'instance' }>, type: Type): boolean {
    if (type.kind !== 'class') return false;
    const template = this.compiler.templateOfName(pattern.name);
    // A derived class's base that is an instance of the template matches too.
    for (let cls: ClassInfo | undefined = type.cls; cls; cls = cls.base) {
      const args = this.compiler.instanceArguments(cls, template);
      if (!args) continue;
      for (const [index, argPattern] of pattern.args.entries()) {
        const argument = args[index];
        if (!argument) return false;
        if (argPattern.kind === 'valueName') {
          const value = templateValue(argument);
          if (value === undefined || !this.bindValue(argPattern.name, value)) return false;
        } else if (!this.match(argPattern, argument)) return false;
      }
      return true;
    }
    return false;
  }

  bind(name: string, type: Type): boolean {
    if (this.fixed.has(name)) return true;
    const parameter = this.parameterNamed(name);
    if (parameter?.isPack) {
      const items = this.packs.get(name) ?? [];
      items.push(type);
      this.packs.set(name, items);
      return true;
    }
    const previous = this.types.get(name);
    if (previous) return typeKey(previous) === typeKey(type);
    this.types.set(name, type);
    return true;
  }

  bindValue(name: string, value: number | bigint): boolean {
    if (this.fixed.has(name)) return true;
    const previous = this.values.get(name);
    if (previous !== undefined) return BigInt(previous) === BigInt(value);
    this.values.set(name, value);
    return true;
  }
}

function innerDeclarator(declarator: Syntax): Syntax | undefined {
  return (
    fieldOf(declarator, 'declarator') ??
    declarator.children.find((child) => child.type !== 'type_qualifier' && child.field !== 'size')
  );
}

/** A function template, a class template, or an alias template the program declares. */
export interface ProgramTemplate {
  readonly name: string;
  readonly parameters: TemplateParameter[];
  /** The declaration the template declares: a function, a class, or an alias. */
  node: Syntax | undefined;
  readonly namespace: NamespaceInfo | undefined;
  /** The class whose member the template is. */
  readonly owner: ClassInfo | undefined;
  /** The bindings of the templates the template is declared in, such as a class template's for a member template. */
  readonly enclosing: Scope[];
  /** The `requires` clause the declaration's arguments must satisfy. */
  readonly constraint?: Syntax;
}

export interface ClassTemplateInfo extends ProgramTemplate {
  readonly kind: 'class' | 'alias';
  readonly instances: Map<string, Type>;
  /** The explicit and partial specializations (`template <class T> class Box<T*>`). */
  readonly specializations: { parameters: TemplateParameter[]; node: Syntax; enclosing: Scope[] }[];
  /** The members the program defines outside the class (`template <class T> T Box<T>::get() const`). */
  readonly outOfClassMembers: {
    parameters: TemplateParameter[];
    memberParameters: TemplateParameter[];
    node: Syntax;
    qualified: Syntax;
  }[];
}

/** Whether an error is one that makes a template's substitution fail rather than the program. */
export function isSubstitutionFailure(error: unknown): boolean {
  return error instanceof CompileError;
}

/** The type with the const qualifier its pattern adds. */
export function withPatternConst(type: Type, isConst: boolean): Type {
  return isConst ? withConst(type) : type;
}

export type { FunctionInfo };
