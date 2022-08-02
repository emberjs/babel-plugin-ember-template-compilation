import { resolve } from 'path';
import makePlugin from './plugin';
import type * as Babel from '@babel/core';

import { Options as PluginOptions } from './plugin';
import { assertTemplateCompiler, EmberTemplateCompiler } from './ember-template-compiler';

export interface Options extends PluginOptions {
  // The on-disk path to the ember-template-comipler.js module for our current
  // ember version. You need to either set `compilerPath` or set `compiler`.
  compilerPath?: string;

  // The ember-template-compiler.js module for your current ember version. You
  // need to either set `compilerPath` or `compiler`.
  compiler?: EmberTemplateCompiler;
}

const htmlbarsInlinePrecompile = makePlugin(function (opts: Options) {
  if (opts.compilerPath) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    let mod: any = require(opts.compilerPath);
    assertTemplateCompiler(mod);
    return mod;
  } else if (opts.compiler) {
    assertTemplateCompiler(opts.compiler);
    return opts.compiler;
  } else {
    throw new Error(`must provide compilerPath or compiler`);
  }
}) as {
  (babel: typeof Babel): Babel.PluginObj<Options>;
  _parallelBabel: { requireFile: string };
  baseDir(): string;
};

htmlbarsInlinePrecompile._parallelBabel = {
  requireFile: __filename,
};

htmlbarsInlinePrecompile.baseDir = function () {
  return resolve(__dirname, '..');
};

export default htmlbarsInlinePrecompile;
