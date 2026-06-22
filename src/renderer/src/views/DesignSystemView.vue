<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Dev-only route: /design-system — token + component reference page -->
<template>
  <div class="ds-wrap">
    <h1>ChronosUI Design System</h1>
    <p class="lead">Three-layer tokens (primitive → semantic → component), brand-neutralized for OSS. Accent #4f7fc1 is a neutral default, not ManGo's brand hue.</p>

    <!-- Primitive palette -->
    <h2>Primitive palette</h2>
    <div class="row">
      <div v-for="sw in primitivePalette" :key="sw.name" class="sw">
        <div class="c" :style="{ background: sw.hex }"></div>
        <div class="n">{{ sw.name }}</div>
        <div class="v">{{ sw.hex }}</div>
      </div>
    </div>
    <div class="row mt">
      <div v-for="sw in accentPalette" :key="sw.name" class="sw">
        <div class="c" :style="{ background: sw.hex }"></div>
        <div class="n">{{ sw.name }}</div>
        <div class="v">{{ sw.hex }}</div>
      </div>
    </div>

    <!-- Semantic tokens — live (reads active theme) -->
    <h2>Semantic tokens (current theme)</h2>
    <div class="row">
      <div v-for="sw in semanticTokens" :key="sw.name" class="sw">
        <div class="c" :style="{ background: `var(--color-${sw.token})` }"></div>
        <div class="n">{{ sw.name }}</div>
      </div>
    </div>

    <!-- Components -->
    <h2>Components</h2>
    <div class="row gap-lg">
      <!-- Buttons, badges, dots, chips, toggles -->
      <div class="card">
        <div class="lbl">Buttons</div>
        <div class="row"><button class="btn primary">▶ Run now</button><button class="btn">Edit</button><button class="btn danger">Delete</button></div>
        <div class="lbl mt-sm">Status badges &amp; dots</div>
        <div class="row ai-center"><span class="badge ok">success</span><span class="badge fail">failed</span><span class="badge warn">timeout</span><span class="badge run">running…</span></div>
        <div class="row ai-center mt-xs"><span><span class="st ok"></span>ok</span><span><span class="st fail"></span>failed</span><span><span class="st warn"></span>timeout</span><span><span class="st off"></span>disabled</span></div>
        <div class="lbl mt-sm">Chips &amp; toggles</div>
        <div class="row ai-center"><span class="chip wrap-chip">wrapped</span><span class="chip">unmanaged</span><span class="toggle"></span><span class="toggle off"></span></div>
      </div>
      <!-- Input + terminal -->
      <div class="card flex1">
        <div class="lbl">Input</div>
        <input class="in mono" value="0 3 * * *" readonly />
        <div class="lbl mt-sm">Execution output (mono, code-bg, ANSI-stripped, break-word — §9.4)</div>
        <div class="term">
          <span class="dim"># /usr/bin/pg_dump assistant | gzip &gt; backup.sql.gz</span>{{ '\n' }}pg_dump: dumping contents of table "tb_memories"{{ '\n' }}<span class="err">pg_dump: error: connection to server lost</span>{{ '\n' }}<span class="dim">— exited 1 after 0.4s —</span>
        </div>
      </div>
    </div>

    <!-- Typography -->
    <h2>Typography</h2>
    <div class="row gap-lg">
      <div>
        <div class="lbl">Sans — system-ui</div>
        <div class="type-lg">Bring Order to Time</div>
        <div class="type-muted">Schedule list, labels, body</div>
      </div>
      <div>
        <div class="lbl">Mono — ui-monospace</div>
        <div class="mono type-md">0 3 * * * /usr/bin/backup.sh</div>
        <div class="mono type-muted">commands, cron, output, durations</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const primitivePalette = [
  { name: 'grey-0',    hex: '#ffffff' },
  { name: 'grey-50',   hex: '#f7f7f8' },
  { name: 'grey-100',  hex: '#ededf0' },
  { name: 'grey-200',  hex: '#d9d9de' },
  { name: 'grey-400',  hex: '#9a9aa3' },
  { name: 'grey-600',  hex: '#5c5c66' },
  { name: 'grey-800',  hex: '#2b2b31' },
  { name: 'grey-900',  hex: '#1a1a1f' },
  { name: 'grey-1000', hex: '#0a0a0a' },
]
const accentPalette = [
  { name: 'accent',        hex: '#4f7fc1' },
  { name: 'ok',            hex: '#3fa45b' },
  { name: 'warn / timeout',hex: '#c9962e' },
  { name: 'danger',        hex: '#c0493f' },
]
// Semantic tokens read live CSS vars — names map to --color-<token>
const semanticTokens = [
  { name: 'bg',          token: 'bg' },
  { name: 'surface',     token: 'surface' },
  { name: 'border',      token: 'border' },
  { name: 'text',        token: 'text' },
  { name: 'text-muted',  token: 'text-muted' },
  { name: 'primary',     token: 'primary' },
  { name: 'nav-bg',      token: 'nav-bg' },
  { name: 'code-bg',     token: 'code-bg' },
]
</script>

