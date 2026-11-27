export PACK VERSION ALLOW_UNVERIFIED BACKEND IMAGE
.PHONY: schematics-list schematics-build test-schematics quality-fast quality-full quality-gate quality-fast-serial quality-full-serial quality-fast-2 quality-full-2 quality-fast-3 quality-full-3 ci-isolated-install ci-isolated-live ci-isolated-full ci-isolated-cache-tests
schematics-list:
	python3 schematics/tooling/build_pack.py list

schematics-build:
	@set -- build --pack "$$PACK" --target-version "$$VERSION" --backend "$${BACKEND:-host}"; case "$$ALLOW_UNVERIFIED" in 1) set -- "$$@" --allow-unverified ;; ''|0) ;; *) echo 'ALLOW_UNVERIFIED must be 0 or 1' >&2; exit 2 ;; esac; if [ -n "$$IMAGE" ]; then set -- "$$@" --image "$$IMAGE"; fi; python3 schematics/tooling/build_pack.py "$$@"

test-schematics:
	./ci/run_schematics.sh

quality-fast:
	./ci/run_quality_gate.sh fast

quality-full:
	./ci/run_quality_gate.sh full

quality-gate: quality-full

quality-fast-serial:
	./ci/run_quality_gate.sh fast --jobs 1

quality-full-serial:
	./ci/run_quality_gate.sh full --jobs 1

quality-fast-2:
	./ci/run_quality_gate.sh fast --jobs 2

quality-full-2:
	./ci/run_quality_gate.sh full --jobs 2

quality-fast-3:
	./ci/run_quality_gate.sh fast --jobs 3

quality-full-3:
	./ci/run_quality_gate.sh full --jobs 3

ci-isolated-install:
	python3 scripts/run_isolatedci.py install

ci-isolated-live:
	python3 scripts/run_isolatedci.py live

ci-isolated-full:
	python3 scripts/run_isolatedci.py full --jobs 2

ci-isolated-cache-tests:
	python3 scripts/run_isolatedci.py cache-tests
