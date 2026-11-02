package dev.zli.remote.livestatus

import android.app.Notification
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Holds the live status notification as a foreground service. Android then keeps the app process,
 * and with it the JavaScript runtime and the connection to the desktop, running in the background.
 */
class LiveStatusService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Android kills the app if a service started with startForegroundService never calls
    // startForeground, even when hide() came first, so it goes to the foreground before stopping.
    val notification = current ?: latest
    if (notification == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        startForeground(LiveStatusNotification.ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
      } else {
        startForeground(LiveStatusNotification.ID, notification)
      }
      running = true
      if (current == null) {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
      }
    } catch (error: RuntimeException) {
      // Without the service the status still shows; only the background connection is lost.
      notify(this, notification)
      stopSelf()
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  companion object {
    @Volatile private var current: Notification? = null
    @Volatile private var latest: Notification? = null
    @Volatile private var running = false

    fun show(context: Context, notification: Notification) {
      current = notification
      latest = notification
      if (running) {
        notify(context, notification)
        return
      }
      val intent = Intent(context, LiveStatusService::class.java)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
        else context.startService(intent)
      } catch (error: RuntimeException) {
        // Android refuses to start a foreground service from the background.
        notify(context, notification)
      }
    }

    fun hide(context: Context) {
      current = null
      // A start still on its way stops the service itself once it is in the foreground.
      if (running) context.stopService(Intent(context, LiveStatusService::class.java))
      context.getSystemService(NotificationManager::class.java).cancel(LiveStatusNotification.ID)
    }

    private fun notify(context: Context, notification: Notification) {
      context.getSystemService(NotificationManager::class.java).notify(LiveStatusNotification.ID, notification)
    }
  }
}
