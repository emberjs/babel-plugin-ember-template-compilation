import type { NodePath } from '@babel/traverse';
import type * as Babel from '@babel/core';
import type { types as t } from '@babel/core';
import { ScopeLocals } from './scope-locals.js';

export class ExpressionParser {
  constructor(private babel: typeof Babel) {}

  parseExpression(invokedName: string, path: NodePath<t.Expression>): unknown {
    switch (path.node.type) {
      case 'ObjectExpression':
        return this.parseObjectExpression(invokedName, path as NodePath<t.ObjectExpression>);
      case 'ArrayExpression': {
        return this.parseArrayExpression(invokedName, path as NodePath<t.ArrayExpression>);
      }
      case 'StringLiteral':
      case 'BooleanLiteral':
      case 'NumericLiteral':
        return path.node.value;
      default:
        throw path.buildCodeFrameError(
          `${invokedName} can only accept static options but you passed ${JSON.stringify(
            path.node
          )}`
        );
    }
  }

  parseArrayExpression(invokedName: string, path: NodePath<t.ArrayExpression>) {
    return path.get('elements').map((element) => {
      if (element.isSpreadElement()) {
        throw element.buildCodeFrameError(`spread element is not allowed here`);
      } else if (element.isExpression()) {
        return this.parseExpression(invokedName, element);
      }
      return null;
    });
  }

  parseScope(invokedName: string, path: NodePath<t.ObjectProperty | t.ObjectMethod>): ScopeLocals {
    let body: t.BlockStatement | t.Expression | undefined = undefined;

    if (path.node.type === 'ObjectMethod') {
      body = path.node.body;
    } else {
      let { value } = path.node;
      if (this.t.isObjectExpression(value)) {
        throw path.buildCodeFrameError(
          `Passing an object as the \`scope\` property to inline templates is no longer supported. Please pass a function that returns an object expression instead.`
        );
      }
      if (this.t.isFunctionExpression(value) || this.t.isArrowFunctionExpression(value)) {
        body = value.body;
      }
    }

    let objExpression: t.Expression | undefined | null = undefined;

    if (body?.type === 'ObjectExpression') {
      objExpression = body;
    } else if (body?.type === 'BlockStatement') {
      // SAFETY: We know that the body is a ReturnStatement because we're checking inside
      let returnStatements = body.body.filter(
        (statement) => statement.type === 'ReturnStatement'
      ) as Babel.types.ReturnStatement[];

      if (returnStatements.length !== 1) {
        throw new Error(
          'Scope functions must have a single return statement which returns an object expression containing references to in-scope values'
        );
      }

      objExpression = returnStatements[0].argument;
    }

    if (objExpression?.type !== 'ObjectExpression') {
      throw path.buildCodeFrameError(
        `Scope objects for \`${invokedName}\` must be an object expression containing only references to in-scope values, or a function that returns an object expression containing only references to in-scope values`
      );
    }

    return objExpression.properties.reduce(
      (res, prop) => {
        if (this.t.isSpreadElement(prop)) {
          throw path.buildCodeFrameError(
            `Scope objects for \`${invokedName}\` may not contain spread elements`
          );
        }
        if (this.t.isObjectMethod(prop)) {
          throw path.buildCodeFrameError(
            `Scope objects for \`${invokedName}\` may not contain methods`
          );
        }

        let { key, value } = prop;
        if (!this.t.isStringLiteral(key) && !this.t.isIdentifier(key)) {
          throw path.buildCodeFrameError(
            `Scope objects for \`${invokedName}\` may only contain static property names`
          );
        }

        let propName = name(key);

        switch (value.type) {
          case 'Identifier':
            res.add(propName, value.name);
            break;
          case 'ThisExpression':
            res.add(propName, 'this');
            break;
          default:
            throw path.buildCodeFrameError(
              `Scope objects for \`${invokedName}\` may only contain direct references to in-scope values, e.g. { ${propName} } or { ${propName}: ${propName} }. Found ${value.type}`
            );
        }
        return res;
      },
      new ScopeLocals({ mode: 'explicit' })
    );
  }

