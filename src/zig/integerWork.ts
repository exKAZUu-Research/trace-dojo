import { ExecutionLimitError, LIMITS } from '../interpreter/limits';

export function spendIntegerOperation(
  left: bigint,
  right: bigint,
  multiply: boolean,
  spend: (cost: number) => void
): void {
  const leftBits = left.toString(2).length;
  const rightBits = right.toString(2).length;
  const resultBits = multiply ? leftBits + rightBits : Math.max(leftBits, rightBits) + 1;
  if (resultBits > LIMITS.maxSlots) throw new ExecutionLimitError('storage');
  spend(Math.ceil(resultBits / 64));
}

export function spendIntegerShift(
  left: bigint,
  amount: bigint,
  leftward: boolean,
  spend: (cost: number) => void
): void {
  const width = BigInt(left.toString(2).length);
  const resultBits = leftward && left !== 0n ? width + amount : width;
  if (resultBits > BigInt(LIMITS.maxSlots)) throw new ExecutionLimitError('storage');
  spend(Math.ceil(Number(resultBits) / 64));
}
