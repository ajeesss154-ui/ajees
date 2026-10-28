package app.aura.assistant

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/** Availability notification; this service does not listen to audio or collect screens. */
class AssistantModeService : Service() {
    companion object {
        const val CHANNEL = "aura_ai_session"
        const val STOP = "app.aura.assistant.STOP_SESSION"
        const val READ_SCREEN = "app.aura.assistant.READ_SELECTED_SCREEN"
        private const val NOTIFICATION_ID = 3001
    }

    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "AI mode session", NotificationManager.IMPORTANCE_LOW)
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) {
            AssistantSession.setMode(false)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == READ_SCREEN) {
            if (AssistantSession.aiMode) {
                // A notification tap is explicit user intent. Keep one selected capture in RAM only.
                AssistantSession.selectScreen(AuraAccessibilityService.instance?.captureScreen(fromNotification = true)
                    ?: org.json.JSONObject().put("error", "Enable AURA accessibility access first."))
                startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            }
            return START_NOT_STICKY
        }
        if (intent == null || !AssistantSession.aiMode) {
            stopSelf()
            return START_NOT_STICKY
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, AssistantModeService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val read = PendingIntent.getService(this, 2, Intent(this, AssistantModeService::class.java).setAction(READ_SCREEN), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_aura)
            .setContentTitle("AURA · AI mode is on")
            .setContentText("Tap to open. Screen reading and actions require your request.")
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(Notification.Action.Builder(null, "Read screen", read).build())
            .addAction(Notification.Action.Builder(null, "Stop AI mode", stop).build())
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(NOTIFICATION_ID, notification)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        AssistantSession.setMode(false)
        super.onDestroy()
    }
    override fun onTaskRemoved(rootIntent: Intent?) {
        AssistantSession.setMode(false)
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }
    override fun onBind(intent: Intent?): IBinder? = null
}
