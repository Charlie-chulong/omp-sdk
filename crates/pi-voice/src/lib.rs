//! Native voice engine: microphone capture, speaker playback, and an optional
//! WebRTC live-conversation peer enabled by the default `live` feature.
//!
//! napi-free by design. `pi-natives` wraps these types in thin `#[napi]`
//! adapters, so the webrtc/opus dependency graph compiles once into this
//! rlib and rebuilds only when voice code changes — never when the N-API
//! surface elsewhere in the addon does.
//!
//! # Architecture
//! ```text
//! JS (packages/natives) -> #[napi] adapters (pi-natives audio.rs / live.rs)
//!   -> pi_voice::audio  (capture/playback engine over in-house OS backends)
//!   -> pi_voice::live   (WebRTC peer + Opus media, feeds audio playback)
//! ```
//!
//! Async live entry points (`live::LivePeerCore::create_offer` and friends)
//! run on the caller's ambient tokio runtime — napi-rs's `tokio_rt` inside
//! the addon. Live callbacks (`live::LiveCallbacks`) are invoked from tokio
//! worker threads and must not block.

pub mod audio;
pub(crate) mod device;
#[cfg(feature = "live")]
pub mod live;

/// Engine-level result: a human-readable failure message the N-API layer maps
/// to a JS error verbatim.
pub type VoiceResult<T> = std::result::Result<T, String>;
