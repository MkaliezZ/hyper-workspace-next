import { randomBytes } from "node:crypto";
import { lstat, mkdir, chmod, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// A private parent directory permits a read-only non-root container mount without
// exposing the secret through environment variables or command-line arguments.
const directory = fileURLToPath(new URL("../.runtime/office-guard/", import.meta.url));
const target = fileURLToPath(new URL("../.runtime/office-guard/secret", import.meta.url));
try {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error();
  await chmod(directory, 0o700);
  try {
    await writeFile(target, randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o444 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await lstat(target);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 ||
        !/^[a-f0-9]{64}\n?$/.test(await readFile(target, "utf8"))) throw new Error();
  }
  await chmod(target, 0o444);
  process.stdout.write("Private Office guard secret is ready; existing values were preserved.\n");
} catch {
  process.stderr.write("Office guard secret initialization failed; inspect the private staging directory.\n");
  process.exitCode = 1;
}
