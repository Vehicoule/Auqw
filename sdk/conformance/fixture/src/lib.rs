//! Conformance fixture guest: canned catalog, playback, lyrics, and radio
//! results for desktop-shell evidence runs. The resolve URLs point at a
//! developer-run range fixture on loopback (`http://127.0.0.1:45999/<id>`);
//! the guest itself never touches the network.
//!
//! Rebuild: `cargo build --target wasm32-unknown-unknown --release -p
//! auqw-conformance-fixture`, then copy `target/wasm32-unknown-unknown/
//! release/auqw_conformance_fixture.wasm` next to this source as
//! `fixture.wasm` and write `fixture.manifest.json` beside it with the
//! wasm's sha256.

use auqw_guest_sdk::{export_plugin, GuestError, GuestFuture, Invocation};
use serde_json::{json, Value};

export_plugin!(dispatch);

/// The fixture media ships in-repo; resolve URLs point at the raw
/// GitHub host (real https + 206 support — the manifest can only ever
/// bless an https destination, so a loopback fixture cannot pass the
/// result-URL allowlist).
const MEDIA_BASE: &str =
    "https://raw.githubusercontent.com/Vehicoule/Auqw/s4/desktop-shell/sdk/conformance/fixture/media/";

struct Track {
    id: &'static str,
    title: &'static str,
    artist: &'static str,
    artist_id: &'static str,
    album: &'static str,
    album_id: &'static str,
    duration_ms: u64,
    year: u64,
    genre: &'static str,
    art_seed: &'static str,
}

const TRACKS: &[Track] = &[
    Track {
        id: "trk1",
        title: "Glass Harbor",
        artist: "Nova Field",
        artist_id: "art-nova",
        album: "Salted Static",
        album_id: "alb-salted",
        duration_ms: 206_000,
        year: 2021,
        genre: "shoegaze",
        art_seed: "auqw-salted",
    },
    Track {
        id: "trk2",
        title: "Driftline",
        artist: "Nova Field",
        artist_id: "art-nova",
        album: "Salted Static",
        album_id: "alb-salted",
        duration_ms: 187_000,
        year: 2021,
        genre: "shoegaze",
        art_seed: "auqw-drift",
    },
    Track {
        id: "trk3",
        title: "Paper Satellites",
        artist: "Cobalt Union",
        artist_id: "art-cobalt",
        album: "Static Seasons",
        album_id: "alb-seasons",
        duration_ms: 233_000,
        year: 2019,
        genre: "indie",
        art_seed: "auqw-paper",
    },
    Track {
        id: "trk4",
        title: "Ninth Lantern",
        artist: "Cobalt Union",
        artist_id: "art-cobalt",
        album: "Static Seasons",
        album_id: "alb-seasons",
        duration_ms: 214_000,
        year: 2019,
        genre: "indie",
        art_seed: "auqw-lantern",
    },
    Track {
        id: "trk5",
        title: "The Quiet Broadcast",
        artist: "Tessellate",
        artist_id: "art-tess",
        album: "Modular Dusk",
        album_id: "alb-modular",
        duration_ms: 251_000,
        year: 2023,
        genre: "ambient",
        art_seed: "auqw-broadcast",
    },
    Track {
        id: "trk6",
        title: "Antenna Garden",
        artist: "Tessellate",
        artist_id: "art-tess",
        album: "Modular Dusk",
        album_id: "alb-modular",
        duration_ms: 199_000,
        year: 2023,
        genre: "ambient",
        art_seed: "auqw-antenna",
    },
    Track {
        id: "trk7",
        title: "Copper Ferry",
        artist: "Vespers",
        artist_id: "art-vesp",
        album: "Harbor Lights",
        album_id: "alb-harbor",
        duration_ms: 178_000,
        year: 2017,
        genre: "folk",
        art_seed: "auqw-ferry",
    },
    Track {
        id: "trk8",
        title: "Winter Loop",
        artist: "Vespers",
        artist_id: "art-vesp",
        album: "Harbor Lights",
        album_id: "alb-harbor",
        duration_ms: 242_000,
        year: 2017,
        genre: "folk",
        art_seed: "auqw-winter",
    },
];

fn track_meta(t: &Track) -> Value {
    json!({
        "source_ref": { "provider": "fixture-audio", "kind": "track", "id": t.id },
        "title": t.title,
        "artist": t.artist,
        "album": t.album,
        "duration_ms": t.duration_ms,
        "release_year": t.year,
        "artwork": [{
            "url": format!("https://picsum.photos/seed/{}/240/240", t.art_seed),
            "width": 240,
            "height": 240,
        }],
        "explicit": false,
        "genre": t.genre,
        "storefront": "US",
        "artist_ref": { "provider": "fixture-audio", "kind": "artist", "id": t.artist_id },
        "album_ref": { "provider": "fixture-audio", "kind": "album", "id": t.album_id },
        "isrc": null,
    })
}

