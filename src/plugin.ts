import type { NodePath } from '@babel/traverse';
import traverse from '@babel/traverse';
import type * as Babel from '@babel/core';
import type { types as t } from '@babel/core';
import { ImportUtil } from 'babel-import-util';
import { ExpressionParser } from './expression-parser';
import { JSUtils, ExtendedPluginBuilder } from './js-utils';
import type { EmberTemplateCompiler, PreprocessOptions } from './ember-template-compiler';
import { LegacyModuleName } from './public-types';

export * from './public-types';

type ModuleName = LegacyModuleName | '@ember/template-compilation';

interface ModuleConfig {
  moduleName: ModuleName;
  export: string;
  allowTemplateLiteral: boolean;
  enableScope: boolean;
}

const INLINE_PRECOMPILE_MODULES: ModuleConfig[] = [
  {
    moduleName: 'ember-cli-htmlbars',
    export: 'hbs',
    allowTemplateLiteral: true,
    enableScope: false,
  },
  {
    moduleName: 'ember-cli-htmlbars-inline-precompile',
    export: 'default',
    allowTemplateLiteral: true,
    enableScope: false,
  },
  {
    moduleName: 'htmlbars-inline-precompile',
    export: 'default',
    allowTemplateLiteral: true,
    enableScope: false,
  },
  {
    moduleName: '@ember/template-compilation',
    export: 'precompileTemplate',
    allowTemplateLiteral: false,
    enableScope: true,
  },
];

export interface Options {
  // The ember-template-compiler.js module that ships within your ember-source version.
  compiler: EmberTemplateCompiler;

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

interface State<EnvSpecificOptions> {
  opts: EnvSpecificOptions;
  normalizedOpts: Required<Options>;
  util: ImportUtil;
  templateFactory: { moduleName: string; exportName: string };
  program: NodePath<t.Program>;
  lastInsertedPath: NodePath<t.Statement> | undefined;
  filename: string;
}

export function makePlugin<EnvSpecificOptions>(loadOptions: (opts: EnvSpecificOptions) => Options) {
  return function htmlbarsInlinePrecompile(
    babel: typeof Babel
  ): Babel.PluginObj<State<EnvSpecificOptions>> {
    let t = babel.types;

    return {
      visitor: {
        Program: {
          enter(path: NodePath<t.Program>, state: State<EnvSpecificOptions>) {
            state.normalizedOpts = {
              targetFormat: 'wire',
              outputModuleOverrides: {},
              enableLegacyModules: [],
              transforms: [],
              ...loadOptions(state.opts),
            };

            state.templateFactory = templateFactoryConfig(state.normalizedOpts);
            state.util = new ImportUtil(t, path);
            state.program = path;
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
          let options = referencesInlineCompiler(tagPath, state);
          if (!options) {
            return;
          }

          if (!options.allowTemplateLiteral) {
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
            insertCompiledTemplate(babel, state, template, path, {});
          } else {
            insertTransformedTemplate(babel, state, template, path, {}, options);
          }
        },

        CallExpression(path: NodePath<t.CallExpression>, state: State<EnvSpecificOptions>) {
          let calleePath = path.get('callee');

          if (!calleePath.isIdentifier()) {
            return;
          }
          let options = referencesInlineCompiler(calleePath, state);
          if (!options) {
            return;
          }

          let [firstArg, secondArg, ...restArgs] = path.get('arguments');

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
              options.enableScope
            );
          }
          if (restArgs.length > 0) {
            throw path.buildCodeFrameError(
              `${calleePath.node.name} can only be invoked with 2 arguments: the template string, and any static options`
            );
          }
          if (state.normalizedOpts.targetFormat === 'wire') {
            insertCompiledTemplate(babel, state, template, path, userTypedOptions);
          } else {
            insertTransformedTemplate(babel, state, template, path, userTypedOptions, options);
          }
        },
      },
    };
  } as (babel: typeof Babel) => Babel.PluginObj<unknown>;
}

