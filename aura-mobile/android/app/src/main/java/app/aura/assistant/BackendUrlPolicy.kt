package app.aura.assistant

import java.net.URI

/** Release connections require TLS. Debug HTTP is confined to explicit local targets. */
internal object BackendUrlPolicy {
    fun validate(value: String, debug: Boolean): String {
        val clean = value.trim().trimEnd('/')
        if (clean.isEmpty()) return clean
        require(clean.length <= 2048) { "Backend URL is too long." }
        val uri = URI(clean)
        require(!uri.host.isNullOrBlank() && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null && (uri.port == -1 || uri.port in 1..65535)) { "Use a backend URL without credentials, a query, or a fragment, and with a valid port." }
        val scheme = uri.scheme?.lowercase()
        val host = uri.host.lowercase()
        val debugLocal = host == "localhost" || host == "127.0.0.1" || privateIpv4(host)
        require(scheme == "https" || (debug && scheme == "http" && debugLocal)) {
            if (debug) "Use HTTPS, or debug HTTP to localhost, 127.0.0.1, 10.0.2.2, or a private LAN IPv4 address."
            else "Use an HTTPS backend URL."
        }
        return clean
    }

    private fun privateIpv4(host: String): Boolean {
        val parts = host.split('.')
        if (parts.size != 4 || parts.any { it.isEmpty() || it.length > 3 || it.any { char -> char !in '0'..'9' } || (it.length > 1 && it.startsWith('0')) }) return false
        val numbers = parts.map { it.toIntOrNull() ?: return false }
        if (numbers.any { it !in 0..255 }) return false
        return numbers[0] == 10 || (numbers[0] == 172 && numbers[1] in 16..31) || (numbers[0] == 192 && numbers[1] == 168)
    }
}
