import './raise-on-deprecated-template-compiler.js';
import path from 'path';
import * as babel from '@babel/core';
import HTMLBarsInlinePrecompile, { Options } from '../src/node-main.js';
import TransformTemplateLiterals from '@babel/plugin-transform-template-literals';
import TransformModules from '@babel/plugin-transform-modules-amd';
import TransformUnicodeEscapes from '@babel/plugin-transform-unicode-escapes';
// @ts-expect-error no upstream types
import TransformTypescript from '@babel/plugin-transform-typescript';
import { stripIndent } from 'common-tags';
import { EmberTemplateCompiler } from '../src/ember-template-compiler.js';
import { ExtendedPluginBuilder } from '../src/js-utils.js';
import { Preprocessor } from 'content-tag';
import { ALLOWED_GLOBALS } from '../src/scope-locals.js';
import { fileURLToPath } from 'url';
import { describe, it, beforeEach, afterEach, expect, chai, vi, type Mock } from 'vitest';
import { codeEquality, type CodeEqualityAssertions } from 'code-equality-assertions/chai';

chai.use(codeEquality);

let precompileSpy: Mock;

async function mockTemplateCompiler(importOriginal: () => Promise<EmberTemplateCompiler>) {
  const mod = await importOriginal();
  precompileSpy = vi.spyOn(mod, 'precompile');
  return {
    // the plugin probes for the existence of this, and if we don't stick a key
    // here Vitest injects a failure
    default: null,
    ...mod,
  };
}

vi.mock('ember-source/ember-template-compiler/index.js', mockTemplateCompiler);
vi.mock('ember-source/dist/ember-template-compiler.js', mockTemplateCompiler);

declare module 'vitest' {
  interface Assertion extends CodeEqualityAssertions {}
}

