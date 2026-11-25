import { CompileError } from '../interpreter/diagnostics';
import type { Compiler } from './compiler';
import { implicitConversion } from './conversions';
import type { Expr } from './expr';
import { parseExpressionAt } from './parse';
import { type ProgramTemplate, TemplateBindings, type TemplateParameter } from './programTemplates';
import { fieldOf, type Syntax } from './syntax';
import { isArithmetic, isSigned, nonReference, sameType, type Type, typeName, unqualified } from './types';

/** A concept the program defines (`template <class T> concept C = ...;`). */
export interface ConceptInfo extends ProgramTemplate {
  readonly kind: 'concept';
}

/** The named child in a field, which the grammar may also give to the parentheses around it. */
function namedField(node: Syntax, name: string): Syntax {
  return node.children.find((child) => child.field === name) as Syntax;
}

/** The concepts of `<concepts>` the interpreter evaluates, by their name in `std`. */
const LIBRARY_CONCEPTS: Record<string, (compiler: Compiler, args: Type[], row: number) => boolean> = {
  same_as: (_, [a, b]) => sameType(a, b),
  derived_from: (_, [a, b]) => unqualified(a).kind === 'class' && unqualified(b).kind === 'class' && isDerived(a, b),
  convertible_to: (compiler, [a, b], row) => convertible(compiler, a, b, row),
  integral: (_, [a]) => a.kind === 'int' && !a.enumeration,
  signed_integral: (_, [a]) => a.kind === 'int' && !a.enumeration && isSigned(a) && a.name !== 'bool',
  unsigned_integral: (_, [a]) => a.kind === 'int' && !a.enumeration && (!isSigned(a) || a.name === 'bool'),
  floating_point: (_, [a]) => a.kind === 'float',
  equality_comparable: (compiler, [a], row) =>
    compiles(compiler, () => compiler.binary('==', value(a, row), value(a, row), row)),
  totally_ordered: (compiler, [a], row) =>
    ['<', '>', '<=', '>=', '=='].every((operator) =>
      compiles(compiler, () => compiler.binary(operator, value(a, row), value(a, row), row))
    ),
  default_initializable: (compiler, [a], row) =>
    compiles(compiler, () => compiler.valueInitialized(unqualified(a), row)),
  copy_constructible: (compiler, [a], row) => convertible(compiler, a, unqualified(a), row),
  integral_or_floating: (_, [a]) => isArithmetic(a),
};

function isDerived(a: Type, b: Type): boolean {
  const from = unqualified(a);
  const to = unqualified(b);
  return from.kind === 'class' && to.kind === 'class' && from.cls.isDerivedFrom(to.cls);
}

function value(type: Type, row: number): Expr {
  return { type: nonReference(type), isLvalue: true, row, run: () => {} };
}

function convertible(compiler: Compiler, from: Type, to: Type, row: number): boolean {
  return implicitConversion(compiler, { ...value(from, row), isLvalue: from.kind === 'reference' }, to) !== undefined;
}

/** Whether compiling something succeeds, as an atomic constraint's substitution does (C++20 [temp.constr.atomic]). */
function compiles(compiler: Compiler, compile: () => unknown): boolean {
  return compiler.unevaluated(() => {
    try {
      compile();
      return true;
    } catch (error) {
      if (error instanceof CompileError) return false;
      throw error;
    }
  });
}

/** The concept a name denotes, the program's or the library's, or undefined when it names no concept. */
export function conceptNamed(
  compiler: Compiler,
  name: Syntax
): ConceptInfo | ((args: Type[], row: number) => boolean) | undefined {
  if (name.type === 'qualified_identifier' && fieldOf(name, 'scope')?.text === 'std') {
    const inner = fieldOf(name, 'name') as Syntax;
    const plain = inner.type === 'template_type' || inner.type === 'template_function' ? fieldOf(inner, 'name') : inner;
    const library = plain && LIBRARY_CONCEPTS[plain.text];
    if (library) return (args, row) => library(compiler, args, row);
    return undefined;
  }
  const entity =
    name.type === 'qualified_identifier' ? compiler.lookupQualified(name, true) : compiler.findName(name.text, true);
  if (entity?.kind === 'template' && entity.template.program?.kind === 'concept')
    return entity.template.program as unknown as ConceptInfo;
  return undefined;
}

