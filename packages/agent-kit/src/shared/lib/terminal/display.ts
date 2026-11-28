/** 去掉 ANSI 转义序列，让终端原始文本变成纯文本（颜色 / 光标控制 / OSC 超链接） */
export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '') // OSC
    .replace(/\u001b[@-Z\\-_]/g, '') // 两字节转义
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

