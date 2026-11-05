//! Thin safe wrapper over `unsafe-libopus` (libopus transpiled to pure Rust), so the
//! build needs no cmake / C++ toolchain. Mirrors the small slice of the `opus`
//! crate's API this server uses.

use std::fmt;

use unsafe_libopus::{
    opus_encode, opus_encoder_create, opus_encoder_ctl_impl, opus_encoder_destroy, opus_strerror, varargs, OpusEncoder,
    OPUS_APPLICATION_AUDIO, OPUS_GET_LOOKAHEAD_REQUEST, OPUS_OK, OPUS_SET_BITRATE_REQUEST, OPUS_SET_COMPLEXITY_REQUEST,
    OPUS_SET_LSB_DEPTH_REQUEST, OPUS_SET_VBR_CONSTRAINT_REQUEST, OPUS_SET_VBR_REQUEST,
};

#[derive(Debug, Clone, Copy)]
pub struct Error(i32);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", opus_strerror(self.0))
    }
}

impl std::error::Error for Error {}

#[derive(Clone, Copy)]
#[allow(dead_code)]
pub enum Channels {
    Mono = 1,
    Stereo = 2,
}

#[derive(Clone, Copy)]
pub enum Application {
    Audio,
}

#[derive(Clone, Copy)]
pub enum Bitrate {
    Bits(i32),
}

pub struct Encoder {
    st: *mut OpusEncoder,
    channels: usize,
}

// The encoder state is owned exclusively by this struct (and only used behind a Mutex / one thread).
unsafe impl Send for Encoder {}

impl Encoder {
    pub fn new(rate: u32, channels: Channels, app: Application) -> Result<Self, Error> {
        let app = match app {
            Application::Audio => OPUS_APPLICATION_AUDIO,
        };
        let mut err = 0i32;
        let st = unsafe { opus_encoder_create(rate as i32, channels as i32, app, &mut err) };
        if st.is_null() || err != OPUS_OK {
            return Err(Error(if err != OPUS_OK { err } else { -7 }));
        }
        Ok(Self { st, channels: channels as usize })
    }

    fn ctl(&mut self, request: i32, value: i32) -> Result<(), Error> {
        let r = unsafe { opus_encoder_ctl_impl(self.st, request, varargs!(value)) };
        if r < 0 { Err(Error(r)) } else { Ok(()) }
    }

    pub fn set_bitrate(&mut self, b: Bitrate) -> Result<(), Error> {
        let Bitrate::Bits(v) = b;
        self.ctl(OPUS_SET_BITRATE_REQUEST, v)
    }
    pub fn set_vbr(&mut self, on: bool) -> Result<(), Error> {
        self.ctl(OPUS_SET_VBR_REQUEST, on as i32)
    }
    pub fn set_vbr_constraint(&mut self, on: bool) -> Result<(), Error> {
        self.ctl(OPUS_SET_VBR_CONSTRAINT_REQUEST, on as i32)
    }
    pub fn set_complexity(&mut self, c: i32) -> Result<(), Error> {
        self.ctl(OPUS_SET_COMPLEXITY_REQUEST, c)
    }
    pub fn set_lsb_depth(&mut self, d: i32) -> Result<(), Error> {
        self.ctl(OPUS_SET_LSB_DEPTH_REQUEST, d)
    }
    pub fn get_lookahead(&mut self) -> Result<i32, Error> {
        let mut v = 0i32;
        let r = unsafe { opus_encoder_ctl_impl(self.st, OPUS_GET_LOOKAHEAD_REQUEST, varargs!(&mut v)) };
        if r < 0 { Err(Error(r)) } else { Ok(v) }
    }

    /// Encode interleaved 16-bit PCM (one frame); returns the packet length.
    pub fn encode(&mut self, pcm: &[i16], out: &mut [u8]) -> Result<usize, Error> {
        if pcm.is_empty() || pcm.len() % self.channels != 0 {
            return Err(Error(-1));
        }
        let n = unsafe {
            opus_encode(self.st, pcm.as_ptr(), (pcm.len() / self.channels) as i32, out.as_mut_ptr(), out.len() as i32)
        };
        if n < 0 { Err(Error(n)) } else { Ok(n as usize) }
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe { opus_encoder_destroy(self.st) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use unsafe_libopus::{opus_decode, opus_decoder_create};

    #[test]
    fn roundtrip_sine() {
        let mut enc = Encoder::new(48000, Channels::Stereo, Application::Audio).unwrap();
        enc.set_bitrate(Bitrate::Bits(160000)).unwrap();
        enc.set_vbr(true).unwrap();
        enc.set_vbr_constraint(false).unwrap();
        enc.set_complexity(10).unwrap();
        enc.set_lsb_depth(16).unwrap();
        assert_eq!(enc.get_lookahead().unwrap(), 312);
        let mut err = 0;
        let dec = unsafe { opus_decoder_create(48000, 2, &mut err) };
        assert_eq!(err, 0);
        let (mut sig, mut dsum, mut n_pk) = (0f64, 0f64, 0usize);
        let mut all_in = vec![];
        let mut all_out = vec![];
        for f in 0..100 {
            let pcm: Vec<i16> = (0..960).flat_map(|i| {
                let t = (f * 960 + i) as f64 / 48000.0;
                let v = ((t * 440.0 * std::f64::consts::TAU).sin() * 12000.0) as i16;
                [v, v]
            }).collect();
            let mut out = [0u8; 4000];
            let n = enc.encode(&pcm, &mut out).unwrap();
            n_pk += n;
            let mut dp = vec![0i16; 960 * 2];
            let r = unsafe { opus_decode(dec, out.as_ptr(), n as i32, dp.as_mut_ptr(), 960, 0) };
            assert_eq!(r, 960);
            all_in.extend(pcm);
            all_out.extend(dp);
        }
        // decoded signal lags by the lookahead (312 samples): compare with that shift
        let sh = 312 * 2;
        for i in 20000..(all_in.len() - sh) {
            let a = all_in[i] as f64;
            let b = all_out[i + sh] as f64;
            sig += a * a;
            dsum += (a - b) * (a - b);
        }
        let snr = 10.0 * (sig / dsum).log10();
        println!("bytes {n_pk}, snr {snr:.1} dB");
        assert!(snr > 15.0, "snr {snr}");
    }
}
