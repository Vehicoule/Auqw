#include "JsonListModel.hpp"

#include <utility>

JsonListModel::JsonListModel(QStringList roles)
    : roles_(std::move(roles)) {}

int JsonListModel::rowCount(const QModelIndex& parent) const {
    return parent.isValid() ? 0 : static_cast<int>(items_.size());
}

QVariant JsonListModel::data(const QModelIndex& index, int role) const {
    if (!index.isValid() || index.row() < 0 || index.row() >= items_.size()) {
        return {};
    }

    const int roleIndex = role - Qt::UserRole - 1;
    if (roleIndex < 0 || roleIndex >= roles_.size()) {
        return {};
    }

    const QVariant value = items_.at(index.row()).value(roles_.at(roleIndex));
    return value.isNull() ? QString{} : value;
}

QHash<int, QByteArray> JsonListModel::roleNames() const {
    QHash<int, QByteArray> names;
    for (int i = 0; i < roles_.size(); ++i) {
        names.insert(Qt::UserRole + 1 + i, roles_.at(i).toUtf8());
    }
    return names;
}

void JsonListModel::setItems(QVector<QVariantMap> items) {
    beginResetModel();
    items_ = std::move(items);
    endResetModel();
}

QVariantMap JsonListModel::itemAt(int row) const {
    if (row < 0 || row >= items_.size()) {
        return {};
    }
    return items_.at(row);
}
