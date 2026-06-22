// SPDX-License-Identifier: Apache-2.0
// Minimal stub of the Electron runtime for unit tests running in Node/vitest.
// Only the symbols referenced by src/main/ipc.ts are provided.
export const app = {
  getName: () => 'chronos-ui',
  getVersion: () => '0.1.0'
}

export const ipcMain = {
  handle: (_channel: string, _handler: () => unknown) => {}
}
