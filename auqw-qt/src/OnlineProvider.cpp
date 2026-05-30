#include "OnlineProvider.hpp"

#include <QMetaType>

OnlineProvider::OnlineProvider(QObject* parent)
    : QObject(parent) {
    qRegisterMetaType<QVector<OnlineTrackResult>>("QVector<OnlineTrackResult>");
    qRegisterMetaType<OnlineStreamResult>("OnlineStreamResult");
}

OnlineProvider::~OnlineProvider() = default;
