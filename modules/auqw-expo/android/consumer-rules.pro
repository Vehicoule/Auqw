# JNA + UniFFI keep rules (merged into the consuming app's R8 config).
#
# JNA reflects over generated Structure subclasses: it reads declared
# public field names AND the @FieldOrder class annotation (Structure
# .getFieldOrder() walks the hierarchy, so RustBuffer$ByValue inherits
# RustBuffer's annotation). -keepclassmembers is NOT enough — it preserves
# members but lets R8 strip the class-level annotation and rename the
# class, which crashes the first FFI call with:
#   "Structure.getFieldOrder() on class ...RustBuffer$ByValue does not
#   provide enough names [0] ([]) to match declared fields [3]".
# Full -keep + *Annotation* retention is required.
#
# JNA also ships desktop AWT references that can't resolve under R8 — the
# code paths using them never run on Android.
-dontwarn java.awt.**
-dontwarn com.sun.jna.**

# Runtime annotations carry the @FieldOrder metadata JNA needs.
-keepattributes *Annotation*

# JNA's own classes reach their members reflectively (Pointer.peer, etc.).
-keep class com.sun.jna.** { *; }

# The generated UniFFI binding package: Structure subclasses, the JNA
# Library interface (proxied by Native.load), and Callback interfaces —
# all reflection targets, so keep names + members + annotations intact.
-keep class uniffi.** { *; }

# Belt-and-suspenders for any other JNA Structure/Library/Callback
# subclass on the classpath.
-keep class * extends com.sun.jna.** { *; }
