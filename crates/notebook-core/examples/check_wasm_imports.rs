use std::env;
use std::error::Error;
use std::fs;
use std::path::PathBuf;

use wasmparser::{ComponentExternalKind, Encoding, Operator, Parser, Payload};
use wit_component::ComponentEncoder;

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = env::args_os().skip(1);
    let path = arguments
        .next()
        .map(PathBuf::from)
        .ok_or("usage: check_wasm_imports <module.wasm> [component.wasm]")?;
    let component_path = arguments.next().map(PathBuf::from);
    if arguments.next().is_some() {
        return Err("usage: check_wasm_imports <module.wasm> [component.wasm]".into());
    }
    let module = fs::read(&path)?;
    check_core_module(&module)?;

    let component = if let Some(component_path) = &component_path {
        fs::read(component_path)?
    } else {
        ComponentEncoder::default()
            .module(&module)?
            .validate(true)
            .encode()?
    };
    check_component(&component)?;

    println!(
        "Notebook Core WASM verified: SIMD128, 0 module imports, 0 component imports, 512 MiB memory cap, WIT exports present ({}, component={})",
        path.display(),
        component_path.as_ref().map_or_else(
            || "generated".to_owned(),
            |value| value.display().to_string()
        )
    );
    Ok(())
}

fn check_core_module(module: &[u8]) -> Result<(), Box<dyn Error>> {
    let mut imports = Vec::new();
    let mut component_metadata = false;
    let mut core_module = false;
    let mut memories = Vec::new();
    let mut simd128 = false;

    for payload in Parser::new(0).parse_all(module) {
        match payload? {
            Payload::Version { encoding, .. } => core_module = encoding == Encoding::Module,
            Payload::ImportSection(section) => {
                for imports_group in section {
                    imports.push(format!("{:?}", imports_group?));
                }
            }
            Payload::MemorySection(section) => {
                for memory in section {
                    memories.push(memory?);
                }
            }
            Payload::CodeSectionEntry(body) => {
                let mut operators = body.get_operators_reader()?;
                while !operators.eof() {
                    if matches!(
                        operators.read()?,
                        Operator::V128Const { .. } | Operator::I8x16Shuffle { .. }
                    ) {
                        simd128 = true;
                    }
                }
            }
            Payload::CustomSection(section) if section.name().starts_with("component-type") => {
                component_metadata = true;
            }
            _ => {}
        }
    }

    if !core_module {
        return Err("artifact is not a core WebAssembly module".into());
    }
    if !imports.is_empty() {
        return Err(format!("forbidden WebAssembly imports: {}", imports.join(", ")).into());
    }
    if !component_metadata {
        return Err("wit-bindgen component-type metadata is missing".into());
    }
    if !simd128 {
        return Err("required SIMD128 instructions are missing".into());
    }
    if memories.len() != 1 {
        return Err(format!("expected one linear memory, found {}", memories.len()).into());
    }
    let memory = memories[0];
    if memory.memory64 || memory.shared || memory.maximum != Some(8192) {
        return Err(format!("unexpected linear-memory limits: {memory:?}").into());
    }
    Ok(())
}

fn check_component(component: &[u8]) -> Result<(), Box<dyn Error>> {
    let mut is_component = false;
    let mut imports = Vec::new();
    let mut exports = Vec::new();
    let mut depth = 0usize;

    for payload in Parser::new(0).parse_all(component) {
        match payload? {
            Payload::Version { encoding, .. } if depth == 0 && encoding == Encoding::Component => {
                is_component = true;
            }
            Payload::ComponentImportSection(section) if depth == 0 => {
                for import in section {
                    imports.push(format!("{:?}", import?));
                }
            }
            Payload::ComponentExportSection(section) if depth == 0 => {
                for export in section {
                    let export = export?;
                    exports.push((export.name.name.to_owned(), export.kind));
                }
            }
            Payload::ModuleSection { .. } | Payload::ComponentSection { .. } => depth += 1,
            Payload::End(_) if depth > 0 => depth -= 1,
            _ => {}
        }
    }

    if !is_component {
        return Err("component encoding did not produce a WebAssembly component".into());
    }
    if !imports.is_empty() {
        return Err(format!("forbidden component imports: {}", imports.join(", ")).into());
    }
    let expected = [(
        "libre-ai:notebook-core/api@2.0.0".to_owned(),
        ComponentExternalKind::Instance,
    )];
    if exports != expected {
        return Err(format!("unexpected component exports: {exports:?}").into());
    }
    Ok(())
}
