import type { NodePath } from '@babel/traverse';
import type * as Babel from '@babel/core';
import type { types as t } from '@babel/core';
import { ImportUtil } from 'babel-import-util';
import { ExpressionParser } from './expression-parser';
import { JSUtils, ExtendedPluginBuilder } from './js-utils';
import type { EmberTemplateCompiler, PreprocessOptions } from './ember-template-compiler';
import { LegacyModuleName } from './public-types';
import { ScopeLocals } from './scope-locals';
import { ASTPluginBuilder, preprocess, print } from '@glimmer/syntax';

export * from './public-types';

type ModuleName = LegacyModuleName | '@ember/template-compilation' | '@ember/template-compiler';

interface ModuleConfig {
  moduleName: ModuleName;
  export: string;
  allowTemplateLiteral?: true;
  enableScope?: true;
  rfc931Support?: 'polyfilled';
}

const INLINE_PRECOMPILE_MODULES: ModuleConfig[] = [
  {
    moduleName: 'ember-cli-htmlbars',
    export: 'hbs',
    allowTemplateLiteral: true,
  },
  {
    moduleName: 'ember-cli-htmlbars-inline-precompile',
    export: 'default',
    allowTemplateLiteral: true,
  },
  {
    moduleName: 'htmlbars-inline-precompile',
    export: 'default',
    allowTemplateLiteral: true,
  },
  {
    moduleName: '@ember/template-compilation',
    export: 'precompileTemplate',
    enableScope: true,
  },
  {
    moduleName: '@ember/template-compiler',
    export: 'template',
    enableScope: true,
    rfc931Support: 'polyfilled',
  },
];

export interface Options {
  // The ember-template-compiler.js module that ships within your ember-source
  // version. Mandatory when using targetFormat: 'wire'.
  compiler?: EmberTemplateCompiler;

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
  // compilation.
  transforms?: ExtendedPluginBuilder[];
}

interface WireOpts {
  targetFormat: 'wire';
  compiler: EmberTemplateCompiler;
  outputModuleOverrides: Record<string, Record<string, [string, string]>>;
  enableLegacyModules: LegacyModuleName[];
  transforms: ExtendedPluginBuilder[];
}

interface HbsOpts {
  targetFormat: 'hbs';
  outputModuleOverrides: Record<string, Record<string, [string, string]>>;
  enableLegacyModules: LegacyModuleName[];
  transforms: ExtendedPluginBuilder[];
}

type NormalizedOpts = WireOpts | HbsOpts;

function normalizeOpts(options: Options): NormalizedOpts {
  if ((options.targetFormat ?? 'wire') === 'wire') {
    let { compiler } = options;
    if (!compiler) {
      throw new Error(
        `when targetFormat==="wire" you must set the compiler or compilerPath option`
      );
    }
    return {
      outputModuleOverrides: {},
      enableLegacyModules: [],
      transforms: [],
      ...options,
      targetFormat: 'wire',
      compiler,
    };
  } else {
    return {
      outputModuleOverrides: {},
      enableLegacyModules: [],
      transforms: [],
      ...options,
      targetFormat: 'hbs',
    };
  }
}

interface State<EnvSpecificOptions> {
  opts: EnvSpecificOptions;
  normalizedOpts: NormalizedOpts;
  util: ImportUtil;
  templateFactory: { moduleName: string; exportName: string };
  program: NodePath<t.Program>;
  lastInsertedPath: NodePath<t.Statement> | undefined;
  filename: string;
  recursionGuard: Set<unknown>;
}

