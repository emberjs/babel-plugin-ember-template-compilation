import type { types as t } from '@babel/core';
import type * as Babel from '@babel/core';
import type { NodePath } from '@babel/traverse';
import type { ASTPluginBuilder, ASTPluginEnvironment, ASTv1, WalkerPath } from '@glimmer/syntax';
import type { ImportUtil } from 'babel-import-util';

interface State {
  program: NodePath<Babel.types.Program>;
  lastInsertedPath: NodePath<Babel.types.Statement> | undefined;
}

// This exists to give AST plugins a controlled interface for influencing the
// surrounding Javascript scope
export class JSUtils {
  #babel: typeof Babel;
  #state: State;
  #template: NodePath<t.Expression>;
  #locals: string[];
  #importer: ImportUtil;

  constructor(
    babel: typeof Babel,
    state: State,
    template: NodePath<t.Expression>,
    locals: string[],
    importer: ImportUtil
  ) {
    this.#babel = babel;
    this.#state = state;
    this.#template = template;
    this.#locals = locals;
    this.#importer = importer;

    if (!this.#state.lastInsertedPath) {
      let target: NodePath<t.Statement> | undefined;
      for (let statement of this.#state.program.get('body')) {
        if (!statement.isImportDeclaration()) {
          break;
        }
        target = statement;
      }
      if (target) {
        this.#state.lastInsertedPath = target;
      }
    }
  }

  /**
   * Create a new binding that you can use in your template, initialized with
   * the given Javascript expression.
   *
   * @param { Expression } expression A javascript expression whose value will
   * initialize your new binding. See docs on the Expression type for details.
   * @param target The location within your template where the binding will be
   * used. This matters so we can avoid naming collisions.
   * @param opts.nameHint Optionally, provide a descriptive name for your new
   * binding. We will mangle this name as needed to avoid collisions, but
   * picking a good name here can aid in debugging.
   *
   * @return The name you can use in your template to access the binding.
   */
  bindExpression(
    expression: Expression,
    target: WalkerPath<ASTv1.Node>,
    opts?: { nameHint?: string }
  ): string {
    let name = unusedNameLike(
      opts?.nameHint ?? 'a',
      (candidate) =>
        this.#template.scope.hasBinding(candidate) ||
        this.#locals.includes(candidate) ||
        astNodeHasBinding(target, candidate)
    );
    let t = this.#babel.types;
    let declaration: NodePath<t.VariableDeclaration> = this.#emitStatement(
      t.variableDeclaration('let', [
        t.variableDeclarator(
          t.identifier(name),
          this.#parseExpression(this.#state.program, expression)
        ),
      ])
    );
    declaration.scope.registerBinding('module', declaration.get('declarations.0') as NodePath);
    this.#locals.push(name);
    return name;
  }

  #emitStatement<T extends t.Statement>(statement: T): NodePath<T> {
    if (this.#state.lastInsertedPath) {
      this.#state.lastInsertedPath = this.#state.lastInsertedPath.insertAfter(statement)[0];
    } else {
      this.#state.lastInsertedPath = this.#state.program.unshiftContainer('body', statement)[0];
    }
    return this.#state.lastInsertedPath as NodePath<T>;
  }

  /**
   * Gain access to an imported value within your template.
   *
   * @param moduleSpecifier The path to import from.
   * @param exportedName The named export you wish to access, or "default" for
   * the default export, or "*" for the namespace export.
   * @param target The location within your template where the binding will be
   * used. This matters so we can avoid naming collisions.
   * @param opts.nameHint Optionally, provide a descriptive name for your new
   * binding. We will mangle this name as needed to avoid collisions, but
   * picking a good name here can aid in debugging.
   *
   * @return The name you can use in your template to access the imported value.
   */
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

    // If we're already referencing the imported name from the outer scope and
    // it's not shadowed at our target location in the template, we can reuse
    // the existing import.
    if (
      this.#locals.includes(importedIdentifier.name) &&
      !astNodeHasBinding(target, importedIdentifier.name)
    ) {
      return importedIdentifier.name;
    }

    let identifier = unusedNameLike(
      importedIdentifier.name,
      (candidate) => this.#locals.includes(candidate) || astNodeHasBinding(target, candidate)
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
      this.#emitStatement(
        t.variableDeclaration('let', [
          t.variableDeclarator(t.identifier(identifier), importedIdentifier),
        ])
      );
    }
    this.#locals.push(identifier);
    return identifier;
  }

  /**
   * Add an import statement purely for side effect.
   *
   * @param moduleSpecifier the module to import
   */
  importForSideEffect(moduleSpecifier: string): void {
    this.#importer.importForSideEffect(moduleSpecifier);
  }

  /**
   * Emit a javascript expresison for side-effect. This only accepts
   * expressions, not statements, because you should not introduce new bindings.
   * To introduce a binding see bindExpression or bindImport instead.
   *
   * @param { Expression } expression A javascript expression whose value will
   * initialize your new binding. See docs on the Expression type below for
   * details.
   */
  emitExpression(expression: Expression): void {
    let t = this.#babel.types;
    this.#emitStatement(
      t.expressionStatement(this.#parseExpression(this.#state.program, expression))
    );
  }

  #parseExpression(target: NodePath<t.Node>, expression: Expression): t.Expression {
    let expressionString: string;
    if (typeof expression === 'string') {
      expressionString = expression;
    } else {
      expressionString = expression(new ExpressionContext(this.#importer, target));
    }

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

/**
 * This extends Glimmer's ASTPluginEnvironment type to put our jsutils into meta
 */
export type WithJSUtils<T extends { meta?: object }> = {
  meta: T['meta'] & { jsutils: JSUtils };
} & T;

export type ExtendedPluginBuilder = ASTPluginBuilder<WithJSUtils<ASTPluginEnvironment>>;

function body(node: t.Program | t.File) {
  if (node.type === 'File') {
    return node.program.body;
  } else {
    return node.body;
  }
}

/**
 * Allows you to construct an expression that relies on imported values.
 */
class ExpressionContext {
  #importer: ImportUtil;
  #target: NodePath<t.Node>;

  constructor(importer: ImportUtil, target: NodePath<t.Node>) {
    this.#importer = importer;
    this.#target = target;
  }

  /**
   * Find or create a local binding for the given import.
   *
   * @param moduleSpecifier The path to import from.
   * @param exportedName The named export you wish to access, or "default" for
   * the default export, or "*" for the namespace export.
   * @param nameHint Optionally, provide a descriptive name for your new
   * binding. We will mangle this name as needed to avoid collisions, but
   * picking a good name here can aid in debugging.

   * @return the local identifier for the imported value
   */
  import(moduleSpecifier: string, exportedName: string, nameHint?: string): string {
    return this.#importer.import(this.#target, moduleSpecifier, exportedName, nameHint).name;
  }
}

/**
 * You can pass a Javascript expression as a string like:
 *
 *   "new Date()"
 *
 * Or as a function that returns a string:
 *
 *   () => "new Date()"
 *
 * When you use a function, it can use imported values:
 *
 *   (context) => `new ${context.import("luxon", "DateTime")}()`
 *
 */
export type Expression = string | ((context: ExpressionContext) => string);
