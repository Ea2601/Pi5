package expo.modules.klyrixwg

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.util.Log
import com.klyrix.wg.wgbridge.Wgbridge
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet4Address
import java.net.InetAddress

// JS tarafı: modules/klyrix-wg/index.ts (src/platform/wg.ts kullanır).
//  - WireGuard köprüsü (gate/wg → Wgbridge: wireguard-go + gVisor netstack): tünel uygulamanın içinde, kullanıcı alanında —
//    telefonda VPN izni / simgesi yok. Ad çözümü, el sıkışma ve deneme uzun sürebilir: AsyncFunction (JS iş parçacığı beklemez).
//  - Keşif: Android NSD ile ev ağındaki _klyrix-gate._tcp duyuruları (Pi: backend/src/mesh.ts) → onDeviceFound
//    {name, host (IPv4), port, id, role, app}. Aday yalnız adres önerir; JS GET /api/app/pair ile doğrular.
class KlyrixWgModule : Module() {
  companion object {
    private const val TAG = "KlyrixWg"
    private const val SERVICE_TYPE = "_klyrix-gate._tcp"
  }

  private val context: Context?
    get() = appContext.reactContext?.applicationContext

  private var nsd: NsdManager? = null
  private var discovery: NsdManager.DiscoveryListener? = null
  // Eski Android'de aynı anda tek çözümleme yapılabilir: bulunanlar sıraya alınır
  private val resolveQueue = ArrayDeque<NsdServiceInfo>()
  private var resolving = false
  private val lock = Any()

  override fun definition() = ModuleDefinition {
    Name("KlyrixWg")

    Events("onDeviceFound", "onDeviceLost")

    Function<String>("generatePrivateKey") { Wgbridge.generatePrivateKey() }

    Function("publicKey") { privateKey: String -> Wgbridge.publicKey(privateKey) }

    AsyncFunction("start") { privateKey: String, address: String, serverPublicKey: String, endpoint: String ->
      Wgbridge.start(privateKey, address, serverPublicKey, endpoint)
    }

    AsyncFunction("setEndpoint") { endpoint: String -> Wgbridge.setEndpoint(endpoint) }

    AsyncFunction<Unit>("rehandshake") { Wgbridge.rehandshake() }

    AsyncFunction("probe") { timeoutMs: Int -> Wgbridge.probe(timeoutMs.toLong()) }

    Function<Long>("lastHandshake") { Wgbridge.lastHandshake() }

    Function<Boolean>("running") { Wgbridge.running() }

    AsyncFunction<Unit>("stop") { Wgbridge.stop() }

    AsyncFunction<String>("proxyStart") { Wgbridge.proxyStart() }

    AsyncFunction<Unit>("proxyStop") { Wgbridge.proxyStop() }

    Function<Unit>("startDiscovery") { startDiscovery() }

    Function<Unit>("stopDiscovery") { stopDiscovery() }

    OnDestroy { stopDiscovery() }
  }

  private fun startDiscovery() {
    val ctx = context ?: return
    stopDiscovery()
    val m = ctx.getSystemService(Context.NSD_SERVICE) as NsdManager
    val l = object : NsdManager.DiscoveryListener {
      override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
        Log.w(TAG, "keşif başlamadı: $errorCode")
      }
      override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
      override fun onDiscoveryStarted(serviceType: String) {}
      override fun onDiscoveryStopped(serviceType: String) {}
      override fun onServiceFound(info: NsdServiceInfo) {
        enqueueResolve(info)
      }
      override fun onServiceLost(info: NsdServiceInfo) {
        sendEvent("onDeviceLost", mapOf<String, Any?>("name" to info.serviceName))
      }
    }
    try {
      m.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, l)
      nsd = m
      discovery = l
    } catch (e: Exception) {
      Log.w(TAG, "keşif: ${e.message}")
    }
  }

  private fun stopDiscovery() {
    val m = nsd
    val l = discovery
    nsd = null
    discovery = null
    synchronized(lock) {
      resolveQueue.clear()
      resolving = false
    }
    if (m != null && l != null) {
      try {
        m.stopServiceDiscovery(l)
      } catch (e: Exception) {
        Log.w(TAG, "keşif durdurulamadı: ${e.message}")
      }
    }
  }

  private fun enqueueResolve(info: NsdServiceInfo) {
    synchronized(lock) {
      resolveQueue.addLast(info)
      if (resolving) return
      resolving = true
    }
    resolveNext()
  }

  @Suppress("DEPRECATION")
  private fun resolveNext() {
    val m = nsd
    val next = synchronized(lock) {
      val n = resolveQueue.removeFirstOrNull()
      if (n == null || m == null) resolving = false
      n
    }
    if (next == null || m == null) return
    try {
      m.resolveService(next, object : NsdManager.ResolveListener {
        override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
          resolveNext()
        }
        override fun onServiceResolved(info: NsdServiceInfo) {
          found(info)
          resolveNext()
        }
      })
    } catch (e: Exception) {
      Log.w(TAG, "çözümlenemedi: ${e.message}")
      resolveNext()
    }
  }

  @Suppress("DEPRECATION")
  private fun found(info: NsdServiceInfo) {
    val addrs: List<InetAddress> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) info.hostAddresses else listOfNotNull(info.host)
    val v4 = addrs.firstOrNull { it is Inet4Address }?.hostAddress ?: return
    val txt = info.attributes.mapValues { (_, v) -> if (v == null) "" else String(v, Charsets.UTF_8) }
    sendEvent("onDeviceFound", mapOf<String, Any?>(
      "name" to info.serviceName, "host" to v4, "port" to info.port,
      "id" to (txt["id"] ?: ""), "role" to (txt["role"] ?: ""), "app" to (txt["app"] ?: ""),
    ))
  }
}
