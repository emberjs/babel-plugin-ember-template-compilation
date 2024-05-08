import path from 'path';
import * as babel from '@babel/core';
import HTMLBarsInlinePrecompile, { Options } from '..';
import TransformTemplateLiterals from '@babel/plugin-transform-template-literals';
import TransformModules from '@babel/plugin-transform-modules-amd';
import TransformUnicodeEscapes from '@babel/plugin-transform-unicode-escapes';
// @ts-expect-error no upstream types
import TransformTypescript from '@babel/plugin-transform-typescript';
import { stripIndent } from 'common-tags';
import { EmberTemplateCompiler } from '../src/ember-template-compiler';
import sinon from 'sinon';
import { ExtendedPluginBuilder } from '../src/js-utils';
import 'code-equality-assertions/jest';
import { Preprocessor } from 'content-tag';

describe('htmlbars-inline-precompile', function () {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let compiler: EmberTemplateCompiler = { ...require('ember-source/dist/ember-template-compiler') };
  let plugins: ([typeof HTMLBarsInlinePrecompile, Options] | [unknown])[];

  function transform(code: string) {
    let x = babel
      .transform(code, {
        filename: 'foo-bar.js',
        plugins,
      })!
      .code!.trim();
    return x;
  }

  beforeEach(function () {
    plugins = [[HTMLBarsInlinePrecompile, { compiler }]];
  });

  afterEach(function () {
    sinon.restore();
  });

  it('supports compilation that returns a non-JSON.parseable object', function () {
    sinon.replace(compiler, 'precompile', (template) => {
      return `function() { return "${template}"; }`;
    });

    let transpiled = transform(
      "import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('hello');"
    );

    expect(transpiled).toEqualCode(`
      import { createTemplateFactory } from "@ember/template-factory";
      var compiled = createTemplateFactory(
      /*
        hello
      */
      function () {
        return "hello";
      });
    `);
  });

  it('supports compilation with templateCompilerPath', function () {
    plugins = [[HTMLBarsInlinePrecompile, { compilerPath: require.resolve('./mock-precompile') }]];

    let transpiled = transform(
      "import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('hello');"
    );

    expect(transpiled).toEqualCode(`
      import { createTemplateFactory } from "@ember/template-factory";
      var compiled = createTemplateFactory(
      /*
        hello
      */
      precompiledFromPath(hello));
    `);
  });

  it('passes options when used as a call expression', function () {
    let source = 'hello';
    let spy = sinon.spy(compiler, 'precompile');

    transform(
      `import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('${source}');`
    );

    expect(spy.firstCall.lastArg).toHaveProperty('contents', source);
  });

  it('uses the user provided isProduction option if present', function () {
    let source = 'hello';
    let spy = sinon.spy(compiler, 'precompile');

    transform(
      `import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('${source}', { isProduction: true });`
    );

    expect(spy.firstCall.lastArg).toHaveProperty('isProduction', true);
  });

  it('allows a template string literal when used as a call expression', function () {
    let source = 'hello';
    let spy = sinon.spy(compiler, 'precompile');

    transform(
      `import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate(\`${source}\`);`
    );

    expect(spy.firstCall.lastArg).toHaveProperty('contents', source);
  });

  it('errors when the template string contains placeholders', function () {
    expect(() =>
      transform(
        "import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate(`string ${value}`)"
      )
    ).toThrow(/placeholders inside a template string are not supported/);
  });

  it('errors when the template string is tagged', function () {
    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          compiler,
          enableLegacyModules: ['htmlbars-inline-precompile'],
        },
      ],
    ];
    expect(() =>
      transform("import hbs from 'htmlbars-inline-precompile';\nvar compiled = hbs(hbs`string`)")
    ).toThrow(/tagged template strings inside hbs are not supported/);
  });

  it('allows static userland options when used as a call expression', function () {
    let source = 'hello';
    let spy = sinon.spy(compiler, 'precompile');

    transform(
      `import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('${source}', { parseOptions: { srcName: 'bar.hbs' }, moduleName: 'foo/bar.hbs', xyz: 123, qux: true, stringifiedThing: ${JSON.stringify(
        { foo: 'baz' }
      )}});`
    );

    expect(spy.firstCall.lastArg).toHaveProperty('parseOptions', { srcName: 'bar.hbs' });
    expect(spy.firstCall.lastArg).toHaveProperty('moduleName', 'foo/bar.hbs');
    expect(spy.firstCall.lastArg).toHaveProperty('xyz', 123);
    expect(spy.firstCall.lastArg).toHaveProperty('qux', true);
    expect(spy.firstCall.lastArg).toHaveProperty('stringifiedThing', { foo: 'baz' });
  });

  it('adds a comment with the original template string', function () {
    sinon.replace(compiler, 'precompile', (template) => {
      return `precompiled("${template}")`;
    });

    let transformed = transform(stripIndent`
      import { precompileTemplate } from '@ember/template-compilation';
      if ('foo') {
        const template = precompileTemplate('hello');
      }
    `);

    expect(transformed).toEqual(stripIndent`
      import { createTemplateFactory } from "@ember/template-factory";
      if ('foo') {
        const template = createTemplateFactory(
        /*
          hello
        */
        precompiled("hello"));
      }
    `);
  });

  it('avoids a build time error when passed `insertRuntimeErrors`', function () {
    sinon.stub(compiler, 'precompile').throws(new Error('NOOOOOOOOOOOOOOOOOOOOOO'));

    let transformed = transform(
      `import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('hello', { insertRuntimeErrors: true });`
    );

    expect(transformed).toEqualCode(`
      var compiled = function () {
        throw new Error("NOOOOOOOOOOOOOOOOOOOOOO");
      }();
    `);
  });

  it('escapes any */ included in the template string', function () {
    plugins = [
      [HTMLBarsInlinePrecompile, { compiler, enableLegacyModules: ['htmlbars-inline-precompile'] }],
    ];

    sinon.replace(compiler, 'precompile', (template) => {
      return `precompiled("${template}")`;
    });

    let transformed = transform(stripIndent`
      import hbs from 'htmlbars-inline-precompile';
      if ('foo') {
        const template = hbs\`hello */\`;
      }
    `);

    expect(transformed).toEqualCode(`
      import { createTemplateFactory } from "@ember/template-factory";

      if ('foo') {
        const template = createTemplateFactory(
        /*
          hello *\\/
        */
        precompiled("hello */"));
      }
    `);
  });

  it('passes options when used as a tagged template string', function () {
    plugins = [
      [HTMLBarsInlinePrecompile, { compiler, enableLegacyModules: ['htmlbars-inline-precompile'] }],
    ];

    let source = 'hello';
    let spy = sinon.spy(compiler, 'precompile');

    transform(`import hbs from 'htmlbars-inline-precompile';\nvar compiled = hbs\`${source}\`;`);

    expect(spy.firstCall.lastArg).toHaveProperty('contents', source);
  });

  it("strips import statement for '@ember/template-precompilation' module", function () {
    let transformed = transform(
      "import { precompileTemplate } from '@ember/template-compilation';\nimport Ember from 'ember';"
    );

    // strips import statement
    expect(transformed).toEqual("import Ember from 'ember';");
  });

  it('replaces tagged template expressions with precompiled version', function () {
    sinon.replace(compiler, 'precompile', (template) => {
      return `precompiled("${template}")`;
    });

    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          compiler,
          enableLegacyModules: ['htmlbars-inline-precompile'],
        },
      ],
    ];
    let transformed = transform(
      "import hbs from 'htmlbars-inline-precompile';\nvar compiled = hbs`hello`;"
    );

    expect(transformed).toEqualCode(`
      import { createTemplateFactory } from "@ember/template-factory";
      var compiled = createTemplateFactory(
      /*
        hello
      */
      precompiled("hello"));
    `);
  });

  it('replaces tagged template expressions with precompiled version when ember-cli-htmlbars is enabled', function () {
    sinon.replace(compiler, 'precompile', (template) => {
      return `precompiled("${template}")`;
    });

    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          compiler,
          enableLegacyModules: ['ember-cli-htmlbars'],
        },
      ],
    ];

    let transformed = transform(
      "import { hbs as baz } from 'ember-cli-htmlbars';\nvar compiled = baz`hello`;"
    );

    expect(transformed).toEqualCode(`
      import { createTemplateFactory } from "@ember/template-factory";
      var compiled = createTemplateFactory(
      /*
        hello
      */
      precompiled("hello"));
    `);
  });

  it('leaves tagged template expressions alone when ember-cli-htmlbars is disabled', function () {
    let transformed = transform(
      "import { hbs as baz } from 'ember-cli-htmlbars';\nvar compiled = baz`hello`;"
    );

    expect(transformed).toEqualCode(`
      import { hbs as baz } from 'ember-cli-htmlbars';
      var compiled = baz\`hello\`;
    `);
  });

  it('does not cause an error when no import is found', function () {
    expect(() => transform('something("whatever")')).not.toThrow();
    expect(() => transform('something`whatever`')).not.toThrow();
  });

  it('works with multiple imports', function () {
    sinon.replace(compiler, 'precompile', (template) => {
      return `precompiled("${template}")`;
    });

    let transformed = transform(`
      import { precompileTemplate } from '@ember/template-compilation';
      import { precompileTemplate as other } from '@ember/template-compilation';
      let a = precompileTemplate('hello');
      let b = other('hello');
    `);

    expect(transformed).toEqualCode(`
      import { createTemplateFactory } from "@ember/template-factory";
      let a = createTemplateFactory(
      /*
        hello
      */
      precompiled("hello"));
      let b = createTemplateFactory(
      /*
        hello
      */
      precompiled("hello"));
    `);
  });

  it('works with renamed scope', function () {
    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          compiler,

          targetFormat: 'wire',
          enableLegacyModules: [
            'ember-cli-htmlbars',
            'ember-cli-htmlbars-inline-precompile',
            'htmlbars-inline-precompile',
          ],
        },
      ],
    ];

    /**
     * This scenario happens within Babel (somewhere) when
     * import { Setup as Foo } from '...' is done.
     * The import alias is undone, and the aliasing is moved to the usage location.
     *
     * Being wrapped in setComponentTemplate is required, else the scope bag is correct
     * (ie: [Setup]).
     */
    let code = `
      import { Setup } from './foo.js';
      import { precompileTemplate } from '@ember/template-compilation';
      import { setComponentTemplate } from '@ember/component';
      import templateOnly from '@ember/component/template-only';

      export default setComponentTemplate(precompileTemplate("<Foo />", {
        strictMode: true,
        scope: () => ({
          Foo: Setup
        })
      }), templateOnly());
    `;

    let transformed = transform(code);

    /**
     * Have to choose our line because `moduleName` differs per-machine.
     */
    let scope = transformed
      .split('\n')
      .find((line) => line.includes('scope'))
      ?.trim();

    // Not [Foo]
    expect(scope).toEqual('"scope": () => [Setup],');
  });

  it('does not fully remove imports that have other imports', function () {
    let transformed = transform(`
      import { precompileTemplate, compileTemplate } from '@ember/template-compilation';
    `);

    expect(transformed).toEqualCode(
      `import { compileTemplate } from '@ember/template-compilation';`
    );
  });

  it('forbids template literal usage of @ember/template-compilation', function () {
    expect(() => {
      transform(`
        import { precompileTemplate } from '@ember/template-compilation';
        let a = precompileTemplate\`hello\`;
      `);
    }).toThrow(
      /Attempted to use `precompileTemplate` as a template tag, but it can only be called as a function with a string passed to it:/
    );
  });

  it('works properly when used along with modules transform', function () {
    sinon.replace(compiler, 'precompile', (template) => {
      return `precompiled("${template}")`;
    });

    plugins.push([TransformModules]);
    let transformed = transform(
      "import { precompileTemplate } from '@ember/template-compilation';\n" +
        "var compiled1 = precompileTemplate('hello');\n" +
        "var compiled2 = precompileTemplate('goodbye');\n"
    );

    expect(transformed).toEqualCode(`
      define(["@ember/template-factory"], function (_templateFactory) {
        "use strict";

        var compiled1 = (0, _templateFactory.createTemplateFactory)(
        /*
          hello
        */
        precompiled("hello"));
        var compiled2 = (0, _templateFactory.createTemplateFactory)(
        /*
          goodbye
        */
        precompiled("goodbye"));
      });
    `);
  });

  it('does not error when reusing a preexisting import', function () {
    sinon.replace(compiler, 'precompile', (template) => {
      return `precompiled("${template}")`;
    });

    let transformed = transform(`
      import { createTemplateFactory } from '@ember/template-factory';
      import { precompileTemplate } from '@ember/template-compilation';
      precompileTemplate('hello');
      createTemplateFactory('whatever here');
    `);

    expect(transformed).toEqualCode(`
      import { createTemplateFactory } from '@ember/template-factory';
      createTemplateFactory(
      /*
        hello
      */
      precompiled("hello"));
      createTemplateFactory('whatever here');
    `);
  });

  it('works properly when used after modules transform', function () {
    sinon.replace(compiler, 'precompile', (template) => {
      return `precompiled("${template}")`;
    });

    plugins.unshift([TransformModules]);
    let transformed = transform(
      "import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('hello');"
    );

    expect(transformed).toEqualCode(`
      define(["@ember/template-factory"], function (_templateFactory) {
        "use strict";

        var compiled = (0, _templateFactory.createTemplateFactory)(
        /*
          hello
        */
        precompiled("hello"));
      });
    `);
  });

  it('works properly when used along with @babel/plugin-transform-unicode-escapes', function () {
    sinon.replace(compiler, 'precompile', (template) => {
      return `precompiled("${template}")`;
    });

    plugins.push([TransformUnicodeEscapes]);
    let transformed = transform(
      "import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('some emoji goes 💥');"
    );

    expect(transformed).toEqualCode(`
      import { createTemplateFactory } from "@ember/template-factory";
      var compiled = createTemplateFactory(
      /*
        some emoji goes 💥
      */
      precompiled("some emoji goes 💥"));
    `);
  });

  it('replaces tagged template expressions when before babel-plugin-transform-es2015-template-literals', function () {
    sinon.replace(compiler, 'precompile', (template) => {
      return `precompiled("${template}")`;
    });

    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          compiler,
          enableLegacyModules: ['htmlbars-inline-precompile'],
        },
      ],
      [TransformTemplateLiterals],
    ];

    let transformed = transform(
      "import hbs from 'htmlbars-inline-precompile';\nvar compiled = hbs`hello`;"
    );

    expect(transformed).toEqualCode(`
      import { createTemplateFactory } from "@ember/template-factory";
      var compiled = createTemplateFactory(
      /*
        hello
      */
      precompiled("hello"));
    `);
  });

  it("doesn't replace unrelated tagged template strings", function () {
    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          compiler,
          enableLegacyModules: ['htmlbars-inline-precompile'],
        },
      ],
    ];
    let transformed = transform(
      'import hbs from "htmlbars-inline-precompile";\nvar compiled = anotherTag`hello`;'
    );

    // other tagged template strings are not touched
    expect(transformed).toEqual('var compiled = anotherTag`hello`;');
  });

  it('throws when the tagged template string contains placeholders', function () {
    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          compiler,
          enableLegacyModules: ['htmlbars-inline-precompile'],
        },
      ],
    ];
    expect(() =>
      transform(
        "import hbs from 'htmlbars-inline-precompile';\nvar compiled = hbs`string ${value}`"
      )
    ).toThrow(/placeholders inside a tagged template string are not supported/);
  });

  it('works with glimmer modules', function () {
    sinon.replace(compiler, 'precompile', (template) => {
      return `precompiled("${template}")`;
    });

    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          compiler,
          outputModuleOverrides: {
            '@ember/template-factory': {
              createTemplateFactory: ['createTemplateFactory', '@glimmer/core'],
            },
          },
        },
      ],
    ];

    let transformed = transform(stripIndent`
      import { precompileTemplate } from '@ember/template-compilation';
      const template = precompileTemplate('hello');
    `);

    expect(transformed).toEqualCode(`
      import { createTemplateFactory } from "@glimmer/core";
      const template = createTemplateFactory(
      /*
        hello
      */
      precompiled("hello"));
    `);
  });

  describe('caching', function () {
    it('include `baseDir` function for caching', function () {
      expect(HTMLBarsInlinePrecompile.baseDir()).toEqual(path.resolve(__dirname, '..'));
    });
  });

  it('throws when the second argument is not an object', function () {
    expect(() =>
      transform(
        "import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('first', 'second');"
      )
    ).toThrow(
      /precompileTemplate can only be invoked with 2 arguments: the template string, and any static options/
    );
  });

  it('throws when argument is not a string', function () {
    expect(() =>
      transform(
        "import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate(123);"
      )
    ).toThrow(
      /precompileTemplate should be invoked with at least a single argument \(the template string\)/
    );
  });

  it('throws when no argument is passed', function () {
    expect(() =>
      transform(
        "import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate();"
      )
    ).toThrow(
      /precompileTemplate should be invoked with at least a single argument \(the template string\)/
    );
  });

  let expressionTransform: ExtendedPluginBuilder = (env) => {
    return {
      name: 'expression-transform',
      visitor: {
        PathExpression(node, path) {
          if (node.original === 'onePlusOne') {
            let name = env.meta.jsutils.bindExpression('1+1', path, { nameHint: 'two' });
            return env.syntax.builders.path(name);
          }
          return undefined;
        },
      },
    };
  };

  let importTransform: ExtendedPluginBuilder = (env) => {
    return {
      name: 'import-transform',
      visitor: {
        PathExpression(node, path) {
          if (node.original === 'onePlusOne') {
            let name = env.meta.jsutils.bindImport('my-library', 'default', path, {
              nameHint: 'two',
            });
            return env.syntax.builders.path(name);
          }
          return undefined;
        },
      },
    };
  };

  it('includes the original template content', function () {
    let transformed = transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';

        const template = precompileTemplate('hello {{firstName}}');
      `);

    expect(transformed).toContain(`hello {{firstName}}`);
  });

  it('allows AST transform to bind a JS expression', function () {
    plugins = [
      [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
    ];

    let transformed = transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        const template = precompileTemplate('<Message @text={{onePlusOne}} />');
      `);

    expect(transformed).toEqualCode(`
      import { precompileTemplate } from '@ember/template-compilation';
      let two = 1 + 1;
      const template = precompileTemplate("<Message @text={{two}} />", {
        scope: () => ({
          two
        })
      });
    `);
  });

  it('adds locals to the compiled output', function () {
    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          compiler,
          transforms: [expressionTransform],
        },
      ],
    ];

    let transformed = transform(stripIndent`
      import { precompileTemplate } from '@ember/template-compilation';
      const template = precompileTemplate('<Message @text={{onePlusOne}} />');
    `);
    expect(transformed).toContain(`"scope": () => [two]`);
  });

  it('allows AST transform to bind a JS import', function () {
    plugins = [[HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [importTransform] }]];

    let transformed = transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        const template = precompileTemplate('<Message @text={{onePlusOne}} />');
      `);

    expect(transformed).toEqualCode(`
      import { precompileTemplate } from '@ember/template-compilation';
      import two from "my-library";
      const template = precompileTemplate("<Message @text={{two}} />", {
        scope: () => ({
          two
        })
      });
    `);
  });

  it('JS import added by ast transform survives typescript interoperability, in hbs targetFormat', function () {
    plugins = [
      [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [importTransform] }],
      TransformTypescript,
    ];

    let transformed = transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        const template = precompileTemplate('<Message @text={{onePlusOne}} />');
      `);

    expect(transformed).toEqualCode(`
      import { precompileTemplate } from '@ember/template-compilation';
      import two from "my-library";
      const template = precompileTemplate("<Message @text={{two}} />", {
        scope: () => ({
          two
        })
      });
    `);
  });

  it('JS import added by ast transform survives typescript interoperability, in wire targetFormat', function () {
    plugins = [
      [HTMLBarsInlinePrecompile, { targetFormat: 'wire', compiler, transforms: [importTransform] }],
      TransformTypescript,
    ];

    let transformed = transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        const template = precompileTemplate('<Message @text={{onePlusOne}} />');
      `);

    expect(normalizeWireFormat(transformed)).toEqualCode(`
      import two from "my-library";
      import { createTemplateFactory } from "@ember/template-factory";
      const template = createTemplateFactory(
       /*
         <Message @text={{onePlusOne}} />
       */
      {
        id: "<id>",
        block: '[[[8,[39,0],null,[["@text"],[[32,0]]],null]],[],false,["message"]]',
        moduleName: "<moduleName>",
        scope: () => [two],
        isStrictMode: false,
      });
    `);
  });

  it('does not smash existing js binding for import', function () {
    plugins = [[HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [importTransform] }]];

    let transformed = transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        export function inner() {
          let two = 'twice';
          const template = precompileTemplate('<Message @text={{onePlusOne}} />');
        }
      `);

    expect(transformed).toEqualCode(`
      import { precompileTemplate } from '@ember/template-compilation';
      import two0 from "my-library";
      export function inner() {
        let two = 'twice';
        const template = precompileTemplate("<Message @text={{two0}} />", {
          scope: () => ({
            two0
          })
        });
      }
    `);
  });

  it('does not smash existing hbs binding for import', function () {
    plugins = [[HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [importTransform] }]];

    let transformed = transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        export function inner() {
          const template = precompileTemplate('{{#let "twice" as |two|}}<Message @text={{onePlusOne}} />{{/let}}');
        }
      `);

    expect(transformed).toEqualCode(`
      import { precompileTemplate } from '@ember/template-compilation';
      let two0 = two;
      import two from "my-library";
      export function inner() {
        const template = precompileTemplate("{{#let \\"twice\\" as |two|}}<Message @text={{two0}} />{{/let}}", {
          scope: () => ({
            two0
          })
        });
      }
    `);
  });

  it('does not smash existing js binding for expression', function () {
    plugins = [
      [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
    ];

    let transformed = transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        export default function() {
          let two = 'twice';
          const template = precompileTemplate('<Message @text={{onePlusOne}} />');
        }
      `);

    expect(transformed).toEqualCode(`
      import { precompileTemplate } from '@ember/template-compilation';
      let two0 = 1 + 1;
      export default function () {
        let two = 'twice';
        const template = precompileTemplate("<Message @text={{two0}} />", {
          scope: () => ({
            two0
          })
        });
      }
    `);
  });

  it('reuses existing imports when possible', () => {
    plugins = [[HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [importTransform] }]];

    let transformed = transform(stripIndent`
      import { precompileTemplate } from '@ember/template-compilation';
      export default function() {
        const template = precompileTemplate('{{onePlusOne}}{{onePlusOne}}');
      }
    `);

    expect(transformed).toContain(`{{two}}{{two}}`);
    expect(transformed).toContain(`scope: () => ({
      two
    })`);
    expect(transformed).toContain(`import two from "my-library"`);
  });

  it('rebinds existing imports when necessary', () => {
    plugins = [[HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [importTransform] }]];

    let transformed = transform(stripIndent`
      import { precompileTemplate } from '@ember/template-compilation';
      export default function() {
        const template = precompileTemplate('{{onePlusOne}}{{#let "twice" as |two|}}{{onePlusOne}}{{/let}}');
      }
    `);

    //expect(transformed).toContain(`{{two}}{{#let "twice" as |two|}}{{two0}}{{/let}}`);
    expect(transformed).toContain(`{{two}}{{#let \\"twice\\" as |two|}}{{two0}}{{/let}}`);
    expect(transformed).toContain(`scope: () => ({
      two,
      two0
    })`);
    expect(transformed).toContain(`import two from "my-library"`);
    expect(transformed).toContain('let two0 = two');
  });

  it('does not smash own newly-created js binding for expression', function () {
    plugins = [
      [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
    ];

    let transformed = transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        export default function() {
          const template1 = precompileTemplate('<Message @text={{onePlusOne}} />');
          const template2 = precompileTemplate('<Other @text={{onePlusOne}} />');
        }
      `);

    expect(transformed).toEqualCode(`
      import { precompileTemplate } from '@ember/template-compilation';
      let two = 1 + 1;
      let two0 = 1 + 1;
      export default function () {
        const template1 = precompileTemplate("<Message @text={{two}} />", {
          scope: () => ({
            two
          })
        });
        const template2 = precompileTemplate("<Other @text={{two0}} />", {
          scope: () => ({
            two0
          })
        });
      }
    `);
  });

  it('does not smash existing hbs block binding for expression', function () {
    plugins = [
      [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
    ];

    let transformed = transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        export default function() {
          const template = precompileTemplate('{{#let "twice" as |two|}}<Message @text={{onePlusOne}} />{{/let}}');
        }
      `);

    expect(transformed).toEqualCode(`
      import { precompileTemplate } from '@ember/template-compilation';
      let two0 = 1 + 1;
      export default function () {
        const template = precompileTemplate("{{#let \\"twice\\" as |two|}}<Message @text={{two0}} />{{/let}}", {
          scope: () => ({
            two0
          })
        });
      }
    `);
  });

  it('does not smash existing hbs element binding for expression', function () {
    plugins = [
      [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
    ];

    let transformed = transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        export default function() {
          const template = precompileTemplate('<Outer as |two|><Message @text={{onePlusOne}} /></Outer>');
        }
      `);

    expect(transformed).toEqualCode(`
      import { precompileTemplate } from '@ember/template-compilation';
      let two0 = 1 + 1;
      export default function () {
        const template = precompileTemplate("<Outer as |two|><Message @text={{two0}} /></Outer>", {
          scope: () => ({
            two0
          })
        });
      }
    `);
  });

  it('understands that block params are only defined in the body, not the arguments, of an element', function () {
    plugins = [
      [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
    ];

    let transformed = transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        export default function() {
          const template = precompileTemplate('<Message @text={{onePlusOne}} as |two|>{{two}}</Message>');
        }
      `);

    expect(transformed).toEqualCode(`
      import { precompileTemplate } from '@ember/template-compilation';
      let two = 1 + 1;
      export default function () {
        const template = precompileTemplate("<Message @text={{two}} as |two|>{{two}}</Message>", {
          scope: () => ({
            two
          })
        });
      }
    `);
  });

  it('does not smash other previously-bound expressions with new ones', () => {
    plugins = [
      [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
    ];

    let transformed = transform(stripIndent`
      import { precompileTemplate } from '@ember/template-compilation';
      export default function() {
        const template = precompileTemplate('{{onePlusOne}}{{onePlusOne}}');
      }
    `);

    expect(transformed).toContain(`{{two}}{{two0}}`);
    expect(transformed).toContain(`scope: () => ({
      two,
      two0
    })`);
    expect(transformed).toContain(`let two = 1 + 1`);
    expect(transformed).toContain(`let two0 = 1 + 1`);
  });

  it('can bind expressions that need imports', function () {
    let nowTransform: ExtendedPluginBuilder = (env) => {
      return {
        name: 'now-transform',
        visitor: {
          PathExpression(node, path) {
            if (node.original === 'now') {
              let name = env.meta.jsutils.bindExpression(
                (context) => {
                  let identifier = context.import('luxon', 'DateTime');
                  return `${identifier}.now()`;
                },
                path,
                { nameHint: 'current' }
              );
              return env.syntax.builders.path(name);
            }
            return undefined;
          },
        },
      };
    };

    plugins = [[HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [nowTransform] }]];

    let transformed = transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        export default function() {
          const template = precompileTemplate('<Message @when={{now}} />');
        }
      `);

    expect(transformed).toMatch(/let current = DateTime.now()/);
    expect(transformed).toMatch(/import { DateTime } from "luxon"/);
    expect(transformed).toContain('when={{current}}');
  });

  it('can emit side-effectful expression that need imports', function () {
    let compatTransform: ExtendedPluginBuilder = (env) => {
      return {
        name: 'compat-transform',
        visitor: {
          ElementNode(node) {
            if (node.tag === 'Thing') {
              env.meta.jsutils.emitExpression((context) => {
                let identifier = context.import('ember-thing', '*', 'thing');
                return `window.define('my-app/components/thing', ${identifier})`;
              });
            }
          },
        },
      };
    };

    plugins = [[HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [compatTransform] }]];

    let transformed = transform(stripIndent`
      import { precompileTemplate } from '@ember/template-compilation';
      export default function() {
        const template = precompileTemplate('<Thing />');
      }
    `);

    expect(transformed).toContain(`import * as thing from "ember-thing"`);
    expect(transformed).toContain(`window.define('my-app/components/thing', thing)`);
  });

  it('prevents inconsistent external manipulation of the locals array', function () {
    let compatTransform: ExtendedPluginBuilder = (env) => {
      return {
        name: 'compat-transform',
        visitor: {
          Template() {
            (env as any).locals.push('NewThing');
          },
        },
      };
    };

    plugins = [[HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [compatTransform] }]];

    expect(() => {
      transform(stripIndent`
      import { precompileTemplate } from '@ember/template-compilation';
      let NewThing = Thing;
      export default function() {
        const template = precompileTemplate('<Thing />');
      }
    `);
    }).toThrow(/The only supported way to manipulate locals is via the jsutils API/);
  });

  it('can emit side-effectful import', function () {
    let compatTransform: ExtendedPluginBuilder = (env) => {
      return {
        name: 'compat-transform',
        visitor: {
          ElementNode(node) {
            if (node.tag === 'Thing') {
              env.meta.jsutils.importForSideEffect('setup-the-things');
            }
          },
        },
      };
    };

    plugins = [[HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [compatTransform] }]];

    let transformed = transform(stripIndent`
      import { precompileTemplate } from '@ember/template-compilation';
      export default function() {
        const template = precompileTemplate('<Thing />');
      }
    `);

    expect(transformed).toContain(`import "setup-the-things"`);
  });

  describe('source-to-source', function () {
    const color: ExtendedPluginBuilder = (env) => {
      return {
        name: 'simple-transform',
        visitor: {
          PathExpression(node) {
            if (node.original === 'red') {
              return env.syntax.builders.string('#ff0000');
            }
            return undefined;
          },
        },
      };
    };

    it('can run an ast transform inside precompileTemplate', function () {
      plugins = [[HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [color] }]];

      let transformed = transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        const template = precompileTemplate('<Message @color={{red}} />');
      `);

      expect(transformed).toEqualCode(`
        import { precompileTemplate } from '@ember/template-compilation';
        const template = precompileTemplate("<Message @color={{\\"#ff0000\\"}} />");
      `);
    });

    it('can run an ast transform inside hbs backticks', function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            compiler,
            targetFormat: 'hbs',
            transforms: [color],
            enableLegacyModules: ['ember-cli-htmlbars'],
          },
        ],
      ];

      let transformed = transform(
        "import { hbs } from 'ember-cli-htmlbars'; const template = hbs`<Message @color={{red}} />`;"
      );

      expect(transformed).toEqualCode(`
        import { hbs } from 'ember-cli-htmlbars';
        const template = hbs\`<Message @color={{"#ff0000"}} />\`;
      `);
    });

    it('can run an ast transform inside hbs call', function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            compiler,
            targetFormat: 'hbs',
            transforms: [color],
            enableLegacyModules: ['ember-cli-htmlbars'],
          },
        ],
      ];

      let transformed = transform(`
        import { hbs } from 'ember-cli-htmlbars'; 
        const template = hbs('<Message @color={{red}} />');
      `);

      expect(transformed).toEqualCode(`
        import { hbs } from 'ember-cli-htmlbars';
        const template = hbs('<Message @color={{"#ff0000"}} />');
      `);
    });

    it('can create the options object for precompileTemplate', function () {
      plugins = [
        [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
      ];

      let transformed = transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        const template = precompileTemplate('<Message @text={{onePlusOne}} />');
      `);

      expect(transformed).toEqualCode(`
        import { precompileTemplate } from '@ember/template-compilation';
        let two = 1 + 1;
        const template = precompileTemplate("<Message @text={{two}} />", {
          scope: () => ({
            two
          })
        });
      `);
    });

    it('adds scope to existing options object', function () {
      plugins = [
        [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
      ];

      let transformed = transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        import Message from 'message';
        const template = precompileTemplate('<Message @text={{onePlusOne}} />', {
          moduleName: 'customModuleName'
        });
      `);

      expect(transformed).toEqualCode(`
        import { precompileTemplate } from '@ember/template-compilation';
        import Message from 'message';
        let two = 1 + 1;
        const template = precompileTemplate("<Message @text={{two}} />", {
          moduleName: 'customModuleName',
          scope: () => ({
            two
          })
        });
      `);
    });

    it('adds new locals to preexisting scope', function () {
      plugins = [
        [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
      ];

      let transformed = transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        import Message from 'message';
        const template = precompileTemplate('<Message @text={{onePlusOne}} />', {
          scope: () => ({
            Message
          })
        });
      `);

      expect(transformed).toEqualCode(`
        import { precompileTemplate } from '@ember/template-compilation';
        import Message from 'message';
        let two = 1 + 1;
        const template = precompileTemplate("<Message @text={{two}} />", {
          scope: () => ({
            Message,
            two
          })
        });
      `);
    });

    it('adds new locals to preexisting renamed scope', function () {
      plugins = [
        [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
      ];

      let transformed = transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        import Message$ from 'message';
        import Label from 'label';
        const template = precompileTemplate('<Label /><Message @text={{onePlusOne}} />', {
          scope: () => ({
            Label,
            Message: Message$
          })
        });
      `);

      expect(transformed).toEqualCode(`
        import { precompileTemplate } from '@ember/template-compilation';
        import Message$ from 'message';
        import Label from 'label';
        let two = 1 + 1;
        const template = precompileTemplate("<Label /><Message @text={{two}} />", {
          scope: () => ({
            Label,
            Message: Message$,
            two
          })
        });
      `);
    });

    it('switches from legacy callExpressions to precompileTemplate when needed to support scope', function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            compiler,
            targetFormat: 'hbs',
            transforms: [expressionTransform],
            enableLegacyModules: ['ember-cli-htmlbars'],
          },
        ],
      ];

      let transformed = transform(stripIndent`
        import { hbs } from 'ember-cli-htmlbars';
        const template = hbs('<Message @text={{onePlusOne}} />');
      `);

      expect(transformed).toEqualCode(`
        import { precompileTemplate } from "@ember/template-compilation";
        let two = 1 + 1;
        const template = precompileTemplate("<Message @text={{two}} />", {
          scope: () => ({
            two
          })
        });
      `);
    });

    it('switches from hbs backticks to precompileTemplate when needed to support scope', function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            compiler,
            targetFormat: 'hbs',
            transforms: [expressionTransform],
            enableLegacyModules: ['ember-cli-htmlbars'],
          },
        ],
      ];

      let transformed = transform(
        "import { hbs } from 'ember-cli-htmlbars'; const template = hbs`<Message @text={{onePlusOne}} />`;"
      );

      expect(transformed).toEqualCode(`
        import { precompileTemplate } from "@ember/template-compilation";
        let two = 1 + 1;
        const template = precompileTemplate("<Message @text={{two}} />", {
          scope: () => ({
            two
          })
        });
      `);
    });

    it('does not remove original import if there are still callsites using it', function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
            transforms: [expressionTransform],
            enableLegacyModules: ['ember-cli-htmlbars'],
          },
        ],
      ];

      let transformed = transform(
        "import { hbs } from 'ember-cli-htmlbars'; const template = hbs`<Message @text={{onePlusOne}} />`; const other = hbs`hello`;"
      );

      expect(transformed).toEqualCode(`
        import { hbs } from 'ember-cli-htmlbars';
        import { precompileTemplate } from "@ember/template-compilation";
        let two = 1 + 1;
        const template = precompileTemplate("<Message @text={{two}} />", {
          scope: () => ({
            two
          })
        });
        const other = hbs\`hello\`;
      `);
    });

    it('leaves html entities unchanged when there are no transforms', function () {
      plugins = [[HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [] }]];

      let transformed = transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        const template = precompileTemplate('&times;');
      `);

      expect(transformed).toEqualCode(`
        import { precompileTemplate } from '@ember/template-compilation';
        const template = precompileTemplate('&times;');
      `);
    });

    it('emits setComponentTemplate and templateOnlyComponent when polyfilling rfc931 in hbs format', function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
            transforms: [color],
          },
        ],
      ];

      let transformed = transform(
        `import { template } from '@ember/template-compiler'; 
         import HelloWorld from 'somewhere';
         export default template('<HelloWorld @color={{red}} />', { scope: () => ({ HelloWorld }) });`
      );

      expect(transformed).toEqualCode(`
        import HelloWorld from "somewhere";
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        import templateOnly from "@ember/component/template-only";
        export default setComponentTemplate(precompileTemplate('<HelloWorld @color={{"#ff0000"}} />', { scope: () => ({ HelloWorld }), strictMode: true }), templateOnly());
      `);
    });

    it('emits setComponentTemplate when polyfilling rfc931 with hbs target', function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
            transforms: [color],
          },
        ],
      ];

      let transformed = transform(
        `
         import { template } from '@ember/template-compiler'; 
         import HelloWorld from 'somewhere';
         export default class MyComponent {
           static {
             template('<HelloWorld @color={{red}} />', { component: this, scope: () => ({ HelloWorld }) });
           }
         }
        `
      );

      expect(transformed).toEqualCode(`
        import HelloWorld from "somewhere";
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        export default class MyComponent {
          static {
            setComponentTemplate(
              precompileTemplate('<HelloWorld @color={{"#ff0000"}} />', { scope: () => ({ HelloWorld }), strictMode: true }), 
              this
            );
          }
        }
      `);
    });

    it('emits setComponentTemplate outside a class when polyfilling rfc931 with hbs target', function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
            transforms: [color],
          },
        ],
      ];

      let transformed = transform(
        `
         import { template } from '@ember/template-compiler'; 
         import HelloWorld from 'somewhere';
         export default class MyComponent {      
         }
         template('<HelloWorld @color={{red}} />', { component: MyComponent, scope: () => ({ HelloWorld }) });
        `
      );

      expect(transformed).toEqualCode(`
        import HelloWorld from "somewhere";
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        export default class MyComponent {
        }
        setComponentTemplate(
          precompileTemplate('<HelloWorld @color={{"#ff0000"}} />', { scope: () => ({ HelloWorld }), strictMode: true }), 
          MyComponent
        );
      `);
    });

    it('cleans up leftover imports when there is more than one template', function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
          },
        ],
      ];
      let code = `
        import { template } from "@ember/template-compiler";
        import Component from '@glimmer/component';
        export default class Test extends Component {
            foo = 1;
            static{
                template("<Icon />", {
                    component: this,
                    eval () {
                        return eval(arguments[0]);
                    }
                });
            }
        }
        const Icon = template("Icon", {
            eval () {
                return eval(arguments[0]);
            }
        });
      `;

      let transformed = transform(code);

      expect(transformed).toEqualCode(`
        import Component from "@glimmer/component";
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        import templateOnly from "@ember/component/template-only";
        export default class Test extends Component {
          foo = 1;
          static {
            setComponentTemplate(
              precompileTemplate("<Icon />", {
                strictMode: true,
                scope: () => ({
                  Icon,
                }),
              }),
              this
            );
          }
        }
        const Icon = setComponentTemplate(
          precompileTemplate("Icon", {
            strictMode: true,
          }),
          templateOnly()
        );
      `);
    });

    it("respects user's strict option on template()", function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
            transforms: [],
          },
        ],
      ];

      let transformed = transform(
        `import { template } from '@ember/template-compiler'; 
         import HelloWorld from 'somewhere';
         export default template('<HelloWorld />', { strict: false, scope: () => ({ HelloWorld }) });`
      );

      expect(transformed).toEqualCode(`
        import HelloWorld from "somewhere";
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        import templateOnly from "@ember/component/template-only";
        export default setComponentTemplate(precompileTemplate('<HelloWorld />', { strictMode: false, scope: () => ({ HelloWorld }) }), templateOnly());
      `);
    });
  });

  it('removes original import when there are multiple callsites that all needed replacement', function () {
    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          targetFormat: 'hbs',
          transforms: [expressionTransform],
          enableLegacyModules: ['ember-cli-htmlbars'],
        },
      ],
    ];

    let transformed = transform(
      "import { hbs } from 'ember-cli-htmlbars'; const template = hbs`<Message @text={{onePlusOne}} />`; const other = hbs`{{onePlusOne}}`;"
    );

    expect(transformed).toEqualCode(`
      import { precompileTemplate } from "@ember/template-compilation";
      let two = 1 + 1;
      let two0 = 1 + 1;
      const template = precompileTemplate("<Message @text={{two}} />", {
        scope: () => ({
          two
        })
      });
      const other = precompileTemplate("{{two0}}", {
        scope: () => ({
          two0
        })
      });
    `);
  });

  it('emits setComponentTemplate and templateOnlyComponent when compiling rfc931 to wire format', function () {
    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          compiler,
          targetFormat: 'wire',
          transforms: [],
        },
      ],
    ];

    let transformed = transform(
      `import { template } from '@ember/template-compiler'; 
       import HelloWorld from 'somewhere';
       export default template('<HelloWorld />', { scope: () => ({ HelloWorld }) });`
    );

    expect(normalizeWireFormat(transformed)).toEqualCode(`
      import HelloWorld from "somewhere";
      import { setComponentTemplate } from "@ember/component";
      import { createTemplateFactory } from "@ember/template-factory";
      import templateOnly from "@ember/component/template-only";
      export default setComponentTemplate(createTemplateFactory(
        /*
          <HelloWorld />
      */
        {
          id: "<id>",
          block: "[[[8,[32,0],null,null,null]],[],false,[]]",
          moduleName: "<moduleName>",
          scope: () => [HelloWorld],
          isStrictMode: true,
        }
      ), templateOnly());    
    `);
  });

  it('emits setComponentTemplate when compiling rfc931 to wire format', function () {
    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          compiler,
          targetFormat: 'wire',
          transforms: [],
        },
      ],
    ];

    let transformed = transform(
      `
       import { template } from '@ember/template-compiler'; 
       import HelloWorld from 'somewhere';
       export default class {
         static {
           template('<HelloWorld />', { component: this, scope: () => ({ HelloWorld }) });
         }
       }
      `
    );

    expect(normalizeWireFormat(transformed)).toEqualCode(`
      import HelloWorld from "somewhere";
      import { setComponentTemplate } from "@ember/component";
      import { createTemplateFactory } from "@ember/template-factory";
      export default class {
        static {
          setComponentTemplate(
            createTemplateFactory(
              /*
                <HelloWorld />
          */
              {
                id: "<id>",
                block: "[[[8,[32,0],null,null,null]],[],false,[]]",
                moduleName: "<moduleName>",
                scope: () => [HelloWorld],
                isStrictMode: true,
              }
            ),
            this
          );
        }
      }
    `);
  });

  describe('scope', function () {
    it('correctly handles scope function (non-block arrow function)', function () {
      let source = '<foo /><bar/>';
      let spy = sinon.spy(compiler, 'precompile');

      transform(
        `import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('${source}', { scope: () => ({ foo, bar }) });`
      );
      expect(spy.firstCall.lastArg).toHaveProperty('locals', ['foo', 'bar']);
    });

    it('correctly handles scope function (block arrow function)', function () {
      let source = '<foo /><bar/>';
      let spy = sinon.spy(compiler, 'precompile');

      transform(
        `import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('${source}', { scope: () => { return { foo, bar }; }});`
      );

      expect(spy.firstCall.lastArg).toHaveProperty('locals', ['foo', 'bar']);
    });

    it('correctly handles scope function (normal function)', function () {
      let source = '<foo /><bar/>';
      let spy = sinon.spy(compiler, 'precompile');

      transform(
        `import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('${source}', { scope: function() { return { foo, bar }; }});`
      );

      expect(spy.firstCall.lastArg).toHaveProperty('locals', ['foo', 'bar']);
    });

    it('correctly handles scope function (object method)', function () {
      let source = '<foo /><bar/>';
      let spy = sinon.spy(compiler, 'precompile');

      transform(
        `import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('${source}', { scope() { return { foo, bar }; }});`
      );
      expect(spy.firstCall.lastArg).toHaveProperty('locals', ['foo', 'bar']);
    });

    it('correctly handles scope function with coverage', function () {
      let source = '<foo /><bar/>';
      let spy = sinon.spy(compiler, 'precompile');

      transform(
        `import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('${source}', { scope() { ++cov_2rkfh72wo; return { foo, bar }; }});`
      );
      expect(spy.firstCall.lastArg).toHaveProperty('locals', ['foo', 'bar']);
    });

    it('correctly handles scope if it contains keys and values', function () {
      let transformed = transform(`
        import bar from 'bar';
        import MyButton from 'my-button';
        import { precompileTemplate } from '@ember/template-compilation';
        var compiled = precompileTemplate('<Foo /><MyButton />', { scope: () => ({ Foo: bar, MyButton}) });
      `);

      expect(normalizeWireFormat(transformed)).toEqualCode(`
        import bar from "bar";
        import MyButton from 'my-button';
        import { createTemplateFactory } from "@ember/template-factory";
        var compiled = createTemplateFactory(
          /*
            <Foo /><MyButton />
          */
          {
            id: "<id>",
            block: "[[[8,[32,0],null,null,null],[8,[32,1],null,null,null]],[],false,[]]",
            moduleName: "<moduleName>",
            scope: () => [bar, MyButton],
            isStrictMode: false,
          }
        );
      `);
    });

    it('errors if scope is not an object', function () {
      expect(() => {
        transform(
          "import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('hello', { scope: () => ['foo', 'bar'] });"
        );
      }).toThrow(
        /Scope objects for `precompileTemplate` must be an object expression containing only references to in-scope values/
      );
    });

    it('errors if scope contains any non-reference values', function () {
      expect(() => {
        transform(
          "import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('hello', { scope: () => ({ foo, bar: 123 }) });"
        );
      }).toThrow(
        /Scope objects for `precompileTemplate` may only contain direct references to in-scope values, e.g. { bar } or { bar: bar }/
      );
    });

    it('correctly removes not used scope', function () {
      let spy = sinon.spy(compiler, 'precompile');
      transform(`
        import { precompileTemplate } from '@ember/template-compilation';
        let foo, bar;
        var compiled = precompileTemplate('<foo /><bar/>', { scope: () => ({ foo, bar, baz }) });
      `);
      expect(spy.firstCall.lastArg).toHaveProperty('locals', ['foo', 'bar']);
    });

    it('does not automagically add to scope when not using implicit-scope-form', function () {
      let spy = sinon.spy(compiler, 'precompile');
      transform(`
        import { precompileTemplate } from '@ember/template-compilation';
        let foo, bar;
        var compiled = precompileTemplate('<foo /><bar/>', { scope: () => ({ bar }) });
      `);
      expect(spy.firstCall.lastArg).toHaveProperty('locals', ['bar']);
    });
  });

  describe('implicit-scope-form', function () {
    it('uses local to satisfy upvar in template, in hbs target', function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            compiler,
            targetFormat: 'hbs',
          },
        ],
      ];

      let transformed = transform(
        `import { template } from '@ember/template-compiler'; 
         import HelloWorld from 'somewhere';
         export default template('<HelloWorld />', { eval: function() { return eval(arguments[0]) } })
        `
      );

      expect(transformed).toEqualCode(`
        import HelloWorld from "somewhere";
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        import templateOnly from "@ember/component/template-only";
        export default setComponentTemplate(precompileTemplate('<HelloWorld />', { strictMode: true, scope: () => ({ HelloWorld }) }), templateOnly());
      `);
    });

    // You might think this would be confusing style, and you'd be correct. But
    // that's what the lint rules are for. When it comes to correctness, we need
    // our scope to behave like real Javascript, and Javascript doesn't care
    // whether you've (for example) capitalized your variable identifier.
    it('shadows html elements with locals', function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            compiler,
            targetFormat: 'hbs',
          },
        ],
      ];

      let transformed = transform(
        `import { template } from '@ember/template-compiler'; 
         let div = 1;
         export default template('<div></div>', { eval: function() { return eval(arguments[0]) } })
        `
      );

      expect(transformed).toEqualCode(`
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        import templateOnly from "@ember/component/template-only";
        let div = 1;
        export default setComponentTemplate(precompileTemplate('<div></div>', { strictMode: true, scope: () => ({ div })}), templateOnly());
      `);
    });

    it('shadows ember keywords with locals', function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            compiler,
            targetFormat: 'hbs',
          },
        ],
      ];

      let transformed = transform(
        `import { template } from '@ember/template-compiler'; 
         let hasBlock = 1;
         export default template('{{hasBlock "thing"}}', { eval: function() { return eval(arguments[0]) } })
        `
      );

      expect(transformed).toEqualCode(`
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        import templateOnly from "@ember/component/template-only";
        let hasBlock = 1;
        export default setComponentTemplate(precompileTemplate('{{hasBlock "thing"}}', { strictMode: true, scope: () => ({ hasBlock }) }), templateOnly());
      `);
    });

    it('leaves ember keywords alone when no local is defined', function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            compiler,
            targetFormat: 'hbs',
          },
        ],
      ];

      let transformed = transform(
        `import { template } from '@ember/template-compiler'; 
         export default template('{{hasBlock "thing"}}', { eval: function() { return eval(arguments[0]) } })
        `
      );

      expect(transformed).toEqualCode(`
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        import templateOnly from "@ember/component/template-only";
        export default setComponentTemplate(precompileTemplate('{{hasBlock "thing"}}', { strictMode: true }), templateOnly());
      `);
    });

    it('uses local to satisfy upvar in template, in wire target', function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            compiler,
            targetFormat: 'wire',
          },
        ],
      ];

      let transformed = transform(
        `import { template } from '@ember/template-compiler'; 
         import HelloWorld from 'somewhere';
         export default template('<HelloWorld />', { eval: function() { return eval(arguments[0]) } })
        `
      );

      expect(normalizeWireFormat(transformed)).toEqualCode(`
        import HelloWorld from "somewhere";
        import { setComponentTemplate } from "@ember/component";
        import { createTemplateFactory } from "@ember/template-factory";
        import templateOnly from "@ember/component/template-only";
        export default setComponentTemplate(
          createTemplateFactory(
            /*
              <HelloWorld />
            */
            {
              id: "<id>",
              block: "[[[8,[32,0],null,null,null]],[],false,[]]",
              moduleName: "<moduleName>",
              scope: () => [HelloWorld],
              isStrictMode: true,
            }
          ),
           templateOnly()
        );
      `);
    });

    it('interoperates correctly with @babel/plugin-transform-typescript when handling locals with hbs target', function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            compiler,
            targetFormat: 'hbs',
          },
        ],
        TransformTypescript,
      ];

      let transformed = transform(
        `import { template } from '@ember/template-compiler'; 
         import HelloWorld from 'somewhere';
         export default template('<HelloWorld />', { eval: function() { return eval(arguments[0]) } })
        `
      );

      expect(transformed).toEqualCode(`
        import HelloWorld from "somewhere";
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        import templateOnly from "@ember/component/template-only";
        export default setComponentTemplate(precompileTemplate('<HelloWorld />', { strictMode: true, scope: () => ({ HelloWorld }) }), templateOnly());
      `);
    });

    it('respects local priority when inter-operating with @babel/plugin-transform-typescript', function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            compiler,
            targetFormat: 'hbs',
          },
        ],
        TransformTypescript,
      ];

      let transformed = transform(
        `import { template } from '@ember/template-compiler'; 
         import HelloWorld from 'somewhere';
         export default function() { 
          let { HelloWorld } = globalThis;
          return template('<HelloWorld />', { eval: function() { return eval(arguments[0]) } })
         }
        `
      );

      expect(transformed).toEqualCode(`
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        import templateOnly from "@ember/component/template-only";
        export default function() {
          let { HelloWorld } = globalThis;
          return setComponentTemplate(precompileTemplate('<HelloWorld />', { strictMode: true, scope: () => ({ HelloWorld })}), templateOnly());
        }
      `);
    });

    it('interoperates correctly with @babel/plugin-transform-typescript when handling locals with wire target', function () {
      let imports: string[] = [];
      let otherPlugin: babel.PluginObj = {
        name: 'other',
        visitor: {
          ImportDeclaration(path) {
            imports.push(path.node.source.value);
          },
        },
      };
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            compiler,
            targetFormat: 'wire',
          },
        ],
        otherPlugin,
        TransformTypescript,
      ];

      let transformed = transform(
        `import { template } from '@ember/template-compiler'; 
         import HelloWorld from 'somewhere';
         export default template('<HelloWorld />', { eval: function() { return eval(arguments[0]) } })
        `
      );

      expect(normalizeWireFormat(transformed)).toEqualCode(`
    import HelloWorld from 'somewhere';
    import { setComponentTemplate } from "@ember/component";
    import { createTemplateFactory } from "@ember/template-factory";
    import templateOnly from "@ember/component/template-only";
    export default setComponentTemplate(
      createTemplateFactory(
        /*
          <HelloWorld />
       */
        {
          id: "<id>",
          block: "[[[8,[32,0],null,null,null]],[],false,[]]",
          moduleName: "<moduleName>",
          scope: () => [HelloWorld],
          isStrictMode: true,
        }
      ),
      templateOnly()
    );
      `);
    });
  });

  describe('content-tag end-to-end', function () {
    it('works for expression form', function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            compiler,
            targetFormat: 'hbs',
          },
        ],
      ];

      let p = new Preprocessor();

      let transformed = transform(
        p.process(
          `import HelloWorld from 'somewhere';
           const MyComponent = <template><HelloWorld /></template>;
          `
        )
      );

      expect(transformed).toEqualCode(`
          import HelloWorld from "somewhere";
          import { precompileTemplate } from "@ember/template-compilation";
          import { setComponentTemplate } from "@ember/component";
          import templateOnly from "@ember/component/template-only";
          const MyComponent = setComponentTemplate(precompileTemplate('<HelloWorld />', { strictMode: true, scope: () => ({ HelloWorld })  }), templateOnly());
        `);
    });

    it('works for class member form', function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            compiler,
            targetFormat: 'hbs',
          },
        ],
      ];

      let p = new Preprocessor();

      let transformed = transform(
        p.process(
          `import HelloWorld from 'somewhere';
           export default class {
             <template><HelloWorld /></template>
           }
          `
        )
      );

      expect(transformed).toEqualCode(`
          import HelloWorld from "somewhere";
          import { precompileTemplate } from "@ember/template-compilation";
          import { setComponentTemplate } from "@ember/component";
          export default class {
            static {
              setComponentTemplate(precompileTemplate('<HelloWorld />', { strictMode: true, scope: () => ({ HelloWorld }) }), this);
            }
          }
        `);
    });

    it('works for class member form with `this` references', function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            compiler,
            targetFormat: 'hbs',
          },
        ],
      ];

      let p = new Preprocessor();

      let transformed = transform(
        p.process(
          `import HelloWorld from 'somewhere';
           export default class {
             h = HelloWorld;
             <template><this.h /></template>
           }
          `
        )
      );

      expect(transformed).toEqualCode(`
          import HelloWorld from "somewhere";
          import { precompileTemplate } from "@ember/template-compilation";
          import { setComponentTemplate } from "@ember/component";
          export default class {
            h = HelloWorld;
            static {
              setComponentTemplate(precompileTemplate('<this.h />', { strictMode: true }), this);
            }
          }
        `);
    });
  });
});

// This takes out parts of ember's wire format that aren't our job and shouldn't
// break our tests if they change.
function normalizeWireFormat(src: string): string {
  return src
    .replace(/"moduleName":\s"[^"]+"/, '"moduleName": "<moduleName>"')
    .replace(/"id":\s"[^"]+"/, '"id": "<id>"');
}
