import type { ConInfo } from './entities';
import { ConValue, type Slot, type Value } from './values';

// GHC erases a newtype, so its value is its field's; here a newtype keeps a box, which these keep transparent: the
// box is evaluated with its field, and a pattern of it matches without evaluating anything.

/** The strict fields of a newtype's constructor: its one field, so that building the box evaluates it. */
export const NEWTYPE_STRICT_FIELDS: readonly number[] = [0];

export function matchesWithoutEvaluating(con: ConInfo): boolean {
  return con.isNewtype === true;
}

export function newtypeBox(con: ConInfo, field: Slot, force: (slot: Slot) => Value): ConValue {
  force(field);
  return new ConValue(con, [field]);
}
