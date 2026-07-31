import assert from "node:assert/strict";
import test from "node:test";
import { summarizeVitestList } from "../scripts/fact-utils.mjs";

test("summarizeVitestList counts executed test definitions and unique files", () => {
  assert.deepEqual(summarizeVitestList([
    { name: "suite > first", file: "/repo/a.test.ts" },
    { name: "suite > parameterized 1", file: "/repo/a.test.ts" },
    { name: "suite > parameterized 2", file: "/repo/b.test.ts" },
  ]), { testFiles: 2, testCases: 3 });
});

test("summarizeVitestList rejects empty or malformed evidence", () => {
  assert.throws(() => summarizeVitestList([]), /no test cases/);
  assert.throws(() => summarizeVitestList({}), /not an array/);
});
