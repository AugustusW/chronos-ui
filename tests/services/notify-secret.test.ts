import { describe, it, expect } from 'vitest'
import { goSecretDir } from '../../src/main/services/notify-secret'

describe('goSecretDir mirrors Go os.UserConfigDir()/chronos-ui', () => {
  it('darwin → ~/Library/Application Support/chronos-ui', () => {
    expect(goSecretDir('darwin', {}, '/Users/x')).toBe('/Users/x/Library/Application Support/chronos-ui')
  })
  it('linux honours XDG_CONFIG_HOME', () => {
    expect(goSecretDir('linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/x')).toBe('/cfg/chronos-ui')
  })
  it('win32 honours APPDATA', () => {
    expect(goSecretDir('win32', { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'C:\\Users\\x'))
      .toBe('C:\\Users\\x\\AppData\\Roaming\\chronos-ui')
  })
  it('linux falls back to ~/.config when XDG_CONFIG_HOME is empty string (parity with Go)', () => {
    expect(goSecretDir('linux', { XDG_CONFIG_HOME: '' }, '/home/x')).toBe('/home/x/.config/chronos-ui')
  })
  it('win32 falls back to ~/AppData/Roaming when APPDATA is empty string (parity with Go)', () => {
    expect(goSecretDir('win32', { APPDATA: '' }, 'C:\\Users\\x')).toBe('C:\\Users\\x\\AppData\\Roaming\\chronos-ui')
  })
})
