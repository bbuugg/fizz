/** 构建供 APK 内置的本机运行环境（构建机需要 Docker Buildx）。 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createGunzip } from 'node:zlib'

const root = resolve(import.meta.dirname, '../../..')
const abi = process.argv[2] ?? process.env.FIZZ_ANDROID_ABI ?? 'arm64-v8a'
const platform = { 'arm64-v8a': 'linux/arm64', x86_64: 'linux/amd64' }[abi]
if (!platform) throw new Error('用法：node scripts/build-runtime.mjs [arm64-v8a|x86_64]')
const out = join(root, 'apps/mobile/runtime/out', abi)
await mkdir(out, { recursive: true })
// 导出中断时旧清单不能继续被 cap sync 当作有效产物。
await rm(join(out, 'assets/fizz-runtime/manifest.json'), { force: true })
// local 导出不会清理旧资源；避免升级后仍把会被 Android 自动解压的旧 .gz 归档打进 APK。
for (const file of ['system.tar.gz', 'engine.tar.gz']) {
  await rm(join(out, 'assets/fizz-runtime', file), { force: true })
}
const result = spawnSync('docker', [
  'buildx', 'build', '--platform', platform,
  '--file', 'apps/mobile/runtime/Dockerfile',
  '--output', `type=local,dest=${out}`, '.'
], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

async function checksum(path) {
  const sha256 = createHash('sha256')
  for await (const chunk of createReadStream(path)) sha256.update(chunk)
  return { sha256: sha256.digest('hex'), bytes: (await stat(path)).size }
}

async function archive(name) {
  const path = join(out, 'assets/fizz-runtime', name)
  let unpackedBytes = 0
  for await (const chunk of createReadStream(path).pipe(createGunzip())) unpackedBytes += chunk.length
  return { file: name, ...await checksum(path), unpackedBytes }
}

const version = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8')).version
const manifest = {
  format: 1, abi, appVersion: version, systemVersion: 'bookworm-node24-v1',
  system: await archive('system.tgz'), engine: await archive('engine.tgz'),
  launcher: Object.fromEntries(await Promise.all(
    ['libproot.so', 'libproot-loader.so', 'libtalloc.so', 'libandroid-shmem.so']
      .map(async (file) => [file, await checksum(join(out, 'jniLibs', abi, file))])
  ))
}
await writeFile(join(out, 'assets/fizz-runtime/manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`[mobile] ${abi} 运行环境已生成：${out}`)
