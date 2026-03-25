import {
  type Arch,
  type BuildConfig,
  buildMcpServers,
  copyInterceptor,
  copySDK,
  downloadBun,
  downloadUv,
  loadEnvFile,
  verifySDKCopy,
} from './build/common'
import { cpSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'

function stageSessionServer(rootDir: string, electronDir: string): void {
  const source = join(rootDir, 'packages', 'session-mcp-server', 'dist', 'index.js')
  const dest = join(electronDir, '.client-build', 'resources', 'session-mcp-server', 'index.js')

  if (!existsSync(source)) {
    throw new Error(`Session MCP server not found at ${source}`)
  }

  mkdirSync(join(electronDir, '.client-build', 'resources', 'session-mcp-server'), { recursive: true })
  copyFileSync(source, dest)
}

function stagePiAgentServer(rootDir: string, electronDir: string, arch: Arch): void {
  const sourceDir = join(rootDir, 'packages', 'pi-agent-server', 'dist')
  const sourceIndex = join(sourceDir, 'index.js')
  if (!existsSync(sourceIndex)) return

  const destDir = join(electronDir, '.client-build', 'resources', 'pi-agent-server')
  rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })
  copyFileSync(sourceIndex, join(destDir, 'index.js'))

  const koffiSource = join(rootDir, 'node_modules', 'koffi')
  if (!existsSync(koffiSource)) return

  const koffiDest = join(destDir, 'node_modules', 'koffi')
  mkdirSync(koffiDest, { recursive: true })

  for (const entry of ['package.json', 'index.js', 'indirect.js', 'index.d.ts', 'lib']) {
    const src = join(koffiSource, entry)
    if (existsSync(src)) {
      cpSync(src, join(koffiDest, entry), { recursive: true })
    }
  }

  const targetDir = `darwin_${arch}`
  const nativeSrc = join(koffiSource, 'build', 'koffi', targetDir)
  const nativeDest = join(koffiDest, 'build', 'koffi', targetDir)

  if (existsSync(nativeSrc)) {
    mkdirSync(nativeDest, { recursive: true })
    cpSync(nativeSrc, nativeDest, { recursive: true })
    return
  }

  const buildSrc = join(koffiSource, 'build')
  if (existsSync(buildSrc)) {
    cpSync(buildSrc, join(koffiDest, 'build'), { recursive: true })
  }
}

async function main(): Promise<void> {
  const rootDir = join(import.meta.dir, '..')
  const electronDir = join(rootDir, 'apps', 'electron')
  const arch: Arch = process.arch === 'arm64' ? 'arm64' : 'x64'

  const config: BuildConfig = {
    platform: 'darwin',
    arch,
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir,
    electronDir,
  }

  await loadEnvFile(config)

  console.log(`Preparing client packaging assets for darwin-${arch}...`)

  rmSync(join(electronDir, '.client-build'), { recursive: true, force: true })

  await downloadBun(config)
  await downloadUv(config)
  copySDK(config)
  verifySDKCopy(config)
  copyInterceptor(config)
  buildMcpServers(config)
  stageSessionServer(rootDir, electronDir)
  stagePiAgentServer(rootDir, electronDir, arch)

  console.log('Client packaging assets prepared ✓')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
