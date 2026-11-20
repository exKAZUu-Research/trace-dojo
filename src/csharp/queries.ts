import { CompileError } from '../interpreter/diagnostics';
import type { Expression, LambdaParameter, Position, QueryClause, TypeNode } from './ast';

/** The prefix of the lambda parameters that carry several range variables, which no program can name. */
export const TRANSPARENT_PREFIX = '<>h__TransparentIdentifier';

/** The range variables in scope: one plain variable, or several carried by a transparent identifier. */
interface RangeState {
  variables: string[];
  /** The name of the lambda parameter that carries the variables. */
  parameter: string;
}

/**
 * Translates a query expression into method calls as the C# specification does (§12.20.3): `from x in xs where c
 * select e` becomes `xs.Where(x => c).Select(x => e)`, and clauses that add range variables carry them in anonymous
 * objects whose lambda parameters the binder looks names up in.
 */
export function desugarQuery(node: Extract<Expression, { kind: 'query' }>): Expression {
  const counter = { value: 0 };
  return translate(node.clauses, counter, node);
}

/** The method calls translated so far, with the range variables in scope after them. */
interface Translation {
  source: Expression;
  state: RangeState;
  readonly counter: { value: number };
  /** The query's first source, on which even a select of the range variable itself calls `Select`. */
  readonly firstSource: Expression;
}

function translate(clauses: QueryClause[], counter: { value: number }, position: Position): Expression {
  const [first, ...rest] = clauses;
  if (first?.kind !== 'from') throw unexpected(position);
  const translation: Translation = {
    source: castSource(first),
    state: { variables: [first.name], parameter: first.name },
    counter,
    firstSource: first.source,
  };
  for (let index = 0; index < rest.length; index++) {
    if (translateClause(translation, rest[index], rest[index + 1])) index++;
  }
  if (translation.state.variables.length > 0) throw unexpected(position);
  return translation.source;
}

/** Translates one clause, telling whether it also consumed the select clause that follows it. */
function translateClause(translation: Translation, clause: QueryClause, next: QueryClause | undefined): boolean {
  const { state } = translation;
  switch (clause.kind) {
    case 'from': {
      return translateFrom(translation, clause, next);
    }
    case 'let': {
      const [selected, nextState] = combine(state, clause.name, clause.value, translation.counter, clause);
      translation.source = call(translation.source, 'Select', [lambda(state, selected, clause)], clause);
      translation.state = nextState;
      return false;
    }
    case 'where': {
      translation.source = call(translation.source, 'Where', [lambda(state, clause.condition, clause)], clause);
      return false;
    }
    case 'join': {
      return translateJoin(translation, clause, next);
    }
    case 'orderby': {
      for (const [index, ordering] of clause.orderings.entries()) {
        const name = `${index === 0 ? 'OrderBy' : 'ThenBy'}${ordering.descending ? 'Descending' : ''}`;
        translation.source = call(translation.source, name, [lambda(state, ordering.key, clause)], clause);
      }
      return false;
    }
    case 'select': {
      translateSelect(translation, clause, next);
      return false;
    }
    case 'group': {
      translateGroup(translation, clause);
      return false;
    }
    case 'into': {
      translation.state = { variables: [clause.name], parameter: clause.name };
      return false;
    }
  }
}

function translateFrom(
  translation: Translation,
  clause: Extract<QueryClause, { kind: 'from' }>,
  next: QueryClause | undefined
): boolean {
  const { state } = translation;
  const collection = castSource(clause);
  if (next?.kind === 'select') {
    translation.source = call(
      translation.source,
      'SelectMany',
      [lambda(state, collection, clause), lambda2(state, clause.name, next.value, clause)],
      clause
    );
    translation.state = { variables: [], parameter: '' };
    return true;
  }
  const [selected, nextState] = combine(
    state,
    clause.name,
    { kind: 'name', name: clause.name, typeArgs: undefined, row: clause.row, column: clause.column },
    translation.counter,
    clause
  );
  translation.source = call(
    translation.source,
    'SelectMany',
    [lambda(state, collection, clause), lambda2(state, clause.name, selected, clause)],
    clause
  );
  translation.state = nextState;
  return false;
}

