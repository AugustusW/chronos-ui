// SPDX-License-Identifier: Apache-2.0
package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type fakeReader struct {
	dsn string
	err error
}

func (f fakeReader) read(string) (string, error) { return f.dsn, f.err }

// stubSecretReader is an alias used by the notify-token tests to clearly signal
// "keychain miss" intent (same underlying type as fakeReader).
type stubSecretReader = fakeReader

// writeSecretFileForTest writes content to dir/<filename> with mode 0600.
func writeSecretFileForTest(t *testing.T, dir, filename, content string) {
	t.Helper()
	path := filepath.Join(dir, filename)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestResolveDSNKeychainHit(t *testing.T) {
	dsn, err := resolveDSNWith(fakeReader{dsn: "postgres://u:p@h/db"}, t.TempDir(), "svc")
	if err != nil || dsn != "postgres://u:p@h/db" {
		t.Fatalf("keychain hit: got (%q,%v)", dsn, err)
	}
}

func TestResolveDSNFallbackFile(t *testing.T) {
	dir := t.TempDir()
	service := "com.augustusw.chronos-ui/pg-dsn"
	path := filepath.Join(dir, sanitizeService(service)+".dsn")
	if err := os.WriteFile(path, []byte("postgres://u:p@h/db\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// keychain miss (err) → fall back to the 0600 file
	dsn, err := resolveDSNWith(fakeReader{err: os.ErrNotExist}, dir, service)
	if err != nil || dsn != "postgres://u:p@h/db" {
		t.Fatalf("fallback: got (%q,%v)", dsn, err)
	}
}

func TestResolveDSNFallbackPrefersKeychain(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, sanitizeService("svc")+".dsn")
	_ = os.WriteFile(path, []byte("postgres://file/db"), 0o600)
	// keychain hit wins over the fallback file
	dsn, err := resolveDSNWith(fakeReader{dsn: "postgres://keychain/db"}, dir, "svc")
	if err != nil || dsn != "postgres://keychain/db" {
		t.Fatalf("keychain should win: got (%q,%v)", dsn, err)
	}
}

func TestResolveDSNNoneAvailable(t *testing.T) {
	_, err := resolveDSNWith(fakeReader{err: os.ErrNotExist}, t.TempDir(), "svc")
	if err == nil {
		t.Fatal("expected error when neither keychain nor fallback file has the DSN")
	}
}

func TestSanitizeService(t *testing.T) {
	if got := sanitizeService("com.augustusw.chronos-ui/pg-dsn"); got != "com.augustusw.chronos-ui_pg-dsn" {
		t.Fatalf("sanitizeService = %q", got)
	}
}

func TestResolveNotifyTokenFromFile(t *testing.T) {
	dir := t.TempDir()
	writeSecretFileForTest(t, dir, "chronos-ui-notify-token.secret", "BOT:abc123")
	kc := stubSecretReader{err: errors.New("keychain miss")} // forces file fallback
	tok, err := resolveSecretWith(kc, dir, notifyTokenService, ".secret")
	if err != nil || tok != "BOT:abc123" {
		t.Fatalf("got %q err=%v", tok, err)
	}
}