export function makePlugin<EnvSpecificOptions>(loadOptions: (opts: EnvSpecificOptions) => Options) {
  return function htmlbarsInlinePrecompile(
    babel: typeof Babel
  ): Babel.PluginObj<State<EnvSpecificOptions>> {
    let t = babel.types;

    const plugin = {
      visitor: {
        Program: {
          enter(path: NodePath<t.Program>, state: State<EnvSpecificOptions>) {
            state.normalizedOpts = normalizeOpts(loadOptions(state.opts));
            state.templateFactory = templateFactoryConfig(state.normalizedOpts);
            state.util = new ImportUtil(t, path);
            state.program = path;
            state.recursionGuard = new Set();
          },
          exit(_path: NodePath<t.Program>, state: State<EnvSpecificOptions>) {
            if (state.normalizedOpts.targetFormat === 'wire') {
              for (let { moduleName, export: exportName } of configuredModules(state)) {
                state.util.removeImport(moduleName, exportName);
              }
            }
          },
        },

        TaggedTemplateExpression(
          path: NodePath<t.TaggedTemplateExpression>,
          state: State<EnvSpecificOptions>
        ) {
          let tagPath = path.get('tag');

          if (!tagPath.isIdentifier()) {
            return;
          }
          let config = referencesInlineCompiler(tagPath, state);
          if (!config) {
            return;
          }

          if (!config.allowTemplateLiteral) {
            throw path.buildCodeFrameError(
              `Attempted to use \`${tagPath.node.name}\` as a template tag, but it can only be called as a function with a string passed to it: ${tagPath.node.name}('content here')`
            );
          }

          if (path.node.quasi.expressions.length) {
            throw path.buildCodeFrameError(
              'placeholders inside a tagged template string are not supported'
            );
          }

          let template = path.node.quasi.quasis.map((quasi) => quasi.value.cooked).join('');
          if (state.normalizedOpts.targetFormat === 'wire') {
            insertCompiledTemplate(
              babel,
              state,
              state.normalizedOpts,
              template,
              path,
              {},
              config,
              undefined
            );
          } else {
            insertTransformedTemplate(babel, state, template, path, {}, config, undefined);
          }
        },

        CallExpression(path: NodePath<t.CallExpression>, state: State<EnvSpecificOptions>) {
          let calleePath = path.get('callee');

          if (!calleePath.isIdentifier()) {
            return;
          }
          let config = referencesInlineCompiler(calleePath, state);
          if (!config) {
            return;
          }

          if (state.recursionGuard.has(path.node)) {
            return;
          }

          if (path.get('arguments').length > 2) {
            throw path.buildCodeFrameError(
              `${calleePath.node.name} can only be invoked with 2 arguments: the template string and any static options`
            );
          }

          let [firstArg, secondArg] = path.get('arguments');

          let template;

          switch (firstArg?.node.type) {
            case 'StringLiteral':
              template = firstArg.node.value;
              break;
            case 'TemplateLiteral':
              if (firstArg.node.expressions.length) {
                throw path.buildCodeFrameError(
                  'placeholders inside a template string are not supported'
                );
              } else {
                template = firstArg.node.quasis.map((quasi) => quasi.value.cooked).join('');
              }
              break;
            case 'TaggedTemplateExpression':
              throw path.buildCodeFrameError(
                `tagged template strings inside ${calleePath.node.name} are not supported`
              );
            default:
              throw path.buildCodeFrameError(
                `${calleePath.node.name} should be invoked with at least a single argument (the template string)`
              );
          }

          let userTypedOptions: Record<string, unknown>;
          let backingClass: undefined | NodePath<Parameters<typeof t.callExpression>[1][number]>;

          if (!secondArg) {
            userTypedOptions = {};
          } else {
            if (!secondArg.isObjectExpression()) {
              throw path.buildCodeFrameError(
                `${calleePath.node.name} can only be invoked with 2 arguments: the template string, and any static options`
              );
            }

            userTypedOptions = new ExpressionParser(babel).parseObjectExpression(
              calleePath.node.name,
              secondArg,
              config.enableScope ? path : false,
              Boolean(config.rfc931Support)
            );
            if (config.rfc931Support && userTypedOptions.component) {
              backingClass = userTypedOptions.component as NodePath<
                Parameters<typeof t.callExpression>[1][number]
              >;
            }
          }

          if (state.normalizedOpts.targetFormat === 'wire') {
            insertCompiledTemplate(
              babel,
              state,
              state.normalizedOpts,
              template,
              path,
              userTypedOptions,
              config,
              backingClass
            );
          } else {
            insertTransformedTemplate(
              babel,
              state,
              template,
              path,
              userTypedOptions,
              config,
              backingClass
            );
          }
        },
      },
    };

    return {
      pre(this: State<EnvSpecificOptions>, file) {
        // run our processing in pre so that imports for gts
        // are kept for other plugins.
        babel.traverse(file.ast, plugin.visitor, file.scope, this);
      },
      visitor: {},
    };
  } as (babel: typeof Babel) => Babel.PluginObj<unknown>;
}

function* configuredModules<EnvSpecificOptions>(state: State<EnvSpecificOptions>) {
  for (let moduleConfig of INLINE_PRECOMPILE_MODULES) {
    if (
      moduleConfig.moduleName !== '@ember/template-compilation' &&
      moduleConfig.moduleName !== '@ember/template-compiler' &&
      !state.normalizedOpts.enableLegacyModules.includes(moduleConfig.moduleName)
    ) {
      continue;
    }
    yield moduleConfig;
  }
}

