fn main() {
    println!("cargo:rerun-if-changed=../../vendored/wit/notebook-core-v2/world.wit");
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        // Bound linear memory even though the host controls actual growth.
        println!("cargo:rustc-link-arg=--max-memory=536870912");
    }
}
