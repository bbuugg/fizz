package cn.codeemo.fizz.runtime;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.os.IBinder;
import android.os.PowerManager;
import com.getcapacitor.JSObject;
import java.util.function.Consumer;

public final class RuntimeService extends Service {
    private static final String CHANNEL = "fizz-local-runtime";
    private static final int NOTIFICATION = 7801;
    private RuntimeEngine engine;
    private PowerManager.WakeLock wakeLock;
    private ConnectivityManager connectivity;
    private final Consumer<JSObject> listener = status -> {
        String phase = status.getString("phase", "stopped");
        if (phase.equals("stopped") || phase.equals("error")) stopSelf();
    };
    private final ConnectivityManager.NetworkCallback network = new ConnectivityManager.NetworkCallback() {
        @Override public void onLinkPropertiesChanged(Network network, LinkProperties properties) {
            try { engine.updateDns(); }
            catch (Exception failure) { engine.log("更新手机 DNS 失败：" + failure.getMessage()); }
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        engine = RuntimeEngine.get(this);
        engine.listeners.add(listener);
        getSystemService(NotificationManager.class).createNotificationChannel(
            new NotificationChannel(CHANNEL, "Fizz 本机运行环境 / Local runtime", NotificationManager.IMPORTANCE_LOW));
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent open = PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, RuntimeService.class).setAction("stop"), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = new Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Fizz · 本机引擎 / Local engine")
            .setContentText("Linux / Node 正在手机上运行 · 点此返回")
            .setContentIntent(open).setOngoing(true)
            .addAction(new Notification.Action.Builder(null, "停止 / Stop", stop).build()).build();
        startForeground(NOTIFICATION, notification);
        wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Fizz:LocalRuntime");
        wakeLock.acquire();
        connectivity = getSystemService(ConnectivityManager.class);
        connectivity.registerDefaultNetworkCallback(network);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "stop".equals(intent.getAction())) engine.stop(() -> stopSelf(startId));
        else {
            engine.start();
            if (engine.isIdle()) stopSelf(startId);
        }
        // 系统回收后由用户重新打开恢复；不在后台无限重启或重放任务。
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        engine.listeners.remove(listener);
        // 服务被系统销毁时也收掉 tracees，避免留下没有前台通知的本机引擎。
        if (engine.isActive()) engine.stop(null);
        connectivity.unregisterNetworkCallback(network);
        if (wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
