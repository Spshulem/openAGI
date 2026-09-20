import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "sh.openagi.mobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "sh.openagi.mobile"
        minSdk = 31
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    // Compile to Java 17 bytecode using whatever JDK Gradle is running on
    // (Android Studio's JDK 21). Do not set a jvmToolchain: there is no
    // standalone JDK 17 on this machine and auto-provisioning would download one.
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    sourceSets {
        getByName("main").kotlin.srcDir("src/main/kotlin")
        getByName("test").kotlin.srcDir("src/test/kotlin")
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

// kotlinOptions { jvmTarget = "17" } is a hard compile error under Kotlin
// 2.3.21's Gradle plugin ("Using 'jvmTarget: String' is an error. Please
// migrate to the compilerOptions DSL."). This is the equivalent
// compilerOptions form: same Java 17 bytecode target, still no
// jvmToolchain() call, so nothing auto-provisions a JDK.
kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}