function referencesInlineCompiler<EnvSpecificOptions>(
  path: NodePath<t.Identifier>,
  state: State<EnvSpecificOptions>
): ModuleConfig | undefined {
  for (let moduleConfig of configuredModules(state)) {
    if (path.referencesImport(moduleConfig.moduleName, moduleConfig.export)) {
      return moduleConfig;
    }
  }
  return undefined;
}

function runtimeErrorIIFE(babel: typeof Babel, replacements: { ERROR_MESSAGE: string }) {
  let statement = babel.template(`(function() {\n  throw new Error('ERROR_MESSAGE');\n})();`)(
    replacements
  ) as t.ExpressionStatement;
  return statement.expression;
}

function buildScopeLocals(
  userTypedOptions: Record<string, unknown>,
  formatOptions: ModuleConfig,
  target: NodePath<t.Expression>
): ScopeLocals {
  if (formatOptions.rfc931Support && userTypedOptions.eval) {
    return new ScopeLocals(target, 'implicit');
  } else if (userTypedOptions.scope) {
    return userTypedOptions.scope as ScopeLocals;
  } else {
    return new ScopeLocals(target, 'explicit');
  }
}

function buildPrecompileOptions<EnvSpecificOptions>(
  babel: typeof Babel,
  target: NodePath<t.Expression>,
  state: State<EnvSpecificOptions>,
  template: string,
  userTypedOptions: Record<string, unknown>,
  config: ModuleConfig,
  scope: ScopeLocals
): PreprocessOptions & Record<string, unknown> {
  let jsutils = new JSUtils(babel, state, target, scope.add.bind(scope), state.util);
  let meta = Object.assign({ jsutils }, userTypedOptions?.meta);

  let output: PreprocessOptions & Record<string, unknown> = {
    contents: template,

    // we've extended meta to add jsutils, but the types in @glimmer/syntax
    // don't account for extension
    meta: meta as PreprocessOptions['meta'],

    // TODO: embroider's template-compiler allows this to be overriden to get
    // backward-compatible module names that don't match the real name of the
    // on-disk file. What's our plan for migrating people away from that?
    moduleName: state.filename,

    // This is here so it's *always* the real filename. Historically, there is
    // also `moduleName` but that did not match the real on-disk filename, it
    // was the notional runtime module name from classic ember builds.
    filename: state.filename,

    plugins: {
      // the cast is needed here only because our meta is extended. That is,
      // these plugins can access meta.jsutils.
      ast: [...state.normalizedOpts.transforms, scope.crawl()] as ASTPluginBuilder[],
    },
  };

  for (let [key, value] of Object.entries(userTypedOptions)) {
    if (key !== 'scope') {
      // `scope` in the user-facing API becomes `locals` in the low-level
      // ember-template-compiler API
      output[key] = value;
    }
  }

  output.locals = scope.locals;

  if (config.rfc931Support) {
    output.strictMode = true;
  }

  return output;
}

// if scope has different keys and values, this function will remap the keys to the values
// you can see an example of this in the test "correctly handles scope if it contains keys and values"
function remapIdentifiers(ast: Babel.types.File, babel: typeof Babel, scopeLocals: ScopeLocals) {
  if (!scopeLocals.needsRemapping()) {
    // do nothing if all keys are the same as their values
    return;
  }

  babel.traverse(ast, {
    Identifier(path: NodePath<t.Identifier>) {
      if (scopeLocals.has(path.node.name) && path.node.name !== scopeLocals.get(path.node.name)) {
        // replace the path only if the key is different from the value
        path.replaceWith(babel.types.identifier(scopeLocals.get(path.node.name)));
      }
    },
  });
}

