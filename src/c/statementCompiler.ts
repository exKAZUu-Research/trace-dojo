import type { Scalar, Value } from './arith';
import { convertScalar } from './arith';
import type { Compound, Declaration, Expression, Statement, StaticAssert } from './ast';
import type { FunctionContext, SwitchContext } from './compilerBase';
import { ExpressionCompiler } from './expressionCompiler';
import { evaluate } from './pointerBounds';
import { Completion, type Exec, type Frame, type LocalInfo } from './runtime';
import { type CType, isInteger, promote, typeName, unqualified } from './types';

/** A compiled statement and the labels inside it, where a `goto` or `switch` may enter it. */
export interface Compiled {
  exec: Exec;
  labels: ReadonlySet<number>;
}

const NO_LABELS: ReadonlySet<number> = new Set();
const NOOP: Compiled = { exec: () => Completion.Normal, labels: NO_LABELS };

export abstract class StatementCompiler extends ExpressionCompiler {
  /** Compiles a block-scope declaration, which runs its initializers when control reaches it. */
  protected abstract localDeclaration(declaration: Declaration): Compiled;

  protected get context(): FunctionContext {
    return this.fn as FunctionContext;
  }

  /** The row whose step a statement records, when the program is traced. */
  protected stepRow(row: number): number | undefined {
    return this.isTracing ? row : undefined;
  }

