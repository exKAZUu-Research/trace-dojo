import { LIMITS } from '../../interpreter/limits';
import type { Runtime } from '../runtime';

export class BoundedStringParts {
  private readonly parts: string[] = [];
  private length = 0;

  constructor(private readonly runtime: Runtime) {}

  append(part: string): void {
    if (part.length === 0) return;
    this.length += part.length;
    if (this.length > LIMITS.maxStringLength) this.runtime.throwError('OutOfMemoryError', '', []);
    this.runtime.spend(Math.ceil(part.length / 1024));
    this.parts.push(part);
  }

  text(): string {
    return this.parts.join('');
  }
}
