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

This package has both a Node implementation and a portable implementation that works in browsers. Both implementations share these common options:

```ts
interface Options {
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
  // list.
  enableLegacyModules?: LegacyModuleName[];
}

type LegacyModuleName =
  | 'ember-cli-htmlbars'
  | 'ember-cli-htmlbars-inline-precompile'
  | 'htmlbars-inline-precompile';
```

### Node Options

When used in Node, the Options are extended to include:

```ts
interface NodeOptions extends Options {
  // The on-disk path to a module that provides a `precompile` function as
  // defined below. You need to either set `precompilePath` or set `precompile`.
  precompilerPath?: string;

  // A precompile function that invokes Ember's template compiler.
  //
  // Options handling rules:
  //
  //  - we add `content`, which is the original string form of the template
  //  - we have special parsing for `scope` which becomes `locals` when passed
  //    to your precompile
  //  - anything else the user passes to `precompileTemplate` will be passed
  //    through to your `precompile`.
  precompile?: EmberPrecompile;
}

type EmberPrecompile = (templateString: string, options: Record<string, unknown>) => string;
```

### Browser Options

For use in non-Node environments including browsers, when you import from this package you get a factory function that takes a callback and returns the plugin. Your callback receives the babel plugin options and should return the `precompile: EmberPrecompile` function as defined above.

```js
import makePlugin from 'babel-plugin-ember-template-compilation';
import * as babel from '@babel/core';

babel.transform(someCode, { plugins: [makePlugin(loadTemplateCompiler)] });
```

# Acknowledgement / History

This repo derives from https://github.com/ember-cli/babel-plugin-htmlbars-inline-precompile
