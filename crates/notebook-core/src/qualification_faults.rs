#[cfg(target_arch = "wasm32")]
const ARGON2_OOM_SUFFIX: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
#[cfg(target_arch = "wasm32")]
const JCS_OOM_SUFFIX: &str = "cccccccccccccccccccccccccccccccc";
#[cfg(target_arch = "wasm32")]
const SERDE_OOM_SUFFIX: &[u8] = b"dddddddddddddddddddddddddddddddd";
#[cfg(target_arch = "wasm32")]
const PANIC_SUFFIX: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
#[cfg(target_arch = "wasm32")]
const OOM_SUFFIX: &str = "ffffffffffffffffffffffffffffffff";

pub(crate) fn trigger(id: &str) {
    #[cfg(target_arch = "wasm32")]
    if id.ends_with(PANIC_SUFFIX) {
        panic!("qualification-only internal panic");
    } else if id.ends_with(OOM_SUFFIX) {
        trigger_allocator_oom();
    }

    #[cfg(not(target_arch = "wasm32"))]
    let _ = id;
}

pub(crate) fn arm_serde_allocation(document: &[u8]) {
    #[cfg(target_arch = "wasm32")]
    if document
        .windows(SERDE_OOM_SUFFIX.len())
        .any(|window| window == SERDE_OOM_SUFFIX)
    {
        crate::qualification_allocator::fail_next_allocation();
        // Valid envelopes now deserialize entirely through borrowed strings, so
        // their production parser path deliberately performs no heap allocation.
        // Keep the non-shipping dependency fault boundary executable with an
        // owned-string parse whose first allocation must hit the armed allocator.
        let probe = serde_json::from_slice::<String>(b"\"qualification-serde-allocation\"");
        std::hint::black_box(probe);
        panic!("qualification-only serde allocation unexpectedly succeeded");
    }

    #[cfg(not(target_arch = "wasm32"))]
    let _ = document;
}

pub(crate) fn arm_jcs_allocation(id: &str) {
    #[cfg(target_arch = "wasm32")]
    if id.ends_with(JCS_OOM_SUFFIX) {
        crate::qualification_allocator::fail_next_allocation();
    }

    #[cfg(not(target_arch = "wasm32"))]
    let _ = id;
}

pub(crate) fn arm_argon2_allocation(id: &str) {
    #[cfg(target_arch = "wasm32")]
    if id.ends_with(ARGON2_OOM_SUFFIX) {
        crate::qualification_allocator::fail_next_allocation();
    }

    #[cfg(not(target_arch = "wasm32"))]
    let _ = id;
}

#[cfg(target_arch = "wasm32")]
#[cold]
#[inline(never)]
fn trigger_allocator_oom() -> ! {
    // The qualification module is linked with a 512 MiB maximum. Requesting a
    // single 600 MiB allocation forces the Rust allocator's memory.grow path
    // to fail without asking the browser process to overcommit beyond that cap.
    let allocation = Vec::<u8>::with_capacity(600 * 1024 * 1024);
    std::hint::black_box(allocation);
    panic!("qualification-only OOM unexpectedly succeeded");
}
