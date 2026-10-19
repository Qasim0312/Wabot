package com.example.wabot.crypto

import android.util.Base64
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.digests.SHA256Digest
import java.io.InputStream
import java.io.OutputStream
import javax.crypto.Cipher
import javax.crypto.CipherInputStream
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

object WhatsAppCrypto {
    private const val AUDIO_INFO = "WhatsApp Audio Keys"
    private const val IMAGE_INFO = "WhatsApp Image Keys"
    private const val VIDEO_INFO = "WhatsApp Video Keys"

    fun decryptMedia(
        encryptedStream: InputStream,
        outputStream: OutputStream,
        base64MediaKey: String,
        mediaType: String
    ) {
        val mediaKeyBytes = Base64.decode(base64MediaKey, Base64.DEFAULT)

        val infoString = when (mediaType.lowercase()) {
            "audio", "voice" -> AUDIO_INFO
            "image" -> IMAGE_INFO
            "video" -> VIDEO_INFO
            else -> throw IllegalArgumentException("Unsupported media type: $mediaType")
        }

        // Expand the mediaKey using HKDF-SHA256 to 112 bytes
        val hkdf = HKDFBytesGenerator(SHA256Digest())
        hkdf.init(HKDFParameters(mediaKeyBytes, null, infoString.toByteArray(Charsets.UTF_8)))

        val expandedKeys = ByteArray(112)
        hkdf.generateBytes(expandedKeys, 0, expandedKeys.size)

        // Extract the 16-byte IV and the 32-byte Cipher Key
        val ivBytes = expandedKeys.copyOfRange(0, 16)
        val cipherKeyBytes = expandedKeys.copyOfRange(32, 64)

        // Setup AES Decryption
        val secretKey = SecretKeySpec(cipherKeyBytes, "AES")
        val ivSpec = IvParameterSpec(ivBytes)
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey, ivSpec)

        // Decrypt the network stream chunk by chunk
        val buffer = ByteArray(4096)
        var bytesRead: Int
        val cipherInputStream = CipherInputStream(encryptedStream, cipher)

        while (cipherInputStream.read(buffer).also { bytesRead = it } != -1) {
            outputStream.write(buffer, 0, bytesRead)
        }
        cipherInputStream.close()
    }
}