<style scoped>
.ds-wrap { width: 1100px; padding: 28px 32px; }
h1 { font-size: 20px; margin: 0 0 2px; }
.lead { color: var(--color-text-muted); font-size: 13px; margin: 0 0 24px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--color-text-muted); margin: 26px 0 12px; border-bottom: 1px solid var(--color-border); padding-bottom: 6px; }
.row { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-start; }
.mt { margin-top: 14px; }
.gap-lg { gap: 28px; align-items: flex-start; }
.ai-center { align-items: center; }
.mt-sm { margin-top: 14px; }
.mt-xs { margin-top: 8px; }

/* Swatches */
.sw { width: 96px; }
.sw .c { height: 52px; border-radius: 8px; border: 1px solid var(--color-border); }
.sw .n { font-size: 11px; margin-top: 5px; font-weight: 500; }
.sw .v { font-size: 10.5px; color: var(--color-text-muted); font-family: var(--p-font-mono); }

/* Card */
.card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--p-radius); padding: 14px 16px; }
.flex1 { flex: 1; }

/* Buttons */
.btn { border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text); border-radius: var(--p-radius); padding: 7px 14px; font-size: 12px; cursor: pointer; }
.btn.primary { background: var(--color-primary); color: var(--color-on-primary); border-color: transparent; font-weight: 500; }
.btn.danger { background: var(--color-danger); color: var(--color-on-primary); border-color: transparent; }

/* Badges */
.badge { font-size: 10px; font-weight: 600; padding: 3px 10px; border-radius: 20px; }
.badge.ok   { background: rgba(63,164,91,.16);  color: var(--color-ok); }
.badge.fail { background: rgba(192,73,63,.16);  color: var(--color-danger); }
.badge.warn { background: rgba(201,150,46,.16); color: var(--color-warn); }
.badge.run  { background: rgba(79,127,193,.16); color: var(--color-primary); }

/* Status dots */
.st { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
.st.ok   { background: var(--color-ok); }
.st.fail { background: var(--color-danger); }
.st.warn { background: var(--color-warn); }
.st.off  { background: var(--color-off); }

/* Chips */
.chip { font-size: 10px; padding: 2px 9px; border-radius: 20px; border: 1px solid var(--color-border); color: var(--color-text-muted); font-weight: 500; flex: 0 0 auto; align-self: flex-start; width: max-content; }
.chip.wrap-chip { background: rgba(var(--color-primary-rgb),.12); border-color: transparent; color: var(--color-primary); }

/* Toggles */
.toggle { display: inline-block; width: 34px; height: 19px; border-radius: 20px; background: var(--color-ok); position: relative; vertical-align: middle; }
.toggle.off { background: var(--color-off); }
.toggle::after { content: ""; position: absolute; top: 2px; left: 2px; width: 15px; height: 15px; border-radius: 50%; background: var(--color-on-primary); }
.toggle.off::after { left: auto; right: 2px; }

/* Input */
.in { border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text); border-radius: var(--p-radius); padding: 8px 10px; font-size: 12px; width: 220px; }

/* Terminal */
.term { background: var(--color-code-bg); font-family: var(--p-font-mono); font-size: 12px; line-height: 1.5; padding: 12px 14px; border-radius: var(--p-radius); white-space: pre-wrap; margin-top: 8px; }
.term .err { color: var(--color-danger); }
.term .dim { color: var(--color-text-muted); }

/* Typography */
.lbl { font-size: 11px; color: var(--color-text-muted); width: 100%; margin: -4px 0 2px; }
.mono { font-family: var(--p-font-mono); }
.type-lg { font-size: 18px; }
.type-md { font-size: 14px; }
.type-muted { font-size: 13px; color: var(--color-text-muted); }
</style>
