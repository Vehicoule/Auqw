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
