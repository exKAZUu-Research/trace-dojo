import { CompileError } from '../interpreter/diagnostics';
import type {
  ArrayInitializer,
  Block,
  ExplicitConstructorCall,
  Expression,
  ExpressionStatement,
  Parameter,
  Span,
  Statement,
} from './ast';
import { type AssignmentFacts, DefiniteAssignmentChecker } from './definiteAssignment';

export interface InitializationPath {
  /** The blank final fields this path must assign exactly once. */
  blankFinals: readonly string[];
  /** The initializer blocks and field initializers that run before the constructor, in textual order. */
  initializers: readonly (Block | Expression | ArrayInitializer)[];
  constructorDeclaration?: {
    parameters: readonly Parameter[];
    explicitCall: ExplicitConstructorCall | undefined;
    prologue?: readonly Statement[];
    body: Block;
  };
  /** Where an unassigned blank final is reported. */
  span: Span;
}

/**
 * Applies the definite assignment rules to the code that initializes a class or an object: its field initializers
 * and initializer blocks and, for objects, one constructor, which together must assign every blank final field
 * exactly once.
 */
export function checkInitialization(path: InitializationPath): AssignmentFacts {
  const checker = new DefiniteAssignmentChecker();
  let state = checker.initialState();
  for (const name of path.blankFinals) state = checker.declareField(state, name);
  const constructor = path.constructorDeclaration;
  // A constructor that calls this(...) starts after another constructor has initialized the object.
  if (constructor?.explicitCall?.target === 'this') {
    for (const name of path.blankFinals) state = checker.assignField(state, name);
  } else {
    for (const initializer of path.initializers) {
      state =
        initializer.kind === 'block' ? checker.statement(initializer, state) : checker.initializer(initializer, state);
    }
  }
  if (constructor) {
    const withParameters = checker.declareParameters(state, constructor.parameters);
    // The prologue runs before the call's arguments, and its locals stay in scope for them and the body.
    const callArgs = (constructor.explicitCall?.args ?? []).map((arg): ExpressionStatement => ({
      kind: 'expression',
      expression: arg,
      row: arg.row,
      endRow: arg.endRow,
      start: arg.start,
      end: arg.end,
    }));
    const whole: Block = {
      ...constructor.body,
      statements: [...(constructor.prologue ?? []), ...callArgs, ...constructor.body.statements],
    };
    state = checker.statement(whole, withParameters);
  }
  for (const exit of [state, ...checker.returns]) {
    const unassigned = path.blankFinals.find((name) => exit.assigned && !checker.isFieldAssigned(exit, name));
    if (unassigned !== undefined) {
      throw new CompileError([
        { row: path.span.row, message: `final のフィールド ${unassigned} に値が代入されていない可能性があります。` },
      ]);
    }
  }
  return checker;
}
