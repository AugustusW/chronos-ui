// SPDX-License-Identifier: Apache-2.0
/**
 * Sequential batch runner (architect §11.3): runs ids one at a time so progress + load are simple.
 * cancel() stops the queue between items; it does NOT kill the in-flight run (architect LOW-1).
 */
export function createBatchRunner(runOne: (id: number) => Promise<void>): {
  run(ids: number[]): Promise<void>
  cancel(): void
} {
  let cancelled = false
  return {
    async run(ids) {
      cancelled = false
      for (const id of ids) {
        if (cancelled) break
        await runOne(id)
      }
    },
    cancel() {
      cancelled = true
    }
  }
}
