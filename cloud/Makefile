.PHONY: build dev test web docker
web:
	cd web && bun install --frozen-lockfile && bun run build
build: web
	go build -tags webassets -o bin/autopilot ./cmd/autopilot
dev:
	go run ./cmd/autopilot serve
test:
	go test -race ./...
docker:
	docker compose up -d --build
