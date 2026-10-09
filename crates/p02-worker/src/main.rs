//! `p02-worker migrate` applies the P02 migrations (connect as the migration
//! role); `p02-worker run` processes jobs until interrupted (connect as a
//! login member of `p02_worker`). Output carries stable codes only.

use std::process::ExitCode;
use std::time::Duration;

use p02_fetch::{FetcherConfig, SafeFetcher};
use p02_worker::config::database_config;
use p02_worker::{Processed, WorkerSettings, process_one};
use tokio_postgres::{Client, NoTls};

const IDLE_POLL: Duration = Duration::from_secs(1);
const ERROR_BACKOFF: Duration = Duration::from_secs(5);

#[tokio::main]
async fn main() -> ExitCode {
    let command = std::env::args().nth(1);
    let url = std::env::var("P02_DATABASE_URL").ok();
    let config = match database_config(url.as_deref()) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("p02-worker: {error}");
            return ExitCode::from(2);
        }
    };
    let Ok(mut client) = connect(&config).await else {
        eprintln!("p02-worker: the database connection failed");
        return ExitCode::from(1);
    };
    match command.as_deref() {
        Some("migrate") => match p02_store::migrate::migrate(&mut client).await {
            Ok(report) => {
                println!(
                    "p02-worker: migrations verified={} applied={}",
                    report.verified, report.applied
                );
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("p02-worker: migration refused: {error}");
                ExitCode::from(1)
            }
        },
        Some("run") => run(&mut client).await,
        _ => {
            eprintln!("usage: p02-worker migrate|run (P02_DATABASE_URL set)");
            ExitCode::from(2)
        }
    }
}

async fn connect(config: &tokio_postgres::Config) -> Result<Client, tokio_postgres::Error> {
    let (client, connection) = config.connect(NoTls).await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    Ok(client)
}

async fn run(client: &mut Client) -> ExitCode {
    let fetcher = match SafeFetcher::new(FetcherConfig::default()) {
        Ok(fetcher) => fetcher,
        Err(error) => {
            eprintln!("p02-worker: fetcher setup failed: {error}");
            return ExitCode::from(1);
        }
    };
    let settings = WorkerSettings::default();
    loop {
        let step = tokio::select! {
            step = process_one(client, &fetcher, &settings) => step,
            _ = tokio::signal::ctrl_c() => return ExitCode::SUCCESS,
        };
        let pause = match step {
            Ok(Processed::Idle) => IDLE_POLL,
            Ok(Processed::Completed | Processed::Retried) => Duration::ZERO,
            Err(error) => {
                eprintln!("p02-worker: store error: {error}");
                ERROR_BACKOFF
            }
        };
        if !pause.is_zero() {
            tokio::select! {
                () = tokio::time::sleep(pause) => {}
                _ = tokio::signal::ctrl_c() => return ExitCode::SUCCESS,
            }
        }
    }
}
