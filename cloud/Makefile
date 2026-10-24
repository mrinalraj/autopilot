.PHONY: build dev start test web docker package
REVISION := $(shell git rev-parse HEAD)$(shell test -z "$$(git status --porcelain)" || printf '%s' '-dirty')
web:
	cd web && bun install --frozen-lockfile && bun run build
build: web
	go build -mod=readonly -tags webassets -trimpath -buildvcs=false -ldflags='-X main.revision=$(REVISION)' -o bin/autopilot-cloud ./cmd/autopilot
start: build
	./bin/autopilot-cloud start
dev:
	go run ./cmd/autopilot serve
test:
	go test -race ./...
	go vet ./...
package:
	python3 scripts/package.py $(if $(TARGETS),--targets $(TARGETS))
docker:
	docker compose up -d --build
