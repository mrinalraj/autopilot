package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/mrinalraj/autopilot/cloud/internal/app"
)

func TestStaticDelivery(t *testing.T) {
	a, err := app.New(app.Config{DataDir: t.TempDir(), AllowedHosts: []string{"app.test"}})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Store.Close()
	assets := fstest.MapFS{
		"index.html":               {Data: []byte("<html>current</html>")},
		"manifest.webmanifest":     {Data: []byte(`{"id":"/"}`)},
		"service-worker.js":        {Data: []byte("/* worker */")},
		"offline.html":             {Data: []byte("<html>offline</html>")},
		"icons/icon-192.png":       {Data: []byte("image")},
		"assets/index-12345678.js": {Data: []byte("/* app */")},
	}
	server := New(a, assets)
	for _, tt := range []struct {
		path, mime, cache string
		status            int
	}{
		{"/", "text/html", "no-cache", 200},
		{"/workspaces/example", "text/html", "no-cache", 200},
		{"/manifest.webmanifest", "application/manifest+json", "no-cache", 200},
		{"/service-worker.js", "javascript", "no-cache", 200},
		{"/icons/icon-192.png", "image/png", "no-cache", 200},
		{"/offline.html", "text/html", "no-cache", 200},
		{"/assets/index-12345678.js", "javascript", "immutable", 200},
		{"/assets/missing.js", "text/plain", "no-store", 404},
		{"/assets/missing", "text/plain", "no-store", 404},
		{"/missing.webmanifest", "text/plain", "no-store", 404},
		{"/icons/missing.png", "text/plain", "no-store", 404},
		{"/api/v1/snapshot", "application/json", "no-store", 200},
		{"/healthz", "application/json", "no-store", 200},
	} {
		t.Run(tt.path, func(t *testing.T) {
			req := httptest.NewRequest("GET", "http://app.test"+tt.path, nil)
			req.Header.Set("Accept", "text/html")
			rec := httptest.NewRecorder()
			server.ServeHTTP(rec, req)
			if rec.Code != tt.status || !strings.Contains(rec.Header().Get("Content-Type"), tt.mime) || !strings.Contains(rec.Header().Get("Cache-Control"), tt.cache) {
				t.Fatalf("%d %v: %s", rec.Code, rec.Header(), rec.Body.String())
			}
		})
	}
	req := httptest.NewRequest("HEAD", "http://app.test/service-worker.js", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Body.Len() != 0 || rec.Header().Get("Content-Length") == "" {
		t.Fatal("HEAD must describe but not send the asset")
	}
	// An asset replacement is visible immediately without a stale HTML response.
	assets["index.html"] = &fstest.MapFile{Data: []byte("<html>updated</html>")}
	req = httptest.NewRequest("GET", "http://app.test/", nil)
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), "updated") {
		t.Fatal("old app document served")
	}
}
