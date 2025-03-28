import { ExtendedPluginBuilder } from '../src/js-utils.js';

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

export default expressionTransform;
