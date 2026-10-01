import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const script = fileURLToPath(new URL("./test-ios.sh", import.meta.url));
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function run(devices, simulatorID = "") {
  const directory = mkdtempSync(join(tmpdir(), "zimlo-ios-selector-test-"));
  directories.push(directory);
  const inventory = join(directory, "devices.json");
  const argumentsPath = join(directory, "xcodebuild-arguments.txt");
  writeFileSync(inventory, JSON.stringify({ devices }));
  writeFileSync(join(directory, "xcrun"), '#!/bin/sh\ncat "$ZIMLO_TEST_SIMULATOR_JSON"\n', { mode: 0o755 });
  writeFileSync(join(directory, "xcodebuild"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$ZIMLO_TEST_XCODEBUILD_ARGS"\n', { mode: 0o755 });
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      ZIMLO_IOS_SIMULATOR_ID: simulatorID,
      ZIMLO_TEST_SIMULATOR_JSON: inventory,
      ZIMLO_TEST_XCODEBUILD_ARGS: argumentsPath,
    },
  });
  return { ...result, argumentsPath };
}

const runtime = (value) => `com.apple.CoreSimulator.SimRuntime.${value}`;
const phone = (udid, state = "Shutdown", isAvailable = true) => ({ name: "iPhone 14", udid, state, isAvailable });

test("skips a booted iOS 16 device and selects a compatible shutdown iPhone", () => {
  const result = run({
    [runtime("iOS-16-4")]: [phone("old-booted", "Booted")],
    [runtime("iOS-17-0")]: [phone("compatible")],
  });
  expect(result.status).toBe(0);
  expect(readFileSync(result.argumentsPath, "utf8")).toContain("platform=iOS Simulator,id=compatible\n");
});

test("prefers a booted compatible iPhone over other compatible shutdown devices", () => {
  const result = run({
    [runtime("iOS-16-4")]: [phone("old-booted", "Booted")],
    [runtime("iOS-17-0")]: [phone("compatible-shutdown")],
    [runtime("iOS-18-0-1")]: [phone("compatible-booted", "Booted")],
  });
  expect(result.status).toBe(0);
  expect(readFileSync(result.argumentsPath, "utf8")).toContain("platform=iOS Simulator,id=compatible-booted\n");
});

test("fails before xcodebuild when no available compatible iPhone exists", () => {
  const result = run({
    [runtime("iOS-16-4")]: [phone("old", "Booted")],
    [runtime("iOS-18-0")]: [phone("unavailable", "Booted", false), { ...phone("ipad"), name: "iPad Pro" }],
    [runtime("tvOS-18-0")]: [phone("other-platform")],
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("No available iPhone simulator runtime meets the project deployment target");
  expect(() => readFileSync(result.argumentsPath)).toThrow();
});

test("keeps an explicitly selected simulator without consulting automatic selection", () => {
  const result = run({}, "explicit-device");
  expect(result.status).toBe(0);
  expect(readFileSync(result.argumentsPath, "utf8")).toContain("platform=iOS Simulator,id=explicit-device\n");
});
