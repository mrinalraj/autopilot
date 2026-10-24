package app

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/storage"
)

func (a *App) ConfigureWebhook(ctx context.Context, id string, enabled bool, secret string) (domain.Integration, error) {
	a.IntegrationOps.Lock()
	defer a.IntegrationOps.Unlock()
	i, e := storage.Get[domain.Integration](ctx, a.Store.DB, "integrations", id)
	if e != nil {
		return i, e
	}
	if i.Provider != "linear" && i.Provider != "jira" {
		return i, fmt.Errorf("signed tracker webhooks are available for Linear and Jira")
	}
	if secret != "" {
		if len(secret) < 16 {
			return i, fmt.Errorf("use a webhook signing secret of at least 16 characters")
		}
		if e = a.SetSecret("webhook-"+id, secret); e != nil {
			return i, e
		}
	}
	if enabled {
		if _, e = a.Secret("webhook-" + id); e != nil {
			return i, fmt.Errorf("configure the signing secret first")
		}
	}
	i.WebhookEnabled = enabled
	i.Touch()
	return i, a.save(ctx, i, i.ID, "webhook.configured", "Updated webhook receiver")
}

// Linear signs the raw body with Linear-Signature; Jira admin webhooks use
// X-Hub-Signature: sha256=<hex>. Payloads trigger authoritative synchronization,
// not direct issue mutation. See provider documentation linked in the README.
func (a *App) ReceiveWebhook(ctx context.Context, id, linearSignature, jiraSignature string, body []byte) error {
	i, e := storage.Get[domain.Integration](ctx, a.Store.DB, "integrations", id)
	if e != nil || !i.Enabled || !i.WebhookEnabled {
		return fmt.Errorf("webhook receiver unavailable")
	}
	secret, e := a.Secret("webhook-" + id)
	if e != nil {
		return fmt.Errorf("webhook receiver unavailable")
	}
	signature := linearSignature
	if i.Provider == "jira" {
		if !strings.HasPrefix(jiraSignature, "sha256=") {
			return fmt.Errorf("invalid webhook signature")
		}
		signature = strings.TrimPrefix(jiraSignature, "sha256=")
	} else if i.Provider != "linear" {
		return fmt.Errorf("unsupported webhook provider")
	}
	received, e := hex.DecodeString(signature)
	if e != nil {
		return fmt.Errorf("invalid webhook signature")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	if !hmac.Equal(received, mac.Sum(nil)) {
		return fmt.Errorf("invalid webhook signature")
	}
	var event struct {
		WebhookTimestamp int64 `json:"webhookTimestamp"`
		Timestamp        int64 `json:"timestamp"`
	}
	if e = json.Unmarshal(body, &event); e != nil {
		return fmt.Errorf("invalid webhook payload")
	}
	if i.Provider == "linear" {
		age := time.Since(time.UnixMilli(event.WebhookTimestamp))
		if event.WebhookTimestamp == 0 || age > time.Minute || age < -time.Minute {
			return fmt.Errorf("expired webhook timestamp")
		}
	}
	digest := sha256.Sum256(body)
	return a.Store.Tx(ctx, func(q storage.Queryer) error {
		current, e := storage.Get[domain.Integration](ctx, q, "integrations", id)
		if e != nil {
			return e
		}
		if !current.Enabled || !current.WebhookEnabled {
			return fmt.Errorf("webhook receiver unavailable")
		}
		result, e := q.ExecContext(ctx, "INSERT OR IGNORE INTO webhook_receipts(integration_id,digest,at) VALUES(?,?,?)", id, hex.EncodeToString(digest[:]), domain.Now())
		if e != nil {
			return e
		}
		n, _ := result.RowsAffected()
		if n == 0 {
			return nil
		}
		current.WebhookPending = true
		current.LastWebhook = domain.Now()
		current.Touch()
		if e = persist(ctx, q, current); e != nil {
			return e
		}
		if _, e = q.ExecContext(ctx, "DELETE FROM webhook_receipts WHERE at<?", time.Now().Add(-30*24*time.Hour).UTC().Format(time.RFC3339Nano)); e != nil {
			return e
		}
		return storage.Event(ctx, q, id, "webhook.received", "Verified webhook received; synchronization queued")
	})
}
