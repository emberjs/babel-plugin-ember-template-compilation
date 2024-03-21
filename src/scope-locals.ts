/*
  This class exists because:
   - before template compilation starts, we need to pass a `locals` array to
     ember-template-compiler
   - the JSUtils API can mutate the scope during template compilation
   - those scope mutations need to update both the original `locals` array and
     our own name mapping, keeping them in sync.
*/
export class ScopeLocals {
  #mapping: Record<string, string> = {};
  #locals: string[] = [];

  get locals() {
    return this.#locals;
  }

  has(key: string): boolean {
    return key in this.#mapping;
  }

  get(key: string): string {
    return this.#mapping[key];
  }

  isEmpty(): boolean {
    return this.#locals.length === 0;
  }

  needsRemapping(): boolean {
    return Object.entries(this.#mapping).some(([k, v]) => k !== v);
  }

  entries() {
    let mapping: Record<string, string> = {};
    this.locals.forEach((name) => {
      mapping[name] = this.mapping[name] || name;
    });
    return Object.entries(mapping);
  }

  get mapping() {
    return this.#mapping;
  }

  add(key: string, value?: string) {
    this.#mapping[key] = value ?? key;
    if (!this.#locals.includes(key)) {
      this.#locals.push(key);
    }
  }
}
