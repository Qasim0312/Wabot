package com.example.wabot

import android.app.Application
import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.example.wabot.data.AppDatabase
import com.example.wabot.data.SavedMediaEntity
import com.example.wabot.network.SyncEngine
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val syncEngine = SyncEngine(application)
    private val dao = AppDatabase.getInstance(application).savedMediaDao()

    val savedMediaList: StateFlow<List<SavedMediaEntity>> = dao.getAllMedia()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    var isRefreshing = mutableStateOf(false)
        private set

    fun triggerSync() {
        viewModelScope.launch {
            isRefreshing.value = true
            syncEngine.pullAndDecryptSync()
            isRefreshing.value = false
        }
    }
}
