import { CompileError } from '../interpreter/diagnostics';
import type { CatchClause, Resource, Statement } from './ast';
import { type Completion, type EnclosingTry, type Eval, type Exec, type MethodContext } from './compilerBase';
import { assignedNames } from './definiteAssignment';
import { canCompleteNormally } from './reachability';
import { type Frame, JavaThrow } from './runtime';
import { SwitchCompiler } from './switchCompiler';
import { type ClassInfo, isSubclass, type JavaType, type MethodInfo, upperBound } from './types';
import { type Value } from './values';

type CatchHandler = (frame: Frame, thrown: JavaThrow) => Completion | undefined;

interface CompiledResource {
  init: Exec | undefined;
  read: Eval;
  close: MethodInfo;
}

/**
 * Closes the opened resources in reverse order, returning the exception the statement throws: the first exception,
 * to which the exceptions closing later resources join as suppressed.
 */
function closeResources(
  frame: Frame,
  opened: readonly Value[],
  resources: readonly CompiledResource[],
  primary: JavaThrow | undefined
): JavaThrow | undefined {
  let thrown = primary;
  let isRooted = false;
  try {
    for (let index = opened.length - 1; index >= 0; index--) {
      const value = opened[index];
      if (value === undefined) continue;
      try {
        frame.runtime.invoke(frame, frame.runtime.dispatch(value, resources[index].close), value, [], undefined);
      } catch (error) {
        if (!(error instanceof JavaThrow)) throw error;
        if (thrown) (thrown.value.suppressed ??= []).push(error.value);
        else {
          thrown = error;
          // The exception, and those suppressed in it, stay reachable while the remaining resources close.
          frame.temporaries.push(thrown.value);
          isRooted = true;
        }
      }
    }
  } finally {
    if (isRooted) frame.temporaries.pop();
  }
  return thrown;
}

/** Compiles try statements, their catch clauses and finally blocks, and try-with-resources. */
export abstract class TryCompiler extends SwitchCompiler {
  protected compileTry(context: MethodContext, statement: Extract<Statement, { kind: 'try' }>): Exec {
    if (statement.catches.length === 0 && !statement.finallyBlock && statement.resources.length === 0) {
      this.error(statement, 'try 文には catch か finally が必要です。');
    }
    // The finally block is compiled first: one that cannot complete normally discards every exception thrown
    // before it, so the try and catch blocks then throw nothing out of the statement. Its error waits until the
    // blocks before it compile, so that the first error in the source is the one reported.
    let finallyBlock: Exec | undefined;
    let finallyError: CompileError | undefined;
    try {
      finallyBlock = statement.finallyBlock ? this.compileBlock(context, statement.finallyBlock) : undefined;
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
      finallyError = error;
    }
    // A finally block that failed to compile still has its structure, where unreached conditions count as variable.
    const discardsExceptions = statement.finallyBlock !== undefined && !canCompleteNormally(statement.finallyBlock);
    if (discardsExceptions) context.tries.push({ caughtTypes: [this.builtins.throwableClass], thrownTypes: [] });
    try {
      const enclosing: EnclosingTry = {
        caughtTypes: statement.catches.flatMap((clause) => clause.types.map((type) => this.resolveThrowable(type))),
        thrownTypes: [],
      };
      context.tries.push(enclosing);
      let body: Exec;
      try {
        body =
          statement.resources.length > 0
            ? this.withScope(context, () => this.compileResources(context, statement))
            : this.compileBlock(context, statement.body);
      } finally {
        context.tries.pop();
      }
      const handle = this.compileCatchClauses(context, statement.catches, enclosing.thrownTypes);
      if (finallyError) throw finallyError;
      return runTry(body, handle, finallyBlock);
    } finally {
      if (discardsExceptions) context.tries.pop();
    }
  }

  /** Compiles a try-with-resources statement's resources and try block, which close the resources after it. */
  protected compileResources(context: MethodContext, statement: Extract<Statement, { kind: 'try' }>): Exec {
    const resources = statement.resources.map((resource) => this.compileResource(context, resource));
    const body = this.compileBlock(context, statement.body);
    return (frame) => {
      const opened: Value[] = [];
      let completion: Completion | undefined;
      let primary: JavaThrow | undefined;
      try {
        for (const resource of resources) {
          resource.init?.(frame);
          opened.push(resource.read(frame));
        }
        completion = body(frame);
      } catch (error) {
        if (!(error instanceof JavaThrow)) throw error;
        primary = error;
      }
      // The pending return value or exception stays reachable while the resources' close() methods run.
      frame.temporaries.push(completion?.kind === 'return' ? completion.value : primary?.value);
      try {
        primary = closeResources(frame, opened, resources, primary);
      } finally {
        frame.temporaries.pop();
      }
      if (primary) throw primary;
      return completion;
    };
  }

