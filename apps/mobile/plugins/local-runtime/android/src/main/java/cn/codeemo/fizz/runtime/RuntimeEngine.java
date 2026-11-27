package cn.codeemo.fizz.runtime;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.system.Os;
import android.system.OsConstants;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** 运行时唯一事实源；WebView 重建、切后台均不改变 Node 的生命周期。 */
final class RuntimeEngine {
    private static RuntimeEngine instance;
    static synchronized RuntimeEngine get(Context context) {
        if (instance == null) instance = new RuntimeEngine(context.getApplicationContext());
        return instance;
    }

    final CopyOnWriteArraySet<Consumer<JSObject>> listeners = new CopyOnWriteArraySet<>();
    private final Context context;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ArrayDeque<String> logs = new ArrayDeque<>();
    private final File base;
    private volatile String phase = "stopped";
    private volatile String error;
    volatile int progress;
    private volatile boolean stopping;
    private volatile Process process;
    private volatile String token;
    private volatile String secret;
    private volatile int port;

    private RuntimeEngine(Context context) {
        this.context = context;
        this.base = new File(context.getFilesDir(), "fizz-runtime");
    }

    synchronized void prepareStart() {
        if (isIdle()) stopping = false;
    }

    synchronized void start() {
        // startForegroundService 的投递可能晚于用户的停止请求，不能在这里重新清除取消标记。
        if (stopping) return;
        if (!phase.equals("stopped") && !phase.equals("error")) return;
        error = null;
        progress = 0;
        phase = "installing";
        publish();
        worker.execute(() -> {
            try {
                new RuntimeInstaller(context, this, () -> stopping).install();
                if (stopping) throw new InterruptedException("启动已取消");
                updateDns();
                secret = randomSecret();
                token = makeToken(secret);
                try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
                    port = socket.getLocalPort();
                }
                Files.deleteIfExists(new File(base, "rootfs/run/fizz-server.pid").toPath());
                phase = "starting";
                publish();
                Process launched;
                synchronized (this) {
                    if (stopping) throw new InterruptedException("启动已取消");
                    launched = launcher().start();
                    process = launched;
                }
                pump(launched.getInputStream());
                long deadline = android.os.SystemClock.elapsedRealtime() + 120000;
                while (!stopping && launched.isAlive() && android.os.SystemClock.elapsedRealtime() < deadline) {
                    if (healthy()) {
                        phase = "running";
                        log("Fizz 正在手机本地运行");
                        Thread waiter = new Thread(() -> {
                            try { launched.waitFor(); }
                            catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
                            worker.execute(() -> {
                                if (process != launched) return;
                                process = null;
                                token = null;
                                secret = null;
                                if (!stopping) {
                                    error = "本机引擎已退出（" + launched.exitValue() + "），请查看运行日志后重试";
                                    phase = "error";
                                    publish();
                                }
                            });
                        }, "fizz-runtime-wait");
                        waiter.setDaemon(true);
                        waiter.start();
                        return;
                    }
                    Thread.sleep(300);
                }
                if (!stopping) throw new IllegalStateException(launched.isAlive() ? "本机引擎启动超时，请查看运行日志" : "本机引擎启动失败，请查看运行日志");
                cleanup();
            } catch (Exception failure) {
                cleanup();
                if (!stopping) {
                    error = failure.getMessage() == null ? failure.toString() : failure.getMessage();
                    log(error);
                    phase = "error";
                    publish();
                }
            }
        });
    }

    void stop(Runnable done) {
        synchronized (this) {
            stopping = true;
            phase = "stopping";
            publish();
        }
        worker.execute(() -> {
            cleanup();
            phase = "stopped";
            error = null;
            publish();
            if (done != null) done.run();
        });
    }

    boolean isActive() {
        return phase.equals("installing") || phase.equals("starting") || phase.equals("running");
    }

    boolean isIdle() {
        return phase.equals("stopped") || phase.equals("error");
    }

    private ProcessBuilder launcher() {
        File root = new File(base, "rootfs");
        String libs = context.getApplicationInfo().nativeLibraryDir;
        File tmp = new File(context.getCacheDir(), "fizz-proot");
        tmp.mkdirs();
        new File(base, "home/.l2s").mkdirs();
        List<String> argv = new ArrayList<>(Arrays.asList(libs + "/libproot.so", "--kill-on-exit", "--link2symlink", "--sysvipc", "-L", "-0",
            "--rootfs=" + root.getAbsolutePath(), "--cwd=/opt/fizz"));
        for (String bind : Arrays.asList("/dev", "/proc", "/sys", "/system", "/apex",
            "/dev/urandom:/dev/random", "/proc/self/fd:/dev/fd",
            "/proc/self/fd/0:/dev/stdin", "/proc/self/fd/1:/dev/stdout", "/proc/self/fd/2:/dev/stderr",
            base + "/shm:/dev/shm", base + "/empty:/sys/fs/selinux",
            base + "/data:/data", base + "/home:/root", base + "/workspace:/workspace", base + "/engine:/opt/fizz")) {
            argv.add("-b");
            argv.add(bind);
        }
        argv.addAll(Arrays.asList("/usr/bin/env", "-i", "HOME=/root", "USER=root", "LOGNAME=root", "SHELL=/bin/bash",
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8", "TERM=xterm-256color", "TMPDIR=/tmp",
            "NODE_ENV=production", "NODE_OPTIONS=--dns-result-order=ipv4first", "UV_USE_IO_URING=0",
            "FIZZ_HOST=127.0.0.1", "FIZZ_PORT=" + port, "FIZZ_JWT_SECRET=" + secret,
            "/bin/sh", "-c", "echo $$ > /run/fizz-server.pid; exec /usr/local/bin/node /opt/fizz/mobile-entry.mjs"));
        ProcessBuilder builder = new ProcessBuilder(argv).directory(base).redirectErrorStream(true);
        Map<String, String> env = builder.environment();
        env.clear();
        env.put("PATH", "/system/bin");
        env.put("ANDROID_ROOT", "/system");
        env.put("ANDROID_DATA", "/data");
        env.put("PROOT_LOADER", libs + "/libproot-loader.so");
        env.put("PROOT_TMP_DIR", tmp.getAbsolutePath());
        env.put("PROOT_L2S_DIR", new File(base, "home/.l2s").getAbsolutePath());
        env.put("LD_LIBRARY_PATH", libs);
        log("启动 Android PRoot → Node → Fizz（仅监听 127.0.0.1）");
        return builder;
    }

    synchronized void updateDns() throws Exception {
        File etc = new File(base, "rootfs/etc");
        if (!etc.isDirectory()) return;
        ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
        Network network = manager.getActiveNetwork();
        LinkProperties properties = network == null ? null : manager.getLinkProperties(network);
        StringBuilder config = new StringBuilder("options timeout:2 attempts:2\n");
        if (properties != null) for (InetAddress server : properties.getDnsServers()) {
            config.append("nameserver ").append(server.getHostAddress()).append('\n');
        }
        // 离线时也能启动本地界面；网络回调会在联网后写入实际 DNS。
        File target = new File(etc, "resolv.conf");
        File temporary = new File(etc, "resolv.conf.tmp");
        Files.write(temporary.toPath(), config.toString().getBytes(StandardCharsets.UTF_8));
        Files.move(temporary.toPath(), target.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    }

    private boolean healthy() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/api/health").openConnection();
            connection.setConnectTimeout(1000);
            connection.setReadTimeout(1000);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            if (connection.getResponseCode() != 200) return false;
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                String line = reader.readLine();
                return line != null && "fizz-server".equals(new org.json.JSONObject(line).optString("name"));
            }
        } catch (Exception ignored) {
            return false; // 正常的启动探活，失败由退出码或总时限统一报告。
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void cleanup() {
        Process current = process;
        if (current != null && current.isAlive()) {
            // 先让同一个 server 正常落盘，再收 PRoot；--kill-on-exit 负责它的剩余 tracees。
            try {
                File marker = new File(base, "rootfs/run/fizz-server.pid");
                int pid = Integer.parseInt(new String(Files.readAllBytes(marker.toPath()), StandardCharsets.UTF_8).trim());
                String cmdline = new String(Files.readAllBytes(new File("/proc/" + pid + "/cmdline").toPath()), StandardCharsets.UTF_8);
                if (cmdline.contains("/opt/fizz/mobile-entry.mjs")) Os.kill(pid, OsConstants.SIGTERM);
            } catch (Exception failure) {
                log("未能发送优雅退出信号，继续清理 PRoot");
            }
            try {
                if (!current.waitFor(16, TimeUnit.SECONDS)) current.destroy();
                if (!current.waitFor(3, TimeUnit.SECONDS)) current.destroyForcibly();
                current.waitFor();
            } catch (InterruptedException failure) {
                current.destroyForcibly();
                Thread.currentThread().interrupt();
            }
        }
        process = null;
        token = null;
        secret = null;
    }

    private void pump(InputStream stream) {
        Thread thread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) log(line);
            } catch (Exception failure) {
                if (!stopping) log("读取引擎日志失败：" + failure.getMessage());
            }
        }, "fizz-runtime-log");
        thread.setDaemon(true);
        thread.start();
    }

    synchronized void log(String message) {
        String line = message;
        if (secret != null) line = line.replace(secret, "[redacted]");
        if (token != null) line = line.replace(token, "[redacted]");
        if (line.contains("容器回调 token：")) line = "容器回调 token：[redacted]";
        logs.addLast(line.length() > 2000 ? line.substring(0, 2000) : line);
        while (logs.size() > 120) logs.removeFirst();
        publish();
    }

    synchronized JSObject snapshot(boolean credentials) {
        JSObject result = new JSObject();
        result.put("phase", phase);
        result.put("progress", progress);
        result.put("logs", new JSArray(new ArrayList<>(logs)));
        if (error != null) result.put("error", error);
        if (credentials && phase.equals("running") && token != null) {
            JSObject connection = new JSObject();
            connection.put("serverBase", "http://127.0.0.1:" + port);
            connection.put("token", token);
            result.put("connection", connection);
        }
        return result;
    }

    void publish() {
        JSObject status = snapshot(false);
        for (Consumer<JSObject> listener : listeners) listener.accept(status);
    }

    private static String randomSecret() {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        return base64(bytes);
    }

    private static String makeToken(String secret) throws Exception {
        long now = System.currentTimeMillis() / 1000;
        String data = base64("{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8)) + "." +
            base64(("{\"sub\":\"fizz\",\"iat\":" + now + ",\"exp\":" + (now + 31536000L) + "}").getBytes(StandardCharsets.UTF_8));
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return data + "." + base64(mac.doFinal(data.getBytes(StandardCharsets.UTF_8)));
    }

    private static String base64(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.NO_WRAP | Base64.NO_PADDING | Base64.URL_SAFE);
    }
}
