/*
      matrix: 
        node: ['18', '20', '22']
        ember: ['~3.28.0', '~4.12.0', '~5.12.0', '~6.4.0', 'latest', 'beta']
        os: ['ubuntu-latest']
        include:
          - node: 22
            ember: '~6.4.0'
            os: windows-latest
          - node: 22
            ember: latest
            os: windows-latest

*/

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

export default {
  scenarios,
};
