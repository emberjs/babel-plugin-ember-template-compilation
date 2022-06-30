import type { types as t } from '@babel/core';
import type * as Babel from '@babel/core';
import type { NodePath } from '@babel/traverse';
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

  bindValue(expression: string, opts?: { nameHint?: string }): string {
    let name = this.#unusedNameLike(opts?.nameHint ?? 'a');
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

  bindImport(moduleSpecifier: string, exportedName: string, opts?: { nameHint?: string }): string {
    let identifier = this.#importer.import(
      this.#template,
      moduleSpecifier,
      exportedName,
      opts?.nameHint
    );
    this.#locals.push(identifier.name);
    return identifier.name;
  }

  #parseExpression(expressionString: string): t.Expression {
    let parsed = this.#babel.parse(expressionString);
    if (!parsed) {
      throw new Error(`JSUtils.bindValue could not understand the expression: ${expressionString}`);
    }
    let statements = body(parsed);
    if (statements.length !== 1) {
      throw new Error(
        `JSUtils.bindValue expected to find exactly one expression but found ${statements.length} in: ${expressionString}`
      );
    }
    let statement = statements[0];
    if (statement.type !== 'ExpressionStatement') {
      throw new Error(
        `JSUtils.bindValue expected to find an expression but found ${statement.type} in: ${expressionString}`
      );
    }
    return statement.expression;
  }

  #unusedNameLike(desiredName: string): string {
    let candidate = desiredName;
    let counter = 0;
    while (this.#template.scope.hasBinding(candidate)) {
      candidate = `${desiredName}${counter++}`;
    }
    return candidate;
  }
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
