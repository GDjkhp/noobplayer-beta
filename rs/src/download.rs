//! GET /api/download — pulls a whole track's PCM from NodeLink as fast as the
//! connection allows and returns it as opus (Ogg), mp3 or wav. No pacing, none
//! of the relay's gapless machinery.

use axum::body::Body;
use axum::extract::RawQuery;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use futures_util::StreamExt;
use regex::Regex;
use serde_json::json;
use std::sync::LazyLock;

use crate::auth::url_pairs;
use crate::nodelink;
use crate::relay::{OPUS_BITRATE, PCM_CHANNELS, PCM_FRAME_BYTES, PCM_FRAME_SAMPLES, PCM_RATE};
use crate::util::{jerr, trunc_chars};

struct Spec {
    mime: &'static str,
    ext: &'static str,
}

fn spec_for(fmt: &str) -> Option<Spec> {
    match fmt {
        "opus" => Some(Spec { mime: "audio/ogg", ext: "ogg" }),
        "mp3" => Some(Spec { mime: "audio/mpeg", ext: "mp3" }),
        "wav" => Some(Spec { mime: "audio/wav", ext: "wav" }),
        _ => None,
    }
}

/// Pulls an entire track's raw PCM from NodeLink in one go.
async fn fetch_full_pcm(encoded: &str) -> Result<Vec<u8>, String> {
    let body = json!({"encodedTrack": encoded, "position": 0});
    let r = nodelink::request("POST", "/v4/loadstream", &[], Some(&body), true).await.map_err(|e| e.to_string())?;
    if r.status().as_u16() != 200 {
        let status = r.status().as_u16();
        let txt = r.text().await.unwrap_or_default();
        return Err(format!("NodeLink loadstream {status}: {txt}"));
    }
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = Box::pin(nodelink::chunked(r.bytes_stream(), 65536));
    while let Some(item) = stream.next().await {
        buf.extend_from_slice(&item.map_err(|e| e.to_string())?);
    }
    Ok(buf)
}

/// Standard 44-byte RIFF/WAVE header in front of the raw PCM.
fn pcm_to_wav_bytes(pcm: &[u8]) -> Vec<u8> {
    let channels = PCM_CHANNELS as u16;
    let bits = 16u16;
    let byte_rate = (PCM_RATE * PCM_CHANNELS * 16 / 8) as u32;
    let block_align = channels * bits / 8;
    let data_size = pcm.len() as u32;
    let mut v = Vec::with_capacity(44 + pcm.len());
    v.extend_from_slice(b"RIFF");
    v.extend_from_slice(&(36 + data_size).to_le_bytes());
    v.extend_from_slice(b"WAVE");
    v.extend_from_slice(b"fmt ");
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&channels.to_le_bytes());
    v.extend_from_slice(&(PCM_RATE as u32).to_le_bytes());
    v.extend_from_slice(&byte_rate.to_le_bytes());
    v.extend_from_slice(&block_align.to_le_bytes());
    v.extend_from_slice(&bits.to_le_bytes());
    v.extend_from_slice(b"data");
    v.extend_from_slice(&data_size.to_le_bytes());
    v.extend_from_slice(pcm);
    v
}

// ───────────────────────── Ogg/Opus writer ─────────────────────────

fn ogg_crc_table() -> &'static [u32; 256] {
    static T: LazyLock<[u32; 256]> = LazyLock::new(|| {
        let mut t = [0u32; 256];
        for i in 0..256u32 {
            let mut r = i << 24;
            for _ in 0..8 {
                r = if r & 0x8000_0000 != 0 { (r << 1) ^ 0x04C1_1DB7 } else { r << 1 };
            }
            t[i as usize] = r;
        }
        t
    });
    &T
}

fn ogg_crc(data: &[u8]) -> u32 {
    let t = ogg_crc_table();
    let mut crc = 0u32;
    for &b in data {
        crc = (crc << 8) ^ t[(((crc >> 24) as u8) ^ b) as usize];
    }
    crc
}

struct OggWriter {
    out: Vec<u8>,
    serial: u32,
    seq: u32,
}

