import { ExecutionLimitError, LIMITS } from '../interpreter/limits';

export type IntegerWork = 'read' | 'add' | 'multiply';

export function spendIntegerWidth(width: number, spend: (cost: number) => void): void {
  if (!Number.isSafeInteger(width) || width > LIMITS.maxSlots) throw new ExecutionLimitError('storage');
  spend(Math.ceil(width / 64));
}

export function integerOperationWork(operator: string): IntegerWork {
  if (operator.startsWith('*') || operator === '@mulWithOverflow') return 'multiply';
  if (
    operator.startsWith('+') ||
    operator.startsWith('-') ||
    operator === '@addWithOverflow' ||
    operator === '@subWithOverflow'
  )
    return 'add';
  return 'read';
}

export function spendIntegerOperation(
  left: bigint,
  right: bigint,
  operation: IntegerWork,
  spend: (cost: number) => void
): void {
  const leftBits = (left < 0n ? -left : left).toString(2).length;
  const rightBits = (right < 0n ? -right : right).toString(2).length;
  const resultBits =
    operation === 'multiply' ? leftBits + rightBits : Math.max(leftBits, rightBits) + (operation === 'add' ? 1 : 0);
  if (resultBits > LIMITS.maxSlots) throw new ExecutionLimitError('storage');
  spend(Math.ceil(resultBits / 64));
}

export function spendIntegerShift(
  left: bigint,
  amount: bigint,
  leftward: boolean,
  spend: (cost: number) => void
): void {
  const width = BigInt((left < 0n ? -left : left).toString(2).length);
  const resultBits = leftward && left !== 0n ? width + amount : width;
  if (resultBits > BigInt(LIMITS.maxSlots)) throw new ExecutionLimitError('storage');
  spend(Math.ceil(Number(resultBits) / 64));
}