  parseEval(
    invokedName: string,
    path: NodePath<t.ObjectProperty | t.ObjectMethod>
  ): { isEval: true } {
    let body: NodePath<t.BlockStatement>;

    if (path.isObjectMethod()) {
      body = path.get('body');
    } else if (path.isObjectProperty()) {
      let value = path.get('value');
      if (value.isFunctionExpression()) {
        body = value.get('body');
      } else {
        throw path.buildCodeFrameError(
          `unsupported syntax for \`eval\` parameter to \`${invokedName}\`. It must be an object method or a function.`
        );
      }
    } else {
      throw path.buildCodeFrameError(
        `unsupported syntax for \`eval\` parameter to \`${invokedName}\`. It must be an object method or a function.`
      );
    }

    let returnStatements = body
      .get('body')
      .filter((statement) => statement.isReturnStatement()) as NodePath<t.ReturnStatement>[];

    if (returnStatements.length !== 1) {
      throw body.buildCodeFrameError('eval function must have a single return statement');
    }

    let returnExpression = returnStatements[0].get('argument');

    if (!returnExpression.isCallExpression()) {
      throw returnStatements[0].buildCodeFrameError(
        'eval function must return `eval(arguments[0])`. Found non-CallExpression.'
      );
    }

    let callee = returnExpression.get('callee');
    if (!callee.isIdentifier() || callee.node.name !== 'eval') {
      throw returnExpression.buildCodeFrameError(
        'eval function must return `eval(arguments[0])`. Found callee is not eval.'
      );
    }

    let args = returnExpression.get('arguments');
    if (args.length !== 1) {
      throw returnExpression.buildCodeFrameError(
        'eval function must return `eval(arguments[0])`. Found incorrect number of arguments.'
      );
    }
    let arg = args[0];
    if (!arg.isMemberExpression()) {
      throw arg.buildCodeFrameError(
        'eval function must return `eval(arguments[0])`. Found argument is non-MemberExpression.'
      );
    }
    let obj = arg.get('object');
    if (!obj.isIdentifier() || obj.node.name !== 'arguments') {
      throw obj.buildCodeFrameError(
        'eval function must return `eval(arguments[0])`. Found wrong argument to eval.'
      );
    }
    let prop = arg.get('property');
    if (!prop.isNumericLiteral() || prop.node.value !== 0) {
      throw prop.buildCodeFrameError(
        'eval function must return `eval(arguments[0])`. Found wrong property.'
      );
    }
    return { isEval: true };
  }

  parseObjectExpression(
    invokedName: string,
    path: NodePath<t.ObjectExpression>,
    shouldParseScope = false,
    shouldSupportRFC931 = false
  ) {
    let result: Record<string, unknown> = {};

    path.get('properties').forEach((property) => {
      let { node } = property;
      if (this.t.isSpreadElement(node)) {
        throw property.buildCodeFrameError(`${invokedName} does not allow spread element`);
      }

      if (node.computed) {
        throw property.buildCodeFrameError(`${invokedName} can only accept static property names`);
      }

      let { key } = node;
      if (!this.t.isIdentifier(key) && !this.t.isStringLiteral(key)) {
        throw property.buildCodeFrameError(`${invokedName} can only accept static property names`);
      }

      let propertyName = name(key);

      if (shouldParseScope && propertyName === 'scope') {
        result.scope = this.parseScope(invokedName, property as NodePath<typeof node>);
      } else if (shouldSupportRFC931 && propertyName === 'eval') {
        result.eval = this.parseEval(invokedName, property as NodePath<typeof node>);
      } else if (shouldSupportRFC931 && propertyName === 'component') {
        result.component = (property as NodePath<typeof node>).get('value');
      } else {
        if (this.t.isObjectMethod(node)) {
          throw property.buildCodeFrameError(
            `${invokedName} does not accept a method for ${propertyName}`
          );
        }
        let valuePath = (property as NodePath<typeof node>).get('value');
        if (!valuePath.isExpression()) {
          throw valuePath.buildCodeFrameError(`must be an expression`);
        }
        result[propertyName] = this.parseExpression(invokedName, valuePath);
      }
    });

    return result;
  }

  private get t() {
    return this.babel.types;
  }
}

function name(node: t.StringLiteral | t.Identifier): string {
  if (node.type === 'StringLiteral') {
    return node.value;
  } else {
    return node.name;
  }
}
