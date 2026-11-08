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
        versionCode = 9
        versionName = "0.1.8"
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
        externalNativeBuild { cmake { arguments += listOf("-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON", "-DANDROID_STL=c++_shared") } }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    ndkVersion = "27.2.12479018"
    externalNativeBuild { cmake { path = file("src/main/cpp/CMakeLists.txt"); version = "3.22.1" } }

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
        // Settings screen shows the build version per FEATURES.md ("so a bug
        // report can name one") — AGP 8 no longer generates BuildConfig by
        // default, so this is opted back in rather than hardcoding the
        // version string a second place.
        buildConfig = true
    }

    sourceSets {
        getByName("main").kotlin.srcDir("src/main/kotlin")
        getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/daemonAssets"))
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
    implementation("com.google.mlkit:genai-prompt:1.0.0-beta4")
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.window)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.security.crypto)
    implementation(libs.androidx.glance.appwidget)
    implementation(libs.androidx.glance.material3)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.kotlinx.coroutines.test)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}

val prepareEmbeddedRuntime by tasks.registering(Exec::class) {
    workingDir(rootDir)
    commandLine("bash", "scripts/prepare-embedded-runtime.sh")
}
tasks.configureEach {
    if (name == "preBuild" || name.startsWith("configureCMake") || name.startsWith("mergeDebugAssets") || name.startsWith("mergeReleaseAssets")) dependsOn(prepareEmbeddedRuntime)
}
