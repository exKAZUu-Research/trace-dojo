import { type Type, typeName } from '../types';

/** A key that tells template arguments apart, including different classes with the same name. */
export function typeKey(type: Type): string {
  switch (type.kind) {
    case 'class': {
      return `${type.cls.name}#${type.cls.id}${type.isConst ? ' const' : ''}`;
    }
    case 'pointer': {
      return `${typeKey(type.to)}*${type.isConst ? ' const' : ''}`;
    }
    case 'reference': {
      return `${typeKey(type.to)}&`;
    }
    case 'array': {
      return `${typeKey(type.of)}[${type.length ?? ''}]`;
    }
    case 'memberPointer': {
      return `${typeKey(type.to)} ${type.cls.name}#${type.cls.id}::*`;
    }
    default: {
      return typeName(type);
    }
  }
}
