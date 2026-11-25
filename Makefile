.PHONY: test-schematics quality-fast quality-gate
test-schematics:
	./ci/run_schematics.sh

quality-fast:
	./ci/run_quality_gate.sh fast

quality-gate:
	./ci/run_quality_gate.sh full
