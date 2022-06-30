import type { types as t } from '@babel/core';
import type * as Babel from '@babel/core';
import type { NodePath } from '@babel/traverse';
import type { ASTv1, WalkerPath } from '@glimmer/syntax';
import type { ImportUtil } from 'babel-import-util';

// This exists to give AST plugins a controlled interface for influencing the
// surrounding Javascript scope
export class JSUtils {
  #babel: typeof Babel;
  #program: NodePath<t.Program>;
  #template: NodePath<t.Expression>;
  #locals: string[];
  #importer: ImportUtil;

  constructor(
    babel: typeof Babel,
    program: NodePath<t.Program>,
    template: NodePath<t.Expression>,
    locals: string[],
    importer: ImportUtil
  ) {
    this.#babel = babel;
    this.#program = program;
    this.#template = template;
    this.#locals = locals;
    this.#importer = importer;
  }

  bindExpression(
    expression: string,
    target: WalkerPath<ASTv1.Node>,
    opts?: { nameHint?: string }
  ): string {
    let name = unusedNameLike(
      opts?.nameHint ?? 'a',
      (candidate) =>
        this.#template.scope.hasBinding(candidate) || astNodeHasBinding(target, candidate)
    );
    let t = this.#babel.types;
    this.#program.unshiftContainer(
      'body',
      t.variableDeclaration('let', [
        t.variableDeclarator(t.identifier(name), this.#parseExpression(expression)),
      ])
    );
    this.#locals.push(name);
    return name;
  }

  bindImport(
    moduleSpecifier: string,
    exportedName: string,
    target: WalkerPath<ASTv1.Node>,
    opts?: { nameHint?: string }
  ): string {
    // This will discover or create the local name for accessing the given import.
    let importedIdentifier = this.#importer.import(
      this.#template,
      moduleSpecifier,
      exportedName,
      opts?.nameHint
    );

    let identifier = unusedNameLike(importedIdentifier.name, (candidate) =>
      astNodeHasBinding(target, candidate)
    );
    if (identifier !== importedIdentifier.name) {
      // The importedIdentifier that we have in Javascript is not usable within
      // our HBS because it's shadowed by a block param. So we will introduce a
      // second name via a variable declaration.
      //
      // The reason we don't force the import itself to have this name is that
      // we might be re-using an existing import, and we don't want to go
      // rewriting all of its callsites that are unrelated to us.
      let t = this.#babel.types;
      this.#program.unshiftContainer(
        'body',
        t.variableDeclaration('let', [
          t.variableDeclarator(t.identifier(identifier), importedIdentifier),
        ])
      );
    }
    this.#locals.push(identifier);
    return identifier;
  }

  #parseExpression(expressionString: string): t.Expression {
    let parsed = this.#babel.parse(expressionString);
    if (!parsed) {
      throw new Error(
        `JSUtils.bindExpression could not understand the expression: ${expressionString}`
      );
    }
    let statements = body(parsed);
    if (statements.length !== 1) {
      throw new Error(
        `JSUtils.bindExpression expected to find exactly one expression but found ${statements.length} in: ${expressionString}`
      );
    }
    let statement = statements[0];
    if (statement.type !== 'ExpressionStatement') {
      throw new Error(
        `JSUtils.bindExpression expected to find an expression but found ${statement.type} in: ${expressionString}`
      );
    }
    return statement.expression;
  }
}

function unusedNameLike(desiredName: string, isUsed: (name: string) => boolean): string {
  let candidate = desiredName;
  let counter = 0;
  while (isUsed(candidate)) {
    candidate = `${desiredName}${counter++}`;
  }
  return candidate;
}

function astNodeHasBinding(target: WalkerPath<ASTv1.Node>, name: string): boolean {
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

// This extends Glimmer's ASTPluginEnvironment type to put our jsutils into
// meta.
export type WithJSUtils<T extends { meta?: object }> = {
  meta: T['meta'] & { jsutils: JSUtils };
} & T;

function body(node: t.Program | t.File) {
  if (node.type === 'File') {
    return node.program.body;
  } else {
    return node.body;
  }
}
