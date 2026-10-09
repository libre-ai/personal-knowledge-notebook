/**
 * Throwaway PostgreSQL clusters for the API tests (owner-accepted harness,
 * Y35), mirroring `p02_store::testing`: Unix socket only, the P02 migrations
 * applied by the migration role, NOINHERIT login members of the runtime
 * roles. Without PostgreSQL server binaries the harness throws: a database
 * test never passes by skipping.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { SQL } from "bun";

const MIGRATIONS = resolve(import.meta.dir, "../../../crates/p02-store/migrations");
export const BOOTSTRAP = "p02_bootstrap";
export const MIGRATOR = "p02_migrator";
export const API_LOGIN = "p02_api_login";
export const DATABASE = "p02";

function bindir(): string {
  const configured = process.env.P02_PG_BINDIR;
  if (configured) return configured;
  const probe = Bun.spawnSync(["pg_config", "--bindir"], { stdout: "pipe", stderr: "ignore" });
  if (probe.success) {
    const dir = probe.stdout.toString().trim();
    if (existsSync(join(dir, "initdb"))) return dir;
  }
  for (const [parent, prefix] of [
    ["/usr/lib/postgresql", ""],
    ["/opt/homebrew/opt", "postgresql"],
    ["/usr/local/opt", "postgresql"],
  ] as const) {
    if (!existsSync(parent)) continue;
    const found = readdirSync(parent)
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(parent, name, "bin"))
      .filter((bin) => existsSync(join(bin, "initdb")))
      .sort();
    const last = found.at(-1);
    if (last) return last;
  }
  throw new Error(
    "PostgreSQL server binaries not found: database tests refuse to pass without a database",
  );
}

function run(bin: string, program: string, args: string[]): void {
  const result = Bun.spawnSync([join(bin, program), ...args], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) {
    throw new Error(
      `${program} failed: ${result.stderr.toString().trim().split("\n").slice(-4).join(" | ")}`,
    );
  }
}

let next = 0;

export interface TestCluster {
  readonly socketDir: string;
  connect(user: string, database?: string): SQL;
  stop(): Promise<void>;
}

export async function startCluster(): Promise<TestCluster> {
  const bin = bindir();
  const root = `/tmp/p02api-${process.pid}-${next++}-${Date.now() % 100000}`;
  mkdirSync(root, { recursive: true });
  const data = join(root, "data");
  const opened: SQL[] = [];
  let server: ReturnType<typeof Bun.spawn> | undefined;
  const stop = async () => {
    for (const client of opened) await client.close().catch(() => undefined);
    Bun.spawnSync([join(bin, "pg_ctl"), "stop", "-D", data, "-m", "immediate", "-w"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    server?.kill();
    rmSync(root, { recursive: true, force: true });
  };
  try {
    run(bin, "initdb", [
      "-D",
      data,
      "-U",
      BOOTSTRAP,
      "-A",
      "trust",
      "-E",
      "UTF8",
      "--locale=C",
      "--no-sync",
    ]);
    server = Bun.spawn(
      [
        join(bin, "postgres"),
        "-D",
        data,
        "-k",
        root,
        "-c",
        "listen_addresses=",
        "-c",
        "fsync=off",
        "-c",
        "unix_socket_permissions=0700",
        "-c",
        "max_connections=20",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    const connect = (user: string, database = DATABASE): SQL => {
      const client = new SQL({
        adapter: "postgres",
        path: root,
        port: 5432,
        username: user,
        database,
        max: 2,
      });
      opened.push(client);
      return client;
    };
    const deadline = Date.now() + 30_000;
    let bootstrap = connect(BOOTSTRAP, "postgres");
    for (;;) {
      try {
        await bootstrap`SELECT 1`;
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await bootstrap.close().catch(() => undefined);
        await Bun.sleep(50);
        bootstrap = connect(BOOTSTRAP, "postgres");
      }
    }
    await bootstrap.unsafe(`CREATE ROLE ${MIGRATOR} LOGIN CREATEROLE`);
    await bootstrap.unsafe(`CREATE DATABASE ${DATABASE} OWNER ${MIGRATOR}`);
    await bootstrap.unsafe(`REVOKE ALL ON DATABASE ${DATABASE} FROM PUBLIC`);
    const migrator = connect(MIGRATOR);
    for (const file of readdirSync(MIGRATIONS)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      await migrator.unsafe(await Bun.file(join(MIGRATIONS, file)).text());
    }
    const owner = connect(BOOTSTRAP);
    await owner.unsafe(
      `CREATE ROLE ${API_LOGIN} LOGIN NOINHERIT IN ROLE p02_api; GRANT CONNECT ON DATABASE ${DATABASE} TO ${API_LOGIN}`,
    );
    return { socketDir: root, connect, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
