// SPDX-License-Identifier: Apache-2.0
import type { ChronosApi } from './index'

declare global {
  interface Window {
    chronos: ChronosApi
  }
}
