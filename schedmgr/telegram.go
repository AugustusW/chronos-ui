package main

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// sendTelegram POSTs a plain-text message to Bot API sendMessage. Best-effort: the caller logs the
// error and never lets it change a job's exit code. baseURL is injectable for tests.
func sendTelegram(client *http.Client, baseURL, token, chatID, text string) error {
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
