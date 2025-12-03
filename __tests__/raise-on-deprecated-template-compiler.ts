const orig = console.log;
console.log = function (message, ...rest) {
  orig.call(this, `customized console.log for ${message}`);
  if (message.includes('Your app is using the legacy ember-template-compiler.js AMD bundle')) {
    throw new Error(`We tried to use the deprecated ember-template-compiler.js`);
  }
  return orig.call(this, message, ...rest);
};