/** Whether template arguments satisfy a concept. */
export function satisfiesConcept(
  compiler: Compiler,
  concept: ConceptInfo | ((args: Type[], row: number) => boolean),
  args: Type[],
  row: number
): boolean {
  if (typeof concept === 'function') return concept(args, row);
  const bindings = new TemplateBindings();
  for (const [index, parameter] of concept.parameters.entries()) {
    if (parameter.isPack) {
      bindings.bind(parameter, args.slice(index));
      break;
    }
    const argument = args[index];
    if (!argument) return compiler.error(row, `コンセプト ${concept.name} のテンプレート引数が足りません。`);
    bindings.bind(parameter, argument);
  }
  return compiler.inTemplateOf(concept, bindings, () => evaluateConstraint(compiler, concept.node as Syntax));
}

/** The concept a type constraint names with the arguments after the first (`std::convertible_to<int>`). */
function typeConstraint(
  compiler: Compiler,
  node: Syntax
): { concept: ConceptInfo | ((args: Type[], row: number) => boolean); args: Type[] } | undefined {
  const named = node.type === 'qualified_identifier' ? (fieldOf(node, 'name') as Syntax) : node;
  const list =
    named.type === 'template_type' || named.type === 'template_function' ? fieldOf(named, 'arguments') : undefined;
  const nameNode =
    node.type === 'qualified_identifier'
      ? {
          ...node,
          all: node.all.map((child) => (child === named && list ? (fieldOf(named, 'name') as Syntax) : child)),
        }
      : list
        ? (fieldOf(named, 'name') as Syntax)
        : named;
  const concept = conceptNamed(compiler, nameNode);
  if (!concept) return undefined;
  return { concept, args: list ? compiler.templateArgumentsOf(list) : [] };
}

/** Whether a type satisfies a type constraint (`std::integral` of `template <std::integral T>`). */
export function satisfiesTypeConstraint(compiler: Compiler, constraint: Syntax, type: Type): boolean {
  const named = typeConstraint(compiler, constraint);
  if (!named) return compiler.error(constraint.row, `${constraint.text} はコンセプトではありません。`);
  return satisfiesConcept(compiler, named.concept, [type, ...named.args], constraint.row);
}

/** Whether a template parameter's declared type names a concept, which makes it a constrained type parameter. */
export function isConceptName(compiler: Compiler, node: Syntax): boolean {
  try {
    return typeConstraint(compiler, node) !== undefined;
  } catch (error) {
    if (error instanceof CompileError) return false;
    throw error;
  }
}

/** Evaluates a constraint expression where the template's parameters are bound (C++20 [temp.constr]). */
export function evaluateConstraint(compiler: Compiler, node: Syntax): boolean {
  switch (node.type) {
    case 'constraint_conjunction': {
      return (
        evaluateConstraint(compiler, namedField(node, 'left')) &&
        evaluateConstraint(compiler, namedField(node, 'right'))
      );
    }
    case 'constraint_disjunction': {
      return (
        evaluateConstraint(compiler, namedField(node, 'left')) ||
        evaluateConstraint(compiler, namedField(node, 'right'))
      );
    }
    case 'requires_clause': {
      // The grammar gives the parentheses of `requires (!C<T>)` the constraint's field too.
      const constraint = node.children.find((child) => child.field === 'constraint');
      return evaluateConstraint(compiler, constraint as Syntax);
    }
    case 'parenthesized_expression': {
      return evaluateConstraint(compiler, node.children[0]);
    }
    case 'requires_expression': {
      return requirementsHold(compiler, node);
    }
    case 'template_type':
    case 'template_function':
    case 'qualified_identifier': {
      const named = typeConstraint(compiler, node);
      if (named) return satisfiesConcept(compiler, named.concept, named.args, node.row);
      break;
    }
    case 'binary_expression': {
      // A concept's definition writes conjunctions and disjunctions as `&&` and `||` expressions.
      const operator = node.all.find((child) => !child.isNamed && ['&&', '||', 'and', 'or'].includes(child.type))?.type;
      if (operator === '&&' || operator === 'and')
        return (
          evaluateConstraint(compiler, namedField(node, 'left')) &&
          evaluateConstraint(compiler, namedField(node, 'right'))
        );
      if (operator === '||' || operator === 'or')
        return (
          evaluateConstraint(compiler, namedField(node, 'left')) ||
          evaluateConstraint(compiler, namedField(node, 'right'))
        );
      break;
    }
    case 'unary_expression': {
      const argument = namedField(node, 'argument');
      if (node.all.some((child) => child.type === '!' || child.type === 'not'))
        return !evaluateConstraint(compiler, argument);
      break;
    }
    default: {
      break;
    }
  }
  // The grammar reads a variable template's instance (`requires is_small<T>`) as a type.
  const expression: Syntax = node.type === 'template_type' ? { ...node, type: 'template_function' } : node;
  let constant: number | bigint | undefined;
  try {
    constant = compiler.unevaluated(() => compiler.constantValueOf(compiler.compileExpression(expression)));
  } catch (error) {
    if (error instanceof CompileError) return false;
    throw error;
  }
  if (constant === undefined) return compiler.error(node.row, `制約 ${node.text} は定数式でなければなりません。`);
  return Number(constant) !== 0;
}

