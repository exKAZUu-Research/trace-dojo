import type { Block, Expression, Statement } from './ast';

/*
 * The rewrites that let suspend code run as a coroutine's steps: Kotlin constructs whose parts may suspend, written as
 * the statements that make the same calls in the same order, where only statements and variables' values suspend.
 */

let hiddenNames = 0;

export function hiddenName(what: string): string {
  return `\0${what}${hiddenNames++}`;
}

const SUBJECT = 'subject';

/** Whether a name is that of the variable `whenAsIf` holds a `when` subject in. */
export function isHiddenSubject(name: string): boolean {
  return name.startsWith(`\0${SUBJECT}`);
}

export function propertyStatement(row: number, name: string, initializer: Expression): Statement {
  return {
    kind: 'property',
    row,
    modifiers: { keywords: new Set(), annotations: [] },
    isVar: false,
    name,
    type: undefined,
    receiver: undefined,
    typeParameters: [],
    initializer,
    delegate: undefined,
    getter: undefined,
    setter: undefined,
  };
}

/** `for (x in xs) body` as `val it = xs.iterator(); while (it.hasNext()) { val x = it.next(); body }`. */
export function forAsWhile(statement: Extract<Statement, { kind: 'for' }>): Statement[] {
  const { row } = statement;
  const iterator = hiddenName('iterator');
  const read: Expression = { kind: 'name', row, name: iterator };
  const call = (receiver: Expression, name: string): Expression => ({
    kind: 'call',
    row,
    callee: { kind: 'member', row, receiver, name, isSafe: false },
    typeArgs: [],
    args: [],
    trailingLambda: undefined,
  });
  const { variable } = statement;
  const element: Statement =
    'names' in variable
      ? {
          kind: 'destructuring',
          row,
          modifiers: { keywords: new Set(), annotations: [] },
          isVar: false,
          names: variable.names,
          initializer: call(read, 'next'),
        }
      : ({ ...propertyStatement(row, variable.name, call(read, 'next')), type: variable.type } as Statement);
  return [
    propertyStatement(row, iterator, call(statement.iterable, 'iterator')),
    {
      kind: 'while',
      row,
      label: statement.label,
      condition: call(read, 'hasNext'),
      body: { ...statement.body, statements: [element, ...statement.body.statements] },
    },
  ];
}

/**
 * `when` as the statements it stands for: its subject held in a variable, then the `if` chain that tests it, which a
 * scope of their own must hold so that the variable ends with the `when`.
 */
export function whenAsIf(expression: Extract<Expression, { kind: 'when' }>): Statement[] {
  const { row } = expression;
  // `when (val x = ...)` reads its subject through its own variable, which its branches see.
  const subjectName = expression.subjectVariable?.name ?? hiddenName(SUBJECT);
  const subject: Expression = { kind: 'name', row, name: subjectName };
  const test = (
    condition: Extract<Expression, { kind: 'when' }>['entries'][number]['conditions'][number]
  ): Expression => {
    if (!expression.subject) return (condition as { expression: Expression }).expression;
    switch (condition.kind) {
      case 'is': {
        return { kind: 'is', row: condition.row, negated: condition.negated, operand: subject, type: condition.type };
      }
      case 'in': {
        return {
          kind: 'in',
          row: condition.row,
          negated: condition.negated,
          left: subject,
          right: condition.expression,
        };
      }
      default: {
        return { kind: 'binary', row: condition.row, operator: '==', left: subject, right: condition.expression };
      }
    }
  };
  let chain: Block | undefined;
  for (const entry of expression.entries.toReversed()) {
    if (entry.conditions.length === 0 && !entry.guard) {
      chain = entry.body;
      continue;
    }
    const [first, ...rest] = entry.conditions.map(test);
    let condition: Expression = first;
    for (const right of rest) condition = { kind: 'binary', row: entry.row, operator: '||', left: condition, right };
    if (entry.guard)
      condition = { kind: 'binary', row: entry.row, operator: '&&', left: condition, right: entry.guard };
    chain = {
      row: entry.row,
      endRow: entry.body.endRow,
      isBraced: true,
      statements: [
        {
          kind: 'expressionStatement',
          row: entry.row,
          expression: { kind: 'if', row: entry.row, condition, thenBranch: entry.body, elseBranch: chain },
        },
      ],
    };
  }
  return [
    ...(expression.subject ? [subjectStatement(expression, subjectName, expression.subject)] : []),
    ...(chain?.statements ?? []),
  ];
}

