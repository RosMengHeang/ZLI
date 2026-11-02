package dev.zli.remote.livestatus

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build

private const val ACTION_PRESS = "dev.zli.remote.livestatus.PRESS"
private const val EXTRA_TARGET = "target"

internal object LiveStatusNotification {
  const val ID = 1001
  private const val CHANNEL_ID = "live-status"
  // Written by the expo-notifications config plugin when the app sets a notification icon.
  private const val ICON_META_DATA = "expo.modules.notifications.default_notification_icon"
  private val AMBER = Color.parseColor("#875500")
  private val BLUE = Color.parseColor("#346bf1")

  fun build(context: Context, content: LiveStatusContent): Notification {
    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ensureChannel(context)
        Notification.Builder(context, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(context)
      }
    val expanded = listOfNotNull(content.detail.ifBlank { null }, content.others).joinToString("\n")

    builder
      .setSmallIcon(smallIcon(context))
      .setContentTitle(content.title)
      .setContentText(content.detail)
      .setStyle(Notification.BigTextStyle().bigText(expanded))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setCategory(if (content.needsYou) Notification.CATEGORY_REMINDER else Notification.CATEGORY_PROGRESS)
      .setColor(if (content.needsYou) AMBER else BLUE)
      .setContentIntent(openIntent(context, content.url))

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
    }
    // A Live Update needs an ongoing, uncolorized notification in a standard style, which this is.
    // The person can still turn promotion off for the app in the system settings.
    if (supportsLiveUpdates()) {
      builder.setRequestPromotedOngoing(true)
      builder.setShortCriticalText(content.badge)
    }
    content.actions.forEachIndexed { index, action ->
      builder.addAction(
        Notification.Action.Builder(null as Icon?, action.label, pressIntent(context, index, action.target)).build()
      )
    }
    return builder.build()
  }

  // Live Updates came with Android 16 QPR2 (API 36.1); on 36.0 the builder methods do not exist.
  private fun supportsLiveUpdates(): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA &&
      Build.VERSION.SDK_INT_FULL >= Build.VERSION_CODES_FULL.BAKLAVA_1

  private fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    // Quiet on purpose: the "agents" channel already alerts when an agent needs the person.
    val channel = NotificationChannel(CHANNEL_ID, "Agents at work", NotificationManager.IMPORTANCE_LOW)
    channel.description = "The agent that needs you or is working, while ZLI Remote is connected."
    channel.setShowBadge(false)
    manager.createNotificationChannel(channel)
  }

  @Suppress("DEPRECATION")
  private fun smallIcon(context: Context): Int {
    val metaData = runCatching {
      context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA).metaData
    }.getOrNull()
    return metaData?.getInt(ICON_META_DATA, 0)?.takeIf { it != 0 }
      ?: context.applicationInfo.icon.takeIf { it != 0 }
      ?: android.R.drawable.sym_def_app_icon
  }

  private fun openIntent(context: Context, url: String): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
      .setPackage(context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      context,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun pressIntent(context: Context, index: Int, target: String): PendingIntent {
    val intent = Intent(context, LiveStatusActionReceiver::class.java)
      .setAction(ACTION_PRESS)
      .putExtra(EXTRA_TARGET, target)
    return PendingIntent.getBroadcast(
      context,
      index,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }
}

class LiveStatusActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_PRESS) return
    intent.getStringExtra(EXTRA_TARGET)?.let(LiveStatusPresses::press)
  }
}
