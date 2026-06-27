// SPDX-License-Identifier: Apache-2.0
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// secretReader reads a secret (the Postgres DSN) from the OS keychain by service name.
type secretReader interface {
	read(service string) (string, error)
}

// platformSecretReader delegates to the build-tagged keychainRead for the current OS.
type platformSecretReader struct{}

func (platformSecretReader) read(service string) (string, error) { return keychainRead(service) }

// resolveDSNWith returns the Postgres DSN for a keychain service: the OS keychain first, then a 0600
// file fallback (spec §2.1). The DSN secret never appears in the crontab line — only the service
// name does (the "pg:keychain:<service>" descriptor). The keychain reader + fallback dir are
// injected so the logic is headlessly testable; openStoreWith supplies the platform defaults.
func resolveDSNWith(kc secretReader, fallbackDir, service string) (string, error) {
	dsn, kcErr := kc.read(service)
	if kcErr == nil {
		if dsn = strings.TrimSpace(dsn); dsn != "" {
			return dsn, nil
		}
	}
	fileDSN, err := readDSNFile(fallbackDir, service)
	if err != nil {
		// Surface the keychain error too — on macOS the common failure is a cross-binary ACL denial
		// (the spec-flagged hard part), which would otherwise be invisible when the fallback is absent.
		kcNote := "returned empty"
		if kcErr != nil {
			kcNote = kcErr.Error()
		}
		return "", fmt.Errorf("no DSN for %q (keychain: %s; fallback: %w)", service, kcNote, err)
	}
	return fileDSN, nil
}

func defaultFallbackDir() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "chronos-ui"
	}
	return filepath.Join(dir, "chronos-ui")
}

// readDSNFile reads the 0600 fallback DSN file. A looser-than-0600 file still reads (best-effort:
// schedmgr must function) but emits a stderr warning surfacing the plaintext-secret risk.
func readDSNFile(dir, service string) (string, error) {
	path := filepath.Join(dir, sanitizeService(service)+".dsn")
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.Mode().Perm()&0o077 != 0 {
		fmt.Fprintf(os.Stderr, "schedmgr: WARNING: DSN fallback file %s has loose permissions %o (want 0600)\n", path, info.Mode().Perm())
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	dsn := strings.TrimSpace(string(b))
	if dsn == "" {
		return "", fmt.Errorf("fallback file %s is empty", path)
	}
	return dsn, nil
}

// sanitizeService maps a keychain service name (which may contain '/' or ':') to a safe filename.
func sanitizeService(service string) string {
	return strings.NewReplacer("/", "_", ":", "_", string(os.PathSeparator), "_").Replace(service)
}
