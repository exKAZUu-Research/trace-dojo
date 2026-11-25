// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { unsetTarget } from './assignment';
import type { Expr, Stmt } from './ast';
import { toBool } from './conversions';
import { evSteps, hoist, type Steps } from './generatorSteps';
import { looseEquals, toStr } from './operators';
import { share } from './places';
import { type Frame, rt, type Runtime } from './runtime';
import {
  type BlockFrame,
  type Completion,
  declareStaticVar,
  enterForeach,
  pushListFrame,
  type SuspendingLoopFrame,
} from './statements';
import { suspends } from './suspension';
import type { Ref, Value } from './values';

/** Starts a generator's statement whose own expressions or loop header contain a `yield`. */
// code-gauge-allow functionNcss -- One case per statement kind that may hold a `yield`.
export function enterSuspendingStatement(
  stack: BlockFrame[],
  statement: Stmt,
  runtime: Runtime,
  frame: Frame
): Completion {
  const stepRow = (): Completion => {
    runtime.steps.step(statement.row);
    return undefined;
  };
  const held = frame.temporaries.length;
  switch (statement.k) {
    case 'expr': {
      return pushPending(stack, evSteps(statement.e), stepRow);
    }
    case 'echo': {
      return pushPending(stack, echoSteps(statement.args, frame, held), stepRow);
    }
    case 'unset': {
      return pushPending(stack, unsetSteps(statement.targets), stepRow);
    }
    case 'return': {
      const e = statement.e as Expr;
      return pushPending(stack, returnSteps(e), () => ({
        t: 'return',
        slot: frame.returning as Value | Ref,
        row: e.row,
      }));
    }
    case 'if': {
      return pushPending(stack, evSteps(statement.cond), (value) => {
        const branch = toBool(value) ? statement.consequent : statement.alternate;
        if (branch) pushListFrame(stack, branch);
        return;
      });
    }
    case 'while':
    case 'do': {
      stack.push({ k: 'stepLoop', stmt: statement, held, started: false });
      return undefined;
    }
    case 'for': {
      return pushPending(stack, forClauseSteps(statement.init, statement.row, frame, held), () => {
        stack.push({ k: 'stepLoop', stmt: statement, held, started: false });
        return;
      });
    }
    case 'foreach': {
      return pushPending(stack, evSteps(statement.subject), (value) =>
        enterForeach(
          stack,
          { ...statement, subject: { k: 'held', v: value, row: statement.subject.row } },
          runtime,
          frame
        )
      );
    }
    case 'switch': {
      return pushPending(stack, switchStartSteps(statement), (start) => {
        if (start !== -1n) stack.push({ k: 'switch', cases: statement.cases, index: Number(start) });
        return;
      });
    }
    case 'static': {
      return pushPending(stack, staticSteps(statement, frame), () => {});
    }
    default: {
      throw new Error(`A ${statement.k} statement cannot suspend`);
    }
  }
}

/** Runs the header of a loop that contains a `yield`, as the frames of the other loops run theirs. */
export function stepSuspendingLoop(
  stack: BlockFrame[],
  top: SuspendingLoopFrame,
  runtime: Runtime,
  frame: Frame
): Completion {
  const { stmt } = top;
  switch (stmt.k) {
    case 'while': {
      if (top.started) runtime.spend();
      top.started = true;
      runtime.dropTemporaries(frame, top.held);
      runtime.row = stmt.row;
      return pushPending(stack, evSteps(stmt.cond), (value) => continueLoop(stack, toBool(value), stmt.body));
    }
    case 'do': {
      if (!top.started) {
        top.started = true;
        pushListFrame(stack, stmt.body);
        return undefined;
      }
      runtime.row = stmt.row;
      return pushPending(stack, evSteps(stmt.cond), (value) => {
        const go = toBool(value);
        if (go) {
          runtime.spend();
          runtime.dropTemporaries(frame, top.held);
        }
        return continueLoop(stack, go, stmt.body);
      });
    }
    case 'for': {
      return pushPending(stack, forHeaderSteps(top, stmt, frame), (go) => continueLoop(stack, go === true, stmt.body));
    }
  }
}

function pushPending(stack: BlockFrame[], steps: Steps<Value>, after: (value: Value) => Completion): Completion {
  stack.push({ k: 'pending', steps, after });
  return undefined;
}

function continueLoop(stack: BlockFrame[], go: boolean, body: Stmt[]): Completion {
  if (go) pushListFrame(stack, body);
  else stack.pop();
  return undefined;
}

function* echoSteps(args: Expr[], frame: Frame, held: number): Steps<Value> {
  const runtime = rt();
  for (const arg of args) {
    const value = yield* evSteps(arg);
    runtime.echo(toStr(value));
    runtime.dropTemporaries(frame, held);
  }
  return null;
}

function* unsetSteps(targets: Expr[]): Steps<Value> {
  for (const target of targets) unsetTarget(yield* hoist(target, true));
  return null;
}

function* returnSteps(e: Expr): Steps<Value> {
  const frame = rt().frame;
  const value = yield* evSteps(e);
  frame.returning = share(value);
  return null;
}

function* forClauseSteps(expressions: Expr[], row: number, frame: Frame, held: number): Steps<Value> {
  if (expressions.length === 0) return null;
  const runtime = rt();
  runtime.row = row;
  for (const expression of expressions) {
    yield* evSteps(expression);
    runtime.dropTemporaries(frame, held);
  }
  runtime.steps.step(row);
  return null;
}

function* forHeaderSteps(top: SuspendingLoopFrame, stmt: Extract<Stmt, { k: 'for' }>, frame: Frame): Steps<Value> {
  const runtime = rt();
  if (top.started) {
    yield* forClauseSteps(stmt.update, stmt.row, frame, top.held);
    runtime.spend();
  }
  top.started = true;
  runtime.row = stmt.row;
  let go = true;
  for (const e of stmt.cond) {
    go = toBool(yield* evSteps(e));
    runtime.dropTemporaries(frame, top.held);
  }
  return go;
}

/** The index of the case a switch starts at, as a PHP integer, or -1 when none matches. */
function* switchStartSteps(statement: Extract<Stmt, { k: 'switch' }>): Steps<Value> {
  const runtime = rt();
  const subject = yield* evSteps(statement.subject);
  for (const [index, item] of statement.cases.entries()) {
    if (item.test === undefined) continue;
    runtime.row = item.row;
    if (looseEquals(subject, yield* evSteps(item.test))) return BigInt(index);
  }
  return BigInt(statement.cases.findIndex((item) => item.test === undefined));
}

function* staticSteps(statement: Extract<Stmt, { k: 'static' }>, frame: Frame): Steps<Value> {
  const statics = frame.fn?.kind === 'user' ? frame.fn.statics : rt().globalStatics;
  for (const { name, init } of statement.vars) {
    if (statics.has(name) || !init || !suspends(init)) {
      declareStaticVar(statics, name, init, frame);
      continue;
    }
    const value = yield* evSteps(init);
    declareStaticVar(statics, name, { k: 'held', v: value, row: init.row }, frame);
  }
  return null;
}
