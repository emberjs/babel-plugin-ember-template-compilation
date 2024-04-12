import type { ASTv1, WalkerPath } from '@glimmer/syntax';

export function astNodeHasBinding(target: WalkerPath<ASTv1.Node>, name: string): boolean {
  let cursor: WalkerPath<ASTv1.Node> | null = target;
  while (cursor) {
    let parentNode = cursor.parent?.node;
    if (
      parentNode?.type === 'ElementNode' &&
      parentNode.blockParams.includes(name) &&
      // an ElementNode's block params are valid only within its children
      parentNode.children.includes(cursor.node as ASTv1.Statement)
    ) {
      return true;
    }

    if (
      parentNode?.type === 'Block' &&
      parentNode.blockParams.includes(name) &&
      // a Block's blockParams are valid only within its body
      parentNode.body.includes(cursor.node as ASTv1.Statement)
    ) {
      return true;
    }

    cursor = cursor.parent;
  }
  return false;
}
