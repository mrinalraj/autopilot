//go:build webassets

package web

import (
	"embed"
	"io/fs"
)

//go:embed dist
var embedded embed.FS

func init() { releaseAssets, _ = fs.Sub(embedded, "dist") }
