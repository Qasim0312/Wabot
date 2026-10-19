package com.example.wabot.data;

import androidx.room.Dao;
import androidx.room.Insert;
import androidx.room.OnConflictStrategy;
import androidx.room.Query;

import java.util.List;
import kotlinx.coroutines.flow.Flow;

@Dao
public interface SavedMediaDao {
    @Query("SELECT * FROM saved_media ORDER BY timestamp DESC")
    Flow<List<SavedMediaEntity>> getAllMedia();

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    void insertMedia(SavedMediaEntity media);

    @Query("UPDATE saved_media SET localFilePath = :path WHERE waId = :waId")
    void updateLocalFilePath(String waId, String path);
}