describe('htmlbars-inline-precompile', function () {
  let plugins: ([typeof HTMLBarsInlinePrecompile, Options] | [unknown])[];

  async function transform(code: string) {
    let result = await babel.transformAsync(code, {
      filename: 'foo-bar.js',
      plugins,
    });
    return result!.code!.trim();
  }

  beforeEach(function () {
    plugins = [[HTMLBarsInlinePrecompile, {}]];
  });

  afterEach(function () {
    vi.resetAllMocks();
  });

  it('supports compilation that returns a non-JSON.parseable object', async function () {
    plugins = [
      [
        HTMLBarsInlinePrecompile,
        { compilerPath: fileURLToPath(new URL('./mock-precompile', import.meta.url)) },
      ],
    ];

    let transpiled = await transform(
      "import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('hello');"
    );

    expect(transpiled).equalCode(`
      import { createTemplateFactory } from "@ember/template-factory";
      var compiled = createTemplateFactory(
      /*
        hello
      */
      precompiledFromPath(hello)
    )
    `);
  });

  it('supports compilation with templateCompilerPath', async function () {
    plugins = [
      [
        HTMLBarsInlinePrecompile,
        { compilerPath: fileURLToPath(new URL('./mock-precompile', import.meta.url)) },
      ],
    ];

    let transpiled = await transform(
      "import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('hello');"
    );

    expect(transpiled).equalCode(`
      import { createTemplateFactory } from "@ember/template-factory";
      var compiled = createTemplateFactory(
      /*
        hello
      */
      precompiledFromPath(hello));
    `);
  });

  it('passes options when used as a call expression', async function () {
    let source = 'hello';

    await transform(
      `import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('${source}');`
    );

    expect(precompileSpy.mock.lastCall?.at(-1)).toHaveProperty('contents', source);
  });

  it('uses the user provided isProduction option if present', async function () {
    let source = 'hello';

    await transform(
      `import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('${source}', { isProduction: true });`
    );

    expect(precompileSpy.mock.lastCall?.at(-1)).toHaveProperty('isProduction', true);
  });

  it('allows a template string literal when used as a call expression', async function () {
    let source = 'hello';

    await transform(
      `import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate(\`${source}\`);`
    );

    expect(precompileSpy.mock.lastCall?.at(-1)).toHaveProperty('contents', source);
  });

  it('errors when the template string contains placeholders', async function () {
    await expect(() =>
      transform(
        "import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate(`string ${value}`)"
      )
    ).rejects.toThrow(/placeholders inside a template string are not supported/);
  });

  it('errors when the template string is tagged', async function () {
    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          enableLegacyModules: ['htmlbars-inline-precompile'],
        },
      ],
    ];
    await expect(() =>
      transform("import hbs from 'htmlbars-inline-precompile';\nvar compiled = hbs(hbs`string`)")
    ).rejects.toThrow(/tagged template strings inside hbs are not supported/);
  });

  it('allows static userland options when used as a call expression', async function () {
    let source = 'hello';

    await transform(
      `import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('${source}', { parseOptions: { srcName: 'bar.hbs' }, moduleName: 'foo/bar.hbs', xyz: 123, qux: true, stringifiedThing: ${JSON.stringify(
        { foo: 'baz' }
      )}});`
    );

    let lastArg = precompileSpy.mock.lastCall?.at(-1);
    expect(lastArg).toHaveProperty('parseOptions', { srcName: 'bar.hbs' });
    expect(lastArg).toHaveProperty('moduleName', 'foo/bar.hbs');
    expect(lastArg).toHaveProperty('xyz', 123);
    expect(lastArg).toHaveProperty('qux', true);
    expect(lastArg).toHaveProperty('stringifiedThing', { foo: 'baz' });
  });

  it('avoids a build time error when passed `insertRuntimeErrors`', async function () {
    precompileSpy.mockImplementation(() => {
      throw new Error('NOOOOOOOOOOOOOOOOOOOOOO');
    });

    let transformed = await transform(
      `import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('hello', { insertRuntimeErrors: true });`
    );

    expect(transformed).equalCode(`
      var compiled = function () {
        throw new Error("NOOOOOOOOOOOOOOOOOOOOOO");
      }();
    `);
  });

  it('escapes any */ included in the template string', async function () {
    plugins = [[HTMLBarsInlinePrecompile, { enableLegacyModules: ['htmlbars-inline-precompile'] }]];

    precompileSpy.mockImplementation((template) => {
      return `precompiled("${template}")`;
    });

    let transformed = await transform(stripIndent`
      import hbs from 'htmlbars-inline-precompile';
      if ('foo') {
        const template = hbs\`hello */\`;
      }
    `);

    expect(transformed).equalCode(`
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

  it('passes options when used as a tagged template string', async function () {
    plugins = [[HTMLBarsInlinePrecompile, { enableLegacyModules: ['htmlbars-inline-precompile'] }]];

    let source = 'hello';

    await transform(
      `import hbs from 'htmlbars-inline-precompile';\nvar compiled = hbs\`${source}\`;`
    );

    expect(precompileSpy.mock.lastCall?.at(-1)).toHaveProperty('contents', source);
  });

  it("strips import statement for '@ember/template-precompilation' module", async function () {
    let transformed = await transform(
      "import { precompileTemplate } from '@ember/template-compilation';\nimport Ember from 'ember';"
    );

    // strips import statement
    expect(transformed).toEqual("import Ember from 'ember';");
  });

  it('replaces tagged template expressions with precompiled version', async function () {
    precompileSpy.mockImplementation((template) => {
      return `precompiled("${template}")`;
    });

    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          enableLegacyModules: ['htmlbars-inline-precompile'],
        },
      ],
    ];
    let transformed = await transform(
      "import hbs from 'htmlbars-inline-precompile';\nvar compiled = hbs`hello`;"
    );

    expect(transformed).equalCode(`
      import { createTemplateFactory } from "@ember/template-factory";
      var compiled = createTemplateFactory(
      /*
        hello
      */
      precompiled("hello"));
    `);
  });

  it('replaces tagged template expressions with precompiled version when ember-cli-htmlbars is enabled', async function () {
    precompileSpy.mockImplementation((template) => {
      return `precompiled("${template}")`;
    });

    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          enableLegacyModules: ['ember-cli-htmlbars'],
        },
      ],
    ];

    let transformed = await transform(
      "import { hbs as baz } from 'ember-cli-htmlbars';\nvar compiled = baz`hello`;"
    );

    expect(transformed).equalCode(`
      import { createTemplateFactory } from "@ember/template-factory";
      var compiled = createTemplateFactory(
      /*
        hello
      */
      precompiled("hello"));
    `);
  });

  it('leaves tagged template expressions alone when ember-cli-htmlbars is disabled', async function () {
    let transformed = await transform(
      "import { hbs as baz } from 'ember-cli-htmlbars';\nvar compiled = baz`hello`;"
    );

    expect(transformed).equalCode(`
      import { hbs as baz } from 'ember-cli-htmlbars';
      var compiled = baz\`hello\`;
    `);
  });

  it('does not cause an error when no import is found', async function () {
    await transform('something("whatever")');
    await transform('something`whatever`');
  });

  it('works with multiple imports', async function () {
    precompileSpy.mockImplementation((template) => {
      return `precompiled("${template}")`;
    });

    let transformed = await transform(`
      import { precompileTemplate } from '@ember/template-compilation';
      import { precompileTemplate as other } from '@ember/template-compilation';
      let a = precompileTemplate('hello');
      let b = other('hello');
    `);

    expect(transformed).equalCode(`
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

  it('works with renamed scope', async function () {
    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
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

    let transformed = await transform(code);

    let normalized = normalizeWireFormat(transformed);

    expect(normalized).equalCode(`
      import { Setup } from "./foo.js";
      import { setComponentTemplate } from "@ember/component";
      import templateOnly from "@ember/component/template-only";
      import { createTemplateFactory } from "@ember/template-factory";
      export default setComponentTemplate(
        createTemplateFactory(
          /*
            <Foo />
          */
          {
            id: "<id>",
            block: "[[[8,[32,0],null,null,null]],[],[]]",
            moduleName: "<moduleName>",
            scope: () => [Setup],
            isStrictMode: true,
          }
        ),
        templateOnly()
      );
    `);
  });

  it('does not fully remove imports that have other imports', async function () {
    let transformed = await transform(`
      import { precompileTemplate, compileTemplate } from '@ember/template-compilation';
    `);

    expect(transformed).equalCode(`import { compileTemplate } from '@ember/template-compilation';`);
  });

  it('forbids template literal usage of @ember/template-compilation', async function () {
    await expect(() =>
      transform(`
        import { precompileTemplate } from '@ember/template-compilation';
        let a = precompileTemplate\`hello\`;
      `)
    ).rejects.toThrow(
      /Attempted to use `precompileTemplate` as a template tag, but it can only be called as a function with a string passed to it:/
    );
  });

  it('works properly when used along with modules transform', async function () {
    precompileSpy.mockImplementation((template) => {
      return `precompiled("${template}")`;
    });

    plugins.push([TransformModules]);
    let transformed = await transform(
      "import { precompileTemplate } from '@ember/template-compilation';\n" +
        "var compiled1 = precompileTemplate('hello');\n" +
        "var compiled2 = precompileTemplate('goodbye');\n"
    );

    expect(transformed).equalCode(`
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

  it('does not error when reusing a preexisting import', async function () {
    precompileSpy.mockImplementation((template) => {
      return `precompiled("${template}")`;
    });

    let transformed = await transform(`
      import { createTemplateFactory } from '@ember/template-factory';
      import { precompileTemplate } from '@ember/template-compilation';
      precompileTemplate('hello');
      createTemplateFactory('whatever here');
    `);

    expect(transformed).equalCode(`
      import { createTemplateFactory } from '@ember/template-factory';
      createTemplateFactory(
      /*
        hello
      */
      precompiled("hello"));
      createTemplateFactory('whatever here');
    `);
  });

  it('works properly when used after modules transform', async function () {
    precompileSpy.mockImplementation((template) => {
      return `precompiled("${template}")`;
    });

    plugins.unshift([TransformModules]);
    let transformed = await transform(
      "import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('hello');"
    );

    expect(transformed).equalCode(`
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

  it('works properly when used along with @babel/plugin-transform-unicode-escapes', async function () {
    precompileSpy.mockImplementation((template) => {
      return `precompiled("${template}")`;
    });

    plugins.push([TransformUnicodeEscapes]);
    let transformed = await transform(
      "import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('some emoji goes 💥');"
    );

    expect(transformed).equalCode(`
      import { createTemplateFactory } from "@ember/template-factory";
      var compiled = createTemplateFactory(
      /*
        some emoji goes 💥
      */
      precompiled("some emoji goes 💥"));
    `);
  });

  it('replaces tagged template expressions when before babel-plugin-transform-es2015-template-literals', async function () {
    precompileSpy.mockImplementation((template) => {
      return `precompiled("${template}")`;
    });

    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          enableLegacyModules: ['htmlbars-inline-precompile'],
        },
      ],
      [TransformTemplateLiterals],
    ];

    let transformed = await transform(
      "import hbs from 'htmlbars-inline-precompile';\nvar compiled = hbs`hello`;"
    );

    expect(transformed).equalCode(`
      import { createTemplateFactory } from "@ember/template-factory";
      var compiled = createTemplateFactory(
      /*
        hello
      */
      precompiled("hello"));
    `);
  });

  it("doesn't replace unrelated tagged template strings", async function () {
    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          enableLegacyModules: ['htmlbars-inline-precompile'],
        },
      ],
    ];
    let transformed = await transform(
      'import hbs from "htmlbars-inline-precompile";\nvar compiled = anotherTag`hello`;'
    );

    // other tagged template strings are not touched
    expect(transformed).toEqual('var compiled = anotherTag`hello`;');
  });

  it('throws when the tagged template string contains placeholders', async function () {
    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          enableLegacyModules: ['htmlbars-inline-precompile'],
        },
      ],
    ];
    await expect(() =>
      transform(
        "import hbs from 'htmlbars-inline-precompile';\nvar compiled = hbs`string ${value}`"
      )
    ).rejects.toThrow(/placeholders inside a tagged template string are not supported/);
  });

  it('works with glimmer modules', async function () {
    precompileSpy.mockImplementation((template) => {
      return `precompiled("${template}")`;
    });

    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          outputModuleOverrides: {
            '@ember/template-factory': {
              createTemplateFactory: ['createTemplateFactory', '@glimmer/core'],
            },
          },
        },
      ],
    ];

    let transformed = await transform(stripIndent`
      import { precompileTemplate } from '@ember/template-compilation';
      const template = precompileTemplate('hello');
    `);

    expect(transformed).equalCode(`
      import { createTemplateFactory } from "@glimmer/core";
      const template = createTemplateFactory(
      /*
        hello
      */
      precompiled("hello"));
    `);
  });

  describe('caching', function () {
    it('include `baseDir` function for caching', async function () {
      expect(HTMLBarsInlinePrecompile.baseDir()).toEqual(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
      );
    });
  });

  it('throws when the second argument is not an object', async function () {
    await expect(() =>
      transform(
        "import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('first', 'second');"
      )
    ).rejects.toThrow(
      /precompileTemplate can only be invoked with 2 arguments: the template string, and any static options/
    );
  });

  it('throws when argument is not a string', async function () {
    await expect(() =>
      transform(
        "import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate(123);"
      )
    ).rejects.toThrow(
      /precompileTemplate should be invoked with at least a single argument \(the template string\)/
    );
  });

  it('throws when no argument is passed', async function () {
    await expect(() =>
      transform(
        "import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate();"
      )
    ).rejects.toThrow(
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

  it('includes the original template content', async function () {
    let transformed = await transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';

        const template = precompileTemplate('hello {{firstName}}');
      `);

    expect(transformed).toContain(`hello {{firstName}}`);
  });

  it('allows AST transform to bind a JS expression', async function () {
    plugins = [
      [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
    ];

    let transformed = await transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        const template = precompileTemplate('<Message @text={{onePlusOne}} />');
      `);

    expect(transformed).equalCode(`
      import { precompileTemplate } from '@ember/template-compilation';
      let two = 1 + 1;
      const template = precompileTemplate("<Message @text={{two}} />", {
        scope: () => ({
          two
        })
      });
    `);
  });

  it('can load a transform from an absolute path', async function () {
    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          targetFormat: 'hbs',
          transforms: [fileURLToPath(new URL('./mock-transform', import.meta.url))],
        },
      ],
    ];

    let transformed = await transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        const template = precompileTemplate('<Message @text={{onePlusOne}} />');
      `);

    expect(transformed).equalCode(`
      import { precompileTemplate } from '@ember/template-compilation';
      let two = 1 + 1;
      const template = precompileTemplate("<Message @text={{two}} />", {
        scope: () => ({
          two
        })
      });
    `);
  });

  it('adds locals to the compiled output', async function () {
    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          transforms: [expressionTransform],
        },
      ],
    ];

    let transformed = await transform(stripIndent`
      import { precompileTemplate } from '@ember/template-compilation';
      const template = precompileTemplate('<Message @text={{onePlusOne}} />');
    `);
    expect(transformed).toContain(`"scope": () => [two]`);
  });

  it('allows AST transform to bind a JS import', async function () {
    plugins = [[HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [importTransform] }]];

    let transformed = await transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        const template = precompileTemplate('<Message @text={{onePlusOne}} />');
      `);

    expect(transformed).equalCode(`
      import { precompileTemplate } from '@ember/template-compilation';
      import two from "my-library";
      const template = precompileTemplate("<Message @text={{two}} />", {
        scope: () => ({
          two
        })
      });
    `);
  });

  it('JS import added by ast transform survives typescript interoperability, in hbs targetFormat', async function () {
    plugins = [
      [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [importTransform] }],
      TransformTypescript,
    ];

    let transformed = await transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        const template = precompileTemplate('<Message @text={{onePlusOne}} />');
      `);

    expect(transformed).equalCode(`
      import { precompileTemplate } from '@ember/template-compilation';
      import two from "my-library";
      const template = precompileTemplate("<Message @text={{two}} />", {
        scope: () => ({
          two
        })
      });
    `);
  });

  it('JS import added by ast transform survives typescript interoperability, in wire targetFormat', async function () {
    plugins = [
      [HTMLBarsInlinePrecompile, { targetFormat: 'wire', transforms: [importTransform] }],
      TransformTypescript,
    ];

    let transformed = await transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        const template = precompileTemplate('<Message @text={{onePlusOne}} />');
      `);

    expect(normalizeWireFormat(transformed)).equalCode(`
      import two from "my-library";
      import { createTemplateFactory } from "@ember/template-factory";
      const template = createTemplateFactory(
       /*
         <Message @text={{onePlusOne}} />
       */
      {
        id: "<id>",
        block: '[[[8,[39,0],null,[["@text"],[[32,0]]],null]],[],["message"]]',
        moduleName: "<moduleName>",
        scope: () => [two],
        isStrictMode: false,
      });
    `);
  });

  it('does not smash existing js binding for import', async function () {
    plugins = [[HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [importTransform] }]];

    let transformed = await transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        export function inner() {
          let two = 'twice';
          const template = precompileTemplate('<Message @text={{onePlusOne}} />');
        }
      `);

    expect(transformed).equalCode(`
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

  it('does not smash existing hbs binding for import', async function () {
    plugins = [[HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [importTransform] }]];

    let transformed = await transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        export function inner() {
          const template = precompileTemplate('{{#let "twice" as |two|}}<Message @text={{onePlusOne}} />{{/let}}');
        }
      `);

    expect(transformed).equalCode(`
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

  it('does not smash existing js binding for expression', async function () {
    plugins = [
      [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
    ];

    let transformed = await transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        export default function() {
          let two = 'twice';
          const template = precompileTemplate('<Message @text={{onePlusOne}} />');
        }
      `);

    expect(transformed).equalCode(`
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

  it('reuses existing imports when possible', async () => {
    plugins = [[HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [importTransform] }]];

    let transformed = await transform(stripIndent`
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

  it('rebinds existing imports when necessary', async () => {
    plugins = [[HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [importTransform] }]];

    let transformed = await transform(stripIndent`
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

  it('does not smash own newly-created js binding for expression', async function () {
    plugins = [
      [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
    ];

    let transformed = await transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        export default function() {
          const template1 = precompileTemplate('<Message @text={{onePlusOne}} />');
          const template2 = precompileTemplate('<Other @text={{onePlusOne}} />');
        }
      `);

    expect(transformed).equalCode(`
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

  it('does not smash existing hbs block binding for expression', async function () {
    plugins = [
      [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
    ];

    let transformed = await transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        export default function() {
          const template = precompileTemplate('{{#let "twice" as |two|}}<Message @text={{onePlusOne}} />{{/let}}');
        }
      `);

    expect(transformed).equalCode(`
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

  it('does not smash existing hbs element binding for expression', async function () {
    plugins = [
      [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
    ];

    let transformed = await transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        export default function() {
          const template = precompileTemplate('<Outer as |two|><Message @text={{onePlusOne}} /></Outer>');
        }
      `);

    expect(transformed).equalCode(`
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

  it('understands that block params are only defined in the body, not the arguments, of an element', async function () {
    plugins = [
      [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
    ];

    let transformed = await transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        export default function() {
          const template = precompileTemplate('<Message @text={{onePlusOne}} as |two|>{{two}}</Message>');
        }
      `);

    expect(transformed).equalCode(`
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

  it('does not smash other previously-bound expressions with new ones', async () => {
    plugins = [
      [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
    ];

    let transformed = await transform(stripIndent`
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

  it('can bind expressions that need imports', async function () {
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

    let transformed = await transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        export default function() {
          const template = precompileTemplate('<Message @when={{now}} />');
        }
      `);

    expect(transformed).toMatch(/let current = DateTime.now()/);
    expect(transformed).toMatch(/import { DateTime } from "luxon"/);
    expect(transformed).toContain('when={{current}}');
  });

  it('can emit side-effectful expression that need imports', async function () {
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

    let transformed = await transform(stripIndent`
      import { precompileTemplate } from '@ember/template-compilation';
      export default function() {
        const template = precompileTemplate('<Thing />');
      }
    `);

    expect(transformed).toContain(`import * as thing from "ember-thing"`);
    expect(transformed).toContain(`window.define('my-app/components/thing', thing)`);
  });

  it('prevents inconsistent external manipulation of the locals array', async function () {
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

    await expect(() =>
      transform(stripIndent`
      import { precompileTemplate } from '@ember/template-compilation';
      let NewThing = Thing;
      export default function() {
        const template = precompileTemplate('<Thing />');
      }
    `)
    ).rejects.toThrow(/The only supported way to manipulate locals is via the jsutils API/);
  });

  it('can emit side-effectful import', async function () {
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

    let transformed = await transform(stripIndent`
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

    it('can run an ast transform inside precompileTemplate', async function () {
      plugins = [[HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [color] }]];

      let transformed = await transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        const template = precompileTemplate('<Message @color={{red}} />');
      `);

      expect(transformed).equalCode(`
        import { precompileTemplate } from '@ember/template-compilation';
        const template = precompileTemplate("<Message @color={{\\"#ff0000\\"}} />");
      `);
    });

    it('can run an ast transform inside hbs backticks', async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
            transforms: [color],
            enableLegacyModules: ['ember-cli-htmlbars'],
          },
        ],
      ];

      let transformed = await transform(
        "import { hbs } from 'ember-cli-htmlbars'; const template = hbs`<Message @color={{red}} />`;"
      );

      expect(transformed).equalCode(`
        import { hbs } from 'ember-cli-htmlbars';
        const template = hbs\`<Message @color={{"#ff0000"}} />\`;
      `);
    });

    it('can run an ast transform inside hbs call', async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
            transforms: [color],
            enableLegacyModules: ['ember-cli-htmlbars'],
          },
        ],
      ];

      let transformed = await transform(`
        import { hbs } from 'ember-cli-htmlbars'; 
        const template = hbs('<Message @color={{red}} />');
      `);

      expect(transformed).equalCode(`
        import { hbs } from 'ember-cli-htmlbars';
        const template = hbs('<Message @color={{"#ff0000"}} />');
      `);
    });

    it('can create the options object for precompileTemplate', async function () {
      plugins = [
        [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
      ];

      let transformed = await transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        const template = precompileTemplate('<Message @text={{onePlusOne}} />');
      `);

      expect(transformed).equalCode(`
        import { precompileTemplate } from '@ember/template-compilation';
        let two = 1 + 1;
        const template = precompileTemplate("<Message @text={{two}} />", {
          scope: () => ({
            two
          })
        });
      `);
    });

    it('adds scope to existing options object', async function () {
      plugins = [
        [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
      ];

      let transformed = await transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        import Message from 'message';
        const template = precompileTemplate('<Message @text={{onePlusOne}} />', {
          moduleName: 'customModuleName'
        });
      `);

      expect(transformed).equalCode(`
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

    it('adds new locals to preexisting scope', async function () {
      plugins = [
        [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
      ];

      let transformed = await transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        import Message from 'message';
        const template = precompileTemplate('<Message @text={{onePlusOne}} />', {
          scope: () => ({
            Message
          })
        });
      `);

      expect(transformed).equalCode(`
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

    it('adds new locals to preexisting renamed scope', async function () {
      plugins = [
        [HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [expressionTransform] }],
      ];

      let transformed = await transform(stripIndent`
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

      expect(transformed).equalCode(`
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

    it('switches from legacy callExpressions to precompileTemplate when needed to support scope', async function () {
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

      let transformed = await transform(stripIndent`
        import { hbs } from 'ember-cli-htmlbars';
        const template = hbs('<Message @text={{onePlusOne}} />');
      `);

      expect(transformed).equalCode(`
        import { precompileTemplate } from "@ember/template-compilation";
        let two = 1 + 1;
        const template = precompileTemplate("<Message @text={{two}} />", {
          scope: () => ({
            two
          })
        });
      `);
    });

    it('switches from hbs backticks to precompileTemplate when needed to support scope', async function () {
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

      let transformed = await transform(
        "import { hbs } from 'ember-cli-htmlbars'; const template = hbs`<Message @text={{onePlusOne}} />`;"
      );

      expect(transformed).equalCode(`
        import { precompileTemplate } from "@ember/template-compilation";
        let two = 1 + 1;
        const template = precompileTemplate("<Message @text={{two}} />", {
          scope: () => ({
            two
          })
        });
      `);
    });

    it('does not remove original import if there are still callsites using it', async function () {
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

      let transformed = await transform(
        "import { hbs } from 'ember-cli-htmlbars'; const template = hbs`<Message @text={{onePlusOne}} />`; const other = hbs`hello`;"
      );

      expect(transformed).equalCode(`
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

    it('leaves html entities unchanged when there are no transforms', async function () {
      plugins = [[HTMLBarsInlinePrecompile, { targetFormat: 'hbs', transforms: [] }]];

      let transformed = await transform(stripIndent`
        import { precompileTemplate } from '@ember/template-compilation';
        const template = precompileTemplate('&times;');
      `);

      expect(transformed).equalCode(`
        import { precompileTemplate } from '@ember/template-compilation';
        const template = precompileTemplate('&times;');
      `);
    });

    it('emits setComponentTemplate and templateOnlyComponent when polyfilling rfc931 in hbs format', async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
            transforms: [color],
          },
        ],
      ];

      let transformed = await transform(
        `import { template } from '@ember/template-compiler'; 
         import HelloWorld from 'somewhere';
         export default template('<HelloWorld @color={{red}} />', { scope: () => ({ HelloWorld }) });`
      );

      expect(transformed).equalCode(`
        import HelloWorld from "somewhere";
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        import templateOnly from "@ember/component/template-only";
        export default setComponentTemplate(precompileTemplate('<HelloWorld @color={{"#ff0000"}} />', { scope: () => ({ HelloWorld }), strictMode: true }), templateOnly());
      `);
    });

    it('emits setComponentTemplate when polyfilling rfc931 with hbs target', async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
            transforms: [color],
          },
        ],
      ];

      let transformed = await transform(
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

      expect(transformed).equalCode(`
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

    it('emits setComponentTemplate outside a class when polyfilling rfc931 with hbs target', async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
            transforms: [color],
          },
        ],
      ];

      let transformed = await transform(
        `
         import { template } from '@ember/template-compiler'; 
         import HelloWorld from 'somewhere';
         export default class MyComponent {      
         }
         template('<HelloWorld @color={{red}} />', { component: MyComponent, scope: () => ({ HelloWorld }) });
        `
      );

      expect(transformed).equalCode(`
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

    it('cleans up leftover imports when there is more than one template', async function () {
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

      let transformed = await transform(code);

      expect(transformed).equalCode(`
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

    it("respects user's strict option on template()", async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
            transforms: [],
          },
        ],
      ];

      let transformed = await transform(
        `import { template } from '@ember/template-compiler'; 
         import HelloWorld from 'somewhere';
         export default template('<HelloWorld />', { strict: false, scope: () => ({ HelloWorld }) });`
      );

      expect(transformed).equalCode(`
        import HelloWorld from "somewhere";
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        import templateOnly from "@ember/component/template-only";
        export default setComponentTemplate(precompileTemplate('<HelloWorld />', { strictMode: false, scope: () => ({ HelloWorld }) }), templateOnly());
      `);
    });
  });

  it('removes original import when there are multiple callsites that all needed replacement', async function () {
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

    let transformed = await transform(
      "import { hbs } from 'ember-cli-htmlbars'; const template = hbs`<Message @text={{onePlusOne}} />`; const other = hbs`{{onePlusOne}}`;"
    );

    expect(transformed).equalCode(`
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

  it('emits setComponentTemplate and templateOnlyComponent when compiling rfc931 to wire format', async function () {
    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          targetFormat: 'wire',
          transforms: [],
        },
      ],
    ];

    let transformed = await transform(
      `import { template } from '@ember/template-compiler'; 
       import HelloWorld from 'somewhere';
       export default template('<HelloWorld />', { scope: () => ({ HelloWorld }) });`
    );

    expect(normalizeWireFormat(transformed)).equalCode(`
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
          block: "[[[8,[32,0],null,null,null]],[],[]]",
          moduleName: "<moduleName>",
          scope: () => [HelloWorld],
          isStrictMode: true,
        }
      ), templateOnly());    
    `);
  });

  it('emits setComponentTemplate when compiling rfc931 to wire format', async function () {
    plugins = [
      [
        HTMLBarsInlinePrecompile,
        {
          targetFormat: 'wire',
          transforms: [],
        },
      ],
    ];

    let transformed = await transform(
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

    expect(normalizeWireFormat(transformed)).equalCode(`
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
                block: "[[[8,[32,0],null,null,null]],[],[]]",
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
    it('correctly handles scope function (non-block arrow function)', async function () {
      let source = '<foo /><bar/>';

      await transform(
        `import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('${source}', { scope: () => ({ foo, bar }) });`
      );
      expect(precompileSpy.mock.lastCall?.at(-1)).toHaveProperty('locals', ['foo', 'bar']);
    });

    it('correctly handles scope function (block arrow function)', async function () {
      let source = '<foo /><bar/>';

      await transform(
        `import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('${source}', { scope: () => { return { foo, bar }; }});`
      );

      expect(precompileSpy.mock.lastCall?.at(-1)).toHaveProperty('locals', ['foo', 'bar']);
    });

    it('correctly handles scope function (normal function)', async function () {
      let source = '<foo /><bar/>';

      await transform(
        `import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('${source}', { scope: function() { return { foo, bar }; }});`
      );

      expect(precompileSpy.mock.lastCall?.at(-1)).toHaveProperty('locals', ['foo', 'bar']);
    });

    it('correctly handles scope function (object method)', async function () {
      let source = '<foo /><bar/>';

      await transform(
        `import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('${source}', { scope() { return { foo, bar }; }});`
      );
      expect(precompileSpy.mock.lastCall?.at(-1)).toHaveProperty('locals', ['foo', 'bar']);
    });

    it('correctly handles scope function with coverage', async function () {
      let source = '<foo /><bar/>';

      await transform(
        `import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('${source}', { scope() { ++cov_2rkfh72wo; return { foo, bar }; }});`
      );
      expect(precompileSpy.mock.lastCall?.at(-1)).toHaveProperty('locals', ['foo', 'bar']);
    });

    it('correctly handles scope if it contains keys and values', async function () {
      let transformed = await transform(`
        import bar from 'bar';
        import MyButton from 'my-button';
        import { precompileTemplate } from '@ember/template-compilation';
        var compiled = precompileTemplate('<Foo /><MyButton />', { scope: () => ({ Foo: bar, MyButton}) });
      `);

      expect(normalizeWireFormat(transformed)).equalCode(`
        import bar from "bar";
        import MyButton from 'my-button';
        import { createTemplateFactory } from "@ember/template-factory";
        var compiled = createTemplateFactory(
          /*
            <Foo /><MyButton />
          */
          {
            id: "<id>",
            block: "[[[8,[32,0],null,null,null],[8,[32,1],null,null,null]],[],[]]",
            moduleName: "<moduleName>",
            scope: () => [bar, MyButton],
            isStrictMode: false,
          }
        );
      `);
    });

    it('errors if scope is not an object', async function () {
      await expect(() =>
        transform(
          "import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('hello', { scope: () => ['foo', 'bar'] });"
        )
      ).rejects.toThrow(
        /Scope objects for `precompileTemplate` must be an object expression containing only references to in-scope values/
      );
    });

    it('errors if scope contains any non-reference values', async function () {
      await expect(() =>
        transform(
          "import { precompileTemplate } from '@ember/template-compilation';\nvar compiled = precompileTemplate('hello', { scope: () => ({ foo, bar: 123 }) });"
        )
      ).rejects.toThrow(
        /Scope objects for `precompileTemplate` may only contain direct references to in-scope values, e.g. { bar } or { bar: bar }/
      );
    });

    it('correctly removes not used scope', async function () {
      await transform(`
        import { precompileTemplate } from '@ember/template-compilation';
        let foo, bar;
        var compiled = precompileTemplate('<foo /><bar/>', { scope: () => ({ foo, bar, baz }) });
      `);
      expect(precompileSpy.mock.lastCall?.at(-1)).toHaveProperty('locals', ['foo', 'bar']);
    });

    it('does not automagically add to scope when not using implicit-scope-form', async function () {
      await transform(`
        import { precompileTemplate } from '@ember/template-compilation';
        let foo, bar;
        var compiled = precompileTemplate('<foo /><bar/>', { scope: () => ({ bar }) });
      `);
      expect(precompileSpy.mock.lastCall?.at(-1)).toHaveProperty('locals', ['bar']);
    });

    it('can pass lexically scoped "this"', async function () {
      let transformed = await transform(`
        import { precompileTemplate } from '@ember/template-compilation';
        export function example() {
          return precompileTemplate('{{this.message}}', { scope: () => ({ "this": this }) });
        }
      `);
      expect(precompileSpy.mock.lastCall?.at(-1)).toHaveProperty('locals', ['this']);
      expect(normalizeWireFormat(transformed)).equalCode(`
        import { createTemplateFactory } from "@ember/template-factory";
        export function example() {
          return createTemplateFactory(
            /*
              {{this.message}}
            */
            {
              id: "<id>",
              block: '[[[1,[32,0,["message"]]]],[],[]]',
              moduleName: "<moduleName>",
              scope: () => [this],
              isStrictMode: false,
            }
          );
        }
      `);
    });
  });

  describe('implicit-scope-form', function () {
    it('uses local to satisfy upvar in template, in hbs target', async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
          },
        ],
      ];

      let transformed = await transform(
        `import { template } from '@ember/template-compiler'; 
         import HelloWorld from 'somewhere';
         export default template('<HelloWorld />', { eval: function() { return eval(arguments[0]) } })
        `
      );

      expect(transformed).equalCode(`
        import HelloWorld from "somewhere";
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        import templateOnly from "@ember/component/template-only";
        export default setComponentTemplate(precompileTemplate('<HelloWorld />', { strictMode: true, scope: () => ({ HelloWorld }) }), templateOnly());
      `);
    });

    describe('implements RFC#1070: default globals', function () {
      for (let name of ALLOWED_GLOBALS) {
        it(`${name}: allowed`, async function () {
          plugins = [
            [
              HTMLBarsInlinePrecompile,
              {
                targetFormat: 'hbs',
              },
            ],
          ];

          let transformed = await transform(
            `import { template } from '@ember/template-compiler'; 
         const data = {};
         export default template('{{${name} data}}', { eval: function() { return eval(arguments[0]) } })
        `
          );

          expect(transformed).equalCode(`
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        import templateOnly from "@ember/component/template-only";
        const data = {};
        export default setComponentTemplate(precompileTemplate('{{${name} data}}', { strictMode: true, scope: () => ({ ${name}, data }) }), templateOnly());
      `);
        });
      }
    });

    // You might think this would be confusing style, and you'd be correct. But
    // that's what the lint rules are for. When it comes to correctness, we need
    // our scope to behave like real Javascript, and Javascript doesn't care
    // whether you've (for example) capitalized your variable identifier.
    it('shadows html elements with locals', async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
          },
        ],
      ];

      let transformed = await transform(
        `import { template } from '@ember/template-compiler'; 
         let div = 1;
         export default template('<div></div>', { eval: function() { return eval(arguments[0]) } })
        `
      );

      expect(transformed).equalCode(`
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        import templateOnly from "@ember/component/template-only";
        let div = 1;
        export default setComponentTemplate(precompileTemplate('<div></div>', { strictMode: true, scope: () => ({ div })}), templateOnly());
      `);
    });

    it('shadows ember keywords with locals', async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
          },
        ],
      ];

      let transformed = await transform(
        `import { template } from '@ember/template-compiler'; 
         let hasBlock = 1;
         export default template('{{hasBlock "thing"}}', { eval: function() { return eval(arguments[0]) } })
        `
      );

      expect(transformed).equalCode(`
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        import templateOnly from "@ember/component/template-only";
        let hasBlock = 1;
        export default setComponentTemplate(precompileTemplate('{{hasBlock "thing"}}', { strictMode: true, scope: () => ({ hasBlock }) }), templateOnly());
      `);
    });

    it('captures lexical "this" in mustache when template is used as an expression', async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
          },
        ],
      ];

      let transformed = await transform(
        `import { template } from '@ember/template-compiler'; 
        function upper(s) { return s.toUpperCase() }
        export function exampleTest() {
          this.message = "hello";
          render(template('{{upper this.message}}', { eval: function() { return eval(arguments[0]) } }))
        }
        `
      );

      expect(transformed).equalCode(`
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        import templateOnly from "@ember/component/template-only";
        function upper(s) {
          return s.toUpperCase();
        }
        export function exampleTest() {
          this.message = "hello";
          render(
            setComponentTemplate(
              precompileTemplate("{{upper this.message}}", {
                strictMode: true,
                scope: () => ({
                  upper,
                  this: this,
                }),
              }),
              templateOnly()
            )
          );
        }
      `);
    });

    it('captures lexical "this" in Element when template is used as an expression', async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
          },
        ],
      ];

      let transformed = await transform(
        `import { template } from '@ember/template-compiler'; 
        import SomeComponent from './elsewhere.js';
        export function exampleTest() {
          this.message = SomeComponent;
          render(template('<this.message />', { eval: function() { return eval(arguments[0]) } }))
        }
        `
      );

      expect(transformed).equalCode(`
        import SomeComponent from './elsewhere.js';
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        import templateOnly from "@ember/component/template-only";
        export function exampleTest() {
          this.message = SomeComponent;
          render(
            setComponentTemplate(
              precompileTemplate("<this.message />", {
                strictMode: true,
                scope: () => ({
                  this: this,
                }),
              }),
              templateOnly()
            )
          );
        }
      `);
    });

    it('does not captures lexical "this" when template is used in class body', async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
          },
        ],
      ];

      let transformed = await transform(
        `import { template } from '@ember/template-compiler'; 
        import Component from '@glimmer/component';
        export class Example extends Component {
          upper(s) { return s.toUpperCase() }
          message = "hi";
          static {
            template('{{this.upper this.message}}', { component: this, eval: function() { return eval(arguments[0]) } })
          }
        }
        `
      );

      expect(transformed).equalCode(`
        import Component from '@glimmer/component';
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        export class Example extends Component {
          upper(s) { return s.toUpperCase() }
          message = "hi";
          static {
            setComponentTemplate(
              precompileTemplate("{{this.upper this.message}}", {
                strictMode: true,
              }), this)
          }
        }
      `);
    });

    it('does not captures lexical "this" when template is used in class body even when a TS "this" is in scope', async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
          },
        ],
        TransformTypescript,
      ];

      let transformed = await transform(
        `import { template } from '@ember/template-compiler'; 
        import Component from '@glimmer/component';

        function someHelper() {}
        
        export function example(this: unknown) {
        
          class Example extends Component {
            upper(s) { return s.toUpperCase() }
            message = "hi";
            static {
              template('{{this.upper (someHelper this.message) }}', { component: this, eval: function() { return eval(arguments[0]) } })
            }
          }

        }
        `
      );

      expect(transformed).equalCode(`
        import Component from "@glimmer/component";
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";

        function someHelper() {}

        export function example() {
          class Example extends Component {
            upper(s) {
              return s.toUpperCase();
            }
            message = "hi";
            static {
              setComponentTemplate(
                precompileTemplate("{{this.upper (someHelper this.message)}}", {
                  strictMode: true,
                  scope: () => ({ someHelper }),
                }),
                this
              );
            }
          }
        }
      `);
    });

    it('leaves ember keywords alone when no local is defined', async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
          },
        ],
      ];

      let transformed = await transform(
        `import { template } from '@ember/template-compiler'; 
         export default template('{{hasBlock "thing"}}', { eval: function() { return eval(arguments[0]) } })
        `
      );

      expect(transformed).equalCode(`
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        import templateOnly from "@ember/component/template-only";
        export default setComponentTemplate(precompileTemplate('{{hasBlock "thing"}}', { strictMode: true }), templateOnly());
      `);
    });

    it('uses local to satisfy upvar in template, in wire target', async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'wire',
          },
        ],
      ];

      let transformed = await transform(
        `import { template } from '@ember/template-compiler'; 
         import HelloWorld from 'somewhere';
         export default template('<HelloWorld />', { eval: function() { return eval(arguments[0]) } })
        `
      );

      expect(normalizeWireFormat(transformed)).equalCode(`
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
              block: "[[[8,[32,0],null,null,null]],[],[]]",
              moduleName: "<moduleName>",
              scope: () => [HelloWorld],
              isStrictMode: true,
            }
          ),
           templateOnly()
        );
      `);
    });

    it('interoperates correctly with @babel/plugin-transform-typescript when handling locals with hbs target', async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
          },
        ],
        TransformTypescript,
      ];

      let transformed = await transform(
        `import { template } from '@ember/template-compiler'; 
         import HelloWorld from 'somewhere';
         export default template('<HelloWorld />', { eval: function() { return eval(arguments[0]) } })
        `
      );

      expect(transformed).equalCode(`
        import HelloWorld from "somewhere";
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        import templateOnly from "@ember/component/template-only";
        export default setComponentTemplate(precompileTemplate('<HelloWorld />', { strictMode: true, scope: () => ({ HelloWorld }) }), templateOnly());
      `);
    });

    it('respects local priority when inter-operating with @babel/plugin-transform-typescript', async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
          },
        ],
        TransformTypescript,
      ];

      let transformed = await transform(
        `import { template } from '@ember/template-compiler'; 
         import HelloWorld from 'somewhere';
         export default function() { 
          let { HelloWorld } = globalThis;
          return template('<HelloWorld />', { eval: function() { return eval(arguments[0]) } })
         }
        `
      );

      expect(transformed).equalCode(`
        import { precompileTemplate } from "@ember/template-compilation";
        import { setComponentTemplate } from "@ember/component";
        import templateOnly from "@ember/component/template-only";
        export default function() {
          let { HelloWorld } = globalThis;
          return setComponentTemplate(precompileTemplate('<HelloWorld />', { strictMode: true, scope: () => ({ HelloWorld })}), templateOnly());
        }
      `);
    });

    it('interoperates correctly with @babel/plugin-transform-typescript when handling locals with wire target', async function () {
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
            targetFormat: 'wire',
          },
        ],
        otherPlugin,
        TransformTypescript,
      ];

      let transformed = await transform(
        `import { template } from '@ember/template-compiler'; 
         import HelloWorld from 'somewhere';
         export default template('<HelloWorld />', { eval: function() { return eval(arguments[0]) } })
        `
      );

      expect(normalizeWireFormat(transformed)).equalCode(`
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
          block: "[[[8,[32,0],null,null,null]],[],[]]",
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
    it('works for expression form', async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
          },
        ],
      ];

      let p = new Preprocessor();

      let transformed = await transform(
        p.process(
          `import HelloWorld from 'somewhere';
           const MyComponent = <template><HelloWorld /></template>;
          `
        )
      );

      expect(transformed).equalCode(`
          import HelloWorld from "somewhere";
          import { precompileTemplate } from "@ember/template-compilation";
          import { setComponentTemplate } from "@ember/component";
          import templateOnly from "@ember/component/template-only";
          const MyComponent = setComponentTemplate(precompileTemplate('<HelloWorld />', { strictMode: true, scope: () => ({ HelloWorld })  }), templateOnly());
        `);
    });

    it('expression form can capture lexical "this"', async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
          },
        ],
      ];

      let p = new Preprocessor();

      let transformed = await transform(
        p.process(
          `
          export function example() {
            return <template>{{this.message}}</template>;
          }
          `
        )
      );

      expect(transformed).equalCode(`
          import { precompileTemplate } from "@ember/template-compilation";
          import { setComponentTemplate } from "@ember/component";
          import templateOnly from "@ember/component/template-only";
          export function example() {
            return setComponentTemplate(precompileTemplate('{{this.message}}', { strictMode: true, scope: () => ({ this: this })  }), templateOnly());
          }
        `);
    });

    it('works for class member form', async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
          },
        ],
      ];

      let p = new Preprocessor();

      let transformed = await transform(
        p.process(
          `import HelloWorld from 'somewhere';
           export default class {
             <template><HelloWorld /></template>
           }
          `
        )
      );

      expect(transformed).equalCode(`
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

    it('works for class member form with `this` references', async function () {
      plugins = [
        [
          HTMLBarsInlinePrecompile,
          {
            targetFormat: 'hbs',
          },
        ],
      ];

      let p = new Preprocessor();

      let transformed = await transform(
        p.process(
          `import HelloWorld from 'somewhere';
           export default class {
             h = HelloWorld;
             <template><this.h /></template>
           }
          `
        )
      );

      expect(transformed).equalCode(`
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
    .replace(/"id":\s"[^"]+"/, '"id": "<id>"')
    .replace(`"id": null`, '"id": "<id>"');
}
