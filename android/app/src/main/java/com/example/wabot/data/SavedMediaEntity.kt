package com.example.wabot.data

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "saved_media")
data class SavedMediaEntity(
    @PrimaryKey val waId: String,
    val jid: String,
    val pushName: String,
    val mediaType: String,
    val mime: String,
    val localFilePath: String = "",
    val mediaUrl: String = "",
    val directPath: String = "",
    val mediaKey: String = "",
    val encSha256: String = "",
    val fileSha256: String = "",
    val instancePhone: String = "",
    val timestamp: Long = System.currentTimeMillis()
)
