import type { FunctionInfo, Runtime } from './runtime';

export class RecordShapes {
  private readonly fieldNameIndexes = new Map<string, number>();
  private readonly registeredFunctions = new WeakSet<FunctionInfo>();

  constructor(private readonly runtime: Runtime) {}

  registerFunction(info: FunctionInfo): void {
    if (!info.recordFieldNames || this.registeredFunctions.has(info)) return;
    this.registerDeclarations(info.recordFieldNames);
    this.registeredFunctions.add(info);
  }

  registerDeclarations(names: Iterable<string>): void {
    for (const key of names) this.fieldNamesIndex(key);
  }

  shape(fieldCount: number, fieldNames: string | undefined): bigint {
    const index = fieldNames === undefined ? 0 : this.fieldNamesIndex(fieldNames);
    // The VM packs field count into the low 16 bits and reserves name index zero for positional records.
    return BigInt(fieldCount) + (BigInt(index) << 16n);
  }

  private fieldNamesIndex(key: string): number {
    const existing = this.fieldNameIndexes.get(key);
    if (existing !== undefined) return existing;
    this.runtime.allocate(1);
    const index = this.fieldNameIndexes.size + 1;
    this.fieldNameIndexes.set(key, index);
    return index;
  }
}
