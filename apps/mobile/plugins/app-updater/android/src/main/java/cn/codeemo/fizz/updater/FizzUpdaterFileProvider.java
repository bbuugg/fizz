package cn.codeemo.fizz.updater;

import androidx.core.content.FileProvider;

/**
 * 更新器专用的 FileProvider。
 *
 * ⚠️ 这个空子类是**必须的**，不是多余的抽象：
 *
 * Capacitor 生成的宿主 `AndroidManifest.xml` 里已经有一个
 * `androidx.core.content.FileProvider`（authority `${applicationId}.fileprovider`，
 * paths 指向它自己的 `@xml/file_paths`）。而清单合并器是按 `android:name` 给
 * `<provider>` 节点做键的 —— 插件清单里再写同一个类名，两边的
 * `android:authorities` 与 `FILE_PROVIDER_PATHS` 的 `android:resource` 就会撞车：
 *
 *   Attribute provider#androidx.core.content.FileProvider@authorities value=(A) ... is also
 *   present at [:<插件>] value=(B) → Manifest merger failed
 *
 * 生成出来的 `android/` 是 `cap add` 的产物、每次 CI 重建，**不能**靠在那里加
 * `tools:replace` 解决（下一次生成就没了；而且让它覆盖会把插件自己的 authority 顶掉、
 * 装 APK 时 FileProvider 直接找不到路径）。换成一个独有类名的子类，节点键就不同了，
 * 两个 FileProvider 各自带着自己的 authority / paths 并存。
 *
 * 运行期 `FileProvider.getUriForFile(ctx, authority, file)` 是靠 **authority 反查**
 * 清单里的 provider 再读它的 paths meta-data 的，子类不需要任何额外实现。
 */
public class FizzUpdaterFileProvider extends FileProvider {}
