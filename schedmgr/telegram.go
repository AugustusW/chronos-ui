package main

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// notifyTokenRe / notifyChatIDRe mirror the IPC-boundary check in src/main/ipc.ts. The token is
// interpolated into the api.telegram.org URL path, so a value carrying '/', '..' or query chars could
// reshape the request path; the chatID picks the recipient. Validating here is defense-in-depth: the
// token is read from the on-disk/keychain secret, which a tampered file could otherwise weaponize
// (code review #7). Token: "<botId>:<auth>"; chatID: signed integer or "@channelusername".
var (
	notifyTokenRe  = regexp.MustCompile(`^\d+:[A-Za-z0-9_-]+$`)
	notifyChatIDRe = regexp.MustCompile(`^-?\d+$|^@\w+$`)
)

// validateNotifyCreds rejects a malformed bot token / chat id before either is used to build a request.
func validateNotifyCreds(token, chatID string) error {
	if !notifyTokenRe.MatchString(token) {
		return fmt.Errorf("invalid telegram bot token format")
	}
	if !notifyChatIDRe.MatchString(chatID) {
		return fmt.Errorf("invalid telegram chat id format")
	}
	return nil
}

// sendTelegram POSTs a plain-text message to Bot API sendMessage. Best-effort: the caller logs the
// error and never lets it change a job's exit code. baseURL is injectable for tests.
func sendTelegram(client *http.Client, baseURL, token, chatID, text string) error {
	if err := validateNotifyCreds(token, chatID); err != nil {
		return err
	}
	form := url.Values{}
	form.Set("chat_id", chatID)
	form.Set("text", text)
	endpoint := fmt.Sprintf("%s/bot%s/sendMessage", strings.TrimRight(baseURL, "/"), token)
	resp, err := client.PostForm(endpoint, form)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("telegram sendMessage %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

const telegramBaseURL = "https://api.telegram.org"
