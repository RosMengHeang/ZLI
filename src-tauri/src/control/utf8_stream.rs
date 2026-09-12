/// Incremental UTF-8 decoder for PTY byte streams.
///
/// Incomplete trailing sequences are held until the next chunk so split
/// multibyte characters (for example `❯`) never emit U+FFFD mid-stream.
#[derive(Debug, Default, Clone)]
pub(crate) struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn push(&mut self, chunk: &[u8]) -> String {
        if chunk.is_empty() && self.pending.is_empty() {
            return String::new();
        }
        let mut buffer = std::mem::take(&mut self.pending);
        buffer.extend_from_slice(chunk);
        self.decode_buffer(buffer)
    }

    /// Emit any held incomplete bytes as lossy UTF-8 (end of stream).
    pub(crate) fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        let pending = std::mem::take(&mut self.pending);
        String::from_utf8_lossy(&pending).into_owned()
    }

    pub(crate) fn clear(&mut self) {
        self.pending.clear();
    }

    fn decode_buffer(&mut self, buffer: Vec<u8>) -> String {
        match std::str::from_utf8(&buffer) {
            Ok(text) => text.to_owned(),
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                let (valid, rest) = buffer.split_at(valid_up_to);
                let mut output = std::str::from_utf8(valid)
                    .expect("valid_up_to prefix is UTF-8")
                    .to_owned();
                if error.error_len().is_none() {
                    self.pending = rest.to_vec();
                    return output;
                }
                let bad_len = error.error_len().unwrap_or(1).max(1);
                output.push('\u{FFFD}');
                if rest.len() > bad_len {
                    output.push_str(&self.push(&rest[bad_len..]));
                } else if rest.len() == bad_len {
                    // consumed the invalid byte(s)
                } else {
                    self.pending = rest.to_vec();
                }
                output
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Utf8StreamDecoder;

    #[test]
    fn split_prompt_marker_emits_no_replacement() {
        let marker = "❯".as_bytes();
        assert_eq!(marker.len(), 3);
        let mut decoder = Utf8StreamDecoder::new();
        let first = decoder.push(&marker[..2]);
        let second = decoder.push(&marker[2..]);
        assert_eq!(first, "");
        assert_eq!(second, "❯");
        assert!(!first.contains('\u{FFFD}'));
        assert!(!second.contains('\u{FFFD}'));
        assert_eq!(decoder.finish(), "");
    }
}
