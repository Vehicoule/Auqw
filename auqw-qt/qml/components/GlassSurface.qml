import QtQuick

Rectangle {
    id: surface

    property color fillColor: "#cc14191f"
    property color strokeColor: "#2e3943"
    property color highlightColor: "#18ffffff"
    property real surfaceRadius: 8

    radius: surfaceRadius
    color: fillColor
    border.color: strokeColor
    border.width: 1

    Rectangle {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: 1
        height: 1
        radius: surface.radius
        color: surface.highlightColor
    }
}
