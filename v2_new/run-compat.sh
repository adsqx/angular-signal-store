#!/usr/bin/env bash
# Runs the current store's tests and examples against v2 (copies them so '../src' resolves to v2_new/src).
# Usage: bash v2_new/run-compat.sh   (from the repo root or v2_new)
set -u
cd "$(dirname "$0")"
rm -rf test examples && mkdir -p test examples
cp ../test/smoke.ts ../test/regressions.test.ts ../test/draft.test.ts ../test/jsnq-optional.test.ts ../test/store-throughput-bench.ts test/
cp ../examples/*.ts examples/
# v2 has no version signals: the regression that counts them checks an internal of the current store only.
sed -i "s#const versionNodes = () => (ss.getStore(name).createServiceGetter as any).versions.keys().length as number;#const versionNodes = () => 0; // v2: no version nodes exist#" test/regressions.test.ts
sed -i "s#assert(versionNodes() > before, '\[bug2a\] a reactive probe of a missing key tracks its version');#// v2: internal version-node count not applicable (the behaviour is covered by the cases above)#" test/regressions.test.ts
cat > examples/tsconfig.json <<'JSON'
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "noEmit": true, "declaration": false, "declarationMap": false, "sourceMap": false, "rootDir": "../..", "baseUrl": ".", "types": [],
    "paths": {
      "@adsq/angular-signal-store": ["../src/index.ts"],
      "@adsq/angular-signal-store/jsnq": ["../src/jsnq.ts"],
      "@adsq/angular-signal-store/devtools": ["../src/devtools.ts"]
    }
  },
  "include": ["0*.ts", "_check.ts"]
}
JSON
for t in smoke.ts regressions.test.ts draft.test.ts jsnq-optional.test.ts; do
  echo "== $t"
  bun "test/$t" 2>&1 | grep -vE "^\s+at |^$" | tail -12
  echo "   exit: ${PIPESTATUS[0]}"
done
echo "== examples"
bun examples/run-all.ts 2>&1 | grep -E "===|FAIL|fail|Error|passed" | head -30
