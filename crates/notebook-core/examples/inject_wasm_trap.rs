use std::env;
use std::error::Error;
use std::fs;
use std::path::PathBuf;

use wasmparser::{ExternalKind, Parser, Payload, validate};

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = env::args_os().skip(1);
    let input = arguments
        .next()
        .map(PathBuf::from)
        .ok_or("usage: inject_wasm_trap <input.wasm> <export-name> <output.wasm>")?;
    let export_name = arguments
        .next()
        .and_then(|value| value.into_string().ok())
        .ok_or("export name must be valid UTF-8")?;
    let output = arguments
        .next()
        .map(PathBuf::from)
        .ok_or("usage: inject_wasm_trap <input.wasm> <export-name> <output.wasm>")?;
    if arguments.next().is_some() {
        return Err("usage: inject_wasm_trap <input.wasm> <export-name> <output.wasm>".into());
    }

    let mut module = fs::read(&input)?;
    let mut target_function = None;
    let mut imported_functions = 0u32;
    let mut code_ordinal = 0u32;
    let mut operator_range = None;

    for payload in Parser::new(0).parse_all(&module) {
        match payload? {
            Payload::ImportSection(section) => {
                for group in section {
                    for import in group?.into_iter() {
                        let (_, import) = import?;
                        if matches!(
                            import.ty,
                            wasmparser::TypeRef::Func(_) | wasmparser::TypeRef::FuncExact(_)
                        ) {
                            imported_functions = imported_functions
                                .checked_add(1)
                                .ok_or("imported function count overflow")?;
                        }
                    }
                }
            }
            Payload::ExportSection(section) => {
                for export in section {
                    let export = export?;
                    if export.name == export_name
                        && export.kind == ExternalKind::Func
                        && target_function.replace(export.index).is_some()
                    {
                        return Err("duplicate target export".into());
                    }
                }
            }
            Payload::CodeSectionEntry(body) => {
                if target_function == Some(imported_functions + code_ordinal) {
                    let start = body.get_binary_reader_for_operators()?.original_position();
                    operator_range = Some(start..body.range().end);
                }
                code_ordinal = code_ordinal
                    .checked_add(1)
                    .ok_or("code function count overflow")?;
            }
            _ => {}
        }
    }

    let target_function = target_function.ok_or("target function export not found")?;
    if target_function < imported_functions {
        return Err("cannot replace an imported function".into());
    }
    let range = operator_range.ok_or("target function body not found")?;
    if range.len() < 2 {
        return Err("target function body is too short for trap injection".into());
    }

    module[range.start] = 0x00; // unreachable
    module[(range.start + 1)..(range.end - 1)].fill(0x01); // nop
    module[range.end - 1] = 0x0b; // end
    validate(&module)?;
    fs::write(&output, &module)?;

    println!(
        "Injected qualification trap into {export_name} (function {target_function}) -> {}",
        output.display()
    );
    Ok(())
}
