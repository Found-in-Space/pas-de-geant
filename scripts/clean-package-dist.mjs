import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const packageDirectory = process.cwd();
const manifest = JSON.parse(
  readFileSync(resolve(packageDirectory, "package.json"), "utf8"),
);
const publishablePackages = new Set([
  "@found-in-space/shadowline",
  "@found-in-space/shadowline-astronomy-engine",
]);

if (!publishablePackages.has(manifest.name)) {
  throw new Error(`Refusing to clean an unknown package: ${manifest.name}`);
}

rmSync(resolve(packageDirectory, "dist"), {
  recursive: true,
  force: true,
});
