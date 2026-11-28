import type { Expr } from './ast';
import type { Compiler, Eval } from './compiler';
import { isPlaceExpr } from './compilerCommon';
import type { Frame } from './runtime';
import type { Type } from './types';
import { isPlace, type Value } from './values';

/**
 * A value the code borrows that no variable holds (`&make()`, the receiver of `make().get()`, a `match`'s scrutinee),
 * which goes when the statement ends, or for one a `let` extends (`let r = &make();`), with the variable it binds.
 * `read` gives the value, or for a mutable borrow the place holding it, whose contents go.
 */
export function dropsBorrowedTemporary(c: Compiler, operand: Expr, read: Eval): Eval {
  if (isPlaceExpr(operand, c.annotations)) return read;
  const dropped = c.droppedType(operand.ty);
  if (!dropped) return read;
  const slot = c.extendedTemporarySlot(operand);
  return (frame) => {
    const value = read(frame);
    holdTemporary(frame, value, dropped(frame), slot);
    return value;
  };
}

/** Keeps a temporary until its statement ends, or until the variable in `slot` goes. */
export function holdTemporary(frame: Frame, value: Value, type: Type, slot?: number): void {
  const { dropper } = frame.runtime;
  if (!dropper?.needsDrop(type)) return;
  const release = (): void => dropper.drop(isPlace(value) ? value.get() : value, type);
  if (slot === undefined) {
    frame.runtime.liveGuards.push({ release });
    return;
  }
  // The guards the temporary holds (`&*cell.borrow()`) stay until it goes, unlike the statement's others.
  frame.runtime.keepGuardsOf(value);
  frame.holdUntilDropped(slot, release);
}
