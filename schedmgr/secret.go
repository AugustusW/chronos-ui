// SPDX-License-Identifier: Apache-2.0
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// secretReader reads a named secret from the OS keychain by service name.
type secretReader interface {
	read(service string) (string, error)
}

// platformSecretReader delegates to the build-tagged keychainRead for the current OS.
type platformSecretReader struct{}

func (platformSecretReader) read(service string) (string, error) { return keychainRead(service) }

const notifyTokenService = "chronos-ui-notify-token"

// resolveSecretWith returns a named secret: OS keychain first, then a 0600 <service><ext> file
// (spec §2.1). The keychain reader + fallback dir are injected so the logic is headlessly testable.
func resolveSecretWith(kc secretReader, fallbackDir, service, ext string) (string, error) {
	val, kcErr := kc.read(service)
	if kcErr == nil {
		if val = strings.TrimSpace(val); val != "" {
			return val, nil
		}
	}
	fileVal, err := readSecretFile(fallbackDir, service, ext)
	if err != nil {
		kcNote := "returned empty"
		if kcErr != nil {
			kcNote = kcErr.Error()
		}
		return "", fmt.Errorf("no secret for %q (keychain: %s; fallback: %w)", service, kcNote, err)
	}
	return fileVal, nil
}

// resolveDSNWith returns the Postgres DSN for a keychain service: the OS keychain first, then a
// 0600 <service>.dsn file fallback. The DSN secret never appears in the crontab line — only the
// service name does (the "pg:keychain:<service>" descriptor). The keychain reader + fallback dir
// are injected so the logic is headlessly testable; openStoreWith supplies the platform defaults.
func resolveDSNWith(kc secretReader, fallbackDir, service string) (string, error) {
	return resolveSecretWith(kc, fallbackDir, service, ".dsn")
}

// resolveNotifyToken returns the Telegram bot token used for failure notifications: OS keychain
// first, then a 0600 <service>.secret file fallback.
func resolveNotifyToken() (string, error) {
	return resolveSecretWith(platformSecretReader{}, defaultFallbackDir(), notifyTokenService, ".secret")
}

func defaultFallbackDir() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "chronos-ui"
	}
	return filepath.Join(dir, "chronos-ui")
}

// readSecretFile reads a 0600 fallback secret file. A looser-than-0600 file still reads
// (best-effort: schedmgr must function) but emits a stderr warning surfacing the plaintext-secret
// risk.
func readSecretFile(dir, service, ext string) (string, error) {
	path := filepath.Join(dir, sanitizeService(service)+ext)
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.Mode().Perm()&0o077 != 0 {
		fmt.Fprintf(os.Stderr, "schedmgr: WARNING: secret fallback file %s has loose permissions %o (want 0600)\n", path, info.Mode().Perm())
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	v := strings.TrimSpace(string(b))
	if v == "" {
		return "", fmt.Errorf("fallback file %s is empty", path)
	}
	return v, nil
}

// sanitizeService maps a keychain service name (which may contain '/' or ':') to a safe filename.
func sanitizeService(service string) string {
	return strings.NewReplacer("/", "_", ":", "_", string(os.PathSeparator), "_").Replace(service)
}
