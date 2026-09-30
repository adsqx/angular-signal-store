/** Tiny assertion helper shared by the examples: prints `ok  <label>` or throws. */
export function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAILED ${label}: got ${a}, expected ${e}`);
  console.log(`  ok  ${label}`);
}

export function section(title: string): void {
  console.log(`\n${title}`);
}
