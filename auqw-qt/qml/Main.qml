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

    readonly property bool mobilePlatform: Qt.platform.os === "android" || Qt.platform.os === "ios"
    readonly property bool compact: root.width < 760 || root.mobilePlatform
    readonly property int density: root.compact ? 56 : 44
    readonly property int pagePadding: root.compact ? 14 : 22
    readonly property int pageGap: root.compact ? 12 : 16
    readonly property int navWidth: 184
    readonly property int queuePanelWidth: Math.min(340, Math.max(280, Math.round(root.width * 0.28)))
    readonly property int safeTop: root.mobilePlatform ? 10 : 0
    readonly property int safeBottom: root.mobilePlatform ? 10 : 0
    readonly property var themeOptions: ["system", "light", "dark"]

    property int currentPageIndex: 0

    function goTo(index) {
        currentPageIndex = index
    }

    function playbackDetailText() {
        if (coreController.playbackErrorMessage.length > 0) {
            return coreController.playbackErrorMessage
        }
        var detail = coreController.playbackState.length > 0 ? coreController.playbackState : "stopped"
        var byline = [coreController.playbackArtist, coreController.playbackAlbum].filter(function(item) { return item.length > 0 }).join(" | ")
        return byline.length > 0 ? detail + " | " + byline : detail
    }

    color: palette.window

    component PageHeader: ColumnLayout {
        property string title
        property string detail

        spacing: 4
        Layout.fillWidth: true

        Label {
            text: parent.title
            font.pixelSize: root.compact ? 24 : 28
            font.weight: Font.DemiBold
            Layout.fillWidth: true
            elide: Text.ElideRight
        }

        Label {
            text: parent.detail
            color: root.palette.placeholderText
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
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
            }

            Label {
                text: detail
                color: root.palette.placeholderText
                horizontalAlignment: Text.AlignHCenter
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
            }
        }
    }

    component NavButton: Button {
        property int pageIndex: 0

        checkable: true
        checked: root.currentPageIndex === pageIndex
        flat: true
        leftPadding: 14
        rightPadding: 14
        implicitHeight: root.density
        Layout.fillWidth: true
        onClicked: root.goTo(pageIndex)
    }

    component SectionFrame: Frame {
        padding: root.pagePadding
        Layout.fillWidth: true
        Layout.fillHeight: true
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

        contentItem: ColumnLayout {
            spacing: 2

            Label {
                text: title.length > 0 ? title : "Untitled track"
                font.weight: Font.Medium
                elide: Text.ElideRight
                Layout.fillWidth: true
            }

            Label {
                text: [artist, album].filter(function(item) { return item.length > 0 }).join(" | ")
                color: root.palette.placeholderText
                elide: Text.ElideRight
                visible: text.length > 0
                Layout.fillWidth: true
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
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                }

                Label {
                    text: [artist, album].filter(function(item) { return item.length > 0 }).join(" | ")
                    color: root.palette.placeholderText
                    elide: Text.ElideRight
                    visible: text.length > 0
                    Layout.fillWidth: true
                }

                Label {
                    text: local_path
                    color: root.palette.placeholderText
                    font.pixelSize: 11
                    elide: Text.ElideMiddle
                    visible: text.length > 0 && !root.compact
                    Layout.fillWidth: true
                }
            }

            ColumnLayout {
                spacing: 4
                visible: !root.compact

                Button {
                    objectName: "queueMoveUpButton"
                    text: "Up"
                    enabled: queue_item_id.length > 0 && queueDelegate.index > 0
                    implicitHeight: 28
                    onClicked: coreController.moveQueueItem(queue_item_id, queueDelegate.index - 1)
                }

                Button {
                    objectName: "queueMoveDownButton"
                    text: "Down"
                    enabled: queue_item_id.length > 0 && queueDelegate.ListView.view !== null && queueDelegate.index < queueDelegate.ListView.view.count - 1
                    implicitHeight: 28
                    onClicked: coreController.moveQueueItem(queue_item_id, queueDelegate.index + 1)
                }
            }

            Button {
                text: "Remove"
                enabled: queue_item_id.length > 0
                implicitHeight: Math.max(36, root.density - 8)
                onClicked: coreController.removeQueueItem(queue_item_id)
            }
        }
    }

    component PlaylistDelegate: ItemDelegate {
        required property string name

        width: ListView.view.width
        implicitHeight: root.compact ? 58 : 52
        enabled: false

        contentItem: Label {
            text: name.length > 0 ? name : "Untitled playlist"
            font.weight: Font.Medium
            elide: Text.ElideRight
            verticalAlignment: Text.AlignVCenter
        }
    }

    component LibraryPage: SectionFrame {
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
                    color: root.palette.placeholderText
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                    verticalAlignment: Text.AlignVCenter
                }
            }

            Item {
                Layout.fillWidth: true
                Layout.fillHeight: true

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
                    detail: "Library state is empty"
                    visible: tracksList.count === 0
                }
            }
        }

        FolderDialog {
            id: libraryFolderDialog
            title: "Import Folder"
            onAccepted: coreController.importLocalFolder(selectedFolder)
        }
    }

    component SearchPage: SectionFrame {
        objectName: "searchPage"

        ColumnLayout {
            anchors.fill: parent
            spacing: root.pageGap

            PageHeader {
                title: "Search"
                detail: "0 results"
            }

            TextField {
                id: searchField
                placeholderText: "Search"
                Layout.fillWidth: true
                implicitHeight: root.density
                inputMethodHints: Qt.ImhNoPredictiveText
            }

            EmptyState {
                title: searchField.text.length > 0 ? "No results" : "No query"
                detail: "Provider state is empty"
            }
        }
    }

    component PlaylistsPage: SectionFrame {
        objectName: "playlistsPage"

        ColumnLayout {
            anchors.fill: parent
            spacing: root.pageGap

            PageHeader {
                title: "Playlists"
                detail: playlistsList.count + " playlists"
            }

            Item {
                Layout.fillWidth: true
                Layout.fillHeight: true

                ListView {
                    id: playlistsList
                    anchors.fill: parent
                    clip: true
                    model: coreController.playlistsModel
                    delegate: PlaylistDelegate {}
                }

                EmptyState {
                    anchors.fill: parent
                    title: "No playlists"
                    detail: "Playlist state is empty"
                    visible: playlistsList.count === 0
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
                detail: "Add tracks from Library"
                visible: queueList.count === 0
            }
        }
    }

    component QueuePage: SectionFrame {
        objectName: "queuePage"

        QueueContent {
            anchors.fill: parent
        }
    }

    component SettingsPage: SectionFrame {
        objectName: "settingsPage"

        ColumnLayout {
            anchors.fill: parent
            spacing: root.pageGap

            PageHeader {
                title: "Settings"
                detail: "Core status: " + (coreController.coreStatus.length > 0 ? coreController.coreStatus : coreController.helloText)
            }

            GroupBox {
                title: "Theme"
                Layout.fillWidth: true

                ColumnLayout {
                    anchors.fill: parent
                    spacing: 10

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

                    Label {
                        text: coreController.themeSetting.length > 0 ? "Stored: " + coreController.themeSetting : "Stored: empty"
                        color: root.palette.placeholderText
                        Layout.fillWidth: true
                        elide: Text.ElideRight
                    }
                }
            }

            Item {
                Layout.fillHeight: true
            }
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.topMargin: root.safeTop
        anchors.bottomMargin: root.safeBottom
        spacing: 0

        ToolBar {
            Layout.fillWidth: true

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: root.pagePadding
                anchors.rightMargin: root.pagePadding
                spacing: root.pageGap

                Label {
                    text: coreController.appName.length > 0 ? coreController.appName : "Auqw"
                    font.pixelSize: root.compact ? 20 : 22
                    font.weight: Font.DemiBold
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                }

                Label {
                    text: coreController.appId + " | schema " + coreController.schemaVersion
                    color: root.palette.placeholderText
                    visible: !root.compact
                    elide: Text.ElideMiddle
                    Layout.maximumWidth: 380
                }

                Frame {
                    padding: 8

                    Label {
                        text: coreController.coreStatus.length > 0 ? coreController.coreStatus : coreController.helloText
                        color: coreController.coreStatus === "Ready" ? "#137a4a" : root.palette.text
                        font.pixelSize: 12
                        font.weight: Font.Medium
                    }
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.margins: root.pagePadding
            spacing: root.pageGap

            Frame {
                id: desktopNavigationRail
                objectName: "desktopNavigationRail"
                visible: !root.compact
                Layout.preferredWidth: root.navWidth
                Layout.fillHeight: true
                padding: 10

                ColumnLayout {
                    anchors.fill: parent
                    spacing: 6

                    NavButton {
                        text: "Library"
                        pageIndex: 0
                    }

                    NavButton {
                        text: "Search"
                        pageIndex: 1
                    }

                    NavButton {
                        text: "Playlists"
                        pageIndex: 2
                    }

                    Item {
                        Layout.fillHeight: true
                    }

                    NavButton {
                        text: "Settings"
                        pageIndex: 4
                    }
                }
            }

            StackLayout {
                id: mainStack
                objectName: "mainStack"
                currentIndex: root.currentPageIndex
                Layout.fillWidth: true
                Layout.fillHeight: true

                LibraryPage {}
                SearchPage {}
                PlaylistsPage {}
                QueuePage {}
                SettingsPage {}
            }

            Frame {
                id: queuePanel
                objectName: "queuePanel"
                visible: !root.compact
                Layout.preferredWidth: root.queuePanelWidth
                Layout.fillHeight: true
                padding: root.pagePadding

                QueueContent {
                    anchors.fill: parent
                }
            }
        }

        Frame {
            id: miniPlayer
            objectName: "miniPlayer"
            Layout.fillWidth: true
            Layout.leftMargin: root.pagePadding
            Layout.rightMargin: root.pagePadding
            Layout.bottomMargin: root.compact ? 8 : root.pagePadding
            implicitHeight: root.compact ? 68 : 76
            padding: root.compact ? 10 : 14

            RowLayout {
                anchors.fill: parent
                spacing: root.pageGap

                Rectangle {
                    Layout.preferredWidth: root.compact ? 44 : 48
                    Layout.preferredHeight: root.compact ? 44 : 48
                    radius: 6
                    color: root.palette.mid

                    Label {
                        anchors.centerIn: parent
                        text: "A"
                        font.weight: Font.Bold
                    }
                }

                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 2

                    Label {
                        objectName: "miniPlayerTitle"
                        text: coreController.playbackTitle.length > 0 ? coreController.playbackTitle : "Nothing playing"
                        font.weight: Font.DemiBold
                        elide: Text.ElideRight
                        Layout.fillWidth: true
                    }

                    Label {
                        objectName: "miniPlayerState"
                        text: root.playbackDetailText()
                        color: root.palette.placeholderText
                        elide: Text.ElideRight
                        Layout.fillWidth: true
                    }
                }

                Button {
                    objectName: "miniPreviousButton"
                    text: "Prev"
                    enabled: coreController.playbackState !== "loading"
                    implicitHeight: root.density
                    visible: !root.compact || root.width > 560
                    onClicked: coreController.playPreviousQueuedTrack()
                }

                Button {
                    objectName: "miniPlayPauseButton"
                    text: coreController.playbackState === "playing" ? "Pause" : "Play"
                    enabled: coreController.playbackState !== "loading"
                    implicitHeight: root.density
                    visible: !root.compact || root.width > 420
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
                    text: "Next"
                    enabled: coreController.playbackState !== "loading"
                    implicitHeight: root.density
                    visible: !root.compact || root.width > 560
                    onClicked: coreController.playNextQueuedTrack()
                }

                Button {
                    objectName: "miniStopButton"
                    text: "Stop"
                    enabled: coreController.playbackState !== "stopped"
                    implicitHeight: root.density
                    visible: !root.compact || root.width > 500
                    onClicked: coreController.stopPlayback()
                }

                Button {
                    objectName: "miniRepeatButton"
                    text: coreController.repeatMode === "off" ? "Repeat" : "Repeat " + coreController.repeatMode
                    checkable: true
                    checked: coreController.repeatMode !== "off"
                    implicitHeight: root.density
                    visible: !root.compact || root.width > 640
                    onClicked: coreController.toggleRepeatMode()
                }

                Button {
                    objectName: "miniShuffleButton"
                    text: "Shuffle"
                    checkable: true
                    checked: coreController.shuffleEnabled
                    implicitHeight: root.density
                    visible: !root.compact || root.width > 700
                    onClicked: coreController.toggleShuffle()
                }
            }
        }

        TabBar {
            id: mobileTabs
            visible: root.compact
            currentIndex: root.currentPageIndex
            Layout.fillWidth: true
            implicitHeight: Math.max(60, root.density)
            onCurrentIndexChanged: {
                if (visible && currentIndex !== root.currentPageIndex) {
                    root.goTo(currentIndex)
                }
            }

            TabButton {
                text: "Library"
                implicitHeight: root.density
            }

            TabButton {
                text: "Search"
                implicitHeight: root.density
            }

            TabButton {
                text: "Lists"
                implicitHeight: root.density
            }

            TabButton {
                text: "Queue"
                implicitHeight: root.density
            }

            TabButton {
                text: "Settings"
                implicitHeight: root.density
            }
        }
    }
}
