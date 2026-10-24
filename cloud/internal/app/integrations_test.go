package app

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mrinalraj/autopilot/cloud/internal/domain"
)

func TestExternalCancellationPreservesLocalNotesAndAlertsActiveWorker(t *testing.T) {
	a, w, r, _ := fixture(t)
	ctx := context.Background()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"data":{"issues":{"nodes":[{"id":"external-1","identifier":"TEAM-1","title":"Canceled upstream","updatedAt":"2026-10-23T10:00:00Z","state":{"id":"canceled","type":"canceled","name":"Canceled"}}],"pageInfo":{"hasNextPage":false}}}}`)
	}))
	defer upstream.Close()
	integration := domain.Integration{Meta: domain.NewMeta(), WorkspaceID: w.ID, Provider: "linear", Label: "Test tracker", BaseURL: upstream.URL, Scope: "TEAM", Enabled: true}
	if err := a.save(ctx, integration, integration.ID, "test.integration", ""); err != nil {
		t.Fatal(err)
	}
	a.SetSecret("integration-"+integration.ID, "test-token")
	issue := domain.Issue{Meta: domain.NewMeta(), WorkspaceID: w.ID, Title: "Original", Identifier: "TEAM-1", Source: "linear", IntegrationID: integration.ID, ExternalID: "external-1", Status: "ready", Acceptance: "Local criteria"}
	if err := a.save(ctx, issue, issue.ID, "test.issue", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Comment(ctx, issue.ID, "Private local note"); err != nil {
		t.Fatal(err)
	}
	p := proposed(t, a, w, r, issue.ID)
	if _, err := a.Approve(ctx, p.ID, p.Revision, "cancel-fixture"); err != nil {
		t.Fatal(err)
	}
	if err := a.Schedule(ctx); err != nil {
		t.Fatal(err)
	}
	if err := a.Sync(ctx, integration.ID); err != nil {
		t.Fatal(err)
	}
	updated := records[domain.Issue](t, a, "issues")[0]
	if updated.Status != "canceled" || updated.Acceptance != "Local criteria" {
		t.Fatal("mirror overwrote local metadata or missed cancellation")
	}
	if records[domain.Comment](t, a, "comments")[0].Body != "Private local note" {
		t.Fatal("private note changed")
	}
	if _, err := a.UpdateIssue(ctx, updated.ID, updated); err == nil {
		t.Fatal("linked issue fields editable locally")
	}
	if err := a.Sync(ctx, integration.ID); err != nil {
		t.Fatal(err)
	}
	actions := records[domain.Action](t, a, "actions")
	if len(actions) != 1 || actions[0].Kind != "notice" || actions[0].State != "attention" {
		t.Fatal("active cancellation was not surfaced exactly once")
	}
	if records[domain.Run](t, a, "runs")[0].State != "running" {
		t.Fatal("sync implicitly stopped a worker")
	}
}

func TestInterruptedDeliveryIsNeverReplayed(t *testing.T) {
	a, _, _, f := fixture(t)
	ctx := context.Background()
	action := domain.Action{Meta: domain.NewMeta(), Kind: "tracker.comment", State: "delivering", Fingerprint: "crash", Body: "Check remote before retry"}
	if err := a.save(ctx, action, action.ID, "test.delivery", ""); err != nil {
		t.Fatal(err)
	}
	if err := a.Reconcile(ctx, true); err != nil {
		t.Fatal(err)
	}
	a.DeliverActions(ctx)
	if records[domain.Action](t, a, "actions")[0].State != "uncertain" || f.sends != 0 {
		t.Fatal("interrupted delivery was replayed")
	}
}
