#include "YoutubeUmpParser.hpp"

#include <QtGlobal>

namespace {

constexpr qsizetype maxUmpPartSize = 64 * 1024 * 1024;

bool readUmpVarint(const QByteArray& bytes, qsizetype offset, quint32& value, qsizetype& nextOffset) {
    if (offset >= bytes.size()) {
        return false;
    }

    const auto first = static_cast<quint8>(bytes.at(offset));
    const qsizetype length = first < 128 ? 1 : first < 192 ? 2 : first < 224 ? 3 : first < 240 ? 4 : 5;
    if (offset + length > bytes.size()) {
        return false;
    }

    switch (length) {
    case 1:
        value = first;
        break;
    case 2:
        value = (first & 0x3f)
            + 64u * static_cast<quint8>(bytes.at(offset + 1));
        break;
    case 3:
        value = (first & 0x1f)
            + 32u * (static_cast<quint8>(bytes.at(offset + 1))
                     + 256u * static_cast<quint8>(bytes.at(offset + 2)));
        break;
    case 4:
        value = (first & 0x0f)
            + 16u * (static_cast<quint8>(bytes.at(offset + 1))
                     + 256u * (static_cast<quint8>(bytes.at(offset + 2))
                               + 256u * static_cast<quint8>(bytes.at(offset + 3))));
        break;
    default:
        value = static_cast<quint8>(bytes.at(offset + 1))
            | (static_cast<quint8>(bytes.at(offset + 2)) << 8)
            | (static_cast<quint8>(bytes.at(offset + 3)) << 16)
            | (static_cast<quint8>(bytes.at(offset + 4)) << 24);
        break;
    }

    nextOffset = offset + length;
    return true;
}

bool readProtoVarint(const QByteArray& bytes, qsizetype& offset, quint64& value) {
    value = 0;
    int shift = 0;
    while (offset < bytes.size() && shift <= 63) {
        const quint8 byte = static_cast<quint8>(bytes.at(offset++));
        value |= static_cast<quint64>(byte & 0x7f) << shift;
        if ((byte & 0x80) == 0) {
            return true;
        }
        shift += 7;
    }
    return false;
}

bool skipProtoField(const QByteArray& bytes, qsizetype& offset, quint32 wireType) {
    quint64 value = 0;
    switch (wireType) {
    case 0:
        return readProtoVarint(bytes, offset, value);
    case 1:
        if (offset + 8 > bytes.size()) {
            return false;
        }
        offset += 8;
        return true;
    case 2:
        if (!readProtoVarint(bytes, offset, value) || value > static_cast<quint64>(bytes.size() - offset)) {
            return false;
        }
        offset += static_cast<qsizetype>(value);
        return true;
    case 5:
        if (offset + 4 > bytes.size()) {
            return false;
        }
        offset += 4;
        return true;
    default:
        return false;
    }
}

QString parseStringField(const QByteArray& payload, quint32 wantedField) {
    qsizetype offset = 0;
    while (offset < payload.size()) {
        quint64 tag = 0;
        if (!readProtoVarint(payload, offset, tag)) {
            return {};
        }
        const quint32 field = static_cast<quint32>(tag >> 3);
        const quint32 wireType = static_cast<quint32>(tag & 0x07);
        if (field == wantedField && wireType == 2) {
            quint64 length = 0;
            if (!readProtoVarint(payload, offset, length) || length > static_cast<quint64>(payload.size() - offset)) {
                return {};
            }
            return QString::fromUtf8(payload.mid(offset, static_cast<qsizetype>(length)));
        }
        if (!skipProtoField(payload, offset, wireType)) {
            return {};
        }
    }
    return {};
}

YoutubeUmpMediaHeader parseMediaHeader(const QByteArray& payload) {
    YoutubeUmpMediaHeader header;
    qsizetype offset = 0;
    while (offset < payload.size()) {
        quint64 tag = 0;
        if (!readProtoVarint(payload, offset, tag)) {
            return header;
        }
        const quint32 field = static_cast<quint32>(tag >> 3);
        const quint32 wireType = static_cast<quint32>(tag & 0x07);
        quint64 value = 0;
        if (wireType == 0 && readProtoVarint(payload, offset, value)) {
            switch (field) {
            case 1:
                header.headerId = static_cast<int>(value);
                break;
            case 3:
                header.itag = static_cast<int>(value);
                break;
            case 9:
                header.sequenceNumber = static_cast<qint64>(value);
                break;
            case 12:
                header.durationMs = static_cast<qint64>(value);
                break;
            case 14:
                header.contentLength = static_cast<qint64>(value);
                break;
            default:
                break;
            }
            continue;
        }
        if (!skipProtoField(payload, offset, wireType)) {
            return header;
        }
    }
    return header;
}

YoutubeUmpEvent parseSabrError(const QByteArray& payload) {
    YoutubeUmpEvent event{.type = YoutubeUmpEventType::SabrError};
    qsizetype offset = 0;
    while (offset < payload.size()) {
        quint64 tag = 0;
        if (!readProtoVarint(payload, offset, tag)) {
            return event;
        }
        const quint32 field = static_cast<quint32>(tag >> 3);
        const quint32 wireType = static_cast<quint32>(tag & 0x07);
        if (field == 1 && wireType == 2) {
            quint64 length = 0;
            if (!readProtoVarint(payload, offset, length) || length > static_cast<quint64>(payload.size() - offset)) {
                return event;
            }
            event.text = QString::fromUtf8(payload.mid(offset, static_cast<qsizetype>(length)));
            offset += static_cast<qsizetype>(length);
            continue;
        }
        if (field == 2 && wireType == 0) {
            quint64 value = 0;
            if (readProtoVarint(payload, offset, value)) {
                event.code = static_cast<int>(value);
            }
            continue;
        }
        if (!skipProtoField(payload, offset, wireType)) {
            return event;
        }
    }
    return event;
}

YoutubeUmpEvent parseNextRequestPolicy(const QByteArray& payload) {
    YoutubeUmpEvent event{.type = YoutubeUmpEventType::NextRequestPolicy};
    qsizetype offset = 0;
    while (offset < payload.size()) {
        quint64 tag = 0;
        if (!readProtoVarint(payload, offset, tag)) {
            return event;
        }
        const quint32 field = static_cast<quint32>(tag >> 3);
        const quint32 wireType = static_cast<quint32>(tag & 0x07);
        if (field == 4 && wireType == 0) {
            quint64 value = 0;
            if (readProtoVarint(payload, offset, value)) {
                event.code = static_cast<int>(value);
            }
            continue;
        }
        if (field == 7 && wireType == 2) {
            quint64 length = 0;
            if (!readProtoVarint(payload, offset, length) || length > static_cast<quint64>(payload.size() - offset)) {
                return event;
            }
            event.bytes = payload.mid(offset, static_cast<qsizetype>(length));
            offset += static_cast<qsizetype>(length);
            continue;
        }
        if (!skipProtoField(payload, offset, wireType)) {
            return event;
        }
    }
    return event;
}

YoutubeUmpEvent parseStreamProtectionStatus(const QByteArray& payload) {
    YoutubeUmpEvent event{.type = YoutubeUmpEventType::StreamProtectionStatus};
    qsizetype offset = 0;
    while (offset < payload.size()) {
        quint64 tag = 0;
        if (!readProtoVarint(payload, offset, tag)) {
            return event;
        }
        const quint32 field = static_cast<quint32>(tag >> 3);
        const quint32 wireType = static_cast<quint32>(tag & 0x07);
        if (wireType == 0) {
            quint64 value = 0;
            if (readProtoVarint(payload, offset, value)) {
                if (field == 1) {
                    event.code = static_cast<int>(value);
                } else if (field == 2) {
                    event.mediaHeader.headerId = static_cast<int>(value);
                }
            }
            continue;
        }
        if (!skipProtoField(payload, offset, wireType)) {
            return event;
        }
    }
    return event;
}

YoutubeUmpEvent parseContextUpdate(const QByteArray& payload) {
    YoutubeUmpEvent event{.type = YoutubeUmpEventType::SabrContextUpdate};
    qsizetype offset = 0;
    while (offset < payload.size()) {
        quint64 tag = 0;
        if (!readProtoVarint(payload, offset, tag)) {
            return event;
        }
        const quint32 field = static_cast<quint32>(tag >> 3);
        const quint32 wireType = static_cast<quint32>(tag & 0x07);
        if (field == 1 && wireType == 0) {
            quint64 value = 0;
            if (readProtoVarint(payload, offset, value)) {
                event.code = static_cast<int>(value);
            }
            continue;
        }
        if (field == 3 && wireType == 2) {
            quint64 length = 0;
            if (!readProtoVarint(payload, offset, length) || length > static_cast<quint64>(payload.size() - offset)) {
                return event;
            }
            event.bytes = payload.mid(offset, static_cast<qsizetype>(length));
            offset += static_cast<qsizetype>(length);
            continue;
        }
        if (!skipProtoField(payload, offset, wireType)) {
            return event;
        }
    }
    return event;
}

} // namespace

