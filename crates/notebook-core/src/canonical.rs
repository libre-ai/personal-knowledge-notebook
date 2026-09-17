use std::collections::BTreeSet;
use std::fmt;

use serde::de::{DeserializeSeed, Error as _, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::crypto::sha256_hex;
use crate::error::ErrorCode;
use crate::validate::{
    MAX_CONTEXT_BLOCKS, MAX_CONTEXT_CONTENT_BYTES, MAX_CONTEXT_DOCUMENT_BYTES,
    MAX_CONTEXT_JSON_DEPTH, MAX_CONTEXT_JSON_NODES, MAX_CONTEXT_LINKS_PER_BLOCK,
    MAX_CONTEXT_NUMBER_MAGNITUDE, MAX_CONTEXT_TOTAL_LINKS, valid_block_id, valid_context_id,
    valid_digest,
};

const CONTEXT_SCHEMA_VERSION: &str = "libre-ai.context-document.v2";
const CONTEXT_DIGEST_DOMAIN: &[u8] = b"libre-ai.context-document.v2";
const MAX_BLOCK_CONTENT_CHARS: usize = 262_144;

pub(crate) fn serialize_jcs<T: Serialize>(
    value: &T,
    reserved_bytes: usize,
) -> Result<Vec<u8>, ErrorCode> {
    let mut output = Vec::new();
    output
        .try_reserve_exact(reserved_bytes)
        .map_err(|_| ErrorCode::ResourceLimitExceeded)?;
    serde_jcs::to_writer(&mut output, value).map_err(|_| ErrorCode::InternalFailure)?;
    Ok(output)
}

pub(crate) fn canonicalize_context_document(document: &[u8]) -> Result<Vec<u8>, ErrorCode> {
    if document.is_empty()
        || document.len() > MAX_CONTEXT_DOCUMENT_BYTES
        || document.starts_with(&[0xef, 0xbb, 0xbf])
    {
        return Err(ErrorCode::InvalidDocument);
    }

    #[cfg(feature = "qualification-faults")]
    crate::qualification_faults::arm_serde_allocation(document);
    let mut context: ContextDocument =
        serde_json::from_slice(document).map_err(|_| ErrorCode::InvalidDocument)?;
    #[cfg(feature = "qualification-faults")]
    crate::qualification_faults::trigger(&context.id);
    context.validate_and_normalize()?;
    #[cfg(feature = "qualification-faults")]
    crate::qualification_faults::arm_jcs_allocation(&context.id);
    serialize_jcs(&context, document.len())
}

#[derive(Deserialize, Serialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContextDocument {
    schema_version: String,
    id: String,
    root_block_ids: Vec<String>,
    blocks: Vec<ContextBlock>,
    total_bytes: usize,
    digest: String,
}

#[derive(Deserialize, Serialize, Zeroize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContextBlock {
    id: String,
    media_type: String,
    content: String,
    links: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextWithoutDigestRef<'a> {
    schema_version: &'a str,
    id: &'a str,
    root_block_ids: &'a [String],
    blocks: &'a [ContextBlock],
    total_bytes: usize,
}

