// SPDX-License-Identifier: Apache-2.0
// Cross-Node test setup for jsdom-environment tests.
//
// Node 22+ exposes a native global `localStorage`/`sessionStorage` (experimental
// webstorage; on by default on Node 24+). vitest's jsdom environment does NOT
// override a Web Storage global that is already present on `globalThis`, so app code
// reading the bare `localStorage` global gets Node's native storage — whose semantics
// differ from the DOM Storage app/tests expect (e.g. `.clear()` is absent), breaking
// jsdom-based tests.
//
// Rather than depend on a Node version or a `NODE_OPTIONS=--no-experimental-webstorage`
// flag (which Node 20 — the version the CI pins — rejects as an unknown option),
// install a clean, spec-compliant in-memory Storage for the test run. This is robust
// across Node 20/22/24/25 and a no-op in node-environment test files (no `window`).
class MemoryStorage {
  private store = new Map<string, string>()
  get length(): number {
    return this.store.size
  }
  clear(): void {
    this.store.clear()
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }
}

if (typeof window !== 'undefined') {
  for (const key of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(globalThis, key, {
      value: new MemoryStorage(),
      configurable: true,
      writable: true
    })
  }
}
