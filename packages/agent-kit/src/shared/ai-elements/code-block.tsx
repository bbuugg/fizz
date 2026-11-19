"use client";

import { Button } from "@fizz/ui/button";
import { cn } from "@fizz/agent-kit/shared/lib/utils";
import { CheckIcon, CopyIcon } from "lucide-react";
import {
  type ComponentProps,
  createContext,
  type HTMLAttributes,
  useContext,
  useEffect,
  useState,
} from "react";
import { type BundledLanguage, codeToHtml, type ShikiTransformer, type ThemeRegistrationAny } from "shiki";
import { useCodeTheme } from "@fizz/agent-kit/shared/lib/code-theme";

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: BundledLanguage;
  showLineNumbers?: boolean;
};

type CodeBlockContextType = {
  code: string;
};

const CodeBlockContext = createContext<CodeBlockContextType>({
  code: "",
});

const lineNumberTransformer: ShikiTransformer = {
  name: "line-numbers",
  line(node, line) {
    node.children.unshift({
      type: "element",
      tagName: "span",
      properties: {
        className: [
          "inline-block",
          "min-w-10",
          "mr-4",
          "text-right",
          "select-none",
          "text-muted-foreground",
        ],
      },
      children: [{ type: "text", value: String(line) }],
    });
  },
};

export async function highlightCode(
  code: string,
  language: BundledLanguage,
  showLineNumbers = false,
  themes: [ThemeRegistrationAny, ThemeRegistrationAny]
) {
  const transformers: ShikiTransformer[] = showLineNumbers
    ? [lineNumberTransformer]
    : [];

  // `themes` 是当前配色主题编译出的 [亮, 暗]（见 lib/code-theme.ts），不再写死 one-light / one-dark-pro
  return await Promise.all([
    codeToHtml(code, {
      lang: language,
      theme: themes[0],
      transformers,
    }),
    codeToHtml(code, {
      lang: language,
      theme: themes[1],
      transformers,
    }),
  ]);
}

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  const [html, setHtml] = useState<string>("");
  const [darkHtml, setDarkHtml] = useState<string>("");
  // 跟随配色主题：[亮, 暗] 一对 Shiki 主题，换主题 / 改自定义代码色时重新高亮
  const { shiki } = useCodeTheme();

  useEffect(() => {
    // 不能用「只写首次」的 mounted 标记：主题变化时这里会再跑一次，
    // 标记会让新的高亮结果被丢掉（表现为「换了主题代码块没变」）。
    let alive = true;
    void highlightCode(code, language, showLineNumbers, shiki).then(([light, dark]) => {
      if (!alive) return;
      setHtml(light);
      setDarkHtml(dark);
    });

    return () => {
      alive = false;
    };
  }, [code, language, showLineNumbers, shiki]);

  return (
    <CodeBlockContext.Provider value={{ code }}>
      <div
        className={cn(
          "group relative w-full overflow-hidden rounded-md border bg-background text-foreground",
          className
        )}
        {...props}
      >
        {/*
          这两层才是真正滚动的容器（工具卡的「参数 / 结果」也从这里滚）：滚条一律藏掉
          （`no-scrollbar`，与思考内容、工具输出同口径）—— 滚轮 / 触屏 / 键盘照常可用，
          只是不再画那条压在右侧的条。
        */}
        <div className="relative">
          <div
            className="overflow-auto no-scrollbar dark:hidden [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-4 [&>pre]:text-foreground! [&>pre]:text-sm [&_code]:font-mono [&_code]:text-sm"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: "this is needed."
            dangerouslySetInnerHTML={{ __html: html }}
          />
          <div
            className="hidden overflow-auto no-scrollbar dark:block [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-4 [&>pre]:text-foreground! [&>pre]:text-sm [&_code]:font-mono [&_code]:text-sm"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: "this is needed."
            dangerouslySetInnerHTML={{ __html: darkHtml }}
          />
          {children && (
            <div className="absolute top-2 right-2 flex items-center gap-2">
              {children}
            </div>
          )}
        </div>
      </div>
    </CodeBlockContext.Provider>
  );
};

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const { code } = useContext(CodeBlockContext);

  const copyToClipboard = async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      await navigator.clipboard.writeText(code);
      setIsCopied(true);
      onCopy?.();
      setTimeout(() => setIsCopied(false), timeout);
    } catch (error) {
      onError?.(error as Error);
    }
  };

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      className={cn("shrink-0", className)}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon size={14} />}
    </Button>
  );
};
