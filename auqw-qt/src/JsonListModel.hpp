#pragma once

#include <QAbstractListModel>
#include <QByteArray>
#include <QHash>
#include <QModelIndex>
#include <QStringList>
#include <QVariant>
#include <QVariantMap>
#include <QVector>

class JsonListModel final : public QAbstractListModel {
public:
    explicit JsonListModel(QStringList roles);

    [[nodiscard]] int rowCount(const QModelIndex& parent = {}) const override;
    [[nodiscard]] QVariant data(const QModelIndex& index, int role) const override;
    [[nodiscard]] QHash<int, QByteArray> roleNames() const override;

    void setItems(QVector<QVariantMap> items);
    [[nodiscard]] QVariantMap itemAt(int row) const;

private:
    QStringList roles_;
    QVector<QVariantMap> items_;
};
