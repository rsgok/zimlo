import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../web/dist");
const destination = resolve(here, "../public");

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });

// The Bridge may stay alive while the web app is rebuilt. Keep the shipped
// entrypoint self-contained so an already-running server never points at a
// content-hashed asset route that was registered by an older build.
const indexPath = resolve(destination, "index.html");
let index = await readFile(indexPath, "utf8");
const scriptTag = index.match(/<script type="module" crossorigin src="([^"]+)"><\/script>/u);
const styleTag = index.match(/<link rel="stylesheet" crossorigin href="([^"]+)">/u);

if (!scriptTag?.[1] || !styleTag?.[1]) {
  throw new Error("无法在 Web 构建中找到入口脚本或样式。");
}

const script = await readFile(resolve(destination, scriptTag[1].replace(/^\//u, "")), "utf8");
const style = await readFile(resolve(destination, styleTag[1].replace(/^\//u, "")), "utf8");
index = index
  .replace(scriptTag[0], () => `<script type="module">${script.replaceAll("</script", "<\\/script")}</script>`)
  .replace(styleTag[0], () => `<style>${style.replaceAll("</style", "<\\/style")}</style>`);
await writeFile(indexPath, index);