function* configuredModules<EnvSpecificOptions>(state: State<EnvSpecificOptions>) {
  for (let moduleConfig of INLINE_PRECOMPILE_MODULES) {
    if (
      moduleConfig.moduleName !== '@ember/template-compilation' &&
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

function buildPrecompileOptions<EnvSpecificOptions>(
  babel: typeof Babel,
  target: NodePath<t.Expression>,
  state: State<EnvSpecificOptions>,
  template: string,
  userTypedOptions: Record<string, unknown>
): PreprocessOptions & Record<string, unknown> {
  if (!userTypedOptions.locals) {
    userTypedOptions.locals = [];
  }
  let jsutils = new JSUtils(babel, state, target, userTypedOptions.locals as string[], state.util);
  let meta = Object.assign({ jsutils }, userTypedOptions?.meta);
  return Object.assign(
    {
      contents: template,
      meta,

      // TODO: embroider's template-compiler allows this to be overriden to get
      // backward-compatible module names that don't match the real name of the
      // on-disk file. What's our plan for migrating people away from that?
      moduleName: state.filename,

      // This is here so it's *always* the real filename. Historically, there is
      // also `moduleName` but that did not match the real on-disk filename, it
      // was the notional runtime module name from classic ember builds.
      filename: state.filename,

      plugins: {
        ast: state.normalizedOpts.transforms,
      },
    },
    userTypedOptions
  );
}

// if scope has different keys and values, this function will remap the keys to the values
// you can see an example of this in the test "correctly handles scope if it contains keys and values"
function remapIdentifiers(ast: Babel.types.File, localsWithNames?: { [key: string]: string }) {
  if (
    !localsWithNames ||
    Object.keys(localsWithNames).length === 0 ||
    Object.keys(localsWithNames).every((key) => key === localsWithNames[key])
  ) {
    // do nothing if all keys are the same as their values
    return;
  }

  let visitor = {
    ObjectProperty(path: NodePath<t.ObjectProperty>) {
      if (
        path.node.key.type === 'StringLiteral' &&
        path.node.key.value === 'scope' &&
        path.node.value.type === 'ArrowFunctionExpression' &&
        path.node.value.body.type === 'ArrayExpression'
      ) {
        for (let element of path.node.value.body.elements) {
          if (element?.type === 'Identifier') {
            const replacement = localsWithNames[element.name];
            if (replacement) {
              element.name = replacement;
            }
          }
        }
      }
    },
  };
  traverse(ast, visitor);
}

function insertCompiledTemplate<EnvSpecificOptions>(
  babel: typeof Babel,
  state: State<EnvSpecificOptions>,
  template: string,
  target: NodePath<t.Expression>,
  userTypedOptions: Record<string, unknown>
) {
  let t = babel.types;
  let options = buildPrecompileOptions(babel, target, state, template, userTypedOptions);

  let precompileResultString: string;

  if (options.insertRuntimeErrors) {
    try {
      precompileResultString = state.normalizedOpts.compiler.precompile(template, options);
    } catch (error) {
      target.replaceWith(runtimeErrorIIFE(babel, { ERROR_MESSAGE: (error as any).message }));
      return;
    }
  } else {
    precompileResultString = state.normalizedOpts.compiler.precompile(template, options);
  }

  let precompileResultAST = babel.parse(`var precompileResult = ${precompileResultString}; `, {
    babelrc: false,
    configFile: false,
  }) as t.File;

  const localsWithNames = <{ [key: string]: string } | undefined>userTypedOptions.localsWithNames;
  remapIdentifiers(precompileResultAST, localsWithNames);

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
  target.replaceWith(t.callExpression(templateFactoryIdentifier, [templateExpression]));
}

function insertTransformedTemplate<EnvSpecificOptions>(
  babel: typeof Babel,
  state: State<EnvSpecificOptions>,
  template: string,
  target: NodePath<t.CallExpression> | NodePath<t.TaggedTemplateExpression>,
  userTypedOptions: Record<string, unknown>,
  formatOptions: ModuleConfig
) {
  let t = babel.types;
  let options = buildPrecompileOptions(babel, target, state, template, userTypedOptions);
  let ast = state.normalizedOpts.compiler._preprocess(template, { ...options, mode: 'codemod' });
  let transformed = state.normalizedOpts.compiler._print(ast);
  if (target.isCallExpression()) {
    (target.get('arguments.0') as NodePath<t.Node>).replaceWith(t.stringLiteral(transformed));
    if (options.locals && options.locals.length > 0) {
      if (!formatOptions.enableScope) {
        maybePruneImport(state.util, target.get('callee'));
        target.set('callee', precompileTemplate(state.util, target));
      }
      updateScope(babel, target, options.locals);
    }
  } else {
    if (options.locals && options.locals.length > 0) {
      // need to add scope, so need to replace the backticks form with a call
      // expression to precompileTemplate
      maybePruneImport(state.util, target.get('tag'));
      let newCall = target.replaceWith(
        t.callExpression(precompileTemplate(state.util, target), [t.stringLiteral(transformed)])
      )[0];
      updateScope(babel, newCall, options.locals);
    } else {
      (target.get('quasi').get('quasis.0') as NodePath<t.TemplateElement>).replaceWith(
        t.templateElement({ raw: transformed })
      );
    }
  }
}

function templateFactoryConfig(opts: Required<Options>) {
  let moduleName = '@ember/template-factory';
  let exportName = 'createTemplateFactory';
  let overrides = opts.outputModuleOverrides[moduleName]?.[exportName];
  return overrides
    ? { exportName: overrides[0], moduleName: overrides[1] }
    : { exportName, moduleName };
}

function buildScope(babel: typeof Babel, locals: string[]) {
  let t = babel.types;
  return t.arrowFunctionExpression(
    [],
    t.objectExpression(
      locals.map((name) => t.objectProperty(t.identifier(name), t.identifier(name), false, true))
    )
  );
}
function updateScope(babel: typeof Babel, target: NodePath<t.CallExpression>, locals: string[]) {
  let t = babel.types;
  let secondArg = target.get('arguments.1') as NodePath<t.ObjectExpression> | undefined;
  if (secondArg) {
    let scope = secondArg.get('properties').find((p) => {
      let key = p.get('key') as NodePath<t.Node>;
      return key.isIdentifier() && key.node.name === 'scope';
    });
    if (scope) {
      scope.set('value', buildScope(babel, locals));
    } else {
      secondArg.pushContainer(
        'properties',
        t.objectProperty(t.identifier('scope'), buildScope(babel, locals))
      );
    }
  } else {
    target.pushContainer(
      'arguments',
      t.objectExpression([t.objectProperty(t.identifier('scope'), buildScope(babel, locals))])
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
