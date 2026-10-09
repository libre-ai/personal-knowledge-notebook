//! Database connection settings of the worker binary.
//!
//! The connection string comes from `P02_DATABASE_URL` (libpq key/value or
//! URL form, never logged). This build has no TLS transport for PostgreSQL,
//! so it only accepts Unix-socket hosts: a TCP host is refused rather than
//! connected in clear text.

use std::str::FromStr;

use thiserror::Error;
use tokio_postgres::Config;
use tokio_postgres::config::Host;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum ConfigError {
    #[error("P02_DATABASE_URL is not set")]
    Missing,
    #[error("P02_DATABASE_URL is not a valid PostgreSQL connection string")]
    Invalid,
    #[error("only Unix-socket PostgreSQL hosts are supported until a TLS transport is configured")]
    PlaintextTcp,
}

/// Parse and vet a connection string.
pub fn database_config(value: Option<&str>) -> Result<Config, ConfigError> {
    let value = value.ok_or(ConfigError::Missing)?;
    let config = Config::from_str(value).map_err(|_| ConfigError::Invalid)?;
    let hosts = config.get_hosts();
    if hosts.is_empty() || hosts.iter().any(|host| !matches!(host, Host::Unix(_))) {
        return Err(ConfigError::PlaintextTcp);
    }
    Ok(config)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn only_unix_socket_hosts_are_accepted() {
        assert!(
            database_config(Some(
                "host=/run/postgresql dbname=p02 user=p02_worker_login"
            ))
            .is_ok()
        );
        assert_eq!(database_config(None).err(), Some(ConfigError::Missing));
        assert_eq!(
            database_config(Some("host=db.example.org dbname=p02")).err(),
            Some(ConfigError::PlaintextTcp)
        );
        assert_eq!(
            database_config(Some("postgresql://user@db.example.org/p02")).err(),
            Some(ConfigError::PlaintextTcp)
        );
        assert_eq!(
            database_config(Some("dbname=p02")).err(),
            Some(ConfigError::PlaintextTcp)
        );
        assert_eq!(
            database_config(Some("host=/run/pg port=notaport")).err(),
            Some(ConfigError::Invalid)
        );
    }

    #[test]
    fn errors_never_echo_the_connection_string() {
        let text = format!("{}", ConfigError::Invalid);
        assert!(!text.contains("host=") && !text.contains("password"));
    }
}
