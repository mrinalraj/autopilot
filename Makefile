.PHONY: build start test typecheck package
build start package:
	$(MAKE) -C cloud $@
test:
	bun test test/changelog.test.ts
	$(MAKE) -C cloud test
typecheck:
	cd cloud/web && bunx tsc --noEmit
