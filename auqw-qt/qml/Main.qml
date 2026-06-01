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
    readonly property int safeTop: root.mobilePlatform ? 10 : 0
    readonly property int safeBottom: root.mobilePlatform ? 10 : 0
    readonly property var themeOptions: ["system", "light", "dark"]
    readonly property bool hasPlayback: coreController.playbackState !== "stopped" || coreController.playbackTitle.length > 0
    readonly property real playbackProgress: coreController.playbackDurationMs > 0
        ? Math.max(0, Math.min(1, coreController.playbackPositionMs / coreController.playbackDurationMs))
        : 0

    property int currentPageIndex: 0
    property string selectedDownloadId: ""

    function goTo(index) {
        currentPageIndex = index
    }

    function goSearch(query) {
        currentPageIndex = 2
        if (query.length > 0) {
            coreController.searchOnline(query)
        }
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
        property int pageIndex: 0
        property string glyph: ""
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

            Label {
                text: glyph
                horizontalAlignment: Text.AlignHCenter
                font.pixelSize: 19
                font.weight: Font.DemiBold
                color: parent.parent.checked ? "#0e5a43" : "#4d5a54"
                Layout.fillWidth: true
            }

            Label {
                text: label
                visible: !root.compact
                horizontalAlignment: Text.AlignHCenter
                font.pixelSize: 11
                color: parent.parent.checked ? "#0e5a43" : "#6a756f"
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

                Label {
                    anchors.centerIn: parent
                    text: "♪"
                    color: "#4f6258"
                    font.pixelSize: 18
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

            Button {
                objectName: "libraryTrackDownloadButton"
                text: "⇩"
                enabled: track_id.length > 0
                implicitWidth: 42
                implicitHeight: 36
                ToolTip.visible: hovered
                ToolTip.text: "Download"
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

                Label {
                    anchors.centerIn: parent
                    text: "♪"
                    visible: artwork_url.length === 0
                    color: "#4f6258"
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

            Button {
                text: "♡"
                implicitWidth: 38
                implicitHeight: 34
                ToolTip.visible: hovered
                ToolTip.text: "Favorite"
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
        onClicked: coreController.addSearchResultToQueue(result_id)

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

            Button {
                text: "♡"
                implicitWidth: 40
                implicitHeight: 36
                ToolTip.visible: hovered
                ToolTip.text: "Favorite"
                onClicked: coreController.favoriteSearchResult(result_id)
            }

            Button {
                objectName: "searchResultDownloadButton"
                text: "⇩"
                enabled: result_id.length > 0
                implicitWidth: 40
                implicitHeight: 36
                ToolTip.visible: hovered
                ToolTip.text: "Download"
                onClicked: coreController.downloadSearchResult(result_id)
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

            Button {
                objectName: "downloadRemoveButton"
                text: "×"
                enabled: download_id.length > 0
                implicitWidth: 40
                implicitHeight: 36
                ToolTip.visible: hovered
                ToolTip.text: "Remove"
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

                Button {
                    objectName: "queueMoveUpButton"
                    text: "↑"
                    enabled: queue_item_id.length > 0 && queueDelegate.index > 0
                    implicitWidth: 36
                    implicitHeight: 28
                    onClicked: coreController.moveQueueItem(queue_item_id, queueDelegate.index - 1)
                }

                Button {
                    objectName: "queueMoveDownButton"
                    text: "↓"
                    enabled: queue_item_id.length > 0 && queueDelegate.ListView.view !== null && queueDelegate.index < queueDelegate.ListView.view.count - 1
                    implicitWidth: 36
                    implicitHeight: 28
                    onClicked: coreController.moveQueueItem(queue_item_id, queueDelegate.index + 1)
                }
            }

            Button {
                text: "×"
                enabled: queue_item_id.length > 0
                implicitWidth: 40
                implicitHeight: 36
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
                    Layout.fillWidth: true
                    implicitHeight: root.density
                    inputMethodHints: Qt.ImhNoPredictiveText
                    onTextEdited: coreController.suggestOnline(text)
                    onAccepted: coreController.searchOnline(text)
                }

                Button {
                    objectName: "searchButton"
                    text: "⌕"
                    enabled: searchField.text.length > 0 && coreController.searchStatus !== "Searching"
                    implicitWidth: root.density
                    implicitHeight: root.density
                    ToolTip.visible: hovered
                    ToolTip.text: "Search"
                    onClicked: coreController.searchOnline(searchField.text)
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
                        searchField.text = model.text
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

                Button {
                    objectName: "downloadRemoveSelectedButton"
                    text: "×"
                    enabled: root.selectedDownloadId.length > 0
                    implicitWidth: root.density
                    implicitHeight: root.density
                    ToolTip.visible: hovered
                    ToolTip.text: "Remove selected"
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
        onAccepted: root.goSearch(text)
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
                glyph: "⌂"
                label: "Home"
            }

            NavPill {
                objectName: "floatingNavLibraryButton"
                pageIndex: 1
                glyph: "▤"
                label: "Library"
            }

            NavPill {
                objectName: "floatingNavSettingsButton"
                pageIndex: 3
                glyph: "☷"
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
        height: Math.min(root.height - 48, 520)
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

            Slider {
                from: 0
                to: Math.max(1, coreController.playbackDurationMs)
                value: coreController.playbackPositionMs
                Layout.fillWidth: true
                onMoved: coreController.seekPlayback(value)
            }

            RowLayout {
                Layout.alignment: Qt.AlignHCenter
                spacing: 8

                Button {
                    objectName: "miniPreviousButton"
                    text: "⏮"
                    implicitWidth: root.density
                    implicitHeight: root.density
                    onClicked: coreController.playPreviousQueuedTrack()
                }

                Button {
                    objectName: "miniPlayPauseButton"
                    text: coreController.playbackState === "playing" ? "⏸" : "▶"
                    implicitWidth: root.density
                    implicitHeight: root.density
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

                Button {
                    objectName: "miniNextButton"
                    text: "⏭"
                    implicitWidth: root.density
                    implicitHeight: root.density
                    onClicked: coreController.playNextQueuedTrack()
                }

                Button {
                    objectName: "miniStopButton"
                    text: "■"
                    implicitWidth: root.density
                    implicitHeight: root.density
                    onClicked: coreController.stopPlayback()
                }

                Button {
                    objectName: "miniRepeatButton"
                    text: "↻"
                    checkable: true
                    checked: coreController.repeatMode !== "off"
                    implicitWidth: root.density
                    implicitHeight: root.density
                    onClicked: coreController.toggleRepeatMode()
                }

                Button {
                    objectName: "miniShuffleButton"
                    text: "⇄"
                    checkable: true
                    checked: coreController.shuffleEnabled
                    implicitWidth: root.density
                    implicitHeight: root.density
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
