package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSendTelegramPostsToSendMessage(t *testing.T) {
	var gotPath, gotChat, gotText string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = r.ParseForm()
		gotChat = r.FormValue("chat_id")
		gotText = r.FormValue("text")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	err := sendTelegram(&http.Client{Timeout: 5 * time.Second}, srv.URL, "TOK", "42", "hello")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(gotPath, "/botTOK/sendMessage") || gotChat != "42" || gotText != "hello" {
		t.Fatalf("path=%q chat=%q text=%q", gotPath, gotChat, gotText)
	}
}

func TestSendTelegramNon2xxIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"ok":false,"description":"bad"}`))
	}))
	defer srv.Close()
	if err := sendTelegram(srv.Client(), srv.URL, "TOK", "42", "x"); err == nil {
		t.Fatal("expected error on 400")
	}
}