function translateJoin(
  translation: Translation,
  clause: Extract<QueryClause, { kind: 'join' }>,
  next: QueryClause | undefined
): boolean {
  const { state } = translation;
  const inner = castSource(clause);
  const innerKey: Expression = {
    kind: 'lambda',
    isQuery: true,
    parameters: [parameter(clause.name, clause)],
    body: clause.innerKey,
    isStatic: false,
    returnType: undefined,
    ...at(clause),
  };
  const method = clause.into ? 'GroupJoin' : 'Join';
  const resultName = clause.into ?? clause.name;
  if (next?.kind === 'select') {
    translation.source = call(
      translation.source,
      method,
      [inner, lambda(state, clause.outerKey, clause), innerKey, lambda2(state, resultName, next.value, clause)],
      clause
    );
    translation.state = { variables: [], parameter: '' };
    return true;
  }
  const [selected, nextState] = combine(
    state,
    resultName,
    { kind: 'name', name: resultName, typeArgs: undefined, ...at(clause) },
    translation.counter,
    clause
  );
  translation.source = call(
    translation.source,
    method,
    [inner, lambda(state, clause.outerKey, clause), innerKey, lambda2(state, resultName, selected, clause)],
    clause
  );
  translation.state = nextState;
  return false;
}

function translateSelect(
  translation: Translation,
  clause: Extract<QueryClause, { kind: 'select' }>,
  next: QueryClause | undefined
): void {
  const { state } = translation;
  const isIdentity =
    clause.value.kind === 'name' &&
    state.variables.length === 1 &&
    clause.value.name === state.variables[0] &&
    state.parameter === state.variables[0];
  // A select of the range variable itself adds no call, unless the query would otherwise be its source alone.
  if (!(isIdentity && translation.source !== translation.firstSource))
    translation.source = call(translation.source, 'Select', [lambda(state, clause.value, clause)], clause);
  if (next && next.kind !== 'into') throw unexpected(next);
  translation.state = { variables: [], parameter: '' };
}

function translateGroup(translation: Translation, clause: Extract<QueryClause, { kind: 'group' }>): void {
  const { state } = translation;
  const isIdentity =
    clause.value.kind === 'name' &&
    state.variables.length === 1 &&
    state.parameter === state.variables[0] &&
    clause.value.name === state.variables[0];
  const args = isIdentity
    ? [lambda(state, clause.key, clause)]
    : [lambda(state, clause.key, clause), lambda(state, clause.value, clause)];
  translation.source = call(translation.source, 'GroupBy', args, clause);
  translation.state = { variables: [], parameter: '' };
}

/** The source of a `from` or `join` clause, cast to the element type the clause declares. */
function castSource(clause: Extract<QueryClause, { kind: 'from' | 'join' }>): Expression {
  return clause.type ? call(clause.source, 'Cast', [], clause, [clause.type]) : clause.source;
}

function unexpected(position: Position): CompileError {
  return new CompileError([
    { row: position.row, message: 'CS0742: クエリ本体の後には select 句または group 句が必要です' },
  ]);
}

/** Adds a range variable, carrying the ones in scope with it in an anonymous object under a new transparent identifier. */
function combine(
  state: RangeState,
  name: string,
  value: Expression,
  counter: { value: number },
  position: Position
): [Expression, RangeState] {
  const members = [
    ...state.variables.map((variable) => ({
      name: variable,
      value: { kind: 'name', name: variable, typeArgs: undefined, ...at(position) } as Expression,
    })),
    { name, value },
  ];
  const selected: Expression = { kind: 'anonymousObject', members, ...at(position) };
  const parameterName = `${TRANSPARENT_PREFIX}${counter.value++}`;
  return [selected, { variables: [...state.variables, name], parameter: parameterName }];
}

function lambda(state: RangeState, body: Expression, position: Position): Expression {
  return {
    kind: 'lambda',
    isQuery: true,
    parameters: [parameter(state.parameter, position)],
    body,
    isStatic: false,
    returnType: undefined,
    ...at(position),
  };
}

function lambda2(state: RangeState, second: string, body: Expression, position: Position): Expression {
  return {
    kind: 'lambda',
    isQuery: true,
    parameters: [parameter(state.parameter, position), parameter(second, position)],
    body,
    isStatic: false,
    returnType: undefined,
    ...at(position),
  };
}

function parameter(name: string, position: Position): LambdaParameter {
  return { name, type: undefined, modifier: undefined, ...at(position) };
}

function call(
  target: Expression,
  name: string,
  args: Expression[],
  position: Position,
  typeArgs?: TypeNode[]
): Expression {
  return {
    kind: 'invocation',
    target: { kind: 'memberAccess', target, name, typeArgs, nameRow: position.row, ...at(position) },
    args: args.map((value) => ({ name: undefined, modifier: undefined, value, ...at(position) })),
    ...at(position),
  };
}

function at(position: Position): Position {
  return { row: position.row, column: position.column };
}