function subjectStatement(
  expression: Extract<Expression, { kind: 'when' }>,
  name: string,
  subject: Expression
): Statement {
  const statement = propertyStatement(expression.row, name, subject);
  const declared = expression.subjectVariable?.type;
  return declared ? ({ ...statement, type: declared } as Statement) : statement;
}

const nameOf = (row: number, name: string): Expression => ({ kind: 'name', row, name });

const block = (row: number, statements: Statement[]): Block => ({ row, endRow: row, isBraced: true, statements });

const expressionStatement = (expression: Expression): Statement => ({
  kind: 'expressionStatement',
  row: expression.row,
  expression,
});

const ifStatement = (row: number, condition: Expression, thenBranch: Block, elseBranch?: Block): Statement =>
  expressionStatement({ kind: 'if', row, condition, thenBranch, elseBranch });

/** `v != null`, whose `if` sees `v` as not null. */
function isNotNull(row: number, name: string): Expression {
  return { kind: 'binary', row, operator: '!=', left: nameOf(row, name), right: { kind: 'null', row } };
}

/** Whether an expression is `a && b`, `a || b`, or `a ?: b`, whose right side runs only when its left side asks. */
export function isShortCircuit(expression: Expression): expression is Extract<Expression, { kind: 'binary' }> {
  return expression.kind === 'binary' && ['&&', '||', '?:'].includes(expression.operator);
}

/**
 * The statements that give an expression's value to `assign`: an `if`, `when`, or `try` whose branches end by
 * assigning what they end with, and `&&`, `||`, and `?:` as the `if` that runs their right side only when needed.
 */
export function assignedForm(expression: Expression, assign: (value: Expression) => Statement): Statement[] {
  const { row } = expression;
  const assignLast = (body: Block): Block => {
    const last = body.statements.at(-1);
    const statements =
      last?.kind === 'expressionStatement'
        ? [...body.statements.slice(0, -1), assign(last.expression)]
        : [...body.statements, assign(nameOf(body.endRow, 'Unit'))];
    return { ...body, statements };
  };
  switch (expression.kind) {
    case 'parenthesized': {
      return assignedForm(expression.expression, assign);
    }
    case 'if': {
      const elseBranch = expression.elseBranch ? assignLast(expression.elseBranch) : undefined;
      return [ifStatement(row, expression.condition, assignLast(expression.thenBranch), elseBranch)];
    }
    case 'when': {
      const entries = expression.entries.map((entry) => ({ ...entry, body: assignLast(entry.body) }));
      return whenAsIf({ ...expression, entries });
    }
    case 'try': {
      const catches = expression.catches.map((clause) => ({ ...clause, body: assignLast(clause.body) }));
      return [expressionStatement({ ...expression, body: assignLast(expression.body), catches })];
    }
    case 'binary': {
      const { left, right } = expression;
      const constant = (value: boolean): Expression => ({ kind: 'boolean', row, value });
      if (expression.operator === '&&')
        return [ifStatement(row, left, block(row, [assign(right)]), block(row, [assign(constant(false))]))];
      if (expression.operator === '||')
        return [ifStatement(row, left, block(row, [assign(constant(true))]), block(row, [assign(right)]))];
      const held = hiddenName('elvis');
      return [
        propertyStatement(row, held, left),
        ifStatement(row, isNotNull(row, held), block(row, [assign(nameOf(row, held))]), block(row, [assign(right)])),
      ];
    }
    default: {
      return [assign(expression)];
    }
  }
}

/**
 * `a?.f(x)` as the `if` it stands for, `if (a != null) a.f(x) else null` with `a` held in a variable, so that its
 * arguments run only when `a` is not null.
 */
export function safeCallAsIf(call: Extract<Expression, { kind: 'call' }>): Expression {
  const { row } = call;
  const callee = call.callee as Extract<Expression, { kind: 'member' }>;
  const held = hiddenName('receiver');
  const unsafe: Expression = { ...call, callee: { ...callee, receiver: nameOf(row, held), isSafe: false } };
  const test: Expression = {
    kind: 'if',
    row,
    condition: isNotNull(row, held),
    thenBranch: block(row, [expressionStatement(unsafe)]),
    elseBranch: block(row, [expressionStatement({ kind: 'null', row })]),
  };
  return {
    kind: 'if',
    row,
    condition: { kind: 'boolean', row, value: true },
    thenBranch: block(row, [propertyStatement(row, held, callee.receiver), expressionStatement(test)]),
    elseBranch: block(row, [expressionStatement({ kind: 'null', row })]),
  };
}
