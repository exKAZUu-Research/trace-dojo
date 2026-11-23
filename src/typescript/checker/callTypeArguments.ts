import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker, Mapper } from './checker';
import { named } from './syntax';
import type { TypeArgumentMismatch } from './typeNodes';
import type { Signature, Type } from './types';

export class CallTypeArguments {
  constructor(private readonly c: Checker) {}

  written(node: TreeNode): Type[] | undefined {
    const argumentsNode = node.childForFieldName('type_arguments');
    return argumentsNode ? named(argumentsNode).map((argument) => this.c.typeNodes.typeFromNode(argument)) : undefined;
  }

  candidates(node: TreeNode, signatures: Signature[], typeArguments?: Type[]): Signature[] {
    if (!typeArguments) return signatures;
    const count = typeArguments.length;
    const eligible = signatures.filter(
      ({ typeParameters }) =>
        typeParameters.length >= count && typeParameters.filter((parameter) => !parameter.default).length <= count
    );
    if (eligible.length === 0) {
      const counts = [...new Set(signatures.map((signature) => signature.typeParameters.length))];
      this.c.error(this.nodeAt(node, 0), `型引数は ${counts.join(' か ')} 個必要ですが、${count} 個渡されています。`);
    }
    return eligible;
  }

  firstMismatch(candidate: Signature, typeArguments?: Type[]): TypeArgumentMismatch | undefined {
    if (!typeArguments) return undefined;
    const { typeParameters } = candidate;
    const filled = this.c.fillTypeArguments(typeParameters, typeArguments);
    const first = this.c.typeNodes.typeArgumentMismatches(typeParameters, filled, typeArguments.length).next();
    return first.done ? undefined : first.value;
  }

  reportMismatch(node: TreeNode, mismatch: TypeArgumentMismatch): void {
    this.c.typeNodes.reportTypeArgumentMismatch(this.nodeAt(node, mismatch.index), mismatch);
  }

  instantiate(signature: Signature, typeArguments: Type[]): Signature {
    const filled = this.c.fillTypeArguments(signature.typeParameters, typeArguments);
    const mapper: Mapper = new Map(signature.typeParameters.map((parameter, index) => [parameter.id, filled[index]]));
    return { ...this.c.instantiateSignature(signature, mapper), typeParameters: [] };
  }

  private nodeAt(node: TreeNode, index: number): TreeNode {
    const argumentsNode = node.childForFieldName('type_arguments');
    return argumentsNode ? (named(argumentsNode)[index] ?? node) : node;
  }
}
