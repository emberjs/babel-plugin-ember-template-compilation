import { ASTv1 } from '@glimmer/syntax';
import { ExtendedPluginBuilder } from './js-utils';

// The interface we use from ember-template-compiler.js
export interface EmberTemplateCompiler {
  precompile(templateString: string, options: PreprocessOptions): string;
  _buildCompileOptions(options: PreprocessOptions): PreprocessOptions;
  _print(ast: ASTv1.Template, options?: { entityEncoding?: 'transformed' | 'raw' }): string;
  _preprocess(src: string, options?: PreprocessOptions): ASTv1.Template;
}

export interface PreprocessOptions {
  contents: string;
  moduleName: string;
  plugins?: { ast?: ExtendedPluginBuilder[] };
  filename?: string;
  parseOptions?: {
    srcName?: string;
    ignoreStandalone?: boolean;
  };
  mode?: 'codemod' | 'precompile';
  strictMode?: boolean;
  locals?: string[];
}

export function assertTemplateCompiler(
  emberTemplateCompiler: any
): asserts emberTemplateCompiler is EmberTemplateCompiler {
  if (typeof emberTemplateCompiler._preprocess !== 'function') {
    throw new Error(`Unexpected API on ember template compiler. This plugin supports Ember 3.27+.`);
  }
}
