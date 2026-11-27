package cn.codeemo.fizz.runtime;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.function.Consumer;

@CapacitorPlugin(name = "FizzRuntime")
public class RuntimePlugin extends Plugin {
    private RuntimeEngine engine;
    private final Consumer<JSObject> listener = status -> notifyListeners("status", status);

    @Override public void load() {
        engine = RuntimeEngine.get(getContext());
        engine.listeners.add(listener);
    }

    @Override protected void handleOnDestroy() {
        engine.listeners.remove(listener);
        // WebView 销毁不等于停止任务；运行时归前台服务所有。
        super.handleOnDestroy();
    }

    @PluginMethod public void status(PluginCall call) {
        call.resolve(engine.snapshot(true));
    }

    @PluginMethod public void start(PluginCall call) {
        try {
            engine.prepareStart();
            getContext().startForegroundService(new Intent(getContext(), RuntimeService.class));
            call.resolve(engine.snapshot(true));
        } catch (Exception error) {
            call.reject(error.getMessage(), "RUNTIME_START_FAILED", error);
        }
    }

    @PluginMethod public void stop(PluginCall call) {
        engine.stop(() -> call.resolve(engine.snapshot(false)));
    }
}