/** Whether a requires expression's requirements hold: each compiles, with its parameters as unevaluated values. */
export function requirementsHold(compiler: Compiler, node: Syntax): boolean {
  const parameters = fieldOf(node, 'parameters');
  const requirements = fieldOf(node, 'requirements')?.children ?? [];
  return compiler.withRequiresParameters(parameters, () =>
    requirements.every((requirement) => requirementHolds(compiler, requirement))
  );
}

function requirementHolds(compiler: Compiler, requirement: Syntax): boolean {
  switch (requirement.type) {
    case 'simple_requirement': {
      const expression = requirement.children[0];
      if (!expression) return true;
      // The grammar reads a nested requirement (`requires sizeof(T) >= 4;`) as an expression starting with a clause.
      const nested = /^requires\b([\s\S]*);$/.exec(requirement.text.trim());
      if (nested) {
        const constraint = parseExpressionAt(nested[1], requirement);
        if (!constraint)
          return compiler.error(requirement.row, `requires の後の条件 ${nested[1].trim()} を読めません。`);
        return evaluateConstraint(compiler, constraint);
      }
      return compiles(compiler, () => compiler.compileExpression(expression));
    }
    case 'type_requirement': {
      const type = requirement.children[0];
      return compiles(compiler, () => compiler.resolveTypeSpecifier(type, false, true));
    }
    case 'compound_requirement': {
      const expression = requirement.children.find(
        (child) => child.type !== 'trailing_return_type' && child.type !== 'noexcept'
      ) as Syntax;
      let expr: Expr | undefined;
      if (!compiles(compiler, () => (expr = compiler.compileExpression(expression)))) return false;
      const trailing = requirement.children.find((child) => child.type === 'trailing_return_type');
      if (!trailing || !expr) return true;
      const constraint = fieldOf(trailing.children[0], 'type') as Syntax;
      // `{ e } -> C<Args>` checks `C<decltype((e)), Args>`.
      const type = expr.isLvalue && !expr.isXvalue ? ({ kind: 'reference', to: expr.type } as Type) : expr.type;
      return satisfiesTypeConstraint(compiler, constraint, type);
    }
    default: {
      return compiler.unsupported(requirement.row, `requires 式の要件 ${requirement.text}`);
    }
  }
}

/** The type parameters of a template that its parameter list constrains with a concept (`template <std::integral T>`). */
export function constrainedParameters(compiler: Compiler, parameters: TemplateParameter[]): TemplateParameter[] {
  return parameters.map((parameter) => {
    if (parameter.kind !== 'value' || !parameter.valueType || !isConceptName(compiler, parameter.valueType))
      return parameter;
    const declaration = parameter.valueDeclaration as Syntax;
    const declarator = fieldOf(declaration, 'declarator');
    return {
      name: declarator?.type === 'variadic_declarator' ? declarator.children[0]?.text : declarator?.text,
      kind: 'type',
      isPack: parameter.isPack,
      constraint: parameter.valueType,
      defaultValue: parameter.defaultValue,
    };
  });
}

export { typeName };
