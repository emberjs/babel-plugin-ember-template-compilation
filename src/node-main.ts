import { resolve } from 'path';
import makePlugin from './plugin';

import { Options as SharedOptions } from './plugin';
import { assertTemplateCompiler, EmberTemplateCompiler } from './ember-template-compiler';
import { ExtendedPluginBuilder } from './js-utils';

export type Options = Omit<SharedOptions, 'transforms' | 'compiler'> & {
  // The on-disk path to the ember-template-comipler.js module for our current
  // ember version. You need to either set `compilerPath` or set `compiler`.
  compilerPath?: string;

  // The ember-template-compiler.js module that ships within your ember-source
  // version. You need to set either `compilerPath` or `compiler`.
  compiler?: EmberTemplateCompiler;

  // List of custom transformations to apply to the handlebars AST before
  // compilation. These can be the actual functions or resolvable module names.
  transforms?: (ExtendedPluginBuilder | string)[];
};

function handleNodeSpecificOptions(opts: Options): SharedOptions {
  let compiler: EmberTemplateCompiler;
  if (opts.compilerPath) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    let mod: any = require(opts.compilerPath);
    assertTemplateCompiler(mod);
    compiler = mod;
  } else if (opts.compiler) {
    assertTemplateCompiler(opts.compiler);
    compiler = opts.compiler;
  } else {
    throw new Error(`must provide compilerPath or compiler`);
  }

  let transforms = [];
  if (opts.transforms) {
    transforms = opts.transforms.map((t) => {
      if (typeof t === 'string') {
        return require(t);
      } else {
        return t;
      }
    });
  }
  return { ...opts, transforms, compiler };
}

const htmlbarsInlinePrecompile = makePlugin(handleNodeSpecificOptions);

(htmlbarsInlinePrecompile as any)._parallelBabel = {
  requireFile: __filename,
};

(htmlbarsInlinePrecompile as any).baseDir = function () {
  return resolve(__dirname, '..');
};

export default htmlbarsInlinePrecompile as typeof htmlbarsInlinePrecompile & {
  baseDir(): string;
  _parallelBabel: { requireFile: string };
};
