package com.jarvis.shop

import android.app.Application
import android.content.Context
import com.jarvis.shop.audio.Recorder
import com.jarvis.shop.audio.Speaker
import com.jarvis.shop.data.ApiClient
import com.jarvis.shop.data.AuthManager
import com.jarvis.shop.data.SessionStore
import com.jarvis.shop.data.ShopRepository

/** Hand-wired dependencies: small enough that a DI framework would only add build time. */
class AppGraph(context: Context) {
    val session = SessionStore(context)
    val api = ApiClient(session)
    val auth = AuthManager(api, session)
    val repo = ShopRepository(api, session)
    val appContext: Context = context.applicationContext
    val speaker = Speaker(context)
    init { api.refresh = auth::refresh }
    fun newRecorder() = Recorder()
}

class JarvisApp : Application() {
    lateinit var graph: AppGraph
    override fun onCreate() { super.onCreate(); graph = AppGraph(this) }
}

val Context.graph: AppGraph get() = (applicationContext as JarvisApp).graph