impl OggWriter {
    fn page(&mut self, header_type: u8, granule: i64, packets: &[&[u8]]) {
        let mut segs: Vec<u8> = Vec::new();
        for p in packets {
            let mut n = p.len();
            while n >= 255 {
                segs.push(255);
                n -= 255;
            }
            segs.push(n as u8);
        }
        let mut page = Vec::with_capacity(27 + segs.len() + packets.iter().map(|p| p.len()).sum::<usize>());
        page.extend_from_slice(b"OggS");
        page.push(0);
        page.push(header_type);
        page.extend_from_slice(&granule.to_le_bytes());
        page.extend_from_slice(&self.serial.to_le_bytes());
        page.extend_from_slice(&self.seq.to_le_bytes());
        page.extend_from_slice(&[0, 0, 0, 0]);
        page.push(segs.len() as u8);
        page.extend_from_slice(&segs);
        for p in packets {
            page.extend_from_slice(p);
        }
        let crc = ogg_crc(&page);
        page[22..26].copy_from_slice(&crc.to_le_bytes());
        self.out.extend_from_slice(&page);
        self.seq += 1;
    }
}

fn encode_opus_ogg(pcm: &[u8], bitrate: i32) -> Result<Vec<u8>, String> {
    let mut enc = crate::opus::Encoder::new(PCM_RATE as u32, crate::opus::Channels::Stereo, crate::opus::Application::Audio).map_err(|e| e.to_string())?;
    enc.set_bitrate(crate::opus::Bitrate::Bits(bitrate)).map_err(|e| e.to_string())?;
    enc.set_vbr(true).map_err(|e| e.to_string())?;
    enc.set_vbr_constraint(false).map_err(|e| e.to_string())?;
    enc.set_complexity(10).map_err(|e| e.to_string())?;
    let pre_skip = enc.get_lookahead().map_err(|e| e.to_string())? as u16;

    // Pad the tail to a whole number of frames with silence, plus one frame so
    // the encoder's lookahead is flushed out.
    let mut pcm = pcm.to_vec();
    let rem = pcm.len() % PCM_FRAME_BYTES;
    if rem != 0 {
        pcm.resize(pcm.len() + (PCM_FRAME_BYTES - rem), 0);
    }
    pcm.resize(pcm.len() + PCM_FRAME_BYTES, 0);

    let mut w = OggWriter { out: Vec::new(), serial: rand::random::<u32>(), seq: 0 };
    let mut head = Vec::new();
    head.extend_from_slice(b"OpusHead");
    head.push(1);
    head.push(PCM_CHANNELS as u8);
    head.extend_from_slice(&pre_skip.to_le_bytes());
    head.extend_from_slice(&(PCM_RATE as u32).to_le_bytes());
    head.extend_from_slice(&0i16.to_le_bytes());
    head.push(0);
    w.page(0x02, 0, &[&head]);
    let vendor = b"noobplayer";
    let mut tags = Vec::new();
    tags.extend_from_slice(b"OpusTags");
    tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    tags.extend_from_slice(vendor);
    tags.extend_from_slice(&0u32.to_le_bytes());
    w.page(0x00, 0, &[&tags]);

    let total_frames = pcm.len() / PCM_FRAME_BYTES;
    let mut packets: Vec<Vec<u8>> = Vec::new();
    let mut out = [0u8; 4000];
    let mut samples: Vec<i16> = vec![0; PCM_FRAME_SAMPLES * PCM_CHANNELS];
    let mut done_frames = 0usize;
    let mut seg_count = 0usize;
    let flush = |w: &mut OggWriter, packets: &mut Vec<Vec<u8>>, done: usize, eos: bool| {
        if packets.is_empty() && !eos {
            return;
        }
        let refs: Vec<&[u8]> = packets.iter().map(|p| p.as_slice()).collect();
        let granule = pre_skip as i64 + (done * PCM_FRAME_SAMPLES) as i64;
        w.page(if eos { 0x04 } else { 0x00 }, granule, &refs);
        packets.clear();
    };
    for f in 0..total_frames {
        let chunk = &pcm[f * PCM_FRAME_BYTES..(f + 1) * PCM_FRAME_BYTES];
        for (i, s) in samples.iter_mut().enumerate() {
            *s = i16::from_le_bytes([chunk[2 * i], chunk[2 * i + 1]]);
        }
        let n = enc.encode(&samples, &mut out).map_err(|e| e.to_string())?;
        let segs = n / 255 + 1;
        if seg_count + segs > 255 {
            flush(&mut w, &mut packets, done_frames, false);
            seg_count = 0;
        }
        packets.push(out[..n].to_vec());
        seg_count += segs;
        done_frames += 1;
        if packets.len() >= 50 && f + 1 < total_frames {
            flush(&mut w, &mut packets, done_frames, false);
            seg_count = 0;
        }
    }
    flush(&mut w, &mut packets, done_frames, true);
    Ok(w.out)
}

