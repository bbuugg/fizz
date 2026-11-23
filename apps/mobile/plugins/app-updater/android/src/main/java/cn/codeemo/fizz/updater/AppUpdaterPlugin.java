package cn.codeemo.fizz.updater;

import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;

/**
 * 应用内更新（仅安卓壳）：下载交给系统 DownloadManager（走通知栏、可断点续传），
 * 装 APK 交给系统安装器（FileProvider + ACTION_VIEW）。
 *
 * 三件事刻意不做：
 *
 * 1. **不静默安装**：安卓没有这条路。REQUEST_INSTALL_PACKAGES 只让安装器愿意被拉起，
 *    「安装未知应用」的授权与最终确认都在系统里，由用户点头；
 * 2. **不把 APK 写公共存储**：目标目录是应用专属的外部目录（getExternalFilesDir），
 *    不需要任何存储权限，卸载应用时一并清掉；
 * 3. **不在原生侧决定「要不要更新」**：版本比较与 GitHub 查询都在 JS 侧
 *    （apps/mobile/src/update），这里只负责「按给定 URL 下载 / 取消 / 调起安装器」。
 */
@CapacitorPlugin(name = "FizzUpdater")
public class AppUpdaterPlugin extends Plugin {

    private static final String FILE_NAME = "fizz-update.apk";
    private static final String MIME_APK = "application/vnd.android.package-archive";
    private static final long POLL_INTERVAL_MS = 400;

    /** 当前下载任务 id；-1 表示没有进行中的任务 */
    private long downloadId = -1;
    private Handler handler;
    private Runnable poller;

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("缺少下载地址");
            return;
        }
        Context ctx = getContext();
        File dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) {
            call.reject("无法访问应用下载目录");
            return;
        }
        File target = new File(dir, FILE_NAME);
        // 上一版遗留的安装包先删掉，否则 DownloadManager 会因目标已存在而失败
        if (target.exists() && !target.delete()) {
            call.reject("无法清理旧的安装包");
            return;
        }

        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
        request.setTitle("Fizz 更新");
        request.setDescription("正在下载新版本…");
        request.setMimeType(MIME_APK);
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        request.setDestinationInExternalFilesDir(ctx, Environment.DIRECTORY_DOWNLOADS, FILE_NAME);

        DownloadManager manager = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) {
            call.reject("系统下载服务不可用");
            return;
        }
        try {
            stopPolling();
            downloadId = manager.enqueue(request);
        } catch (Exception err) {
            call.reject("下载任务创建失败：" + err.getMessage());
            return;
        }
        startPolling();
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        stopPolling();
        if (downloadId >= 0) {
            DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager != null) manager.remove(downloadId);
            downloadId = -1;
        }
        call.resolve();
    }

    /** 安卓 8+ 才需要「安装未知应用」授权；更早的系统装上即可 */
    @PluginMethod
    public void canInstall(PluginCall call) {
        boolean allowed = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            allowed = getContext().getPackageManager().canRequestPackageInstalls();
        }
        JSObject ret = new JSObject();
        ret.put("allowed", allowed);
        call.resolve(ret);
    }

    /** 跳系统设置里本应用的「安装未知应用」开关页，用户授权后返回应用再点安装 */
    @PluginMethod
    public void openInstallPermissionSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent intent = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName())
            );
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                getContext().startActivity(intent);
            } catch (ActivityNotFoundException err) {
                call.reject("settings-missing");
                return;
            }
        }
        call.resolve();
    }

    /** 调起系统安装器；下载文件不存在或没授权都会 reject，由 JS 侧转成界面提示 */
    @PluginMethod
    public void install(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            call.reject("install-permission");
            return;
        }
        File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        File apk = dir == null ? null : new File(dir, FILE_NAME);
        if (apk == null || !apk.exists()) {
            call.reject("install-missing");
            return;
        }
        Uri uri = FileProvider.getUriForFile(
            getContext(),
            getContext().getPackageName() + ".fizzupdater.fileprovider",
            apk
        );
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, MIME_APK);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
        } catch (ActivityNotFoundException err) {
            call.reject("install-activity");
            return;
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        stopPolling();
    }

    /**
     * DownloadManager 没有进度回调，只能轮询。轮询与事件都只在有任务时存在，
     * 任务结束（成功 / 失败 / 取消）立刻停掉，免得后台一直占着主线程消息队列。
     */
    private void startPolling() {
        if (handler == null) handler = new Handler(Looper.getMainLooper());
        poller = new Runnable() {
            @Override
            public void run() {
                if (downloadId < 0) return;
                pollOnce();
                if (downloadId >= 0) handler.postDelayed(this, POLL_INTERVAL_MS);
            }
        };
        handler.post(poller);
    }

    private void stopPolling() {
        if (handler != null && poller != null) handler.removeCallbacks(poller);
        poller = null;
    }

    private void pollOnce() {
        DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) {
            downloadId = -1;
            notifyListeners("downloadFailed", failed("service"), false);
            return;
        }
        Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(downloadId));
        if (cursor == null) return;
        try {
            if (!cursor.moveToFirst()) {
                downloadId = -1;
                notifyListeners("downloadFailed", failed("lost"), false);
                return;
            }
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            long done = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
            long total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
            int percent = total > 0 ? (int) Math.min(100, done * 100 / total) : 0;

            JSObject progress = new JSObject();
            progress.put("percent", percent);
            notifyListeners("downloadProgress", progress, false);

            if (status == DownloadManager.STATUS_SUCCESSFUL) {
                downloadId = -1;
                notifyListeners("downloadCompleted", progress, false);
            } else if (status == DownloadManager.STATUS_FAILED) {
                int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                downloadId = -1;
                notifyListeners("downloadFailed", failed(describeFailure(reason)), false);
            }
        } finally {
            cursor.close();
        }
    }

    /** 失败原因以**机器码**回传，文案由 JS 侧按当前语言翻译（原生侧不留中文字符串） */
    private JSObject failed(String code) {
        JSObject data = new JSObject();
        data.put("code", code);
        return data;
    }

    private String describeFailure(int reason) {
        switch (reason) {
            case DownloadManager.ERROR_INSUFFICIENT_SPACE:
                return "space";
            case DownloadManager.ERROR_FILE_ERROR:
                return "file";
            case DownloadManager.ERROR_HTTP_DATA_ERROR:
            case DownloadManager.ERROR_UNHANDLED_HTTP_CODE:
                return "network";
            case DownloadManager.ERROR_TOO_MANY_REDIRECTS:
                return "redirect";
            case DownloadManager.ERROR_CANNOT_RESUME:
            case DownloadManager.ERROR_UNKNOWN:
                return "interrupted";
            default:
                return "unknown";
        }
    }
}