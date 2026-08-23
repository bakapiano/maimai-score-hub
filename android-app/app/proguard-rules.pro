-keepattributes *Annotation*

# OkHttp detects these optional desktop/JVM TLS providers reflectively. Android
# uses its platform TLS provider, so the optional implementations are absent.
-dontwarn org.bouncycastle.jsse.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**
