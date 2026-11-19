import type { ValueEntity } from './entities';
import { compileError } from './errors';
import { emptyExports, type TypeLike } from './modules';
import type { QName, Span } from './syntax';

export class ExportTableBuilder {
  readonly table = emptyExports();
  private readonly values = new Map<string, ValueEntity>();
  private readonly fields = new Map<string, ValueEntity>();
  private readonly children = new Map<TypeLike['entity'], Set<ValueEntity>>();

  addType(name: QName, entity: TypeLike, children: readonly ValueEntity[]): void {
    let entry = this.table.types.get(name.name);
    if (entry && entry.entity.entity !== entity.entity) throw exportConflict(name.name, name.span);
    if (!entry) {
      entry = { entity, children: [] };
      this.table.types.set(name.name, entry);
      this.children.set(entity.entity, new Set());
    }
    const seen = this.children.get(entity.entity) as Set<ValueEntity>;
    for (const child of children) {
      this.addValue(child, name.span);
      if (seen.has(child)) continue;
      seen.add(child);
      entry.children.push(child);
    }
  }
  addValue(entity: ValueEntity, span: Span): void {
    const namespace = entity.sort === 'field' ? this.fields : this.values;
    const previous = namespace.get(entity.name);
    if (previous && previous !== entity) throw exportConflict(entity.name, span);
    namespace.set(entity.name, entity);
    this.table.values.set(entity.name, entity);
  }
}

function exportConflict(name: string, span: Span): Error {
  return compileError(span, `${name} として異なる定義を export することはできません。`);
}
