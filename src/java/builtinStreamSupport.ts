import { type Collections } from './builtinCollections';
import { type Registry } from './builtinSupport';
import { type Wrappers } from './builtinWrappers';
import { type ClassInfo, type ClassType, type JavaType, type TypeVariable, type WildcardType } from './types';

export interface Context {
  registry: Registry;
  objectClass: ClassInfo;
  objectType: JavaType;
  stringType: JavaType;
  collections: Collections;
  wrappers: Wrappers;
  fn: (name: string) => ClassInfo;
}

export const classType = (cls: ClassInfo, ...args: JavaType[]): ClassType => ({ kind: 'class', cls, args });
export const superOf = (bound: JavaType): WildcardType => ({ kind: 'wildcard', bound, isSuper: true });
export const extendsOf = (bound: JavaType): WildcardType => ({ kind: 'wildcard', bound, isSuper: false });
export const typeVariable = (name: string, bound: JavaType): TypeVariable => ({ name, bounds: [bound] });
export const variableType = (variable: TypeVariable): JavaType => ({ kind: 'typeVar', variable });
