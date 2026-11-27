import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 只收集源码测试，避免桌面打包后的插件副本被再次执行。
    exclude: [
      ...configDefaults.exclude,
      '**/dist/**',
      '**/dist-server/**',
      'apps/desktop/out/**',
      'apps/desktop/release/**'
    ]
  }
})