YoutubeUmpParseResult YoutubeUmpParser::append(const QByteArray& chunk) {
    buffer_.append(chunk);
    YoutubeUmpParseResult result;

    while (!buffer_.isEmpty()) {
        quint32 type = 0;
        quint32 size = 0;
        qsizetype offset = 0;
        if (!readUmpVarint(buffer_, offset, type, offset)) {
            break;
        }
        if (!readUmpVarint(buffer_, offset, size, offset)) {
            break;
        }
        if (size > maxUmpPartSize) {
            buffer_.clear();
            return {
                .ok = false,
                .errorMessage = QStringLiteral("Malformed UMP frame."),
            };
        }
        if (offset + static_cast<qsizetype>(size) > buffer_.size()) {
            break;
        }

        const QByteArray payload = buffer_.mid(offset, static_cast<qsizetype>(size));
        buffer_.remove(0, offset + static_cast<qsizetype>(size));

        switch (type) {
        case 20:
            result.events.push_back(YoutubeUmpEvent{
                .type = YoutubeUmpEventType::MediaHeader,
                .mediaHeader = parseMediaHeader(payload),
            });
            break;
        case 21:
            result.events.push_back(YoutubeUmpEvent{.type = YoutubeUmpEventType::Media});
            if (!payload.isEmpty()) {
                result.audioBytes.append(payload.mid(1));
            }
            break;
        case 22:
            result.events.push_back(YoutubeUmpEvent{.type = YoutubeUmpEventType::MediaEnd});
            break;
        case 35:
            result.events.push_back(parseNextRequestPolicy(payload));
            break;
        case 43:
            result.events.push_back(YoutubeUmpEvent{
                .type = YoutubeUmpEventType::Redirect,
                .text = parseStringField(payload, 1),
            });
            break;
        case 44:
            result.events.push_back(parseSabrError(payload));
            break;
        case 46:
            result.events.push_back(YoutubeUmpEvent{.type = YoutubeUmpEventType::ReloadPlayer});
            break;
        case 57:
            result.events.push_back(parseContextUpdate(payload));
            break;
        case 58:
            result.events.push_back(parseStreamProtectionStatus(payload));
            break;
        case 59:
            result.events.push_back(YoutubeUmpEvent{
                .type = YoutubeUmpEventType::SabrContextSendingPolicy,
                .bytes = payload,
            });
            break;
        default:
            break;
        }
    }

    return result;
}

void YoutubeUmpParser::reset() {
    buffer_.clear();
}

