package expo.modules.klyrixkeepalive

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log

// Yedekleme turu sürerken uygulama sürecini ayakta tutan ön plan hizmeti (dataSync). İş JS'te (src/backup.ts) sürer; hizmet
// yalnız ilerleme bildirimini gösterir ve ekran kapalıyken CPU'yu (Android 14'ten önce Wi-Fi'ı da) uyanık tutar.
// Uygulama öndeyken startService ile başlatılır ve kendini ön plana alır: alamazsa (ör. Android 15'te günlük dataSync süresi
// doldu) sessizce kapanır — startForegroundService'teki "zamanında ön plana geçmedi" çökmesi bu yolda olmaz.
class KeepAliveService : Service() {
  companion object {
    private const val TAG = "KlyrixKeepAlive"
    const val CHANNEL_ID = "klyrix-sync"
    const val NOTIFICATION_ID = 7301
    const val ACTION_STOP_REQUEST = "expo.modules.klyrixkeepalive.STOP_REQUEST"
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    private const val LOCK_TIMEOUT_MS = 6L * 60 * 60 * 1000

    // Hizmet ön planda mı: modül bildirimi yalnız o zaman yeniler; durdururken modül hemen false yapar (geç gelen bir
    // güncelleme, hizmet kapandıktan sonra sahipsiz bir bildirim bırakmasın)
    @Volatile var running = false

    // Modül ayarlar: bildirimdeki «Durdur» ve Android 15 süre sınırı JS'e olay olarak gider
    @Volatile var listener: ((String) -> Unit)? = null

    fun build(context: Context, title: String, text: String, progress: Int, max: Int): Notification {
      ensureChannel(context)
      val b = builder(context)
        .setSmallIcon(R.drawable.klyrix_sync_notification)
        .setContentTitle(title)
        .setContentText(text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setShowWhen(false)
        .setCategory(Notification.CATEGORY_PROGRESS)
      if (max > 0) b.setProgress(max, progress.coerceIn(0, max), false) else b.setProgress(0, 0, true)
      // Bildirime dokununca uygulama açılır
      context.packageManager.getLaunchIntentForPackage(context.packageName)?.let { launch ->
        b.setContentIntent(PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
      }
      val stop = Intent(context, KeepAliveService::class.java).setAction(ACTION_STOP_REQUEST)
      val stopIntent = PendingIntent.getService(context, 1, stop, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      b.addAction(Notification.Action.Builder(Icon.createWithResource(context, R.drawable.klyrix_sync_notification), "Durdur", stopIntent).build())
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
      return b.build()
    }

    @Suppress("DEPRECATION")
    private fun builder(context: Context): Notification.Builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(context, CHANNEL_ID) else Notification.Builder(context)

    private fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (nm.getNotificationChannel(CHANNEL_ID) != null) return
      val channel = NotificationChannel(CHANNEL_ID, "Yedekleme", NotificationManager.IMPORTANCE_LOW)
      channel.description = "Yedekleme sürerken ilerleme"
      channel.setShowBadge(false)
      nm.createNotificationChannel(channel)
    }
  }

  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP_REQUEST) {
      listener?.invoke("onStopRequest")
      if (!running) stopSelf()
      return START_NOT_STICKY
    }
    val notification = build(this, intent?.getStringExtra(EXTRA_TITLE) ?: "Klyrix/Gate Sync", intent?.getStringExtra(EXTRA_TEXT) ?: "", 0, 0)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (e: Exception) {
      // Ön plana geçilemedi: tur yine sürer, ama yalnız uygulama öndeyken
      Log.w(TAG, "ön plan hizmeti başlatılamadı: ${e.message}")
      running = false
      stopSelf()
      return START_NOT_STICKY
    }
    running = true
    acquireLocks()
    return START_NOT_STICKY
  }

  // Android 15+: dataSync günde en çok 6 saat; süre dolunca birkaç saniye içinde durulmalı. Tur durur (JS), bir sonraki
  // turda kaldığı yerden sürer.
  override fun onTimeout(startId: Int, fgsType: Int) {
    Log.w(TAG, "dataSync süre sınırı doldu")
    listener?.invoke("onTimeout")
    running = false
    stopSelf()
  }

  override fun onDestroy() {
    running = false
    releaseLocks()
    stopForeground(STOP_FOREGROUND_REMOVE)
    (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIFICATION_ID)
    super.onDestroy()
  }

  @Suppress("DEPRECATION")
  private fun acquireLocks() {
    if (wakeLock == null) {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      val lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "klyrix:sync")
      lock.setReferenceCounted(false)
      lock.acquire(LOCK_TIMEOUT_MS)
      wakeLock = lock
    }
    // Android 14'ten önce Wi-Fi ekran kapalıyken güç tasarrufuna geçip yüklemeyi yavaşlatabilir (14+'da bu kilit etkisiz)
    if (wifiLock == null && Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
      val lock = wm?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "klyrix:sync")
      lock?.setReferenceCounted(false)
      lock?.acquire()
      wifiLock = lock
    }
  }

  private fun releaseLocks() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    wifiLock?.let { if (it.isHeld) it.release() }
    wifiLock = null
  }
}
