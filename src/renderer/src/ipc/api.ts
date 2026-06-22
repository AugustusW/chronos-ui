// SPDX-License-Identifier: Apache-2.0
import type { ChronosApi } from '../../../preload/index'
// Lazy bridge: resolve window.chronos at call time so (a) importing this module never touches window
// (node-env tests / router.test.ts stay safe) and (b) methods reflect the current window.chronos
// (jsdom tests that set it in beforeEach work; production preload sets it before the bundle runs).
export const api: ChronosApi = new Proxy({} as ChronosApi, {
  get(_t, prop: string) {
    const c = (globalThis as { window?: { chronos?: Record<string, unknown> } }).window?.chronos
    return c?.[prop]
  }
})