  /** Compiles a resource: a variable it declares and initializes, or the effectively final variable it names. */
  protected compileResource(context: MethodContext, resource: Resource): CompiledResource {
    let init: Exec | undefined;
    let read: Eval;
    let type: JavaType;
    if ('local' in resource) {
      init = this.compileLocal(context, resource.local);
      const slot = this.findLocal(context, resource.local.declarators[0].name) as number;
      type = context.locals[slot].type;
      read = (frame) => frame.locals[slot] as Value;
    } else {
      ({ type, run: read } = this.compileValue(context, resource.expression));
    }
    const bound = upperBound(type);
    const autoCloseable = this.builtins.classes.get('AutoCloseable') as ClassInfo;
    if (bound.kind !== 'class' || !isSubclass(bound.cls, autoCloseable)) {
      return this.error(resource, 'try-with-resources 文には AutoCloseable を実装したオブジェクトしか書けません。');
    }
    const close = this.selectMethod(resource, this.collectMethods(bound.cls, 'close'), [], 'メソッド close');
    this.checkThrown(context, resource, close.thrownTypes);
    return { init, read, close: close.declared ?? close };
  }

  /** Rejects catching what an earlier clause catches, or a checked exception the try block cannot throw. */
  protected checkCatchable(
    clause: CatchClause,
    classes: readonly ClassInfo[],
    thrownInTry: readonly ClassInfo[],
    earlierClasses: readonly ClassInfo[]
  ): void {
    const exceptionClass = this.builtins.classes.get('Exception') as ClassInfo;
    for (const [index, cls] of classes.entries()) {
      if (classes.some((other, otherIndex) => otherIndex !== index && isSubclass(cls, other))) {
        this.error(clause, `catch の例外 ${cls.name} は、同じ catch の他の例外と親子関係にあります。`);
      }
      if (earlierClasses.some((earlier) => isSubclass(cls, earlier))) {
        this.error(clause, `例外 ${cls.name} は、前の catch ですでに捕まえられています。`);
      }
      // Exception and Throwable also catch unchecked exceptions, which any code may throw.
      const mayBeThrown =
        !this.isChecked(cls) ||
        isSubclass(exceptionClass, cls) ||
        thrownInTry.some((thrown) => isSubclass(thrown, cls) || isSubclass(cls, thrown));
      if (!mayBeThrown) this.error(clause, `例外 ${cls.name} は、この try 文の中で投げられることがありません。`);
    }
  }

  /** Compiles catch clauses into a handler that rethrows an exception none of them catches. */
  protected compileCatchClauses(
    context: MethodContext,
    clauses: CatchClause[],
    thrownInTry: readonly ClassInfo[]
  ): CatchHandler {
    const earlierClasses: ClassInfo[] = [];
    const handlers = clauses.map((clause) => {
      const classes = clause.types.map((type) => this.resolveThrowable(type));
      this.checkCatchable(clause, classes, thrownInTry, earlierClasses);
      const rethrown = caughtByClause(thrownInTry, classes, earlierClasses);
      earlierClasses.push(...classes);
      const exec = this.withScope(context, () => {
        const type = classes.length === 1 ? classes[0].type : this.builtins.throwableClass.type;
        const slot = this.declareLocal(context, clause, clause.name, type);
        if (!assignedNames(clause.body).includes(clause.name)) context.rethrownTypes.set(slot, rethrown);
        const handler = this.compileBlock(context, clause.body);
        return (frame) => {
          frame.locals[slot] = frame.temporaries.pop();
          return handler(frame);
        };
      });
      return { classes, exec };
    });
    return (frame, thrown) => {
      const handler = handlers.find(({ classes }) => classes.some((cls) => isSubclass(thrown.value.cls, cls)));
      if (!handler) throw thrown;
      frame.temporaries.push(thrown.value);
      return handler.exec(frame);
    };
  }
}

/** What a catch clause receives: what the try block throws narrowed to its classes, minus what earlier clauses catch. */
function caughtByClause(
  thrownInTry: readonly ClassInfo[],
  classes: readonly ClassInfo[],
  earlierClasses: readonly ClassInfo[]
): ClassInfo[] {
  const narrowed = thrownInTry.flatMap((thrown) =>
    classes.flatMap((cls) => {
      if (isSubclass(thrown, cls)) return [thrown];
      return isSubclass(cls, thrown) ? [cls] : [];
    })
  );
  return narrowed.filter((thrown) => !earlierClasses.some((earlier) => isSubclass(thrown, earlier)));
}

function runTry(body: Exec, handle: CatchHandler, finallyBlock: Exec | undefined): Exec {
  return (frame) => {
    const { completion, pending } = attemptTry(frame, body, handle);
    if (finallyBlock) {
      // A return value or an exception the finally block delays keeps its turtles alive while the block runs.
      frame.temporaries.push(completion?.kind === 'return' ? completion.value : pending?.value);
      try {
        const finallyCompletion = finallyBlock(frame);
        if (finallyCompletion) return finallyCompletion;
      } finally {
        frame.temporaries.pop();
      }
    }
    if (pending) throw pending;
    return completion;
  };
}

/** Runs a try block and its catch clauses, returning how they completed or the exception left for finally. */
function attemptTry(frame: Frame, body: Exec, handle: CatchHandler): { completion?: Completion; pending?: JavaThrow } {
  const temporaries = frame.temporaries.length;
  try {
    return { completion: body(frame) };
  } catch (error) {
    if (!(error instanceof JavaThrow)) throw error;
    // An exception thrown mid-expression leaves that expression's pending values behind.
    frame.temporaries.length = temporaries;
    try {
      return { completion: handle(frame, error) };
    } catch (error_) {
      if (!(error_ instanceof JavaThrow)) throw error_;
      frame.temporaries.length = temporaries;
      return { pending: error_ };
    }
  }
}