impl ContextDocument {
    fn validate_and_normalize(&mut self) -> Result<(), ErrorCode> {
        if self.schema_version != CONTEXT_SCHEMA_VERSION
            || !valid_context_id(&self.id)
            || !valid_digest(&self.digest)
            || self.root_block_ids.is_empty()
            || self.root_block_ids.len() > MAX_CONTEXT_BLOCKS
            || self.blocks.is_empty()
            || self.blocks.len() > MAX_CONTEXT_BLOCKS
            || self.total_bytes > MAX_CONTEXT_CONTENT_BYTES
        {
            return Err(ErrorCode::InvalidDocument);
        }

        let mut block_ids = BTreeSet::new();
        let mut input_content_bytes = 0usize;
        let mut total_links = 0usize;
        for block in &self.blocks {
            if !block.validate_shape() || !block_ids.insert(block.id.as_str()) {
                return Err(ErrorCode::InvalidDocument);
            }
            input_content_bytes = input_content_bytes
                .checked_add(block.content.len())
                .ok_or(ErrorCode::InvalidDocument)?;
            total_links = total_links
                .checked_add(block.links.len())
                .ok_or(ErrorCode::InvalidDocument)?;
        }
        if input_content_bytes > MAX_CONTEXT_CONTENT_BYTES
            || total_links > MAX_CONTEXT_TOTAL_LINKS
            || !unique_valid_block_ids(&self.root_block_ids)
            || self
                .root_block_ids
                .iter()
                .any(|identifier| !block_ids.contains(identifier.as_str()))
            || self.blocks.iter().any(|block| {
                block
                    .links
                    .iter()
                    .any(|identifier| !block_ids.contains(identifier.as_str()))
            })
        {
            return Err(ErrorCode::InvalidDocument);
        }

        let mut json_nodes = 0usize;
        for block in &mut self.blocks {
            block.links.sort();
            if block.media_type == "application/json" {
                let nested = parse_unique_binary64_json(&block.content)?;
                let metrics = json_metrics(nested.as_value())?;
                json_nodes = json_nodes
                    .checked_add(metrics.nodes)
                    .ok_or(ErrorCode::InvalidDocument)?;
                if metrics.depth > MAX_CONTEXT_JSON_DEPTH || json_nodes > MAX_CONTEXT_JSON_NODES {
                    return Err(ErrorCode::InvalidDocument);
                }
                let canonical =
                    serialize_jcs(nested.as_value(), block.content.len()).map_err(|error| {
                        if error == ErrorCode::ResourceLimitExceeded {
                            error
                        } else {
                            ErrorCode::InvalidDocument
                        }
                    })?;
                let normalized =
                    String::from_utf8(canonical).map_err(|_| ErrorCode::InternalFailure)?;
                block.content.zeroize();
                block.content = normalized;
                if block.content.chars().count() > MAX_BLOCK_CONTENT_CHARS {
                    return Err(ErrorCode::InvalidDocument);
                }
            }
        }

        self.root_block_ids.sort();
        self.blocks.sort_by(|left, right| left.id.cmp(&right.id));
        self.total_bytes = self.blocks.iter().try_fold(0usize, |total, block| {
            total
                .checked_add(block.content.len())
                .ok_or(ErrorCode::InvalidDocument)
        })?;
        if self.total_bytes > MAX_CONTEXT_CONTENT_BYTES {
            return Err(ErrorCode::InvalidDocument);
        }

        let unsigned = ContextWithoutDigestRef {
            schema_version: &self.schema_version,
            id: &self.id,
            root_block_ids: &self.root_block_ids,
            blocks: &self.blocks,
            total_bytes: self.total_bytes,
        };
        let canonical = serialize_jcs(&unsigned, self.total_bytes)?;
        let mut hasher = Sha256::new();
        hasher.update(CONTEXT_DIGEST_DOMAIN);
        hasher.update([0]);
        hasher.update(canonical);
        self.digest = sha256_hex(&hasher.finalize().into())?;
        Ok(())
    }
}

impl ContextBlock {
    fn validate_shape(&self) -> bool {
        valid_block_id(&self.id)
            && matches!(
                self.media_type.as_str(),
                "text/plain" | "text/markdown" | "application/json"
            )
            && self.content.chars().count() <= MAX_BLOCK_CONTENT_CHARS
            && self.links.len() <= MAX_CONTEXT_LINKS_PER_BLOCK
            && unique_valid_block_ids(&self.links)
    }
}

fn unique_valid_block_ids(values: &[String]) -> bool {
    let mut unique = BTreeSet::new();
    values
        .iter()
        .all(|value| valid_block_id(value) && unique.insert(value.as_str()))
}

#[derive(Clone, Copy)]
struct JsonMetrics {
    depth: usize,
    nodes: usize,
}

fn json_metrics(value: &Value) -> Result<JsonMetrics, ErrorCode> {
    let mut pending = Vec::new();
    pending
        .try_reserve_exact(64)
        .map_err(|_| ErrorCode::ResourceLimitExceeded)?;
    pending.push((value, 1usize));
    let mut depth = 0usize;
    let mut nodes = 0usize;

    while let Some((item, item_depth)) = pending.pop() {
        nodes = nodes.checked_add(1).ok_or(ErrorCode::InvalidDocument)?;
        if nodes > MAX_CONTEXT_JSON_NODES || item_depth > MAX_CONTEXT_JSON_DEPTH {
            return Err(ErrorCode::InvalidDocument);
        }
        depth = depth.max(item_depth);
        match item {
            Value::Array(values) => {
                pending
                    .try_reserve(values.len())
                    .map_err(|_| ErrorCode::ResourceLimitExceeded)?;
                pending.extend(values.iter().map(|nested| (nested, item_depth + 1)));
            }
            Value::Object(values) => {
                pending
                    .try_reserve(values.len())
                    .map_err(|_| ErrorCode::ResourceLimitExceeded)?;
                pending.extend(values.values().map(|nested| (nested, item_depth + 1)));
            }
            _ => {}
        }
    }

    Ok(JsonMetrics { depth, nodes })
}

struct SensitiveJson(Value);

impl SensitiveJson {
    const fn as_value(&self) -> &Value {
        &self.0
    }
}

impl Drop for SensitiveJson {
    fn drop(&mut self) {
        zeroize_json_value(&mut self.0);
    }
}

