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

function translate(clauses: QueryClause[], counter: { value: number }, position: Position): Expression {
  const [first, ...rest] = clauses;
  if (first?.kind !== 'from')
    throw new CompileError([
      { row: position.row, message: 'CS0742: クエリ本体の後には select 句または group 句が必要です' },
    ]);
  let source = first.type ? call(first.source, 'Cast', [], first, [first.type]) : first.source;
  let state: RangeState = { variables: [first.name], parameter: first.name };
  for (let index = 0; index < rest.length; index++) {
    const clause = rest[index];
    const isLast = index === rest.length - 1;
    const next = rest[index + 1];
    switch (clause.kind) {
      case 'from': {
        const collection = clause.type ? call(clause.source, 'Cast', [], clause, [clause.type]) : clause.source;
        if (next?.kind === 'select') {
          source = call(
            source,
            'SelectMany',
            [lambda(state, collection, clause), lambda2(state, clause.name, next.value, clause)],
            clause
          );
          index++;
          state = { variables: [], parameter: '' };
          continue;
        }
        const [selected, nextState] = combine(
          state,
          clause.name,
          { kind: 'name', name: clause.name, typeArgs: undefined, row: clause.row, column: clause.column },
          counter,
          clause
        );
        source = call(
          source,
          'SelectMany',
          [lambda(state, collection, clause), lambda2(state, clause.name, selected, clause)],
          clause
        );
        state = nextState;
        break;
      }
      case 'let': {
        const [selected, nextState] = combine(state, clause.name, clause.value, counter, clause);
        source = call(source, 'Select', [lambda(state, selected, clause)], clause);
        state = nextState;
        break;
      }
      case 'where': {
        source = call(source, 'Where', [lambda(state, clause.condition, clause)], clause);
        break;
      }
      case 'join': {
        const inner = clause.type ? call(clause.source, 'Cast', [], clause, [clause.type]) : clause.source;
        const innerKey: Expression = {
          kind: 'lambda',
          parameters: [parameter(clause.name, clause)],
          body: clause.innerKey,
          isStatic: false,
          returnType: undefined,
          ...at(clause),
        };
        const method = clause.into ? 'GroupJoin' : 'Join';
        const resultName = clause.into ?? clause.name;
        if (next?.kind === 'select') {
          source = call(
            source,
            method,
            [inner, lambda(state, clause.outerKey, clause), innerKey, lambda2(state, resultName, next.value, clause)],
            clause
          );
          index++;
          state = { variables: [], parameter: '' };
          continue;
        }
        const [selected, nextState] = combine(
          state,
          resultName,
          { kind: 'name', name: resultName, typeArgs: undefined, ...at(clause) },
          counter,
          clause
        );
        source = call(
          source,
          method,
          [inner, lambda(state, clause.outerKey, clause), innerKey, lambda2(state, resultName, selected, clause)],
          clause
        );
        state = nextState;
        break;
      }
      case 'orderby': {
        for (const [position2, ordering] of clause.orderings.entries()) {
          const name =
            position2 === 0
              ? ordering.descending
                ? 'OrderByDescending'
                : 'OrderBy'
              : ordering.descending
                ? 'ThenByDescending'
                : 'ThenBy';
          source = call(source, name, [lambda(state, ordering.key, clause)], clause);
        }
        break;
      }
      case 'select': {
        const isIdentity =
          clause.value.kind === 'name' &&
          state.variables.length === 1 &&
          clause.value.name === state.variables[0] &&
          state.parameter === state.variables[0];
        // A select of the range variable itself adds no call, unless the query would otherwise be its source alone.
        if (!(isIdentity && source !== first.source))
          source = call(source, 'Select', [lambda(state, clause.value, clause)], clause);
        if (!isLast) {
          const continuation = rest[index + 1];
          if (continuation?.kind !== 'into') throw unexpected(continuation ?? clause);
        }
        state = { variables: [], parameter: '' };
        break;
      }
      case 'group': {
        const isIdentity =
          clause.value.kind === 'name' &&
          state.variables.length === 1 &&
          state.parameter === state.variables[0] &&
          clause.value.name === state.variables[0];
        const args = isIdentity
          ? [lambda(state, clause.key, clause)]
          : [lambda(state, clause.key, clause), lambda(state, clause.value, clause)];
        source = call(source, 'GroupBy', args, clause);
        state = { variables: [], parameter: '' };
        break;
      }
      case 'into': {
        state = { variables: [clause.name], parameter: clause.name };
        break;
      }
    }
  }
  if (state.variables.length > 0)
    throw new CompileError([
      { row: position.row, message: 'CS0742: クエリ本体の後には select 句または group 句が必要です' },
    ]);
  return source;
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
