import type { Span } from './ast';
import type { ClassInfo } from './classes';
import type { DartType } from './types';

export function checkRepresentationCycles(
  classes: readonly { cls: ClassInfo; declaration: Span }[],
  reportCycle: (span: Span, name: string) => never
): void {
  const visiting = new Set<ClassInfo>();
  const checked = new Set<ClassInfo>();
  const visit = (cls: ClassInfo, declaration: Span): void => {
    if (!cls.representationType || checked.has(cls)) return;
    if (visiting.has(cls)) reportCycle(declaration, cls.name);
    visiting.add(cls);
    for (const dependency of referencedClasses(cls.representationType)) {
      visit(dependency, dependency.declaration ?? declaration);
    }
    visiting.delete(cls);
    checked.add(cls);
  };
  for (const { cls, declaration } of classes) visit(cls, declaration);
}

function* referencedClasses(type: DartType): Iterable<ClassInfo> {
  if (type.kind === 'interface') yield type.cls;
  for (const nested of nestedTypes(type)) yield* referencedClasses(nested);
}

function nestedTypes(type: DartType): readonly DartType[] {
  switch (type.kind) {
    case 'interface': {
      return type.args;
    }
    case 'record': {
      return [...type.positional, ...type.named.map((field) => field.type)];
    }
    case 'function': {
      return [
        ...type.typeParams.flatMap(({ bound }) => (bound ? [bound] : [])),
        type.returnType,
        ...type.positional,
        ...type.named.map((parameter) => parameter.type),
      ];
    }
    default: {
      return [];
    }
  }
}
