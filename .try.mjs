const embers = [
  {
    name: 'ember-lts-3.28',
    npm: {
      devDependencies: {
        'ember-source': '~3.28.0',
      },
    },
    env: {
      NO_LEXICAL_THIS: true,
    },
  },
  {
    name: 'ember-lts-4.12',
    npm: {
      devDependencies: {
        'ember-source': '~4.12.0',
      },
    },
    env: {
      NO_LEXICAL_THIS: true,
    },
  },
  {
    name: 'ember-lts-5.12',
    npm: {
      devDependencies: {
        'ember-source': '~5.12.0',
      },
    },
    env: {
      NO_LEXICAL_THIS: true,
    },
  },
  {
    name: 'ember-lts-6.4',
    npm: {
      devDependencies: {
        'ember-source': 'npm:ember-source@~6.4.0',
      },
    },
  },
  {
    name: 'ember-latest',
    npm: {
      devDependencies: {
        'ember-source': 'npm:ember-source@latest',
      },
    },
  },
  {
    name: 'ember-beta',
    npm: {
      devDependencies: {
        'ember-source': 'npm:ember-source@beta',
      },
    },
  },
];

const nodes = ['18', '20', '22'];

const scenarios = nodes.flatMap((node) =>
  embers.map((s) => ({
    ...s,
    node,
    name: s.name + `-node-${node}`,
    os: 'ubuntu-latest',
  }))
);

/* Windows spot checks */
scenarios.push({
  name: 'ember-latest-windows',
  os: 'windows-latest',
  node: '22',
  npm: {
    devDependencies: {
      'ember-source': 'npm:ember-source@latest',
    },
  },
});
scenarios.push({
  name: 'ember-lts-6.4-windows',
  os: 'windows-latest',
  node: '22',
  npm: {
    devDependencies: {
      'ember-source': 'npm:ember-source@~6.4.0',
    },
  },
});

/**
 * Babel 8 needs Node ^22.18.0 || >=24.11.0.
 * `use-node-version` in .npmrc makes pnpm run
 * scripts on Node 18, so the env overrides it.
 * Babel 8 types do not match src yet, so the
 * `prepare` script (tsc) is skipped on install.
 */
scenarios.push({
  name: 'babel-8',
  os: 'ubuntu-latest',
  node: '24',
  npm: {
    devDependencies: {
      '@babel/core': '^8.0.0',
      '@babel/plugin-transform-modules-amd': '^8.0.0',
      '@babel/plugin-transform-template-literals': '^8.0.0',
      '@babel/plugin-transform-typescript': '^8.0.0',
      '@babel/plugin-transform-unicode-escapes': '^8.0.0',
      '@babel/traverse': '^8.0.0',
    },
  },
  env: {
    npm_config_use_node_version: '24.22.2',
    npm_config_ignore_scripts: 'true',
  },
});

export default {
  scenarios,
};
