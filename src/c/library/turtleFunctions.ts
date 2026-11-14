import { TURTLE_METHOD_NAMES, type TurtleState } from '../../interpreter/turtleWorld';
import type { Value } from '../arith';
import type { Expression } from '../ast';
import type { Operand } from '../compilerBase';
import { CRuntimeError } from '../errors';
import type { ExpressionCompiler, SpecialCall } from '../expressionCompiler';
import type { Frame, FunctionInfo, NativeFunction, Runtime } from '../runtime';
import { CHAR_POINTER, type CType, INT, isCharType, isInteger, typeName } from '../types';
import { unsupported } from '../unsupported';
import { asAddress, asNumber, bytesToText, readCString } from './support';

function turtleOf(runtime: Runtime, value: Value | undefined): TurtleState {
  const address = asAddress(value);
  if (address === 0) throw new CRuntimeError('nullAccess');
  const block = runtime.memory.find(address);
  if (block?.base !== address || !block.turtle) {
    if (runtime.memory.wasFreed(address)) throw new CRuntimeError('useAfterFree');
    throw new CRuntimeError('custom', '亀（new_turtle で作った Turtle *）ではないものを渡しました。');
  }
  return block.turtle;
}

export const TURTLE_FUNCTIONS: Record<string, NativeFunction> = {
  new_turtle: (runtime, args) => {
    const x = args.length > 0 ? asNumber(args[0]) : 0;
    const y = args.length > 1 ? asNumber(args[1]) : 0;
    const color = args.length > 2 ? bytesToText(readCString(runtime, asAddress(args[2]))) : undefined;
    const created = runtime.world.create(x, y, color);
    if ('error' in created) throw new CRuntimeError('custom', created.error);
    const block = runtime.allocate(8, 'heap');
    block.turtle = created;
    block.isReadOnly = true;
    return block.base;
  },
  remove: (runtime, [turtle]) => {
    runtime.world.remove(turtleOf(runtime, turtle));
    return;
  },
};

for (const [names, sign] of [
  [TURTLE_METHOD_NAMES.forward, 1],
  [TURTLE_METHOD_NAMES.backward, -1],
] as const) {
  for (const name of names) {
    TURTLE_FUNCTIONS[name] = (runtime, [turtle]) => {
      const error = runtime.world.move(turtleOf(runtime, turtle), sign);
      if (error) throw new CRuntimeError('custom', error);
      return;
    };
  }
}
for (const [names, quarters] of [
  [TURTLE_METHOD_NAMES.turnRight, 1],
  [TURTLE_METHOD_NAMES.turnLeft, 3],
] as const) {
  for (const name of names) {
    TURTLE_FUNCTIONS[name] = (runtime, [turtle]) => {
      runtime.world.turn(turtleOf(runtime, turtle), quarters);
      return;
    };
  }
}
for (const name of TURTLE_METHOD_NAMES.canMoveForward) {
  TURTLE_FUNCTIONS[name] = (runtime, [turtle]) => {
    const state = turtleOf(runtime, turtle);
    runtime.collectGarbage();
    return runtime.world.canMoveForward(state) ? 1 : 0;
  };
}
for (const name of TURTLE_METHOD_NAMES.isFrontPainted) {
  TURTLE_FUNCTIONS[name] = (runtime, [turtle]) => (runtime.world.isFrontPainted(turtleOf(runtime, turtle)) ? 1 : 0);
}

const NEW_TURTLE_USAGE = 'new_turtle には、引数を書かないか、x と y、または x と y と色（"R" など）を書いてください。';

/**
 * `new_turtle()`, `new_turtle(x, y)`, or `new_turtle(x, y, color)`: C has no overloading, so the compiler checks the
 * three forms of the Java constructor itself.
 */
export const newTurtleCall: SpecialCall = (compiler, call, fn) => {
  const { row, args } = call;
  if (args.length > 0 && args.length !== 2 && args.length !== 3) compiler.error(row, NEW_TURTLE_USAGE);
  const types: CType[] = [INT, INT, CHAR_POINTER].slice(0, args.length);
  const operands = args.map((arg) => compiler.rvalue(arg));
  const values = operands.map((operand, index) => {
    const type = types[index];
    if (index < 2 && !isInteger(operand.type)) compiler.error(args[index].row, NEW_TURTLE_USAGE);
    if (index === 2 && !(operand.type.kind === 'pointer' && isCharType(operand.type.to))) {
      compiler.error(args[index].row, NEW_TURTLE_USAGE);
    }
    return compiler.convertForAssignment(operand, type, 'argument', args[index].row);
  });
  return compiler.callOperand(
    { kind: 'function', ret: fn.type.ret as CType, params: types, variadic: false },
    () => 0,
    fn,
    values,
    types,
    row
  );
};

/** `remove(turtle)` removes a turtle; stdio's `remove(path)`, which deletes a file, is no feature of the interpreter. */
export const removeCall: SpecialCall = (compiler, call, fn) => {
  const { row, args } = call;
  if (args.length !== 1) compiler.error(row, 'remove には、亀（Turtle *）を1つ渡してください。');
  const operand = compiler.rvalue(args[0] as Expression);
  const type = operand.type;
  if (type.kind === 'pointer' && isCharType(type.to)) unsupported(row, 'ファイルの削除（remove）');
  if (!(type.kind === 'pointer' && type.to.kind === 'record' && type.to.info.isTurtle)) {
    compiler.error(row, `remove には、亀（Turtle *）を渡してください（${typeName(type)}）。`);
  }
  return compiler.callOperand(
    { kind: 'function', ret: fn.type.ret, params: [type], variadic: false },
    () => 0,
    fn,
    [operand.value],
    [type],
    row
  );
};

export type { ExpressionCompiler, Frame, FunctionInfo, Operand };
