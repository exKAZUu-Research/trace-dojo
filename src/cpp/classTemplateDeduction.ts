import type { Compiler } from './compiler';
import type { Expr } from './expr';
import {
  type ClassTemplateInfo,
  Deduction,
  isSubstitutionFailure,
  type TemplateArgument,
  type TemplateParameter,
  templateParameters,
} from './programTemplates';
import type { Scope } from './scopes';
import { fieldOf, type Syntax } from './syntax';
import { functionDeclarator } from './templateCompiler';
import { type Type, typeName } from './types';

/** A deduction guide the program declares (`template <class T> Box(T) -> Box<T>;`). */
export interface DeductionGuide {
  readonly parameters: TemplateParameter[];
  /** The guide's declaration, whose declarator lists its parameters and gives its result after `->`. */
  readonly node: Syntax;
  readonly enclosing: Scope[];
}

/** A function a class template argument deduction considers, with its template parameters and parameter list. */
interface Candidate {
  readonly parameters: TemplateParameter[];
  readonly declarations: readonly Syntax[];
  /** The class its deduced bindings make, or undefined when they make none. */
  readonly result: (bindings: Deduction) => Type | undefined;
}

/**
 * The instance of a program's class template that an initializer's arguments deduce, as the implicit guides of its
 * constructors, the guides the program declares, the copy deduction candidate, and an aggregate's members do (C++20
 * [over.match.class.deduct]). The guides the program declares win over the constructors, as the tie-breaker of
 * overload resolution makes them.
 */
export function deduceProgramClass(
  compiler: Compiler,
  info: ClassTemplateInfo,
  args: readonly Expr[],
  row: number
): Type {
  const [only] = args;
  // The copy deduction candidate: a single argument of an instance of the template deduces that instance.
  if (args.length === 1 && only.type.kind === 'class' && only.type.cls.templateOrigin === info) return only.type;
  const constructors = constructorCandidates(compiler, info);
  const aggregate = constructors.length === 0 ? aggregateCandidate(compiler, info) : undefined;
  for (const group of [guideCandidates(compiler, info), constructors, aggregate ? [aggregate] : []]) {
    for (const candidate of group) {
      const deduced = tryCandidate(compiler, candidate, args);
      if (deduced) return deduced;
    }
  }
  return compiler.error(
    row,
    `クラステンプレート ${info.name} のテンプレート引数を、初期値（${args.map((arg) => (arg.braced ? '{...}' : typeName(arg.type))).join(', ')}）から推論できません。`
  );
}

function tryCandidate(compiler: Compiler, candidate: Candidate, args: readonly Expr[]): Type | undefined {
  const deduction = new Deduction(compiler, candidate.parameters);
  try {
    let index = 0;
    for (const declaration of candidate.declarations) {
      const pattern = deduction.pattern(declaration, fieldOf(declaration, 'declarator'));
      if (declaration.type === 'variadic_parameter_declaration') {
        for (; index < args.length; index++) if (!matches(deduction, pattern, args[index])) return undefined;
        break;
      }
      const arg = args[index];
      if (!arg) {
        if (declaration.type === 'optional_parameter_declaration') continue;
        return undefined;
      }
      index++;
      if (!matches(deduction, pattern, arg)) return undefined;
    }
    if (index < args.length) return undefined;
    return candidate.result(deduction);
  } catch (error) {
    if (isSubstitutionFailure(error)) return undefined;
    throw error;
  }
}

/** Whether an argument matches a parameter's pattern; a braced list deduces nothing, so it matches any. */
function matches(deduction: Deduction, pattern: ReturnType<Deduction['pattern']>, arg: Expr): boolean {
  return arg.braced !== undefined || deduction.matchArgument(pattern, arg);
}

function guideCandidates(compiler: Compiler, info: ClassTemplateInfo): Candidate[] {
  return info.guides.map((guide) => {
    const declarator = functionDeclarator(fieldOf(guide.node, 'declarator') as Syntax) as Syntax;
    const resultNode = declarator.children.find((child) => child.type === 'trailing_return_type')?.children[0];
    return {
      parameters: guide.parameters,
      declarations: fieldOf(declarator, 'parameters')?.children ?? [],
      result: (deduction) => {
        const bindings = compiler.completeTemplateBindings({ ...info, parameters: guide.parameters }, deduction);
        if (!bindings || !resultNode) return;
        return compiler.typeInTemplate({ ...info, enclosing: guide.enclosing }, bindings, resultNode);
      },
    };
  });
}

function constructorCandidates(compiler: Compiler, info: ClassTemplateInfo): Candidate[] {
  const body = info.node && fieldOf(info.node, 'body');
  const candidates: Candidate[] = [];
  for (const member of body?.children ?? []) {
    const isTemplate = member.type === 'template_declaration';
    const declaration = isTemplate
      ? member.children.find((child) => child.field !== 'parameters' && child.type !== 'requires_clause')
      : member;
    const written = declaration && fieldOf(declaration, 'declarator');
    const declarator = written && functionDeclarator(written);
    const name = declarator && fieldOf(declarator, 'declarator');
    if (!declarator || name?.text !== info.name || fieldOf(declaration, 'type')) continue;
    const own = isTemplate ? templateParameters(fieldOf(member, 'parameters') as Syntax) : [];
    candidates.push({
      parameters: [...info.parameters, ...own],
      declarations: fieldOf(declarator, 'parameters')?.children ?? [],
      result: (deduction) => instanceOf(compiler, info, deduction),
    });
  }
  return candidates;
}

/** The aggregate deduction candidate, whose parameters are an aggregate's members (C++20 [over.match.class.deduct]). */
function aggregateCandidate(compiler: Compiler, info: ClassTemplateInfo): Candidate | undefined {
  const body = info.node && fieldOf(info.node, 'body');
  if (!body) return undefined;
  const declarations: Syntax[] = [];
  for (const member of body.children) {
    if (member.type !== 'field_declaration') continue;
    for (const declarator of member.children.filter((child) => child.field === 'declarator')) {
      if (functionDeclarator(declarator)) continue;
      declarations.push({ ...member, all: [fieldOf(member, 'type') as Syntax, declarator], children: [] });
    }
  }
  return {
    parameters: info.parameters,
    declarations,
    result: (deduction) => instanceOf(compiler, info, deduction),
  };
}

function instanceOf(compiler: Compiler, info: ClassTemplateInfo, deduction: Deduction): Type | undefined {
  const bindings = compiler.completeTemplateBindings(info, deduction);
  if (!bindings) return undefined;
  return compiler.instantiateClassTemplate(info, bindings.args as TemplateArgument[], info.node?.row ?? 0);
}
