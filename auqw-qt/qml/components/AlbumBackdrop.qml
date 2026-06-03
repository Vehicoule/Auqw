import QtQuick
import QtQuick.Effects

Item {
    id: backdrop
    objectName: "immersiveAlbumBackdrop"

    property string sourceUrl: ""
    property color fallbackColor: "#080a0d"
    property color overlayColor: "#e6080a0d"
    property color vignetteColor: "#f0080a0d"
    readonly property bool hasArtwork: sourceUrl.length > 0

    Canvas {
        id: fallbackWash
        anchors.fill: parent
        visible: !backdrop.hasArtwork
        onPaint: {
            var ctx = getContext("2d")
            ctx.clearRect(0, 0, width, height)
            ctx.fillStyle = backdrop.fallbackColor
            ctx.fillRect(0, 0, width, height)

            var glow = ctx.createRadialGradient(width * 0.28, height * 0.16, 0, width * 0.28, height * 0.16, Math.max(width, height) * 0.7)
            glow.addColorStop(0, "#24352f")
            glow.addColorStop(0.38, "#121820")
            glow.addColorStop(1, "#080a0d")
            ctx.fillStyle = glow
            ctx.fillRect(0, 0, width, height)
        }
        onWidthChanged: requestPaint()
        onHeightChanged: requestPaint()
    }

    Image {
        id: albumBackdropSource
        objectName: "albumBackdropSource"
        anchors.fill: parent
        source: backdrop.sourceUrl
        fillMode: Image.PreserveAspectCrop
        visible: backdrop.hasArtwork
        opacity: 0.36
        asynchronous: true
        cache: true
    }

    MultiEffect {
        objectName: "albumBackdrop"
        anchors.fill: parent
        source: albumBackdropSource
        blurEnabled: true
        blur: 1.0
        blurMax: 72
        blurMultiplier: 1.45
        saturation: 1.25
        brightness: -0.08
        contrast: 1.18
        opacity: backdrop.hasArtwork ? 0.88 : 0
    }

    Rectangle {
        anchors.fill: parent
        color: backdrop.overlayColor
    }

    Rectangle {
        anchors.fill: parent
        color: "transparent"
        gradient: Gradient {
            GradientStop { position: 0.0; color: "#52080a0d" }
            GradientStop { position: 0.56; color: "#b0080a0d" }
            GradientStop { position: 1.0; color: backdrop.vignetteColor }
        }
    }
}