function insertCompiledTemplate<EnvSpecificOptions>(
  babel: typeof Babel,
  state: State<EnvSpecificOptions>,
  opts: WireOpts,
  template: string,
  target: NodePath<t.Expression>,
  userTypedOptions: Record<string, unknown>,
  config: ModuleConfig,
  backingClass: NodePath<Parameters<typeof t.callExpression>[1][number]> | undefined
) {
  let t = babel.types;
  let scopeLocals = buildScopeLocals(userTypedOptions, config, target);
  let options = buildPrecompileOptions(
    babel,
    target,
    state,
    template,
    userTypedOptions,
    config,
    scopeLocals
  );

  let precompileResultString: string;

  // insertRuntimeErrors is legacy and not supported by the newer rfc931 form
  if (options.insertRuntimeErrors && !config.rfc931Support) {
    try {
      precompileResultString = opts.compiler.precompile(template, options);
    } catch (error) {
      target.replaceWith(runtimeErrorIIFE(babel, { ERROR_MESSAGE: (error as any).message }));
      return;
    }
  } else {
    precompileResultString = opts.compiler.precompile(template, options);
  }

  let precompileResultAST = babel.parse(`var precompileResult = ${precompileResultString}; `, {
    babelrc: false,
    configFile: false,
  }) as t.File;

  remapIdentifiers(precompileResultAST, babel, scopeLocals);

  let templateExpression = (precompileResultAST.program.body[0] as t.VariableDeclaration)
    .declarations[0].init as t.Expression;

  t.addComment(
    templateExpression,
    'leading',
    `\n  ${template.replace(/\*\//g, '*\\/')}\n`,
    /* line comment? */ false
  );

  let templateFactoryIdentifier = state.util.import(
    target,
    state.templateFactory.moduleName,
    state.templateFactory.exportName
  );

  let expression = t.callExpression(templateFactoryIdentifier, [templateExpression]);

  if (config.rfc931Support) {
    expression = t.callExpression(
      state.util.import(target, '@ember/component', 'setComponentTemplate'),
      [
        expression,
        backingClass?.node ??
          t.callExpression(
            state.util.import(target, '@ember/component/template-only', 'default', 'templateOnly'),
            []
          ),
      ]
    );
  }
  target.replaceWith(expression);
  target.scope.crawl();
}

function insertTransformedTemplate<EnvSpecificOptions>(
  babel: typeof Babel,
  state: State<EnvSpecificOptions>,
  template: string,
  target: NodePath<t.CallExpression> | NodePath<t.TaggedTemplateExpression>,
  userTypedOptions: Record<string, unknown>,
  formatOptions: ModuleConfig,
  backingClass: NodePath<Parameters<typeof t.callExpression>[1][number]> | undefined
) {
  let t = babel.types;
  let scopeLocals = buildScopeLocals(userTypedOptions, formatOptions, target);
  let options = buildPrecompileOptions(
    babel,
    target,
    state,
    template,
    userTypedOptions,
    formatOptions,
    scopeLocals
  );
  let ast = preprocess(template, { ...options, mode: 'codemod' });
  let transformed = print(ast, { entityEncoding: 'raw' });
  if (target.isCallExpression()) {
    (target.get('arguments.0') as NodePath<t.Node>).replaceWith(t.stringLiteral(transformed));
    if (!formatOptions.enableScope) {
      maybePruneImport(state.util, target.get('callee'));
      target.set('callee', precompileTemplate(state.util, target));
    }

    updateScope(babel, target, scopeLocals);

    if (formatOptions.rfc931Support === 'polyfilled') {
      maybePruneImport(state.util, target.get('callee'));
      target.set('callee', precompileTemplate(state.util, target));
      convertStrictMode(babel, target);
      removeEvalAndScope(target);
      target.node.arguments = target.node.arguments.slice(0, 2);
      state.recursionGuard.add(target.node);
      target = target.replaceWith(
        t.callExpression(state.util.import(target, '@ember/component', 'setComponentTemplate'), [
          target.node,
          backingClass?.node ??
            t.callExpression(
              state.util.import(
                target,
                '@ember/component/template-only',
                'default',
                'templateOnly'
              ),
              []
            ),
        ])
      )[0];
    }
    target.scope.crawl();
  } else {
    if (!scopeLocals.isEmpty()) {
      // need to add scope, so need to replace the backticks form with a call
      // expression to precompileTemplate
      maybePruneImport(state.util, target.get('tag'));
      let newCall = target.replaceWith(
        t.callExpression(precompileTemplate(state.util, target), [t.stringLiteral(transformed)])
      )[0];
      updateScope(babel, newCall, scopeLocals);
      newCall.scope.crawl();
    } else {
      (target.get('quasi').get('quasis.0') as NodePath<t.TemplateElement>).replaceWith(
        t.templateElement({ raw: transformed })
      );
    }
  }
}

