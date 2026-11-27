/**
 * 从 Termux 原始包提取 Android/Bionic 启动器；不复制 dsh-Go 的应用代码。
 * 版本和 SHA-256 对照其 runtime/build-runtime.sh 的已锁定输入。
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

const arch = { arm64: ['aarch64', 'arm64-v8a'], amd64: ['x86_64', 'x86_64'] }[process.argv[2]]
if (!arch) throw new Error('运行环境只支持 arm64 / amd64')
const [termuxArch, abi] = arch
const packages = [
  ['proot', '5.1.107.102', 'p', {
    aarch64: '10a394b585c2fc2b2c8502544f4e5f1be581dc8bfff79e8ba62f16207423e030',
    x86_64: '2497064226c15971be8131c7facead94a06c225347796326a383c832dca57758'
  }],
  ['libtalloc', '2.5.0', 'libt', {
    aarch64: '556591f43bb773ad8777e1a29522640866a55f95dab71914418b94a8c58ad5a7',
    x86_64: 'b8c6d95f20075dc1f9ec6573575b2444e8d526e48e0d8d6d5cf4e071e6e06530'
  }],
  ['libandroid-shmem', '0.7', 'liba', {
    aarch64: '0da3a24d558b93c92bcf8d611e0826a99ff96e396b148e6cdf33b47c47c57ff6',
    x86_64: 'ffa9e4c87467b158b148d0ff92dda796aa038276c2075af3269cdcdb06f25797'
  }]
]

await mkdir('unpacked', { recursive: true })
await mkdir(`jniLibs/${abi}`, { recursive: true })
await mkdir('notices', { recursive: true })
const provenance = []
for (const [name, version, prefix, hashes] of packages) {
  const file = `${name}_${version}_${termuxArch}.deb`
  const url = `https://packages.termux.dev/apt/termux-main/pool/main/${prefix}/${name}/${file}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== hashes[termuxArch]) {
    throw new Error(`${file}: SHA-256 不符`)
  }
  await writeFile(file, bytes)
  execFileSync('dpkg-deb', ['--extract', file, 'unpacked'], { stdio: 'inherit' })
  provenance.push({ name, version, url, sha256: hashes[termuxArch] })
}

const prefix = 'unpacked/data/data/com.termux/files/usr'
for (const [source, name] of [
  ['bin/proot', 'libproot.so'],
  ['libexec/proot/loader', 'libproot-loader.so'],
  ['lib/libtalloc.so.2.5.0', 'libtalloc.so'],
  ['lib/libandroid-shmem.so', 'libandroid-shmem.so']
]) {
  const bytes = await readFile(`${prefix}/${source}`)
  // Android 只打包 lib*.so；在 ELF 原字符串槽位内改名，不改变段布局。
  const oldName = Buffer.from('libtalloc.so.2\0')
  const newName = Buffer.alloc(oldName.length)
  newName.write('libtalloc.so')
  for (let at = bytes.indexOf(oldName); at !== -1; at = bytes.indexOf(oldName, at + oldName.length)) {
    newName.copy(bytes, at)
  }
  await writeFile(`jniLibs/${abi}/${name}`, bytes, { mode: 0o755 })
}

await writeFile('notices/termux-inputs.json', JSON.stringify(provenance, null, 2) + '\n')
// 许可证正文来自构建镜像或所校验的原始包，不能只打包一个上游链接。
for (const license of ['GPL-2', 'GPL-3', 'LGPL-3']) {
  await copyFile(`/usr/share/common-licenses/${license}`, `notices/${license}.txt`)
}
await copyFile(`${prefix}/share/doc/libandroid-shmem/copyright`, 'notices/libandroid-shmem-copyright.txt')
const tallocHeader = await readFile(`${prefix}/include/talloc.h`, 'utf8')
const noticeEnd = tallocHeader.indexOf('*/')
if (noticeEnd === -1) throw new Error('libtalloc 版权声明缺失')
await writeFile('notices/libtalloc-notice.txt', tallocHeader.slice(0, noticeEnd + 2) + '\n')
await writeFile('notices/SOURCES.txt', `Android launcher components (run as separate processes):
PRoot 5.1.107.102, GPL-2.0: https://github.com/termux/proot/tree/v5.1.107.102
libtalloc 2.5.0, LGPL-3.0-or-later: https://download.samba.org/pub/talloc/talloc-2.5.0.tar.gz
libandroid-shmem 0.7, BSD-3-Clause: https://github.com/termux/libandroid-shmem/tree/v0.7
Termux build recipes and Android patches: https://github.com/termux/termux-packages
Exact binary inputs and checksums: termux-inputs.json
Local binary modification: libtalloc.so.2 -> libtalloc.so in the existing ELF string slots.
The source and build script for that modification are apps/mobile/runtime/prepare-launcher.mjs in Fizz.
Debian, Node.js and npm dependencies retain their licenses inside the runtime archives.
These notices and source pointers do not replace the corresponding-source distribution obligations.
`)
