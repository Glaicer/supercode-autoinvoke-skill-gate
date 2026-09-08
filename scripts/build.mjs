import { transformAsync } from "@babel/core";
import presetTypeScript from "@babel/preset-typescript";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(root, "src");
const outputDir = join(root, "dist");

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const files = (await readdir(sourceDir)).filter(
  (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
);

for (const file of files) {
  const input = join(sourceDir, file);
  const source = await readFile(input, "utf8");

  const result = await transformAsync(source, {
    filename: input,
    configFile: false,
    babelrc: false,
    presets: [[presetTypeScript]],
  });
  if (!result?.code) throw new Error(`build: Babel produced no output for ${file}`);

  const output = result.code.replace(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.js$2");
  const target = join(outputDir, `${file.slice(0, -extname(file).length)}.js`);
  await writeFile(target, `${output}\n`);
}
