#!/usr/bin/env bash
# Full comparison of the current store (src/) and v2 (v2_new/src/). Run from anywhere: bash v2_new/compare.sh
set -u
V2="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$V2")"
cd "$V2"
echo "### 1. Current test suites and examples, run against v2"; bash run-compat.sh
echo; echo "### 2. Throughput benchmark (ms, median of 5; lower is better)"
paste <(echo -e "case\tcurrent"; cd "$ROOT" && bun test/store-throughput-bench.ts 2>&1 | tail -6 | cut -f1,2) <(echo v2; bun test/store-throughput-bench.ts 2>&1 | tail -6 | cut -f2)
echo; echo "### 3. Scenarios sensitive to the immutable core (ms, median; lower is better)"
paste <(echo -e "scenario\tcurrent"; bun bench-extra.ts "$ROOT/src" 2>/dev/null) <(echo v2; bun bench-extra.ts "$V2/src" 2>/dev/null | cut -f2)
echo; echo "### 4. Live consumers (1,000 writes; consumer runs counted)"
for n in 1000 5000; do echo "-- $n consumers: current"; bun bench-live.ts "$ROOT/src" $n 2>/dev/null; echo "-- $n consumers: v2"; bun bench-live.ts "$V2/src" $n 2>/dev/null; done
echo; echo "### 5. Bundle size"; (cd "$ROOT" && node v2_new/tools/size.mjs)
echo; echo "### 6. Randomized stale-read check (seeds 1-200)"
T="$(mktemp -d)"; mkdir -p "$T/v2root"; ln -s "$V2/src" "$T/v2root/src"; ln -s "$ROOT/node_modules" "$T/v2root/node_modules"
for m in exact container; do
  bun tools/stale-check.ts "$ROOT" 1 200 $m 0 "$T/current-$m.txt" > /dev/null 2>&1
  bun tools/stale-check.ts "$T/v2root" 1 200 $m 0 "$T/v2-$m.txt" > /dev/null 2>&1
done
python3 tools/classify.py "$T"/current-exact.txt "$T"/current-container.txt "$T"/v2-exact.txt "$T"/v2-container.txt
