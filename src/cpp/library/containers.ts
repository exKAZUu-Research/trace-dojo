import { classType, type Type, typeName, unqualified } from '../types';
import { adapterClass } from './adapters';
import { orderedClass, pairClass } from './associative';
import { randomClasses } from './random';
import type { Library, LibraryTemplate } from './registry';
import { sequenceClass } from './sequences';
import { unorderedClass } from './unordered';
import { FUNCTOR_NAMES, functorClass, numericLimitsClass } from './utility';

/** The class templates of the library: containers, `std::pair`, function objects, and `std::numeric_limits`. */
export function containerTemplates(library: Library): LibraryTemplate[] {
  const compiler = (): Library['compiler'] => library.compiler;
  const arity = (name: string, args: Type[], min: number, max: number, row: number): void => {
    if (args.length < min || args.length > max) {
      compiler().error(
        row,
        `std::${name} のテンプレート引数は ${min === max ? `${min} 個` : `${min} 〜 ${max} 個`}です。`
      );
    }
  };
  const constantOf = (type: Type, name: string, row: number): number => {
    const value = (type as unknown as { constant?: number }).constant;
    if (value === undefined) return compiler().error(row, `std::${name} の大きさには定数を書いてください。`);
    return value;
  };
  /** Checks the container argument of an adapter, which must hold the same element type. */
  const checkContainer = (
    name: string,
    element: Type,
    container: Type | undefined,
    allowed: string[],
    row: number
  ): void => {
    if (!container) return;
    const library_ = container.kind === 'class' ? container.cls.library : undefined;
    if (!library_ || !allowed.includes(library_.kind) || typeName(library_.args[0]) !== typeName(element)) {
      compiler().unsupported(row, `std::${name} の中身のコンテナに ${typeName(container)} を使うこと`);
    }
  };
  const templates: LibraryTemplate[] = [];
  for (const kind of ['vector', 'deque', 'list'] as const) {
    templates.push({
      name: kind,
      instantiate: (args, row) => {
        arity(kind, args, 1, 1, row);
        return classType(sequenceClass(library, kind, args[0]));
      },
    });
  }
  templates.push({
    name: 'array',
    instantiate: (args, row) => {
      arity('array', args, 2, 2, row);
      return classType(sequenceClass(library, 'array', args[0], constantOf(args[1], 'array', row)));
    },
  });
  for (const kind of ['stack', 'queue'] as const) {
    templates.push({
      name: kind,
      instantiate: (args, row) => {
        arity(kind, args, 1, 2, row);
        checkContainer(kind, args[0], args[1], kind === 'stack' ? ['deque', 'vector', 'list'] : ['deque', 'list'], row);
        return classType(adapterClass(library, kind, args[0], undefined));
      },
    });
  }
  templates.push({
    name: 'priority_queue',
    instantiate: (args, row) => {
      arity('priority_queue', args, 1, 3, row);
      checkContainer('priority_queue', args[0], args[1], ['vector', 'deque'], row);
      return classType(adapterClass(library, 'priority_queue', args[0], args[2]));
    },
  });
  for (const kind of ['map', 'multimap'] as const) {
    templates.push({
      name: kind,
      instantiate: (args, row) => {
        arity(kind, args, 2, 3, row);
        return classType(orderedClass(library, kind, args[0], args[1], args[2]));
      },
    });
  }
  for (const kind of ['set', 'multiset'] as const) {
    templates.push({
      name: kind,
      instantiate: (args, row) => {
        arity(kind, args, 1, 2, row);
        return classType(orderedClass(library, kind, args[0], undefined, args[1]));
      },
    });
  }
  templates.push({
    name: 'unordered_map',
    instantiate: (args, row) => {
      arity('unordered_map', args, 2, 2, row);
      return classType(unorderedClass(library, 'unordered_map', args[0], args[1]));
    },
  });
  templates.push({
    name: 'unordered_set',
    instantiate: (args, row) => {
      arity('unordered_set', args, 1, 1, row);
      return classType(unorderedClass(library, 'unordered_set', args[0], undefined));
    },
  });
  templates.push({
    name: 'pair',
    instantiate: (args, row) => {
      arity('pair', args, 2, 2, row);
      return classType(pairClass(library, args[0], args[1]));
    },
  });
  for (const name of FUNCTOR_NAMES) {
    templates.push({
      name,
      instantiate: (args, row) => {
        arity(name, args, 0, 1, row);
        return classType(functorClass(library, name, args[0] ? unqualified(args[0]) : undefined));
      },
    });
  }
  templates.push({
    name: 'numeric_limits',
    instantiate: (args, row) => {
      arity('numeric_limits', args, 1, 1, row);
      return classType(numericLimitsClass(library, args[0]));
    },
  });
  templates.push(...randomClasses(library));
  return templates;
}
