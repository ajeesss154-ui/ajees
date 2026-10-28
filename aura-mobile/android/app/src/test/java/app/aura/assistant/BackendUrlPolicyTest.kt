package app.aura.assistant

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

@RunWith(Parameterized::class)
class BackendUrlPolicyTest(private val url: String, private val debug: Boolean, private val accepted: Boolean) {
    @Test fun enforcesConnectionBoundary() {
        val actual = runCatching { BackendUrlPolicy.validate(url, debug) }.isSuccess
        assertEquals("URL acceptance differs for debug=$debug: $url", accepted, actual)
    }

    companion object {
        @JvmStatic @Parameterized.Parameters(name = "{index}: debug={1} {0}")
        fun cases(): List<Array<Any>> = listOf(
            arrayOf("https://aura.example.com", false, true),
            arrayOf("https://aura.example.com/api/", true, true),
            arrayOf("http://localhost:8787", true, true),
            arrayOf("http://127.0.0.1:8787", true, true),
            arrayOf("http://10.0.2.2:8787", true, true),
            arrayOf("http://192.168.1.10:8787", true, true),
            arrayOf("http://172.16.0.1", true, true),
            arrayOf("http://172.31.255.254", true, true),
            arrayOf("http://10.255.255.254", true, true),
            arrayOf("http://localhost:8787", false, false),
            arrayOf("http://10.0.2.2:8787", false, false),
            arrayOf("http://192.168.1.10:8787", false, false),
            arrayOf("http://example.com", true, false),
            arrayOf("http://8.8.8.8", true, false),
            arrayOf("http://172.32.0.1", true, false),
            arrayOf("http://192.169.1.10", true, false),
            arrayOf("http://10.0.0.1.evil.example", true, false),
            arrayOf("http://192.168.001.1", true, false),
            arrayOf("https://user:secret@example.com", true, false),
            arrayOf("https://example.com?token=secret", true, false),
            arrayOf("https://example.com#fragment", true, false),
            arrayOf("https://example.com:0", true, false),
            arrayOf("https://example.com:65536", true, false),
            arrayOf("ftp://192.168.1.1", true, false),
            arrayOf("javascript:alert(1)", true, false),
            arrayOf("not-a-url", true, false),
            arrayOf("", false, true)
        )
    }
}
