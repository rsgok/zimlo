#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const itemPattern = /\s*<item\b[\s\S]*?<\/item>/gu;

function itemsFrom(xml) {
  return [...xml.matchAll(itemPattern)].map((match) => match[0].trim());
}

function itemForFile(xml, fileName) {
  const item = itemsFrom(xml).find((candidate) => candidate.includes(fileName));
  if (!item) {
    throw new Error(`Appcast does not contain ${fileName}.`);
  }
  if (!item.includes("sparkle:edSignature=")) {
    throw new Error(`Appcast item for ${fileName} is not signed.`);
  }
  return item;
}

export function mergeLegacyAppcast({ legacyXml, armXml, intelXml, armFileName, intelFileName }) {
  const armItem = itemForFile(armXml, armFileName);
  const intelItem = itemForFile(intelXml, intelFileName);
  const baseXml = legacyXml ?? armXml;
  const withoutCurrentRelease = baseXml.replace(itemPattern, (item) => {
    return item.includes(armFileName) || item.includes(intelFileName) ? "" : item;
  });
  const insertion = `\n    ${armItem}\n    ${intelItem}\n`;
  const firstItem = withoutCurrentRelease.search(/<item\b/u);

  if (firstItem >= 0) {
    return `${withoutCurrentRelease.slice(0, firstItem)}${insertion}${withoutCurrentRelease.slice(firstItem)}`;
  }

  const channelEnd = withoutCurrentRelease.indexOf("</channel>");
  if (channelEnd < 0) {
    throw new Error("Legacy appcast does not contain a channel element.");
  }
  return `${withoutCurrentRelease.slice(0, channelEnd)}${insertion}${withoutCurrentRelease.slice(channelEnd)}`;
}

function main(args) {
  if (args.length !== 6) {
    throw new Error("usage: merge-legacy-appcast.mjs LEGACY ARM INTEL ARM_DMG INTEL_DMG OUTPUT");
  }
  const [legacyPath, armPath, intelPath, armFileName, intelFileName, outputPath] = args;
  const merged = mergeLegacyAppcast({
    legacyXml: existsSync(legacyPath) ? readFileSync(legacyPath, "utf8") : null,
    armXml: readFileSync(armPath, "utf8"),
    intelXml: readFileSync(intelPath, "utf8"),
    armFileName,
    intelFileName,
  });
  writeFileSync(outputPath, merged, { mode: 0o644 });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2));
}
