# babel-plugin-ember-template-compilation

<a href="https://github.com/emberjs/babel-plugin-ember-template-compilation"><img alt="Build Status" src="https://github.com/emberjs/babel-plugin-ember-template-compilation/workflows/CI/badge.svg"></a>

Babel plugin that implements Ember's low-level template-compilation API.

## Requirements

- Node 12+ (when used in Node, but we also support in-browser usage)
- Babel 7
- the output works with ember-source 3.27+. For older Ember versions, see [babel-plugin-htmlbars-inline-precompile](https://github.com/ember-cli/babel-plugin-htmlbars-inline-precompile) instead.

## Usage

This plugin implements `precompileTemplate` from [RFC 496](https://github.com/emberjs/rfcs/blob/master/text/0496-handlebars-strict-mode.md#low-level-apis):

```js
import { precompileTemplate } from '@ember/template-compilation';
```

For backward compatibility, it also has an `enableLegacyModules` option that can enable each of these widely-used older patterns:

```js
import { hbs } from 'ember-cli-htmlbars';
import hbs from 'ember-cli-htmlbars-inline-precompile';
import hbs from 'htmlbars-inline-precompile';
```

## Common Options

This package has both a Node implementation and a portable implementation that works in browsers.

The exported modules are:

- `babel-plugin-ember-template-compilation`: automatically chooses between the node and browser implementations (using package.json `exports` feature).
- `babel-plugin-ember-template-compilation/browser`: the core implementation that works in browsers (and anywhere else) without using any Node-specific APIs.
- `babel-plugin-ember-template-compilation/node`: the Node-specific implementation that adds the ability to automatically load plugins from disk, etc.

The options are:

```ts
interface Options {
  // The ember-template-compiler.js module that ships within your ember-source version. In the browser implementation, this is mandatory. In the Node implementation you can use compilerPath instead.
  compiler?: EmberTemplateCompiler;

  // The on-disk path to the ember-template-compiler.js module for our current
  // ember version. You may set `compilerPath` or set `compiler`.
  // This will get resolved from the current working directory, so a package name
  // like "ember-source/dist/ember-template-compiler" (the default value) is acceptable. 
  compilerPath?: string;

  // Allows you to remap what imports will be emitted in our compiled output. By
  // example:
  //
  //   outputModuleOverrides: {
  //     '@ember/template-factory': {
  //       createTemplateFactory: ['createTemplateFactory', '@glimmer/core'],
  //     }
  //   }
  //
  // Normal Ember apps shouldn't need this, it exists to support other
  // environments like standalone GlimmerJS
  outputModuleOverrides?: Record<string, Record<string, [string, string]>>;

  // By default, this plugin implements only Ember's stable public API for
  // template compilation, which is:
  //
  //    import { precompileTemplate } from '@ember/template-compilation';
  //
  // But historically there are several other importable syntaxes in widespread
  // use, and we can enable those too by including their module names in this
  // list. See `type LegacyModuleName` below.
  enableLegacyModules?: LegacyModuleName[];

  // Controls the output format.
  //
  //  "wire": The default. In the output, your templates are ready to execute in
  //  the most performant way.
  //
  //  "hbs": In the output, your templates will still be in HBS format.
  //  Generally this means they will still need further processing before
  //  they're ready to execute. The purpose of this mode is to support things
  //  like codemods and pre-publication transformations in libraries.
  targetFormat?: 'wire' | 'hbs';

  // Optional list of custom transforms to apply to the handlebars AST before
  // compilation. See `type Transform` below.
  transforms?: Transform[];
}

// The legal legacy module names. These are the only ones that are supported,
// because these are the ones in widespread community use. We don't want people
// creating new ones -- prefer `@ember/template-compilation` in new code.
type LegacyModuleName =
  | 'ember-cli-htmlbars'
  | 'ember-cli-htmlbars-inline-precompile'
  | 'htmlbars-inline-precompile';

// Each transform can be
//   - the actual AST transform function (this is the only kind that works in non-Node environments)
//   - a path to a module where we will find the AST transform function as the default export
//   - an array of length two containing the path to a module and an arguments object.
//       In this case we will pass the arguments to the default export from the module and
//       it should return the actual AST transform function.
// All the path resolving happens relative to the current working directory and
// respects node_modules resolution.
type Transform = Function | string | [string, unknown];
```

# JSUtils: Manipulating Javascript from within AST transforms

AST transforms are plugins for modifying HBS templates at build time. Because those templates are embedded in Javascript and can access the Javascript scope, an AST plugin may want to introduce some new things into Javascript scope. That is what the JSUtils API is for.

Your AST transform can access the JSUtils API via `env.meta.jsutils`. Here's an example transform.

```js
function myAstTransform(env) {
  return {
    name: 'my-ast-transform',
    visitor: {
      PathExpression(node, path) {
        if (node.original === 'onePlusOne') {
          let name = env.meta.jsutils.bindExpression('1+1', path, { nameHint: 'two' });
          return env.syntax.builders.path(name);
        }
      },
    },
  };
}
```

The example transform above would rewrite:

```js
import { precompileTemplate } from '@ember/template-compilation';
precompileTemplate('<Counter @value={{onePlusOne}} />>');
```

To:

```js
import { precompileTemplate } from '@ember/template-compilation';
let two = 1 + 1;
precompileTemplate('<Counter @value={{two}} />', { scope: () => ({ two }) });
```

See the jsdoc comments in js-utils.js for details on the methods available.

# Acknowledgement / History

This repo derives from https://github.com/ember-cli/babel-plugin-htmlbars-inline-precompile
