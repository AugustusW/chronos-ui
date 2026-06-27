// SPDX-License-Identifier: Apache-2.0
package main

import "testing"

func TestParseDBDescriptor(t *testing.T) {
	cases := []struct {
		in       string
		wantIsPg bool
		wantSvc  string
	}{
		{"/Users/me/Library/Application Support/chronos-ui/chronos.db", false, ""},
		{":memory:", false, ""},
		{"pg:keychain:com.augustusw.chronos-ui/pg-dsn", true, "com.augustusw.chronos-ui/pg-dsn"},
		{"pg:keychain:svc", true, "svc"},
		{"", false, ""},
	}
	for _, c := range cases {
		isPg, svc := parseDBDescriptor(c.in)
		if isPg != c.wantIsPg || svc != c.wantSvc {
			t.Fatalf("parseDBDescriptor(%q) = (%v,%q), want (%v,%q)", c.in, isPg, svc, c.wantIsPg, c.wantSvc)
		}
	}
}
