#include "OnlineProvider.hpp"

#include <QMetaType>

OnlineProvider::OnlineProvider(QObject* parent)
    : QObject(parent) {
    qRegisterMetaType<QVector<OnlineTrackResult>>("QVector<OnlineTrackResult>");
    qRegisterMetaType<QVector<OnlineSuggestionResult>>("QVector<OnlineSuggestionResult>");
    qRegisterMetaType<OnlineTrackMetadata>("OnlineTrackMetadata");
    qRegisterMetaType<OnlineStreamResult>("OnlineStreamResult");
}

OnlineProvider::~OnlineProvider() = default;

OnlineProviderCapabilities OnlineProvider::capabilities() const {
    return {};
}
