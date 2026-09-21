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
/// text, then mask every value in `secrets` verbatim. Guest-supplied
/// strings (e.g. `fail` messages) can quote a signed stream URL or echo
/// back token material the host handed them; redaction must survive
/// embedding, not just a whole-string URL. A truncated URL keeps `?…`
/// as the cut marker; a masked secret leaves `***`.
pub fn redact_text(text: &str, secrets: &[String]) -> String {
    // Bytes that cannot be part of a URL token.
    const URL_END: &[u8] = b" \t\r\n\"'<>)],}";
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if has_url_scheme(&bytes[i..]) {
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
    // Substring masking only makes sense for real token material — a
    // short string would mangle unrelated text.
    for secret in secrets.iter().filter(|s| s.len() >= 8) {
        out = out.replace(secret.as_str(), "***");
    }
    out
}

/// Whether `b` begins with `http://` or `https://` under an
/// ASCII-case-insensitive match — schemes are case-insensitive, so
/// `HTTPS://` leaks signed params exactly like its lowercase form.
fn has_url_scheme(b: &[u8]) -> bool {
    (b.len() >= 7 && b[..7].eq_ignore_ascii_case(b"http://"))
        || (b.len() >= 8 && b[..8].eq_ignore_ascii_case(b"https://"))
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
            redact_text(text, &[]),
            "fetch https://rr1---sn.x.c/v?… failed; retry https://b.c/d"
        );
    }

    #[test]
    fn schemes_redact_case_insensitively() {
        let text = "hit HTTPS://a.b/s?sig=SECRET and HtTp://c.d/e?tok=SECRET done";
        let out = redact_text(text, &[]);
        assert!(!out.contains("SECRET"), "{out}");
        assert_eq!(out, "hit HTTPS://a.b/s?… and HtTp://c.d/e?… done");
    }

    #[test]
    fn secrets_are_masked_wherever_they_appear() {
        let secrets = vec!["guest-access-token-123".to_string()];
        let text = "token was guest-access-token-123 in https://a.b/s?x=guest-access-token-123";
        let out = redact_text(text, &secrets);
        assert!(!out.contains("guest-access-token-123"), "{out}");
        assert_eq!(out, "token was *** in https://a.b/s?…");
    }

    #[test]
    fn short_secrets_are_not_masked() {
        let secrets = vec!["pin".to_string()];
        let out = redact_text("spinning pinwheel", &secrets);
        assert_eq!(out, "spinning pinwheel");
    }

    #[test]
    fn secrets_cannot_survive() {
        let text = "bad https://a.b/stream?expire=1&sig=SYNTHETIC_SECRET end";
        let out = redact_text(text, &[]);
        assert!(!out.contains("SYNTHETIC_SECRET"), "{out}");
        assert!(out.starts_with("bad https://a.b/stream"));
        assert!(out.ends_with(" end"));
    }

    #[test]
    fn uppercase_scheme_still_redacts() {
        let text = "w HTTPS://a.b/s?sig=SYNTHETIC_SECRET Http://c.d/?q=1 e";
        let out = redact_text(text, &[]);
        assert!(!out.contains("SYNTHETIC_SECRET"), "{out}");
        assert!(out.starts_with("w HTTPS://a.b/s?… Http://c.d/?…"), "{out}");
        assert!(out.ends_with(" e"));
    }
}