fn zeroize_json_value(value: &mut Value) {
    match value {
        Value::String(string) => string.zeroize(),
        Value::Array(values) => {
            for nested in values.iter_mut() {
                zeroize_json_value(nested);
            }
            values.clear();
        }
        Value::Object(values) => {
            for (mut key, mut nested) in std::mem::take(values) {
                key.zeroize();
                zeroize_json_value(&mut nested);
            }
        }
        _ => {}
    }
    *value = Value::Null;
}

fn parse_unique_binary64_json(input: &str) -> Result<SensitiveJson, ErrorCode> {
    let mut deserializer = serde_json::Deserializer::from_str(input);
    let value = UniqueValueSeed
        .deserialize(&mut deserializer)
        .map_err(|_| ErrorCode::InvalidDocument)?;
    deserializer.end().map_err(|_| ErrorCode::InvalidDocument)?;
    Ok(SensitiveJson(value))
}

struct UniqueValueSeed;

impl<'de> DeserializeSeed<'de> for UniqueValueSeed {
    type Value = Value;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(UniqueValueVisitor)
    }
}

struct UniqueValueVisitor;

impl<'de> Visitor<'de> for UniqueValueVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value with unique object keys and bounded binary64 numbers")
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(Value::Null)
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        binary64_number(value as f64)
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        binary64_number(value as f64)
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        binary64_number(value)
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        Ok(Value::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(Value::String(value))
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut output = Vec::new();
        if let Some(length) = sequence.size_hint() {
            output
                .try_reserve(length.min(MAX_CONTEXT_JSON_NODES))
                .map_err(A::Error::custom)?;
        }
        while let Some(value) = sequence.next_element_seed(UniqueValueSeed)? {
            output.try_reserve(1).map_err(A::Error::custom)?;
            output.push(value);
        }
        Ok(Value::Array(output))
    }

    fn visit_map<A>(self, mut object: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut output = Map::new();
        while let Some(key) = object.next_key::<String>()? {
            if output.contains_key(&key) {
                return Err(A::Error::custom("duplicate object key"));
            }
            let value = object.next_value_seed(UniqueValueSeed)?;
            output.insert(key, value);
        }
        Ok(Value::Object(output))
    }
}

fn binary64_number<E>(value: f64) -> Result<Value, E>
where
    E: serde::de::Error,
{
    if !value.is_finite() || value.abs() > MAX_CONTEXT_NUMBER_MAGNITUDE {
        return Err(E::custom("number outside the Context binary64 domain"));
    }
    Number::from_f64(value)
        .map(Value::Number)
        .ok_or_else(|| E::custom("non-finite JSON number"))
}

#[cfg(test)]
mod tests {
    use super::{canonicalize_context_document, parse_unique_binary64_json, serialize_jcs};
    use crate::ErrorCode;

    const DIGEST: &str = "0000000000000000000000000000000000000000000000000000000000000000";
    const BLOCK: &str = "blk_000102030405060708090a0b0c0d0e0f";

    fn context(content: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": "libre-ai.context-document.v2",
            "id": "urn:libre-ai:context:101112131415161718191a1b1c1d1e1f",
            "rootBlockIds": [BLOCK],
            "blocks": [{
                "id": BLOCK,
                "mediaType": "application/json",
                "content": content,
                "links": []
            }],
            "totalBytes": 0,
            "digest": DIGEST
        }))
        .unwrap()
    }

    #[test]
    fn normalizes_binary64_numbers_and_recomputes_derived_fields() {
        let output = canonicalize_context_document(&context(
            r#"{"z":1,"n":333333333.33333329,"a":[3,2,1]}"#,
        ))
        .unwrap();
        let output = String::from_utf8(output).unwrap();
        assert!(output.contains(r#""content":"{\"a\":[3,2,1],\"n\":333333333.3333333,\"z\":1}""#));
        assert!(!output.contains(&format!(r#""digest":"{DIGEST}""#)));
    }

    #[test]
    fn rejects_duplicate_nested_keys_and_out_of_range_numbers() {
        assert!(parse_unique_binary64_json(r#"{"a":1,"a":2}"#).is_err());
        assert!(parse_unique_binary64_json(r#"{"value":9007199254740992}"#).is_err());
        assert_eq!(
            canonicalize_context_document(&context(r#"{"a":1,"a":2}"#)),
            Err(ErrorCode::InvalidDocument)
        );
    }

    #[test]
    fn canonicalizes_negative_zero_to_zero() {
        let value = parse_unique_binary64_json(r#"{"value":-0}"#).unwrap();
        assert_eq!(
            String::from_utf8(serialize_jcs(value.as_value(), 16).unwrap()).unwrap(),
            r#"{"value":0}"#
        );
    }
}
