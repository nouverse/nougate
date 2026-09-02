/**
 * The version this build reports, as a constant.
 *
 * It was read from `package.json` at runtime, in two places, through `projectPath()`. That works
 * from a checkout and from the Docker image, and it cannot work at all in a `bun build --compile`
 * binary: there is no `package.json` on disk beside the executable, so startup ended in a throw
 * before the server was ever reached.
 *
 * A constant is the whole fix, because the version is the only thing either caller wanted. Nothing
 * else in the file was read.
 *
 * **Kept in step by a test, not by discipline.** `tests/unit/version-constant.test.ts` compares this
 * against `package.json` and fails the build when they drift — which is the part that makes a
 * hardcoded version safe. Bump both together, or let the test tell you that you did not.
 */
export const NOUGATE_VERSION = '0.7.0';
