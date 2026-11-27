package cn.codeemo.fizz.runtime;

import android.content.Context;
import android.os.Build;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.function.BooleanSupplier;
import org.json.JSONObject;

/** Linux 系统只初始化一次；后续 APK 只原子替换引擎，保留 apt/npm 安装结果及用户目录。 */
final class RuntimeInstaller {
    private final Context context;
    private final RuntimeEngine engine;
    private final BooleanSupplier cancelled;
    private final File base;

    RuntimeInstaller(Context context, RuntimeEngine engine, BooleanSupplier cancelled) {
        this.context = context;
        this.engine = engine;
        this.cancelled = cancelled;
        this.base = new File(context.getFilesDir(), "fizz-runtime");
    }

    void install() throws Exception {
        JSONObject manifest;
        try (InputStream input = context.getAssets().open("fizz-runtime/manifest.json")) {
            manifest = new JSONObject(new String(readAll(input), StandardCharsets.UTF_8));
        }
        if (manifest.getInt("format") != 1) throw new IllegalStateException("不支持的运行环境格式");
        if (!Arrays.asList(Build.SUPPORTED_ABIS).contains(manifest.getString("abi"))) {
            throw new IllegalStateException("APK 内的运行环境与手机 CPU 架构不匹配");
        }
        if (context.getApplicationInfo().targetSdkVersion > 28) {
            throw new IllegalStateException("PRoot 本机运行包必须使用 targetSdk 28，请重新构建 APK");
        }
        if (!new File(context.getApplicationInfo().nativeLibraryDir, "libproot.so").canExecute()) {
            throw new IllegalStateException("APK 未解出 Android PRoot 启动器，请检查 useLegacyPackaging");
        }
        base.mkdirs();
        installPart("rootfs", manifest.getJSONObject("system"), manifest.getString("systemVersion") + "/" + manifest.getString("abi"), true);
        installPart("engine", manifest.getJSONObject("engine"), manifest.getJSONObject("engine").getString("sha256"), false);
        for (String name : new String[]{"data", "home", "workspace", "shm", "empty"}) new File(base, name).mkdirs();
        for (String name : new String[]{"dev", "dev/shm", "proc", "sys", "tmp", "run", "root", "data", "workspace", "opt/fizz", "system", "apex"}) {
            new File(base, "rootfs/" + name).mkdirs();
        }
        File hosts = new File(base, "rootfs/etc/hosts");
        if (!Files.exists(hosts.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            Files.write(hosts.toPath(), "127.0.0.1 localhost\n::1 localhost ip6-localhost\n".getBytes(StandardCharsets.UTF_8));
        }
        engine.log("本机运行环境就绪（" + manifest.getString("abi") + "，Fizz " + manifest.getString("appVersion") + "）");
    }

    private void installPart(String name, JSONObject archive, String version, boolean system) throws Exception {
        File current = new File(base, name);
        File previous = new File(base, name + ".previous");
        File staging = new File(base, name + ".staging");
        if (!current.exists() && previous.exists() && !previous.renameTo(current)) {
            throw new IllegalStateException("无法恢复上次运行环境更新");
        }
        File marker = new File(current, ".fizz-version");
        if (marker.isFile()) {
            String installed = new String(Files.readAllBytes(marker.toPath()), StandardCharsets.UTF_8).trim();
            if (installed.equals(version)) {
                RuntimeArchive.deleteTree(previous);
                RuntimeArchive.deleteTree(staging);
                return;
            }
            if (system) throw new IllegalStateException("此 APK 需要新的 Linux 系统版本；现有系统及数据已保留，未自动重置");
        } else if (current.exists()) {
            throw new IllegalStateException("运行环境版本标记缺失；现有目录已保留，请检查安装日志");
        }
        RuntimeArchive.deleteTree(staging);
        long unpacked = archive.getLong("unpackedBytes");
        if (base.getUsableSpace() < unpacked + unpacked / 5) {
            throw new IllegalStateException("手机空间不足，解包至少需要 " + (unpacked * 6 / 5 / 1048576) + " MiB 可用空间");
        }
        String file = archive.getString("file");
        if (!file.equals(system ? "system.tgz" : "engine.tgz")) throw new IllegalStateException("运行环境清单路径不合法");
        engine.log("校验 " + file);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = context.getAssets().open("fizz-runtime/" + file)) {
            byte[] buffer = new byte[65536];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (cancelled.getAsBoolean()) throw new InterruptedException("安装已取消");
                digest.update(buffer, 0, count);
            }
        } catch (FileNotFoundException failure) {
            throw new IOException("APK 内缺少运行环境归档：" + file + "，请重新构建 APK", failure);
        }
        StringBuilder hash = new StringBuilder();
        for (byte value : digest.digest()) hash.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        if (!hash.toString().equals(archive.getString("sha256"))) throw new IllegalStateException(file + " 完整性校验失败");
        engine.log("解包 " + file);
        final int[] lastPercent = {-1};
        try (InputStream input = context.getAssets().open("fizz-runtime/" + file)) {
            RuntimeArchive.extract(input, staging, cancelled, bytes -> {
                int percent = (int) Math.min(100, bytes * 100 / Math.max(1, unpacked));
                if (percent != lastPercent[0]) {
                    lastPercent[0] = percent;
                    engine.progress = percent;
                    engine.publish();
                }
            });
        }
        Files.write(new File(staging, ".fizz-version").toPath(), version.getBytes(StandardCharsets.UTF_8));
        if (cancelled.getAsBoolean()) throw new InterruptedException("安装已取消");
        RuntimeArchive.deleteTree(previous);
        if (current.exists() && !current.renameTo(previous)) throw new IllegalStateException("无法暂存旧引擎");
        if (!staging.renameTo(current)) {
            if (previous.exists() && !previous.renameTo(current)) throw new IllegalStateException("引擎激活及恢复失败，旧引擎保留在 .previous 目录");
            throw new IllegalStateException("无法激活运行环境");
        }
        RuntimeArchive.deleteTree(previous);
    }

    private static byte[] readAll(InputStream input) throws java.io.IOException {
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
        return bytes.toByteArray();
    }
}
