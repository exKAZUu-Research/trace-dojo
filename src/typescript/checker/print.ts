import type { Checker } from './checker';
import {
  booleanType,
  falseType,
  type ObjectType,
  type Property,
  type Signature,
  type Structure,
  trueType,
  type Type,
} from './types';

function isNullish(member: Type): boolean {
  return member.kind === 'intrinsic' && (member.name === 'null' || member.name === 'undefined');
}

/** Prints types as TypeScript writes them in its messages. */
export class Printer {
  private depth = 0;

  constructor(private readonly c: Checker) {}

  print(type: Type): string {
    if (this.depth > 4) return '...';
    this.depth++;
    try {
      return this.printType(type);
    } finally {
      this.depth--;
    }
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- One case per kind of type.
  // code-gauge-allow functionNcss 47 -- One case per kind of type.
  private printType(type: Type): string {
    switch (type.kind) {
      case 'intrinsic': {
        return type.name;
      }
      case 'literal': {
        if (typeof type.value === 'string') return JSON.stringify(type.value);
        if (typeof type.value === 'bigint') return `${type.value}n`;
        return String(type.value);
      }
      case 'union': {
        if (type === booleanType) return 'boolean';
        // TypeScript lists `null` and `undefined` last, as in `string | undefined`.
        const members = [...type.types.filter((member) => !isNullish(member)), ...type.types.filter(isNullish)];
        const hasBoolean = members.includes(trueType) && members.includes(falseType);
        const printed: string[] = [];
        for (const member of members) {
          if (hasBoolean && (member === trueType || member === falseType)) {
            if (member === falseType) printed.push('boolean');
            continue;
          }
          printed.push(this.wrap(member));
        }
        return printed.join(' | ');
      }
      case 'intersection': {
        return type.types.map((member) => this.wrap(member)).join(' & ');
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
        if (type.aliasName) return type.aliasName;
        return `${this.print(type.checkType)} extends ${this.print(type.extendsType)} ? ${this.print(type.trueType)} : ${this.print(type.falseType)}`;
      }
      case 'templateLiteral': {
        let text = '`';
        for (const [index, part] of type.texts.entries()) {
          text += part;
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

  /** A type as a member of a union, an intersection, or an array, parenthesized when it is a function. */
  private wrap(type: Type): string {
    const text = this.print(type);
    if (type.kind === 'object' && type.isFunction && !type.aliasName) return `(${text})`;
    if (type.kind === 'union' && type !== booleanType) return `(${text})`;
    if (type.kind === 'intersection') return `(${text})`;
    return text;
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- One case per kind of object type.
  private printObject(type: ObjectType): string {
    if (type.aliasName) {
      const args = type.aliasArguments ?? [];
      return args.length > 0 &&
        !args.every((argument) => argument.kind === 'typeParameter' && argument.name === argument.name && false)
        ? `${type.aliasName}<${args.map((argument) => this.print(argument)).join(', ')}>`
        : type.aliasName;
    }
    switch (type.objectKind) {
      case 'reference': {
        const args = type.typeArguments ?? [];
        if (type.target?.name === 'Array') return `${this.wrap(args[0])}[]`;
        if (type.target?.name === 'ReadonlyArray') return `readonly ${this.wrap(args[0])}[]`;
        return `${type.name}<${args.map((argument) => this.print(argument)).join(', ')}>`;
      }
      case 'interface': {
        if (type.typeParameters)
          return `${type.name}<${type.typeParameters.map((parameter) => parameter.name).join(', ')}>`;
        return type.name ?? '{}';
      }
      case 'tuple': {
        const elements = (type.tuple?.elements ?? []).map((element) => {
          const name = element.name ? `${element.name}${element.optional ? '?' : ''}: ` : '';
          if (element.rest) return `...${name}${this.print(element.type)}`;
          return `${name}${this.print(element.type)}${element.optional && !element.name ? '?' : ''}`;
        });
        return `${type.tuple?.readonly ? 'readonly ' : ''}[${elements.join(', ')}]`;
      }
      case 'mapped': {
        const info = type.mapped;
        if (!info) return '{}';
        return `{ [${info.typeParameter.name} in ${this.print(info.constraint)}]: ${this.print(info.template)}; }`;
      }
      default: {
        return this.printAnonymous(type);
      }
    }
  }

  private printAnonymous(type: ObjectType): string {
    if (type.isClassStatic && type.classInfo) return `typeof ${type.classInfo.name}`;
    const structure = type.resolve();
    const signatureOnly = this.printSignatureOnly(structure);
    if (signatureOnly) return signatureOnly;
    const members: string[] = [];
    if (structure.stringIndex) members.push(`[x: string]: ${this.print(structure.stringIndex.type)};`);
    if (structure.numberIndex) members.push(`[x: number]: ${this.print(structure.numberIndex.type)};`);
    for (const signature of structure.callSignatures) members.push(`${this.printSignature(signature, ': ')};`);
    for (const signature of structure.constructSignatures) members.push(`new ${this.printSignature(signature, ': ')};`);
    for (const property of structure.properties.values()) members.push(...this.printProperty(property));
    if (members.length === 0) return '{}';
    return `{ ${members.join(' ')} }`;
  }

  /** A function or constructor type with a single signature and no other members, as an arrow. */
  private printSignatureOnly(structure: Structure): string | undefined {
    if (structure.properties.size > 0 || structure.stringIndex || structure.numberIndex) return undefined;
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
  private printProperty(property: Property): string[] {
    const name = /^[$A-Z_a-z\u0080-￿][\w$\u0080-￿]*$/.test(property.name)
      ? property.name
      : JSON.stringify(property.name);
    const optional = property.optional ? '?' : '';
    const propertyType = property.type();
    if (property.isMethod && propertyType.kind === 'object') {
      return propertyType
        .resolve()
        .callSignatures.map((signature) => `${name}${optional}${this.printSignature(signature, ': ')};`);
    }
    return [
      `${property.readonly ? 'readonly ' : ''}${name}${optional}: ${this.print(property.optional ? this.c.relations.removeUndefined(propertyType) : propertyType)};`,
    ];
  }

  printSignature(signature: Signature, arrow: string): string {
    const typeParameters =
      signature.typeParameters.length > 0
        ? `<${signature.typeParameters.map((parameter) => parameter.name).join(', ')}>`
        : '';
    const parameters = signature.parameters.map((parameter) => {
      if (parameter.rest) return `...${parameter.name}: ${this.print(parameter.type)}`;
      return `${parameter.name}${parameter.optional ? '?' : ''}: ${this.print(parameter.optional ? this.c.relations.removeUndefined(parameter.type) : parameter.type)}`;
    });
    if (signature.thisType) parameters.unshift(`this: ${this.print(signature.thisType)}`);
    const predicate = signature.predicate
      ? `${signature.predicate.index === -1 ? 'this' : (signature.parameters[signature.predicate.index]?.name ?? 'x')} is ${this.print(signature.predicate.type)}`
      : undefined;
    return `${typeParameters}(${parameters.join(', ')})${arrow}${predicate ?? this.print(signature.returnType())}`;
  }
}
