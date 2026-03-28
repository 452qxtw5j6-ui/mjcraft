/**
 * Cross-platform packaging resource staging script.
 *
 * Stages runtime assets that packaged apps need but that do not live in the
 * repo's committed resources tree:
 * - Claude SDK (for Anthropic subprocess sessions)
 * - Bundled Bun runtime
 * - Bundled uv binary
 * - Session MCP server
 * - Pi agent server (+ koffi native module)
 *
 * After staging, copies resources/ to dist/resources/ so electron-builder can
 * include either the primary resources path or the dist/resources fallback.
 */

import { existsSync, cpSync } from "fs";
import { join } from "path";
import {
  copyPiAgentServer,
  copySDK,
  copySessionServer,
  downloadBun,
  downloadUv,
  verifyMcpServersExist,
  verifySDKCopy,
  type Arch,
  type BuildConfig,
  type Platform,
} from "./build/common";

const ROOT_DIR = join(import.meta.dir, "..");
const ELECTRON_DIR = join(ROOT_DIR, "apps/electron");

function resolveBuildPlatform(): Platform {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "win32";
  if (process.platform === "linux") return "linux";
  throw new Error(`Unsupported platform for packaged assets: ${process.platform}`);
}

function resolveBuildArch(): Arch {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x64";
  throw new Error(`Unsupported architecture for packaged assets: ${process.arch}`);
}

async function main(): Promise<void> {
  const config: BuildConfig = {
    platform: resolveBuildPlatform(),
    arch: resolveBuildArch(),
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir: ROOT_DIR,
    electronDir: ELECTRON_DIR,
  };

  console.log(`📦 Staging packaged runtime assets for ${config.platform}-${config.arch}...`);

  copySDK(config);
  verifySDKCopy(config);

  copySessionServer(config);
  copyPiAgentServer(config);
  verifyMcpServersExist(config);

  await downloadBun(config);
  await downloadUv(config);

  const srcDir = join(ELECTRON_DIR, "resources");
  const destDir = join(ELECTRON_DIR, "dist/resources");

  if (!existsSync(srcDir)) {
    console.log("⚠️ No resources directory found");
    return;
  }

  cpSync(srcDir, destDir, { recursive: true, force: true });
  console.log("📦 Copied resources to dist");
}

main().catch((error) => {
  console.error("❌ Failed to stage packaged runtime assets:", error);
  process.exit(1);
});
