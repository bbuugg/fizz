/** 原生宿主提供 JWT 密钥和端口，其余装配仍走同一个 Fizz server。 */
import { randomBytes, scryptSync } from 'node:crypto'
import { startRuntimeDnsSync } from './mobile-dns.mjs'

if (!process.env.FIZZ_JWT_SECRET || process.env.FIZZ_HOST !== '127.0.0.1') {
  throw new Error('手机本机引擎必须由原生宿主启动')
}

// 不开放「首次登录设置密码」：本机凭据由原生桥交给 WebView，不能让别的应用抢注密码。
const salt = randomBytes(16)
const hash = scryptSync(randomBytes(32), salt, 64)
process.env.FIZZ_AUTH_PASS = `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`
process.env.FIZZ_AUTH_CAPTCHA = '0'
process.env.FIZZ_DATA_DIR = '/data'
process.env.HOME = '/root'
process.env.GIT_CONFIG_GLOBAL = '/root/.gitconfig'
process.env.UV_USE_IO_URING = '0'

// 原生层会在切网时原子替换 resolv.conf，Node 的 resolve 系列也要跟随更新。
startRuntimeDnsSync()

await import('./apps/server/dist/index.js')
