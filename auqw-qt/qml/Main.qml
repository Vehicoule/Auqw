import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs
import QtQuick.Layouts
import QtQuick.Window

ApplicationWindow {
    id: root
    objectName: "auqwShellWindow"

    width: 1180
    height: 760
    minimumWidth: 360
    minimumHeight: 560
    visible: true
    title: coreController.appName.length > 0 ? coreController.appName : "Auqw"
    color: "#f6f3ee"

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
    readonly property var themeOptions: ["system", "light", "dark"]
    readonly property bool hasPlayback: coreController.playbackState !== "stopped" && coreController.playbackTitle.length > 0
    readonly property real playbackProgress: coreController.playbackDurationMs > 0
        ? Math.max(0, Math.min(1, coreController.playbackPositionMs / coreController.playbackDurationMs))
        : 0

    property int currentPageIndex: 0
    property string selectedDownloadId: ""
    property string searchPageQuery: ""

    function goTo(index) {
        currentPageIndex = index
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
        currentPageIndex = 2
        searchPageQuery = trimmedQuery
        if (globalSearchField.text.length > 0) {
            globalSearchField.text = ""
        }
        coreController.searchOnline(trimmedQuery)
    }

    function goSearch(query) {
        submitSearch(query, null)
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
                    ? (iconButton.checked ? "#0e5a43" : "#4d5a54")
                    : "#9aa39e"
                anchors.centerIn: parent
                width: Math.min(iconButton.width, iconButton.height, 24)
                height: width
            }
        }
    }

    component GlassFrame: Frame {
        padding: root.pagePadding
        background: Rectangle {
            radius: 8
            color: "#dffafafa"
            border.color: "#80ffffff"
            border.width: 1
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
            color: "#1f2522"
            Layout.fillWidth: true
            elide: Text.ElideRight
        }

        Label {
            text: parent.detail
            color: "#66736d"
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
                color: "#1f2522"
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
            }

            Label {
                text: detail
                color: "#66736d"
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
                    strokeColor: navPill.checked ? "#0e5a43" : "#4d5a54"
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
                color: navPill.checked ? "#0e5a43" : "#6a756f"
                Layout.fillWidth: true
                elide: Text.ElideRight
            }
        }

        background: Rectangle {
            radius: 8
            color: parent.checked ? "#d8efe6" : parent.hovered ? "#eff6f3" : "transparent"
            border.color: parent.checked ? "#9bd1ba" : "transparent"
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
                color: "#e5ece8"

                Item {
                    anchors.centerIn: parent
                    width: 24
                    height: 24

                    DrawnIcon {
                        kind: "track"
                        strokeColor: "#4f6258"
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
                    color: "#202622"
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                }

                Label {
                    text: [artist, album].filter(function(item) { return item.length > 0 }).join(" | ")
                    color: "#66736d"
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

            Rectangle {
                Layout.preferredWidth: 42
                Layout.preferredHeight: 42
                radius: 6
                color: "#e9eee9"
                clip: true

                Image {
                    anchors.fill: parent
                    source: artwork_url
                    visible: artwork_url.length > 0
                    fillMode: Image.PreserveAspectCrop
                    asynchronous: true
                }

                Item {
                    anchors.centerIn: parent
                    visible: artwork_url.length === 0
                    width: 24
                    height: 24

                    DrawnIcon {
                        kind: "track"
                        strokeColor: "#4f6258"
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
                    color: "#202622"
                    font.weight: Font.Medium
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                }

                Label {
                    text: [artist, album].filter(function(item) { return item.length > 0 }).join(" | ")
                    color: "#66736d"
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
    }

    component SearchResultDelegate: ItemDelegate {
        required property string result_id
        required property string title
        required property string artist
        required property string album
        required property string artwork_url
        required property int duration_ms

        objectName: "searchResultDelegate"
        width: ListView.view.width
        implicitHeight: root.compact ? 72 : 66
        enabled: result_id.length > 0
        onClicked: coreController.playSearchResult(result_id)

        contentItem: RowLayout {
            spacing: 10

            Rectangle {
                Layout.preferredWidth: root.compact ? 46 : 50
                Layout.preferredHeight: root.compact ? 46 : 50
                radius: 6
                color: "#e2eae6"
                clip: true

                Image {
                    anchors.fill: parent
                    source: artwork_url
                    fillMode: Image.PreserveAspectCrop
                    visible: artwork_url.length > 0
                    asynchronous: true
                    cache: true
                }
            }

            ColumnLayout {
                Layout.fillWidth: true
                spacing: 2

                Label {
                    text: title.length > 0 ? title : "Untitled track"
                    font.weight: Font.Medium
                    color: "#202622"
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                }

                Label {
                    text: [artist, album, root.formatDuration(duration_ms)].filter(function(item) { return item.length > 0 }).join(" | ")
                    color: "#66736d"
                    elide: Text.ElideRight
                    visible: text.length > 0
                    Layout.fillWidth: true
                }
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
                    color: "#202622"
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                }

                ProgressBar {
                    value: progress / 100
                    Layout.fillWidth: true
                }

                Label {
                    text: error_text.length > 0 ? error_text : target_path
                    color: error_text.length > 0 ? "#a63b2f" : "#66736d"
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
                    color: "#202622"
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                }

                Label {
                    text: [artist, album].filter(function(item) { return item.length > 0 }).join(" | ")
                    color: "#66736d"
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

    component HomeLane: GlassFrame {
        id: homeLane

        property string title
        property alias model: laneList.model
        property string emptyText
        property string listObjectName

        Layout.fillWidth: true
        Layout.preferredHeight: root.compact ? 220 : 250

        ColumnLayout {
            anchors.fill: parent
            spacing: 10

            Label {
                text: homeLane.title
                font.pixelSize: 18
                font.weight: Font.DemiBold
                color: "#202622"
                Layout.fillWidth: true
            }

            Item {
                Layout.fillWidth: true
                Layout.fillHeight: true

                ListView {
                    id: laneList
                    objectName: homeLane.listObjectName
                    anchors.fill: parent
                    clip: true
                    model: []
                    delegate: HomeTrackDelegate {}
                }

                EmptyState {
                    anchors.fill: parent
                    title: homeLane.emptyText
                    detail: ""
                    visible: laneList.count === 0
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

                    HomeLane {
                        title: "Recommendations"
                        listObjectName: "recommendationsList"
                        model: coreController.recommendationsModel
                        emptyText: "No recommendations yet"
                    }

                    HomeLane {
                        title: "Keep Listening"
                        listObjectName: "keepListeningList"
                        model: coreController.recentTracksModel
                        emptyText: "No recent plays"
                    }

                    HomeLane {
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
        objectName: "libraryPage"

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

                Button {
                    objectName: "importFolderButton"
                    text: "Import Folder"
                    implicitHeight: root.density
                    onClicked: libraryFolderDialog.open()
                }

                Label {
                    objectName: "importStatusLabel"
                    text: coreController.importStatus
                    color: "#66736d"
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                    verticalAlignment: Text.AlignVCenter
                }
            }

            TabBar {
                id: libraryTabs
                objectName: "libraryTabs"
                Layout.fillWidth: true

                TabButton {
                    text: "Tracks"
                }

                TabButton {
                    objectName: "libraryDownloadsTab"
                    text: "Downloads"
                }
            }

            StackLayout {
                currentIndex: libraryTabs.currentIndex
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
        objectName: "searchPage"

        ColumnLayout {
            anchors.fill: parent
            spacing: root.pageGap

            PageHeader {
                title: "Search"
                detail: coreController.searchStatus === "Ready" ? searchResultsList.count + " results" : coreController.searchStatus
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: root.pageGap

                TextField {
                    id: searchField
                    objectName: "searchField"
                    placeholderText: "Search"
                    text: root.searchPageQuery
                    Layout.fillWidth: true
                    implicitHeight: root.density
                    inputMethodHints: Qt.ImhNoPredictiveText
                    onTextEdited: {
                        root.searchPageQuery = text
                        coreController.suggestOnline(text)
                    }
                    onAccepted: root.submitSearch(text, searchField)
                }

                IconButton {
                    objectName: "searchButton"
                    iconName: "search"
                    iconObjectName: "searchSubmitIcon"
                    enabled: searchField.text.length > 0 && coreController.searchStatus !== "Searching"
                    implicitWidth: root.density
                    implicitHeight: root.density
                    tooltip: "Search"
                    onClicked: root.submitSearch(searchField.text, searchField)
                }
            }

            Label {
                objectName: "searchStatusLabel"
                text: coreController.searchErrorMessage.length > 0 ? coreController.searchErrorMessage : coreController.searchStatus
                color: coreController.searchStatus === "Error" || coreController.searchStatus === "Disabled" ? "#a63b2f" : "#66736d"
                Layout.fillWidth: true
                elide: Text.ElideRight
            }

            ListView {
                id: searchSuggestionsList
                objectName: "searchSuggestionsList"
                Layout.fillWidth: true
                Layout.preferredHeight: visible ? Math.min(count * 38, 128) : 0
                visible: count > 0
                clip: true
                model: coreController.searchSuggestionsModel
                delegate: ItemDelegate {
                    objectName: "searchSuggestionDelegate"
                    width: ListView.view.width
                    implicitHeight: 38
                    text: model.text
                    onClicked: {
                        root.searchPageQuery = model.text
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
                    clip: true
                    model: coreController.searchResultsModel
                    delegate: SearchResultDelegate {}
                }

                EmptyState {
                    anchors.fill: parent
                    title: coreController.searchStatus === "Searching" ? "Searching" : searchField.text.length > 0 ? "No results" : "No query"
                    detail: coreController.searchStatus === "Disabled" ? "Online source is disabled" : "Search is ready"
                    visible: searchResultsList.count === 0
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
                color: coreController.downloadStatus.indexOf("unavailable") >= 0 ? "#a63b2f" : "#66736d"
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

            GroupBox {
                objectName: "settingsAppearancePlaybackGroup"
                title: "Appearance + Playback"
                Layout.fillWidth: true

                GridLayout {
                    anchors.fill: parent
                    columns: root.compact ? 1 : 3
                    rowSpacing: 10
                    columnSpacing: 10

                    ComboBox {
                        id: themeSelector
                        model: root.themeOptions
                        currentIndex: Math.max(0, root.themeOptions.indexOf(coreController.themeSetting.length > 0 ? coreController.themeSetting : "system"))
                        implicitHeight: root.density
                        Layout.fillWidth: true
                        onActivated: function(index) {
                            coreController.setThemeSetting(root.themeOptions[index])
                        }
                    }

                    Button {
                        text: coreController.repeatMode === "off" ? "Repeat Off" : "Repeat " + coreController.repeatMode
                        checkable: true
                        checked: coreController.repeatMode !== "off"
                        implicitHeight: root.density
                        Layout.fillWidth: true
                        onClicked: coreController.toggleRepeatMode()
                    }

                    Button {
                        text: "Shuffle"
                        checkable: true
                        checked: coreController.shuffleEnabled
                        implicitHeight: root.density
                        Layout.fillWidth: true
                        onClicked: coreController.toggleShuffle()
                    }
                }
            }

            GroupBox {
                objectName: "onlineSourceSettingsGroup"
                title: "Online Source"
                Layout.fillWidth: true

                RowLayout {
                    anchors.fill: parent
                    spacing: root.pageGap

                    Switch {
                        checked: coreController.onlineEnabled
                        text: coreController.onlineSourceStatus
                        onToggled: coreController.setOnlineEnabled(checked)
                    }

                    Label {
                        text: coreController.onlineSourceCapabilities.join(" / ")
                        color: "#66736d"
                        Layout.fillWidth: true
                        elide: Text.ElideRight
                    }
                }
            }

            GroupBox {
                objectName: "storageSettingsGroup"
                title: "Storage"
                Layout.fillWidth: true

                RowLayout {
                    anchors.fill: parent
                    spacing: root.pageGap

                    TextField {
                        id: downloadDirectoryField
                        objectName: "downloadDirectoryField"
                        text: coreController.downloadDirectory
                        placeholderText: "Download folder"
                        Layout.fillWidth: true
                        implicitHeight: root.density
                    }

                    Button {
                        objectName: "downloadDirectorySaveButton"
                        text: "Save"
                        implicitHeight: root.density
                        onClicked: coreController.setDownloadDirectory(downloadDirectoryField.text)
                    }
                }
            }

            GroupBox {
                objectName: "listeningDataSettingsGroup"
                title: "Listening Data"
                Layout.fillWidth: true

                RowLayout {
                    anchors.fill: parent
                    spacing: root.pageGap

                    Button {
                        text: "Clear Listening"
                        implicitHeight: root.density
                        Layout.fillWidth: true
                        onClicked: coreController.clearListeningHistory()
                    }

                    Button {
                        text: "Clear Search"
                        implicitHeight: root.density
                        Layout.fillWidth: true
                        onClicked: coreController.clearSearchHistory()
                    }
                }
            }

            GroupBox {
                id: aboutSettingsGroup
                objectName: "aboutSettingsGroup"
                title: "About"
                property bool expanded: false
                Layout.fillWidth: true

                ColumnLayout {
                    anchors.fill: parent
                    spacing: 6

                    Button {
                        text: aboutSettingsGroup.expanded ? "Hide Details" : "Show Details"
                        implicitHeight: root.density
                        onClicked: aboutSettingsGroup.expanded = !aboutSettingsGroup.expanded
                    }

                    Label {
                        text: coreController.appId + " | schema " + coreController.schemaVersion
                        color: "#66736d"
                        visible: aboutSettingsGroup.expanded
                        Layout.fillWidth: true
                        elide: Text.ElideMiddle
                    }

                    Label {
                        text: coreController.databasePath
                        color: "#66736d"
                        font.pixelSize: 11
                        visible: aboutSettingsGroup.expanded
                        Layout.fillWidth: true
                        elide: Text.ElideMiddle
                    }
                }
            }
        }
    }

    Item {
        anchors.fill: parent
        anchors.margins: root.pagePadding
        anchors.topMargin: root.safeTop + root.pagePadding
        anchors.bottomMargin: root.safeBottom + 94

        StackLayout {
            id: mainStack
            objectName: "mainStack"
            anchors.fill: parent
            anchors.rightMargin: !root.compact ? root.queuePanelWidth + root.pageGap : 0
            currentIndex: root.currentPageIndex

            HomePage {}
            LibraryPage {}
            SearchPage {}
            SettingsPage {}
        }

        GlassFrame {
            id: queuePanel
            objectName: "queuePanel"
            visible: !root.compact
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            anchors.right: parent.right
            width: root.queuePanelWidth

            QueueContent {
                anchors.fill: parent
            }
        }

        Item {
            id: desktopNavigationRail
            objectName: "desktopNavigationRail"
            visible: false
        }
    }

    TextField {
        id: globalSearchField
        objectName: "globalSearchField"
        width: root.compact ? Math.min(root.width - 28, 260) : 300
        height: root.density
        anchors.top: parent.top
        anchors.right: parent.right
        anchors.topMargin: root.safeTop + 14
        anchors.rightMargin: root.pagePadding
        placeholderText: "Search"
        inputMethodHints: Qt.ImhNoPredictiveText
        onTextEdited: coreController.suggestOnline(text)
        onAccepted: root.submitSearch(text, globalSearchField)
        background: Rectangle {
            radius: 8
            color: "#e8ffffff"
            border.color: "#88ffffff"
        }
        leftPadding: 16
        rightPadding: 16
    }

    GlassFrame {
        id: floatingNavigation
        objectName: "floatingNavigation"
        width: root.navWidth
        height: root.compact ? 64 : 72
        padding: 8
        x: root.hasPlayback ? root.pagePadding : Math.round((root.width - width) / 2)
        y: root.height - height - root.safeBottom - 14
        z: 20

        Behavior on x {
            NumberAnimation { duration: 220; easing.type: Easing.OutCubic }
        }

        RowLayout {
            anchors.fill: parent
            spacing: 6

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
                pageIndex: 3
                iconName: "settings"
                iconObjectName: "floatingNavSettingsIcon"
                label: "Settings"
            }
        }
    }

    Button {
        id: currentSongBox
        objectName: "currentSongBox"
        visible: root.hasPlayback
        width: root.compact ? Math.max(132, root.width - floatingNavigation.width - root.pagePadding * 3) : 330
        height: floatingNavigation.height
        x: root.width - width - root.pagePadding
        y: floatingNavigation.y
        z: 20
        flat: true
        onClicked: nowPlayingSheet.open()

        background: Rectangle {
            radius: 8
            color: "#e8ffffff"
            border.color: "#88ffffff"
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

                Rectangle {
                    anchors.centerIn: parent
                    width: parent.width - 8
                    height: width
                    radius: 6
                    color: "#e2eae6"
                    clip: true

                    Image {
                        objectName: "miniPlayerArtworkImage"
                        anchors.fill: parent
                        source: coreController.playbackArtworkUrl
                        fillMode: Image.PreserveAspectCrop
                        visible: coreController.playbackArtworkUrl.length > 0
                        asynchronous: true
                        cache: true
                    }

                    Label {
                        objectName: "miniPlayerArtworkFallback"
                        anchors.centerIn: parent
                        text: "A"
                        visible: coreController.playbackArtworkUrl.length === 0
                        font.weight: Font.Bold
                        color: "#4f6258"
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
                    color: "#202622"
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                }

                Label {
                    objectName: "miniPlayerState"
                    text: root.formatProgress()
                    color: "#66736d"
                    font.pixelSize: 12
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                }
            }
        }
    }

    Popup {
        id: nowPlayingSheet
        objectName: "nowPlayingSheet"
        modal: true
        focus: true
        width: Math.min(root.width - 28, 560)
        height: Math.min(root.height - 48, root.compact ? 660 : 520)
        x: Math.round((root.width - width) / 2)
        y: Math.round((root.height - height) / 2)
        closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside

        background: Rectangle {
            radius: 8
            color: "#f8ffffff"
            border.color: "#88ffffff"
        }

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: root.pagePadding
            spacing: root.pageGap

            Label {
                text: "Now Playing"
                font.pixelSize: 24
                font.weight: Font.DemiBold
                color: "#202622"
                Layout.fillWidth: true
            }

            Rectangle {
                Layout.alignment: Qt.AlignHCenter
                Layout.preferredWidth: Math.min(parent.width, 260)
                Layout.preferredHeight: Layout.preferredWidth
                radius: 8
                color: "#e2eae6"
                clip: true

                Image {
                    anchors.fill: parent
                    source: coreController.playbackArtworkUrl
                    fillMode: Image.PreserveAspectCrop
                    visible: coreController.playbackArtworkUrl.length > 0
                    asynchronous: true
                }
            }

            Label {
                text: coreController.playbackTitle.length > 0 ? coreController.playbackTitle : "Nothing playing"
                font.pixelSize: 20
                font.weight: Font.DemiBold
                color: "#202622"
                horizontalAlignment: Text.AlignHCenter
                Layout.fillWidth: true
                elide: Text.ElideRight
            }

            Label {
                text: root.playbackDetailText()
                color: "#66736d"
                horizontalAlignment: Text.AlignHCenter
                Layout.fillWidth: true
                elide: Text.ElideRight
            }

            RowLayout {
                Layout.alignment: Qt.AlignHCenter
                spacing: 8

                IconButton {
                    objectName: "nowPlayingFavoriteButton"
                    iconName: "heart"
                    enabled: coreController.playbackTrackId.length > 0
                    tooltip: "Favorite"
                    onClicked: coreController.favoriteTrack(coreController.playbackTrackId)
                }

                IconButton {
                    objectName: "nowPlayingDownloadButton"
                    iconName: "download"
                    enabled: coreController.playbackTrackId.length > 0
                    tooltip: "Download"
                    onClicked: coreController.downloadTrack(coreController.playbackTrackId)
                }

                IconButton {
                    objectName: "nowPlayingQueueButton"
                    iconName: "queue"
                    enabled: coreController.playbackTrackId.length > 0
                    tooltip: "Add to Queue"
                    onClicked: coreController.addTrackToQueue(coreController.playbackTrackId)
                }
            }

            Slider {
                from: 0
                to: Math.max(1, coreController.playbackDurationMs)
                value: coreController.playbackPositionMs
                Layout.fillWidth: true
                onMoved: coreController.seekPlayback(value)
            }

            RowLayout {
                id: nowPlayingControls

                property int controlSize: root.compact ? 44 : root.density

                Layout.alignment: Qt.AlignHCenter
                spacing: root.compact ? 6 : 8

                IconButton {
                    objectName: "miniPreviousButton"
                    iconName: "previous"
                    iconObjectName: "miniPreviousIcon"
                    implicitWidth: nowPlayingControls.controlSize
                    implicitHeight: nowPlayingControls.controlSize
                    tooltip: "Previous"
                    onClicked: coreController.playPreviousQueuedTrack()
                }

                IconButton {
                    objectName: "miniPlayPauseButton"
                    iconName: coreController.playbackState === "playing" ? "pause" : "play"
                    iconObjectName: "miniPlayPauseIcon"
                    implicitWidth: nowPlayingControls.controlSize
                    implicitHeight: nowPlayingControls.controlSize
                    tooltip: coreController.playbackState === "playing" ? "Pause" : "Play"
                    onClicked: {
                        if (coreController.playbackState === "playing") {
                            coreController.pausePlayback()
                        } else if (coreController.playbackState === "paused") {
                            coreController.resumePlayback()
                        } else {
                            coreController.playFirstQueuedTrack()
                        }
                    }
                }

                IconButton {
                    objectName: "miniNextButton"
                    iconName: "next"
                    iconObjectName: "miniNextIcon"
                    implicitWidth: nowPlayingControls.controlSize
                    implicitHeight: nowPlayingControls.controlSize
                    tooltip: "Next"
                    onClicked: coreController.playNextQueuedTrack()
                }

                IconButton {
                    objectName: "miniStopButton"
                    iconName: "stop"
                    iconObjectName: "miniStopIcon"
                    implicitWidth: nowPlayingControls.controlSize
                    implicitHeight: nowPlayingControls.controlSize
                    tooltip: "Stop"
                    onClicked: coreController.stopPlayback()
                }

                IconButton {
                    objectName: "miniRepeatButton"
                    iconName: "repeat"
                    iconObjectName: "miniRepeatIcon"
                    checkable: true
                    checked: coreController.repeatMode !== "off"
                    implicitWidth: nowPlayingControls.controlSize
                    implicitHeight: nowPlayingControls.controlSize
                    tooltip: "Repeat"
                    onClicked: coreController.toggleRepeatMode()
                }

                IconButton {
                    objectName: "miniShuffleButton"
                    iconName: "shuffle"
                    iconObjectName: "miniShuffleIcon"
                    checkable: true
                    checked: coreController.shuffleEnabled
                    implicitWidth: nowPlayingControls.controlSize
                    implicitHeight: nowPlayingControls.controlSize
                    tooltip: "Shuffle"
                    onClicked: coreController.toggleShuffle()
                }
            }
        }
    }

    Item {
        id: miniPlayer
        objectName: "miniPlayer"
        visible: false
    }
}
