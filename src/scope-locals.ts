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
import { ASTPluginEnvironment, NodeVisitor } from '@glimmer/syntax';
import { astNodeHasBinding } from './hbs-utils';

export class ScopeLocals {
  constructor(jsPath: NodePath<t.Expression>) {
    this.#jsPath = jsPath;
  }

  #mapping: Record<string, string> = {};
  #locals: string[] = [];
  #jsPath: NodePath<t.Expression>;

  get locals() {
    return this.#locals;
  }

  has(key: string): boolean {
    return key in this.#mapping;
  }

  get(key: string): string {
    return this.#mapping[key];
  }

  isEmpty(): boolean {
    return this.#locals.length === 0;
  }

  needsRemapping(): boolean {
    return Object.entries(this.#mapping).some(([k, v]) => k !== v);
  }

  entries() {
    return Object.entries(this.#mapping);
  }

  add(hbsName: string, jsName?: string) {
    this.#mapping[hbsName] = jsName ?? hbsName;
    if (!this.#locals.includes(hbsName)) {
      this.#locals.push(hbsName);
    }
  }

  #isInJsScope(hbsName: string) {
    let jsName = this.#mapping[hbsName] ?? hbsName;
    return ['this', 'globalThis'].includes(jsName) || this.#jsPath.scope.getBinding(jsName);
  }

  get l() {
    return this.#locals;
  }

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
              for (let name of Object.keys(this.#mapping)) {
                if (!seen.has(name)) {
                  this.#locals.splice(this.#locals.indexOf(name), 1);
                  delete this.#mapping[name];
                }
              }
            },
          },
          PathExpression: (node, path) => {
            if (node.head.type !== 'VarHead') {
              return;
            }
            const name = node.head.name;
            if (!astNodeHasBinding(path, name) && this.#isInJsScope(name)) {
              seen.add(name);
              this.add(name, this.#mapping[name]);
            }
          },
          ElementNode: (node, path) => {
            const name = node.tag.split('.')[0];
            if (!astNodeHasBinding(path, name) && this.#isInJsScope(name)) {
              seen.add(name);
              this.add(name, this.#mapping[name]);
            }
          },
        },
      };
    };
  }
}
