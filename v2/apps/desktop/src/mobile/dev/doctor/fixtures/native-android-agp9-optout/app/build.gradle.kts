plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "com.example.nativeapp"
    defaultConfig {
        applicationId = "com.example.nativeapp"
    }
    signingConfigs {
        create("release") {
            storeFile = file(System.getenv("KEYSTORE_PATH") ?: "release.jks")
        }
    }
}
