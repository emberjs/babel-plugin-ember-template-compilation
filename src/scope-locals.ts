/*
  This class exists because:
   - before template compilation starts, we need to pass a `locals` array to
     ember-template-compiler
   - the JSUtils API can mutate the scope during template compilation
   - those scope mutations need to update both the original `locals` array and
     our own name mapping, keeping them in sync.
*/

import type { NodePath } from '@babel/traverse';
import type { types as t } from '@babel/core';
import type { ASTPluginEnvironment, NodeVisitor } from '@glimmer/syntax';
import { astNodeHasBinding } from './hbs-utils.js';
import { readOnlyArray } from './read-only-array.js';

/**
 * RFC: https://github.com/emberjs/rfcs/pull/1070
 *
 * Criteria for inclusion in this list:
 *
 *   Any of:
 *     - begins with an uppercase letter
 *     - guaranteed to never be added to glimmer as a keyword (e.g.: globalThis)
 *
 *   And:
 *     - must not need new to invoke
 *     - must not require lifetime management (e.g.: setTimeout)
 *     - must not be a single-word lower-case API, because of potential collision with future new HTML elements
 *     - if the API is a function, the return value should not be a promise
 *     - must be one one of these lists:
 *        - https://tc39.es/ecma262/#sec-global-object
 *        - https://tc39.es/ecma262/#sec-function-properties-of-the-global-object
 *        - https://html.spec.whatwg.org/multipage/nav-history-apis.html#window
 *        - https://html.spec.whatwg.org/multipage/indices.html#all-interfaces
 *        - https://html.spec.whatwg.org/multipage/webappapis.html
 */
export const ALLOWED_GLOBALS = new Set([
  // ////////////////
  // namespaces
  // ////////////////
  //   TC39
  'globalThis',
  'Atomics',
  'JSON',
  'Math',
  'Reflect',
  //   WHATWG
  'localStorage',
  'sessionStorage',
  'URL',
  // ////////////////
  // functions / utilities
  // ////////////////
  //   TC39
  'isNaN',
  'isFinite',
  'parseInt',
  'parseFloat',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  //   WHATWG
  'postMessage',
  'structuredClone',
  // ////////////////
  // new-less Constructors (still functions)
  // ////////////////
  //   TC39
  'Array', // different behavior from (array)
  'BigInt',
  'Boolean',
  'Date',
  'Number',
  'Object', // different behavior from (hash)
  'String',
  // ////////////////
  // Values
  // ////////////////
  //   TC39
  'Infinity',
  'NaN',
  //   WHATWG
  'isSecureContext',
]);

/*
    `mode` refers to the implicit and explicit formats defined here:

      https://github.com/emberjs/rfcs/blob/9fd6ceac2559bee1c33acf0d7834e675125a4f16/text/0931-template-compiler-api.md#explicit-form
      https://github.com/emberjs/rfcs/blob/9fd6ceac2559bee1c33acf0d7834e675125a4f16/text/0931-template-compiler-api.md#implicit-form

    This class needs to know the difference because in implicit format, upvars
    in hbs are automagically connected with outer Javascript bindings, and in
    explicit form they are not.
*/
type Params =
  | {
      mode: 'explicit';
    }
  | {
      mode: 'implicit';
      jsPath: NodePath;
      mayUseLexicalThis: boolean;
    };

// A negated or explicitly-signed number is a UnaryExpression rather than a
// literal, but it's still a constant value with no dependency on any binding.
export type SignedNumericLiteral = t.UnaryExpression & {
  operator: '-' | '+';
  argument: t.NumericLiteral | t.BigIntLiteral;
};

// The constant values a scope entry can hold. Regexes and template literals
// are deliberately excluded: a regex literal would construct a new (stateful)
// object on every call, and a template literal can contain expressions that
// reference bindings we know nothing about.
export type LiteralScopeValue =
  | Exclude<t.Literal, t.RegExpLiteral | t.TemplateLiteral>
  | SignedNumericLiteral;

// Each hbs name in the template's scope maps to either the name of a JS
// binding or, when a bundler's constant inlining has replaced the original
// binding with its statically-known value, that value.
export type ScopeValue = string | LiteralScopeValue;

export class ScopeLocals {
  constructor(params: Params) {
    this.#params = params;
  }

  #mapping: Record<string, ScopeValue> = {};
  #locals: string[] = [];
  #params: Params;

  get locals() {
    return readOnlyArray(
      this.#locals,
      'The only supported way to manipulate locals is via the jsutils API\nhttps://github.com/emberjs/babel-plugin-ember-template-compilation#jsutils-manipulating-javascript-from-within-ast-transforms'
    );
  }

  has(key: string): boolean {
    return key in this.#mapping;
  }

  get(key: string): ScopeValue {
    return this.#mapping[key];
  }

  isEmpty(): boolean {
    return this.#locals.length === 0;
  }

  entries() {
    return Object.entries(this.#mapping);
  }

  add(hbsName: string, jsValue?: ScopeValue) {
    this.#mapping[hbsName] = jsValue ?? hbsName;
    if (!this.#locals.includes(hbsName)) {
      this.#locals.push(hbsName);
    }
  }

  #isInJsScope(hbsName: string, jsPath: NodePath) {
    let jsValue = this.#mapping[hbsName] ?? hbsName;
    if (typeof jsValue !== 'string') {
      // a constant value doesn't need any binding
      return true;
    }
    return ALLOWED_GLOBALS.has(jsValue) || jsPath.scope.getBinding(jsValue);
  }

  // this AST transform discovers all possible upvars in HBS that refer to valid
  // bindings in JS, and then depending on the mode adjusts our actual scope bag
  // contents.
  crawl() {
    return (_env: ASTPluginEnvironment): { name: string; visitor: NodeVisitor } => {
      let seen: Set<string>;
      return {
        name: 'scope-locals-crawl',
        visitor: {
          Template: {
            enter: () => {
              seen = new Set();
            },
            exit: (_node, _path) => {
              if (this.#params.mode === 'implicit') {
                // all hbs upvars that have matching JS bindings go into the
                // scope
                for (let name of seen) {
                  if (name === 'this') {
                    if (this.#params.mayUseLexicalThis) {
                      this.add(name);
                    }
                  } else if (this.#isInJsScope(name, this.#params.jsPath)) {
                    this.add(name);
                  }
                }
              } else {
                // in explicit form, we might prune back the preexising scope in
                // the case where another AST transform has eliminated the use
                // of the original binding. But we don't add anything new. The
                // only way for new bindings to be introduced into scope is for
                // another AST transform to explicitly call the jsutils, which
                // calls our `add`.
                for (let name of Object.keys(this.#mapping)) {
                  if (!seen.has(name)) {
                    this.#locals.splice(this.#locals.indexOf(name), 1);
                    delete this.#mapping[name];
                  }
                }
              }
            },
          },
          PathExpression: (node, path) => {
            switch (node.head.type) {
              case 'ThisHead':
                if (!astNodeHasBinding(path, 'this')) {
                  seen.add('this');
                }
                break;
              case 'VarHead': {
                const name = node.head.name;
                if (!astNodeHasBinding(path, name)) {
                  seen.add(name);
                }
              }
            }
          },
          ElementNode: (node, path) => {
            const name = node.tag.split('.')[0];
            if (!astNodeHasBinding(path, name)) {
              seen.add(name);
            }
          },
        },
      };
    };
  }
}
