package com.example.wabot

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

import androidx.activity.viewModels
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.example.wabot.data.SavedMediaEntity
import java.io.File

class MainActivity : ComponentActivity() {
    private val viewModel: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    // Trigger an automatic sync routine whenever you launch the app
                    LaunchedEffect(Unit) {
                        viewModel.triggerSync()
                    }
                    MediaDashboardScreen(viewModel)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MediaDashboardScreen(viewModel: MainViewModel) {
    val items = viewModel.savedMediaList.collectAsState().value
    val refreshing = viewModel.isRefreshing.value

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("WhatsApp View Once Box") },
                actions = {
                    Button(onClick = { viewModel.triggerSync() }, enabled = !refreshing) {
                        Text(if (refreshing) "Syncing..." else "Refresh")
                    }
                }
            )
        }
    ) { paddingValues ->
        if (items.isEmpty()) {
            Box(modifier = Modifier.fillMaxSize().padding(paddingValues), contentAlignment = Alignment.Center) {
                Text("No captured view-once media yet.", style = MaterialTheme.typography.bodyLarge)
            }
        } else {
            LazyColumn(modifier = Modifier.fillMaxSize().padding(paddingValues).padding(8.dp)) {
                items(items) { media ->
                    MediaItemRow(media)
                }
            }
        }
    }
}

@Composable
fun MediaItemRow(media: SavedMediaEntity) {
    Card(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Column(modifier = Modifier.padding(12.dp)) {
            Text(text = "From: ${media.pushName}", style = MaterialTheme.typography.titleMedium)
            Text(text = "Type: ${media.mediaType.uppercase()}", style = MaterialTheme.typography.bodySmall)
            Spacer(modifier = Modifier.height(8.dp))

            if (media.mediaType == "image") {
                if (media.localFilePath.isNotBlank() && File(media.localFilePath).exists()) {
                    AsyncImage(
                        model = File(media.localFilePath),
                        contentDescription = "Decrypted View Once Media",
                        modifier = Modifier.fillMaxWidth().height(200.dp).padding(top = 4.dp)
                    )
                } else {
                    Text("Metadata saved. Media file is not available yet.")
                }
            } else {
                Text(
                    text = "📁 File stored securely at:\n${media.localFilePath}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.primary
                )
            }
        }
    }
}
