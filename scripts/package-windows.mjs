import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let runDir

function directory(path) {
  const entry = lstatSync(path)
  if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync.native(path).toLowerCase() !== resolve(path).toLowerCase()) {
    throw new Error(`目录必须是工程内的普通目录：${path}`)
  }
}

function file(path) {
  const entry = lstatSync(path)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0) throw new Error(`文件缺失、为空或不是普通文件：${path}`)
  return entry
}

function inside(parent, path) {
  const part = relative(parent, path)
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

async function sha256(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

function typecheck(config) {
  console.log(`检查 ${config}`)
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [join(projectDir, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', join(projectDir, config)], {
      cwd: projectDir, stdio: 'inherit', shell: false, windowsHide: true,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? accept() : reject(new Error(`${config} 检查失败（${signal ?? code}）。`)))
  })
}

async function packageWindows() {
  const [target, ...extra] = process.argv.slice(2)
  if (!['dir', 'zip'].includes(target) || extra.length) throw new Error('请使用 npm run pack:win 或 npm run dist:win。')
  if (process.platform !== 'win32' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) !== 24) {
    throw new Error('Windows x64 交付需要 Windows x64 与 Node.js 24。')
  }
  directory(projectDir)
  process.chdir(projectDir)
  const packagePath = join(projectDir, 'package.json')
  const lockPath = join(projectDir, 'package-lock.json')
  file(packagePath)
  try { file(lockPath) } catch { throw new Error('尚无可用的 package-lock.json。请先在获准安装依赖后生成并审查锁文件，再执行交付。') }
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8'))
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  if (lock.lockfileVersion !== 3 || lock.name !== metadata.name || lock.version !== metadata.version || !lock.packages?.['']) {
    throw new Error('锁文件与项目身份、版本或 npm 锁文件格式不符。')
  }
  directory(join(projectDir, 'node_modules'))
  for (const field of ['dependencies', 'devDependencies']) {
    const declared = metadata[field] ?? {}
    const locked = lock.packages[''][field] ?? {}
    if (Object.keys(declared).length !== Object.keys(locked).length) throw new Error(`${field} 与锁文件不一致。`)
    for (const [name, version] of Object.entries(declared)) {
      if (locked[name] !== version || lock.packages[`node_modules/${name}`]?.version !== version) {
        throw new Error(`${name} 的声明版本与锁文件不一致。`)
      }
      const installedPath = join(projectDir, 'node_modules', name, 'package.json')
      file(installedPath)
      if (JSON.parse(readFileSync(installedPath, 'utf8')).version !== version) throw new Error(`${name} 的已安装版本与声明不一致。`)
    }
  }
  const packageHash = await sha256(packagePath)
  const lockHash = await sha256(lockPath)
  await typecheck('tsconfig.node.json')
  await typecheck('tsconfig.web.json')

  const outputRoot = join(projectDir, 'dist')
  try { mkdirSync(outputRoot) } catch (error) { if (error.code !== 'EEXIST') throw error }
  directory(outputRoot)
  // 每次使用独占新目录，保留旧交付和失败产物，避免混入旧构建块或覆盖已有文件。
  runDir = mkdtempSync(join(outputRoot, `windows-x64-${new Date().toISOString().replace(/[:.]/g, '-')}-`))
  directory(runDir)
  const bundleDir = join(runDir, 'bundle')
  const artifactDir = join(runDir, 'artifacts')
  const resourceDir = join(runDir, 'resources')
  mkdirSync(bundleDir)
  mkdirSync(resourceDir)
  console.log(`本次交付目录：${runDir}`)

  const { build } = await import('electron-vite')
  await build({ configFile: join(projectDir, 'electron.vite.config.ts'), mode: 'production', envFile: false,
    build: { outDir: bundleDir, emptyOutDir: false, sourcemap: false } })
  for (const entry of ['main/index.js', 'main/service.js', 'preload/index.js', 'renderer/index.html']) file(join(bundleDir, entry))

  const { build: distribute, Platform, Arch } = await import('electron-builder')
  let unpackedDir
  const artifacts = await distribute({
    projectDir, targets: Platform.WINDOWS.createTarget(target, Arch.x64), publish: 'never',
    config: {
      appId: 'io.storyweave.desktop', productName: 'StoryWeave', extends: null,
      electronVersion: metadata.devDependencies.electron, buildVersion: metadata.version,
      directories: { app: projectDir, output: artifactDir, buildResources: resourceDir },
      // 根目录只取包信息；应用代码仅来自本次构建，生产依赖由打包器按依赖树收集。
      files: ['package.json', { from: bundleDir, to: 'out', filter: ['**/*', '!**/*.map'] }],
      asar: true, asarUnpack: ['node_modules/better-sqlite3/**'],
      npmRebuild: true, nativeRebuilder: 'sequential', allowMissingDependencies: false,
      publish: null, artifactName: 'StoryWeave-${version}-windows-${arch}.${ext}',
      win: { executableName: 'StoryWeave', icon: join(projectDir, 'resources/storyweave.ico'), requestedExecutionLevel: 'asInvoker', signExecutable: false },
      afterPack: async (context) => {
        if (!inside(artifactDir, context.appOutDir)) throw new Error('打包产物超出本次交付目录。')
        directory(context.appOutDir)
        for (const entry of ['StoryWeave.exe', 'resources/app.asar',
          'resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/win32-x64.node']) file(join(context.appOutDir, entry))
        unpackedDir = context.appOutDir
      },
    },
  })
  if (!unpackedDir || (target === 'zip' && !artifacts.some((path) => path.endsWith('.zip')))) throw new Error('交付产物不完整。')
  if (await sha256(packagePath) !== packageHash || await sha256(lockPath) !== lockHash) throw new Error('交付期间依赖声明或锁文件发生变化，请核对本次产物后重新交付。')
  const files = []
  for (const path of artifacts) {
    if (!inside(artifactDir, path)) throw new Error('返回的交付文件超出本次目录。')
    const entry = file(path)
    files.push({ path: relative(runDir, path).split(sep).join('/'), bytes: entry.size, sha256: await sha256(path) })
  }
  // 清单记录构建来源与校验值；运行验收仍须使用本次生成的正式包独立完成。
  writeFileSync(join(runDir, 'release-manifest.json'), JSON.stringify({
    format: 'storyweave-desktop-release', version: 1, createdAt: new Date().toISOString(),
    appVersion: metadata.version, electronVersion: metadata.devDependencies.electron, nodeVersion: process.versions.node,
    platform: 'win32', arch: 'x64', target, signed: false, runtimeVerified: false,
    packageJsonSha256: packageHash, packageLockSha256: lockHash,
    unpackedDirectory: relative(runDir, unpackedDir).split(sep).join('/'), files,
  }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  console.log(`交付产物已生成，尚待运行验收：${runDir}`)
}

packageWindows().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Windows 交付未完成。')
  if (runDir) console.error(`本次已产生的文件保留在：${runDir}`)
  process.exitCode = 1
})
