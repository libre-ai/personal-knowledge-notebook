use std::fmt;

use crate::error::StoreError;

/// A private tenant (organization) identifier, fleet format
/// `^ten_[a-z0-9]{16,64}$` (`common.v1` `tenantId`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TenantId(String);

impl TenantId {
    pub fn parse(value: &str) -> Result<Self, StoreError> {
        let Some(rest) = value.strip_prefix("ten_") else {
            return Err(StoreError::TenantInvalid);
        };
        let well_formed = (16..=64).contains(&rest.len())
            && rest
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());
        if well_formed {
            Ok(Self(value.to_owned()))
        } else {
            Err(StoreError::TenantInvalid)
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for TenantId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_fleet_format() {
        assert!(TenantId::parse("ten_0123456789abcdef").is_ok());
        assert!(TenantId::parse(&format!("ten_{}", "a".repeat(64))).is_ok());
        for bad in [
            "",
            "ten_",
            "ten_0123456789abcde",
            "ten_0123456789ABCDEF",
            "ten_0123456789abcdef'",
            "tenant_0123456789abcdef",
            "public",
        ] {
            assert!(TenantId::parse(bad).is_err(), "{bad}");
        }
        assert!(TenantId::parse(&format!("ten_{}", "a".repeat(65))).is_err());
    }
}
