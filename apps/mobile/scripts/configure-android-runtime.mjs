/** android/ 是生成物：在 cap sync 后恢复本机运行时的资源、ABI 与执行权限配置。 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const mobile = resolve(import.meta.dirname, '..')
const gradle = join(mobile, 'android/app/build.gradle')
const abi = process.env.FIZZ_ANDROID_ABI ?? 'arm64-v8a'
if (!['arm64-v8a', 'x86_64'].includes(abi)) throw new Error('FIZZ_ANDROID_ABI 只支持 arm64-v8a / x86_64')
if (!existsSync(gradle)) throw new Error('先运行 npm run add:android --workspace @fizz/mobile')
const bundle = join(mobile, 'runtime/out', abi)
const manifestPath = join(bundle, 'assets/fizz-runtime/manifest.json')
if (!existsSync(manifestPath)) {
  throw new Error(`缺少 ${abi} 本机运行环境，先运行 npm run build:mobile:runtime -- ${abi}`)
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const version = JSON.parse(readFileSync(join(mobile, '../desktop/package.json'), 'utf8')).version
if (manifest.format !== 1 || manifest.abi !== abi || manifest.appVersion !== version) {
  throw new Error('运行环境架构或版本与 APK 不匹配，请重新运行 build:mobile:runtime')
}
for (const [path, expected] of [
  ['assets/fizz-runtime/system.tgz', manifest.system],
  ['assets/fizz-runtime/engine.tgz', manifest.engine],
  ...['libproot.so', 'libproot-loader.so', 'libtalloc.so', 'libandroid-shmem.so']
    .map((file) => [`jniLibs/${abi}/${file}`, manifest.launcher?.[file]])
]) {
  const fullPath = join(bundle, path)
  if (!existsSync(fullPath)) throw new Error(`运行环境缺少 ${path}，请重新构建`)
  if (path.endsWith('.tgz') && expected?.file !== path.split('/').pop()) {
    throw new Error(`${path} 与清单文件名不符，请重新运行 build:mobile:runtime`)
  }
  if (!expected || expected.bytes !== statSync(fullPath).size) throw new Error(`${path} 清单或大小不符，请重新构建`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(fullPath)) hash.update(chunk)
  if (hash.digest('hex') !== expected.sha256) throw new Error(`${path} SHA-256 不符，请重新构建`)
}
for (const file of ['GPL-2.txt', 'GPL-3.txt', 'LGPL-3.txt', 'libandroid-shmem-copyright.txt', 'libtalloc-notice.txt', 'SOURCES.txt', 'termux-inputs.json']) {
  if (!existsSync(join(bundle, 'assets/fizz-runtime/notices', file))) throw new Error(`运行环境缺少许可证或来源说明：${file}`)
}

function replaceBlock(path, marker, block) {
  const original = readFileSync(path, 'utf8')
  const stripped = original.replace(new RegExp(`\\n?// >>> ${marker}[\\s\\S]*?// <<< ${marker}\\n?`), '\n').trimEnd()
  const next = `${stripped}\n\n// >>> ${marker}\n${block}\n// <<< ${marker}\n`
  if (next !== original) writeFileSync(path, next)
}

// Android 10 的私有目录 exec 限制按 targetSdk 生效。与 dsh-Go 一样，这是侧载 APK。
replaceBlock(join(mobile, 'android/variables.gradle'), 'fizz-runtime-sdk', `ext {
    minSdkVersion = 26
    targetSdkVersion = 28
}`)
replaceBlock(gradle, 'fizz-local-runtime', `android {
    defaultConfig {
        minSdkVersion 26
        targetSdkVersion 28
        ndk { abiFilters.clear(); abiFilters.add('${abi}') }
    }
    sourceSets.main {
        assets.srcDir '../../runtime/out/${abi}/assets'
        jniLibs.srcDir '../../runtime/out/${abi}/jniLibs'
    }
    packagingOptions.jniLibs {
        useLegacyPackaging = true
        keepDebugSymbols += ['**/libproot.so', '**/libproot-loader.so', '**/libtalloc.so', '**/libandroid-shmem.so']
    }
    androidResources { noCompress += ['tgz'] }
    lint { disable += ['ExpiredTargetSdkVersion'] }
}`)
console.log(`[mobile] 本机运行环境已接入 APK（${abi}，targetSdk 28，minSdk 26）`)
