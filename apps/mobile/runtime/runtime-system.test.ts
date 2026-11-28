// 防止安卓 rootfs 漏装 bubblewrap，导致 Linux 沙箱探针找不到 bwrap。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('Android runtime system packages', () => {
  it('installs bubblewrap in the system image exported to the APK', () => {
    const dockerfile = readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8')
    const systemStage = dockerfile.split(/^FROM /m)
      .find((stage) => stage.startsWith('node:24-bookworm-slim AS system\n'))
    const install = systemStage?.match(/apt-get install\s+-y\s+--no-install-recommends\s+([\s\S]*?)&&/)

    expect(install).toBeTruthy()
    const packages = install![1]!.replace(/\\\r?\n/g, ' ').trim().split(/\s+/)
    expect(packages).toContain('bubblewrap')
    expect(dockerfile).toContain('FROM system AS system-archive')
    expect(dockerfile).toContain('COPY --from=system-archive /out/system.tgz /assets/fizz-runtime/system.tgz')
  })
})
