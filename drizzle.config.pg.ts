// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/main/db/schema.pg.ts',
  out: './src/main/db/migrations.pg'
})
