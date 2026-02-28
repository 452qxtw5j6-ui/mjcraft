/**
 * Cross-platform asset copy script.
 *
 * Copies the resources/ directory to dist/resources/.
 * All bundled assets (docs, themes, permissions, tool-icons) now live in resources/
 * which electron-builder handles natively via directories.buildResources.
 *
 * At Electron startup, setBundledAssetsRoot(__dirname) is called, and then
 * getBundledAssetsDir('docs') resolves to <__dirname>/resources/docs/, etc.
 *
 * Run: bun scripts/copy-assets.ts
 */

import { cpSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Copy all resources (icons, themes, docs, permissions, tool-icons, etc.)
cpSync('resources', 'dist/resources', { recursive: true });

console.log('✓ Copied resources/ → dist/resources/');

// Copy PowerShell parser script (for Windows command validation in Explore mode)
// Source: packages/shared/src/agent/powershell-parser.ps1
// Destination: dist/resources/powershell-parser.ps1
const psParserSrc = join('..', '..', 'packages', 'shared', 'src', 'agent', 'powershell-parser.ps1');
const psParserDest = join('dist', 'resources', 'powershell-parser.ps1');
try {
  copyFileSync(psParserSrc, psParserDest);
  console.log('✓ Copied powershell-parser.ps1 → dist/resources/');
} catch (err) {
  // Only warn - PowerShell validation is optional on non-Windows platforms
  console.log('⚠ powershell-parser.ps1 copy skipped (not critical on non-Windows)');
}

// Copy Pi agent server build output into packaged runtime resources
// Source: packages/pi-agent-server/dist/index.js
// Destination: dist/resources/pi-agent-server/index.js
const piServerSrc = join('..', '..', 'packages', 'pi-agent-server', 'dist', 'index.js');
const piServerDir = join('dist', 'resources', 'pi-agent-server');
const piServerDest = join(piServerDir, 'index.js');
try {
  if (existsSync(piServerSrc)) {
    mkdirSync(piServerDir, { recursive: true });
    copyFileSync(piServerSrc, piServerDest);
    console.log('✓ Copied pi-agent-server → dist/resources/pi-agent-server/');
  } else {
    console.log('⚠ pi-agent-server copy skipped: source dist/index.js not found');
  }
} catch {
  console.log('⚠ pi-agent-server copy failed (Pi sessions may not work in packaged builds)');
}
