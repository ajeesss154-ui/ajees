package app.aura.assistant

import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArraySet

/** Ephemeral session only: AI mode is always off after a process restart. */
object AssistantSession {
    @Volatile var aiMode: Boolean = false
        private set
    private val main = Handler(Looper.getMainLooper())
    val stateListeners = CopyOnWriteArraySet<() -> Unit>()
    val shutdownListeners = CopyOnWriteArraySet<() -> Unit>()
    @Volatile var selectedScreen: JSONObject? = null
        private set
    private var screenExpiry: Runnable? = null
    private var screenGeneration = 0
    fun selectScreen(screen: JSONObject?) {
        screenExpiry?.let(main::removeCallbacks)
        selectedScreen = screen
        val generation = ++screenGeneration
        if (screen != null) {
            val expire = Runnable {
                if (screenGeneration == generation) { selectedScreen = null; screenExpiry = null }
            }
            screenExpiry = expire
            main.postDelayed(expire, 60000)
        } else screenExpiry = null
    }
    fun consumeScreen(): JSONObject? {
        val screen = selectedScreen
        selectScreen(null)
        return screen
    }
    private val usedActionIds = LinkedHashSet<String>()

    fun setMode(enabled: Boolean) {
        aiMode = enabled
        if (!enabled) {
            selectScreen(null)
            shutdownListeners.forEach { listener -> main.post { listener() } }
        }
        stateListeners.forEach { listener -> main.post { listener() } }
    }

    @Synchronized fun claimAction(id: String): Boolean {
        if (usedActionIds.contains(id)) return false
        usedActionIds.add(id)
        if (usedActionIds.size > 100) usedActionIds.remove(usedActionIds.first())
        return true
    }
}
