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
    return Object.entries(this.#mapping);
  }

  add(key: string, value?: string) {
    if (this.#locals.includes(key)) {
      // We already knew about this name. Only remap it if explicitly asked to.
      if (value) {
        this.#mapping[key] = value;
      }
    } else {
      this.#mapping[key] = value ?? key;
      this.#locals.push(key);
    }
  }
}
