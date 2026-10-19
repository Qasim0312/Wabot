package com.example.wabot.network

import android.content.Context
import com.example.wabot.BuildConfig
import com.example.wabot.crypto.WhatsAppCrypto
import com.example.wabot.data.AppDatabase
import com.example.wabot.data.SavedMediaEntity
import io.ktor.client.*
import io.ktor.client.call.*
import io.ktor.client.engine.android.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.serialization.kotlinx.json.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.io.FileOutputStream
import java.net.URL

@Serializable
data class PendingViewDto(
    @SerialName("wa_id") val waId: String,
    val jid: String,
    @SerialName("push_name") val pushName: String? = null,
    @SerialName("media_type") val mediaType: String,
    @SerialName("media_url") val mediaUrl: String,
    @SerialName("media_key") val mediaKey: String,
    val mime: String? = null,
    @SerialName("direct_path") val directPath: String? = null,
    @SerialName("enc_sha256") val encSha256: String? = null,
    @SerialName("file_sha256") val fileSha256: String? = null,
    @SerialName("instance_phone") val instancePhone: String? = null
)

class SyncEngine(private val context: Context) {
    private val supabaseUrl = BuildConfig.SUPABASE_URL.trimEnd('/')
    // Use the public anon/publishable key. Never embed the Supabase service-role key in an app.
    private val supabaseAnonKey = BuildConfig.SUPABASE_ANON_KEY

    private val db = AppDatabase.getInstance(context)

    private val client = HttpClient(Android) {
        install(ContentNegotiation) {
            json(Json { ignoreUnknownKeys = true })
        }
    }

    suspend fun pullAndDecryptSync(): Int = withContext(Dispatchers.IO) {
        var itemsSynced = 0
        try {
            require(supabaseUrl.startsWith("https://") && supabaseAnonKey.isNotBlank()) {
                "Set supabase.url and supabase.anonKey in android/local.properties before syncing."
            }
            // 1. Fetch pending rows from Supabase 'pending_views' table
            val response: HttpResponse = client.get("$supabaseUrl/rest/v1/pending_views") {
                header("apikey", supabaseAnonKey)
                header("Authorization", "Bearer $supabaseAnonKey")
                parameter("select", "instance_phone,wa_id,jid,push_name,media_type,media_url,direct_path,media_key,enc_sha256,file_sha256,mime,created_at")
            }

            if (response.status.value != 200) return@withContext 0
            val pendingList: List<PendingViewDto> = response.body()

            for (item in pendingList) {
                // Persist all message metadata first, so a media download failure cannot lose the message.
                val entity = SavedMediaEntity(
                    waId = item.waId,
                    jid = item.jid,
                    pushName = item.pushName ?: "Unknown",
                    mediaType = item.mediaType,
                    mime = item.mime ?: "",
                    mediaUrl = item.mediaUrl,
                    directPath = item.directPath ?: "",
                    mediaKey = item.mediaKey,
                    encSha256 = item.encSha256 ?: "",
                    fileSha256 = item.fileSha256 ?: "",
                    instancePhone = item.instancePhone ?: ""
                )
                db.savedMediaDao().insertMedia(entity)

                // 2. Stream down the encrypted binary directly from WhatsApp CDN URL
                val url = URL(item.mediaUrl)
                val connection = url.openConnection()
                val encryptedInputStream = connection.getInputStream()

                // Create a secure internal file destination path on your device
                val ext = if (item.mediaType == "video") "mp4" else if (item.mediaType == "audio") "ogg" else "jpg"
                val localFile = File(context.filesDir, "media_${item.waId}.$ext")
                val fileOutputStream = FileOutputStream(localFile)

                // 3. Decrypt on the fly using crypto parameters
                WhatsAppCrypto.decryptMedia(
                    encryptedStream = encryptedInputStream,
                    outputStream = fileOutputStream,
                    base64MediaKey = item.mediaKey,
                    mediaType = item.mediaType
                )
                fileOutputStream.close()
                encryptedInputStream.close()

                // 4. Save file reference path properties locally to Room DB
                db.savedMediaDao().updateLocalFilePath(item.waId, localFile.absolutePath)

                // 5. Clean up and delete row from Supabase queue table so it stays empty
                client.delete("$supabaseUrl/rest/v1/pending_views") {
                    header("apikey", supabaseAnonKey)
                    header("Authorization", "Bearer $supabaseAnonKey")
                    parameter("wa_id", "eq.${item.waId}")
                }

                itemsSynced++
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
        itemsSynced
    }
}