fn all_tracks() -> Vec<Value> {
    TRACKS.iter().map(track_meta).collect()
}

fn matched(t: &Track) -> Value {
    json!({
        "title": t.title,
        "artist": t.artist,
        "album": t.album,
        "duration_ms": t.duration_ms,
    })
}

fn lyrics_query_track(payload: &Value) -> Option<&'static Track> {
    let title = payload["query"]["title"].as_str()?;
    TRACKS.iter().find(|t| t.title.eq_ignore_ascii_case(title))
}

fn dispatch(inv: Invocation) -> GuestFuture {
    Box::pin(run(inv))
}

async fn run(inv: Invocation) -> Result<Value, GuestError> {
    let p = inv.payload;
    match inv.capability.as_str() {
        "catalog.search" => {
            let query = p["query"].as_str().unwrap_or_default().to_lowercase();
            let items: Vec<Value> = all_tracks()
                .into_iter()
                .filter(|m| {
                    query.is_empty()
                        || [m["title"].as_str(), m["artist"].as_str(), m["album"].as_str()]
                            .iter()
                            .flatten()
                            .any(|s| s.to_lowercase().contains(&query))
                })
                .collect();
            Ok(json!({ "items": items, "storefront": "US" }))
        }
        "catalog.metadata" => {
            let refs = p["refs"].as_array().cloned().unwrap_or_default();
            let items: Vec<Value> = TRACKS
                .iter()
                .filter(|t| {
                    refs.iter().any(|r| {
                        r["id"].as_str() == Some(t.id)
                            && r["provider"].as_str() == Some("fixture-audio")
                    })
                })
                .map(track_meta)
                .collect();
            Ok(json!({ "items": items }))
        }
        "catalog.entity" => {
            let id = p["ref"]["id"].as_str().unwrap_or_default();
            let kind = p["ref"]["kind"].as_str().unwrap_or_default();
            let items: Vec<Value> = TRACKS
                .iter()
                .filter(|t| match kind {
                    "artist" => t.artist_id == id,
                    "album" => t.album_id == id,
                    _ => false,
                })
                .map(track_meta)
                .collect();
            let first = items.first().cloned();
            if let Some(m) = &first {
                Ok(json!({
                    "entity": {
                        "source_ref": {
                            "provider": "fixture-audio",
                            "kind": kind,
                            "id": id,
                        },
                        "kind": kind,
                        "title": if kind == "artist" {
                            m["artist"].clone()
                        } else {
                            m["album"].clone()
                        },
                        "subtitle": if kind == "album" {
                            m["artist"].clone()
                        } else {
                            Value::Null
                        },
                        "artwork": m["artwork"].clone(),
                    },
                    "items": items,
                    "continuation": null,
                    "complete": true,
                }))
            } else {
                Err(GuestError::Failed {
                    kind: "not-found".into(),
                    message: format!("fixture entity {id} unknown"),
                })
            }
        }
        "playback.candidates" => Ok(json!({ "items": all_tracks() })),
        "playback.resolve" => {
            // Hosts send source_ref as a bare id string or a full
            // {provider, kind, id} ref — the fixture accepts both.
            let id = p["source_ref"]
                .as_str()
                .or_else(|| p["source_ref"]["id"].as_str())
                .unwrap_or_default();
            if TRACKS.iter().any(|t| t.id == id) {
                Ok(json!({
                    "url": format!("{MEDIA_BASE}{id}.mp3"),
                    "mime": "audio/mpeg",
                    "bitrate_kbps": 320,
                    "expires_at_ms": null,
                    "client": "fixture-audio",
                }))
            } else {
                Err(GuestError::Failed {
                    kind: "not-found".into(),
                    message: format!("fixture track {id} unknown"),
                })
            }
        }
        "lyrics.synced" => {
            let Some(t) = lyrics_query_track(&p) else {
                return Ok(json!({ "state": "absent", "lines": null, "matched": null }));
            };
            let lines: Vec<Value> = (0..12u64)
                .map(|i| {
                    json!({
                        "t_ms": i * 15_000 + 2_000,
                        "text": format!("{} · line {}", t.title, i + 1),
                    })
                })
                .collect();
            Ok(json!({
                "state": "synced",
                "lines": lines,
                "matched": matched(t),
            }))
        }
        "lyrics.plain" => {
            let Some(t) = lyrics_query_track(&p) else {
                return Ok(json!({ "state": "absent", "text": null, "matched": null }));
            };
            Ok(json!({
                "state": "plain",
                "text": format!("{}\n\nplain lyrics fixture line one\nplain lyrics fixture line two", t.title),
                "matched": matched(t),
            }))
        }
        "radio.seed" => Ok(json!({ "items": all_tracks(), "continuation": null })),
        other => Err(GuestError::Failed {
            kind: "not-applicable".into(),
            message: format!("fixture capability {other} unimplemented"),
        }),
    }
}
