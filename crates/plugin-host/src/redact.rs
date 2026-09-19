/// Strip the query string and fragment from a URL for logging and tracing.
///
/// Resolved playback URLs carry signed parameters; they must never appear
/// raw in output.
pub fn redact_url(url: &str) -> String {
    match url.find(['?', '#']) {
        Some(i) => url[..i].to_string(),
        None => url.to_string(),
    }
}

/// Strip query + fragment from every `http(s)://` URL inside arbitrary
/// text. Guest-supplied strings (e.g. `fail` messages) can quote a
/// signed stream URL; redaction must survive embedding, not just a
/// whole-string URL. A truncated URL keeps `?…` as the cut marker.
pub fn redact_text(text: &str) -> String {
    // Bytes that cannot be part of a URL token.
    const URL_END: &[u8] = b" \t\r\n\"'<>)],}";
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"http://") || bytes[i..].starts_with(b"https://") {
            let mut j = i;
            while j < bytes.len()
                && !URL_END.contains(&bytes[j])
                && bytes[j] != b'?'
                && bytes[j] != b'#'
            {
                j += 1;
            }
            out.push_str(&text[i..j]);
            let cut = j < bytes.len() && (bytes[j] == b'?' || bytes[j] == b'#');
            while j < bytes.len() && !URL_END.contains(&bytes[j]) {
                j += 1;
            }
            if cut {
                out.push_str("?…");
            }
            i = j;
        } else {
            let Some(ch) = text[i..].chars().next() else {
                break;
            };
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_without_query_is_untouched() {
        assert_eq!(redact_url("https://a.b/c"), "https://a.b/c");
        assert_eq!(redact_url("https://a.b/c?sig=x#f"), "https://a.b/c");
    }

    #[test]
    fn embedded_urls_lose_their_query() {
        let text = "fetch https://rr1---sn.x.c/v?sig=SECRET&pot=TOKEN failed; retry https://b.c/d";
        assert_eq!(
            redact_text(text),
            "fetch https://rr1---sn.x.c/v?… failed; retry https://b.c/d"
        );
    }

    #[test]
    fn secrets_cannot_survive() {
        let text = "bad https://a.b/stream?expire=1&sig=SYNTHETIC_SECRET end";
        let out = redact_text(text);
        assert!(!out.contains("SYNTHETIC_SECRET"), "{out}");
        assert!(out.starts_with("bad https://a.b/stream"));
        assert!(out.ends_with(" end"));
    }
}
