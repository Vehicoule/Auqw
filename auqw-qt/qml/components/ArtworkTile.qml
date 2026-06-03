import QtQuick
import QtQuick.Controls

Rectangle {
    id: tile

    property string artworkUrl: ""
    property string fallbackText: "A"
    property color fallbackColor: "#222a31"
    property color textColor: "#d3ded7"
    property color borderColor: "#42505c"
    property real tileRadius: 8

    radius: tileRadius
    color: fallbackColor
    border.color: borderColor
    border.width: 1
    clip: true

    Image {
        anchors.fill: parent
        source: tile.artworkUrl
        fillMode: Image.PreserveAspectCrop
        visible: tile.artworkUrl.length > 0
        asynchronous: true
        cache: true
    }

    Label {
        anchors.centerIn: parent
        text: tile.fallbackText.length > 0 ? tile.fallbackText.charAt(0).toUpperCase() : "A"
        visible: tile.artworkUrl.length === 0
        color: tile.textColor
        font.pixelSize: Math.max(16, Math.round(Math.min(tile.width, tile.height) * 0.36))
        font.weight: Font.Bold
    }
}