function templateFactoryConfig(opts: NormalizedOpts) {
  let moduleName = '@ember/template-factory';
  let exportName = 'createTemplateFactory';
  let overrides = opts.outputModuleOverrides[moduleName]?.[exportName];
  return overrides
    ? { exportName: overrides[0], moduleName: overrides[1] }
    : { exportName, moduleName };
}

function buildScope(babel: typeof Babel, locals: ScopeLocals) {
  let t = babel.types;

  return t.arrowFunctionExpression(
    [],
    t.objectExpression(
      locals
        .entries()
        .map(([name, identifier]) =>
          t.objectProperty(t.identifier(name), t.identifier(identifier), false, true)
        )
    )
  );
}
function updateScope(babel: typeof Babel, target: NodePath<t.CallExpression>, locals: ScopeLocals) {
  let t = babel.types;
  let secondArg = target.get('arguments.1') as NodePath<t.ObjectExpression> | undefined;
  if (secondArg) {
    let scope = secondArg.get('properties').find((p) => {
      let key = p.get('key') as NodePath<t.Node>;
      return key.isIdentifier() && key.node.name === 'scope';
    });
    if (scope) {
      scope.set('value', buildScope(babel, locals));
      if (locals.isEmpty()) {
        scope.remove();
      }
    } else if (!locals.isEmpty()) {
      secondArg.pushContainer(
        'properties',
        t.objectProperty(t.identifier('scope'), buildScope(babel, locals))
      );
    }
  } else if (!locals.isEmpty()) {
    target.pushContainer(
      'arguments',
      t.objectExpression([t.objectProperty(t.identifier('scope'), buildScope(babel, locals))])
    );
  }
}

function removeEvalAndScope(target: NodePath<t.CallExpression>) {
  let secondArg = target.get('arguments.1') as NodePath<t.ObjectExpression> | undefined;
  if (secondArg) {
    let evalProp = secondArg.get('properties').find((p) => {
      let key = p.get('key') as NodePath<t.Node>;
      return key.isIdentifier() && key.node.name === 'eval';
    });
    if (evalProp) {
      evalProp.remove();
    }

    let componentProp = secondArg.get('properties').find((p) => {
      let key = p.get('key') as NodePath<t.Node>;
      return key.isIdentifier() && key.node.name === 'component';
    });
    if (componentProp) {
      componentProp.remove();
    }
  }
}

// Given a call to template(), convert its "strict" argument into
// precompileTemplate's "strictMode" argument. They differ in name and default
// value.
function convertStrictMode(babel: typeof Babel, target: NodePath<t.CallExpression>) {
  let t = babel.types;
  let secondArg = target.get('arguments.1') as NodePath<t.ObjectExpression> | undefined;
  if (secondArg) {
    let strict = secondArg.get('properties').find((p) => {
      let key = p.get('key') as NodePath<t.Node>;
      return key.isIdentifier() && key.node.name === 'strict';
    }) as NodePath<t.ObjectProperty>;
    if (strict) {
      strict.set('key', t.identifier('strictMode'));
    } else {
      secondArg.pushContainer(
        'properties',
        t.objectProperty(t.identifier('strictMode'), t.booleanLiteral(true))
      );
    }
  } else {
    target.pushContainer(
      'arguments',
      t.objectExpression([t.objectProperty(t.identifier('strictMode'), t.booleanLiteral(true))])
    );
  }
}

function maybePruneImport(
  util: ImportUtil,
  identifier: NodePath<t.Expression | t.V8IntrinsicIdentifier>
) {
  if (!identifier.isIdentifier()) {
    return;
  }
  let binding = identifier.scope.getBinding(identifier.node.name);
  // this checks if the identifier (that we're about to remove) is used in
  // exactly one place.
  if (
    binding?.referencePaths.reduce((count, path) => (path.removed ? count : count + 1), 0) === 1
  ) {
    let specifier = binding.path;
    if (specifier.isImportSpecifier()) {
      let declaration = specifier.parentPath as NodePath<t.ImportDeclaration>;
      util.removeImport(declaration.node.source.value, name(specifier.node.imported));
    }
  }
  identifier.removed = true;
}

function precompileTemplate(util: ImportUtil, target: NodePath<t.Node>) {
  return util.import(target, '@ember/template-compilation', 'precompileTemplate');
}

function name(node: t.StringLiteral | t.Identifier) {
  if (node.type === 'StringLiteral') {
    return node.value;
  } else {
    return node.name;
  }
}

export default makePlugin<Options>((options) => options);
