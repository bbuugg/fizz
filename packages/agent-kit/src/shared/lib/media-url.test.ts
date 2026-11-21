// APK 的 WebView 不与服务端同源：防止媒体请求误打到 localhost。
import { expect, it, vi } from 'vitest'
import { loadMediaObjectUrl } from './media-url'

vi.mock('@fizz/agent-client/host', () => ({
  getAgentHostOrNull: () => ({ capabilities: { localMediaFetch: false } }),
  getServerBaseOverride: () => 'http://192.0.2.1:7801'
}))
vi.mock('@fizz/agent-client/api', () => ({
  hostFetch: vi.fn(),
  resolveServerUrl: (base: string, path: string) => `${base}${path}`
}))

it('resolves uploaded images against the configured APK server and leaves external URLs alone', async () => {
  await expect(loadMediaObjectUrl('/api/uploads/example.png')).resolves.toBe('http://192.0.2.1:7801/api/uploads/example.png')
  await expect(loadMediaObjectUrl('https://example.org/image.png')).resolves.toBe('https://example.org/image.png')
  await expect(loadMediaObjectUrl('//example.org/image.png')).resolves.toBe('//example.org/image.png')
})
