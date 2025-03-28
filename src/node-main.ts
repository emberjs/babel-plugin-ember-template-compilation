import { dirname, resolve, sep } from 'path';
import { makePlugin } from './plugin.js';

import { Options as SharedOptions } from './plugin.js';
import { assertTemplateCompiler, EmberTemplateCompiler } from './ember-template-compiler.js';
import { ExtendedPluginBuilder } from './js-utils.js';
import { fileURLToPath, pathToFileURL } from 'url';
import { resolve as importMetaResolve } from 'import-meta-resolve';

export * from './public-types.js';

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

async function cwdImport(moduleName: string) {
  let target = importMetaResolve(moduleName, pathToFileURL(process.cwd() + sep).href);
  if (!target.startsWith('file:')) {
    // import-meta-resolve doesn't consistently return file URLs rather than paths
    // https://github.com/wooorm/import-meta-resolve/issues/31
    //
    // also, under some conditions which I have not been able to reproduce in
    // the test suite, Windows will error if you pass an absolute path that is
    // not a file: URL.
    target = pathToFileURL(target).href;
  }
  return esCompat(await import(target));
}

async function handleNodeSpecificOptions(opts: Options): Promise<SharedOptions> {
  let compiler: EmberTemplateCompiler | undefined = undefined;
  if (opts.compilerPath) {
    let mod: any = await cwdImport(opts.compilerPath);
    assertTemplateCompiler(mod);
    compiler = mod;
  } else if (opts.compiler) {
    assertTemplateCompiler(opts.compiler);
    compiler = opts.compiler;
  } else if ((opts.targetFormat ?? 'wire') === 'wire') {
    let mod: any = await cwdImport('ember-source/dist/ember-template-compiler.js');
    assertTemplateCompiler(mod);
    compiler = mod;
  }

  let transforms = [];
  if (opts.transforms) {
    transforms = await Promise.all(
      opts.transforms.map(async (t) => {
        if (typeof t === 'string') {
          return (await cwdImport(t)).default;
        } else if (Array.isArray(t) && typeof t[0] === 'string') {
          return (await cwdImport(t[0])).default.call(undefined, t[1]);
        } else {
          return t;
        }
      })
    );
  }
  return { ...opts, transforms, compiler };
}

const htmlbarsInlinePrecompile = makePlugin(handleNodeSpecificOptions);

(htmlbarsInlinePrecompile as any)._parallelBabel = {
  requireFile: fileURLToPath(import.meta.url),
};

(htmlbarsInlinePrecompile as any).baseDir = function () {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
};

export default htmlbarsInlinePrecompile as typeof htmlbarsInlinePrecompile & {
  baseDir(): string;
  _parallelBabel: { requireFile: string };
};

function esCompat(m: Record<string, any>) {
  if (m?.default?.__esModule) {
    return m.default;
  }
  return m;
}
