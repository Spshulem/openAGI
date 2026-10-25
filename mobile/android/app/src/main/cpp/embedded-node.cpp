#include <jni.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unistd.h>
namespace node { int Start(int argc, char* argv[]); }

// Called once on a dedicated 16 MB thread, never the UI thread. Credentials
// stay in the process environment and never appear in argv or logcat.
extern "C" JNIEXPORT jint JNICALL
Java_sh_openagi_mobile_embedded_EmbeddedAgent_startNode(JNIEnv* env, jobject,
        jstring root, jstring data, jstring token, jint port, jstring zone) {
    auto copy = [env](jstring value) {
        const char* chars = env->GetStringUTFChars(value, nullptr);
        std::string result(chars);
        env->ReleaseStringUTFChars(value, chars);
        return result;
    };
    auto runtime = copy(root), directory = copy(data), secret = copy(token), timezone = copy(zone);
    setenv("OPENAGI_DATA_DIR", directory.c_str(), 1);
    setenv("OPENAGI_AUTH_TOKEN", secret.c_str(), 1);
    setenv("OPENAGI_TIME_ZONE", timezone.c_str(), 1);
    setenv("TZ", timezone.c_str(), 1);
    setenv("PORT", std::to_string(port).c_str(), 1);
    if (chdir(runtime.c_str()) != 0) return -1;
    // Node may retain argv for the entire process lifetime.
    std::string entry = runtime + "/bin/mobile-entry.mjs";
    auto* storage = new char[5 + 10 + entry.size() + 1];
    char* args[] = {storage, storage + 5, storage + 15, nullptr};
    strcpy(args[0], "node");
    strcpy(args[1], "--jitless");
    strcpy(args[2], entry.c_str());
    return node::Start(3, args);
}
