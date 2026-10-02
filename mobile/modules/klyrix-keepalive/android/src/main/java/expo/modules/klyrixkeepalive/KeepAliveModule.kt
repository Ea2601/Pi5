package expo.modules.klyrixkeepalive

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// JS tarafı: modules/klyrix-keepalive/index.ts (src/platform/keepalive.ts kullanır).
//  start  — hizmeti başlatır; yalnız uygulama öndeyken olur (Android arka plandan hizmet başlatmayı yasaklar → false)
//  update — hizmet ön plandayken bildirimi (metin + ilerleme) yeniler; bildirim izni yoksa hiçbir şey yapmaz
//  stop   — hizmeti kapatır, bildirim kalkar
// Olaylar: onStopRequest (bildirimdeki «Durdur»), onTimeout (Android 15 günlük süre sınırı).
class KeepAliveModule : Module() {
  private val context: Context?
    get() = appContext.reactContext?.applicationContext

  override fun definition() = ModuleDefinition {
    Name("KlyrixKeepAlive")

    Events("onStopRequest", "onTimeout")

    OnCreate {
      KeepAliveService.listener = { name -> sendEvent(name, mapOf<String, Any?>()) }
    }

    OnDestroy {
      KeepAliveService.listener = null
    }

    Function("start") { title: String, text: String ->
      val ctx = context ?: return@Function false
      try {
        val intent = Intent(ctx, KeepAliveService::class.java)
          .putExtra(KeepAliveService.EXTRA_TITLE, title)
          .putExtra(KeepAliveService.EXTRA_TEXT, text)
        ctx.startService(intent) != null
      } catch (e: Exception) {
        Log.w("KlyrixKeepAlive", "hizmet başlatılamadı: ${e.message}")
        false
      }
    }

    Function("update") { title: String, text: String, progress: Int, max: Int ->
      val ctx = context
      if (ctx != null && KeepAliveService.running && notificationsAllowed(ctx)) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(KeepAliveService.NOTIFICATION_ID, KeepAliveService.build(ctx, title, text, progress, max))
      }
    }

    Function<Unit>("stop") {
      KeepAliveService.running = false
      val ctx = context
      if (ctx != null) ctx.stopService(Intent(ctx, KeepAliveService::class.java))
    }

    Function<Boolean>("isRunning") {
      KeepAliveService.running
    }
  }

  private fun notificationsAllowed(ctx: Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
      ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
}
