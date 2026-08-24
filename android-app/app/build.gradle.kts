import com.android.build.gradle.internal.api.BaseVariantOutputImpl

plugins {
    id("com.android.application")
}

val betaKeystorePath = System.getenv("ANDROID_BETA_KEYSTORE_PATH")
val betaKeystorePassword = System.getenv("ANDROID_BETA_STORE_PASSWORD")
val betaKeyAlias = System.getenv("ANDROID_BETA_KEY_ALIAS")
val betaKeyPassword = System.getenv("ANDROID_BETA_KEY_PASSWORD")
val hasBetaSigning = listOf(
    betaKeystorePath,
    betaKeystorePassword,
    betaKeyAlias,
    betaKeyPassword,
).all { !it.isNullOrBlank() }
val appVersionCode = providers.gradleProperty("mshVersionCode")
    .orNull
    ?.toIntOrNull()
    ?: 4
val appVersionName = providers.gradleProperty("mshVersionName")
    .orNull
    ?.takeIf { it.isNotBlank() }
    ?: "0.2.2"

android {
    namespace = "com.bakapiano.maiscorehub.android"
    compileSdk = 35

    signingConfigs {
        if (hasBetaSigning) {
            create("beta") {
                storeFile = file(betaKeystorePath!!)
                storePassword = betaKeystorePassword
                keyAlias = betaKeyAlias
                keyPassword = betaKeyPassword
                storeType = "JKS"
            }
        }
    }

    defaultConfig {
        applicationId = "com.bakapiano.maiscorehub.android"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
        manifestPlaceholders["appLabel"] = "MaiScoreHub"
    }

    buildTypes {
        debug {
            buildConfigField("boolean", "E2E_ENABLED", "true")
            buildConfigField("boolean", "ALLOW_INSECURE_APP_UPDATES", "true")
            buildConfigField("String", "APP_RELEASE_CHANNEL", "\"debug\"")
            buildConfigField(
                "String",
                "APP_RELEASE_API_BASE_URL",
                "\"http://localhost:9050/api/v1\"",
            )
            buildConfigField(
                "String",
                "WEB_URL",
                "\"http://localhost:3001/app/sync\"",
            )
            manifestPlaceholders["usesCleartextTraffic"] = "true"
        }
        release {
            buildConfigField("boolean", "E2E_ENABLED", "false")
            buildConfigField("boolean", "ALLOW_INSECURE_APP_UPDATES", "false")
            buildConfigField("String", "APP_RELEASE_CHANNEL", "\"stable\"")
            buildConfigField(
                "String",
                "APP_RELEASE_API_BASE_URL",
                "\"https://api.maiscorehub.bakapiano.com/api/v1\"",
            )
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            buildConfigField(
                "String",
                "WEB_URL",
                "\"https://maiscorehub.bakapiano.com/app/sync\"",
            )
            manifestPlaceholders["usesCleartextTraffic"] = "false"
        }
        create("beta") {
            initWith(getByName("release"))
            applicationIdSuffix = ".beta"
            versionNameSuffix = "-beta"
            signingConfig = signingConfigs.findByName("beta")
                ?: signingConfigs.getByName("debug")
            buildConfigField("boolean", "E2E_ENABLED", "true")
            buildConfigField("boolean", "ALLOW_INSECURE_APP_UPDATES", "false")
            buildConfigField("String", "APP_RELEASE_CHANNEL", "\"beta\"")
            buildConfigField(
                "String",
                "WEB_URL",
                "\"https://maiscorehub.bakapiano.com/app/sync\"",
            )
            manifestPlaceholders["usesCleartextTraffic"] = "false"
            manifestPlaceholders["appLabel"] = "MaiScoreHub Beta"
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    applicationVariants.all {
        val variantName = name
        outputs.all {
            (this as BaseVariantOutputImpl).outputFileName =
                "MaiScoreHub-$variantName.apk"
        }
    }
}

dependencies {
    implementation("androidx.core:core:1.15.0")
    implementation("androidx.credentials:credentials:1.6.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.6.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("com.squareup.okhttp3:okhttp:4.10.0")
    implementation("com.squareup.okhttp3:okhttp-urlconnection:4.10.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
