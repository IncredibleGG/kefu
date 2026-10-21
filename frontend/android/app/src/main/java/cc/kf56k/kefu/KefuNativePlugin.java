package cc.kf56k.kefu;

import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * kefu 自用的小外掛(JS:registerPlugin("KefuNative"))。
 *
 * getInfo() → { firebaseConfigured: boolean, messagesChannelId: string }
 *
 * 用途:沒有 google-services.json 時 Firebase 不會初始化,此時呼叫
 * PushNotifications.register() 會在原生端拋 IllegalStateException 讓 App 閃退;
 * 前端必須先查 firebaseConfigured,為 false 時 pushRegister() 直接回 null。
 */
@CapacitorPlugin(name = "KefuNative")
public class KefuNativePlugin extends Plugin {

    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("firebaseConfigured", isFirebaseConfigured(getContext()));
        ret.put("messagesChannelId", MainActivity.MESSAGES_CHANNEL_ID);
        call.resolve(ret);
    }

    /** google-services Gradle 外掛套用後會產生 string 資源 google_app_id;沒有它代表未設定 Firebase */
    static boolean isFirebaseConfigured(Context ctx) {
        int id = ctx.getResources().getIdentifier("google_app_id", "string", ctx.getPackageName());
        if (id == 0) return false;
        String value = ctx.getString(id);
        return value != null && !value.isEmpty();
    }
}
