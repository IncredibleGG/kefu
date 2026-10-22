package cc.kf56k.kefu;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** 通知頻道 id,與 docs/NATIVE-CLIENTS.md §2、後端 FCM android.notification.channel_id 相同 */
    static final String MESSAGES_CHANNEL_ID = "kefu_messages";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 本地外掛須在 super.onCreate 之前註冊
        registerPlugin(KefuNativePlugin.class);
        super.onCreate(savedInstanceState);
        ensureMessagesChannel();
    }

    /**
     * 啟動時先建立訊息通知頻道:App 被殺掉、JS 尚未執行時收到的 FCM 推播也能落在正確頻道。
     * 重複建立同 id 的頻道不會覆蓋使用者已調整的設定。
     */
    private void ensureMessagesChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel channel = new NotificationChannel(
            MESSAGES_CHANNEL_ID,
            getString(R.string.notification_channel_messages),
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription(getString(R.string.notification_channel_messages_desc));
        channel.enableVibration(true);
        nm.createNotificationChannel(channel);
    }
}
