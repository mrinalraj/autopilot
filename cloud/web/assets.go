// Package web provides the same UI assets to the standalone server and desktop host.
package web

import (
	"embed"
	"io/fs"
	"os"
)

// The source entry keeps go test/build usable before a frontend build.
// Release builds use assets_release.go and the webassets build tag.
var sourceFS = os.DirFS("web/dist")

func Assets() fs.FS {
	if releaseAssets != nil {
		return releaseAssets
	}
	return sourceFS
}

var releaseAssets fs.FS
var _ embed.FS
