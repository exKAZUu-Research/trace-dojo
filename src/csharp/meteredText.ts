import { LIMITS } from '../interpreter/limits';
import { PendingException } from './numeric';

/** The operations budget that a text processor's work is charged to. */
export interface TextBudget {
  spend(cost?: number): void;
}

/** How many characters one operation of the budget stands for. */
const CHARACTERS_PER_OPERATION = 16;

/**
 * The text that one native call reads and builds, such as a format string's expansion or a regex substitution.
 * Every character it reads or appends is charged, so a processor that reads its input again pays for each pass, and
 * the text is checked against .NET's string limit before it grows past it instead of after it is built.
 */
export class MeteredText {
  private readonly parts: string[] = [];
  private builtLength = 0;
  private unchargedCharacters = 0;

  constructor(private readonly budget: TextBudget) {}

  get length(): number {
    return this.builtLength;
  }

  /** Charges characters that the processor reads from its input. */
  read(count: number): void {
    this.unchargedCharacters += count;
    if (this.unchargedCharacters < CHARACTERS_PER_OPERATION * 64) return;
    this.budget.spend(Math.floor(this.unchargedCharacters / CHARACTERS_PER_OPERATION));
    this.unchargedCharacters %= CHARACTERS_PER_OPERATION;
  }

  append(text: string): void {
    if (this.builtLength + text.length > LIMITS.maxStringLength)
      throw new PendingException(
        'System.OutOfMemoryException',
        "Exception of type 'System.OutOfMemoryException' was thrown."
      );
    this.parts.push(text);
    this.builtLength += text.length;
    this.read(text.length);
  }

  /** Charges what is left of the characters read, for a processor that ends without building text here. */
  settle(): void {
    this.budget.spend(Math.ceil(this.unchargedCharacters / CHARACTERS_PER_OPERATION));
    this.unchargedCharacters = 0;
  }

  toString(): string {
    this.settle();
    return this.parts.join('');
  }
}
