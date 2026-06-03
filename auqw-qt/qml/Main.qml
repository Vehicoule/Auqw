import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs
import QtQuick.Effects
import QtQuick.Layouts
import QtQuick.Window
import "components"

ApplicationWindow {
    id: root
    objectName: "auqwShellWindow"

    width: 1180
    height: 760
    minimumWidth: 360
    minimumHeight: 560
    visible: true
    title: coreController.appName.length > 0 ? coreController.appName : "Auqw"
    color: appThemeRoot.background

    readonly property bool mobilePlatform: Qt.platform.os === "android" || Qt.platform.os === "ios"
    readonly property bool compact: root.width < 760 || root.mobilePlatform
    readonly property int density: root.compact ? 54 : 44
    readonly property int pagePadding: root.compact ? 14 : 24
    readonly property int pageGap: root.compact ? 12 : 16
    readonly property int navWidth: root.compact
        ? (root.hasPlayback ? Math.max(154, Math.round((root.width - root.pagePadding * 3) * 0.52)) : Math.min(root.width - 28, 230))
        : 270
    readonly property int queuePanelWidth: Math.min(330, Math.max(280, Math.round(root.width * 0.27)))
    readonly property int safeTop: root.mobilePlatform ? 44 : 0
    readonly property int safeBottom: root.mobilePlatform ? 10 : 0
    readonly property int topChromeHeight: root.compact ? 54 : root.density
    readonly property var themeOptions: ["system", "light", "dark"]
    readonly property bool hasPlayback: coreController.playbackState !== "stopped" && coreController.playbackTitle.length > 0
    readonly property real playbackProgress: coreController.playbackDurationMs > 0
        ? Math.max(0, Math.min(1, coreController.playbackPositionMs / coreController.playbackDurationMs))
        : 0

    property int currentPageIndex: 0
    property string selectedDownloadId: ""
    property string searchPageQuery: ""
    property string submittedSearchQuery: ""
    property bool focusSearchFieldOnPage: false
    property bool searchOverlayOpen: false
    property real miniPlayerDragOffset: 0

    AppTheme {
        id: appThemeRoot
        darkPrimary: true
    }

    function goTo(index) {
        currentPageIndex = Math.max(0, Math.min(index, 2))
        searchOverlayOpen = false
    }

    function openSearchPage(query, focusField) {
        searchPageQuery = query
        if (focusField) {
            focusSearchFieldOnPage = true
        }
        searchOverlayOpen = true
    }

    function updateSearchQuery(query) {
        searchPageQuery = query
        coreController.suggestOnline(query)
    }

    function submitSearch(query, sourceField) {
        var trimmedQuery = query.trim()
        if (sourceField) {
            sourceField.focus = false
        }
        Qt.inputMethod.hide()
        if (trimmedQuery.length === 0) {
            return
        }
        searchOverlayOpen = true
        searchPageQuery = trimmedQuery
        submittedSearchQuery = trimmedQuery
        coreController.searchOnline(trimmedQuery)
    }

    function goSearch(query) {
        openSearchPage(query, true)
    }

    function playbackDetailText() {
        if (coreController.playbackErrorMessage.length > 0) {
            return coreController.playbackErrorMessage
        }
        var byline = [coreController.playbackArtist, coreController.playbackAlbum].filter(function(item) { return item.length > 0 }).join(" | ")
        return byline.length > 0 ? byline : (coreController.playbackState.length > 0 ? coreController.playbackState : "stopped")
    }

    function formatDuration(durationMs) {
        if (durationMs <= 0) {
            return ""
        }
        var totalSeconds = Math.floor(durationMs / 1000)
        var minutes = Math.floor(totalSeconds / 60)
        var seconds = totalSeconds % 60
        return minutes + ":" + (seconds < 10 ? "0" + seconds : seconds)
    }

    function formatProgress() {
        var position = root.formatDuration(coreController.playbackPositionMs)
        var duration = root.formatDuration(coreController.playbackDurationMs)
        if (position.length === 0 && duration.length === 0) {
            return coreController.playbackState
        }
        return position + " / " + duration
    }

    function handlePlayPause() {
        if (coreController.playbackState === "playing") {
            coreController.pausePlayback()
        } else if (coreController.playbackState === "paused") {
            coreController.resumePlayback()
        } else {
            coreController.playFirstQueuedTrack()
        }
    }

    function stopPlaybackFromSwipe() {
        nowPlayingSheet.close()
        root.miniPlayerDragOffset = 0
        coreController.stopPlayback()
    }

    component DrawnIcon: Canvas {
        id: icon

        property string kind: ""
        property color strokeColor: "#4d5a54"

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
            function circle(cx, cy, r) {
                ctx.beginPath()
                ctx.arc(x(cx), y(cy), Math.min(w, h) * r / 24, 0, Math.PI * 2)
                ctx.stroke()
            }
            function rect(rx, ry, rw, rh, filled) {
                ctx.beginPath()
                ctx.rect(x(rx), y(ry), x(rw), y(rh))
                if (filled) {
                    ctx.fill()
                } else {
                    ctx.stroke()
                }
            }

            if (kind === "home") {
                poly([4, 11, 12, 4, 20, 11], false, false)
                poly([6, 10, 6, 20, 18, 20, 18, 10], false, false)
                line(11, 20, 11, 15)
                line(13, 20, 13, 15)
            } else if (kind === "library") {
                rect(5, 5, 14, 14, false)
                line(9, 5, 9, 19)
                line(5, 10, 19, 10)
                line(5, 15, 19, 15)
            } else if (kind === "settings") {
                line(5, 7, 19, 7)
                line(5, 12, 19, 12)
                line(5, 17, 19, 17)
                circle(9, 7, 1.6)
                circle(15, 12, 1.6)
                circle(11, 17, 1.6)
            } else if (kind === "search") {
                circle(10, 10, 5)
                line(14, 14, 20, 20)
            } else if (kind === "heart") {
                ctx.beginPath()
                ctx.moveTo(x(12), y(20))
                ctx.bezierCurveTo(x(5), y(15), x(4), y(10), x(8), y(7))
                ctx.bezierCurveTo(x(10), y(5.6), x(12), y(7.2), x(12), y(9))
                ctx.bezierCurveTo(x(12), y(7.2), x(14), y(5.6), x(16), y(7))
                ctx.bezierCurveTo(x(20), y(10), x(19), y(15), x(12), y(20))
                ctx.stroke()
            } else if (kind === "download") {
                line(12, 5, 12, 15)
                poly([8, 11, 12, 15, 16, 11], false, false)
                line(6, 19, 18, 19)
            } else if (kind === "queue") {
                line(5, 7, 14, 7)
                line(5, 12, 14, 12)
                line(5, 17, 14, 17)
                line(18, 10, 18, 20)
                line(13, 15, 23, 15)
            } else if (kind === "previous") {
                poly([5, 5, 5, 19], false, false)
                poly([18, 5, 8, 12, 18, 19], true, false)
            } else if (kind === "play") {
                poly([8, 5, 19, 12, 8, 19], true, true)
            } else if (kind === "pause") {
                rect(7, 5, 3, 14, true)
                rect(14, 5, 3, 14, true)
            } else if (kind === "next") {
                poly([19, 5, 19, 19], false, false)
                poly([6, 5, 16, 12, 6, 19], true, false)
            } else if (kind === "stop") {
                rect(7, 7, 10, 10, true)
            } else if (kind === "repeat") {
                line(7, 8, 17, 8)
                poly([15, 5, 18, 8, 15, 11], false, false)
                line(17, 16, 7, 16)
                poly([9, 13, 6, 16, 9, 19], false, false)
            } else if (kind === "shuffle") {
                line(5, 7, 9, 7)
                line(9, 7, 16, 17)
                line(16, 17, 20, 17)
                poly([18, 14, 21, 17, 18, 20], false, false)
                line(5, 17, 9, 17)
                line(9, 17, 16, 7)
                line(16, 7, 20, 7)
                poly([18, 4, 21, 7, 18, 10], false, false)
            } else if (kind === "remove") {
                line(7, 7, 17, 17)
                line(17, 7, 7, 17)
            } else if (kind === "up") {
                poly([7, 14, 12, 9, 17, 14], false, false)
                line(12, 9, 12, 20)
            } else if (kind === "down") {
                poly([7, 10, 12, 15, 17, 10], false, false)
                line(12, 4, 12, 15)
            } else if (kind === "track") {
                line(10, 5, 10, 17)
                line(10, 5, 17, 7)
                circle(7.5, 17, 2.5)
            }
        }
    }

    component IconButton: Button {
        id: iconButton

        property string iconName: ""
        property string iconObjectName: ""
        property string tooltip: ""

        text: ""
        flat: true
        padding: 0
        implicitWidth: root.density
        implicitHeight: root.density
        ToolTip.visible: hovered && tooltip.length > 0
        ToolTip.text: tooltip

        contentItem: Item {
            implicitWidth: iconButton.implicitWidth
            implicitHeight: iconButton.implicitHeight

            DrawnIcon {
                objectName: iconButton.iconObjectName
                kind: iconButton.iconName
                strokeColor: iconButton.enabled
                    ? (iconButton.checked ? appThemeRoot.accent : appThemeRoot.icon)
                    : appThemeRoot.iconMuted
                anchors.centerIn: parent
                width: Math.min(iconButton.width, iconButton.height, 24)
                height: width
            }
        }

        background: Rectangle {
            radius: 8
            color: iconButton.checked
                ? appThemeRoot.accentSoft
                : iconButton.pressed ? appThemeRoot.hover : "transparent"
            border.color: iconButton.checked ? appThemeRoot.accent : "transparent"
            border.width: 1
        }
    }

    component GlassFrame: Frame {
        padding: root.pagePadding
        background: GlassSurface {
            surfaceRadius: 8
            fillColor: appThemeRoot.panel
            strokeColor: appThemeRoot.borderSoft
        }
    }

    component SettingsGroup: GroupBox {
        id: settingsGroup

        Layout.fillWidth: true
        padding: root.pagePadding
        topPadding: root.pagePadding + 26
        leftPadding: root.pagePadding
        rightPadding: root.pagePadding
        bottomPadding: root.pagePadding

        label: Label {
            text: settingsGroup.title
            color: appThemeRoot.textSecondary
            font.pixelSize: 13
            font.weight: Font.DemiBold
            leftPadding: settingsGroup.leftPadding
            elide: Text.ElideRight
        }

        background: Rectangle {
            y: settingsGroup.topPadding - settingsGroup.padding
            width: parent.width
            height: parent.height - y
            radius: 8
            color: appThemeRoot.panel
            border.color: appThemeRoot.borderSoft
            border.width: 1
        }
    }

    component SettingsButton: Button {
        id: settingsButton

        padding: 0
        implicitHeight: root.density

        contentItem: Label {
            text: settingsButton.text
            color: settingsButton.enabled
                ? (settingsButton.checked ? appThemeRoot.accent : appThemeRoot.textPrimary)
                : appThemeRoot.textMuted
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight
            font.pixelSize: 14
            font.weight: Font.DemiBold
        }

        background: Rectangle {
            radius: 8
            color: settingsButton.checked
                ? appThemeRoot.accentSoft
                : settingsButton.pressed ? appThemeRoot.hover : appThemeRoot.surfaceStrong
            border.color: settingsButton.checked ? appThemeRoot.accent : appThemeRoot.border
            border.width: 1
        }
    }

    component ShellButton: Button {
        id: shellButton

        padding: 0
        implicitHeight: root.density

        contentItem: Label {
            text: shellButton.text
            color: shellButton.enabled ? appThemeRoot.textPrimary : appThemeRoot.textMuted
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight
            font.pixelSize: 14
            font.weight: Font.DemiBold
        }

        background: Rectangle {
            radius: 8
            color: shellButton.pressed ? appThemeRoot.hover : appThemeRoot.surfaceStrong
            border.color: shellButton.hovered ? appThemeRoot.accent : appThemeRoot.border
            border.width: 1
        }
    }

    component ShellSegmentButton: Button {
        id: shellSegmentButton

        checkable: true
        padding: 0
        implicitHeight: root.density

        contentItem: Label {
            text: shellSegmentButton.text
            color: shellSegmentButton.checked ? appThemeRoot.accent : appThemeRoot.textSecondary
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight
            font.pixelSize: 14
            font.weight: Font.DemiBold
        }

        background: Rectangle {
            radius: 8
            color: shellSegmentButton.checked ? appThemeRoot.accentSoft : shellSegmentButton.hovered ? appThemeRoot.hover : appThemeRoot.surfaceStrong
            border.color: shellSegmentButton.checked ? appThemeRoot.accent : appThemeRoot.border
            border.width: 1
        }
    }

    component ShellTextField: TextField {
        id: shellTextField

        property color fieldColor: appThemeRoot.surfaceStrong

        color: appThemeRoot.textPrimary
        placeholderTextColor: appThemeRoot.textMuted
        leftPadding: 16
        rightPadding: 16
        verticalAlignment: TextInput.AlignVCenter

        background: Rectangle {
            radius: 8
            color: shellTextField.fieldColor
            border.color: shellTextField.activeFocus ? appThemeRoot.accent : appThemeRoot.border
            border.width: shellTextField.activeFocus ? 2 : 1
        }
    }

    component SettingsComboBox: ComboBox {
        id: settingsComboBox

        padding: 0
        implicitHeight: root.density

        contentItem: Label {
            text: settingsComboBox.displayText
            color: appThemeRoot.textPrimary
            leftPadding: 14
            rightPadding: 42
            verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight
            font.pixelSize: 14
            font.weight: Font.DemiBold
        }

        indicator: DrawnIcon {
            kind: "down"
            strokeColor: appThemeRoot.icon
            anchors.right: parent.right
            anchors.rightMargin: 14
            anchors.verticalCenter: parent.verticalCenter
            width: 18
            height: 18
        }

        background: Rectangle {
            radius: 8
            color: appThemeRoot.surfaceStrong
            border.color: appThemeRoot.border
            border.width: 1
        }

        delegate: ItemDelegate {
            width: settingsComboBox.width
            implicitHeight: root.density

            contentItem: Label {
                text: modelData
                color: appThemeRoot.textPrimary
                leftPadding: 14
                verticalAlignment: Text.AlignVCenter
                elide: Text.ElideRight
                font.pixelSize: 14
            }

            background: Rectangle {
                color: highlighted ? appThemeRoot.hover : appThemeRoot.surface
            }
        }

        popup: Popup {
            y: settingsComboBox.height + 6
            width: settingsComboBox.width
            implicitHeight: contentItem.implicitHeight
            padding: 1

            contentItem: ListView {
                clip: true
                implicitHeight: contentHeight
                model: settingsComboBox.popup.visible ? settingsComboBox.delegateModel : null
                currentIndex: settingsComboBox.highlightedIndex
                ScrollIndicator.vertical: ScrollIndicator {}
            }

            background: Rectangle {
                radius: 8
                color: appThemeRoot.surfaceStrong
                border.color: appThemeRoot.border
                border.width: 1
            }
        }
    }

    component SettingsSwitch: Switch {
        id: settingsSwitch

        implicitHeight: root.density
        spacing: 10

        indicator: Rectangle {
            x: settingsSwitch.leftPadding
            y: Math.round((settingsSwitch.height - height) / 2)
            width: 58
            height: 32
            radius: height / 2
            color: settingsSwitch.checked ? appThemeRoot.accentSoft : appThemeRoot.surfaceStrong
            border.color: settingsSwitch.checked ? appThemeRoot.accent : appThemeRoot.border
            border.width: 1

            Rectangle {
                width: 24
                height: 24
                radius: 12
                x: settingsSwitch.checked ? parent.width - width - 4 : 4
                anchors.verticalCenter: parent.verticalCenter
                color: settingsSwitch.checked ? appThemeRoot.accent : appThemeRoot.textSecondary

                Behavior on x {
                    NumberAnimation { duration: 120; easing.type: Easing.OutCubic }
                }
            }
        }

        contentItem: Label {
            text: settingsSwitch.text
            color: appThemeRoot.textSecondary
            leftPadding: 68
            verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight
            font.pixelSize: 14
        }
    }

    component PageHeader: ColumnLayout {
        property string title
        property string detail

        spacing: 4
        Layout.fillWidth: true

        Label {
            text: parent.title
            font.pixelSize: root.compact ? 25 : 31
            font.weight: Font.DemiBold
            color: appThemeRoot.textPrimary
            Layout.fillWidth: true
            elide: Text.ElideRight
        }

        Label {
            text: parent.detail
            color: appThemeRoot.textSecondary
            visible: text.length > 0
            wrapMode: Text.WordWrap
            Layout.fillWidth: true
        }
    }

    component EmptyState: Item {
        property string title
        property string detail

        Layout.fillWidth: true
        Layout.fillHeight: true

        ColumnLayout {
            anchors.centerIn: parent
            width: Math.min(parent.width - 32, 360)
            spacing: 8

            Label {
                text: title
                horizontalAlignment: Text.AlignHCenter
                font.pixelSize: 17
                font.weight: Font.DemiBold
                color: appThemeRoot.textPrimary
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
            }

            Label {
                text: detail
                color: appThemeRoot.textSecondary
                horizontalAlignment: Text.AlignHCenter
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
            }
        }
    }

    component NavPill: Button {
        id: navPill

        property int pageIndex: 0
        property string iconName: ""
        property string iconObjectName: ""
        property string label: ""

        objectName: ""
        checkable: true
        checked: root.currentPageIndex === pageIndex
        flat: true
        implicitHeight: root.compact ? 48 : 52
        Layout.fillWidth: true
        ToolTip.visible: hovered
        ToolTip.text: label
        onClicked: root.goTo(pageIndex)

        contentItem: ColumnLayout {
            spacing: 2

            Item {
                Layout.fillWidth: true
                Layout.preferredHeight: 24

                DrawnIcon {
                    objectName: navPill.iconObjectName
                    kind: navPill.iconName
                    strokeColor: navPill.checked ? appThemeRoot.accent : appThemeRoot.icon
                    anchors.centerIn: parent
                    width: 22
                    height: 22
                }
            }

            Label {
                text: label
                visible: !root.compact
                horizontalAlignment: Text.AlignHCenter
                font.pixelSize: 11
                color: navPill.checked ? appThemeRoot.accent : appThemeRoot.textSecondary
                Layout.fillWidth: true
                elide: Text.ElideRight
            }
        }

        background: Rectangle {
            radius: 8
            color: parent.checked ? appThemeRoot.accentSoft : parent.hovered ? appThemeRoot.hover : "transparent"
            border.color: parent.checked ? appThemeRoot.accent : "transparent"
        }
    }

    component TrackDelegate: ItemDelegate {
        required property string track_id
        required property string title
        required property string artist
        required property string album

        objectName: "libraryTrackDelegate"
        width: ListView.view.width
        implicitHeight: root.compact ? 64 : 58
        enabled: track_id.length > 0
        onClicked: coreController.addTrackToQueue(track_id)

        contentItem: RowLayout {
            spacing: 10

            Rectangle {
                Layout.preferredWidth: 42
                Layout.preferredHeight: 42
                radius: 6
                color: appThemeRoot.artworkFallback

                Item {
                    anchors.centerIn: parent
                    width: 24
                    height: 24

                    DrawnIcon {
                        kind: "track"
                        strokeColor: appThemeRoot.icon
                        anchors.centerIn: parent
                        width: 22
                        height: 22
                    }
                }
            }

            ColumnLayout {
                Layout.fillWidth: true
                spacing: 2

                Label {
                    text: title.length > 0 ? title : "Untitled track"
                    font.weight: Font.Medium
                    color: appThemeRoot.textPrimary
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                }

                Label {
                    text: [artist, album].filter(function(item) { return item.length > 0 }).join(" | ")
                    color: appThemeRoot.textSecondary
                    elide: Text.ElideRight
                    visible: text.length > 0
                    Layout.fillWidth: true
                }
            }

            IconButton {
                objectName: "libraryTrackDownloadButton"
                iconName: "download"
                enabled: track_id.length > 0
                implicitWidth: 42
                implicitHeight: 36
                tooltip: "Download"
                onClicked: coreController.downloadTrack(track_id)
            }
        }
    }

    component HomeTrackDelegate: ItemDelegate {
        id: homeTrackDelegate

        required property string track_id
        required property string title
        required property string artist
        required property string album
        required property string artwork_url

        width: ListView.view.width
        implicitHeight: 58
        enabled: track_id.length > 0
        onClicked: coreController.addTrackToQueue(track_id)

        contentItem: RowLayout {
            spacing: 10

            ArtworkTile {
                Layout.preferredWidth: 42
                Layout.preferredHeight: 42
                artworkUrl: artwork_url
                fallbackText: title
                fallbackColor: appThemeRoot.artworkFallback
                textColor: appThemeRoot.icon
                borderColor: appThemeRoot.borderSoft
                tileRadius: 6
            }

            ColumnLayout {
                Layout.fillWidth: true
                spacing: 2

                Label {
                    text: title.length > 0 ? title : "Untitled track"
                    color: appThemeRoot.textPrimary
                    font.weight: Font.Medium
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                }

                Label {
                    text: [artist, album].filter(function(item) { return item.length > 0 }).join(" | ")
                    color: appThemeRoot.textSecondary
                    elide: Text.ElideRight
                    visible: text.length > 0
                    Layout.fillWidth: true
                }
            }

            IconButton {
                iconName: "heart"
                implicitWidth: 38
                implicitHeight: 34
                tooltip: "Favorite"
                onClicked: coreController.favoriteTrack(track_id)
            }
        }

        background: GlassSurface {
            surfaceRadius: 8
            fillColor: homeTrackDelegate.hovered ? appThemeRoot.hover : appThemeRoot.surface
            strokeColor: appThemeRoot.borderSoft
        }
    }

    component SearchResultDelegate: ItemDelegate {
        id: searchResultDelegateRoot

        required property string result_id
        required property string title
        required property string artist
        required property string album
        required property string artwork_url
        required property int duration_ms
        required property bool is_playing
        required property bool is_loading

        objectName: "searchResultDelegate"
        width: ListView.view.width
        implicitHeight: root.compact ? 72 : 66
        enabled: result_id.length > 0
        onClicked: coreController.playSearchResult(result_id)

        contentItem: RowLayout {
            spacing: 10

            ArtworkTile {
                Layout.preferredWidth: root.compact ? 46 : 50
                Layout.preferredHeight: root.compact ? 46 : 50
                artworkUrl: artwork_url
                fallbackText: title
                fallbackColor: appThemeRoot.artworkFallback
                textColor: appThemeRoot.icon
                borderColor: is_playing || is_loading ? appThemeRoot.danger : appThemeRoot.borderSoft
                tileRadius: 6

                Rectangle {
                    anchors.fill: parent
                    color: "transparent"
                    border.color: is_playing || is_loading ? appThemeRoot.danger : "transparent"
                    border.width: 2
                    radius: parent.radius
                }
            }

            ColumnLayout {
                Layout.fillWidth: true
                spacing: 2

                Label {
                    text: title.length > 0 ? title : "Untitled track"
                    font.weight: Font.Medium
                    color: appThemeRoot.textPrimary
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                }

                Label {
                    text: [artist, album, root.formatDuration(duration_ms)].filter(function(item) { return item.length > 0 }).join(" | ")
                    color: appThemeRoot.textSecondary
                    elide: Text.ElideRight
                    visible: text.length > 0
                    Layout.fillWidth: true
                }
            }

            Label {
                text: is_playing ? "Playing" : is_loading ? "Loading" : "Play"
                color: is_playing || is_loading ? appThemeRoot.danger : appThemeRoot.textMuted
                font.pixelSize: 12
                font.weight: is_playing || is_loading ? Font.DemiBold : Font.Normal
                Layout.preferredWidth: root.compact ? 58 : 64
                horizontalAlignment: Text.AlignRight
                elide: Text.ElideRight
            }
        }

        background: Rectangle {
            radius: 8
            color: "transparent"

            GlassSurface {
                anchors.fill: parent
                surfaceRadius: 8
                fillColor: is_playing
                    ? appThemeRoot.dangerSoft
                    : is_loading ? appThemeRoot.warningSoft : searchResultDelegateRoot.hovered ? appThemeRoot.hover : appThemeRoot.surface
                strokeColor: is_playing || is_loading ? appThemeRoot.danger : appThemeRoot.borderSoft
            }
        }
    }

    component DownloadDelegate: ItemDelegate {
        required property string download_id
        required property string title
        required property string state
        required property int progress
        required property string error_text
        required property string target_path

        objectName: "downloadDelegate"
        width: ListView.view.width
        implicitHeight: root.compact ? 78 : 70
        enabled: download_id.length > 0
        onClicked: root.selectedDownloadId = download_id

        contentItem: RowLayout {
            spacing: 10

            ColumnLayout {
                Layout.fillWidth: true
                spacing: 2

                Label {
                    text: title.length > 0 ? title : "Untitled track"
                    font.weight: Font.Medium
                    color: appThemeRoot.textPrimary
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                }

                ProgressBar {
                    value: progress / 100
                    Layout.fillWidth: true
                }

                Label {
                    text: error_text.length > 0 ? error_text : target_path
                    color: error_text.length > 0 ? appThemeRoot.danger : appThemeRoot.textSecondary
                    font.pixelSize: 11
                    elide: Text.ElideMiddle
                    visible: text.length > 0 && !root.compact
                    Layout.fillWidth: true
                }
            }

            IconButton {
                objectName: "downloadRemoveButton"
                iconName: "remove"
                enabled: download_id.length > 0
                implicitWidth: 40
                implicitHeight: 36
                tooltip: "Remove"
                onClicked: coreController.removeDownload(download_id)
            }
        }
    }

    component QueueDelegate: ItemDelegate {
        id: queueDelegate

        required property int index
        required property string queue_item_id
        required property string title
        required property string artist
        required property string album
        required property string local_path

        objectName: "queueTrackDelegate"
        width: ListView.view.width
        implicitHeight: root.compact ? 70 : 64
        enabled: queue_item_id.length > 0
        onClicked: coreController.playQueueItem(queue_item_id)

        contentItem: RowLayout {
            spacing: 10

            ColumnLayout {
                Layout.fillWidth: true
                spacing: 2

                Label {
                    text: title.length > 0 ? title : "Untitled track"
                    font.weight: Font.Medium
                    color: appThemeRoot.textPrimary
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                }

                Label {
                    text: [artist, album].filter(function(item) { return item.length > 0 }).join(" | ")
                    color: appThemeRoot.textSecondary
                    elide: Text.ElideRight
                    visible: text.length > 0
                    Layout.fillWidth: true
                }
            }

            ColumnLayout {
                spacing: 4
                visible: !root.compact

                IconButton {
                    objectName: "queueMoveUpButton"
                    iconName: "up"
                    enabled: queue_item_id.length > 0 && queueDelegate.index > 0
                    implicitWidth: 36
                    implicitHeight: 28
                    tooltip: "Move up"
                    onClicked: coreController.moveQueueItem(queue_item_id, queueDelegate.index - 1)
                }

                IconButton {
                    objectName: "queueMoveDownButton"
                    iconName: "down"
                    enabled: queue_item_id.length > 0 && queueDelegate.ListView.view !== null && queueDelegate.index < queueDelegate.ListView.view.count - 1
                    implicitWidth: 36
                    implicitHeight: 28
                    tooltip: "Move down"
                    onClicked: coreController.moveQueueItem(queue_item_id, queueDelegate.index + 1)
                }
            }

            IconButton {
                iconName: "remove"
                enabled: queue_item_id.length > 0
                implicitWidth: 40
                implicitHeight: 36
                tooltip: "Remove"
                onClicked: coreController.removeQueueItem(queue_item_id)
            }
        }
    }

    component HomeSection: Item {
        id: homeSection

        property string title
        property alias model: sectionList.model
        property string emptyText
        property string listObjectName

        Layout.fillWidth: true
        Layout.preferredHeight: root.compact ? 210 : 242

        ColumnLayout {
            anchors.fill: parent
            spacing: 10

            Label {
                text: homeSection.title
                font.pixelSize: 18
                font.weight: Font.DemiBold
                color: appThemeRoot.textPrimary
                Layout.fillWidth: true
            }

            Item {
                Layout.fillWidth: true
                Layout.fillHeight: true

                ListView {
                    id: sectionList
                    objectName: homeSection.listObjectName
                    anchors.fill: parent
                    clip: true
                    model: []
                    spacing: 8
                    delegate: HomeTrackDelegate {}
                }

                EmptyState {
                    anchors.fill: parent
                    title: homeSection.emptyText
                    detail: ""
                    visible: sectionList.count === 0
                }
            }
        }
    }

    component HomePage: Item {
        objectName: "homePage"

        Flickable {
            anchors.fill: parent
            contentWidth: width
            contentHeight: homeContent.implicitHeight
            clip: true

            ColumnLayout {
                id: homeContent
                width: parent.width
                spacing: root.pageGap

                PageHeader {
                    title: "Home"
                    detail: root.hasPlayback ? "Listening now" : "Pick up from recent music or search something new"
                }

                GridLayout {
                    columns: root.compact ? 1 : 3
                    Layout.fillWidth: true
                    rowSpacing: root.pageGap
                    columnSpacing: root.pageGap

                    HomeSection {
                        title: "Recommendations"
                        listObjectName: "recommendationsList"
                        model: coreController.recommendationsModel
                        emptyText: "No recommendations yet"
                    }

                    HomeSection {
                        title: "Keep Listening"
                        listObjectName: "keepListeningList"
                        model: coreController.recentTracksModel
                        emptyText: "No recent plays"
                    }

                    HomeSection {
                        title: "Favorites"
                        listObjectName: "favoritesList"
                        model: coreController.favoriteTracksModel
                        emptyText: "No favorites"
                    }
                }
            }
        }
    }

    component LibraryPage: Item {
        id: libraryPageRoot
        objectName: "libraryPage"
        property int selectedLibraryTab: 0

        ColumnLayout {
            anchors.fill: parent
            spacing: root.pageGap

            PageHeader {
                title: "Library"
                detail: tracksList.count + " tracks"
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: root.pageGap

                ShellButton {
                    objectName: "importFolderButton"
                    text: "Import Folder"
                    implicitHeight: root.density
                    Layout.preferredWidth: root.compact ? 156 : 150
                    onClicked: libraryFolderDialog.open()
                }

                Label {
                    objectName: "importStatusLabel"
                    text: coreController.importStatus
                    color: appThemeRoot.textSecondary
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                    verticalAlignment: Text.AlignVCenter
                }
            }

            RowLayout {
                objectName: "libraryTabs"
                Layout.fillWidth: true
                spacing: 2

                ShellSegmentButton {
                    text: "Tracks"
                    checked: libraryPageRoot.selectedLibraryTab === 0
                    Layout.fillWidth: true
                    onClicked: libraryPageRoot.selectedLibraryTab = 0
                }

                ShellSegmentButton {
                    objectName: "libraryDownloadsTab"
                    text: "Downloads"
                    checked: libraryPageRoot.selectedLibraryTab === 1
                    Layout.fillWidth: true
                    onClicked: libraryPageRoot.selectedLibraryTab = 1
                }
            }

            StackLayout {
                currentIndex: libraryPageRoot.selectedLibraryTab
                Layout.fillWidth: true
                Layout.fillHeight: true

                Item {
                    ListView {
                        id: tracksList
                        anchors.fill: parent
                        clip: true
                        model: coreController.tracksModel
                        delegate: TrackDelegate {}
                    }

                    EmptyState {
                        anchors.fill: parent
                        title: "No tracks"
                        detail: "Import a folder or add online results"
                        visible: tracksList.count === 0
                    }
                }

                DownloadsPage {}
            }
        }

        FolderDialog {
            id: libraryFolderDialog
            title: "Import Folder"
            onAccepted: coreController.importLocalFolder(selectedFolder)
        }
    }

    component SearchPage: Item {
        id: searchPage
        objectName: "searchPage"
        readonly property string trimmedQuery: root.searchPageQuery.trim()
        readonly property bool submittedQueryActive: root.submittedSearchQuery.length > 0 && root.submittedSearchQuery === trimmedQuery

        ColumnLayout {
            anchors.fill: parent
            spacing: root.pageGap

            RowLayout {
                Layout.fillWidth: true
                spacing: root.pageGap

                ShellTextField {
                    id: searchField
                    objectName: "searchField"
                    placeholderText: "Search"
                    text: root.searchPageQuery
                    Layout.fillWidth: true
                    implicitHeight: root.density
                    inputMethodHints: Qt.ImhNoPredictiveText
                    onTextEdited: {
                        root.updateSearchQuery(text)
                    }
                    onAccepted: root.submitSearch(text, searchField)

                    function takePendingSearchFocus() {
                        if (root.searchOverlayOpen && root.focusSearchFieldOnPage) {
                            forceActiveFocus()
                            root.focusSearchFieldOnPage = false
                        }
                    }

                    Component.onCompleted: takePendingSearchFocus()

                    Connections {
                        target: root
                        function onCurrentPageIndexChanged() {
                            searchField.takePendingSearchFocus()
                        }
                        function onSearchOverlayOpenChanged() {
                            searchField.takePendingSearchFocus()
                        }
                        function onFocusSearchFieldOnPageChanged() {
                            searchField.takePendingSearchFocus()
                        }
                    }
                }

                IconButton {
                    objectName: "searchButton"
                    iconName: "search"
                    iconObjectName: "searchSubmitIcon"
                    enabled: searchField.text.trim().length > 0 && coreController.searchStatus !== "Searching"
                    implicitWidth: root.density
                    implicitHeight: root.density
                    tooltip: "Search"
                    onClicked: root.submitSearch(searchField.text, searchField)
                }
            }

            Label {
                objectName: "searchStatusLabel"
                text: coreController.searchErrorMessage.length > 0 ? coreController.searchErrorMessage : coreController.searchStatus
                visible: coreController.searchStatus !== "Idle" && coreController.searchStatus !== "Ready"
                color: coreController.searchStatus === "Error" || coreController.searchStatus === "Disabled" ? appThemeRoot.danger : appThemeRoot.textSecondary
                Layout.fillWidth: true
                elide: Text.ElideRight
            }

            GlassFrame {
                objectName: "topResultsGlassPanel"
                Layout.fillWidth: true
                Layout.fillHeight: true

                ColumnLayout {
                    anchors.fill: parent
                    spacing: root.pageGap

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 8

                        Label {
                            text: "Top results"
                            font.pixelSize: 18
                            font.weight: Font.DemiBold
                            color: appThemeRoot.textPrimary
                            Layout.fillWidth: true
                            elide: Text.ElideRight
                        }

                        Label {
                            text: searchResultsList.count + " found"
                            visible: searchPage.submittedQueryActive
                            color: appThemeRoot.textMuted
                            font.pixelSize: 12
                            elide: Text.ElideRight
                        }
                    }

                    ListView {
                        id: searchSuggestionsList
                        objectName: "searchSuggestionsList"
                        Layout.fillWidth: true
                        Layout.preferredHeight: visible ? Math.min(count * 38, 128) : 0
                        visible: count > 0 && searchPage.trimmedQuery.length > 0 && !searchPage.submittedQueryActive
                        clip: true
                        model: coreController.searchSuggestionsModel
                        delegate: ItemDelegate {
                            objectName: "searchSuggestionDelegate"
                            width: ListView.view.width
                            implicitHeight: 38
                            text: model.text
                            onClicked: {
                                root.searchPageQuery = model.text
                                root.submittedSearchQuery = model.text.trim()
                                coreController.acceptSearchSuggestion(model.text)
                            }
                        }
                    }

                    Item {
                        Layout.fillWidth: true
                        Layout.fillHeight: true

                        ListView {
                            id: searchResultsList
                            objectName: "searchResultsList"
                            anchors.fill: parent
                            visible: searchPage.submittedQueryActive
                            clip: true
                            model: coreController.searchResultsModel
                            delegate: SearchResultDelegate {}
                        }

                        EmptyState {
                            anchors.fill: parent
                            title: coreController.searchStatus === "Searching" ? "Searching" : searchPage.trimmedQuery.length > 0 ? "No results" : "No query"
                            detail: coreController.searchStatus === "Disabled" ? "Online source is disabled" : searchPage.submittedQueryActive ? "Search is ready" : "Suggestions appear as you type"
                            visible: searchResultsList.count === 0 || !searchPage.submittedQueryActive
                        }
                    }

                    ItemDelegate {
                        objectName: "viewAllResultsRow"
                        visible: searchPage.submittedQueryActive && searchResultsList.count > 0
                        Layout.fillWidth: true
                        implicitHeight: root.density
                        text: "View all results"
                        enabled: false
                    }
                }
            }
        }
    }

    component QueueContent: ColumnLayout {
        spacing: root.pageGap

        RowLayout {
            Layout.fillWidth: true
            spacing: root.pageGap

            PageHeader {
                title: "Queue"
                detail: queueList.count + " queued"
            }

            Button {
                objectName: "queueClearButton"
                text: "Clear"
                enabled: queueList.count > 0
                implicitHeight: root.density
                onClicked: coreController.clearQueue()
            }
        }

        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true

            ListView {
                id: queueList
                objectName: "queueList"
                anchors.fill: parent
                clip: true
                model: coreController.queueModel
                delegate: QueueDelegate {}
            }

            EmptyState {
                anchors.fill: parent
                title: "Queue empty"
                detail: "Add tracks from Home or Library"
                visible: queueList.count === 0
            }
        }
    }

    component DownloadsPage: Item {
        objectName: "downloadsPage"

        ColumnLayout {
            anchors.fill: parent
            spacing: root.pageGap

            RowLayout {
                Layout.fillWidth: true
                spacing: root.pageGap

                PageHeader {
                    title: "Downloads"
                    detail: downloadsList.count + " items"
                }

                IconButton {
                    objectName: "downloadRemoveSelectedButton"
                    iconName: "remove"
                    enabled: root.selectedDownloadId.length > 0
                    implicitWidth: root.density
                    implicitHeight: root.density
                    tooltip: "Remove selected"
                    onClicked: coreController.removeDownload(root.selectedDownloadId)
                }
            }

            Label {
                objectName: "downloadStatusLabel"
                text: coreController.downloadStatus
                color: coreController.downloadStatus.indexOf("unavailable") >= 0 ? appThemeRoot.danger : appThemeRoot.textSecondary
                Layout.fillWidth: true
                elide: Text.ElideRight
            }

            Item {
                Layout.fillWidth: true
                Layout.fillHeight: true

                ListView {
                    id: downloadsList
                    objectName: "downloadsList"
                    anchors.fill: parent
                    clip: true
                    model: coreController.downloadsModel
                    delegate: DownloadDelegate {}
                }

                EmptyState {
                    anchors.fill: parent
                    title: "No downloads"
                    detail: "Downloaded tracks appear here"
                    visible: downloadsList.count === 0
                }
            }
        }
    }

    component SettingsPage: Flickable {
        objectName: "settingsPage"
        contentWidth: width
        contentHeight: settingsContent.implicitHeight
        clip: true

        ColumnLayout {
            id: settingsContent
            width: parent.width
            spacing: root.pageGap

            PageHeader {
                title: "Settings"
                detail: "Core status: " + (coreController.coreStatus.length > 0 ? coreController.coreStatus : coreController.helloText)
            }

            SettingsGroup {
                objectName: "settingsAppearancePlaybackGroup"
                title: "Appearance + Playback"

                GridLayout {
                    anchors.fill: parent
                    columns: root.compact ? 1 : 3
                    rowSpacing: 10
                    columnSpacing: 10

                    SettingsComboBox {
                        id: themeSelector
                        model: root.themeOptions
                        currentIndex: Math.max(0, root.themeOptions.indexOf(coreController.themeSetting.length > 0 ? coreController.themeSetting : "system"))
                        implicitHeight: root.density
                        Layout.fillWidth: true
                        onActivated: function(index) {
                            coreController.setThemeSetting(root.themeOptions[index])
                        }
                    }

                    SettingsButton {
                        text: coreController.repeatMode === "off" ? "Repeat Off" : "Repeat " + coreController.repeatMode
                        checkable: true
                        checked: coreController.repeatMode !== "off"
                        implicitHeight: root.density
                        Layout.fillWidth: true
                        onClicked: coreController.toggleRepeatMode()
                    }

                    SettingsButton {
                        text: "Shuffle"
                        checkable: true
                        checked: coreController.shuffleEnabled
                        implicitHeight: root.density
                        Layout.fillWidth: true
                        onClicked: coreController.toggleShuffle()
                    }
                }
            }

            SettingsGroup {
                objectName: "onlineSourceSettingsGroup"
                title: "Online Source"

                RowLayout {
                    anchors.fill: parent
                    spacing: root.pageGap

                    SettingsSwitch {
                        checked: coreController.onlineEnabled
                        text: coreController.onlineSourceStatus
                        onToggled: coreController.setOnlineEnabled(checked)
                    }

                    Label {
                        text: coreController.onlineSourceCapabilities.join(" / ")
                        color: appThemeRoot.textSecondary
                        Layout.fillWidth: true
                        elide: Text.ElideRight
                    }
                }
            }

            SettingsGroup {
                objectName: "storageSettingsGroup"
                title: "Storage"

                GridLayout {
                    anchors.fill: parent
                    columns: root.compact ? 1 : 2
                    rowSpacing: root.pageGap
                    columnSpacing: root.pageGap

                    ColumnLayout {
                        Layout.fillWidth: true
                        Layout.minimumWidth: 0
                        spacing: 6

                        Label {
                            objectName: "downloadDirectoryDisplay"
                            text: coreController.downloadDirectory
                            color: appThemeRoot.textSecondary
                            elide: Text.ElideMiddle
                            Layout.fillWidth: true

                            MouseArea {
                                anchors.fill: parent
                                acceptedButtons: Qt.NoButton
                                hoverEnabled: true
                            }
                        }

                        ShellTextField {
                            id: downloadDirectoryField
                            objectName: "downloadDirectoryField"
                            text: coreController.downloadDirectory
                            fieldColor: appThemeRoot.surface
                            selectByMouse: true
                            horizontalAlignment: TextInput.AlignLeft
                            Layout.fillWidth: true
                            Layout.minimumWidth: 0
                            implicitHeight: root.density
                            Component.onCompleted: cursorPosition = 0
                            onActiveFocusChanged: {
                                if (!activeFocus) {
                                    cursorPosition = 0
                                }
                            }
                        }
                    }

                    SettingsButton {
                        objectName: "downloadDirectorySaveButton"
                        text: "Save"
                        implicitHeight: root.density
                        Layout.alignment: Qt.AlignBottom
                        onClicked: coreController.setDownloadDirectory(downloadDirectoryField.text)
                    }
                }
            }

            SettingsGroup {
                objectName: "listeningDataSettingsGroup"
                title: "Listening Data"

                RowLayout {
                    anchors.fill: parent
                    spacing: root.pageGap

                    SettingsButton {
                        text: "Clear Listening"
                        implicitHeight: root.density
                        Layout.fillWidth: true
                        onClicked: coreController.clearListeningHistory()
                    }

                    SettingsButton {
                        text: "Clear Search"
                        implicitHeight: root.density
                        Layout.fillWidth: true
                        onClicked: coreController.clearSearchHistory()
                    }
                }
            }

            SettingsGroup {
                id: aboutSettingsGroup
                objectName: "aboutSettingsGroup"
                title: "About"
                property bool expanded: false

                ColumnLayout {
                    anchors.fill: parent
                    spacing: 6

                    SettingsButton {
                        text: aboutSettingsGroup.expanded ? "Hide Details" : "Show Details"
                        implicitHeight: root.density
                        onClicked: aboutSettingsGroup.expanded = !aboutSettingsGroup.expanded
                    }

                    Label {
                        text: coreController.appId + " | schema " + coreController.schemaVersion
                        color: appThemeRoot.textSecondary
                        visible: aboutSettingsGroup.expanded
                        Layout.fillWidth: true
                        elide: Text.ElideMiddle
                    }

                    Label {
                        text: coreController.databasePath
                        color: appThemeRoot.textSecondary
                        font.pixelSize: 11
                        visible: aboutSettingsGroup.expanded
                        Layout.fillWidth: true
                        elide: Text.ElideMiddle
                    }
                }
            }
        }
    }

    AlbumBackdrop {
        id: immersiveAlbumBackdrop
        objectName: "immersiveAlbumBackdrop"
        anchors.fill: parent
        z: -20
        sourceUrl: coreController.moodArtworkUrl
        fallbackColor: appThemeRoot.background
        overlayColor: appThemeRoot.backdropOverlay
    }

    Item {
        id: topChrome
        objectName: "topChrome"
        x: root.compact ? root.pagePadding : root.navWidth + root.pagePadding
        y: root.safeTop + root.pagePadding
        width: Math.max(0, root.width - x - root.pagePadding)
        height: root.topChromeHeight
        z: 18

        Label {
            text: "Auqw"
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            width: Math.max(0, topRightSearchButton.x - 12)
            color: appThemeRoot.textPrimary
            font.pixelSize: root.compact ? 25 : 20
            font.weight: Font.DemiBold
            elide: Text.ElideRight
        }

        IconButton {
            id: topRightSearchButton
            objectName: "topRightSearchButton"
            iconName: "search"
            iconObjectName: "topRightSearchIcon"
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            implicitWidth: root.density
            implicitHeight: root.density
            tooltip: "Search"
            onClicked: root.openSearchPage(root.searchPageQuery, true)
        }
    }

    GlassSurface {
        id: desktopNavigationRail
        objectName: "desktopNavigationRail"
        visible: !root.compact
        x: 0
        y: 0
        width: root.navWidth
        height: root.height
        surfaceRadius: 0
        fillColor: appThemeRoot.surfaceStrong
        strokeColor: appThemeRoot.border
        z: 10

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 18
            spacing: 10

            Label {
                text: "Auqw"
                font.pixelSize: 25
                font.weight: Font.DemiBold
                color: appThemeRoot.textPrimary
                Layout.fillWidth: true
                elide: Text.ElideRight
            }

            Label {
                text: "Library + online playback"
                color: appThemeRoot.textMuted
                font.pixelSize: 12
                Layout.fillWidth: true
                elide: Text.ElideRight
            }

            Item {
                Layout.preferredHeight: 8
            }

            NavPill {
                objectName: "floatingNavHomeButton"
                pageIndex: 0
                iconName: "home"
                iconObjectName: "floatingNavHomeIcon"
                label: "Home"
            }

            NavPill {
                objectName: "floatingNavLibraryButton"
                pageIndex: 1
                iconName: "library"
                iconObjectName: "floatingNavLibraryIcon"
                label: "Library"
            }

            NavPill {
                objectName: "floatingNavSettingsButton"
                pageIndex: 2
                iconName: "settings"
                iconObjectName: "floatingNavSettingsIcon"
                label: "Settings"
            }

            Item {
                Layout.fillHeight: true
            }

            Label {
                text: coreController.onlineSourceStatus
                color: coreController.onlineEnabled ? appThemeRoot.accent : appThemeRoot.danger
                font.pixelSize: 12
                Layout.fillWidth: true
                elide: Text.ElideRight
            }
        }
    }

    Item {
        id: contentHost
        objectName: "contentHost"
        z: 0
        anchors.fill: parent
        anchors.leftMargin: root.compact ? root.pagePadding : root.navWidth + root.pagePadding
        anchors.rightMargin: root.compact
            ? root.pagePadding
            : root.pagePadding + (!root.searchOverlayOpen ? root.queuePanelWidth + root.pageGap : 0)
        anchors.topMargin: root.safeTop + root.pagePadding + root.topChromeHeight + root.pageGap
        anchors.bottomMargin: root.safeBottom + root.pagePadding
            + (root.compact
                ? floatingNavigation.height + 8 + (root.hasPlayback ? currentSongBox.height + 8 : 0)
                : (root.hasPlayback ? bottomPlaybackBar.height + root.pageGap : 0))

        StackLayout {
            id: mainStack
            objectName: "mainStack"
            anchors.fill: parent
            currentIndex: root.currentPageIndex

            HomePage {}
            LibraryPage {}
            SettingsPage {}
        }
    }

    GlassFrame {
        id: queuePanel
        objectName: "queuePanel"
        visible: !root.compact && !root.searchOverlayOpen
        x: root.width - root.pagePadding - width
        y: contentHost.y
        width: root.queuePanelWidth
        height: Math.max(0, (root.hasPlayback ? bottomPlaybackBar.y - root.pageGap : root.height - root.safeBottom - root.pagePadding) - y)
        z: 8

        QueueContent {
            anchors.fill: parent
        }
    }

    Popup {
        id: searchOverlay
        objectName: "searchOverlay"
        modal: root.compact
        focus: true
        visible: root.searchOverlayOpen
        padding: root.pagePadding
        x: root.compact ? root.pagePadding : root.navWidth + root.pagePadding
        y: root.safeTop + root.pagePadding
        width: root.compact ? root.width - root.pagePadding * 2 : root.width - x - root.pagePadding
        height: Math.max(
            260,
            root.height - y - root.safeBottom - root.pagePadding
                - (root.compact ? floatingNavigation.height + 8 + (root.hasPlayback ? currentSongBox.height + 8 : 0)
                                : (root.hasPlayback ? bottomPlaybackBar.height + root.pageGap : 0)))
        z: 30
        closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside
        onClosed: root.searchOverlayOpen = false

        background: GlassSurface {
            objectName: "searchOverlayGlassSurface"
            surfaceRadius: 8
            fillColor: appThemeRoot.panel
            strokeColor: appThemeRoot.borderSoft
        }

        SearchPage {
            anchors.fill: parent
            anchors.margins: searchOverlay.padding
        }
    }

    Frame {
        id: bottomPlaybackBar
        objectName: "bottomPlaybackBar"
        visible: root.hasPlayback && !root.compact
        padding: 0
        x: root.navWidth + root.pagePadding
        y: root.height - root.safeBottom - root.pagePadding - height
        width: Math.max(0, root.width - x - root.pagePadding - (!root.searchOverlayOpen ? root.queuePanelWidth + root.pageGap : 0))
        height: 88
        z: 12
        background: GlassSurface {
            surfaceRadius: 8
            fillColor: appThemeRoot.surfaceStrong
            strokeColor: appThemeRoot.border
        }
    }

    GlassFrame {
        id: floatingNavigation
        objectName: "floatingNavigation"
        visible: root.compact
        width: root.width - root.pagePadding * 2
        height: 64
        padding: 8
        x: root.pagePadding
        y: root.height - height - root.safeBottom - 8
        z: 20

        Item {
            objectName: "bottomGlassNavigation"
            anchors.fill: parent
            visible: false
        }

        RowLayout {
            anchors.fill: parent
            spacing: 6

            NavPill {
                pageIndex: 0
                iconName: "home"
                label: "Home"
            }

            NavPill {
                pageIndex: 1
                iconName: "library"
                label: "Library"
            }

            NavPill {
                pageIndex: 2
                iconName: "settings"
                label: "Settings"
            }
        }
    }

    Button {
        id: currentSongBox
        objectName: "currentSongBox"
        visible: root.hasPlayback
        width: root.compact ? root.width - root.pagePadding * 2 : bottomPlaybackBar.width
        height: root.compact ? 64 : 72
        x: root.compact ? root.pagePadding : bottomPlaybackBar.x
        y: (root.compact ? floatingNavigation.y - height - 8 : bottomPlaybackBar.y + Math.round((bottomPlaybackBar.height - height) / 2)) + root.miniPlayerDragOffset
        z: 21
        flat: true
        onClicked: nowPlayingSheet.open()

        background: GlassSurface {
            surfaceRadius: 8
            fillColor: appThemeRoot.surfaceStrong
            strokeColor: appThemeRoot.border

            Rectangle {
                id: miniPlayerProgressLine
                objectName: "miniPlayerProgressLine"
                anchors.left: parent.left
                anchors.top: parent.top
                height: 2
                width: parent.width * root.playbackProgress
                radius: 1
                color: appThemeRoot.accent
                visible: coreController.playbackDurationMs > 0
            }
        }

        contentItem: RowLayout {
            spacing: 10

            Item {
                Layout.preferredWidth: root.compact ? 48 : 52
                Layout.preferredHeight: root.compact ? 48 : 52

                Canvas {
                    id: currentSongProgressRing
                    anchors.fill: parent
                    onPaint: {
                        var ctx = getContext("2d")
                        ctx.clearRect(0, 0, width, height)
                        ctx.lineWidth = 3
                        ctx.strokeStyle = "#b7c6bd"
                        ctx.beginPath()
                        ctx.arc(width / 2, height / 2, width / 2 - 2, -Math.PI / 2, Math.PI * 1.5)
                        ctx.stroke()
                        ctx.strokeStyle = "#117a58"
                        ctx.beginPath()
                        ctx.arc(width / 2, height / 2, width / 2 - 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * root.playbackProgress)
                        ctx.stroke()
                    }
                    Connections {
                        target: coreController
                        function onPlaybackStateChanged() {
                            currentSongProgressRing.requestPaint()
                        }
                    }
                }

                ArtworkTile {
                    anchors.centerIn: parent
                    width: parent.width - 8
                    height: width
                    artworkUrl: coreController.playbackArtworkUrl
                    fallbackText: coreController.playbackTitle
                    fallbackColor: appThemeRoot.artworkFallback
                    textColor: appThemeRoot.icon
                    borderColor: appThemeRoot.borderSoft
                    tileRadius: 6

                    Item {
                        objectName: "miniPlayerArtworkImage"
                        visible: coreController.playbackArtworkUrl.length > 0
                    }

                    Item {
                        objectName: "miniPlayerArtworkFallback"
                        visible: coreController.playbackArtworkUrl.length === 0
                    }
                }
            }

            ColumnLayout {
                Layout.fillWidth: true
                spacing: 2

                Label {
                    objectName: "miniPlayerTitle"
                    text: coreController.playbackTitle.length > 0 ? coreController.playbackTitle : "Nothing playing"
                    font.weight: Font.DemiBold
                    color: appThemeRoot.textPrimary
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                }

                Label {
                    objectName: "miniPlayerState"
                    text: root.formatProgress()
                    color: appThemeRoot.textSecondary
                    font.pixelSize: 12
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                }
            }
        }

        MouseArea {
            id: miniPlayerSwipeStopHandle
            objectName: "miniPlayerSwipeStopHandle"
            anchors.fill: parent
            z: 10
            property real pressY: 0

            function stopFromSwipe() {
                root.stopPlaybackFromSwipe()
            }

            onPressed: function(mouse) {
                pressY = mouse.y
                root.miniPlayerDragOffset = 0
            }
            onPositionChanged: function(mouse) {
                if (pressed) {
                    root.miniPlayerDragOffset = Math.max(0, Math.min(90, mouse.y - pressY))
                }
            }
            onReleased: function(mouse) {
                var offset = root.miniPlayerDragOffset
                root.miniPlayerDragOffset = 0
                if (offset > Math.max(34, currentSongBox.height * 0.45) || mouse.y - pressY > Math.max(34, currentSongBox.height * 0.45)) {
                    stopFromSwipe()
                }
            }
            onClicked: nowPlayingSheet.open()
        }
    }

    Item {
        id: miniPlayer
        objectName: "miniPlayer"
        visible: currentSongBox.visible
        x: currentSongBox.x
        y: currentSongBox.y
        width: currentSongBox.width
        height: currentSongBox.height
        z: currentSongBox.z - 1
    }

    Popup {
        id: nowPlayingSheet
        objectName: "nowPlayingSheet"
        modal: true
        focus: true
        width: root.compact ? root.width : Math.min(root.width - 28, 560)
        height: root.compact ? Math.min(root.height - root.safeTop, 680) : Math.min(root.height - 48, 520)
        x: root.compact ? 0 : Math.round((root.width - width) / 2)
        y: root.compact ? root.height - height : Math.round((root.height - height) / 2)
        closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside

        background: GlassSurface {
            objectName: "optionBNowPlayingSheet"
            surfaceRadius: root.compact ? 8 : 8
            fillColor: appThemeRoot.panel
            strokeColor: appThemeRoot.borderSoft
        }

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: root.pagePadding
            spacing: root.pageGap

            Label {
                text: "Now Playing"
                font.pixelSize: 24
                font.weight: Font.DemiBold
                color: appThemeRoot.textPrimary
                Layout.fillWidth: true
            }

            ArtworkTile {
                Layout.alignment: Qt.AlignHCenter
                Layout.preferredWidth: Math.min(parent.width, 260)
                Layout.preferredHeight: Layout.preferredWidth
                artworkUrl: coreController.playbackArtworkUrl
                fallbackText: coreController.playbackTitle
                fallbackColor: appThemeRoot.artworkFallback
                textColor: appThemeRoot.icon
                borderColor: appThemeRoot.borderSoft
                tileRadius: 8
            }

            Label {
                text: coreController.playbackTitle.length > 0 ? coreController.playbackTitle : "Nothing playing"
                font.pixelSize: 20
                font.weight: Font.DemiBold
                color: appThemeRoot.textPrimary
                horizontalAlignment: Text.AlignHCenter
                Layout.fillWidth: true
                elide: Text.ElideRight
            }

            Label {
                text: root.playbackDetailText()
                color: appThemeRoot.textSecondary
                horizontalAlignment: Text.AlignHCenter
                Layout.fillWidth: true
                elide: Text.ElideRight
            }

            Slider {
                from: 0
                to: Math.max(1, coreController.playbackDurationMs)
                value: coreController.playbackPositionMs
                Layout.fillWidth: true
                onMoved: coreController.seekPlayback(value)
            }

            PlayerControls {
                Layout.alignment: Qt.AlignHCenter
                compact: root.compact
                playing: coreController.playbackState === "playing"
                repeatActive: coreController.repeatMode !== "off"
                shuffleActive: coreController.shuffleEnabled
                trackActionEnabled: coreController.playbackTrackId.length > 0
                accentColor: appThemeRoot.accent
                iconColor: appThemeRoot.icon
                mutedColor: appThemeRoot.iconMuted
                surfaceColor: appThemeRoot.accentSoft
                borderColor: appThemeRoot.border
                onFavoriteRequested: coreController.favoriteTrack(coreController.playbackTrackId)
                onPreviousRequested: coreController.playPreviousQueuedTrack()
                onPlayPauseRequested: root.handlePlayPause()
                onNextRequested: coreController.playNextQueuedTrack()
                onRepeatRequested: coreController.toggleRepeatMode()
                onDownloadRequested: coreController.downloadTrack(coreController.playbackTrackId)
                onQueueRequested: coreController.addTrackToQueue(coreController.playbackTrackId)
                onShuffleRequested: coreController.toggleShuffle()
            }
        }

        Connections {
            target: coreController
            function onPlaybackStateChanged() {
                if (!root.hasPlayback) {
                    nowPlayingSheet.close()
                }
            }
        }
    }
}
