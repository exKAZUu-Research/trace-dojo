import type { Checker } from './checker';
import { hasIndexSignature, keyedIndexes } from './indexInfos';
import {
  booleanType,
  falseType,
  type LiteralValue,
  type MappedInfo,
  nullType,
  type ObjectType,
  type Property,
  type Signature,
  type Structure,
  trueType,
  type Type,
  undefinedType,
  unionOf,
  uniqueSymbolName,
} from './types';

function modifierPrefix(modifier: '+' | '-'): string {
  return modifier === '-' ? '-' : '';
}

function isNullish(member: Type): boolean {
  return member.kind === 'intrinsic' && (member.name === 'null' || member.name === 'undefined');
}

/** Prints types as TypeScript writes them in its messages. */
export class Printer {
  private depth = 0;

  constructor(private readonly c: Checker) {}

  print(type: Type): string {
    this.c.budget.spend();
    if (this.depth > 4) return '...';
    this.depth++;
    try {
      const printed = this.printType(type);
      // As TypeScript's `typeToString`, a whole printed type is cut short at twice its length limit.
      return this.depth === 1 && printed.length >= MAX_TYPE_LENGTH
        ? `${printed.slice(0, MAX_TYPE_LENGTH - 3)}...`
        : printed;
    } finally {
      this.depth--;
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- One case per kind of type.
  // code-gauge-allow functionNcss -- One case per kind of type.
  private printType(type: Type): string {
    switch (type.kind) {
      case 'intrinsic': {
        return type.name;
      }
      case 'literal': {
        return printLiteral(type.value);
      }
      case 'union': {
        if (type === booleanType) return 'boolean';
        // TypeScript lists `null` and `undefined` last, as in `string | undefined`.
        const members = [
          ...type.types.filter((member) => !isNullish(member)),
          ...[nullType, undefinedType].filter((member) => type.types.includes(member)),
        ];
        this.c.budget.spend(members.length);
        const printedMembers =
          members.includes(trueType) && members.includes(falseType)
            ? members
                .filter((member) => member !== trueType)
                .map((member) => (member === falseType ? booleanType : member))
            : members;
        return this.printUnion(printedMembers);
      }
      case 'intersection': {
        return boundedJoin(type.types, ' & ', (member) => this.wrap(member));
      }
      case 'typeParameter': {
        // A class's polymorphic `this` prints as the class.
        const constraint = type.isThisType ? type.constraint?.() : undefined;
        return constraint ? this.print(constraint) : type.name;
      }
      case 'indexedAccess': {
        return `${this.wrap(type.objectType)}[${this.print(type.indexType)}]`;
      }
      case 'keyof': {
        return `keyof ${this.wrap(type.type)}`;
      }
      case 'conditional': {
        if (type.aliasName) return this.printAlias(type.aliasName, type.aliasArguments);
        return `${this.print(type.checkType)} extends ${this.print(type.extendsType)} ? ${this.print(type.trueType)} : ${this.print(type.falseType)}`;
      }
      case 'templateLiteral': {
        let text = '`';
        for (const [index, part] of type.texts.entries()) {
          this.c.budget.spend();
          text += part;
          if (text.length >= MAX_TYPE_LENGTH) break;
          if (index < type.types.length) text += `\${${this.print(type.types[index])}}`;
        }
        return `${text}\``;
      }
      case 'stringMapping': {
        return `${type.mapping}<${this.print(type.type)}>`;
      }
      case 'object': {
        return this.printObject(type);
      }
    }
  }

  private printUnion(members: Type[]): string {
    if (members.length <= 2) return boundedJoin(members, ' | ', (member) => this.wrap(member));
    const kept: string[] = [];
    let length = 0;
    for (let index = 0; index < members.length - 1; index++) {
      const text = this.wrap(members[index]);
      if (length + text.length > MAX_PRINTED_LENGTH) break;
      kept.push(text);
      length += text.length + 3;
    }
    const last = this.wrap(members.at(-1) as Type);
    const omitted = members.length - 1 - kept.length;
    if (omitted > 0 || length + last.length > MAX_PRINTED_LENGTH) kept.push(`... ${omitted} more ...`);
    return [...kept, last].join(' | ');
  }

  /** A type as a member of a union, an intersection, or an array, parenthesized when it is a function. */
  private wrap(type: Type): string {
    const text = this.print(type);
    if (type.kind === 'object' && type.isFunction && !type.aliasName) return `(${text})`;
    if (type.kind === 'union' && type !== booleanType) return `(${text})`;
    if (type.kind === 'intersection') return `(${text})`;
    return text;
  }

  private printAlias(name: string, args: Type[] = []): string {
    return args.length > 0 ? `${name}<${boundedJoin(args, ', ', (argument) => this.print(argument))}>` : name;
  }

  // code-gauge-allow functionCognitiveComplexity -- One case per kind of object type.
  private printObject(type: ObjectType): string {
    if (type.aliasName) return this.printAlias(type.aliasName, type.aliasArguments);
    switch (type.objectKind) {
      case 'reference': {
        const args = type.typeArguments ?? [];
        if (this.c.isArrayType(type)) return `${this.wrap(args[0])}[]`;
        if (this.c.isReadonlyArrayType(type)) return `readonly ${this.wrap(args[0])}[]`;
        return `${type.name}<${boundedJoin(args, ', ', (argument) => this.print(argument))}>`;
      }
      case 'interface': {
        if (type.typeParameters)
          return `${type.name}<${boundedJoin(type.typeParameters, ', ', (parameter) => parameter.name)}>`;
        return type.name ?? '{}';
      }
      case 'tuple': {
        const elements = boundedJoin(type.tuple?.elements ?? [], ', ', (element) => {
          const name = element.name ? `${element.name}${element.optional ? '?' : ''}: ` : '';
          if (element.rest) return `...${name}${this.print(element.type)}`;
          return `${name}${this.print(element.type)}${element.optional && !element.name ? '?' : ''}`;
        });
        return `${type.tuple?.readonly ? 'readonly ' : ''}[${elements}]`;
      }
      case 'mapped': {
        return type.mapped ? this.printMapped(type.mapped) : '{}';
      }
      default: {
        return this.printAnonymous(type);
      }
    }
  }

  private printMapped(info: MappedInfo): string {
    const readonly = info.readonlyModifier ? `${modifierPrefix(info.readonlyModifier)}readonly ` : '';
    const optional = info.optionalModifier ? `${modifierPrefix(info.optionalModifier)}?` : '';
    const as = info.nameType ? ` as ${this.print(info.nameType)}` : '';
    // TypeScript prints the template of a mapped type that adds `?` with the `undefined` it reads as.
    const template = info.optionalModifier === '+' ? unionOf([info.template, undefinedType]) : info.template;
    return `{ ${readonly}[${info.typeParameter.name} in ${this.print(info.constraint)}${as}]${optional}: ${this.print(template)}; }`;
  }

  private printAnonymous(type: ObjectType): string {
    if (type.isClassStatic && type.classInfo) return `typeof ${type.classInfo.name}`;
    const structure = type.resolve();
    const signatureOnly = this.printSignatureOnly(structure);
    if (signatureOnly) return signatureOnly;
    const members = boundedJoin(this.anonymousMembers(structure), ' ', (member) => member);
    return members ? `{ ${members} }` : '{}';
  }

  private *anonymousMembers(structure: Structure): Iterable<string> {
    for (const index of keyedIndexes(structure))
      yield `${index.readonly ? 'readonly ' : ''}[x: ${this.print(index.keyType)}]: ${this.print(index.type)};`;
    for (const signature of structure.callSignatures) yield `${this.printSignature(signature, ': ')};`;
    for (const signature of structure.constructSignatures) yield `new ${this.printSignature(signature, ': ')};`;
    for (const property of structure.properties.values()) yield* this.printProperty(property);
  }

  /** A function or constructor type with a single signature and no other members, as an arrow. */
  private printSignatureOnly(structure: Structure): string | undefined {
    if (structure.properties.size > 0 || hasIndexSignature(structure)) return undefined;
    const { callSignatures, constructSignatures } = structure;
    if (callSignatures.length === 1 && constructSignatures.length === 0) {
      return this.printSignature(callSignatures[0], ' => ');
    }
    if (callSignatures.length === 0 && constructSignatures.length === 1) {
      const signature = constructSignatures[0];
      return `${signature.isAbstract ? 'abstract ' : ''}new ${this.printSignature(signature, ' => ')}`;
    }
    return undefined;
  }

  /** The members a property prints as: one per signature of a method. */
  private *printProperty(property: Property): Iterable<string> {
    this.c.budget.spend();
    const name = printedPropertyName(property.name, this.c.typeOperators.propertyKeyType(property));
    const optional = property.optional ? '?' : '';
    const propertyType = property.type();
    if (property.isMethod && propertyType.kind === 'object') {
      for (const signature of propertyType.resolve().callSignatures)
        yield `${name}${optional}${this.printSignature(signature, ': ')};`;
      return;
    }
    yield `${property.readonly ? 'readonly ' : ''}${name}${optional}: ${this.print(property.optional ? this.c.relations.removeUndefined(propertyType) : propertyType)};`;
  }

  printSignature(signature: Signature, arrow: string): string {
    const typeParameters =
      signature.typeParameters.length > 0
        ? `<${boundedJoin(signature.typeParameters, ', ', (parameter) => parameter.name)}>`
        : '';
    const thisParameter = signature.thisType ? `this: ${this.print(signature.thisType)}` : '';
    const parameters = boundedJoin(
      signature.parameters,
      ', ',
      (parameter) => {
        if (parameter.rest) return `...${parameter.name}: ${this.print(parameter.type)}`;
        return `${parameter.name}${parameter.optional ? '?' : ''}: ${this.print(parameter.optional ? this.c.relations.removeUndefined(parameter.type) : parameter.type)}`;
      },
      thisParameter
    );
    const predicate = signature.predicate
      ? `${signature.predicate.index === -1 ? 'this' : (signature.parameters[signature.predicate.index]?.name ?? 'x')} is ${this.print(signature.predicate.type)}`
      : undefined;
    return `${typeParameters}(${parameters})${arrow}${predicate ?? this.print(signature.returnType())}`;
  }
}

/** TypeScript's limit on the length of a printed type, past which it leaves members out. */
const MAX_PRINTED_LENGTH = 160;

const MAX_TYPE_LENGTH = MAX_PRINTED_LENGTH * 2;

function boundedJoin<T>(values: Iterable<T>, separator: string, print: (value: T) => string, prefix = ''): string {
  if (prefix.length >= MAX_TYPE_LENGTH) return prefix;
  let result = prefix;
  let delimiter = prefix ? separator : '';
  for (const value of values) {
    result += delimiter + print(value);
    if (result.length >= MAX_TYPE_LENGTH) break;
    delimiter = separator;
  }
  return result;
}

function printLiteral(value: LiteralValue): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return `typeof ${uniqueSymbolName(String(value))}`;
  return String(value);
}

/** How a type prints a property name: an identifier as is, a symbol in brackets, and others quoted. */
export function printedPropertyName(name: string, key: Type): string {
  if (key.kind === 'literal' && typeof key.value === 'symbol') {
    const symbolName = uniqueSymbolName(String(key.value));
    if (symbolName !== undefined) return `[${symbolName}]`;
  }
  return /^#?[$A-Z_a-z\u0080-￿][\w$\u0080-￿]*$/.test(name) ? name : JSON.stringify(name);
}
