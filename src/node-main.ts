import { resolve } from 'path';
import { makePlugin } from './plugin';

import { Options as SharedOptions } from './plugin';
import { assertTemplateCompiler, EmberTemplateCompiler } from './ember-template-compiler';
import { ExtendedPluginBuilder } from './js-utils';

export * from './public-types';

export type Transform = ExtendedPluginBuilder | string | [string, unknown];

export type Options = Omit<SharedOptions, 'transforms' | 'compiler'> & {
  // The on-disk path to the ember-template-compiler.js module for our current
  // ember version. You can set either `compilerPath` or set `compiler`. If you
  // set neither, we will attempt to resolve
  // "ember-source/dist/ember-template-compiler.js" from the current working
  // directory.
  compilerPath?: string;

  // The ember-template-compiler.js module that ships within your ember-source
  // version. You can set either `compilerPath` or `compiler`.
  compiler?: EmberTemplateCompiler;

  // List of custom transformations to apply to the handlebars AST before
  // compilation. These can be
  //   - the actual functions
  //   - resolvable module names
  //   - pairs of [resolvableModuleName, options], in which case we will invoke
  //     the default export of the module with the options as argument, and the
  //     actual ast transform function should be returned.
  transforms?: Transform[];
};

function cwdRequire(moduleName: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(require.resolve(moduleName, { paths: [process.cwd()] }));
}

function handleNodeSpecificOptions(opts: Options): SharedOptions {
  let compiler: EmberTemplateCompiler | undefined = undefined;
  if (opts.compilerPath) {
    let mod: any = cwdRequire(opts.compilerPath);
    assertTemplateCompiler(mod);
    compiler = mod;
  } else if (opts.compiler) {
    assertTemplateCompiler(opts.compiler);
    compiler = opts.compiler;
  } else {
    let mod: any = cwdRequire('ember-source/dist/ember-template-compiler.js');
    assertTemplateCompiler(mod);
    compiler = mod;
  }

  let transforms = [];
  if (opts.transforms) {
    transforms = opts.transforms.map((t) => {
      if (typeof t === 'string') {
        return esCompat(cwdRequire(t)).default;
      } else if (Array.isArray(t) && typeof t[0] === 'string') {
        return esCompat(cwdRequire(t[0])).default.call(undefined, t[1]);
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

function esCompat(m: Record<string, any>) {
  return m?.__esModule ? m : { default: m };
}
