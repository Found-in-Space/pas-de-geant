import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const workspaceRoot = new URL("../", import.meta.url);
const temporaryRoot = await mkdtemp(join(tmpdir(), "shadowline-pack-"));
const consumerRoot = join(temporaryRoot, "consumer");

function run(command, arguments_, cwd = workspaceRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}.`));
    });
  });
}

try {
  await run("npm", [
    "pack",
    "--workspace",
    "@found-in-space/shadowline",
    "--pack-destination",
    temporaryRoot,
  ]);
  await run("npm", [
    "pack",
    "--workspace",
    "@found-in-space/shadowline-astronomy-engine",
    "--pack-destination",
    temporaryRoot,
  ]);
  await mkdir(consumerRoot);
  await writeFile(
    join(consumerRoot, "package.json"),
    JSON.stringify({ private: true, type: "module" }, null, 2),
  );
  const archives = (await readdir(temporaryRoot))
    .filter((name) => name.endsWith(".tgz"))
    .sort()
    .map((name) => join(temporaryRoot, name));
  if (archives.length !== 2) {
    throw new Error(`Expected two package archives, found ${archives.length}.`);
  }
  await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...archives,
    ],
    consumerRoot,
  );
  await run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'import { EclipseEngine } from "@found-in-space/shadowline";',
        'import { astronomyEngineCapabilities } from "@found-in-space/shadowline-astronomy-engine";',
        "const engine = new EclipseEngine(astronomyEngineCapabilities());",
        "const events = engine.eventsForYear(2026);",
        'if (events.length !== 2) throw new Error("Unexpected 2026 event count.");',
        'console.log(`Packed consumer found ${events.length} eclipses in 2026.`);',
      ].join("\n"),
    ],
    consumerRoot,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
