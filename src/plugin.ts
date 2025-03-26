import type { NodePath } from '@babel/traverse';
import type * as Babel from '@babel/core';
import type { types as t } from '@babel/core';
import { ImportUtil, type Importer } from 'babel-import-util';
import { ExpressionParser } from './expression-parser.js';
import { JSUtils, ExtendedPluginBuilder } from './js-utils.js';
import type { EmberTemplateCompiler, PreprocessOptions } from './ember-template-compiler.js';
import { LegacyModuleName } from './public-types.js';
import { ScopeLocals } from './scope-locals.js';
import { type ASTPluginBuilder, preprocess, print } from '@glimmer/syntax';

export * from './public-types.js';

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
      throw new Error(`when targetFormat==="wire" you must provide the ember template compiler`);
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
  util: ImportUtil;
  templateFactory: { moduleName: string; exportName: string };
  program: NodePath<t.Program>;
  lastInsertedPath: NodePath<t.Statement> | undefined;
  filename: string;
  recursionGuard: Set<unknown>;
}

export function makePlugin<EnvSpecificOptions>(
  loadOptions: (opts: EnvSpecificOptions) => Promise<Options>
) {
  return async function htmlbarsInlinePrecompile(
    babel: typeof Babel,
    opts: EnvSpecificOptions
  ): Promise<Babel.PluginObj<State<EnvSpecificOptions>>> {
    let t = babel.types;

    let normalizedOpts = normalizeOpts(await loadOptions(opts));

    const plugin = {
      visitor: {
        Program: {
          enter(path: NodePath<t.Program>, state: State<EnvSpecificOptions>) {
            state.templateFactory = templateFactoryConfig(normalizedOpts);
            state.util = new ImportUtil(babel, path);
            state.program = path;
            state.recursionGuard = new Set();
          },
          exit(_path: NodePath<t.Program>, state: State<EnvSpecificOptions>) {
            if (normalizedOpts.targetFormat === 'wire') {
              for (let { moduleName, export: exportName } of configuredModules(normalizedOpts)) {
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
          let config = referencesInlineCompiler(tagPath, normalizedOpts);
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
          if (normalizedOpts.targetFormat === 'wire') {
            insertCompiledTemplate(
              babel,
              state,
              normalizedOpts,
              template,
              path,
              {},
              config,
              undefined
            );
          } else {
            insertTransformedTemplate(
              babel,
              state,
              normalizedOpts,
              template,
              path,
              {},
              config,
              undefined
            );
          }
        },

        CallExpression(path: NodePath<t.CallExpression>, state: State<EnvSpecificOptions>) {
          let calleePath = path.get('callee');

          if (!calleePath.isIdentifier()) {
            return;
          }
          let config = referencesInlineCompiler(calleePath, normalizedOpts);
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
              config.enableScope,
              Boolean(config.rfc931Support)
            );
            if (config.rfc931Support && userTypedOptions.component) {
              backingClass = userTypedOptions.component as NodePath<
                Parameters<typeof t.callExpression>[1][number]
              >;
            }
          }

          if (normalizedOpts.targetFormat === 'wire') {
            insertCompiledTemplate(
              babel,
              state,
              normalizedOpts,
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
              normalizedOpts,
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
  } as (babel: typeof Babel) => Promise<Babel.PluginObj<unknown>>;
}

function* configuredModules(normalizedOpts: NormalizedOpts) {
  for (let moduleConfig of INLINE_PRECOMPILE_MODULES) {
    if (
      moduleConfig.moduleName !== '@ember/template-compilation' &&
      moduleConfig.moduleName !== '@ember/template-compiler' &&
      !normalizedOpts.enableLegacyModules.includes(moduleConfig.moduleName)
    ) {
      continue;
    }
    yield moduleConfig;
  }
}

function referencesInlineCompiler(
  path: NodePath<t.Identifier>,
  normalizedOpts: NormalizedOpts
): ModuleConfig | undefined {
  for (let moduleConfig of configuredModules(normalizedOpts)) {
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
  target: NodePath<t.Expression>,
  mayUseLexicalThis: boolean
): ScopeLocals {
  if (formatOptions.rfc931Support && userTypedOptions.eval) {
    return new ScopeLocals({ mode: 'implicit', jsPath: target, mayUseLexicalThis });
  } else if (userTypedOptions.scope) {
    return userTypedOptions.scope as ScopeLocals;
  } else {
    return new ScopeLocals({ mode: 'explicit' });
  }
}

function buildPrecompileOptions<EnvSpecificOptions>(
  babel: typeof Babel,
  target: NodePath<t.Expression>,
  state: State<EnvSpecificOptions>,
  normalizedOpts: NormalizedOpts,
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
      ast: [...normalizedOpts.transforms, scope.crawl()] as ASTPluginBuilder[],
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

function remapAndBindIdentifiers(target: NodePath, babel: typeof Babel, scopeLocals: ScopeLocals) {
  target.traverse({
    Identifier(path: NodePath<t.Identifier>) {
      if (scopeLocals.has(path.node.name) && path.node.name !== scopeLocals.get(path.node.name)) {
        // this identifier has different names in hbs vs js, so we need to
        // replace the hbs name in the template compiler output with the js
        // name
        path.replaceWith(babel.types.identifier(scopeLocals.get(path.node.name)));
      }
      // this is where we tell babel's scope system about the new reference we
      // just introduced. @babel/plugin-transform-typescript in particular
      // cares a lot about those references being present.
      path.scope.getBinding(path.node.name)?.reference(path);
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
  let scopeLocals = buildScopeLocals(userTypedOptions, config, target, !backingClass);
  let options = buildPrecompileOptions(
    babel,
    target,
    state,
    opts,
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

  let templateExpression = babel.template.expression.ast(precompileResultString);

  t.addComment(
    templateExpression,
    'leading',
    `\n  ${template.replace(/\*\//g, '*\\/')}\n`,
    /* line comment? */ false
  );

  state.util.replaceWith(target, (i) => {
    let templateFactoryIdentifier = i.import(
      state.templateFactory.moduleName,
      state.templateFactory.exportName
    );

    let expression = t.callExpression(templateFactoryIdentifier, [templateExpression]);

    if (config.rfc931Support) {
      expression = t.callExpression(i.import('@ember/component', 'setComponentTemplate'), [
        expression,
        backingClass?.node ??
          t.callExpression(
            i.import('@ember/component/template-only', 'default', 'templateOnly'),
            []
          ),
      ]);
    }
    return expression;
  });

  remapAndBindIdentifiers(target, babel, scopeLocals);
}

function insertTransformedTemplate<EnvSpecificOptions>(
  babel: typeof Babel,
  state: State<EnvSpecificOptions>,
  normalizedOpts: NormalizedOpts,
  template: string,
  target: NodePath<t.CallExpression> | NodePath<t.TaggedTemplateExpression>,
  userTypedOptions: Record<string, unknown>,
  formatOptions: ModuleConfig,
  backingClass: NodePath<Parameters<typeof t.callExpression>[1][number]> | undefined
) {
  let t = babel.types;
  let scopeLocals = buildScopeLocals(userTypedOptions, formatOptions, target, !backingClass);
  let options = buildPrecompileOptions(
    babel,
    target,
    state,
    normalizedOpts,
    template,
    userTypedOptions,
    formatOptions,
    scopeLocals
  );
  let ast = preprocess(template, { ...options, mode: 'codemod' });
  let transformed = print(ast, { entityEncoding: 'raw' });

  if (target.isCallExpression()) {
    updateCallForm<EnvSpecificOptions>(
      target,
      transformed,
      formatOptions,
      scopeLocals,
      state,
      babel,
      backingClass
    );
  } else {
    updateBacktickForm<EnvSpecificOptions>(scopeLocals, state, target, t, transformed, babel);
  }
}

function updateBacktickForm<EnvSpecificOptions>(
  scopeLocals: ScopeLocals,
  state: State<EnvSpecificOptions>,
  target: NodePath<t.TaggedTemplateExpression>,
  t: typeof Babel.types,
  transformed: string,
  babel: typeof Babel
) {
  if (scopeLocals.isEmpty()) {
    // simple case: just replace the string literal part with the transformed
    // template contents
    (target.get('quasi').get('quasis.0') as NodePath<t.TemplateElement>).replaceWith(
      t.templateElement({ raw: transformed })
    );
    return;
  }

  // need to add scope, so need to replace the backticks form with a call
  // expression to precompileTemplate
  maybePruneImport(state.util, target.get('tag'));
  let newCall = state.util.replaceWith(target, (i) =>
    t.callExpression(precompileTemplate(i), [t.stringLiteral(transformed)])
  );
  updateScope(babel, newCall, scopeLocals);
}

function updateCallForm<EnvSpecificOptions>(
  target: NodePath<Babel.types.CallExpression>,
  transformed: string,
  formatOptions: ModuleConfig,
  scopeLocals: ScopeLocals,
  state: State<EnvSpecificOptions>,
  babel: typeof Babel,
  backingClass:
    | NodePath<Babel.types.Expression | Babel.types.ArgumentPlaceholder | Babel.types.SpreadElement>
    | undefined
) {
  // first the simple part: replacing the string literal with the actual body of
  // the rewritten template
  (target.get('arguments.0') as NodePath<t.Node>).replaceWith(
    babel.types.stringLiteral(transformed)
  );

  if (!formatOptions.enableScope && !scopeLocals.isEmpty()) {
    // an AST transform added lexically scoped values to a template that
    // wasn't already in a form that supports them, so convert form.
    maybePruneImport(state.util, target.get('callee'));
    state.util.replaceWith(target.get('callee'), (i) => precompileTemplate(i));
  }

  if (formatOptions.rfc931Support === 'polyfilled') {
    maybePruneImport(state.util, target.get('callee'));
    state.util.replaceWith(target.get('callee'), (i) => precompileTemplate(i));
    convertStrictMode(babel, target);
    removeEvalAndScope(target);
    target.node.arguments = target.node.arguments.slice(0, 2);
    state.recursionGuard.add(target.node);
    state.util.replaceWith(target, (i) =>
      babel.types.callExpression(i.import('@ember/component', 'setComponentTemplate'), [
        target.node,
        backingClass?.node ??
          babel.types.callExpression(
            i.import('@ember/component/template-only', 'default', 'templateOnly'),
            []
          ),
      ])
    );
    // we just wrapped the target callExpression in the call to
    // setComponentTemplate. Adjust `target` back to point at the
    // precompileTemplate call for the final updateScope below.
    //
    target = target.get('arguments.0') as NodePath<t.CallExpression>;
  }
  // We deliberately do updateScope at the end so that when it updates
  // references, those references will point to the accurate paths in the
  // final AST.
  updateScope(babel, target, scopeLocals);
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
          t.objectProperty(t.identifier(name), t.identifier(identifier), false, name !== 'this')
        )
    )
  );
}

// this is responsible both for adjusting the AST for our scope argument *and*
// ensuring that babel's scope system will see that these new identifiers
// reference their bindings. @babel/plugin-transform-typescript in particular
// cares an awful lot about whether an import has valid non-type references, so
// these newly introducd references need to be valid.
function updateScope(babel: typeof Babel, target: NodePath<t.CallExpression>, locals: ScopeLocals) {
  let t = babel.types;
  let secondArg = target.get('arguments.1') as NodePath<t.ObjectExpression> | undefined;
  if (secondArg) {
    let scope = secondArg.get('properties').find((p) => {
      let key = p.get('key') as NodePath<t.Node>;
      return key.isIdentifier() && key.node.name === 'scope';
    });
    if (scope) {
      if (locals.isEmpty()) {
        scope.remove();
      } else {
        scope.set('value', buildScope(babel, locals));
        // funny-looking naming here, but it actually makes sense because we're
        // connecting the glimmer scope system with the babel scope system.
        scope.scope.crawl();
      }
    } else if (!locals.isEmpty()) {
      secondArg.pushContainer(
        'properties',
        t.objectProperty(t.identifier('scope'), buildScope(babel, locals))
      );
      (
        secondArg.get(
          `properties.${secondArg.node.properties.length - 1}`
        ) as NodePath<t.ObjectProperty>
      ).scope.crawl();
    }
  } else if (!locals.isEmpty()) {
    target.pushContainer(
      'arguments',
      t.objectExpression([t.objectProperty(t.identifier('scope'), buildScope(babel, locals))])
    );
    (target.get('arguments.1') as NodePath<t.ObjectExpression>).scope.crawl();
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

  if (!binding) {
    return;
  }

  let found = binding.referencePaths.find((path) => path.node === identifier.node);
  if (!found) {
    return;
  }

  binding.referencePaths.splice(binding.referencePaths.indexOf(found), 1);
  binding.references--;

  if (binding.references === 0) {
    let specifier = binding.path;
    if (specifier.isImportSpecifier()) {
      let declaration = specifier.parentPath as NodePath<t.ImportDeclaration>;
      util.removeImport(declaration.node.source.value, name(specifier.node.imported));
    }
  }
}

function precompileTemplate(i: Importer) {
  return i.import('@ember/template-compilation', 'precompileTemplate');
}

function name(node: t.StringLiteral | t.Identifier) {
  if (node.type === 'StringLiteral') {
    return node.value;
  } else {
    return node.name;
  }
}

export default makePlugin<Options>(async (options) => options);
