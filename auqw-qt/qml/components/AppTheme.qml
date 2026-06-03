import QtQuick

Item {
    id: theme
    objectName: "appThemeRoot"

    property bool darkPrimary: true
    readonly property bool fullImmersiveDark: darkPrimary
    readonly property bool lightFallback: !darkPrimary

    readonly property color background: darkPrimary ? "#080a0d" : "#f4efe7"
    readonly property color backdropOverlay: darkPrimary ? "#d9080a0d" : "#ccf4efe7"
    readonly property color surface: darkPrimary ? "#e6181d23" : "#f8ffffff"
    readonly property color surfaceStrong: darkPrimary ? "#f0212730" : "#ffffffff"
    readonly property color panel: darkPrimary ? "#cc14191f" : "#dffafafa"
    readonly property color hover: darkPrimary ? "#29323a" : "#f3f2ef"
    readonly property color accent: darkPrimary ? "#6df0b2" : "#0e5a43"
    readonly property color accentSoft: darkPrimary ? "#293829" : "#d8efe6"
    readonly property color danger: darkPrimary ? "#ff6b7c" : "#a63b2f"
    readonly property color dangerSoft: darkPrimary ? "#3a1d25" : "#fff0f2"
    readonly property color warningSoft: darkPrimary ? "#3a2e1d" : "#fff6e8"
    readonly property color textPrimary: darkPrimary ? "#f3f7f4" : "#1f2522"
    readonly property color textSecondary: darkPrimary ? "#a8b5ad" : "#66736d"
    readonly property color textMuted: darkPrimary ? "#7f8b84" : "#7a817c"
    readonly property color border: darkPrimary ? "#42505c" : "#e5e0d7"
    readonly property color borderSoft: darkPrimary ? "#2e3943" : "#80ffffff"
    readonly property color icon: darkPrimary ? "#d3ded7" : "#4d5a54"
    readonly property color iconMuted: darkPrimary ? "#7f8b84" : "#9aa39e"
    readonly property color artworkFallback: darkPrimary ? "#222a31" : "#e2eae6"

    visible: false
    width: 0
    height: 0
}
