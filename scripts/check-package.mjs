import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const target = manifest.exports?.["."];

assert.equal(target, "./dist/gate.js", "root export must be compiled JavaScript");
assert.equal(manifest.exports?.["./server"], "./dist/gate.js", "server export must resolve to the gate entry");

for (const entry of ["./dist/gate.js", "./dist/filter.js", "./dist/policy.js"]) {
  const code = readFileSync(resolve(root, entry), "utf8");
  assert.doesNotMatch(code, /from ["'][^"']+\.ts["']/, `compiled ${entry} must not import TypeScript`);
}

const gateCode = readFileSync(resolve(root, "./dist/gate.js"), "utf8");
assert.match(gateCode, /export default /, "compiled gate must keep a default export for loaders that require one");

const packed = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
  }),
);
const pack = Array.isArray(packed) ? packed[0] : (packed[manifest.name] ?? Object.values(packed)[0]);
const files = pack.files.map((file) => file.path);

assert.ok(files.includes("dist/gate.js"), "tarball must include the compiled gate entry");
assert.ok(files.includes("dist/filter.js"), "tarball must include the compiled filter");
assert.ok(files.includes("dist/policy.js"), "tarball must include the compiled policy");
assert.ok(!files.some((file) => file.endsWith(".ts")), "tarball must not include raw sources");

console.log("package artifact: compiled JS only");