fn encode_mp3(pcm: &[u8], bitrate_kbps: u32) -> Result<Vec<u8>, String> {
    use mp3lame_encoder::{Bitrate, Builder, FlushNoGap, InterleavedPcm, Quality};
    let mut b = Builder::new().ok_or("lame init failed")?;
    b.set_num_channels(PCM_CHANNELS as u8).map_err(|e| format!("{e:?}"))?;
    b.set_sample_rate(PCM_RATE as u32).map_err(|e| format!("{e:?}"))?;
    let br = match bitrate_kbps {
        192 => Bitrate::Kbps192,
        _ => Bitrate::Kbps192,
    };
    b.set_brate(br).map_err(|e| format!("{e:?}"))?;
    b.set_quality(Quality::Best).map_err(|e| format!("{e:?}"))?;
    let mut enc = b.build().map_err(|e| format!("{e:?}"))?;

    let mut pcm = pcm.to_vec();
    let rem = pcm.len() % PCM_FRAME_BYTES;
    if rem != 0 {
        pcm.resize(pcm.len() + (PCM_FRAME_BYTES - rem), 0);
    }
    let samples: Vec<i16> = pcm.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
    let mut out: Vec<u8> = Vec::new();
    for chunk in samples.chunks(PCM_FRAME_SAMPLES * PCM_CHANNELS * 50) {
        out.reserve(mp3lame_encoder::max_required_buffer_size(chunk.len() / 2));
        let n = enc.encode(InterleavedPcm(chunk), out.spare_capacity_mut()).map_err(|e| format!("{e:?}"))?;
        unsafe { out.set_len(out.len() + n) };
    }
    out.reserve(7200);
    let n = enc.flush::<FlushNoGap>(out.spare_capacity_mut()).map_err(|e| format!("{e:?}"))?;
    unsafe { out.set_len(out.len() + n) };
    Ok(out)
}

static BAD_NAME_CHARS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"[\\/:*?"<>|\r\n]"#).unwrap());

fn safe_filename(name: &str) -> String {
    let cleaned = BAD_NAME_CHARS.replace_all(name, "");
    let t = trunc_chars(cleaned.trim(), 120);
    if t.is_empty() {
        "track".into()
    } else {
        t
    }
}

pub async fn download_track(RawQuery(q): RawQuery) -> Response {
    let pairs = url_pairs(q.as_deref().unwrap_or(""));
    let get = |k: &str| pairs.iter().find(|(kk, _)| kk == k).map(|(_, v)| v.clone());
    let encoded = get("encodedTrack").unwrap_or_default();
    let fmt = get("format").filter(|s| !s.is_empty()).unwrap_or_else(|| "opus".into()).to_lowercase();
    let title = get("title").filter(|s| !s.is_empty()).unwrap_or_else(|| "track".into());
    let author = get("author").unwrap_or_default();
    if encoded.is_empty() {
        return jerr(400, "encodedTrack required");
    }
    let Some(spec) = spec_for(&fmt) else {
        return jerr(400, "format must be opus, mp3, or wav");
    };

    let pcm = match fetch_full_pcm(&encoded).await {
        Ok(p) => p,
        Err(e) => return jerr(502, &format!("failed to fetch audio: {e}")),
    };
    if pcm.is_empty() {
        return jerr(502, "empty stream");
    }

    let data: Vec<u8> = if fmt == "wav" {
        pcm_to_wav_bytes(&pcm)
    } else {
        let f2 = fmt.clone();
        let r = tokio::task::spawn_blocking(move || if f2 == "opus" { encode_opus_ogg(&pcm, OPUS_BITRATE) } else { encode_mp3(&pcm, 192) }).await;
        match r {
            Ok(Ok(d)) => d,
            Ok(Err(e)) => return jerr(500, &format!("encoding to {fmt} failed: {e}")),
            Err(e) => return jerr(500, &format!("encoding to {fmt} failed: {e}")),
        }
    };

    let filename = safe_filename(&if author.is_empty() { title.clone() } else { format!("{author} - {title}") });
    let disp = format!("attachment; filename=\"{}.{}\"", filename, spec.ext);
    let mut resp = Response::new(Body::from(data.clone()));
    *resp.status_mut() = StatusCode::OK;
    let h = resp.headers_mut();
    if let Ok(v) = HeaderValue::from_bytes(disp.as_bytes()) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    h.insert(header::CONTENT_LENGTH, HeaderValue::from_str(&data.len().to_string()).unwrap());
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(spec.mime));
    resp
}
