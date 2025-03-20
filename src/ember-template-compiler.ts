import type { ASTv1, PreprocessOptions } from '@glimmer/syntax';

// The interface we use from ember-template-compiler.js
export interface EmberTemplateCompiler {
  precompile(templateString: string, options: PreprocessOptions): string;
  _buildCompileOptions(options: PreprocessOptions): PreprocessOptions;
  _print(ast: ASTv1.Template, options?: { entityEncoding?: 'transformed' | 'raw' }): string;
  _preprocess(src: string, options?: PreprocessOptions): ASTv1.Template;
}

export { PreprocessOptions };

export function assertTemplateCompiler(
  emberTemplateCompiler: any
): asserts emberTemplateCompiler is EmberTemplateCompiler {
  if (typeof emberTemplateCompiler._preprocess !== 'function') {
    throw new Error(`Unexpected API on ember template compiler. This plugin supports Ember 3.27+.`);
  }
}