  /**
   * @param isFunctionBody Whether the block is a function's body, which shares the parameters' scope and keeps its
   * variables when it ends, so that the trace can read them as the function returns.
   */
  protected compound(compound: Compound, isFunctionBody = false): Compiled {
    const compile = (): Compiled => this.blockItems(compound.items, !isFunctionBody);
    return isFunctionBody ? compile() : this.withScope(compile);
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- Running a block from a label, and leaving its scope.
  // code-gauge-allow functionNcss 40 -- Label dispatch, lexical lifetime and completion share the child list.
  private blockItems(items: (Statement | Declaration | StaticAssert)[], endsScope: boolean): Compiled {
    const children = items.map((item): Compiled => {
      if (item.kind === 'declaration') return this.localDeclaration(item);
      if (item.kind === 'staticAssert') {
        this.staticAssert(item);
        return NOOP;
      }
      return this.statement(item);
    });
    const locals = this.scopeLocals().filter((local) => !local.isParameter);
    const labels = new Set<number>();
    const childOfLabel = new Map<number, number>();
    for (const [index, child] of children.entries()) {
      for (const label of child.labels) {
        labels.add(label);
        childOfLabel.set(label, index);
      }
    }
    const execs = children.map((child) => child.exec);
    const count = execs.length;
    const exec: Exec = (frame, entry) => {
      frame.enterScope(locals);
      let start = 0;
      let enter = entry;
      if (entry !== undefined) start = childOfLabel.get(entry) ?? count;
      try {
        for (let index = start; index < count; index++) {
          const completion = execs[index](frame, enter);
          enter = undefined;
          if (completion === Completion.Normal) continue;
          if (completion === Completion.Goto) {
            const target = childOfLabel.get(frame.gotoLabel);
            if (target !== undefined) {
              index = target - 1;
              enter = frame.gotoLabel;
              continue;
            }
          }
          return completion;
        }
        return Completion.Normal;
      } finally {
        if (endsScope) frame.exitScope(locals);
      }
    };
    return { exec, labels };
  }

  private scopeLocals(): LocalInfo[] {
    return [...this.scope.ordinary.values()].flatMap((entity) => (entity.kind === 'local' ? [entity.local] : []));
  }

  protected statement(statement: Statement): Compiled {
    return this.withVisibility(this.compileStatement(statement));
  }

  protected withVisibility(compiled: Compiled): Compiled {
    if (!this.isTracing) return compiled;
    const locals: LocalInfo[] = [];
    const names = new Set<string>();
    for (let scope: typeof this.scope | undefined = this.scope; scope; scope = scope.parent) {
      for (const [name, entity] of scope.ordinary) {
        if (names.has(name)) continue;
        names.add(name);
        if (entity.kind === 'local') locals.push(entity.local);
      }
    }
    locals.sort((a, b) => a.index - b.index);
    return {
      ...compiled,
      exec: (frame, entry) => {
        const previous = frame.visibleLocals;
        frame.visibleLocals = locals;
        try {
          return compiled.exec(frame, entry);
        } finally {
          if (previous === undefined) frame.finalVisibleLocals = locals;
          frame.visibleLocals = previous;
        }
      },
    };
  }

  // code-gauge-allow functionNcss 43 -- One case per C statement kind; helpers already isolate control-flow construction.
  private compileStatement(statement: Statement): Compiled {
    const { row } = statement;
    switch (statement.kind) {
      case 'compound': {
        return this.compound(statement);
      }
      case 'expression': {
        return this.expressionStatement(statement.expression, row);
      }
      case 'if': {
        return this.ifStatement(statement);
      }
      case 'while': {
        return this.whileStatement(statement);
      }
      case 'doWhile': {
        return this.doWhileStatement(statement);
      }
      case 'for': {
        return this.withScope(() => this.withVisibility(this.forStatement(statement)));
      }
      case 'switch': {
        return this.switchStatement(statement);
      }
      case 'case': {
        return this.caseStatement(statement);
      }
      case 'break': {
        if (this.context.loopDepth === 0 && this.context.switches.length === 0) {
          this.error(row, 'break 文は、ループか switch 文の中にしか書けません。');
        }
        return { exec: () => Completion.Break, labels: NO_LABELS };
      }
      case 'continue': {
        if (this.context.loopDepth === 0) this.error(row, 'continue 文は、ループの中にしか書けません。');
        return { exec: () => Completion.Continue, labels: NO_LABELS };
      }
      case 'return': {
        return this.returnStatement(statement);
      }
      case 'goto': {
        const label = this.label(statement.label, row);
        const id = label.id;
        return {
          exec: (frame) => {
            frame.runtime.spend();
            frame.gotoLabel = id;
            return Completion.Goto;
          },
          labels: NO_LABELS,
        };
      }
      case 'labeled': {
        const label = this.label(statement.label, row);
        if (label.defined) this.error(row, `ラベル「${statement.label}」が2つあります。`);
        label.defined = true;
        label.row = row;
        return this.labeled(label.id, this.statementOrDeclaration(statement.body));
      }
    }
  }

  private statementOrDeclaration(item: Statement | Declaration): Compiled {
    return item.kind === 'declaration' ? this.localDeclaration(item) : this.statement(item);
  }

  private label(name: string, row: number): { id: number; row: number; defined: boolean } {
    const labels = this.context.labels;
    let label = labels.get(name);
    if (!label) {
      label = { id: this.context.nextLabel++, row, defined: false };
      labels.set(name, label);
    }
    return label;
  }

  /** A statement with a label, which a `goto` to the label enters at its start, even from inside it. */
  private labeled(id: number, body: Compiled): Compiled {
    const run = body.exec;
    const exec: Exec = (frame, entry) => {
      let completion = run(frame, entry === id ? undefined : entry);
      while (completion === Completion.Goto && frame.gotoLabel === id) completion = run(frame);
      return completion;
    };
    return { exec, labels: new Set([id, ...body.labels]) };
  }

  protected expressionStatement(expression: Expression | undefined, row: number): Compiled {
    if (!expression) return NOOP;
    const operand = this.rvalue(expression);
    const effect = operand.effect ?? operand.value;
    const step = this.stepRow(row);
    if (step === undefined) {
      return {
        exec: (frame) => {
          frame.runtime.fullExpression(() => effect(frame));
          return Completion.Normal;
        },
        labels: NO_LABELS,
      };
    }
    const onlyCalls = operand.isCall === true;
    return {
      exec: (frame) => {
        frame.runtime.steps.runStatement(step, onlyCalls, () => frame.runtime.fullExpression(() => effect(frame)));
        return Completion.Normal;
      },
      labels: NO_LABELS,
    };
  }

  private ifStatement(statement: Extract<Statement, { kind: 'if' }>): Compiled {
    const condition = this.condition(statement.condition, 'if 文');
    const then = this.withScope(() => this.statement(statement.consequent));
    const otherwise = statement.alternative
      ? this.withScope(() => this.statement(statement.alternative as Statement))
      : NOOP;
    const runThen = then.exec;
    const runOtherwise = otherwise.exec;
    const exec: Exec = (frame, entry) => {
      if (entry !== undefined) return then.labels.has(entry) ? runThen(frame, entry) : runOtherwise(frame, entry);
      return condition(frame) ? runThen(frame) : runOtherwise(frame);
    };
    return { exec, labels: new Set([...then.labels, ...otherwise.labels]) };
  }

  private loopBody(body: Statement): Compiled {
    this.context.loopDepth++;
    try {
      return this.withScope(() => this.statement(body));
    } finally {
      this.context.loopDepth--;
    }
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Loop entry labels and condition/step timing must remain coordinated with completion handling.
  // code-gauge-allow duplicateLines 19 -- While and do-while intentionally mirror completion handling but differ in condition and step timing.
  private whileStatement(statement: Extract<Statement, { kind: 'while' }>): Compiled {
    const condition = this.condition(statement.condition, 'while 文');
    const body = this.loopBody(statement.body);
    const run = body.exec;
    const exec: Exec = (frame, entry) => {
      let enter = entry;
      for (;;) {
        if (enter === undefined) {
          frame.runtime.spend();
          if (!condition(frame)) return Completion.Normal;
        }
        const completion = run(frame, enter);
        enter = undefined;
        if (completion === Completion.Break) return Completion.Normal;
        if (completion !== Completion.Normal && completion !== Completion.Continue) return completion;
      }
    };
    return { exec, labels: body.labels };
  }

  // code-gauge-allow duplicateLines 19 -- While and do-while intentionally mirror completion handling but differ in condition and step timing.
  private doWhileStatement(statement: Extract<Statement, { kind: 'doWhile' }>): Compiled {
    const body = this.loopBody(statement.body);
    const condition = this.condition(statement.condition, 'do while 文');
    const run = body.exec;
    const exec: Exec = (frame, entry) => {
      let enter = entry;
      for (;;) {
        frame.runtime.spend();
        const completion = run(frame, enter);
        enter = undefined;
        if (completion === Completion.Break) return Completion.Normal;
        if (completion !== Completion.Normal && completion !== Completion.Continue) return completion;
        if (!condition(frame)) return Completion.Normal;
      }
    };
    return { exec, labels: body.labels };
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- The parts of a for statement, each optional, and their steps.
  // code-gauge-allow functionNcss 33 -- Initialization, condition, update, entry labels, and scope exit form one loop lifecycle.
  private forStatement(statement: Extract<Statement, { kind: 'for' }>): Compiled {
    const row = this.stepRow(statement.row);
    const init = statement.init === undefined ? undefined : this.forInit(statement.init);
    const condition = statement.condition ? this.condition(statement.condition, 'for 文') : undefined;
    const update = statement.update ? this.rvalue(statement.update) : undefined;
    const updateEffect = update ? (update.effect ?? update.value) : undefined;
    const body = this.loopBody(statement.body);
    const run = body.exec;
    const locals = this.scopeLocals();
    const exec: Exec = (frame, entry) => {
      const { steps } = frame.runtime;
      frame.enterScope(locals);
      let enter = entry;
      try {
        if (enter === undefined && init) {
          frame.runtime.fullExpression(() => init(frame));
          steps.step(row);
        }
        for (;;) {
          if (enter === undefined) {
            frame.runtime.spend();
            if (condition && !condition(frame)) return Completion.Normal;
          }
          const completion = run(frame, enter);
          enter = undefined;
          if (completion === Completion.Break) return Completion.Normal;
          if (completion !== Completion.Normal && completion !== Completion.Continue) return completion;
          if (updateEffect) {
            frame.runtime.fullExpression(() => updateEffect(frame));
            steps.step(row);
          }
        }
      } finally {
        frame.exitScope(locals);
      }
    };
    return { exec, labels: body.labels };
  }

  private forInit(init: NonNullable<Extract<Statement, { kind: 'for' }>['init']>): (frame: Frame) => void {
    if (init.kind !== 'declaration') {
      const operand = this.rvalue(init);
      return operand.effect ?? operand.value;
    }
    const { storage } = init.specifiers;
    if (storage && storage !== 'auto' && storage !== 'register') {
      this.error(init.row, 'for 文の初期化の宣言には、static などの記憶域の指定は書けません。');
    }
    const compiled = this.withoutSteps(() => this.localDeclaration(init));
    return (frame) => {
      compiled.exec(frame);
    };
  }

  /** Compiles a part of a statement whose steps the statement records as a whole. */
  protected withoutSteps<T>(compile: () => T): T {
    const trace = this.options.trace;
    (this.options as { trace?: unknown }).trace = undefined;
    try {
      return compile();
    } finally {
      (this.options as { trace?: unknown }).trace = trace;
    }
  }

  private switchStatement(statement: Extract<Statement, { kind: 'switch' }>): Compiled {
    const { row } = statement;
    const operand = this.rvalue(statement.condition);
    if (!isInteger(operand.type))
      this.error(row, `switch 文の値には整数を書いてください（${typeName(operand.type)}）。`);
    const type = promote(operand.type);
    const value = this.converted(operand, type);
    const context: SwitchContext = { type, cases: new Map(), ranges: [] };
    this.context.switches.push(context);
    let body: Compiled;
    try {
      body = this.withScope(() => this.statement(statement.body));
    } finally {
      this.context.switches.pop();
    }
    const run = body.exec;
    const { cases, defaultLabel, ranges } = context;
    const exec: Exec = (frame, entry) => {
      let label = entry;
      if (label === undefined) {
        const selected = frame.runtime.fullExpression(() => value(frame)) as Scalar;
        label = cases.get(String(selected)) ?? rangeLabel(ranges, selected) ?? defaultLabel;
        if (label === undefined) return Completion.Normal;
      }
      const completion = run(frame, label);
      return completion === Completion.Break ? Completion.Normal : completion;
    };
    const ownLabels = new Set([
      ...cases.values(),
      ...ranges.map((range) => range.label),
      ...(defaultLabel === undefined ? [] : [defaultLabel]),
    ]);
    return { exec, labels: new Set([...body.labels].filter((label) => !ownLabels.has(label))) };
  }

  // code-gauge-allow functionCognitiveComplexity 21 -- Case ranges and individual labels share duplicate detection.
  private caseStatement(statement: Extract<Statement, { kind: 'case' }>): Compiled {
    const { row } = statement;
    const context = this.context.switches.at(-1);
    const id = this.context.nextLabel++;
    if (!context) {
      this.error(
        row,
        statement.value ? 'case は、switch 文の中にしか書けません。' : 'default は、switch 文の中にしか書けません。'
      );
    }
    if (statement.value) {
      const value = this.caseValue(statement.value, context.type, row);
      const end = statement.endValue ? this.caseValue(statement.endValue, context.type, row) : value;
      const overlapping = context.ranges.find(
        (range) => BigInt(range.low) <= BigInt(end) && BigInt(value) <= BigInt(range.high)
      );
      // clang reports a value that a range already covers at the range.
      if (overlapping)
        this.error(
          overlapping.row,
          `case の値「${String(BigInt(value) > BigInt(overlapping.low) ? value : overlapping.low)}」が2つあります。`
        );
      if (context.cases.has(String(value))) this.error(row, `case の値「${String(value)}」が2つあります。`);
      // An empty range (5 ... 3) is only a warning in clang, and no value selects it.
      if (statement.endValue && BigInt(end) >= BigInt(value))
        context.ranges.push({ low: value, high: end, label: id, row });
      else context.cases.set(String(value), id);
    } else {
      // clang reports a second default at the first one.
      if (context.defaultLabel !== undefined)
        this.error(context.defaultRow ?? row, 'switch 文に default が2つあります。');
      context.defaultLabel = id;
      context.defaultRow = row;
    }
    return this.labeled(id, this.statementOrDeclaration(statement.body));
  }

  private caseValue(expression: Expression, type: CType, row: number): Scalar {
    const operand = this.rvalue(expression);
    if (operand.constant === undefined || operand.type.kind !== 'int')
      this.error(row, 'case の値には、整数の定数を書いてください。');
    return convertScalar(operand.constant, operand.type, type);
  }

  private returnStatement(statement: Extract<Statement, { kind: 'return' }>): Compiled {
    const { row } = statement;
    const returnType = unqualified(this.context.returnType);
    const name = this.context.info.name;
    if (!statement.value) {
      if (returnType.kind !== 'void')
        this.error(row, `関数「${name}」は値を返す関数なので、return 文に値を書いてください。`);
      return {
        exec: () => Completion.Return,
        labels: NO_LABELS,
      };
    }
    const operand = this.rvalue(statement.value);
    if (returnType.kind === 'void') {
      if (operand.type.kind !== 'void')
        this.error(row, `関数「${name}」は値を返さない（void の）関数なので、return 文に値を書けません。`);
      const effect = operand.effect ?? operand.value;
      return {
        exec: (frame) => {
          frame.runtime.fullExpression(() => effect(frame));
          return Completion.Return;
        },
        labels: NO_LABELS,
      };
    }
    const value = this.convertForAssignment(operand, returnType, 'return', row);
    return {
      exec: (frame) => {
        const result = frame.runtime.fullExpression(() => evaluate(value, frame));
        frame.returnValue = result.value;
        frame.returnRange = result.range;
        frame.returnBytes = result.bytes;
        return Completion.Return;
      },
      labels: NO_LABELS,
    };
  }
}

/** The label of GNU's `case low ... high:` that a value falls in. */
function rangeLabel(ranges: SwitchContext['ranges'], value: Scalar): number | undefined {
  if (ranges.length === 0) return undefined;
  const number = BigInt(value);
  return ranges.find((range) => BigInt(range.low) <= number && number <= BigInt(range.high))?.label;
}

export type { Value };
