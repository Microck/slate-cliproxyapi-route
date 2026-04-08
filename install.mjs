#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.join(repoDir, "files");
const targetDir = path.join(os.homedir(), ".local", "bin");
const backupRoot = path.join(
  os.homedir(),
  ".local",
  "share",
  "slate-cliproxyapi-route",
  "backups"
);
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(backupRoot, timestamp);
const files = ["slate", "slate-randomlabs-proxy.js"];

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

await fs.mkdir(targetDir, { recursive: true });
await fs.mkdir(backupDir, { recursive: true });

for (const file of files) {
  const sourcePath = path.join(sourceDir, file);
  const targetPath = path.join(targetDir, file);
  const backupPath = path.join(backupDir, file);

  if (await pathExists(targetPath)) {
    await fs.copyFile(targetPath, backupPath);
  }

  await fs.copyFile(sourcePath, targetPath);
  await fs.chmod(targetPath, 0o755);
}

console.log(`Installed Slate CLIProxyAPI route to ${targetDir}`);
console.log(`Backups saved under ${backupDir}`);
console.log("Next: launch `slate` and verify `/v3/stream` rewrites in the traffic log.");
