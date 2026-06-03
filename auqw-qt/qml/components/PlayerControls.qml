import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

RowLayout {
    id: playerControls

    property bool compact: false
    property bool playing: false
    property bool repeatActive: false
    property bool shuffleActive: false
    property bool trackActionEnabled: false
    property color accentColor: "#6df0b2"
    property color iconColor: "#d3ded7"
    property color mutedColor: "#7f8b84"
    property color surfaceColor: "#29323a"
    property color borderColor: "#42505c"
    property int controlSize: compact ? 44 : 52

    signal favoriteRequested()
    signal previousRequested()
    signal playPauseRequested()
    signal nextRequested()
    signal repeatRequested()
    signal downloadRequested()
    signal queueRequested()
    signal shuffleRequested()

    Layout.fillWidth: false
    Layout.preferredWidth: implicitWidth
    Layout.maximumWidth: implicitWidth
    implicitWidth: (controlSize * 5) + (controlSize + 8) + (spacing * 5)
    implicitHeight: controlSize + 8
    spacing: compact ? 6 : 8

    component ControlIcon: Canvas {
        id: icon

        property string kind: ""
        property color strokeColor: "#d3ded7"

        implicitWidth: 22
        implicitHeight: 22
        antialiasing: true
        onKindChanged: requestPaint()
        onStrokeColorChanged: requestPaint()
        onWidthChanged: requestPaint()
        onHeightChanged: requestPaint()

        onPaint: {
            var ctx = getContext("2d")
            var w = width
            var h = height
            ctx.clearRect(0, 0, w, h)
            ctx.lineWidth = Math.max(1.8, Math.min(w, h) * 0.09)
            ctx.lineCap = "round"
            ctx.lineJoin = "round"
            ctx.strokeStyle = strokeColor
            ctx.fillStyle = strokeColor

            function x(v) { return w * v / 24 }
            function y(v) { return h * v / 24 }
            function line(x1, y1, x2, y2) {
                ctx.beginPath()
                ctx.moveTo(x(x1), y(y1))
                ctx.lineTo(x(x2), y(y2))
                ctx.stroke()
            }
            function poly(points, closed, filled) {
                ctx.beginPath()
                ctx.moveTo(x(points[0]), y(points[1]))
                for (var i = 2; i < points.length; i += 2) {
                    ctx.lineTo(x(points[i]), y(points[i + 1]))
                }
                if (closed) {
                    ctx.closePath()
                }
                if (filled) {
                    ctx.fill()
                } else {
                    ctx.stroke()
                }
            }

            if (kind === "heart") {
                ctx.beginPath()
                ctx.moveTo(x(12), y(20))
                ctx.bezierCurveTo(x(5), y(15), x(4), y(10), x(8), y(7))
                ctx.bezierCurveTo(x(10), y(5.6), x(12), y(7.2), x(12), y(9))
                ctx.bezierCurveTo(x(12), y(7.2), x(14), y(5.6), x(16), y(7))
                ctx.bezierCurveTo(x(20), y(10), x(19), y(15), x(12), y(20))
                ctx.stroke()
            } else if (kind === "previous") {
                poly([5, 5, 5, 19], false, false)
                poly([18, 5, 8, 12, 18, 19], true, false)
            } else if (kind === "play") {
                poly([8, 5, 19, 12, 8, 19], true, true)
            } else if (kind === "pause") {
                ctx.fillRect(x(7), y(5), x(3), y(14))
                ctx.fillRect(x(14), y(5), x(3), y(14))
            } else if (kind === "next") {
                poly([19, 5, 19, 19], false, false)
                poly([6, 5, 16, 12, 6, 19], true, false)
            } else if (kind === "repeat") {
                line(7, 8, 17, 8)
                poly([15, 5, 18, 8, 15, 11], false, false)
                line(17, 16, 7, 16)
                poly([9, 13, 6, 16, 9, 19], false, false)
            } else if (kind === "more") {
                ctx.beginPath()
                ctx.arc(x(7), y(12), Math.min(w, h) * 1.3 / 24, 0, Math.PI * 2)
                ctx.arc(x(12), y(12), Math.min(w, h) * 1.3 / 24, 0, Math.PI * 2)
                ctx.arc(x(17), y(12), Math.min(w, h) * 1.3 / 24, 0, Math.PI * 2)
                ctx.fill()
            }
        }
    }

    component ControlButton: Button {
        id: controlButton

        property string iconName: ""
        property string iconObjectName: ""
        property string tooltip: ""
        property bool prominent: false

        text: ""
        padding: 0
        implicitWidth: prominent ? playerControls.controlSize + 8 : playerControls.controlSize
        implicitHeight: implicitWidth
        ToolTip.visible: hovered && tooltip.length > 0
        ToolTip.text: tooltip

        contentItem: Item {
            implicitWidth: controlButton.implicitWidth
            implicitHeight: controlButton.implicitHeight

            ControlIcon {
                objectName: controlButton.iconObjectName
                kind: controlButton.iconName
                strokeColor: controlButton.enabled
                    ? (controlButton.checked || controlButton.prominent ? playerControls.accentColor : playerControls.iconColor)
                    : playerControls.mutedColor
                anchors.centerIn: parent
                width: Math.min(controlButton.width, controlButton.height, controlButton.prominent ? 28 : 24)
                height: width
            }
        }

        background: Rectangle {
            radius: 8
            color: controlButton.checked || controlButton.prominent ? playerControls.surfaceColor : "transparent"
            border.color: controlButton.checked || controlButton.prominent ? playerControls.borderColor : "transparent"
            border.width: 1
        }
    }

    ControlButton {
        objectName: "nowPlayingFavoriteButton"
        iconName: "heart"
        enabled: playerControls.trackActionEnabled
        tooltip: "Favorite"
        onClicked: playerControls.favoriteRequested()
    }

    ControlButton {
        objectName: "miniPreviousButton"
        iconName: "previous"
        iconObjectName: "miniPreviousIcon"
        tooltip: "Previous"
        onClicked: playerControls.previousRequested()
    }

    ControlButton {
        objectName: "miniPlayPauseButton"
        iconName: playerControls.playing ? "pause" : "play"
        iconObjectName: "miniPlayPauseIcon"
        prominent: true
        tooltip: playerControls.playing ? "Pause" : "Play"
        onClicked: playerControls.playPauseRequested()
    }

    ControlButton {
        objectName: "miniNextButton"
        iconName: "next"
        iconObjectName: "miniNextIcon"
        tooltip: "Next"
        onClicked: playerControls.nextRequested()
    }

    ControlButton {
        objectName: "miniRepeatButton"
        iconName: "repeat"
        iconObjectName: "miniRepeatIcon"
        checkable: true
        checked: playerControls.repeatActive
        tooltip: "Repeat"
        onClicked: playerControls.repeatRequested()
    }

    ControlButton {
        id: overflowButton
        objectName: "nowPlayingOverflowButton"
        iconName: "more"
        tooltip: "More"
        onClicked: nowPlayingOverflowMenu.open()

        Menu {
            id: nowPlayingOverflowMenu
            objectName: "nowPlayingOverflowMenu"

            MenuItem {
                objectName: "nowPlayingDownloadMenuItem"
                text: "Download"
                enabled: playerControls.trackActionEnabled
                onTriggered: playerControls.downloadRequested()
            }

            MenuItem {
                objectName: "nowPlayingQueueMenuItem"
                text: "Add to Queue"
                enabled: playerControls.trackActionEnabled
                onTriggered: playerControls.queueRequested()
            }

            MenuItem {
                objectName: "nowPlayingShuffleMenuItem"
                text: playerControls.shuffleActive ? "Shuffle On" : "Shuffle Off"
                checkable: true
                checked: playerControls.shuffleActive
                onTriggered: playerControls.shuffleRequested()
            }
        }
    }
}
