/**
 * electron-builder afterPack hook
 *
 * Copies the pre-compiled macOS 26+ Liquid Glass icon (Assets.car) into the
 * app bundle. The Assets.car file is compiled locally using actool with the
 * macOS 26 SDK (not available in CI), then committed to the repo.
 *
 * To regenerate Assets.car after icon changes:
 *   cd apps/electron
 *   xcrun actool "resources/icon.icon" --compile "resources" \
 *     --app-icon AppIcon --minimum-deployment-target 26.0 \
 *     --platform macosx --output-partial-info-plist /dev/null
 *
 * For older macOS versions, the app falls back to icon.icns which is
 * included separately by electron-builder.
 */

const path = require('path');
const fs = require('fs');

module.exports = async function afterPack(context) {
  // Only process macOS builds
  if (context.electronPlatformName !== 'darwin') {
    console.log('Skipping Liquid Glass icon (not macOS)');
    return;
  }

  const appPath = context.appOutDir;
  const productFilename = context.packager.appInfo.productFilename;
  const resourcesDir = path.join(appPath, `${productFilename}.app`, 'Contents', 'Resources');
  const precompiledAssets = path.join(context.packager.projectDir, 'resources', 'Assets.car');
  const iconSourceSvg = path.join(context.packager.projectDir, 'resources', 'icon.icon', 'Assets', 'icon.svg');

  console.log(`afterPack: projectDir=${context.packager.projectDir}`);
  console.log(`afterPack: looking for Assets.car at ${precompiledAssets}`);

  // Check if pre-compiled Assets.car exists
  if (!fs.existsSync(precompiledAssets)) {
    console.log('Warning: Pre-compiled Assets.car not found in resources/');
    console.log('The app will use the fallback icon.icns on all macOS versions');
    return;
  }

  // If the source icon changed after Assets.car was compiled, prefer the newer icon.icns
  // instead of shipping a stale Liquid Glass asset.
  try {
    const assetsStat = fs.statSync(precompiledAssets);
    const svgStat = fs.existsSync(iconSourceSvg) ? fs.statSync(iconSourceSvg) : null;
    if (svgStat && svgStat.mtimeMs > assetsStat.mtimeMs) {
      console.log('Skipping stale Assets.car because icon.svg is newer; using icon.icns fallback');
      return;
    }
  } catch (err) {
    console.log(`Warning: Could not compare icon asset timestamps: ${err.message}`);
  }

  // Copy pre-compiled Assets.car to the app bundle
  const destAssetsCar = path.join(resourcesDir, 'Assets.car');
  try {
    fs.copyFileSync(precompiledAssets, destAssetsCar);
    console.log(`Liquid Glass icon copied: ${destAssetsCar}`);
  } catch (err) {
    // Don't fail the build if Assets.car can't be copied - app will use fallback icon.icns
    console.log(`Warning: Could not copy Assets.car: ${err.message}`);
    console.log('The app will use the fallback icon.icns on all macOS versions');
  }
};
