package com.example.wabot.data;

import android.content.Context;
import androidx.room.Database;
import androidx.room.Room;
import androidx.room.RoomDatabase;

@Database(entities = {SavedMediaEntity.class}, version = 2, exportSchema = false)
public abstract class AppDatabase extends RoomDatabase {
    public abstract SavedMediaDao savedMediaDao();

    private static volatile AppDatabase INSTANCE;

    public static AppDatabase getInstance(Context context) {
        if (INSTANCE == null) {
            synchronized (AppDatabase.class) {
                if (INSTANCE == null) {
                    INSTANCE = Room.databaseBuilder(
                        context.getApplicationContext(),
                        AppDatabase.class,
                        "wa_saved_media.db"
                    ).addMigrations(MIGRATION_1_2).build();
                }
            }
        }
        return INSTANCE;
    }

    private static final androidx.room.migration.Migration MIGRATION_1_2 =
        new androidx.room.migration.Migration(1, 2) {
            @Override
            public void migrate(androidx.sqlite.db.SupportSQLiteDatabase database) {
                database.execSQL("ALTER TABLE saved_media ADD COLUMN mediaUrl TEXT NOT NULL DEFAULT ''");
                database.execSQL("ALTER TABLE saved_media ADD COLUMN directPath TEXT NOT NULL DEFAULT ''");
                database.execSQL("ALTER TABLE saved_media ADD COLUMN mediaKey TEXT NOT NULL DEFAULT ''");
                database.execSQL("ALTER TABLE saved_media ADD COLUMN encSha256 TEXT NOT NULL DEFAULT ''");
                database.execSQL("ALTER TABLE saved_media ADD COLUMN fileSha256 TEXT NOT NULL DEFAULT ''");
                database.execSQL("ALTER TABLE saved_media ADD COLUMN instancePhone TEXT NOT NULL DEFAULT ''");
            }
        };
}
