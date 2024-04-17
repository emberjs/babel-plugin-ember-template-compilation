const mutationMethods = [
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
];

export function readOnlyArray<T>(array: T[], message = 'Forbidden array mutation') {
  return new Proxy(array, {
    get(target, prop) {
      if (typeof prop === 'string' && mutationMethods.includes(prop)) {
        return () => {
          throw new Error(message);
        };
      }
      return Reflect.get(target, prop);
    },
    set(_target, _prop) {
      throw new Error(message);
    },
    deleteProperty() {
      throw new Error(message);
    },
  });
}
