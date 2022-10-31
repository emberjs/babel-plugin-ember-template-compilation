export function precompile(value: string) {
  return `precompiledFromPath(${value})`;
}

export function _preprocess(...args: unknown[]) {
  return args;
}
