const BUN_TEST_ENTRY_PATTERN = /[._](?:test|spec)\.[cm]?[jt]sx?$/;

/** True when the process is an explicitly marked test child or Bun is running a test entrypoint. */
export function isBunTestRuntime(): boolean {
	if (process.env.PI_TEST_RUNTIME === "1") return true;
	const hasTestEnvironment = process.env.BUN_ENV === "test" || process.env.NODE_ENV === "test";
	return (
		hasTestEnvironment && BUN_TEST_ENTRY_PATTERN.test(typeof Bun === "undefined" ? (process.argv[1] ?? "") : Bun.main)
	);
}
