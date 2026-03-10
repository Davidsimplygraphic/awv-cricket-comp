const tests = [];

export function test(name, fn) {
  tests.push({ name, fn });
}

export async function run() {
  let failures = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${name}`);
      console.error(error?.stack || error);
    }
  }

  console.log(`Executed ${tests.length} test${tests.length === 1 ? "" : "s"}.`);

  if (failures) {
    console.error(`${failures} test${failures === 1 ? "" : "s"} failed.`);
    process.exitCode = 1;
  }
}
