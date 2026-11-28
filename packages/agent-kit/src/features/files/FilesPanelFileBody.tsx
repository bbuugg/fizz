import { FileMarkdownPreview } from '@fizz/agent-kit/features/files/FileMarkdownPreview'
import { FileHtmlPreview, type HtmlPreviewSource } from '@fizz/agent-kit/features/files/FileHtmlPreview'
import MonacoEditor, { monacoLanguageOf } from '@fizz/agent-kit/features/files/MonacoEditor'
import type { DiffTab, OpenTab } from '@fizz/agent-kit/features/files/files-panel-types'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { File as FileIcon, Files, Loader2 } from 'lucide-react'
import { FileDiffView } from '@fizz/agent-kit/features/git/FileDiffView'

/** 文件面板右侧的文件内容：错误、预览、媒体和 Monaco 编辑器。 */
export function FilesPanelFileBody({
  activeTab,
  diffTab,
  panelError,
  fileName,
  showPreview,
  source,
  wordWrap,
  lineNumbers,
  onChange,
  onZoom
}: {
  activeTab: OpenTab | null
  diffTab: DiffTab | null
  panelError: string | null
  fileName: string | null
  showPreview: boolean
  source?: HtmlPreviewSource
  wordWrap: 'on' | 'off'
  lineNumbers: boolean
  onChange: (value: string) => void
  onZoom: (src: string | null) => void
}) {
  const t = useT()

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {diffTab ? (
        diffTab.loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t('读取 diff…')}
          </div>
        ) : diffTab.error ? (
          <div className="flex h-full items-center justify-center px-6">
            <div className="max-w-md text-center text-sm text-foreground">
              <FileIcon className="mx-auto mb-2 size-8 opacity-30" />
              {diffTab.error}
            </div>
          </div>
        ) : (
          <div className="h-full overflow-auto">
            <FileDiffView
              path={
                diffTab.commit
                  ? t('{path}（提交 {short}）', {
                      path: diffTab.commit.label,
                      short: diffTab.commit.short
                    })
                  : diffTab.staged
                    ? t('{path}（已暂存）', { path: diffTab.path })
                    : diffTab.path
              }
              hunks={diffTab.hunks ?? []}
              deleted={diffTab.deleted}
              wrap
            />
          </div>
        )
      ) : panelError ? (
        <div className="flex h-full items-center justify-center px-6">
          <div className="max-w-md text-center text-sm text-foreground">
            <FileIcon className="mx-auto mb-2 size-8 opacity-30" />
            {panelError}
          </div>
        </div>
      ) : activeTab && activeTab.kind === 'binary' ? (
        <div className="flex h-full items-center justify-center px-6">
          <div className="text-center text-sm text-foreground">
            <FileIcon className="mx-auto mb-2 size-8 opacity-30" />
            {t('该文件类型不支持预览')}
          </div>
        </div>
      ) : activeTab && activeTab.kind === 'markdown' && activeTab.viewMode === 'preview' ? (
        activeTab.loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="h-full overflow-auto">
            <FileMarkdownPreview markdown={activeTab.content} />
          </div>
        )
      ) : activeTab && activeTab.kind === 'html' && activeTab.viewMode === 'preview' ? (
        activeTab.loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <FileHtmlPreview html={activeTab.content} source={source} path={activeTab.path} />
        )
      ) : activeTab && showPreview ? (
        <div className="flex h-full items-center justify-center overflow-auto p-4">
          {activeTab.mediaLoading ? (
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          ) : activeTab.kind === 'image' || activeTab.kind === 'svg' ? (
            activeTab.mediaUrl ? (
              <img
                src={activeTab.mediaUrl}
                alt={fileName ?? 'preview'}
                onClick={() => onZoom(activeTab.mediaUrl)}
                className="max-h-full max-w-full cursor-zoom-in object-contain"
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t('预览加载失败')}</p>
            )
          ) : activeTab.kind === 'video' ? (
            activeTab.mediaUrl ? (
              <video src={activeTab.mediaUrl} controls className="max-h-full max-w-full" style={{ maxWidth: '100%' }} />
            ) : (
              <p className="text-sm text-muted-foreground">{t('预览加载失败')}</p>
            )
          ) : activeTab.mediaUrl ? (
            <audio src={activeTab.mediaUrl} controls className="w-96" />
          ) : (
            <p className="text-sm text-muted-foreground">{t('预览加载失败')}</p>
          )}
        </div>
      ) : activeTab ? (
        <MonacoEditor
          value={activeTab.loading ? '' : activeTab.content}
          onChange={onChange}
          language={monacoLanguageOf(fileName)}
          showLanguageSelector
          showCopyButton
          showHeader={activeTab.viewMode === 'edit'}
          wordWrap={wordWrap}
          lineNumbers={lineNumbers}
        />
      ) : (
        <div className="flex h-full items-center justify-center px-6">
          <div className="text-center text-sm text-foreground">
            <Files className="mx-auto mb-2 size-8 opacity-30" />
            {t('从左侧选择一个文件查看或编辑')}
          </div>
        </div>
      )}
    </div>
  )
}
