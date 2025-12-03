import fs from 'node:fs';
let pkg = JSON.parse(fs.readFileSync('package.json'));
pkg.devDependencies['ember-source'] = process.argv[2];
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
